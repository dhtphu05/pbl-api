# Runbook E — Marketplace Webhook Signature Failures (`401 Unauthorized`)

## 1. Incident Overview

| Field | Value |
|---|---|
| **Alert Name** | `MarketplaceWebhookSignatureFailureSpike` |
| **Owner Service** | `integration` (`apps/integration`) |
| **Database Schema** | `integration.webhook_events`, `integration.channel_connections` |
| **Severity** | `SEV-2` (Legitimate Shopee/TikTok/Lazada order webhooks rejected, delaying order import and stock reservation) |
| **SLO Impact** | Marketplace webhook ingestion success rate |

---

## 2. Symptoms & Detection

- Spike in HTTP `401 Unauthorized` responses on `POST /api/v1/integration/webhooks/:channel`.
- `integration.webhook_events` shows rows with `signature_valid = false` or `processing_status = 'REJECTED_SIGNATURE'`.

---

## 3. Diagnostic SQL Queries

```sql
-- 1. Count webhook signature failures by channel and shop_id over the last hour
SELECT
  channel_code,
  external_shop_id,
  COUNT(*) FILTER (WHERE signature_valid = false) AS invalid_sig_count,
  COUNT(*) FILTER (WHERE signature_valid = true) AS valid_sig_count,
  MAX(received_at) AS last_received_at
FROM integration.webhook_events
WHERE received_at >= NOW() - INTERVAL '1 hour'
GROUP BY channel_code, external_shop_id
ORDER BY invalid_sig_count DESC;
```

---

## 4. Root Cause Triage

1. **Webhook Secret Rotation on Marketplace Partner Portal**:
   - Shopee Partner Key / TikTok App Secret / Lazada App Secret was rotated in the marketplace developer console without updating `integration-service` secrets (`SHOPEE_WEBHOOK_SECRET`, `TIKTOK_WEBHOOK_SECRET`, `LAZADA_WEBHOOK_SECRET`).
2. **Reverse Proxy Body Mutation**:
   - API Gateway or ingress re-serialized the raw JSON body before forwarding to `integration-service`, altering whitespace and invalidating HMAC-SHA256 calculation over raw request bytes.
3. **Spoofed / Malicious Traffic**:
   - External scanner sending unsigned requests to the public webhook endpoint.

---

## 5. Remediation Steps

1. **Verify Source IP & Headers**:
   - Inspect request logs for `x-shopee-signature`, `x-tts-signature`, or `x-lazada-signature`. If headers are missing and source IPs do not belong to marketplace webhook CIDR ranges, block at WAF/Gateway.
2. **Verify Partner Secret Configuration**:
   - Compare the configured secret in Vault/Secret Manager with the active Partner Key in the marketplace console.
   - Update the secret and perform a rolling restart of `integration-service`.
3. **Replay Legitimate Rejected Webhooks**:
   - Once the secret is corrected, trigger a reconciliation poll (`OrdersSyncService.pollMissedOrders(tenantId, connectionId)`) to import any marketplace orders missed during the signature failure window.
