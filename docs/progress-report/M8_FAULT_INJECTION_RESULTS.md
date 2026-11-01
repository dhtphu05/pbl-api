# M8 Distributed Fault-Injection Test Results

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation  
**Test Files:**
- [`libs/events/test/m8-concurrency-fault-reconciliation.int-spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/test/m8-concurrency-fault-reconciliation.int-spec.ts)
- [`libs/events/test/m8-full-system-workflows.int-spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/test/m8-full-system-workflows.int-spec.ts)

---

## 1. 10 Distributed Fault-Injection Scenarios Verified

| Fault # | Injected Fault | Target Boundary | Expected Resilient Behavior | Observed Result |
|---|---|---|---|---|
| **Fault 1** | `Inventory` service completely down (`ECONNREFUSED` / `503`) during POS checkout | `Sales` $\rightarrow$ `Inventory` | Checkout aborts immediately with `503 STOCK_RESERVATION_UNKNOWN`; `0` orders created, `0` payments captured | **PASS** |
| **Fault 2** | `Inventory` commits reservation in DB, but HTTP response is lost (`ETIMEDOUT`) | `Sales` $\rightarrow$ `Inventory` | `CheckoutService` queries `getWarehouseReservationByKey` using `reserveIdempotencyKey`, recovers the existing `reservationId` deterministically, and completes checkout with `on_hand` deducted once (`20 -> 19`) | **PASS** |
| **Fault 3** | `Customer` loyalty hold fails after `Inventory` reservation succeeded | `Sales` $\rightarrow$ `Customer` & `Inventory` | `CheckoutService` catches loyalty failure and executes compensating `releaseReservation`; `available_qty` restored to `100%` | **PASS** |
| **Fault 4** | Payment declined after `Inventory` reservation and `Customer` loyalty hold succeeded | `Sales` $\rightarrow$ `Inventory` & `Customer` | `CheckoutService` releases both `Inventory` reservation (`RELEASED`) and `Customer` loyalty hold (`RELEASED`); `held_points = 0` | **PASS** |
| **Fault 5** | Post-payment `Inventory.confirmReservation` times out after payment capture | `Sales` $\rightarrow$ `Inventory` | Checkout session recorded as `RECONCILIATION_REQUIRED` (payment never silently dropped); subsequent confirmation retry converges `Inventory` to `CONFIRMED` | **PASS** |
| **Fault 6** | `Finance` service down (`503`) during `ON_ACCOUNT` credit checkout | `Sales` $\rightarrow$ `Finance` | Credit check fails closed (`503`); `Inventory` reservation is compensated (`RELEASED`); `0` unapproved credit orders created | **PASS** |
| **Fault 7** | Out-of-order `catalog.price.changed` event (`v5 = 350,000 VND` arrives before stale `v2 = 110,000 VND`) | `Catalog` $\rightarrow$ `Sales` | `CatalogClient.onPriceChanged` monotonic version check ignores `v2`; `Sales` projection retains `350,000.00 VND` | **PASS** |
| **Fault 8** | Marketplace webhook arrives with unmapped external SKU | `Shopee` $\rightarrow$ `Integration` | Order sync logs `SKU_MAPPING_NOT_FOUND` conflict without crashing worker; after mapping is created, `retryConflict` imports order cleanly | **PASS** |
| **Fault 9** | `Insight` consumer offline while `Sales`, `Inventory`, and `Finance` process transactions | `Outbox` $\rightarrow$ `Insight` | Events remain durable in `outbox_events`; once consumer resumes, backlog drains and `Insight` projections converge with `0` drift | **PASS** |
| **Fault 10** | Poison marketplace sync job exhausts `maxAttempts = 1` | `Integration` SyncWorker | Job transitions to `DEAD_LETTERED` and writes a diagnostic entry in `integration.dead_letter_events` (`dlqCount >= 1`), isolating the poison message | **PASS** |
