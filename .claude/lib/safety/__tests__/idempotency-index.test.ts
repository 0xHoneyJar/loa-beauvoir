import { describe, it, expect, beforeEach } from "vitest";
import type { ResilientStore } from "../../persistence/resilient-store";
import { IdempotencyIndex, type DedupState, type AuditQueryFn } from "../idempotency-index";

// -- Mock store (in-memory ResilientStore) --

class MockStore<T> implements ResilientStore<T> {
  private data: T | null = null;
  writeCalls = 0;

  async get(): Promise<T | null> {
    return this.data;
  }
  async set(d: T): Promise<void> {
    this.data = d;
    this.writeCalls++;
  }
  async exists(): Promise<boolean> {
    return this.data !== null;
  }
  async clear(): Promise<void> {
    this.data = null;
  }
}

// -- Helpers --

const FIXED_NOW = 1706140800000; // 2024-01-25T00:00:00.000Z
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function createIndex(
  overrides: {
    store?: MockStore<DedupState>;
    auditQuery?: AuditQueryFn;
    ttlMs?: number;
    now?: () => number;
  } = {},
) {
  const store = overrides.store ?? new MockStore<DedupState>();
  return {
    index: new IdempotencyIndex({
      store,
      auditQuery: overrides.auditQuery,
      ttlMs: overrides.ttlMs,
      now: overrides.now ?? (() => FIXED_NOW),
    }),
    store,
  };
}

// -- Tests --

