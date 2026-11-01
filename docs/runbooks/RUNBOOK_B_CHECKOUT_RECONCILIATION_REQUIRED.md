# Runbook B — Checkout `RECONCILIATION_REQUIRED` (`CheckoutService`)

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `SalesCheckoutReconciliationRequiredDetected` |
| **Owner Service** | `sales` (`apps/sales`) |
| **Database Schema** | `sales.orders`, `sales.checkout_sagas`, `inventory.stock_reservations`, `finance.sales_financial_records` |
| **Severity** | `SEV-1` (Customer payment captured or stock deducted, but post-commit step partially failed) |
| **SLO Impact** | Checkout completion integrity & financial/stock consistency |

---

## 2. Symptoms & Detection

- `sales.checkout_sagas` contains rows with `status = 'RECONCILIATION_REQUIRED'`.
- `sales.orders` has an order stuck in `PENDING_PAYMENT` or `COMPLETED` with missing downstream confirmation (`reservation_id` still `RESERVED` in `inventory`, or loyalty hold still `HELD` in `customer`).
- Alert triggered on log event `Checkout saga entered RECONCILIATION_REQUIRED`.

---

## 3. Diagnostic SQL Queries

```sql
-- 1. List all checkout sagas requiring reconciliation
SELECT
  id,
  tenant_id,
  order_id,
  idempotency_key,
  status,
  current_step,
  reservation_id,
  loyalty_hold_id,
  payment_tx_id,
  failure_reason,
  compensation_log,
  created_at,
  updated_at
FROM sales.checkout_sagas
WHERE status IN ('RECONCILIATION_REQUIRED', 'COMPENSATING')
ORDER BY updated_at DESC;

-- 2. Cross-check corresponding order state in sales.orders
SELECT
  id,
  order_number,
  status,
  payment_status,
  fulfillment_status,
  grand_total,
  reservation_id,
  loyalty_hold_id
FROM sales.orders
WHERE id = '<order_id>';
```

---

## 4. Root Cause Triage

A checkout saga transitions to `RECONCILIATION_REQUIRED` in two situations:
1. **Pre-Payment Failure + Compensation Failure**:
   - Payment failed (`PAYMENT_DECLINED` or timeout), and the compensating release call (`inventory.releaseReservation` or `customer.releasePointsHold`) threw an unhandled error after retries.
2. **Post-Payment Confirmation Failure**:
   - Payment succeeded (`payment_tx_id` is populated), so payment cannot be silently rolled back, but `inventory.confirmReservation` or `customer.confirmPointsHold` timed out.

---

## 5. Remediation Steps

### Case A: Payment Did NOT Succeed (`payment_tx_id IS NULL`)

1. Verify with payment provider / `finance` that no funds were captured.
2. Release any remaining `RESERVED` stock reservation in `inventory` (`ReservationsService.releaseReservation(tenantId, reservationId, idempotencyKey)`).
3. Release any remaining `HELD` loyalty hold in `customer` (`LoyaltyService.releaseHold(tenantId, holdId, idempotencyKey)`).
4. Update `sales.checkout_sagas.status = 'COMPENSATED_FAILED'` and verify `sales.orders.status = 'CANCELLED'`.

### Case B: Payment DID Succeed (`payment_tx_id IS NOT NULL`)

1. Confirm the inventory reservation in `inventory`:
   - Invoke `ReservationsService.confirmReservation(tenantId, reservationId, idempotencyKey)`.
2. Confirm the loyalty points hold in `customer` (if `loyalty_hold_id IS NOT NULL`):
   - Invoke `LoyaltyService.confirmHold(tenantId, holdId, idempotencyKey)`.
3. Verify `sales.orders` has `status = 'COMPLETED'`, `payment_status = 'PAID'`, `fulfillment_status = 'FULFILLED'`.
4. Verify `sales.outbox_events` emitted `sales.order.completed` so `finance` and `insight` projections converge.
5. Mark `sales.checkout_sagas.status = 'COMPLETED'`.

---

## 6. Verification

Run Cross-Service Reconciliation Pair 1 (`Sales <-> Inventory`) and Pair 2 (`Sales <-> Finance`) to confirm zero discrepancy.
