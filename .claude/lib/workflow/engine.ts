/**
 * @deprecated This module has been renamed to hardened-executor.ts to clarify
 * that it is a single-step hardened executor, not a multi-step workflow engine.
 * Import from "./hardened-executor.js" instead.
 *
 * This re-export shim exists for backwards compatibility and will be removed
 * in a future version.
 */

export {
  HardenedExecutor,
  HardenedExecutor as WorkflowEngine,
  WorkflowError,
  getStrategy,
  generateDedupKey,
  type HardenedExecutorConfig,
  type HardenedExecutorConfig as WorkflowEngineConfig,
  type StepDef,
  type StepResult,
  type StepExecutor,
  type DedupEntry,
  type IdempotencyIndex,
  type OperatingMode,
  type CompensationStrategy,
  type WorkflowErrorCode,
} from "./hardened-executor.js";
