import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AuditTrail,
  AuditWriteError,
  type AuditRecord,
  type ChainVerification,
} from "../audit-trail";
import { createLogger } from "../logger";
import { SecretRedactor } from "../secret-redactor";

// Shared test helpers
function createTestConfig(dir: string, overrides: Record<string, unknown> = {}) {
  const redactor = new SecretRedactor();
  const logger = createLogger(redactor, { level: "error", sink: () => {} });
  return {
    path: join(dir, "audit.jsonl"),
    redactor,
    logger,
    now: () => 1706140800000, // Fixed timestamp: 2024-01-25T00:00:00.000Z
    ...overrides,
  };
}

async function readRecords(filePath: string): Promise<AuditRecord[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe("AuditTrail", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "audit-trail-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("initialize()", () => {
    it("creates file on empty directory", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      // Write a record to prove fd is open
      await trail.recordIntent("test_action", "test_target", { key: "value" });
      await trail.close();

      const records = await readRecords(config.path);
      expect(records).toHaveLength(1);
      expect(records[0].seq).toBe(1);
    });

    it("recovers state from existing file", async () => {
      const config = createTestConfig(tmpDir);

      // Write initial records
      const trail1 = new AuditTrail(config);
      await trail1.initialize();
      await trail1.recordIntent("action1", "target1", {});
      await trail1.recordIntent("action2", "target2", {});
      await trail1.close();

      // Re-open and verify recovery
      const trail2 = new AuditTrail(config);
      await trail2.initialize();
      const seq = await trail2.recordIntent("action3", "target3", {});
      await trail2.close();

      // seq should continue from 2
      expect(seq).toBe(3);

      const records = await readRecords(config.path);
      expect(records).toHaveLength(3);
    });

    it("recovers from corrupt last line (torn write)", async () => {
      const config = createTestConfig(tmpDir);

      // Write valid records
      const trail1 = new AuditTrail(config);
      await trail1.initialize();
      await trail1.recordIntent("action1", "target1", {});
      await trail1.close();

      // Append corrupt data (simulating torn write)
      const { appendFile } = await import("node:fs/promises");
      await appendFile(config.path, '{"broken json\n');

      // Create a logger that captures warnings
      const warnings: string[] = [];
      const redactor = new SecretRedactor();
      const logger = createLogger(redactor, {
        level: "debug",
        sink: (level, msg) => {
          if (level === "warn") warnings.push(msg);
        },
      });

      // Re-open - should recover by discarding corrupt line
      const trail2 = new AuditTrail({ ...config, logger });
      await trail2.initialize();
      const seq = await trail2.recordIntent("action2", "target2", {});
      await trail2.close();

      // Should continue from seq 1
      expect(seq).toBe(2);
      expect(warnings.some((w) => w.includes("Discarding corrupt"))).toBe(true);

      const records = await readRecords(config.path);
      expect(records).toHaveLength(2);
    });
  });

  describe("Hash chain integrity", () => {
    it("creates valid hash chain across 3+ records", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("create_pr", "repo/main", { title: "PR 1" });
      await trail.recordIntent("add_comment", "issue/42", { body: "Hello" });
      await trail.recordIntent("merge_pr", "repo/pr/1", {});
      await trail.close();

      const records = await readRecords(config.path);
      expect(records).toHaveLength(3);

      // First record links to genesis
      expect(records[0].prevHash).toBe("genesis");

      // Each subsequent record links to previous hash
      expect(records[1].prevHash).toBe(records[0].hash);
      expect(records[2].prevHash).toBe(records[1].hash);

      // All hashes are non-empty hex strings
      for (const record of records) {
        expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it("produces deterministic hashes for identical records", async () => {
      const config1 = createTestConfig(tmpDir);
      const dir2 = await mkdtemp(join(tmpdir(), "audit-trail-test-"));

      try {
        const config2 = createTestConfig(dir2);

        const trail1 = new AuditTrail(config1);
        const trail2 = new AuditTrail(config2);

        await trail1.initialize();
        await trail2.initialize();

        await trail1.recordIntent("action", "target", { key: "value" });
        await trail2.recordIntent("action", "target", { key: "value" });

        await trail1.close();
        await trail2.close();

        const records1 = await readRecords(config1.path);
        const records2 = await readRecords(config2.path);

        expect(records1[0].hash).toBe(records2[0].hash);
      } finally {
        await rm(dir2, { recursive: true, force: true });
      }
    });
  });

  describe("Intent-result pairing", () => {
    it("recordIntent returns monotonic seq number", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const seq1 = await trail.recordIntent("action1", "target", {});
      const seq2 = await trail.recordIntent("action2", "target", {});
      const seq3 = await trail.recordIntent("action3", "target", {});
      await trail.close();

      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });

    it("recordResult links to intent via intentSeq", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const intentSeq = await trail.recordIntent("create_pr", "repo", { title: "test" });
      const resultSeq = await trail.recordResult(intentSeq, "create_pr", "repo", { pr_number: 42 });
      await trail.close();

      const records = await readRecords(config.path);
      expect(records).toHaveLength(2);

      // Intent record
      expect(records[0].phase).toBe("intent");
      expect(records[0].seq).toBe(intentSeq);
      expect(records[0].intentSeq).toBeUndefined();

      // Result record
      expect(records[1].phase).toBe("result");
      expect(records[1].seq).toBe(resultSeq);
      expect(records[1].intentSeq).toBe(intentSeq);
      expect(records[1].result).toEqual({ pr_number: 42 });
    });

    it("recordResult with error links to intent", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const intentSeq = await trail.recordIntent("create_pr", "repo", {});
      await trail.recordResult(intentSeq, "create_pr", "repo", undefined, "API rate limited");
      await trail.close();

      const records = await readRecords(config.path);
      expect(records[1].intentSeq).toBe(intentSeq);
      expect(records[1].error).toBe("API rate limited");
      expect(records[1].result).toBeUndefined();
    });

    it("tracks pending intents", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const seq1 = await trail.recordIntent("action1", "target", {});
      const seq2 = await trail.recordIntent("action2", "target", {});

      expect(trail.getPendingIntents().has(seq1)).toBe(true);
      expect(trail.getPendingIntents().has(seq2)).toBe(true);

      await trail.recordResult(seq1, "action1", "target", "ok");

      expect(trail.getPendingIntents().has(seq1)).toBe(false);
      expect(trail.getPendingIntents().has(seq2)).toBe(true);

      await trail.close();
    });
  });

  describe("recordDenied", () => {
    it("records policy-blocked actions", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const seq = await trail.recordDenied(
        "delete_repo",
        "critical-repo",
        { owner: "org" },
        "Action blocked by policy: delete_repo not in allowlist",
      );
      await trail.close();

      const records = await readRecords(config.path);
      expect(records).toHaveLength(1);
      expect(records[0].phase).toBe("denied");
      expect(records[0].seq).toBe(seq);
      expect(records[0].error).toBe("Action blocked by policy: delete_repo not in allowlist");
      expect(records[0].dryRun).toBe(false);
    });
  });

  describe("recordDryRun", () => {
    it("records dry-run actions with dryRun flag", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordDryRun("create_pr", "repo", { title: "test PR" });
      await trail.close();

      const records = await readRecords(config.path);
      expect(records).toHaveLength(1);
      expect(records[0].phase).toBe("dry_run");
      expect(records[0].dryRun).toBe(true);
    });
  });

  describe("Secret redaction", () => {
    it("redacts secrets in params before writing", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("create_pr", "repo", {
        authorization: "Bearer ghp_1234567890123456789012345678901234AB",
        title: "Safe title",
      });
      await trail.close();

      const records = await readRecords(config.path);
      const params = records[0].params;
      // Authorization header should be redacted
      expect(params.authorization).toBe("[REDACTED:header]");
      // Normal field should be preserved
      expect(params.title).toBe("Safe title");
    });

    it("redacts secrets in result fields", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const intentSeq = await trail.recordIntent("fetch_token", "api", {});
      await trail.recordResult(intentSeq, "fetch_token", "api", {
        token: "ghp_1234567890123456789012345678901234AB",
      });
      await trail.close();

      const records = await readRecords(config.path);
      const result = records[1].result as Record<string, unknown>;
      expect(result.token).toBe("[REDACTED:github_pat]");
    });

    it("redacts secrets in error fields", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const intentSeq = await trail.recordIntent("action", "target", {});
      await trail.recordResult(
        intentSeq,
        "action",
        "target",
        undefined,
        "Auth failed: ghp_1234567890123456789012345678901234AB",
      );
      await trail.close();

      const records = await readRecords(config.path);
      expect(records[1].error).toBe("Auth failed: [REDACTED:github_pat]");
    });
  });

  describe("verifyChain()", () => {
    it("validates a correct chain", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action1", "target", {});
      await trail.recordIntent("action2", "target", {});
      await trail.recordIntent("action3", "target", {});
      await trail.close();

      const result = await trail.verifyChain();
      expect(result.valid).toBe(true);
      expect(result.recordCount).toBe(3);
      expect(result.brokenAt).toBeUndefined();
    });

    it("detects tampered record (modified field)", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action1", "target", {});
      await trail.recordIntent("action2", "target", {});
      await trail.close();

      // Tamper: modify action in second record
      const content = await readFile(config.path, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const record2 = JSON.parse(lines[1]) as AuditRecord;
      record2.action = "tampered_action";
      lines[1] = JSON.stringify(record2);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(config.path, lines.join("\n") + "\n", "utf8");

      // Re-create trail to verify from fresh read
      const trail2 = new AuditTrail(config);
      const result = await trail2.verifyChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });

    it("detects broken prevHash linkage", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action1", "target", {});
      await trail.recordIntent("action2", "target", {});
      await trail.close();

      // Tamper: change prevHash of second record
      const content = await readFile(config.path, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const record2 = JSON.parse(lines[1]) as AuditRecord;
      record2.prevHash = "fakehash";
      lines[1] = JSON.stringify(record2);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(config.path, lines.join("\n") + "\n", "utf8");

      const trail2 = new AuditTrail(config);
      const result = await trail2.verifyChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
      expect(result.actual).toBe("fakehash");
    });

    it("returns valid for empty/non-existent file", async () => {
      const config = createTestConfig(tmpDir);
      config.path = join(tmpDir, "nonexistent.jsonl");
      const trail = new AuditTrail(config);

      const result = await trail.verifyChain();
      expect(result.valid).toBe(true);
      expect(result.recordCount).toBe(0);
    });
  });

  describe("HMAC signing", () => {
    it("adds HMAC when hmacKey is configured", async () => {
      const config = createTestConfig(tmpDir, { hmacKey: "test-secret-key" });
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action", "target", {});
      await trail.close();

      const records = await readRecords(config.path);
      expect(records[0].hmac).toBeDefined();
      expect(records[0].hmac).toMatch(/^[0-9a-f]{64}$/);
    });

    it("does not add HMAC when hmacKey is not configured", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action", "target", {});
      await trail.close();

      const records = await readRecords(config.path);
      expect(records[0].hmac).toBeUndefined();
    });
  });

  describe("HMAC verification in verifyChain (TASK-1.7)", () => {
    it("verifyChain with correct key passes on HMAC records", async () => {
      const hmacKey = "my-secret-key";
      const config = createTestConfig(tmpDir, { hmacKey });
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action1", "target", { data: "a" });
      await trail.recordIntent("action2", "target", { data: "b" });
      await trail.close();

      const result: ChainVerification = await trail.verifyChain(hmacKey);
      expect(result.valid).toBe(true);
      expect(result.recordCount).toBe(2);
      expect(result.hmacError).toBeUndefined();
    });

    it("verifyChain with wrong key fails on HMAC records", async () => {
      const hmacKey = "correct-key";
      const config = createTestConfig(tmpDir, { hmacKey });
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action", "target", {});
      await trail.close();

      const result: ChainVerification = await trail.verifyChain("wrong-key");
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(0);
      expect(result.hmacError).toBe(true);
    });

    it("verifyChain without key on HMAC records passes (HMAC not checked)", async () => {
      const config = createTestConfig(tmpDir, { hmacKey: "secret" });
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action", "target", {});
      await trail.close();

      // Verify without providing a key — should skip HMAC checks entirely
      const result: ChainVerification = await trail.verifyChain();
      expect(result.valid).toBe(true);
      expect(result.recordCount).toBe(1);
      expect(result.hmacError).toBeUndefined();
    });

    it("verifyChain with key on non-HMAC records passes (no hmac field)", async () => {
      // Write records WITHOUT an hmacKey
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action", "target", {});
      await trail.close();

      // Records have no hmac field; verifying with a key should still pass
      const result: ChainVerification = await trail.verifyChain("some-key");
      expect(result.valid).toBe(true);
      expect(result.recordCount).toBe(1);
      expect(result.hmacError).toBeUndefined();
    });

    it("verifyChain detects tampered hmac field", async () => {
      const hmacKey = "signing-key";
      const config = createTestConfig(tmpDir, { hmacKey });
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action", "target", { val: 42 });
      await trail.close();

      // Tamper: replace the hmac with a bogus value
      const content = await readFile(config.path, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const record = JSON.parse(lines[0]) as AuditRecord;
      record.hmac = "a".repeat(64); // fake HMAC
      lines[0] = JSON.stringify(record);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(config.path, lines.join("\n") + "\n", "utf8");

      const trail2 = new AuditTrail(config);
      const result: ChainVerification = await trail2.verifyChain(hmacKey);
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(0);
      expect(result.hmacError).toBe(true);
    });
  });

  describe("Short write handling", () => {
    it("throws AuditWriteError after max retries on zero-byte writes", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      // Mock the fd.write to return 0 bytes
      const originalFd = (trail as any).fd;
      const mockWrite = vi.fn().mockResolvedValue({ bytesWritten: 0, buffer: Buffer.alloc(0) });
      (trail as any).fd = {
        ...originalFd,
        write: mockWrite,
        sync: originalFd.sync.bind(originalFd),
        close: originalFd.close.bind(originalFd),
        stat: originalFd.stat.bind(originalFd),
      };

      await expect(trail.recordIntent("action", "target", {})).rejects.toThrow(AuditWriteError);
      await expect(trail.recordIntent("action", "target", {})).rejects.toThrow(/retries/);

      // Restore to close properly
      (trail as any).fd = originalFd;
      await trail.close();
    });

    it("retries on short writes and succeeds", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const originalFd = (trail as any).fd;
      const originalWrite = originalFd.write.bind(originalFd);
      let callCount = 0;

      // First write returns partial (10 bytes), subsequent writes work normally
      const mockWrite = vi
        .fn()
        .mockImplementation(async (buffer: Buffer, offset: number, length: number) => {
          callCount++;
          if (callCount === 1) {
            // Short write: only write 10 bytes
            const partialLen = Math.min(10, length);
            const result = await originalWrite(buffer, offset, partialLen);
            return { bytesWritten: partialLen, buffer: result.buffer };
          }
          return originalWrite(buffer, offset, length);
        });

      (trail as any).fd = {
        ...originalFd,
        write: mockWrite,
        sync: originalFd.sync.bind(originalFd),
        close: originalFd.close.bind(originalFd),
        stat: originalFd.stat.bind(originalFd),
      };

      // Should succeed despite short first write
      const seq = await trail.recordIntent("action", "target", { data: "some value" });
      expect(seq).toBe(1);

      // Restore to close properly
      (trail as any).fd = originalFd;
      await trail.close();
    });
  });

  describe("Batched fsync for dry_run", () => {
    it("uses batched fsync timer for dry_run (not immediate)", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const fd = (trail as any).fd;
      const syncSpy = vi.spyOn(fd, "sync");

      // Intent should call sync immediately
      await trail.recordIntent("action", "target", {});
      const syncCallsAfterIntent = syncSpy.mock.calls.length;
      expect(syncCallsAfterIntent).toBe(1);

      // Dry run should NOT call sync immediately
      await trail.recordDryRun("action", "target", {});
      const syncCallsAfterDryRun = syncSpy.mock.calls.length;
      // Should still be 1 (no immediate sync for dry_run)
      expect(syncCallsAfterDryRun).toBe(syncCallsAfterIntent);

      // Verify the batch timer is pending
      expect((trail as any).batchFsyncPending).toBe(true);

      syncSpy.mockRestore();
      await trail.close();
    });
  });

  describe("Dedup key", () => {
    it("stores dedupeKey on intent records", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent(
        "create_pr",
        "repo",
        { title: "test" },
        "create_pr:repo/main:abc123",
      );
      await trail.close();

      const records = await readRecords(config.path);
      expect(records[0].dedupeKey).toBe("create_pr:repo/main:abc123");
    });
  });

  describe("Error handling", () => {
    it("throws AuditWriteError when not initialized", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      // Don't call initialize

      await expect(trail.recordIntent("action", "target", {})).rejects.toThrow(AuditWriteError);
      await expect(trail.recordIntent("action", "target", {})).rejects.toThrow("not initialized");
    });

    it("throws AuditWriteError when closed", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();
      await trail.close();

      await expect(trail.recordIntent("action", "target", {})).rejects.toThrow(AuditWriteError);
      await expect(trail.recordIntent("action", "target", {})).rejects.toThrow("closed");
    });

    it("close is idempotent", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.close();
      await trail.close(); // Should not throw
    });
  });

  describe("Timestamp injection", () => {
    it("uses injected now() for timestamps", async () => {
      const config = createTestConfig(tmpDir, {
        now: () => 1700000000000, // 2023-11-14T22:13:20.000Z
      });
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action", "target", {});
      await trail.close();

      const records = await readRecords(config.path);
      expect(records[0].ts).toBe("2023-11-14T22:13:20.000Z");
    });
  });

  describe("Canonical serialization", () => {
    it("excludes hash and hmac from canonical form", async () => {
      const config = createTestConfig(tmpDir, { hmacKey: "secret" });
      const trail = new AuditTrail(config);
      await trail.initialize();

      await trail.recordIntent("action", "target", { foo: "bar" });
      await trail.close();

      // Verify chain should pass, which means canonical excludes hash/hmac correctly
      const result = await trail.verifyChain();
      expect(result.valid).toBe(true);
    });

    it("sorted keys produce consistent hashes regardless of insertion order", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      // Params with different key order should produce same canonical form
      await trail.recordIntent("action", "target", { zebra: 1, alpha: 2, middle: 3 });
      await trail.close();

      // Chain should be valid (canonical serialization is deterministic)
      const result = await trail.verifyChain();
      expect(result.valid).toBe(true);
    });
  });

  describe("Rotation (TASK-1.6)", () => {
    it("rotates when file exceeds maxSizeBytes and no pending intents", async () => {
      // Use a tiny maxSizeBytes so rotation triggers quickly
      const config = createTestConfig(tmpDir, { maxSizeBytes: 500 });
      const trail = new AuditTrail(config);
      await trail.initialize();

      // Write intent+result pairs until rotation triggers.
      // Each record is ~200+ bytes, so a few pairs will exceed 500 bytes.
      for (let i = 0; i < 5; i++) {
        const seq = await trail.recordIntent("action", "target", {
          idx: i,
          padding: "x".repeat(50),
        });
        await trail.recordResult(seq, "action", "target", { ok: true });
      }
      await trail.close();

      // Check that an archived file was created
      const files = await readdir(tmpDir);
      const archiveFiles = files.filter(
        (f) => f.startsWith("audit.jsonl.") && f.endsWith(".jsonl"),
      );
      expect(archiveFiles.length).toBeGreaterThanOrEqual(1);

      // Current audit.jsonl should still exist (with remaining records)
      const currentExists = files.includes("audit.jsonl");
      expect(currentExists).toBe(true);
    });

    it("defers rotation when pending intents exist", async () => {
      const logMessages: string[] = [];
      const redactor = new SecretRedactor();
      const logger = createLogger(redactor, {
        level: "debug",
        sink: (_level, msg) => {
          logMessages.push(msg);
        },
      });

      const config = createTestConfig(tmpDir, {
        maxSizeBytes: 300,
        logger,
      });
      const trail = new AuditTrail(config);
      await trail.initialize();

      // Record intents without results — these stay pending
      await trail.recordIntent("action1", "target", { padding: "x".repeat(80) });
      await trail.recordIntent("action2", "target", { padding: "y".repeat(80) });

      // File should exceed 300 bytes but rotation should be deferred
      const files = await readdir(tmpDir);
      const archiveFiles = files.filter(
        (f) => f.startsWith("audit.jsonl.") && f.endsWith(".jsonl"),
      );
      expect(archiveFiles).toHaveLength(0);

      // Should have logged the deferral message
      expect(logMessages.some((m) => m.includes("Rotation deferred"))).toBe(true);

      await trail.close();
    });

    it("starts fresh chain (prevHash = genesis) after rotation", async () => {
      // Use 1500 bytes: large enough that a single intent+result pair (~400 bytes)
      // won't trigger rotation, but 4+ pairs will exceed the limit.
      const config = createTestConfig(tmpDir, { maxSizeBytes: 1500 });
      const trail = new AuditTrail(config);
      await trail.initialize();

      // Write enough paired records to trigger rotation (~400 bytes each pair)
      for (let i = 0; i < 6; i++) {
        const seq = await trail.recordIntent("action", "target", {
          idx: i,
          padding: "x".repeat(40),
        });
        await trail.recordResult(seq, "action", "target", { ok: true });
      }

      // Write one more pair after rotation to populate the new file
      const postSeq = await trail.recordIntent("post_rotation", "target", { fresh: true });
      await trail.recordResult(postSeq, "post_rotation", "target", { ok: true });
      await trail.close();

      // Confirm rotation happened (archive file exists)
      const files = await readdir(tmpDir);
      const archiveFiles = files.filter(
        (f) => f.startsWith("audit.jsonl.") && f.endsWith(".jsonl"),
      );
      expect(archiveFiles.length).toBeGreaterThanOrEqual(1);

      // Read the current (post-rotation) audit file
      const currentRecords = await readRecords(config.path);
      expect(currentRecords.length).toBeGreaterThan(0);

      // First record in the new file should have prevHash = genesis
      expect(currentRecords[0].prevHash).toBe("genesis");
      // Seq should restart from 1
      expect(currentRecords[0].seq).toBe(1);
    });

    it("verifyChain passes on new file after rotation", async () => {
      // Same sizing rationale as above
      const config = createTestConfig(tmpDir, { maxSizeBytes: 1500 });
      const trail = new AuditTrail(config);
      await trail.initialize();

      // Write enough paired records to trigger rotation
      for (let i = 0; i < 6; i++) {
        const seq = await trail.recordIntent("action", "target", {
          idx: i,
          padding: "x".repeat(40),
        });
        await trail.recordResult(seq, "action", "target", { ok: true });
      }

      // Write one more pair after rotation so new file has content
      const postSeq = await trail.recordIntent("post_rotation", "target", {});
      await trail.recordResult(postSeq, "post_rotation", "target", { ok: true });

      // Verify chain on the current (rotated) file
      const result = await trail.verifyChain();
      expect(result.valid).toBe(true);
      expect(result.recordCount).toBeGreaterThan(0);

      await trail.close();
    });
  });

  describe("Torn write recovery (TASK-1.5)", () => {
    it("recovers from corrupt last line (parse error)", async () => {
      const config = createTestConfig(tmpDir);
      const trail1 = new AuditTrail(config);
      await trail1.initialize();
      await trail1.recordIntent("action1", "target1", {});
      await trail1.recordIntent("action2", "target2", {});
      await trail1.close();

      // Append corrupt JSON (simulating torn write)
      const { appendFile } = await import("node:fs/promises");
      await appendFile(config.path, '{"broken json\n');

      // Create a logger that captures warnings
      const warnings: string[] = [];
      const redactor = new SecretRedactor();
      const logger = createLogger(redactor, {
        level: "debug",
        sink: (level, msg) => {
          if (level === "warn") warnings.push(msg);
        },
      });

      const trail2 = new AuditTrail({ ...config, logger });
      await trail2.initialize();
      const seq = await trail2.recordIntent("action3", "target3", {});
      await trail2.close();

      // Should continue from seq 2
      expect(seq).toBe(3);
      expect(warnings.some((w) => w.includes("Discarding corrupt"))).toBe(true);
      expect(
        warnings.some((w) =>
          w.includes("Torn write recovery: discarded 1 records (1 parse errors, 0 chain breaks)"),
        ),
      ).toBe(true);

      const records = await readRecords(config.path);
      expect(records).toHaveLength(3);
      // Chain should be valid after recovery
      const result = await trail2.verifyChain();
      expect(result.valid).toBe(true);
    });

    it("truncates at valid JSON with wrong prevHash", async () => {
      const config = createTestConfig(tmpDir);
      const trail1 = new AuditTrail(config);
      await trail1.initialize();
      await trail1.recordIntent("action1", "target1", {});
      await trail1.recordIntent("action2", "target2", {});
      await trail1.close();

      // Tamper: change prevHash of second record to break the chain
      const content = await readFile(config.path, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const record2 = JSON.parse(lines[1]) as AuditRecord;
      record2.prevHash = "tampered_prev_hash";
      lines[1] = JSON.stringify(record2);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(config.path, lines.join("\n") + "\n", "utf8");

      const warnings: string[] = [];
      const redactor = new SecretRedactor();
      const logger = createLogger(redactor, {
        level: "debug",
        sink: (level, msg) => {
          if (level === "warn") warnings.push(msg);
        },
      });

      const trail2 = new AuditTrail({ ...config, logger });
      await trail2.initialize();
      const seq = await trail2.recordIntent("action3", "target3", {});
      await trail2.close();

      // Should continue from seq 1 (only first record survived)
      expect(seq).toBe(2);
      expect(warnings.some((w) => w.includes("Chain break detected"))).toBe(true);
      expect(warnings.some((w) => w.includes("1 records (0 parse errors, 1 chain breaks)"))).toBe(
        true,
      );

      const records = await readRecords(config.path);
      expect(records).toHaveLength(2);
      // First record is original, second is newly written
      expect(records[0].action).toBe("action1");
      expect(records[1].action).toBe("action3");
    });

    it("truncates at HMAC mismatch when HMAC enabled", async () => {
      const hmacKey = "test-hmac-key";
      const config = createTestConfig(tmpDir, { hmacKey });
      const trail1 = new AuditTrail(config);
      await trail1.initialize();
      await trail1.recordIntent("action1", "target1", {});
      await trail1.recordIntent("action2", "target2", {});
      await trail1.close();

      // Tamper: change the HMAC of second record
      const content = await readFile(config.path, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const record2 = JSON.parse(lines[1]) as AuditRecord;
      record2.hmac = "b".repeat(64); // fake HMAC
      lines[1] = JSON.stringify(record2);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(config.path, lines.join("\n") + "\n", "utf8");

      const warnings: string[] = [];
      const redactor = new SecretRedactor();
      const logger = createLogger(redactor, {
        level: "debug",
        sink: (level, msg) => {
          if (level === "warn") warnings.push(msg);
        },
      });

      const trail2 = new AuditTrail({ ...config, hmacKey, logger });
      await trail2.initialize();
      const seq = await trail2.recordIntent("action3", "target3", {});
      await trail2.close();

      // Should continue from seq 1 (only first record survived)
      expect(seq).toBe(2);
      expect(warnings.some((w) => w.includes("HMAC mismatch"))).toBe(true);
      expect(warnings.some((w) => w.includes("1 records (0 parse errors, 1 chain breaks)"))).toBe(
        true,
      );

      const records = await readRecords(config.path);
      expect(records).toHaveLength(2);
    });

    it("stops at mid-file corruption (valid, corrupt, valid)", async () => {
      const config = createTestConfig(tmpDir);
      const trail1 = new AuditTrail(config);
      await trail1.initialize();
      await trail1.recordIntent("action1", "target1", {});
      await trail1.recordIntent("action2", "target2", {});
      await trail1.recordIntent("action3", "target3", {});
      await trail1.close();

      // Corrupt the middle record (break JSON)
      const content = await readFile(config.path, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      lines[1] = '{"corrupt middle'; // invalid JSON in the middle
      const { writeFile } = await import("node:fs/promises");
      await writeFile(config.path, lines.join("\n") + "\n", "utf8");

      const warnings: string[] = [];
      const redactor = new SecretRedactor();
      const logger = createLogger(redactor, {
        level: "debug",
        sink: (level, msg) => {
          if (level === "warn") warnings.push(msg);
        },
      });

      const trail2 = new AuditTrail({ ...config, logger });
      await trail2.initialize();
      const seq = await trail2.recordIntent("action4", "target4", {});
      await trail2.close();

      // Only first record survives; second was corrupt, third is also discarded
      expect(seq).toBe(2);
      expect(
        warnings.some((w) =>
          w.includes("Torn write recovery: discarded 2 records (1 parse errors, 0 chain breaks)"),
        ),
      ).toBe(true);

      const records = await readRecords(config.path);
      expect(records).toHaveLength(2);
      expect(records[0].action).toBe("action1");
      expect(records[1].action).toBe("action4");
    });

    it("handles empty file gracefully", async () => {
      const config = createTestConfig(tmpDir);

      // Create an empty file
      const { writeFile } = await import("node:fs/promises");
      await writeFile(config.path, "", "utf8");

      const trail = new AuditTrail(config);
      await trail.initialize();
      const seq = await trail.recordIntent("action1", "target1", {});
      await trail.close();

      expect(seq).toBe(1);
      const records = await readRecords(config.path);
      expect(records).toHaveLength(1);
      expect(records[0].prevHash).toBe("genesis");
    });

    it("handles all-corrupt file (no valid records)", async () => {
      const config = createTestConfig(tmpDir);

      // Write all-corrupt content
      const { writeFile } = await import("node:fs/promises");
      await writeFile(config.path, '{"broken\n{"also broken\n', "utf8");

      const warnings: string[] = [];
      const redactor = new SecretRedactor();
      const logger = createLogger(redactor, {
        level: "debug",
        sink: (level, msg) => {
          if (level === "warn") warnings.push(msg);
        },
      });

      const trail = new AuditTrail({ ...config, logger });
      await trail.initialize();
      const seq = await trail.recordIntent("action1", "target1", {});
      await trail.close();

      // Should start fresh from seq 1 with genesis prevHash
      expect(seq).toBe(1);
      expect(warnings.some((w) => w.includes("Torn write recovery"))).toBe(true);

      const records = await readRecords(config.path);
      expect(records).toHaveLength(1);
      expect(records[0].prevHash).toBe("genesis");
    });

    it("clean file is a no-op (no records lost)", async () => {
      const config = createTestConfig(tmpDir);
      const trail1 = new AuditTrail(config);
      await trail1.initialize();
      await trail1.recordIntent("action1", "target1", {});
      await trail1.recordIntent("action2", "target2", {});
      await trail1.recordIntent("action3", "target3", {});
      await trail1.close();

      // Re-open with a logger that captures warnings
      const warnings: string[] = [];
      const redactor = new SecretRedactor();
      const logger = createLogger(redactor, {
        level: "debug",
        sink: (level, msg) => {
          if (level === "warn") warnings.push(msg);
        },
      });

      const trail2 = new AuditTrail({ ...config, logger });
      await trail2.initialize();
      const seq = await trail2.recordIntent("action4", "target4", {});
      await trail2.close();

      // Should continue from seq 3
      expect(seq).toBe(4);
      // No torn write recovery warnings should be logged
      expect(warnings.some((w) => w.includes("Torn write recovery"))).toBe(false);
      expect(warnings.some((w) => w.includes("Discarding corrupt"))).toBe(false);
      expect(warnings.some((w) => w.includes("Chain break"))).toBe(false);
      expect(warnings.some((w) => w.includes("HMAC mismatch"))).toBe(false);

      const records = await readRecords(config.path);
      expect(records).toHaveLength(4);
    });

    it("truncates at hash mismatch (tampered record content)", async () => {
      const config = createTestConfig(tmpDir);
      const trail1 = new AuditTrail(config);
      await trail1.initialize();
      await trail1.recordIntent("action1", "target1", {});
      await trail1.recordIntent("action2", "target2", {});
      await trail1.close();

      // Tamper: modify action field but keep same hash (hash will now be wrong)
      const content = await readFile(config.path, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      const record2 = JSON.parse(lines[1]) as AuditRecord;
      record2.action = "tampered_action"; // content changed but hash unchanged
      lines[1] = JSON.stringify(record2);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(config.path, lines.join("\n") + "\n", "utf8");

      const warnings: string[] = [];
      const redactor = new SecretRedactor();
      const logger = createLogger(redactor, {
        level: "debug",
        sink: (level, msg) => {
          if (level === "warn") warnings.push(msg);
        },
      });

      const trail2 = new AuditTrail({ ...config, logger });
      await trail2.initialize();
      const seq = await trail2.recordIntent("action3", "target3", {});
      await trail2.close();

      // Only first record should survive
      expect(seq).toBe(2);
      expect(warnings.some((w) => w.includes("Hash mismatch"))).toBe(true);

      const records = await readRecords(config.path);
      expect(records).toHaveLength(2);
      expect(records[0].action).toBe("action1");
    });
  });

  describe("Query API (TASK-1.8)", () => {
    it("finds an existing successful result by intentSeq", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const intentSeq = await trail.recordIntent("create_pr", "repo", { title: "test" });
      await trail.recordResult(intentSeq, "create_pr", "repo", { pr_number: 42 });

      const entry = await trail.findResultByIntentSeq(intentSeq);
      expect(entry).toEqual({ hasResult: true, error: undefined });

      await trail.close();
    });

    it("finds a result with error by intentSeq", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const intentSeq = await trail.recordIntent("create_pr", "repo", {});
      await trail.recordResult(intentSeq, "create_pr", "repo", undefined, "API rate limited");

      const entry = await trail.findResultByIntentSeq(intentSeq);
      expect(entry).toEqual({ hasResult: true, error: "API rate limited" });

      await trail.close();
    });

    it("returns null when no result found for intentSeq", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const intentSeq = await trail.recordIntent("create_pr", "repo", {});
      // No recordResult call

      const entry = await trail.findResultByIntentSeq(intentSeq);
      expect(entry).toBeNull();

      // Also test a completely unknown intentSeq
      const unknown = await trail.findResultByIntentSeq(9999);
      expect(unknown).toBeNull();

      await trail.close();
    });

    it("tracks multiple intents each with own result", async () => {
      const config = createTestConfig(tmpDir);
      const trail = new AuditTrail(config);
      await trail.initialize();

      const seq1 = await trail.recordIntent("action1", "target1", {});
      const seq2 = await trail.recordIntent("action2", "target2", {});
      const seq3 = await trail.recordIntent("action3", "target3", {});

      await trail.recordResult(seq1, "action1", "target1", { ok: true });
      await trail.recordResult(seq2, "action2", "target2", undefined, "timeout");
      // seq3 intentionally has no result

      expect(await trail.findResultByIntentSeq(seq1)).toEqual({
        hasResult: true,
        error: undefined,
      });
      expect(await trail.findResultByIntentSeq(seq2)).toEqual({
        hasResult: true,
        error: "timeout",
      });
      expect(await trail.findResultByIntentSeq(seq3)).toBeNull();

      await trail.close();
    });

    it("populates index during initialize() recovery", async () => {
      const config = createTestConfig(tmpDir);

      // Phase 1: write intent+result records, then close
      const trail1 = new AuditTrail(config);
      await trail1.initialize();
      const seq1 = await trail1.recordIntent("action1", "target", {});
      await trail1.recordResult(seq1, "action1", "target", { ok: true });
      const seq2 = await trail1.recordIntent("action2", "target", {});
      await trail1.recordResult(seq2, "action2", "target", undefined, "failed");
      const seq3 = await trail1.recordIntent("action3", "target", {});
      // seq3 has no result
      await trail1.close();

      // Phase 2: re-open and verify index was rebuilt from file
      const trail2 = new AuditTrail(config);
      await trail2.initialize();

      expect(await trail2.findResultByIntentSeq(seq1)).toEqual({
        hasResult: true,
        error: undefined,
      });
      expect(await trail2.findResultByIntentSeq(seq2)).toEqual({
        hasResult: true,
        error: "failed",
      });
      expect(await trail2.findResultByIntentSeq(seq3)).toBeNull();

      await trail2.close();
    });
  });
});
