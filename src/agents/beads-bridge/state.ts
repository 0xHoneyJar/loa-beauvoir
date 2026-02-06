/**
 * BridgeState — dispatch tracking with atomic JSON persistence.
 *
 * Follows the Map + sweeper pattern from subagent-registry.ts.
 * Uses loadJsonFile/saveJsonFile for atomic writes.
 */

import os from "node:os";
import path from "node:path";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";

// -- Types --------------------------------------------------------------------

export interface DispatchRecord {
  beadId: string;
  runId: string;
  childSessionKey: string;
  sprintId: string;
  dispatchedAt: number;
  completedAt?: number;
  outcome?: "success" | "error" | "timeout";
  resultSummary?: string;
}

interface PersistedBridgeState {
  version: 1;
  dispatches: Record<string, DispatchRecord>;
}

// -- Constants ----------------------------------------------------------------

const STATE_DIR = path.join(os.homedir(), ".openclaw", "state", "beads-bridge");
const STATE_PATH = path.join(STATE_DIR, "dispatches.json");
const SWEEP_INTERVAL_MS = 60_000;
const ARCHIVE_AFTER_MS = 60 * 60_000; // 60 minutes

// -- BridgeState class --------------------------------------------------------

export class BridgeState {
  private dispatches = new Map<string, DispatchRecord>();
  private sweeper: NodeJS.Timeout | null = null;

  // -- Accessors --------------------------------------------------------------

  set(record: DispatchRecord): void {
    this.dispatches.set(record.runId, record);
    this.persistToDisk();
  }

  getByRunId(runId: string): DispatchRecord | undefined {
    return this.dispatches.get(runId);
  }

  getByBeadId(beadId: string): DispatchRecord | undefined {
    for (const record of this.dispatches.values()) {
      if (record.beadId === beadId) return record;
    }
    return undefined;
  }

  getActive(): DispatchRecord[] {
    return [...this.dispatches.values()].filter((r) => !r.completedAt);
  }

  getCompleted(): DispatchRecord[] {
    return [...this.dispatches.values()].filter((r) => r.completedAt);
  }

  get size(): number {
    return this.dispatches.size;
  }

  // -- Persistence ------------------------------------------------------------

  loadFromDisk(): void {
    const raw = loadJsonFile(STATE_PATH);
    if (!raw || typeof raw !== "object") return;

    const data = raw as PersistedBridgeState;
    if (data.version !== 1 || !data.dispatches) return;

    this.dispatches.clear();
    for (const [key, record] of Object.entries(data.dispatches)) {
      if (record && typeof record === "object" && record.runId && record.beadId) {
        this.dispatches.set(key, record);
      }
    }
  }

  private persistToDisk(): void {
    const data: PersistedBridgeState = {
      version: 1,
      dispatches: Object.fromEntries(this.dispatches),
    };
    saveJsonFile(STATE_PATH, data);
  }

  // -- Sweeper ----------------------------------------------------------------

  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private sweep(): void {
    const now = Date.now();
    let mutated = false;
    for (const [runId, record] of this.dispatches.entries()) {
      if (!record.completedAt) continue;
      if (now - record.completedAt > ARCHIVE_AFTER_MS) {
        this.dispatches.delete(runId);
        mutated = true;
      }
    }
    if (mutated) this.persistToDisk();
    if (this.dispatches.size === 0) this.stopSweeper();
  }
}
