/**
 * Loa Identity Layer - Beauvoir Resilience System
 *
 * Main entry point for the Loa identity system.
 *
 * @module deploy/loa-identity
 */

// Security
export {
  AuditLogger,
  ManifestSigner,
  AllowlistSigner,
  PIIRedactor,
  SecretScanner,
  CredentialManager,
  KeyManager,
  generateKeyPair,
  getCredentialManager,
  createKeyManager,
  runPreCommitHook,
} from "./security/index.js";

// WAL
export { SegmentedWALManager, createSegmentedWALManager } from "./wal/index.js";

// Memory
export {
  SessionMemoryManager,
  ConsolidationEngine,
  ConsolidationQueue,
  EmbeddingClient,
  createSessionMemoryManager,
  createConsolidationEngine,
  createConsolidationQueue,
  createEmbeddingClient,
  createDefaultQualityGates,
  applyQualityGates,
} from "./memory/index.js";

// Recovery
export {
  RecoveryEngine,
  R2Client,
  GitClient,
  createRecoveryEngine,
  createR2ClientFromMount,
  createR2ClientFromEnv,
  createGitClient,
  createGitClientFromEnv,
  runRecoveryEngine,
} from "./recovery/index.js";

// Repair
export {
  RepairEngine,
  DependencyDetector,
  createRepairEngine,
  createDependencyDetector,
} from "./repair/index.js";

// Scheduler
export { Scheduler, createBeauvoirScheduler } from "./scheduler/index.js";

// Identity (from portable persistence framework)
export {
  IdentityLoader,
  createIdentityLoader,
} from "../../.claude/lib/persistence/identity/identity-loader.js";

// Beads Persistence
export {
  BeadsWALAdapter,
  BeadsRecoveryHandler,
  BeadsPersistenceService,
  createBeadsWALAdapter,
  createBeadsRecoveryHandler,
  createBeadsPersistenceService,
  createDefaultBeadsConfig,
  registerBeadsSchedulerTasks,
  unregisterBeadsSchedulerTasks,
  getBeadsSchedulerStatus,
  type BeadWALEntry,
  type BeadOperation,
  type BeadsWALConfig,
  type RecoveryResult,
  type BeadsRecoveryConfig,
  type BeadsSchedulerConfig,
  type BeadsPersistenceConfig,
  type BeadsPersistenceOpts,
  type BeadsPersistenceStatus,
} from "./beads/index.js";

/**
 * Initialize the complete Loa identity system
 */
export async function initializeLoa(config: {
  grimoiresDir: string;
  walDir: string;
  r2MountPath?: string;
  beads?: {
    enabled?: boolean;
    beadsDir?: string;
    scheduler?: import("./beads/index.js").BeadsSchedulerConfig;
  };
}): Promise<{
  identity: import("../../.claude/lib/persistence/identity/identity-loader.js").IdentityLoader;
  recovery: import("./recovery/index.js").RecoveryEngine;
  memory: import("./memory/index.js").SessionMemoryManager;
  scheduler: import("./scheduler/index.js").Scheduler;
  beads?: import("./beads/index.js").BeadsPersistenceService;
  /** Idempotent shutdown — caller registers signal handlers */
  shutdown: () => void;
}> {
  const { grimoiresDir, walDir, r2MountPath, beads: beadsConfig } = config;

  // Import modules
  const { createIdentityLoader } =
    await import("../../.claude/lib/persistence/identity/identity-loader.js");
  const { ManifestSigner } = await import("./security/index.js");
  const { AuditLogger } = await import("./security/index.js");
  const { createRecoveryEngine } = await import("./recovery/index.js");
  const { createSegmentedWALManager } = await import("./wal/index.js");
  const { PIIRedactor } = await import("./security/index.js");
  const { createSessionMemoryManager } = await import("./memory/index.js");
  const { createBeauvoirScheduler } = await import("./scheduler/index.js");

  // Initialize audit logger
  const auditLogger = new AuditLogger(`${walDir}/audit.log`);
  await auditLogger.initialize();

  // Initialize recovery engine
  const manifestSigner = new ManifestSigner();
  const recovery = createRecoveryEngine(grimoiresDir, manifestSigner, auditLogger);

  // Run recovery
  await recovery.run();

  // Initialize identity loader
  const identity = createIdentityLoader(grimoiresDir.replace("/grimoires", ""));
  await identity.load();

  // Initialize WAL and memory
  const walManager = createSegmentedWALManager(`${walDir}/segments`);
  await walManager.initialize();

  const redactor = new PIIRedactor();
  const memory = createSessionMemoryManager(walManager, redactor, auditLogger);

  // Initialize scheduler
  const scheduler = createBeauvoirScheduler({
    consolidateMemory: async () => {
      console.log("[loa] Consolidation triggered (placeholder)");
    },
    syncToR2: async () => {
      console.log("[loa] R2 sync triggered (placeholder)");
    },
    syncToGit: async () => {
      console.log("[loa] Git sync triggered (placeholder)");
    },
    healthCheck: async () => {
      console.log("[loa] Health check triggered (placeholder)");
    },
  });

  // Initialize beads persistence (if enabled)
  let beadsPersistence: import("./beads/index.js").BeadsPersistenceService | undefined;

  if (beadsConfig?.enabled !== false) {
    const { createBeadsPersistenceService, createDefaultBeadsConfig, createBeadsRunStateManager } =
      await import("./beads/index.js");

    const runStateManager = createBeadsRunStateManager({ verbose: false });

    // Single source of truth for scheduler config — normalize once, pass everywhere
    const schedulerConfig = {
      healthCheck: { enabled: true, ...beadsConfig?.scheduler?.healthCheck },
      autoSync: { enabled: true, ...beadsConfig?.scheduler?.autoSync },
      staleCheck: { enabled: true, ...beadsConfig?.scheduler?.staleCheck },
      workQueue: { enabled: false, ...beadsConfig?.scheduler?.workQueue },
    };

    beadsPersistence = createBeadsPersistenceService(
      createDefaultBeadsConfig({
        enabled: beadsConfig?.enabled ?? true,
        beadsDir: beadsConfig?.beadsDir ?? ".beads",
        scheduler: schedulerConfig,
      }),
      { wal: walManager, scheduler, runStateManager },
    );

    try {
      await beadsPersistence.initialize();
      scheduler.start();
      console.log("[loa] Beads persistence initialized, scheduler started");
    } catch (err) {
      try {
        scheduler.stop();
      } catch (stopErr) {
        console.error("[loa] Defensive scheduler.stop() failed:", stopErr);
      }
      throw err;
    }
  }

  // Return cleanup handle — caller (top-level entrypoint) owns signal registration
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    try {
      scheduler.stop();
    } catch (err) {
      console.error("[loa] scheduler.stop() failed during shutdown:", err);
    }
  };

  return { identity, recovery, memory, scheduler, beads: beadsPersistence, shutdown };
}
