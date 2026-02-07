import { describe, it, expect } from "vitest";
import {
  CircuitBreaker,
  classifyGitHubFailure,
  type CircuitBreakerState,
  type FailureClass,
  type OperationContext,
} from "../circuit-breaker.js";
import { PersistenceError } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────

function createCB(
  config?: Partial<{
    // Legacy keys
    maxFailures: number;
    resetTimeMs: number;
    halfOpenRetries: number;
    // Enhanced keys
    failureThreshold: number;
    rollingWindowMs: number;
    openDurationMs: number;
    halfOpenProbeCount: number;
    countableClasses: FailureClass[];
  }>,
  options?: {
    onStateChange?: (from: CircuitBreakerState, to: CircuitBreakerState) => void;
    now?: () => number;
  },
) {
  return new CircuitBreaker(config, options);
}

function tripCircuit(
  cb: CircuitBreaker,
  count: number,
  failureClass: FailureClass = "transient",
): void {
  for (let i = 0; i < count; i++) {
    cb.recordFailure(failureClass);
  }
}

// ── Backwards Compatibility (TASK-2.6b) ────────────────────────

describe("CircuitBreaker — backwards compatibility", () => {
  it("starts in CLOSED state", () => {
    const cb = createCB();
    expect(cb.getState()).toBe("CLOSED");
  });

  it("accepts legacy config shape (maxFailures, resetTimeMs, halfOpenRetries)", () => {
    const transitions: Array<[CircuitBreakerState, CircuitBreakerState]> = [];
    const cb = createCB(
      { maxFailures: 3, resetTimeMs: 5000, halfOpenRetries: 1 },
      { onStateChange: (from, to) => transitions.push([from, to]) },
    );

    tripCircuit(cb, 3);
    expect(cb.getState()).toBe("OPEN");
    expect(transitions).toEqual([["CLOSED", "OPEN"]]);
  });

  it("recordFailure() without args defaults to transient", () => {
    const cb = createCB({ failureThreshold: 2, rollingWindowMs: 60_000 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
  });

  it("execute() signature unchanged — passes through on CLOSED", async () => {
    const cb = createCB();
    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
  });

  it("execute() throws CB_OPEN when circuit is open", async () => {
    const cb = createCB({ maxFailures: 1 });
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    await expect(cb.execute(async () => "nope")).rejects.toThrow(PersistenceError);
    try {
      await cb.execute(async () => "nope");
    } catch (e) {
      expect((e as PersistenceError).code).toBe("CB_OPEN");
    }
  });

  it("execute() records failure on function throw", async () => {
    const cb = createCB({ maxFailures: 2 });

    await expect(
      cb.execute(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(cb.getFailureCount()).toBe(1);
  });

  it("execute() records success on function resolve", async () => {
    const cb = createCB();
    cb.recordFailure();
    expect(cb.getFailureCount()).toBe(1);

    await cb.execute(async () => "ok");
    expect(cb.getFailureCount()).toBe(0);
  });

  it("getFailureCount() returns rolling window total", () => {
    const cb = createCB({ failureThreshold: 10, rollingWindowMs: 60_000 });
    tripCircuit(cb, 4);
    expect(cb.getFailureCount()).toBe(4);
  });

  it("reset() forces CLOSED regardless of current state", () => {
    const cb = createCB({ maxFailures: 1 });
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    cb.reset();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getFailureCount()).toBe(0);
  });

  it("legacy halfOpenRetries maps to halfOpenProbeCount", () => {
    let clock = 0;
    const cb = createCB(
      { maxFailures: 1, resetTimeMs: 100, halfOpenRetries: 2 },
      { now: () => clock },
    );

    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    clock = 100;
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
  });
});

// ── Failure Classification ─────────────────────────────────────

describe("CircuitBreaker — failure classification", () => {
  it("counts only countable classes toward threshold", () => {
    const cb = createCB({
      failureThreshold: 3,
      rollingWindowMs: 60_000,
      countableClasses: ["transient", "external", "rate_limited"],
    });

    // permanent and expected do not count
    cb.recordFailure("permanent");
    cb.recordFailure("permanent");
    cb.recordFailure("permanent");
    expect(cb.getState()).toBe("CLOSED");

    // transient counts
    cb.recordFailure("transient");
    cb.recordFailure("external");
    cb.recordFailure("rate_limited");
    expect(cb.getState()).toBe("OPEN");
  });

  it("expected failures never trip the circuit", () => {
    const cb = createCB({ failureThreshold: 1, rollingWindowMs: 60_000 });

    cb.recordFailure("expected");
    cb.recordFailure("expected");
    cb.recordFailure("expected");
    expect(cb.getState()).toBe("CLOSED");
    // They still appear in the window
    expect(cb.getFailureCount()).toBe(3);
  });

  it("permanent failures do not count by default", () => {
    const cb = createCB({ failureThreshold: 2, rollingWindowMs: 60_000 });

    cb.recordFailure("permanent");
    cb.recordFailure("permanent");
    expect(cb.getState()).toBe("CLOSED");

    // but transient does
    cb.recordFailure("transient");
    cb.recordFailure("transient");
    expect(cb.getState()).toBe("OPEN");
  });

  it("all five failure classes are accepted", () => {
    const cb = createCB({ failureThreshold: 100, rollingWindowMs: 60_000 });
    const classes: FailureClass[] = [
      "transient",
      "permanent",
      "expected",
      "external",
      "rate_limited",
    ];
    for (const cls of classes) {
      cb.recordFailure(cls);
    }
    expect(cb.getFailureCount()).toBe(5);
    const window = cb.getFailureWindow();
    expect(window.map((r) => r.failureClass)).toEqual(classes);
  });
});

// ── Rolling Window ─────────────────────────────────────────────

describe("CircuitBreaker — rolling window", () => {
  it("evicts records older than rollingWindowMs", () => {
    let clock = 0;
    const cb = createCB({ failureThreshold: 10, rollingWindowMs: 1000 }, { now: () => clock });

    cb.recordFailure("transient");
    clock = 500;
    cb.recordFailure("transient");
    expect(cb.getFailureCount()).toBe(2);

    // Advance past the window for the first record
    clock = 1001;
    expect(cb.getFailureCount()).toBe(1);

    // Advance past the window for the second record
    clock = 1501;
    expect(cb.getFailureCount()).toBe(0);
  });

  it("window eviction prevents threshold trip from stale failures", () => {
    let clock = 0;
    const cb = createCB({ failureThreshold: 3, rollingWindowMs: 1000 }, { now: () => clock });

    cb.recordFailure("transient"); // t=0
    clock = 400;
    cb.recordFailure("transient"); // t=400
    clock = 800;
    cb.recordFailure("transient"); // t=800 -- but first is NOT yet stale
    expect(cb.getState()).toBe("OPEN");
  });

  it("stale failures that fall out of window do not trip threshold", () => {
    let clock = 0;
    const cb = createCB({ failureThreshold: 3, rollingWindowMs: 1000 }, { now: () => clock });

    cb.recordFailure("transient"); // t=0
    clock = 600;
    cb.recordFailure("transient"); // t=600

    // First record is now stale
    clock = 1100;
    cb.recordFailure("transient"); // t=1100, window has [t=600, t=1100]
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getFailureCount()).toBe(2);
  });
});

// ── State Machine Transitions ──────────────────────────────────

describe("CircuitBreaker — state transitions", () => {
  it("CLOSED -> OPEN after failureThreshold countable failures", () => {
    const transitions: Array<[CircuitBreakerState, CircuitBreakerState]> = [];
    const cb = createCB(
      { failureThreshold: 3, rollingWindowMs: 60_000 },
      { onStateChange: (from, to) => transitions.push([from, to]) },
    );

    tripCircuit(cb, 3);
    expect(cb.getState()).toBe("OPEN");
    expect(transitions).toEqual([["CLOSED", "OPEN"]]);
  });

  it("OPEN -> HALF_OPEN after openDurationMs elapses", () => {
    let clock = 0;
    const transitions: Array<[CircuitBreakerState, CircuitBreakerState]> = [];
    const cb = createCB(
      { failureThreshold: 1, openDurationMs: 1000, rollingWindowMs: 60_000 },
      {
        now: () => clock,
        onStateChange: (from, to) => transitions.push([from, to]),
      },
    );

    cb.recordFailure("transient");
    expect(cb.getState()).toBe("OPEN");

    clock = 500;
    expect(cb.getState()).toBe("OPEN");

    clock = 1000;
    expect(cb.getState()).toBe("HALF_OPEN");
    expect(transitions).toEqual([
      ["CLOSED", "OPEN"],
      ["OPEN", "HALF_OPEN"],
    ]);
  });

  it("HALF_OPEN -> CLOSED after halfOpenProbeCount successes", () => {
    let clock = 0;
    const cb = createCB(
      {
        failureThreshold: 1,
        openDurationMs: 100,
        halfOpenProbeCount: 2,
        rollingWindowMs: 60_000,
      },
      { now: () => clock },
    );

    cb.recordFailure("transient");
    expect(cb.getState()).toBe("OPEN");

    clock = 100;
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.getFailureCount()).toBe(0);
  });

  it("HALF_OPEN -> OPEN on failure during probe", () => {
    let clock = 0;
    const transitions: Array<[CircuitBreakerState, CircuitBreakerState]> = [];
    const cb = createCB(
      { failureThreshold: 1, openDurationMs: 100, rollingWindowMs: 60_000 },
      {
        now: () => clock,
        onStateChange: (from, to) => transitions.push([from, to]),
      },
    );

    cb.recordFailure("transient");
    clock = 100;
    cb.getState(); // trigger HALF_OPEN

    cb.recordFailure("transient");
    expect(cb.getState()).toBe("OPEN");

    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition).toEqual(["HALF_OPEN", "OPEN"]);
  });

  it("full cycle: CLOSED -> OPEN -> HALF_OPEN -> CLOSED", () => {
    let clock = 0;
    const transitions: Array<[CircuitBreakerState, CircuitBreakerState]> = [];
    const cb = createCB(
      {
        failureThreshold: 2,
        openDurationMs: 500,
        halfOpenProbeCount: 1,
        rollingWindowMs: 60_000,
      },
      {
        now: () => clock,
        onStateChange: (from, to) => transitions.push([from, to]),
      },
    );

    expect(cb.getState()).toBe("CLOSED");

    cb.recordFailure("transient");
    cb.recordFailure("external");
    expect(cb.getState()).toBe("OPEN");

    clock = 500;
    expect(cb.getState()).toBe("HALF_OPEN");

    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");

    expect(transitions).toEqual([
      ["CLOSED", "OPEN"],
      ["OPEN", "HALF_OPEN"],
      ["HALF_OPEN", "CLOSED"],
    ]);
  });
});

