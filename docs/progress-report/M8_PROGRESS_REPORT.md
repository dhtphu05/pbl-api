# M8 Master Progress Report — Full-System Integration, Distributed Reliability & Architecture Validation

**Project:** PBL6 SapoClone — Multi-Tenant Omnichannel Retail Management SaaS  
**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation  
**Status:** **COMPLETED & VERIFIED AGAINST REAL POSTGRESQL**  
**Date:** 2026-10-31

---

## 1. Executive Summary

Milestone M8 integrated and hardened all eight SapoClone microservices (`platform`, `catalog`, `inventory`, `sales`, `customer`, `finance`, `integration`, `insight`) into a cohesive, fault-tolerant, multi-tenant distributed backend. Rather than stopping at mocks or architectural diagrams, we executed end-to-end multi-service workflows, concurrency races, and fault injections against real PostgreSQL schemas with Row-Level Security (RLS) enforced, uncovered and fixed five real cross-service integration defects, and verified zero drift across all seven cross-service reconciliation pairs.

---

## 2. Key Engineering Deliverables Completed in M8

### 2.1. Infrastructure, S2S Adapters & Contract Hardening
1. **Docker Compose & ElasticMQ Topology**:
   - Updated [`docker-compose.yml`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docker-compose.yml) and [`docker/elasticmq.conf`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docker/elasticmq.conf) to orchestrate all 8 services (`:3000`–`:3007`) and their dedicated SQS queues + DLQs.
   - Updated [`.github/workflows/ci.yml`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/.github/workflows/ci.yml) to build, lint, architecture-check, and test all 8 microservices.
2. **S2S HTTP Adapters for Distributed Checkout Saga**:
   - Implemented [`CustomerLoyaltyHttpClient`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/infrastructure/customer-client/customer-loyalty.client.ts) (`Sales <-> Customer`) and [`FinanceCreditHttpClient`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/infrastructure/finance-client/finance-credit.client.ts) (`Sales <-> Finance`) and wired them into [`OrdersModule`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/orders/orders.module.ts) and [`CheckoutService`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/modules/checkout/checkout.service.ts).

### 2.2. Real Cross-Service Defects Discovered & Fixed
| # | Defect Discovered During Real-PostgreSQL Integration | Root Cause | Fix Applied |
|---|---|---|---|
| **1** | `Inventory` rejected `skuCode` strings passed by `Sales` during checkout & returns | `Inventory` tables type `sku_id` as `UUID`, whereas `Sales` passed `skuCode` strings | Updated [`CatalogSkuProjectionHandler.assertCatalogSkuEligible`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/inventory/src/infrastructure/catalog-reference/catalog-sku-projection.handler.ts), [`ReceivingService`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/inventory/src/modules/receiving/receiving.service.ts), [`ReservationsService`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/inventory/src/stock/reservations.service.ts), and [`StockQueryService.getStockBySku`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/inventory/src/modules/stock/stock-query.service.ts) to resolve either UUID `sku_id` or `sku_code` to canonical UUID `skuId` |
| **2** | Credit sale (`ON_ACCOUNT`) failed database check constraint in `Sales` | `CHK_order_tenders_method` omitted `'ON_ACCOUNT'` | Added `'ON_ACCOUNT'` to `CHK_order_tenders_method` in [`1791900000200-create-m3-sales-core.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/migrations/1791900000200-create-m3-sales-core.ts) |
| **3** | Shopee webhook with top-level `data.item_list` did not auto-enqueue `ORDER_IMPORT` | [`WebhooksService.ingestWebhook`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/integration/src/modules/webhooks/webhooks.service.ts) only checked `data.order_detail` | Updated inline order detection to check `Array.isArray(dataObj?.item_list) \|\| Array.isArray(dataObj?.order_items) \|\| Array.isArray(dataObj?.lines)` |
| **4** | `inventory.transfer.dispatched` caused `NOT NULL` violation on `warehouse_id` in `Insight` | Transfer dispatch emits per-line `inventory.stock.changed` events plus a summary event with `fromWarehouseId`/`toWarehouseId` and `items: [...]` | Updated [`ProjectionsService.processInventoryStockEvent`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/insight/src/modules/projections/projections.service.ts) to resolve `warehouseId` and ignore multi-line header events |
| **5** | Out-of-order `catalog.price.changed` event could overwrite newer price in `Sales` | [`CatalogClient.onPriceChanged`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/apps/sales/src/infrastructure/catalog-client/catalog.client.ts) lacked monotonic version check on `UPDATE` | Added `AND (aggregate_version < $5::int OR (aggregate_version = $5::int AND source_updated_at <= $4::timestamptz))` |

---

## 3. Comprehensive Verification Summary (`pnpm verify:m8`)

| Verification Gate | Suite / File | Tests | Result |
|---|---|---|---|
| **DDD & Hexagonal Architecture Fitness** | `pnpm test:arch` (9 suites across all 8 apps + `libs/common`) | `85 / 85` | **100% PASS** |
| **End-to-End Business Workflows A–G** | [`m8-full-system-workflows.int-spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/test/m8-full-system-workflows.int-spec.ts) | `7 / 7` | **100% PASS** |
| **20 Concurrency + 10 Fault + RLS + 7 Recon + Perf** | [`m8-concurrency-fault-reconciliation.int-spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/test/m8-concurrency-fault-reconciliation.int-spec.ts) | `8 / 8` | **100% PASS** |

### Real-PostgreSQL Latency Baseline
- **POS Checkout Saga (`Sales` + `Inventory` Reserve & Confirm + Outbox)**: `p50 = 35.14 ms`, `p95 = 47.25 ms`, `p99 = 55.92 ms`.
- **Multi-Service Outbox Batch Propagation (`25` completed orders across 7 services)**: `1,734.45 ms` (`~69.38 ms / order`).
- **Insight Dashboard Overview Query**: `p50 = 2.04 ms`, `p95 = 2.66 ms`, `p99 = 8.96 ms`.
