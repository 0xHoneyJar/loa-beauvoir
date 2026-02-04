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

const execAsync = promisify(exec);

/**
 * SECURITY: Pattern for valid bead IDs (alphanumeric, underscore, hyphen only)
 * Prevents command injection and path traversal via beadId
 */
const BEAD_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * SECURITY: Allowed bead types (whitelist)
 */
const ALLOWED_TYPES = new Set(["task", "bug", "feature", "epic", "story", "debt", "spike"]);

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
 * SECURITY: Validate bead ID against safe pattern
 * @throws Error if beadId contains unsafe characters
 */
function validateBeadId(beadId: string): void {
  if (!beadId || typeof beadId !== "string") {
    throw new Error("Invalid beadId: must be a non-empty string");
  }
  if (!BEAD_ID_PATTERN.test(beadId)) {
    throw new Error(
      `Invalid beadId: must match pattern ${BEAD_ID_PATTERN} (got: ${beadId.slice(0, 50)})`,
    );
  }
  if (beadId.length > 128) {
    throw new Error("Invalid beadId: exceeds maximum length of 128 characters");
  }
}

/**
 * SECURITY: Validate brCommand is safe
 * Only allows 'br' or absolute paths to prevent arbitrary command execution
 */
function validateBrCommand(cmd: string): void {
  if (cmd === "br") return;
  if (cmd.startsWith("/") && !cmd.includes(" ") && !cmd.includes(";")) return;
  throw new Error(`Invalid brCommand: must be 'br' or an absolute path without spaces/semicolons`);
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
    const title = this.escapeArg(String(payload.title ?? "Untitled"));

    // SECURITY: Whitelist allowed types
    const rawType = String(payload.type ?? "task");
    const type = ALLOWED_TYPES.has(rawType) ? rawType : "task";

    // SECURITY: Validate priority is a number in valid range
    const rawPriority = Number(payload.priority);
    const priority =
      Number.isInteger(rawPriority) && rawPriority >= 0 && rawPriority <= 10 ? rawPriority : 2;

    let cmd = `create ${title} --type ${type} --priority ${priority}`;

    if (payload.description) {
      cmd += ` --description ${this.escapeArg(String(payload.description))}`;
    }

    await this.execBr(cmd);
  }

  private async replayUpdate(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const updates: string[] = [];

    // SECURITY: Only allow whitelisted keys
    for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined && value !== null && ALLOWED_UPDATE_KEYS.has(key)) {
        // SECURITY: Escape both key (via whitelist) and value
        updates.push(`--${key} ${this.escapeArg(String(value))}`);
      }
    }

    if (updates.length > 0) {
      // SECURITY: beadId already validated, escape it anyway for defense in depth
      await this.execBr(`update ${this.escapeArg(beadId)} ${updates.join(" ")}`);
    }
  }

  private async replayClose(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const reason = payload.reason ? ` --reason ${this.escapeArg(String(payload.reason))}` : "";
    // SECURITY: Escape beadId
    await this.execBr(`close ${this.escapeArg(beadId)}${reason}`);
  }

  private async replayReopen(beadId: string): Promise<void> {
    // SECURITY: Escape beadId
    await this.execBr(`reopen ${this.escapeArg(beadId)}`);
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
        .map((l) => this.escapeArg(l));
      escapedLabels = safeLabels.join(" ");
    } else {
      const labelStr = String(payload.labels ?? payload.label ?? "");
      if (/^[a-zA-Z0-9_:-]+$/.test(labelStr)) {
        escapedLabels = this.escapeArg(labelStr);
      } else {
        escapedLabels = "";
      }
    }

    if (escapedLabels) {
      // SECURITY: Escape beadId
      await this.execBr(`label ${action} ${this.escapeArg(beadId)} ${escapedLabels}`);
    }
  }

  private async replayComment(beadId: string, payload: Record<string, unknown>): Promise<void> {
    const text = this.escapeArg(String(payload.text ?? ""));
    if (text && text !== "''") {
      // SECURITY: Escape beadId
      await this.execBr(`comments add ${this.escapeArg(beadId)} ${text}`);
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
        await this.execBr(`dep ${action} ${this.escapeArg(beadId)} ${this.escapeArg(targetStr)}`);
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
   * Escape argument for shell execution
   * Uses single-quote escaping which is safe for all content
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
