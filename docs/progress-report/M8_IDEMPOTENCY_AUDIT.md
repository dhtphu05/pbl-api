# M8 Idempotency Audit — Commands, Webhooks, S2S & Event Consumers

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation

---

## 1. End-to-End Idempotency Matrix

Every state-mutating entrypoint across all 8 microservices enforces deterministic idempotency backed by PostgreSQL unique constraints:

| Service | Operation / Endpoint | Idempotency Key Scope | Storage Table & Unique Constraint | Behavior on Duplicate Replay | Verified In |
|---|---|---|---|---|---|
| **Catalog** | Create Product / Variant | `(tenant_id, sku_code)` | `catalog.product_variants` `UQ_variant_tenant_sku` | Rejects conflicting concurrent SKU creation with `409 Conflict` | Concurrency 1 |
| **Inventory** | Create / Post Stock Receipt | `(tenant_id, idempotency_key)` | `inventory.inventory_receipts` | Returns existing receipt without double-incrementing `on_hand_qty` | Workflow A, Concurrency 5 |
| **Inventory** | Reserve / Confirm / Release Stock | `(tenant_id, warehouse_id, idempotency_key)` | `inventory.stock_reservations` | Returns existing `reservationId` & status; never double-locks or double-deducts | Workflow B, Concurrency 3 & 4, Fault 2 |
| **Inventory** | Restock Sales Return | `(tenant_id, reference_id, sku_id)` | `inventory.stock_movements` (`RETURN_IN`) | Returns existing movement; prevents double restock | Workflow E |
| **Sales** | POS Checkout (`POST /pos/checkout`) | `(tenant_id, idempotency_key)` | `sales.checkout_sessions` | Returns cached `CheckoutResult`; payload mismatch returns `409 IDEMPOTENCY_CONFLICT` | Workflow B, Fault 2 |
| **Sales** | Sales Return (`POST /returns`) | `(tenant_id, idempotency_key)` + per-line `returned_qty <= sold_qty` | `sales.sales_returns` | Concurrent returns exceeding remaining returnable qty rejected (`422`) | Workflow E |
| **Customer** | Hold / Confirm / Release Loyalty Points | `(tenant_id, idempotency_key)` | `customer.loyalty_point_holds` | Returns existing hold record; never double-holds or double-redeems | Workflow C |
| **Customer** | Award Loyalty Points (`sales.order.completed`) | `(tenant_id, reference_type, reference_id, type)` | `customer.loyalty_transactions` | Duplicate event delivery is a no-op (`points_delta` applied once) | Workflow B & G |
| **Finance** | Record Order Settlement (`sales.order.completed`) | `(tenant_id, order_id)` | `finance.payment_settlements` | Duplicate `sales.order.completed` event creates exactly 1 settlement & 1 journal entry | Workflow B & D |
| **Finance** | Process Refund (`sales.refund.requested`) | `(tenant_id, idempotency_key)` | `finance.refund_operations` | 10x concurrent duplicate `sales.refund.requested` deliveries produce exactly 1 refund payout | Concurrency 14 |
| **Finance** | Record Debt Payment (`POST /debts/payments`) | `(tenant_id, idempotency_key)` | `finance.debt_payments` | Returns existing payment record; prevents double AR deduction | Workflow D |
| **Integration** | Ingest Marketplace Webhook | `(tenant_id, channel, webhook_id)` & `(tenant_id, connection_id, external_order_id)` | `integration.webhook_events`, `integration.marketplace_order_sync_logs` | 100x duplicate Shopee webhook replay produces 1 imported order and 1 reservation | Workflow F |
| **Insight** | Analytical Event Ingestion | `(tenant_id, event_id)` + `(tenant_id, order_id)` | `insight.inbox_messages`, `insight.sales_order_facts` | 100x duplicate event replay produces 0 metric inflation (`0.0000 VND` drift) | Workflow G |
