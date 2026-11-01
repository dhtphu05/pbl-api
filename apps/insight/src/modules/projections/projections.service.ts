import { Injectable } from '@nestjs/common';
import { EventEnvelope, TenantContext } from '@pbl/common';
import { qualifiedTable } from '@pbl/events';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  OrderContributionVector,
  addDecimals,
  computeAvailableQty,
  computeInventoryValuation,
  computeOrderContributionDelta,
  computeProjectionFreshness,
  computeTargetOrderContribution,
  computeWeightedAverageCost,
  divDecimals,
  formatDateColumn,
  formatScaledDecimal,
  isZeroContributionDelta,
  mulDecimals,
  parseScaledDecimal,
  subDecimals,
  toReportingDateBucket,
} from '../../domain/insight-domain';

export interface OrderItemEventInput {
  lineKey?: string;
  variantId?: string;
  productId?: string | null;
  sku?: string;
  skuCode?: string;
  name?: string;
  productName?: string;
  categoryId?: string | null;
  brandId?: string | null;
  quantity: number | string;
  unitPrice: number | string;
  discount?: number | string;
  unitCost?: number | string | null;
  costMissing?: boolean;
}

export interface NormalizedOrderEventInput {
  orderId: string;
  code?: string;
  branchId: string;
  channelType?: string;
  customerId?: string | null;
  customerGroupId?: string | null;
  sellerStaffId?: string | null;
  createdBy?: string | null;
  actorId?: string | null;
  orderStatus?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  subtotal?: string | number;
  discountTotal?: string | number;
  taxTotal?: string | number;
  grandTotal?: string | number;
  totalAmount?: number | string;
  occurredAt?: string;
  completedAt?: string;
  aggregateVersion?: number;
  costMissing?: boolean;
  items?: OrderItemEventInput[];
  lines?: OrderItemEventInput[];
}

export interface ReturnLineEventInput {
  sku?: string;
  skuCode?: string;
  variantId?: string;
  quantity: number | string;
  refundAmount?: number | string;
  unitCost?: number | string;
  restocked?: boolean;
}

export interface NormalizedReturnEventInput {
  returnId: string;
  code?: string;
  orderId: string;
  branchId: string;
  customerId?: string | null;
  customerGroupId?: string | null;
  sellerStaffId?: string | null;
  channelType?: string;
  status?: string;
  totalRefundAmount: string | number;
  restocked?: boolean;
  occurredAt: string;
  items?: ReturnLineEventInput[];
  lines?: ReturnLineEventInput[];
}

const ORDER_STATUS_RANK: Record<string, number> = {
  DRAFT: 1,
  CREATED: 1,
  CONFIRMED: 2,
  COMPLETED: 3,
  CANCELLED: 4,
};

@Injectable()
export class ProjectionsService {
  constructor(private readonly dataSource: DataSource) {}

  async getActiveGenerations(
    manager: EntityManager,
    tenantId: string,
    projectionName = 'sales_analytics',
  ): Promise<{ activeGenerationId: string; buildingGenerationIds: string[] }> {
    const checkpointsTable = qualifiedTable(
      manager.connection,
      'projection_checkpoints',
    );
    const generationsTable = qualifiedTable(
      manager.connection,
      'projection_generations',
    );

    const cpRows = await manager.query(
      `SELECT "active_generation_id" FROM ${checkpointsTable}
       WHERE "tenant_id" = $1 AND "projection_name" = $2
       LIMIT 1`,
      [tenantId, projectionName],
    );
    const activeGenerationId: string =
      cpRows[0]?.active_generation_id ?? 'gen-active';

    const buildingRows = await manager.query(
      `SELECT "generation_id" FROM ${generationsTable}
       WHERE "tenant_id" = $1 AND "projection_name" = $2 AND "status" = 'BUILDING'`,
      [tenantId, projectionName],
    );
    const buildingGenerationIds: string[] = buildingRows
      .map((r: { generation_id: string }) => r.generation_id)
      .filter((g: string) => g !== activeGenerationId);

    return { activeGenerationId, buildingGenerationIds };
  }

  async touchCheckpoint(
    manager: EntityManager,
    tenantId: string,
    projectionName: string,
    event: { id?: string; type?: string; occurredAt?: string },
  ): Promise<void> {
    const checkpointsTable = qualifiedTable(
      manager.connection,
      'projection_checkpoints',
    );
    await manager.query(
      `INSERT INTO ${checkpointsTable} (
        "id", "tenant_id", "projection_name", "active_generation_id",
        "last_event_id", "last_event_type", "last_event_occurred_at",
        "last_processed_at", "projection_version", "events_processed_count", "status", "updated_at"
      ) VALUES ($1, $2, $3, 'gen-active', $4, $5, $6, now(), 1, 1, 'HEALTHY', now())
      ON CONFLICT ("tenant_id", "projection_name") DO UPDATE SET
        "last_event_id" = COALESCE(EXCLUDED."last_event_id", ${checkpointsTable}."last_event_id"),
        "last_event_type" = COALESCE(EXCLUDED."last_event_type", ${checkpointsTable}."last_event_type"),
        "last_event_occurred_at" = COALESCE(EXCLUDED."last_event_occurred_at", ${checkpointsTable}."last_event_occurred_at"),
        "last_processed_at" = now(),
        "projection_version" = ${checkpointsTable}."projection_version" + 1,
        "events_processed_count" = ${checkpointsTable}."events_processed_count" + 1,
        "status" = 'HEALTHY',
        "updated_at" = now()`,
      [
        randomUUID(),
        tenantId,
        projectionName,
        event.id ?? null,
        event.type ?? null,
        event.occurredAt ? new Date(event.occurredAt) : new Date(),
      ],
    );
  }

  async getFreshness(
    tenantId?: string,
    projectionName = 'sales_analytics',
    manager?: EntityManager,
  ) {
    const resolvedTenantId = tenantId ?? TenantContext.require();
    const em = manager ?? this.dataSource.manager;
    const checkpointsTable = qualifiedTable(
      em.connection,
      'projection_checkpoints',
    );
    const rows = await em.query(
      `SELECT "active_generation_id", "last_processed_at", "projection_version", "last_event_occurred_at", "events_processed_count", "status"
       FROM ${checkpointsTable}
       WHERE "tenant_id" = $1 AND "projection_name" = $2
       LIMIT 1`,
      [resolvedTenantId, projectionName],
    );
    const row = rows[0];
    const freshness = computeProjectionFreshness({
      lastProcessedAt: row?.last_processed_at ?? new Date(),
      projectionVersion: row?.projection_version ?? 1,
    });
    return {
      ...freshness,
      activeGenerationId: (row?.active_generation_id as string) ?? 'gen-active',
      eventsProcessedCount: Number(row?.events_processed_count ?? 0),
      status: (row?.status as string) ?? 'HEALTHY',
    };
  }

  async upsertDimensionCache(
    manager: EntityManager,
    input: {
      tenantId?: string;
      dimensionType: 'PRODUCT' | 'VARIANT' | 'CUSTOMER' | 'BRANCH';
      entityId: string;
      code: string;
      name: string;
      parentId?: string | null;
      categoryId?: string | null;
      brandId?: string | null;
      customerGroupId?: string | null;
      metadata?: Record<string, unknown>;
      aggregateVersion?: number;
    },
  ): Promise<void> {
    const tenantId = input.tenantId ?? TenantContext.require();
    const dimTable = qualifiedTable(
      manager.connection,
      'insight_dimension_caches',
    );
    const version = input.aggregateVersion ?? 1;

    await manager.query(
      `INSERT INTO ${dimTable} (
        "id", "tenant_id", "dimension_type", "entity_id", "code", "name",
        "parent_id", "category_id", "brand_id", "customer_group_id",
        "metadata", "aggregate_version", "updated_at"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, now())
      ON CONFLICT ("tenant_id", "dimension_type", "entity_id") DO UPDATE SET
        "code" = CASE WHEN EXCLUDED."aggregate_version" >= ${dimTable}."aggregate_version" THEN EXCLUDED."code" ELSE ${dimTable}."code" END,
        "name" = CASE WHEN EXCLUDED."aggregate_version" >= ${dimTable}."aggregate_version" THEN EXCLUDED."name" ELSE ${dimTable}."name" END,
        "parent_id" = CASE WHEN EXCLUDED."aggregate_version" >= ${dimTable}."aggregate_version" THEN COALESCE(EXCLUDED."parent_id", ${dimTable}."parent_id") ELSE ${dimTable}."parent_id" END,
        "category_id" = CASE WHEN EXCLUDED."aggregate_version" >= ${dimTable}."aggregate_version" THEN COALESCE(EXCLUDED."category_id", ${dimTable}."category_id") ELSE ${dimTable}."category_id" END,
        "brand_id" = CASE WHEN EXCLUDED."aggregate_version" >= ${dimTable}."aggregate_version" THEN COALESCE(EXCLUDED."brand_id", ${dimTable}."brand_id") ELSE ${dimTable}."brand_id" END,
        "customer_group_id" = CASE WHEN EXCLUDED."aggregate_version" >= ${dimTable}."aggregate_version" THEN COALESCE(EXCLUDED."customer_group_id", ${dimTable}."customer_group_id") ELSE ${dimTable}."customer_group_id" END,
        "metadata" = CASE WHEN EXCLUDED."aggregate_version" >= ${dimTable}."aggregate_version" THEN EXCLUDED."metadata" ELSE ${dimTable}."metadata" END,
        "aggregate_version" = GREATEST(${dimTable}."aggregate_version", EXCLUDED."aggregate_version"),
        "updated_at" = now()`,
      [
        randomUUID(),
        tenantId,
        input.dimensionType,
        input.entityId,
        input.code,
        input.name,
        input.parentId ?? null,
        input.categoryId ?? null,
        input.brandId ?? null,
        input.customerGroupId ?? null,
        JSON.stringify(input.metadata ?? {}),
        version,
      ],
    );
  }

