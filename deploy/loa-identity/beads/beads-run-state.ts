/**
 * Beads Run State Manager
 *
 * Re-exports upstream BeadsRunStateManager from .claude/lib/beads.
 * This file provides backwards compatibility for existing imports.
 *
 * @module beads-run-state
 */

// =============================================================================
// Re-export everything from upstream
// =============================================================================

export {
  // Manager class
  BeadsRunStateManager,
  createBeadsRunStateManager,
} from "../../../.claude/lib/beads";

// =============================================================================
// Re-export types from upstream
// =============================================================================

export type {
  SprintState,
  CircuitBreakerRecord,
  MigrationResult,
  BeadsRunStateConfig,
} from "../../../.claude/lib/beads";

// =============================================================================
// Re-export LABELS with optional extensions
// =============================================================================

import { LABELS as BASE_LABELS, type RunState } from "../../../.claude/lib/beads";

/**
 * Label schema for run state management.
 * Extends upstream LABELS with project-specific labels for backward compatibility.
 */
export const LABELS = {
  ...BASE_LABELS,

  // -------------------------------------------------------------------------
  // Run Lifecycle (extending upstream)
  // -------------------------------------------------------------------------
  /**
   * Marks a run as complete.
   */
  RUN_COMPLETE: "run:complete",

  // -------------------------------------------------------------------------
  // Sprint State (prefixes for compatibility)
  // -------------------------------------------------------------------------
  /**
   * Prefix for sprint labels.
   */
  SPRINT_PREFIX: "sprint:",

  // -------------------------------------------------------------------------
  // Task State Labels (for work queue)
  // -------------------------------------------------------------------------
  /**
   * Task is ready for work (no blockers).
   */
  TASK_READY: "ready",

  /**
   * Task is currently being worked on.
   */
  TASK_IN_PROGRESS: "in_progress",

  /**
   * Task is blocked by dependencies.
   */
  TASK_BLOCKED: "blocked",

  /**
   * Task has been completed.
   */
  TASK_DONE: "done",
} as const;

// Re-export RunState type
export type { RunState };
