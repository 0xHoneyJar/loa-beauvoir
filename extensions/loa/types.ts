/**
 * LOA Plugin Types
 *
 * Type definitions for LOA identity, memory, and recovery integration.
 * Aligns with existing deploy/loa-identity exports.
 */

import type {
  IdentityLoader,
  SessionMemoryManager,
  RecoveryEngine,
  PIIRedactor,
  AuditLogger,
} from '../../deploy/loa-identity/index.js';

/**
 * LOA plugin configuration
 */
export interface LoaConfig {
  /** Path to grimoires directory (default: 'grimoires/loa') */
  grimoiresDir: string;
  /** Path to WAL directory for memory persistence */
  walDir: string;
  /** Enable LOA identity system (default: true in this fork) */
  enabled: boolean;
  /** R2 mount path for recovery (optional) */
  r2MountPath?: string;
}

/**
 * LOA plugin state - tracks runtime status
 */
export interface LoaPluginState {
  /** Whether LOA is currently active and controlling the agent */
  isActive: boolean;
  /** Whether the plugin is in degraded mode (after recovery failures) */
  isDegraded: boolean;
  /** Last successful SOUL.md generation timestamp */
  lastSoulGeneration?: Date;
  /** Recovery attempt count in current window */
  recoveryAttempts: number;
  /** Recovery window start timestamp */
  recoveryWindowStart?: Date;
  /** Last error message if in degraded mode */
  lastError?: string;
}

/**
 * LOA context - contains all initialized LOA systems
 */
export interface LoaContext {
  /** Plugin configuration */
  config: LoaConfig;
  /** Plugin state */
  state: LoaPluginState;
  /** Identity loader for BEAUVOIR.md parsing */
  identity: IdentityLoader;
  /** Memory manager for session capture */
  memory: SessionMemoryManager;
  /** Recovery engine for auto-repair */
  recovery: RecoveryEngine;
  /** PII redactor for memory sanitization */
  redactor: PIIRedactor;
  /** Audit logger for tracking operations */
  auditLogger: AuditLogger;
  /** Soul generator for BEAUVOIR.md -> SOUL.md transformation */
  soulGenerator: SoulGenerator;
  /** Retry queue for failed memory captures */
  retryQueue: RetryQueue;
  /** Loop detector for recovery attempt tracking */
  loopDetector: LoopDetector;
}

/**
 * Soul generator interface for BEAUVOIR.md -> SOUL.md transformation
 */
export interface SoulGenerator {
  /** Generate SOUL.md from BEAUVOIR.md */
  generate(): Promise<SoulGenerationResult>;
  /** Get the checksum of current BEAUVOIR.md */
  getBeauvoirChecksum(): Promise<string>;
  /** Check if SOUL.md needs regeneration */
  needsRegeneration(): Promise<boolean>;
}

/**
 * Result of SOUL.md generation
 */
export interface SoulGenerationResult {
  /** Whether generation succeeded */
  success: boolean;
  /** Path to generated SOUL.md */
  soulPath?: string;
  /** Checksum embedded in SOUL.md footer */
  checksum?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Retry queue for failed operations
 */
export interface RetryQueue {
  /** Add an operation to the retry queue */
  enqueue(operation: RetryOperation): void;
  /** Process pending retries (called periodically) */
  process(): Promise<void>;
  /** Get pending retry count */
  getPendingCount(): number;
  /** Clear all pending retries */
  clear(): void;
}

/**
 * Operation to retry
 */
export interface RetryOperation {
  /** Operation type */
  type: 'memory_capture' | 'soul_generation' | 'recovery';
  /** Operation payload */
  payload: unknown;
  /** Number of attempts so far */
  attempts: number;
  /** Max attempts before giving up */
  maxAttempts: number;
  /** Timestamp of last attempt */
  lastAttempt?: Date;
  /** Error from last attempt */
  lastError?: string;
}

/**
 * Loop detector for recovery attempt tracking
 */
export interface LoopDetector {
  /** Record a recovery attempt */
  recordAttempt(): void;
  /** Check if we're in a recovery loop */
  isInLoop(): boolean;
  /** Get current attempt count in window */
  getAttemptCount(): number;
  /** Reset the detector (on successful recovery) */
  reset(): void;
}

/**
 * Bootstrap hook result
 */
export interface BootstrapResult {
  /** Whether bootstrap succeeded */
  success: boolean;
  /** Whether agent should start (even if in degraded mode) */
  shouldStart: boolean;
  /** Whether LOA is fully operational */
  loaActive: boolean;
  /** Error message if bootstrap failed */
  error?: string;
}

/**
 * Memory capture event data
 */
export interface MemoryCaptureEvent {
  /** Conversation messages */
  messages: unknown[];
  /** Whether the conversation was successful */
  success: boolean;
  /** Duration of the conversation in ms */
  durationMs?: number;
  /** Agent ID */
  agentId?: string;
  /** Session key */
  sessionKey?: string;
}

/**
 * Context injection result
 */
export interface ContextInjectionResult {
  /** Context to prepend to system prompt */
  prependContext?: string;
  /** Whether injection was successful */
  success: boolean;
  /** Token count of injected context */
  tokenCount?: number;
}

/**
 * Quality gate result for memory capture
 */
export interface QualityGateResult {
  /** Whether content passed all gates */
  passed: boolean;
  /** Which gates failed */
  failedGates: string[];
  /** Filtered/processed content */
  content?: string;
}

/**
 * Input sanitization result for context injection
 */
export interface SanitizationResult {
  /** Sanitized content */
  content: string;
  /** Whether any dangerous patterns were found */
  hadDangerousPatterns: boolean;
  /** Patterns that were removed/escaped */
  removedPatterns: string[];
}
