import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { runInTenantTransaction, TenantContext } from '@pbl/common';
import {
  CreateWarehouseReservationRequest,
  INVENTORY_RESERVATION_COMMITTED,
  INVENTORY_RESERVATION_CONFIRMED,
  INVENTORY_RESERVATION_EXPIRED,
  INVENTORY_RESERVATION_RELEASED,
  INVENTORY_STOCK_CHANGED,
  OrderCompletedPayload,
  ReservationConfirmedPayload,
  ReservationLifecycleEventPayload,
  ReserveStockRequest,
  StockChangedPayload,
  StockLine,
  StockReservation,
  StockShortage,
  WarehouseReservationLineInput,
  WarehouseReservationLineResult,
  WarehouseReservationResponse,
  WarehouseReservationState,
  WarehouseStockShortage,
} from '@pbl/contracts';
import { EventOutbox, qualifiedTable } from '@pbl/events';
import { createHash, randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { RESERVATION_TTL_MINUTES } from '../config/inventory.config';
import {
  computeValuationAfterDeduction,
  formatCentsToMoney,
  parseMoneyToCents,
} from '../domain/inventory-domain';
import { assertCatalogSkuEligible } from '../infrastructure/catalog-reference/catalog-sku-projection.handler';
import { assertActiveWarehouse } from '../modules/warehouses/warehouses.service';
import { mergeLines, sameLines } from './stock-lines';

export const WarehouseReservationErrorCode = {
  MISSING_IDEMPOTENCY_KEY: 'MISSING_IDEMPOTENCY_KEY',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
  INVALID_RESERVATION_STATE: 'INVALID_RESERVATION_STATE',
  RESERVATION_STATE_CONFLICT: 'RESERVATION_STATE_CONFLICT',
  RESERVATION_ALREADY_COMMITTED: 'RESERVATION_ALREADY_COMMITTED',
  RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
} as const;

const SCALE_FACTOR = 1000n;
const DEFAULT_TTL_SECONDS = 900;

export function parseDecimalToMilli(value: string): bigint {
  const trimmed = value.trim();
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,3}))?$/.exec(trimmed);
  if (!match) {
    throw new BadRequestException({
      errorCode: WarehouseReservationErrorCode.INVALID_QUANTITY,
      message: `Invalid decimal quantity "${value}" (expected NUMERIC(18,3))`,
    });
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fracStr = (match[3] ?? '').padEnd(3, '0');
  const frac = BigInt(fracStr);
  return sign * (whole * SCALE_FACTOR + frac);
}

export function formatMilliToDecimal(milli: bigint): string {
  const negative = milli < 0n;
  const abs = negative ? -milli : milli;
  const whole = abs / SCALE_FACTOR;
  const frac = (abs % SCALE_FACTOR).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

export interface NormalizedWarehouseReservationLine {
  warehouseId: string;
  skuId: string;
  qtyMilli: bigint;
  qty: string;
}

export function normalizeReservationLines(
  lines: WarehouseReservationLineInput[],
): NormalizedWarehouseReservationLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new BadRequestException({
      errorCode: WarehouseReservationErrorCode.INVALID_QUANTITY,
      message: 'At least one reservation line is required',
    });
  }
  const merged = new Map<
    string,
    { warehouseId: string; skuId: string; qtyMilli: bigint }
  >();
  for (const line of lines) {
    const qtyMilli = parseDecimalToMilli(line.qty);
    if (qtyMilli <= 0n) {
      throw new BadRequestException({
        errorCode: WarehouseReservationErrorCode.INVALID_QUANTITY,
        message: 'Reservation line quantity must be strictly greater than zero',
      });
    }
    const key = `${line.warehouseId}:${line.skuId}`;
    const existing = merged.get(key);
    if (existing) {
      existing.qtyMilli += qtyMilli;
    } else {
      merged.set(key, {
        warehouseId: line.warehouseId,
        skuId: line.skuId,
        qtyMilli,
      });
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => {
      const whCmp = a.warehouseId.localeCompare(b.warehouseId);
      return whCmp !== 0 ? whCmp : a.skuId.localeCompare(b.skuId);
    })
    .map((item) => ({
      warehouseId: item.warehouseId,
      skuId: item.skuId,
      qtyMilli: item.qtyMilli,
      qty: formatMilliToDecimal(item.qtyMilli),
    }));
}

export function hashReservationRequest(
  req: CreateWarehouseReservationRequest,
  normalizedLines = normalizeReservationLines(req.lines),
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        callerService: req.callerService,
        sourceRefType: req.sourceRefType,
        sourceRefId: req.sourceRefId,
        lines: normalizedLines.map((l) => [l.warehouseId, l.skuId, l.qty]),
      }),
    )
    .digest('hex');
}

export interface WarehouseReserveResult {
  reservation: WarehouseReservationResponse;
  replayed: boolean;
}

/** Thrown inside the reservation transaction so that it rolls back and nothing is held */
export class StockShortageError extends Error {
  constructor(readonly shortages: StockShortage[]) {
    super('Not enough stock');
    this.name = 'StockShortageError';
  }
}

/** The order id is already held for other lines or another branch */
export class ReservationMismatchError extends Error {
  constructor() {
    super('The order is already held for different lines');
    this.name = 'ReservationMismatchError';
  }
}

export interface ReserveResult {
  /** False when the same order had already been held (an idempotent retry) */
  created: boolean;
  reservation: StockReservation;
}

