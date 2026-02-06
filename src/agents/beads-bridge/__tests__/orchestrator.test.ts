import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock child_process for BrExecutor
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: vi.fn(),
}));

// Mock json-file to avoid real filesystem
vi.mock("../../../infra/json-file.js", () => ({
  loadJsonFile: vi.fn(() => undefined),
  saveJsonFile: vi.fn(),
}));

import type { BeadRecord } from "../br-executor.js";
import { DispatchOrchestrator, type OrchestratorDeps } from "../orchestrator.js";

function makeDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    callGateway: vi.fn().mockResolvedValue({ runId: "mock-run-id" }),
    onAgentEvent: vi.fn().mockReturnValue(() => {}),
    readLatestAssistantReply: vi.fn().mockResolvedValue("done"),
    ...overrides,
  };
}

function makeBeadJson(bead: BeadRecord): string {
  return JSON.stringify(bead);
}

function makeBeadListJson(beads: BeadRecord[]): string {
  return JSON.stringify(beads);
}

function setupExecFile(responses: Map<string, string>) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb?: Function) => {
    // promisify pattern: if callback provided, call it; otherwise return for promisify
    const key = args.join(" ");
    for (const [pattern, response] of responses.entries()) {
      if (key.includes(pattern)) {
        if (cb) {
          cb(null, { stdout: response, stderr: "" });
          return;
        }
        return { stdout: response, stderr: "" };
      }
    }
    // Default: empty response for mutations
    if (cb) {
      cb(null, { stdout: "", stderr: "" });
      return;
    }
    return { stdout: "", stderr: "" };
  });
}

