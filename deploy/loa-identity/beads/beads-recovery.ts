/**
 * Beads Recovery Handler
 *
 * Restores beads state from WAL after a crash by replaying
 * recorded transitions through the br CLI.
 *
 * @module beads-recovery
 */

import { exec } from "child_process";
import { statSync, existsSync } from "fs";
import { promisify } from "util";
import type { BeadsWALAdapter, BeadWALEntry, BeadOperation } from "./beads-wal-adapter.js";

const execAsync = promisify(exec);

/**
 * Result of a recovery operation
 */
export interface RecoveryResult {
  /** Whether recovery completed successfully */
  success: boolean;
  /** Number of WAL entries replayed */
  entriesReplayed: number;
  /** List of bead IDs affected by recovery */
  beadsAffected: string[];
  /** Time taken in milliseconds */
  durationMs: number;
  /** Error message if recovery failed */
  error?: string;
}

/**
 * Configuration for BeadsRecoveryHandler
 */
export interface BeadsRecoveryConfig {
  /** Path to .beads directory (default: ".beads") */
  beadsDir?: string;
  /** Command to run br (default: "br") */
  brCommand?: string;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Skip final sync after recovery */
  skipSync?: boolean;
}

/**
 * Recovery handler for beads state
 *
 * Checks if recovery is needed by comparing WAL timestamps with SQLite mtime,
 * then replays WAL entries through br commands to restore state.
 */
export class BeadsRecoveryHandler {
  private readonly adapter: BeadsWALAdapter;
  private readonly beadsDir: string;
  private readonly brCommand: string;
  private readonly verbose: boolean;
  private readonly skipSync: boolean;

  constructor(adapter: BeadsWALAdapter, config?: BeadsRecoveryConfig) {
    this.adapter = adapter;
    this.beadsDir = config?.beadsDir ?? ".beads";
    this.brCommand = config?.brCommand ?? "br";
    this.verbose = config?.verbose ?? false;
    this.skipSync = config?.skipSync ?? false;
  }

  /**
   * Check if recovery is needed
   *
   * Recovery is needed when WAL has entries newer than the SQLite database's
   * last modification time, indicating a crash occurred before sync.
   *
   * @returns true if WAL has entries newer than SQLite
   */
  async needsRecovery(): Promise<boolean> {
    try {
      const lastSync = this.getLastSyncTime();
      const walEntries = await this.adapter.replay();

      if (walEntries.length === 0) {
        if (this.verbose) {
          console.log("[beads-recovery] No WAL entries, recovery not needed");
        }
        return false;
      }

      const newestWAL = new Date(walEntries[walEntries.length - 1].timestamp);
      const needsRecovery = newestWAL > lastSync;

      if (this.verbose) {
        console.log(
          `[beads-recovery] Last sync: ${lastSync.toISOString()}, newest WAL: ${newestWAL.toISOString()}, needs recovery: ${needsRecovery}`,
        );
      }

      return needsRecovery;
    } catch (e) {
      console.error(`[beads-recovery] Error checking recovery status: ${e}`);
      // If we can't determine, assume recovery is needed for safety
      return true;
    }
  }

  /**
   * Perform crash recovery by replaying WAL to SQLite
   *
   * Groups entries by bead ID for efficient replay, then executes
   * br commands to restore each operation.
   *
   * @returns RecoveryResult with details of what was recovered
   */
  async recover(): Promise<RecoveryResult> {
    const start = Date.now();
    const affectedBeads = new Set<string>();

    try {
      const entries = await this.adapter.replay();

      if (entries.length === 0) {
        return {
          success: true,
          entriesReplayed: 0,
          beadsAffected: [],
          durationMs: Date.now() - start,
        };
      }

      console.log(`[beads-recovery] Replaying ${entries.length} WAL entries...`);

      // Group entries by bead for efficient replay
      const byBead = this.groupByBead(entries);

      for (const [beadId, beadEntries] of Array.from(byBead.entries())) {
        try {
          await this.replayBeadEntries(beadId, beadEntries);
          affectedBeads.add(beadId);
        } catch (e) {
          console.error(`[beads-recovery] Failed to replay bead ${beadId}: ${e}`);
          // Continue with other beads
        }
      }

      // Sync to ensure JSONL is updated
      if (!this.skipSync) {
        try {
          await this.execBr("sync --flush-only");
          console.log("[beads-recovery] Synced to JSONL");
        } catch (e) {
          console.warn(`[beads-recovery] Sync failed (non-fatal): ${e}`);
        }
      }

      const result: RecoveryResult = {
        success: true,
        entriesReplayed: entries.length,
        beadsAffected: Array.from(affectedBeads),
        durationMs: Date.now() - start,
      };

      console.log(
        `[beads-recovery] Recovery complete: ${result.entriesReplayed} entries, ` +
          `${result.beadsAffected.length} beads (${result.durationMs}ms)`,
      );

      return result;
    } catch (e) {
      const error = String(e);
      console.error(`[beads-recovery] Recovery failed: ${error}`);

      return {
        success: false,
        entriesReplayed: 0,
        beadsAffected: Array.from(affectedBeads),
        durationMs: Date.now() - start,
        error,
      };
    }
  }