  /**
   * Core Order Event Processor with Contribution-Delta Accounting, Out-of-Order Version
   * Protection, Transaction-Time Cost Snapshotting, and Missing Cost Pending State.
   */
  async processSalesOrderEvent(
    event: EventEnvelope<NormalizedOrderEventInput>,
    manager: EntityManager,
    inferredStatus?: 'CREATED' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED',
  ): Promise<{ applied: boolean; reason?: string }> {
    const tenantId = event.tenantId || TenantContext.require();
    const payload = event.payload;
    const orderId = payload.orderId;
    if (!orderId) {
      return { applied: false, reason: 'MISSING_ORDER_ID' };
    }

    const orderFactsTable = qualifiedTable(
      manager.connection,
      'sales_order_facts',
    );
    const lineFactsTable = qualifiedTable(
      manager.connection,
      'sales_order_line_facts',
    );
    const dimTable = qualifiedTable(
      manager.connection,
      'insight_dimension_caches',
    );
    const stockTable = qualifiedTable(
      manager.connection,
      'inventory_stock_projections',
    );

    const existingRows = await manager.query(
      `SELECT * FROM ${orderFactsTable}
       WHERE "tenant_id" = $1 AND "order_id" = $2
       FOR UPDATE`,
      [tenantId, orderId],
    );
    const existing = existingRows[0] ?? null;

    if (existing && event.id && existing.last_event_id === event.id) {
      return { applied: false, reason: 'DUPLICATE_EVENT' };
    }

    const rawStatus = (
      inferredStatus ??
      payload.orderStatus ??
      'COMPLETED'
    ).toUpperCase();
    const statusRank = ORDER_STATUS_RANK[rawStatus] ?? 1;
    const incomingVersion =
      payload.aggregateVersion !== undefined
        ? Number(payload.aggregateVersion)
        : statusRank;

    if (existing) {
      const existingRank = ORDER_STATUS_RANK[existing.order_status] ?? 1;
      const existingVersion = Number(existing.last_aggregate_version ?? 1);
      // Reject stale/out-of-order events that have a lower aggregate version or lower lifecycle rank
      if (
        incomingVersion < existingVersion ||
        (payload.aggregateVersion === undefined && statusRank < existingRank)
      ) {
        return { applied: false, reason: 'OUT_OF_ORDER_STALE_EVENT' };
      }
      // If identical status and version already processed, treat as idempotent no-op
      if (
        existing.order_status === rawStatus &&
        incomingVersion === existingVersion &&
        Number(existing.contributed_order_count) > 0
      ) {
        return { applied: false, reason: 'ALREADY_AT_TARGET_STATE' };
      }
    }

    const eventInstant =
      payload.completedAt ??
      payload.occurredAt ??
      event.occurredAt ??
      new Date().toISOString();
    const dateBucket: string = existing?.date_bucket
      ? formatDateColumn(existing.date_bucket)
      : toReportingDateBucket(eventInstant);

    const branchId = payload.branchId ?? existing?.branch_id;
    const channelType = (
      payload.channelType ??
      existing?.channel_type ??
      'POS'
    ).toUpperCase();
    const customerId =
      payload.customerId !== undefined
        ? payload.customerId
        : (existing?.customer_id ?? null);

    // Resolve customer group from payload, existing fact, or dimension cache
    let customerGroupId =
      payload.customerGroupId ?? existing?.customer_group_id ?? null;
    if (!customerGroupId && customerId) {
      const custRows = await manager.query(
        `SELECT "customer_group_id" FROM ${dimTable}
         WHERE "tenant_id" = $1 AND "dimension_type" = 'CUSTOMER' AND "entity_id" = $2
         LIMIT 1`,
        [tenantId, customerId],
      );
      customerGroupId = custRows[0]?.customer_group_id ?? null;
    }
    const resolvedCustomerGroupId = customerGroupId || 'WALK_IN';

    const sellerStaffId =
      payload.sellerStaffId ??
      payload.createdBy ??
      payload.actorId ??
      event.actor?.id ??
      existing?.seller_staff_id ??
      'UNASSIGNED';

    // Resolve lines and transaction-time snapshots
    const rawItems = payload.items ?? payload.lines ?? [];
    const existingLines = existing
      ? await manager.query(
          `SELECT * FROM ${lineFactsTable} WHERE "tenant_id" = $1 AND "order_id" = $2 ORDER BY "line_key" ASC`,
          [tenantId, orderId],
        )
      : [];

    interface ResolvedLine {
      lineKey: string;
      variantId: string;
      productId: string | null;
      skuCode: string;
      productName: string;
      categoryId: string | null;
      brandId: string | null;
      quantity: string;
      unitPrice: string;
      lineSubtotal: string;
      lineDiscount: string;
      lineNetRevenue: string;
      unitCostSnapshot: string;
      cogsAmount: string;
      grossProfitAmount: string;
      costStatus: 'VERIFIED' | 'PENDING';
      prevGrossRevenue: string;
      prevDiscount: string;
      prevNetRevenue: string;
      prevCogs: string;
      prevUnitsSold: string;
      prevCostStatus: 'VERIFIED' | 'PENDING' | null;
    }

    const resolvedLines: ResolvedLine[] = [];
    const existingLineMap = new Map<string, Record<string, unknown>>();
    for (const el of existingLines) {
      existingLineMap.set(String(el.line_key), el);
    }

    if (rawItems.length > 0) {
      for (let i = 0; i < rawItems.length; i++) {
        const item = rawItems[i];
        const skuCode = String(
          item.skuCode ?? item.sku ?? item.variantId ?? `SKU-${i + 1}`,
        );
        const lineKey = String(item.lineKey ?? `${skuCode}#${i}`);
        const prevLine =
          existingLineMap.get(lineKey) ?? existingLineMap.get(skuCode);

        // Look up variant/product dimension cache if category/brand/name not on payload
        let productName = String(
          item.productName ?? item.name ?? prevLine?.product_name ?? skuCode,
        );
        let categoryId: string | null =
          item.categoryId ?? (prevLine?.category_id as string | null) ?? null;
        let brandId: string | null =
          item.brandId ?? (prevLine?.brand_id as string | null) ?? null;
        let productId: string | null =
          item.productId ?? (prevLine?.product_id as string | null) ?? null;
        let variantId = String(
          item.variantId ?? prevLine?.variant_id ?? skuCode,
        );

        if (!categoryId || !brandId || productName === skuCode) {
          const dimRows = await manager.query(
            `SELECT "entity_id", "name", "parent_id", "category_id", "brand_id"
             FROM ${dimTable}
             WHERE "tenant_id" = $1 AND "dimension_type" = 'VARIANT' AND ("code" = $2 OR "entity_id" = $2)
             LIMIT 1`,
            [tenantId, skuCode],
          );
          if (dimRows[0]) {
            variantId = String(dimRows[0].entity_id || variantId);
            productName = String(dimRows[0].name || productName);
            productId = productId ?? dimRows[0].parent_id ?? null;
            categoryId = categoryId ?? dimRows[0].category_id ?? null;
            brandId = brandId ?? dimRows[0].brand_id ?? null;
          }
          if (productId && (!categoryId || !brandId)) {
            const prodRows = await manager.query(
              `SELECT "category_id", "brand_id", "name"
               FROM ${dimTable}
               WHERE "tenant_id" = $1 AND "dimension_type" = 'PRODUCT' AND "entity_id" = $2
               LIMIT 1`,
              [tenantId, productId],
            );
            if (prodRows[0]) {
              categoryId = categoryId ?? prodRows[0].category_id ?? null;
              brandId = brandId ?? prodRows[0].brand_id ?? null;
            }
          }
        }

        const qtyStr = formatScaledDecimal(
          parseScaledDecimal(item.quantity),
          4,
        );
        const unitPriceStr = formatScaledDecimal(
          parseScaledDecimal(item.unitPrice),
          4,
        );
        const lineSubtotalStr = mulDecimals(qtyStr, unitPriceStr, 4);
        const lineDiscountStr = formatScaledDecimal(
          parseScaledDecimal(item.discount ?? 0),
          4,
        );

        // Determine transaction-time unit cost snapshot:
        // If prevLine already captured a VERIFIED snapshot, preserve it!
        let costStatus: 'VERIFIED' | 'PENDING' = 'VERIFIED';
        let unitCostSnapshotStr = '0.0000';

        if (
          prevLine &&
          prevLine.cost_status === 'VERIFIED' &&
          parseScaledDecimal(prevLine.unit_cost_snapshot as string) > 0n
        ) {
          unitCostSnapshotStr = formatScaledDecimal(
            parseScaledDecimal(prevLine.unit_cost_snapshot as string),
            4,
          );
          costStatus = 'VERIFIED';
        } else if (item.costMissing || payload.costMissing) {
          costStatus = 'PENDING';
          unitCostSnapshotStr = '0.0000';
        } else if (item.unitCost !== undefined && item.unitCost !== null) {
          unitCostSnapshotStr = formatScaledDecimal(
            parseScaledDecimal(item.unitCost),
            4,
          );
          costStatus = 'VERIFIED';
        } else {
          // Look up current weighted-average cost in inventory_stock_projections
          const stockRows = await manager.query(
            `SELECT "avg_unit_cost" FROM ${stockTable}
             WHERE "tenant_id" = $1 AND "sku_code" = $2
             ORDER BY ("branch_id" = $3) DESC NULLS LAST, "updated_at" DESC
             LIMIT 1`,
            [tenantId, skuCode, branchId],
          );
          if (stockRows[0] && stockRows[0].avg_unit_cost !== null) {
            unitCostSnapshotStr = formatScaledDecimal(
              parseScaledDecimal(stockRows[0].avg_unit_cost),
              4,
            );
            costStatus = 'VERIFIED';
          } else {
            unitCostSnapshotStr = '0.0000';
            costStatus = 'VERIFIED';
          }
        }

        const cogsAmountStr =
          costStatus === 'VERIFIED'
            ? mulDecimals(qtyStr, unitCostSnapshotStr, 4)
            : '0.0000';
        const lineNetRevStr = subDecimals(lineSubtotalStr, lineDiscountStr, 4);
        const grossProfitStr = subDecimals(lineNetRevStr, cogsAmountStr, 4);

        resolvedLines.push({
          lineKey,
          variantId,
          productId,
          skuCode,
          productName,
          categoryId,
          brandId,
          quantity: qtyStr,
          unitPrice: unitPriceStr,
          lineSubtotal: lineSubtotalStr,
          lineDiscount: lineDiscountStr,
          lineNetRevenue: lineNetRevStr,
          unitCostSnapshot: unitCostSnapshotStr,
          cogsAmount: cogsAmountStr,
          grossProfitAmount: grossProfitStr,
          costStatus,
          prevGrossRevenue: String(prevLine?.contributed_gross_revenue ?? '0'),
          prevDiscount: String(prevLine?.contributed_discount ?? '0'),
          prevNetRevenue: String(prevLine?.contributed_net_revenue ?? '0'),
          prevCogs: String(prevLine?.contributed_cogs ?? '0'),
          prevUnitsSold: String(prevLine?.contributed_units_sold ?? '0'),
          prevCostStatus:
            (prevLine?.cost_status as 'VERIFIED' | 'PENDING') ?? null,
        });
      }
    } else if (existingLines.length > 0) {
      for (const el of existingLines) {
        resolvedLines.push({
          lineKey: String(el.line_key),
          variantId: String(el.variant_id),
          productId: (el.product_id as string) ?? null,
          skuCode: String(el.sku_code),
          productName: String(el.product_name),
          categoryId: (el.category_id as string) ?? null,
          brandId: (el.brand_id as string) ?? null,
          quantity: String(el.quantity),
          unitPrice: String(el.unit_price),
          lineSubtotal: String(el.line_subtotal),
          lineDiscount: String(el.line_discount),
          lineNetRevenue: String(el.line_net_revenue),
          unitCostSnapshot: String(el.unit_cost_snapshot),
          cogsAmount: String(el.cogs_amount),
          grossProfitAmount: String(el.gross_profit_amount),
          costStatus: (el.cost_status as 'VERIFIED' | 'PENDING') ?? 'VERIFIED',
          prevGrossRevenue: String(el.contributed_gross_revenue ?? '0'),
          prevDiscount: String(el.contributed_discount ?? '0'),
          prevNetRevenue: String(el.contributed_net_revenue ?? '0'),
          prevCogs: String(el.contributed_cogs ?? '0'),
          prevUnitsSold: String(el.contributed_units_sold ?? '0'),
          prevCostStatus: (el.cost_status as 'VERIFIED' | 'PENDING') ?? null,
        });
      }
    }

    // Compute order-level totals
    let sumLineSubtotals = 0n;
    let sumLineDiscounts = 0n;
    let sumLineCogs = 0n;
    let sumLineUnits = 0n;
    let anyPendingCost = Boolean(payload.costMissing);

    for (const line of resolvedLines) {
      sumLineSubtotals += parseScaledDecimal(line.lineSubtotal);
      sumLineDiscounts += parseScaledDecimal(line.lineDiscount);
      sumLineCogs += parseScaledDecimal(line.cogsAmount);
      sumLineUnits += parseScaledDecimal(line.quantity);
      if (line.costStatus === 'PENDING') {
        anyPendingCost = true;
      }
    }

    const subtotalStr =
      payload.subtotal !== undefined
        ? formatScaledDecimal(parseScaledDecimal(payload.subtotal), 4)
        : sumLineSubtotals > 0n
          ? formatScaledDecimal(sumLineSubtotals, 4)
          : existing
            ? String(existing.subtotal)
            : formatScaledDecimal(
                parseScaledDecimal(
                  payload.grandTotal ?? payload.totalAmount ?? 0,
                ),
                4,
              );

    const discountTotalStr =
      payload.discountTotal !== undefined
        ? formatScaledDecimal(parseScaledDecimal(payload.discountTotal), 4)
        : sumLineDiscounts > 0n
          ? formatScaledDecimal(sumLineDiscounts, 4)
          : existing
            ? String(existing.discount_total)
            : '0.0000';

    // Allocate order-level discount across lines if line discounts were 0 but order discountTotal > 0
    if (
      resolvedLines.length > 0 &&
      sumLineDiscounts === 0n &&
      parseScaledDecimal(discountTotalStr) > 0n &&
      sumLineSubtotals > 0n
    ) {
      let remainingDiscount = parseScaledDecimal(discountTotalStr);
      for (let i = 0; i < resolvedLines.length; i++) {
        const line = resolvedLines[i];
        const lineSub = parseScaledDecimal(line.lineSubtotal);
        const alloc =
          i === resolvedLines.length - 1
            ? remainingDiscount
            : (parseScaledDecimal(discountTotalStr) * lineSub) /
              sumLineSubtotals;
        remainingDiscount -= alloc;
        line.lineDiscount = formatScaledDecimal(alloc, 4);
        line.lineNetRevenue = formatScaledDecimal(lineSub - alloc, 4);
        line.grossProfitAmount = formatScaledDecimal(
          lineSub - alloc - parseScaledDecimal(line.cogsAmount),
          4,
        );
      }
    }

    const taxTotalStr =
      payload.taxTotal !== undefined
        ? formatScaledDecimal(parseScaledDecimal(payload.taxTotal), 4)
        : existing
          ? String(existing.tax_total)
          : '0.0000';

    const grandTotalStr =
      payload.grandTotal !== undefined || payload.totalAmount !== undefined
        ? formatScaledDecimal(
            parseScaledDecimal(payload.grandTotal ?? payload.totalAmount ?? 0),
            4,
          )
        : formatScaledDecimal(
            parseScaledDecimal(subtotalStr) -
              parseScaledDecimal(discountTotalStr) +
              parseScaledDecimal(taxTotalStr),
            4,
          );

    const cogsTotalStr =
      resolvedLines.length > 0
        ? formatScaledDecimal(sumLineCogs, 4)
        : existing
          ? String(existing.cogs_total)
          : '0.0000';

    const unitsTotalStr =
      resolvedLines.length > 0
        ? formatScaledDecimal(sumLineUnits, 4)
        : existing
          ? String(existing.units_total)
          : '1.0000';

    const targetContribution = computeTargetOrderContribution({
      status: rawStatus,
      subtotal: subtotalStr,
      discountTotal: discountTotalStr,
      cogsTotal: cogsTotalStr,
      unitsTotal: unitsTotalStr,
    });

    const previousContribution: OrderContributionVector | null = existing
      ? {
          gmv: String(existing.contributed_gmv),
          grossRevenue: String(existing.contributed_gross_revenue),
          discount: String(existing.contributed_discount),
          netRevenue: String(existing.contributed_net_revenue),
          cogs: String(existing.contributed_cogs),
          unitsSold: String(existing.contributed_units_sold),
          orderCount: Number(existing.contributed_order_count),
          completedCount: Number(existing.contributed_completed_count),
          cancelledCount: Number(existing.contributed_cancelled_count),
        }
      : null;

    const delta = computeOrderContributionDelta(
      targetContribution,
      previousContribution,
    );

    const orderCostStatus: 'VERIFIED' | 'PENDING' = anyPendingCost
      ? 'PENDING'
      : 'VERIFIED';

    // Persist or update sales_order_facts
    await manager.query(
      `INSERT INTO ${orderFactsTable} (
        "id", "tenant_id", "order_id", "order_code", "branch_id", "channel_type",
        "customer_id", "customer_group_id", "seller_staff_id", "order_status",
        "payment_status", "fulfillment_status", "date_bucket",
        "subtotal", "discount_total", "tax_total", "grand_total", "cogs_total", "units_total",
        "cost_status", "contributed_gmv", "contributed_gross_revenue", "contributed_discount",
        "contributed_net_revenue", "contributed_cogs", "contributed_units_sold",
        "contributed_order_count", "contributed_completed_count", "contributed_cancelled_count",
        "last_aggregate_version", "last_event_id", "raw_payload", "occurred_at", "completed_at", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23,
        $24, $25, $26,
        $27, $28, $29,
        $30, $31, $32::jsonb, $33, $34, now()
      )
      ON CONFLICT ("tenant_id", "order_id") DO UPDATE SET
        "order_code" = EXCLUDED."order_code",
        "branch_id" = EXCLUDED."branch_id",
        "channel_type" = EXCLUDED."channel_type",
        "customer_id" = COALESCE(EXCLUDED."customer_id", ${orderFactsTable}."customer_id"),
        "customer_group_id" = EXCLUDED."customer_group_id",
        "seller_staff_id" = COALESCE(EXCLUDED."seller_staff_id", ${orderFactsTable}."seller_staff_id"),
        "order_status" = EXCLUDED."order_status",
        "payment_status" = EXCLUDED."payment_status",
        "fulfillment_status" = EXCLUDED."fulfillment_status",
        "subtotal" = EXCLUDED."subtotal",
        "discount_total" = EXCLUDED."discount_total",
        "tax_total" = EXCLUDED."tax_total",
        "grand_total" = EXCLUDED."grand_total",
        "cogs_total" = EXCLUDED."cogs_total",
        "units_total" = EXCLUDED."units_total",
        "cost_status" = EXCLUDED."cost_status",
        "contributed_gmv" = EXCLUDED."contributed_gmv",
        "contributed_gross_revenue" = EXCLUDED."contributed_gross_revenue",
        "contributed_discount" = EXCLUDED."contributed_discount",
        "contributed_net_revenue" = EXCLUDED."contributed_net_revenue",
        "contributed_cogs" = EXCLUDED."contributed_cogs",
        "contributed_units_sold" = EXCLUDED."contributed_units_sold",
        "contributed_order_count" = EXCLUDED."contributed_order_count",
        "contributed_completed_count" = EXCLUDED."contributed_completed_count",
        "contributed_cancelled_count" = EXCLUDED."contributed_cancelled_count",
        "last_aggregate_version" = EXCLUDED."last_aggregate_version",
        "last_event_id" = EXCLUDED."last_event_id",
        "raw_payload" = EXCLUDED."raw_payload",
        "completed_at" = COALESCE(EXCLUDED."completed_at", ${orderFactsTable}."completed_at"),
        "updated_at" = now()`,
      [
        existing?.id ?? randomUUID(),
        tenantId,
        orderId,
        payload.code ?? existing?.order_code ?? `ORD-${orderId.slice(0, 8)}`,
        branchId,
        channelType,
        customerId,
        resolvedCustomerGroupId,
        sellerStaffId,
        rawStatus,
        payload.paymentStatus ??
          (rawStatus === 'COMPLETED'
            ? 'PAID'
            : (existing?.payment_status ?? 'UNPAID')),
        payload.fulfillmentStatus ??
          (rawStatus === 'COMPLETED'
            ? 'FULFILLED'
            : (existing?.fulfillment_status ?? 'UNFULFILLED')),
        dateBucket,
        subtotalStr,
        discountTotalStr,
        taxTotalStr,
        grandTotalStr,
        cogsTotalStr,
        unitsTotalStr,
        orderCostStatus,
        targetContribution.gmv,
        targetContribution.grossRevenue,
        targetContribution.discount,
        targetContribution.netRevenue,
        targetContribution.cogs,
        targetContribution.unitsSold,
        targetContribution.orderCount,
        targetContribution.completedCount,
        targetContribution.cancelledCount,
        incomingVersion,
        event.id ?? null,
        JSON.stringify(payload),
        new Date(eventInstant),
        rawStatus === 'COMPLETED'
          ? new Date(payload.completedAt ?? eventInstant)
          : (existing?.completed_at ?? null),
      ],
    );

    // Determine target generations to update (active + any shadow building generation)
    const { activeGenerationId, buildingGenerationIds } =
      await this.getActiveGenerations(manager, tenantId, 'sales_analytics');
    const targetGenerations = [activeGenerationId, ...buildingGenerationIds];

    // Upsert line facts and apply product summary deltas
    let pendingLinesDeltaTotal = 0;
    for (const line of resolvedLines) {
      const lineTargetGross =
        rawStatus === 'COMPLETED' ? line.lineSubtotal : '0.0000';
      const lineTargetDiscount =
        rawStatus === 'COMPLETED' ? line.lineDiscount : '0.0000';
      const lineTargetNet =
        rawStatus === 'COMPLETED' ? line.lineNetRevenue : '0.0000';
      const lineTargetCogs =
        rawStatus === 'COMPLETED' ? line.cogsAmount : '0.0000';
      const lineTargetUnits =
        rawStatus === 'COMPLETED' ? line.quantity : '0.0000';

      const lineDeltaGross = subDecimals(
        lineTargetGross,
        line.prevGrossRevenue,
        4,
      );
      const lineDeltaDiscount = subDecimals(
        lineTargetDiscount,
        line.prevDiscount,
        4,
      );
      const lineDeltaNet = subDecimals(lineTargetNet, line.prevNetRevenue, 4);
      const lineDeltaCogs = subDecimals(lineTargetCogs, line.prevCogs, 4);
      const lineDeltaProfit = subDecimals(lineDeltaNet, lineDeltaCogs, 4);
      const lineDeltaUnits = subDecimals(
        lineTargetUnits,
        line.prevUnitsSold,
        4,
      );

      const wasPending =
        line.prevCostStatus === 'PENDING' &&
        parseScaledDecimal(line.prevUnitsSold) > 0n
          ? 1
          : 0;
      const isNowPending =
        rawStatus === 'COMPLETED' && line.costStatus === 'PENDING' ? 1 : 0;
      const pendingLineDelta = isNowPending - wasPending;
      pendingLinesDeltaTotal += pendingLineDelta;

      await manager.query(
        `INSERT INTO ${lineFactsTable} (
          "id", "tenant_id", "order_id", "line_key", "branch_id", "channel_type",
          "customer_group_id", "seller_staff_id", "date_bucket", "variant_id",
          "product_id", "sku_code", "product_name", "category_id", "brand_id",
          "quantity", "unit_price", "line_subtotal", "line_discount", "line_net_revenue",
          "unit_cost_snapshot", "cogs_amount", "gross_profit_amount", "cost_status",
          "contributed_gross_revenue", "contributed_discount", "contributed_net_revenue",
          "contributed_cogs", "contributed_units_sold", "occurred_at", "updated_at"
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20,
          $21, $22, $23, $24,
          $25, $26, $27,
          $28, $29, $30, now()
        )
        ON CONFLICT ("tenant_id", "order_id", "line_key") DO UPDATE SET
          "product_id" = COALESCE(EXCLUDED."product_id", ${lineFactsTable}."product_id"),
          "product_name" = EXCLUDED."product_name",
          "category_id" = COALESCE(EXCLUDED."category_id", ${lineFactsTable}."category_id"),
          "brand_id" = COALESCE(EXCLUDED."brand_id", ${lineFactsTable}."brand_id"),
          "quantity" = EXCLUDED."quantity",
          "unit_price" = EXCLUDED."unit_price",
          "line_subtotal" = EXCLUDED."line_subtotal",
          "line_discount" = EXCLUDED."line_discount",
          "line_net_revenue" = EXCLUDED."line_net_revenue",
          "unit_cost_snapshot" = EXCLUDED."unit_cost_snapshot",
          "cogs_amount" = EXCLUDED."cogs_amount",
          "gross_profit_amount" = EXCLUDED."gross_profit_amount",
          "cost_status" = EXCLUDED."cost_status",
          "contributed_gross_revenue" = EXCLUDED."contributed_gross_revenue",
          "contributed_discount" = EXCLUDED."contributed_discount",
          "contributed_net_revenue" = EXCLUDED."contributed_net_revenue",
          "contributed_cogs" = EXCLUDED."contributed_cogs",
          "contributed_units_sold" = EXCLUDED."contributed_units_sold",
          "updated_at" = now()`,
        [
          randomUUID(),
          tenantId,
          orderId,
          line.lineKey,
          branchId,
          channelType,
          resolvedCustomerGroupId,
          sellerStaffId,
          dateBucket,
          line.variantId,
          line.productId,
          line.skuCode,
          line.productName,
          line.categoryId,
          line.brandId,
          line.quantity,
          line.unitPrice,
          line.lineSubtotal,
          line.lineDiscount,
          line.lineNetRevenue,
          line.unitCostSnapshot,
          line.cogsAmount,
          line.grossProfitAmount,
          line.costStatus,
          lineTargetGross,
          lineTargetDiscount,
          lineTargetNet,
          lineTargetCogs,
          lineTargetUnits,
          new Date(eventInstant),
        ],
      );

      if (
        parseScaledDecimal(lineDeltaGross) !== 0n ||
        parseScaledDecimal(lineDeltaUnits) !== 0n ||
        parseScaledDecimal(lineDeltaCogs) !== 0n ||
        delta.completedCount !== 0 ||
        pendingLineDelta !== 0
      ) {
        for (const genId of targetGenerations) {
          await this.applyProductSummaryDelta(manager, {
            tenantId,
            generationId: genId,
            dateBucket,
            branchId,
            variantId: line.variantId,
            productId: line.productId,
            skuCode: line.skuCode,
            productName: line.productName,
            categoryId: line.categoryId,
            brandId: line.brandId,
            unitsSoldDelta: lineDeltaUnits,
            unitsReturnedDelta: '0.0000',
            grossRevenueDelta: lineDeltaGross,
            discountDelta: lineDeltaDiscount,
            returnsAmountDelta: '0.0000',
            netRevenueDelta: lineDeltaNet,
            cogsDelta: lineDeltaCogs,
            returnedCogsDelta: '0.0000',
            grossProfitDelta: lineDeltaProfit,
            orderCountDelta: delta.completedCount,
            pendingCostLinesDelta: pendingLineDelta,
          });
        }
      }

      if (rawStatus === 'COMPLETED') {
        await manager.query(
          `UPDATE ${stockTable}
           SET "last_sale_at" = GREATEST(COALESCE("last_sale_at", $3::timestamptz), $3::timestamptz),
               "updated_at" = now()
           WHERE "tenant_id" = $1 AND "sku_code" = $2`,
          [tenantId, line.skuCode, new Date(eventInstant)],
        );
      }
    }

    if (!isZeroContributionDelta(delta) || pendingLinesDeltaTotal !== 0) {
      const grossProfitDelta = subDecimals(delta.netRevenue, delta.cogs, 4);
      for (const genId of targetGenerations) {
        await this.applyOrderDeltaToSummaries(manager, {
          tenantId,
          generationId: genId,
          dateBucket,
          branchId,
          channelType,
          employeeId: sellerStaffId,
          customerGroupId: resolvedCustomerGroupId,
          delta,
          grossProfitDelta,
          pendingCostLinesDelta: pendingLinesDeltaTotal,
        });
      }
    }

    await this.touchCheckpoint(manager, tenantId, 'sales_analytics', event);
    return { applied: true };
  }

