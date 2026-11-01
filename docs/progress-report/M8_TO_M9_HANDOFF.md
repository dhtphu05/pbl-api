# M8 to M9 Handoff Guide — Production Deployment, Cloud Infrastructure & Go-Live Readiness

**Milestone:** M8 $\rightarrow$ M9 Transition  
**Date:** 2026-10-31

---

## 1. What M8 Guarantees Entering M9

1. **8 Autonomous Bounded Contexts**:
   - `platform`, `catalog`, `inventory`, `sales`, `customer`, `finance`, `integration`, and `insight` compile, pass `85` architecture fitness checks (`pnpm test:arch`), and enforce strict database schema isolation with PostgreSQL Forced RLS.
2. **Proven Distributed Workflows & Reliability**:
   - End-to-End Workflows A–G, 20 Concurrency Scenarios, 10 Fault-Injection Scenarios, Multi-Tenant RLS Isolation, and 7 Cross-Service Reconciliation Pairs are automated and passing against real PostgreSQL via `pnpm verify:m8`.
3. **Operational Runbooks Ready**:
   - Runbooks A through J are available in [`docs/runbooks/`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/docs/runbooks/).

---

## 2. M9 Priorities & Production Readiness Checklist

| Area | M8 State (Completed) | M9 Action Item |
|---|---|---|
| **Cloud Messaging (AWS SNS/SQS)** | Local ElasticMQ queues (`docker/elasticmq.conf`) + SQS/SNS SDK adapters in `@pbl6/events` | Provision production AWS SNS topics, SQS queues, IAM policies, and CloudWatch DLQ alarms via Terraform (`pbl-infra`) |
| **API Gateway (`KrakenD`)** | Service routes and RS256 JWKS endpoints verified | Deploy KrakenD gateway cluster with rate-limiting, CORS, and JWKS caching in staging/production |
| **Marketplace Partner Credentials** | Deterministic partner simulator + real HMAC-SHA256 webhook verification | Inject live Shopee Open Platform, TikTok Shop Partner, and Lazada Open Platform credentials via AWS Secrets Manager |
| **Scheduled Maintenance Crons** | `expireReservations`, `executeReconciliation`, and `OutboxPoller` verified | Configure production cron schedules and Prometheus/Grafana alerts mapped to Runbooks A–J |
| **Load & Soak Testing** | Single-node real-PostgreSQL baseline (`p95 = 47.25 ms` checkout, `p95 = 2.66 ms` dashboard) | Run distributed multi-replica k6 load tests against ECS Fargate + Neon/RDS PostgreSQL |
