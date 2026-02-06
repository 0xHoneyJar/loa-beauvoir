/**
 * Persistence Framework Adapter — wires framework classes to container config.
 *
 * This module bridges .claude/lib/persistence/ (portable framework) with
 * deploy/loa-identity/ (container-specific paths and env vars).
 *
 * Usage:
 *   const { circuitBreaker, walManager, checkpointProtocol, recoveryEngine,
 *           beadsWALAdapter, beadsRecovery, learningStore, identityLoader }
 *     = await initializePersistence();
 *
 * @module deploy/loa-identity/persistence-init
 */

import type { IRecoverySource } from "../../.claude/lib/persistence/recovery/recovery-source.js";
import { BeadsRecoveryHandler } from "../../.claude/lib/persistence/beads/beads-recovery.js";
import { BeadsWALAdapter } from "../../.claude/lib/persistence/beads/beads-wal-adapter.js";
import { CheckpointProtocol } from "../../.claude/lib/persistence/checkpoint/checkpoint-protocol.js";
import { MountCheckpointStorage } from "../../.claude/lib/persistence/checkpoint/storage-mount.js";
import { CircuitBreaker } from "../../.claude/lib/persistence/circuit-breaker.js";
import { IdentityLoader } from "../../.claude/lib/persistence/identity/identity-loader.js";
import { LearningStore } from "../../.claude/lib/persistence/learning/learning-store.js";
import { DefaultQualityGateScorer } from "../../.claude/lib/persistence/learning/quality-gates.js";
import { createManifestSigner } from "../../.claude/lib/persistence/recovery/manifest-signer.js";
import { RecoveryEngine } from "../../.claude/lib/persistence/recovery/recovery-engine.js";
import { MountRecoverySource } from "../../.claude/lib/persistence/recovery/sources/mount-source.js";
import { TemplateRecoverySource } from "../../.claude/lib/persistence/recovery/sources/template-source.js";
import { WALManager } from "../../.claude/lib/persistence/wal/wal-manager.js";

// ── Container Configuration ──────────────────────────────────

export interface ContainerPersistenceConfig {
  /** Path to grimoires directory. Default: from LOA_GRIMOIRE_DIR or 'grimoires/loa' */
  grimoiresDir?: string;
  /** Path to R2 mount. Default: from LOA_R2_MOUNT_PATH */
  r2MountPath?: string;
  /** Path to Ed25519 signing key. Default: from LOA_SIGNING_KEY_PATH or '.loa/signing-key.pem' */
  signingKeyPath?: string;
  /** Circuit breaker overrides */
  circuitBreaker?: {
    maxFailures?: number;
    resetTimeMs?: number;
  };
  /** Beads directory. Default: '.beads' */
  beadsDir?: string;
  /** br command path. Default: from LOA_BR_COMMAND or 'br' */
  brCommand?: string;
}

// ── Initialization ───────────────────────────────────────────

export async function initializePersistence(config?: ContainerPersistenceConfig) {
  const grimoiresDir = config?.grimoiresDir ?? process.env.LOA_GRIMOIRE_DIR ?? "grimoires/loa";
  const r2MountPath = config?.r2MountPath ?? process.env.LOA_R2_MOUNT_PATH;

  // Circuit Breaker (standalone, no container deps)
  const circuitBreaker = new CircuitBreaker(
    {
      maxFailures: config?.circuitBreaker?.maxFailures ?? 3,
      resetTimeMs: config?.circuitBreaker?.resetTimeMs ?? 5 * 60 * 1000,
      halfOpenRetries: 1,
    },
    {
      onStateChange: (from, to) => {
        console.log(`[persistence] Circuit breaker: ${from} → ${to}`);
      },
    },
  );

  // WAL Manager (container WAL directory)
  const walManager = new WALManager({
    walDir: `${grimoiresDir}/wal`,
    maxSegmentSize: 10 * 1024 * 1024,
    maxSegmentAge: 60 * 60 * 1000,
    maxSegments: 10,
    diskPressure: {
      warningBytes: 100 * 1024 * 1024,
      criticalBytes: 150 * 1024 * 1024,
    },
  });

  // Checkpoint Protocol (mount-based if R2 available)
  let checkpointProtocol: CheckpointProtocol | null = null;
  if (r2MountPath) {
    const storage = new MountCheckpointStorage(r2MountPath, "grimoires");
    checkpointProtocol = new CheckpointProtocol({ storage });
  }

  // Recovery Engine (cascade: mount → template)
  const sources: IRecoverySource[] = [];

  if (r2MountPath) {
    const mountStorage = new MountCheckpointStorage(r2MountPath, "grimoires");
    sources.push(new MountRecoverySource(mountStorage));
  }

  // Template fallback (always available)
  const templates = new Map<string, Buffer>([
    ["BEAUVOIR.md", Buffer.from("# BEAUVOIR\n\nDefault identity template.\n")],
    ["NOTES.md", Buffer.from("# NOTES\n\nSession notes.\n")],
  ]);
  sources.push(new TemplateRecoverySource(templates));

  const recoveryEngine = new RecoveryEngine({
    sources,
    loopMaxFailures: 3,
    loopWindowMs: 10 * 60 * 1000,
    onStateChange: (from, to) => {
      console.log(`[persistence] Recovery: ${from} → ${to}`);
    },
    onEvent: (event, data) => {
      console.log(`[persistence] Recovery event: ${event}`, data);
    },
  });

  // ── Sprint 2: Beads Bridge ────────────────────────────────

  const beadsWALAdapter = new BeadsWALAdapter(walManager, {
    pathPrefix: ".beads/wal",
  });

  const beadsRecovery = new BeadsRecoveryHandler(beadsWALAdapter, {
    beadsDir: ".beads",
    brCommand: process.env.LOA_BR_COMMAND ?? "br",
    skipSync: false,
  });

  // ── Sprint 2: Learning Store ─────────────────────────────

  const learningStore = new LearningStore(
    {
      basePath: `${grimoiresDir}/a2a/compound`,
    },
    new DefaultQualityGateScorer(),
  );

  // ── Sprint 2: Identity Loader ────────────────────────────

  const identityLoader = new IdentityLoader({
    beauvoirPath: `${grimoiresDir}/BEAUVOIR.md`,
    notesPath: `${grimoiresDir}/NOTES.md`,
  });

  return {
    circuitBreaker,
    walManager,
    checkpointProtocol,
    recoveryEngine,
    beadsWALAdapter,
    beadsRecovery,
    learningStore,
    identityLoader,
  };
}