  /**
   * Resolves pending COGS lines when a late cost event arrives for a SKU or order.
   */
  async resolvePendingOrderCosts(
    manager: EntityManager,
    input: {
      tenantId?: string;
      skuCode: string;
      unitCost: string | number;
      orderId?: string | null;
    },
  ): Promise<{ resolvedLines: number }> {
    const tenantId = input.tenantId ?? TenantContext.require();
    const unitCostScaled = parseScaledDecimal(input.unitCost);
    if (unitCostScaled <= 0n) {
      return { resolvedLines: 0 };
    }
    const unitCostStr = formatScaledDecimal(unitCostScaled, 4);

    const lineFactsTable = qualifiedTable(
      manager.connection,
      'sales_order_line_facts',
    );
    const orderFactsTable = qualifiedTable(
      manager.connection,
      'sales_order_facts',
    );

    const params: unknown[] = [tenantId, input.skuCode];
    let orderClause = '';
    if (input.orderId) {
      params.push(input.orderId);
      orderClause = ` AND "order_id" = $3`;
    }

    const pendingLines = await manager.query(
      `SELECT * FROM ${lineFactsTable}
       WHERE "tenant_id" = $1 AND "sku_code" = $2 AND "cost_status" = 'PENDING'${orderClause}
       FOR UPDATE`,
      params,
    );

    if (pendingLines.length === 0) {
      return { resolvedLines: 0 };
    }

    const { activeGenerationId, buildingGenerationIds } =
      await this.getActiveGenerations(manager, tenantId, 'sales_analytics');
    const targetGenerations = [activeGenerationId, ...buildingGenerationIds];

    for (const line of pendingLines) {
      const qtyStr = String(line.quantity);
      const newCogsStr = mulDecimals(qtyStr, unitCostStr, 4);
      const newGrossProfitStr = subDecimals(
        String(line.line_net_revenue),
        newCogsStr,
        4,
      );
      const isCompletedContribution =
        parseScaledDecimal(String(line.contributed_units_sold)) > 0n;
      const cogsDeltaStr = isCompletedContribution ? newCogsStr : '0.0000';
      const profitDeltaStr = isCompletedContribution
        ? subDecimals('0', newCogsStr, 4)
        : '0.0000';

      await manager.query(
        `UPDATE ${lineFactsTable}
         SET "unit_cost_snapshot" = $1,
             "cogs_amount" = $2,
             "gross_profit_amount" = $3,
             "cost_status" = 'VERIFIED',
             "contributed_cogs" = CASE WHEN "contributed_units_sold" > 0 THEN $2::numeric ELSE 0 END,
             "updated_at" = now()
         WHERE "id" = $4`,
        [unitCostStr, newCogsStr, newGrossProfitStr, line.id],
      );

      // Update parent order fact
      await manager.query(
        `UPDATE ${orderFactsTable}
         SET "cogs_total" = "cogs_total" + $1::numeric,
             "contributed_cogs" = "contributed_cogs" + $2::numeric,
             "cost_status" = CASE
               WHEN EXISTS (
                 SELECT 1 FROM ${lineFactsTable} lf
                 WHERE lf."tenant_id" = $3 AND lf."order_id" = $4 AND lf."cost_status" = 'PENDING' AND lf."id" <> $5
               ) THEN 'PENDING'
               ELSE 'VERIFIED'
             END,
             "updated_at" = now()
         WHERE "tenant_id" = $3 AND "order_id" = $4`,
        [newCogsStr, cogsDeltaStr, tenantId, line.order_id, line.id],
      );

      if (isCompletedContribution) {
        const dateBucket = formatDateColumn(line.date_bucket);

        for (const genId of targetGenerations) {
          await this.applyProductSummaryDelta(manager, {
            tenantId,
            generationId: genId,
            dateBucket,
            branchId: String(line.branch_id),
            variantId: String(line.variant_id),
            productId: (line.product_id as string) ?? null,
            skuCode: String(line.sku_code),
            productName: String(line.product_name),
            categoryId: (line.category_id as string) ?? null,
            brandId: (line.brand_id as string) ?? null,
            unitsSoldDelta: '0.0000',
            unitsReturnedDelta: '0.0000',
            grossRevenueDelta: '0.0000',
            discountDelta: '0.0000',
            returnsAmountDelta: '0.0000',
            netRevenueDelta: '0.0000',
            cogsDelta: cogsDeltaStr,
            returnedCogsDelta: '0.0000',
            grossProfitDelta: profitDeltaStr,
            orderCountDelta: 0,
            pendingCostLinesDelta: -1,
          });

          await this.applyOrderDeltaToSummaries(manager, {
            tenantId,
            generationId: genId,
            dateBucket,
            branchId: String(line.branch_id),
            channelType: String(line.channel_type),
            employeeId: String(line.seller_staff_id ?? 'UNASSIGNED'),
            customerGroupId: String(line.customer_group_id ?? 'WALK_IN'),
            delta: {
              gmv: '0.0000',
              grossRevenue: '0.0000',
              discount: '0.0000',
              netRevenue: '0.0000',
              cogs: cogsDeltaStr,
              unitsSold: '0.0000',
              orderCount: 0,
              completedCount: 0,
              cancelledCount: 0,
            },
            grossProfitDelta: profitDeltaStr,
            pendingCostLinesDelta: -1,
          });
        }
      }
    }

    return { resolvedLines: pendingLines.length };
  }

