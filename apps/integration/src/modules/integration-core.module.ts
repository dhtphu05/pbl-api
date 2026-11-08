import { Module } from '@nestjs/common';
import { PblPropagationModule } from '@pbl/common';
import { IntegrationEventsConsumer } from '../consumers/integration-events.consumer';
import { ProviderRateLimiterService } from '../infrastructure/rate-limiting/provider-rate-limiter.service';
import { SalesOrderClient } from '../infrastructure/sales-client/sales-order.client';
import { LazadaProviderAdapter } from '../providers/lazada/lazada.adapter';
import { ProviderRegistryService } from '../providers/provider-registry.service';
import { ShopeeProviderAdapter } from '../providers/shopee/shopee.adapter';
import { BranchScopeService } from './branch-scope/branch-scope.service';
import { ConflictsController } from './conflicts/conflicts.controller';
import { ConflictsService } from './conflicts/conflicts.service';
import { ConnectionsController } from './connections/connections.controller';
import { LazadaCallbackController } from './connections/lazada-callback.controller';
import { ConnectionsService } from './connections/connections.service';
import { InventorySyncService } from './inventory-sync/inventory-sync.service';
import { OrderSyncService } from './order-sync/order-sync.service';
import { ReconciliationController } from './reconciliation/reconciliation.controller';
import { ReconciliationService } from './reconciliation/reconciliation.service';
import { SkuMappingController } from './sku-mapping/sku-mapping.controller';
import { SkuMappingService } from './sku-mapping/sku-mapping.service';
import { SyncJobsController } from './sync-jobs/sync-jobs.controller';
import { SyncJobsService } from './sync-jobs/sync-jobs.service';
import { WebhooksController } from './webhooks/webhooks.controller';
import { WebhooksService } from './webhooks/webhooks.service';

@Module({
  imports: [
    // sales gets no user token from background jobs; the call carries x-internal-token
    PblPropagationModule.forRoot({ baseURL: process.env.SALES_SERVICE_URL }),
  ],
  controllers: [
    ConnectionsController,
    LazadaCallbackController,
    SkuMappingController,
    SyncJobsController,
    ConflictsController,
    ReconciliationController,
    WebhooksController,
  ],
  providers: [
    ProviderRateLimiterService,
    ShopeeProviderAdapter,
    LazadaProviderAdapter,
    ProviderRegistryService,
    SalesOrderClient,
    BranchScopeService,
    ConnectionsService,
    SkuMappingService,
    OrderSyncService,
    InventorySyncService,
    SyncJobsService,
    WebhooksService,
    ConflictsService,
    ReconciliationService,
    IntegrationEventsConsumer,
  ],
  exports: [
    ProviderRateLimiterService,
    ProviderRegistryService,
    SalesOrderClient,
    ConnectionsService,
    SkuMappingService,
    OrderSyncService,
    InventorySyncService,
    SyncJobsService,
    WebhooksService,
    ConflictsService,
    ReconciliationService,
    IntegrationEventsConsumer,
  ],
})
export class IntegrationCoreModule {}
