/**
 * Enhanced Circuit Breaker with rolling window, failure classification,
 * and GitHub-specific failure classification.
 *
 * States: CLOSED -> OPEN (after threshold failures in window) -> HALF_OPEN (after timeout) -> CLOSED
 *
 * No timers -- state transitions happen lazily on execute()/getState() calls.
 * This avoids timer leaks and makes the component fully testable with fake clocks.
 *
 * Backwards compatible with the original consecutive-failure API (TASK-2.6b).
 *
 * Extracted from deploy/loa-identity/scheduler/scheduler.ts
 * Enhanced per SDD section 3.5 (TASK-2.6, TASK-2.6b, TASK-2.7)
 */

import { PersistenceError } from "./types.js";

// ── Failure Classification ─────────────────────────────────────

export type FailureClass = "transient" | "permanent" | "expected" | "external" | "rate_limited";

export interface OperationContext {
  resourceShouldExist?: boolean;
  classifyOverrides?: Partial<Record<number, FailureClass>>;
}

export interface FailureRecord {
  timestamp: number;
  failureClass: FailureClass;
}

// ── Types ──────────────────────────────────────────────────────

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Legacy config shape for backwards compatibility. */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 3 */
  maxFailures: number;
  /** Time in ms before attempting half-open probe. Default: 5 minutes */
  resetTimeMs: number;
  /** Number of successful probes in HALF_OPEN before closing. Default: 1 */
  halfOpenRetries: number;
}

/** Enhanced config with rolling window and failure classification. */
export interface EnhancedCircuitBreakerConfig {
  /** Number of countable failures in the rolling window to trip the circuit. Default: 5 */
  failureThreshold: number;
  /** Rolling window duration in ms. Default: 1 hour */
  rollingWindowMs: number;
  /** Duration the circuit stays open before probing. Default: 30 minutes */
  openDurationMs: number;
  /** Number of successful probes required to close the circuit. Default: 2 */
  halfOpenProbeCount: number;
  /** Failure classes that count toward the threshold. Default: transient, external, rate_limited */
  countableClasses?: FailureClass[];
}

export type CircuitBreakerStateChangeCallback = (
  from: CircuitBreakerState,
  to: CircuitBreakerState,
) => void;

// ── Defaults ───────────────────────────────────────────────────

const DEFAULT_ENHANCED_CONFIG: Required<EnhancedCircuitBreakerConfig> = {
  failureThreshold: 5,
  rollingWindowMs: 3_600_000, // 1 hour
  openDurationMs: 1_800_000, // 30 minutes
  halfOpenProbeCount: 2,
  countableClasses: ["transient", "external", "rate_limited"],
};

// ── Config Adapter ─────────────────────────────────────────────

/** Detect whether a config object uses the legacy shape. */
function isLegacyConfig(
  config: Partial<CircuitBreakerConfig> | Partial<EnhancedCircuitBreakerConfig>,
): config is Partial<CircuitBreakerConfig> {
  return "maxFailures" in config || "resetTimeMs" in config || "halfOpenRetries" in config;
}

/** Map old config keys to the enhanced config. */
function adaptLegacyConfig(
  legacy: Partial<CircuitBreakerConfig>,
): Partial<EnhancedCircuitBreakerConfig> {
  const adapted: Partial<EnhancedCircuitBreakerConfig> = {};
  if (legacy.maxFailures !== undefined) {
    adapted.failureThreshold = legacy.maxFailures;
  }
  if (legacy.resetTimeMs !== undefined) {
    adapted.openDurationMs = legacy.resetTimeMs;
  }
  if (legacy.halfOpenRetries !== undefined) {
    adapted.halfOpenProbeCount = legacy.halfOpenRetries;
  }
  return adapted;
}

// ── GitHub Failure Classifier ──────────────────────────────────

