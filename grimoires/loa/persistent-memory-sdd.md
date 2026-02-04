# Software Design Document: Persistent Memory for Loa (Phase 4-5)

> **Version**: 1.0.0
> **Created**: 2026-02-05
> **PRD**: `grimoires/loa/persistent-memory-prd.md`
> **Prerequisites**: Phase 1-3 SDD (`grimoires/loa/beads-openclaw-sdd.md`)
> **Status**: DRAFT

---

## Overview

This document describes the technical design for Phases 4 and 5 of the beads integration:

- **Phase 4**: Run-Mode Unification - Replace `.run/` with beads as single source of truth
- **Phase 5**: Cron-Based Task Decomposition - Bounded 30-minute sessions via work queue

### Design Goals

1. **Single source of truth** - All state in beads, no parallel systems
2. **Session isolation** - Each session is independent and bounded
3. **Seamless handoff** - Context preserved between sessions via bead comments
4. **Backward compatible** - Existing `/run` commands work unchanged

---

## System Architecture

### Target State (Post Phase 4-5)

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           OpenClaw Gateway                                 │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                         Scheduler                                     │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │ │
│  │  │ beads_health│  │ beads_sync  │  │beads_stale  │  │beads_work   │ │ │
│  │  │ (15 min)    │  │ (5 min)     │  │ (24h)       │  │_queue(5min) │ │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └──────┬──────┘ │ │
│  └────────────────────────────────────────────────────────────┼─────────┘ │
│                                                                │           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                      Skill Commands                                   │ │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐ │ │
│  │  │/run        │  │/run-status │  │/run-halt   │  │/implement      │ │ │
│  │  │            │  │            │  │            │  │--single-task   │ │ │
│  │  │ Writes to  │  │ Reads from │  │ Updates    │  │                │ │ │
│  │  │ beads      │  │ beads      │  │ beads      │  │ Cron-triggered │ │ │
│  │  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └───────┬────────┘ │ │
│  └────────┼───────────────┼───────────────┼─────────────────┼──────────┘ │
│           │               │               │                 │             │
│           └───────────────┴───────────────┴─────────────────┘             │
│                                   │                                        │
│                                   ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                   BeadsRunStateManager (NEW)                          │ │
│  │                                                                       │ │
│  │   getRunState()     setRunState()     createCircuitBreaker()         │ │
│  │   claimTask()       releaseTask()     recordHandoff()                │ │
│  │                                                                       │ │
│  └────────────────────────────────────────────────────────────────────┬─┘ │
│                                                                        │    │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                   BeadsPersistenceService (Phase 1-3)                 │ │
│  │                                                                       │ │
│  │   BeadsWALAdapter    BeadsRecoveryHandler    BeadsSchedulerTasks     │ │
│  │                                                                       │ │
│  └───────────────────────────────────────────────────────────────────┬──┘ │
│                                                                       │     │
└───────────────────────────────────────────────────────────────────────┼─────┘
                                                                        │
                                                                        ▼
                              ┌─────────────────────────────────────────────┐
                              │               .beads/                        │
                              │  beads.db (SQLite) ←── Single Source Truth   │
                              │  issues.jsonl      ←── Git sync              │
                              └─────────────────────────────────────────────┘

                                    ❌ .run/ (DEPRECATED)
```

---

## Component Design

### Component 1: BeadsRunStateManager

**Location**: `deploy/loa-identity/beads/beads-run-state.ts`

**Purpose**: Manage run-mode execution state using beads as the backing store.

#### Interface

```typescript
/**
 * Run states mapped from .run/state.json semantics
 */
export type RunState = "READY" | "RUNNING" | "HALTED" | "COMPLETE";

/**
 * Sprint execution state
 */
export interface SprintState {
  id: string;
  sprintNumber: number;
  status: "pending" | "in_progress" | "completed" | "halted";
  tasksTotal: number;
  tasksCompleted: number;
  currentTaskId?: string;
}

/**
 * Circuit breaker record
 */
export interface CircuitBreakerRecord {
  beadId: string;
  sprintId: string;
  reason: string;
  failureCount: number;
  createdAt: string;
  resolvedAt?: string;
}

/**
 * Manager for run-mode state using beads
 */
