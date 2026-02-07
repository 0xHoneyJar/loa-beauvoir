/**
 * Integration test: Boot -> Workflow -> Audit end-to-end.
 *
 * Boots the framework with real constructors (no mocks), executes a mock
 * workflow step, and verifies the full audit + dedup + redaction pipeline.
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import type { DedupState } from "../../safety/idempotency-index.js";
import type { StepDef } from "../../workflow/hardened-executor.js";
import { IdempotencyIndex } from "../../safety/idempotency-index.js";
import { HardenedExecutor } from "../../workflow/hardened-executor.js";
import { boot } from "../orchestrator.js";

// ── Helpers ──────────────────────────────────────────────────

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

async function bootReal(nowFn?: () => number) {
  const tmpDir = await mkdtemp(join(tmpdir(), "bwi-test-"));
  const result = await boot({ dataDir: tmpDir, now: nowFn });
  cleanup = async () => {
    await result.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  };
  return { tmpDir, result };
}

// ── Tests ────────────────────────────────────────────────────

describe("Boot -> Workflow -> Audit Integration", () => {
  it("end-to-end: boot, execute workflow step, verify audit + dedup", async () => {
    let time = 1000;
    const now = () => time++;
    const { tmpDir, result } = await bootReal(now);
    const { services, health } = result;

    // 1. Verify boot health
    expect(health.success).toBe(true);
    expect(health.subsystems["auditTrail"]).toBe("ok");
    expect(health.subsystems["circuitBreaker"]).toBe("ok");
    expect(services.store).toBeDefined();

    // 2. Create IdempotencyIndex backed by a real ResilientStore
    const dedupStore = services.store!.create<DedupState>("dedup-index", {
      schemaVersion: 1,
    });
    const dedupIndex = new IdempotencyIndex({
      store: dedupStore,
      now,
    });

    // 3. Create HardenedExecutor with real services
    const executorResult = { pr_url: "https://github.com/test/repo/pull/42" };
    const executor = async (_step: StepDef) => executorResult;

    const engine = new HardenedExecutor(
      {
        auditTrail: services.auditTrail,
        circuitBreaker: services.circuitBreaker,
        rateLimiter: services.rateLimiter,
        dedupIndex,
        operatingMode: "autonomous",
      },
      executor,
    );

    // 4. Execute a workflow step
    const step: StepDef = {
      id: "step-1",
      skill: "create_pull_request",
      scope: "test-owner/test-repo",
      resource: "pulls",
      capability: "write",
      input: { title: "Test PR", body: "Integration test" },
    };

    const stepResult = await engine.advance("wf-integration-1", step);
    expect(stepResult.status).toBe("completed");
    expect(stepResult.outputs).toEqual(executorResult);

    // 5. Verify audit trail has intent + result records
    const auditContent = await readFile(join(tmpDir, "audit-trail.jsonl"), "utf8");
    const records = auditContent
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));

    expect(records.length).toBe(2);
    expect(records[0].phase).toBe("intent");
    expect(records[0].action).toBe("create_pull_request");
    expect(records[0].target).toBe("test-owner/test-repo/pulls");
    expect(records[1].phase).toBe("result");
    expect(records[1].intentSeq).toBe(records[0].seq);

    // 6. Verify hash chain integrity
    const verification = await services.auditTrail.verifyChain();
    expect(verification.valid).toBe(true);
    expect(verification.recordCount).toBe(2);

    // 7. Verify dedup index shows completed
    const dedupKey = `create_pull_request:test-owner/test-repo/pulls:step-1`;
    const entry = await dedupIndex.check(dedupKey);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe("completed");

    // 8. Verify second execution is deduped (skipped)
    const secondResult = await engine.advance("wf-integration-1", step);
    expect(secondResult.status).toBe("skipped");
    expect(secondResult.deduped).toBe(true);

    // 9. Verify log output was redacted: embed a GitHub PAT in params and check
    const secretStep: StepDef = {
      id: "step-secret",
      skill: "add_issue_comment",
      scope: "test-owner/test-repo",
      resource: "comments",
      capability: "write",
      input: { body: "Token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" },
    };
    await engine.advance("wf-integration-2", secretStep);

    const updatedContent = await readFile(join(tmpDir, "audit-trail.jsonl"), "utf8");
    // The secret should be redacted in the audit file
    expect(updatedContent).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    expect(updatedContent).toContain("[REDACTED:github_pat]");
  });

  it("degraded mode blocks mutations but allows reads", async () => {
    let time = 1000;
    const now = () => time++;
    const { result } = await bootReal(now);
    const { services } = result;

    const executor = async (_step: StepDef) => ({ data: "ok" });

    // Wire engine in degraded mode (simulating a P1 failure scenario)
    const engine = new HardenedExecutor(
      {
        auditTrail: services.auditTrail,
        operatingMode: "degraded",
      },
      executor,
    );

    // Write step should be blocked
    const writeStep: StepDef = {
      id: "write-step",
      skill: "create_branch",
      scope: "owner/repo",
      resource: "branches",
      capability: "write",
      input: { name: "feature/x" },
    };
    await expect(engine.advance("wf-degraded", writeStep)).rejects.toThrow(
      "Write operations blocked in degraded mode",
    );

    // Read step should proceed
    const readStep: StepDef = {
      id: "read-step",
      skill: "get_file",
      scope: "owner/repo",
      resource: "contents",
      capability: "read",
      input: { path: "README.md" },
    };
    const readResult = await engine.advance("wf-degraded", readStep);
    expect(readResult.status).toBe("completed");
    expect(readResult.outputs).toEqual({ data: "ok" });
  });
});
