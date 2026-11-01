# M8 Contract Compatibility Audit — REST, S2S & Event Schemas

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation

---

## 1. Canonical Identifier & Data Type Alignment

During M8 cross-service integration testing on real PostgreSQL, we audited every producer-consumer contract and resolved all identifier and schema mismatches:

### 1.1. Canonical Variant / SKU Identifier (`Catalog` $\leftrightarrow$ `Inventory` $\leftrightarrow$ `Sales` $\leftrightarrow$ `Integration`)
- **Finding**: `Catalog` generates a UUID `product_variants.id` (`variantId`) and a merchant-readable string `sku_code` (`skuCode`). `Inventory` stores `sku_id` as a `UUID` column referencing the canonical variant UUID, while `Sales` (`CheckoutService`, `M3OrdersService`, `ReturnsService`) passed `skuCode` strings in S2S calls (`reserveStock`, `restockReturn`) or queried `getStockBySku(skuCode)`.
- **Fix Implemented**:
  1. [`CatalogSkuProjectionHandler.assertCatalogSkuEligible`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/inventory/src/infrastructure/catalog-reference/catalog-sku-projection.handler.ts) now matches `WHERE tenant_id = $1 AND (sku_id::text = $2 OR sku_code = $2)` and returns the canonical UUID `skuId`.
  2. [`ReceivingService.createReceipt`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/inventory/src/modules/receiving/receiving.service.ts) and [`ReservationsService.reserveStock`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/inventory/src/stock/reservations.service.ts) normalize every incoming SKU identifier to its canonical UUID `skuId` before inserting into `inventory_receipt_items`, `stock_reservations`, `inventory_balances`, or `stock_movements`.
  3. [`StockQueryService.getStockBySku`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/inventory/src/modules/stock/stock-query.service.ts) resolves either a UUID `sku_id` or a string `sku_code` via `catalog_sku_projection`.

### 1.2. Credit Sale Tender Method (`Sales` $\leftrightarrow$ `Finance`)
- **Finding**: `CheckoutService` writes `'ON_ACCOUNT'` into `sales.order_tenders.method` for credit sales, which previously violated `CHK_order_tenders_method`.
- **Fix Implemented**: Added `'ON_ACCOUNT'` to `CHK_order_tenders_method` in [`1791900000200-create-m3-sales-core.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/migrations/1791900000200-create-m3-sales-core.ts).

### 1.3. Multi-Line Inventory Document Header Events (`Inventory` $\rightarrow$ `Insight`)
- **Finding**: `TransfersService.dispatchTransfer` and `ReceivingService.postReceipt` emit per-line `inventory.stock.changed` events (which carry `warehouseId`, `skuCode`, `newOnHand`, `avgCost`) AND a document-level summary event (`inventory.transfer.dispatched`, `inventory.stock.received`) containing `fromWarehouseId`/`toWarehouseId` and an `items` array.
- **Fix Implemented**: Updated [`ProjectionsService.processInventoryStockEvent`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/insight/src/modules/projections/projections.service.ts) to resolve `warehouseId` from `p.warehouseId ?? p.fromWarehouseId ?? p.toWarehouseId` and skip document-header summary events when per-line `inventory.stock.changed` events already maintain the SKU projections.

### 1.4. Out-of-Order Price Change Events (`Catalog` $\rightarrow$ `Sales`)
- **Finding**: [`CatalogClient.onPriceChanged`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/infrastructure/catalog-client/catalog.client.ts) updated `catalog_variant_projection` without checking `aggregate_version` when a default price list changed.
- **Fix Implemented**: Added `AND (aggregate_version < $5::int OR (aggregate_version = $5::int AND source_updated_at <= $4::timestamptz))` to `onPriceChanged` in [`catalog.client.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/infrastructure/catalog-client/catalog.client.ts).

---

## 2. Canonical `EventEnvelope<T>` Contract (`@pbl6/events`)

All domain events published across all 8 services conform to `EventEnvelope<T>` in [`libs/events/src/event.types.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/src/event.types.ts):

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `UUID` | Yes | Globally unique event identifier for consumer inbox deduplication |
| `type` | `string` | Yes | Versioned domain event name (e.g., `sales.order.completed`) |
| `version` | `number` | Yes | Schema version (`1`) |
| `occurredAt` | `ISO-8601` | Yes | Producer timestamp when the state transition occurred |
| `tenantId` | `UUID` | Yes | Authoritative tenant boundary |
| `actor` | `{ id, type }` | Yes | User, staff, or system actor initiating the transition |
| `traceId` | `string` | Optional | Distributed correlation/trace identifier |
| `payload` | `T` | Yes | Strongly typed event payload |
