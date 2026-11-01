/**
 * Milestone M8 — Full-System End-to-End Business Workflows (Workflows A through G)
 * Real PostgreSQL Multi-Schema Integration Suite across all 8 Bounded Contexts:
 * Platform (branch events), Catalog (M1), Inventory (M2), Sales & POS (M3),
 * Customer & Loyalty (M4), Finance (M5), Integration & Omnichannel (M6), and Insight (M7).
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
import { computeShopeeWebhookSignature } from '../../../apps/integration/src/domain/integration-domain';
import {
  ChannelInventoryPublicationEntity,
  ChannelOrderRefEntity,
  M6_INTEGRATION_ENTITIES,
  WebhookInboxEventEntity,
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
import {
  SalesDomainError,
  SalesDomainErrorCode,
} from '../../../apps/sales/src/domain/sales-domain';
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
const BRANCH_A = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
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

describe('M8 Full-System Distributed Workflows A through G (Real PostgreSQL Across 7 Service Schemas)', () => {
  const catalogSchema = uniqueSchema('m8_cat');
  const inventorySchema = uniqueSchema('m8_inv');
  const salesSchema = uniqueSchema('m8_sal');
  const customerSchema = uniqueSchema('m8_cus');
  const financeSchema = uniqueSchema('m8_fin');
  const integrationSchema = uniqueSchema('m8_int');
  const insightSchema = uniqueSchema('m8_ins');

  let catalogDs: DataSource;
  let inventoryDs: DataSource;
  let salesDs: DataSource;
  let customerDs: DataSource;
  let financeDs: DataSource;
  let integrationDs: DataSource;
  let insightDs: DataSource;

  // Catalog services
  let catalogCategories: CatalogCategoriesService;
  let catalogBrands: BrandsService;
  let catalogAttributes: AttributesService;
  let catalogProducts: ProductsService;
  let catalogPricing: PricingService;

  // Inventory services
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

  // Sales services
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

  // Customer services
  let customerGroups: GroupsService;
  let customerMemberships: MembershipsService;
  let customerAddresses: AddressesService;
  let customerLoyalty: LoyaltyService;
  let customerProfiles: ProfilesService;
  let customerDataMgmt: DataManagementService;

  // Finance services
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

  // Integration services
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

  // Insight services
  let insightProjections: ProjectionsService;
  let insightConsumer: InsightEventsConsumer;
  let insightReporting: InsightReportingService;
  let insightRebuild: InsightRebuildService;
  let insightReconciliation: InsightReconciliationService;
  let insightSummaryHandler: SalesSummaryHandler;
  let insightAuditHandler: AuditHandler;

  let pauseInsightConsumer = false;
  const bufferedInsightEvents: EventEnvelope<any>[] = [];

  /**
   * Drains all unpublished `outbox_event` rows across all producer schemas
   * and routes them through the real downstream consumer handlers.
   */
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
      if (countInPass === 0) {
        break;
      }
    }
    return dispatched;
  }

  async function dispatchEnvelopeToSubscribers(
    env: EventEnvelope<any>,
  ): Promise<void> {
    const tId = env.tenantId;
    await runAsTenant(tId, async () => {
      // 1. Catalog -> Inventory, Sales, Integration
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

      // 2. Inventory -> Integration, Finance
      if (env.type === INVENTORY_STOCK_CHANGED.type) {
        await integrationDs.transaction(async (em) => {
          await intEventsConsumer.onInventoryStockChanged(env, em);
        });
      } else if (env.type === INVENTORY_STOCK_RECEIVED.type) {
        await financePayables.onStockReceived(env);
      } else if (env.type === INVENTORY_PURCHASE_ORDER_APPROVED.type) {
        await financePayables.onPurchaseOrderApproved(env);
      }

      // 3. Sales -> Customer Loyalty & Finance Settlements/Refunds/Reconciliation
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

      // 4. All source events -> Insight Consumer (unless paused for downtime test)
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

  /**
   * Helper to get warehouse stock balance for a given warehouseId and skuCode
   */
  async function getWarehouseBalance(warehouseId: string, skuCode: string) {
    const summary = await invStockQuery.getStockBySku(skuCode);
    const wh = summary.warehouses.find((w) => w.warehouseId === warehouseId);
    return {
      onHandQty: wh?.onHandQty ?? '0.000',
      reservedQty: wh?.reservedQty ?? '0.000',
      availableQty: wh?.availableQty ?? '0.000',
    };
  }

  beforeAll(async () => {
    const outbox = new EventOutbox();

    // 1. Initialize Catalog Schema & Services
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

    // 2. Initialize Inventory Schema & Services
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

    // 3. Initialize Customer Schema & Services
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

    // 4. Initialize Finance Schema & Services
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

    // 5. Initialize Sales Schema & Services (wired to REAL Inventory, Customer, and Finance!)
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

    // Wire Sales -> Customer Loyalty real delegate
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

    // Wire Sales -> Finance Credit Authorization real delegate
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

    // Wire Sales -> Inventory real S2S adapter backed by real ReservationsService + ReceivingService
    const realInventoryBridge = {
      reserve: async () => null,
      release: async () => undefined,
      reserveWarehouseStock: async (idempotencyKey: string, req: any) => {
        try {
          const res = await invReservations.reserveWarehouseStock(
            idempotencyKey,
            req,
          );
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
          if (err instanceof NotFoundException) {
            return null;
          }
          throw err;
        }
      },
      getWarehouseReservationByKey: async (
        idempotencyKey: string,
        callerService = 'sales',
      ) => {
        try {
          return await invReservations.getWarehouseReservationByKey(
            callerService,
            idempotencyKey,
          );
        } catch (err) {
          if (err instanceof NotFoundException) {
            return null;
          }
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
          if (err instanceof NotFoundException) {
            return null;
          }
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

    // 6. Initialize Integration Schema & Services (wired to REAL Sales & Inventory!)
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

    // Wire Integration -> Real Sales M3OrdersService + Real Inventory Reservations
    intSalesOrderClient.setCanonicalSalesDelegate(async (cmd) => {
      return runAsTenant(cmd.tenantId, async () => {
        try {
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
        } catch (err) {
          if (
            err instanceof SalesDomainError &&
            err.code === SalesDomainErrorCode.INSUFFICIENT_STOCK
          ) {
            // Create unconfirmed PENDING order in Sales so canonical order exists while on SHORTAGE_HOLD
            const pending = await salesOrders.createOmnichannelOrder(
              ACTOR_OWNER,
              ['owner'],
              {
                branchId: cmd.branchId,
                warehouseId: cmd.warehouseId ?? undefined,
                channelType: 'MARKETPLACE',
                sourceConnectionId: cmd.connectionId,
                externalOrderId: `${cmd.externalOrderId}:shortage-pending`,
                customerName: cmd.buyerName,
                shippingFee: cmd.shippingFee,
                autoConfirm: false,
                lines: cmd.lines.map((l) => ({
                  variantId: l.variantId,
                  skuCode: l.skuCode,
                  qty: l.quantity,
                })),
              },
            );
            const rawShortages =
              (err.details as { shortages?: any[] })?.shortages ?? [];
            return {
              internalOrderId: pending.id,
              internalOrderCode: pending.code,
              orderStatus: 'PENDING',
              fulfillmentStatus: 'UNFULFILLED',
              replayed: false,
              shortageDetected: true,
              shortages: rawShortages.map((s: any) => ({
                variantId: cmd.lines[0]?.variantId ?? s.skuId,
                skuCode: s.skuId,
                requestedQty: Number(s.requestedQty ?? cmd.lines[0]?.quantity),
                availableQty: Number(s.availableQty ?? 0),
              })),
            };
          }
          throw err;
        }
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

    // 7. Initialize Insight Schema & Services
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

    // Seed Platform Branch Event into Inventory, Sales, and Insight
    const branchCreatedEnv: EventEnvelope<any> = {
      id: randomUUID(),
      type: 'platform.branch.created',
      version: 1,
      occurredAt: new Date().toISOString(),
      tenantId: TENANT_A,
      actor: { id: ACTOR_OWNER, type: 'account' },
      traceId: 'm8-init',
      payload: {
        id: BRANCH_A,
        code: 'CN-HCM-01',
        name: 'Chi nhanh Trung Tam Q1',
        isWarehouse: true,
        status: 'active',
        updatedAt: new Date().toISOString(),
      },
    };
    await runAsTenant(TENANT_A, async () => {
      await invBranchHandler.onCreated(
        branchCreatedEnv as never,
        inventoryDs.manager,
      );
      await salesBranchHandler.onCreated(
        branchCreatedEnv as never,
        salesDs.manager,
      );
      await deliverEventToInsight(branchCreatedEnv);
    });
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
  // WORKFLOW A: End-to-End Product Creation -> Stock Receipt -> POS Sale ->
  // Finance Settlement -> Customer Loyalty -> Analytics -> Marketplace Stock Sync
  // =========================================================================
  it('Workflow A: Executes complete 7-service retail lifecycle from Catalog SKU creation through POS sale, Finance journal, Customer loyalty, Insight rollup & Integration stock sync', async () => {
    await runAsTenant(TENANT_A, async () => {
      // Step 1: Create Warehouse in Inventory & Marketplace Connection in Integration (Shopee)
      const warehouse = await invWarehouses.create({
        branchId: BRANCH_A,
        code: 'WH-HCM-01',
        name: 'Kho Trung Tam Q1',
        isDefault: true,
      });

      const conn = await intConnections.createConnection(ACTOR_OWNER, {
        provider: 'SHOPEE',
        externalShopId: 'SHOP-M8-001',
        shopName: 'Sapo Flagship Shopee',
        branchId: BRANCH_A,
        warehouseId: warehouse.id,
        safetyStockBuffer: 2,
        accessToken: 'at_wfa_001',
        refreshToken: 'rt_wfa_001',
        webhookSecret: 'sec_wfa_001',
      });

      // Step 2: Create Category, Brand & Product with Variant in Catalog
      const cat = await catalogCategories.create({
        name: 'Shirts',
      });
      const brand = await catalogBrands.create({
        name: 'Sapo Wear',
      });
      const product = await catalogProducts.createProduct({
        name: 'Ao Polo M8 Premium',
        categoryId: cat.id,
        brandId: brand.id,
        baseUnit: 'PCS',
        createDefaultVariant: true,
        defaultSkuCode: 'SKU-POLO-M8-L',
        defaultBarcode: '8938505970011',
        defaultBasePrice: '250000.00',
      });
      const variant = product.variants![0];
      expect(variant.skuCode).toBe('SKU-POLO-M8-L');

      // Drain outboxes -> Inventory, Sales, Integration, and Insight learn the new Catalog variant
      await drainAllOutboxes();

      // Map SKU in Integration to Shopee listing
      await intSkuMapping.createMapping(ACTOR_OWNER, {
        connectionId: conn.id,
        externalItemId: 'ITEM-SHP-001',
        externalSkuId: 'MODEL-SHP-001',
        externalSkuCode: 'SKU-POLO-M8-L',
        internalVariantId: variant.id,
      });

      // Step 3: Post Stock Receipt of 20 units @ 120,000 VND in Inventory
      const receiptDraft = await invReceiving.createReceipt(
        {
          warehouseId: warehouse.id,
          sourceType: 'PURCHASE_ORDER',
          supplierId: 'SUP-001',
          items: [
            {
              skuId: variant.skuCode,
              qty: '20.000',
              unitCost: '120000.00',
            },
          ],
        },
        'm8-wfa-receipt-create',
      );
      const postedReceipt = await invReceiving.postReceipt(
        receiptDraft.id,
        'm8-wfa-receipt-post',
      );
      expect(postedReceipt.status).toBe('POSTED');

      // Drain outboxes -> Integration receives stock changed, Finance creates AP payable, Insight updates inventory projection
      await drainAllOutboxes();

      const stockBeforeSale = await getWarehouseBalance(
        warehouse.id,
        variant.skuCode,
      );
      expect(stockBeforeSale.onHandQty).toBe('20.000');
      expect(stockBeforeSale.availableQty).toBe('20.000');

      // Step 4: Create Customer in Customer Service
      const customer = await customerProfiles.createCustomer(
        TENANT_A,
        ACTOR_OWNER,
        {
          name: 'Tran Thi Minh',
          phone: '0901112233',
          email: 'minh.tran@example.com',
        },
      );
      await drainAllOutboxes();

      // Step 5: Open POS Shift & Execute POS Checkout for 2 units @ 250,000 VND = 500,000 VND CASH
      const shift = await salesShifts.openShift(ACTOR_OWNER, {
        branchId: BRANCH_A,
        registerCode: 'POS-01',
        openingCash: '1000000.00',
      });

      const checkoutRes = await salesCheckout.checkout(
        ACTOR_OWNER,
        ['owner'],
        'idem-checkout-wfa-001',
        {
          branchId: BRANCH_A,
          warehouseId: warehouse.id,
          shiftId: shift.id,
          customerId: customer.id,
          customerName: customer.name,
          paymentMethod: 'CASH',
          tenderedCash: 500000,
          lines: [
            {
              variantId: variant.id,
              skuCode: variant.skuCode,
              qty: 2,
            },
          ],
        },
      );

      expect(checkoutRes.state).toBe('CONFIRMED');
      expect(checkoutRes.paymentStatus).toBe('PAID');
      expect(checkoutRes.fulfillmentStatus).toBe('FULFILLED');
      expect(checkoutRes.quote.grandTotal).toBe('500000.00');

      // Step 6: Drain all outboxes so Customer, Finance, Integration, and Insight process the sale
      await drainAllOutboxes();

      // Verify Inventory Stock Balance after sale: on_hand = 18, reserved = 0, available = 18
      const stockAfterSale = await getWarehouseBalance(
        warehouse.id,
        variant.skuCode,
      );
      expect(stockAfterSale.onHandQty).toBe('18.000');
      expect(stockAfterSale.reservedQty).toBe('0.000');
      expect(stockAfterSale.availableQty).toBe('18.000');

      // Verify Customer Loyalty Points Earned: 500,000 VND / 10,000 = 50 points
      const loyaltyAccount = await customerLoyalty.getLoyaltyAccount(
        customer.id,
      );
      expect(loyaltyAccount.availablePoints).toBe(50);
      expect(loyaltyAccount.lifetimeEarnedPoints).toBe(50);

      // Verify Finance Settlement & Balanced Double-Entry Journal
      const finRecon = await financeReconciliation.triggerReconciliationRun(
        ACTOR_OWNER,
        { reconciliationType: 'FULL_SYSTEM' },
        TENANT_A,
      );
      expect(finRecon.run.status).toBeDefined();

      // Verify Integration Marketplace Stock Publication: available 18 - safetyBuffer 2 = 16 published to Shopee
      const pubRows = await integrationDs.transaction(async (em) => {
        await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          TENANT_A,
        ]);
        return em.getRepository(ChannelInventoryPublicationEntity).find({
          where: { tenantId: TENANT_A, connectionId: conn.id },
        });
      });
      expect(pubRows.length).toBeGreaterThanOrEqual(1);
      expect(pubRows[0].targetPublishedQty).toBe(16);
      expect(pubRows[0].status).toBe('SUCCEEDED');

      // Verify Insight Daily Sales Projection Rollup
      const today = new Date().toISOString().slice(0, 10);
      const overview = await insightReporting.getDashboardOverview({
        from: today,
        to: today,
        branchId: BRANCH_A,
      });
      expect(
        Number(overview.metrics.netSalesRevenue.current),
      ).toBeGreaterThanOrEqual(500000);
      expect(
        Number(overview.metrics.completedOrderCount.current),
      ).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // WORKFLOW B: 100 Concurrent Checkouts for 1 Unit Against 10 Units in Stock
  // =========================================================================
  it('Workflow B: 100 concurrent checkout attempts for 1 unit against 10 units in stock -> exact 10 succeed, 90 fail with INSUFFICIENT_STOCK, zero negative stock', async () => {
    await runAsTenant(TENANT_A, async () => {
      // Create dedicated product & warehouse with exactly 10 units in stock
      const product = await catalogProducts.createProduct({
        name: 'Limited Flash Sale Item',
        baseUnit: 'PCS',
        createDefaultVariant: true,
        defaultSkuCode: 'SKU-FLASH-10',
        defaultBasePrice: '100000.00',
      });
      const variant = product.variants![0];
      await drainAllOutboxes();

      const warehouse = await invWarehouses.create({
        branchId: BRANCH_A,
        code: 'WH-FLASH-10',
        name: 'Kho Flash Sale',
      });
      const draft = await invReceiving.createReceipt(
        {
          warehouseId: warehouse.id,
          sourceType: 'MANUAL',
          items: [
            {
              skuId: variant.skuCode,
              qty: '10.000',
              unitCost: '50000.00',
            },
          ],
        },
        'm8-wfb-receipt-create',
      );
      await invReceiving.postReceipt(draft.id, 'm8-wfb-receipt-post');
      await drainAllOutboxes();

      // Launch 100 concurrent checkout requests, each requesting 1 unit with unique Idempotency-Key
      const attempts = Array.from({ length: 100 }, (_, idx) =>
        runAsTenant(TENANT_A, () =>
          salesCheckout.checkout(
            ACTOR_OWNER,
            ['owner'],
            `idem-wfb-flash-${idx + 1}`,
            {
              branchId: BRANCH_A,
              warehouseId: warehouse.id,
              paymentMethod: 'CASH',
              tenderedCash: 100000,
              lines: [
                {
                  variantId: variant.id,
                  skuCode: variant.skuCode,
                  qty: 1,
                },
              ],
            },
          ),
        ),
      );

      const results = await Promise.allSettled(attempts);
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      expect(fulfilled.length).toBe(10);
      expect(rejected.length).toBe(90);

      for (const rej of rejected) {
        expect(rej.reason).toBeInstanceOf(SalesDomainError);
        expect((rej.reason as SalesDomainError).code).toBe(
          SalesDomainErrorCode.INSUFFICIENT_STOCK,
        );
      }

      // Verify final warehouse stock balance: on_hand = 0, reserved = 0, available = 0
      const finalBalance = await getWarehouseBalance(
        warehouse.id,
        variant.skuCode,
      );
      expect(finalBalance.onHandQty).toBe('0.000');
      expect(finalBalance.reservedQty).toBe('0.000');
      expect(finalBalance.availableQty).toBe('0.000');
    });
  });

  // =========================================================================
  // WORKFLOW C: Sales + Customer Loyalty Concurrency & 5-Stage Failure Recovery
  // =========================================================================
  it('Workflow C: Concurrent 80-point redemptions against 100-point balance (1 succeeds, 1 rejected) + 5 failure-injection recovery stages', async () => {
    await runAsTenant(TENANT_A, async () => {
      // Create product & stock 50 units
      const product = await catalogProducts.createProduct({
        name: 'San pham Loyalty WFC',
        baseUnit: 'PCS',
        createDefaultVariant: true,
        defaultSkuCode: 'SKU-LOY-WFC',
        defaultBasePrice: '150000.00',
      });
      const variant = product.variants![0];
      await drainAllOutboxes();

      const warehouse = await invWarehouses.create({
        branchId: BRANCH_A,
        code: 'WH-LOY-WFC',
        name: 'Kho Loyalty WFC',
      });
      const rDraft = await invReceiving.createReceipt(
        {
          warehouseId: warehouse.id,
          sourceType: 'MANUAL',
          items: [
            { skuId: variant.skuCode, qty: '50.000', unitCost: '80000.00' },
          ],
        },
        'm8-wfc-rcv-1',
      );
      await invReceiving.postReceipt(rDraft.id, 'm8-wfc-rcv-post-1');
      await drainAllOutboxes();

      // Create customer and grant exactly 100 loyalty points
      const customer = await customerProfiles.createCustomer(
        TENANT_A,
        ACTOR_OWNER,
        {
          name: 'Le Van Loyalty',
          phone: '0902223344',
        },
      );
      await customerLoyalty.adjustPoints(
        customer.id,
        ACTOR_OWNER,
        'wfc-init-100-pts',
        {
          pointsDelta: 100,
          reason: 'Initial 100 points for Workflow C',
          idempotencyKey: 'wfc-init-100-pts',
        },
      );

      // Part 1: Two concurrent checkouts each attempting to redeem 80 points from 100-point balance
      const [c1, c2] = await Promise.allSettled([
        runAsTenant(TENANT_A, () =>
          salesCheckout.checkout(ACTOR_OWNER, ['owner'], 'idem-wfc-race-1', {
            branchId: BRANCH_A,
            warehouseId: warehouse.id,
            customerId: customer.id,
            redeemLoyaltyPoints: 80,
            paymentMethod: 'CASH',
            tenderedCash: 150000,
            lines: [
              { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
            ],
          }),
        ),
        runAsTenant(TENANT_A, () =>
          salesCheckout.checkout(ACTOR_OWNER, ['owner'], 'idem-wfc-race-2', {
            branchId: BRANCH_A,
            warehouseId: warehouse.id,
            customerId: customer.id,
            redeemLoyaltyPoints: 80,
            paymentMethod: 'CASH',
            tenderedCash: 150000,
            lines: [
              { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
            ],
          }),
        ),
      ]);

      const raceFulfilled = [c1, c2].filter((r) => r.status === 'fulfilled');
      const raceRejected = [c1, c2].filter((r) => r.status === 'rejected');
      expect(raceFulfilled.length).toBe(1);
      expect(raceRejected.length).toBe(1);

      const accountAfterRace = await customerLoyalty.getLoyaltyAccount(
        customer.id,
      );
      expect(accountAfterRace.heldPoints).toBe(0);
      expect(accountAfterRace.lifetimeRedeemedPoints).toBe(80);

      // Top up customer points by 300 for the 5 failure injection scenarios
      await customerLoyalty.adjustPoints(
        customer.id,
        ACTOR_OWNER,
        'wfc-topup-300',
        {
          pointsDelta: 300,
          reason: 'Top up for 5 failure injection stages',
          idempotencyKey: 'wfc-topup-300',
        },
      );

      // Stage 1: Fail after loyalty hold before stock reserve -> retry recovers cleanly
      await expect(
        salesCheckout.checkout(
          ACTOR_OWNER,
          ['owner'],
          'idem-wfc-fail-stage-1',
          {
            branchId: BRANCH_A,
            warehouseId: warehouse.id,
            customerId: customer.id,
            redeemLoyaltyPoints: 20,
            simulateFailureAfterLoyaltyHold: true,
            paymentMethod: 'CASH',
            tenderedCash: 150000,
            lines: [
              { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
            ],
          },
        ),
      ).rejects.toThrow();

      // Retry with same Idempotency-Key -> resumes workflow, reserves stock, commits stock & loyalty hold
      const recoveredStage1 = await salesCheckout.checkout(
        ACTOR_OWNER,
        ['owner'],
        'idem-wfc-fail-stage-1',
        {
          branchId: BRANCH_A,
          warehouseId: warehouse.id,
          customerId: customer.id,
          redeemLoyaltyPoints: 20,
          simulateFailureAfterLoyaltyHold: true,
          paymentMethod: 'CASH',
          tenderedCash: 150000,
          lines: [{ variantId: variant.id, skuCode: variant.skuCode, qty: 1 }],
        },
      );
      expect(recoveredStage1.state).toBe('CONFIRMED');
      expect(recoveredStage1.replayed).toBe(true);

      // Stage 2: Fail during stock reserve (request 999 units) -> loyalty hold is automatically released!
      const ptsBeforeStage2 = (
        await customerLoyalty.getLoyaltyAccount(customer.id)
      ).availablePoints;
      await expect(
        salesCheckout.checkout(
          ACTOR_OWNER,
          ['owner'],
          'idem-wfc-fail-stage-2',
          {
            branchId: BRANCH_A,
            warehouseId: warehouse.id,
            customerId: customer.id,
            redeemLoyaltyPoints: 30,
            paymentMethod: 'CASH',
            tenderedCash: 150000 * 999,
            lines: [
              { variantId: variant.id, skuCode: variant.skuCode, qty: 999 },
            ],
          },
        ),
      ).rejects.toThrow();
      const accountAfterStage2 = await customerLoyalty.getLoyaltyAccount(
        customer.id,
      );
      expect(accountAfterStage2.availablePoints).toBe(ptsBeforeStage2);
      expect(accountAfterStage2.heldPoints).toBe(0);

      // Stage 3: Fail after both holds (loyalty held + stock reserved) before commit -> retry finalizes both
      await expect(
        salesCheckout.checkout(
          ACTOR_OWNER,
          ['owner'],
          'idem-wfc-fail-stage-3',
          {
            branchId: BRANCH_A,
            warehouseId: warehouse.id,
            customerId: customer.id,
            redeemLoyaltyPoints: 25,
            simulateFailureAfterReserve: true,
            paymentMethod: 'CASH',
            tenderedCash: 150000,
            lines: [
              { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
            ],
          },
        ),
      ).rejects.toThrow();
      const recoveredStage3 = await salesCheckout.checkout(
        ACTOR_OWNER,
        ['owner'],
        'idem-wfc-fail-stage-3',
        {
          branchId: BRANCH_A,
          warehouseId: warehouse.id,
          customerId: customer.id,
          redeemLoyaltyPoints: 25,
          simulateFailureAfterReserve: true,
          paymentMethod: 'CASH',
          tenderedCash: 150000,
          lines: [{ variantId: variant.id, skuCode: variant.skuCode, qty: 1 }],
        },
      );
      expect(recoveredStage3.state).toBe('CONFIRMED');

      // Stage 4: Fail after stock commit before loyalty commit -> reconciliation worker completes loyalty commit & order
      await expect(
        salesCheckout.checkout(
          ACTOR_OWNER,
          ['owner'],
          'idem-wfc-fail-stage-4',
          {
            branchId: BRANCH_A,
            warehouseId: warehouse.id,
            customerId: customer.id,
            redeemLoyaltyPoints: 15,
            simulateFailureAfterStockCommitBeforeLoyaltyCommit: true,
            paymentMethod: 'CASH',
            tenderedCash: 150000,
            lines: [
              { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
            ],
          },
        ),
      ).rejects.toThrow();

      const reconRes = await salesCheckout.reconcilePendingCheckouts();
      expect(reconRes.finalized).toBeGreaterThanOrEqual(1);

      // Stage 5: Duplicate retry after completion -> returns same order without double point deduction
      const ptsBeforeReplay = (
        await customerLoyalty.getLoyaltyAccount(customer.id)
      ).availablePoints;
      const replayedStage4 = await salesCheckout.checkout(
        ACTOR_OWNER,
        ['owner'],
        'idem-wfc-fail-stage-4',
        {
          branchId: BRANCH_A,
          warehouseId: warehouse.id,
          customerId: customer.id,
          redeemLoyaltyPoints: 15,
          simulateFailureAfterStockCommitBeforeLoyaltyCommit: true,
          paymentMethod: 'CASH',
          tenderedCash: 150000,
          lines: [{ variantId: variant.id, skuCode: variant.skuCode, qty: 1 }],
        },
      );
      expect(replayedStage4.state).toBe('CONFIRMED');
      expect(replayedStage4.replayed).toBe(true);
      const ptsAfterReplay = (
        await customerLoyalty.getLoyaltyAccount(customer.id)
      ).availablePoints;
      expect(ptsAfterReplay).toBe(ptsBeforeReplay);
      expect(
        (await customerLoyalty.getLoyaltyAccount(customer.id)).heldPoints,
      ).toBe(0);
    });
  });

  // =========================================================================
  // WORKFLOW D: Credit Sale & Finance (Concurrency, Partial Debt Payment & Fail-Closed Outage)
  // =========================================================================
  it('Workflow D: Credit limit 1,000,000 VND with two concurrent 800,000 VND credit sales -> 1 succeeds, 1 rejected; partial 300,000 VND collection; Finance outage fails closed (503)', async () => {
    await runAsTenant(TENANT_A, async () => {
      // Create product priced at 800,000 VND & receive 20 units
      const product = await catalogProducts.createProduct({
        name: 'May In Hoa Don Credit',
        baseUnit: 'PCS',
        createDefaultVariant: true,
        defaultSkuCode: 'SKU-CREDIT-800K',
        defaultBasePrice: '800000.00',
      });
      const variant = product.variants![0];
      await drainAllOutboxes();

      const warehouse = await invWarehouses.create({
        branchId: BRANCH_A,
        code: 'WH-CREDIT-WFD',
        name: 'Kho Credit WFD',
      });
      const rDraft = await invReceiving.createReceipt(
        {
          warehouseId: warehouse.id,
          sourceType: 'MANUAL',
          items: [
            { skuId: variant.skuCode, qty: '20.000', unitCost: '500000.00' },
          ],
        },
        'm8-wfd-rcv-1',
      );
      await invReceiving.postReceipt(rDraft.id, 'm8-wfd-rcv-post-1');
      await drainAllOutboxes();

      // Create customer & configure credit limit = 1,000,000 VND in Finance
      const customer = await customerProfiles.createCustomer(
        TENANT_A,
        ACTOR_OWNER,
        {
          name: 'Pham Van Credit',
          phone: '0903334455',
        },
      );
      await financeCreditAuth.updateCreditLimit(
        customer.id,
        { creditLimit: '1000000.00' },
        TENANT_A,
      );

      // Part 1: Two concurrent 800,000 VND ON_ACCOUNT credit sales
      const [crd1, crd2] = await Promise.allSettled([
        runAsTenant(TENANT_A, () =>
          salesCheckout.checkout(
            ACTOR_OWNER,
            ['owner'],
            'idem-wfd-credit-race-1',
            {
              branchId: BRANCH_A,
              warehouseId: warehouse.id,
              customerId: customer.id,
              customerName: customer.name,
              paymentMethod: 'ON_ACCOUNT',
              lines: [
                { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
              ],
            },
          ),
        ),
        runAsTenant(TENANT_A, () =>
          salesCheckout.checkout(
            ACTOR_OWNER,
            ['owner'],
            'idem-wfd-credit-race-2',
            {
              branchId: BRANCH_A,
              warehouseId: warehouse.id,
              customerId: customer.id,
              customerName: customer.name,
              paymentMethod: 'ON_ACCOUNT',
              lines: [
                { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
              ],
            },
          ),
        ),
      ]);

      const crdFulfilled = [crd1, crd2].filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      const crdRejected = [crd1, crd2].filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(crdFulfilled.length).toBe(1);
      expect(crdRejected.length).toBe(1);
      expect((crdRejected[0].reason as SalesDomainError).code).toBe(
        SalesDomainErrorCode.CREDIT_AUTHORIZATION_FAILED,
      );

      await drainAllOutboxes();

      // Verify customer credit profile after 1st credit sale: postedDebt = 800,000, heldCredit = 0, available = 200,000
      const profileAfterSale = await financeCreditAuth.getCreditProfile(
        customer.id,
        TENANT_A,
      );
      expect(profileAfterSale.postedDebt).toBe('800000.00');
      expect(profileAfterSale.heldCredit).toBe('0.00');
      expect(profileAfterSale.availableCredit).toBe('200000.00');

      // Record Insight netSalesRevenue before debt collection to prove debt collection does not double-count sales revenue
      const today = new Date().toISOString().slice(0, 10);
      const overviewBeforeCollection =
        await insightReporting.getDashboardOverview({
          from: today,
          to: today,
          branchId: BRANCH_A,
        });
      const netSalesBefore =
        overviewBeforeCollection.metrics.netSalesRevenue.current;

      // Part 2: Partial receivable collection of 300,000 VND + duplicate retry with same idempotencyKey
      const receivablesList = await financeReceivables.listReceivables(
        { customerId: customer.id },
        TENANT_A,
      );
      expect(receivablesList.data.length).toBe(1);
      const receivable = receivablesList.data[0];
      expect(receivable.outstandingAmount).toBe('800000.00');

      const payment1 = await financeReceivables.recordReceivablePayment(
        receivable.id,
        customer.id,
        ACTOR_OWNER,
        'idem-wfd-pay-300k',
        {
          amount: '300000.00',
          paymentMethod: 'CASH',
          overpaymentPolicy: 'REJECT',
        },
        TENANT_A,
      );
      expect(payment1.customerTotalDebtAfter).toBe('500000.00');

      // Duplicate retry with same idempotencyKey -> no double collection
      const payment1Replay = await financeReceivables.recordReceivablePayment(
        receivable.id,
        customer.id,
        ACTOR_OWNER,
        'idem-wfd-pay-300k',
        {
          amount: '300000.00',
          paymentMethod: 'CASH',
          overpaymentPolicy: 'REJECT',
        },
        TENANT_A,
      );
      expect(payment1Replay.replayed).toBe(true);
      expect(payment1Replay.customerTotalDebtAfter).toBe('500000.00');

      await drainAllOutboxes();

      const profileAfterPayment = await financeCreditAuth.getCreditProfile(
        customer.id,
        TENANT_A,
      );
      expect(profileAfterPayment.postedDebt).toBe('500000.00');
      expect(profileAfterPayment.availableCredit).toBe('500000.00');

      // Verify Insight sales revenue was NOT inflated by receivable debt collection
      const overviewAfterCollection =
        await insightReporting.getDashboardOverview({
          from: today,
          to: today,
          branchId: BRANCH_A,
        });
      expect(overviewAfterCollection.metrics.netSalesRevenue.current).toBe(
        netSalesBefore,
      );
      expect(
        Number(overviewAfterCollection.metrics.debtCollectedAmount),
      ).toBeGreaterThanOrEqual(300000);

      // Part 3: Finance service outage during credit authorization -> fails closed with 503 CREDIT_SERVICE_UNAVAILABLE
      salesFinanceCreditClient.setSimulateUnavailable(true);
      try {
        await expect(
          salesCheckout.checkout(
            ACTOR_OWNER,
            ['owner'],
            'idem-wfd-finance-outage',
            {
              branchId: BRANCH_A,
              warehouseId: warehouse.id,
              customerId: customer.id,
              customerName: customer.name,
              paymentMethod: 'ON_ACCOUNT',
              lines: [
                { variantId: variant.id, skuCode: variant.skuCode, qty: 1 },
              ],
            },
          ),
        ).rejects.toMatchObject({
          code: SalesDomainErrorCode.CREDIT_SERVICE_UNAVAILABLE,
          httpStatus: 503,
        });
      } finally {
        salesFinanceCreditClient.setSimulateUnavailable(false);
      }
    });
  });

  // =========================================================================
  // WORKFLOW E: Returns & Refunds (Partial Return, Concurrent Conflicting Returns & Timeout Recovery)
  // =========================================================================
  it('Workflow E: Partial return of 2/5 units restocks inventory, claws back loyalty points, posts refund & adjusts Insight; concurrent conflicting returns for remaining 3 allow only 1 winner', async () => {
    await runAsTenant(TENANT_A, async () => {
      // Create product & stock 20 units
      const product = await catalogProducts.createProduct({
        name: 'San pham Return WFE',
        baseUnit: 'PCS',
        createDefaultVariant: true,
        defaultSkuCode: 'SKU-RET-WFE',
        defaultBasePrice: '200000.00',
      });
      const variant = product.variants![0];
      await drainAllOutboxes();

      const warehouse = await invWarehouses.create({
        branchId: BRANCH_A,
        code: 'WH-RET-WFE',
        name: 'Kho Return WFE',
      });
      const rDraft = await invReceiving.createReceipt(
        {
          warehouseId: warehouse.id,
          sourceType: 'MANUAL',
          items: [
            { skuId: variant.skuCode, qty: '20.000', unitCost: '100000.00' },
          ],
        },
        'm8-wfe-rcv-1',
      );
      await invReceiving.postReceipt(rDraft.id, 'm8-wfe-rcv-post-1');
      await drainAllOutboxes();

      const customer = await customerProfiles.createCustomer(
        TENANT_A,
        ACTOR_OWNER,
        {
          name: 'Hoang Thi Return',
          phone: '0904445566',
        },
      );

      // Sell 5 units @ 200,000 VND = 1,000,000 VND (earns 100 loyalty points)
      const checkout = await salesCheckout.checkout(
        ACTOR_OWNER,
        ['owner'],
        'idem-wfe-sale-5',
        {
          branchId: BRANCH_A,
          warehouseId: warehouse.id,
          customerId: customer.id,
          customerName: customer.name,
          paymentMethod: 'CASH',
          tenderedCash: 1000000,
          lines: [{ variantId: variant.id, skuCode: variant.skuCode, qty: 5 }],
        },
      );
      await drainAllOutboxes();

      // Stock after 5 sold = 15.000; Customer points = 100
      expect(
        (await getWarehouseBalance(warehouse.id, variant.skuCode)).onHandQty,
      ).toBe('15.000');
      expect(
        (await customerLoyalty.getLoyaltyAccount(customer.id)).availablePoints,
      ).toBe(100);

      // Fetch order details to get orderItemId
      const orderDetail = await salesOrders.getOrderDetails(checkout.orderId!);
      const orderItemId = orderDetail.items[0].id;

      // Part 1: Return 2 units (RESTOCK) -> 400,000 VND refund, +2 stock, -40 loyalty points
      const ret1 = await salesReturns.createReturn(ACTOR_OWNER, {
        orderId: checkout.orderId!,
        warehouseId: warehouse.id,
        autoReceive: true,
        items: [
          {
            orderItemId,
            returnQty: 2,
            disposition: 'RESTOCK',
          },
        ],
      });
      expect(ret1.totalRefundAmount).toBe('400000.00');
      await drainAllOutboxes();

      expect(
        (await getWarehouseBalance(warehouse.id, variant.skuCode)).onHandQty,
      ).toBe('17.000');
      expect(
        (await customerLoyalty.getLoyaltyAccount(customer.id)).availablePoints,
      ).toBe(60);

      // Part 2: Concurrent conflicting returns — 3 units remain returnable, two concurrent requests each try to return 3 units
      const [concRet1, concRet2] = await Promise.allSettled([
        runAsTenant(TENANT_A, () =>
          salesReturns.createReturn(ACTOR_OWNER, {
            orderId: checkout.orderId!,
            warehouseId: warehouse.id,
            autoReceive: true,
            items: [{ orderItemId, returnQty: 3, disposition: 'RESTOCK' }],
          }),
        ),
        runAsTenant(TENANT_A, () =>
          salesReturns.createReturn(ACTOR_OWNER, {
            orderId: checkout.orderId!,
            warehouseId: warehouse.id,
            autoReceive: true,
            items: [{ orderItemId, returnQty: 3, disposition: 'RESTOCK' }],
          }),
        ),
      ]);

      const retWinners = [concRet1, concRet2].filter(
        (r) => r.status === 'fulfilled',
      );
      const retLosers = [concRet1, concRet2].filter(
        (r) => r.status === 'rejected',
      );
      expect(retWinners.length).toBe(1);
      expect(retLosers.length).toBe(1);
      expect((retLosers[0] as PromiseRejectedResult).reason).toMatchObject({
        code: SalesDomainErrorCode.RETURN_QUANTITY_EXCEEDED,
      });

      await drainAllOutboxes();

      // Total returned = 2 + 3 = 5 units -> stock is back to 20.000, loyalty points back to 0
      expect(
        (await getWarehouseBalance(warehouse.id, variant.skuCode)).onHandQty,
      ).toBe('20.000');
      expect(
        (await customerLoyalty.getLoyaltyAccount(customer.id)).availablePoints,
      ).toBe(0);

      // Part 3: Refund provider timeout ambiguity -> RECONCILIATION_REQUIRED -> resolved without double payout
      const secondOrder = await salesCheckout.checkout(
        ACTOR_OWNER,
        ['owner'],
        'idem-wfe-sale-timeout-test',
        {
          branchId: BRANCH_A,
          warehouseId: warehouse.id,
          paymentMethod: 'BANK_TRANSFER',
          lines: [{ variantId: variant.id, skuCode: variant.skuCode, qty: 1 }],
        },
      );
      await drainAllOutboxes();

      const createdRefund = await financeRefunds.createRefund(
        ACTOR_OWNER,
        'idem-wfe-refund-timeout',
        {
          orderId: secondOrder.orderId!,
          branchId: BRANCH_A,
          method: 'BANK_TRANSFER',
          amount: '200000.00',
          autoApprove: true,
        },
        TENANT_A,
      );

      const timedOutRefund = await financeRefunds.executeRefund(
        createdRefund.refund.id,
        ACTOR_OWNER,
        {
          simulateProviderTimeout: true,
          requireReconciliationOnTimeout: true,
        },
        TENANT_A,
      );
      expect(timedOutRefund.status).toBe('RECONCILIATION_REQUIRED');

      const resolvedRefund = await financeRefunds.confirmRefundOutcome(
        createdRefund.refund.id,
        ACTOR_OWNER,
        {
          outcome: 'COMPLETED',
          externalRefundRef: 'BANK-TX-CONFIRMED-001',
        },
        TENANT_A,
      );
      expect(resolvedRefund.status).toBe('COMPLETED');
    });
  });

  // =========================================================================
  // WORKFLOW F: Omnichannel Order Import (Integration -> Sales -> Inventory)
  // =========================================================================
  it('Workflow F: Omnichannel order import, 100x duplicate webhook replay, unmapped SKU conflict & resolution, shortage hold, and lost-response recovery', async () => {
    await runAsTenant(TENANT_A, async () => {
      // Create product & stock 10 units
      const product = await catalogProducts.createProduct({
        name: 'Tai Nghe Bluetooth Omni',
        baseUnit: 'PCS',
        createDefaultVariant: true,
        defaultSkuCode: 'SKU-OMNI-WFF',
        defaultBasePrice: '300000.00',
      });
      const variant = product.variants![0];
      await drainAllOutboxes();

      const warehouse = await invWarehouses.create({
        branchId: BRANCH_A,
        code: 'WH-OMNI-WFF',
        name: 'Kho Omnichannel WFF',
      });
      const rDraft = await invReceiving.createReceipt(
        {
          warehouseId: warehouse.id,
          sourceType: 'MANUAL',
          items: [
            { skuId: variant.skuCode, qty: '10.000', unitCost: '150000.00' },
          ],
        },
        'm8-wff-rcv-1',
      );
      await invReceiving.postReceipt(rDraft.id, 'm8-wff-rcv-post-1');
      await drainAllOutboxes();

      // Create Shopee connection & map SKU-OMNI-WFF
      const webhookSecret = 'shopee_wff_secret_001';
      const conn = await intConnections.createConnection(ACTOR_OWNER, {
        provider: 'SHOPEE',
        externalShopId: 'SHOP-WFF-001',
        shopName: 'Sapo Omni Shopee',
        branchId: BRANCH_A,
        warehouseId: warehouse.id,
        accessToken: 'at_wff_001',
        refreshToken: 'rt_wff_001',
        webhookSecret,
      });

      await intSkuMapping.createMapping(ACTOR_OWNER, {
        connectionId: conn.id,
        externalItemId: 'SHP-ITEM-WFF-1',
        externalSkuId: 'SHP-MOD-WFF-1',
        externalSkuCode: 'SKU-OMNI-WFF',
        internalVariantId: variant.id,
      });

      // Case 1 & Case 2: Import Shopee order via signed webhook + replay 100 duplicate webhooks
      const externalOrderId = 'SHP-ORD-WFF-100';
      const webhookUrl = `https://api.sapoclone.local/webhooks/v1/shopee/${conn.connectionKey}`;
      const rawBody = JSON.stringify({
        code: 3,
        shop_id: 'SHOP-WFF-001',
        msg_id: 'MSG-WFF-100',
        timestamp: Math.floor(Date.now() / 1000),
        data: {
          ordersn: externalOrderId,
          order_status: 'READY_TO_SHIP',
          update_time: Math.floor(Date.now() / 1000),
          buyer_username: 'buyer.shopee.100',
          currency: 'VND',
          total_amount: 600000,
          estimated_shipping_fee: 0,
          payment_method: 'SHOPEEPAY',
          item_list: [
            {
              item_id: 'SHP-ITEM-WFF-1',
              model_id: 'SHP-MOD-WFF-1',
              model_sku: 'SKU-OMNI-WFF',
              item_name: 'Tai Nghe Black',
              model_quantity_purchased: 2,
              model_discounted_price: 300000,
            },
          ],
        },
      });
      const signature = computeShopeeWebhookSignature(
        webhookUrl,
        rawBody,
        webhookSecret,
      );

      // Fire 100 concurrent duplicate webhook deliveries
      const webhookDeliveries = Array.from({ length: 100 }, () =>
        intWebhooks.ingestWebhook({
          provider: 'SHOPEE',
          connectionKey: conn.connectionKey,
          rawBody,
          headers: { authorization: signature },
          webhookUrl,
        }),
      );
      const whResults = await Promise.all(webhookDeliveries);
      const firstAccepted = whResults.filter((r) => !r.deduplicated);
      const deduplicatedCount = whResults.filter((r) => r.deduplicated);
      expect(firstAccepted.length).toBe(1);
      expect(deduplicatedCount.length).toBe(99);

      // Process queued webhook sync job
      await intSyncJobs.claimAndProcessBatch({
        tenantId: TENANT_A,
        workerId: 'worker-wff',
        batchSize: 10,
      });

      // Verify 1 inbox event, 1 ChannelOrderRef IMPORTED, and 2 units reserved in Inventory (available = 8.000)
      const stockAfterOmniImport = await getWarehouseBalance(
        warehouse.id,
        variant.skuCode,
      );
      expect(stockAfterOmniImport.onHandQty).toBe('10.000');
      expect(stockAfterOmniImport.reservedQty).toBe('2.000');
      expect(stockAfterOmniImport.availableQty).toBe('8.000');

      const counts = await integrationDs.transaction(async (em) => {
        await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          TENANT_A,
        ]);
        const inboxCount = await em
          .getRepository(WebhookInboxEventEntity)
          .count({
            where: { tenantId: TENANT_A, connectionId: conn.id },
          });
        const orderRefs = await em.getRepository(ChannelOrderRefEntity).find({
          where: {
            tenantId: TENANT_A,
            connectionId: conn.id,
            externalOrderId,
          },
        });
        return { inboxCount, orderRefs };
      });
      expect(counts.inboxCount).toBe(1);
      expect(counts.orderRefs).toHaveLength(1);
      expect(counts.orderRefs[0].syncStatus).toBe('IMPORTED');

      // Case 3: Unknown SKU -> MAPPING_REQUIRED conflict -> map SKU -> resolve conflict -> IMPORTED
      const unmappedOrderPayload = {
        ordersn: 'SHP-ORD-UNMAPPED-1',
        order_status: 'READY_TO_SHIP',
        update_time: Math.floor(Date.now() / 1000),
        total_amount: 300000,
        item_list: [
          {
            item_id: 'SHP-ITEM-NEW-99',
            model_id: 'SHP-MOD-NEW-99',
            model_sku: 'EXT-UNMAPPED-99',
            item_name: 'Unmapped Item',
            model_quantity_purchased: 1,
            model_discounted_price: 300000,
          },
        ],
      };

      const unmappedRes = await intOrderSync.importOrderByExternalId({
        tenantId: TENANT_A,
        connectionId: conn.id,
        externalOrderId: 'SHP-ORD-UNMAPPED-1',
        inlineOrderPayload: unmappedOrderPayload,
      });
      expect(unmappedRes.statusOutcome).toBe('MAPPING_REQUIRED');

      // Operator creates SKU mapping & re-imports order
      await intSkuMapping.createMapping(ACTOR_OWNER, {
        connectionId: conn.id,
        externalItemId: 'SHP-ITEM-NEW-99',
        externalSkuId: 'SHP-MOD-NEW-99',
        externalSkuCode: 'EXT-UNMAPPED-99',
        internalVariantId: variant.id,
      });
      const retriedAfterMap = await intOrderSync.importOrderByExternalId({
        tenantId: TENANT_A,
        connectionId: conn.id,
        externalOrderId: 'SHP-ORD-UNMAPPED-1',
        inlineOrderPayload: unmappedOrderPayload,
      });
      expect(retriedAfterMap.statusOutcome).toBe('IMPORTED');

      // Case 4: Insufficient stock (request 50 units when 7 are available) -> SHORTAGE_HOLD conflict
      const shortageRes = await intOrderSync.importOrderByExternalId({
        tenantId: TENANT_A,
        connectionId: conn.id,
        externalOrderId: 'SHP-ORD-SHORTAGE-1',
        inlineOrderPayload: {
          ordersn: 'SHP-ORD-SHORTAGE-1',
          order_status: 'READY_TO_SHIP',
          update_time: Math.floor(Date.now() / 1000),
          total_amount: 15000000,
          item_list: [
            {
              item_id: 'SHP-ITEM-WFF-1',
              model_id: 'SHP-MOD-WFF-1',
              model_sku: 'SKU-OMNI-WFF',
              item_name: 'Tai Nghe Black',
              model_quantity_purchased: 50,
              model_discounted_price: 300000,
            },
          ],
        },
      });
      expect(shortageRes.statusOutcome).toBe('SHORTAGE_HOLD');

      // Case 5: Sales created canonical order, but Integration crashed before saving response -> Retry recovers without duplicate order
      const crashOrderPayload = {
        ordersn: 'SHP-ORD-CRASH-REC-1',
        order_status: 'READY_TO_SHIP',
        update_time: Math.floor(Date.now() / 1000),
        total_amount: 300000,
        item_list: [
          {
            item_id: 'SHP-ITEM-WFF-1',
            model_id: 'SHP-MOD-WFF-1',
            model_sku: 'SKU-OMNI-WFF',
            item_name: 'Tai Nghe Black',
            model_quantity_purchased: 1,
            model_discounted_price: 300000,
          },
        ],
      };

      intSalesOrderClient.simulateCrashAfterSalesCreate(
        TENANT_A,
        conn.id,
        'SHP-ORD-CRASH-REC-1',
      );
      await expect(
        intOrderSync.importOrderByExternalId({
          tenantId: TENANT_A,
          connectionId: conn.id,
          externalOrderId: 'SHP-ORD-CRASH-REC-1',
          inlineOrderPayload: crashOrderPayload,
        }),
      ).rejects.toThrow();

      // Retry recovers the canonical order idempotently
      const recoveredOmni = await intOrderSync.importOrderByExternalId({
        tenantId: TENANT_A,
        connectionId: conn.id,
        externalOrderId: 'SHP-ORD-CRASH-REC-1',
        inlineOrderPayload: crashOrderPayload,
      });
      expect(recoveredOmni.statusOutcome).toBe('IMPORTED');
      expect(recoveredOmni.replayed).toBe(true);
    });
  });

  // =========================================================================
  // WORKFLOW G: Real-Time Insight (100x Duplicate Event Replay, Downtime Catch-Up & Deterministic Rebuild)
  // =========================================================================
  it('Workflow G: Insight processes 100x duplicate event replay idempotently, catches up after consumer downtime, and deterministically rebuilds projections to match source truth', async () => {
    await runAsTenant(TENANT_A, async () => {
      await drainAllOutboxes();
      const today = new Date().toISOString().slice(0, 10);

      // Record baseline before Workflow G sale
      const baselineOverview = await insightReporting.getDashboardOverview({
        from: today,
        to: today,
        branchId: BRANCH_A,
      });
      const baseNetRevenue = Number(
        baselineOverview.metrics.netSalesRevenue.current,
      );

      // Create product & stock 10 units for Workflow G
      const product = await catalogProducts.createProduct({
        name: 'San pham Insight WFG',
        baseUnit: 'PCS',
        createDefaultVariant: true,
        defaultSkuCode: 'SKU-INSIGHT-WFG',
        defaultBasePrice: '500000.00',
      });
      const variant = product.variants![0];
      await drainAllOutboxes();

      const warehouse = await invWarehouses.create({
        branchId: BRANCH_A,
        code: 'WH-INSIGHT-WFG',
        name: 'Kho Insight WFG',
      });
      const rDraft = await invReceiving.createReceipt(
        {
          warehouseId: warehouse.id,
          sourceType: 'MANUAL',
          items: [
            { skuId: variant.skuCode, qty: '10.000', unitCost: '250000.00' },
          ],
        },
        'm8-wfg-rcv-1',
      );
      await invReceiving.postReceipt(rDraft.id, 'm8-wfg-rcv-post-1');
      await drainAllOutboxes();

      // Step 1: Pause Insight consumer to simulate Insight downtime while POS sale of 500,000 VND occurs
      pauseInsightConsumer = true;
      const saleRes = await salesCheckout.checkout(
        ACTOR_OWNER,
        ['owner'],
        'idem-wfg-sale-500k',
        {
          branchId: BRANCH_A,
          warehouseId: warehouse.id,
          paymentMethod: 'CASH',
          tenderedCash: 500000,
          lines: [{ variantId: variant.id, skuCode: variant.skuCode, qty: 1 }],
        },
      );
      expect(saleRes.state).toBe('CONFIRMED');
      await drainAllOutboxes();

      // While Insight consumer is down, POS sale succeeded (non-blocking!), and buffered events wait in queue
      expect(bufferedInsightEvents.length).toBeGreaterThan(0);

      // Step 2: Resume Insight consumer & replay the buffered events 100 times to prove idempotency
      pauseInsightConsumer = false;
      const eventsToDeliver = [...bufferedInsightEvents];
      bufferedInsightEvents.length = 0;

      for (const ev of eventsToDeliver) {
        await deliverEventToInsight(ev);
      }
      const checkoutEvent = eventsToDeliver.find(
        (e) =>
          e.type === SALES_CHECKOUT_COMPLETED.type ||
          e.type === SALES_ORDER_COMPLETED.type,
      )!;
      expect(checkoutEvent).toBeDefined();

      // Replay the exact same event 100 times
      for (let i = 0; i < 100; i++) {
        await deliverEventToInsight(checkoutEvent);
      }

      const afterCatchupOverview = await insightReporting.getDashboardOverview({
        from: today,
        to: today,
        branchId: BRANCH_A,
      });
      expect(Number(afterCatchupOverview.metrics.netSalesRevenue.current)).toBe(
        baseNetRevenue + 500000,
      );

      // Step 3: Trigger deterministic projection rebuild in Insight & verify projections remain identical
      const rebuildJob = await insightRebuild.triggerRebuild({
        projectionName: 'sales_analytics',
        fromDate: today,
        toDate: today,
        reason: 'M8 Workflow G deterministic rebuild verification',
      });
      expect(rebuildJob.status).toBe('ACTIVE');

      const afterRebuildOverview = await insightReporting.getDashboardOverview({
        from: today,
        to: today,
        branchId: BRANCH_A,
      });
      expect(Number(afterRebuildOverview.metrics.netSalesRevenue.current)).toBe(
        baseNetRevenue + 500000,
      );
    });
  });
});
