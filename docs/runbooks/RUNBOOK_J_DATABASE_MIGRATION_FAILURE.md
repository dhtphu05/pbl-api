# Runbook J — Database Migration Failure or Schema Drift

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `DatabaseMigrationFailed` |
| **Owner Service** | Platform-wide (All 8 bounded-context schemas) |
| **Database Schema** | `platform`, `catalog`, `inventory`, `sales`, `customer`, `finance`, `integration`, `insight` |
| **Severity** | `SEV-1` (Deployment blocked or service startup failing due to schema mismatch) |
| **SLO Impact** | Service availability & deployment pipeline integrity |

---

## 2. Symptoms & Detection

- CI/CD migration step or container startup fails with `QueryFailedError` during TypeORM `runMigrations()`.
- Service health check `/health/readiness` returns `503 Service Unavailable`.

---

## 3. Diagnostic SQL Queries

```sql
-- 1. Check applied migrations in a specific service schema
SELECT id, "timestamp", name
FROM sales.migrations
ORDER BY "timestamp" DESC
LIMIT 20;

-- 2. Check for active DDL locks or blocking queries
SELECT
  pid,
  usename,
  state,
  wait_event_type,
  wait_event,
  age(clock_timestamp(), query_start) AS duration,
  query
FROM pg_stat_activity
WHERE state <> 'idle'
  AND pid <> pg_backend_pid()
ORDER BY duration DESC;
```

---

## 4. Root Cause Triage

1. **Lock Timeout During `ALTER TABLE`**:
   - Long-running analytical or reporting query held an `ACCESS SHARE` lock while migration attempted `ACCESS EXCLUSIVE` lock.
2. **Constraint Violation on Existing Data**:
   - Adding a `CHECK` or `UNIQUE` constraint failed because legacy rows violated the new constraint.
3. **Missing Schema Search Path**:
   - Migration executed with unqualified table names while `search_path` did not match the target service schema.

---

## 5. Remediation Steps

1. **Verify Transaction Rollback**:
   - All TypeORM migrations in SapoClone run inside a transaction (`transaction: 'all'`). Verify in `<schema>.migrations` that the failed migration was rolled back cleanly.
2. **Terminate Blocking Queries (If Lock Contention)**:
   - Use `SELECT pg_cancel_backend(<pid>);` for stuck read queries blocking DDL.
3. **Pre-Validate Data Before Constraint Addition**:
   - Run a `SELECT` check for violating rows and backfill/normalize data inside the migration before adding `NOT NULL`, `CHECK`, or `UNIQUE` constraints.
4. **Re-Run Migration & Verify RLS Policies**:
   - Confirm `rowsecurity = true` and `forcerowsecurity = true` on all tenant-scoped tables after migration completion:
     ```sql
     SELECT schemaname, tablename, rowsecurity, forcerowsecurity
     FROM pg_tables
     WHERE schemaname IN ('catalog', 'inventory', 'sales', 'customer', 'finance', 'integration', 'insight')
     ORDER BY schemaname, tablename;
     ```
