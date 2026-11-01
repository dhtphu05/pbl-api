# M8 Reproducible Demo & Verification Guide

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation

---

## 1. Prerequisites

1. **PostgreSQL 16** running on `localhost:25432` (or configured via `DB_HOST` / `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE`).
   - To start local infrastructure via Docker Compose:
     ```bash
     docker compose up -d postgres redis elasticmq
     ```
2. **Node.js 22+ & pnpm**:
   ```bash
   pnpm install
   ```

---

## 2. One-Command Full-System Verification (`pnpm verify:m8`)

Run the reproducible M8 verification runner [`scripts/m8-verify-system.mjs`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/scripts/m8-verify-system.mjs):

```bash
pnpm verify:m8
```

### What `pnpm verify:m8` Executes:
1. **Phase 1 — DDD & Hexagonal Architecture Fitness Gates (`pnpm test:arch`)**:
   - Runs 9 test suites (`85` tests) verifying zero cross-service code imports, zero cross-schema SQL queries, and strict domain layer purity across all 8 microservices (`platform`, `catalog`, `inventory`, `sales`, `customer`, `finance`, `integration`, `insight`).
2. **Phase 2 — End-to-End Business Workflows A through G (`m8-full-system-workflows.int-spec.ts`)**:
   - Provisions isolated PostgreSQL schemas with real TypeORM migrations and Forced RLS for all 7 domain services and executes:
     - **Workflow A**: Full 7-service retail lifecycle (Catalog SKU $\rightarrow$ Inventory Receipt $\rightarrow$ POS Checkout $\rightarrow$ Customer Loyalty $\rightarrow$ Finance Settlement & Journal $\rightarrow$ Insight Rollup $\rightarrow$ Integration Shopee Stock Push).
     - **Workflow B**: High-contention `100`-checkout race for `10` units in stock (`10` succeed, `90` rejected with `409 INSUFFICIENT_STOCK`, `0` negative balances).
     - **Workflow C**: Loyalty redemption race + 5-stage saga failure & recovery verification.
     - **Workflow D**: Credit limit enforcement (`ON_ACCOUNT`), concurrent credit sale race, partial debt repayment, and fail-closed Finance outage.
     - **Workflow E**: Partial sales return, inventory restock, loyalty clawback, Finance refund, and concurrent over-return prevention.
     - **Workflow F**: Shopee webhook ingestion, `100x` duplicate webhook replay, unmapped SKU conflict & recovery, and shortage hold.
     - **Workflow G**: `100x` duplicate analytical event replay, consumer downtime catch-up, and shadow generation rebuild.
3. **Phase 3 — Concurrency Matrix, Fault Injection, Multi-Tenant Isolation, 7 Reconciliation Pairs & Performance Baseline (`m8-concurrency-fault-reconciliation.int-spec.ts`)**:
   - Runs all 20 concurrency scenarios, 10 fault-injection scenarios, Tenant A vs Tenant B RLS isolation across all 7 schemas, all 7 cross-service reconciliation pairs (including injected drift detection and self-healing rebuild), and outputs real `p50`/`p95`/`p99` latency telemetry.
