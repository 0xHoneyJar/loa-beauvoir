/**
 * Beads Persistence Service
 *
 * Main entry point that orchestrates all beads persistence components.
 * Coordinates WAL recording, crash recovery, and scheduled maintenance.
 *
 * @module beads-persistence-service
 */

import type { Scheduler } from "../scheduler/scheduler.js";
import type { SegmentedWALManager } from "../wal/wal-manager.js";
import {
  BeadsRecoveryHandler,
  createBeadsRecoveryHandler,
  type RecoveryResult,
} from "./beads-recovery.js";
import { registerBeadsSchedulerTasks, type BeadsSchedulerConfig } from "./beads-scheduler-tasks.js";
import { BeadsWALAdapter, createBeadsWALAdapter, type BeadOperation } from "./beads-wal-adapter.js";

/**
 * Configuration for BeadsPersistenceService
 */
export interface BeadsPersistenceConfig {
  /** Master switch for all persistence features */
  enabled: boolean;
  /** Path to .beads directory */
  beadsDir: string;
  /** WAL-specific configuration */
  wal?: {
    /** Enable WAL recording (default: true) */
    enabled?: boolean;
    /** Replay WAL on start for crash recovery (default: true) */
    replayOnStart?: boolean;
    /** WAL path prefix */
    pathPrefix?: string;
    /** Enable verbose logging */
    verbose?: boolean;
  };
  /** Scheduler task configuration */
  scheduler?: BeadsSchedulerConfig;
  /** Command to run br (default: "br") */
  brCommand?: string;
}

/**
 * Health status of the service
 */
export interface BeadsPersistenceStatus {
  /** Whether service is fully initialized */
  initialized: boolean;
  /** Whether WAL adapter is active */
  walEnabled: boolean;
  /** Whether scheduler tasks are registered */
  schedulerEnabled: boolean;
  /** Last recovery result (if any) */
  lastRecovery?: RecoveryResult;
  /** Current WAL sequence number */
  walSeq?: number;
}

/**
 * Main service that coordinates beads persistence
 *
 * Provides:
 * - WAL integration for crash-resilient state transitions
 * - Automatic crash recovery on startup
 * - Scheduled health checks, auto-sync, and stale alerts
 * - Graceful degradation if components are unavailable
 */
export class BeadsPersistenceService {
  private readonly config: BeadsPersistenceConfig;
  private readonly walAdapter?: BeadsWALAdapter;
  private readonly recoveryHandler?: BeadsRecoveryHandler;
  private readonly scheduler?: Scheduler;
  private initialized = false;
  private lastRecovery?: RecoveryResult;

  /**
   * Create a new BeadsPersistenceService
   *
   * @param config - Service configuration
   * @param wal - Optional WALManager for crash recovery
   * @param scheduler - Optional Scheduler for maintenance tasks
   */
  constructor(config: BeadsPersistenceConfig, wal?: SegmentedWALManager, scheduler?: Scheduler) {
    this.config = config;
    this.scheduler = scheduler;

    if (!config.enabled) {
      console.log("[beads-persistence] Disabled by configuration");
      return;
    }

    // Initialize WAL adapter if WAL provided and enabled
    if (wal && config.wal?.enabled !== false) {
      this.walAdapter = createBeadsWALAdapter(wal, {
        pathPrefix: config.wal?.pathPrefix,
        verbose: config.wal?.verbose ?? process.env.DEBUG === "true",
      });

      this.recoveryHandler = createBeadsRecoveryHandler(this.walAdapter, {
        beadsDir: config.beadsDir,
        brCommand: config.brCommand,
        verbose: config.wal?.verbose ?? process.env.DEBUG === "true",
      });

      console.log("[beads-persistence] WAL adapter initialized");
    } else if (config.wal?.enabled !== false) {
      console.log("[beads-persistence] WAL not provided, running without crash recovery");
    }

    // Register scheduler tasks if scheduler provided
    if (scheduler) {
      registerBeadsSchedulerTasks(scheduler, {
        ...config.scheduler,
        beadsDir: config.beadsDir,
        brCommand: config.brCommand,
      });
    } else {
      console.log("[beads-persistence] Scheduler not provided, running without maintenance tasks");
    }
  }

