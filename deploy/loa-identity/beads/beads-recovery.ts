/**
 * Beads Recovery Handler
 *
 * Restores beads state from WAL after a crash by replaying
 * recorded transitions through the br CLI.
 *
 * SECURITY: All user-controllable values are validated and escaped
 * before being used in shell commands to prevent command injection.
 *
 * @module beads-recovery
 */

import { exec } from "child_process";
import { statSync, existsSync } from "fs";
import { promisify } from "util";
import type { BeadsWALAdapter, BeadWALEntry } from "./beads-wal-adapter.js";
import {
  validateBeadId,
  validateBrCommand,
  shellEscape,
  BEAD_ID_PATTERN,
  ALLOWED_TYPES,
  LABEL_PATTERN,
} from "../../../.claude/lib/beads";

const execAsync = promisify(exec);

/**
 * SECURITY: Allowed label actions (whitelist)
 */
const ALLOWED_LABEL_ACTIONS = new Set(["add", "remove"]);

/**
 * SECURITY: Allowed dependency actions (whitelist)
 */
const ALLOWED_DEP_ACTIONS = new Set(["add", "remove"]);

/**
 * SECURITY: Allowed update payload keys (whitelist)
 */
const ALLOWED_UPDATE_KEYS = new Set([
  "title",
  "description",
  "priority",
  "type",
  "status",
  "assignee",
  "due",
  "estimate",
]);

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

    // SECURITY: Validate brCommand before storing
    const brCmd = config?.brCommand ?? "br";
    validateBrCommand(brCmd);
    this.brCommand = brCmd;

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
      // SECURITY: Don't expose internal error details
      console.error("[beads-recovery] Error checking recovery status");
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
          // SECURITY: Validate beadId before processing
          validateBeadId(beadId);
          await this.replayBeadEntries(beadId, beadEntries);
          affectedBeads.add(beadId);
        } catch (e) {
          // SECURITY: Don't expose full error details in logs
          console.error(`[beads-recovery] Failed to replay bead: validation or command error`);
          // Continue with other beads
        }
      }

      // Sync to ensure JSONL is updated
      if (!this.skipSync) {
        try {
          await this.execBr("sync --flush-only");
          console.log("[beads-recovery] Synced to JSONL");
        } catch (e) {
          console.warn("[beads-recovery] Sync failed (non-fatal)");
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
      // SECURITY: Don't expose internal error details
      console.error("[beads-recovery] Recovery failed");

      return {
        success: false,
        entriesReplayed: 0,
        beadsAffected: Array.from(affectedBeads),
        durationMs: Date.now() - start,
        error: "Recovery failed - check logs for details",
      };
    }
  }

  /**
   * Replay entries for a single bead
   */
  private async replayBeadEntries(beadId: string, entries: BeadWALEntry[]): Promise<void> {
    for (const entry of entries) {
      if (this.verbose) {
        console.log(`[beads-recovery] Replaying ${entry.operation} for bead`);
      }

      await this.replayEntry(entry);
    }
  }

  /**
   * Replay a single WAL entry through br CLI
   */
  private async replayEntry(entry: BeadWALEntry): Promise<void> {
    const { operation, beadId, payload } = entry;

    // SECURITY: Validate beadId for every entry
    validateBeadId(beadId);

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
        console.warn("[beads-recovery] Unknown operation type, skipping");
    }
  }

  private async replayCreate(payload: Record<string, unknown>): Promise<void> {
    const title = shellEscape(String(payload.title ?? "Untitled"));

    // SECURITY: Whitelist allowed types
    const rawType = String(payload.type ?? "task");
    const type = ALLOWED_TYPES.has(rawType) ? rawType : "task";

    // SECURITY: Validate priority is a number in valid range
    const rawPriority = Number(payload.priority);
    const priority =
      Number.isInteger(rawPriority) && rawPriority >= 0 && rawPriority <= 10 ? rawPriority : 2;

    let cmd = `create ${title} --type ${type} --priority ${priority}`;

    if (payload.description) {
      cmd += ` --description ${shellEscape(String(payload.description))}`;
    }

    await this.execBr(cmd);
  }

  private async replayUpdate(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const updates: string[] = [];

    // SECURITY: Only allow whitelisted keys
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null && ALLOWED_UPDATE_KEYS.has(key)) {
        // SECURITY: Escape both key (via whitelist) and value
        updates.push(`--${key} ${shellEscape(String(value))}`);
      }
    }

    if (updates.length > 0) {
      // SECURITY: beadId already validated, escape it anyway for defense in depth
      await this.execBr(`update ${shellEscape(beadId)} ${updates.join(" ")}`);
    }
  }

  private async replayClose(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const reason = payload.reason ? ` --reason ${shellEscape(String(payload.reason))}` : "";
    // SECURITY: Escape beadId
    await this.execBr(`close ${shellEscape(beadId)}${reason}`);
  }

  private async replayReopen(beadId: string): Promise<void> {
    // SECURITY: Escape beadId
    await this.execBr(`reopen ${shellEscape(beadId)}`);
  }

  private async replayLabel(beadId: string, payload: Record<string, unknown>): Promise<void> {
    // SECURITY: Whitelist allowed actions
    const rawAction = String(payload.action ?? "add");
    const action = ALLOWED_LABEL_ACTIONS.has(rawAction) ? rawAction : "add";

    // SECURITY: Escape each label individually
    let escapedLabels: string;
    if (Array.isArray(payload.labels)) {
      // Validate and escape each label
      const safeLabels = payload.labels
        .map((l) => String(l))
        .filter((l) => /^[a-zA-Z0-9_:-]+$/.test(l))
        .map((l) => shellEscape(l));
      escapedLabels = safeLabels.join(" ");
    } else {
      const labelStr = String(payload.labels ?? payload.label ?? "");
      if (/^[a-zA-Z0-9_:-]+$/.test(labelStr)) {
        escapedLabels = shellEscape(labelStr);
      } else {
        escapedLabels = "";
      }
    }

    if (escapedLabels) {
      // SECURITY: Escape beadId
      await this.execBr(`label ${action} ${shellEscape(beadId)} ${escapedLabels}`);
    }
  }

  private async replayComment(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const text = shellEscape(String(payload.text ?? ""));
    if (text && text !== "''") {
      // SECURITY: Escape beadId
      await this.execBr(`comments add ${shellEscape(beadId)} ${text}`);
    }
  }

  private async replayDep(beadId: string, payload: Record<string, unknown>): Promise<void> {
    // SECURITY: Whitelist allowed actions
    const rawAction = String(payload.action ?? "add");
    const action = ALLOWED_DEP_ACTIONS.has(rawAction) ? rawAction : "add";

    const target = payload.target ?? payload.dependency;

    if (target) {
      const targetStr = String(target);
      // SECURITY: Validate target is a valid beadId
      if (BEAD_ID_PATTERN.test(targetStr)) {
        // SECURITY: Escape both beadId and target
        await this.execBr(`dep ${action} ${shellEscape(beadId)} ${shellEscape(targetStr)}`);
      }
    }
  }

  /**
   * Execute a br command
   */
  private async execBr(args: string): Promise<string> {
    const cmd = `${this.brCommand} ${args}`;

    if (this.verbose) {
      // SECURITY: Don't log full command which may contain sensitive data
      console.log("[beads-recovery] Executing br command");
    }

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: this.beadsDir,
        timeout: 30000, // 30 second timeout per command
      });

      if (stderr && this.verbose) {
        // SECURITY: Don't expose stderr content
        console.warn("[beads-recovery] Command produced stderr output");
      }

      return stdout;
    } catch (e: unknown) {
      // SECURITY: Don't expose command details in error
      throw new Error("br command execution failed");
    }
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
