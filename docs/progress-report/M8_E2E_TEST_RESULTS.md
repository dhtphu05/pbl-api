# M8 End-to-End Integration Test Results (Workflows A–G)

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation  
**Test File:** [`libs/events/test/m8-full-system-workflows.int-spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/test/m8-full-system-workflows.int-spec.ts)  
**Database Engine:** Real PostgreSQL (`localhost:25432`, isolated schemas across all 7 domain services)

---

## 1. Execution Summary

```text
PASS libs/events/test/m8-full-system-workflows.int-spec.ts (10.314 s)
  M8 Full-System Distributed Workflows A through G (Real PostgreSQL Across 7 Service Schemas)
    ✓ Workflow A: Executes complete 7-service retail lifecycle from Catalog SKU creation through POS sale, Finance journal, Customer loyalty, Insight rollup & Integration stock sync (557 ms)
    ✓ Workflow B: 100 concurrent checkout attempts for 1 unit against 10 units in stock -> exact 10 succeed, 90 fail with INSUFFICIENT_STOCK, zero negative stock (771 ms)
    ✓ Workflow C: Concurrent 80-point redemptions against 100-point balance (1 succeeds, 1 rejected) + 5 failure-injection recovery stages (1068 ms)
    ✓ Workflow D: Credit limit 1,000,000 VND with two concurrent 800,000 VND credit sales -> 1 succeeds, 1 rejected; partial 300,000 VND collection; Finance outage fails closed (503) (661 ms)
    ✓ Workflow E: Partial return of 2/5 units restocks inventory, claws back loyalty points, posts refund & adjusts Insight; concurrent conflicting returns for remaining 3 allow only 1 winner (571 ms)
    ✓ Workflow F: Omnichannel order import, 100x duplicate webhook replay, unmapped SKU conflict & resolution, shortage hold, and lost-response recovery (513 ms)
    ✓ Workflow G: Insight processes 100x duplicate event replay idempotently, catches up after consumer downtime, and deterministically rebuilds projections to match source truth (644 ms)

Test Suites: 1 passed, 1 total
Tests:       7 passed, 7 total
```

---

## 2. Detailed Workflow Verification Evidence

| Workflow | Key Assertions Verified Against Real PostgreSQL | Measured Duration | Result |
|---|---|---|---|
| **Workflow A** | Catalog variant `SKU-M8-AO-POLO-01` (`250,000 VND`) projected to `Inventory` & `Sales`; receipt of `50` units @ `120,000 VND` cost; POS cash checkout for `2` units (`500,000 VND`); `Inventory` `on_hand = 48.000`; `Customer` loyalty `+5` pts; `Finance` settlement & balanced journal (`500,000 VND`); `Insight` `net_sales_revenue = 500,000`, `cogs_amount = 240,000`, `gross_profit = 260,000`; `Integration` Shopee stock push `45` (`48 - 3` buffer) | `557 ms` | **PASS** |
| **Workflow B** | `10` units received; `100` concurrent POS checkouts (`Promise.allSettled`) for `1` unit each; exactly `10` succeed, `90` fail with `409 INSUFFICIENT_STOCK`; final `on_hand = 0.000`, `reserved = 0.000`, `available = 0.000`; `stock_movements` sum = `0` | `771 ms` | **PASS** |
| **Workflow C** | Customer seeded with `100` pts; two concurrent `80`-pt redemptions $\rightarrow$ `1` succeeds, `1` rejected (`409`); 5 failure stages verified: loyalty hold failure releases stock, payment decline releases stock + loyalty hold, post-payment confirm timeout flags `RECONCILIATION_REQUIRED` and forward-recovers, expired reservation swept cleanly | `1068 ms` | **PASS** |
| **Workflow D** | Customer credit limit `1,000,000 VND`; two concurrent `800,000 VND` `ON_ACCOUNT` checkouts $\rightarrow$ `1` succeeds, `1` rejected (`422 CREDIT_LIMIT_EXCEEDED`); partial debt payment of `300,000 VND` reduces AR balance to `500,000 VND`; `Finance` outage during credit check fails closed (`503`) and releases stock | `661 ms` | **PASS** |
| **Workflow E** | Order of `5` units (`1,000,000 VND`); partial return of `2` units restocks `Inventory` (`+2`), claws back `4` loyalty pts, creates `400,000 VND` refund, and updates `Insight` returns; two concurrent returns for `3` units each against remaining `3` returnable units $\rightarrow$ `1` succeeds, `1` rejected (`422`) | `571 ms` | **PASS** |
| **Workflow F** | Shopee HMAC-signed webhook imports order (`2` units), `100x` duplicate webhook replay creates `1` order & `1` reservation; unmapped SKU webhook creates `SKU_MAPPING_NOT_FOUND` conflict and recovers after mapping creation; shortage order transitions to `ON_HOLD_SHORTAGE` | `513 ms` | **PASS** |
| **Workflow G** | `100x` duplicate delivery of `sales.order.completed` to `Insight` results in `0` duplicate revenue (`0.0000 VND` drift); consumer downtime backlog drains and catches up; shadow generation rebuild (`triggerRebuild`) + `executeReconciliation` confirms `0` discrepancies | `644 ms` | **PASS** |
