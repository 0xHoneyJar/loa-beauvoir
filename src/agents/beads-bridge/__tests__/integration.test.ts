/**
 * Integration test — full dispatch→complete→cascade→re-dispatch cycle.
 *
 * 3-task sprint: A (no deps), B (no deps), C (depends on A+B).
 * Dispatch A+B in batch 1. Fire synthetic lifecycle "end" events.
 * Verify C is unblocked. Dispatch C in batch 2.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock child_process for BrExecutor
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: vi.fn(),
}));

// Mock json-file for state persistence
vi.mock("../../../infra/json-file.js", () => ({
  loadJsonFile: vi.fn(() => undefined),
  saveJsonFile: vi.fn(),
}));

import type { AgentEventPayload } from "../../../infra/agent-events.js";
import type { BeadRecord } from "../br-executor.js";
import { DispatchOrchestrator, type OrchestratorDeps } from "../orchestrator.js";

// -- Helpers ------------------------------------------------------------------

/** In-memory bead database to simulate br CLI. */
class MockBeadDb {
  beads: Map<string, BeadRecord>;

  constructor(beads: BeadRecord[]) {
    this.beads = new Map(beads.map((b) => [b.id, { ...b }]));
  }

  get(id: string): BeadRecord {
    const b = this.beads.get(id);
    if (!b) throw new Error(`Bead not found: ${id}`);
    return { ...b };
  }

  listAll(): BeadRecord[] {
    return [...this.beads.values()].map((b) => ({ ...b }));
  }

  listByLabel(label: string): BeadRecord[] {
    return this.listAll().filter((b) => b.labels.includes(label));
  }

  addLabel(id: string, label: string): void {
    const b = this.beads.get(id);
    if (b && !b.labels.includes(label)) b.labels.push(label);
  }

  removeLabel(id: string, label: string): void {
    const b = this.beads.get(id);
    if (b) b.labels = b.labels.filter((l) => l !== label);
  }

  close(id: string): void {
    const b = this.beads.get(id);
    if (b) b.status = "closed";
  }
}

function wireExecFile(db: MockBeadDb) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb?: Function) => {
    let stdout = "";
    const joined = args.join(" ");

    if (joined.startsWith("list") && joined.includes("--json")) {
      if (joined.includes("--label")) {
        const label = args[args.indexOf("--label") + 1];
        stdout = JSON.stringify(db.listByLabel(label));
      } else {
        stdout = JSON.stringify(db.listAll());
      }
    } else if (joined.startsWith("show")) {
      const id = args[1];
      stdout = JSON.stringify(db.get(id));
    } else if (joined.startsWith("label add")) {
      db.addLabel(args[2], args[3]);
    } else if (joined.startsWith("label remove")) {
      db.removeLabel(args[2], args[3]);
    } else if (joined.startsWith("close")) {
      db.close(args[1]);
    } else if (joined.startsWith("comment")) {
      // no-op
    }

    if (cb) {
      cb(null, { stdout, stderr: "" });
    }
    return { stdout, stderr: "" };
  });
}

describe("beads-bridge integration", () => {
  let lifecycleListener: ((evt: AgentEventPayload) => void) | null;
  let runIdCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleListener = null;
    runIdCounter = 0;
  });

  it("full cycle: dispatch → complete → cascade → re-dispatch", async () => {
    // -- Setup: 3-task sprint with dependency graph -------------------------
    const db = new MockBeadDb([
      {
        id: "task-a",
        title: "Task A",
        status: "open",
        labels: ["ready", "sprint-source:s1", "sprint:in_progress"],
      },
      {
        id: "task-b",
        title: "Task B",
        status: "open",
        labels: ["ready", "sprint-source:s1", "sprint:in_progress"],
      },
      {
        id: "task-c",
        title: "Task C",
        status: "open",
        labels: ["blocked", "sprint-source:s1", "sprint:in_progress"],
        depends_on: ["task-a", "task-b"],
      },
    ]);

    wireExecFile(db);

    // -- Setup: deps with captured lifecycle listener ----------------------
    const deps: OrchestratorDeps = {
      callGateway: vi.fn().mockImplementation(() => {
        runIdCounter++;
        return Promise.resolve({ runId: `run-${runIdCounter}` });
      }),
      onAgentEvent: vi.fn().mockImplementation((listener: (evt: AgentEventPayload) => void) => {
        lifecycleListener = listener;
        return () => {
          lifecycleListener = null;
        };
      }),
      readLatestAssistantReply: vi.fn().mockResolvedValue("Task completed"),
    };

    const orch = new DispatchOrchestrator(deps);
    orch.restoreOnce();

    // -- Wave 1: Dispatch A and B ----------------------------------------
    const tasksWave1 = await orch.readSprintTasks();
    const ready1 = tasksWave1.filter((t) => t.labels.includes("ready"));
    expect(ready1).toHaveLength(2);

    const result1 = await orch.dispatchBatch(ready1, {});
    expect(result1.dispatched).toHaveLength(2);
    expect(result1.errors).toHaveLength(0);
    expect(orch.getActiveCount()).toBe(2);

    // Verify A and B are claimed (session label added, ready removed)
    const aAfterDispatch = db.get("task-a");
    expect(aAfterDispatch.labels.some((l) => l.startsWith("session:bridge-"))).toBe(true);
    expect(aAfterDispatch.labels.includes("ready")).toBe(false);

    // C should still be blocked
    const cMid = db.get("task-c");
    expect(cMid.labels.includes("blocked")).toBe(true);

    // -- Fire lifecycle "end" events for A and B -------------------------
    expect(lifecycleListener).not.toBeNull();

    // Complete task A
    lifecycleListener!({
      runId: "run-1",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    // Let async completion handler run
    await new Promise((r) => setTimeout(r, 50));

    // A should be closed with "done"
    const aAfterComplete = db.get("task-a");
    expect(aAfterComplete.status).toBe("closed");
    expect(aAfterComplete.labels.includes("done")).toBe(true);

    // C still blocked (B not done yet)
    const cStillBlocked = db.get("task-c");
    expect(cStillBlocked.labels.includes("blocked")).toBe(true);

    // Complete task B
    lifecycleListener!({
      runId: "run-2",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    await new Promise((r) => setTimeout(r, 50));

    // B should be closed with "done"
    const bAfterComplete = db.get("task-b");
    expect(bAfterComplete.status).toBe("closed");
    expect(bAfterComplete.labels.includes("done")).toBe(true);

    // -- Verify C is unblocked (cascade) ---------------------------------
    const cUnblocked = db.get("task-c");
    expect(cUnblocked.labels.includes("blocked")).toBe(false);
    expect(cUnblocked.labels.includes("ready")).toBe(true);

    // -- Wave 2: Dispatch C ----------------------------------------------
    const tasksWave2 = await orch.readSprintTasks();
    const ready2 = tasksWave2.filter((t) => t.labels.includes("ready"));
    expect(ready2).toHaveLength(1);
    expect(ready2[0].id).toBe("task-c");

    const result2 = await orch.dispatchBatch(ready2, {});
    expect(result2.dispatched).toHaveLength(1);
    expect(result2.dispatched[0].beadId).toBe("task-c");

    // All 3 tasks dispatched across 2 waves
    expect(deps.callGateway).toHaveBeenCalledTimes(3);
  });
});
