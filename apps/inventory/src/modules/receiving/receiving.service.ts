import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { RequestContext, runInTenantTransaction } from '@pbl/common';
import {
  INVENTORY_STOCK_CHANGED,
  INVENTORY_STOCK_RECEIVED,
  StockChangedPayload,
} from '@pbl/contracts';
import { EventOutbox } from '@pbl/events';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  computeWeightedAverageCostOnReceipt,
  convertToBaseQtyMilli,
  evaluateStockReceiptPostTransition,
  formatCentsToMoney,
  formatFactorFromTenThousandths,
  formatMilliToQty,
  InventoryDomainError,
  InventoryDomainErrorCode,
  normalizeInventoryCode,
  parseConversionFactorToTenThousandths,
  parseMoneyToCents,
  parseQtyToMilli,
} from '../../domain/inventory-domain';
import { assertCatalogSkuEligible } from '../../infrastructure/catalog-reference/catalog-sku-projection.handler';
import {
  assertActiveWarehouse,
  schemaPrefix,
} from '../warehouses/warehouses.service';
import { CreateStockReceiptDto } from './receiving.dto';

@Injectable()
export class ReceivingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly outbox?: EventOutbox,
  ) {}

  async createReceipt(dto: CreateStockReceiptDto, idempotencyKey?: string) {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      return this.createReceiptInTx(em, tenantId, dto, idempotencyKey);
    });
  }

  async createReceiptInTx(
    em: EntityManager,
    tenantId: string,
    dto: CreateStockReceiptDto,
    idempotencyKey?: string,
  ) {
    const prefix = schemaPrefix(em);
    const cleanKey = idempotencyKey?.trim() || null;

    if (cleanKey) {
      const existingByKey = await em.query(
        `
        SELECT id
        FROM ${prefix}"stock_receipt"
        WHERE tenant_id = $1 AND idempotency_key = $2
        LIMIT 1
        `,
        [tenantId, cleanKey],
      );
      if (existingByKey.length > 0) {
        return this.loadReceiptResponse(
          em,
          prefix,
          tenantId,
          existingByKey[0].id,
        );
      }
    }

    await assertActiveWarehouse(em, prefix, tenantId, dto.warehouseId);

    // Merge duplicate SKU lines deterministically
    const mergedMap = new Map<
      string,
      {
        skuId: string;
        baseQtyMilli: bigint;
        unitCostCents: bigint;
        unitName: string;
        conversionFactor: string;
      }
    >();

    for (const item of dto.items) {
      const resolvedSkuId = await assertCatalogSkuEligible(
        em,
        prefix,
        tenantId,
        item.skuId,
      );
      const factor = parseConversionFactorToTenThousandths(
        item.conversionFactor,
      );
      const baseQtyMilli = convertToBaseQtyMilli(
        item.qty,
        item.conversionFactor,
      );
      const unitCostCents = parseMoneyToCents(item.unitCost ?? '0.00');
      const existing = mergedMap.get(resolvedSkuId);
      if (existing) {
        // Weighted average unit cost across duplicate lines in the same receipt
        const totalQty = existing.baseQtyMilli + baseQtyMilli;
        const totalVal =
          existing.baseQtyMilli * existing.unitCostCents +
          baseQtyMilli * unitCostCents;
        existing.unitCostCents = (totalVal + totalQty / 2n) / totalQty;
        existing.baseQtyMilli = totalQty;
      } else {
        mergedMap.set(resolvedSkuId, {
          skuId: resolvedSkuId,
          baseQtyMilli,
          unitCostCents,
          unitName: (item.unitName ?? 'PCS').trim().toUpperCase(),
          conversionFactor: formatFactorFromTenThousandths(factor),
        });
      }
    }

    const sortedLines = Array.from(mergedMap.values()).sort((a, b) =>
      a.skuId.localeCompare(b.skuId),
    );

    const receiptId = randomUUID();
    const code = dto.code
      ? normalizeInventoryCode(dto.code, 'receipt code')
      : `RCV-${receiptId.slice(0, 8).toUpperCase()}`;

    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const safePoId =
      dto.purchaseOrderId && uuidRegex.test(dto.purchaseOrderId)
        ? dto.purchaseOrderId
        : null;
    const safeSupplierId =
      dto.supplierId && uuidRegex.test(dto.supplierId) ? dto.supplierId : null;

    await em.query(
      `
      INSERT INTO ${prefix}"stock_receipt" (
        id, tenant_id, code, warehouse_id, source_type, purchase_order_id,
        supplier_id, status, idempotency_key, note, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8, $9, $10)
      `,
      [
        receiptId,
        tenantId,
        code,
        dto.warehouseId,
        dto.sourceType ?? 'MANUAL',
        safePoId,
        safeSupplierId,
        cleanKey,
        dto.note ?? null,
        RequestContext.get()?.actor?.id ?? null,
      ],
    );

    for (let i = 0; i < sortedLines.length; i += 1) {
      const line = sortedLines[i];
      await em.query(
        `
        INSERT INTO ${prefix}"stock_receipt_item" (
          id, tenant_id, receipt_id, line_no, sku_id, qty, unit_cost, unit_name, conversion_factor
        ) VALUES ($1, $2, $3, $4, $5, $6::numeric(18,3), $7::numeric(18,2), $8, $9::numeric(18,4))
        `,
        [
          randomUUID(),
          tenantId,
          receiptId,
          i + 1,
          line.skuId,
          formatMilliToQty(line.baseQtyMilli),
          formatCentsToMoney(line.unitCostCents),
          line.unitName,
          line.conversionFactor,
        ],
      );
    }

    if (dto.autoPost) {
      return this.postReceiptInTx(
        em,
        tenantId,
        receiptId,
        cleanKey ?? undefined,
      );
    }

    return this.loadReceiptResponse(em, prefix, tenantId, receiptId);
  }

  async postReceipt(receiptId: string, idempotencyKey?: string) {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      return this.postReceiptInTx(em, tenantId, receiptId, idempotencyKey);
    });
  }

  async postReceiptInTx(
    em: EntityManager,
    tenantId: string,
    receiptId: string,
    idempotencyKey?: string,
  ) {
    const prefix = schemaPrefix(em);

    // 1. Lock receipt row FOR UPDATE to prevent double posting under concurrent requests (Test G)
    const headerRows = await em.query(
      `
      SELECT *
      FROM ${prefix}"stock_receipt"
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE
      `,
      [tenantId, receiptId],
    );
    if (headerRows.length === 0) {
      throw new InventoryDomainError(
        InventoryDomainErrorCode.STOCK_RECEIPT_NOT_FOUND,
        `Stock receipt ${receiptId} not found`,
        404,
      );
    }
    const header = headerRows[0];

    const postDecision = evaluateStockReceiptPostTransition({
      receiptId,
      code: header.code,
      currentStatus: header.status,
      storedIdempotencyKey: header.idempotency_key,
      incomingIdempotencyKey: idempotencyKey,
    });
    if (postDecision === 'IDEMPOTENT_REPLAY') {
      return this.loadReceiptResponse(em, prefix, tenantId, receiptId);
    }

    await assertActiveWarehouse(em, prefix, tenantId, header.warehouse_id);

    const items = await em.query(
      `
      SELECT
        line_no AS "lineNo",
        sku_id AS "skuId",
        qty,
        unit_cost AS "unitCost",
        unit_name AS "unitName",
        conversion_factor AS "conversionFactor"
      FROM ${prefix}"stock_receipt_item"
      WHERE tenant_id = $1 AND receipt_id = $2
      ORDER BY sku_id ASC
      `,
      [tenantId, receiptId],
    );

    const occurredAt = new Date().toISOString();
    const actorId = RequestContext.get()?.actor?.id ?? 'system';
    const correlationId = RequestContext.get()?.requestId ?? null;
    const movementType =
      header.source_type === 'PURCHASE_ORDER'
        ? 'PURCHASE_RECEIPT'
        : header.source_type === 'RETURN'
          ? 'RETURN_RECEIPT'
          : 'MANUAL_RECEIPT';

    for (const item of items) {
      await assertCatalogSkuEligible(em, prefix, tenantId, item.skuId);

      // Lock existing stock_balance row if present
      const existingBalances = await em.query(
        `
        SELECT
          on_hand_qty AS "onHandQty",
          reserved_qty AS "reservedQty",
          COALESCE(avg_unit_cost, 0) AS "avgUnitCost"
        FROM ${prefix}"stock_balance"
        WHERE tenant_id = $1 AND warehouse_id = $2 AND sku_id = $3
        FOR UPDATE
        `,
        [tenantId, header.warehouse_id, item.skuId],
      );

      const oldOnHandQty =
        existingBalances.length > 0
          ? formatMilliToQty(
              parseQtyToMilli(
                String(existingBalances[0].onHandQty),
                true,
                false,
              ),
            )
          : '0.000';
      const oldReservedQty =
        existingBalances.length > 0
          ? formatMilliToQty(
              parseQtyToMilli(
                String(existingBalances[0].reservedQty),
                true,
                false,
              ),
            )
          : '0.000';
      const oldAvgCost =
        existingBalances.length > 0
          ? formatCentsToMoney(
              parseMoneyToCents(String(existingBalances[0].avgUnitCost)),
            )
          : '0.00';

      const qtyStr = formatMilliToQty(
        parseQtyToMilli(String(item.qty), false, false),
      );
      const unitCostStr = formatCentsToMoney(
        parseMoneyToCents(String(item.unitCost ?? '0')),
      );

      const valuation = computeWeightedAverageCostOnReceipt({
        currentOnHandQty: oldOnHandQty,
        currentAvgUnitCost: oldAvgCost,
        receivedBaseQty: qtyStr,
        receivedUnitCost: unitCostStr,
      });

      await em.query(
        `
        INSERT INTO ${prefix}"stock_balance" (
          id, tenant_id, warehouse_id, sku_id, on_hand_qty, reserved_qty, in_transit_qty,
          avg_unit_cost, valuation_amount, version, updated_at
        ) VALUES ($1, $2, $3, $4, $5::numeric(18,3), 0, 0, $6::numeric(18,2), $7::numeric(18,2), 1, now())
        ON CONFLICT (tenant_id, warehouse_id, sku_id) DO UPDATE
        SET
          on_hand_qty = $5::numeric(18,3),
          avg_unit_cost = $6::numeric(18,2),
          valuation_amount = $7::numeric(18,2),
          version = ${prefix}"stock_balance".version + 1,
          updated_at = now()
        `,
        [
          randomUUID(),
          tenantId,
          header.warehouse_id,
          item.skuId,
          valuation.newOnHandQty,
          valuation.newAvgUnitCost,
          valuation.newValuationAmount,
        ],
      );

      await em.query(
        `
        INSERT INTO ${prefix}"stock_balance_ledger" (
          id, tenant_id, warehouse_id, sku_id, movement_type,
          qty_before, qty_delta, on_hand_after, reserved_after,
          unit_cost, avg_cost_after, reference_type, reference_id,
          actor_id, correlation_id, reason, occurred_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6::numeric(18,3), $7::numeric(18,3), $8::numeric(18,3), $9::numeric(18,3),
          $10::numeric(18,2), $11::numeric(18,2), 'STOCK_RECEIPT', $12,
          $13, $14, $15, $16
        )
        `,
        [
          randomUUID(),
          tenantId,
          header.warehouse_id,
          item.skuId,
          movementType,
          oldOnHandQty,
          qtyStr,
          valuation.newOnHandQty,
          oldReservedQty,
          unitCostStr,
          valuation.newAvgUnitCost,
          receiptId,
          actorId,
          correlationId,
          header.note ?? null,
          occurredAt,
        ],
      );

      if (this.outbox) {
        await this.outbox.add(em, INVENTORY_STOCK_CHANGED, {
          warehouseId: header.warehouse_id,
          skuId: item.skuId,
          movementType,
          qtyDelta: qtyStr,
          onHandAfter: valuation.newOnHandQty,
          reservedAfter: oldReservedQty,
          unitCost: unitCostStr,
          avgCostAfter: valuation.newAvgUnitCost,
          referenceType: 'STOCK_RECEIPT',
          referenceId: receiptId,
          occurredAt,
        } satisfies StockChangedPayload);
      }
    }

    await em.query(
      `
      UPDATE ${prefix}"stock_receipt"
      SET
        status = 'POSTED',
        posted_by = $3,
        posted_at = $4::timestamptz,
        idempotency_key = COALESCE(idempotency_key, $5),
        updated_at = now()
      WHERE tenant_id = $1 AND id = $2
      `,
      [
        tenantId,
        receiptId,
        actorId,
        occurredAt,
        idempotencyKey?.trim() ?? null,
      ],
    );

    if (this.outbox) {
      let receiptTotalCents = 0n;
      for (const item of items) {
        const qtyMilli = parseQtyToMilli(String(item.qty), false, false);
        const costCents = parseMoneyToCents(String(item.unitCost ?? '0'));
        receiptTotalCents += (qtyMilli * costCents + 500n) / 1000n;
      }
      await this.outbox.add(em, INVENTORY_STOCK_RECEIVED, {
        receiptId,
        code: header.code,
        warehouseId: header.warehouse_id,
        sourceType: header.source_type,
        purchaseOrderId: header.purchase_order_id,
        supplierId: header.supplier_id ?? null,
        totalAmount: formatCentsToMoney(receiptTotalCents),
        postedAt: occurredAt,
      });
    }

    return this.loadReceiptResponse(em, prefix, tenantId, receiptId);
  }

  async listReceipts(warehouseId?: string, status?: string) {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = schemaPrefix(em);
      const params: unknown[] = [tenantId];
      const filters: string[] = [];

      if (warehouseId) {
        params.push(warehouseId);
        filters.push(`AND warehouse_id = $${params.length}`);
      }
      if (status) {
        params.push(status);
        filters.push(`AND status = $${params.length}`);
      }

      const headers = await em.query(
        `
        SELECT id
        FROM ${prefix}"stock_receipt"
        WHERE tenant_id = $1 ${filters.join(' ')}
        ORDER BY created_at DESC
        LIMIT 100
        `,
        params,
      );
      const results = [];
      for (const h of headers) {
        results.push(
          await this.loadReceiptResponse(em, prefix, tenantId, h.id),
        );
      }
      return results;
    });
  }

  async getReceiptById(receiptId: string) {
    return runInTenantTransaction(this.dataSource, async (em, tenantId) => {
      const prefix = schemaPrefix(em);
      return this.loadReceiptResponse(em, prefix, tenantId, receiptId);
    });
  }

  private async loadReceiptResponse(
    em: EntityManager,
    prefix: string,
    tenantId: string,
    receiptId: string,
  ) {
    const headers = await em.query(
      `
      SELECT
        id,
        tenant_id AS "tenantId",
        code,
        warehouse_id AS "warehouseId",
        source_type AS "sourceType",
        purchase_order_id AS "purchaseOrderId",
        supplier_id AS "supplierId",
        status,
        note,
        posted_by AS "postedBy",
        posted_at AS "postedAt",
        created_by AS "createdBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM ${prefix}"stock_receipt"
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
      `,
      [tenantId, receiptId],
    );
    if (headers.length === 0) {
      throw new InventoryDomainError(
        InventoryDomainErrorCode.STOCK_RECEIPT_NOT_FOUND,
        `Stock receipt ${receiptId} not found`,
        404,
      );
    }
    const items = await em.query(
      `
      SELECT
        id,
        line_no AS "lineNo",
        sku_id AS "skuId",
        qty,
        unit_cost AS "unitCost",
        unit_name AS "unitName",
        conversion_factor AS "conversionFactor"
      FROM ${prefix}"stock_receipt_item"
      WHERE tenant_id = $1 AND receipt_id = $2
      ORDER BY line_no ASC
      `,
      [tenantId, receiptId],
    );

    return {
      ...headers[0],
      items: items.map((i: Record<string, unknown>) => ({
        id: i.id,
        lineNo: Number(i.lineNo),
        skuId: i.skuId,
        qty: formatMilliToQty(parseQtyToMilli(String(i.qty), false, false)),
        unitCost: formatCentsToMoney(
          parseMoneyToCents(String(i.unitCost ?? '0')),
        ),
        unitName: i.unitName,
        conversionFactor: formatFactorFromTenThousandths(
          parseConversionFactorToTenThousandths(
            String(i.conversionFactor ?? '1'),
          ),
        ),
      })),
    };
  }
}
