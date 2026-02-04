/**
 * Tests for BeadsRecoveryHandler
 *
 * @module beads/__tests__/beads-recovery
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { BeadsWALAdapter, BeadWALEntry } from "../beads-wal-adapter.js";
import { BeadsRecoveryHandler } from "../beads-recovery.js";

// Mock child_process
vi.mock("child_process", () => ({
  exec: vi.fn((cmd, opts, callback) => {
    if (typeof opts === "function") {
      callback = opts;
    }
    // Simulate successful execution
    callback(null, { stdout: "", stderr: "" });
  }),
}));

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({
    mtime: new Date(Date.now() - 60000), // 1 minute ago
  })),
}));

function createMockWALAdapter(entries: BeadWALEntry[] = []): BeadsWALAdapter {
  return {
    replay: vi.fn().mockResolvedValue(entries),
    recordTransition: vi.fn().mockResolvedValue(1),
    getTransitionsSince: vi.fn().mockResolvedValue([]),
    getCurrentSeq: vi.fn().mockReturnValue(0),
  } as unknown as BeadsWALAdapter;
}

describe("BeadsRecoveryHandler", () => {
  let mockAdapter: BeadsWALAdapter;
  let handler: BeadsRecoveryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("needsRecovery", () => {
    it("should return false when WAL is empty", async () => {
      mockAdapter = createMockWALAdapter([]);
      handler = new BeadsRecoveryHandler(mockAdapter);

      const result = await handler.needsRecovery();
      expect(result).toBe(false);
    });

    it("should return true when WAL has newer entries than SQLite", async () => {
      const recentEntry: BeadWALEntry = {
        id: "entry-1",
        timestamp: new Date().toISOString(), // Now (newer than mocked mtime)
        operation: "create",
        beadId: "bead-1",
        payload: { title: "Test" },
        checksum: "1234567890123456",
      };

      mockAdapter = createMockWALAdapter([recentEntry]);
      handler = new BeadsRecoveryHandler(mockAdapter);

      const result = await handler.needsRecovery();
      expect(result).toBe(true);
    });

    it("should return false when SQLite is newer than WAL", async () => {
      const oldEntry: BeadWALEntry = {
        id: "entry-1",
        timestamp: new Date(Date.now() - 120000).toISOString(), // 2 minutes ago
        operation: "create",
        beadId: "bead-1",
        payload: { title: "Test" },
        checksum: "1234567890123456",
      };

      mockAdapter = createMockWALAdapter([oldEntry]);
      handler = new BeadsRecoveryHandler(mockAdapter);

      const result = await handler.needsRecovery();
      expect(result).toBe(false);
    });
  });

  describe("recover", () => {
    it("should return success with 0 entries when WAL is empty", async () => {
      mockAdapter = createMockWALAdapter([]);
      handler = new BeadsRecoveryHandler(mockAdapter, { skipSync: true });

      const result = await handler.recover();

      expect(result.success).toBe(true);
      expect(result.entriesReplayed).toBe(0);
      expect(result.beadsAffected).toHaveLength(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should replay create operations", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      const entries: BeadWALEntry[] = [
        {
          id: "entry-1",
          timestamp: new Date().toISOString(),
          operation: "create",
          beadId: "bead-1",
          payload: { title: "New Task", type: "task", priority: 2 },
          checksum: "1234567890123456",
        },
      ];

      mockAdapter = createMockWALAdapter(entries);
      handler = new BeadsRecoveryHandler(mockAdapter, { skipSync: true });

      const result = await handler.recover();

      expect(result.success).toBe(true);
      expect(result.entriesReplayed).toBe(1);
      expect(result.beadsAffected).toContain("bead-1");

      // Verify br command was called
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining("br create"),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should replay close operations", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      const entries: BeadWALEntry[] = [
        {
          id: "entry-1",
          timestamp: new Date().toISOString(),
          operation: "close",
          beadId: "bead-1",
          payload: { reason: "completed" },
          checksum: "1234567890123456",
        },
      ];

      mockAdapter = createMockWALAdapter(entries);
      handler = new BeadsRecoveryHandler(mockAdapter, { skipSync: true });

      const result = await handler.recover();

      expect(result.success).toBe(true);
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining("br close bead-1"),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should replay label operations", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      const entries: BeadWALEntry[] = [
        {
          id: "entry-1",
          timestamp: new Date().toISOString(),
          operation: "label",
          beadId: "bead-1",
          payload: { action: "add", labels: ["bug", "high-priority"] },
          checksum: "1234567890123456",
        },
      ];

      mockAdapter = createMockWALAdapter(entries);
      handler = new BeadsRecoveryHandler(mockAdapter, { skipSync: true });

      const result = await handler.recover();

      expect(result.success).toBe(true);
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining("br label add bead-1"),
        expect.anything(),
        expect.anything(),
      );
    });

    it("should group entries by bead for efficient replay", async () => {
      const entries: BeadWALEntry[] = [
        {
          id: "entry-1",
          timestamp: new Date(Date.now() - 2000).toISOString(),
          operation: "create",
          beadId: "bead-1",
          payload: { title: "Task 1" },
          checksum: "1234567890123456",
        },
        {
          id: "entry-2",
          timestamp: new Date(Date.now() - 1000).toISOString(),
          operation: "create",
          beadId: "bead-2",
          payload: { title: "Task 2" },
          checksum: "1234567890123456",
        },
        {
          id: "entry-3",
          timestamp: new Date().toISOString(),
          operation: "update",
          beadId: "bead-1",
          payload: { title: "Updated Task 1" },
          checksum: "1234567890123456",
        },
      ];

      mockAdapter = createMockWALAdapter(entries);
      handler = new BeadsRecoveryHandler(mockAdapter, { skipSync: true });

      const result = await handler.recover();

      expect(result.success).toBe(true);
      expect(result.entriesReplayed).toBe(3);
      expect(result.beadsAffected).toContain("bead-1");
      expect(result.beadsAffected).toContain("bead-2");
    });

    it("should continue on individual bead failure", async () => {
      const { exec } = await import("child_process");
      const execMock = vi.mocked(exec);

      // Make first call fail, second succeed
      let callCount = 0;
      execMock.mockImplementation((cmd, opts, callback) => {
        callCount++;
        if (typeof opts === "function") {
          callback = opts;
        }
        if (callCount === 1) {
          callback(new Error("Command failed"), { stdout: "", stderr: "error" });
        } else {
          callback(null, { stdout: "", stderr: "" });
        }
        return {} as any;
      });

      const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const entries: BeadWALEntry[] = [
        {
          id: "entry-1",
          timestamp: new Date().toISOString(),
          operation: "create",
          beadId: "bead-1",
          payload: { title: "Task 1" },
          checksum: "1234567890123456",
        },
        {
          id: "entry-2",
          timestamp: new Date().toISOString(),
          operation: "create",
          beadId: "bead-2",
          payload: { title: "Task 2" },
          checksum: "1234567890123456",
        },
      ];

      mockAdapter = createMockWALAdapter(entries);
      handler = new BeadsRecoveryHandler(mockAdapter, { skipSync: true });

      const result = await handler.recover();

      // Should still succeed overall but only affect one bead
      expect(result.success).toBe(true);
      expect(result.beadsAffected).toContain("bead-2");

      warnSpy.mockRestore();
    });
  });
});
