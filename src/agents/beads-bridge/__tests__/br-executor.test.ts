import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock child_process for BrExecutor
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
  execFileSync: vi.fn(),
}));

import { BrExecutor } from "../br-executor.js";

function setupExecFileResponse(stdout: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
      if (cb) {
        cb(null, { stdout, stderr: "" });
        return;
      }
      return { stdout, stderr: "" };
    },
  );
}

describe("BrExecutor output validation (M-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-array from listAll", async () => {
    setupExecFileResponse(JSON.stringify({ not: "an array" }));
    const br = new BrExecutor();
    await expect(br.listAll()).rejects.toThrow("expected array");
  });

  it("rejects array with missing id field", async () => {
    setupExecFileResponse(JSON.stringify([{ status: "open", labels: [] }]));
    const br = new BrExecutor();
    await expect(br.listAll()).rejects.toThrow("missing id or status");
  });

  it("rejects array with labels as string instead of array", async () => {
    setupExecFileResponse(JSON.stringify([{ id: "t1", status: "open", labels: "not-array" }]));
    const br = new BrExecutor();
    await expect(br.listAll()).rejects.toThrow("labels must be an array");
  });

  it("rejects non-object from get", async () => {
    setupExecFileResponse('"just a string"');
    const br = new BrExecutor();
    await expect(br.get("task-1")).rejects.toThrow("expected object");
  });

  it("rejects invalid JSON from exec", async () => {
    setupExecFileResponse("not json at all {{{");
    const br = new BrExecutor();
    await expect(br.listAll()).rejects.toThrow("Invalid br JSON output");
  });

  it("accepts valid bead records", async () => {
    const valid = [{ id: "t1", title: "T1", status: "open", labels: ["ready"] }];
    setupExecFileResponse(JSON.stringify(valid));
    const br = new BrExecutor();
    const result = await br.listAll();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });

  it("strips control characters from comment text (L-1)", async () => {
    setupExecFileResponse("");
    const br = new BrExecutor();
    await br.comment("task-1", "hello\x00\x07\x1bworld\ttab\nnewline");

    const args = mockExecFile.mock.calls[0][1] as string[];
    const commentText = args[2];
    expect(commentText).toBe("helloworld\ttab\nnewline");
    expect(commentText).not.toContain("\x00");
    expect(commentText).not.toContain("\x07");
    expect(commentText).not.toContain("\x1b");
  });
});