  /**
   * Replay entries for a single bead
   */
  private async replayBeadEntries(beadId: string, entries: BeadWALEntry[]): Promise<void> {
    for (const entry of entries) {
      if (this.verbose) {
        console.log(`[beads-recovery] Replaying ${entry.operation} for ${beadId}`);
      }

      await this.replayEntry(entry);
    }
  }

  /**
   * Replay a single WAL entry through br CLI
   */
  private async replayEntry(entry: BeadWALEntry): Promise<void> {
    const { operation, beadId, payload } = entry;

    switch (operation) {
      case "create":
        await this.replayCreate(payload);
        break;

      case "update":
        await this.replayUpdate(beadId, payload);
        break;

      case "close":
        await this.replayClose(beadId, payload);
        break;

      case "reopen":
        await this.replayReopen(beadId);
        break;

      case "label":
        await this.replayLabel(beadId, payload);
        break;

      case "comment":
        await this.replayComment(beadId, payload);
        break;

      case "dep":
        await this.replayDep(beadId, payload);
        break;

      default:
        console.warn(`[beads-recovery] Unknown operation: ${operation as string}`);
    }
  }

  private async replayCreate(payload: Record<string, unknown>): Promise<void> {
    const title = this.escapeArg(String(payload.title ?? "Untitled"));
    const type = payload.type ?? "task";
    const priority = payload.priority ?? 2;

    let cmd = `create ${title} --type ${type} --priority ${priority}`;

    if (payload.description) {
      cmd += ` --description ${this.escapeArg(String(payload.description))}`;
    }

    await this.execBr(cmd);
  }

  private async replayUpdate(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const updates: string[] = [];

    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null) {
        updates.push(`--${key} ${this.escapeArg(String(value))}`);
      }
    }

    if (updates.length > 0) {
      await this.execBr(`update ${beadId} ${updates.join(" ")}`);
    }
  }

  private async replayClose(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const reason = payload.reason ? ` --reason ${this.escapeArg(String(payload.reason))}` : "";
    await this.execBr(`close ${beadId}${reason}`);
  }

  private async replayReopen(beadId: string): Promise<void> {
    await this.execBr(`reopen ${beadId}`);
  }

  private async replayLabel(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const action = payload.action ?? "add";
    const labels = Array.isArray(payload.labels)
      ? payload.labels.join(" ")
      : String(payload.labels ?? payload.label ?? "");

    if (labels) {
      await this.execBr(`label ${action} ${beadId} ${labels}`);
    }
  }

  private async replayComment(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const text = this.escapeArg(String(payload.text ?? ""));
    if (text) {
      await this.execBr(`comments add ${beadId} ${text}`);
    }
  }

  private async replayDep(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const action = payload.action ?? "add";
    const target = payload.target ?? payload.dependency;

    if (target) {
      await this.execBr(`dep ${action} ${beadId} ${target}`);
    }
  }

  /**
   * Execute a br command
   */
  private async execBr(args: string): Promise<string> {
    const cmd = `${this.brCommand} ${args}`;

    if (this.verbose) {
      console.log(`[beads-recovery] Executing: ${cmd}`);
    }

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: this.beadsDir,
        timeout: 30000, // 30 second timeout per command
      });

      if (stderr && this.verbose) {
        console.warn(`[beads-recovery] stderr: ${stderr}`);
      }

      return stdout;
    } catch (e: unknown) {
      const error = e as { message?: string; stderr?: string };
      throw new Error(`br command failed: ${error.message ?? error.stderr ?? String(e)}`);
    }
  }

  /**
   * Escape argument for shell execution
   */
  private escapeArg(arg: string): string {
    // Escape single quotes and wrap in single quotes
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Group WAL entries by bead ID
   */
  private groupByBead(entries: BeadWALEntry[]): Map<string, BeadWALEntry[]> {
    const map = new Map<string, BeadWALEntry[]>();

    for (const entry of entries) {
      const list = map.get(entry.beadId) ?? [];
      list.push(entry);
      map.set(entry.beadId, list);
    }

    return map;
  }

  /**
   * Get the last modification time of SQLite database
   */
  private getLastSyncTime(): Date {
    try {
      const dbPath = `${this.beadsDir}/beads.db`;

      if (!existsSync(dbPath)) {
        // No database yet, return epoch (everything is newer)
        return new Date(0);
      }

      const stats = statSync(dbPath);
      return stats.mtime;
    } catch {
      // If we can't read mtime, return epoch (everything is newer)
      return new Date(0);
    }
  }
}

/**
 * Factory function for creating BeadsRecoveryHandler
 */
export function createBeadsRecoveryHandler(
  adapter: BeadsWALAdapter,
  config?: BeadsRecoveryConfig,
): BeadsRecoveryHandler {
  return new BeadsRecoveryHandler(adapter, config);
}
