# Runbook G — Marketplace Order Shortage Hold (`ON_HOLD_SHORTAGE` / `UNMAPPED_SKU`)

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `MarketplaceOrderImportShortageOrUnmappedHold` |
| **Owner Service** | `integration` (`apps/integration`) & `inventory` (`apps/inventory`) |
| **Database Schema** | `integration.marketplace_order_sync_logs`, `integration.sku_mappings`, `inventory.inventory_balances` |
| **Severity** | `SEV-2` (Marketplace buyer order accepted on Shopee/TikTok/Lazada, but local stock or SKU mapping could not be allocated) |
| **SLO Impact** | Marketplace order fulfillment SLA & oversell prevention |

---

## 2. Symptoms & Detection

- `integration.marketplace_order_sync_logs` contains rows with `sync_status IN ('ON_HOLD_SHORTAGE', 'FAILED_UNMAPPED_SKU')`.
- `integration.sync_jobs` has jobs in `DEAD_LETTERED` or `RETRY_SCHEDULED` with error `SKU_MAPPING_NOT_FOUND` or `INSUFFICIENT_AVAILABLE_STOCK`.

---

## 3. Diagnostic SQL Queries

```sql
-- 1. Inspect marketplace orders held for shortage or unmapped SKU
SELECT
  id,
  tenant_id,
  connection_id,
  channel_code,
  external_order_id,
  internal_order_id,
  sync_status,
  error_code,
  error_message,
  created_at,
  updated_at
FROM integration.marketplace_order_sync_logs
WHERE sync_status IN ('ON_HOLD_SHORTAGE', 'FAILED_UNMAPPED_SKU', 'FAILED')
ORDER BY created_at DESC;
```

---

## 4. Root Cause Triage

1. **Missing SKU Mapping (`FAILED_UNMAPPED_SKU`)**:
   - Merchant listed a new variant on Shopee/TikTok without linking `external_item_id` + `external_sku_id` in `integration.sku_mappings`.
2. **Physical Stock Depleted by Simultaneous POS Sale (`ON_HOLD_SHORTAGE`)**:
   - A walk-in POS sale committed the last unit in `inventory.inventory_balances` milliseconds before the marketplace order webhook arrived.

---

## 5. Remediation Steps

### Case A: `FAILED_UNMAPPED_SKU`

1. Create the SKU mapping via `POST /api/v1/integration/sku-mappings` linking `(connection_id, external_item_id, external_sku_id)` to `internal_variant_id`.
2. Replay the dead-lettered `ORDER_IMPORT` job via `SyncJobsService.retryDeadLetterJob(tenantId, jobId)`.

### Case B: `ON_HOLD_SHORTAGE`

1. Check if another branch warehouse has available stock (`inventory.inventory_balances`).
2. Either:
   - Execute an inter-warehouse transfer (`TransfersService`) or stock receipt (`ReceivingService`) into the channel's designated warehouse, then replay the `ORDER_IMPORT` sync job; **OR**
   - Cancel the external marketplace order in Seller Centre if no stock can be sourced within the SLA window.
