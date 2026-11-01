# Runbook H — Dead-Letter Queue (DLQ) Growth (`outbox_events` / `dead_letter_events`)

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `ServiceDeadLetterQueueNonZero` |
| **Owner Service** | Platform-wide (`libs/events`, `integration`, `insight`, all 7 outbox schemas) |
| **Database Schema** | `<service>.outbox_events`, `integration.dead_letter_events`, `insight.dead_letter_events`, SQS `*-dlq` |
| **Severity** | `SEV-2` (Asynchronous domain events or marketplace jobs failed after maximum retry attempts) |
| **SLO Impact** | Eventual consistency convergence across bounded contexts |

---

## 2. Symptoms & Detection

- SQS queue `sapoclone-events-dlq` has `ApproximateNumberOfMessagesVisible > 0`.
- Service `outbox_events` has rows with `status = 'FAILED'` or `attempts >= 5`.
- `integration.dead_letter_events` or `insight.dead_letter_events` has rows with `status = 'PENDING_REVIEW'`.

---

## 3. Diagnostic SQL Queries

```sql
-- 1. Check failed outbox events across service schemas
SELECT 'catalog' AS service, COUNT(*) AS failed_count FROM catalog.outbox_events WHERE status = 'FAILED'
UNION ALL
SELECT 'inventory', COUNT(*) FROM inventory.outbox_events WHERE status = 'FAILED'
UNION ALL
SELECT 'sales', COUNT(*) FROM sales.outbox_events WHERE status = 'FAILED'
UNION ALL
SELECT 'customer', COUNT(*) FROM customer.outbox_events WHERE status = 'FAILED'
UNION ALL
SELECT 'finance', COUNT(*) FROM finance.outbox_events WHERE status = 'FAILED'
UNION ALL
SELECT 'integration', COUNT(*) FROM integration.outbox_events WHERE status = 'FAILED';

-- 2. Inspect Integration & Insight application DLQ records
SELECT
  id,
  tenant_id,
  event_id,
  event_type,
  error_message,
  retry_count,
  created_at
FROM insight.dead_letter_events
ORDER BY created_at DESC
LIMIT 50;
```

---

## 4. Root Cause Triage

1. **Schema / Contract Mismatch (`ValidationError`)**:
   - Producer emitted an event missing a required field expected by the consumer.
2. **Downstream Transient Infrastructure Outage**:
   - Target database or external partner API was unreachable longer than the exponential backoff window.

---

## 5. Remediation Steps

1. **Inspect Error Payload & Stack Trace**:
   - Query `error_message` and `payload` from `dead_letter_events`.
2. **Deploy Hotfix (If Code/Contract Defect)**:
   - Fix consumer handler while preserving backward compatibility.
3. **Replay Dead-Lettered Events Safely**:
   - Reset `outbox_events`:
     ```sql
     UPDATE <service>.outbox_events
     SET status = 'PENDING',
         attempts = 0,
         next_attempt_at = NOW(),
         locked_by = NULL,
         locked_at = NULL
     WHERE status = 'FAILED'
       AND id = '<event_uuid>';
     ```
   - Because all consumers use `processed_events` / `inbox_messages` idempotency (`(tenant_id, event_id, consumer_name)`), replaying an event that already succeeded on some consumers will be safely skipped by those consumers and only applied where needed.
