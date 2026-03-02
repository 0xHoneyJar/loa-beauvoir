/**
 * Token Bucket Rate Limiter with dual-bucket enforcement.
 *
 * Enforces both a global bucket (shared across all workflows) and
 * per-workflow buckets (created lazily). Both must have tokens for
 * a request to be allowed.
 *
 * Designed for GitHub API rate limiting: supports primary (token depletion)
 * and secondary (abuse detection) rate limit signals.
 *
 * SDD ref: Section 3.6 — Token Bucket Rate Limiter (TASK-2.8, TASK-2.9)
 */

// ── Types ────────────────────────────────────────────────────

export interface TokenBucket {
  tokens: number;
  capacity: number;
  refillPerHour: number;
  lastRefill: number; // timestamp ms
}

export interface RateLimiterConfig {
  globalCapacity?: number; // default: 500
  globalRefillPerHour?: number; // default: 500
  perWorkflowCapacity?: number; // default: 100
  perWorkflowRefillPerHour?: number; // default: 100
  idleEvictionMs?: number; // default: 3600000 (1hr)
  now?: () => number; // injectable clock
}

export interface ConsumeResult {
  allowed: boolean;
  retryAfterMs?: number;
  bucket: "global" | "workflow";
}

// ── Internal per-workflow tracking ───────────────────────────

interface WorkflowState {
  bucket: TokenBucket;
  lastAccess: number;
  backoffAttempts: number;
  /** Minimum wait from a secondary rate limit (ms). */
  secondaryRetryAfterMs: number;
}

// ── Defaults ─────────────────────────────────────────────────

const DEFAULTS = {
  globalCapacity: 500,
  globalRefillPerHour: 500,
  perWorkflowCapacity: 100,
  perWorkflowRefillPerHour: 100,
  idleEvictionMs: 3_600_000,
  cleanupIntervalMs: 60_000,
} as const;

const BACKOFF = {
  baseMs: 1_000,
  maxMs: 60_000,
} as const;

// ── Helpers ──────────────────────────────────────────────────

function refill(bucket: TokenBucket, now: number): void {
  const elapsedMs = now - bucket.lastRefill;
  if (elapsedMs <= 0) return;
  const elapsedHours = elapsedMs / 3_600_000;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsedHours * bucket.refillPerHour);
  bucket.lastRefill = now;
}

/** Time in ms until at least 1 token would be refilled. */
function msUntilToken(bucket: TokenBucket): number {
  if (bucket.tokens >= 1) return 0;
  const deficit = 1 - bucket.tokens;
  return Math.ceil((deficit / bucket.refillPerHour) * 3_600_000);
}

// ── Implementation ───────────────────────────────────────────

export class RateLimiter {
  private readonly global: TokenBucket;
  private readonly workflows = new Map<string, WorkflowState>();
  private readonly config: Required<Omit<RateLimiterConfig, "now">>;
  private readonly nowFn: () => number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: RateLimiterConfig) {
    this.nowFn = config?.now ?? Date.now;
    this.config = {
      globalCapacity: config?.globalCapacity ?? DEFAULTS.globalCapacity,
      globalRefillPerHour: config?.globalRefillPerHour ?? DEFAULTS.globalRefillPerHour,
      perWorkflowCapacity: config?.perWorkflowCapacity ?? DEFAULTS.perWorkflowCapacity,
      perWorkflowRefillPerHour:
        config?.perWorkflowRefillPerHour ?? DEFAULTS.perWorkflowRefillPerHour,
      idleEvictionMs: config?.idleEvictionMs ?? DEFAULTS.idleEvictionMs,
    };

    const now = this.nowFn();
    this.global = {
      tokens: this.config.globalCapacity,
      capacity: this.config.globalCapacity,
      refillPerHour: this.config.globalRefillPerHour,
      lastRefill: now,
    };

    // TASK-2.9: periodic idle bucket cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), DEFAULTS.cleanupIntervalMs);
    if (
      this.cleanupTimer &&
      typeof this.cleanupTimer === "object" &&
      "unref" in this.cleanupTimer
    ) {
      (this.cleanupTimer as NodeJS.Timeout).unref();
    }
  }

  /** Try to consume one token. Checks both global and per-workflow buckets. */
  tryConsume(workflowId: string): ConsumeResult {
    const now = this.nowFn();
    const wf = this.getOrCreateWorkflow(workflowId, now);
    wf.lastAccess = now;

    // Respect secondary rate limit hold-off
    if (wf.secondaryRetryAfterMs > 0) {
      const waitMs = wf.secondaryRetryAfterMs;
      wf.secondaryRetryAfterMs = 0;
      return { allowed: false, retryAfterMs: waitMs, bucket: "workflow" };
    }

    // Refill both buckets
    refill(this.global, now);
    refill(wf.bucket, now);

    // Check global first
    if (this.global.tokens < 1) {
      return { allowed: false, retryAfterMs: msUntilToken(this.global), bucket: "global" };
    }

    // Check per-workflow
    if (wf.bucket.tokens < 1) {
      return { allowed: false, retryAfterMs: msUntilToken(wf.bucket), bucket: "workflow" };
    }

    // Consume from both
    this.global.tokens -= 1;
    wf.bucket.tokens -= 1;
    wf.backoffAttempts = 0;
    return { allowed: true, bucket: "workflow" };
  }

  /** Record a rate limit response from GitHub. */
  recordRateLimit(workflowId: string, type: "primary" | "secondary", retryAfterSec?: number): void {
    const now = this.nowFn();
    const wf = this.getOrCreateWorkflow(workflowId, now);
    wf.backoffAttempts++;

    if (type === "primary") {
      // Drain the global bucket to prevent other workflows from hitting the same limit
      this.global.tokens = 0;
    } else {
      // Secondary: set a minimum wait and penalize the workflow bucket
      const waitMs = retryAfterSec ? retryAfterSec * 1000 : BACKOFF.maxMs;
      wf.secondaryRetryAfterMs = waitMs;
      wf.bucket.tokens = 0;
    }
  }

  /** Get backoff delay with exponential + jitter (+-25%). */
  getBackoffMs(workflowId: string): number {
    const wf = this.workflows.get(workflowId);
    if (!wf || wf.backoffAttempts === 0) return 0;

    const expDelay = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** wf.backoffAttempts);
    // Jitter: multiply by random factor in [0.75, 1.25]
    const jitter = 0.75 + Math.random() * 0.5;
    const result = Math.round(expDelay * jitter);

    // For secondary limits, enforce the retryAfter floor
    return Math.max(result, wf.secondaryRetryAfterMs);
  }

  /** TASK-2.9: Remove per-workflow buckets idle longer than idleEvictionMs. */
  cleanup(): number {
    const now = this.nowFn();
    let evicted = 0;
    for (const [id, wf] of this.workflows) {
      if (now - wf.lastAccess >= this.config.idleEvictionMs) {
        this.workflows.delete(id);
        evicted++;
      }
    }
    return evicted;
  }

  /** Shutdown the cleanup interval timer. */
  shutdown(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ── Private ────────────────────────────────────────────────

  private getOrCreateWorkflow(workflowId: string, now: number): WorkflowState {
    let wf = this.workflows.get(workflowId);
    if (!wf) {
      wf = {
        bucket: {
          tokens: this.config.perWorkflowCapacity,
          capacity: this.config.perWorkflowCapacity,
          refillPerHour: this.config.perWorkflowRefillPerHour,
          lastRefill: now,
        },
        lastAccess: now,
        backoffAttempts: 0,
        secondaryRetryAfterMs: 0,
      };
      this.workflows.set(workflowId, wf);
    }
    return wf;
  }
}