/** HTTP error shape for classification. */
interface HttpErrorLike {
  status?: number;
  headers?: Record<string, string> | { get?(name: string): string | null | undefined };
  message?: string;
  body?: string;
  code?: string;
}

/** Resolve a header value from various header container shapes. */
function getHeader(
  headers: Record<string, string> | { get?(name: string): string | null | undefined } | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const val = (headers as { get(name: string): string | null | undefined }).get(name);
    return val ?? undefined;
  }
  // Plain object -- case-insensitive lookup
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return (headers as Record<string, string>)[key];
    }
  }
  return undefined;
}

/**
 * Classify a GitHub API failure into a FailureClass.
 *
 * Rules (evaluated in order per SDD section 3.5):
 * 1. Caller overrides (context.classifyOverrides) checked first
 * 2. 429 -> rate_limited (always)
 * 3. 403 -> rate_limited if Retry-After header, x-ratelimit-remaining: "0", or rate-limit body text; else transient
 * 4. 404 -> transient if resourceShouldExist=true; expected if false or no context
 * 5. 422 -> permanent
 * 6. 500, 502, 503 -> transient
 * 7. Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND) -> external
 * 8. All others -> transient
 */
export function classifyGitHubFailure(
  error: HttpErrorLike,
  context?: OperationContext,
): FailureClass {
  const status = error.status;

  // Rule 1: caller overrides
  if (status !== undefined && context?.classifyOverrides?.[status] !== undefined) {
    return context.classifyOverrides[status] as FailureClass;
  }

  // Rule 7: network errors (check before status since network errors may lack status)
  const errorCode = error.code;
  if (errorCode) {
    const networkCodes = ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"];
    if (networkCodes.includes(errorCode)) {
      return "external";
    }
  }

  if (status === undefined) {
    return "transient";
  }

  // Rule 2: 429 -> rate_limited
  if (status === 429) {
    return "rate_limited";
  }

  // Rule 3: 403 with rate-limit signals
  if (status === 403) {
    const retryAfter = getHeader(error.headers, "retry-after");
    if (retryAfter) return "rate_limited";

    const remaining = getHeader(error.headers, "x-ratelimit-remaining");
    if (remaining === "0") return "rate_limited";

    const bodyText = (error.body ?? error.message ?? "").toLowerCase();
    if (bodyText.includes("secondary rate limit") || bodyText.includes("abuse detection")) {
      return "rate_limited";
    }

    return "transient";
  }

  // Rule 4: 404
  if (status === 404) {
    if (context?.resourceShouldExist === true) return "transient";
    return "expected";
  }

  // Rule 5: 422 -> permanent
  if (status === 422) {
    return "permanent";
  }

  // Rule 6: 500, 502, 503 -> transient
  if (status === 500 || status === 502 || status === 503) {
    return "transient";
  }

  // Rule 8: all others -> transient
  return "transient";
}

// ── Implementation ─────────────────────────────────────────────

