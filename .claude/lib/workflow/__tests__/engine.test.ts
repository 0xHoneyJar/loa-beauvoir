/**
 * Tests for HardenedExecutor — 5-step durable single-step execution.
 *
 * TASK-3.6: Workflow Engine Integration tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PersistenceError } from "../../persistence/types.js";
import {
  HardenedExecutor,
  WorkflowError,
  getStrategy,
  generateDedupKey,
  type StepDef,
  type HardenedExecutorConfig,
  type StepExecutor,
  type IdempotencyIndex,
} from "../hardened-executor.js";

// ── Mock Factories ───────────────────────────────────────────

function createMockAuditTrail() {
  let seq = 0;
  return {
    recordIntent: vi.fn().mockImplementation(() => Promise.resolve(++seq)),
    recordResult: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockDedupIndex(): IdempotencyIndex & {
  check: ReturnType<typeof vi.fn>;
  markPending: ReturnType<typeof vi.fn>;
  markCompleted: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
} {
  return {
    check: vi.fn().mockResolvedValue(null),
    markPending: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCircuitBreaker(state: "CLOSED" | "OPEN" | "HALF_OPEN" = "CLOSED") {
  return {
    execute: vi.fn().mockImplementation((fn: () => Promise<unknown>) => fn()),
    getState: vi.fn().mockReturnValue(state),
  };
}

function createMockRateLimiter(allowed = true) {
  return {
    tryConsume: vi.fn().mockReturnValue({
      allowed,
      retryAfterMs: allowed ? undefined : 5000,
      bucket: "workflow" as const,
    }),
  };
}

function makeStep(overrides?: Partial<StepDef>): StepDef {
  return {
    id: "step-1",
    skill: "create_pull_request",
    scope: "owner/repo",
    resource: "pulls/123",
    capability: "write",
    input: { title: "Fix bug" },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("HardenedExecutor", () => {
  let auditTrail: ReturnType<typeof createMockAuditTrail>;
  let dedupIndex: ReturnType<typeof createMockDedupIndex>;
  let circuitBreaker: ReturnType<typeof createMockCircuitBreaker>;
  let rateLimiter: ReturnType<typeof createMockRateLimiter>;
  let executor: StepExecutor & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    auditTrail = createMockAuditTrail();
    dedupIndex = createMockDedupIndex();
    circuitBreaker = createMockCircuitBreaker("CLOSED");
    rateLimiter = createMockRateLimiter(true);
    executor = vi.fn().mockResolvedValue({ pr_url: "https://github.com/owner/repo/pull/123" });
  });

  function createEngine(overrides?: Partial<HardenedExecutorConfig>): HardenedExecutor {
    return new HardenedExecutor(
      {
        auditTrail: auditTrail as unknown as HardenedExecutorConfig["auditTrail"],
        circuitBreaker: circuitBreaker as unknown as HardenedExecutorConfig["circuitBreaker"],
        rateLimiter: rateLimiter as unknown as HardenedExecutorConfig["rateLimiter"],
        dedupIndex,
        operatingMode: "autonomous",
        ...overrides,
      },
      executor,
    );
  }

  // Test 1: Full 5-step flow
  it("executes full 5-step durable flow: intent -> pending -> execute -> result -> completed", async () => {
    const engine = createEngine();
    const step = makeStep();
    const result = await engine.advance("wf-1", step);

    expect(result.status).toBe("completed");
    expect(result.outputs).toEqual({ pr_url: "https://github.com/owner/repo/pull/123" });
    expect(result.deduped).toBeUndefined();

    // 5.1: recordIntent called with correct args
    expect(auditTrail.recordIntent).toHaveBeenCalledWith(
      "create_pull_request",
      "owner/repo/pulls/123",
      { title: "Fix bug" },
      expect.any(String),
    );

    // 5.2: markPending called
    expect(dedupIndex.markPending).toHaveBeenCalledWith(
      expect.any(String),
      1, // intentSeq
      "check_then_retry", // strategy for create_pull_request
    );

    // 5.3: executor called through circuit breaker
    expect(circuitBreaker.execute).toHaveBeenCalled();
    expect(executor).toHaveBeenCalledWith(step);

    // 5.4: recordResult called
    expect(auditTrail.recordResult).toHaveBeenCalledWith(
      1,
      "create_pull_request",
      "owner/repo/pulls/123",
      { pr_url: "https://github.com/owner/repo/pull/123" },
    );

    // 5.5: markCompleted called
    expect(dedupIndex.markCompleted).toHaveBeenCalledWith(expect.any(String));
  });

  // Test 2: Dedup skip — completed entry
  it("skips execution when dedup index returns completed entry", async () => {
    dedupIndex.check.mockResolvedValue({
      key: "test-key",
      intentSeq: 42,
      status: "completed",
      strategy: "check_then_retry",
    });

    const engine = createEngine();
    const result = await engine.advance("wf-1", makeStep());

    expect(result.status).toBe("skipped");
    expect(result.deduped).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(auditTrail.recordIntent).not.toHaveBeenCalled();
  });

  // Test 3: Dedup skip — failed entry with error context
  it("skips execution when dedup index returns failed entry with error context", async () => {
    dedupIndex.check.mockResolvedValue({
      key: "test-key",
      intentSeq: 42,
      status: "failed",
      strategy: "check_then_retry",
      error: "Previous attempt failed: 422 Unprocessable Entity",
    });

    const engine = createEngine();
    const result = await engine.advance("wf-1", makeStep());

    expect(result.status).toBe("skipped");
    expect(result.deduped).toBe(true);
    expect(result.previousError).toBe("Previous attempt failed: 422 Unprocessable Entity");
    expect(executor).not.toHaveBeenCalled();
  });

  // Test 4: Degraded mode — write step throws DEGRADED_MODE
  it("throws DEGRADED_MODE for write steps in degraded mode", async () => {
    const engine = createEngine({ operatingMode: "degraded" });

    await expect(engine.advance("wf-1", makeStep({ capability: "write" }))).rejects.toThrow(
      WorkflowError,
    );

    try {
      await engine.advance("wf-1", makeStep({ capability: "write" }));
    } catch (err) {
      expect((err as WorkflowError).code).toBe("DEGRADED_MODE");
    }

    expect(executor).not.toHaveBeenCalled();
  });

  // Test 5: Degraded mode — read step proceeds normally
  it("allows read steps in degraded mode", async () => {
    executor.mockResolvedValue({ data: "read result" });
    const engine = createEngine({ operatingMode: "degraded" });
    const step = makeStep({ capability: "read" });

    const result = await engine.advance("wf-1", step);

    expect(result.status).toBe("completed");
    expect(result.outputs).toEqual({ data: "read result" });
    expect(executor).toHaveBeenCalledWith(step);
  });

  // Test 6: Rate limiter — blocked throws RATE_LIMITED
  it("throws RATE_LIMITED when rate limiter blocks the request", async () => {
    rateLimiter = createMockRateLimiter(false);
    const engine = createEngine({
      rateLimiter: rateLimiter as unknown as WorkflowEngineConfig["rateLimiter"],
    });

    await expect(engine.advance("wf-1", makeStep())).rejects.toThrow(WorkflowError);

    try {
      await engine.advance("wf-1", makeStep());
    } catch (err) {
      expect((err as WorkflowError).code).toBe("RATE_LIMITED");
      expect((err as WorkflowError).message).toContain("retry after");
    }

    expect(executor).not.toHaveBeenCalled();
  });

  // Test 7: Circuit breaker OPEN throws CB_OPEN
  it("throws CB_OPEN when circuit breaker is in OPEN state", async () => {
    circuitBreaker = createMockCircuitBreaker("OPEN");
    const engine = createEngine({
      circuitBreaker: circuitBreaker as unknown as WorkflowEngineConfig["circuitBreaker"],
    });

    await expect(engine.advance("wf-1", makeStep())).rejects.toThrow(PersistenceError);

    try {
      await engine.advance("wf-1", makeStep());
    } catch (err) {
      expect((err as PersistenceError).code).toBe("CB_OPEN");
    }

    expect(executor).not.toHaveBeenCalled();
  });

  // Test 8: Error path — execute throws, records failure
  it("records error in audit trail and marks failed in dedup index on execution error", async () => {
    executor.mockRejectedValue(new Error("GitHub API: 500 Internal Server Error"));
    // Circuit breaker re-throws the error after recording
    circuitBreaker.execute.mockImplementation(async (fn: () => Promise<unknown>) => {
      return fn();
    });

    const engine = createEngine();
    const result = await engine.advance("wf-1", makeStep());

    expect(result.status).toBe("failed");
    expect(result.previousError).toBe("GitHub API: 500 Internal Server Error");
    expect(result.outputs).toEqual({});

    // Audit trail records error result
    expect(auditTrail.recordResult).toHaveBeenCalledWith(
      1,
      "create_pull_request",
      "owner/repo/pulls/123",
      null,
      "GitHub API: 500 Internal Server Error",
    );

    // Dedup index marks failed
    expect(dedupIndex.markFailed).toHaveBeenCalledWith(
      expect.any(String),
      "GitHub API: 500 Internal Server Error",
    );

    // markCompleted should NOT have been called
    expect(dedupIndex.markCompleted).not.toHaveBeenCalled();
  });

  // Test 9: No dedup index — still records intent + result in audit trail
  it("records intent and result in audit trail even without dedup index", async () => {
    const engine = createEngine({ dedupIndex: undefined });
    const result = await engine.advance("wf-1", makeStep());

    expect(result.status).toBe("completed");

    // Audit trail still works
    expect(auditTrail.recordIntent).toHaveBeenCalled();
    expect(auditTrail.recordResult).toHaveBeenCalled();
  });

  // Test 10: No rate limiter — skips rate check gracefully
  it("skips rate limiting check when no rate limiter is provided", async () => {
    const engine = createEngine({ rateLimiter: undefined });
    const result = await engine.advance("wf-1", makeStep());

    expect(result.status).toBe("completed");
    expect(executor).toHaveBeenCalled();
  });
});

// ── Helper Function Tests ────────────────────────────────────

describe("getStrategy", () => {
  it("returns check_then_retry for create_pull_request", () => {
    expect(getStrategy("create_pull_request")).toBe("check_then_retry");
  });

  it("returns safe_retry for create_branch", () => {
    expect(getStrategy("create_branch")).toBe("safe_retry");
  });

  it("returns skip for unknown actions", () => {
    expect(getStrategy("unknown_action")).toBe("skip");
  });
});

describe("generateDedupKey", () => {
  it("creates a deterministic key from step attributes", () => {
    const step = makeStep();
    const key = generateDedupKey(step);
    expect(key).toBe("create_pull_request:owner/repo/pulls/123:step-1");
  });
});
