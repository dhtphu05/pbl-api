# M8 Observability, Distributed Tracing & Health Architecture

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation

---

## 1. Correlation & Distributed Trace Propagation

Every synchronous HTTP request, S2S call, and asynchronous `EventEnvelope` propagates a unified correlation context:

| Transport Layer | Header / Envelope Field | Producer / Propagator | Consumer / Logger Binding |
|---|---|---|---|
| **Client $\rightarrow$ API Gateway / Service** | `X-Correlation-Id`, `traceparent` | [`CorrelationIdMiddleware`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/common/src/middleware/correlation-id.middleware.ts) | Bound to `nestjs-pino` structured JSON request logs |
| **Service $\rightarrow$ Service (S2S HTTP)** | `X-Correlation-Id`, `X-Tenant-Id`, `Idempotency-Key`, `X-Internal-Token` | [`InternalS2sClient`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/common/src/s2s/internal-s2s.client.ts) | Propagated across `Sales -> Inventory`, `Sales -> Customer`, `Sales -> Finance`, `Integration -> Sales/Inventory` |
| **Service $\rightarrow$ Outbox $\rightarrow$ SQS Consumer** | `EventEnvelope.traceId`, `EventEnvelope.tenantId`, `EventEnvelope.id` | `OutboxService` / `OutboxPoller` | Logged on consumer ingestion, inbox deduplication, and DLQ routing |

---

## 2. Health & Readiness Endpoints Across All 8 Microservices

Every microservice exposes `@nestjs/terminus` health probes configured in `docker-compose.yml`:
- `GET /health` / `GET /api/v1/health/liveness` — Process liveness check.
- `GET /api/v1/health/readiness` — Verifies PostgreSQL schema connectivity (`SELECT 1`) and critical dependency readiness.

---

## 3. Operational Runbooks Index (`docs/runbooks/`)

All 10 production incident scenarios are documented with SQL diagnostics and step-by-step remediation under `/Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/`:
1. [RUNBOOK_A_INVENTORY_RESERVATION_STUCK.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_A_INVENTORY_RESERVATION_STUCK.md)
2. [RUNBOOK_B_CHECKOUT_RECONCILIATION_REQUIRED.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_B_CHECKOUT_RECONCILIATION_REQUIRED.md)
3. [RUNBOOK_C_LOYALTY_HOLD_STUCK.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_C_LOYALTY_HOLD_STUCK.md)
4. [RUNBOOK_D_FINANCE_REFUND_PENDING_CONFIRMATION.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_D_FINANCE_REFUND_PENDING_CONFIRMATION.md)
5. [RUNBOOK_E_MARKETPLACE_WEBHOOK_SIGNATURE_FAILURES.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_E_MARKETPLACE_WEBHOOK_SIGNATURE_FAILURES.md)
6. [RUNBOOK_F_MARKETPLACE_TOKEN_REFRESH_FAILURE.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_F_MARKETPLACE_TOKEN_REFRESH_FAILURE.md)
7. [RUNBOOK_G_MARKETPLACE_ORDER_SHORTAGE_HOLD.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_G_MARKETPLACE_ORDER_SHORTAGE_HOLD.md)
8. [RUNBOOK_H_DLQ_GROWTH.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_H_DLQ_GROWTH.md)
9. [RUNBOOK_I_INSIGHT_PROJECTION_LAG_OR_MISMATCH.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_I_INSIGHT_PROJECTION_LAG_OR_MISMATCH.md)
10. [RUNBOOK_J_DATABASE_MIGRATION_FAILURE.md](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/RUNBOOK_J_DATABASE_MIGRATION_FAILURE.md)
