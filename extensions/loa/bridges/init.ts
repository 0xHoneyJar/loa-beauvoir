/**
 * Init Bridge
 *
 * Initializes LOA systems from existing deploy/loa-identity.
 * Validates all imports resolve correctly at init time.
 *
 * Sprint Task 1.5 - Flatline: Import validation
 */

import type { LoaConfig } from '../types.js';
import type { PluginLogger } from '../../../src/plugins/types.js';
import { createRetryQueue } from '../state/retry-queue.js';
import { createLoopDetector } from '../state/loop-detector.js';

// Re-export types we use
export type {
  IdentityLoader,
  SessionMemoryManager,
  RecoveryEngine,
  PIIRedactor,
  AuditLogger,
} from '../../../deploy/loa-identity/index.js';

/**
 * Import validation error
 */
export class ImportValidationError extends Error {
  constructor(
    message: string,
    public readonly module: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImportValidationError';
  }
}

/**
 * Validate that all required imports from deploy/loa-identity resolve correctly.
 * Fail fast if module resolution fails (ESM/CJS mismatch, missing exports).
 */
async function validateImports(logger: PluginLogger): Promise<void> {
  const requiredExports = [
    'createIdentityLoader',
    'createSessionMemoryManager',
    'createRecoveryEngine',
    'PIIRedactor',
    'AuditLogger',
    'createSegmentedWALManager',
  ];

  try {
    // Dynamic import to test resolution
    const loaIdentity = await import('../../../deploy/loa-identity/index.js');

    // Validate all required exports exist
    const missing: string[] = [];
    for (const exportName of requiredExports) {
      if (!(exportName in loaIdentity)) {
        missing.push(exportName);
      }
    }

    if (missing.length > 0) {
      throw new ImportValidationError(
        `Missing exports from deploy/loa-identity: ${missing.join(', ')}`,
        'deploy/loa-identity',
      );
    }

    logger.info?.('[loa] Import validation passed');
  } catch (err) {
    if (err instanceof ImportValidationError) {
      throw err;
    }
    throw new ImportValidationError(
      `Failed to import deploy/loa-identity: ${err instanceof Error ? err.message : String(err)}`,
      'deploy/loa-identity',
      err,
    );
  }
}

/**
 * Initialize LOA systems from deploy/loa-identity
 */
export async function initializeLoa(
  config: LoaConfig,
  workspaceDir: string,
  logger: PluginLogger,
): Promise<{
  identity: import('../../../deploy/loa-identity/index.js').IdentityLoader;
  memory: import('../../../deploy/loa-identity/index.js').SessionMemoryManager;
  recovery: import('../../../deploy/loa-identity/index.js').RecoveryEngine;
  redactor: import('../../../deploy/loa-identity/index.js').PIIRedactor;
  auditLogger: import('../../../deploy/loa-identity/index.js').AuditLogger;
  retryQueue: ReturnType<typeof createRetryQueue>;
  loopDetector: ReturnType<typeof createLoopDetector>;
}> {
  // Validate imports first - fail fast on ESM/CJS issues
  await validateImports(logger);

  // Now import the modules we need
  const {
    createIdentityLoader,
    createSessionMemoryManager,
    createRecoveryEngine,
    PIIRedactor,
    AuditLogger,
    ManifestSigner,
    createSegmentedWALManager,
  } = await import('../../../deploy/loa-identity/index.js');

  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  // Resolve paths relative to workspace
  const grimoiresPath = path.resolve(workspaceDir, config.grimoiresDir);
  const walPath = path.resolve(workspaceDir, config.walDir);

  // Ensure directories exist
  await fs.mkdir(grimoiresPath, { recursive: true });
  await fs.mkdir(walPath, { recursive: true });

  logger.info?.(`[loa] Grimoires path: ${grimoiresPath}`);
  logger.info?.(`[loa] WAL path: ${walPath}`);

  // Initialize audit logger
  const auditLogPath = path.join(walPath, 'audit.log');
  const auditLogger = new AuditLogger(auditLogPath);
  await auditLogger.initialize();

  // Initialize identity loader
  const identity = createIdentityLoader(workspaceDir);
  await identity.load();

  // Initialize WAL manager
  const walManager = createSegmentedWALManager(path.join(walPath, 'segments'));
  await walManager.initialize();

  // Initialize PII redactor
  const redactor = new PIIRedactor();

  // Initialize session memory manager
  const memory = createSessionMemoryManager(walManager, redactor, auditLogger);

  // Initialize recovery engine
  const manifestSigner = new ManifestSigner();
  const recovery = createRecoveryEngine(grimoiresPath, manifestSigner, auditLogger);

  // Create retry queue for failed operations
  const retryQueue = createRetryQueue(logger);

  // Create loop detector for recovery tracking
  const loopDetector = createLoopDetector();

  return {
    identity,
    memory,
    recovery,
    redactor,
    auditLogger,
    retryQueue,
    loopDetector,
  };
}