type ReservationRow = {
  id: string;
  order_id: string;
  branch_id: string;
  status: StockReservation['status'];
  expires_at: Date;
};

/**
 * Holds stock for an order, turns a hold into a deduction when the order is
 * completed, and gives back the stock of holds nobody completed. Every statement
 * names the tenant explicitly (it comes from the verified token or from the event),
 * and the check constraint of `stock_item` / `stock_balance` backs the code up:
 * stock cannot go negative whatever happens here.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(RESERVATION_TTL_MINUTES) private readonly ttlMinutes: number,
    @Optional() private readonly outbox?: EventOutbox,
  ) {}

  /**
   * Holds every line, or nothing: one conditional UPDATE per line
   * (`on_hand - reserved >= qty`), in one transaction, lines locked in SKU order so
   * overlapping orders cannot deadlock. Idempotent by `(tenant, orderId)`.
   */
  async reserve(request: ReserveStockRequest): Promise<ReserveResult> {
    const tenantId = TenantContext.require();
    const lines = mergeLines(request.lines);
    return this.dataSource.transaction(async (em) => {
      const t = (name: string) => qualifiedTable(em.connection, name);

      let id = await this.insertReservation(em, tenantId, request);
      if (!id) {
        const existing = await this.findByOrder(em, tenantId, request.orderId);
        if (existing && ['held', 'committed'].includes(existing.status)) {
          const held = await this.toReservation(em, existing);
          if (
            existing.branch_id !== request.branchId ||
            !sameLines(held.lines, request.lines)
          ) {
            throw new ReservationMismatchError();
          }
          return {
            created: false,
            reservation: await this.toReservation(em, existing),
          };
        }
        // released or expired earlier: this order tries again from scratch
        await em.query(
          `DELETE FROM ${t('stock_reservation')} WHERE "id" = $1`,
          [existing!.id],
        );
        id = await this.insertReservation(em, tenantId, request);
      }

      const shortages: StockShortage[] = [];
      for (const line of lines) {
        const [, held] = await em.query(
          `UPDATE ${t('stock_item')}
              SET "quantity_reserved" = "quantity_reserved" + $4, "updated_at" = now()
            WHERE "tenant_id" = $1 AND "branch_id" = $2 AND "sku" = $3
              AND "quantity_on_hand" - "quantity_reserved" >= $4`,
          [tenantId, request.branchId, line.sku, line.quantity],
        );
        if (held === 0) {
          const [item] = await em.query(
            `SELECT "quantity_on_hand" - "quantity_reserved" AS "available"
               FROM ${t('stock_item')}
              WHERE "tenant_id" = $1 AND "branch_id" = $2 AND "sku" = $3`,
            [tenantId, request.branchId, line.sku],
          );
          shortages.push({
            sku: line.sku,
            requested: line.quantity,
            available: item?.available ?? 0,
          });
        }
      }
      if (shortages.length > 0) throw new StockShortageError(shortages);

      for (const line of lines) {
        await em.query(
          `INSERT INTO ${t('stock_reservation_item')} ("id", "tenant_id", "reservation_id", "sku", "quantity")
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), tenantId, id, line.sku, line.quantity],
        );
      }
      const row = await this.findByOrder(em, tenantId, request.orderId);
      return {
        created: true,
        reservation: await this.toReservation(em, row!),
      };
    });
  }

  /** Gives back a hold nobody completed. Idempotent: anything but `held` is left alone. */
  async release(orderId: string): Promise<void> {
    const tenantId = TenantContext.require();
    await this.dataSource.transaction(async (em) => {
      const row = await this.findByOrder(em, tenantId, orderId, true);
      if (row?.status !== 'held') return;
      await this.giveBack(em, tenantId, row, 'released');
    });
  }

  /**
   * The order was completed (event `sales.order.completed`): the hold becomes a
   * deduction. When the hold is gone (the event was very late and it expired) the
   * lines are deducted directly, taking at most what other holds leave free, and
   * what was short is logged; stock never goes below what other holds need.
   */
  async commit(
    em: EntityManager,
    tenantId: string,
    order: OrderCompletedPayload,
  ): Promise<void> {
    const t = (name: string) => qualifiedTable(em.connection, name);
    const row = await this.findByOrder(em, tenantId, order.orderId, true);
    if (row?.status === 'committed') return;

    const held = row?.status === 'held';
    const branchId = row?.branch_id ?? order.branchId;
    const lines = held
      ? await this.itemsOf(em, row!.id)
      : mergeLines(
          order.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
        );

    for (const line of lines) {
      let take = line.quantity;
      if (!held) {
        const [item] = await em.query(
          `SELECT "quantity_on_hand" - "quantity_reserved" AS "free"
             FROM ${t('stock_item')}
            WHERE "tenant_id" = $1 AND "branch_id" = $2 AND "sku" = $3 FOR UPDATE`,
          [tenantId, branchId, line.sku],
        );
        take = Math.min(line.quantity, Math.max(0, item?.free ?? 0));
        if (take < line.quantity) {
          this.logger.warn(
            `Order ${order.code}: ${line.sku} short by ${line.quantity - take} when the hold had gone`,
          );
        }
        if (take < line.quantity) {
          // the gap is on record: a zero-change row, so on-hand stays a true count
          await this.ledger(
            em,
            tenantId,
            branchId,
            line.sku,
            0,
            item?.free ?? 0,
            'sale_shortfall',
            order.orderId,
          );
        }
        if (take === 0) continue;
      }
      const [rows] = await em.query(
        `UPDATE ${t('stock_item')}
            SET "quantity_on_hand" = "quantity_on_hand" - $4,
                "quantity_reserved" = "quantity_reserved" - $5,
                "updated_at" = now()
          WHERE "tenant_id" = $1 AND "branch_id" = $2 AND "sku" = $3
          RETURNING "quantity_on_hand"`,
        [tenantId, branchId, line.sku, take, held ? take : 0],
      );
      await this.ledger(
        em,
        tenantId,
        branchId,
        line.sku,
        -take,
        rows[0].quantity_on_hand,
        'sale',
        order.orderId,
      );
    }
    if (row) {
      await em.query(
        `UPDATE ${t('stock_reservation')} SET "status" = 'committed' WHERE "id" = $1`,
        [row.id],
      );
    }
  }

  /**
   * Expires the holds past their time and gives the stock back. Returns how many.
   * One transaction per hold, so a row that fails cannot block the ones after it.
   */
  async expireDue(limit = 50): Promise<number> {
    const due: { id: string }[] = await this.dataSource.query(
      `SELECT "id" FROM ${qualifiedTable(this.dataSource, 'stock_reservation')}
        WHERE "status" = 'held' AND "expires_at" < now()
        ORDER BY "expires_at" LIMIT $1`,
      [limit],
    );
    let expired = 0;
    for (const { id } of due) {
      try {
        const done = await this.dataSource.transaction(async (em) => {
          const [row] = await em.query(
            `SELECT * FROM ${qualifiedTable(em.connection, 'stock_reservation')}
              WHERE "id" = $1 AND "status" = 'held' AND "expires_at" < now()
              FOR UPDATE SKIP LOCKED`,
            [id],
          );
          if (!row) return false;
          await this.giveBack(em, row.tenant_id, row, 'expired');
          return true;
        });
        if (done) expired++;
      } catch (error) {
        this.logger.error(
          `Could not expire hold ${id}: ${(error as Error).message}`,
        );
      }
    }
    return expired;
  }

  // ---- internals

  private async insertReservation(
    em: EntityManager,
    tenantId: string,
    request: ReserveStockRequest,
  ): Promise<string | null> {
    const rows = await em.query(
      `INSERT INTO ${qualifiedTable(em.connection, 'stock_reservation')}
         ("id", "tenant_id", "order_id", "branch_id", "status", "expires_at")
       VALUES ($1, $2, $3, $4, 'held', now() + make_interval(mins => $5))
       ON CONFLICT ("tenant_id", "order_id") DO NOTHING RETURNING "id"`,
      [
        randomUUID(),
        tenantId,
        request.orderId,
        request.branchId,
        this.ttlMinutes,
      ],
    );
    return rows[0]?.id ?? null;
  }

  private async findByOrder(
    em: EntityManager,
    tenantId: string,
    orderId: string,
    lock = false,
  ): Promise<ReservationRow | null> {
    const rows = await em.query(
      `SELECT "id", "order_id", "branch_id", "status", "expires_at"
         FROM ${qualifiedTable(em.connection, 'stock_reservation')}
        WHERE "tenant_id" = $1 AND "order_id" = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [tenantId, orderId],
    );
    return rows[0] ?? null;
  }

  private async itemsOf(
    em: EntityManager,
    reservationId: string,
  ): Promise<StockLine[]> {
    const rows = await em.query(
      `SELECT "sku", "quantity" FROM ${qualifiedTable(em.connection, 'stock_reservation_item')}
        WHERE "reservation_id" = $1 ORDER BY "sku" COLLATE "C"`,
      [reservationId],
    );
    return rows.map((r: StockLine) => ({ sku: r.sku, quantity: r.quantity }));
  }

  private async toReservation(
    em: EntityManager,
    row: ReservationRow,
  ): Promise<StockReservation> {
    return {
      orderId: row.order_id,
      branchId: row.branch_id,
      status: row.status,
      expiresAt: new Date(row.expires_at).toISOString(),
      lines: await this.itemsOf(em, row.id),
    };
  }

  /** Returns the held quantities to the free stock and closes the reservation */
  private async giveBack(
    em: EntityManager,
    tenantId: string,
    row: ReservationRow,
    status: 'released' | 'expired',
  ): Promise<void> {
    const t = (name: string) => qualifiedTable(em.connection, name);
    for (const line of await this.itemsOf(em, row.id)) {
      await em.query(
        `UPDATE ${t('stock_item')}
            SET "quantity_reserved" = "quantity_reserved" - $4, "updated_at" = now()
          WHERE "tenant_id" = $1 AND "branch_id" = $2 AND "sku" = $3`,
        [tenantId, row.branch_id, line.sku, line.quantity],
      );
    }
    await em.query(
      `UPDATE ${t('stock_reservation')} SET "status" = $2 WHERE "id" = $1`,
      [row.id, status],
    );
  }

  private ledger(
    em: EntityManager,
    tenantId: string,
    branchId: string,
    sku: string,
    changeQty: number,
    balanceAfter: number,
    refType: string,
    refId: string,
  ) {
    return em.query(
      `INSERT INTO ${qualifiedTable(em.connection, 'inventory_ledger')}
         ("id", "tenant_id", "branch_id", "sku", "change_qty", "balance_after", "ref_type", "ref_id")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        tenantId,
        branchId,
        sku,
        changeQty,
        balanceAfter,
        refType,
        refId,
      ],
    );
  }

  // ---- Warehouse-level decimal stock reservations (`/internal/v1/reservations`)

  private schemaPrefix(em: EntityManager): string {
    const schema = (em.connection?.options as { schema?: string } | undefined)
      ?.schema;
    return schema ? `"${schema}".` : '';
  }

  async reserveWarehouseStock(
    idempotencyKey: string | undefined,
    req: CreateWarehouseReservationRequest,
  ): Promise<WarehouseReserveResult> {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 128) {
      throw new BadRequestException({
        errorCode: WarehouseReservationErrorCode.MISSING_IDEMPOTENCY_KEY,
        message: 'Idempotency-Key header is required (1..128 chars)',
      });
    }

    const normalizedLines = normalizeReservationLines(req.lines);
    const requestSha256 = hashReservationRequest(req, normalizedLines);
    const ttlSeconds = req.ttlSeconds ?? DEFAULT_TTL_SECONDS;

    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = this.schemaPrefix(em);

      await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `wh_res:${tenantId}:${req.callerService}:${key}`,
      ]);

      const existingRows = await em.query(
        `
        SELECT
          id,
          tenant_id AS "tenantId",
          caller_service AS "callerService",
          idempotency_key AS "idempotencyKey",
          request_sha256 AS "requestSha256",
          source_ref_type AS "sourceRefType",
          source_ref_id AS "sourceRefId",
          state,
          expires_at AS "expiresAt",
          created_at AS "createdAt"
        FROM ${prefix}"warehouse_reservation"
        WHERE tenant_id = $1 AND caller_service = $2 AND idempotency_key = $3
        LIMIT 1
        `,
        [tenantId, req.callerService, key],
      );

      if (existingRows.length > 0) {
        const existing = existingRows[0];
        if (String(existing.requestSha256).trim() !== requestSha256) {
          throw new ConflictException({
            errorCode: WarehouseReservationErrorCode.IDEMPOTENCY_CONFLICT,
            message:
              'Idempotency-Key was already used with a different reservation payload',
          });
        }
        const reservation = await this.loadWarehouseReservationResponse(
          em,
          prefix,
          tenantId,
          existing,
        );
        return { reservation, replayed: true };
      }

      const uniqueWarehouseIds = Array.from(
        new Set(normalizedLines.map((l) => l.warehouseId)),
      );
      for (const whId of uniqueWarehouseIds) {
        await assertActiveWarehouse(em, prefix, tenantId, whId);
      }

      const shortages: WarehouseStockShortage[] = [];
      for (const line of normalizedLines) {
        line.skuId = await assertCatalogSkuEligible(
          em,
          prefix,
          tenantId,
          line.skuId,
        );

        const balanceRows = await em.query(
          `
          SELECT
            on_hand_qty AS "onHandQty",
            reserved_qty AS "reservedQty"
          FROM ${prefix}"stock_balance"
          WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3
          FOR UPDATE
          `,
          [tenantId, line.warehouseId, line.skuId],
        );

        const availableMilli =
          balanceRows.length === 0
            ? 0n
            : parseDecimalToMilli(String(balanceRows[0].onHandQty)) -
              parseDecimalToMilli(String(balanceRows[0].reservedQty));

        if (availableMilli < line.qtyMilli) {
          shortages.push({
            warehouseId: line.warehouseId,
            skuId: line.skuId,
            requestedQty: line.qty,
            availableQty: formatMilliToDecimal(
              availableMilli > 0n ? availableMilli : 0n,
            ),
          });
        }
      }

      if (shortages.length > 0) {
        throw new ConflictException({
          errorCode: WarehouseReservationErrorCode.INSUFFICIENT_STOCK,
          message: 'Insufficient available stock for one or more lines',
          details: shortages.map((s) => ({
            property: `${s.warehouseId}:${s.skuId}`,
            code: WarehouseReservationErrorCode.INSUFFICIENT_STOCK,
            message: `Requested ${s.requestedQty}, available ${s.availableQty}`,
            ...s,
          })),
        });
      }

      const reservationId = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

      await em.query(
        `
        INSERT INTO ${prefix}"warehouse_reservation" (
          id,
          tenant_id,
          caller_service,
          idempotency_key,
          request_sha256,
          source_ref_type,
          source_ref_id,
          state,
          expires_at,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'HELD', $8, $9, $9)
        `,
        [
          reservationId,
          tenantId,
          req.callerService,
          key,
          requestSha256,
          req.sourceRefType,
          req.sourceRefId,
          expiresAt.toISOString(),
          now.toISOString(),
        ],
      );

      const lineResults: WarehouseReservationLineResult[] = [];
      for (let i = 0; i < normalizedLines.length; i += 1) {
        const line = normalizedLines[i];
        const lineNo = i + 1;
        const [updated] = await em.query(
          `
          UPDATE ${prefix}"stock_balance"
          SET
            reserved_qty = reserved_qty + $4::numeric(18,3),
            version = version + 1,
            updated_at = now()
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND sku_id = $3
            AND (on_hand_qty - reserved_qty) >= $4::numeric(18,3)
          RETURNING
            on_hand_qty AS "onHandQty",
            reserved_qty AS "reservedQty",
            (on_hand_qty - reserved_qty) AS "availableAfter"
          `,
          [tenantId, line.warehouseId, line.skuId, line.qty],
        );

        await em.query(
          `
          INSERT INTO ${prefix}"warehouse_reservation_line" (
            id,
            tenant_id,
            reservation_id,
            line_no,
            warehouse_id,
            sku_id,
            qty
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::numeric(18,3))
          `,
          [
            randomUUID(),
            tenantId,
            reservationId,
            lineNo,
            line.warehouseId,
            line.skuId,
            line.qty,
          ],
        );

        lineResults.push({
          lineNo,
          warehouseId: line.warehouseId,
          skuId: line.skuId,
          qty: line.qty,
          onHandAfter: formatMilliToDecimal(
            parseDecimalToMilli(String(updated[0].onHandQty)),
          ),
          reservedAfter: formatMilliToDecimal(
            parseDecimalToMilli(String(updated[0].reservedQty)),
          ),
          availableAfter: formatMilliToDecimal(
            parseDecimalToMilli(String(updated[0].availableAfter)),
          ),
        });
      }

      if (this.outbox) {
        await this.outbox.add(em, INVENTORY_RESERVATION_CONFIRMED, {
          reservationId,
          sourceRefType: req.sourceRefType,
          sourceRefId: req.sourceRefId,
          state: 'HELD',
          expiresAt: expiresAt.toISOString(),
          lines: normalizedLines.map((l) => ({
            warehouseId: l.warehouseId,
            skuId: l.skuId,
            qty: l.qty,
          })),
        } satisfies ReservationConfirmedPayload);
      }

      return {
        replayed: false,
        reservation: {
          reservationId,
          tenantId,
          callerService: req.callerService,
          sourceRefType: req.sourceRefType,
          sourceRefId: req.sourceRefId,
          state: 'HELD',
          expiresAt: expiresAt.toISOString(),
          createdAt: now.toISOString(),
          lines: lineResults,
        },
      };
    });
  }

  async getWarehouseReservation(
    reservationId: string,
  ): Promise<WarehouseReservationResponse> {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = this.schemaPrefix(em);
      const rows = await em.query(
        `
        SELECT
          id,
          tenant_id AS "tenantId",
          caller_service AS "callerService",
          source_ref_type AS "sourceRefType",
          source_ref_id AS "sourceRefId",
          state,
          expires_at AS "expiresAt",
          created_at AS "createdAt"
        FROM ${prefix}"warehouse_reservation"
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1
        `,
        [tenantId, reservationId],
      );
      if (rows.length === 0) {
        throw new NotFoundException({
          errorCode: WarehouseReservationErrorCode.RESERVATION_NOT_FOUND,
          message: `Reservation ${reservationId} not found`,
        });
      }
      return this.loadWarehouseReservationResponse(
        em,
        prefix,
        tenantId,
        rows[0],
      );
    });
  }

  async getWarehouseReservationByKey(
    idempotencyKeyOrCaller: string,
    maybeKey?: string,
  ): Promise<WarehouseReservationResponse> {
    const callerService = maybeKey ? idempotencyKeyOrCaller : undefined;
    const idempotencyKey = (maybeKey ?? idempotencyKeyOrCaller).trim();
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = this.schemaPrefix(em);
      const rows = callerService
        ? await em.query(
            `
            SELECT
              id,
              tenant_id AS "tenantId",
              caller_service AS "callerService",
              source_ref_type AS "sourceRefType",
              source_ref_id AS "sourceRefId",
              state,
              expires_at AS "expiresAt",
              created_at AS "createdAt"
            FROM ${prefix}"warehouse_reservation"
            WHERE tenant_id = $1 AND caller_service = $2 AND idempotency_key = $3
            LIMIT 1
            `,
            [tenantId, callerService, idempotencyKey],
          )
        : await em.query(
            `
            SELECT
              id,
              tenant_id AS "tenantId",
              caller_service AS "callerService",
              source_ref_type AS "sourceRefType",
              source_ref_id AS "sourceRefId",
              state,
              expires_at AS "expiresAt",
              created_at AS "createdAt"
            FROM ${prefix}"warehouse_reservation"
            WHERE tenant_id = $1 AND idempotency_key = $2
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [tenantId, idempotencyKey],
          );
      if (rows.length === 0) {
        throw new NotFoundException({
          errorCode: WarehouseReservationErrorCode.RESERVATION_NOT_FOUND,
          message: `Reservation with idempotency key ${idempotencyKey} not found`,
        });
      }
      return this.loadWarehouseReservationResponse(
        em,
        prefix,
        tenantId,
        rows[0],
      );
    });
  }

  async listWarehouseReservationsByOrder(
    sourceRefId: string,
  ): Promise<WarehouseReservationResponse[]> {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = this.schemaPrefix(em);
      const rows = await em.query(
        `
        SELECT
          id,
          tenant_id AS "tenantId",
          caller_service AS "callerService",
          source_ref_type AS "sourceRefType",
          source_ref_id AS "sourceRefId",
          state,
          expires_at AS "expiresAt",
          created_at AS "createdAt"
        FROM ${prefix}"warehouse_reservation"
        WHERE tenant_id = $1 AND source_ref_id = $2
        ORDER BY created_at DESC
        `,
        [tenantId, sourceRefId],
      );
      const results: WarehouseReservationResponse[] = [];
      for (const r of rows) {
        results.push(
          await this.loadWarehouseReservationResponse(em, prefix, tenantId, r),
        );
      }
      return results;
    });
  }

  async commitWarehouseReservation(
    reservationId: string,
    options?: { fulfillmentId?: string; note?: string },
  ): Promise<WarehouseReservationResponse> {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = this.schemaPrefix(em);
      const rows = await em.query(
        `
        SELECT
          id,
          tenant_id AS "tenantId",
          caller_service AS "callerService",
          source_ref_type AS "sourceRefType",
          source_ref_id AS "sourceRefId",
          state,
          expires_at AS "expiresAt",
          created_at AS "createdAt"
        FROM ${prefix}"warehouse_reservation"
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
        `,
        [tenantId, reservationId],
      );
      if (rows.length === 0) {
        throw new NotFoundException({
          errorCode: WarehouseReservationErrorCode.RESERVATION_NOT_FOUND,
          message: `Reservation ${reservationId} not found`,
        });
      }
      const header = rows[0];
      if (header.state === 'COMMITTED') {
        return this.loadWarehouseReservationResponse(
          em,
          prefix,
          tenantId,
          header,
        );
      }
      if (header.state !== 'HELD') {
        throw new ConflictException({
          errorCode: WarehouseReservationErrorCode.INVALID_RESERVATION_STATE,
          code:
            header.state === 'EXPIRED'
              ? WarehouseReservationErrorCode.RESERVATION_EXPIRED
              : WarehouseReservationErrorCode.RESERVATION_STATE_CONFLICT,
          message: `Cannot commit reservation in state ${header.state}`,
        });
      }

      const lines = await em.query(
        `
        SELECT
          line_no AS "lineNo",
          warehouse_id AS "warehouseId",
          sku_id AS "skuId",
          qty
        FROM ${prefix}"warehouse_reservation_line"
        WHERE tenant_id = $1 AND reservation_id = $2
        ORDER BY warehouse_id ASC, sku_id ASC
        `,
        [tenantId, reservationId],
      );

      const occurredAt = new Date().toISOString();
      for (const line of lines) {
        const qtyStr = formatMilliToDecimal(
          parseDecimalToMilli(String(line.qty)),
        );

        const existingRows = await em.query(
          `
          SELECT
            on_hand_qty AS "onHandQty",
            reserved_qty AS "reservedQty",
            COALESCE(avg_unit_cost, 0) AS "avgUnitCost"
          FROM ${prefix}"stock_balance"
          WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3
          FOR UPDATE
          `,
          [tenantId, line.warehouseId, line.skuId],
        );

        const oldOnHandQty = formatMilliToDecimal(
          parseDecimalToMilli(String(existingRows[0]?.onHandQty ?? '0')),
        );
        const avgCostStr = formatCentsToMoney(
          parseMoneyToCents(String(existingRows[0]?.avgUnitCost ?? '0')),
        );
        const valuation = computeValuationAfterDeduction({
          currentOnHandQty: oldOnHandQty,
          currentAvgUnitCost: avgCostStr,
          deductedBaseQty: qtyStr,
        });

        const [updated] = await em.query(
          `
          UPDATE ${prefix}"stock_balance"
          SET
            on_hand_qty = on_hand_qty - $4::numeric(18,3),
            reserved_qty = reserved_qty - $4::numeric(18,3),
            valuation_amount = $5::numeric(18,2),
            version = version + 1,
            updated_at = now()
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND sku_id = $3
            AND reserved_qty >= $4::numeric(18,3)
            AND on_hand_qty >= $4::numeric(18,3)
          RETURNING
            on_hand_qty AS "onHandQty",
            reserved_qty AS "reservedQty"
          `,
          [
            tenantId,
            line.warehouseId,
            line.skuId,
            qtyStr,
            valuation.newValuationAmount,
          ],
        );

        const onHandAfter = formatMilliToDecimal(
          parseDecimalToMilli(String(updated[0].onHandQty)),
        );
        const reservedAfter = formatMilliToDecimal(
          parseDecimalToMilli(String(updated[0].reservedQty)),
        );
        const qtyDelta = `-${qtyStr}`;

        await em.query(
          `
          INSERT INTO ${prefix}"stock_balance_ledger" (
            id,
            tenant_id,
            warehouse_id,
            sku_id,
            movement_type,
            qty_before,
            qty_delta,
            on_hand_after,
            reserved_after,
            unit_cost,
            avg_cost_after,
            reference_type,
            reference_id,
            reason,
            occurred_at
          ) VALUES (
            $1, $2, $3, $4, 'SALE_COMMIT',
            $5::numeric(18,3), $6::numeric(18,3), $7::numeric(18,3), $8::numeric(18,3),
            $9::numeric(18,2), $10::numeric(18,2), $11, $12, $13, $14
          )
          `,
          [
            randomUUID(),
            tenantId,
            line.warehouseId,
            line.skuId,
            oldOnHandQty,
            qtyDelta,
            onHandAfter,
            reservedAfter,
            avgCostStr,
            avgCostStr,
            header.sourceRefType,
            options?.fulfillmentId ?? header.sourceRefId,
            options?.note ?? null,
            occurredAt,
          ],
        );

        if (this.outbox) {
          await this.outbox.add(em, INVENTORY_STOCK_CHANGED, {
            warehouseId: line.warehouseId,
            skuId: line.skuId,
            movementType: 'SALE_COMMIT',
            qtyDelta,
            onHandAfter,
            reservedAfter,
            unitCost: avgCostStr,
            avgCostAfter: avgCostStr,
            referenceType: header.sourceRefType,
            referenceId: options?.fulfillmentId ?? header.sourceRefId,
            occurredAt,
          } satisfies StockChangedPayload);
        }
      }

      await em.query(
        `
        UPDATE ${prefix}"warehouse_reservation"
        SET
          state = 'COMMITTED',
          fulfillment_id = COALESCE($3::uuid, fulfillment_id),
          note = COALESCE($4, note),
          updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        `,
        [
          tenantId,
          reservationId,
          options?.fulfillmentId ?? null,
          options?.note ?? null,
        ],
      );

      if (this.outbox) {
        await this.outbox.add(em, INVENTORY_RESERVATION_COMMITTED, {
          reservationId,
          sourceRefType: header.sourceRefType,
          sourceRefId: header.sourceRefId,
          state: 'COMMITTED',
          occurredAt,
          lines: lines.map((l: Record<string, unknown>) => ({
            warehouseId: String(l.warehouseId),
            skuId: String(l.skuId),
            qty: formatMilliToDecimal(parseDecimalToMilli(String(l.qty))),
          })),
        } satisfies ReservationLifecycleEventPayload);
      }

      return this.loadWarehouseReservationResponse(em, prefix, tenantId, {
        ...header,
        state: 'COMMITTED',
      });
    });
  }

  async releaseWarehouseReservation(
    reservationId: string,
    reasonOrOptions?: string | { reason?: string; note?: string },
  ): Promise<WarehouseReservationResponse> {
    const reason =
      typeof reasonOrOptions === 'string'
        ? reasonOrOptions
        : reasonOrOptions?.reason;
    const note =
      typeof reasonOrOptions === 'object' ? reasonOrOptions?.note : undefined;
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = this.schemaPrefix(em);
      const rows = await em.query(
        `
        SELECT
          id,
          tenant_id AS "tenantId",
          caller_service AS "callerService",
          source_ref_type AS "sourceRefType",
          source_ref_id AS "sourceRefId",
          state,
          expires_at AS "expiresAt",
          created_at AS "createdAt"
        FROM ${prefix}"warehouse_reservation"
        WHERE tenant_id = $1 AND id = $2
        FOR UPDATE
        `,
        [tenantId, reservationId],
      );
      if (rows.length === 0) {
        throw new NotFoundException({
          errorCode: WarehouseReservationErrorCode.RESERVATION_NOT_FOUND,
          message: `Reservation ${reservationId} not found`,
        });
      }
      const header = rows[0];
      if (header.state === 'RELEASED' || header.state === 'EXPIRED') {
        return this.loadWarehouseReservationResponse(
          em,
          prefix,
          tenantId,
          header,
        );
      }
      if (header.state === 'COMMITTED') {
        throw new ConflictException({
          errorCode: WarehouseReservationErrorCode.INVALID_RESERVATION_STATE,
          code: WarehouseReservationErrorCode.RESERVATION_ALREADY_COMMITTED,
          message: 'Cannot release a committed reservation',
        });
      }

      const lines = await em.query(
        `
        SELECT
          warehouse_id AS "warehouseId",
          sku_id AS "skuId",
          qty
        FROM ${prefix}"warehouse_reservation_line"
        WHERE tenant_id = $1 AND reservation_id = $2
        ORDER BY warehouse_id ASC, sku_id ASC
        `,
        [tenantId, reservationId],
      );

      for (const line of lines) {
        const qtyStr = formatMilliToDecimal(
          parseDecimalToMilli(String(line.qty)),
        );
        await em.query(
          `
          UPDATE ${prefix}"stock_balance"
          SET
            reserved_qty = reserved_qty - $4::numeric(18,3),
            version = version + 1,
            updated_at = now()
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND sku_id = $3
            AND reserved_qty >= $4::numeric(18,3)
          `,
          [tenantId, line.warehouseId, line.skuId, qtyStr],
        );
      }

      const occurredAt = new Date().toISOString();
      await em.query(
        `
        UPDATE ${prefix}"warehouse_reservation"
        SET
          state = 'RELEASED',
          release_reason = COALESCE($3, release_reason),
          note = COALESCE($4, note),
          updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        `,
        [tenantId, reservationId, reason ?? 'ORDER_CANCELLED', note ?? null],
      );

      if (this.outbox) {
        await this.outbox.add(em, INVENTORY_RESERVATION_RELEASED, {
          reservationId,
          sourceRefType: header.sourceRefType,
          sourceRefId: header.sourceRefId,
          state: 'RELEASED',
          reason: reason ?? 'ORDER_CANCELLED',
          occurredAt,
          lines: lines.map((l: Record<string, unknown>) => ({
            warehouseId: String(l.warehouseId),
            skuId: String(l.skuId),
            qty: formatMilliToDecimal(parseDecimalToMilli(String(l.qty))),
          })),
        } satisfies ReservationLifecycleEventPayload);
      }

      return this.loadWarehouseReservationResponse(em, prefix, tenantId, {
        ...header,
        state: 'RELEASED',
      });
    });
  }

  /**
   * Atomically expires a single HELD warehouse reservation if its expires_at < now(),
   * using FOR UPDATE SKIP LOCKED so concurrent expiry workers or concurrent commit
   * operations never double-release or corrupt reserved_qty (Test F).
   */
  async expireWarehouseReservation(reservationId: string): Promise<boolean> {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = this.schemaPrefix(em);
      const rows = await em.query(
        `
        SELECT
          id,
          tenant_id AS "tenantId",
          caller_service AS "callerService",
          source_ref_type AS "sourceRefType",
          source_ref_id AS "sourceRefId",
          state,
          expires_at AS "expiresAt",
          created_at AS "createdAt"
        FROM ${prefix}"warehouse_reservation"
        WHERE tenant_id = $1
          AND id = $2
          AND state = 'HELD'
          AND expires_at < now()
        FOR UPDATE SKIP LOCKED
        `,
        [tenantId, reservationId],
      );
      if (rows.length === 0) {
        return false;
      }
      const header = rows[0];
      const lines = await em.query(
        `
        SELECT
          warehouse_id AS "warehouseId",
          sku_id AS "skuId",
          qty
        FROM ${prefix}"warehouse_reservation_line"
        WHERE tenant_id = $1 AND reservation_id = $2
        ORDER BY warehouse_id ASC, sku_id ASC
        `,
        [tenantId, reservationId],
      );

      for (const line of lines) {
        const qtyStr = formatMilliToDecimal(
          parseDecimalToMilli(String(line.qty)),
        );
        await em.query(
          `
          UPDATE ${prefix}"stock_balance"
          SET
            reserved_qty = reserved_qty - $4::numeric(18,3),
            version = version + 1,
            updated_at = now()
          WHERE tenant_id = $1
            AND warehouse_id = $2
            AND sku_id = $3
            AND reserved_qty >= $4::numeric(18,3)
          `,
          [tenantId, line.warehouseId, line.skuId, qtyStr],
        );
      }

      const occurredAt = new Date().toISOString();
      await em.query(
        `
        UPDATE ${prefix}"warehouse_reservation"
        SET
          state = 'EXPIRED',
          release_reason = 'EXPIRED',
          updated_at = now()
        WHERE tenant_id = $1 AND id = $2
        `,
        [tenantId, reservationId],
      );

      if (this.outbox) {
        await this.outbox.add(em, INVENTORY_RESERVATION_EXPIRED, {
          reservationId,
          sourceRefType: header.sourceRefType,
          sourceRefId: header.sourceRefId,
          state: 'EXPIRED',
          reason: 'EXPIRED',
          occurredAt,
          lines: lines.map((l: Record<string, unknown>) => ({
            warehouseId: String(l.warehouseId),
            skuId: String(l.skuId),
            qty: formatMilliToDecimal(parseDecimalToMilli(String(l.qty))),
          })),
        } satisfies ReservationLifecycleEventPayload);
      }

      return true;
    });
  }

  /**
   * Scans due HELD warehouse reservations for the active tenant and expires them
   * one by one using FOR UPDATE SKIP LOCKED.
   */
  async expireDueWarehouseReservations(limit = 50): Promise<number> {
    const activeTenant = TenantContext.current();
    if (!activeTenant) {
      return 0;
    }
    const candidates = await runInTenantTransaction(
      this.dataSource,
      async (em, tenantId) => {
        const prefix = this.schemaPrefix(em);
        return em.query(
          `
          SELECT id
          FROM ${prefix}"warehouse_reservation"
          WHERE tenant_id = $1 AND state = 'HELD' AND expires_at < now()
          ORDER BY expires_at ASC
          LIMIT $2
          `,
          [tenantId, limit],
        );
      },
    );

    let expiredCount = 0;
    for (const row of candidates) {
      const ok = await this.expireWarehouseReservation(String(row.id));
      if (ok) expiredCount += 1;
    }
    return expiredCount;
  }

  private async loadWarehouseReservationResponse(
    em: EntityManager,
    prefix: string,
    tenantId: string,
    header: {
      id: string;
      tenantId: string;
      callerService: string;
      sourceRefType: 'ORDER' | 'TRANSFER' | 'RETURN';
      sourceRefId: string;
      state: WarehouseReservationState;
      expiresAt: Date | string;
      createdAt: Date | string;
    },
  ): Promise<WarehouseReservationResponse> {
    const lines = await em.query(
      `
      SELECT
        l.line_no AS "lineNo",
        l.warehouse_id AS "warehouseId",
        l.sku_id AS "skuId",
        l.qty AS "qty",
        COALESCE(b.on_hand_qty, 0) AS "onHandAfter",
        COALESCE(b.reserved_qty, 0) AS "reservedAfter",
        COALESCE(b.on_hand_qty - b.reserved_qty, 0) AS "availableAfter"
      FROM ${prefix}"warehouse_reservation_line" l
      LEFT JOIN ${prefix}"stock_balance" b
        ON b.tenant_id = l.tenant_id
        AND b.warehouse_id = l.warehouse_id
        AND b.sku_id = l.sku_id
      WHERE l.tenant_id = $1 AND l.reservation_id = $2
      ORDER BY l.line_no ASC
      `,
      [tenantId, header.id],
    );

    return {
      reservationId: header.id,
      tenantId: header.tenantId,
      callerService: header.callerService,
      sourceRefType: header.sourceRefType,
      sourceRefId: header.sourceRefId,
      state: header.state,
      expiresAt:
        header.expiresAt instanceof Date
          ? header.expiresAt.toISOString()
          : new Date(header.expiresAt).toISOString(),
      createdAt:
        header.createdAt instanceof Date
          ? header.createdAt.toISOString()
          : new Date(header.createdAt).toISOString(),
      lines: lines.map((l: Record<string, unknown>) => ({
        lineNo: Number(l.lineNo),
        warehouseId: String(l.warehouseId),
        skuId: String(l.skuId),
        qty: formatMilliToDecimal(parseDecimalToMilli(String(l.qty))),
        onHandAfter: formatMilliToDecimal(
          parseDecimalToMilli(String(l.onHandAfter)),
        ),
        reservedAfter: formatMilliToDecimal(
          parseDecimalToMilli(String(l.reservedAfter)),
        ),
        availableAfter: formatMilliToDecimal(
          parseDecimalToMilli(String(l.availableAfter)),
        ),
      })),
    };
  }
}
