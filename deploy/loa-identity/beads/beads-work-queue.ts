/**
 * Beads Work Queue
 *
 * Scheduler-driven task processor for bounded session execution.
 * Implements the "cron-based task decomposition" pattern for 30-minute
 * bounded sessions instead of unbounded marathon sessions.
 *
 * SECURITY: All user-controllable values are validated and shell-escaped
 * before being used in commands to prevent command injection.
 *
 * @module beads/work-queue
 * @version 1.0.0
 */

import { exec, type ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import { promisify } from "util";
import {
  validateBeadId,
  validateLabel,
  shellEscape,
  validateBrCommand,
  LABELS,
  type Bead,
  type IBrExecutor,
  type BrCommandResult,
  type IBeadsRunStateManager,
} from "../../../.claude/lib/beads";

const execAsync = promisify(exec);

/**
 * GNU timeout(1) exit code when time limit is reached.
 * Note: timeout is GNU coreutils — not available on macOS by default.
 * macOS users can install via `brew install coreutils` (provides `gtimeout`).
 * TODO: Consider cross-platform alternative (Node setTimeout + SIGTERM) for macOS.
 */
const TIMEOUT_EXIT_CODE = 124;

// =============================================================================
// Types & Interfaces
// =============================================================================

/**
 * Configuration for the work queue
 */
export interface WorkQueueConfig {
  /** Enable work queue processing */
  enabled: boolean;

  /** Check interval in milliseconds (default: 5 minutes) */
  intervalMs: number;

  /** Jitter for check interval in milliseconds (default: 30 seconds) */
  jitterMs: number;

  /** Session timeout in milliseconds (default: 30 minutes) */
  sessionTimeoutMs: number;

  /** Circuit breaker configuration */
  circuitBreaker: {
    /** Max consecutive failures before open (default: 3) */
    maxFailures: number;

    /** Reset time in milliseconds (default: 30 minutes) */
    resetTimeMs: number;
  };
}

/**
 * Task claim record
 */
export interface TaskClaim {
  /** Bead ID of the claimed task */
  taskId: string;

  /** ISO timestamp when task was claimed */
  claimedAt: string;

  /** Session ID for tracking */
  sessionId: string;

  /** Task title */
  title?: string;

  /** Task priority */
  priority?: number;
}

/**
 * Session handoff context for preserving state between sessions
 */
export interface SessionHandoff {
  /** Session ID that created this handoff */
  sessionId: string;

  /** Files changed during the session */
  filesChanged: string[];

  /** Description of current implementation state */
  currentState: string;

  /** Remaining steps for next session */
  nextSteps: string[];

  /** Tokens used in this session */
  tokensUsed: number;

  /** ISO timestamp of handoff */
  timestamp?: string;
}

/**
 * Result of stale session recovery (Phase 5.7)
 */
export interface StaleSessionRecoveryResult {
  /** Number of tasks successfully recovered */
  recovered: number;

  /** Number of recovery failures */
  failed: number;

  /** Details of each recovery attempt */
  details: Array<{
    taskId: string;
    sessionId: string;
    claimedAt: string;
    status: "recovered" | "failed";
    error?: string;
  }>;
}

/**
 * Scheduler task registration interface
 */
export interface SchedulerRegistration {
  id: string;
  name: string;
  intervalMs: number;
  jitterMs?: number;
  handler: () => Promise<void>;
  circuitBreaker?: {
    maxFailures: number;
    resetTimeMs: number;
    halfOpenRetries?: number;
  };
}

/**
 * Scheduler interface for registration
 */
export interface ISchedulerRegistry {
  register(task: SchedulerRegistration): void;
}

/**
 * A bead included in compiled context, with relevance scoring
 */
export interface CompiledBead {
  /** The bead data */
  bead: Bead;

  /** Relevance score (0-1) */
  score: number;

  /** Reason for inclusion */
  reason: string;
}

/**
 * Result of context compilation for a task
 */
export interface ContextCompilationResult {
  /** The task ID this compilation targets */
  taskId: string;

  /** Compiled beads ordered by relevance */
  beads: CompiledBead[];

  /** Estimated token count of compiled context */
  tokenEstimate: number;

  /** Token budget (advisory — actual compilation uses upstream config) */
  tokenBudget: number;

  /** Trace log entries for debugging */
  trace: string[];
}

/**
 * Interface for context compilers used by the work queue
 */
export interface IContextCompiler {
  compile(
    taskId: string,
    options?: { tokenBudget?: number },
  ): Promise<ContextCompilationResult | null>;
}

// =============================================================================
// Work Queue Labels (extending base LABELS)
// =============================================================================

/**
 * Extended labels for work queue operations
 * Maps to consistent naming scheme for task state
 */
export const WORK_QUEUE_LABELS = {
  ...LABELS,

  // Task state labels (aliases for upstream labels)
  TASK_READY: LABELS.STATUS_READY,
  TASK_BLOCKED: LABELS.STATUS_BLOCKED,
  // TODO: Reference upstream LABELS constants once STATUS_IN_PROGRESS/STATUS_DONE are defined
  TASK_IN_PROGRESS: "in_progress",
  TASK_DONE: "done",

  // Epic linking
  EPIC_PREFIX: "epic:",

  // Dependency tracking
  BLOCKED_BY_PREFIX: "blocked-by:",
} as const;

// =============================================================================
// Default BR Executor
// =============================================================================

/**
 * Default br CLI executor
 * @internal
 */
class DefaultBrExecutor implements IBrExecutor {
  constructor(private readonly brCommand: string) {}

  async exec(args: string): Promise<BrCommandResult> {
    try {
      const { stdout, stderr } = await execAsync(`${this.brCommand} ${args}`);
      return {
        success: true,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
      };
    } catch (e) {
      const error = e as { stdout?: string; stderr?: string; code?: number };
      return {
        success: false,
        stdout: error.stdout?.trim() ?? "",
        stderr: error.stderr?.trim() ?? "",
        exitCode: error.code ?? 1,
      };
    }
  }

  async execJson<T = unknown>(args: string): Promise<T> {
    const result = await this.exec(args);
    if (!result.success) {
      throw new Error(`br command failed: ${result.stderr}`);
    }
    if (!result.stdout) {
      return [] as unknown as T;
    }
    return JSON.parse(result.stdout) as T;
  }
}

// =============================================================================
// Default Configuration
// =============================================================================

/**
 * Default work queue configuration
 */
export const DEFAULT_WORK_QUEUE_CONFIG: WorkQueueConfig = {
  enabled: true,
  intervalMs: 5 * 60 * 1000, // 5 minutes
  jitterMs: 30 * 1000, // ±30 seconds
  sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
  circuitBreaker: {
    maxFailures: 3,
    resetTimeMs: 30 * 60 * 1000, // 30 minutes
  },
};

// =============================================================================
// BeadsWorkQueue
// =============================================================================

/**
 * Work queue for processing tasks from beads in bounded sessions.
 *
 * Implements the "single-task mode" pattern where each session:
 * 1. Claims one ready task
 * 2. Processes it for up to 30 minutes
 * 3. Records a handoff if incomplete
 * 4. Exits cleanly
 *
 * @example
 * ```typescript
 * const runState = new BeadsRunStateManager();
 * const workQueue = new BeadsWorkQueue(config, runState);
 *
 * // Register with scheduler
 * workQueue.register(scheduler);
 *
 * // Or manually claim and process
 * const claim = await workQueue.claimNextTask();
 * if (claim) {
 *   // Process task...
 *   await workQueue.releaseTask(claim.taskId, "done");
 * }
 * ```
 */
export class BeadsWorkQueue {
  private readonly config: WorkQueueConfig;
  private readonly runState: IBeadsRunStateManager;
  private readonly executor: IBrExecutor;
  private readonly verbose: boolean;

  /** Active agent session process (if running) */
  private activeSession: ChildProcess | null = null;

  constructor(
    config: Partial<WorkQueueConfig>,
    runStateManager: IBeadsRunStateManager,
    options?: {
      brCommand?: string;
      executor?: IBrExecutor;
      verbose?: boolean;
    },
  ) {
    this.config = {
      ...DEFAULT_WORK_QUEUE_CONFIG,
      ...config,
      circuitBreaker: {
        ...DEFAULT_WORK_QUEUE_CONFIG.circuitBreaker,
        ...config.circuitBreaker,
      },
    };
    this.runState = runStateManager;

    const brCommand = options?.brCommand ?? "br";
    validateBrCommand(brCommand);
    this.executor = options?.executor ?? new DefaultBrExecutor(brCommand);
    this.verbose = options?.verbose ?? process.env.DEBUG === "true";
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Scheduler Registration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Register work queue task with scheduler
   */
  register(scheduler: ISchedulerRegistry): void {
    if (!this.config.enabled) {
      this.log("Disabled by configuration");
      return;
    }

    scheduler.register({
      id: "beads_work_queue",
      name: "Beads Work Queue Processor",
      intervalMs: this.config.intervalMs,
      jitterMs: this.config.jitterMs,
      handler: this.createHandler(),
      circuitBreaker: {
        maxFailures: this.config.circuitBreaker.maxFailures,
        resetTimeMs: this.config.circuitBreaker.resetTimeMs,
        halfOpenRetries: 1,
      },
    });

    this.log(
      `Registered (interval=${this.config.intervalMs}ms, timeout=${this.config.sessionTimeoutMs}ms)`,
    );
  }

  /**
   * Create the scheduler handler function
   */
  private createHandler(): () => Promise<void> {
    return async () => {
      // Check run state - only process if RUNNING
      const state = await this.runState.getRunState();
      if (state !== "RUNNING") {
        this.logDebug(`Skipping - run state is ${state}`);
        return;
      }

      // Claim next task
      const claim = await this.claimNextTask();
      if (!claim) {
        this.logDebug("No ready tasks");
        return;
      }

      this.log(`Claimed task ${claim.taskId}`);

      // Trigger single-task agent session
      await this.triggerAgentSession(claim);
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Task Claiming
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Claim the next ready task from the queue.
   *
   * Claims the highest-priority ready task by:
   * 1. Querying for open tasks with "ready" label
   * 2. Sorting by priority (lower number = higher priority)
   * 3. Removing "ready" label and adding "in_progress"
   * 4. Adding session tracking label
   *
   * @returns TaskClaim if a task was claimed, null if no ready tasks
   */
  async claimNextTask(): Promise<TaskClaim | null> {
    try {
      // Get ready tasks (not blocked, not in_progress, not done)
      const tasks = await this.queryBeadsJson<Bead[]>(
        `list --label '${WORK_QUEUE_LABELS.TASK_READY}' --status open --json`,
      );

      if (!tasks || tasks.length === 0) {
        return null;
      }

      // Sort by priority (lower number = higher priority)
      const sortedTasks = [...tasks].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

      const task = sortedTasks[0];
      const sessionId = randomUUID();
      const claimedAt = new Date().toISOString();

      // Validate task ID before operations
      validateBeadId(task.id);

      // Claim the task: remove ready, add in_progress
      await this.removeLabel(task.id, WORK_QUEUE_LABELS.TASK_READY);
      await this.addLabel(task.id, WORK_QUEUE_LABELS.TASK_IN_PROGRESS);
      await this.addLabel(task.id, `${WORK_QUEUE_LABELS.SESSION_PREFIX}${sessionId}`);

      // TOCTOU mitigation: verify we're the sole claimant.
      // If two agents race, both may complete the claim sequence above.
      // Re-query and check for multiple session:* labels (like DynamoDB
      // conditional writes — check-after-write).
      // TODO: Push atomic claiming into br itself (`br claim --label ready --limit 1`)
      const verified = await this.queryBeadsJson<Bead>(`show ${shellEscape(task.id)} --json`);
      if (verified) {
        const sessionLabels =
          verified.labels?.filter((l: string) => l.startsWith(WORK_QUEUE_LABELS.SESSION_PREFIX)) ??
          [];
        if (sessionLabels.length > 1) {
          // Another agent claimed simultaneously — back off gracefully
          this.log(
            `Task ${task.id}: concurrent claim detected (${sessionLabels.length} sessions), backing off`,
          );
          await this.removeLabel(task.id, `${WORK_QUEUE_LABELS.SESSION_PREFIX}${sessionId}`);
          await this.removeLabel(task.id, WORK_QUEUE_LABELS.TASK_IN_PROGRESS);
          await this.addLabel(task.id, WORK_QUEUE_LABELS.TASK_READY);
          return null;
        }
      }

      // Add claim comment
      await this.addComment(task.id, `Claimed by session ${sessionId} at ${claimedAt}`);

      this.log(`Claimed task ${task.id} (priority: ${task.priority}, session: ${sessionId})`);

      return {
        taskId: task.id,
        claimedAt,
        sessionId,
        title: task.title,
        priority: task.priority,
      };
    } catch (e) {
      this.logError(`Error claiming task: ${e}`);
      return null;
    }
  }

  /**
   * Release a task after processing.
   *
   * @param taskId - Bead ID of the task
   * @param status - Final status: "done" (closes bead) or "blocked" (keeps open)
   * @param reason - Optional reason for blocked status
   */
  async releaseTask(taskId: string, status: "done" | "blocked", reason?: string): Promise<void> {
    validateBeadId(taskId);

    try {
      // Remove in_progress label
      await this.removeLabel(taskId, WORK_QUEUE_LABELS.TASK_IN_PROGRESS);

      if (status === "done") {
        await this.addLabel(taskId, WORK_QUEUE_LABELS.TASK_DONE);
        await this.closeBead(taskId);
        await this.addComment(taskId, `Completed at ${new Date().toISOString()}`);
        this.log(`Released task ${taskId} as done`);
      } else {
        await this.addLabel(taskId, WORK_QUEUE_LABELS.TASK_BLOCKED);
        if (reason) {
          await this.addComment(taskId, `Blocked: ${reason}`);
        }
        this.log(`Released task ${taskId} as blocked: ${reason ?? "no reason"}`);
      }
    } catch (e) {
      this.logError(`Error releasing task ${taskId}: ${e}`);
      throw e;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Session Handoff
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Record session handoff for context preservation.
   *
   * Creates a structured comment on the task bead that the next
   * session can parse to continue work seamlessly.
   *
   * @param taskId - Bead ID of the task
   * @param context - Handoff context with state information
   */
  async recordHandoff(taskId: string, context: SessionHandoff): Promise<void> {
    validateBeadId(taskId);

    const timestamp = context.timestamp ?? new Date().toISOString();

    const handoffComment = `
--- SESSION HANDOFF ---
Session: ${context.sessionId}
Timestamp: ${timestamp}
Tokens used: ${context.tokensUsed}

Files changed:
${context.filesChanged.length > 0 ? context.filesChanged.map((f) => `  - ${f}`).join("\n") : "  (none)"}

Current state:
${context.currentState}

Next steps:
${context.nextSteps.length > 0 ? context.nextSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") : "  (none)"}
--- END HANDOFF ---
`.trim();

    try {
      await this.addComment(taskId, handoffComment);
      await this.addLabel(taskId, `${WORK_QUEUE_LABELS.HANDOFF_PREFIX}${context.sessionId}`);
      this.log(`Recorded handoff for task ${taskId} (session: ${context.sessionId})`);
    } catch (e) {
      this.logError(`Error recording handoff for ${taskId}: ${e}`);
      throw e;
    }
  }

  /**
   * Parse previous handoff from task comments.
   *
   * Reads from br comments (not task.description) since recordHandoff()
   * writes via addComment(). Falls back to description for backwards
   * compatibility with existing beads that may have handoff text in
   * the description field.
   *
   * @param taskId - Bead ID of the task
   * @returns Parsed handoff context or null if no handoff found
   */
  async getPreviousHandoff(taskId: string): Promise<SessionHandoff | null> {
    validateBeadId(taskId);

    try {
      // Primary: read comments (where recordHandoff() writes)
      let handoffSource: string | null = null;

      const comments = await this.queryBeadsJson<Array<{ body: string }>>(
        `comments list ${shellEscape(taskId)} --json`,
      );
      if (comments && comments.length > 0) {
        // Search comments in reverse (most recent first)
        for (let i = comments.length - 1; i >= 0; i--) {
          const body = comments[i].body ?? "";
          if (body.includes("--- SESSION HANDOFF ---")) {
            handoffSource = body;
            break;
          }
        }
      }

      // Fallback: check description for backwards compatibility
      if (!handoffSource) {
        const task = await this.queryBeadsJson<Bead>(`show ${shellEscape(taskId)} --json`);
        if (task?.description?.includes("--- SESSION HANDOFF ---")) {
          handoffSource = task.description;
        }
      }

      if (!handoffSource) {
        return null;
      }

      return this.parseHandoffText(handoffSource);
    } catch (e) {
      this.logError(`Error parsing handoff for ${taskId}: ${e}`);
      return null;
    }
  }

  /**
   * Parse structured handoff text into a SessionHandoff object.
   */
  private parseHandoffText(text: string): SessionHandoff | null {
    const handoffMatch = text.match(/--- SESSION HANDOFF ---[\s\S]*?--- END HANDOFF ---/);

    if (!handoffMatch) {
      return null;
    }

    const handoffText = handoffMatch[0];

    // Parse handoff fields
    const sessionMatch = handoffText.match(/Session: ([\w-]+)/);
    const timestampMatch = handoffText.match(/Timestamp: ([\w\-:TZ.]+)/);
    const tokensMatch = handoffText.match(/Tokens used: (\d+)/);

    // Parse files changed
    const filesSection = handoffText.match(/Files changed:\n([\s\S]*?)\n\nCurrent state:/);
    const filesChanged: string[] = [];
    if (filesSection) {
      const fileLines = filesSection[1].split("\n");
      for (const line of fileLines) {
        const match = line.match(/^\s+-\s+(.+)$/);
        if (match && match[1] !== "(none)") {
          filesChanged.push(match[1]);
        }
      }
    }

    // Parse current state
    const stateSection = handoffText.match(/Current state:\n([\s\S]*?)\n\nNext steps:/);
    const currentState = stateSection?.[1].trim() || "";

    // Parse next steps
    const stepsSection = handoffText.match(/Next steps:\n([\s\S]*?)--- END HANDOFF ---/);
    const nextSteps: string[] = [];
    if (stepsSection) {
      const stepLines = stepsSection[1].split("\n");
      for (const line of stepLines) {
        const match = line.match(/^\s+\d+\.\s+(.+)$/);
        if (match && match[1] !== "(none)") {
          nextSteps.push(match[1]);
        }
      }
    }

    return {
      sessionId: sessionMatch?.[1] || "unknown",
      timestamp: timestampMatch?.[1],
      tokensUsed: parseInt(tokensMatch?.[1] || "0", 10),
      filesChanged,
      currentState,
      nextSteps,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Agent Session Triggering
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Trigger a single-task agent session.
   *
   * Uses the openclaw CLI to start a bounded session that processes
   * exactly one task.
   *
   * SECURITY: Uses spawn() with argv array — no shell interpretation,
   * no injection surface. Same pattern as Kubernetes kubelet exec.
   * See: OWASP OS Command Injection Cheat Sheet, Option A.
   *
   * @param claim - Task claim with sessionId
   */
  async triggerAgentSession(claim: TaskClaim): Promise<void> {
    const timeoutSeconds = Math.floor(this.config.sessionTimeoutMs / 1000);

    // SECURITY: Validate agent command before execution
    const agentCommand = process.env.LOA_AGENT_COMMAND ?? "openclaw";
    validateBrCommand(agentCommand);

    // Validate claim inputs (defense-in-depth — already validated at claim time)
    validateBeadId(claim.taskId);

    this.log(
      `Triggering agent session: timeout ${timeoutSeconds}s ${agentCommand} agent run --mode single-task --task-id ${claim.taskId}`,
    );

    try {
      // SECURITY: spawn() with argv array — no shell interpretation, no injection surface
      this.activeSession = spawn(
        "timeout",
        [
          `${timeoutSeconds}s`,
          agentCommand,
          "agent",
          "run",
          "--mode",
          "single-task",
          "--task-id",
          claim.taskId,
          "--session-id",
          claim.sessionId,
        ],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            LOA_SINGLE_TASK_MODE: "true",
            LOA_TASK_ID: claim.taskId,
            LOA_SESSION_ID: claim.sessionId,
            LOA_SESSION_TIMEOUT: String(timeoutSeconds),
          },
        },
      );

      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        this.activeSession!.on("close", (code, signal) => {
          this.activeSession = null;

          // GNU timeout(1) exits with code 124 when the time limit is reached.
          // It sends SIGTERM to its child, but the wrapper process itself exits
          // normally with code 124 — so signal will be null, not "SIGTERM".
          if (signal === "SIGTERM" || code === TIMEOUT_EXIT_CODE) {
            this.log(`Session timed out for task ${claim.taskId}`);
            resolve();
          } else if (code === 0) {
            this.log(`Session completed for task ${claim.taskId}`);
            resolve();
          } else {
            this.logError(`Session failed for task ${claim.taskId} (code: ${code})`);
            reject(new Error(`Agent session exited with code ${code}`));
          }
        });

        this.activeSession!.on("error", (err) => {
          this.activeSession = null;
          this.logError(`Session error for task ${claim.taskId}: ${err}`);
          reject(err);
        });
      });
    } catch (e) {
      this.activeSession = null;

      // On error, record a minimal handoff
      try {
        await this.recordHandoff(claim.taskId, {
          sessionId: claim.sessionId,
          filesChanged: [],
          currentState: `Session error: ${e}`,
          nextSteps: ["Investigate and retry"],
          tokensUsed: 0,
        });
      } catch {
        // Ignore handoff recording errors
      }

      throw e;
    }
  }

  /**
   * Stop active session if running
   */
  stopActiveSession(): void {
    if (this.activeSession) {
      this.activeSession.kill("SIGTERM");
      this.activeSession = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Session Timeout Handling (Phase 5.7)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Detect and recover stale sessions.
   *
   * A session is considered stale if:
   * 1. Task has "in_progress" label
   * 2. Task has a session:* label
   * 3. The claim timestamp (from comment) is older than sessionTimeoutMs
   *
   * Recovery:
   * 1. Remove "in_progress" label
   * 2. Add "ready" label to make task available again
   * 3. Add a stale session marker comment
   *
   * @returns Recovery result with details of recovered tasks
   */
  async recoverStaleSessions(): Promise<StaleSessionRecoveryResult> {
    const result: StaleSessionRecoveryResult = {
      recovered: 0,
      failed: 0,
      details: [],
    };

    try {
      // Find all in_progress tasks
      const inProgressTasks = await this.queryBeadsJson<Bead[]>(
        `list --label '${WORK_QUEUE_LABELS.TASK_IN_PROGRESS}' --status open --json`,
      );

      if (!inProgressTasks || inProgressTasks.length === 0) {
        this.logDebug("No in_progress tasks found");
        return result;
      }

      const now = Date.now();
      const timeoutMs = this.config.sessionTimeoutMs;

      for (const task of inProgressTasks) {
        try {
          validateBeadId(task.id);

          // Find session label
          const sessionLabel = task.labels?.find((l: string) =>
            l.startsWith(WORK_QUEUE_LABELS.SESSION_PREFIX),
          );

          if (!sessionLabel) {
            continue; // No session tracking, skip
          }

          const sessionId = sessionLabel.replace(WORK_QUEUE_LABELS.SESSION_PREFIX, "");

          // Parse claim timestamp from task (look for claim comment)
          const claimedAt = await this.parseClaimTimestamp(task.id);

          if (!claimedAt) {
            this.logDebug(`Task ${task.id}: no claim timestamp found, skipping`);
            continue;
          }

          const claimTime = new Date(claimedAt).getTime();

          // Guard against malformed timestamps: NaN comparison evaluates
          // as false for <, meaning NaN elapsed would incorrectly bypass
          // the "not stale yet" check and trigger false recovery.
          if (isNaN(claimTime)) {
            this.logError(`Task ${task.id}: invalid claim timestamp "${claimedAt}", skipping`);
            continue;
          }

          const elapsed = now - claimTime;

          if (elapsed < timeoutMs) {
            // Not stale yet
            continue;
          }

          this.log(
            `Task ${task.id}: session ${sessionId} timed out (${Math.floor(elapsed / 60000)} min)`,
          );

          // Recover the task
          await this.recoverTask(task.id, sessionId, claimedAt);

          result.recovered++;
          result.details.push({
            taskId: task.id,
            sessionId,
            claimedAt,
            status: "recovered",
          });
        } catch (e) {
          result.failed++;
          result.details.push({
            taskId: task.id,
            sessionId: "unknown",
            claimedAt: "unknown",
            status: "failed",
            error: String(e),
          });
          this.logError(`Error recovering task ${task.id}: ${e}`);
        }
      }

      this.log(`Recovered ${result.recovered} stale sessions, ${result.failed} failed`);
      return result;
    } catch (e) {
      this.logError(`Error during stale session recovery: ${e}`);
      throw e;
    }
  }

  /**
   * Parse claim timestamp from task comments.
   *
   * Reads from br comments (where claimNextTask() writes via addComment()).
   * Falls back to task.description for backwards compatibility.
   *
   * @param taskId - Bead ID of the task
   * @returns ISO timestamp string or null if not found
   */
  private async parseClaimTimestamp(taskId: string): Promise<string | null> {
    try {
      // Primary: search comments (where claimNextTask writes)
      const comments = await this.queryBeadsJson<Array<{ body: string }>>(
        `comments list ${shellEscape(taskId)} --json`,
      );
      if (comments && comments.length > 0) {
        // Search comments in reverse (most recent claim first)
        for (let i = comments.length - 1; i >= 0; i--) {
          const body = comments[i].body ?? "";
          const claimMatch = body.match(/Claimed by session [\w-]+ at ([\w\-:TZ.]+)/);
          if (claimMatch) {
            return claimMatch[1];
          }
        }
      }

      // Fallback: check description for backwards compatibility
      const task = await this.queryBeadsJson<Bead>(`show ${shellEscape(taskId)} --json`);
      if (task?.description) {
        const claimMatch = task.description.match(/Claimed by session [\w-]+ at ([\w\-:TZ.]+)/);
        if (claimMatch) {
          return claimMatch[1];
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Recover a stale task by making it ready again.
   *
   * @param taskId - Bead ID of the task
   * @param sessionId - Session ID that was processing the task
   * @param claimedAt - When the task was claimed
   */
  private async recoverTask(taskId: string, sessionId: string, claimedAt: string): Promise<void> {
    validateBeadId(taskId);

    // Remove in_progress label
    await this.removeLabel(taskId, WORK_QUEUE_LABELS.TASK_IN_PROGRESS);

    // Remove session label
    await this.removeLabel(taskId, `${WORK_QUEUE_LABELS.SESSION_PREFIX}${sessionId}`);

    // Add ready label to make available again
    await this.addLabel(taskId, WORK_QUEUE_LABELS.TASK_READY);

    // Add stale session comment
    const staleComment = `--- STALE SESSION DETECTED ---
Session: ${sessionId}
Claimed at: ${claimedAt}
Recovered at: ${new Date().toISOString()}
Reason: Session timeout (${Math.floor(this.config.sessionTimeoutMs / 60000)} minutes)
Action: Task returned to ready queue
--- END STALE SESSION ---`;

    await this.addComment(taskId, staleComment);

    this.log(`Recovered stale task ${taskId} from session ${sessionId}`);
  }

  /**
   * Get session timeout in milliseconds
   */
  getSessionTimeout(): number {
    return this.config.sessionTimeoutMs;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get current work queue configuration (deep copy — callers cannot
   * mutate internal state via nested circuitBreaker reference).
   */
  getConfig(): Readonly<WorkQueueConfig> {
    return {
      ...this.config,
      circuitBreaker: { ...this.config.circuitBreaker },
    };
  }

  /**
   * Check if work queue is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  private async queryBeadsJson<T>(args: string): Promise<T | null> {
    try {
      return await this.executor.execJson<T>(args);
    } catch {
      return null;
    }
  }

  private async addLabel(beadId: string, label: string): Promise<void> {
    validateBeadId(beadId);
    validateLabel(label);
    await this.executor.exec(`label add ${shellEscape(beadId)} ${shellEscape(label)}`);
  }

  private async removeLabel(beadId: string, label: string): Promise<void> {
    validateBeadId(beadId);
    validateLabel(label);
    try {
      await this.executor.exec(`label remove ${shellEscape(beadId)} ${shellEscape(label)}`);
    } catch {
      // Ignore if label doesn't exist
    }
  }

  private async addComment(beadId: string, text: string): Promise<void> {
    validateBeadId(beadId);
    await this.executor.exec(`comments add ${shellEscape(beadId)} ${shellEscape(text)}`);
  }

  private async closeBead(beadId: string): Promise<void> {
    validateBeadId(beadId);
    await this.executor.exec(`close ${shellEscape(beadId)}`);
  }

  private log(message: string): void {
    console.log(`[beads-work-queue] ${message}`);
  }

  /**
   * Log errors unconditionally.
   *
   * Errors are NEVER gated on verbose — silent failures in production
   * make debugging impossible. Same pattern as Netflix Zuul: debug
   * messages gated on level, errors always emitted.
   */
  private logError(message: string): void {
    console.error(`[beads-work-queue] ${message}`);
  }

  private logDebug(message: string): void {
    if (this.verbose) {
      console.log(`[beads-work-queue] DEBUG: ${message}`);
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Factory function for creating BeadsWorkQueue
 *
 * @example
 * ```typescript
 * const runState = createBeadsRunStateManager();
 * const workQueue = createBeadsWorkQueue({ enabled: true }, runState);
 * ```
 */
export function createBeadsWorkQueue(
  config: Partial<WorkQueueConfig>,
  runStateManager: IBeadsRunStateManager,
  options?: {
    brCommand?: string;
    executor?: IBrExecutor;
    verbose?: boolean;
  },
): BeadsWorkQueue {
  return new BeadsWorkQueue(config, runStateManager, options);
}
