import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { runInTenantTransaction } from '@pbl/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  formatCentsToMoney,
  formatMilliToQty,
  InventoryDomainError,
  InventoryDomainErrorCode,
  parseMoneyToCents,
  parseQtyToMilli,
} from '../../domain/inventory-domain';
import {
  assertActiveWarehouse,
  schemaPrefix,
} from '../warehouses/warehouses.service';
import {
  ListStockMovementsQueryDto,
  ListStocksQueryDto,
  ListStockThresholdsQueryDto,
  UpsertStockThresholdDto,
} from './stock-query.dto';

export interface ReconciliationMismatch {
  warehouseId: string;
  skuId: string;
  kind:
    | 'ON_HAND_VS_LEDGER'
    | 'RESERVED_VS_HELD_LINES'
    | 'IN_TRANSIT_VS_TRANSFERS';
  balanceValue: string;
  expectedValue: string;
  delta: string;
}

@Injectable()
export class StockQueryService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async listStocks(query: ListStocksQueryDto) {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = schemaPrefix(em);
      const params: unknown[] = [tenantId];
      const filters: string[] = [];

      if (query.warehouseId) {
        params.push(query.warehouseId);
        filters.push(`AND b.warehouse_id = $${params.length}`);
      }
      if (query.skuId) {
        params.push(query.skuId);
        filters.push(`AND b.sku_id = $${params.length}`);
      }
      if (query.belowThreshold === 'true') {
        filters.push(
          `AND t.min_qty IS NOT NULL AND (b.on_hand_qty - b.reserved_qty) < t.min_qty`,
        );
      }

      const countRows = await em.query(
        `
        SELECT COUNT(*)::int AS total
        FROM ${prefix}"stock_balance" b
        LEFT JOIN ${prefix}"stock_threshold" t
          ON t.tenant_id = b.tenant_id
          AND t.warehouse_id = b.warehouse_id
          AND t.sku_id = b.sku_id
        WHERE b.tenant_id = $1 ${filters.join(' ')}
        `,
        params,
      );
      const totalRecords = Number(countRows[0]?.total ?? 0);
      const limit = query.limit ?? 20;
      const page = query.page ?? 1;
      const offset = (page - 1) * limit;
      const totalPages = Math.max(1, Math.ceil(totalRecords / limit));

      const dataParams = [...params, limit, offset];
      const rows = await em.query(
        `
        SELECT
          b.id,
          b.tenant_id AS "tenantId",
          b.warehouse_id AS "warehouseId",
          w.code AS "warehouseCode",
          w.name AS "warehouseName",
          b.sku_id AS "skuId",
          b.on_hand_qty AS "onHandQty",
          b.reserved_qty AS "reservedQty",
          (b.on_hand_qty - b.reserved_qty) AS "availableQty",
          b.in_transit_qty AS "inTransitQty",
          COALESCE(b.avg_unit_cost, 0) AS "avgUnitCost",
          COALESCE(b.valuation_amount, 0) AS "valuationAmount",
          b.version,
          t.min_qty AS "minQty",
          t.max_qty AS "maxQty",
          b.updated_at AS "updatedAt"
        FROM ${prefix}"stock_balance" b
        INNER JOIN ${prefix}"warehouse" w
          ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
        LEFT JOIN ${prefix}"stock_threshold" t
          ON t.tenant_id = b.tenant_id
          AND t.warehouse_id = b.warehouse_id
          AND t.sku_id = b.sku_id
        WHERE b.tenant_id = $1 ${filters.join(' ')}
        ORDER BY b.warehouse_id ASC, b.sku_id ASC
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}
        `,
        dataParams,
      );