  /**
   * Idempotent Sales Return / Refund Projection Processor.
   */
  async processSalesReturnCompleted(
    event: EventEnvelope<NormalizedReturnEventInput>,
    manager: EntityManager,
  ): Promise<{ applied: boolean; reason?: string }> {
    const tenantId = event.tenantId || TenantContext.require();
    const payload = event.payload;
    const returnId = payload.returnId;
    if (!returnId) {
      return { applied: false, reason: 'MISSING_RETURN_ID' };
    }

    const returnFactsTable = qualifiedTable(
      manager.connection,
      'sales_return_facts',
    );
    const orderFactsTable = qualifiedTable(
      manager.connection,
      'sales_order_facts',
    );
    const lineFactsTable = qualifiedTable(
      manager.connection,
      'sales_order_line_facts',
    );

    const existingReturn = await manager.query(
      `SELECT "id" FROM ${returnFactsTable}
       WHERE "tenant_id" = $1 AND "return_id" = $2
       LIMIT 1`,
      [tenantId, returnId],
    );
    if (existingReturn.length > 0) {
      return { applied: false, reason: 'DUPLICATE_RETURN' };
    }

    // Look up original order fact and line facts
    const orderRows = await manager.query(
      `SELECT * FROM ${orderFactsTable}
       WHERE "tenant_id" = $1 AND "order_id" = $2
       LIMIT 1`,
      [tenantId, payload.orderId],
    );
    const orderFact = orderRows[0] ?? null;

    const orderLines = await manager.query(
      `SELECT * FROM ${lineFactsTable}
       WHERE "tenant_id" = $1 AND "order_id" = $2
       ORDER BY "line_key" ASC`,
      [tenantId, payload.orderId],
    );
    const orderLineBySku = new Map<string, Record<string, unknown>>();
    for (const ol of orderLines) {
      orderLineBySku.set(String(ol.sku_code), ol);
    }

    const branchId = payload.branchId ?? orderFact?.branch_id;
    const channelType = (
      payload.channelType ??
      orderFact?.channel_type ??
      'POS'
    ).toUpperCase();
    const customerGroupId =
      payload.customerGroupId ?? orderFact?.customer_group_id ?? 'WALK_IN';
    const sellerStaffId =
      payload.sellerStaffId ?? orderFact?.seller_staff_id ?? 'UNASSIGNED';
    const dateBucket = toReportingDateBucket(
      payload.occurredAt ?? event.occurredAt ?? new Date().toISOString(),
    );
    const refundAmountStr = formatScaledDecimal(
      parseScaledDecimal(payload.totalRefundAmount),
      4,
    );
    const restocked = payload.restocked !== false;

    const { activeGenerationId, buildingGenerationIds } =
      await this.getActiveGenerations(manager, tenantId, 'sales_analytics');
    const targetGenerations = [activeGenerationId, ...buildingGenerationIds];

    const rawReturnLines = payload.items ?? payload.lines ?? [];
    let totalReturnedUnits = 0n;
    let totalReturnedCogs = 0n;

    if (rawReturnLines.length > 0) {
      for (const rLine of rawReturnLines) {
        const skuCode = String(
          rLine.skuCode ?? rLine.sku ?? rLine.variantId ?? 'SKU-DEFAULT',
        );
        const origLine = orderLineBySku.get(skuCode);
        const qtyStr = formatScaledDecimal(
          parseScaledDecimal(rLine.quantity),
          4,
        );
        const unitCostStr =
          rLine.unitCost !== undefined
            ? formatScaledDecimal(parseScaledDecimal(rLine.unitCost), 4)
            : origLine
              ? String(origLine.unit_cost_snapshot)
              : '0.0000';
        const lineRestocked =
          rLine.restocked !== undefined ? rLine.restocked : restocked;
        const lineReturnedCogsStr = lineRestocked
          ? mulDecimals(qtyStr, unitCostStr, 4)
          : '0.0000';

        const lineRefundStr =
          rLine.refundAmount !== undefined
            ? formatScaledDecimal(parseScaledDecimal(rLine.refundAmount), 4)
            : origLine
              ? mulDecimals(
                  qtyStr,
                  divDecimals(
                    String(origLine.line_net_revenue),
                    String(origLine.quantity),
                    4,
                  ),
                  4,
                )
              : refundAmountStr;

        totalReturnedUnits += parseScaledDecimal(qtyStr);
        totalReturnedCogs += parseScaledDecimal(lineReturnedCogsStr);

        const lineProfitImpact = subDecimals(
          lineReturnedCogsStr,
          lineRefundStr,
          4,
        );

        for (const genId of targetGenerations) {
          await this.applyProductSummaryDelta(manager, {
            tenantId,
            generationId: genId,
            dateBucket,
            branchId,
            variantId: String(origLine?.variant_id ?? skuCode),
            productId: (origLine?.product_id as string) ?? null,
            skuCode,
            productName: String(origLine?.product_name ?? skuCode),
            categoryId: (origLine?.category_id as string) ?? null,
            brandId: (origLine?.brand_id as string) ?? null,
            unitsSoldDelta: '0.0000',
            unitsReturnedDelta: qtyStr,
            grossRevenueDelta: '0.0000',
            discountDelta: '0.0000',
            returnsAmountDelta: lineRefundStr,
            netRevenueDelta: subDecimals('0', lineRefundStr, 4),
            cogsDelta: '0.0000',
            returnedCogsDelta: lineReturnedCogsStr,
            grossProfitDelta: lineProfitImpact,
            orderCountDelta: 0,
            pendingCostLinesDelta: 0,
          });
        }
      }
    } else if (orderLines.length > 0 && orderFact) {
      // Proportional return allocation across original order lines
      const orderNetScaled = parseScaledDecimal(
        subDecimals(
          String(orderFact.subtotal),
          String(orderFact.discount_total),
          4,
        ),
      );
      const refundScaled = parseScaledDecimal(refundAmountStr);

      for (const origLine of orderLines) {
        const lineNetScaled = parseScaledDecimal(
          String(origLine.line_net_revenue),
        );
        const ratioNum =
          orderNetScaled > 0n ? refundScaled : DECIMAL_SCALE_FALLBACK;
        const ratioDen =
          orderNetScaled > 0n ? orderNetScaled : DECIMAL_SCALE_FALLBACK;
        const lineRefundScaled =
          orderNetScaled > 0n
            ? (refundScaled * lineNetScaled) / orderNetScaled
            : refundScaled;
        const lineUnitsScaled =
          (parseScaledDecimal(String(origLine.quantity)) * ratioNum) / ratioDen;
        const lineCogsScaled = restocked
          ? (parseScaledDecimal(String(origLine.cogs_amount)) * ratioNum) /
            ratioDen
          : 0n;

        const lineRefundStr = formatScaledDecimal(lineRefundScaled, 4);
        const lineUnitsStr = formatScaledDecimal(lineUnitsScaled, 4);
        const lineCogsStr = formatScaledDecimal(lineCogsScaled, 4);
        const lineProfitImpact = subDecimals(lineCogsStr, lineRefundStr, 4);

        totalReturnedUnits += lineUnitsScaled;
        totalReturnedCogs += lineCogsScaled;

        for (const genId of targetGenerations) {
          await this.applyProductSummaryDelta(manager, {
            tenantId,
            generationId: genId,
            dateBucket,
            branchId,
            variantId: String(origLine.variant_id),
            productId: (origLine.product_id as string) ?? null,
            skuCode: String(origLine.sku_code),
            productName: String(origLine.product_name),
            categoryId: (origLine.category_id as string) ?? null,
            brandId: (origLine.brand_id as string) ?? null,
            unitsSoldDelta: '0.0000',
            unitsReturnedDelta: lineUnitsStr,
            grossRevenueDelta: '0.0000',
            discountDelta: '0.0000',
            returnsAmountDelta: lineRefundStr,
            netRevenueDelta: subDecimals('0', lineRefundStr, 4),
            cogsDelta: '0.0000',
            returnedCogsDelta: lineCogsStr,
            grossProfitDelta: lineProfitImpact,
            orderCountDelta: 0,
            pendingCostLinesDelta: 0,
          });
        }
      }
    } else {
      totalReturnedUnits = parseScaledDecimal(1);
    }

    const returnedUnitsStr = formatScaledDecimal(totalReturnedUnits, 4);
    const returnedCogsStr = formatScaledDecimal(totalReturnedCogs, 4);

    await manager.query(
      `INSERT INTO ${returnFactsTable} (
        "id", "tenant_id", "return_id", "return_code", "order_id", "branch_id",
        "channel_type", "customer_id", "customer_group_id", "seller_staff_id",
        "date_bucket", "refund_amount", "returned_units", "returned_cogs_amount",
        "restocked", "return_lines", "last_event_id", "occurred_at", "created_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16::jsonb, $17, $18, now()
      )`,
      [
        randomUUID(),
        tenantId,
        returnId,
        payload.code ?? `RET-${returnId.slice(0, 8)}`,
        payload.orderId,
        branchId,
        channelType,
        payload.customerId ?? orderFact?.customer_id ?? null,
        customerGroupId,
        sellerStaffId,
        dateBucket,
        refundAmountStr,
        returnedUnitsStr,
        returnedCogsStr,
        restocked,
        JSON.stringify(rawReturnLines),
        event.id ?? null,
        new Date(payload.occurredAt ?? event.occurredAt ?? new Date()),
      ],
    );

    const netRevenueDeltaStr = subDecimals('0', refundAmountStr, 4);
    const grossProfitDeltaStr = subDecimals(
      returnedCogsStr,
      refundAmountStr,
      4,
    );

    for (const genId of targetGenerations) {
      await this.applyReturnDeltaToSummaries(manager, {
        tenantId,
        generationId: genId,
        dateBucket,
        branchId,
        channelType,
        employeeId: sellerStaffId,
        customerGroupId,
        refundAmount: refundAmountStr,
        netRevenueDelta: netRevenueDeltaStr,
        returnedCogs: returnedCogsStr,
        grossProfitDelta: grossProfitDeltaStr,
        returnedUnits: returnedUnitsStr,
      });
    }

    await this.touchCheckpoint(manager, tenantId, 'sales_analytics', event);
    return { applied: true };
  }

