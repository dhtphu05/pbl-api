# Runbook C — Loyalty Hold Stuck (`HELD` Beyond Order Lifecycle)

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `CustomerLoyaltyHoldStuck` |
| **Owner Service** | `customer` (`apps/customer`) |
| **Database Schema** | `customer.loyalty_point_holds`, `customer.loyalty_accounts`, `customer.loyalty_transactions` |
| **Severity** | `SEV-2` (Customer loyalty points remain locked in `held_points` and cannot be redeemed on new orders) |
| **SLO Impact** | Customer loyalty balance accuracy |

---

## 2. Symptoms & Detection

- `customer.loyalty_point_holds` has records with `status = 'HELD'` and `expires_at < NOW()`.
- Customer reports missing redeemable points (`available_points = current_points - held_points` is lower than expected).

---

## 3. Diagnostic SQL Queries

```sql
-- 1. Find expired or orphaned loyalty holds
SELECT
  h.id AS hold_id,
  h.tenant_id,
  h.customer_id,
  h.order_id,
  h.points,
  h.status,
  h.expires_at,
  a.current_points,
  a.held_points
FROM customer.loyalty_point_holds h
JOIN customer.loyalty_accounts a
  ON a.tenant_id = h.tenant_id
 AND a.customer_id = h.customer_id
WHERE h.status = 'HELD'
  AND h.expires_at < NOW()
ORDER BY h.expires_at ASC;

-- 2. Verify account balance vs ledger sum invariant
SELECT
  a.tenant_id,
  a.customer_id,
  a.current_points,
  COALESCE(SUM(t.points_delta), 0) AS ledger_sum
FROM customer.loyalty_accounts a
LEFT JOIN customer.loyalty_transactions t
  ON t.tenant_id = a.tenant_id
 AND t.customer_id = a.customer_id
GROUP BY a.tenant_id, a.customer_id, a.current_points
HAVING a.current_points <> COALESCE(SUM(t.points_delta), 0);
```

---

## 4. Root Cause Triage

1. **Order Checkout Abandoned or Timed Out**:
   - `sales-service` placed a point hold via `POST /api/v1/internal/loyalty/holds`, then crashed or timed out before releasing the hold.
2. **Order Completed Without Hold Confirmation**:
   - Check `sales.orders` by `order_id` to see whether the associated order is `COMPLETED` or `CANCELLED`.

---

## 5. Remediation Steps

1. Cross-reference `order_id` in `sales.orders`:
   - **If `sales.orders.status = 'COMPLETED'`**:
     Invoke `LoyaltyService.confirmHold(tenantId, holdId, idempotencyKey)` to convert the hold into a `REDEEM` ledger entry and deduct both `current_points` and `held_points`.
   - **If `sales.orders.status = 'CANCELLED'` or order does not exist**:
     Invoke `LoyaltyService.releaseHold(tenantId, holdId, idempotencyKey)` to transition the hold to `'RELEASED'` and decrement `held_points` without changing `current_points`.
2. Re-run Diagnostic Query #2 to verify `current_points = SUM(points_delta)` and `held_points >= 0`.
