/**
 * Memory Module - Session capture, quality filtering, and consolidation
 *
 * @module deploy/loa-identity/memory
 */

export {
  SessionMemoryManager,
  createSessionMemoryManager,
  type MemoryEntry,
  type QualityGate,
  type SessionManagerConfig,
} from './session-manager.js';

export {
  temporalGate,
  speculationGate,
  instructionGate,
  confidenceGate,
  contentQualityGate,
  technicalContentGate,
  createDefaultQualityGates,
  applyQualityGates,
  QualityThresholds,
  type QualityCheckResult,
  type GateMetadata,
  type QualityThresholdLevel,
} from './quality-gates.js';

export {
  EmbeddingClient,
  createEmbeddingClient,
  type EmbeddingResponse,
  type SimilarityResponse,
  type BatchSimilarityResponse,
  type HealthResponse,
  type EmbeddingClientConfig,
  type ServiceStatus,
} from './embedding-client.js';

export {
  ConsolidationEngine,
  createConsolidationEngine,
  type ConsolidatedMemory,
  type SessionMemory,
  type ConsolidationResult,
  type ConsolidationEngineConfig,
} from './consolidation-engine.js';

export {
  ConsolidationQueue,
  createConsolidationQueue,
  type QueuedConsolidation,
  type ConsolidationQueueConfig,
} from './consolidation-queue.js';

// Context Tracking (FR-10)
export {
  ContextTracker,
  createContextTracker,
  createContextTrackerFromEnv,
  type ContextThresholds,
  type ContextStatus,
  type ContextStatusLevel,
  type ContextCheckResult,
  type ContextHistoryEntry,
} from './context-tracker.js';
