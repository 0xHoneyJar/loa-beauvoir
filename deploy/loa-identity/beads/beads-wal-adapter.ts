/**
 * Beads WAL Adapter
 *
 * Records beads state transitions to the Write-Ahead Log for crash recovery.
 * Integrates with OpenClaw's SegmentedWALManager for persistence.
 *
 * SECURITY: All beadIds are validated before use in paths to prevent
 * path traversal attacks. Checksums use 128-bit (32 hex char) truncation
 * for adequate collision resistance.
 *
 * @module beads-wal-adapter
 */

import { createHash, randomUUID } from "crypto";
import type { SegmentedWALManager, WALEntry } from "../wal/wal-manager.js";
import {
  validateBeadId,
  validateOperation as validateOperationBase,
  BEAD_ID_PATTERN,
  MAX_BEAD_ID_LENGTH,
  ALLOWED_OPERATIONS as BASE_ALLOWED_OPERATIONS,
} from "../../../.claude/lib/beads";

/**
 * SECURITY: Allowed operation types for WAL (whitelist)
 * Uses upstream base operations
 */
const ALLOWED_OPERATIONS = BASE_ALLOWED_OPERATIONS;

/**
 * SECURITY: Validate operation type against whitelist
 * Wraps upstream validateOperation with BeadOperation type assertion
 */
function validateOperation(operation: unknown): asserts operation is BeadOperation {
  validateOperationBase(operation);
}

/**
 * SECURITY: Validate WAL entry structure at runtime
 * Ensures deserialized data matches expected schema
 */
function validateWALEntry(data: unknown): asserts data is BeadWALEntry {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid WAL entry: must be an object");
  }

  const entry = data as Record<string, unknown>;

  // Validate required string fields
  if (typeof entry.id !== "string" || !entry.id) {
    throw new Error("Invalid WAL entry: missing or invalid id");
  }
  if (typeof entry.timestamp !== "string" || !entry.timestamp) {
    throw new Error("Invalid WAL entry: missing or invalid timestamp");
  }
  if (typeof entry.checksum !== "string" || !entry.checksum) {
    throw new Error("Invalid WAL entry: missing or invalid checksum");
  }

  // Validate beadId
  validateBeadId(entry.beadId);

  // Validate operation
  validateOperation(entry.operation);

  // Validate payload is an object
  if (!entry.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload)) {
    throw new Error("Invalid WAL entry: payload must be an object");
  }
}

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
   * SECURITY: Validates beadId and operation before recording to prevent
   * path traversal and injection attacks.
   *
   * @param entry - Partial entry (id, timestamp, checksum will be generated)
   * @returns WAL sequence number
   * @throws Error if beadId or operation fails validation
   */
  async recordTransition(
    entry: Omit<BeadWALEntry, "id" | "timestamp" | "checksum">,
  ): Promise<number> {
    // SECURITY: Validate beadId before using in path construction
    validateBeadId(entry.beadId);

    // SECURITY: Validate operation type
    validateOperation(entry.operation);

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
      // SECURITY: Don't log full beadId in case of sensitive data
      console.log(`[beads-wal] recorded ${entry.operation} (seq=${seq})`);
    }

    return seq;
  }

  /**
   * Replay all beads transitions from WAL
   *
   * Used for crash recovery. Returns entries sorted by timestamp.
   * Entries with invalid checksums or schema are logged and skipped.
   *
   * SECURITY: All deserialized entries are validated at runtime before use.
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
            console.warn("[beads-wal] entry has no data, skipping");
            return;
          }

          // Decode base64 data from WAL
          const jsonStr = Buffer.from(walEntry.data, "base64").toString("utf-8");
          const parsed: unknown = JSON.parse(jsonStr);

          // SECURITY: Validate entry structure at runtime (throws on invalid)
          validateWALEntry(parsed);
          const entry = parsed as BeadWALEntry;

          // Verify integrity
          if (this.verifyChecksum(entry)) {
            entries.push(entry);
          } else {
            // SECURITY: Don't log entry details that may contain sensitive data
            console.warn("[beads-wal] checksum mismatch, skipping entry");
          }
        } catch (e) {
          // SECURITY: Don't expose parsing error details
          console.error("[beads-wal] failed to parse/validate entry, skipping");
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
   * SECURITY: All deserialized entries are validated at runtime before use.
   *
   * @param seq - Sequence number to start from (exclusive)
   * @returns Array of validated BeadWALEntry objects since that sequence
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
          const parsed: unknown = JSON.parse(jsonStr);

          // SECURITY: Validate entry structure at runtime (throws on invalid)
          validateWALEntry(parsed);
          const entry = parsed as BeadWALEntry;

          if (this.verifyChecksum(entry)) {
            beadEntries.push(entry);
          }
        } catch {
          // Skip invalid entries (validation or parse failure)
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
   * Compute SHA-256 checksum of payload (truncated to 32 hex chars = 128 bits)
   *
   * SECURITY: Uses 128-bit truncation for adequate collision resistance.
   * 64-bit (16 chars) would be vulnerable to birthday attacks with ~2^32 entries.
   */
  private computeChecksum(payload: Record<string, unknown>): string {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
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
