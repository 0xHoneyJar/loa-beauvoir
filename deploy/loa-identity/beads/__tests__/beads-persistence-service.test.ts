/**
 * Tests for BeadsPersistenceService
 *
 * Covers:
 * - TASK-1.5: Constructor refactor (options object)
 * - TASK-1.5b: WorkQueue registration via vi.mock spies
 *
 * @module beads/__tests__/beads-persistence-service
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { IBeadsRunStateManager } from "../../../../.claude/lib/beads";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { SegmentedWALManager } from "../../wal/wal-manager.js";

// Spy on work queue + scheduler task registration
const mockCreateBeadsWorkQueue = vi.fn().mockReturnValue({
  register: vi.fn(),
});
const mockRegisterBeadsSchedulerTasks = vi.fn();
const mockRegisterWorkQueueTask = vi.fn();

vi.mock("../beads-work-queue.js", () => ({
  createBeadsWorkQueue: mockCreateBeadsWorkQueue,
}));

vi.mock("../beads-scheduler-tasks.js", () => ({
  registerBeadsSchedulerTasks: mockRegisterBeadsSchedulerTasks,
  registerWorkQueueTask: mockRegisterWorkQueueTask,
}));

// Mock WAL adapter and recovery handler
vi.mock("../beads-wal-adapter.js", () => ({
  createBeadsWALAdapter: vi.fn().mockReturnValue({
    recordTransition: vi.fn().mockResolvedValue(1),
    getCurrentSeq: vi.fn().mockReturnValue(0),
  }),
  BeadsWALAdapter: vi.fn(),
}));

vi.mock("../beads-recovery.js", () => ({
  createBeadsRecoveryHandler: vi.fn().mockReturnValue({
    needsRecovery: vi.fn().mockResolvedValue(false),
    recover: vi
      .fn()
      .mockResolvedValue({ success: true, entriesReplayed: 0, beadsAffected: [], durationMs: 0 }),
  }),
  BeadsRecoveryHandler: vi.fn(),
}));

// Import after mocks
const { BeadsPersistenceService, createBeadsPersistenceService, createDefaultBeadsConfig } =
  await import("../beads-persistence-service.js");

function createMockScheduler(): Scheduler {
  return {
    register: vi.fn(),
    disable: vi.fn(),
    enable: vi.fn(),
    getStatus: vi.fn().mockReturnValue([]),
    getTask: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    trigger: vi.fn().mockResolvedValue(true),
    resetCircuitBreaker: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
  } as any;
}

function createMockWAL(): SegmentedWALManager {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    append: vi.fn().mockResolvedValue(1),
    readAll: vi.fn().mockResolvedValue([]),
    truncate: vi.fn().mockResolvedValue(undefined),
    getCurrentSeq: vi.fn().mockReturnValue(0),
  } as any;
}

function createMockRunStateManager(): IBeadsRunStateManager {
  return {
    getRunState: vi.fn().mockReturnValue("RUNNING"),
    setRunState: vi.fn(),
    getSprintState: vi.fn().mockReturnValue(null),
    setSprintState: vi.fn(),
  } as any;
}

describe("BeadsPersistenceService", () => {
  let mockScheduler: Scheduler;
  let mockWAL: SegmentedWALManager;
  let mockRunState: IBeadsRunStateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockScheduler = createMockScheduler();
    mockWAL = createMockWAL();
    mockRunState = createMockRunStateManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // TASK-1.5: Constructor refactor (options object)
  // =========================================================================

  describe("constructor options object (TASK-1.5)", () => {
    it("accepts options object with wal, scheduler, runStateManager", () => {
      const config = createDefaultBeadsConfig();
      const service = new BeadsPersistenceService(config, {
        wal: mockWAL,
        scheduler: mockScheduler,
        runStateManager: mockRunState,
      });

      expect(service).toBeDefined();
      expect(service.isHealthy()).toBe(false); // not initialized yet
    });

    it("works with no opts (all optional)", () => {
      const config = createDefaultBeadsConfig();
      const service = new BeadsPersistenceService(config);

      expect(service).toBeDefined();
    });

    it("throws when workQueue.enabled=true but runStateManager missing", () => {
      const config = createDefaultBeadsConfig({
        scheduler: {
          healthCheck: { enabled: true },
          autoSync: { enabled: true },
          staleCheck: { enabled: true },
          workQueue: { enabled: true },
        },
      });

      expect(() => new BeadsPersistenceService(config, { scheduler: mockScheduler })).toThrow(
        /workQueue\.enabled=true requires a runStateManager/,
      );
    });

    it("does NOT throw when workQueue.enabled=false and runStateManager missing", () => {
      const config = createDefaultBeadsConfig({
        scheduler: {
          healthCheck: { enabled: true },
          autoSync: { enabled: true },
          staleCheck: { enabled: true },
          workQueue: { enabled: false },
        },
      });

      expect(() => new BeadsPersistenceService(config, { scheduler: mockScheduler })).not.toThrow();
    });

    it("factory function accepts options object", () => {
      const config = createDefaultBeadsConfig();
      const service = createBeadsPersistenceService(config, {
        wal: mockWAL,
        scheduler: mockScheduler,
      });

      expect(service).toBeInstanceOf(BeadsPersistenceService);
    });
  });

  // =========================================================================
  // TASK-1.5b: WorkQueue registration via vi.mock spies
  // =========================================================================

  describe("WorkQueue registration (TASK-1.5b)", () => {
    it("calls registerWorkQueueTask when workQueue.enabled=true + runStateManager present", () => {
      const config = createDefaultBeadsConfig({
        scheduler: {
          healthCheck: { enabled: true },
          autoSync: { enabled: true },
          staleCheck: { enabled: true },
          workQueue: { enabled: true },
        },
      });

      new BeadsPersistenceService(config, {
        wal: mockWAL,
        scheduler: mockScheduler,
        runStateManager: mockRunState,
      });

      expect(mockCreateBeadsWorkQueue).toHaveBeenCalledOnce();
      expect(mockRegisterWorkQueueTask).toHaveBeenCalledOnce();
    });

    it("does NOT call registerWorkQueueTask when workQueue.enabled=false", () => {
      const config = createDefaultBeadsConfig({
        scheduler: {
          healthCheck: { enabled: true },
          autoSync: { enabled: true },
          staleCheck: { enabled: true },
          workQueue: { enabled: false },
        },
      });

      new BeadsPersistenceService(config, {
        scheduler: mockScheduler,
      });

      expect(mockCreateBeadsWorkQueue).not.toHaveBeenCalled();
      expect(mockRegisterWorkQueueTask).not.toHaveBeenCalled();
    });

    it("passes same schedulerConfig to both registerBeadsSchedulerTasks and registerWorkQueueTask", () => {
      const config = createDefaultBeadsConfig({
        beadsDir: "/custom/beads",
        brCommand: "custom-br",
        scheduler: {
          healthCheck: { enabled: true },
          autoSync: { enabled: true },
          staleCheck: { enabled: true },
          workQueue: { enabled: true },
        },
      });

      new BeadsPersistenceService(config, {
        scheduler: mockScheduler,
        runStateManager: mockRunState,
      });

      // Both should receive a config object containing beadsDir and brCommand
      const mainTasksConfig = mockRegisterBeadsSchedulerTasks.mock.calls[0][1];
      const workQueueConfig = mockRegisterWorkQueueTask.mock.calls[0][2];

      expect(mainTasksConfig.beadsDir).toBe("/custom/beads");
      expect(mainTasksConfig.brCommand).toBe("custom-br");
      expect(workQueueConfig.beadsDir).toBe("/custom/beads");
      expect(workQueueConfig.brCommand).toBe("custom-br");
      // Same object reference — single source of truth
      expect(mainTasksConfig).toBe(workQueueConfig);
    });
  });
});