  /**
   * Inventory Stock, Valuation, Reservation & Multi-Warehouse Transfer Projection Processor.
   */
  async processInventoryStockEvent(
    event: EventEnvelope<{
      warehouseId: string;
      destinationWarehouseId?: string;
      branchId?: string | null;
      skuId?: string;
      skuCode?: string;
      productName?: string;
      categoryId?: string | null;
      movementType?: string;
      qtyDelta?: string | number;
      onHandAfter?: string | number;
      reservedAfter?: string | number;
      unitCost?: string | number;
      avgCostAfter?: string | number;
      lowStockThreshold?: string | number;
      referenceType?: string;
      referenceId?: string;
      occurredAt?: string;
    }>,
    manager: EntityManager,
  ): Promise<{ applied: boolean }> {
    const tenantId = event.tenantId || TenantContext.require();
    const p = event.payload;
    const movementType = String(p.movementType ?? 'STOCK_CHANGE').toUpperCase();
    const warehouseId =
      p.warehouseId ??
      (movementType === 'TRANSFER_RECEIPT'
        ? ((p as any).toWarehouseId ?? (p as any).fromWarehouseId)
        : ((p as any).fromWarehouseId ?? (p as any).toWarehouseId));
    if (!warehouseId || (!p.skuCode && !p.skuId)) {
      return { applied: false };
    }
    const skuCode = String(p.skuCode ?? p.skuId ?? 'UNKNOWN-SKU');
    const occurredAt =
      p.occurredAt ?? event.occurredAt ?? new Date().toISOString();
    const dateBucket = toReportingDateBucket(occurredAt);
    const eventId = event.id ?? randomUUID();

    const movementTable = qualifiedTable(
      manager.connection,
      'inventory_movement_projections',
    );
    const stockTable = qualifiedTable(
      manager.connection,
      'inventory_stock_projections',
    );
    const dimTable = qualifiedTable(
      manager.connection,
      'insight_dimension_caches',
    );

    // Check movement idempotency
    const existingMov = await manager.query(
      `SELECT "id" FROM ${movementTable}
       WHERE "tenant_id" = $1 AND "event_id" = $2 AND "warehouse_id" = $3 AND "sku_code" = $4
       LIMIT 1`,
      [tenantId, eventId, warehouseId, skuCode],
    );
    if (existingMov.length > 0) {
      return { applied: false };
    }

    // Look up current stock projection row
    const stockRows = await manager.query(
      `SELECT * FROM ${stockTable}
       WHERE "tenant_id" = $1 AND "warehouse_id" = $2 AND "sku_code" = $3
       FOR UPDATE`,
      [tenantId, warehouseId, skuCode],
    );
    const current = stockRows[0] ?? null;

    let productName = p.productName ?? current?.product_name ?? skuCode;
    let categoryId = p.categoryId ?? current?.category_id ?? null;
    if (!current || productName === skuCode) {
      const dimRows = await manager.query(
        `SELECT "name", "category_id" FROM ${dimTable}
         WHERE "tenant_id" = $1 AND "dimension_type" = 'VARIANT' AND ("code" = $2 OR "entity_id" = $2)
         LIMIT 1`,
        [tenantId, skuCode],
      );
      if (dimRows[0]) {
        productName = dimRows[0].name || productName;
        categoryId = categoryId ?? dimRows[0].category_id ?? null;
      }
    }

    const curOnHand = String(current?.on_hand_qty ?? '0');
    const curReserved = String(current?.reserved_qty ?? '0');
    const curInTransit = String(current?.in_transit_qty ?? '0');
    const curAvgCost = String(current?.avg_unit_cost ?? '0');
    const thresholdStr = formatScaledDecimal(
      parseScaledDecimal(
        p.lowStockThreshold ?? current?.low_stock_threshold ?? 5,
      ),
      4,
    );

    const qtyDeltaStr = formatScaledDecimal(
      parseScaledDecimal(p.qtyDelta ?? 0),
      4,
    );
    const newOnHandStr =
      p.onHandAfter !== undefined
        ? formatScaledDecimal(parseScaledDecimal(p.onHandAfter), 4)
        : addDecimals(curOnHand, qtyDeltaStr, 4);
    const newReservedStr =
      p.reservedAfter !== undefined
        ? formatScaledDecimal(parseScaledDecimal(p.reservedAfter), 4)
        : curReserved;

    let newAvgCostStr = curAvgCost;
    if (p.avgCostAfter !== undefined && p.avgCostAfter !== null) {
      newAvgCostStr = formatScaledDecimal(
        parseScaledDecimal(p.avgCostAfter),
        4,
      );
    } else if (
      p.unitCost !== undefined &&
      p.unitCost !== null &&
      parseScaledDecimal(qtyDeltaStr) > 0n &&
      (movementType.includes('RECEIPT') || movementType.includes('RECEIVE'))
    ) {
      newAvgCostStr = computeWeightedAverageCost(
        curOnHand,
        curAvgCost,
        qtyDeltaStr,
        p.unitCost,
        4,
      );
    } else if (
      parseScaledDecimal(curAvgCost) === 0n &&
      p.unitCost !== undefined &&
      p.unitCost !== null
    ) {
      newAvgCostStr = formatScaledDecimal(parseScaledDecimal(p.unitCost), 4);
    }

    const unitCostForMovement =
      p.unitCost !== undefined && p.unitCost !== null
        ? formatScaledDecimal(parseScaledDecimal(p.unitCost), 4)
        : newAvgCostStr;

    // Handle multi-warehouse transfer in-transit tracking so stock is never double-counted
    let newInTransitStr = curInTransit;
    if (movementType === 'TRANSFER_DISPATCH') {
      const absTransferQty = formatScaledDecimal(
        parseScaledDecimal(qtyDeltaStr) < 0n
          ? -parseScaledDecimal(qtyDeltaStr)
          : parseScaledDecimal(qtyDeltaStr),
        4,
      );
      if (p.destinationWarehouseId) {
        // Add to destination warehouse's in_transit_qty
        await this.adjustWarehouseInTransit(manager, {
          tenantId,
          warehouseId: p.destinationWarehouseId,
          skuCode,
          productName,
          categoryId,
          inTransitQtyDelta: absTransferQty,
          unitCost: unitCostForMovement,
          dateBucket,
        });
      } else {
        newInTransitStr = addDecimals(curInTransit, absTransferQty, 4);
      }
    } else if (movementType === 'TRANSFER_RECEIPT') {
      const absReceiptQty = formatScaledDecimal(
        parseScaledDecimal(qtyDeltaStr) < 0n
          ? -parseScaledDecimal(qtyDeltaStr)
          : parseScaledDecimal(qtyDeltaStr),
        4,
      );
      const remainingTransit =
        parseScaledDecimal(curInTransit) - parseScaledDecimal(absReceiptQty);
      newInTransitStr = formatScaledDecimal(
        remainingTransit > 0n ? remainingTransit : 0n,
        4,
      );
    }

    const availableStr = computeAvailableQty(newOnHandStr, newReservedStr, 4);
    const valuationStr = computeInventoryValuation(
      newOnHandStr,
      newAvgCostStr,
      4,
    );
    const inTransitValuationStr = computeInventoryValuation(
      newInTransitStr,
      newAvgCostStr,
      4,
    );
    const isLowStock =
      parseScaledDecimal(thresholdStr) > 0n &&
      parseScaledDecimal(availableStr) <= parseScaledDecimal(thresholdStr);

    await manager.query(
      `INSERT INTO ${stockTable} (
        "id", "tenant_id", "warehouse_id", "branch_id", "sku_code", "variant_id",
        "product_name", "category_id", "on_hand_qty", "reserved_qty", "available_qty",
        "in_transit_qty", "avg_unit_cost", "inventory_valuation", "in_transit_valuation",
        "low_stock_threshold", "is_low_stock", "last_movement_at", "projection_version", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18, 1, now()
      )
      ON CONFLICT ("tenant_id", "warehouse_id", "sku_code") DO UPDATE SET
        "branch_id" = COALESCE(EXCLUDED."branch_id", ${stockTable}."branch_id"),
        "product_name" = EXCLUDED."product_name",
        "category_id" = COALESCE(EXCLUDED."category_id", ${stockTable}."category_id"),
        "on_hand_qty" = EXCLUDED."on_hand_qty",
        "reserved_qty" = EXCLUDED."reserved_qty",
        "available_qty" = EXCLUDED."available_qty",
        "in_transit_qty" = EXCLUDED."in_transit_qty",
        "avg_unit_cost" = EXCLUDED."avg_unit_cost",
        "inventory_valuation" = EXCLUDED."inventory_valuation",
        "in_transit_valuation" = EXCLUDED."in_transit_valuation",
        "low_stock_threshold" = EXCLUDED."low_stock_threshold",
        "is_low_stock" = EXCLUDED."is_low_stock",
        "last_movement_at" = EXCLUDED."last_movement_at",
        "projection_version" = ${stockTable}."projection_version" + 1,
        "updated_at" = now()`,
      [
        current?.id ?? randomUUID(),
        tenantId,
        warehouseId,
        p.branchId ?? current?.branch_id ?? warehouseId,
        skuCode,
        p.skuId ?? current?.variant_id ?? skuCode,
        productName,
        categoryId,
        newOnHandStr,
        newReservedStr,
        availableStr,
        newInTransitStr,
        newAvgCostStr,
        valuationStr,
        inTransitValuationStr,
        thresholdStr,
        isLowStock,
        new Date(occurredAt),
      ],
    );

    const valueDeltaStr = mulDecimals(qtyDeltaStr, unitCostForMovement, 4);
    await manager.query(
      `INSERT INTO ${movementTable} (
        "id", "tenant_id", "event_id", "date_bucket", "warehouse_id", "branch_id",
        "sku_code", "movement_type", "qty_delta", "unit_cost", "value_delta",
        "on_hand_after", "reserved_after", "reference_type", "reference_id", "occurred_at", "created_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16, now()
      )
      ON CONFLICT ("tenant_id", "event_id", "warehouse_id", "sku_code") DO NOTHING`,
      [
        randomUUID(),
        tenantId,
        eventId,
        dateBucket,
        warehouseId,
        p.branchId ?? current?.branch_id ?? warehouseId,
        skuCode,
        movementType,
        qtyDeltaStr,
        unitCostForMovement,
        valueDeltaStr,
        newOnHandStr,
        newReservedStr,
        p.referenceType ?? 'INVENTORY',
        p.referenceId ?? eventId,
        new Date(occurredAt),
      ],
    );

    await this.refreshWarehouseValuationSnapshot(
      manager,
      tenantId,
      warehouseId,
      dateBucket,
    );

    // If this movement carries a verified cost, resolve any pending order line costs for this SKU
    if (parseScaledDecimal(unitCostForMovement) > 0n) {
      await this.resolvePendingOrderCosts(manager, {
        tenantId,
        skuCode,
        unitCost: unitCostForMovement,
        orderId: p.referenceType === 'ORDER' ? p.referenceId : null,
      });
    }

    await this.touchCheckpoint(manager, tenantId, 'inventory_analytics', event);
    return { applied: true };
  }

