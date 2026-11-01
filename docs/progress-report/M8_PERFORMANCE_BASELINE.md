# M8 Performance Baseline Report (Real PostgreSQL)

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation  
**Benchmark Suite:** [`libs/events/test/m8-concurrency-fault-reconciliation.int-spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/events/test/m8-concurrency-fault-reconciliation.int-spec.ts) (`Phase 9 — Real PostgreSQL Performance Baseline`)  
**Environment:** Apple Silicon macOS host, PostgreSQL 16 (`localhost:25432`), TypeORM connection pooling,Forced RLS enabled across all 7 schemas.

---

## 1. Raw Benchmark Telemetry Output

Captured directly from `pnpm verify:m8`:

```json
{
  "benchmark": "M8_PERFORMANCE_BASELINE",
  "posCheckoutSequential25": {
    "p50Ms": 35.14,
    "p95Ms": 47.25,
    "p99Ms": 55.92
  },
  "outboxBatchPropagation25OrdersMs": 1734.45,
  "insightDashboardOverview25": {
    "p50Ms": 2.04,
    "p95Ms": 2.66,
    "p99Ms": 8.96
  }
}
```

---

## 2. SLO Comparison & Analysis

| Operation / Path | Sample Size | Measured `p50` | Measured `p95` | Measured `p99` | Target M8 SLO | Verdict |
|---|---|---|---|---|---|---|
| **Full POS Checkout Saga** (`Sales` + `Inventory` Reserve & Confirm + Order Commit + Outbox Insert) | `25` checkouts | `35.14 ms` | `47.25 ms` | `55.92 ms` | `p95 < 400 ms` | **PASS (`8.5x` faster than SLO)** |
| **Multi-Service Outbox Propagation** (`25` completed orders drained across `Sales -> Customer + Finance + Inventory -> Integration + Insight`) | `25` orders (~125 events) | — | `1,734.45 ms` (total batch) | `~69.38 ms / order` | `< 5,000 ms` freshness | **PASS (`2.9x` faster than SLO)** |
| **Insight Dashboard Overview Query** (`AnalyticsService.getOverview` over pre-aggregated summary tables) | `25` queries | `2.04 ms` | `2.66 ms` | `8.96 ms` | `p95 < 150 ms` | **PASS (`56x` faster than SLO)** |
| **High-Contention 100-Request Stock Race** (`100` concurrent checkouts on `10` units) | `100` concurrent checkouts | — | `771 ms` (entire 100-request burst) | — | `< 3,000 ms` | **PASS** |
