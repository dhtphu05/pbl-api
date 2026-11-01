# M8 CI/CD Integration & Quality Gates

**Milestone:** M8 — Full-System Integration, Distributed Reliability & Architecture Validation  
**Workflow File:** [`.github/workflows/ci.yml`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/.github/workflows/ci.yml)

---

## 1. Automated CI Pipeline Stages

The GitHub Actions workflow [`.github/workflows/ci.yml`](file:///Users/mac/Desktop/SEM7/pbl6/pbl-api/.github/workflows/ci.yml) enforces six mandatory quality gates on every push and pull request:

| Stage | Job / Step | Command Executed | Coverage Scope |
|---|---|---|---|
| **1. Shared Libraries Build** | `build:libs` | `pnpm build:libs` | `@pbl6/common`, `@pbl6/auth`, `@pbl6/events`, `@pbl6/config`, `@pbl6/cache` |
| **2. All 8 Microservices Build** | `build:<service>` | `pnpm build:platform && pnpm build:catalog && pnpm build:inventory && pnpm build:sales && pnpm build:customer && pnpm build:finance && pnpm build:integration && pnpm build:insight` | Compiles all 8 NestJS apps with zero TypeScript errors |
| **3. DDD Architecture Fitness Gate** | `test:arch` | `pnpm test:arch` | 9 test suites (`85` assertions) enforcing zero cross-service imports, zero cross-schema SQL, and domain layer purity |
| **4. Per-Service Unit Test Matrix** | `test:<service>` | `pnpm test:platform`, `test:catalog`, `test:inventory`, `test:sales`, `test:customer`, `test:finance`, `test:integration`, `test:insight` | All 8 microservices + shared libraries |
| **5. Real-PostgreSQL Full-System Integration Gate** | `test:int` / `verify:m8` | `pnpm verify:m8` | Workflows A–G, 20 Concurrency Scenarios, 10 Fault Injections, Multi-Tenant RLS Isolation, 7 Reconciliation Pairs, Performance Baseline |
| **6. Package Tarball Verification** | `pack:libs` | `pnpm pack:libs` | Verifies publishable shared package artifacts |
