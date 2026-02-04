/**
 * Tests for BeadsSchedulerTasks
 *
 * @module beads/__tests__/beads-scheduler-tasks
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Scheduler } from "../../scheduler/scheduler.js";
import {
  registerBeadsSchedulerTasks,
  unregisterBeadsSchedulerTasks,
  getBeadsSchedulerStatus,
} from "../beads-scheduler-tasks.js";

// Mock child_process
vi.mock("child_process", () => ({
  exec: vi.fn((cmd, opts, callback) => {
    if (typeof opts === "function") {
      callback = opts;
    }
    // Return successful responses by default
    if (cmd.includes("doctor")) {
      callback(null, { stdout: JSON.stringify({ status: "healthy" }), stderr: "" });
    } else if (cmd.includes("sync")) {
      callback(null, { stdout: "Synced", stderr: "" });
    } else if (cmd.includes("stale")) {
      callback(null, { stdout: "[]", stderr: "" });
    } else {
      callback(null, { stdout: "", stderr: "" });
    }
  }),
}));

function createMockScheduler(): Scheduler & {
  registeredTasks: Map<string, any>;
  disabledTasks: Set<string>;
} {
  const registeredTasks = new Map<string, any>();
  const disabledTasks = new Set<string>();

  return {
    registeredTasks,
    disabledTasks,

    register(task: any) {
      registeredTasks.set(task.id, task);
    },

    disable(taskId: string) {
      disabledTasks.add(taskId);
    },

    enable(taskId: string) {
      disabledTasks.delete(taskId);
    },

    getStatus() {
      return Array.from(registeredTasks.values()).map((task) => ({
        id: task.id,
        name: task.name,
        status: disabledTasks.has(task.id) ? "disabled" : "idle",
        lastRun: null,
        consecutiveFailures: 0,
      }));
    },

    getTask(taskId: string) {
      return registeredTasks.get(taskId);
    },

    start() {},
    stop() {},
    trigger: vi.fn().mockResolvedValue(true),
    resetCircuitBreaker() {},
    isRunning: () => false,
  } as any;
}

describe("BeadsSchedulerTasks", () => {
  let mockScheduler: ReturnType<typeof createMockScheduler>;

  beforeEach(() => {
    mockScheduler = createMockScheduler();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("registerBeadsSchedulerTasks", () => {
    it("should register all three tasks by default", () => {
      registerBeadsSchedulerTasks(mockScheduler);

      expect(mockScheduler.registeredTasks.has("beads_health")).toBe(true);
      expect(mockScheduler.registeredTasks.has("beads_sync")).toBe(true);
      expect(mockScheduler.registeredTasks.has("beads_stale_check")).toBe(true);
    });

    it("should register health check with correct defaults", () => {
      registerBeadsSchedulerTasks(mockScheduler);

      const task = mockScheduler.registeredTasks.get("beads_health");
      expect(task.name).toBe("Beads Health Check");
      expect(task.intervalMs).toBe(15 * 60 * 1000); // 15 minutes
      expect(task.jitterMs).toBe(60 * 1000); // 1 minute
      expect(task.circuitBreaker).toBeDefined();
      expect(task.circuitBreaker.maxFailures).toBe(3);
    });

    it("should register sync task with mutex group", () => {
      registerBeadsSchedulerTasks(mockScheduler);

      const task = mockScheduler.registeredTasks.get("beads_sync");
      expect(task.name).toBe("Beads Auto Sync");
      expect(task.intervalMs).toBe(5 * 60 * 1000); // 5 minutes
      expect(task.mutexGroup).toBe("sync");
    });

    it("should register stale check with 24h interval", () => {
      registerBeadsSchedulerTasks(mockScheduler);

      const task = mockScheduler.registeredTasks.get("beads_stale_check");
      expect(task.name).toBe("Beads Stale Check");
      expect(task.intervalMs).toBe(24 * 60 * 60 * 1000); // 24 hours
    });

    it("should respect disabled config for health check", () => {
      registerBeadsSchedulerTasks(mockScheduler, {
        healthCheck: { enabled: false },
      });

      expect(mockScheduler.registeredTasks.has("beads_health")).toBe(false);
      expect(mockScheduler.registeredTasks.has("beads_sync")).toBe(true);
      expect(mockScheduler.registeredTasks.has("beads_stale_check")).toBe(true);
    });

    it("should respect disabled config for sync", () => {
      registerBeadsSchedulerTasks(mockScheduler, {
        autoSync: { enabled: false },
      });

      expect(mockScheduler.registeredTasks.has("beads_health")).toBe(true);
      expect(mockScheduler.registeredTasks.has("beads_sync")).toBe(false);
      expect(mockScheduler.registeredTasks.has("beads_stale_check")).toBe(true);
    });

    it("should respect disabled config for stale check", () => {
      registerBeadsSchedulerTasks(mockScheduler, {
        staleCheck: { enabled: false },
      });

      expect(mockScheduler.registeredTasks.has("beads_health")).toBe(true);
      expect(mockScheduler.registeredTasks.has("beads_sync")).toBe(true);
      expect(mockScheduler.registeredTasks.has("beads_stale_check")).toBe(false);
    });

    it("should allow custom intervals", () => {
      registerBeadsSchedulerTasks(mockScheduler, {
        healthCheck: { intervalMs: 10 * 60 * 1000 },
        autoSync: { intervalMs: 2 * 60 * 1000 },
        staleCheck: { intervalMs: 12 * 60 * 60 * 1000, staleDays: 14 },
      });

      expect(mockScheduler.registeredTasks.get("beads_health").intervalMs).toBe(10 * 60 * 1000);
      expect(mockScheduler.registeredTasks.get("beads_sync").intervalMs).toBe(2 * 60 * 1000);
      expect(mockScheduler.registeredTasks.get("beads_stale_check").intervalMs).toBe(
        12 * 60 * 60 * 1000,
      );
    });
  });

  describe("task handlers", () => {
    it("health check handler should call br doctor", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      registerBeadsSchedulerTasks(mockScheduler);
      const task = mockScheduler.registeredTasks.get("beads_health");

      await task.handler();

      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining("br doctor"),
        expect.anything(),
        expect.anything(),
      );
    });

    it("sync handler should call br sync --flush-only", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      registerBeadsSchedulerTasks(mockScheduler);
      const task = mockScheduler.registeredTasks.get("beads_sync");

      await task.handler();

      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining("br sync --flush-only"),
        expect.anything(),
        expect.anything(),
      );
    });

    it("stale check handler should call br stale", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      registerBeadsSchedulerTasks(mockScheduler);
      const task = mockScheduler.registeredTasks.get("beads_stale_check");

      await task.handler();

      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining("br stale --days 7"),
        expect.anything(),
        expect.anything(),
      );
    });

    it("health check should throw on unhealthy status", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      execMock.mockImplementation((cmd, opts, callback) => {
        if (typeof opts === "function") {
          callback = opts;
        }
        callback(null, {
          stdout: JSON.stringify({ status: "unhealthy", message: "Database corrupt" }),
          stderr: "",
        });
        return {} as any;
      });

      registerBeadsSchedulerTasks(mockScheduler);
      const task = mockScheduler.registeredTasks.get("beads_health");

      await expect(task.handler()).rejects.toThrow("Beads unhealthy");
    });

    it("stale check should warn on stale issues", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      const staleIssues = [
        { id: "bead-1", title: "Old task 1" },
        { id: "bead-2", title: "Old task 2" },
      ];

      execMock.mockImplementation((cmd, opts, callback) => {
        if (typeof opts === "function") {
          callback = opts;
        }
        callback(null, { stdout: JSON.stringify(staleIssues), stderr: "" });
        return {} as any;
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      registerBeadsSchedulerTasks(mockScheduler);
      const task = mockScheduler.registeredTasks.get("beads_stale_check");

      await task.handler();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Found 2 stale issues"));

      warnSpy.mockRestore();
    });

    it("handlers should gracefully handle br command not found", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      execMock.mockImplementation((cmd, opts, callback) => {
        if (typeof opts === "function") {
          callback = opts;
        }
        callback(new Error("command not found: br"), { stdout: "", stderr: "" });
        return {} as any;
      });

      registerBeadsSchedulerTasks(mockScheduler);

      // All handlers should complete without throwing
      const healthTask = mockScheduler.registeredTasks.get("beads_health");
      const syncTask = mockScheduler.registeredTasks.get("beads_sync");
      const staleTask = mockScheduler.registeredTasks.get("beads_stale_check");

      await expect(healthTask.handler()).resolves.not.toThrow();
      await expect(syncTask.handler()).resolves.not.toThrow();
      await expect(staleTask.handler()).resolves.not.toThrow();
    });
  });

  describe("unregisterBeadsSchedulerTasks", () => {
    it("should disable all beads tasks", () => {
      registerBeadsSchedulerTasks(mockScheduler);
      unregisterBeadsSchedulerTasks(mockScheduler);

      expect(mockScheduler.disabledTasks.has("beads_health")).toBe(true);
      expect(mockScheduler.disabledTasks.has("beads_sync")).toBe(true);
      expect(mockScheduler.disabledTasks.has("beads_stale_check")).toBe(true);
    });
  });

  describe("getBeadsSchedulerStatus", () => {
    it("should return status of beads tasks only", () => {
      // Register beads tasks
      registerBeadsSchedulerTasks(mockScheduler);

      // Register a non-beads task
      mockScheduler.register({
        id: "other_task",
        name: "Other Task",
        intervalMs: 1000,
        handler: async () => {},
      });

      const status = getBeadsSchedulerStatus(mockScheduler);

      expect(status).toHaveLength(3);
      expect(status.map((s) => s.id)).toEqual(["beads_health", "beads_sync", "beads_stale_check"]);
    });
  });
});
