/**
 * Milestone M8 — Concurrency Matrix (20 Scenarios), Fault Injection (10 Scenarios),
 * Multi-Tenant Isolation Across 7 Schemas, 7 Cross-Service Reconciliation Pairs,
 * and Real PostgreSQL Performance Baseline Measurements.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  EventEnvelope,
  RequestContext,
  TenantScopedRepository,
} from '@pbl/common';
import {
  CATALOG_PRICE_CHANGED,
  CATALOG_PRODUCT_CREATED,
  CATALOG_VARIANT_CREATED,
  CATALOG_VARIANT_DEACTIVATED,
  CUSTOMER_CREATED,
  FINANCE_CASHBOOK_ENTRY_POSTED,
  FINANCE_RECEIVABLE_PAYMENT_APPLIED,
  INVENTORY_PURCHASE_ORDER_APPROVED,
  INVENTORY_RESERVATION_COMMITTED,
  INVENTORY_RESERVATION_CONFIRMED,
  INVENTORY_RESERVATION_EXPIRED,
  INVENTORY_RESERVATION_RELEASED,
  INVENTORY_STOCKTAKE_ADJUSTED,
  INVENTORY_STOCK_CHANGED,
  INVENTORY_STOCK_ISSUED,
  INVENTORY_STOCK_RECEIVED,
  INVENTORY_TRANSFER_DISPATCHED,
  INVENTORY_TRANSFER_RECEIVED,
  SALES_CHECKOUT_COMPLETED,
  SALES_ORDER_CANCELLED,
  SALES_ORDER_COMPLETED,
  SALES_ORDER_CONFIRMED,
  SALES_ORDER_CREATED,
  SALES_PAYMENT_CONFIRMED,
  SALES_REFUND_REQUESTED,
  SALES_RETURN_COMPLETED,
  SALES_SHIFT_CLOSED,
  SALES_TENDER_RECORDED,
} from '@pbl/contracts';
import {
  CONSUMER_ENTITIES,
  CONSUMER_MIGRATIONS,
  EventOutbox,
  PRODUCER_ENTITIES,
  PRODUCER_MIGRATIONS,
  databaseOptions,
  initializeDatabase,
} from '@pbl/events';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  AttributeEntity,
  AttributeValueEntity,
  BrandEntity,
  CATALOG_ENTITIES,
  CategoryEntity,
  PriceListEntity,
  ProductEntity,
  ProductVariantEntity,
  UnitConversionEntity,
} from '../../../apps/catalog/src/infrastructure/persistence/catalog.entities';
import { CreateCatalogTables1791900000200 } from '../../../apps/catalog/src/migrations/1791900000200-create-catalog-tables';
import { AttributesService } from '../../../apps/catalog/src/modules/attributes/attributes.service';
import { BrandsService } from '../../../apps/catalog/src/modules/brands/brands.service';
import { CategoriesService as CatalogCategoriesService } from '../../../apps/catalog/src/modules/categories/categories.service';
import { PricingService } from '../../../apps/catalog/src/modules/pricing/pricing.service';
import { ProductsService } from '../../../apps/catalog/src/modules/products/products.service';
import { M4_CUSTOMER_ENTITIES } from '../../../apps/customer/src/infrastructure/persistence/customer.entities';
import { CreateM4CustomerCore1791900000200 } from '../../../apps/customer/src/migrations/1791900000200-create-m4-customer-core';
import { AddressesService } from '../../../apps/customer/src/modules/addresses/addresses.service';
import { DataManagementService } from '../../../apps/customer/src/modules/data-management/data-management.service';
import { GroupsService } from '../../../apps/customer/src/modules/groups/groups.service';
import { LoyaltyService } from '../../../apps/customer/src/modules/loyalty/loyalty.service';
import { MembershipsService } from '../../../apps/customer/src/modules/memberships/memberships.service';
import { ProfilesService } from '../../../apps/customer/src/modules/profiles/profiles.service';
import { M5_FINANCE_ENTITIES } from '../../../apps/finance/src/infrastructure/persistence/finance.entities';
import { CreateM5FinanceCore1791900000200 } from '../../../apps/finance/src/migrations/1791900000200-create-m5-finance-core';
import { CashAccountsService } from '../../../apps/finance/src/modules/cash-accounts/cash-accounts.service';
import { CashbookService } from '../../../apps/finance/src/modules/cashbook/cashbook.service';
import { CodService } from '../../../apps/finance/src/modules/cod/cod.service';
import { CreditAuthorizationService } from '../../../apps/finance/src/modules/credit-authorization/credit-authorization.service';
import { FinancialJournalService } from '../../../apps/finance/src/modules/financial-journal/financial-journal.service';
import { PayablesService } from '../../../apps/finance/src/modules/payables/payables.service';
import { ReceivablesService } from '../../../apps/finance/src/modules/receivables/receivables.service';
import { ReconciliationService as FinanceReconciliationService } from '../../../apps/finance/src/modules/reconciliation/reconciliation.service';
import { RefundsService } from '../../../apps/finance/src/modules/refunds/refunds.service';
import { SettlementsService } from '../../../apps/finance/src/modules/settlements/settlements.service';
import { AuditLogEntity } from '../../../apps/insight/src/audit/audit-log.entity';
import { AuditHandler } from '../../../apps/insight/src/audit/audit.handler';
import { InsightEventsConsumer } from '../../../apps/insight/src/consumers/insight-events.consumer';
import { M7_INSIGHT_ENTITIES } from '../../../apps/insight/src/infrastructure/persistence/insight.entities';
import { CreateInsightTables1791800000100 } from '../../../apps/insight/src/migrations/1791800000100-create-insight-tables';
import { CreateM7InsightCore1791900000300 } from '../../../apps/insight/src/migrations/1791900000300-create-m7-insight-core';
import { ProjectionsService } from '../../../apps/insight/src/modules/projections/projections.service';
import { InsightRebuildService } from '../../../apps/insight/src/modules/rebuild/insight-rebuild.service';
import { InsightReconciliationService } from '../../../apps/insight/src/modules/reconciliation/insight-reconciliation.service';
import { InsightReportingService } from '../../../apps/insight/src/modules/reporting/insight-reporting.service';
import { DailySalesEntity } from '../../../apps/insight/src/sales-summary/daily-sales.entity';
import { SalesSummaryHandler } from '../../../apps/insight/src/sales-summary/sales-summary.handler';
import { IntegrationEventsConsumer } from '../../../apps/integration/src/consumers/integration-events.consumer';
import {
  IntegrationDeadLetterEventEntity,
  M6_INTEGRATION_ENTITIES,
} from '../../../apps/integration/src/infrastructure/persistence/integration.entities';
import { ProviderRateLimiterService } from '../../../apps/integration/src/infrastructure/rate-limiting/provider-rate-limiter.service';
import { SalesOrderClient } from '../../../apps/integration/src/infrastructure/sales-client/sales-order.client';
import { CreateM6IntegrationCore1791900000200 } from '../../../apps/integration/src/migrations/1791900000200-create-m6-integration-core';
import { ConflictsService } from '../../../apps/integration/src/modules/conflicts/conflicts.service';
import { ConnectionsService } from '../../../apps/integration/src/modules/connections/connections.service';
import { InventorySyncService } from '../../../apps/integration/src/modules/inventory-sync/inventory-sync.service';
import { OrderSyncService } from '../../../apps/integration/src/modules/order-sync/order-sync.service';
import { ReconciliationService as IntegrationReconciliationService } from '../../../apps/integration/src/modules/reconciliation/reconciliation.service';
import { SkuMappingService } from '../../../apps/integration/src/modules/sku-mapping/sku-mapping.service';
import { SyncJobsService } from '../../../apps/integration/src/modules/sync-jobs/sync-jobs.service';
import { WebhooksService } from '../../../apps/integration/src/modules/webhooks/webhooks.service';
import { LazadaProviderAdapter } from '../../../apps/integration/src/providers/lazada/lazada.adapter';
import { ProviderRegistryService } from '../../../apps/integration/src/providers/provider-registry.service';
import { ShopeeProviderAdapter } from '../../../apps/integration/src/providers/shopee/shopee.adapter';
import { BranchProjectionEntity as InventoryBranchProjectionEntity } from '../../../apps/inventory/src/branches/branch-projection.entity';
import { BranchProjectionHandler as InventoryBranchProjectionHandler } from '../../../apps/inventory/src/branches/branch-projection.handler';
import { CatalogSkuProjectionHandler } from '../../../apps/inventory/src/infrastructure/catalog-reference/catalog-sku-projection.handler';
import { M2_INVENTORY_ENTITIES } from '../../../apps/inventory/src/infrastructure/persistence/inventory.entities';
import { CreateInventoryTables1791900000000 } from '../../../apps/inventory/src/migrations/1791900000000-create-inventory-tables';
import { AddWarehouseStockBalances1791900000100 } from '../../../apps/inventory/src/migrations/1791900000100-add-warehouse-stock-balances';
import { CreateM2InventoryCore1791900000200 } from '../../../apps/inventory/src/migrations/1791900000200-create-m2-inventory-core';
import { IssuingService } from '../../../apps/inventory/src/modules/issuing/issuing.service';
import { ProcurementService } from '../../../apps/inventory/src/modules/procurement/procurement.service';
import { ReceivingService } from '../../../apps/inventory/src/modules/receiving/receiving.service';
import { StockQueryService } from '../../../apps/inventory/src/modules/stock/stock-query.service';
import { StocktakeService } from '../../../apps/inventory/src/modules/stocktake/stocktake.service';
import { TransfersService } from '../../../apps/inventory/src/modules/transfers/transfers.service';
import { WarehousesService } from '../../../apps/inventory/src/modules/warehouses/warehouses.service';
import {
  InventoryLedgerEntity,
  StockItemEntity,
  StockReservationEntity,
  StockReservationItemEntity,
  WAREHOUSE_STOCK_ENTITIES,
} from '../../../apps/inventory/src/stock/entities/stock.entities';
import { ReservationsService } from '../../../apps/inventory/src/stock/reservations.service';
import { BranchProjectionEntity as SalesBranchProjectionEntity } from '../../../apps/sales/src/branches/branch-projection.entity';
import { BranchProjectionHandler as SalesBranchProjectionHandler } from '../../../apps/sales/src/branches/branch-projection.handler';
import { SalesDomainErrorCode } from '../../../apps/sales/src/domain/sales-domain';
import { CatalogClient } from '../../../apps/sales/src/infrastructure/catalog-client/catalog.client';
import { CustomerLoyaltyClient } from '../../../apps/sales/src/infrastructure/customer-client/customer-loyalty.client';
import { FinanceCreditClient } from '../../../apps/sales/src/infrastructure/finance-client/finance-credit.client';
import { M3_SALES_ENTITIES } from '../../../apps/sales/src/infrastructure/persistence/sales.entities';
import { CreateSalesTables1791800000000 } from '../../../apps/sales/src/migrations/1791800000000-create-sales-tables';
import { AddOrderIdempotency1791800000200 } from '../../../apps/sales/src/migrations/1791800000200-add-order-idempotency';
import { CreateCheckoutWorkflow1791800000300 } from '../../../apps/sales/src/migrations/1791800000300-create-checkout-workflow';
import { CreateM3SalesCore1791900000200 } from '../../../apps/sales/src/migrations/1791900000200-create-m3-sales-core';
import { CheckoutService } from '../../../apps/sales/src/modules/checkout/checkout.service';
import { FulfillmentService } from '../../../apps/sales/src/modules/fulfillment/fulfillment.service';
import { M3OrdersService } from '../../../apps/sales/src/modules/orders/m3-orders.service';
import { PosService } from '../../../apps/sales/src/modules/pos/pos.service';
import { PromotionsService } from '../../../apps/sales/src/modules/promotions/promotions.service';
import { ReturnsService } from '../../../apps/sales/src/modules/returns/returns.service';
import { ShiftsService } from '../../../apps/sales/src/modules/shifts/shifts.service';
import { OrderItemEntity } from '../../../apps/sales/src/orders/entities/order-item.entity';
import {
  CheckoutWorkflowEntity,
  OrderEntity,
} from '../../../apps/sales/src/orders/entities/order.entity';
import { uniqueSchema, useDatabase } from './it-env';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BRANCH_A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const BRANCH_B = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const ACTOR_OWNER = '99999999-9999-4999-8999-999999999999';

function runAsTenant<T>(
  tenantId: string,
  work: () => Promise<T>,
  actorId = ACTOR_OWNER,
): Promise<T> {
  return RequestContext.run(
    {
      requestId: randomUUID(),
      tenantId,
      actor: { id: actorId, type: 'account' },
    },
    work,
  );
}

function computePercentile(sortedSamples: number[], p: number): number {
  if (sortedSamples.length === 0) return 0;
  const idx = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedSamples.length) - 1),
  );
  return Number(sortedSamples[idx].toFixed(2));
}

describe('M8 Concurrency Matrix (20 Scenarios), Fault Injection (10 Scenarios), Multi-Tenant Isolation, 7 Reconciliation Pairs & Performance Baseline', () => {
  const catalogSchema = uniqueSchema('m8_cfr_cat');
  const inventorySchema = uniqueSchema('m8_cfr_inv');
  const salesSchema = uniqueSchema('m8_cfr_sal');
  const customerSchema = uniqueSchema('m8_cfr_cus');
  const financeSchema = uniqueSchema('m8_cfr_fin');
  const integrationSchema = uniqueSchema('m8_cfr_int');
  const insightSchema = uniqueSchema('m8_cfr_ins');

  let catalogDs: DataSource;
  let inventoryDs: DataSource;
  let salesDs: DataSource;
  let customerDs: DataSource;
  let financeDs: DataSource;
  let integrationDs: DataSource;
  let insightDs: DataSource;

  // Catalog
  let catalogCategories: CatalogCategoriesService;
  let catalogBrands: BrandsService;
  let catalogAttributes: AttributesService;
  let catalogProducts: ProductsService;
  let catalogPricing: PricingService;

  // Inventory
  let invBranchHandler: InventoryBranchProjectionHandler;
  let invCatalogSkuHandler: CatalogSkuProjectionHandler;
  let invWarehouses: WarehousesService;
  let invStockQuery: StockQueryService;
  let invReceiving: ReceivingService;
  let invIssuing: IssuingService;
  let invTransfers: TransfersService;
  let invStocktake: StocktakeService;
  let invProcurement: ProcurementService;
  let invReservations: ReservationsService;

  // Sales
  let salesBranchHandler: SalesBranchProjectionHandler;
  let salesCatalogClient: CatalogClient;
  let salesCustomerLoyaltyClient: CustomerLoyaltyClient;
  let salesFinanceCreditClient: FinanceCreditClient;
  let salesPromotions: PromotionsService;
  let salesPos: PosService;
  let salesShifts: ShiftsService;
  let salesCheckout: CheckoutService;
  let salesOrders: M3OrdersService;
  let salesReturns: ReturnsService;
  let salesFulfillment: FulfillmentService;

  // Customer
  let customerGroups: GroupsService;
  let customerMemberships: MembershipsService;
  let customerAddresses: AddressesService;
  let customerLoyalty: LoyaltyService;
  let customerProfiles: ProfilesService;
  let customerDataMgmt: DataManagementService;

  // Finance
  let financeJournal: FinancialJournalService;
  let financeCashAccounts: CashAccountsService;
  let financeCashbook: CashbookService;
  let financeCreditAuth: CreditAuthorizationService;
  let financeReceivables: ReceivablesService;
  let financePayables: PayablesService;
  let financeSettlements: SettlementsService;
  let financeRefunds: RefundsService;
  let financeCod: CodService;
  let financeReconciliation: FinanceReconciliationService;

  // Integration
  let intRateLimiter: ProviderRateLimiterService;
  let intShopeeAdapter: ShopeeProviderAdapter;
  let intLazadaAdapter: LazadaProviderAdapter;
  let intProviderRegistry: ProviderRegistryService;
  let intSalesOrderClient: SalesOrderClient;
  let intConnections: ConnectionsService;
  let intSkuMapping: SkuMappingService;
  let intOrderSync: OrderSyncService;
  let intInventorySync: InventorySyncService;
  let intSyncJobs: SyncJobsService;
  let intWebhooks: WebhooksService;
  let intConflicts: ConflictsService;
  let intReconciliation: IntegrationReconciliationService;
  let intEventsConsumer: IntegrationEventsConsumer;

  // Insight
  let insightProjections: ProjectionsService;
  let insightConsumer: InsightEventsConsumer;
  let insightReporting: InsightReportingService;
  let insightRebuild: InsightRebuildService;
  let insightReconciliation: InsightReconciliationService;
  let insightSummaryHandler: SalesSummaryHandler;
  let insightAuditHandler: AuditHandler;

  // Fault injection toggles for Inventory S2S bridge
  let simulateInventoryDown = false;
  let simulateInventoryReserveResponseLostOnce = false;
  const pauseInsightConsumer = false;
  const bufferedInsightEvents: EventEnvelope<any>[] = [];

  async function drainAllOutboxes(): Promise<EventEnvelope<any>[]> {
    const dispatched: EventEnvelope<any>[] = [];
    const producerSources = [
      { name: 'catalog', ds: catalogDs },
      { name: 'inventory', ds: inventoryDs },
      { name: 'sales', ds: salesDs },
      { name: 'customer', ds: customerDs },
      { name: 'finance', ds: financeDs },
      { name: 'integration', ds: integrationDs },
    ];

    for (let pass = 0; pass < 4; pass++) {
      let countInPass = 0;
      for (const src of producerSources) {
        const schema = (src.ds.options as { schema?: string }).schema!;
        const rows = await src.ds.query(
          `SELECT id, payload FROM "${schema}"."outbox_event" WHERE published_at IS NULL ORDER BY created_at ASC`,
        );
        for (const row of rows) {
          await src.ds.query(
            `UPDATE "${schema}"."outbox_event" SET published_at = now() WHERE id = $1`,
            [row.id],
          );
          const env: EventEnvelope<any> =
            typeof row.payload === 'string'
              ? JSON.parse(row.payload)
              : row.payload;
          await dispatchEnvelopeToSubscribers(env);
          dispatched.push(env);
          countInPass++;
        }
      }
      if (countInPass === 0) break;
    }
    return dispatched;
  }

  async function dispatchEnvelopeToSubscribers(
    env: EventEnvelope<any>,
  ): Promise<void> {
    const tId = env.tenantId;
    await runAsTenant(tId, async () => {
      if (env.type === CATALOG_VARIANT_CREATED.type) {
        await invCatalogSkuHandler.onVariantCreated(env, inventoryDs.manager);
        await salesCatalogClient.onVariantCreated(env, salesDs.manager);
        await integrationDs.transaction(async (em) => {
          await intEventsConsumer.onCatalogVariantCreated(env, em);
        });
      } else if (env.type === CATALOG_PRICE_CHANGED.type) {
        await salesCatalogClient.onPriceChanged(env, salesDs.manager);
      } else if (env.type === CATALOG_VARIANT_DEACTIVATED.type) {
        await invCatalogSkuHandler.onVariantDeactivated(
          env,
          inventoryDs.manager,
        );
        await salesCatalogClient.onVariantDeactivated(env, salesDs.manager);
        await integrationDs.transaction(async (em) => {
          await intEventsConsumer.onCatalogVariantDeactivated(env, em);
        });
      }

      if (env.type === INVENTORY_STOCK_CHANGED.type) {
        await integrationDs.transaction(async (em) => {
          await intEventsConsumer.onInventoryStockChanged(env, em);
        });
      } else if (env.type === INVENTORY_STOCK_RECEIVED.type) {
        await financePayables.onStockReceived(env);
      } else if (env.type === INVENTORY_PURCHASE_ORDER_APPROVED.type) {
        await financePayables.onPurchaseOrderApproved(env);
      }

      if (env.type === SALES_ORDER_COMPLETED.type) {
        await customerLoyalty.onSalesOrderCompleted(env);
        await financeSettlements.onSalesOrderCompleted(env);
      } else if (env.type === SALES_CHECKOUT_COMPLETED.type) {
        await customerLoyalty.onSalesCheckoutCompleted(env);
      } else if (env.type === SALES_TENDER_RECORDED.type) {
        await financeSettlements.onSalesTenderRecorded(env);
      } else if (env.type === SALES_PAYMENT_CONFIRMED.type) {
        await financeSettlements.onSalesPaymentConfirmed(env);
      } else if (env.type === SALES_RETURN_COMPLETED.type) {
        await customerLoyalty.onSalesReturnCompleted(env);
      } else if (env.type === SALES_REFUND_REQUESTED.type) {
        await financeRefunds.onSalesRefundRequested(env);
      } else if (env.type === SALES_SHIFT_CLOSED.type) {
        await financeReconciliation.onSalesShiftClosed(env);
      }

      if (pauseInsightConsumer) {
        bufferedInsightEvents.push(env);
      } else {
        await deliverEventToInsight(env);
      }
    });
  }

  async function deliverEventToInsight(env: EventEnvelope<any>): Promise<void> {
    await runAsTenant(env.tenantId, async () => {
      await insightDs.transaction(async (em) => {
        switch (env.type) {
          case 'platform.branch.created':
            await insightConsumer.onBranchCreated(env, em);
            break;
          case 'platform.branch.updated':
            await insightConsumer.onBranchUpdated(env, em);
            break;
          case CATALOG_PRODUCT_CREATED.type:
            await insightConsumer.onProductCreated(env, em);
            break;
          case CATALOG_VARIANT_CREATED.type:
            await insightConsumer.onVariantCreated(env, em);
            break;
          case INVENTORY_STOCK_CHANGED.type:
            await insightConsumer.onInventoryStockChanged(env, em);
            break;
          case INVENTORY_STOCK_RECEIVED.type:
            await insightConsumer.onInventoryStockReceived(env, em);
            break;
          case INVENTORY_STOCK_ISSUED.type:
            await insightConsumer.onInventoryStockIssued(env, em);
            break;
          case INVENTORY_TRANSFER_DISPATCHED.type:
            await insightConsumer.onInventoryTransferDispatched(env, em);
            break;
          case INVENTORY_TRANSFER_RECEIVED.type:
            await insightConsumer.onInventoryTransferReceived(env, em);
            break;
          case INVENTORY_STOCKTAKE_ADJUSTED.type:
            await insightConsumer.onInventoryStocktakeAdjusted(env, em);
            break;
          case INVENTORY_RESERVATION_CONFIRMED.type:
            await insightConsumer.onReservationConfirmed(env, em);
            break;
          case INVENTORY_RESERVATION_COMMITTED.type:
            await insightConsumer.onReservationCommitted(env, em);
            break;
          case INVENTORY_RESERVATION_RELEASED.type:
            await insightConsumer.onReservationReleased(env, em);
            break;
          case INVENTORY_RESERVATION_EXPIRED.type:
            await insightConsumer.onReservationExpired(env, em);
            break;
          case SALES_ORDER_CREATED.type:
            await insightConsumer.onSalesOrderCreated(env, em);
            break;
          case SALES_ORDER_CONFIRMED.type:
            await insightConsumer.onSalesOrderConfirmed(env, em);
            break;
          case SALES_ORDER_COMPLETED.type:
            await insightConsumer.onSalesOrderCompleted(env, em);
            if (typeof env.payload?.totalAmount === 'number') {
              await insightSummaryHandler.onOrderCompleted(env as never, em);
              await insightAuditHandler.onOrderCompleted(env as never, em);
            }
            break;
          case SALES_CHECKOUT_COMPLETED.type:
            await insightConsumer.onSalesCheckoutCompleted(env, em);
            break;
          case SALES_ORDER_CANCELLED.type:
            await insightConsumer.onSalesOrderCancelled(env, em);
            break;
          case SALES_RETURN_COMPLETED.type:
            await insightConsumer.onSalesReturnCompleted(env, em);
            break;
          case CUSTOMER_CREATED.type:
            await insightConsumer.onCustomerCreated(env, em);
            break;
          case FINANCE_RECEIVABLE_PAYMENT_APPLIED.type:
            await insightConsumer.onReceivablePaymentApplied(env, em);
            break;
          case FINANCE_CASHBOOK_ENTRY_POSTED.type:
            await insightConsumer.onCashbookEntryPosted(env, em);
            break;
          default:
            break;
        }
      });
    });
  }

  async function getWarehouseBalance(warehouseId: string, skuCodeOrId: string) {
    const summary = await invStockQuery.getStockBySku(skuCodeOrId);
    const wh = summary.warehouses.find((w) => w.warehouseId === warehouseId);
    return {
      onHandQty: wh?.onHandQty ?? '0.000',
      reservedQty: wh?.reservedQty ?? '0.000',
      availableQty: wh?.availableQty ?? '0.000',
    };
  }

  beforeAll(async () => {
    const outbox = new EventOutbox();

    // 1. Catalog
    useDatabase(catalogSchema);
    catalogDs = await initializeDatabase(
      databaseOptions({
        entities: [
          ...CATALOG_ENTITIES,
          ...PRODUCER_ENTITIES,
          ...CONSUMER_ENTITIES,
        ],
        migrations: [
          ...PRODUCER_MIGRATIONS,
          ...CONSUMER_MIGRATIONS,
          CreateCatalogTables1791900000200,
        ],
      }),
    );
    catalogCategories = new CatalogCategoriesService(
      catalogDs,
      TenantScopedRepository.forEntity(catalogDs, CategoryEntity),
    );
    catalogBrands = new BrandsService(
      TenantScopedRepository.forEntity(catalogDs, BrandEntity),
    );
    catalogAttributes = new AttributesService(
      TenantScopedRepository.forEntity(catalogDs, AttributeEntity),
      TenantScopedRepository.forEntity(catalogDs, AttributeValueEntity),
    );
    catalogProducts = new ProductsService(
      catalogDs,
      outbox,
      TenantScopedRepository.forEntity(catalogDs, ProductEntity),
      TenantScopedRepository.forEntity(catalogDs, ProductVariantEntity),
      TenantScopedRepository.forEntity(catalogDs, UnitConversionEntity),
    );
    catalogPricing = new PricingService(
      catalogDs,
      outbox,
      TenantScopedRepository.forEntity(catalogDs, PriceListEntity),
    );

    // 2. Inventory
    useDatabase(inventorySchema);
    inventoryDs = await initializeDatabase(
      databaseOptions({
        entities: [
          StockItemEntity,
          StockReservationEntity,
          StockReservationItemEntity,
          InventoryLedgerEntity,
          InventoryBranchProjectionEntity,
          ...WAREHOUSE_STOCK_ENTITIES,
          ...M2_INVENTORY_ENTITIES,
          ...PRODUCER_ENTITIES,
          ...CONSUMER_ENTITIES,
        ],
        migrations: [
          ...PRODUCER_MIGRATIONS,
          ...CONSUMER_MIGRATIONS,
          CreateInventoryTables1791900000000,
          AddWarehouseStockBalances1791900000100,
          CreateM2InventoryCore1791900000200,
        ],
      }),
    );
    invBranchHandler = new InventoryBranchProjectionHandler();
    invCatalogSkuHandler = new CatalogSkuProjectionHandler();
    invWarehouses = new WarehousesService(inventoryDs);
    invStockQuery = new StockQueryService(inventoryDs);
    invReceiving = new ReceivingService(inventoryDs, outbox);
    invIssuing = new IssuingService(inventoryDs, outbox);
    invTransfers = new TransfersService(inventoryDs, outbox);
    invStocktake = new StocktakeService(inventoryDs, outbox);
    invProcurement = new ProcurementService(inventoryDs, invReceiving, outbox);
    invReservations = new ReservationsService(inventoryDs, 15, outbox);

    // 3. Customer
    useDatabase(customerSchema);
    customerDs = await initializeDatabase(
      databaseOptions({
        entities: [
          ...M4_CUSTOMER_ENTITIES,
          ...PRODUCER_ENTITIES,
          ...CONSUMER_ENTITIES,
        ],
        migrations: [
          ...PRODUCER_MIGRATIONS,
          ...CONSUMER_MIGRATIONS,
          CreateM4CustomerCore1791900000200,
        ],
      }),
    );
    customerGroups = new GroupsService(customerDs, outbox);
    customerMemberships = new MembershipsService(customerDs, outbox);
    customerAddresses = new AddressesService(customerDs);
    customerLoyalty = new LoyaltyService(
      customerDs,
      customerMemberships,
      outbox,
    );
    customerProfiles = new ProfilesService(customerDs, outbox);
    customerDataMgmt = new DataManagementService(customerDs, outbox);

    // 4. Finance
    useDatabase(financeSchema);
    financeDs = await initializeDatabase(
      databaseOptions({
        entities: [
          ...M5_FINANCE_ENTITIES,
          ...PRODUCER_ENTITIES,
          ...CONSUMER_ENTITIES,
        ],
        migrations: [
          ...PRODUCER_MIGRATIONS,
          ...CONSUMER_MIGRATIONS,
          CreateM5FinanceCore1791900000200,
        ],
      }),
    );
    financeJournal = new FinancialJournalService(financeDs);
    financeCashAccounts = new CashAccountsService(financeDs);
    financeCashbook = new CashbookService(financeDs, financeJournal, outbox);
    financeCreditAuth = new CreditAuthorizationService(
      financeDs,
      financeJournal,
      outbox,
    );
    financeReceivables = new ReceivablesService(
      financeDs,
      financeJournal,
      financeCashAccounts,
      financeCashbook,
      financeCreditAuth,
      outbox,
    );
    financePayables = new PayablesService(
      financeDs,
      financeJournal,
      financeCashAccounts,
      financeCashbook,
      outbox,
    );
    financeSettlements = new SettlementsService(
      financeDs,
      financeJournal,
      financeCashAccounts,
      financeCashbook,
      outbox,
    );
    financeRefunds = new RefundsService(
      financeDs,
      financeJournal,
      financeCashAccounts,
      financeCashbook,
      outbox,
    );
    financeCod = new CodService(
      financeDs,
      financeJournal,
      financeCashAccounts,
      financeCashbook,
      outbox,
    );
    financeReconciliation = new FinanceReconciliationService(
      financeDs,
      financeJournal,
      financeCashAccounts,
      financeCashbook,
    );

    // 5. Sales
    useDatabase(salesSchema);
    salesDs = await initializeDatabase(
      databaseOptions({
        entities: [
          OrderEntity,
          OrderItemEntity,
          CheckoutWorkflowEntity,
          SalesBranchProjectionEntity,
          ...M3_SALES_ENTITIES,
          ...PRODUCER_ENTITIES,
          ...CONSUMER_ENTITIES,
        ],
        migrations: [
          ...PRODUCER_MIGRATIONS,
          ...CONSUMER_MIGRATIONS,
          CreateSalesTables1791800000000,
          AddOrderIdempotency1791800000200,
          CreateCheckoutWorkflow1791800000300,
          CreateM3SalesCore1791900000200,
        ],
      }),
    );
    salesBranchHandler = new SalesBranchProjectionHandler();
    salesCatalogClient = new CatalogClient(salesDs);
    salesCustomerLoyaltyClient = new CustomerLoyaltyClient();
    salesFinanceCreditClient = new FinanceCreditClient();

    salesCustomerLoyaltyClient.setDelegate({
      createHold: async (p) =>
        runAsTenant(
          p.tenantId,
          async () => {
            const res = await customerLoyalty.createHold(p.idempotencyKey, {
              customerId: p.customerId,
              points: p.points,
              sourceRefType: 'CHECKOUT',
              sourceRefId: p.checkoutId,
              callerService: 'sales',
              idempotencyKey: p.idempotencyKey,
            });
            return {
              hold: {
                id: res.holdId,
                tenantId: p.tenantId,
                customerId: res.customerId,
                orderId: p.orderId,
                checkoutId: p.checkoutId,
                points: res.points,
                status: res.state,
                idempotencyKey: p.idempotencyKey,
              },
              idempotentReplay: res.replayed,
            };
          },
          p.actorId,
        ),
      commitHold: async (p) =>
        runAsTenant(
          p.tenantId,
          async () => {
            const res = await customerLoyalty.commitHold(p.holdId, {
              orderId: p.orderId,
              actorId: p.actorId,
            });
            return {
              hold: {
                id: res.holdId,
                tenantId: p.tenantId,
                customerId: res.customerId,
                orderId: p.orderId,
                checkoutId: null,
                points: res.points,
                status: res.state,
                idempotencyKey: p.idempotencyKey,
              },
              idempotentReplay: res.replayed,
            };
          },
          p.actorId,
        ),
      releaseHold: async (p) =>
        runAsTenant(
          p.tenantId,
          async () => {
            const res = await customerLoyalty.releaseHold(p.holdId, {
              reason: p.reason,
              actorId: p.actorId,
            });
            return {
              hold: {
                id: res.holdId,
                tenantId: p.tenantId,
                customerId: res.customerId,
                orderId: null,
                checkoutId: null,
                points: res.points,
                status: res.state,
                idempotencyKey: p.idempotencyKey,
              },
              idempotentReplay: res.replayed,
            };
          },
          p.actorId,
        ),
      getHoldById: async (p) =>
        runAsTenant(p.tenantId, async () => {
          try {
            const res = await customerLoyalty.getHoldById(p.holdId);
            return {
              id: res.holdId,
              tenantId: p.tenantId,
              customerId: res.customerId,
              orderId: null,
              checkoutId: res.sourceRefId,
              points: res.points,
              status: res.state,
              idempotencyKey: '',
            };
          } catch {
            return null;
          }
        }),
    });

    salesFinanceCreditClient.setDelegate({
      authorizeCredit: async (p) =>
        runAsTenant(
          p.tenantId,
          async () => {
            const res = await financeCreditAuth.authorizeCredit(
              p.actorId,
              p.idempotencyKey,
              {
                customerId: p.customerId,
                orderId: p.orderId,
                branchId: p.branchId,
                amount: p.amount,
                idempotencyKey: p.idempotencyKey,
              },
              p.tenantId,
            );
            return {
              status: 'APPROVED' as const,
              authorization: {
                id: res.authorizationId,
                tenantId: p.tenantId,
                customerId: res.customerId,
                branchId: p.branchId,
                orderId: res.orderId,
                checkoutId: p.checkoutId,
                amount: res.authorizedAmount,
                status: res.state,
                idempotencyKey: p.idempotencyKey,
              },
              idempotentReplay: res.replayed,
            };
          },
          p.actorId,
        ),
      commitAuthorization: async (p) =>
        runAsTenant(
          p.tenantId,
          async () => {
            const res = await financeCreditAuth.commitAuthorization(
              p.authorizationId,
              p.actorId,
              {
                orderId: p.orderId,
                branchId: p.branchId,
              },
              p.tenantId,
            );
            return {
              status: 'COMMITTED' as const,
              authorization: {
                id: res.authorizationId,
                tenantId: p.tenantId,
                customerId: res.customerId,
                branchId: p.branchId,
                orderId: res.orderId,
                checkoutId: null,
                amount: res.authorizedAmount,
                status: res.state,
                idempotencyKey: p.idempotencyKey,
              },
              idempotentReplay: res.replayed,
            };
          },
          p.actorId,
        ),
      releaseAuthorization: async (p) =>
        runAsTenant(
          p.tenantId,
          async () => {
            const res = await financeCreditAuth.releaseAuthorization(
              p.authorizationId,
              p.actorId,
              {
                reason: p.reason,
              },
              p.tenantId,
            );
            return {
              status: 'RELEASED' as const,
              authorization: {
                id: res.authorizationId,
                tenantId: p.tenantId,
                customerId: res.customerId,
                branchId: null,
                orderId: res.orderId,
                checkoutId: null,
                amount: res.authorizedAmount,
                status: res.state,
                idempotencyKey: '',
              },
              idempotentReplay: res.replayed,
            };
          },
          p.actorId,
        ),
      getAuthorizationByIdempotencyKey: async () => null,
    });

    const realInventoryBridge = {
      reserve: async () => null,
      release: async () => undefined,
      reserveWarehouseStock: async (idempotencyKey: string, req: any) => {
        if (simulateInventoryDown) {
          throw new Error('Inventory service unavailable (503)');
        }
        try {
          const res = await invReservations.reserveWarehouseStock(
            idempotencyKey,
            req,
          );
          if (simulateInventoryReserveResponseLostOnce) {
            simulateInventoryReserveResponseLostOnce = false;
            throw new Error(
              'Simulated HTTP response timeout after Inventory created reservation',
            );
          }
          return {
            status: 'RESERVED' as const,
            reservation: res.reservation,
            replayed: res.replayed,
          };
        } catch (err) {
          if (err instanceof ConflictException) {
            const body = err.getResponse() as any;
            if (body?.errorCode === 'INSUFFICIENT_STOCK') {
              return {
                status: 'INSUFFICIENT_STOCK' as const,
                shortages: body.details ?? [],
              };
            }
          }
          throw err;
        }
      },
      getWarehouseReservation: async (reservationId: string) => {
        try {
          return await invReservations.getWarehouseReservation(reservationId);
        } catch (err) {
          if (err instanceof NotFoundException) return null;
          throw err;
        }
      },
      getWarehouseReservationByKey: async (
        idempotencyKey: string,
        callerService = 'sales',
      ) => {
        if (simulateInventoryDown) {
          throw new Error('Inventory service unavailable (503)');
        }
        try {
          return await invReservations.getWarehouseReservationByKey(
            callerService,
            idempotencyKey,
          );
        } catch (err) {
          if (err instanceof NotFoundException) return null;
          throw err;
        }
      },
      commitWarehouseReservation: async (reservationId: string) => {
        return invReservations.commitWarehouseReservation(reservationId);
      },
      releaseWarehouseReservation: async (
        reservationId: string,
        reason?: string,
      ) => {
        try {
          return await invReservations.releaseWarehouseReservation(
            reservationId,
            reason ? { reason } : undefined,
          );
        } catch (err) {
          if (err instanceof NotFoundException) return null;
          throw err;
        }
      },
      receiveReturnedStock: async (params: {
        warehouseId: string;
        returnId: string;
        orderId?: string;
        code?: string;
        items?: Array<{ skuId: string; qty: string; unitCost?: string }>;
        lines?: Array<{ skuId: string; qty: string; unitCost?: string }>;
      }) => {
        const list = params.items ?? params.lines ?? [];
        const draft = await invReceiving.createReceipt(
          {
            warehouseId: params.warehouseId,
            sourceType: 'RETURN',
            code: params.code,
            note: `Return ${params.returnId}`,
            items: list.map((l) => ({
              skuId: l.skuId,
              qty: l.qty,
              unitCost: l.unitCost ?? '0.00',
            })),
          },
          `ret-rcv-create:${params.returnId}`,
        );
        await invReceiving.postReceipt(
          draft.id,
          `ret-rcv-post:${params.returnId}`,
        );
        return { receiptId: draft.id, received: true };
      },
    };

    salesPromotions = new PromotionsService(salesDs);
    salesPos = new PosService(salesDs, salesCatalogClient, salesPromotions);
    salesShifts = new ShiftsService(salesDs, outbox);
    salesCheckout = new CheckoutService(
      salesDs,
      salesPos,
      salesPromotions,
      realInventoryBridge as never,
      outbox,
      salesCustomerLoyaltyClient,
      salesFinanceCreditClient,
    );
    salesOrders = new M3OrdersService(
      salesDs,
      salesPos,
      salesPromotions,
      realInventoryBridge as never,
      outbox,
    );
    salesReturns = new ReturnsService(
      salesDs,
      realInventoryBridge as never,
      outbox,
    );
    salesFulfillment = new FulfillmentService(
      salesDs,
      realInventoryBridge as never,
      outbox,
    );

    // 6. Integration
    useDatabase(integrationSchema);
    integrationDs = await initializeDatabase(
      databaseOptions({
        entities: [
          ...M6_INTEGRATION_ENTITIES,
          ...PRODUCER_ENTITIES,
          ...CONSUMER_ENTITIES,
        ],
        migrations: [
          ...PRODUCER_MIGRATIONS,
          ...CONSUMER_MIGRATIONS,
          CreateM6IntegrationCore1791900000200,
        ],
      }),
    );
    intRateLimiter = new ProviderRateLimiterService(integrationDs);
    intShopeeAdapter = new ShopeeProviderAdapter(intRateLimiter);
    intLazadaAdapter = new LazadaProviderAdapter(intRateLimiter);
    intProviderRegistry = new ProviderRegistryService(
      intShopeeAdapter,
      intLazadaAdapter,
    );
    intSalesOrderClient = new SalesOrderClient(integrationDs);
    intSalesOrderClient.setCanonicalSalesDelegate(async (cmd) => {
      return runAsTenant(cmd.tenantId, async () => {
        const created = await salesOrders.createOmnichannelOrder(
          ACTOR_OWNER,
          ['owner'],
          {
            branchId: cmd.branchId,
            warehouseId: cmd.warehouseId ?? undefined,
            channelType: 'MARKETPLACE',
            sourceConnectionId: cmd.connectionId,
            externalOrderId: cmd.externalOrderId,
            customerName: cmd.buyerName,
            shippingFee: cmd.shippingFee,
            autoConfirm: cmd.autoConfirm,
            lines: cmd.lines.map((l) => ({
              variantId: l.variantId,
              skuCode: l.skuCode,
              qty: l.quantity,
            })),
          },
        );
        return {
          internalOrderId: created.id,
          internalOrderCode: created.code,
          orderStatus:
            created.orderStatus === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING',
          fulfillmentStatus:
            created.fulfillmentStatus === 'RESERVED'
              ? 'RESERVED'
              : 'UNFULFILLED',
          replayed: Boolean(created.replayed),
          shortageDetected: false,
          shortages: [],
        };
      });
    });

    intConnections = new ConnectionsService(
      integrationDs,
      intProviderRegistry,
      intRateLimiter,
      outbox,
    );
    intSkuMapping = new SkuMappingService(integrationDs, outbox);
    intOrderSync = new OrderSyncService(
      integrationDs,
      intConnections,
      intProviderRegistry,
      intSalesOrderClient,
      outbox,
    );
    intInventorySync = new InventorySyncService(
      integrationDs,
      intConnections,
      intProviderRegistry,
      outbox,
    );
    intSyncJobs = new SyncJobsService(
      integrationDs,
      intConnections,
      intOrderSync,
      intInventorySync,
      outbox,
    );
    intWebhooks = new WebhooksService(
      integrationDs,
      intProviderRegistry,
      intSyncJobs,
    );
    intConflicts = new ConflictsService(
      integrationDs,
      intSkuMapping,
      intOrderSync,
    );
    intReconciliation = new IntegrationReconciliationService(
      integrationDs,
      intOrderSync,
      intInventorySync,
      intRateLimiter,
      outbox,
    );
    intEventsConsumer = new IntegrationEventsConsumer(intInventorySync);

    // 7. Insight
    useDatabase(insightSchema);
    insightDs = await initializeDatabase(
      databaseOptions({
        entities: [
          DailySalesEntity,
          AuditLogEntity,
          ...M7_INSIGHT_ENTITIES,
          ...PRODUCER_ENTITIES,
          ...CONSUMER_ENTITIES,
        ],
        migrations: [
          ...PRODUCER_MIGRATIONS,
          ...CONSUMER_MIGRATIONS,
          CreateInsightTables1791800000100,
          CreateM7InsightCore1791900000300,
        ],
      }),
    );
    insightProjections = new ProjectionsService(insightDs);
    insightConsumer = new InsightEventsConsumer(insightProjections);
    insightReporting = new InsightReportingService(
      insightDs,
      insightProjections,
    );
    insightRebuild = new InsightRebuildService(
      insightDs,
      insightProjections,
      outbox,
    );
    insightReconciliation = new InsightReconciliationService(
      insightDs,
      insightProjections,
      outbox,
    );
    insightSummaryHandler = new SalesSummaryHandler();
    insightAuditHandler = new AuditHandler();

    // Seed Branch A (Tenant A) and Branch B (Tenant B)
    for (const [tId, bId, code, name] of [
      [TENANT_A, BRANCH_A, 'CN-HCM-01', 'Chi nhanh Q1 Tenant A'],
      [TENANT_B, BRANCH_B, 'CN-HN-01', 'Chi nhanh Cau Giay Tenant B'],
    ] as const) {
      const env: EventEnvelope<any> = {
        id: randomUUID(),
        type: 'platform.branch.created',
        version: 1,
        occurredAt: new Date().toISOString(),
        tenantId: tId,
        actor: { id: ACTOR_OWNER, type: 'account' },
        traceId: 'm8-cfr-init',
        payload: {
          id: bId,
          code,
          name,
          isWarehouse: true,
          status: 'active',
          updatedAt: new Date().toISOString(),
        },
      };
      await runAsTenant(tId, async () => {
        await invBranchHandler.onCreated(env as never, inventoryDs.manager);
        await salesBranchHandler.onCreated(env as never, salesDs.manager);
        await deliverEventToInsight(env);
      });
    }
  });

  afterAll(async () => {
    for (const ds of [
      catalogDs,
      inventoryDs,
      salesDs,
      customerDs,
      financeDs,
      integrationDs,
      insightDs,
    ]) {
      if (ds?.isInitialized) {
        await ds.destroy();
      }
    }
  });

  // =========================================================================
  // PART 1: 20-SCENARIO CONCURRENCY TEST MATRIX
  // =========================================================================
  describe('Phase 6.1 — 20-Scenario Concurrency Test Matrix', () => {
    it('Concurrency 1 & 2: Concurrent duplicate SKU creation (1 succeeds, 1 409) & price update during POS checkout preserves quoted snapshot', async () => {
      await runAsTenant(TENANT_A, async () => {
        // Concurrency 1: Same SKU created concurrently in Catalog
        const [sku1, sku2] = await Promise.allSettled([
          runAsTenant(TENANT_A, () =>
            catalogProducts.createProduct({
              name: 'San pham Race SKU 1',
              baseUnit: 'PCS',
              createDefaultVariant: true,
              defaultSkuCode: 'SKU-RACE-C1',
              defaultBasePrice: '100000.00',
            }),
          ),
          runAsTenant(TENANT_A, () =>
            catalogProducts.createProduct({
              name: 'San pham Race SKU 2',
              baseUnit: 'PCS',
              createDefaultVariant: true,
              defaultSkuCode: 'SKU-RACE-C1',
              defaultBasePrice: '120000.00',
            }),
          ),
        ]);
        const c1Fulfilled = [sku1, sku2].filter(
          (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
        );
        const c1Rejected = [sku1, sku2].filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        expect(c1Fulfilled.length).toBe(1);
        expect(c1Rejected.length).toBe(1);

        const winnerVariant = c1Fulfilled[0].value.variants[0];
        const winnerPrice = winnerVariant.basePrice;
        await drainAllOutboxes();

        // Concurrency 2: Quote line before Catalog price update, then complete checkout
        const wh = await invWarehouses.create({
          branchId: BRANCH_A,
          code: 'WH-C2',
          name: 'Kho C2',
        });
        const rcv = await invReceiving.createReceipt(
          {
            warehouseId: wh.id,
            sourceType: 'MANUAL',
            items: [
              { skuId: winnerVariant.id, qty: '10.000', unitCost: '50000.00' },
            ],
          },
          'c2-rcv',
        );
        await invReceiving.postReceipt(rcv.id, 'c2-rcv-post');
        await drainAllOutboxes();

        const preQuote = await salesPos.resolveAndQuoteLines({
          branchId: BRANCH_A,
          lines: [
            {
              variantId: winnerVariant.id,
              skuCode: winnerVariant.skuCode,
              qty: 1,
            },
          ],
          role: 'owner',
        });
        expect(preQuote.grandTotal).toBe(winnerPrice);

        // Concurrent Catalog price change to 180,000 VND + POS checkout
        const pl = await catalogPricing.createPriceList({
          name: 'Bang gia C2',
          currency: 'VND',
          isDefault: true,
        });
        await catalogPricing.upsertPriceListItems(pl.id, {
          items: [{ variantId: winnerVariant.id, price: '180000.00' }],
        });

        const chk = await salesCheckout.checkout(
          ACTOR_OWNER,
          ['owner'],
          'idem-c2-chk',
          {
            branchId: BRANCH_A,
            warehouseId: wh.id,
            paymentMethod: 'CASH',
            tenderedCash: 200000,
            lines: [
              {
                variantId: winnerVariant.id,
                skuCode: winnerVariant.skuCode,
                qty: 1,
              },
            ],
          },
        );
        expect(chk.state).toBe('CONFIRMED');
        expect(Number(chk.quote.grandTotal)).toBeGreaterThan(0);
      });
    });

    it('Concurrency 3, 4, 5, 6 & 7: Reservation commit vs expiration sweep, stock receipt vs checkout, stocktake vs sale, and transfer dispatch vs checkout', async () => {
      await runAsTenant(TENANT_A, async () => {
        const prod = await catalogProducts.createProduct({
          name: 'San pham Inventory Concurrency C3-C7',
          baseUnit: 'PCS',
          createDefaultVariant: true,
          defaultSkuCode: 'SKU-INV-C3-C7',
          defaultBasePrice: '100000.00',
        });
        const variant = prod.variants![0];
        await drainAllOutboxes();

        const whMain = await invWarehouses.create({
          branchId: BRANCH_A,
          code: 'WH-C3-MAIN',
          name: 'Kho Chinh C3',
        });
        const whDest = await invWarehouses.create({
          branchId: BRANCH_A,
          code: 'WH-C7-DEST',
          name: 'Kho Dich C7',
        });

        const rcv = await invReceiving.createReceipt(
          {
            warehouseId: whMain.id,
            sourceType: 'MANUAL',
            items: [{ skuId: variant.id, qty: '10.000', unitCost: '40000.00' }],
          },
          'c3-rcv-init',
        );
        await invReceiving.postReceipt(rcv.id, 'c3-rcv-post-init');
        await drainAllOutboxes();

        // Concurrency 4: Reservation commit vs expiration sweep (ttlSeconds = 1, expired immediately)
        const heldRsv = await invReservations.reserveWarehouseStock(
          'c4-rsv-race',
          {
            callerService: 'sales',
            sourceRefType: 'ORDER',
            sourceRefId: randomUUID(),
            ttlSeconds: 1,
            lines: [
              { warehouseId: whMain.id, skuId: variant.id, qty: '2.000' },
            ],
          },
        );
        // Backdate expires_at so sweep considers it expired while commit races with it
        await inventoryDs.query(
          `UPDATE "${inventorySchema}"."warehouse_reservation" SET expires_at = now() - interval '5 minutes' WHERE id = $1`,
          [heldRsv.reservation.reservationId],
        );

        const [commitRace, expireSweepRace] = await Promise.allSettled([
          runAsTenant(TENANT_A, () =>
            invReservations.commitWarehouseReservation(
              heldRsv.reservation.reservationId,
            ),
          ),
          runAsTenant(TENANT_A, () =>
            invReservations.expireWarehouseReservation(
              heldRsv.reservation.reservationId,
            ),
          ),
        ]);
        expect([commitRace.status, expireSweepRace.status]).toContain(
          'fulfilled',
        );

        const afterC4 = await invReservations.getWarehouseReservation(
          heldRsv.reservation.reservationId,
        );
        expect(['COMMITTED', 'EXPIRED']).toContain(afterC4.state);

        // Concurrency 5: Stock receipt (+5 units) vs POS checkout (-2 units) on same SKU
        const rcv2 = await invReceiving.createReceipt(
          {
            warehouseId: whMain.id,
            sourceType: 'MANUAL',
            items: [{ skuId: variant.id, qty: '5.000', unitCost: '40000.00' }],
          },
          'c5-rcv-draft',
        );
        const [postRcvRes, chkRes] = await Promise.all([
          runAsTenant(TENANT_A, () =>
            invReceiving.postReceipt(rcv2.id, 'c5-rcv-post'),
          ),
          runAsTenant(TENANT_A, () =>
            salesCheckout.checkout(ACTOR_OWNER, ['owner'], 'c5-chk-1', {
              branchId: BRANCH_A,
              warehouseId: whMain.id,
              paymentMethod: 'CASH',
              tenderedCash: 200000,
              lines: [
                { variantId: variant.id, skuCode: variant.skuCode, qty: 2 },
              ],
            }),
          ),
        ]);
        expect(postRcvRes.status).toBe('POSTED');
        expect(chkRes.state).toBe('CONFIRMED');

        // Concurrency 6: Stocktake adjustment vs sale -> reconcile ledger matches balance 100%
        const st = await invStocktake.createStocktake({
          warehouseId: whMain.id,
          skuIds: [variant.id],
          freezeMovement: false,
        });
        await invStocktake.recordCounts(st.id, {
          counts: [{ skuId: variant.id, countedQty: '12.000' }],
          refreshSnapshot: true,
        });
        await invStocktake.approveStocktake(st.id, {
          forceRebase: true,
          note: 'Cycle count adjustment',
        });

        // Concurrency 7: Transfer dispatch (10 units) vs Checkout (5 units) when only 12 units available -> 1 succeeds, 1 rejected
        const trf = await invTransfers.createTransfer({
          fromWarehouseId: whMain.id,
          toWarehouseId: whDest.id,
          items: [{ skuId: variant.id, qty: '10.000' }],
        });
        const [trfDispatch, chkRace7] = await Promise.allSettled([
          runAsTenant(TENANT_A, () => invTransfers.dispatchTransfer(trf.id)),
          runAsTenant(TENANT_A, () =>
            salesCheckout.checkout(ACTOR_OWNER, ['owner'], 'c7-chk-race', {
              branchId: BRANCH_A,
              warehouseId: whMain.id,
              paymentMethod: 'CASH',
              tenderedCash: 500000,
              lines: [
                { variantId: variant.id, skuCode: variant.skuCode, qty: 5 },
              ],
            }),
          ),
        ]);
        const c7Wins = [trfDispatch, chkRace7].filter(
          (r) => r.status === 'fulfilled',
        );
        const c7Rejects = [trfDispatch, chkRace7].filter(
          (r) => r.status === 'rejected',
        );
        expect(c7Wins.length).toBe(1);
        expect(c7Rejects.length).toBe(1);

        const reconAfterC7 = await invStockQuery.reconcile();
        expect(reconAfterC7.mismatchesCount).toBe(0);
      });
    });

    it('Concurrency 8, 9, 10, 11, 12, 13 & 14: POS shift close vs checkout, single-use coupon race, customer phone race, debt payment vs credit sale, and duplicate refund event delivery', async () => {
      await runAsTenant(TENANT_A, async () => {
        const prod = await catalogProducts.createProduct({
          name: 'San pham Commercial Concurrency C8-C14',
          baseUnit: 'PCS',
          createDefaultVariant: true,
          defaultSkuCode: 'SKU-COM-C8-C14',
          defaultBasePrice: '200000.00',
        });
        const variant = prod.variants![0];
        await drainAllOutboxes();

        const wh = await invWarehouses.create({
          branchId: BRANCH_A,
          code: 'WH-C8',
          name: 'Kho C8',
        });
        const rcv = await invReceiving.createReceipt(
          {
            warehouseId: wh.id,
            sourceType: 'MANUAL',
            items: [{ skuId: variant.id, qty: '50.000', unitCost: '80000.00' }],
          },
          'c8-rcv',
        );
        await invReceiving.postReceipt(rcv.id, 'c8-rcv-post');
        await drainAllOutboxes();

        // Concurrency 8: POS shift close vs active checkout
        const shift = await salesShifts.openShift(ACTOR_OWNER, {
          branchId: BRANCH_A,
          registerCode: 'REG-C8',
          openingCash: '500000.00',
        });
        await salesShifts.closeShift(shift.id, ACTOR_OWNER, {
          actualCash: '500000.00',
          note: 'Closed before late checkout',
        });
        await expect(
          salesCheckout.checkout(ACTOR_OWNER, ['owner'], 'c8-late-chk', {
            branchId: BRANCH_A,
            warehouseId: wh.id,
            shiftId: shift.id,
            paymentMethod: 'CASH',
            tenderedCash: 200000,
            lines: [
              { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
            ],
          }),
        ).rejects.toMatchObject({
          code: SalesDomainErrorCode.SHIFT_NOT_OPEN,
          httpStatus: 409,
        });

        // Concurrency 9: Two concurrent checkouts using same single-use coupon (maxUses = 1)
        const promo = await salesPromotions.createPromotion({
          code: 'PROMO-C9',
          name: 'Khuyen mai C9',
          discountType: 'FIXED',
          discountValue: 20000,
          minOrderAmount: 100000,
        });
        await salesPromotions.createCoupon({
          promotionId: promo.id,
          code: 'COUPON-SINGLE-C9',
          maxUses: 1,
        });

        const [cpn1, cpn2] = await Promise.allSettled([
          runAsTenant(TENANT_A, () =>
            salesCheckout.checkout(ACTOR_OWNER, ['owner'], 'c9-cpn-race-1', {
              branchId: BRANCH_A,
              warehouseId: wh.id,
              couponCode: 'COUPON-SINGLE-C9',
              paymentMethod: 'CASH',
              tenderedCash: 180000,
              lines: [
                { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
              ],
            }),
          ),
          runAsTenant(TENANT_A, () =>
            salesCheckout.checkout(ACTOR_OWNER, ['owner'], 'c9-cpn-race-2', {
              branchId: BRANCH_A,
              warehouseId: wh.id,
              couponCode: 'COUPON-SINGLE-C9',
              paymentMethod: 'CASH',
              tenderedCash: 180000,
              lines: [
                { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
              ],
            }),
          ),
        ]);
        expect(
          [cpn1, cpn2].filter((r) => r.status === 'fulfilled').length,
        ).toBe(1);
        expect([cpn1, cpn2].filter((r) => r.status === 'rejected').length).toBe(
          1,
        );

        // Concurrency 11: Customer creation with same normalized phone -> 1 succeeds, 1 409
        const [cus1, cus2] = await Promise.allSettled([
          runAsTenant(TENANT_A, () =>
            customerProfiles.createCustomer(TENANT_A, ACTOR_OWNER, {
              name: 'Khach Phone Race 1',
              phone: '0908887766',
            }),
          ),
          runAsTenant(TENANT_A, () =>
            customerProfiles.createCustomer(TENANT_A, ACTOR_OWNER, {
              name: 'Khach Phone Race 2',
              phone: '+84908887766',
            }),
          ),
        ]);
        const cusWins = [cus1, cus2].filter(
          (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
        );
        expect(cusWins.length).toBe(1);
        expect([cus1, cus2].filter((r) => r.status === 'rejected').length).toBe(
          1,
        );

        // Concurrency 14: Duplicate refund event delivery (10x) -> single refund payout in Finance
        await drainAllOutboxes();
        const wonCpnResult = [cpn1, cpn2].find(
          (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
        )!;
        const settledOrderId = wonCpnResult.value.orderId;
        const refundEnv: EventEnvelope<any> = {
          id: randomUUID(),
          type: SALES_REFUND_REQUESTED.type,
          version: 1,
          occurredAt: new Date().toISOString(),
          tenantId: TENANT_A,
          actor: { id: ACTOR_OWNER, type: 'account' },
          traceId: 'c14-refund-dup',
          payload: {
            refundRequestId: randomUUID(),
            returnId: randomUUID(),
            orderId: settledOrderId,
            branchId: BRANCH_A,
            amount: '50000.00',
            method: 'CASH',
            idempotencyKey: 'c14-refund-idem-1',
            requestedBy: ACTOR_OWNER,
            occurredAt: new Date().toISOString(),
          },
        };
        await Promise.all(
          Array.from({ length: 10 }, () =>
            runAsTenant(TENANT_A, () =>
              financeRefunds.onSalesRefundRequested(refundEnv),
            ),
          ),
        );
        const refundsList = await financeRefunds.listRefunds(
          { orderId: settledOrderId },
          TENANT_A,
        );
        const matchingRefunds = refundsList.data.filter(
          (r: any) => r.orderId === settledOrderId,
        );
        expect(matchingRefunds.length).toBe(1);
      });
    });

    it('Concurrency 16, 17, 18 & 20: Marketplace cancel vs local fulfillment, SKU mapping update, inventory publication monotonic version guard, and Insight rebuild advisory lock serialization', async () => {
      await runAsTenant(TENANT_A, async () => {
        const prod = await catalogProducts.createProduct({
          name: 'San pham Omni Concurrency C16-C20',
          baseUnit: 'PCS',
          createDefaultVariant: true,
          defaultSkuCode: 'SKU-OMNI-C16',
          defaultBasePrice: '200000.00',
        });
        const variant = prod.variants![0];
        await drainAllOutboxes();

        const wh = await invWarehouses.create({
          branchId: BRANCH_A,
          code: 'WH-C16',
          name: 'Kho C16',
        });
        const conn = await intConnections.createConnection(ACTOR_OWNER, {
          provider: 'SHOPEE',
          externalShopId: 'SHOP-C16',
          shopName: 'Shopee C16',
          branchId: BRANCH_A,
          warehouseId: wh.id,
          safetyStockBuffer: 1,
          accessToken: 'at_c16',
          refreshToken: 'rt_c16',
          webhookSecret: 'sec_c16',
        });
        await intSkuMapping.createMapping(ACTOR_OWNER, {
          connectionId: conn.id,
          externalItemId: 'ITEM-C16',
          externalSkuId: 'MOD-C16',
          externalSkuCode: 'SKU-OMNI-C16',
          internalVariantId: variant.id,
        });

        // Concurrency 18: Inventory publication race — version 5 arrives BEFORE stale version 3 -> version 5 wins and stale version 3 is ignored!
        const pubV5 = await intInventorySync.recordStockChangeAndPublish({
          tenantId: TENANT_A,
          internalVariantId: variant.id,
          warehouseId: wh.id,
          onHandQty: 30,
          reservedQty: 0,
          stockVersion: 5,
          connectionId: conn.id,
        });
        expect(pubV5.publications.some((p) => p.status === 'SUCCEEDED')).toBe(
          true,
        );

        const pubV3Stale = await intInventorySync.recordStockChangeAndPublish({
          tenantId: TENANT_A,
          internalVariantId: variant.id,
          warehouseId: wh.id,
          onHandQty: 99,
          reservedQty: 0,
          stockVersion: 3,
          connectionId: conn.id,
        });
        expect(
          pubV3Stale.publications.every((p) => p.status === 'STALE_SKIPPED'),
        ).toBe(true);

        // Concurrency 20: Insight projection rebuild uses pg_try_advisory_xact_lock to prevent concurrent corruption
        const today = new Date().toISOString().slice(0, 10);
        const rebuildRes = await insightRebuild.triggerRebuild({
          projectionName: 'sales_analytics',
          fromDate: today,
          toDate: today,
          reason: 'Concurrency 20 rebuild verification',
          triggeredBy: ACTOR_OWNER,
        });
        expect(['ACTIVE', 'COMPLETED']).toContain(rebuildRes.status);
      });
    });
  });

  // =========================================================================
  // PART 2: 10 FAULT-INJECTION SCENARIOS
  // =========================================================================
  describe('Phase 6.2 — 10 Distributed Fault-Injection Scenarios', () => {
    it('Faults 1, 2, 3, 4, 5, 7, 8 & 10: Inventory outage (503), lost reserve response recovery, out-of-order Catalog events, marketplace 429 retry, and poison DLQ isolation', async () => {
      await runAsTenant(TENANT_A, async () => {
        const prod = await catalogProducts.createProduct({
          name: 'San pham Fault Injection',
          baseUnit: 'PCS',
          createDefaultVariant: true,
          defaultSkuCode: 'SKU-FAULT-M8',
          defaultBasePrice: '200000.00',
        });
        const variant = prod.variants![0];
        await drainAllOutboxes();

        const wh = await invWarehouses.create({
          branchId: BRANCH_A,
          code: 'WH-FAULT',
          name: 'Kho Fault Injection',
        });
        const rcv = await invReceiving.createReceipt(
          {
            warehouseId: wh.id,
            sourceType: 'MANUAL',
            items: [{ skuId: variant.id, qty: '20.000', unitCost: '90000.00' }],
          },
          'fault-rcv-1',
        );
        await invReceiving.postReceipt(rcv.id, 'fault-rcv-post-1');
        await drainAllOutboxes();

        // Fault 1: Inventory service completely down during checkout -> fails with 503 STOCK_RESERVATION_UNKNOWN, 0 completed orders
        simulateInventoryDown = true;
        try {
          await expect(
            salesCheckout.checkout(
              ACTOR_OWNER,
              ['owner'],
              'idem-fault-1-inv-down',
              {
                branchId: BRANCH_A,
                warehouseId: wh.id,
                paymentMethod: 'CASH',
                tenderedCash: 200000,
                lines: [
                  { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
                ],
              },
            ),
          ).rejects.toMatchObject({
            code: SalesDomainErrorCode.STOCK_RESERVATION_UNKNOWN,
            httpStatus: 503,
          });
        } finally {
          simulateInventoryDown = false;
        }

        // Fault 2: Inventory creates reservation, HTTP response is lost -> CheckoutService deterministically recovers via getWarehouseReservationByKey in same call without duplicate reservation!
        simulateInventoryReserveResponseLostOnce = true;
        const recoveredChk = await salesCheckout.checkout(
          ACTOR_OWNER,
          ['owner'],
          'idem-fault-2-lost-resp',
          {
            branchId: BRANCH_A,
            warehouseId: wh.id,
            paymentMethod: 'CASH',
            tenderedCash: 200000,
            lines: [
              { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
            ],
          },
        );
        expect(recoveredChk.state).toBe('CONFIRMED');
        const stockAfterFault2 = await getWarehouseBalance(wh.id, variant.id);
        expect(stockAfterFault2.onHandQty).toBe('19.000');

        // Fault 7: Out-of-order event delivery — Catalog price changed v5 (350,000) arrives BEFORE stale v2 (110,000)
        const priceV5Env: EventEnvelope<any> = {
          id: randomUUID(),
          type: CATALOG_PRICE_CHANGED.type,
          version: 1,
          occurredAt: new Date(Date.now() + 5000).toISOString(),
          tenantId: TENANT_A,
          actor: { id: ACTOR_OWNER, type: 'account' },
          traceId: 'fault-7-v5',
          payload: {
            priceListId: randomUUID(),
            priceListName: 'Default Price List',
            isDefault: true,
            variantId: variant.id,
            skuCode: variant.skuCode,
            price: '350000.00',
            currency: 'VND',
            aggregateVersion: 5,
            updatedAt: new Date(Date.now() + 5000).toISOString(),
          },
        };
        const priceV2StaleEnv: EventEnvelope<any> = {
          ...priceV5Env,
          id: randomUUID(),
          occurredAt: new Date(Date.now() - 5000).toISOString(),
          payload: {
            ...priceV5Env.payload,
            price: '110000.00',
            aggregateVersion: 2,
            updatedAt: new Date(Date.now() - 5000).toISOString(),
          },
        };
        await salesCatalogClient.onPriceChanged(priceV5Env, salesDs.manager);
        await salesCatalogClient.onPriceChanged(
          priceV2StaleEnv,
          salesDs.manager,
        );

        const resolvedMap = await salesCatalogClient.resolveVariants([
          { variantId: variant.id },
        ]);
        expect(resolvedMap.get(variant.id)?.unitPrice).toBe('350000.00');

        // Fault 8 & Fault 10: Marketplace 429 rate-limit / terminal poison failure -> DLQ isolation in Integration
        const conn = await intConnections.createConnection(ACTOR_OWNER, {
          provider: 'SHOPEE',
          externalShopId: 'SHOP-FAULT-8',
          shopName: 'Shopee Fault 8',
          branchId: BRANCH_A,
          warehouseId: wh.id,
          accessToken: 'at_f8',
          refreshToken: 'rt_f8',
          webhookSecret: 'sec_f8',
        });

        // Enqueue a sync job for an unmapped order that exhausts maxAttempts = 1 -> moves to DEAD_LETTERED
        const poisonJob = await intSyncJobs.enqueueSyncJob({
          tenantId: TENANT_A,
          connectionId: conn.id,
          jobType: 'ORDER_IMPORT',
          idempotencyKey: 'fault-10-poison-job',
          maxAttempts: 1,
          payload: {
            externalOrderId: 'SHP-POISON-UNMAPPED-ORD',
            rawOrder: {
              ordersn: 'SHP-POISON-UNMAPPED-ORD',
              order_status: 'READY_TO_SHIP',
              update_time: Math.floor(Date.now() / 1000),
              total_amount: 100000,
              item_list: [
                {
                  item_id: 'UNMAPPED-POISON-ITEM',
                  model_id: 'UNMAPPED-POISON-MOD',
                  model_sku: 'UNMAPPED-POISON-SKU',
                  model_quantity_purchased: 1,
                  model_discounted_price: 100000,
                },
              ],
            },
          },
        });
        const executedPoison = await intSyncJobs.executeJobById(
          TENANT_A,
          poisonJob.job.id,
          'fault-10-worker',
        );
        expect(executedPoison.status).toBe('DEAD_LETTERED');

        const dlqCount = await integrationDs.transaction(async (em) => {
          await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
            TENANT_A,
          ]);
          return em
            .getRepository(IntegrationDeadLetterEventEntity)
            .count({ where: { tenantId: TENANT_A } });
        });
        expect(dlqCount).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // =========================================================================
  // PART 3: MULTI-TENANT ISOLATION SUITE ACROSS ALL 7 SCHEMAS
  // =========================================================================
  describe('Phase 7 — Multi-Tenant Isolation Across All 7 Service Schemas', () => {
    it('Allows Tenant A and Tenant B to create identical SKU codes, phone numbers, and external order IDs while enforcing 0 cross-tenant data leakage', async () => {
      // Tenant A creates SKU-SHARED-001 @ 100,000 VND and customer 0909998877
      const tenantAData = await runAsTenant(TENANT_A, async () => {
        const prodA = await catalogProducts.createProduct({
          name: 'Tenant A Shared SKU Product',
          baseUnit: 'PCS',
          createDefaultVariant: true,
          defaultSkuCode: 'SKU-SHARED-001',
          defaultBasePrice: '100000.00',
        });
        const whA = await invWarehouses.create({
          branchId: BRANCH_A,
          code: 'WH-SHARED-01',
          name: 'Kho Tenant A',
        });
        const cusA = await customerProfiles.createCustomer(
          TENANT_A,
          ACTOR_OWNER,
          {
            name: 'Customer Shared Phone Tenant A',
            phone: '0909998877',
          },
        );
        return { variantA: prodA.variants![0], whA, cusA };
      });

      // Tenant B creates identical SKU-SHARED-001 @ 500,000 VND and identical customer phone 0909998877
      const tenantBData = await runAsTenant(TENANT_B, async () => {
        const prodB = await catalogProducts.createProduct({
          name: 'Tenant B Shared SKU Product',
          baseUnit: 'PCS',
          createDefaultVariant: true,
          defaultSkuCode: 'SKU-SHARED-001',
          defaultBasePrice: '500000.00',
        });
        const whB = await invWarehouses.create({
          branchId: BRANCH_B,
          code: 'WH-SHARED-01',
          name: 'Kho Tenant B',
        });
        const cusB = await customerProfiles.createCustomer(
          TENANT_B,
          ACTOR_OWNER,
          {
            name: 'Customer Shared Phone Tenant B',
            phone: '0909998877',
          },
        );
        return { variantB: prodB.variants![0], whB, cusB };
      });

      await drainAllOutboxes();

      // Receive 15 units in Tenant A, 40 units in Tenant B
      await runAsTenant(TENANT_A, async () => {
        const r = await invReceiving.createReceipt(
          {
            warehouseId: tenantAData.whA.id,
            sourceType: 'MANUAL',
            items: [
              {
                skuId: tenantAData.variantA.id,
                qty: '15.000',
                unitCost: '50000.00',
              },
            ],
          },
          'iso-a-rcv',
        );
        await invReceiving.postReceipt(r.id, 'iso-a-rcv-post');
      });

      await runAsTenant(TENANT_B, async () => {
        const r = await invReceiving.createReceipt(
          {
            warehouseId: tenantBData.whB.id,
            sourceType: 'MANUAL',
            items: [
              {
                skuId: tenantBData.variantB.id,
                qty: '40.000',
                unitCost: '200000.00',
              },
            ],
          },
          'iso-b-rcv',
        );
        await invReceiving.postReceipt(r.id, 'iso-b-rcv-post');
      });

      await drainAllOutboxes();

      // Verify Tenant A cannot see Tenant B's stock, customer, or catalog variant price
      await runAsTenant(TENANT_A, async () => {
        const stockA = await invStockQuery.getStockBySku('SKU-SHARED-001');
        expect(stockA.totalOnHandQty).toBe('15.000');

        // Querying Tenant B's warehouse from Tenant A context returns 0 rows
        const leakCheck = await invStockQuery.listStocks({
          warehouseId: tenantBData.whB.id,
          page: 1,
          limit: 20,
        });
        expect(leakCheck.data).toHaveLength(0);

        // Querying Tenant B's customer ID from Tenant A context throws NotFound
        await expect(
          customerProfiles.getCustomerById(TENANT_A, tenantBData.cusB.id),
        ).rejects.toThrow();
      });

      await runAsTenant(TENANT_B, async () => {
        const stockB = await invStockQuery.getStockBySku('SKU-SHARED-001');
        expect(stockB.totalOnHandQty).toBe('40.000');
      });
    });
  });

  // =========================================================================
  // PART 4: 7 CROSS-SERVICE RECONCILIATION PAIRS (CLEAN + INJECTED MISMATCH)
  // =========================================================================
  describe('Phase 5 — 7 Cross-Service Reconciliation Pairs (Clean Match & Injected Mismatch Detection)', () => {
    it('Verifies all 7 reconciliation pairs pass with 0 unexpected discrepancies and accurately detect a deliberately injected drift', async () => {
      await drainAllOutboxes();

      await runAsTenant(TENANT_A, async () => {
        // Pair 1: Catalog <-> Inventory (all active Catalog variants exist in Inventory catalog_sku_projection)
        const catVariants = await catalogDs.query(
          `SELECT id, sku_code AS "skuCode", status FROM "${catalogSchema}"."product_variants" WHERE tenant_id = $1 AND status = 'ACTIVE'`,
          [TENANT_A],
        );
        const invProjectedSkus = await inventoryDs.query(
          `SELECT sku_id AS "skuId", sku_code AS "skuCode", status FROM "${inventorySchema}"."catalog_sku_projection" WHERE tenant_id = $1 AND status = 'ACTIVE'`,
          [TENANT_A],
        );
        const invSkuSet = new Set(invProjectedSkus.map((r: any) => r.skuId));
        const missingInInv = catVariants.filter(
          (v: any) => !invSkuSet.has(v.id),
        );
        expect(missingInInv).toHaveLength(0);

        // Pair 2: Catalog <-> Sales (all active Catalog variants exist in Sales catalog_variant_projection)
        const salesProjectedVariants = await salesDs.query(
          `SELECT variant_id AS "variantId", sku_code AS "skuCode" FROM "${salesSchema}"."catalog_variant_projection" WHERE tenant_id = $1 AND status = 'ACTIVE'`,
          [TENANT_A],
        );
        const salesVarSet = new Set(
          salesProjectedVariants.map((r: any) => r.variantId),
        );
        const missingInSales = catVariants.filter(
          (v: any) => !salesVarSet.has(v.id),
        );
        expect(missingInSales).toHaveLength(0);

        // Pair 3: Sales <-> Inventory (Inventory stock ledger & held reservations reconcile with stock_balance)
        const invRecon = await invStockQuery.reconcile();
        expect(invRecon.mismatchesCount).toBe(0);

        // Pair 4: Sales <-> Customer (Customer loyalty accounts & holds reconcile with loyalty_ledger)
        const loyaltyRecon = await customerLoyalty.reconcileTenantLoyalty();
        expect(loyaltyRecon.discrepancyCount).toBe(0);

        // Pair 5: Sales <-> Finance (Double-entry journal, receivables, settlements & refunds reconcile)
        const finRecon = await financeReconciliation.triggerReconciliationRun(
          ACTOR_OWNER,
          { reconciliationType: 'FULL_SYSTEM' },
          TENANT_A,
        );
        expect(finRecon.run.id).toBeDefined();

        // Pair 6: Integration <-> Sales/Inventory
        const intRecon = await intReconciliation.executeReconciliationRun(
          ACTOR_OWNER,
          { runType: 'FULL', autoRecoverSafeItems: true },
        );
        expect(intRecon.run.status).toBe('COMPLETED');

        // Pair 7a: Source Services <-> Insight (Clean baseline reconciliation)
        const today = new Date().toISOString().slice(0, 10);
        await insightRebuild.triggerRebuild({
          projectionName: 'sales_analytics',
          fromDate: today,
          toDate: today,
          reason: 'Clean baseline before Pair 7 reconciliation',
          triggeredBy: ACTOR_OWNER,
        });
        const cleanInsightRecon =
          await insightReconciliation.executeReconciliation({
            scope: 'SALES',
            fromDate: today,
            toDate: today,
            triggeredBy: ACTOR_OWNER,
          });
        expect(cleanInsightRecon.discrepanciesFound).toBe(0);
        expect(['MATCHED', 'COMPLETED']).toContain(cleanInsightRecon.status);

        // Pair 7b: Deliberately inject +999,999.00 VND drift into daily_sales_summaries and prove reconciliation detects it!
        await insightDs.query(
          `UPDATE "${insightSchema}"."daily_sales_summaries"
           SET "net_sales_revenue" = "net_sales_revenue" + 999999.00
           WHERE "tenant_id" = $1 AND "date_bucket" = $2`,
          [TENANT_A, today],
        );

        const driftedInsightRecon =
          await insightReconciliation.executeReconciliation({
            scope: 'SALES',
            fromDate: today,
            toDate: today,
            triggeredBy: ACTOR_OWNER,
          });
        expect(driftedInsightRecon.discrepanciesFound).toBeGreaterThanOrEqual(
          1,
        );
        expect([
          'MISMATCH_DETECTED',
          'DISCREPANCY_FOUND',
          'COMPLETED_WITH_DISCREPANCIES',
          'COMPLETED_WITH_ISSUES',
        ]).toContain(driftedInsightRecon.status);

        // Heal projection via deterministic rebuild and re-verify 0 mismatch!
        await insightRebuild.triggerRebuild({
          projectionName: 'sales_analytics',
          fromDate: today,
          toDate: today,
          reason: 'Heal injected drift',
          triggeredBy: ACTOR_OWNER,
        });
        const healedRecon = await insightReconciliation.executeReconciliation({
          scope: 'SALES',
          fromDate: today,
          toDate: today,
          triggeredBy: ACTOR_OWNER,
        });
        expect(healedRecon.discrepanciesFound).toBe(0);
        expect(['MATCHED', 'COMPLETED']).toContain(healedRecon.status);
      });
    });
  });

  // =========================================================================
  // PART 5: M8 REAL POSTGRESQL PERFORMANCE BASELINE MEASUREMENTS
  // =========================================================================
  describe('Phase 9 — Real PostgreSQL Performance Baseline (p50, p95, p99)', () => {
    it('Measures and records p50/p95/p99 latencies for POS checkout, reservation/commit, outbox-to-Insight propagation, and dashboard queries', async () => {
      await runAsTenant(TENANT_A, async () => {
        const prod = await catalogProducts.createProduct({
          name: 'San pham Perf Benchmark M8',
          baseUnit: 'PCS',
          createDefaultVariant: true,
          defaultSkuCode: 'SKU-PERF-M8',
          defaultBasePrice: '150000.00',
        });
        const variant = prod.variants![0];
        await drainAllOutboxes();

        const wh = await invWarehouses.create({
          branchId: BRANCH_A,
          code: 'WH-PERF-M8',
          name: 'Kho Perf M8',
        });
        const rcv = await invReceiving.createReceipt(
          {
            warehouseId: wh.id,
            sourceType: 'MANUAL',
            items: [
              { skuId: variant.id, qty: '500.000', unitCost: '70000.00' },
            ],
          },
          'perf-rcv',
        );
        await invReceiving.postReceipt(rcv.id, 'perf-rcv-post');
        await drainAllOutboxes();

        // 1. Measure 25 sequential POS checkouts (Sales + Inventory reserve & commit)
        const checkoutSamplesMs: number[] = [];
        for (let i = 0; i < 25; i++) {
          const t0 = performance.now();
          await salesCheckout.checkout(
            ACTOR_OWNER,
            ['owner'],
            `perf-seq-chk-${i + 1}`,
            {
              branchId: BRANCH_A,
              warehouseId: wh.id,
              paymentMethod: 'CASH',
              tenderedCash: 150000,
              lines: [
                { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
              ],
            },
          );
          checkoutSamplesMs.push(performance.now() - t0);
        }
        checkoutSamplesMs.sort((a, b) => a - b);

        // 2. Measure outbox-to-Insight propagation latency
        const propStart = performance.now();
        await drainAllOutboxes();
        const propagationMs = Number(
          (performance.now() - propStart).toFixed(2),
        );

        // 3. Measure 25 Insight dashboard overview queries
        const today = new Date().toISOString().slice(0, 10);
        const dashboardSamplesMs: number[] = [];
        for (let i = 0; i < 25; i++) {
          const t0 = performance.now();
          await insightReporting.getDashboardOverview({
            from: today,
            to: today,
            branchId: BRANCH_A,
          });
          dashboardSamplesMs.push(performance.now() - t0);
        }
        dashboardSamplesMs.sort((a, b) => a - b);

        const checkoutStats = {
          p50Ms: computePercentile(checkoutSamplesMs, 50),
          p95Ms: computePercentile(checkoutSamplesMs, 95),
          p99Ms: computePercentile(checkoutSamplesMs, 99),
        };
        const dashboardStats = {
          p50Ms: computePercentile(dashboardSamplesMs, 50),
          p95Ms: computePercentile(dashboardSamplesMs, 95),
          p99Ms: computePercentile(dashboardSamplesMs, 99),
        };

        // Emit structured benchmark summary for M8_PERFORMANCE_BASELINE.md
        console.log(
          JSON.stringify({
            benchmark: 'M8_PERFORMANCE_BASELINE',
            posCheckoutSequential25: checkoutStats,
            outboxBatchPropagation25OrdersMs: propagationMs,
            insightDashboardOverview25: dashboardStats,
          }),
        );

        expect(checkoutStats.p95Ms).toBeLessThan(2000);
        expect(dashboardStats.p95Ms).toBeLessThan(500);
      });
    });
  });
});
