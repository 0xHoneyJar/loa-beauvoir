/**
 * Repair Module - Sandboxed self-repair with signed allowlists
 *
 * @module deploy/loa-identity/repair
 */

export {
  RepairEngine,
  createRepairEngine,
  type RepairAction,
  type RepairRequest,
  type RepairResult,
  type RepairApproval,
  type RepairEngineConfig,
} from './repair-engine.js';

export {
  DependencyDetector,
  createDependencyDetector,
  type DependencyIssue,
  type DependencyReport,
} from './dependency-detector.js';