  /**
   * Finance Cashbook & Receivable Payment Processor.
   * Tracks cash inflow/outflow and debt collection on daily_sales_summaries
   * WITHOUT altering recognized sales revenue (GMV / Gross / Net Sales Revenue).
   */
  async processFinanceCashOrReceivableEvent(
    event: EventEnvelope<{
      branchId?: string | null;
      direction?: 'RECEIPT' | 'EXPENSE';
      amount?: string | number;
      paidAmount?: string | number;
      paymentDelta?: string | number;
      occurredAt?: string;
    }>,
    manager: EntityManager,
    kind: 'CASHBOOK' | 'RECEIVABLE_PAYMENT',
  ): Promise<void> {
    const tenantId = event.tenantId || TenantContext.require();
    const p = event.payload;
    if (!p.branchId) {
      return;
    }
    const dateBucket = toReportingDateBucket(
      p.occurredAt ?? event.occurredAt ?? new Date().toISOString(),
    );
    const { activeGenerationId, buildingGenerationIds } =
      await this.getActiveGenerations(manager, tenantId, 'sales_analytics');
    const dailyTable = qualifiedTable(
      manager.connection,
      'daily_sales_summaries',
    );

    let cashInflowDelta = '0.0000';
    let cashOutflowDelta = '0.0000';
    let debtCollectedDelta = '0.0000';

    if (kind === 'RECEIVABLE_PAYMENT') {
      const amt = formatScaledDecimal(
        parseScaledDecimal(p.paymentDelta ?? p.paidAmount ?? p.amount ?? 0),
        4,
      );
      debtCollectedDelta = amt;
      cashInflowDelta = amt;
    } else if (kind === 'CASHBOOK') {
      const amt = formatScaledDecimal(parseScaledDecimal(p.amount ?? 0), 4);
      if (p.direction === 'EXPENSE') {
        cashOutflowDelta = amt;
      } else {
        cashInflowDelta = amt;
      }
    }

    for (const genId of [activeGenerationId, ...buildingGenerationIds]) {
      await manager.query(
        `INSERT INTO ${dailyTable} (
          "id", "tenant_id", "generation_id", "date_bucket", "branch_id",
          "cash_inflow_amount", "cash_outflow_amount", "debt_collected_amount",
          "projection_version", "updated_at"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now())
        ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id") DO UPDATE SET
          "cash_inflow_amount" = ${dailyTable}."cash_inflow_amount" + EXCLUDED."cash_inflow_amount",
          "cash_outflow_amount" = ${dailyTable}."cash_outflow_amount" + EXCLUDED."cash_outflow_amount",
          "debt_collected_amount" = ${dailyTable}."debt_collected_amount" + EXCLUDED."debt_collected_amount",
          "projection_version" = ${dailyTable}."projection_version" + 1,
          "updated_at" = now()`,
        [
          randomUUID(),
          tenantId,
          genId,
          dateBucket,
          p.branchId,
          cashInflowDelta,
          cashOutflowDelta,
          debtCollectedDelta,
        ],
      );
    }
  }

