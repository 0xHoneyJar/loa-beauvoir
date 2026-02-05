/**
 * Beads Scheduler Tasks
 *
 * Registers periodic maintenance tasks for beads with the OpenClaw scheduler.
 * Includes health checks, auto-sync, and stale issue detection.
 *
 * SECURITY: brCommand is validated to prevent command injection.
 * Only 'br' or absolute paths without shell metacharacters are allowed.
 *
 * @module beads-scheduler-tasks
 */

import { exec } from "child_process";
import { promisify } from "util";
import type { IBeadsRunStateManager } from "../../../.claude/lib/beads";
import type { Scheduler } from "../scheduler/scheduler.js";
import { validateBrCommand } from "../../../.claude/lib/beads";
import { BeadsWorkQueue, type WorkQueueConfig } from "./beads-work-queue.js";

const execAsync = promisify(exec);

/**
 * SECURITY: Validate staleDays is a safe integer
 */
function validateStaleDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error("Invalid staleDays: must be an integer between 1 and 365");
  }
}

/**
 * Configuration for beads scheduler tasks
 */
export interface BeadsSchedulerConfig {
  /** Health check task configuration */
  healthCheck?: {
    enabled?: boolean;
    intervalMs?: number;
    jitterMs?: number;
  };
  /** Auto-sync task configuration */
  autoSync?: {
    enabled?: boolean;
    intervalMs?: number;
    jitterMs?: number;
  };
  /** Stale issue check configuration */
  staleCheck?: {
    enabled?: boolean;
    intervalMs?: number;
    jitterMs?: number;
    staleDays?: number;
  };
  /** Work queue processing configuration (Phase 5) */
  workQueue?: {
    enabled?: boolean;
    intervalMs?: number;
    jitterMs?: number;
    sessionTimeoutMs?: number;
  };
  /** Path to .beads directory */
  beadsDir?: string;
  /** Command to run br */
  brCommand?: string;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: Required<BeadsSchedulerConfig> = {
  healthCheck: {
    enabled: true,
    intervalMs: 15 * 60 * 1000, // 15 minutes
    jitterMs: 60 * 1000, // 1 minute
  },
  autoSync: {
    enabled: true,
    intervalMs: 5 * 60 * 1000, // 5 minutes
    jitterMs: 30 * 1000, // 30 seconds
  },
  staleCheck: {
    enabled: true,
    intervalMs: 24 * 60 * 60 * 1000, // 24 hours
    jitterMs: 60 * 60 * 1000, // 1 hour
    staleDays: 7,
  },
  workQueue: {
    enabled: false, // Off by default, requires explicit enablement
    intervalMs: 5 * 60 * 1000, // 5 minutes (check for ready tasks)
    jitterMs: 30 * 1000, // 30 seconds
    sessionTimeoutMs: 30 * 60 * 1000, // 30 minute session windows
  },
  beadsDir: ".beads",
  brCommand: "br",
};

/**
 * Circuit breaker configuration for beads tasks
 */
const CIRCUIT_BREAKER_CONFIG = {
  maxFailures: 3,
  resetTimeMs: 5 * 60 * 1000, // 5 minutes
  halfOpenRetries: 1,
};

/**
 * Relaxed circuit breaker for daily tasks
 */
const DAILY_CIRCUIT_BREAKER_CONFIG = {
  maxFailures: 3,
  resetTimeMs: 60 * 60 * 1000, // 1 hour reset for daily task
  halfOpenRetries: 1,
};

/**
 * Register beads maintenance tasks with the scheduler
 *
 * Tasks registered:
 * - beads_health: Runs `br doctor` every 15 minutes
 * - beads_sync: Runs `br sync --flush-only` every 5 minutes
 * - beads_stale_check: Reports stale issues every 24 hours
 *
 * @param scheduler - OpenClaw Scheduler instance
 * @param config - Optional configuration overrides
 */
export function registerBeadsSchedulerTasks(
  scheduler: Scheduler,
  config?: BeadsSchedulerConfig,
): void {
  const cfg = mergeConfig(DEFAULT_CONFIG, config);

  // SECURITY: Validate configuration before registering tasks
  validateBrCommand(cfg.brCommand);
  if (cfg.staleCheck.staleDays !== undefined) {
    validateStaleDays(cfg.staleCheck.staleDays);
  }

  // Health check task
  if (cfg.healthCheck.enabled) {
    scheduler.register({
      id: "beads_health",
      name: "Beads Health Check",
      intervalMs: cfg.healthCheck.intervalMs!,
      jitterMs: cfg.healthCheck.jitterMs,
      handler: createHealthCheckHandler(cfg.brCommand, cfg.beadsDir),
      circuitBreaker: CIRCUIT_BREAKER_CONFIG,
    });

    console.log(
      `[beads-scheduler] Registered beads_health (interval: ${cfg.healthCheck.intervalMs! / 1000}s)`,
    );
  }

  // Auto-sync task (in mutex group with git_sync)
  if (cfg.autoSync.enabled) {
    scheduler.register({
      id: "beads_sync",
      name: "Beads Auto Sync",
      intervalMs: cfg.autoSync.intervalMs!,
      jitterMs: cfg.autoSync.jitterMs,
      handler: createSyncHandler(cfg.brCommand, cfg.beadsDir),
      mutexGroup: "sync", // Prevents concurrent git_sync operations
      circuitBreaker: CIRCUIT_BREAKER_CONFIG,
    });

    console.log(
      `[beads-scheduler] Registered beads_sync (interval: ${cfg.autoSync.intervalMs! / 1000}s, mutex: sync)`,
    );
  }

  // Stale issue check task
  if (cfg.staleCheck.enabled) {
    scheduler.register({
      id: "beads_stale_check",
      name: "Beads Stale Check",
      intervalMs: cfg.staleCheck.intervalMs!,
      jitterMs: cfg.staleCheck.jitterMs,
      handler: createStaleCheckHandler(cfg.brCommand, cfg.beadsDir, cfg.staleCheck.staleDays!),
      circuitBreaker: DAILY_CIRCUIT_BREAKER_CONFIG,
    });

    console.log(
      `[beads-scheduler] Registered beads_stale_check (interval: ${cfg.staleCheck.intervalMs! / (60 * 60 * 1000)}h, staleDays: ${cfg.staleCheck.staleDays})`,
    );
  }

  console.log("[beads-scheduler] Beads maintenance tasks registered");
}

/**
 * Register work queue processing task with the scheduler (Phase 5)
 *
 * This task periodically checks for ready tasks and triggers agent sessions
 * to process them in bounded time windows.
 *
 * @param scheduler - OpenClaw Scheduler instance
 * @param workQueue - BeadsWorkQueue instance
 * @param config - Optional configuration overrides
 */
export function registerWorkQueueTask(
  scheduler: Scheduler,
  workQueue: BeadsWorkQueue,
  config?: BeadsSchedulerConfig,
): void {
  const cfg = mergeConfig(DEFAULT_CONFIG, config);

  if (!cfg.workQueue.enabled) {
    console.log("[beads-scheduler] Work queue task disabled");
    return;
  }

  // Use the work queue's own register method which provides the handler
  workQueue.register(scheduler);

  console.log(
    `[beads-scheduler] Registered beads_work_queue (interval: ${cfg.workQueue.intervalMs! / 1000}s, session timeout: ${cfg.workQueue.sessionTimeoutMs! / (60 * 1000)}min)`,
  );
}

/**
 * Create handler for health check task
 */
function createHealthCheckHandler(brCommand: string, beadsDir: string): () => Promise<void> {
  return async () => {
    try {
      // Try JSON output first
      const { stdout } = await execAsync(`${brCommand} doctor --json`, {
        cwd: beadsDir,
        timeout: 30000,
      });

      const status = JSON.parse(stdout);

      if (status.status !== "healthy") {
        console.warn(`[beads-scheduler] Health check warning: ${status.message}`);
        throw new Error(`Beads unhealthy: ${status.message}`);
      }

      console.log("[beads-scheduler] Health check passed");
    } catch (e) {
      // br doctor might not have --json flag, try without
      try {
        const { stdout } = await execAsync(`${brCommand} doctor`, {
          cwd: beadsDir,
          timeout: 30000,
        });

        if (stdout.includes("ERROR") || stdout.includes("FAIL")) {
          throw new Error(`Beads unhealthy: ${stdout}`);
        }

        console.log("[beads-scheduler] Health check passed (text mode)");
      } catch (textError) {
        // If br doctor command doesn't exist, consider healthy (beads not initialized)
        const errorMessage = String(textError);
        if (errorMessage.includes("command not found") || errorMessage.includes("ENOENT")) {
          console.log("[beads-scheduler] Health check skipped (br not available)");
          return;
        }
        throw textError;
      }
    }
  };
}

/**
 * Create handler for auto-sync task
 */
function createSyncHandler(brCommand: string, beadsDir: string): () => Promise<void> {
  return async () => {
    try {
      await execAsync(`${brCommand} sync --flush-only`, {
        cwd: beadsDir,
        timeout: 60000, // 1 minute timeout for sync
      });

      console.log("[beads-scheduler] Auto sync completed");
    } catch (e) {
      const errorMessage = String(e);

      // If br not available, skip gracefully
      if (errorMessage.includes("command not found") || errorMessage.includes("ENOENT")) {
        console.log("[beads-scheduler] Sync skipped (br not available)");
        return;
      }

      // If no changes to sync, that's fine
      if (errorMessage.includes("nothing to sync")) {
        console.log("[beads-scheduler] No changes to sync");
        return;
      }

      throw e;
    }
  };
}

/**
 * Create handler for stale issue check task
 */
function createStaleCheckHandler(
  brCommand: string,
  beadsDir: string,
  staleDays: number,
): () => Promise<void> {
  return async () => {
    try {
      // Try to get stale issues
      const { stdout } = await execAsync(`${brCommand} stale --days ${staleDays} --json`, {
        cwd: beadsDir,
        timeout: 30000,
      });

      const staleIssues = JSON.parse(stdout);

      if (Array.isArray(staleIssues) && staleIssues.length > 0) {
        console.warn(
          `[beads-scheduler] Found ${staleIssues.length} stale issues (>${staleDays} days old):`,
        );

        // Show first 5
        for (const issue of staleIssues.slice(0, 5)) {
          console.warn(`  - ${issue.id}: ${issue.title}`);
        }

        if (staleIssues.length > 5) {
          console.warn(`  ... and ${staleIssues.length - 5} more`);
        }
      } else {
        console.log("[beads-scheduler] No stale issues found");
      }
    } catch (e) {
      const errorMessage = String(e);

      // br stale might not exist, skip gracefully
      if (
        errorMessage.includes("command not found") ||
        errorMessage.includes("ENOENT") ||
        errorMessage.includes("Unknown command") ||
        errorMessage.includes("no such subcommand")
      ) {
        console.log("[beads-scheduler] Stale check skipped (command not available)");
        return;
      }

      // Empty result is fine
      if (errorMessage.includes("No issues found")) {
        console.log("[beads-scheduler] No stale issues found");
        return;
      }

      throw e;
    }
  };
}

/**
 * Merge user config with defaults
 */
function mergeConfig(
  defaults: Required<BeadsSchedulerConfig>,
  overrides?: BeadsSchedulerConfig,
): Required<BeadsSchedulerConfig> {
  if (!overrides) return defaults;

  return {
    healthCheck: {
      ...defaults.healthCheck,
      ...overrides.healthCheck,
    },
    autoSync: {
      ...defaults.autoSync,
      ...overrides.autoSync,
    },
    staleCheck: {
      ...defaults.staleCheck,
      ...overrides.staleCheck,
    },
    workQueue: {
      ...defaults.workQueue,
      ...overrides.workQueue,
    },
    beadsDir: overrides.beadsDir ?? defaults.beadsDir,
    brCommand: overrides.brCommand ?? defaults.brCommand,
  };
}

/**
 * Unregister all beads tasks from scheduler
 *
 * Useful for cleanup or reconfiguration
 */
export function unregisterBeadsSchedulerTasks(scheduler: Scheduler): void {
  const beadsTasks = ["beads_health", "beads_sync", "beads_stale_check", "beads_work_queue"];

  for (const taskId of beadsTasks) {
    try {
      scheduler.disable(taskId);
      console.log(`[beads-scheduler] Disabled ${taskId}`);
    } catch {
      // Task might not exist
    }
  }
}

/**
 * Get status of all beads scheduler tasks
 */
export function getBeadsSchedulerStatus(scheduler: Scheduler): Array<{
  id: string;
  name: string;
  status: string;
  lastRun: string | null;
  consecutiveFailures: number;
}> {
  const allTasks = scheduler.getStatus();
  const beadsTasks = ["beads_health", "beads_sync", "beads_stale_check", "beads_work_queue"];

  return allTasks
    .filter((task) => beadsTasks.includes(task.id))
    .map((task) => ({
      id: task.id,
      name: task.name,
      status: task.status,
      lastRun: task.lastRun,
      consecutiveFailures: task.consecutiveFailures,
    }));
}
