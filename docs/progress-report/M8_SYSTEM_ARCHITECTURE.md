# M8 System Architecture — Bounded Contexts, Runtime Topology & Event Bus

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation

---

## 1. Full System Context & Bounded Context Map (Diagram 1)

```mermaid
flowchart TB
  subgraph Clients["Omnichannel Touchpoints"]
    POS["POS Register UI"]
    ADMIN["Merchant Admin & Analytics"]
    MKT["Shopee / TikTok Shop / Lazada"]
  end

  subgraph Gateway["API Edge & Identity"]
    KRAKEND["KrakenD API Gateway"]
    PLATFORM["Platform Service (:3000)\nSchema: platform\nAuth, Tenants, Branches, RBAC, JWKS"]
  end

  subgraph CoreCommerce["Core Retail Bounded Contexts"]
    CATALOG["Catalog Service (:3001)\nSchema: catalog\nProducts, Variants, Barcodes, Prices"]
    INVENTORY["Inventory Service (:3002)\nSchema: inventory\nWarehouses, Balances, Reservations, Ledger"]
    SALES["Sales Service (:3003)\nSchema: sales\nOrders, POS Shifts, Checkout Saga, Returns"]
    CUSTOMER["Customer Service (:3004)\nSchema: customer\nProfiles, Groups, Loyalty Holds & Ledger"]
    FINANCE["Finance Service (:3005)\nSchema: finance\nCashbook, Settlements, AR Debt, Refunds"]
    INTEGRATION["Integration Service (:3006)\nSchema: integration\nChannel Connections, SKU Maps, Sync Jobs"]
    INSIGHT["Insight Service (:3007)\nSchema: insight\nRead Projections, Shadow Rebuild, Reconciliation"]
  end

  POS --> KRAKEND
  ADMIN --> KRAKEND
  MKT -->|Signed Webhooks| INTEGRATION
  KRAKEND --> PLATFORM
  KRAKEND --> CATALOG
  KRAKEND --> INVENTORY
  KRAKEND --> SALES
  KRAKEND --> CUSTOMER
  KRAKEND --> FINANCE
  KRAKEND --> INTEGRATION
  KRAKEND --> INSIGHT

  SALES -->|S2S HTTP: Reserve/Confirm/Release/Return| INVENTORY
  SALES -->|S2S HTTP: Hold/Confirm/Release Points| CUSTOMER
  SALES -->|S2S HTTP: Credit Check| FINANCE
  INTEGRATION -->|S2S HTTP: Create Channel Order| SALES
  INTEGRATION -->|S2S HTTP: Reserve Stock| INVENTORY
```

---

## 2. Local Docker Compose & Runtime Topology (Diagram 2)

```mermaid
flowchart LR
  subgraph Containers["Docker Compose Network (pbl-network)"]
    PG[("PostgreSQL 16 (:5432 / :25432)\n8 Isolated Schemas + Forced RLS")]
    REDIS[("Redis 7 (:6379)\nIdempotency & Rate Limit Cache")]
    SQS[["ElasticMQ / SQS (:9324)\n8 Service Queues + DLQs"]]

    S_PLAT["platform (:3000)"]
    S_CAT["catalog (:3001)"]
    S_INV["inventory (:3002)"]
    S_SAL["sales (:3003)"]
    S_CUS["customer (:3004)"]
    S_FIN["finance (:3005)"]
    S_INT["integration (:3006)"]
    S_INS["insight (:3007)"]
  end

  S_PLAT & S_CAT & S_INV & S_SAL & S_CUS & S_FIN & S_INT & S_INS --> PG
  S_PLAT & S_CAT & S_INV & S_SAL & S_CUS & S_FIN & S_INT & S_INS --> REDIS
  S_PLAT & S_CAT & S_INV & S_SAL & S_CUS & S_FIN & S_INT & S_INS <--> SQS
```

---

## 3. Asynchronous Event Topology — Transactional Outbox to Consumers (Diagram 3)

```mermaid
flowchart LR
  subgraph Producers["Authoritative Outbox Producers"]
    CAT_OB["catalog.outbox_events"]
    INV_OB["inventory.outbox_events"]
    SAL_OB["sales.outbox_events"]
    CUS_OB["customer.outbox_events"]
    FIN_OB["finance.outbox_events"]
    INT_OB["integration.outbox_events"]
  end

  BUS(("SNS / SQS\nAt-Least-Once Bus"))

  subgraph Consumers["Idempotent Inbox Consumers"]
    INV_IN["Inventory Consumer\ncatalog.variant.*"]
    SAL_IN["Sales Consumer\ncatalog.variant.*, catalog.price.changed\nfinance.refund.*"]
    CUS_IN["Customer Consumer\nsales.order.completed\nsales.return.completed"]
    FIN_IN["Finance Consumer\nsales.order.completed\nsales.return.completed\nsales.refund.requested"]
    INT_IN["Integration Consumer\ninventory.stock.changed"]
    INS_IN["Insight Consumer\nAll 6 Domain Streams"]
  end

  CAT_OB & INV_OB & SAL_OB & CUS_OB & FIN_OB & INT_OB --> BUS
  BUS --> INV_IN & SAL_IN & CUS_IN & FIN_IN & INT_IN & INS_IN
```

---

## 4. Architectural Invariants Enforced

1. **Zero Cross-Service Code Imports**: Enforced by [`ddd-architecture-fitness.spec.ts`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/libs/common/src/bootstrap/ddd-architecture-fitness.spec.ts).
2. **Zero Cross-Schema SQL Queries**: Every microservice connects to its own schema (`platform`, `catalog`, `inventory`, `sales`, `customer`, `finance`, `integration`, `insight`) and never queries another service's tables directly.
3. **Database-Level Multi-Tenant Isolation**: Every tenant-scoped table enforces `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` keyed on `current_setting('app.current_tenant', true)` / `current_setting('app.tenant_id', true)`.
