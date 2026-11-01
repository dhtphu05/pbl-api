# M8 Service Dependency & Communication Matrix

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation

---

## 1. Synchronous S2S Dependencies (`InternalS2sClient`)

Synchronous S2S calls are restricted strictly to **real-time command validations or resource reservations** where the caller cannot proceed without an immediate decision. All S2S requests carry `X-Internal-Token` (HMAC-SHA256 signed service token), `X-Tenant-Id`, `X-Correlation-Id`, and `Idempotency-Key`.

| Caller Service | Target Service | Port / Endpoint | Adapter Class | Timeout / Retry Policy | Fallback / Failure Mode |
|---|---|---|---|---|---|
| `Sales` | `Inventory` | `POST /api/v1/internal/reservations/reserve`<br>`POST /api/v1/internal/reservations/:id/confirm`<br>`POST /api/v1/internal/reservations/:id/release`<br>`POST /api/v1/internal/returns/restock` | [`InventoryClient`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/infrastructure/inventory-client/inventory.client.ts) | 3000ms timeout; deterministic recovery via `GET /reservations/by-key/:key` on timeout | Pre-payment: fail checkout (`503 STOCK_RESERVATION_UNKNOWN` or `409 INSUFFICIENT_STOCK`). Post-payment: mark saga `RECONCILIATION_REQUIRED` |
| `Sales` | `Customer` | `POST /api/v1/internal/loyalty/holds`<br>`POST /api/v1/internal/loyalty/holds/:id/confirm`<br>`POST /api/v1/internal/loyalty/holds/:id/release`<br>`POST /api/v1/internal/loyalty/reverse` | [`CustomerLoyaltyHttpClient`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/infrastructure/customer-client/customer-loyalty.client.ts) | 3000ms timeout; idempotent `holdKey` | Pre-payment: release inventory reservation and fail checkout. Post-payment: mark `RECONCILIATION_REQUIRED` |
| `Sales` | `Finance` | `POST /api/v1/internal/credit/check` | [`FinanceCreditHttpClient`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/infrastructure/finance-client/finance-credit.client.ts) | 3000ms timeout | Reject `ON_ACCOUNT` credit sale if credit limit exceeded (`422 CREDIT_LIMIT_EXCEEDED`) or Finance unreachable |
| `Integration` | `Sales` | `POST /api/v1/orders` | [`OrderSyncProcessor`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/integration/src/modules/orders-sync/orders-sync.service.ts) | SyncJob retry with exponential backoff (max 5 attempts) | Move sync job to `RETRY_SCHEDULED` or `DEAD_LETTERED` |
| `Integration` | `Inventory` | `POST /api/v1/internal/reservations/reserve`<br>`POST /api/v1/internal/reservations/:id/confirm`<br>`POST /api/v1/internal/reservations/:id/release` | [`OrdersSyncService`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/integration/src/modules/orders-sync/orders-sync.service.ts) | SyncJob retry with exponential backoff | If `INSUFFICIENT_AVAILABLE_STOCK`, place marketplace order in `ON_HOLD_SHORTAGE` |

---

## 2. Asynchronous Domain Event Subscriptions

| Producer Service | Event Type | Consumer Service(s) | Purpose | Ordering / Idempotency Mechanism |
|---|---|---|---|---|
| `Catalog` | `catalog.product.created`<br>`catalog.product.updated`<br>`catalog.variant.created`<br>`catalog.variant.updated`<br>`catalog.variant.status_changed` | `Inventory`, `Sales`, `Insight` | Project canonical SKU metadata (`catalog_sku_projection`, `catalog_variant_projection`) | `(tenant_id, event_id)` inbox + monotonic `aggregate_version` |
| `Catalog` | `catalog.price.changed` | `Sales` | Update default selling price in `sales.catalog_variant_projection` | Monotonic `aggregate_version` & `source_updated_at` guard in [`CatalogClient.onPriceChanged`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/infrastructure/catalog-client/catalog.client.ts) |
| `Inventory` | `inventory.stock.received`<br>`inventory.stock.changed`<br>`inventory.stock.adjusted`<br>`inventory.transfer.dispatched`<br>`inventory.transfer.received`<br>`inventory.reservation.*` | `Integration`, `Insight` | Trigger outbound marketplace stock push (`Integration`) and update stock/COGS projections (`Insight`) | Monotonic `stock_version` in `Integration`; `(tenant_id, event_id)` inbox in `Insight` |
| `Sales` | `sales.order.created`<br>`sales.order.completed`<br>`sales.order.cancelled` | `Customer`, `Finance`, `Insight` | Award loyalty points & update spend (`Customer`), record settlement/cashbook/AR debt (`Finance`), update revenue/COGS/profit summaries (`Insight`) | Idempotent `(tenant_id, order_id)` ledger constraints + `(tenant_id, event_id)` inbox |
| `Sales` | `sales.return.completed`<br>`sales.refund.requested` | `Customer`, `Finance`, `Insight` | Deduct returned loyalty points (`Customer`), disburse refund / reduce AR debt (`Finance`), record return revenue/COGS reversal (`Insight`) | Idempotent `evt:rf:<refundRequestId>` key in `Finance` |
| `Finance` | `finance.settlement.recorded`<br>`finance.debt.changed`<br>`finance.debt.payment.recorded`<br>`finance.refund.completed`<br>`finance.cashbook.recorded` | `Sales`, `Insight` | Confirm refund completion (`Sales`) and update cashflow/aging projections (`Insight`) | `(tenant_id, event_id)` inbox |
| `Integration` | `integration.order.imported`<br>`integration.order.conflict`<br>`integration.inventory.published` | `Insight` | Track channel sync health and omnichannel order analytics | `(tenant_id, event_id)` inbox |
