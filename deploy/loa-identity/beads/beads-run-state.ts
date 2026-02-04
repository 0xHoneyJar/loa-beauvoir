/**
 * Beads Run State Manager
 *
 * Manages run-mode execution state using beads as the backing store.
 * Replaces .run/ state files with beads as single source of truth (Phase 4).
 *
 * SECURITY: All user-controllable values are validated and shell-escaped
 * before being used in commands to prevent command injection.
 *
 * @module beads-run-state
 */

import { exec } from "child_process";
import { existsSync, readFileSync } from "fs";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * SECURITY: Pattern for valid bead IDs (alphanumeric, underscore, hyphen only)
 */
const BEAD_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * SECURITY: Maximum length for string inputs
 */
const MAX_STRING_LENGTH = 1024;

/**
 * Label schema for run state management
 * All labels follow the pattern: category:value
 */
export const LABELS = {
  // Run-level labels
  RUN_CURRENT: "run:current",
  RUN_COMPLETE: "run:complete",

  // Sprint-level labels
  SPRINT_PREFIX: "sprint:",
  SPRINT_IN_PROGRESS: "sprint:in_progress",
  SPRINT_PENDING: "sprint:pending",
  SPRINT_COMPLETE: "sprint:complete",

  // Circuit breaker labels
  CIRCUIT_BREAKER: "circuit-breaker",
  SAME_ISSUE_PREFIX: "same-issue-",

  // Task-level labels
  TASK_READY: "ready",
  TASK_IN_PROGRESS: "in_progress",
  TASK_BLOCKED: "blocked",
  TASK_DONE: "done",

  // Session tracking
  SESSION_PREFIX: "session:",
  HANDOFF_PREFIX: "handoff:",
} as const;

/**
 * Run states mapped from .run/state.json semantics
 */
export type RunState = "READY" | "RUNNING" | "HALTED" | "COMPLETE";

/**
 * Sprint execution state
 */
export interface SprintState {
  /** Bead ID of the sprint */
  id: string;
  /** Sprint number (extracted from label) */
  sprintNumber: number;
  /** Current status */
  status: "pending" | "in_progress" | "completed" | "halted";
  /** Total tasks in sprint */
  tasksTotal: number;
  /** Completed task count */
  tasksCompleted: number;
  /** Currently executing task ID */
  currentTaskId?: string;
}

/**
 * Circuit breaker record stored as bead
 */
export interface CircuitBreakerRecord {
  /** Bead ID of the circuit breaker */
  beadId: string;
  /** Sprint ID that triggered the breaker */
  sprintId: string;
  /** Reason for halt */
  reason: string;
  /** Number of failures */
  failureCount: number;
  /** When circuit breaker was created */
  createdAt: string;
  /** When circuit breaker was resolved (if resolved) */
  resolvedAt?: string;
}

/**
 * Result of migration from .run/ to beads
 */
export interface MigrationResult {
  /** Whether migration succeeded */
  success: boolean;
  /** Number of sprints migrated */
  migratedSprints: number;
  /** Number of tasks migrated */
  migratedTasks: number;
  /** Number of circuit breakers created */
  circuitBreakersCreated: number;
  /** Any warnings during migration */
  warnings: string[];
}

/**
 * Configuration for BeadsRunStateManager
 */