      return {
        data: rows.map((r: Record<string, unknown>) =>
          this.formatBalanceRow(r),
        ),
        pagination: {
          limit,
          currentPage: page,
          ...(page < totalPages ? { nextPage: page + 1 } : {}),
          totalRecords,
          totalPages,
        },
      };
    });
  }

  async getStockBySku(skuId: string) {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = schemaPrefix(em);
      const rows = await em.query(
        `
        SELECT
          b.id,
          b.tenant_id AS "tenantId",
          b.warehouse_id AS "warehouseId",
          w.code AS "warehouseCode",
          w.name AS "warehouseName",
          b.sku_id AS "skuId",
          b.on_hand_qty AS "onHandQty",
          b.reserved_qty AS "reservedQty",
          (b.on_hand_qty - b.reserved_qty) AS "availableQty",
          b.in_transit_qty AS "inTransitQty",
          COALESCE(b.avg_unit_cost, 0) AS "avgUnitCost",
          COALESCE(b.valuation_amount, 0) AS "valuationAmount",
          b.version,
          t.min_qty AS "minQty",
          t.max_qty AS "maxQty",
          b.updated_at AS "updatedAt"
        FROM ${prefix}"stock_balance" b
        INNER JOIN ${prefix}"warehouse" w
          ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
        LEFT JOIN ${prefix}"stock_threshold" t
          ON t.tenant_id = b.tenant_id
          AND t.warehouse_id = b.warehouse_id
          AND t.sku_id = b.sku_id
        WHERE b.tenant_id = $1
          AND (
            b.sku_id::text = $2
            OR EXISTS (
              SELECT 1 FROM ${prefix}"catalog_sku_projection" csp
              WHERE csp.tenant_id = b.tenant_id
                AND csp.sku_id = b.sku_id
                AND csp.sku_code = $2
            )
          )
        ORDER BY w.code ASC
        `,
        [tenantId, skuId],
      );

      const warehouses = rows.map((r: Record<string, unknown>) =>
        this.formatBalanceRow(r),
      );

      let totalOnHandMilli = 0n;
      let totalReservedMilli = 0n;
      let totalAvailableMilli = 0n;
      let totalInTransitMilli = 0n;
      let totalValuationCents = 0n;

      for (const wh of warehouses) {
        totalOnHandMilli += parseQtyToMilli(wh.onHandQty, true, false);
        totalReservedMilli += parseQtyToMilli(wh.reservedQty, true, false);
        totalAvailableMilli += parseQtyToMilli(wh.availableQty, true, false);
        totalInTransitMilli += parseQtyToMilli(wh.inTransitQty, true, false);
        totalValuationCents += parseMoneyToCents(wh.valuationAmount);
      }

      return {
        skuId,
        tenantId,
        totalOnHandQty: formatMilliToQty(totalOnHandMilli),
        totalReservedQty: formatMilliToQty(totalReservedMilli),
        totalAvailableQty: formatMilliToQty(totalAvailableMilli),
        totalInTransitQty: formatMilliToQty(totalInTransitMilli),
        totalValuationAmount: formatCentsToMoney(totalValuationCents),
        warehouses,
      };
    });
  }

  async listMovements(query: ListStockMovementsQueryDto) {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = schemaPrefix(em);
      const params: unknown[] = [tenantId];
      const filters: string[] = [];

      if (query.warehouseId) {
        params.push(query.warehouseId);
        filters.push(`AND warehouse_id = $${params.length}`);
      }
      if (query.skuId) {
        params.push(query.skuId);
        filters.push(`AND sku_id = $${params.length}`);
      }
      if (query.movementType) {
        params.push(query.movementType);
        filters.push(`AND movement_type = $${params.length}`);
      }
      if (query.referenceType) {
        params.push(query.referenceType);
        filters.push(`AND reference_type = $${params.length}`);
      }
      if (query.referenceId) {
        params.push(query.referenceId);
        filters.push(`AND reference_id = $${params.length}`);
      }

      const countRows = await em.query(
        `
        SELECT COUNT(*)::int AS total
        FROM ${prefix}"stock_balance_ledger"
        WHERE tenant_id = $1 ${filters.join(' ')}
        `,
        params,
      );
      const totalRecords = Number(countRows[0]?.total ?? 0);
      const limit = query.limit ?? 20;
      const page = query.page ?? 1;
      const offset = (page - 1) * limit;
      const totalPages = Math.max(1, Math.ceil(totalRecords / limit));

      const dataParams = [...params, limit, offset];
      const rows = await em.query(
        `
        SELECT
          id,
          tenant_id AS "tenantId",
          warehouse_id AS "warehouseId",
          sku_id AS "skuId",
          movement_type AS "movementType",
          COALESCE(qty_before, on_hand_after - qty_delta) AS "qtyBefore",
          qty_delta AS "qtyDelta",
          on_hand_after AS "onHandAfter",
          reserved_after AS "reservedAfter",
          COALESCE(unit_cost, 0) AS "unitCost",
          COALESCE(avg_cost_after, 0) AS "avgCostAfter",
          reference_type AS "referenceType",
          reference_id AS "referenceId",
          actor_id AS "actorId",
          correlation_id AS "correlationId",
          reason,
          occurred_at AS "occurredAt",
          created_at AS "createdAt"
        FROM ${prefix}"stock_balance_ledger"
        WHERE tenant_id = $1 ${filters.join(' ')}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}
        `,
        dataParams,
      );

      return {
        data: rows.map((r: Record<string, unknown>) => ({
          ...r,
          qtyBefore: formatMilliToQty(
            parseQtyToMilli(String(r.qtyBefore ?? '0'), true, true),
          ),
          qtyDelta: formatMilliToQty(
            parseQtyToMilli(String(r.qtyDelta), false, true),
          ),
          onHandAfter: formatMilliToQty(
            parseQtyToMilli(String(r.onHandAfter), true, false),
          ),
          reservedAfter: formatMilliToQty(
            parseQtyToMilli(String(r.reservedAfter), true, false),
          ),
          unitCost: formatCentsToMoney(
            parseMoneyToCents(String(r.unitCost ?? '0')),
          ),
          avgCostAfter: formatCentsToMoney(
            parseMoneyToCents(String(r.avgCostAfter ?? '0')),
          ),
        })),
        pagination: {
          limit,
          currentPage: page,
          ...(page < totalPages ? { nextPage: page + 1 } : {}),
          totalRecords,
          totalPages,
        },
      };
    });
  }

  async upsertThreshold(dto: UpsertStockThresholdDto) {
    const minMilli = parseQtyToMilli(dto.minQty, true, false);
    const maxMilli =
      dto.maxQty !== undefined && dto.maxQty !== null
        ? parseQtyToMilli(dto.maxQty, true, false)
        : null;
    if (maxMilli !== null && maxMilli < minMilli) {
      throw new InventoryDomainError(
        InventoryDomainErrorCode.INVALID_QUANTITY,
        'maxQty must be greater than or equal to minQty',
        400,
      );
    }

    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = schemaPrefix(em);
      await assertActiveWarehouse(em, prefix, tenantId, dto.warehouseId);

      const minStr = formatMilliToQty(minMilli);
      const maxStr = maxMilli !== null ? formatMilliToQty(maxMilli) : null;

      const rows = await em.query(
        `
        INSERT INTO ${prefix}"stock_threshold" (
          id, tenant_id, warehouse_id, sku_id, min_qty, max_qty, updated_at
        ) VALUES ($1, $2, $3, $4, $5::numeric(18,3), $6::numeric(18,3), now())
        ON CONFLICT (tenant_id, warehouse_id, sku_id) DO UPDATE
        SET
          min_qty = EXCLUDED.min_qty,
          max_qty = EXCLUDED.max_qty,
          updated_at = now()
        RETURNING
          id,
          tenant_id AS "tenantId",
          warehouse_id AS "warehouseId",
          sku_id AS "skuId",
          min_qty AS "minQty",
          max_qty AS "maxQty",
          updated_at AS "updatedAt"
        `,
        [randomUUID(), tenantId, dto.warehouseId, dto.skuId, minStr, maxStr],
      );
      const row = rows[0];
      return {
        ...row,
        minQty: formatMilliToQty(
          parseQtyToMilli(String(row.minQty), true, false),
        ),
        maxQty:
          row.maxQty !== null
            ? formatMilliToQty(parseQtyToMilli(String(row.maxQty), true, false))
            : null,
      };
    });
  }

  async listThresholds(query: ListStockThresholdsQueryDto) {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = schemaPrefix(em);
      const params: unknown[] = [tenantId];
      const filters: string[] = [];

      if (query.warehouseId) {
        params.push(query.warehouseId);
        filters.push(`AND t.warehouse_id = $${params.length}`);
      }
      if (query.onlyAlerts === 'true') {
        filters.push(
          `AND COALESCE(b.on_hand_qty - b.reserved_qty, 0) < t.min_qty`,
        );
      }

      const rows = await em.query(
        `
        SELECT
          t.id,
          t.tenant_id AS "tenantId",
          t.warehouse_id AS "warehouseId",
          t.sku_id AS "skuId",
          t.min_qty AS "minQty",
          t.max_qty AS "maxQty",
          COALESCE(b.on_hand_qty, 0) AS "onHandQty",
          COALESCE(b.reserved_qty, 0) AS "reservedQty",
          COALESCE(b.on_hand_qty - b.reserved_qty, 0) AS "availableQty",
          (COALESCE(b.on_hand_qty - b.reserved_qty, 0) < t.min_qty) AS "isAlert",
          t.updated_at AS "updatedAt"
        FROM ${prefix}"stock_threshold" t
        LEFT JOIN ${prefix}"stock_balance" b
          ON b.tenant_id = t.tenant_id
          AND b.warehouse_id = t.warehouse_id
          AND b.sku_id = t.sku_id
        WHERE t.tenant_id = $1 ${filters.join(' ')}
        ORDER BY t.warehouse_id ASC, t.sku_id ASC
        `,
        params,
      );

      return rows.map((r: Record<string, unknown>) => ({
        ...r,
        minQty: formatMilliToQty(
          parseQtyToMilli(String(r.minQty), true, false),
        ),
        maxQty:
          r.maxQty !== null
            ? formatMilliToQty(parseQtyToMilli(String(r.maxQty), true, false))
            : null,
        onHandQty: formatMilliToQty(
          parseQtyToMilli(String(r.onHandQty), true, false),
        ),
        reservedQty: formatMilliToQty(
          parseQtyToMilli(String(r.reservedQty), true, false),
        ),
        availableQty: formatMilliToQty(
          parseQtyToMilli(String(r.availableQty), true, false),
        ),
        isAlert: Boolean(r.isAlert),
      }));
    });
  }

  /**
   * Reconciles authoritative `stock_balance` rows against:
   * 1. Sum of physical `stock_balance_ledger.qty_delta` movements.
   * 2. Sum of active `HELD` `warehouse_reservation_line.qty`.
   * 3. Sum of unresolved in-transit `stock_transfer_item` quantities targeting `to_warehouse_id`.
   * Never silently overwrites authoritative balances; returns a structured diagnostic report.
   */
  async reconcile() {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = schemaPrefix(em);

      const balances = await em.query(
        `
        SELECT
          warehouse_id AS "warehouseId",
          sku_id AS "skuId",
          on_hand_qty AS "onHandQty",
          reserved_qty AS "reservedQty",
          in_transit_qty AS "inTransitQty"
        FROM ${prefix}"stock_balance"
        WHERE tenant_id = $1
        ORDER BY warehouse_id ASC, sku_id ASC
        `,
        [tenantId],
      );

      const ledgerSums = await em.query(
        `
        SELECT
          warehouse_id AS "warehouseId",
          sku_id AS "skuId",
          COALESCE(SUM(qty_delta), 0) AS "ledgerNetQty"
        FROM ${prefix}"stock_balance_ledger"
        WHERE tenant_id = $1
        GROUP BY warehouse_id, sku_id
        `,
        [tenantId],
      );

      const heldSums = await em.query(
        `
        SELECT
          l.warehouse_id AS "warehouseId",
          l.sku_id AS "skuId",
          COALESCE(SUM(l.qty), 0) AS "heldQty"
        FROM ${prefix}"warehouse_reservation_line" l
        INNER JOIN ${prefix}"warehouse_reservation" r
          ON r.tenant_id = l.tenant_id AND r.id = l.reservation_id
        WHERE l.tenant_id = $1 AND r.state = 'HELD'
        GROUP BY l.warehouse_id, l.sku_id
        `,
        [tenantId],
      );

      const inTransitSums = await em.query(
        `
        SELECT
          t.to_warehouse_id AS "warehouseId",
          ti.sku_id AS "skuId",
          COALESCE(SUM(ti.dispatched_qty - ti.received_qty - ti.discrepancy_qty), 0) AS "inTransitQty"
        FROM ${prefix}"stock_transfer_item" ti
        INNER JOIN ${prefix}"stock_transfer" t
          ON t.tenant_id = ti.tenant_id AND t.id = ti.transfer_id
        WHERE ti.tenant_id = $1
          AND t.status IN ('DISPATCHED', 'PARTIALLY_RECEIVED', 'DISCREPANCY')
        GROUP BY t.to_warehouse_id, ti.sku_id
        `,
        [tenantId],
      );

      const ledgerMap = new Map<string, bigint>();
      for (const r of ledgerSums) {
        ledgerMap.set(
          `${r.warehouseId}:${r.skuId}`,
          parseQtyToMilli(String(r.ledgerNetQty), true, true),
        );
      }

      const heldMap = new Map<string, bigint>();
      for (const r of heldSums) {
        heldMap.set(
          `${r.warehouseId}:${r.skuId}`,
          parseQtyToMilli(String(r.heldQty), true, false),
        );
      }

      const transitMap = new Map<string, bigint>();
      for (const r of inTransitSums) {
        transitMap.set(
          `${r.warehouseId}:${r.skuId}`,
          parseQtyToMilli(String(r.inTransitQty), true, true),
        );
      }

      const mismatches: ReconciliationMismatch[] = [];
      for (const b of balances) {
        const key = `${b.warehouseId}:${b.skuId}`;
        const onHandMilli = parseQtyToMilli(String(b.onHandQty), true, false);
        const reservedMilli = parseQtyToMilli(
          String(b.reservedQty),
          true,
          false,
        );
        const inTransitMilli = parseQtyToMilli(
          String(b.inTransitQty),
          true,
          false,
        );

        const expectedOnHand = ledgerMap.get(key) ?? 0n;
        if (onHandMilli !== expectedOnHand) {
          mismatches.push({
            warehouseId: b.warehouseId,
            skuId: b.skuId,
            kind: 'ON_HAND_VS_LEDGER',
            balanceValue: formatMilliToQty(onHandMilli),
            expectedValue: formatMilliToQty(expectedOnHand),
            delta: formatMilliToQty(onHandMilli - expectedOnHand),
          });
        }

        const expectedReserved = heldMap.get(key) ?? 0n;
        if (reservedMilli !== expectedReserved) {
          mismatches.push({
            warehouseId: b.warehouseId,
            skuId: b.skuId,
            kind: 'RESERVED_VS_HELD_LINES',
            balanceValue: formatMilliToQty(reservedMilli),
            expectedValue: formatMilliToQty(expectedReserved),
            delta: formatMilliToQty(reservedMilli - expectedReserved),
          });
        }

        const expectedInTransit = transitMap.get(key) ?? 0n;
        if (inTransitMilli !== expectedInTransit) {
          mismatches.push({
            warehouseId: b.warehouseId,
            skuId: b.skuId,
            kind: 'IN_TRANSIT_VS_TRANSFERS',
            balanceValue: formatMilliToQty(inTransitMilli),
            expectedValue: formatMilliToQty(expectedInTransit),
            delta: formatMilliToQty(inTransitMilli - expectedInTransit),
          });
        }
      }

      return {
        tenantId,
        checkedAt: new Date().toISOString(),
        checkedBalancesCount: balances.length,
        consistent: mismatches.length === 0,
        mismatchesCount: mismatches.length,
        mismatches,
      };
    });
  }

  private formatBalanceRow(r: Record<string, unknown>) {
    const onHandMilli = parseQtyToMilli(
      String(r.onHandQty ?? '0'),
      true,
      false,
    );
    const reservedMilli = parseQtyToMilli(
      String(r.reservedQty ?? '0'),
      true,
      false,
    );
    const availableMilli = onHandMilli - reservedMilli;
    const inTransitMilli = parseQtyToMilli(
      String(r.inTransitQty ?? '0'),
      true,
      false,
    );
    const minMilli =
      r.minQty !== undefined && r.minQty !== null
        ? parseQtyToMilli(String(r.minQty), true, false)
        : null;
    const maxMilli =
      r.maxQty !== undefined && r.maxQty !== null
        ? parseQtyToMilli(String(r.maxQty), true, false)
        : null;

    return {
      id: r.id,
      tenantId: r.tenantId,
      warehouseId: r.warehouseId,
      warehouseCode: r.warehouseCode,
      warehouseName: r.warehouseName,
      skuId: r.skuId,
      onHandQty: formatMilliToQty(onHandMilli),
      reservedQty: formatMilliToQty(reservedMilli),
      availableQty: formatMilliToQty(availableMilli),
      inTransitQty: formatMilliToQty(inTransitMilli),
      avgUnitCost: formatCentsToMoney(
        parseMoneyToCents(String(r.avgUnitCost ?? '0')),
      ),
      valuationAmount: formatCentsToMoney(
        parseMoneyToCents(String(r.valuationAmount ?? '0')),
      ),
      version: Number(r.version ?? 0),
      minQty: minMilli !== null ? formatMilliToQty(minMilli) : null,
      maxQty: maxMilli !== null ? formatMilliToQty(maxMilli) : null,
      belowThreshold: minMilli !== null ? availableMilli < minMilli : false,
      updatedAt: r.updatedAt,
    };
  }
}
