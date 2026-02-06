import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeState, type DispatchRecord } from "../state.js";

// Mock json-file to avoid real filesystem
vi.mock("../../../infra/json-file.js", () => ({
  loadJsonFile: vi.fn(() => undefined),
  saveJsonFile: vi.fn(),
}));

import { loadJsonFile, saveJsonFile } from "../../../infra/json-file.js";

const mockLoad = vi.mocked(loadJsonFile);
const mockSave = vi.mocked(saveJsonFile);

function makeRecord(runId: string, overrides?: Partial<DispatchRecord>): DispatchRecord {
  return {
    beadId: `bead-${runId}`,
    runId,
    childSessionKey: `agent:default:subagent:${runId}`,
    sprintId: "sprint-1",
    dispatchedAt: Date.now(),
    ...overrides,
  };
}

describe("BridgeState", () => {
  let state: BridgeState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = new BridgeState();
  });

  afterEach(() => {
    state.stopSweeper();
  });

  it("stores and retrieves records by runId", () => {
    const record = makeRecord("run-1");
    state.set(record);
    expect(state.getByRunId("run-1")).toEqual(record);
  });

  it("retrieves records by beadId", () => {
    const record = makeRecord("run-1");
    state.set(record);
    expect(state.getByBeadId("bead-run-1")).toEqual(record);
  });

  it("returns undefined for unknown IDs", () => {
    expect(state.getByRunId("unknown")).toBeUndefined();
    expect(state.getByBeadId("unknown")).toBeUndefined();
  });

  it("tracks active vs completed records", () => {
    state.set(makeRecord("active-1"));
    state.set(makeRecord("done-1", { completedAt: Date.now(), outcome: "success" }));

    expect(state.getActive()).toHaveLength(1);
    expect(state.getCompleted()).toHaveLength(1);
    expect(state.size).toBe(2);
  });

  it("persists to disk on every set()", () => {
    state.set(makeRecord("run-1"));
    expect(mockSave).toHaveBeenCalledTimes(1);
    const saved = mockSave.mock.calls[0][1] as {
      version: number;
      dispatches: Record<string, unknown>;
    };
    expect(saved.version).toBe(1);
    expect(saved.dispatches["run-1"]).toBeDefined();
  });

  it("restores from disk on loadFromDisk()", () => {
    const record = makeRecord("run-1");
    mockLoad.mockReturnValue({
      version: 1,
      dispatches: { "run-1": record },
    });

    state.loadFromDisk();
    expect(state.getByRunId("run-1")).toEqual(record);
  });

  it("handles corrupt file gracefully (starts fresh)", () => {
    mockLoad.mockReturnValue("not an object");
    state.loadFromDisk();
    expect(state.size).toBe(0);
  });

  it("handles wrong version gracefully", () => {
    mockLoad.mockReturnValue({ version: 99, dispatches: {} });
    state.loadFromDisk();
    expect(state.size).toBe(0);
  });

  it("handles missing file gracefully", () => {
    mockLoad.mockReturnValue(undefined);
    state.loadFromDisk();
    expect(state.size).toBe(0);
  });

  it("sweeper archives completed records older than 60 min", () => {
    vi.useFakeTimers();
    try {
      const old = makeRecord("old", {
        completedAt: Date.now() - 61 * 60_000,
        outcome: "success",
      });
      const fresh = makeRecord("fresh", {
        completedAt: Date.now(),
        outcome: "success",
      });
      state.set(old);
      state.set(fresh);
      vi.clearAllMocks();

      state.startSweeper();
      vi.advanceTimersByTime(61_000); // trigger sweep

      expect(state.getByRunId("old")).toBeUndefined();
      expect(state.getByRunId("fresh")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeper self-stops when map is empty", () => {
    vi.useFakeTimers();
    try {
      const record = makeRecord("done", {
        completedAt: Date.now() - 61 * 60_000,
        outcome: "success",
      });
      state.set(record);
      vi.clearAllMocks();

      state.startSweeper();
      vi.advanceTimersByTime(61_000);

      // All records swept → sweeper should stop
      expect(state.size).toBe(0);
      // No additional persist calls after the sweep
      const callCount = mockSave.mock.calls.length;
      vi.advanceTimersByTime(120_000);
      expect(mockSave.mock.calls.length).toBe(callCount);
    } finally {
      vi.useRealTimers();
    }
  });
});
