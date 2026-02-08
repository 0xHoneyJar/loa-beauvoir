import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimiter } from "../rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.shutdown();
  });

  function createLimiter(overrides?: Parameters<typeof RateLimiter.prototype.constructor>[0]) {
    const clock = { now: 0 };
    limiter = new RateLimiter({ now: () => clock.now, ...overrides });
    return { limiter, clock };
  }

  // ── Lazy per-workflow bucket creation ──────────────────────

  it("creates per-workflow bucket lazily on first tryConsume", () => {
    const { limiter } = createLimiter();
    const r = limiter.tryConsume("wf-1");
    expect(r.allowed).toBe(true);
  });

  // ── Token refill accuracy ─────────────────────────────────

  it("refills tokens based on elapsed time", () => {
    const { limiter, clock } = createLimiter({
      globalCapacity: 2,
      globalRefillPerHour: 2,
      perWorkflowCapacity: 2,
      perWorkflowRefillPerHour: 2,
    });

    // Drain both tokens
    limiter.tryConsume("wf-1");
    limiter.tryConsume("wf-1");
    const depleted = limiter.tryConsume("wf-1");
    expect(depleted.allowed).toBe(false);

    // Advance 30 minutes → should refill 1 token (2/hr * 0.5hr = 1)
    clock.now += 1_800_000;
    const refilled = limiter.tryConsume("wf-1");
    expect(refilled.allowed).toBe(true);

    // Should be depleted again after consuming the 1 refilled token
    const depletedAgain = limiter.tryConsume("wf-1");
    expect(depletedAgain.allowed).toBe(false);
  });

  it("caps refilled tokens at capacity", () => {
    const { limiter, clock } = createLimiter({
      globalCapacity: 3,
      globalRefillPerHour: 100,
      perWorkflowCapacity: 3,
      perWorkflowRefillPerHour: 100,
    });

    // Drain all tokens
    limiter.tryConsume("wf-1");
    limiter.tryConsume("wf-1");
    limiter.tryConsume("wf-1");

    // Advance a full hour — refill would be 100, but capacity is 3
    clock.now += 3_600_000;
    limiter.tryConsume("wf-1"); // 1
    limiter.tryConsume("wf-1"); // 2
    limiter.tryConsume("wf-1"); // 3
    const fourth = limiter.tryConsume("wf-1");
    expect(fourth.allowed).toBe(false);
  });

  // ── Dual-bucket depletion ─────────────────────────────────

  it("reports global bucket depleted when global runs out first", () => {
    const { limiter } = createLimiter({
      globalCapacity: 1,
      globalRefillPerHour: 0,
      perWorkflowCapacity: 100,
      perWorkflowRefillPerHour: 0,
    });

    const first = limiter.tryConsume("wf-1");
    expect(first.allowed).toBe(true);

    const second = limiter.tryConsume("wf-1");
    expect(second.allowed).toBe(false);
    expect(second.bucket).toBe("global");
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it("reports workflow bucket depleted when workflow runs out first", () => {
    const { limiter } = createLimiter({
      globalCapacity: 100,
      globalRefillPerHour: 0,
      perWorkflowCapacity: 1,
      perWorkflowRefillPerHour: 0,
    });

    const first = limiter.tryConsume("wf-1");
    expect(first.allowed).toBe(true);

    const second = limiter.tryConsume("wf-1");
    expect(second.allowed).toBe(false);
    expect(second.bucket).toBe("workflow");
  });

  it("per-workflow buckets are independent", () => {
    const { limiter } = createLimiter({
      globalCapacity: 500,
      globalRefillPerHour: 0,
      perWorkflowCapacity: 1,
      perWorkflowRefillPerHour: 0,
    });

    expect(limiter.tryConsume("wf-1").allowed).toBe(true);
    expect(limiter.tryConsume("wf-1").allowed).toBe(false);

    // Different workflow still has its own token
    expect(limiter.tryConsume("wf-2").allowed).toBe(true);
    expect(limiter.tryConsume("wf-2").allowed).toBe(false);
  });

  // ── retryAfterMs calculation ──────────────────────────────

  it("returns correct retryAfterMs when bucket is depleted", () => {
    const { limiter } = createLimiter({
      globalCapacity: 1,
      globalRefillPerHour: 1, // 1 token/hr = 3600s per token
      perWorkflowCapacity: 100,
      perWorkflowRefillPerHour: 100,
    });

    limiter.tryConsume("wf-1");
    const result = limiter.tryConsume("wf-1");
    expect(result.allowed).toBe(false);
    // Need 1 token at 1/hr → 3600000ms
    expect(result.retryAfterMs).toBe(3_600_000);
  });

  // ── recordRateLimit ───────────────────────────────────────

  it("primary rate limit drains global bucket", () => {
    const { limiter } = createLimiter({
      globalCapacity: 10,
      globalRefillPerHour: 0,
      perWorkflowCapacity: 10,
      perWorkflowRefillPerHour: 0,
    });

    limiter.tryConsume("wf-1");
    limiter.recordRateLimit("wf-1", "primary");

    // Global should be drained — even wf-2 can't consume
    const result = limiter.tryConsume("wf-2");
    expect(result.allowed).toBe(false);
    expect(result.bucket).toBe("global");
  });

  it("secondary rate limit sets workflow hold-off", () => {
    const { limiter } = createLimiter({
      globalCapacity: 500,
      globalRefillPerHour: 500,
      perWorkflowCapacity: 100,
      perWorkflowRefillPerHour: 100,
    });

    limiter.tryConsume("wf-1");
    limiter.recordRateLimit("wf-1", "secondary", 30);

    const result = limiter.tryConsume("wf-1");
    expect(result.allowed).toBe(false);
    expect(result.bucket).toBe("workflow");
    expect(result.retryAfterMs).toBe(30_000);
  });

  it("secondary hold-off is consumed on next tryConsume", () => {
    const { limiter, clock } = createLimiter({
      globalCapacity: 500,
      globalRefillPerHour: 500,
      perWorkflowCapacity: 100,
      perWorkflowRefillPerHour: 100,
    });

    limiter.tryConsume("wf-1");
    limiter.recordRateLimit("wf-1", "secondary", 5);

    // First call returns hold-off
    const blocked = limiter.tryConsume("wf-1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(5_000);

    // Advance time and try again — hold-off consumed, bucket refilled
    clock.now += 5_000;
    const retry = limiter.tryConsume("wf-1");
    // Workflow bucket was drained by secondary, but time advanced → some refill
    // With 100/hr and 5s elapsed: ~0.14 tokens. Still depleted.
    // But the hold-off itself is cleared.
    expect(retry.retryAfterMs).not.toBe(5_000);
  });

  // ── Backoff jitter ────────────────────────────────────────

  it("getBackoffMs returns 0 when no rate limits recorded", () => {
    const { limiter } = createLimiter();
    limiter.tryConsume("wf-1");
    expect(limiter.getBackoffMs("wf-1")).toBe(0);
  });

  it("getBackoffMs returns 0 for unknown workflow", () => {
    const { limiter } = createLimiter();
    expect(limiter.getBackoffMs("nonexistent")).toBe(0);
  });

  it("getBackoffMs increases exponentially with jitter in +-25% range", () => {
    const { limiter } = createLimiter();
    limiter.tryConsume("wf-1");

    // Record multiple rate limits to increase backoff attempts
    limiter.recordRateLimit("wf-1", "primary");

    // Sample multiple times to verify jitter range
    // After 1 attempt: base = min(60000, 1000 * 2^1) = 2000
    // Jitter range: [2000 * 0.75, 2000 * 1.25] = [1500, 2500]
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      samples.push(limiter.getBackoffMs("wf-1"));
    }

    const min = Math.min(...samples);
    const max = Math.max(...samples);

    // All samples should be within [1500, 2500]
    expect(min).toBeGreaterThanOrEqual(1500);
    expect(max).toBeLessThanOrEqual(2500);

    // With 50 samples, we should see some variation (jitter working)
    expect(max).toBeGreaterThan(min);
  });

  it("getBackoffMs caps at maxMs", () => {
    const { limiter } = createLimiter();
    limiter.tryConsume("wf-1");

    // Record many rate limits to push backoff high
    for (let i = 0; i < 20; i++) {
      limiter.recordRateLimit("wf-1", "primary");
    }

    // After 20 attempts: base = min(60000, 1000 * 2^20) → 60000
    // Max with jitter: 60000 * 1.25 = 75000
    const backoff = limiter.getBackoffMs("wf-1");
    expect(backoff).toBeLessThanOrEqual(75_000);
    expect(backoff).toBeGreaterThanOrEqual(45_000); // 60000 * 0.75
  });

  it("getBackoffMs respects secondary retryAfter floor", () => {
    const { limiter } = createLimiter();
    limiter.tryConsume("wf-1");
    limiter.recordRateLimit("wf-1", "secondary", 120); // 120s = 120000ms

    // Even if exponential delay is small, floor is 120000ms
    const backoff = limiter.getBackoffMs("wf-1");
    expect(backoff).toBeGreaterThanOrEqual(120_000);
  });

  it("successful tryConsume resets backoff attempts", () => {
    const { limiter, clock } = createLimiter({
      globalCapacity: 500,
      globalRefillPerHour: 500,
      perWorkflowCapacity: 100,
      perWorkflowRefillPerHour: 100,
    });
    limiter.tryConsume("wf-1");
    limiter.recordRateLimit("wf-1", "primary");
    expect(limiter.getBackoffMs("wf-1")).toBeGreaterThan(0);

    // Advance time so global bucket refills enough for a successful consume
    clock.now += 3_600_000; // 1 hour — full refill
    const result = limiter.tryConsume("wf-1");
    expect(result.allowed).toBe(true);
    expect(limiter.getBackoffMs("wf-1")).toBe(0);
  });

  // ── Idle eviction (TASK-2.9) ──────────────────────────────

  it("cleanup evicts idle per-workflow buckets", () => {
    const { limiter, clock } = createLimiter({ idleEvictionMs: 1000 });

    limiter.tryConsume("wf-old");
    clock.now += 500;
    limiter.tryConsume("wf-recent");

    // Advance past eviction threshold for wf-old
    clock.now += 600; // wf-old idle for 1100ms, wf-recent idle for 600ms

    const evicted = limiter.cleanup();
    expect(evicted).toBe(1);

    // wf-recent should still work
    expect(limiter.tryConsume("wf-recent").allowed).toBe(true);
  });

  it("cleanup returns 0 when no buckets are idle", () => {
    const { limiter } = createLimiter();
    limiter.tryConsume("wf-1");
    expect(limiter.cleanup()).toBe(0);
  });

  it("cleanup evicts multiple idle buckets", () => {
    const { limiter, clock } = createLimiter({ idleEvictionMs: 1000 });

    limiter.tryConsume("wf-1");
    limiter.tryConsume("wf-2");
    limiter.tryConsume("wf-3");

    clock.now += 2000;
    expect(limiter.cleanup()).toBe(3);
  });

  // ── Shutdown ──────────────────────────────────────────────

  it("shutdown clears the cleanup interval", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { limiter } = createLimiter();

    limiter.shutdown();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("shutdown is idempotent", () => {
    const { limiter } = createLimiter();
    limiter.shutdown();
    limiter.shutdown(); // should not throw
  });

  // ── Default config ────────────────────────────────────────

  it("uses default config values when none provided", () => {
    let clock = 0;
    limiter = new RateLimiter({ now: () => clock });

    // Should allow 100 per-workflow requests (default capacity)
    for (let i = 0; i < 100; i++) {
      expect(limiter.tryConsume("wf-1").allowed).toBe(true);
    }
    const depleted = limiter.tryConsume("wf-1");
    expect(depleted.allowed).toBe(false);
    expect(depleted.bucket).toBe("workflow");
  });
});
