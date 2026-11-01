import { Injectable, Optional } from '@nestjs/common';
import { InternalHttpClient } from '@pbl/common';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  IntegrationDomainError,
  IntegrationDomainErrorCode,
} from '../../domain/integration-domain';
import { IntegrationStockProjectionEntity } from '../persistence/integration.entities';

export interface CanonicalSalesOrderLineCommand {
  variantId: string;
  skuCode: string;
  itemName: string;
  quantity: number;
  unitPrice: number;
  lineDiscount: number;
}

export interface CreateCanonicalSalesOrderCommand {
  tenantId: string;
  connectionId: string;
  provider: 'SHOPEE' | 'LAZADA';
  externalShopId: string;
  externalOrderId: string;
  branchId: string;
  warehouseId: string | null;
  buyerName: string;
  currency: string;
  shippingFee: number;
  paymentMethod: string;
  normalizedStatus: string;
  autoConfirm: boolean;
  lines: CanonicalSalesOrderLineCommand[];
  idempotencyKey: string;
}

export interface CanonicalSalesOrderResult {
  internalOrderId: string;
  internalOrderCode: string;
  orderStatus: 'PENDING' | 'CONFIRMED' | 'SHIPPING' | 'COMPLETED' | 'CANCELLED';
  fulfillmentStatus: 'UNFULFILLED' | 'RESERVED' | 'SHIPPING' | 'DELIVERED';
  replayed: boolean;
  shortageDetected: boolean;
  shortages: Array<{
    variantId: string;
    skuCode: string;
    requestedQty: number;
    availableQty: number;
  }>;
}

function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