export interface BeadsRunStateConfig {
  /** Command to run br (default: "br") */
  brCommand?: string;
  /** Enable verbose logging */
  verbose?: boolean;
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
 * SECURITY: Escape string for shell single quotes
 * Replaces ' with '\'' which closes the quote, adds escaped quote, reopens quote
 */
function shellEscape(str: string): string {
  if (typeof str !== "string") {
    throw new Error("shellEscape requires a string input");
  }
  if (str.length > MAX_STRING_LENGTH) {
    throw new Error(`Input exceeds maximum length of ${MAX_STRING_LENGTH}`);
  }
  return str.replace(/'/g, "'\\''");
}

/**
 * SECURITY: Validate and sanitize label
 * Labels must be alphanumeric with colons, underscores, and hyphens
 */
function validateLabel(label: string): void {
  if (!label || typeof label !== "string") {
    throw new Error("Invalid label: must be a non-empty string");
  }
  if (!/^[a-zA-Z0-9:_-]+$/.test(label)) {
    throw new Error(`Invalid label format: ${label.slice(0, 50)}`);
  }
  if (label.length > 128) {
    throw new Error("Invalid label: exceeds maximum length");
  }
}

/**
 * Manager for run-mode state using beads as backing store
 *
 * Provides a unified interface for run state management, replacing
 * the previous .run/ file-based system with beads queries.
 */
export class BeadsRunStateManager {
  private readonly brCommand: string;
  private readonly verbose: boolean;

  constructor(config?: BeadsRunStateConfig) {
    this.brCommand = config?.brCommand ?? "br";
    this.verbose = config?.verbose ?? process.env.DEBUG === "true";
  }

  /**
   * Query current run state from beads
   *
   * State mapping:
   * - READY: No beads with run:current label
   * - RUNNING: Has run:current bead with sprint:in_progress child
   * - HALTED: Has run:current bead with circuit-breaker label
   * - COMPLETE: Has run:current bead with no pending sprints
   */
  async getRunState(): Promise<RunState> {
    try {
      // Check for in-progress runs
      const inProgress = await this.queryBeads(`list --label '${LABELS.RUN_CURRENT}' --json`);
      const runs = this.parseJsonSafe(inProgress);

      if (!runs || runs.length === 0) {
        return "READY";
      }

      const currentRun = runs[0];

      // Check for circuit breaker
      if (currentRun.labels?.includes(LABELS.CIRCUIT_BREAKER)) {
        return "HALTED";
      }

      // Check for in-progress sprints
      const sprintsInProgress = await this.queryBeads(
        `list --label '${LABELS.SPRINT_IN_PROGRESS}' --json`,
      );
      const activeSprints = this.parseJsonSafe(sprintsInProgress);

      if (activeSprints && activeSprints.length > 0) {
        return "RUNNING";
      }

      // Check for pending sprints
      const sprintsPending = await this.queryBeads(
        `list --label '${LABELS.SPRINT_PENDING}' --json`,
      );
      const pendingSprints = this.parseJsonSafe(sprintsPending);

      if (!pendingSprints || pendingSprints.length === 0) {
        return "COMPLETE";
      }

      // Has pending sprints but no in-progress - ready for next sprint
      return "RUNNING";
    } catch (e) {
      if (this.verbose) {
        console.error(`[beads-run-state] Error getting run state: ${e}`);
      }
      // Default to READY on error (no active run)
      return "READY";
    }
  }

  /**
   * Get current sprint being executed
   * Returns null if no sprint is in progress
   */
  async getCurrentSprint(): Promise<SprintState | null> {
    try {
      const result = await this.queryBeads(`list --label '${LABELS.SPRINT_IN_PROGRESS}' --json`);
      const sprints = this.parseJsonSafe(result);

      if (!sprints || sprints.length === 0) {
        return null;
      }

      const sprint = sprints[0];
      const sprintNumber = this.extractSprintNumber(sprint.labels || []);

      // Count tasks in this sprint
      const tasksResult = await this.queryBeads(`list --label 'epic:${sprint.id}' --json`);
      const tasks = this.parseJsonSafe(tasksResult) || [];

      const completedTasks = tasks.filter(
        (t: Record<string, unknown>) => t.status === "closed",
      ).length;
      const currentTask = tasks.find((t: Record<string, unknown>) =>
        (t.labels as string[] | undefined)?.includes(LABELS.TASK_IN_PROGRESS),
      );

      return {
        id: sprint.id,
        sprintNumber,
        status: "in_progress",
        tasksTotal: tasks.length,
        tasksCompleted: completedTasks,
        currentTaskId: currentTask?.id as string | undefined,
      };
    } catch (e) {
      if (this.verbose) {
        console.error(`[beads-run-state] Error getting current sprint: ${e}`);
      }
      return null;
    }
  }

  /**
   * Get all sprints in the current run plan
   */
  async getSprintPlan(): Promise<SprintState[]> {
    try {
      // Get all sprint beads (any sprint label)
      const result = await this.queryBeads(`list --type epic --json`);
      const epics = this.parseJsonSafe(result) || [];

      const sprints: SprintState[] = [];

      for (const epic of epics) {
        const labels = (epic.labels as string[]) || [];
        const sprintNumber = this.extractSprintNumber(labels);

        if (sprintNumber === 0) continue; // Not a sprint

        let status: SprintState["status"] = "pending";
        if (labels.includes(LABELS.SPRINT_COMPLETE)) {
          status = "completed";
        } else if (labels.includes(LABELS.SPRINT_IN_PROGRESS)) {
          status = "in_progress";
        } else if (labels.includes(LABELS.CIRCUIT_BREAKER)) {
          status = "halted";
        }

        // Count tasks
        const tasksResult = await this.queryBeads(`list --label 'epic:${epic.id}' --json`);
        const tasks = this.parseJsonSafe(tasksResult) || [];

        sprints.push({
          id: epic.id,
          sprintNumber,
          status,
          tasksTotal: tasks.length,
          tasksCompleted: tasks.filter((t: Record<string, unknown>) => t.status === "closed")
            .length,
        });
      }

      // Sort by sprint number
      return sprints.sort((a, b) => a.sprintNumber - b.sprintNumber);
    } catch (e) {
      if (this.verbose) {
        console.error(`[beads-run-state] Error getting sprint plan: ${e}`);
      }
      return [];
    }
  }

  /**
   * Start a new run with given sprint IDs
   */
  async startRun(sprintIds: string[]): Promise<string> {
    // Validate all sprint IDs
    for (const id of sprintIds) {
      validateBeadId(id);
    }

    // Create run epic
    const title = `Run: ${new Date().toISOString().split("T")[0]}`;
    const runId = await this.createBead({
      title,
      type: "epic",
      priority: 0,
      labels: [LABELS.RUN_CURRENT],
    });

    if (this.verbose) {
      console.log(`[beads-run-state] Created run ${runId}`);
    }

    // Link sprints to run and mark as pending
    for (let i = 0; i < sprintIds.length; i++) {
      const sprintId = sprintIds[i];
      await this.addLabel(sprintId, `${LABELS.SPRINT_PREFIX}${i + 1}`);
      await this.addLabel(sprintId, LABELS.SPRINT_PENDING);
      await this.addLabel(sprintId, `run:${runId}`);
    }

    console.log(`[beads-run-state] Started run ${runId} with ${sprintIds.length} sprints`);
    return runId;
  }

  /**
   * Start executing a specific sprint
   */
  async startSprint(sprintId: string): Promise<void> {
    validateBeadId(sprintId);

    // Remove pending, add in_progress
    await this.removeLabel(sprintId, LABELS.SPRINT_PENDING);
    await this.addLabel(sprintId, LABELS.SPRINT_IN_PROGRESS);

    console.log(`[beads-run-state] Started sprint ${sprintId}`);
  }

  /**
   * Mark sprint as complete
   */
  async completeSprint(sprintId: string): Promise<void> {
    validateBeadId(sprintId);

    await this.removeLabel(sprintId, LABELS.SPRINT_IN_PROGRESS);
    await this.addLabel(sprintId, LABELS.SPRINT_COMPLETE);
    await this.closeBead(sprintId);

    console.log(`[beads-run-state] Completed sprint ${sprintId}`);
  }

  /**
   * Halt run by creating circuit breaker bead
   */
  async haltRun(reason: string): Promise<CircuitBreakerRecord> {
    const currentSprint = await this.getCurrentSprint();
    const sprintId = currentSprint?.id ?? "unknown";
    return this.createCircuitBreaker(sprintId, reason, 1);
  }

  /**
   * Resume run by resolving all active circuit breakers
   */
  async resumeRun(): Promise<void> {
    const cbs = await this.getActiveCircuitBreakers();
    for (const cb of cbs) {
      await this.resolveCircuitBreaker(cb.beadId);
    }
    console.log(`[beads-run-state] Resumed run, resolved ${cbs.length} circuit breakers`);
  }

  /**
   * Create circuit breaker bead for failure tracking
   */
  async createCircuitBreaker(
    sprintId: string,
    reason: string,
    failureCount: number,
  ): Promise<CircuitBreakerRecord> {
    validateBeadId(sprintId);

    const title = `Circuit Breaker: Sprint ${sprintId}`;
    const beadId = await this.createBead({
      title,
      type: "debt",
      priority: 0,
      labels: [LABELS.CIRCUIT_BREAKER, `${LABELS.SAME_ISSUE_PREFIX}${failureCount}x`],
    });

    await this.addComment(beadId, `Triggered: ${reason}`);

    // Also label the run as halted
    try {
      const runs = await this.queryBeads(`list --label '${LABELS.RUN_CURRENT}' --json`);
      const currentRuns = this.parseJsonSafe(runs);
      if (currentRuns && currentRuns.length > 0) {
        await this.addLabel(currentRuns[0].id, LABELS.CIRCUIT_BREAKER);
      }
    } catch {
      // Ignore if run not found
    }

    const record: CircuitBreakerRecord = {
      beadId,
      sprintId,
      reason,
      failureCount,
      createdAt: new Date().toISOString(),
    };

    console.log(`[beads-run-state] Created circuit breaker ${beadId} for sprint ${sprintId}`);
    return record;
  }

  /**
   * Resolve circuit breaker and resume run
   */
  async resolveCircuitBreaker(beadId: string): Promise<void> {
    validateBeadId(beadId);

    await this.closeBead(beadId);
    await this.addComment(beadId, `Resolved at ${new Date().toISOString()}`);

    // Remove circuit breaker label from run
    try {
      const runs = await this.queryBeads(`list --label '${LABELS.RUN_CURRENT}' --json`);
      const currentRuns = this.parseJsonSafe(runs);
      if (currentRuns && currentRuns.length > 0) {
        await this.removeLabel(currentRuns[0].id, LABELS.CIRCUIT_BREAKER);
      }
    } catch {
      // Ignore if run not found
    }

    console.log(`[beads-run-state] Resolved circuit breaker ${beadId}`);
  }

  /**
   * Get all active (open) circuit breakers
   */
  async getActiveCircuitBreakers(): Promise<CircuitBreakerRecord[]> {
    try {
      const result = await this.queryBeads(
        `list --label '${LABELS.CIRCUIT_BREAKER}' --status open --json`,
      );
      const beads = this.parseJsonSafe(result) || [];

      return beads
        .filter((b: Record<string, unknown>) => b.type === "debt")
        .map((b: Record<string, unknown>) => {
          const labels = (b.labels as string[]) || [];
          const failureLabel = labels.find((l) => l.startsWith(LABELS.SAME_ISSUE_PREFIX));
          const failureCount = failureLabel
            ? parseInt(failureLabel.replace(LABELS.SAME_ISSUE_PREFIX, "").replace("x", ""), 10)
            : 1;

          return {
            beadId: b.id as string,
            sprintId: this.extractSprintId(labels),
            reason: (b.description as string) || "Unknown",
            failureCount,
            createdAt: (b.created_at as string) || new Date().toISOString(),
          };
        });
    } catch (e) {
      if (this.verbose) {
        console.error(`[beads-run-state] Error getting circuit breakers: ${e}`);
      }
      return [];
    }
  }

  /**
   * Migrate existing .run/ state to beads
   */
  async migrateFromDotRun(dotRunPath: string): Promise<MigrationResult> {
    const warnings: string[] = [];
    let migratedSprints = 0;
    let migratedTasks = 0;
    let circuitBreakersCreated = 0;

    try {
      // Read state.json
      const statePath = `${dotRunPath}/state.json`;
      if (!existsSync(statePath)) {
        return {
          success: true,
          migratedSprints: 0,
          migratedTasks: 0,
          circuitBreakersCreated: 0,
          warnings: ["No .run/state.json found - nothing to migrate"],
        };
      }

      const stateRaw = readFileSync(statePath, "utf-8");
      // State file exists but we don't need to parse it for basic migration

      // Read sprint-plan-state.json if exists
      const sprintPlanPath = `${dotRunPath}/sprint-plan-state.json`;
      if (existsSync(sprintPlanPath)) {
        const sprintPlanRaw = readFileSync(sprintPlanPath, "utf-8");
        const sprintPlan = JSON.parse(sprintPlanRaw);

        // Create sprint beads
        for (const sprint of sprintPlan.sprints?.list || []) {
          const labels = [`${LABELS.SPRINT_PREFIX}${sprint.id.replace("sprint-", "")}`];

          if (sprint.status === "completed") {
            labels.push(LABELS.SPRINT_COMPLETE);
          } else if (sprint.status === "in_progress") {
            labels.push(LABELS.SPRINT_IN_PROGRESS);
          } else {
            labels.push(LABELS.SPRINT_PENDING);
          }

          await this.createBead({
            title: `Sprint: ${sprint.id}`,
            type: "epic",
            priority: 1,
            labels,
          });
          migratedSprints++;
        }
      }

      // Read circuit-breaker.json if exists
      const cbPath = `${dotRunPath}/circuit-breaker.json`;
      if (existsSync(cbPath)) {
        const cbRaw = readFileSync(cbPath, "utf-8");
        const cb = JSON.parse(cbRaw);
        if (cb.state === "open") {
          await this.createCircuitBreaker(
            cb.sprint || "unknown",
            cb.reason || "Migrated from .run/",
            cb.failures || 3,
          );
          circuitBreakersCreated++;
        }
      }

      console.log(
        `[beads-run-state] Migration complete: ${migratedSprints} sprints, ${circuitBreakersCreated} circuit breakers`,
      );

      return {
        success: true,
        migratedSprints,
        migratedTasks,
        circuitBreakersCreated,
        warnings,
      };
    } catch (e) {
      return {
        success: false,
        migratedSprints,
        migratedTasks,
        circuitBreakersCreated,
        warnings: [...warnings, `Migration failed: ${e}`],
      };
    }
  }

  /**
   * Check if .run/ directory exists (for deprecation warning)
   */
  dotRunExists(dotRunPath = ".run"): boolean {
    return existsSync(dotRunPath);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  private async queryBeads(args: string): Promise<string> {
    const { stdout } = await execAsync(`${this.brCommand} ${args}`);
    return stdout.trim();
  }

  private async createBead(opts: {
    title: string;
    type: string;
    priority: number;
    labels?: string[];
  }): Promise<string> {
    // Validate and escape
    const escapedTitle = shellEscape(opts.title);
    const labelArgs =
      opts.labels
        ?.map((l) => {
          validateLabel(l);
          return `--label '${shellEscape(l)}'`;
        })
        .join(" ") || "";

    const { stdout } = await execAsync(
      `${this.brCommand} create '${escapedTitle}' --type ${opts.type} --priority ${opts.priority} ${labelArgs} --json`,
    );

    const result = JSON.parse(stdout.trim());
    return result.id;
  }

  private async addLabel(beadId: string, label: string): Promise<void> {
    validateBeadId(beadId);
    validateLabel(label);
    await execAsync(`${this.brCommand} label add '${beadId}' '${shellEscape(label)}'`);
  }

  private async removeLabel(beadId: string, label: string): Promise<void> {
    validateBeadId(beadId);
    validateLabel(label);
    try {
      await execAsync(`${this.brCommand} label remove '${beadId}' '${shellEscape(label)}'`);
    } catch {
      // Ignore if label doesn't exist
    }
  }

  private async addComment(beadId: string, text: string): Promise<void> {
    validateBeadId(beadId);
    const escapedText = shellEscape(text);
    await execAsync(`${this.brCommand} comments add '${beadId}' '${escapedText}'`);
  }

  private async closeBead(beadId: string): Promise<void> {
    validateBeadId(beadId);
    await execAsync(`${this.brCommand} close '${beadId}'`);
  }

  private parseJsonSafe(str: string): Record<string, unknown>[] | null {
    try {
      if (!str || str.trim() === "") return null;
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  private extractSprintNumber(labels: string[]): number {
    const sprintLabel = labels?.find((l) => /^sprint:\d+$/.test(l));
    if (sprintLabel) {
      return parseInt(sprintLabel.split(":")[1], 10);
    }
    return 0;
  }

  private extractSprintId(labels: string[]): string {
    const sprintLabel = labels?.find((l) => l.startsWith("sprint:") && !l.includes("_"));
    return sprintLabel?.split(":")[1] || "unknown";
  }
}

/**
 * Factory function for creating BeadsRunStateManager
 */
export function createBeadsRunStateManager(config?: BeadsRunStateConfig): BeadsRunStateManager {
  return new BeadsRunStateManager(config);
}
