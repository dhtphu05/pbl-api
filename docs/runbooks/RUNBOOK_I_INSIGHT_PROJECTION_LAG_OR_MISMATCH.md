# Runbook I — Insight Projection Lag or Reconciliation Mismatch

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `InsightProjectionLagHigh` / `InsightReconciliationMismatchDetected` |
| **Owner Service** | `insight` (`apps/insight`) |
| **Database Schema** | `insight.daily_sales_summaries`, `insight.sales_order_facts`, `insight.inventory_stock_projections`, `insight.projection_generations`, `insight.reconciliation_runs` |
| **Severity** | `SEV-2` (Analytics dashboard metrics stale or diverging from authoritative source services) |
| **SLO Impact** | Dashboard freshness SLA (`p95 < 5s`) & analytical accuracy (`0 VND` drift) |

---

## 2. Symptoms & Detection

- `insight.reconciliation_runs` reports `status = 'DISCREPANCY_FOUND'` and `discrepancies_found > 0`.
- `insight.projection_checkpoints` shows `last_event_occurred_at` lagging behind current time during active business hours.

---

## 3. Diagnostic SQL Queries

```sql
-- 1. Inspect latest reconciliation runs and discrepancies
SELECT
  id,
  tenant_id,
  scope,
  from_date,
  to_date,
  status,
  discrepancies_found,
  discrepancy_details,
  created_at
FROM insight.reconciliation_runs
WHERE discrepancies_found > 0
ORDER BY created_at DESC
LIMIT 20;

-- 2. Inspect active projection generations and rebuild status
SELECT
  id,
  tenant_id,
  projection_name,
  generation_number,
  status,
  events_processed,
  started_at,
  activated_at
FROM insight.projection_generations
ORDER BY created_at DESC
LIMIT 20;
```

---

## 4. Root Cause Triage

1. **Undrained Source Outboxes**:
   - Check if `sales.outbox_events`, `inventory.outbox_events`, or `finance.outbox_events` has a backlog of `PENDING` events.
2. **Out-of-Order / Late Cost Event (`PENDING` COGS)**:
   - Orders completed before `inventory` published weighted average cost (`cost_status = 'PENDING'`).
3. **Manual Data Mutation or Corrupted Summary Row**:
   - Detected by `InsightReconciliationService.executeReconciliation`.

---

## 5. Remediation Steps

1. **Drain Any Pending Outbox Events**:
   - Ensure all source outboxes (`sales`, `inventory`, `finance`, `customer`, `integration`) have `PENDING = 0`.
2. **Trigger Zero-Downtime Shadow Generation Rebuild**:
   - Invoke `RebuildService.triggerRebuild`:
     ```json
     POST /api/v1/insight/admin/rebuild
     {
       "projectionName": "sales_analytics",
       "fromDate": "2026-10-01",
       "toDate": "2026-10-31",
       "reason": "Runbook I reconciliation recovery"
     }
     ```
   - `RebuildService` acquires a PostgreSQL transaction-scoped advisory lock (`pg_try_advisory_xact_lock`), builds a new shadow generation from `insight.sales_order_facts` / source events, and atomically flips `projection_generations.status = 'ACTIVE'` while retiring the old generation (`RETIRING`).
3. **Re-Run Reconciliation Verification**:
   - Invoke `POST /api/v1/insight/admin/reconcile` for scope `'SALES'` and verify `discrepanciesFound = 0` and `status = 'MATCHED'`.
