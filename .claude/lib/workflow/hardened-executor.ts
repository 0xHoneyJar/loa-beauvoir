/**
 * Hardened Executor — 5-step durable single-step execution with production hardening.
 *
 * Wires audit trail (F2), circuit breaker (F4), rate limiter (F5),
 * and idempotency index (F6) into a hardened advance() method for
 * individual workflow steps.
 *
 * NOTE: This is a single-step executor, not a multi-step workflow engine.
 * A future multi-step workflow engine (with start/advance/resume/gate-checking)
 * should delegate to this executor for the hardened execution phase of each step.
 *
 * SDD ref: §5.1 — Workflow Engine Integration (TASK-3.6)
 */

import type { OperatingMode } from "../boot/orchestrator.js";
import type { CircuitBreaker } from "../persistence/circuit-breaker.js";
import type { RateLimiter, ConsumeResult } from "../persistence/rate-limiter.js";
import type { AuditTrail } from "../safety/audit-trail.js";
import { PersistenceError } from "../persistence/types.js";
import {
  IdempotencyIndex as IdempotencyIndexClass,
  type IdempotencyIndexApi,
  type DedupEntry,
  type CompensationStrategy,
} from "../safety/idempotency-index.js";

// ── Re-exports for backwards compat ─────────────────────────
export type { IdempotencyIndexApi, DedupEntry, CompensationStrategy, OperatingMode };

export interface StepDef {
  id: string;
  skill: string;
  scope: string;
  resource: string;
  capability: "read" | "write";
  input?: Record<string, unknown>;
}

export interface StepResult {
  outputs: Record<string, unknown>;
  status: "completed" | "skipped" | "failed";
  deduped?: boolean;
  previousError?: string;
}

export interface HardenedExecutorConfig {
  /** Optional in dev mode where P0 audit trail init may have failed. */
  auditTrail?: AuditTrail;
  circuitBreaker?: CircuitBreaker;
  rateLimiter?: RateLimiter;
  dedupIndex?: IdempotencyIndexApi;
  operatingMode: OperatingMode;
}

/** @deprecated Use HardenedExecutorConfig instead */
export type WorkflowEngineConfig = HardenedExecutorConfig;

export type StepExecutor = (step: StepDef) => Promise<Record<string, unknown>>;

// ── Error Codes ──────────────────────────────────────────────

export type WorkflowErrorCode = "RATE_LIMITED" | "DEGRADED_MODE" | "CB_OPEN";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, message: string) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

// ── Compensation Table ───────────────────────────────────────

const COMPENSATION_TABLE: Record<string, CompensationStrategy> = {
  create_branch: "safe_retry",
  create_pull_request: "check_then_retry",
  add_issue_comment: "check_then_retry",
  update_pull_request: "safe_retry",
  add_labels: "safe_retry",
  create_review: "check_then_retry",
};

export function getStrategy(action: string): CompensationStrategy {
  return COMPENSATION_TABLE[action] ?? "skip";
}

/** Generate a dedup key from step attributes using IdempotencyIndex.generateKey for compatibility. */
export function generateDedupKey(step: StepDef): string {
  return IdempotencyIndexClass.generateKey(step.skill, step.scope, step.resource, step.input ?? {});
}

// ── Hardened Executor ────────────────────────────────────────

export class HardenedExecutor {
  private readonly config: HardenedExecutorConfig;
  private readonly executor: StepExecutor;

  constructor(config: HardenedExecutorConfig, executor: StepExecutor) {
    this.config = config;
    this.executor = executor;
  }

  /** Execute a single workflow step with full production hardening. */
  async advance(workflowId: string, step: StepDef): Promise<StepResult> {
    const { auditTrail, circuitBreaker, rateLimiter, dedupIndex, operatingMode } = this.config;

    // 1. Rate limiter check
    if (rateLimiter) {
      const result: ConsumeResult = rateLimiter.tryConsume(workflowId);
      if (!result.allowed) {
        throw new WorkflowError(
          "RATE_LIMITED",
          `Rate limited on ${result.bucket} bucket (retry after ${result.retryAfterMs}ms)`,
        );
      }
    }

    // 2. Mutation gating — block writes in degraded mode
    if (operatingMode === "degraded" && step.capability === "write") {
      throw new WorkflowError("DEGRADED_MODE", "Write operations blocked in degraded mode");
    }

    // 3. Dedup check — skip if already completed or failed
    const dedupKey = generateDedupKey(step);
    if (dedupIndex) {
      const existing = await dedupIndex.check(dedupKey);
      if (existing) {
        if (existing.status === "completed") {
          return { outputs: {}, status: "skipped", deduped: true };
        }
        if (existing.status === "failed") {
          return {
            outputs: {},
            status: "skipped",
            deduped: true,
            previousError: existing.lastError,
          };
        }
      }
    }

    // 4. Circuit breaker OPEN check
    if (circuitBreaker && circuitBreaker.getState() === "OPEN") {
      throw new PersistenceError("CB_OPEN", "Circuit breaker is open — cannot execute step");
    }

    // 5. Five-step durable execution
    // 5.1: Record intent + fsync (audit trail)
    const intentSeq = auditTrail
      ? await auditTrail.recordIntent(
          step.skill,
          `${step.scope}/${step.resource}`,
          step.input ?? {},
          dedupKey,
        )
      : 0;

    // 5.2: Mark pending (dedup index)
    if (dedupIndex) {
      await dedupIndex.markPending(dedupKey, intentSeq, getStrategy(step.skill));
    }

    // 5.3: Execute via circuit breaker wrapper (or direct)
    try {
      const executeFn = () => this.executor(step);
      const outputs = circuitBreaker ? await circuitBreaker.execute(executeFn) : await executeFn();

      // 5.4: Record result + fsync (audit trail)
      if (auditTrail) {
        await auditTrail.recordResult(
          intentSeq,
          step.skill,
          `${step.scope}/${step.resource}`,
          outputs,
        );
      }

      // 5.5: Mark completed (dedup index)
      if (dedupIndex) {
        await dedupIndex.markCompleted(dedupKey);
      }

      return { outputs, status: "completed" };
    } catch (err) {
      // Error path: wrap each infrastructure call in its own try/catch
      // to prevent audit/dedup I/O errors from swallowing the original error.
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (auditTrail) {
        try {
          await auditTrail.recordResult(
            intentSeq,
            step.skill,
            `${step.scope}/${step.resource}`,
            null,
            errorMsg,
          );
        } catch {
          // Best-effort: audit trail I/O failure on error path is non-fatal
        }
      }
      if (dedupIndex) {
        try {
          await dedupIndex.markFailed(dedupKey, errorMsg);
        } catch {
          // Best-effort: dedup index I/O failure on error path is non-fatal
        }
      }
      return { outputs: {}, status: "failed", previousError: errorMsg };
    }
  }
}

/**
 * @deprecated Use HardenedExecutor instead. WorkflowEngine was renamed to HardenedExecutor
 * to clarify that this is a single-step hardened executor, not a multi-step workflow engine.
 */
export const WorkflowEngine = HardenedExecutor;
