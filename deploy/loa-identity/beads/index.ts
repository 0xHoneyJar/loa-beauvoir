/**
 * Beads Persistence Module
 *
 * Integrates Loa's beads_rust task management with OpenClaw's persistence
 * infrastructure for crash-resilient, cloud-backed task state.
 *
 * @module beads
 *
 * @example
 * ```typescript
 * import {
 *   createBeadsPersistenceService,
 *   createDefaultBeadsConfig
 * } from './beads/index.js';
 *
 * const service = createBeadsPersistenceService(
 *   createDefaultBeadsConfig(),
 *   walManager,
 *   scheduler
 * );
 *
 * await service.initialize();
 *
 * // Record transitions before br commands
 * await service.recordCreate('bead-123', 'New task', 'task', 2);
 * ```
 */

// WAL Adapter
export {
  BeadsWALAdapter,
  createBeadsWALAdapter,
  type BeadWALEntry,
  type BeadOperation,
  type BeadsWALConfig,
} from "./beads-wal-adapter.js";

// Recovery Handler
export {
  BeadsRecoveryHandler,
  createBeadsRecoveryHandler,
  type RecoveryResult,
  type BeadsRecoveryConfig,
} from "./beads-recovery.js";

// Scheduler Tasks
export {
  registerBeadsSchedulerTasks,
  unregisterBeadsSchedulerTasks,
  getBeadsSchedulerStatus,
  type BeadsSchedulerConfig,
} from "./beads-scheduler-tasks.js";

// Main Service
export {
  BeadsPersistenceService,
  createBeadsPersistenceService,
  createDefaultBeadsConfig,
  type BeadsPersistenceConfig,
  type BeadsPersistenceStatus,
} from "./beads-persistence-service.js";

// Run State Manager (Phase 4)
export {
  BeadsRunStateManager,
  createBeadsRunStateManager,
  LABELS,
  type RunState,
  type SprintState,
  type CircuitBreakerRecord,
  type MigrationResult,
  type BeadsRunStateConfig,
} from "./beads-run-state.js";