describe("DispatchOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("restoreOnce", () => {
    it("is idempotent", () => {
      const deps = makeDeps();
      const orch = new DispatchOrchestrator(deps);

      orch.restoreOnce();
      orch.restoreOnce();

      // onAgentEvent should only be called once (for the lifecycle listener)
      expect(deps.onAgentEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe("readSprintTasks", () => {
    it("queries by sprint label when sprintId provided", async () => {
      const readyTasks: BeadRecord[] = [
        { id: "task-1", title: "T1", status: "open", labels: ["ready", "sprint-source:s1"] },
      ];

      setupExecFile(
        new Map([["list --label sprint-source:s1 --json", makeBeadListJson(readyTasks)]]),
      );

      const deps = makeDeps();
      const orch = new DispatchOrchestrator(deps);

      const tasks = await orch.readSprintTasks("s1");
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe("task-1");
    });

    it("defaults to sprint:in_progress when no sprintId", async () => {
      const tasks: BeadRecord[] = [];
      setupExecFile(new Map([["list --label sprint:in_progress --json", makeBeadListJson(tasks)]]));

      const deps = makeDeps();
      const orch = new DispatchOrchestrator(deps);

      const result = await orch.readSprintTasks();
      expect(result).toEqual([]);
    });
  });

  describe("dispatchBatch", () => {
    it("dispatches tasks and returns summary", async () => {
      const task: BeadRecord = {
        id: "task-1",
        title: "Test Task",
        status: "open",
        labels: ["ready", "sprint-source:s1"],
      };

      setupExecFile(
        new Map([
          ["list --json", makeBeadListJson([task])],
          [
            "show task-1 --json",
            makeBeadJson({ ...task, labels: [...task.labels, "session:bridge-"] }),
          ],
        ]),
      );

      // After claim, show returns only one session label (no TOCTOU)
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb?: Function) => {
          const key = args.join(" ");
          let stdout = "";
          if (key.includes("list --json")) {
            stdout = makeBeadListJson([task]);
          } else if (key.includes("show")) {
            // Return task with exactly one session label (our claim)
            stdout = makeBeadJson({
              ...task,
              labels: ["ready", "sprint-source:s1", "session:bridge-mock"],
            });
          }
          if (cb) {
            cb(null, { stdout, stderr: "" });
          }
          return { stdout, stderr: "" };
        },
      );

      const deps = makeDeps();
      const orch = new DispatchOrchestrator(deps);
      orch.restoreOnce();

      const result = await orch.dispatchBatch([task], {});

      expect(result.dispatched).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
      expect(deps.callGateway).toHaveBeenCalled();

      // Verify idempotencyKey is present
      const callArgs = (deps.callGateway as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        params: Record<string, unknown>;
      };
      expect(callArgs.params).toHaveProperty("idempotencyKey");
    });

    it("collects errors per-task without aborting batch", async () => {
      const task1: BeadRecord = { id: "t1", title: "T1", status: "open", labels: ["ready"] };
      const task2: BeadRecord = { id: "t2", title: "T2", status: "open", labels: ["ready"] };

      // Make all br calls fail
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          const err = new Error("br failed");
          if (cb) {
            cb(err, { stdout: "", stderr: "" });
            return;
          }
          throw err;
        },
      );

      const deps = makeDeps();
      const orch = new DispatchOrchestrator(deps);
      orch.restoreOnce();

      const result = await orch.dispatchBatch([task1, task2], {});

      expect(result.errors).toHaveLength(2);
      expect(result.dispatched).toHaveLength(0);
    });
  });

  describe("getStatus", () => {
    it("returns zero counts initially", () => {
      const orch = new DispatchOrchestrator(makeDeps());
      const status = orch.getStatus();
      expect(status).toEqual({ active: 0, completed: 0, total: 0 });
    });
  });

  describe("duplicate event guard (M-1)", () => {
    it("ignores lifecycle event when record already completed", async () => {
      const task: BeadRecord = {
        id: "task-1",
        title: "Test Task",
        status: "open",
        labels: ["ready", "sprint-source:s1"],
      };

      // Wire execFile to succeed for all operations
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, cb?: Function) => {
          const key = args.join(" ");
          let stdout = "";
          if (key.includes("list --json")) {
            stdout = makeBeadListJson([task]);
          } else if (key.includes("show")) {
            stdout = makeBeadJson({
              ...task,
              labels: ["ready", "sprint-source:s1", "session:bridge-mock"],
            });
          } else if (key.includes("list --label sprint-source")) {
            stdout = makeBeadListJson([]);
          }
          if (cb) {
            cb(null, { stdout, stderr: "" });
          }
          return { stdout, stderr: "" };
        },
      );

      let lifecycleListener: ((evt: unknown) => void) | null = null;
      const deps = makeDeps({
        onAgentEvent: vi.fn().mockImplementation((listener: (evt: unknown) => void) => {
          lifecycleListener = listener;
          return () => {
            lifecycleListener = null;
          };
        }),
      });

      const orch = new DispatchOrchestrator(deps);
      orch.restoreOnce();

      // Dispatch a task
      await orch.dispatchBatch([task], {});
      const callCount1 = (deps.readLatestAssistantReply as ReturnType<typeof vi.fn>).mock.calls
        .length;

      // Fire first lifecycle end event
      lifecycleListener!({
        runId: "mock-run-id",
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      });
      await new Promise((r) => setTimeout(r, 50));

      const callCount2 = (deps.readLatestAssistantReply as ReturnType<typeof vi.fn>).mock.calls
        .length;
      // Should have processed (readLatestAssistantReply called)
      expect(callCount2).toBeGreaterThan(callCount1);

      // Fire duplicate lifecycle end event
      lifecycleListener!({
        runId: "mock-run-id",
        seq: 2,
        stream: "lifecycle",
        ts: Date.now(),
        data: { phase: "end" },
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should NOT process again (readLatestAssistantReply not called again)
      const callCount3 = (deps.readLatestAssistantReply as ReturnType<typeof vi.fn>).mock.calls
        .length;
      expect(callCount3).toBe(callCount2);
    });
  });

  describe("lifecycle listener", () => {
    it("registers listener on restoreOnce", () => {
      const deps = makeDeps();
      const orch = new DispatchOrchestrator(deps);
      orch.restoreOnce();

      expect(deps.onAgentEvent).toHaveBeenCalledTimes(1);
      expect(typeof (deps.onAgentEvent as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
        "function",
      );
    });
  });
});
