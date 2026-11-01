# M8 Baseline Audit Report — Pre-Integration System Inventory

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation  
**Repository:** `pbl-api` (`/Users/mac/Desktop/SEM7/pbl6/pbl-api`)  
**Date:** 2026-10-31

---

## 1. Executive Summary

Before executing M8 cross-service integration, we audited all 8 bounded-context microservices (`platform`, `catalog`, `inventory`, `sales`, `customer`, `finance`, `integration`, `insight`), shared libraries (`libs/common`, `libs/auth`, `libs/events`, `libs/config`, `libs/cache`), local container orchestration (`docker-compose.yml`, `docker/elasticmq.conf`), and CI quality gates (`.github/workflows/ci.yml`).

### Audit Verdict Summary

| Service | Schema | Migrations | RLS Forced | Outbox / Inbox | S2S / Event Contracts | Pre-M8 Integration Gaps Identified & Fixed |
|---|---|---|---|---|---|---|
| **Platform** | `platform` | 7 | Yes (`tenant_id`) | Outbox | RS256 JWKS, Tenant/Branch RBAC | Healthy baseline |
| **Catalog** | `catalog` | 3 | Yes (`FORCE ROW LEVEL SECURITY`) | Outbox + Inbox | Publishes `catalog.product.*`, `catalog.variant.*`, `catalog.price.changed` | Healthy baseline |
| **Inventory** | `inventory` | 3 | Yes (`FORCE ROW LEVEL SECURITY`) | Outbox + Inbox | Internal reserve/confirm/release + `inventory.stock.*` | **Fixed:** Canonical UUID `sku_id` resolution when `Sales` passes `skuCode` string (`assertCatalogSkuEligible`, `StockQueryService.getStockBySku`) |
| **Sales** | `sales` | 3 | Yes (`FORCE ROW LEVEL SECURITY`) | Outbox + Inbox + Saga | Checkout Saga, Returns, Orders, Shifts, Promotions | **Fixed:** Wired HTTP S2S adapters `CustomerLoyaltyHttpClient` and `FinanceCreditHttpClient`; added `'ON_ACCOUNT'` to `CHK_order_tenders_method`; added monotonic `aggregate_version` guard in `CatalogClient.onPriceChanged` |
| **Customer** | `customer` | 3 | Yes (`FORCE ROW LEVEL SECURITY`) | Outbox + Inbox | Loyalty hold/confirm/release/earn + `customer.*` events | Healthy baseline |
| **Finance** | `finance` | 3 | Yes (`FORCE ROW LEVEL SECURITY`) | Outbox + Inbox | Credit check, AR debt ledger, cashbook, settlements, refunds | Healthy baseline |
| **Integration** | `integration` | 2 | Yes (`FORCE ROW LEVEL SECURITY`) | Outbox + Inbox + SyncJobs | Shopee/TikTok/Lazada webhooks, SKU mappings, order import, stock push | **Fixed:** Top-level `data.item_list` inline order extraction in `WebhooksService.ingestWebhook` |
| **Insight** | `insight` | 2 | Yes (`FORCE ROW LEVEL SECURITY`) | Outbox + Inbox + Checkpoints | Analytical projections, shadow rebuild, reconciliation | **Fixed:** `processInventoryStockEvent` handling for multi-line header events (`inventory.transfer.dispatched`, `inventory.stock.received`) |

---

## 2. Infrastructure & Local Environment Audit

1. **Docker Compose (`docker-compose.yml`)**:
   - Upgraded to orchestrate all 8 microservices (`platform:3000`, `catalog:3001`, `inventory:3002`, `sales:3003`, `customer:3004`, `finance:3005`, `integration:3006`, `insight:3007`) alongside PostgreSQL (`5432`), Redis (`6379`), and ElasticMQ (`9324`/`9325`).
2. **SQS Queue Topology (`docker/elasticmq.conf`)**:
   - Declared all per-service event queues (`platform-events-queue`, `catalog-events-queue`, `inventory-events-queue`, `sales-events-queue`, `customer-events-queue`, `finance-events-queue`, `integration-events-queue`, `insight-events-queue`) and corresponding dead-letter queues (`*-dlq`).
3. **CI Pipeline (`.github/workflows/ci.yml`)**:
   - Expanded CI matrix to build, lint, architecture-check (`pnpm test:arch`), unit-test, and integration-test all 8 services.