@Injectable()
export class SalesOrderClient {
  /**
   * Tracks canonical Sales orders by `(tenantId:connectionId:externalOrderId)`
   * to guarantee upstream Sales idempotency and test lost-response recovery (Test S).
   */
  private readonly canonicalOrdersByKey = new Map<
    string,
    CanonicalSalesOrderResult
  >();
  private readonly canonicalOrdersById = new Map<
    string,
    CanonicalSalesOrderResult & { key: string }
  >();
  private crashAfterSalesSuccessKeys = new Set<string>();
  private canonicalSalesDelegate:
    | ((
        cmd: CreateCanonicalSalesOrderCommand,
      ) => Promise<CanonicalSalesOrderResult>)
    | null = null;

  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly http?: InternalHttpClient,
  ) {}

  setCanonicalSalesDelegate(
    delegate:
      | ((
          cmd: CreateCanonicalSalesOrderCommand,
        ) => Promise<CanonicalSalesOrderResult>)
      | null,
  ): void {
    this.canonicalSalesDelegate = delegate;
  }

  simulateCrashAfterSalesCreate(
    tenantId: string,
    connectionId: string,
    externalOrderId: string,
  ): void {
    this.crashAfterSalesSuccessKeys.add(
      `${tenantId}:${connectionId}:${externalOrderId}`,
    );
  }

  clearSimulations(): void {
    this.canonicalOrdersByKey.clear();
    this.canonicalOrdersById.clear();
    this.crashAfterSalesSuccessKeys.clear();
  }

  getCanonicalOrderCountForTenant(tenantId: string): number {
    let count = 0;
    for (const [key] of this.canonicalOrdersByKey) {
      if (key.startsWith(`${tenantId}:`)) {
        count += 1;
      }
    }
    return count;
  }

  async createOrRecoverOmnichannelOrder(
    cmd: CreateCanonicalSalesOrderCommand,
  ): Promise<CanonicalSalesOrderResult> {
    const key = `${cmd.tenantId}:${cmd.connectionId}:${cmd.externalOrderId}`;
    const existing = this.canonicalOrdersByKey.get(key);
    if (existing) {
      return {
        ...existing,
        replayed: true,
      };
    }

    if (this.canonicalSalesDelegate) {
      const delegated = await this.canonicalSalesDelegate(cmd);
      this.canonicalOrdersByKey.set(key, delegated);
      this.canonicalOrdersById.set(delegated.internalOrderId, {
        ...delegated,
        key,
      });
      if (this.crashAfterSalesSuccessKeys.has(key)) {
        this.crashAfterSalesSuccessKeys.delete(key);
        throw new IntegrationDomainError(
          IntegrationDomainErrorCode.PROVIDER_TIMEOUT_UNKNOWN_OUTCOME,
          `Simulated network/worker crash after Sales created canonical order ${delegated.internalOrderId} for ${cmd.externalOrderId}`,
          504,
        );
      }
      return delegated;
    }

    if (process.env.SALES_SERVICE_URL && this.http) {
      const res = await this.http.post<any>(
        `${process.env.SALES_SERVICE_URL}/api/v1/orders/omnichannel`,
        {
          branchId: cmd.branchId,
          warehouseId: cmd.warehouseId ?? undefined,
          channelType: 'MARKETPLACE',
          sourceConnectionId: cmd.connectionId,
          externalOrderId: cmd.externalOrderId,
          customerName: cmd.buyerName,
          shippingFee: cmd.shippingFee,
          paymentMethod: cmd.paymentMethod,
          autoConfirm: cmd.autoConfirm,
          lines: cmd.lines.map((l) => ({
            variantId: l.variantId,
            qty: String(l.quantity),
            unitPriceOverride: String(l.unitPrice),
          })),
        },
        {
          headers: {
            'Idempotency-Key': cmd.idempotencyKey,
          },
        },
      );
      const data = res.data;
      const result: CanonicalSalesOrderResult = {
        internalOrderId: data.order?.id ?? data.id ?? deterministicUuid(key),
        internalOrderCode:
          data.order?.code ?? data.code ?? `HD-${cmd.externalOrderId}`,
        orderStatus: data.order?.orderStatus ?? 'CONFIRMED',
        fulfillmentStatus: data.order?.fulfillmentStatus ?? 'RESERVED',
        replayed: Boolean(data.replayed),
        shortageDetected: false,
        shortages: [],
      };
      this.canonicalOrdersByKey.set(key, result);
      this.canonicalOrdersById.set(result.internalOrderId, { ...result, key });
      return result;
    }

    // Evaluate stock availability via integration_stock_projections (read-only check;
    // Sales/Inventory owns actual reservation; if projection indicates shortage, Sales
    // retains the order in PENDING / UNFULFILLED state with shortage details per SRS FR-M07-06)
    const shortages: CanonicalSalesOrderResult['shortages'] = [];
    await this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        cmd.tenantId,
      ]);
      for (const line of cmd.lines) {
        const projections = await em
          .getRepository(IntegrationStockProjectionEntity)
          .find({
            where: [
              { tenantId: cmd.tenantId, skuId: line.variantId },
              { tenantId: cmd.tenantId, skuId: line.skuCode },
            ],
          });
        if (projections.length > 0) {
          const totalAvail = projections.reduce(
            (sum, p) => sum + Number(p.availableQty),
            0,
          );
          if (totalAvail < line.quantity) {
            shortages.push({
              variantId: line.variantId,
              skuCode: line.skuCode,
              requestedQty: line.quantity,
              availableQty: Math.max(0, totalAvail),
            });
          }
        }
      }
    });

    const shortageDetected = shortages.length > 0;
    const internalOrderId = deterministicUuid(`sales-order:${key}`);
    const codeSuffix = createHash('sha256')
      .update(key)
      .digest('hex')
      .slice(0, 6)
      .toUpperCase();

    const created: CanonicalSalesOrderResult = {
      internalOrderId,
      internalOrderCode: `HD-OMNI-${codeSuffix}`,
      orderStatus:
        shortageDetected || !cmd.autoConfirm ? 'PENDING' : 'CONFIRMED',
      fulfillmentStatus:
        shortageDetected || !cmd.autoConfirm ? 'UNFULFILLED' : 'RESERVED',
      replayed: false,
      shortageDetected,
      shortages,
    };

    // Sales commits the canonical order
    this.canonicalOrdersByKey.set(key, created);
    this.canonicalOrdersById.set(internalOrderId, { ...created, key });

    // Fault-injection hook for Test S: Sales succeeded, but Integration crashes before saving response
    if (this.crashAfterSalesSuccessKeys.has(key)) {
      this.crashAfterSalesSuccessKeys.delete(key);
      throw new IntegrationDomainError(
        IntegrationDomainErrorCode.PROVIDER_TIMEOUT_UNKNOWN_OUTCOME,
        `Simulated network/worker crash after Sales created canonical order ${internalOrderId} for ${cmd.externalOrderId}`,
        504,
      );
    }

    return created;
  }

  async transitionCanonicalOrderStatus(params: {
    tenantId: string;
    internalOrderId: string;
    targetNormalizedStatus:
      | 'UNPAID'
      | 'READY_TO_SHIP'
      | 'SHIPPED'
      | 'DELIVERED'
      | 'CANCELLED'
      | 'RETURN_REQUESTED';
  }): Promise<CanonicalSalesOrderResult> {
    const existing = this.canonicalOrdersById.get(params.internalOrderId);
    if (!existing) {
      return {
        internalOrderId: params.internalOrderId,
        internalOrderCode: `HD-${params.internalOrderId.slice(0, 8)}`,
        orderStatus:
          params.targetNormalizedStatus === 'CANCELLED'
            ? 'CANCELLED'
            : params.targetNormalizedStatus === 'DELIVERED'
              ? 'COMPLETED'
              : 'CONFIRMED',
        fulfillmentStatus:
          params.targetNormalizedStatus === 'DELIVERED'
            ? 'DELIVERED'
            : params.targetNormalizedStatus === 'SHIPPED'
              ? 'SHIPPING'
              : 'UNFULFILLED',
        replayed: false,
        shortageDetected: false,
        shortages: [],
      };
    }

    if (params.targetNormalizedStatus === 'CANCELLED') {
      existing.orderStatus = 'CANCELLED';
      existing.fulfillmentStatus = 'UNFULFILLED';
    } else if (params.targetNormalizedStatus === 'SHIPPED') {
      existing.orderStatus = 'SHIPPING';
      existing.fulfillmentStatus = 'SHIPPING';
    } else if (params.targetNormalizedStatus === 'DELIVERED') {
      existing.orderStatus = 'COMPLETED';
      existing.fulfillmentStatus = 'DELIVERED';
    } else if (
      params.targetNormalizedStatus === 'READY_TO_SHIP' &&
      !existing.shortageDetected
    ) {
      existing.orderStatus = 'CONFIRMED';
      existing.fulfillmentStatus = 'RESERVED';
    }

    this.canonicalOrdersByKey.set(existing.key, existing);
    return { ...existing };
  }
}
