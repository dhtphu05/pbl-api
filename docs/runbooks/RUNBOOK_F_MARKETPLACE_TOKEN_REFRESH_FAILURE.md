# Runbook F — Marketplace Token Refresh Failure (`TOKEN_EXPIRED` / `AUTH_REVOKED`)

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `MarketplaceTokenRefreshFailed` |
| **Owner Service** | `integration` (`apps/integration`) |
| **Database Schema** | `integration.channel_connections` |
| **Severity** | `SEV-2` (Outbound stock publication and polling for Shopee/TikTok/Lazada shop paused) |
| **SLO Impact** | Omnichannel stock push SLA & order polling freshness |

---

## 2. Symptoms & Detection

- `integration.channel_connections` has rows with `status IN ('TOKEN_EXPIRED', 'AUTH_ERROR')` or `token_expires_at < NOW()`.
- Outbound inventory sync jobs fail with `401 Unauthorized` or `error_auth` from Shopee/TikTok/Lazada partner APIs.

---

## 3. Diagnostic SQL Queries

```sql
-- 1. List connections with expired or failing tokens
SELECT
  id,
  tenant_id,
  branch_id,
  warehouse_id,
  channel_code,
  external_shop_id,
  shop_name,
  status,
  token_expires_at,
  refresh_token_expires_at,
  last_sync_error,
  updated_at
FROM integration.channel_connections
WHERE status IN ('TOKEN_EXPIRED', 'AUTH_ERROR')
   OR token_expires_at < NOW()
ORDER BY updated_at DESC;
```

---

## 4. Root Cause Triage

1. **Refresh Token Expired or Merchant Revoked App Authorization**:
   - Shopee/TikTok refresh tokens have a finite lifetime (typically 30 days) or can be revoked by the merchant in Seller Centre.
2. **Concurrent Token Refresh Race Across Workers**:
   - If two workers attempted token refresh without row locking, one refresh token rotation could invalidate the other. (`ConnectionsService.refreshToken` uses `FOR UPDATE` row locking to prevent this).

---

## 5. Remediation Steps

1. **If `refresh_token_expires_at > NOW()`**:
   - Trigger `ConnectionsService.refreshToken(tenantId, connectionId)` via internal admin endpoint.
2. **If `refresh_token_expires_at <= NOW()` or `AUTH_REVOKED`**:
   - The merchant must re-authorize the shop via OAuth callback (`POST /api/v1/integration/connections/:id/reauthorize`).
3. **Post-Recovery Catch-Up**:
   - Once `status = 'ACTIVE'`, trigger `InventorySyncService.republishAllForConnection(tenantId, connectionId)` and `OrdersSyncService.pollMissedOrders(tenantId, connectionId)`.