export class BeadsRunStateManager {
  constructor(brCommand?: string);

  // Run state queries
  async getRunState(): Promise<RunState>;
  async getCurrentSprint(): Promise<SprintState | null>;
  async getSprintPlan(): Promise<SprintState[]>;

  // Run state mutations
  async startRun(sprintIds: string[]): Promise<void>;
  async startSprint(sprintId: string): Promise<void>;
  async completeSprint(sprintId: string): Promise<void>;
  async haltRun(reason: string): Promise<CircuitBreakerRecord>;
  async resumeRun(): Promise<void>;

  // Circuit breaker
  async createCircuitBreaker(
    sprintId: string,
    reason: string,
    failureCount: number,
  ): Promise<CircuitBreakerRecord>;
  async resolveCircuitBreaker(beadId: string): Promise<void>;
  async getActiveCircuitBreakers(): Promise<CircuitBreakerRecord[]>;

  // Migration
  async migrateFromDotRun(dotRunPath: string): Promise<MigrationResult>;
}

export interface MigrationResult {
  success: boolean;
  migratedSprints: number;
  migratedTasks: number;
  circuitBreakersCreated: number;
  warnings: string[];
}
```

#### Implementation Details

```typescript
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Label schema for run state
 */
const LABELS = {
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
};

export class BeadsRunStateManager {
  private readonly brCommand: string;

  constructor(brCommand = "br") {
    this.brCommand = brCommand;
  }

  /**
   * Query current run state from beads
   */
  async getRunState(): Promise<RunState> {
    // Check for in-progress runs
    const inProgress = await this.queryBeads(`list --label ${LABELS.RUN_CURRENT} --json`);
    const parsed = JSON.parse(inProgress);

    if (parsed.length === 0) {
      return "READY";
    }

    const currentRun = parsed[0];

    // Check for circuit breaker
    if (currentRun.labels?.includes(LABELS.CIRCUIT_BREAKER)) {
      return "HALTED";
    }

    // Check if all sprints complete
    const sprintsInProgress = await this.queryBeads(
      `list --label ${LABELS.SPRINT_IN_PROGRESS} --json`,
    );
    const sprintsParsed = JSON.parse(sprintsInProgress);

    if (sprintsParsed.length === 0) {
      // No in-progress sprints - check if any pending
      const sprintsPending = await this.queryBeads(`list --label ${LABELS.SPRINT_PENDING} --json`);
      if (JSON.parse(sprintsPending).length === 0) {
        return "COMPLETE";
      }
    }

    return "RUNNING";
  }

  /**
   * Get current sprint being executed
   */
  async getCurrentSprint(): Promise<SprintState | null> {
    const result = await this.queryBeads(`list --label ${LABELS.SPRINT_IN_PROGRESS} --json`);
    const sprints = JSON.parse(result);

    if (sprints.length === 0) {
      return null;
    }

    const sprint = sprints[0];
    const sprintNumber = this.extractSprintNumber(sprint.labels);

    // Count tasks
    const tasks = await this.queryBeads(`list --label epic:${sprint.id} --json`);
    const taskList = JSON.parse(tasks);

    return {
      id: sprint.id,
      sprintNumber,
      status: "in_progress",
      tasksTotal: taskList.length,
      tasksCompleted: taskList.filter((t: any) => t.status === "closed").length,
      currentTaskId: taskList.find((t: any) => t.labels?.includes(LABELS.TASK_IN_PROGRESS))?.id,
    };
  }

  /**
   * Start a new run with given sprint IDs
   */
  async startRun(sprintIds: string[]): Promise<void> {
    // Create run epic
    const runId = await this.createBead({
      title: `Run: ${new Date().toISOString()}`,
      type: "epic",
      priority: 0,
      labels: [LABELS.RUN_CURRENT],
    });

    // Link sprints to run and mark as pending
    for (let i = 0; i < sprintIds.length; i++) {
      const sprintId = sprintIds[i];
      await this.addLabel(sprintId, `${LABELS.SPRINT_PREFIX}${i + 1}`);
      await this.addLabel(sprintId, LABELS.SPRINT_PENDING);
      await this.addLabel(sprintId, `run:${runId}`);
    }

    console.log(`[beads-run] Started run ${runId} with ${sprintIds.length} sprints`);
  }

