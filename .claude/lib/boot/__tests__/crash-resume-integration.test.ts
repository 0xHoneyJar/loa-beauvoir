/**
 * Crash Resume Integration Test — TASK-3.8
 *
 * Simulates partial workflow execution (crash mid-step) and verifies
 * that the IdempotencyIndex + AuditTrail combination provides correct
 * recovery semantics on reboot. No actual SIGKILL needed — we simply
 * leave on-disk state in a partially-completed state, then boot fresh
 * instances and call reconcilePending().
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ResilientJsonStore } from "../../persistence/resilient-store.js";
import { AuditTrail } from "../../safety/audit-trail.js";
import { IdempotencyIndex, type DedupState } from "../../safety/idempotency-index.js";
import { createLogger } from "../../safety/logger.js";
import { SecretRedactor } from "../../safety/secret-redactor.js";

// ── Helpers ───────────────────────────────────────────────────

function makeLogger() {
  const redactor = new SecretRedactor();
  return { redactor, logger: createLogger(redactor, { level: "warn" }) };
}

function makeAuditTrail(dataDir: string, deps: ReturnType<typeof makeLogger>) {
  return new AuditTrail({
    path: join(dataDir, "audit-trail.jsonl"),
    redactor: deps.redactor,
    logger: deps.logger,
  });
}

function makeDedupStore(dataDir: string, deps: ReturnType<typeof makeLogger>) {
  return new ResilientJsonStore<DedupState>({
    path: join(dataDir, "dedup-index.json"),
    schemaVersion: 1,
    logger: deps.logger,
  });
}

function makeDedupIndex(store: ResilientJsonStore<DedupState>, auditTrail?: AuditTrail) {
  return new IdempotencyIndex({
    store,
    auditQuery: auditTrail
      ? (intentSeq: number) => auditTrail.findResultByIntentSeq(intentSeq)
      : undefined,
  });
}

// ── Tests ─────────────────────────────────────────────────────

describe("Crash Resume Integration", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "crash-resume-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("crash after recordIntent only: clean re-execution on recovery", async () => {
    const dedupKey = "create_pr:repo/main:step-1";

    // Phase 1: Simulate crash after recordIntent — dedup index never sees markPending
    const deps1 = makeLogger();
    const auditTrail1 = makeAuditTrail(dataDir, deps1);
    await auditTrail1.initialize();

    await auditTrail1.recordIntent("create_pr", "repo/main", { pr: 1 }, dedupKey);
    // Crash here — markPending was never called
    await auditTrail1.close();

    // Phase 2: Recovery boot — fresh instances from same dataDir
    const deps2 = makeLogger();
    const auditTrail2 = makeAuditTrail(dataDir, deps2);
    await auditTrail2.initialize();
    const store2 = makeDedupStore(dataDir, deps2);
    const dedup2 = makeDedupIndex(store2, auditTrail2);

    // AuditTrail recovery should detect the pending intent (no matching result)
    const pendingIntents = auditTrail2.getPendingIntents();
    expect(pendingIntents.size).toBe(1);

    // Dedup index has no entry → reconcile finds nothing pending
    const needsCompensation = await dedup2.reconcilePending();
    expect(needsCompensation).toHaveLength(0);

    // check() returns null → safe to re-execute from scratch
    const existing = await dedup2.check(dedupKey);
    expect(existing).toBeNull();

    await auditTrail2.close();
  });

  it("crash after markPending: reconcile finds no result, stays pending", async () => {
    const dedupKey = "create_pr:repo/main:step-2";

    // Phase 1: recordIntent + markPending, then crash before execute
    const deps1 = makeLogger();
    const auditTrail1 = makeAuditTrail(dataDir, deps1);
    await auditTrail1.initialize();
    const store1 = makeDedupStore(dataDir, deps1);
    const dedup1 = makeDedupIndex(store1);

    const intentSeq = await auditTrail1.recordIntent("create_pr", "repo/main", { pr: 2 }, dedupKey);
    await dedup1.markPending(dedupKey, intentSeq, "check_then_retry");
    // Crash here — execute never happened, no recordResult, no markCompleted
    await auditTrail1.close();

    // Phase 2: Recovery boot
    const deps2 = makeLogger();
    const auditTrail2 = makeAuditTrail(dataDir, deps2);
    await auditTrail2.initialize();
    const store2 = makeDedupStore(dataDir, deps2);
    const dedup2 = makeDedupIndex(store2, auditTrail2);

    // reconcilePending: entry is pending, auditQuery finds intent but no result → needs compensation
    const needsCompensation = await dedup2.reconcilePending();
    expect(needsCompensation).toHaveLength(1);
    expect(needsCompensation[0].key).toBe(dedupKey);
    expect(needsCompensation[0].status).toBe("pending");
    expect(needsCompensation[0].compensationStrategy).toBe("check_then_retry");

    // check() still returns the pending entry
    const entry = await dedup2.check(dedupKey);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe("pending");

    await auditTrail2.close();
  });

  it("crash after recordResult (pre-complete): auto-promote via auditQuery", async () => {
    const dedupKey = "create_pr:repo/main:step-3";

    // Phase 1: Full sequence minus markCompleted
    const deps1 = makeLogger();
    const auditTrail1 = makeAuditTrail(dataDir, deps1);
    await auditTrail1.initialize();
    const store1 = makeDedupStore(dataDir, deps1);
    const dedup1 = makeDedupIndex(store1);

    // Step 1: recordIntent
    const intentSeq = await auditTrail1.recordIntent("create_pr", "repo/main", { pr: 3 }, dedupKey);

    // Step 2: markPending
    await dedup1.markPending(dedupKey, intentSeq, "check_then_retry");

    // Step 3: Execute succeeded (simulated)
    // Step 4: recordResult — the result IS durably written to audit trail
    await auditTrail1.recordResult(intentSeq, "create_pr", "repo/main", {
      prNumber: 42,
      url: "https://github.com/org/repo/pull/42",
    });

    // Crash here — markCompleted was never called. Dedup still says "pending".
    await auditTrail1.close();

    // Phase 2: Recovery boot
    const deps2 = makeLogger();
    const auditTrail2 = makeAuditTrail(dataDir, deps2);
    await auditTrail2.initialize();
    const store2 = makeDedupStore(dataDir, deps2);
    const dedup2 = makeDedupIndex(store2, auditTrail2);

    // AuditTrail recovery: intent resolved (result exists), so no pending intents
    expect(auditTrail2.getPendingIntents().size).toBe(0);

    // reconcilePending: entry is pending in dedup, but auditQuery finds the result →
    // auto-promotes to completed, returns empty (no compensation needed)
    const needsCompensation = await dedup2.reconcilePending();
    expect(needsCompensation).toHaveLength(0);

    // Verify the entry was promoted to completed (no double execution)
    const entry = await dedup2.check(dedupKey);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe("completed");
    expect(entry!.completedAt).toBeDefined();

    await auditTrail2.close();
  });
});