// ── classifyGitHubFailure ──────────────────────────────────────

describe("classifyGitHubFailure", () => {
  // Rule 1: caller overrides
  it("caller override takes precedence over default classification", () => {
    const ctx: OperationContext = { classifyOverrides: { 404: "permanent" } };
    expect(classifyGitHubFailure({ status: 404 }, ctx)).toBe("permanent");
  });

  it("caller override for 500 overrides default transient", () => {
    const ctx: OperationContext = { classifyOverrides: { 500: "expected" } };
    expect(classifyGitHubFailure({ status: 500 }, ctx)).toBe("expected");
  });

  // Rule 2: 429 -> rate_limited
  it("429 -> rate_limited", () => {
    expect(classifyGitHubFailure({ status: 429 })).toBe("rate_limited");
  });

  it("429 -> rate_limited even with resourceShouldExist context", () => {
    expect(classifyGitHubFailure({ status: 429 }, { resourceShouldExist: true })).toBe(
      "rate_limited",
    );
  });

  // Rule 3: 403 variants
  it("403 + Retry-After header -> rate_limited", () => {
    expect(
      classifyGitHubFailure({
        status: 403,
        headers: { "Retry-After": "60" },
      }),
    ).toBe("rate_limited");
  });

  it("403 + x-ratelimit-remaining: 0 -> rate_limited", () => {
    expect(
      classifyGitHubFailure({
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      }),
    ).toBe("rate_limited");
  });

  it("403 + body containing 'secondary rate limit' -> rate_limited", () => {
    expect(
      classifyGitHubFailure({
        status: 403,
        body: "You have exceeded a secondary rate limit",
      }),
    ).toBe("rate_limited");
  });

  it("403 + body containing 'abuse detection' -> rate_limited", () => {
    expect(
      classifyGitHubFailure({
        status: 403,
        message: "abuse detection mechanism triggered",
      }),
    ).toBe("rate_limited");
  });

  it("403 without rate-limit signals -> transient", () => {
    expect(classifyGitHubFailure({ status: 403 })).toBe("transient");
  });

  it("403 with headers using .get() method -> rate_limited", () => {
    const headers = {
      get(name: string) {
        if (name.toLowerCase() === "retry-after") return "120";
        return null;
      },
    };
    expect(classifyGitHubFailure({ status: 403, headers })).toBe("rate_limited");
  });

  // Rule 4: 404 variants
  it("404 + resourceShouldExist=true -> transient", () => {
    expect(classifyGitHubFailure({ status: 404 }, { resourceShouldExist: true })).toBe("transient");
  });

  it("404 + resourceShouldExist=false -> expected", () => {
    expect(classifyGitHubFailure({ status: 404 }, { resourceShouldExist: false })).toBe("expected");
  });

  it("404 without context -> expected", () => {
    expect(classifyGitHubFailure({ status: 404 })).toBe("expected");
  });

  it("404 does NOT trip circuit when no context (expected class)", () => {
    const cb = createCB({ failureThreshold: 1, rollingWindowMs: 60_000 });
    const cls = classifyGitHubFailure({ status: 404 });
    expect(cls).toBe("expected");

    cb.recordFailure(cls);
    cb.recordFailure(cls);
    cb.recordFailure(cls);
    expect(cb.getState()).toBe("CLOSED");
  });

  // Rule 5: 422 -> permanent
  it("422 -> permanent", () => {
    expect(classifyGitHubFailure({ status: 422 })).toBe("permanent");
  });

  // Rule 6: 500, 502, 503 -> transient
  it("500 -> transient", () => {
    expect(classifyGitHubFailure({ status: 500 })).toBe("transient");
  });

  it("502 -> transient", () => {
    expect(classifyGitHubFailure({ status: 502 })).toBe("transient");
  });

  it("503 -> transient", () => {
    expect(classifyGitHubFailure({ status: 503 })).toBe("transient");
  });

  // Rule 7: network errors -> external
  it("ECONNRESET -> external", () => {
    expect(classifyGitHubFailure({ code: "ECONNRESET" })).toBe("external");
  });

  it("ETIMEDOUT -> external", () => {
    expect(classifyGitHubFailure({ code: "ETIMEDOUT" })).toBe("external");
  });

  it("ENOTFOUND -> external", () => {
    expect(classifyGitHubFailure({ code: "ENOTFOUND" })).toBe("external");
  });

  // Rule 8: all others -> transient
  it("unknown status -> transient", () => {
    expect(classifyGitHubFailure({ status: 418 })).toBe("transient");
  });

  it("no status and no network error code -> transient", () => {
    expect(classifyGitHubFailure({})).toBe("transient");
  });

  // Override with context
  it("override wins even for 429", () => {
    const ctx: OperationContext = { classifyOverrides: { 429: "expected" } };
    expect(classifyGitHubFailure({ status: 429 }, ctx)).toBe("expected");
  });
});
