/**
 * Loa Cloud Stack - Persistence Types
 *
 * Type definitions for WAL (Write-Ahead Log) and state persistence.
 */

// =============================================================================
// WAL (Write-Ahead Log) Types
// =============================================================================

/**
 * Operations that can be recorded in the WAL
 */
export type WALOperation = 'write' | 'delete' | 'mkdir';

/**
 * A single entry in the Write-Ahead Log
 */
export interface WALEntry {
  /** Unix timestamp in milliseconds */
  ts: number;

  /** Sequence number for ordering (monotonically increasing) */
  seq: number;

  /** Operation type */
  op: WALOperation;

  /** Path relative to grimoires/ */
  path: string;

  /** SHA-256 checksum of content (for write ops) */
  checksum?: string;

  /** Base64-encoded content (for write ops) */
  data?: string;

  /** Timestamp when synced to R2 (null if not yet synced) */
  synced_r2?: number;

  /** Timestamp when synced to git (null if not yet synced) */
  synced_git?: number;
}

/**
 * WAL checkpoint - tracks sync state
 */
export interface WALCheckpoint {
  /** Last sequence number synced to R2 */
  last_r2_seq: number;

  /** Last sequence number synced to git */
  last_git_seq: number;

  /** Timestamp of last R2 sync */
  last_r2_sync?: string;

  /** Timestamp of last git sync */
  last_git_sync?: string;

  /** Current WAL file path */
  current_wal: string;

  /** Total entries in current WAL */
  entry_count: number;
}

// =============================================================================
// State Sync Types
// =============================================================================

/**
 * State sync status for monitoring
 */
export interface SyncStatus {
  /** WAL status */
  wal: {
    entries_pending_r2: number;
    entries_pending_git: number;
    last_write: string | null;
  };

  /** R2 sync status */
  r2: {
    connected: boolean;
    last_sync: string | null;
    bytes_synced: number;
  };

  /** Git sync status */
  git: {
    last_sync: string | null;
    last_commit: string | null;
    pending_changes: number;
  };
}

// =============================================================================
// Compound Learning Types (Preview for Sprint 5)
// =============================================================================

/**
 * Quality gate scores (0-10 scale)
 */
export interface QualityGates {
  /** G1: Is the solution non-trivial? */
  discovery_depth: number;

  /** G2: Is the pattern generalizable? */
  reusability: number;

  /** G3: Can we identify when this applies? */
  trigger_clarity: number;

  /** G4: Was the solution verified to work? */
  verification: number;
}

/**
 * Source of a learning extraction
 */
export type LearningSource = 'sprint' | 'error-cycle' | 'retrospective';

/**
 * Target repository for a learning
 */
export type LearningTarget = 'loa' | 'devcontainer' | 'moltworker' | 'openclaw';

/**
 * Lifecycle status of a learning
 */
export type LearningStatus = 'pending' | 'approved' | 'active' | 'archived';

/**
 * A compound learning entry
 */
export interface Learning {
  /** Unique identifier */
  id: string;

  /** ISO timestamp when created */
  created: string;

  /** How was this learning discovered? */
  source: LearningSource;

  // Content
  /** When does this learning apply? */
  trigger: string;

  /** What's the pattern? */
  pattern: string;

  /** What's the solution? */
  solution: string;

  /** Quality gate scores */
  gates: QualityGates;

  /** Which repository does this improve? */
  target: LearningTarget;

  /** Current lifecycle status */
  status: LearningStatus;

  /** Who approved this learning (for self-improvement) */
  approved_by?: string;

  /** When was this approved */
  approved_at?: string;

  /** Effectiveness tracking (Phase 2) */
  effectiveness?: {
    applications: number;
    successes: number;
    failures: number;
    last_applied?: string;
  };
}

/**
 * Store for all learnings
 */
export interface LearningsStore {
  /** Schema version */
  version: string;

  /** All learnings */
  learnings: Learning[];
}
