/**
 * BootOrchestrator tests — validates 7-step deterministic boot sequence.
 */

import { describe, it, expect, vi } from "vitest";
import type { BootConfig, BootFactories } from "../orchestrator.js";
import { boot, BootError } from "../orchestrator.js";

// ── Test Doubles ─────────────────────────────────────────────

function makeMockRedactor() {
  return {
    redact: vi.fn((s: string) => s),
    redactAny: vi.fn((v: unknown) => v),
    redactError: vi.fn((e: Error) => e),
  } as any;
}

function makeMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function makeMockAuditTrail(opts?: { pendingIntents?: Set<number> }) {
  const pending = opts?.pendingIntents ?? new Set<number>();
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getPendingIntents: vi.fn(() => pending),
    recordIntent: vi.fn(),
    recordResult: vi.fn(),
    findResultByIntentSeq: vi.fn(),
  } as any;
}

function makeMockStoreFactory() {
  return { create: vi.fn() } as any;
}

function makeMockCircuitBreaker() {
  return {
    execute: vi.fn(),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    getState: vi.fn(() => "CLOSED"),
    reset: vi.fn(),
  } as any;
}

function makeMockRateLimiter() {
  return {
    tryConsume: vi.fn(() => ({ allowed: true, bucket: "global" })),
    shutdown: vi.fn(),
    cleanup: vi.fn(),
  } as any;
}

function makeMockLockManager(opts?: { staleLocks?: string[] }) {
  return {
    acquire: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    recoverStaleLocks: vi.fn().mockResolvedValue(opts?.staleLocks ?? []),
  } as any;
}

function makeMockToolValidator(result?: { valid: boolean; errors: string[]; warnings: string[] }) {
  const defaultResult = { valid: true, errors: [], warnings: [] };
  return {
    validateRegistry: vi.fn(() => result ?? defaultResult),
    validateParams: vi.fn(() => []),
  } as any;
}

