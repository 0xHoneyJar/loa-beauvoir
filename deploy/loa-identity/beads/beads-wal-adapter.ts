/**
 * Beads WAL Adapter
 *
 * Records beads state transitions to the Write-Ahead Log for crash recovery.
 * Integrates with OpenClaw's SegmentedWALManager for persistence.
 *
 * @module beads-wal-adapter
 */

import { createHash, randomUUID } from "crypto";
import type { SegmentedWALManager, WALEntry } from "../wal/wal-manager.js";

/**
 * Operation types that can be recorded in WAL
 */
export type BeadOperation = "create" | "update" | "close" | "reopen" | "label" | "comment" | "dep";

/**
 * WAL entry for a beads state transition
 */
export interface BeadWALEntry {
  /** Unique entry ID */
  id: string;
  /** Timestamp of operation (ISO 8601) */
  timestamp: string;
  /** Operation type */
  operation: BeadOperation;
  /** Bead ID affected */
  beadId: string;
  /** Operation payload (varies by operation) */
  payload: Record<string, unknown>;
  /** SHA-256 checksum of payload (truncated to 16 chars) */
  checksum: string;
}

/**
 * Configuration for BeadsWALAdapter
 */
export interface BeadsWALConfig {
  /** WAL path prefix for beads entries (default: ".beads/wal") */
  pathPrefix?: string;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

/**
 * Adapter between beads_rust operations and OpenClaw WAL
 *
 * Provides crash-resilient persistence for beads state transitions
 * by recording operations to WAL before they're committed to SQLite.
 */
export class BeadsWALAdapter {
  private readonly wal: SegmentedWALManager;
  private readonly pathPrefix: string;
  private readonly verbose: boolean;

  constructor(wal: SegmentedWALManager, config?: BeadsWALConfig) {
    this.wal = wal;
    this.pathPrefix = config?.pathPrefix ?? ".beads/wal";
    this.verbose = config?.verbose ?? false;
  }

  /**
   * Record a beads transition to WAL
   *
   * @param entry - Partial entry (id, timestamp, checksum will be generated)
   * @returns WAL sequence number
   */
  async recordTransition(
    entry: Omit<BeadWALEntry, "id" | "timestamp" | "checksum">,
  ): Promise<number> {
    const fullEntry: BeadWALEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      checksum: this.computeChecksum(entry.payload),
    };

    const seq = await this.wal.append(
      "write",
      `${this.pathPrefix}/${entry.beadId}/${fullEntry.id}.json`,
      Buffer.from(JSON.stringify(fullEntry)),
    );

    if (this.verbose) {
      console.log(`[beads-wal] recorded ${entry.operation} for ${entry.beadId} (seq=${seq})`);
    }

    return seq;
  }

  /**
   * Replay all beads transitions from WAL
   *
   * Used for crash recovery. Returns entries sorted by timestamp.
   * Entries with invalid checksums are logged and skipped.
   *
   * @returns Array of validated BeadWALEntry objects
   */
  async replay(): Promise<BeadWALEntry[]> {
    const entries: BeadWALEntry[] = [];

    await this.wal.replay(async (walEntry: WALEntry) => {
      // Only process beads WAL entries
      if (walEntry.operation === "write" && walEntry.path.startsWith(this.pathPrefix)) {
        try {
          if (!walEntry.data) {
            console.warn(`[beads-wal] entry has no data: ${walEntry.path}`);
            return;
          }

          // Decode base64 data from WAL
          const jsonStr = Buffer.from(walEntry.data, "base64").toString("utf-8");
          const entry = JSON.parse(jsonStr) as BeadWALEntry;

          // Verify integrity
          if (this.verifyChecksum(entry)) {
            entries.push(entry);
          } else {
            console.warn(`[beads-wal] checksum mismatch for entry ${entry.id}, skipping`);
          }
        } catch (e) {
          console.error(`[beads-wal] failed to parse entry: ${e}`);
        }
      }
    });

    // Sort by timestamp for correct replay order
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (this.verbose || entries.length > 0) {
      console.log(`[beads-wal] replayed ${entries.length} transitions`);
    }

    return entries;
  }

  /**
   * Get transitions since a specific sequence number
   *
   * Used for incremental sync operations.
   *
   * @param seq - Sequence number to start from (exclusive)
   * @returns Array of BeadWALEntry objects since that sequence
   */
  async getTransitionsSince(seq: number): Promise<BeadWALEntry[]> {
    const walEntries = await this.wal.getEntriesSince(seq);
    const beadEntries: BeadWALEntry[] = [];

    for (const walEntry of walEntries) {
      if (
        walEntry.operation === "write" &&
        walEntry.path.startsWith(this.pathPrefix) &&
        walEntry.data
      ) {
        try {
          const jsonStr = Buffer.from(walEntry.data, "base64").toString("utf-8");
          const entry = JSON.parse(jsonStr) as BeadWALEntry;
          if (this.verifyChecksum(entry)) {
            beadEntries.push(entry);
          }
        } catch {
          // Skip invalid entries
        }
      }
    }

    return beadEntries;
  }

  /**
   * Get the current WAL sequence number
   *
   * Useful for tracking checkpoint positions.
   */
  getCurrentSeq(): number {
    return this.wal.getStatus().seq;
  }

  /**
   * Compute SHA-256 checksum of payload (truncated to 16 chars)
   */
  private computeChecksum(payload: Record<string, unknown>): string {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  }

  /**
   * Verify entry checksum matches payload
   */
  private verifyChecksum(entry: BeadWALEntry): boolean {
    const expected = this.computeChecksum(entry.payload);
    return entry.checksum === expected;
  }
}

/**
 * Factory function for creating BeadsWALAdapter
 */
export function createBeadsWALAdapter(
  wal: SegmentedWALManager,
  config?: BeadsWALConfig,
): BeadsWALAdapter {
  return new BeadsWALAdapter(wal, config);
}