  /**
   * Start executing a specific sprint
   */
  async startSprint(sprintId: string): Promise<void> {
    // Remove pending, add in_progress
    await this.removeLabel(sprintId, LABELS.SPRINT_PENDING);
    await this.addLabel(sprintId, LABELS.SPRINT_IN_PROGRESS);

    console.log(`[beads-run] Started sprint ${sprintId}`);
  }

  /**
   * Mark sprint as complete
   */
  async completeSprint(sprintId: string): Promise<void> {
    await this.removeLabel(sprintId, LABELS.SPRINT_IN_PROGRESS);
    await this.addLabel(sprintId, LABELS.SPRINT_COMPLETE);
    await this.closeBead(sprintId);

    console.log(`[beads-run] Completed sprint ${sprintId}`);
  }

  /**
   * Create circuit breaker bead
   */
  async createCircuitBreaker(
    sprintId: string,
    reason: string,
    failureCount: number,
  ): Promise<CircuitBreakerRecord> {
    const beadId = await this.createBead({
      title: `Circuit Breaker: Sprint ${sprintId}`,
      type: "debt",
      priority: 0,
      labels: [
        LABELS.CIRCUIT_BREAKER,
        `${LABELS.SAME_ISSUE_PREFIX}${failureCount}x`,
        `sprint:${sprintId}`,
      ],
    });

    await this.addComment(beadId, `Triggered: ${reason}`);

    // Also label the run as halted
    const runs = await this.queryBeads(`list --label ${LABELS.RUN_CURRENT} --json`);
    const currentRun = JSON.parse(runs)[0];
    if (currentRun) {
      await this.addLabel(currentRun.id, LABELS.CIRCUIT_BREAKER);
    }

    return {
      beadId,
      sprintId,
      reason,
      failureCount,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Resolve circuit breaker and resume run
   */
  async resolveCircuitBreaker(beadId: string): Promise<void> {
    await this.closeBead(beadId);
    await this.addComment(beadId, `Resolved at ${new Date().toISOString()}`);

    // Remove circuit breaker label from run
    const runs = await this.queryBeads(`list --label ${LABELS.RUN_CURRENT} --json`);
    const currentRun = JSON.parse(runs)[0];
    if (currentRun) {
      await this.removeLabel(currentRun.id, LABELS.CIRCUIT_BREAKER);
    }

    console.log(`[beads-run] Resolved circuit breaker ${beadId}`);
  }

  /**
   * Migrate existing .run/ state to beads
   */
  async migrateFromDotRun(dotRunPath: string): Promise<MigrationResult> {
    const { existsSync, readFileSync } = await import("fs");
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

      const state = JSON.parse(readFileSync(statePath, "utf-8"));

      // Read sprint-plan-state.json if exists
      const sprintPlanPath = `${dotRunPath}/sprint-plan-state.json`;
      if (existsSync(sprintPlanPath)) {
        const sprintPlan = JSON.parse(readFileSync(sprintPlanPath, "utf-8"));

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
        const cb = JSON.parse(readFileSync(cbPath, "utf-8"));
        if (cb.state === "open") {
          await this.createCircuitBreaker(
            cb.sprint || "unknown",
            cb.reason || "Migrated from .run/",
            cb.failures || 3,
          );
          circuitBreakersCreated++;
        }
      }

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

  // Helper methods

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
    const labelArgs = opts.labels?.map((l) => `--label '${l}'`).join(" ") || "";
    const { stdout } = await execAsync(
      `${this.brCommand} create '${opts.title}' --type ${opts.type} --priority ${opts.priority} ${labelArgs} --json`,
    );
    const result = JSON.parse(stdout);
    return result.id;
  }

  private async addLabel(beadId: string, label: string): Promise<void> {
    await execAsync(`${this.brCommand} label add '${beadId}' '${label}'`);
  }

  private async removeLabel(beadId: string, label: string): Promise<void> {
    await execAsync(`${this.brCommand} label remove '${beadId}' '${label}'`);
  }

  private async addComment(beadId: string, text: string): Promise<void> {
    await execAsync(`${this.brCommand} comments add '${beadId}' '${text}'`);
  }

  private async closeBead(beadId: string): Promise<void> {
    await execAsync(`${this.brCommand} close '${beadId}'`);
  }

  private extractSprintNumber(labels: string[]): number {
    const sprintLabel = labels?.find((l) => l.match(/^sprint:\d+$/));
    if (sprintLabel) {
      return parseInt(sprintLabel.split(":")[1], 10);
    }
    return 0;
  }
}
```

---

### Component 2: BeadsWorkQueueTask

**Location**: `deploy/loa-identity/beads/beads-work-queue.ts`

**Purpose**: Scheduler task that processes ready tasks from the beads work queue.

#### Interface

```typescript
export interface WorkQueueConfig {
  /** Enable work queue processing */
  enabled: boolean;
  /** Check interval in milliseconds */
  intervalMs: number;
  /** Jitter for check interval */
  jitterMs: number;
  /** Session timeout in milliseconds */
  sessionTimeoutMs: number;
  /** Circuit breaker config */
  circuitBreaker: {
    maxFailures: number;
    resetTimeMs: number;
  };
}

export interface TaskClaim {
  taskId: string;
  claimedAt: string;
  sessionId: string;
}

export class BeadsWorkQueue {
  constructor(config: WorkQueueConfig, runStateManager: BeadsRunStateManager);

  /** Register with scheduler */
  register(scheduler: Scheduler): void;

  /** Claim next ready task */
  async claimNextTask(): Promise<TaskClaim | null>;

  /** Release task (on completion or failure) */
  async releaseTask(taskId: string, status: "done" | "blocked", reason?: string): Promise<void>;

  /** Record session handoff */
  async recordHandoff(taskId: string, context: SessionHandoff): Promise<void>;
}

export interface SessionHandoff {
  sessionId: string;
  filesChanged: string[];
  currentState: string;
  nextSteps: string[];
  tokensUsed: number;
}
```

#### Implementation Details

```typescript
import { Scheduler } from "../scheduler/scheduler.js";
import { BeadsRunStateManager, LABELS } from "./beads-run-state.js";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class BeadsWorkQueue {
  private readonly config: WorkQueueConfig;
  private readonly runState: BeadsRunStateManager;
  private readonly brCommand: string;

  constructor(config: WorkQueueConfig, runStateManager: BeadsRunStateManager, brCommand = "br") {
    this.config = config;
    this.runState = runStateManager;
    this.brCommand = brCommand;
  }

  /**
   * Register work queue task with scheduler
   */
  register(scheduler: Scheduler): void {
    if (!this.config.enabled) {
      console.log("[beads-work-queue] Disabled by configuration");
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

    console.log(
      `[beads-work-queue] Registered (interval=${this.config.intervalMs}ms, timeout=${this.config.sessionTimeoutMs}ms)`,
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
        console.log(`[beads-work-queue] Skipping - run state is ${state}`);
        return;
      }

      // Claim next task
      const claim = await this.claimNextTask();
      if (!claim) {
        console.log("[beads-work-queue] No ready tasks");
        return;
      }

      console.log(`[beads-work-queue] Claimed task ${claim.taskId}`);

      // Trigger single-task agent session
      await this.triggerAgentSession(claim);
    };
  }

  /**
   * Claim the next ready task from the queue
   */
  async claimNextTask(): Promise<TaskClaim | null> {
    // Get ready tasks (not blocked, not in_progress, not done)
    const { stdout } = await execAsync(
      `${this.brCommand} list --label ${LABELS.TASK_READY} --status open --json`,
    );
    const tasks = JSON.parse(stdout);

    if (tasks.length === 0) {
      return null;
    }

    // Sort by priority (lower number = higher priority)
    tasks.sort((a: any, b: any) => (a.priority || 99) - (b.priority || 99));

    const task = tasks[0];
    const sessionId = randomUUID();

    // Claim the task
    await execAsync(`${this.brCommand} label remove '${task.id}' '${LABELS.TASK_READY}'`);
    await execAsync(`${this.brCommand} label add '${task.id}' '${LABELS.TASK_IN_PROGRESS}'`);
    await execAsync(
      `${this.brCommand} label add '${task.id}' '${LABELS.SESSION_PREFIX}${sessionId}'`,
    );

    return {
      taskId: task.id,
      claimedAt: new Date().toISOString(),
      sessionId,
    };
  }

  /**
   * Release a task after processing
   */
  async releaseTask(taskId: string, status: "done" | "blocked", reason?: string): Promise<void> {
    // Remove in_progress label
    await execAsync(`${this.brCommand} label remove '${taskId}' '${LABELS.TASK_IN_PROGRESS}'`);

    if (status === "done") {
      await execAsync(`${this.brCommand} label add '${taskId}' '${LABELS.TASK_DONE}'`);
      await execAsync(`${this.brCommand} close '${taskId}'`);
    } else {
      await execAsync(`${this.brCommand} label add '${taskId}' '${LABELS.TASK_BLOCKED}'`);
      if (reason) {
        await execAsync(`${this.brCommand} comments add '${taskId}' 'Blocked: ${reason}'`);
      }
    }

    console.log(`[beads-work-queue] Released task ${taskId} as ${status}`);
  }

  /**
   * Record session handoff for next session to pick up
   */
  async recordHandoff(taskId: string, context: SessionHandoff): Promise<void> {
    const handoffComment = `
--- SESSION HANDOFF ---
Session: ${context.sessionId}
Timestamp: ${new Date().toISOString()}
Tokens used: ${context.tokensUsed}

Files changed:
${context.filesChanged.map((f) => `  - ${f}`).join("\n")}

Current state:
${context.currentState}

Next steps:
${context.nextSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}
--- END HANDOFF ---
`.trim();

    await execAsync(
      `${this.brCommand} comments add '${taskId}' '${handoffComment.replace(/'/g, "'\\''")}'`,
    );

    // Add handoff label
    await execAsync(
      `${this.brCommand} label add '${taskId}' '${LABELS.HANDOFF_PREFIX}${context.sessionId}'`,
    );

    console.log(`[beads-work-queue] Recorded handoff for ${taskId}`);
  }

  /**
   * Trigger a single-task agent session
   */
  private async triggerAgentSession(claim: TaskClaim): Promise<void> {
    const timeoutSeconds = Math.floor(this.config.sessionTimeoutMs / 1000);

    // Use openclaw to trigger agent session
    const command = `timeout ${timeoutSeconds}s openclaw agent run \\
      --mode single-task \\
      --task-id '${claim.taskId}' \\
      --session-id '${claim.sessionId}'`;

    try {
      await execAsync(command, {
        env: {
          ...process.env,
          LOA_SINGLE_TASK_MODE: "true",
          LOA_TASK_ID: claim.taskId,
          LOA_SESSION_ID: claim.sessionId,
        },
      });
    } catch (e: any) {
      // Check if timeout
      if (e.killed || e.signal === "SIGTERM") {
        console.warn(`[beads-work-queue] Session timed out for task ${claim.taskId}`);
        // Record timeout handoff
        await this.recordHandoff(claim.taskId, {
          sessionId: claim.sessionId,
          filesChanged: [],
          currentState: "Session timed out",
          nextSteps: ["Continue from where we left off"],
          tokensUsed: 0,
        });
        // Don't release - keep in_progress for next session to pick up
        return;
      }
      throw e;
    }
  }
}
```

---

### Component 3: Single-Task Implement Mode

**Location**: Modify `.claude/skills/implementing-tasks/SKILL.md`

**Purpose**: Add `--single-task` flag for bounded session execution.

#### Changes to /implement

```typescript
// In skill handler for /implement

interface ImplementOptions {
  /** Process only one task and exit */
  singleTask?: boolean;
  /** Specific task ID to process (for cron invocation) */
  taskId?: string;
  /** Session ID for tracking */
  sessionId?: string;
  /** Session timeout in minutes */
  timeout?: number;
}

async function handleImplement(options: ImplementOptions): Promise<void> {
  const runState = new BeadsRunStateManager();
  const workQueue = new BeadsWorkQueue(getWorkQueueConfig(), runState);

  if (options.singleTask) {
    await handleSingleTaskMode(options, runState, workQueue);
  } else {
    // Original multi-task implementation
    await handleMultiTaskMode(options);
  }
}

async function handleSingleTaskMode(
  options: ImplementOptions,
  runState: BeadsRunStateManager,
  workQueue: BeadsWorkQueue,
): Promise<void> {
  const startTime = Date.now();
  const timeoutMs = (options.timeout || 30) * 60 * 1000;
  const sessionId = options.sessionId || randomUUID();

  // Get or claim task
  let taskId = options.taskId;
  if (!taskId) {
    const claim = await workQueue.claimNextTask();
    if (!claim) {
      console.log("[implement] No ready tasks to process");
      return;
    }
    taskId = claim.taskId;
  }

  console.log(`[implement] Single-task mode: processing ${taskId}`);

  // Set up timeout handler
  const timeoutHandler = setTimeout(async () => {
    console.warn(`[implement] Session timeout reached`);
    await recordHandoffAndExit();
  }, timeoutMs);

  // Set up graceful shutdown
  process.on("SIGTERM", async () => {
    clearTimeout(timeoutHandler);
    await recordHandoffAndExit();
  });

  try {
    // Read task details
    const task = await getTaskDetails(taskId);

    // Check for previous handoff
    const previousHandoff = await getPreviousHandoff(taskId);
    if (previousHandoff) {
      console.log(`[implement] Resuming from previous session: ${previousHandoff.sessionId}`);
    }

    // Execute task implementation
    const result = await implementTask(task, previousHandoff);

    // Release task
    if (result.success) {
      await workQueue.releaseTask(taskId, "done");
    } else {
      await workQueue.releaseTask(taskId, "blocked", result.error);
    }

    clearTimeout(timeoutHandler);
  } catch (e) {
    clearTimeout(timeoutHandler);
    console.error(`[implement] Task failed: ${e}`);
    await workQueue.recordHandoff(taskId, {
      sessionId,
      filesChanged: getChangedFiles(),
      currentState: `Error: ${e}`,
      nextSteps: ["Investigate and retry"],
      tokensUsed: getTokensUsed(),
    });
  }

  async function recordHandoffAndExit(): Promise<void> {
    await workQueue.recordHandoff(taskId!, {
      sessionId,
      filesChanged: getChangedFiles(),
      currentState: getCurrentImplementationState(),
      nextSteps: getRemainingSteps(),
      tokensUsed: getTokensUsed(),
    });
    process.exit(0);
  }
}
```

---

### Component 4: Run Command Updates

**Location**: Modify `.claude/skills/run-mode/SKILL.md`

**Purpose**: Update run commands to use beads state manager.

#### /run-status Changes

```typescript
// Before (reads from .run/)
const state = JSON.parse(readFileSync(".run/state.json", "utf-8"));

// After (reads from beads)
const runState = new BeadsRunStateManager();
const state = await runState.getRunState();
const sprint = await runState.getCurrentSprint();
const circuitBreakers = await runState.getActiveCircuitBreakers();
```

#### /run-halt Changes

```typescript
// Before
const cb = { state: "open", reason, failures: 3 };
writeFileSync(".run/circuit-breaker.json", JSON.stringify(cb));

// After
const runState = new BeadsRunStateManager();
await runState.createCircuitBreaker(sprintId, reason, failureCount);
```

#### /run-resume Changes

```typescript
// Before
const cb = JSON.parse(readFileSync(".run/circuit-breaker.json", "utf-8"));
cb.state = "closed";
writeFileSync(".run/circuit-breaker.json", JSON.stringify(cb));

// After
const runState = new BeadsRunStateManager();
const cbs = await runState.getActiveCircuitBreakers();
for (const cb of cbs) {
  await runState.resolveCircuitBreaker(cb.beadId);
}
```

---

## Data Flow

### Single-Task Session Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      Scheduler: beads_work_queue                          │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  1. Check run state (must be RUNNING)                                     │
│  2. Query: br list --label ready --status open --json                     │
│  3. Sort by priority                                                      │
│  4. Claim first task:                                                     │
│     - br label remove <id> ready                                          │
│     - br label add <id> in_progress                                       │
│     - br label add <id> session:<uuid>                                    │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  5. Trigger agent session:                                                │
│     timeout 1800s openclaw agent run --mode single-task --task-id <id>   │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
            ┌────────────────────┼────────────────────┐
            │                    │                    │
            ▼                    ▼                    ▼
     ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
     │   SUCCESS    │    │   BLOCKED    │    │   TIMEOUT    │
     │              │    │              │    │              │
     │ br close <id>│    │ br label add │    │ Record       │
     │ br label add │    │   blocked    │    │ handoff      │
     │   done       │    │ br comment   │    │ Keep in_prog │
     └──────────────┘    └──────────────┘    └──────────────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 │
                                 ▼
                    ┌───────────────────────┐
                    │  Next scheduler tick  │
                    │  (5 minutes later)    │
                    └───────────────────────┘
```

### Run State Query Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         /run-status                                       │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  BeadsRunStateManager.getRunState()                                       │
│                                                                           │
│  1. br list --label run:current --json                                    │
│     - Empty? → READY                                                      │
│     - Has circuit-breaker label? → HALTED                                 │
│                                                                           │
│  2. br list --label sprint:in_progress --json                             │
│     - Empty? Check sprint:pending → COMPLETE if none                      │
│     - Has results? → RUNNING                                              │
└────────────────────────────────┬─────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  BeadsRunStateManager.getCurrentSprint()                                  │
│                                                                           │
│  1. br list --label sprint:in_progress --json                             │
│  2. Get sprint bead                                                       │
│  3. br list --label epic:<sprint-id> --json                               │
│  4. Count total/completed tasks                                           │
│  5. Find current task (in_progress label)                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

### New Files

```
deploy/loa-identity/beads/
├── beads-run-state.ts            # Run state manager
├── beads-work-queue.ts           # Work queue processor
└── __tests__/
    ├── beads-run-state.test.ts
    └── beads-work-queue.test.ts

.claude/scripts/beads/
├── migrate-dotrun.sh             # Migration utility
└── work-queue-status.sh          # Queue status check
```

### Modified Files

| File                                 | Change                   |
| ------------------------------------ | ------------------------ |
| `.claude/skills/run-mode/SKILL.md`   | Use BeadsRunStateManager |
| `.claude/skills/implementing-tasks/` | Add --single-task flag   |
| `deploy/loa-identity/bootstrap.ts`   | Register work queue task |
| `deploy/loa-identity/beads/index.ts` | Export new components    |

---

## Configuration Reference

```yaml
# .loa.config.yaml

beads:
  # Phase 4: Run-Mode Unification
  run_mode:
    enabled: true # Use beads for run state
    deprecate_dotrun: true # Warn if .run/ exists
    migration:
      auto: false # Auto-migrate on first access
      backup: true # Backup .run/ before migration

  # Phase 5: Work Queue
  work_queue:
    enabled: true # Enable work queue processor
    interval_ms: 300000 # Check every 5 minutes
    jitter_ms: 30000 # ±30 seconds
    session_timeout_ms: 1800000 # 30 minute max session
    circuit_breaker:
      max_failures: 3 # Failures before open
      reset_time_ms: 1800000 # 30 minute cooldown

  # Single-task mode defaults
  single_task:
    default: false # /implement uses single-task by default
    timeout_minutes: 30 # Default session timeout
    handoff_enabled: true # Record handoffs between sessions
```

---

## Migration Strategy

### Phase 4 Migration Script

```bash
#!/bin/bash
# .claude/scripts/beads/migrate-dotrun.sh

set -euo pipefail

DOTRUN_PATH="${1:-.run}"
BACKUP_PATH="${DOTRUN_PATH}.backup.$(date +%Y%m%d_%H%M%S)"

echo "[migrate] Migrating .run/ to beads..."

# Backup
if [[ -d "$DOTRUN_PATH" ]]; then
  cp -r "$DOTRUN_PATH" "$BACKUP_PATH"
  echo "[migrate] Backed up to $BACKUP_PATH"
fi

# Run TypeScript migration
npx tsx deploy/loa-identity/beads/migrate-dotrun.ts "$DOTRUN_PATH"

echo "[migrate] Migration complete"
echo "[migrate] You can now safely remove $DOTRUN_PATH"
```

### Rollback

```bash
#!/bin/bash
# Rollback migration

# Restore backup
cp -r .run.backup.* .run/

# Remove migrated beads
br list --label run:current --json | jq -r '.[].id' | xargs -I {} br delete {}
br list --label circuit-breaker --json | jq -r '.[].id' | xargs -I {} br delete {}
```

---

## Error Handling

### Work Queue Failures

```typescript
// Circuit breaker for work queue
scheduler.register({
  id: "beads_work_queue",
  handler: async () => {
    /* ... */
  },
  circuitBreaker: {
    maxFailures: 3, // 3 consecutive failures
    resetTimeMs: 30 * 60 * 1000, // 30 minute cooldown
    halfOpenRetries: 1, // 1 retry attempt
    onOpen: () => {
      console.error("[beads-work-queue] Circuit breaker OPEN - pausing work queue");
      // Could notify operator here
    },
    onClose: () => {
      console.log("[beads-work-queue] Circuit breaker CLOSED - resuming work queue");
    },
  },
});
```

### Session Timeout Handling

```typescript
// SIGTERM handler in single-task mode
process.on("SIGTERM", async () => {
  console.log("[implement] Received SIGTERM - recording handoff");

  // Get current state
  const state = {
    filesChanged: await getChangedFiles(),
    currentState: describeCurrentState(),
    nextSteps: computeRemainingSteps(),
  };

  // Record handoff
  await workQueue.recordHandoff(taskId, {
    sessionId,
    ...state,
    tokensUsed: estimateTokensUsed(),
  });

  // Exit cleanly (don't release task - keep in_progress)
  process.exit(0);
});
```

---

## Testing Strategy

### Unit Tests

| Test                                      | Coverage                    |
| ----------------------------------------- | --------------------------- |
| BeadsRunStateManager.getRunState          | All state combinations      |
| BeadsRunStateManager.createCircuitBreaker | CB creation and labeling    |
| BeadsWorkQueue.claimNextTask              | Priority ordering, claiming |
| BeadsWorkQueue.releaseTask                | Done/blocked transitions    |
| BeadsWorkQueue.recordHandoff              | Comment formatting          |

### Integration Tests

| Test                                 | Coverage                  |
| ------------------------------------ | ------------------------- |
| Full run lifecycle via beads         | start → sprint → complete |
| Circuit breaker trigger and recovery | halt → resume flow        |
| Work queue end-to-end                | claim → execute → release |
| Migration from .run/ to beads        | State preservation        |

### Manual Tests

1. Start a run with `/run sprint-plan`
2. Verify `br list --label run:current` shows the run
3. Kill the process mid-sprint
4. Verify circuit breaker created
5. Run `/run-resume` and verify continuation

---

## Security Considerations

1. **Shell escaping** - All user input to `br` commands is single-quote escaped
2. **Session isolation** - Each session has unique ID, no cross-contamination
3. **Timeout enforcement** - Sessions cannot run indefinitely
4. **Circuit breaker** - Prevents runaway failure loops

---

## Appendix

### Label Quick Reference

| Label                | Meaning                          |
| -------------------- | -------------------------------- |
| `run:current`        | Active run epic                  |
| `run:complete`       | Completed run                    |
| `sprint:N`           | Sprint number N                  |
| `sprint:in_progress` | Currently executing sprint       |
| `sprint:pending`     | Sprint waiting to start          |
| `sprint:complete`    | Finished sprint                  |
| `circuit-breaker`    | Halted due to failures           |
| `same-issue-Nx`      | Failed N times on same issue     |
| `ready`              | Task ready for claiming          |
| `in_progress`        | Task currently being worked      |
| `blocked`            | Task blocked by issue            |
| `done`               | Task completed                   |
| `session:<uuid>`     | Session that claimed/worked task |
| `handoff:<uuid>`     | Session that recorded handoff    |
| `epic:<id>`          | Task belongs to epic             |

### Glossary

| Term             | Definition                                         |
| ---------------- | -------------------------------------------------- |
| Bounded session  | Agent session with max 30-minute timeout           |
| Work queue       | Scheduler-driven task processor                    |
| Session handoff  | Protocol for preserving context between sessions   |
| Single-task mode | Agent processes exactly one task per invocation    |
| Circuit breaker  | Pattern that stops retries after repeated failures |
| State divergence | When parallel state systems have conflicting data  |

---

_Generated by Loa Simstim Workflow_
