#!/usr/bin/env node
/**
 * Milestone M8 — Full-System Integration, Distributed Reliability & Architecture Verification Runner
 *
 * Executes in deterministic order:
 * 1. DDD & Hexagonal Architecture Fitness Gates across all 8 bounded contexts (`pnpm test:arch`)
 * 2. End-to-End Business Workflows A through G against real PostgreSQL (`m8-full-system-workflows.int-spec.ts`)
 * 3. 20-Scenario Concurrency Matrix, 10 Fault-Injection Scenarios, Multi-Tenant RLS Isolation,
 *    7 Cross-Service Reconciliation Pairs & Real-PostgreSQL Performance Baseline (`m8-concurrency-fault-reconciliation.int-spec.ts`)
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const steps = [
  {
    name: 'Phase 1 — DDD & Hexagonal Architecture Fitness Gates (8 Bounded Contexts)',
    cmd: 'npx',
    args: [
      'jest',
      'libs/common/src/bootstrap/ddd-architecture-fitness.spec.ts',
      'apps/platform/src/platform-architecture.spec.ts',
      'apps/catalog/src/catalog-architecture.spec.ts',
      'apps/inventory/src/inventory-architecture.spec.ts',
      'apps/sales/src/sales-architecture.spec.ts',
      'apps/customer/src/customer-architecture.spec.ts',
      'apps/finance/src/finance-architecture.spec.ts',
      'apps/integration/src/integration-architecture.spec.ts',
      'apps/insight/src/insight-architecture.spec.ts',
      '--runInBand',
    ],
  },
  {
    name: 'Phase 2 — End-to-End Business Workflows A through G (Real PostgreSQL)',
    cmd: 'npx',
    args: [
      'jest',
      '--config',
      'libs/events/test/jest-int.json',
      'libs/events/test/m8-full-system-workflows.int-spec.ts',
      '--runInBand',
      '--forceExit',
    ],
  },
  {
    name: 'Phase 3 — 20 Concurrency Races, 10 Fault Injections, Multi-Tenant Isolation, 7 Reconciliation Pairs & Performance Baseline',
    cmd: 'npx',
    args: [
      'jest',
      '--config',
      'libs/events/test/jest-int.json',
      'libs/events/test/m8-concurrency-fault-reconciliation.int-spec.ts',
      '--runInBand',
      '--forceExit',
    ],
  },
];

console.log('================================================================================');
console.log(' PBL6 SAPOCLONE — M8 FULL-SYSTEM INTEGRATION & RELIABILITY VERIFICATION SUITE');
console.log('================================================================================\n');

const startedAt = Date.now();

for (const step of steps) {
  console.log(`\n▶ Running: ${step.name}`);
  console.log(`  Command: ${step.cmd} ${step.args.join(' ')}\n`);
  const result = spawnSync(step.cmd, step.args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`\n✖ FAILED: ${step.name} (exit code ${result.status})`);
    process.exit(result.status ?? 1);
  }
  console.log(`\n✔ PASSED: ${step.name}`);
}

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(2);
console.log('\n================================================================================');
console.log(` ✔ ALL M8 FULL-SYSTEM VERIFICATION GATES PASSED IN ${elapsedSec}s`);
console.log('================================================================================');
