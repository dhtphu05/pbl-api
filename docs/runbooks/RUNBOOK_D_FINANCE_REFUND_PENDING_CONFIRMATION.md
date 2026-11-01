# Runbook D — Finance Refund Pending Confirmation (`PROCESSING` / `FAILED`)

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `FinanceRefundPendingConfirmation` |
| **Owner Service** | `finance` (`apps/finance`) |
| **Database Schema** | `finance.refund_records`, `finance.cashbook_entries`, `finance.customer_debt_ledgers` |
| **Severity** | `SEV-2` (Customer return processed in `sales`, but financial refund disbursement or AR reversal is delayed) |
| **SLO Impact** | Financial settlement SLA & cashbook/debt accuracy |

---

## 2. Symptoms & Detection

- `finance.refund_records` contains rows with `status IN ('INITIATED', 'PROCESSING', 'FAILED')` older than 15 minutes.
- `sales.sales_returns` shows `status = 'COMPLETED'`, and `inventory` has restocked the returned items (`RETURN_IN`), but the customer refund receipt or debt reduction is not yet reflected in `finance`.

---

## 3. Diagnostic SQL Queries

```sql
-- 1. Inspect pending or failed refund records
SELECT
  id,
  tenant_id,
  branch_id,
  return_id,
  order_id,
  customer_id,
  amount,
  refund_method,
  status,
  failure_reason,
  idempotency_key,
  created_at,
  updated_at
FROM finance.refund_records
WHERE status IN ('INITIATED', 'PROCESSING', 'FAILED')
ORDER BY created_at ASC;

-- 2. Check if cashbook entry or debt reduction was already created for this return_id
SELECT *
FROM finance.cashbook_entries
WHERE reference_type = 'SALES_RETURN'
  AND reference_id = '<return_id>';
```

---

## 4. Root Cause Triage

1. **External Payment Gateway Timeout**:
   - Refund via card/e-wallet timed out awaiting gateway confirmation.
2. **Outbox/Consumer Delay on `sales.return.completed`**:
   - Event `sales.return.completed` was emitted by `sales-service` but not yet processed by `finance-service`.

---

## 5. Remediation Steps

1. **Check Gateway Status**:
   - Query the payment provider with `idempotency_key` (`refund:<tenant_id>:<return_id>`).
2. **Replay Idempotent Refund Handler**:
   - Re-invoke `RefundsService.processReturnCompleted(tenantId, payload)` with the original `returnId` and `idempotencyKey`.
   - Because `RefundsService` enforces `(tenant_id, idempotency_key)` uniqueness, re-execution safely transitions `FAILED` / `INITIATED` records to `COMPLETED` and appends the `REFUND_OUT` cashbook entry or `RETURN_CREDIT` debt ledger entry without double-refunding.
3. **Verify `Insight` Convergence**:
   - Confirm `finance.refund.completed` is published to `finance.outbox_events` and ingested into `insight.daily_sales_summary`.