function makeHappyFactories(overrides?: Partial<BootFactories>): BootFactories {
  const redactor = makeMockRedactor();
  const logger = makeMockLogger();
  const auditTrail = makeMockAuditTrail();
  const storeFactory = makeMockStoreFactory();
  const circuitBreaker = makeMockCircuitBreaker();
  const rateLimiter = makeMockRateLimiter();
  const lockManager = makeMockLockManager();
  const toolValidator = makeMockToolValidator();

  return {
    createRedactor: vi.fn(() => redactor),
    createLogger: vi.fn(() => logger),
    createAuditTrail: vi.fn(() => auditTrail),
    createStoreFactory: vi.fn(() => storeFactory),
    createCircuitBreaker: vi.fn(() => circuitBreaker),
    createRateLimiter: vi.fn(() => rateLimiter),
    createLockManager: vi.fn(() => lockManager),
    createToolValidator: vi.fn(() => toolValidator),
    checkDataDir: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeValidConfig(overrides?: Partial<BootConfig>): BootConfig {
  return {
    dataDir: "/tmp/beauvoir-test-boot",
    now: () => 1000,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("BootOrchestrator", () => {
  describe("happy path - autonomous/degraded mode", () => {
    it("boots successfully with all subsystems healthy", async () => {
      const factories = makeHappyFactories();
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.success).toBe(true);
      // dedupIndex is always degraded (not yet available), so mode is degraded
      expect(result.health.mode).toBe("degraded");
      expect(result.health.bootTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.services.redactor).toBeDefined();
      expect(result.services.logger).toBeDefined();
      expect(result.services.auditTrail).toBeDefined();
      expect(result.services.lockManager).toBeDefined();
      expect(typeof result.shutdown).toBe("function");
    });

    it("reports all P0 subsystems as ok", async () => {
      const factories = makeHappyFactories();
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.subsystems["config"]).toBe("ok");
      expect(result.health.subsystems["fs"]).toBe("ok");
      expect(result.health.subsystems["redactor"]).toBe("ok");
      expect(result.health.subsystems["logger"]).toBe("ok");
      expect(result.health.subsystems["auditTrail"]).toBe("ok");
      expect(result.health.subsystems["toolValidator"]).toBe("ok");
      expect(result.health.subsystems["lockManager"]).toBe("ok");
    });

    it("reports P1 subsystems correctly", async () => {
      const factories = makeHappyFactories();
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.subsystems["store"]).toBe("ok");
      expect(result.health.subsystems["circuitBreaker"]).toBe("ok");
      expect(result.health.subsystems["rateLimiter"]).toBe("ok");
      expect(result.health.subsystems["dedupIndex"]).toBe("degraded");
    });
  });

  describe("P0 failure - boot abort", () => {
    it("throws BootError when dataDir is inaccessible", async () => {
      const factories = makeHappyFactories({
        checkDataDir: vi.fn().mockRejectedValue(new Error("ENOENT")),
      });
      const config = makeValidConfig();

      await expect(boot(config, factories)).rejects.toThrow(BootError);
    });

    it("throws BootError with correct metadata on P0 failure", async () => {
      const factories = makeHappyFactories({
        checkDataDir: vi.fn().mockRejectedValue(new Error("ENOENT")),
      });
      const config = makeValidConfig();

      try {
        await boot(config, factories);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BootError);
        const bootErr = err as BootError;
        expect(bootErr.subsystems["fs"]).toBe("failed");
        expect(bootErr.errors.length).toBeGreaterThan(0);
        expect(bootErr.bootTimeMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("throws when config validation fails (empty dataDir)", async () => {
      const factories = makeHappyFactories();
      const config = makeValidConfig({ dataDir: "" });

      await expect(boot(config, factories)).rejects.toThrow(BootError);
    });

    it("throws when audit trail initialization fails", async () => {
      const factories = makeHappyFactories({
        createAuditTrail: vi.fn(() => ({
          initialize: vi.fn().mockRejectedValue(new Error("audit init failed")),
          close: vi.fn(),
          getPendingIntents: vi.fn(() => new Set()),
        })) as any,
      });
      const config = makeValidConfig();

      await expect(boot(config, factories)).rejects.toThrow(BootError);
    });

    it("throws when ToolValidator finds unknown tools in policy", async () => {
      const factories = makeHappyFactories({
        createToolValidator: vi.fn(() =>
          makeMockToolValidator({
            valid: false,
            errors: ["Unknown tool in policy.allow: nonexistent_tool"],
            warnings: [],
          }),
        ),
      });
      const config = makeValidConfig({
        mcpToolNames: ["read_file"],
        actionPolicy: [{ allow: ["nonexistent_tool"] }],
      });

      await expect(boot(config, factories)).rejects.toThrow(BootError);
    });
  });

  describe("P1 failure - degraded mode", () => {
    it("enters degraded mode when store factory fails", async () => {
      const factories = makeHappyFactories({
        createStoreFactory: vi.fn(() => {
          throw new Error("store factory boom");
        }),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.mode).toBe("degraded");
      expect(result.health.success).toBe(true);
      expect(result.health.subsystems["store"]).toBe("degraded");
      expect(result.services.store).toBeUndefined();
    });

    it("enters degraded mode when circuit breaker fails", async () => {
      const factories = makeHappyFactories({
        createCircuitBreaker: vi.fn(() => {
          throw new Error("cb boom");
        }),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.mode).toBe("degraded");
      expect(result.health.subsystems["circuitBreaker"]).toBe("degraded");
      expect(result.services.circuitBreaker).toBeUndefined();
    });

    it("enters degraded mode when rate limiter fails", async () => {
      const factories = makeHappyFactories({
        createRateLimiter: vi.fn(() => {
          throw new Error("rl boom");
        }),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.mode).toBe("degraded");
      expect(result.health.subsystems["rateLimiter"]).toBe("degraded");
      expect(result.services.rateLimiter).toBeUndefined();
    });

    it("includes warning messages for degraded subsystems", async () => {
      const factories = makeHappyFactories({
        createStoreFactory: vi.fn(() => {
          throw new Error("store factory boom");
        }),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.warnings.some((w) => w.includes("ResilientStoreFactory"))).toBe(true);
    });
  });

  describe("dev mode", () => {
    it("enters dev mode when allowDev is true and P0 fails", async () => {
      const factories = makeHappyFactories({
        checkDataDir: vi.fn().mockRejectedValue(new Error("ENOENT")),
      });
      const config = makeValidConfig({ allowDev: true });

      const result = await boot(config, factories);

      expect(result.health.mode).toBe("dev");
      expect(result.health.success).toBe(false);
      expect(result.health.warnings.some((w) => w.includes("DEV MODE"))).toBe(true);
    });

    it("includes suppressed P0 errors in warnings", async () => {
      const factories = makeHappyFactories({
        checkDataDir: vi.fn().mockRejectedValue(new Error("ENOENT")),
      });
      const config = makeValidConfig({ allowDev: true });

      const result = await boot(config, factories);

      expect(result.health.warnings.some((w) => w.includes("P0 ERROR (suppressed in dev)"))).toBe(
        true,
      );
    });
  });

  describe("health report completeness", () => {
    it("includes all expected subsystem keys", async () => {
      const factories = makeHappyFactories();
      const config = makeValidConfig();

      const result = await boot(config, factories);

      const expectedKeys = [
        "config",
        "fs",
        "redactor",
        "logger",
        "auditTrail",
        "store",
        "circuitBreaker",
        "rateLimiter",
        "dedupIndex",
        "toolValidator",
        "lockManager",
      ];
      for (const key of expectedKeys) {
        expect(result.health.subsystems).toHaveProperty(key);
      }
    });

    it("reports boot time using the provided now function", async () => {
      let time = 1000;
      const factories = makeHappyFactories();
      const config = makeValidConfig({ now: () => time++ });

      const result = await boot(config, factories);

      expect(result.health.bootTimeMs).toBeGreaterThan(0);
    });
  });

  describe("shutdown", () => {
    it("calls rateLimiter.shutdown()", async () => {
      const mockRateLimiter = makeMockRateLimiter();
      const factories = makeHappyFactories({
        createRateLimiter: vi.fn(() => mockRateLimiter),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);
      await result.shutdown();

      expect(mockRateLimiter.shutdown).toHaveBeenCalledOnce();
    });

    it("calls auditTrail.close()", async () => {
      const mockAuditTrail = makeMockAuditTrail();
      const factories = makeHappyFactories({
        createAuditTrail: vi.fn(() => mockAuditTrail),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);
      await result.shutdown();

      expect(mockAuditTrail.close).toHaveBeenCalledOnce();
    });

    it("completes without error when services are undefined (dev mode)", async () => {
      const factories = makeHappyFactories({
        checkDataDir: vi.fn().mockRejectedValue(new Error("no dir")),
      });
      const config = makeValidConfig({ allowDev: true });

      const result = await boot(config, factories);
      await expect(result.shutdown()).resolves.toBeUndefined();
    });
  });

  describe("step 5 - reconcile pending intents", () => {
    it("reports pending intents as warnings during boot", async () => {
      const pendingIntents = new Set([1, 3, 7]);
      const mockAuditTrail = makeMockAuditTrail({ pendingIntents });
      const factories = makeHappyFactories({
        createAuditTrail: vi.fn(() => mockAuditTrail),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(mockAuditTrail.getPendingIntents).toHaveBeenCalled();
      expect(result.health.warnings.some((w) => w.includes("pending intent"))).toBe(true);
      expect(result.health.warnings.some((w) => w.includes("3"))).toBe(true);
    });

    it("no warning when no pending intents", async () => {
      const mockAuditTrail = makeMockAuditTrail({
        pendingIntents: new Set(),
      });
      const factories = makeHappyFactories({
        createAuditTrail: vi.fn(() => mockAuditTrail),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.warnings.some((w) => w.includes("pending intent"))).toBe(false);
    });

    it("handles reconcile errors gracefully", async () => {
      const mockAuditTrail = makeMockAuditTrail();
      mockAuditTrail.getPendingIntents.mockImplementation(() => {
        throw new Error("reconcile boom");
      });
      const factories = makeHappyFactories({
        createAuditTrail: vi.fn(() => mockAuditTrail),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);
      expect(result.health.warnings.some((w) => w.includes("Failed to reconcile"))).toBe(true);
    });
  });

  describe("step 6 - recover stale locks", () => {
    it("reports recovered stale locks as warnings", async () => {
      const mockLockManager = makeMockLockManager({
        staleLocks: ["workflow-1", "deploy-lock"],
      });
      const factories = makeHappyFactories({
        createLockManager: vi.fn(() => mockLockManager),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(mockLockManager.recoverStaleLocks).toHaveBeenCalled();
      expect(result.health.warnings.some((w) => w.includes("stale lock"))).toBe(true);
      expect(result.health.warnings.some((w) => w.includes("workflow-1"))).toBe(true);
    });

    it("no warning when no stale locks", async () => {
      const mockLockManager = makeMockLockManager({ staleLocks: [] });
      const factories = makeHappyFactories({
        createLockManager: vi.fn(() => mockLockManager),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.warnings.some((w) => w.includes("stale lock"))).toBe(false);
    });

    it("handles lock recovery errors gracefully", async () => {
      const mockLockManager = makeMockLockManager();
      mockLockManager.recoverStaleLocks.mockRejectedValue(new Error("lock recovery boom"));
      const factories = makeHappyFactories({
        createLockManager: vi.fn(() => mockLockManager),
      });
      const config = makeValidConfig();

      const result = await boot(config, factories);
      expect(result.health.warnings.some((w) => w.includes("Failed to recover stale locks"))).toBe(
        true,
      );
    });
  });

  describe("autonomous mode (no failures)", () => {
    it("enters autonomous mode when all subsystems including dedupIndex are ok", async () => {
      const factories = makeHappyFactories({
        createDedupIndex: vi.fn(() => ({ check: vi.fn() })),
      });
      const config = makeValidConfig();
      const result = await boot(config, factories);

      expect(result.health.mode).toBe("autonomous");
      expect(result.health.success).toBe(true);
      expect(result.health.subsystems["dedupIndex"]).toBe("ok");
      expect(result.services.dedupIndex).toBeDefined();
    });

    it("degrades when createDedupIndex returns falsy", async () => {
      const factories = makeHappyFactories({
        createDedupIndex: vi.fn(() => null),
      });
      const config = makeValidConfig();
      const result = await boot(config, factories);

      expect(result.health.mode).toBe("degraded");
      expect(result.health.subsystems["dedupIndex"]).toBe("degraded");
    });

    it("degrades when createDedupIndex throws", async () => {
      const factories = makeHappyFactories({
        createDedupIndex: vi.fn(() => {
          throw new Error("dedup boom");
        }),
      });
      const config = makeValidConfig();
      const result = await boot(config, factories);

      expect(result.health.mode).toBe("degraded");
      expect(result.health.subsystems["dedupIndex"]).toBe("degraded");
      expect(result.health.warnings.some((w) => w.includes("dedup boom"))).toBe(true);
    });
  });

  describe("config validation edge cases", () => {
    it("throws when auditTrailPath is non-string", async () => {
      const factories = makeHappyFactories();
      const config = makeValidConfig({
        auditTrailPath: 123 as any,
      });

      await expect(boot(config, factories)).rejects.toThrow(BootError);
    });

    it("throws when hmacKey is non-string", async () => {
      const factories = makeHappyFactories();
      const config = makeValidConfig({
        hmacKey: 456 as any,
      });

      await expect(boot(config, factories)).rejects.toThrow(BootError);
    });

    it("handles non-Error thrown values via errorMessage", async () => {
      const factories = makeHappyFactories({
        checkDataDir: vi.fn().mockRejectedValue("string-error"),
      });
      const config = makeValidConfig();

      try {
        await boot(config, factories);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(BootError);
        const bootErr = err as BootError;
        expect(bootErr.errors.some((e) => e.includes("string-error"))).toBe(true);
      }
    });

    it("handles redactor factory throwing", async () => {
      const factories = makeHappyFactories({
        createRedactor: vi.fn(() => {
          throw new Error("redactor factory exploded");
        }),
      });
      const config = makeValidConfig();

      await expect(boot(config, factories)).rejects.toThrow(BootError);
    });

    it("cascades logger failure when redactor failed", async () => {
      const factories = makeHappyFactories({
        createRedactor: vi.fn(() => {
          throw new Error("no redactor");
        }),
      });
      const config = makeValidConfig();

      try {
        await boot(config, factories);
        expect.fail("should have thrown");
      } catch (err) {
        const bootErr = err as BootError;
        expect(bootErr.subsystems["redactor"]).toBe("failed");
        expect(bootErr.subsystems["logger"]).toBe("failed");
        expect(bootErr.subsystems["auditTrail"]).toBe("failed");
      }
    });

    it("cascades lock manager failure when logger failed", async () => {
      const factories = makeHappyFactories({
        createLogger: vi.fn(() => {
          throw new Error("no logger");
        }),
      });
      const config = makeValidConfig();

      try {
        await boot(config, factories);
        expect.fail("should have thrown");
      } catch (err) {
        const bootErr = err as BootError;
        expect(bootErr.subsystems["logger"]).toBe("failed");
        expect(bootErr.subsystems["lockManager"]).toBe("failed");
      }
    });
  });

  describe("ToolValidator integration", () => {
    it("skips validation when no mcpToolNames provided", async () => {
      const factories = makeHappyFactories();
      const config = makeValidConfig();

      const result = await boot(config, factories);

      expect(result.health.subsystems["toolValidator"]).toBe("ok");
      expect(factories.createToolValidator).not.toHaveBeenCalled();
    });

    it("passes validation warnings to health report", async () => {
      const factories = makeHappyFactories({
        createToolValidator: vi.fn(() =>
          makeMockToolValidator({
            valid: true,
            errors: [],
            warnings: ["Unregistered MCP tool: secret_tool"],
          }),
        ),
      });
      const config = makeValidConfig({
        mcpToolNames: ["read_file", "secret_tool"],
        actionPolicy: [{ allow: ["read_file"] }],
      });

      const result = await boot(config, factories);

      expect(result.health.subsystems["toolValidator"]).toBe("ok");
      expect(result.health.warnings.some((w) => w.includes("Unregistered MCP tool"))).toBe(true);
    });
  });

  describe("non-factory code paths", () => {
    it("uses real fs.access when no checkDataDir factory provided", async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const tmpDir = await mkdtemp(join(tmpdir(), "boot-test-"));
      try {
        const factories = makeHappyFactories();
        delete factories.checkDataDir;
        const config = makeValidConfig({ dataDir: tmpDir });

        const result = await boot(config, factories);
        expect(result.health.subsystems["fs"]).toBe("ok");
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("uses real fs.access failure for nonexistent dir", async () => {
      const factories = makeHappyFactories();
      delete factories.checkDataDir;
      const config = makeValidConfig({
        dataDir: "/nonexistent-boot-test-" + Date.now(),
        allowDev: true,
      });

      const result = await boot(config, factories);
      expect(result.health.subsystems["fs"]).toBe("failed");
    });

    it("boots with real constructors (no factory overrides)", async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const tmpDir = await mkdtemp(join(tmpdir(), "boot-real-"));
      try {
        // No factories at all — exercises all real constructor branches
        const config: BootConfig = {
          dataDir: tmpDir,
          now: () => 1000,
        };

        const result = await boot(config);
        expect(result.health.success).toBe(true);
        expect(result.health.subsystems["config"]).toBe("ok");
        expect(result.health.subsystems["fs"]).toBe("ok");
        expect(result.health.subsystems["redactor"]).toBe("ok");
        expect(result.health.subsystems["logger"]).toBe("ok");
        expect(result.health.subsystems["auditTrail"]).toBe("ok");
        expect(result.health.subsystems["store"]).toBe("ok");
        expect(result.health.subsystems["circuitBreaker"]).toBe("ok");
        expect(result.health.subsystems["rateLimiter"]).toBe("ok");
        expect(result.health.subsystems["lockManager"]).toBe("ok");

        await result.shutdown();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("boots with real constructors and extra redaction patterns", async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const tmpDir = await mkdtemp(join(tmpdir(), "boot-redact-"));
      try {
        const config: BootConfig = {
          dataDir: tmpDir,
          now: () => 1000,
          extraRedactionPatterns: [{ name: "test_secret", pattern: /SECRET_\w+/ }],
        };

        const result = await boot(config);
        expect(result.health.subsystems["redactor"]).toBe("ok");
        await result.shutdown();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("factory invocation", () => {
    it("passes audit trail config correctly", async () => {
      const createAuditTrail = vi.fn(() => makeMockAuditTrail());
      const factories = makeHappyFactories({ createAuditTrail });
      const config = makeValidConfig({
        auditTrailPath: "/custom/audit.jsonl",
        hmacKey: "test-key",
      });

      await boot(config, factories);

      expect(createAuditTrail).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/custom/audit.jsonl",
          hmacKey: "test-key",
        }),
      );
    });

    it("uses default audit trail path when not specified", async () => {
      const createAuditTrail = vi.fn(() => makeMockAuditTrail());
      const factories = makeHappyFactories({ createAuditTrail });
      const config = makeValidConfig({ dataDir: "/data/test" });

      await boot(config, factories);

      expect(createAuditTrail).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/data/test/audit-trail.jsonl",
        }),
      );
    });
  });
});
