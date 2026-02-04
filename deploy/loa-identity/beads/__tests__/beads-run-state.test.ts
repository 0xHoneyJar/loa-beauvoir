/**
 * Tests for BeadsRunStateManager
 *
 * @module beads/__tests__/beads-run-state
 */

import * as childProcess from "child_process";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { BeadsRunStateManager, LABELS, type RunState } from "../beads-run-state.js";

// Mock child_process
vi.mock("child_process", () => ({
  exec: vi.fn((cmd, callback) => {
    // Default: return empty array
    callback(null, { stdout: "[]", stderr: "" });
  }),
}));

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
}));

function createMockExec(responses: Map<string, string>) {
  const execMock = vi.mocked(childProcess.exec);

  execMock.mockImplementation(((
    cmd: string,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    for (const [pattern, response] of responses) {
      if (cmd.includes(pattern)) {
        callback(null, { stdout: response, stderr: "" });
        return {} as any;
      }
    }
    // Default empty array
    callback(null, { stdout: "[]", stderr: "" });
    return {} as any;
  }) as any);

  return execMock;
}

describe("BeadsRunStateManager", () => {
  let manager: BeadsRunStateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new BeadsRunStateManager({ verbose: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getRunState", () => {
    it("should return READY when no run:current beads exist", async () => {
      createMockExec(new Map([["list --label 'run:current'", "[]"]]));

      const state = await manager.getRunState();
      expect(state).toBe("READY");
    });

    it("should return HALTED when run has circuit-breaker label", async () => {
      createMockExec(
        new Map([
          [
            "list --label 'run:current'",
            JSON.stringify([{ id: "run-1", labels: ["run:current", "circuit-breaker"] }]),
          ],
        ]),
      );

      const state = await manager.getRunState();
      expect(state).toBe("HALTED");
    });

    it("should return RUNNING when sprint:in_progress exists", async () => {
      createMockExec(
        new Map([
          [
            "list --label 'run:current'",
            JSON.stringify([{ id: "run-1", labels: ["run:current"] }]),
          ],
          [
            "list --label 'sprint:in_progress'",
            JSON.stringify([{ id: "sprint-1", labels: ["sprint:in_progress"] }]),
          ],
        ]),
      );

      const state = await manager.getRunState();
      expect(state).toBe("RUNNING");
    });

    it("should return COMPLETE when no pending sprints exist", async () => {
      createMockExec(
        new Map([
          [
            "list --label 'run:current'",
            JSON.stringify([{ id: "run-1", labels: ["run:current"] }]),
          ],
          ["list --label 'sprint:in_progress'", "[]"],
          ["list --label 'sprint:pending'", "[]"],
        ]),
      );

      const state = await manager.getRunState();
      expect(state).toBe("COMPLETE");
    });

    it("should return RUNNING when pending sprints exist but none in progress", async () => {
      createMockExec(
        new Map([
          [
            "list --label 'run:current'",
            JSON.stringify([{ id: "run-1", labels: ["run:current"] }]),
          ],
          ["list --label 'sprint:in_progress'", "[]"],
          [
            "list --label 'sprint:pending'",
            JSON.stringify([{ id: "sprint-1", labels: ["sprint:pending"] }]),
          ],
        ]),
      );

      const state = await manager.getRunState();
      expect(state).toBe("RUNNING");
    });
  });

  describe("getCurrentSprint", () => {
    it("should return null when no sprint is in progress", async () => {
      createMockExec(new Map([["list --label 'sprint:in_progress'", "[]"]]));

      const sprint = await manager.getCurrentSprint();
      expect(sprint).toBeNull();
    });

    it("should return sprint state with task counts", async () => {
      createMockExec(
        new Map([
          [
            "list --label 'sprint:in_progress'",
            JSON.stringify([{ id: "sprint-1", labels: ["sprint:1", "sprint:in_progress"] }]),
          ],
          [
            "list --label 'epic:sprint-1'",
            JSON.stringify([
              { id: "task-1", status: "closed", labels: [] },
              { id: "task-2", status: "open", labels: ["in_progress"] },
              { id: "task-3", status: "open", labels: [] },
            ]),
          ],
        ]),
      );

      const sprint = await manager.getCurrentSprint();

      expect(sprint).not.toBeNull();
      expect(sprint?.id).toBe("sprint-1");
      expect(sprint?.sprintNumber).toBe(1);
      expect(sprint?.status).toBe("in_progress");
      expect(sprint?.tasksTotal).toBe(3);
      expect(sprint?.tasksCompleted).toBe(1);
      expect(sprint?.currentTaskId).toBe("task-2");
    });
  });

  describe("createCircuitBreaker", () => {
    it("should create circuit breaker bead with correct labels", async () => {
      const execMock = vi.mocked(childProcess.exec);

      // Track calls
      const calls: string[] = [];
      execMock.mockImplementation(((
        cmd: string,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        calls.push(cmd);
        if (cmd.includes("create")) {
          callback(null, { stdout: JSON.stringify({ id: "cb-123" }), stderr: "" });
        } else {
          callback(null, { stdout: "[]", stderr: "" });
        }
        return {} as any;
      }) as any);

      const result = await manager.createCircuitBreaker("sprint-1", "Test failure", 3);

      expect(result.beadId).toBe("cb-123");
      expect(result.sprintId).toBe("sprint-1");
      expect(result.reason).toBe("Test failure");
      expect(result.failureCount).toBe(3);

      // Verify create command includes circuit-breaker and same-issue labels
      const createCall = calls.find((c) => c.includes("create"));
      expect(createCall).toContain("--label 'circuit-breaker'");
      expect(createCall).toContain("--label 'same-issue-3x'");

      // Verify comment was added
      const commentCall = calls.find((c) => c.includes("comments add"));
      expect(commentCall).toContain("Triggered: Test failure");
    });
  });

  describe("resolveCircuitBreaker", () => {
    it("should close bead and remove circuit-breaker label from run", async () => {
      const execMock = vi.mocked(childProcess.exec);

      const calls: string[] = [];
      execMock.mockImplementation(((
        cmd: string,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        calls.push(cmd);
        if (cmd.includes("list --label 'run:current'")) {
          callback(null, {
            stdout: JSON.stringify([{ id: "run-1", labels: ["run:current", "circuit-breaker"] }]),
            stderr: "",
          });
        } else {
          callback(null, { stdout: "", stderr: "" });
        }
        return {} as any;
      }) as any);

      await manager.resolveCircuitBreaker("cb-123");

      // Verify close was called
      const closeCall = calls.find((c) => c.includes("close 'cb-123'"));
      expect(closeCall).toBeDefined();

      // Verify comment was added
      const commentCall = calls.find((c) => c.includes("comments add 'cb-123'"));
      expect(commentCall).toContain("Resolved at");

      // Verify label was removed from run
      const removeLabelCall = calls.find((c) => c.includes("label remove 'run-1'"));
      expect(removeLabelCall).toContain("circuit-breaker");
    });
  });

  describe("startRun", () => {
    it("should create run epic and label sprints", async () => {
      const execMock = vi.mocked(childProcess.exec);

      const calls: string[] = [];
      execMock.mockImplementation(((
        cmd: string,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        calls.push(cmd);
        if (cmd.includes("create")) {
          callback(null, { stdout: JSON.stringify({ id: "run-new" }), stderr: "" });
        } else {
          callback(null, { stdout: "", stderr: "" });
        }
        return {} as any;
      }) as any);

      const runId = await manager.startRun(["sprint-1", "sprint-2"]);

      expect(runId).toBe("run-new");

      // Verify run epic created with correct label
      const createCall = calls.find((c) => c.includes("create") && c.includes("Run:"));
      expect(createCall).toContain("--label 'run:current'");
      expect(createCall).toContain("--type epic");

      // Verify sprints were labeled
      const sprint1Labels = calls.filter((c) => c.includes("label add 'sprint-1'"));
      expect(sprint1Labels.length).toBeGreaterThan(0);
      expect(sprint1Labels.some((c) => c.includes("sprint:1"))).toBe(true);
      expect(sprint1Labels.some((c) => c.includes("sprint:pending"))).toBe(true);

      const sprint2Labels = calls.filter((c) => c.includes("label add 'sprint-2'"));
      expect(sprint2Labels.some((c) => c.includes("sprint:2"))).toBe(true);
    });
  });

  describe("startSprint", () => {
    it("should remove pending label and add in_progress", async () => {
      const execMock = vi.mocked(childProcess.exec);

      const calls: string[] = [];
      execMock.mockImplementation(((
        cmd: string,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        calls.push(cmd);
        callback(null, { stdout: "", stderr: "" });
        return {} as any;
      }) as any);

      await manager.startSprint("sprint-1");

      // Verify pending was removed
      const removeCall = calls.find((c) => c.includes("label remove 'sprint-1'"));
      expect(removeCall).toContain("sprint:pending");

      // Verify in_progress was added
      const addCall = calls.find((c) => c.includes("label add 'sprint-1'"));
      expect(addCall).toContain("sprint:in_progress");
    });
  });

  describe("completeSprint", () => {
    it("should remove in_progress, add complete, and close bead", async () => {
      const execMock = vi.mocked(childProcess.exec);

      const calls: string[] = [];
      execMock.mockImplementation(((
        cmd: string,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        calls.push(cmd);
        callback(null, { stdout: "", stderr: "" });
        return {} as any;
      }) as any);

      await manager.completeSprint("sprint-1");

      // Verify in_progress was removed
      expect(
        calls.some((c) => c.includes("label remove") && c.includes("sprint:in_progress")),
      ).toBe(true);

      // Verify complete was added
      expect(calls.some((c) => c.includes("label add") && c.includes("sprint:complete"))).toBe(
        true,
      );

      // Verify bead was closed
      expect(calls.some((c) => c.includes("close 'sprint-1'"))).toBe(true);
    });
  });

  describe("LABELS", () => {
    it("should export all required label constants", () => {
      expect(LABELS.RUN_CURRENT).toBe("run:current");
      expect(LABELS.RUN_COMPLETE).toBe("run:complete");
      expect(LABELS.SPRINT_IN_PROGRESS).toBe("sprint:in_progress");
      expect(LABELS.SPRINT_PENDING).toBe("sprint:pending");
      expect(LABELS.SPRINT_COMPLETE).toBe("sprint:complete");
      expect(LABELS.CIRCUIT_BREAKER).toBe("circuit-breaker");
      expect(LABELS.TASK_READY).toBe("ready");
      expect(LABELS.TASK_IN_PROGRESS).toBe("in_progress");
      expect(LABELS.TASK_BLOCKED).toBe("blocked");
      expect(LABELS.TASK_DONE).toBe("done");
    });
  });

  describe("security", () => {
    it("should reject invalid bead IDs", async () => {
      await expect(manager.startSprint("sprint;rm -rf /")).rejects.toThrow("Invalid beadId");
      await expect(manager.startSprint("sprint$(whoami)")).rejects.toThrow("Invalid beadId");
      await expect(manager.startSprint("")).rejects.toThrow("Invalid beadId");
    });

    it("should accept valid bead IDs", async () => {
      const execMock = vi.mocked(childProcess.exec);
      execMock.mockImplementation(((
        cmd: string,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        callback(null, { stdout: "", stderr: "" });
        return {} as any;
      }) as any);

      // These should not throw
      await expect(manager.startSprint("sprint-1")).resolves.not.toThrow();
      await expect(manager.startSprint("SPRINT_123")).resolves.not.toThrow();
      await expect(manager.startSprint("abc-def-123")).resolves.not.toThrow();
    });

    it("should reject path traversal in migrateFromDotRun", async () => {
      await expect(manager.migrateFromDotRun("../../../etc")).rejects.toThrow(
        "traversal not allowed",
      );
      await expect(manager.migrateFromDotRun(".run/../secrets")).rejects.toThrow(
        "traversal not allowed",
      );
    });
  });
});
