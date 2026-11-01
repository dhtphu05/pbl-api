# M8 20-Scenario Concurrency Test Matrix Results

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation  
**Test Files:**
- [`libs/events/test/m8-concurrency-fault-reconciliation.int-spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/test/m8-concurrency-fault-reconciliation.int-spec.ts)
- [`libs/events/test/m8-full-system-workflows.int-spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/test/m8-full-system-workflows.int-spec.ts)

---

## 1. Complete 20-Scenario Concurrency Matrix Verification

| # | Concurrency Race Scenario | Contending Operations | Locking / Concurrency Control Mechanism | Observed Outcome on Real PostgreSQL | Status |
|---|---|---|---|---|---|
| **C1** | Concurrent duplicate SKU creation | Two requests creating `SKU-RACE-C1` in same tenant | Unique index `UQ_variant_tenant_sku` | `1` succeeds, `1` rejected with `409 Conflict` | **PASS** |
| **C2** | Price update during active POS checkout | `Catalog` price updated while `Sales` checkout is in flight | Order line snapshots unit price at quote/checkout time | Completed order preserves quoted price snapshot | **PASS** |
| **C3** | Reservation confirmation vs expiration sweep | `confirmReservation` racing against `expireReservations` on expired TTL | `SELECT ... FOR UPDATE` on `stock_reservations` & `inventory_balances` | Exactly 1 state transition wins (`CONFIRMED` or `EXPIRED`); `reserved_qty = 0`, never negative | **PASS** |
| **C4** | High-contention stock checkout (`100` vs `10`) | `100` concurrent checkouts for `1` unit with `10` on hand | `SELECT ... FOR UPDATE` on `inventory.inventory_balances` | `10` succeed, `90` fail (`409 INSUFFICIENT_STOCK`), `on_hand = 0` | **PASS** |
| **C5** | Stock receipt post vs POS checkout | `ReceivingService.postReceipt` (`+5`) racing with `CheckoutService` (`-3`) on `5` initial units | Row lock on `inventory_balances` serializes mutations | Both succeed; final `on_hand_qty = 7.000` (`5 + 5 - 3`) | **PASS** |
| **C6** | Stocktake freeze/submit vs POS sale | Stocktake variance (`8` counted) vs POS sale (`-2`) | Row lock on `inventory_balances` + ledger delta | Ledger and balance remain strictly consistent | **PASS** |
| **C7** | Transfer dispatch vs POS checkout for last units | `TransfersService.dispatchTransfer` (`4` units) vs `CheckoutService` (`4` units) with `5` units available | Row lock on source warehouse `inventory_balances` | `1` succeeds, `1` rejected (`409`); remaining `available_qty = 1.000` | **PASS** |
| **C8** | POS shift close vs late checkout | `ShiftsService.closeShift` followed by checkout referencing closed `shiftId` | Shift status check (`status === 'OPEN'`) | Late checkout rejected (`409 SHIFT_NOT_OPEN`) | **PASS** |
| **C9** | Single-use coupon concurrent redemption | Two concurrent checkouts redeeming `COUPON-SINGLE-C9` (`maxUses = 1`) | `SELECT ... FOR UPDATE` on `sales.coupons` | `1` succeeds, `1` rejected (`422 COUPON_USAGE_LIMIT_EXCEEDED`) | **PASS** |
| **C10** | Loyalty point redemption race | Two concurrent `80`-pt holds against `100`-pt balance | `SELECT ... FOR UPDATE` on `customer.loyalty_accounts` | `1` succeeds, `1` rejected (`409 INSUFFICIENT_POINTS`) | **PASS** |
| **C11** | Duplicate customer phone creation (`0908887766` vs `+84908887766`) | Two concurrent `createCustomer` calls with equivalent Vietnamese phones | `VietnamesePhoneNumber` normalization + unique index `(tenant_id, phone_normalized)` | `1` succeeds, `1` rejected (`409 Conflict`) | **PASS** |
| **C12** | Concurrent credit sales exceeding credit limit | Two `800,000 VND` credit sales against `1,000,000 VND` limit | `SELECT ... FOR UPDATE` on `finance.customer_debt_accounts` | `1` succeeds, `1` rejected (`422 CREDIT_LIMIT_EXCEEDED`) | **PASS** |
| **C13** | Customer debt payment vs credit sale | `recordDebtPayment` (`-300,000`) vs credit balance updates | Row lock on `customer_debt_accounts` + append-only ledger | Exact balance `500,000 VND`, `0` lost updates | **PASS** |
| **C14** | `10x` concurrent duplicate `sales.refund.requested` events | `10` parallel deliveries of identical refund event to `Finance` | Unique constraint on `(tenant_id, idempotency_key)` in `finance.refund_operations` | Exactly `1` refund created and executed | **PASS** |
| **C15** | Concurrent conflicting returns on same order | Two concurrent returns for `3` units each when only `3` units remain returnable | `SELECT ... FOR UPDATE` on `sales.orders` during return validation | `1` succeeds, `1` rejected (`422`) | **PASS** |
| **C16** | `100x` duplicate marketplace order webhook | `100` concurrent Shopee webhook deliveries for same `ordersn` | Unique index on `(tenant_id, connection_id, external_order_id)` | `1` internal order created, `1` stock reservation | **PASS** |
| **C17** | SKU mapping creation & conflict retry | Concurrent mapping resolution for unmapped marketplace order | Unique index on `(tenant_id, connection_id, external_item_id, external_sku_id)` | Deterministic resolution without duplicate order import | **PASS** |
| **C18** | Out-of-order outbound stock publication (`v5` before `v3`) | `stockVersion = 5` published before stale `stockVersion = 3` | Monotonic version guard in `InventorySyncService` | `v5` (`SUCCEEDED`) preserved; stale `v3` marked `STALE_SKIPPED` | **PASS** |
| **C19** | `100x` duplicate analytical event delivery to `Insight` | `100` deliveries of `sales.order.completed` | `(tenant_id, event_id)` inbox + `(tenant_id, order_id)` fact upsert | `0` duplicate revenue (`0.0000 VND` drift) | **PASS** |
| **C20** | Concurrent `Insight` projection rebuilds | Rebuild triggered on `(tenant_id, 'sales_analytics')` | `pg_try_advisory_xact_lock` + atomic shadow generation swap | Serialized cleanly without corrupting active dashboard reads | **PASS** |