describe("IdempotencyIndex", () => {
  describe("generateKey", () => {
    it("produces deterministic keys for same inputs", () => {
      const key1 = IdempotencyIndex.generateKey("create", "repo", "file.ts", { branch: "main" });
      const key2 = IdempotencyIndex.generateKey("create", "repo", "file.ts", { branch: "main" });
      expect(key1).toBe(key2);
    });

    it("produces different keys for different inputs", () => {
      const key1 = IdempotencyIndex.generateKey("create", "repo", "file.ts", { branch: "main" });
      const key2 = IdempotencyIndex.generateKey("create", "repo", "file.ts", { branch: "dev" });
      expect(key1).not.toBe(key2);
    });

    it("follows the expected key format", () => {
      const key = IdempotencyIndex.generateKey("create", "repo", "file.ts", { branch: "main" });
      // Format: {action}:{scope}/{resource}:{hash16}
      expect(key).toMatch(/^create:repo\/file\.ts:[0-9a-f]{16}$/);
    });

    it("is stable regardless of param insertion order", () => {
      const key1 = IdempotencyIndex.generateKey("act", "s", "r", { a: 1, b: 2 });
      const key2 = IdempotencyIndex.generateKey("act", "s", "r", { b: 2, a: 1 });
      expect(key1).toBe(key2);
    });
  });

  describe("check", () => {
    it("returns null for unknown key", async () => {
      const { index } = createIndex();
      const result = await index.check("nonexistent:key/here:abcdef0123456789");
      expect(result).toBeNull();
    });

    it("returns entry after markPending", async () => {
      const { index } = createIndex();
      const key = "test:scope/res:abcdef0123456789";
      await index.markPending(key, 1, "safe_retry");
      const result = await index.check(key);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("pending");
    });
  });

  describe("status transitions", () => {
    it("transitions pending -> completed", async () => {
      const { index } = createIndex();
      const key = "test:scope/res:abcdef0123456789";
      await index.markPending(key, 1, "safe_retry");

      const completed = await index.markCompleted(key);
      expect(completed.status).toBe("completed");
      expect(completed.completedAt).toBeDefined();
    });

    it("transitions pending -> failed", async () => {
      const { index } = createIndex();
      const key = "test:scope/res:abcdef0123456789";
      await index.markPending(key, 1, "safe_retry");

      const failed = await index.markFailed(key, "something broke");
      expect(failed.status).toBe("failed");
      expect(failed.failedAt).toBeDefined();
      expect(failed.lastError).toBe("something broke");
    });

    it("throws when transitioning failed -> completed (terminal)", async () => {
      const { index } = createIndex();
      const key = "test:scope/res:abcdef0123456789";
      await index.markPending(key, 1, "safe_retry");
      await index.markFailed(key, "permanent error");

      await expect(index.markCompleted(key)).rejects.toThrow(
        /cannot transition failed -> completed/,
      );
    });

    it("throws when marking nonexistent key as completed", async () => {
      const { index } = createIndex();
      await expect(index.markCompleted("no:such/key:0000000000000000")).rejects.toThrow(
        /no entry found/,
      );
    });

    it("throws when marking nonexistent key as failed", async () => {
      const { index } = createIndex();
      await expect(index.markFailed("no:such/key:0000000000000000", "err")).rejects.toThrow(
        /no entry found/,
      );
    });
  });

  describe("markPending", () => {
    it("sets intentSeq and strategy correctly", async () => {
      const { index } = createIndex();
      const key = "act:s/r:abcdef0123456789";
      const entry = await index.markPending(key, 42, "check_then_retry");

      expect(entry.intentSeq).toBe(42);
      expect(entry.compensationStrategy).toBe("check_then_retry");
      expect(entry.attempts).toBe(1);
      expect(entry.status).toBe("pending");
      expect(entry.createdAt).toBeDefined();
    });

    it("persists to store on write", async () => {
      const { index, store } = createIndex();
      const key = "act:s/r:abcdef0123456789";
      await index.markPending(key, 1, "safe_retry");
      expect(store.writeCalls).toBe(1);

      const stored = await store.get();
      expect(stored).not.toBeNull();
      expect(stored!.entries[key]).toBeDefined();
      expect(stored!.entries[key].status).toBe("pending");
    });
  });

  describe("evict", () => {
    it("removes entries older than ttlMs", async () => {
      let currentTime = FIXED_NOW;
      const { index } = createIndex({
        ttlMs: 2 * ONE_DAY_MS,
        now: () => currentTime,
      });

      // Create entry at FIXED_NOW
      const key = "old:scope/res:abcdef0123456789";
      await index.markPending(key, 1, "safe_retry");

      // Advance time past TTL
      currentTime = FIXED_NOW + 3 * ONE_DAY_MS;
      const evicted = await index.evict();

      expect(evicted).toBe(1);
      const check = await index.check(key);
      expect(check).toBeNull();
    });

    it("keeps fresh entries", async () => {
      let currentTime = FIXED_NOW;
      const { index } = createIndex({
        ttlMs: 2 * ONE_DAY_MS,
        now: () => currentTime,
      });

      const freshKey = "fresh:scope/res:abcdef0123456789";
      await index.markPending(freshKey, 1, "safe_retry");

      // Advance time but not past TTL
      currentTime = FIXED_NOW + ONE_DAY_MS;
      const evicted = await index.evict();

      expect(evicted).toBe(0);
      const check = await index.check(freshKey);
      expect(check).not.toBeNull();
    });

    it("returns 0 when nothing to evict", async () => {
      const { index } = createIndex();
      const evicted = await index.evict();
      expect(evicted).toBe(0);
    });
  });

  describe("reconcilePending", () => {
    it("returns all pending entries without auditQuery", async () => {
      const { index } = createIndex();
      await index.markPending("a:s/r:0000000000000001", 1, "safe_retry");
      await index.markPending("b:s/r:0000000000000002", 2, "check_then_retry");

      const pending = await index.reconcilePending();
      expect(pending).toHaveLength(2);
      expect(pending.every((e) => e.status === "pending")).toBe(true);
    });

    it("skips failed entries (terminal state)", async () => {
      const { index } = createIndex();
      await index.markPending("a:s/r:0000000000000001", 1, "safe_retry");
      await index.markPending("b:s/r:0000000000000002", 2, "safe_retry");
      await index.markFailed("b:s/r:0000000000000002", "permanent");

      const pending = await index.reconcilePending();
      expect(pending).toHaveLength(1);
      expect(pending[0].key).toBe("a:s/r:0000000000000001");
    });

    it("auto-promotes completed via auditQuery", async () => {
      const auditQuery: AuditQueryFn = async (intentSeq: number) => {
        if (intentSeq === 1) return { hasResult: true };
        return null;
      };

      const { index } = createIndex({ auditQuery });
      await index.markPending("a:s/r:0000000000000001", 1, "safe_retry");
      await index.markPending("b:s/r:0000000000000002", 2, "safe_retry");

      const pending = await index.reconcilePending();

      // Entry 1 should be auto-promoted to completed, not returned
      expect(pending).toHaveLength(1);
      expect(pending[0].key).toBe("b:s/r:0000000000000002");

      // Verify the promoted entry is now completed in state
      const promoted = await index.check("a:s/r:0000000000000001");
      expect(promoted!.status).toBe("completed");
      expect(promoted!.completedAt).toBeDefined();
    });

    it("auto-promotes failed via auditQuery error", async () => {
      const auditQuery: AuditQueryFn = async (intentSeq: number) => {
        if (intentSeq === 1) return { hasResult: true, error: "disk full" };
        return null;
      };

      const { index } = createIndex({ auditQuery });
      await index.markPending("a:s/r:0000000000000001", 1, "safe_retry");
      await index.markPending("b:s/r:0000000000000002", 2, "safe_retry");

      const pending = await index.reconcilePending();

      // Entry 1 should be auto-promoted to failed, not returned
      expect(pending).toHaveLength(1);
      expect(pending[0].key).toBe("b:s/r:0000000000000002");

      // Verify the promoted entry is now failed
      const promoted = await index.check("a:s/r:0000000000000001");
      expect(promoted!.status).toBe("failed");
      expect(promoted!.lastError).toBe("disk full");
      expect(promoted!.failedAt).toBeDefined();
    });

    it("returns entries needing compensation when audit has no result", async () => {
      const auditQuery: AuditQueryFn = async () => null;

      const { index } = createIndex({ auditQuery });
      await index.markPending("a:s/r:0000000000000001", 1, "safe_retry");

      const pending = await index.reconcilePending();
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("pending");
    });

    it("returns empty array when no pending entries", async () => {
      const { index } = createIndex();
      const pending = await index.reconcilePending();
      expect(pending).toHaveLength(0);
    });
  });

  describe("lazy initialization", () => {
    it("loads from store on first access", async () => {
      const store = new MockStore<DedupState>();
      // Pre-seed the store with existing state
      await store.set({
        entries: {
          "pre:existing/key:abcdef0123456789": {
            key: "pre:existing/key:abcdef0123456789",
            status: "pending",
            createdAt: new Date(FIXED_NOW).toISOString(),
            intentSeq: 99,
            compensationStrategy: "skip",
            attempts: 1,
          },
        },
        _schemaVersion: 1,
      });

      const { index } = createIndex({ store });
      const entry = await index.check("pre:existing/key:abcdef0123456789");
      expect(entry).not.toBeNull();
      expect(entry!.intentSeq).toBe(99);
    });
  });
});
