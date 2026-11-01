# M8 End-to-End Business Workflow Matrix (Workflows A–G)

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation

---

## 1. End-to-End Business Workflows Overview

All 7 end-to-end workflows are implemented and verified against real PostgreSQL in [`m8-full-system-workflows.int-spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/test/m8-full-system-workflows.int-spec.ts).

| Workflow ID | Business Scenario | Services Participating | Key Invariants Verified | Test Status |
|---|---|---|---|---|
| **Workflow A** | Merchant Onboarding, Catalog Setup & Initial Stock Receipt | `Platform`, `Catalog`, `Inventory`, `Sales`, `Insight` | Variant projected to `Inventory` & `Sales`; receipt posts `on_hand = 50.000`, `avg_cost = 180,000.00`; `Insight` inventory valuation = `9,000,000.00 VND` | **PASS** |
| **Workflow B** | Walk-in POS Cash Checkout with Loyalty Redemption & Earn | `Sales`, `Inventory`, `Customer`, `Finance`, `Insight` | Stock reserved & committed (`50 -> 48`); loyalty points held, redeemed (`-100`), and earned (`+8`); settlement & cashbook created (`840,000.00 VND`); `Insight` net revenue (`840,000`), COGS (`360,000`), gross profit (`480,000`) | **PASS** |
| **Workflow C** | Checkout Failure & Saga Compensation (Payment Declined) | `Sales`, `Inventory`, `Customer`, `Finance`, `Insight` | Payment decline triggers automatic release of `Inventory` reservation (`available_qty` restored to `48.000`) and `Customer` loyalty hold (`held_points = 0`); 0 completed orders, 0 finance settlements | **PASS** |
| **Workflow D** | Credit Sale (`ON_ACCOUNT`) & Customer Debt Repayment | `Sales`, `Customer`, `Finance`, `Inventory`, `Insight` | Credit limit checked; order completed `ON_ACCOUNT`; `Finance` AR debt increases by `1,050,000.00 VND`; partial debt payment of `450,000.00 VND` reduces balance to `600,000.00 VND` and posts cashbook inflow | **PASS** |
| **Workflow E** | Partial Sales Return, Restock, Loyalty Reversal & Refund | `Sales`, `Inventory`, `Customer`, `Finance`, `Insight` | Return of 1 unit restocks `Inventory` (`on_hand` `+1`), reverses earned loyalty points, creates `Finance` refund (`420,000.00 VND`), and updates `Insight` `returns_amount` & `returned_cogs_amount` | **PASS** |
| **Workflow F** | Marketplace Webhook Order Import, Stock Push & Cancellation | `Integration`, `Catalog`, `Inventory`, `Sales`, `Insight` | Valid Shopee HMAC webhook imports order (`SHP-ORD-M8-001`), reserves stock (`-2`), deducts safety buffer (`3`) when publishing remaining stock to Shopee; unmapped SKU webhook is quarantined without corrupting stock | **PASS** |
| **Workflow G** | Inter-Warehouse Stock Transfer & Stocktake Adjustment | `Inventory`, `Integration`, `Insight` | Transfer dispatch moves `5.000` units to `in_transit_qty`; receipt increments destination warehouse `on_hand_qty`; stocktake adjustment (`-1.000` shrinkage) updates ledger, marketplace stock push, and `Insight` valuation | **PASS** |

---

## 2. POS Checkout Saga Sequence Diagram (Diagram 4)

```mermaid
sequenceDiagram
  autonumber
  actor Cashier
  participant Sales as Sales Service (CheckoutService)
  participant Inv as Inventory Service
  participant Cust as Customer Service
  participant Fin as Finance Service
  participant Bus as Outbox / Event Bus
  participant Ins as Insight Service

  Cashier->>Sales: POST /api/v1/pos/checkout (Idempotency-Key)
  Sales->>Sales: Validate open POS Shift, Variant Price Snapshot & Coupon
  Sales->>Inv: POST /internal/reservations/reserve (ttl=900s)
  Inv-->>Sales: 201 RESERVED (reservationId, unitCostSnapshot)
  opt Customer Redeems Loyalty Points
    Sales->>Cust: POST /internal/loyalty/holds (points)
    Cust-->>Sales: 201 HELD (holdId)
  end
  alt Payment Method == ON_ACCOUNT
    Sales->>Fin: POST /internal/credit/check (customerId, grandTotal)
    Fin-->>Sales: 200 eligible=true
  end
  alt Payment Declined / Pre-Commit Error
    Sales->>Inv: POST /internal/reservations/:id/release
    Sales->>Cust: POST /internal/loyalty/holds/:id/release
    Sales-->>Cashier: 422 PAYMENT_DECLINED (Saga COMPENSATED)
  else Payment Captured
    Sales->>Inv: POST /internal/reservations/:id/confirm
    Inv-->>Sales: 200 CONFIRMED (on_hand deducted, SALE_OUT ledger)
    opt Loyalty Hold Active
      Sales->>Cust: POST /internal/loyalty/holds/:id/confirm
      Cust-->>Sales: 200 CONFIRMED (REDEEM ledger)
    end
    Sales->>Sales: Commit Order COMPLETED + Outbox (sales.order.completed)
    Sales-->>Cashier: 201 CheckoutResult (CONFIRMED)
    Sales->>Bus: Publish sales.order.completed
    Bus->>Cust: Award earned points (EARN ledger)
    Bus->>Fin: Record Settlement, Cashbook / AR Debt & Double-Entry Journal
    Bus->>Ins: Update sales_order_facts & daily_sales_summaries
  end
```

---

## 3. Sales Return & Refund Flow Sequence Diagram (Diagram 5)

```mermaid
sequenceDiagram
  autonumber
  actor Staff
  participant Sales as Sales Service (ReturnsService)
  participant Inv as Inventory Service
  participant Bus as Outbox / Event Bus
  participant Cust as Customer Service
  participant Fin as Finance Service
  participant Ins as Insight Service

  Staff->>Sales: POST /api/v1/returns (orderId, lines, refundMethod)
  Sales->>Sales: Lock Order & Validate cumulative returned_qty <= sold_qty
  opt Restockable Condition
    Sales->>Inv: POST /internal/returns/restock
    Inv-->>Sales: 200 Restocked (on_hand_qty += returnQty, RETURN_IN ledger)
  end
  Sales->>Sales: Commit Return COMPLETED + Outbox (sales.return.completed, sales.refund.requested)
  Sales-->>Staff: 201 Return Completed
  Sales->>Bus: Publish sales.return.completed & sales.refund.requested
  Bus->>Cust: Deduct proportionally earned points (RETURN_DEDUCT)
  Bus->>Fin: Create & execute RefundOperation + Cashbook REFUND_OUT / AR Credit
  Fin->>Bus: Publish finance.refund.completed
  Bus->>Ins: Update returns_amount, returned_cogs_amount & net_sales_revenue
```

---

## 4. Marketplace Order Import & Stock Push Flow (Diagram 6)

```mermaid
sequenceDiagram
  autonumber
  participant Shopee as Shopee Partner Webhook
  participant Int as Integration Service
  participant Inv as Inventory Service
  participant Sales as Sales Service
  participant Bus as Outbox / Event Bus
  participant Ins as Insight Service

  Shopee->>Int: POST /api/v1/integration/webhooks/shopee (HMAC Signature)
  Int->>Int: Verify HMAC-SHA256 + Persist WebhookEvent + Enqueue SyncJob (ORDER_IMPORT)
  Int-->>Shopee: 202 Accepted
  Int->>Int: Resolve SKU Mapping (external_item_id + external_sku_id -> internal_variant_id)
  Int->>Inv: POST /internal/reservations/reserve
  Inv-->>Int: 201 RESERVED
  Int->>Sales: POST /api/v1/orders (channel=SHOPEE, externalOrderId)
  Sales-->>Int: 201 Order Created
  Int->>Bus: Publish integration.order.imported
  Inv->>Bus: Publish inventory.stock.changed (stockVersion=N)
  Bus->>Int: InventorySyncService.recordStockChangeAndPublish(stockVersion=N)
  Int->>Shopee: Push available_qty - safety_stock_buffer (if stockVersion > lastPublishedVersion)
  Bus->>Ins: Update channel_sales_summaries & inventory_stock_projections
```

---

## 5. Insight Event Ingestion, Shadow Rebuild & Reconciliation Flow (Diagram 7)

```mermaid
sequenceDiagram
  autonumber
  participant Bus as Source Outbox Events
  participant Ins as Insight ProjectionsService
  participant Reb as Insight RebuildService
  participant Rec as Insight ReconciliationService
  participant DB as PostgreSQL (insight schema)

  Bus->>Ins: EventEnvelope (sales.*, inventory.*, finance.*, customer.*)
  Ins->>DB: Check inbox_messages (tenant_id, event_id)
  Ins->>DB: Upsert immutable fact row (sales_order_facts) & apply delta to active + building generations
  Note over Reb,DB: Zero-Downtime Shadow Rebuild
  Reb->>DB: pg_try_advisory_xact_lock(tenant_id, projection_name)
  Reb->>DB: Create shadow generation (status = BUILDING)
  Reb->>DB: Replay facts into shadow generation rows
  Reb->>DB: Atomic cutover: old -> RETIRING, shadow -> ACTIVE
  Note over Rec,DB: Automated Reconciliation
  Rec->>DB: Compare daily_sales_summaries (ACTIVE) vs sales_order_facts & return_facts
  Rec-->>Rec: Return MATCHED (0 drift) or COMPLETED_WITH_ISSUES (drift details)
```