  /**
   * Initialize service - call on startup
   *
   * Performs crash recovery if needed and marks service as ready.
   * Safe to call multiple times (idempotent).
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      console.log("[beads-persistence] Already initialized");
      return;
    }

    if (!this.config.enabled) {
      this.initialized = true;
      return;
    }

    // Check for and perform crash recovery if needed
    if (this.recoveryHandler && this.config.wal?.replayOnStart !== false) {
      try {
        const needsRecovery = await this.recoveryHandler.needsRecovery();

        if (needsRecovery) {
          console.log("[beads-persistence] Crash recovery needed, replaying WAL...");
          this.lastRecovery = await this.recoveryHandler.recover();

          if (this.lastRecovery.success) {
            console.log(
              `[beads-persistence] Recovery complete: ${this.lastRecovery.entriesReplayed} entries, ` +
                `${this.lastRecovery.beadsAffected.length} beads affected (${this.lastRecovery.durationMs}ms)`,
            );
          } else {
            console.error(`[beads-persistence] Recovery failed: ${this.lastRecovery.error}`);
            // Don't throw - let the service start in degraded mode
          }
        } else {
          console.log("[beads-persistence] No crash recovery needed");
        }
      } catch (e) {
        console.error(`[beads-persistence] Recovery check failed: ${e}`);
        // Don't throw - continue in degraded mode
      }
    }

    this.initialized = true;
    console.log("[beads-persistence] Initialized");
  }

  /**
   * Record a beads transition to WAL
   *
   * Call this before executing br commands to ensure crash recovery.
   * Safe to call even if WAL is not available (no-op).
   *
   * @param operation - Type of operation (create, update, close, etc.)
   * @param beadId - ID of the bead being modified
   * @param payload - Operation-specific data
   * @returns WAL sequence number, or -1 if WAL not available
   */
  async recordTransition(
    operation: BeadOperation,
    beadId: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    if (!this.walAdapter) {
      return -1;
    }

    try {
      return await this.walAdapter.recordTransition({
        operation,
        beadId,
        payload,
      });
    } catch (e) {
      // Log but don't block - SQLite write will still happen
      console.error(`[beads-persistence] Failed to record transition: ${e}`);
      return -1;
    }
  }

  /**
   * Convenience method for recording bead creation
   */
  async recordCreate(
    beadId: string,
    title: string,
    type: string,
    priority: number,
    description?: string,
  ): Promise<number> {
    return this.recordTransition("create", beadId, {
      title,
      type,
      priority,
      description,
    });
  }

  /**
   * Convenience method for recording bead update
   */
  async recordUpdate(beadId: string, updates: Record<string, unknown>): Promise<number> {
    return this.recordTransition("update", beadId, updates);
  }

  /**
   * Convenience method for recording bead close
   */
  async recordClose(beadId: string, reason?: string): Promise<number> {
    return this.recordTransition("close", beadId, { reason });
  }

  /**
   * Convenience method for recording label change
   */
  async recordLabel(
    beadId: string,
    action: "add" | "remove",
    labels: string | string[],
  ): Promise<number> {
    return this.recordTransition("label", beadId, {
      action,
      labels: Array.isArray(labels) ? labels : [labels],
    });
  }

  /**
   * Convenience method for recording comment
   */
  async recordComment(beadId: string, text: string): Promise<number> {
    return this.recordTransition("comment", beadId, { text });
  }

  /**
   * Check if service is healthy and ready
   */
  isHealthy(): boolean {
    return this.initialized;
  }

  /**
   * Get detailed status of the service
   */
  getStatus(): BeadsPersistenceStatus {
    return {
      initialized: this.initialized,
      walEnabled: this.walAdapter !== undefined,
      schedulerEnabled: this.scheduler !== undefined,
      lastRecovery: this.lastRecovery,
      walSeq: this.walAdapter?.getCurrentSeq(),
    };
  }

  /**
   * Manually trigger recovery (for testing or manual intervention)
   */
  async triggerRecovery(): Promise<RecoveryResult | undefined> {
    if (!this.recoveryHandler) {
      console.warn("[beads-persistence] Recovery handler not available");
      return undefined;
    }

    this.lastRecovery = await this.recoveryHandler.recover();
    return this.lastRecovery;
  }
}

/**
 * Factory function for creating BeadsPersistenceService
 */
export function createBeadsPersistenceService(
  config: BeadsPersistenceConfig,
  wal?: SegmentedWALManager,
  scheduler?: Scheduler,
): BeadsPersistenceService {
  return new BeadsPersistenceService(config, wal, scheduler);
}

/**
 * Create default configuration with optional overrides
 */
export function createDefaultBeadsConfig(
  overrides?: Partial<BeadsPersistenceConfig>,
): BeadsPersistenceConfig {
  return {
    enabled: true,
    beadsDir: ".beads",
    wal: {
      enabled: true,
      replayOnStart: true,
      verbose: false,
    },
    scheduler: {
      healthCheck: { enabled: true },
      autoSync: { enabled: true },
      staleCheck: { enabled: true },
    },
    brCommand: "br",
    ...overrides,
  };
}