  private async adjustWarehouseInTransit(
    manager: EntityManager,
    input: {
      tenantId: string;
      warehouseId: string;
      skuCode: string;
      productName: string;
      categoryId: string | null;
      inTransitQtyDelta: string;
      unitCost: string;
      dateBucket: string;
    },
  ): Promise<void> {
    const stockTable = qualifiedTable(
      manager.connection,
      'inventory_stock_projections',
    );
    const inTransitValDelta = mulDecimals(
      input.inTransitQtyDelta,
      input.unitCost,
      4,
    );

    await manager.query(
      `INSERT INTO ${stockTable} (
        "id", "tenant_id", "warehouse_id", "branch_id", "sku_code", "variant_id",
        "product_name", "category_id", "on_hand_qty", "reserved_qty", "available_qty",
        "in_transit_qty", "avg_unit_cost", "inventory_valuation", "in_transit_valuation",
        "low_stock_threshold", "is_low_stock", "last_movement_at", "projection_version", "updated_at"
      ) VALUES (
        $1, $2, $3, $3, $4, $4,
        $5, $6, 0, 0, 0,
        $7, $8, 0, $9,
        5, true, now(), 1, now()
      )
      ON CONFLICT ("tenant_id", "warehouse_id", "sku_code") DO UPDATE SET
        "in_transit_qty" = GREATEST(0, ${stockTable}."in_transit_qty" + EXCLUDED."in_transit_qty"),
        "avg_unit_cost" = CASE WHEN ${stockTable}."avg_unit_cost" = 0 THEN EXCLUDED."avg_unit_cost" ELSE ${stockTable}."avg_unit_cost" END,
        "in_transit_valuation" = GREATEST(0, (${stockTable}."in_transit_qty" + EXCLUDED."in_transit_qty") * CASE WHEN ${stockTable}."avg_unit_cost" = 0 THEN EXCLUDED."avg_unit_cost" ELSE ${stockTable}."avg_unit_cost" END),
        "projection_version" = ${stockTable}."projection_version" + 1,
        "updated_at" = now()`,
      [
        randomUUID(),
        input.tenantId,
        input.warehouseId,
        input.skuCode,
        input.productName,
        input.categoryId,
        input.inTransitQtyDelta,
        input.unitCost,
        inTransitValDelta,
      ],
    );

    await this.refreshWarehouseValuationSnapshot(
      manager,
      input.tenantId,
      input.warehouseId,
      input.dateBucket,
    );
  }

  async refreshWarehouseValuationSnapshot(
    manager: EntityManager,
    tenantId: string,
    warehouseId: string,
    snapshotDate: string,
  ): Promise<void> {
    const stockTable = qualifiedTable(
      manager.connection,
      'inventory_stock_projections',
    );
    const snapTable = qualifiedTable(
      manager.connection,
      'inventory_value_snapshots',
    );

    const aggRows = await manager.query(
      `SELECT
        MAX("branch_id"::text) AS "branch_id",
        COUNT(*)::int AS "sku_count",
        COALESCE(SUM("on_hand_qty"), 0) AS "total_on_hand_qty",
        COALESCE(SUM("reserved_qty"), 0) AS "total_reserved_qty",
        COALESCE(SUM("available_qty"), 0) AS "total_available_qty",
        COALESCE(SUM("in_transit_qty"), 0) AS "total_in_transit_qty",
        COALESCE(SUM("inventory_valuation"), 0) AS "on_hand_valuation",
        COALESCE(SUM("in_transit_valuation"), 0) AS "in_transit_valuation"
       FROM ${stockTable}
       WHERE "tenant_id" = $1 AND "warehouse_id" = $2`,
      [tenantId, warehouseId],
    );

    const agg = aggRows[0];
    const onHandVal = String(agg?.on_hand_valuation ?? '0');
    const inTransitVal = String(agg?.in_transit_valuation ?? '0');
    const totalVal = addDecimals(onHandVal, inTransitVal, 4);

    await manager.query(
      `INSERT INTO ${snapTable} (
        "id", "tenant_id", "snapshot_date", "warehouse_id", "branch_id",
        "sku_count", "total_on_hand_qty", "total_reserved_qty", "total_available_qty",
        "total_in_transit_qty", "on_hand_valuation", "in_transit_valuation", "total_valuation", "updated_at"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
      ON CONFLICT ("tenant_id", "snapshot_date", "warehouse_id") DO UPDATE SET
        "branch_id" = COALESCE(EXCLUDED."branch_id", ${snapTable}."branch_id"),
        "sku_count" = EXCLUDED."sku_count",
        "total_on_hand_qty" = EXCLUDED."total_on_hand_qty",
        "total_reserved_qty" = EXCLUDED."total_reserved_qty",
        "total_available_qty" = EXCLUDED."total_available_qty",
        "total_in_transit_qty" = EXCLUDED."total_in_transit_qty",
        "on_hand_valuation" = EXCLUDED."on_hand_valuation",
        "in_transit_valuation" = EXCLUDED."in_transit_valuation",
        "total_valuation" = EXCLUDED."total_valuation",
        "updated_at" = now()`,
      [
        randomUUID(),
        tenantId,
        snapshotDate,
        warehouseId,
        agg?.branch_id ?? warehouseId,
        Number(agg?.sku_count ?? 0),
        String(agg?.total_on_hand_qty ?? '0'),
        String(agg?.total_reserved_qty ?? '0'),
        String(agg?.total_available_qty ?? '0'),
        String(agg?.total_in_transit_qty ?? '0'),
        onHandVal,
        inTransitVal,
        totalVal,
      ],
    );
  }

  async applyOrderDeltaToSummaries(
    manager: EntityManager,
    input: {
      tenantId: string;
      generationId: string;
      dateBucket: string;
      branchId: string;
      channelType: string;
      employeeId: string;
      customerGroupId: string;
      delta: OrderContributionVector;
      grossProfitDelta: string;
      pendingCostLinesDelta: number;
    },
  ): Promise<void> {
    const dailyTable = qualifiedTable(
      manager.connection,
      'daily_sales_summaries',
    );
    const channelTable = qualifiedTable(
      manager.connection,
      'channel_sales_summaries',
    );
    const empTable = qualifiedTable(
      manager.connection,
      'employee_sales_summaries',
    );
    const custGroupTable = qualifiedTable(
      manager.connection,
      'customer_group_sales_summaries',
    );

    const { delta } = input;

    // 1. Daily Sales Summary
    await manager.query(
      `INSERT INTO ${dailyTable} (
        "id", "tenant_id", "generation_id", "date_bucket", "branch_id",
        "gmv", "gross_sales_revenue", "discount_total", "returns_amount", "net_sales_revenue",
        "cogs_amount", "returned_cogs_amount", "net_cogs_amount", "gross_profit",
        "order_count", "completed_order_count", "cancelled_order_count", "return_count",
        "units_sold", "units_returned", "pending_cost_lines_count", "projection_version", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, 0, $9,
        $10, 0, $10, $11,
        $12, $13, $14, 0,
        $15, 0, GREATEST(0, $16), 1, now()
      )
      ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id") DO UPDATE SET
        "gmv" = ${dailyTable}."gmv" + EXCLUDED."gmv",
        "gross_sales_revenue" = ${dailyTable}."gross_sales_revenue" + EXCLUDED."gross_sales_revenue",
        "discount_total" = ${dailyTable}."discount_total" + EXCLUDED."discount_total",
        "net_sales_revenue" = ${dailyTable}."net_sales_revenue" + EXCLUDED."net_sales_revenue",
        "cogs_amount" = ${dailyTable}."cogs_amount" + EXCLUDED."cogs_amount",
        "net_cogs_amount" = ${dailyTable}."net_cogs_amount" + EXCLUDED."net_cogs_amount",
        "gross_profit" = ${dailyTable}."gross_profit" + EXCLUDED."gross_profit",
        "order_count" = ${dailyTable}."order_count" + EXCLUDED."order_count",
        "completed_order_count" = ${dailyTable}."completed_order_count" + EXCLUDED."completed_order_count",
        "cancelled_order_count" = ${dailyTable}."cancelled_order_count" + EXCLUDED."cancelled_order_count",
        "units_sold" = ${dailyTable}."units_sold" + EXCLUDED."units_sold",
        "pending_cost_lines_count" = GREATEST(0, ${dailyTable}."pending_cost_lines_count" + $16),
        "projection_version" = ${dailyTable}."projection_version" + 1,
        "updated_at" = now()`,
      [
        randomUUID(),
        input.tenantId,
        input.generationId,
        input.dateBucket,
        input.branchId,
        delta.gmv,
        delta.grossRevenue,
        delta.discount,
        delta.netRevenue,
        delta.cogs,
        input.grossProfitDelta,
        delta.orderCount,
        delta.completedCount,
        delta.cancelledCount,
        delta.unitsSold,
        input.pendingCostLinesDelta,
      ],
    );

    // 2. Channel Sales Summary
    await manager.query(
      `INSERT INTO ${channelTable} (
        "id", "tenant_id", "generation_id", "date_bucket", "branch_id", "channel_type",
        "gmv", "gross_sales_revenue", "discount_total", "returns_amount", "net_sales_revenue",
        "gross_profit", "order_count", "completed_order_count", "cancelled_order_count", "units_sold", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, 0, $10,
        $11, $12, $13, $14, $15, now()
      )
      ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id", "channel_type") DO UPDATE SET
        "gmv" = ${channelTable}."gmv" + EXCLUDED."gmv",
        "gross_sales_revenue" = ${channelTable}."gross_sales_revenue" + EXCLUDED."gross_sales_revenue",
        "discount_total" = ${channelTable}."discount_total" + EXCLUDED."discount_total",
        "net_sales_revenue" = ${channelTable}."net_sales_revenue" + EXCLUDED."net_sales_revenue",
        "gross_profit" = ${channelTable}."gross_profit" + EXCLUDED."gross_profit",
        "order_count" = ${channelTable}."order_count" + EXCLUDED."order_count",
        "completed_order_count" = ${channelTable}."completed_order_count" + EXCLUDED."completed_order_count",
        "cancelled_order_count" = ${channelTable}."cancelled_order_count" + EXCLUDED."cancelled_order_count",
        "units_sold" = ${channelTable}."units_sold" + EXCLUDED."units_sold",
        "updated_at" = now()`,
      [
        randomUUID(),
        input.tenantId,
        input.generationId,
        input.dateBucket,
        input.branchId,
        input.channelType,
        delta.gmv,
        delta.grossRevenue,
        delta.discount,
        delta.netRevenue,
        input.grossProfitDelta,
        delta.orderCount,
        delta.completedCount,
        delta.cancelledCount,
        delta.unitsSold,
      ],
    );

    // 3. Employee Sales Summary (when completed revenue/profit/count changes)
    if (
      parseScaledDecimal(delta.grossRevenue) !== 0n ||
      parseScaledDecimal(input.grossProfitDelta) !== 0n ||
      delta.completedCount !== 0
    ) {
      await manager.query(
        `INSERT INTO ${empTable} (
          "id", "tenant_id", "generation_id", "date_bucket", "branch_id", "employee_id",
          "gross_sales_revenue", "discount_total", "returns_amount", "net_sales_revenue",
          "gross_profit", "completed_order_count", "return_count", "units_sold", "updated_at"
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, 0, $9,
          $10, $11, 0, $12, now()
        )
        ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id", "employee_id") DO UPDATE SET
          "gross_sales_revenue" = ${empTable}."gross_sales_revenue" + EXCLUDED."gross_sales_revenue",
          "discount_total" = ${empTable}."discount_total" + EXCLUDED."discount_total",
          "net_sales_revenue" = ${empTable}."net_sales_revenue" + EXCLUDED."net_sales_revenue",
          "gross_profit" = ${empTable}."gross_profit" + EXCLUDED."gross_profit",
          "completed_order_count" = ${empTable}."completed_order_count" + EXCLUDED."completed_order_count",
          "units_sold" = ${empTable}."units_sold" + EXCLUDED."units_sold",
          "updated_at" = now()`,
        [
          randomUUID(),
          input.tenantId,
          input.generationId,
          input.dateBucket,
          input.branchId,
          input.employeeId,
          delta.grossRevenue,
          delta.discount,
          delta.netRevenue,
          input.grossProfitDelta,
          delta.completedCount,
          delta.unitsSold,
        ],
      );

      // 4. Customer Group Sales Summary
      await manager.query(
        `INSERT INTO ${custGroupTable} (
          "id", "tenant_id", "generation_id", "date_bucket", "branch_id", "customer_group_id",
          "gross_sales_revenue", "discount_total", "returns_amount", "net_sales_revenue",
          "gross_profit", "completed_order_count", "units_sold", "updated_at"
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, 0, $9,
          $10, $11, $12, now()
        )
        ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id", "customer_group_id") DO UPDATE SET
          "gross_sales_revenue" = ${custGroupTable}."gross_sales_revenue" + EXCLUDED."gross_sales_revenue",
          "discount_total" = ${custGroupTable}."discount_total" + EXCLUDED."discount_total",
          "net_sales_revenue" = ${custGroupTable}."net_sales_revenue" + EXCLUDED."net_sales_revenue",
          "gross_profit" = ${custGroupTable}."gross_profit" + EXCLUDED."gross_profit",
          "completed_order_count" = ${custGroupTable}."completed_order_count" + EXCLUDED."completed_order_count",
          "units_sold" = ${custGroupTable}."units_sold" + EXCLUDED."units_sold",
          "updated_at" = now()`,
        [
          randomUUID(),
          input.tenantId,
          input.generationId,
          input.dateBucket,
          input.branchId,
          input.customerGroupId,
          delta.grossRevenue,
          delta.discount,
          delta.netRevenue,
          input.grossProfitDelta,
          delta.completedCount,
          delta.unitsSold,
        ],
      );
    }
  }