export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private failureWindow: FailureRecord[] = [];
  private halfOpenSuccesses = 0;
  private lastFailureTime = -1;
  private readonly enhancedConfig: Required<EnhancedCircuitBreakerConfig>;
  private onStateChange?: CircuitBreakerStateChangeCallback;
  private nowFn: () => number;

  constructor(
    config?: Partial<CircuitBreakerConfig> | Partial<EnhancedCircuitBreakerConfig>,
    options?: {
      onStateChange?: CircuitBreakerStateChangeCallback;
      /** Injectable clock for testing. Defaults to Date.now */
      now?: () => number;
    },
  ) {
    // Adapt legacy config if needed
    let resolved: Partial<EnhancedCircuitBreakerConfig> = {};
    if (config) {
      resolved = isLegacyConfig(config)
        ? adaptLegacyConfig(config)
        : (config as Partial<EnhancedCircuitBreakerConfig>);
    }
    this.enhancedConfig = { ...DEFAULT_ENHANCED_CONFIG, ...resolved };
    this.onStateChange = options?.onStateChange;
    this.nowFn = options?.now ?? Date.now;
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws PersistenceError with code CB_OPEN if the circuit is open.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === "OPEN") {
      throw new PersistenceError(
        "CB_OPEN",
        `Circuit breaker is OPEN (${this.getFailureCount()} failures, ` +
          `resets in ${this.msUntilReset()}ms)`,
      );
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Record a successful operation.
   */
  recordSuccess(): void {
    if (this.state === "HALF_OPEN") {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.enhancedConfig.halfOpenProbeCount) {
        this.transition("CLOSED");
        this.failureWindow = [];
        this.halfOpenSuccesses = 0;
      }
    } else {
      // In the enhanced model, success does not clear the rolling window.
      // It only matters when in HALF_OPEN.
      // For backwards compat with getFailureCount() after recordSuccess() in CLOSED,
      // we clear the window (legacy behavior: consecutiveFailures = 0 on success).
      this.failureWindow = [];
    }
  }

  /**
   * Record a failed operation.
   * @param failureClass - Classification of the failure. Defaults to "transient".
   */
  recordFailure(failureClass: FailureClass = "transient"): void {
    const now = this.nowFn();
    this.lastFailureTime = now;

    // Push new record
    this.failureWindow.push({ timestamp: now, failureClass });

    // Evict records older than the rolling window
    this.evictStaleRecords(now);

    // "expected" failures do not evaluate the threshold
    if (failureClass === "expected") {
      return;
    }

    if (this.state === "HALF_OPEN") {
      // Half-open probe failed -- go back to OPEN
      this.halfOpenSuccesses = 0;
      this.transition("OPEN");
    } else if (this.state === "CLOSED") {
      // Count records in countable classes
      const countable = this.countCountableFailures();
      if (countable >= this.enhancedConfig.failureThreshold) {
        this.transition("OPEN");
      }
    }
  }

  /**
   * Get the current state, lazily transitioning OPEN -> HALF_OPEN if timeout elapsed.
   */
  getState(): CircuitBreakerState {
    if (this.state === "OPEN" && this.lastFailureTime >= 0) {
      const elapsed = this.nowFn() - this.lastFailureTime;
      if (elapsed >= this.enhancedConfig.openDurationMs) {
        this.transition("HALF_OPEN");
        this.halfOpenSuccesses = 0;
      }
    }
    return this.state;
  }

  /**
   * Force-reset the circuit breaker to CLOSED state.
   */
  reset(): void {
    this.failureWindow = [];
    this.halfOpenSuccesses = 0;
    this.lastFailureTime = -1;
    this.transition("CLOSED");
  }

  /**
   * Get the number of failures in the current rolling window.
   * For backwards compatibility, returns the total count (all classes).
   */
  getFailureCount(): number {
    this.evictStaleRecords(this.nowFn());
    return this.failureWindow.length;
  }

  /**
   * Get the current failure window records (for observability).
   */
  getFailureWindow(): ReadonlyArray<FailureRecord> {
    this.evictStaleRecords(this.nowFn());
    return [...this.failureWindow];
  }

  // ── Private ──────────────────────────────────────────────

  private transition(to: CircuitBreakerState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onStateChange?.(from, to);
  }

  private msUntilReset(): number {
    if (this.state !== "OPEN" || this.lastFailureTime < 0) return 0;
    const elapsed = this.nowFn() - this.lastFailureTime;
    return Math.max(0, this.enhancedConfig.openDurationMs - elapsed);
  }

  private evictStaleRecords(now: number): void {
    const cutoff = now - this.enhancedConfig.rollingWindowMs;
    this.failureWindow = this.failureWindow.filter((r) => r.timestamp >= cutoff);
  }

  private countCountableFailures(): number {
    const countable = this.enhancedConfig.countableClasses;
    return this.failureWindow.filter((r) => countable.includes(r.failureClass)).length;
  }
}
