import { describe, expect, it, vi } from "vitest";
import type { BrExecutor, BeadRecord } from "../br-executor.js";
import type { DispatchRecord } from "../state.js";
import { CompletionHandler } from "../completion-handler.js";

function makeMockBr() {
  return {
    labelAdd: vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined),
    labelRemove: vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn<[string], Promise<void>>().mockResolvedValue(undefined),
    comment: vi.fn<[string, string], Promise<void>>().mockResolvedValue(undefined),
    listByLabel: vi.fn<[string], Promise<BeadRecord[]>>().mockResolvedValue([]),
    listAll: vi.fn<[], Promise<BeadRecord[]>>().mockResolvedValue([]),
    get: vi.fn<[string], Promise<BeadRecord>>(),
    exec: vi.fn(),
    execRaw: vi.fn(),
  } as unknown as BrExecutor;
}

function makeRecord(overrides?: Partial<DispatchRecord>): DispatchRecord {
  return {
    beadId: "task-1",
    runId: "run-abc",
    childSessionKey: "agent:default:subagent:uuid-123",
    sprintId: "sprint-1",
    dispatchedAt: Date.now(),
    ...overrides,
  };
}

describe("CompletionHandler", () => {
  describe("onSuccess", () => {
    it("reads reply, removes session label, adds done, closes bead", async () => {
      const br = makeMockBr();
      const readReply = vi.fn().mockResolvedValue("Task completed successfully");
      const handler = new CompletionHandler(br, { readLatestAssistantReply: readReply });
      const record = makeRecord();

      await handler.onSuccess(record);

      expect(readReply).toHaveBeenCalledWith({ sessionKey: "agent:default:subagent:uuid-123" });
      expect(record.resultSummary).toBe("Task completed successfully");
      expect(br.labelRemove).toHaveBeenCalledWith("task-1", "session:bridge-uuid-123");
      expect(br.labelAdd).toHaveBeenCalledWith("task-1", "done");
      expect(br.close).toHaveBeenCalledWith("task-1");
    });

    it("truncates result summary to 500 chars", async () => {
      const br = makeMockBr();
      const longReply = "x".repeat(1000);
      const readReply = vi.fn().mockResolvedValue(longReply);
      const handler = new CompletionHandler(br, { readLatestAssistantReply: readReply });
      const record = makeRecord();

      await handler.onSuccess(record);

      expect(record.resultSummary).toHaveLength(500);
    });

    it("handles readReply failure gracefully", async () => {
      const br = makeMockBr();
      const readReply = vi.fn().mockRejectedValue(new Error("network error"));
      const handler = new CompletionHandler(br, { readLatestAssistantReply: readReply });
      const record = makeRecord();

      await handler.onSuccess(record);

      expect(record.resultSummary).toBeUndefined();
      expect(br.labelAdd).toHaveBeenCalledWith("task-1", "done");
    });
  });

  describe("onFailure", () => {
    it("removes session label, adds ready + circuit-breaker, adds comment", async () => {
      const br = makeMockBr();
      const handler = new CompletionHandler(br, { readLatestAssistantReply: vi.fn() });
      const record = makeRecord();

      await handler.onFailure(record, "timeout");

      expect(br.labelRemove).toHaveBeenCalledWith("task-1", "session:bridge-uuid-123");
      expect(br.labelAdd).toHaveBeenCalledWith("task-1", "ready");
      expect(br.labelAdd).toHaveBeenCalledWith("task-1", "circuit-breaker");
      expect(br.comment).toHaveBeenCalledWith("task-1", "Circuit breaker: timeout");
    });

    it("truncates long failure reason", async () => {
      const br = makeMockBr();
      const handler = new CompletionHandler(br, { readLatestAssistantReply: vi.fn() });
      const record = makeRecord();
      const longReason = "x".repeat(2000);

      await handler.onFailure(record, longReason);

      const commentText = (br.comment as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(commentText.length).toBeLessThanOrEqual(900 + "Circuit breaker: ".length);
    });
  });

  describe("cascadeUnblocks", () => {
    it("unblocks tasks with all deps closed", async () => {
      const br = makeMockBr();
      const tasks: BeadRecord[] = [
        { id: "a", title: "A", status: "closed", labels: ["done"] },
        { id: "b", title: "B", status: "closed", labels: ["done"] },
        { id: "c", title: "C", status: "open", labels: ["blocked"], depends_on: ["a", "b"] },
      ];
      vi.mocked(br.listByLabel).mockResolvedValue(tasks);
      const handler = new CompletionHandler(br, { readLatestAssistantReply: vi.fn() });

      const unblocked = await handler.cascadeUnblocks("sprint-1");

      expect(unblocked).toEqual(["c"]);
      expect(br.labelRemove).toHaveBeenCalledWith("c", "blocked");
      expect(br.labelAdd).toHaveBeenCalledWith("c", "ready");
    });

    it("does not unblock tasks with open deps", async () => {
      const br = makeMockBr();
      const tasks: BeadRecord[] = [
        { id: "a", title: "A", status: "closed", labels: ["done"] },
        { id: "b", title: "B", status: "open", labels: ["ready"] },
        { id: "c", title: "C", status: "open", labels: ["blocked"], depends_on: ["a", "b"] },
      ];
      vi.mocked(br.listByLabel).mockResolvedValue(tasks);
      const handler = new CompletionHandler(br, { readLatestAssistantReply: vi.fn() });

      const unblocked = await handler.cascadeUnblocks("sprint-1");

      expect(unblocked).toEqual([]);
    });

    it("cascade errors are non-fatal", async () => {
      const br = makeMockBr();
      const tasks: BeadRecord[] = [
        { id: "a", title: "A", status: "closed", labels: ["done"] },
        { id: "c", title: "C", status: "open", labels: ["blocked"], depends_on: ["a"] },
      ];
      vi.mocked(br.listByLabel).mockResolvedValue(tasks);
      vi.mocked(br.labelRemove).mockRejectedValue(new Error("br error"));
      const handler = new CompletionHandler(br, { readLatestAssistantReply: vi.fn() });

      // Should not throw
      const unblocked = await handler.cascadeUnblocks("sprint-1");
      expect(unblocked).toEqual([]);
    });

    it("returns empty array when sprint query fails", async () => {
      const br = makeMockBr();
      vi.mocked(br.listByLabel).mockRejectedValue(new Error("network"));
      const handler = new CompletionHandler(br, { readLatestAssistantReply: vi.fn() });

      const unblocked = await handler.cascadeUnblocks("sprint-1");
      expect(unblocked).toEqual([]);
    });

    it("does not unblock when dep is missing from sprint query (H-1)", async () => {
      const br = makeMockBr();
      // Task C depends on "external-dep" which is NOT in the sprint query results
      const tasks: BeadRecord[] = [
        { id: "a", title: "A", status: "closed", labels: ["done"] },
        {
          id: "c",
          title: "C",
          status: "open",
          labels: ["blocked"],
          depends_on: ["a", "external-dep"],
        },
      ];
      vi.mocked(br.listByLabel).mockResolvedValue(tasks);
      const handler = new CompletionHandler(br, { readLatestAssistantReply: vi.fn() });

      const unblocked = await handler.cascadeUnblocks("sprint-1");

      // Should NOT unblock because external-dep is missing (treated as not closed)
      expect(unblocked).toEqual([]);
    });

    it("unblocks tasks with empty depends_on", async () => {
      const br = makeMockBr();
      const tasks: BeadRecord[] = [
        { id: "c", title: "C", status: "open", labels: ["blocked"], depends_on: [] },
      ];
      vi.mocked(br.listByLabel).mockResolvedValue(tasks);
      const handler = new CompletionHandler(br, { readLatestAssistantReply: vi.fn() });

      const unblocked = await handler.cascadeUnblocks("sprint-1");
      expect(unblocked).toEqual(["c"]);
    });
  });
});