  async applyReturnDeltaToSummaries(
    manager: EntityManager,
    input: {
      tenantId: string;
      generationId: string;
      dateBucket: string;
      branchId: string;
      channelType: string;
      employeeId: string;
      customerGroupId: string;
      refundAmount: string;
      netRevenueDelta: string;
      returnedCogs: string;
      grossProfitDelta: string;
      returnedUnits: string;
    },
  ): Promise<void> {
    const dailyTable = qualifiedTable(
      manager.connection,
      'daily_sales_summaries',
    );
    const channelTable = qualifiedTable(
      manager.connection,
      'channel_sales_summaries',
    );
    const empTable = qualifiedTable(
      manager.connection,
      'employee_sales_summaries',
    );
    const custGroupTable = qualifiedTable(
      manager.connection,
      'customer_group_sales_summaries',
    );

    const netCogsDelta = subDecimals('0', input.returnedCogs, 4);

    await manager.query(
      `INSERT INTO ${dailyTable} (
        "id", "tenant_id", "generation_id", "date_bucket", "branch_id",
        "gmv", "gross_sales_revenue", "discount_total", "returns_amount", "net_sales_revenue",
        "cogs_amount", "returned_cogs_amount", "net_cogs_amount", "gross_profit",
        "order_count", "completed_order_count", "cancelled_order_count", "return_count",
        "units_sold", "units_returned", "pending_cost_lines_count", "projection_version", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5,
        0, 0, 0, $6, $7,
        0, $8, $9, $10,
        0, 0, 0, 1,
        0, $11, 0, 1, now()
      )
      ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id") DO UPDATE SET
        "returns_amount" = ${dailyTable}."returns_amount" + EXCLUDED."returns_amount",
        "net_sales_revenue" = ${dailyTable}."net_sales_revenue" + EXCLUDED."net_sales_revenue",
        "returned_cogs_amount" = ${dailyTable}."returned_cogs_amount" + EXCLUDED."returned_cogs_amount",
        "net_cogs_amount" = ${dailyTable}."net_cogs_amount" + EXCLUDED."net_cogs_amount",
        "gross_profit" = ${dailyTable}."gross_profit" + EXCLUDED."gross_profit",
        "return_count" = ${dailyTable}."return_count" + 1,
        "units_returned" = ${dailyTable}."units_returned" + EXCLUDED."units_returned",
        "projection_version" = ${dailyTable}."projection_version" + 1,
        "updated_at" = now()`,
      [
        randomUUID(),
        input.tenantId,
        input.generationId,
        input.dateBucket,
        input.branchId,
        input.refundAmount,
        input.netRevenueDelta,
        input.returnedCogs,
        netCogsDelta,
        input.grossProfitDelta,
        input.returnedUnits,
      ],
    );

    await manager.query(
      `INSERT INTO ${channelTable} (
        "id", "tenant_id", "generation_id", "date_bucket", "branch_id", "channel_type",
        "gmv", "gross_sales_revenue", "discount_total", "returns_amount", "net_sales_revenue",
        "gross_profit", "order_count", "completed_order_count", "cancelled_order_count", "units_sold", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        0, 0, 0, $7, $8,
        $9, 0, 0, 0, 0, now()
      )
      ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id", "channel_type") DO UPDATE SET
        "returns_amount" = ${channelTable}."returns_amount" + EXCLUDED."returns_amount",
        "net_sales_revenue" = ${channelTable}."net_sales_revenue" + EXCLUDED."net_sales_revenue",
        "gross_profit" = ${channelTable}."gross_profit" + EXCLUDED."gross_profit",
        "updated_at" = now()`,
      [
        randomUUID(),
        input.tenantId,
        input.generationId,
        input.dateBucket,
        input.branchId,
        input.channelType,
        input.refundAmount,
        input.netRevenueDelta,
        input.grossProfitDelta,
      ],
    );

    await manager.query(
      `INSERT INTO ${empTable} (
        "id", "tenant_id", "generation_id", "date_bucket", "branch_id", "employee_id",
        "gross_sales_revenue", "discount_total", "returns_amount", "net_sales_revenue",
        "gross_profit", "completed_order_count", "return_count", "units_sold", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        0, 0, $7, $8,
        $9, 0, 1, 0, now()
      )
      ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id", "employee_id") DO UPDATE SET
        "returns_amount" = ${empTable}."returns_amount" + EXCLUDED."returns_amount",
        "net_sales_revenue" = ${empTable}."net_sales_revenue" + EXCLUDED."net_sales_revenue",
        "gross_profit" = ${empTable}."gross_profit" + EXCLUDED."gross_profit",
        "return_count" = ${empTable}."return_count" + 1,
        "updated_at" = now()`,
      [
        randomUUID(),
        input.tenantId,
        input.generationId,
        input.dateBucket,
        input.branchId,
        input.employeeId,
        input.refundAmount,
        input.netRevenueDelta,
        input.grossProfitDelta,
      ],
    );

    await manager.query(
      `INSERT INTO ${custGroupTable} (
        "id", "tenant_id", "generation_id", "date_bucket", "branch_id", "customer_group_id",
        "gross_sales_revenue", "discount_total", "returns_amount", "net_sales_revenue",
        "gross_profit", "completed_order_count", "units_sold", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        0, 0, $7, $8,
        $9, 0, 0, now()
      )
      ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id", "customer_group_id") DO UPDATE SET
        "returns_amount" = ${custGroupTable}."returns_amount" + EXCLUDED."returns_amount",
        "net_sales_revenue" = ${custGroupTable}."net_sales_revenue" + EXCLUDED."net_sales_revenue",
        "gross_profit" = ${custGroupTable}."gross_profit" + EXCLUDED."gross_profit",
        "updated_at" = now()`,
      [
        randomUUID(),
        input.tenantId,
        input.generationId,
        input.dateBucket,
        input.branchId,
        input.customerGroupId,
        input.refundAmount,
        input.netRevenueDelta,
        input.grossProfitDelta,
      ],
    );
  }

  async applyProductSummaryDelta(
    manager: EntityManager,
    input: {
      tenantId: string;
      generationId: string;
      dateBucket: string;
      branchId: string;
      variantId: string;
      productId: string | null;
      skuCode: string;
      productName: string;
      categoryId: string | null;
      brandId: string | null;
      unitsSoldDelta: string;
      unitsReturnedDelta: string;
      grossRevenueDelta: string;
      discountDelta: string;
      returnsAmountDelta: string;
      netRevenueDelta: string;
      cogsDelta: string;
      returnedCogsDelta: string;
      grossProfitDelta: string;
      orderCountDelta: number;
      pendingCostLinesDelta: number;
    },
  ): Promise<void> {
    const productTable = qualifiedTable(
      manager.connection,
      'product_sales_summaries',
    );
    const netCogsDelta = subDecimals(
      input.cogsDelta,
      input.returnedCogsDelta,
      4,
    );

    await manager.query(
      `INSERT INTO ${productTable} (
        "id", "tenant_id", "generation_id", "date_bucket", "branch_id",
        "variant_id", "product_id", "sku_code", "product_name", "category_id", "brand_id",
        "units_sold", "units_returned", "gross_sales_revenue", "discount_total",
        "returns_amount", "net_sales_revenue", "cogs_amount", "returned_cogs_amount",
        "net_cogs_amount", "gross_profit", "order_count", "pending_cost_lines_count", "updated_at"
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19,
        $20, $21, $22, GREATEST(0, $23), now()
      )
      ON CONFLICT ("tenant_id", "generation_id", "date_bucket", "branch_id", "sku_code") DO UPDATE SET
        "product_name" = EXCLUDED."product_name",
        "category_id" = COALESCE(EXCLUDED."category_id", ${productTable}."category_id"),
        "brand_id" = COALESCE(EXCLUDED."brand_id", ${productTable}."brand_id"),
        "units_sold" = ${productTable}."units_sold" + EXCLUDED."units_sold",
        "units_returned" = ${productTable}."units_returned" + EXCLUDED."units_returned",
        "gross_sales_revenue" = ${productTable}."gross_sales_revenue" + EXCLUDED."gross_sales_revenue",
        "discount_total" = ${productTable}."discount_total" + EXCLUDED."discount_total",
        "returns_amount" = ${productTable}."returns_amount" + EXCLUDED."returns_amount",
        "net_sales_revenue" = ${productTable}."net_sales_revenue" + EXCLUDED."net_sales_revenue",
        "cogs_amount" = ${productTable}."cogs_amount" + EXCLUDED."cogs_amount",
        "returned_cogs_amount" = ${productTable}."returned_cogs_amount" + EXCLUDED."returned_cogs_amount",
        "net_cogs_amount" = ${productTable}."net_cogs_amount" + EXCLUDED."net_cogs_amount",
        "gross_profit" = ${productTable}."gross_profit" + EXCLUDED."gross_profit",
        "order_count" = ${productTable}."order_count" + EXCLUDED."order_count",
        "pending_cost_lines_count" = GREATEST(0, ${productTable}."pending_cost_lines_count" + $23),
        "updated_at" = now()`,
      [
        randomUUID(),
        input.tenantId,
        input.generationId,
        input.dateBucket,
        input.branchId,
        input.variantId,
        input.productId,
        input.skuCode,
        input.productName,
        input.categoryId,
        input.brandId,
        input.unitsSoldDelta,
        input.unitsReturnedDelta,
        input.grossRevenueDelta,
        input.discountDelta,
        input.returnsAmountDelta,
        input.netRevenueDelta,
        input.cogsDelta,
        input.returnedCogsDelta,
        netCogsDelta,
        input.grossProfitDelta,
        input.orderCountDelta,
        input.pendingCostLinesDelta,
      ],
    );
  }
}

const DECIMAL_SCALE_FALLBACK = 10000n;
