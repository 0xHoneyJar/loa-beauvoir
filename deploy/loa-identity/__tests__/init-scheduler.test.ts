/**
 * Tests for initializeLoa scheduler wiring
 *
 * Covers:
 * - TASK-1.6: Init flow (scheduler.start + fail-fast)
 * - TASK-1.7: Shutdown handle (idempotent, error-safe)
 *
 * @module deploy/loa-identity/__tests__/init-scheduler
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Track scheduler calls
const mockSchedulerStart = vi.fn();
const mockSchedulerStop = vi.fn();

// Track beads persistence calls
const mockInitialize = vi.fn().mockResolvedValue(undefined);

// Mock @noble packages (transitive deps of security modules)
vi.mock("@noble/ed25519", () => ({
  default: {},
  getPublicKey: vi.fn(),
  sign: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@noble/hashes/sha512", () => ({
  sha512: vi.fn(),
}));

// Mock all dynamic imports used by initializeLoa
vi.mock("../../../.claude/lib/persistence/identity/identity-loader.js", () => ({
  createIdentityLoader: vi.fn().mockReturnValue({
    load: vi.fn().mockResolvedValue(undefined),
  }),
  IdentityLoader: vi.fn(),
}));

vi.mock("../security/index.js", () => {
  class MockAuditLogger {
    initialize = vi.fn().mockResolvedValue(undefined);
  }
  class MockManifestSigner {}
  class MockPIIRedactor {}
  return {
    ManifestSigner: MockManifestSigner,
    AuditLogger: MockAuditLogger,
    AllowlistSigner: vi.fn(),
    PIIRedactor: MockPIIRedactor,
    SecretScanner: vi.fn(),
    CredentialManager: vi.fn(),
    KeyManager: vi.fn(),
    generateKeyPair: vi.fn(),
    getCredentialManager: vi.fn(),
    createKeyManager: vi.fn(),
    runPreCommitHook: vi.fn(),
  };
});

vi.mock("../recovery/index.js", () => ({
  RecoveryEngine: vi.fn(),
  R2Client: vi.fn(),
  GitClient: vi.fn(),
  createRecoveryEngine: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue(undefined),
  }),
  createR2ClientFromMount: vi.fn(),
  createR2ClientFromEnv: vi.fn(),
  createGitClient: vi.fn(),
  createGitClientFromEnv: vi.fn(),
  runRecoveryEngine: vi.fn(),
}));

vi.mock("../wal/index.js", () => ({
  SegmentedWALManager: vi.fn(),
  createSegmentedWALManager: vi.fn().mockReturnValue({
    initialize: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../memory/index.js", () => ({
  SessionMemoryManager: vi.fn(),
  ConsolidationEngine: vi.fn(),
  ConsolidationQueue: vi.fn(),
  EmbeddingClient: vi.fn(),
  createSessionMemoryManager: vi.fn().mockReturnValue({}),
  createConsolidationEngine: vi.fn(),
  createConsolidationQueue: vi.fn(),
  createEmbeddingClient: vi.fn(),
  createDefaultQualityGates: vi.fn(),
  applyQualityGates: vi.fn(),
}));

vi.mock("../repair/index.js", () => ({
  RepairEngine: vi.fn(),
  DependencyDetector: vi.fn(),
  createRepairEngine: vi.fn(),
  createDependencyDetector: vi.fn(),
}));

vi.mock("../scheduler/index.js", () => ({
  Scheduler: vi.fn(),
  createBeauvoirScheduler: vi.fn().mockReturnValue({
    register: vi.fn(),
    start: mockSchedulerStart,
    stop: mockSchedulerStop,
    getStatus: vi.fn().mockReturnValue([]),
    isRunning: vi.fn().mockReturnValue(false),
  }),
}));

vi.mock("../beads/index.js", () => ({
  // Static exports used by index.ts barrel
  BeadsWALAdapter: vi.fn(),
  BeadsRecoveryHandler: vi.fn(),
  BeadsPersistenceService: vi.fn(),
  createBeadsWALAdapter: vi.fn(),
  createBeadsRecoveryHandler: vi.fn(),
  registerBeadsSchedulerTasks: vi.fn(),
  unregisterBeadsSchedulerTasks: vi.fn(),
  getBeadsSchedulerStatus: vi.fn(),
  // Dynamic imports used by initializeLoa
  createBeadsPersistenceService: vi.fn().mockReturnValue({
    initialize: mockInitialize,
    isHealthy: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue({ initialized: true }),
  }),
  createDefaultBeadsConfig: vi.fn().mockImplementation((overrides) => ({
    enabled: true,
    beadsDir: ".beads",
    wal: { enabled: true, replayOnStart: true, verbose: false },
    scheduler: {
      healthCheck: { enabled: true },
      autoSync: { enabled: true },
      staleCheck: { enabled: true },
    },
    brCommand: "br",
    ...overrides,
  })),
  createBeadsRunStateManager: vi.fn().mockReturnValue({
    getRunState: vi.fn().mockReturnValue("RUNNING"),
  }),
}));

const { initializeLoa } = await import("../index.js");

const defaultConfig = {
  grimoiresDir: "/tmp/test-grimoires",
  walDir: "/tmp/test-wal",
};

describe("initializeLoa scheduler wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitialize.mockResolvedValue(undefined);
    mockSchedulerStart.mockImplementation(() => {});
    mockSchedulerStop.mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // TASK-1.6: Init flow (start + fail-fast)
  // =========================================================================

  describe("init flow (TASK-1.6)", () => {
    it("calls scheduler.start() after initialize() resolves successfully", async () => {
      await initializeLoa(defaultConfig);

      expect(mockInitialize).toHaveBeenCalledOnce();
      expect(mockSchedulerStart).toHaveBeenCalledOnce();
    });

    it("scheduler.start() NOT called when initialize() rejects", async () => {
      mockInitialize.mockRejectedValueOnce(new Error("init failed"));

      await expect(initializeLoa(defaultConfig)).rejects.toThrow("init failed");

      expect(mockInitialize).toHaveBeenCalledOnce();
      expect(mockSchedulerStart).not.toHaveBeenCalled();
    });

    it("on init failure, scheduler.stop() called defensively", async () => {
      mockInitialize.mockRejectedValueOnce(new Error("init failed"));

      await expect(initializeLoa(defaultConfig)).rejects.toThrow("init failed");

      expect(mockSchedulerStop).toHaveBeenCalledOnce();
    });

    it("original initialize() error is rethrown even if scheduler.stop() also throws", async () => {
      const originalError = new Error("init failed");
      mockInitialize.mockRejectedValueOnce(originalError);
      mockSchedulerStop.mockImplementationOnce(() => {
        throw new Error("stop also failed");
      });

      await expect(initializeLoa(defaultConfig)).rejects.toThrow("init failed");

      // Verify the original error is preserved, not the stop error
      try {
        await initializeLoa({
          ...defaultConfig,
        });
      } catch (e: any) {
        // This second call succeeds since mocks are cleared after first rejection
      }

      expect(mockSchedulerStop).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TASK-1.7: Shutdown handle
  // =========================================================================

  describe("shutdown handle (TASK-1.7)", () => {
    it("shutdown() calls scheduler.stop() exactly once", async () => {
      const result = await initializeLoa(defaultConfig);

      // Clear the start-related stop mock calls
      mockSchedulerStop.mockClear();

      result.shutdown();

      expect(mockSchedulerStop).toHaveBeenCalledOnce();
    });

    it("double shutdown() call is safe — scheduler.stop() called only once", async () => {
      const result = await initializeLoa(defaultConfig);
      mockSchedulerStop.mockClear();

      result.shutdown();
      result.shutdown();

      expect(mockSchedulerStop).toHaveBeenCalledOnce();
    });

    it("shutdown() does not throw even if scheduler.stop() throws", async () => {
      const result = await initializeLoa(defaultConfig);
      mockSchedulerStop.mockClear();
      mockSchedulerStop.mockImplementationOnce(() => {
        throw new Error("stop exploded");
      });

      expect(() => result.shutdown()).not.toThrow();
    });
  });
});
