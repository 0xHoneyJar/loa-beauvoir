/**
 * Tests for BeadsWALAdapter
 *
 * @module beads/__tests__/beads-wal-adapter
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { BeadsWALAdapter, type BeadWALEntry } from "../beads-wal-adapter.js";

// Mock WAL Manager
function createMockWALManager() {
  const entries: Array<{ operation: string; path: string; data: Buffer }> = [];
  let seq = 0;

  return {
    entries,
    async append(operation: string, path: string, data: Buffer): Promise<number> {
      entries.push({ operation, path, data });
      return ++seq;
    },
    async replay(
      callback: (entry: {
        operation: string;
        path: string;
        data?: string;
        seq: number;
      }) => Promise<void>,
    ): Promise<{ replayed: number; errors: number }> {
      let replayed = 0;
      for (const entry of entries) {
        await callback({
          operation: entry.operation,
          path: entry.path,
          data: entry.data.toString("base64"),
          seq: replayed + 1,
        });
        replayed++;
      }
      return { replayed, errors: 0 };
    },
    async getEntriesSince(
      sinceSeq: number,
    ): Promise<Array<{ operation: string; path: string; data: string; seq: number }>> {
      return entries.slice(sinceSeq).map((e, i) => ({
        operation: e.operation,
        path: e.path,
        data: e.data.toString("base64"),
        seq: sinceSeq + i + 1,
      }));
    },
    getStatus() {
      return { seq };
    },
  };
}

describe("BeadsWALAdapter", () => {
  let mockWAL: ReturnType<typeof createMockWALManager>;
  let adapter: BeadsWALAdapter;

  beforeEach(() => {
    mockWAL = createMockWALManager();
    adapter = new BeadsWALAdapter(mockWAL as any);
  });

  describe("recordTransition", () => {
    it("should record a create operation with checksum", async () => {
      const seq = await adapter.recordTransition({
        operation: "create",
        beadId: "bead-123",
        payload: { title: "Test Task", type: "task", priority: 2 },
      });

      expect(seq).toBe(1);
      expect(mockWAL.entries).toHaveLength(1);

      const entry = JSON.parse(mockWAL.entries[0].data.toString()) as BeadWALEntry;
      expect(entry.operation).toBe("create");
      expect(entry.beadId).toBe("bead-123");
      expect(entry.payload).toEqual({
        title: "Test Task",
        type: "task",
        priority: 2,
      });
      expect(entry.checksum).toHaveLength(16);
      expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("should record different operation types", async () => {
      await adapter.recordTransition({
        operation: "create",
        beadId: "bead-1",
        payload: { title: "Task 1" },
      });

      await adapter.recordTransition({
        operation: "update",
        beadId: "bead-1",
        payload: { title: "Updated Task 1" },
      });

      await adapter.recordTransition({
        operation: "label",
        beadId: "bead-1",
        payload: { action: "add", labels: ["bug"] },
      });

      await adapter.recordTransition({
        operation: "close",
        beadId: "bead-1",
        payload: { reason: "done" },
      });

      expect(mockWAL.entries).toHaveLength(4);

      const operations = mockWAL.entries.map((e) => JSON.parse(e.data.toString()).operation);
      expect(operations).toEqual(["create", "update", "label", "close"]);
    });

    it("should use custom path prefix", async () => {
      const customAdapter = new BeadsWALAdapter(mockWAL as any, {
        pathPrefix: "custom/beads",
      });

      await customAdapter.recordTransition({
        operation: "create",
        beadId: "bead-123",
        payload: { title: "Test" },
      });

      expect(mockWAL.entries[0].path).toContain("custom/beads/bead-123/");
    });
  });

  describe("replay", () => {
    it("should replay entries in timestamp order", async () => {
      // Record entries with slight delays to ensure different timestamps
      await adapter.recordTransition({
        operation: "create",
        beadId: "bead-1",
        payload: { title: "First" },
      });

      await new Promise((r) => setTimeout(r, 10));

      await adapter.recordTransition({
        operation: "update",
        beadId: "bead-1",
        payload: { title: "Second" },
      });

      const entries = await adapter.replay();

      expect(entries).toHaveLength(2);
      expect(entries[0].operation).toBe("create");
      expect(entries[1].operation).toBe("update");

      // Verify timestamp ordering
      expect(new Date(entries[0].timestamp).getTime()).toBeLessThan(
        new Date(entries[1].timestamp).getTime(),
      );
    });

    it("should verify checksums and skip invalid entries", async () => {
      // Record a valid entry
      await adapter.recordTransition({
        operation: "create",
        beadId: "bead-1",
        payload: { title: "Valid" },
      });

      // Manually add an invalid entry with wrong checksum
      const invalidEntry: BeadWALEntry = {
        id: "invalid-id",
        timestamp: new Date().toISOString(),
        operation: "create",
        beadId: "bead-2",
        payload: { title: "Invalid" },
        checksum: "wrongchecksum1234",
      };
      mockWAL.entries.push({
        operation: "write",
        path: ".beads/wal/bead-2/invalid.json",
        data: Buffer.from(JSON.stringify(invalidEntry)),
      });

      // Suppress console.warn during test
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const entries = await adapter.replay();

      expect(entries).toHaveLength(1);
      expect(entries[0].beadId).toBe("bead-1");
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("checksum mismatch"));

      warnSpy.mockRestore();
    });

    it("should handle empty WAL", async () => {
      const entries = await adapter.replay();
      expect(entries).toHaveLength(0);
    });
  });

  describe("getTransitionsSince", () => {
    it("should return entries since sequence number", async () => {
      await adapter.recordTransition({
        operation: "create",
        beadId: "bead-1",
        payload: { title: "First" },
      });

      await adapter.recordTransition({
        operation: "create",
        beadId: "bead-2",
        payload: { title: "Second" },
      });

      await adapter.recordTransition({
        operation: "create",
        beadId: "bead-3",
        payload: { title: "Third" },
      });

      const entries = await adapter.getTransitionsSince(1);

      expect(entries).toHaveLength(2);
      expect(entries[0].beadId).toBe("bead-2");
      expect(entries[1].beadId).toBe("bead-3");
    });
  });

  describe("getCurrentSeq", () => {
    it("should return current WAL sequence", async () => {
      expect(adapter.getCurrentSeq()).toBe(0);

      await adapter.recordTransition({
        operation: "create",
        beadId: "bead-1",
        payload: {},
      });

      expect(adapter.getCurrentSeq()).toBe(1);

      await adapter.recordTransition({
        operation: "update",
        beadId: "bead-1",
        payload: {},
      });

      expect(adapter.getCurrentSeq()).toBe(2);
    });
  });

  describe("verbose logging", () => {
    it("should log when verbose is enabled", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const verboseAdapter = new BeadsWALAdapter(mockWAL as any, {
        verbose: true,
      });

      await verboseAdapter.recordTransition({
        operation: "create",
        beadId: "bead-1",
        payload: {},
      });

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[beads-wal] recorded create for bead-1"),
      );

      logSpy.mockRestore();
    });
  });
});
