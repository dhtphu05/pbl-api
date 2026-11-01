# Runbook A — Inventory Reservation Stuck (`RESERVED` Beyond TTL)

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `InventoryReservationExpiredBacklogHigh` |
| **Owner Service** | `inventory` (`apps/inventory`) |
| **Database Schema** | `inventory.stock_reservations`, `inventory.inventory_balances` |
| **Severity** | `SEV-2` (Stock artificially locked; prevents legitimate POS or Marketplace sales) |
| **SLO Impact** | Stock availability accuracy & order checkout conversion rate |

---

## 2. Symptoms & Detection

- `inventory.stock_reservations` contains rows with `status = 'RESERVED'` and `expires_at < NOW() - INTERVAL '5 minutes'`.
- `inventory.inventory_balances.reserved_qty` remains elevated while no active checkout or marketplace hold exists in `sales.orders` or `integration.marketplace_order_Sync_logs`.
- POS cashiers or e-commerce buyers receive `409 Conflict` (`INSUFFICIENT_AVAILABLE_STOCK`) despite physical stock (`on_hand_qty`) being available in the warehouse.

---

## 3. Diagnostic SQL Queries

Run against the `inventory` schema (ensure `SET app.current_tenant = '<tenant_uuid>';` is set for tenant-scoped inspection):

```sql
-- 1. Count stuck reservations by tenant and warehouse
SELECT
  tenant_id,
  warehouse_id,
  COUNT(*) AS stuck_count,
  SUM(quantity) AS total_locked_qty,
  MIN(expires_at) AS oldest_expired_at
FROM inventory.stock_reservations
WHERE status = 'RESERVED'
  AND expires_at < NOW()
GROUP BY tenant_id, warehouse_id
ORDER BY stuck_count DESC;

-- 2. Inspect specific stuck reservation records and idempotency keys
SELECT
  id,
  tenant_id,
  warehouse_id,
  sku_id,
  quantity,
  status,
  expires_at,
  idempotency_key,
  reference_id,
  created_at
FROM inventory.stock_reservations
WHERE status = 'RESERVED'
  AND expires_at < NOW()
ORDER BY expires_at ASC
LIMIT 50;
```

---

## 4. Root Cause Triage

1. **Expiration Sweeper Cron Paused or Failing**:
   - Check `ReservationsService.expireReservations` logs in `inventory-service`.
   - Verify database connectivity and lock contention on `inventory.inventory_balances`.
2. **Checkout Saga Crash Before Release**:
   - `sales-service` crashed after `reserveStock` succeeded and before `releaseReservation` or `confirmReservation` could run.
   - This is expected to be cleaned up automatically by `expireReservations(tenantId)` once `expires_at < NOW()`.

---

## 5. Remediation Steps

### Step 1: Trigger Application-Level Expiration Sweep (Preferred)

Invoke the internal expiration sweep or run the service method via admin/maintenance CLI so domain events (`inventory.reservation.expired`) and stock movement ledger entries (`EXPIRATION`) are properly recorded:

```sql
-- Verify that releasing the expired reservations will not push reserved_qty negative
SELECT
  b.warehouse_id,
  b.sku_id,
  b.on_hand_qty,
  b.reserved_qty,
  b.available_qty,
  COALESCE(SUM(r.quantity), 0) AS expired_reserved_qty
FROM inventory.inventory_balances b
JOIN inventory.stock_reservations r
  ON r.tenant_id = b.tenant_id
 AND r.warehouse_id = b.warehouse_id
 AND r.sku_id = b.sku_id
WHERE r.status = 'RESERVED'
  AND r.expires_at < NOW()
GROUP BY b.warehouse_id, b.sku_id, b.on_hand_qty, b.reserved_qty, b.available_qty;
```

### Step 2: Verify Balance Invariant After Sweep

```sql
-- Must return 0 rows (Invariant: available_qty = on_hand_qty - reserved_qty AND reserved_qty >= 0)
SELECT *
FROM inventory.inventory_balances
WHERE available_qty <> (on_hand_qty - reserved_qty)
   OR reserved_qty < 0
   OR available_qty < 0;
```

---

## 6. Prevention & Escalation

- Ensure `ReservationsService.expireReservations` runs every 60 seconds per active tenant.
- Never manually `DELETE` rows from `inventory.stock_reservations`; always transition `status` to `'EXPIRED'` or `'RELEASED'` while decrementing `reserved_qty` and incrementing `available_qty` atomically.
