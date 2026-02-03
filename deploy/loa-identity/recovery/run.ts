/**
 * Recovery Engine Entrypoint
 *
 * Run this on container startup to initialize recovery engine.
 *
 * @module deploy/loa-identity/recovery/run
 */

import { RecoveryEngine, createRecoveryEngine } from './recovery-engine.js';
import { ManifestSigner } from '../security/manifest-signer.js';
import { AuditLogger } from '../security/audit-logger.js';
import { R2Client, createR2ClientFromMount } from './r2-client.js';
import { GitClient, createGitClientFromEnv } from './git-client.js';

interface RunConfig {
  grimoiresDir: string;
  walDir: string;
  r2MountPath?: string;
}

/**
 * Main entrypoint for recovery engine
 */
export async function runRecoveryEngine(
  config?: Partial<RunConfig>
): Promise<{
  success: boolean;
  state: string;
  restoreSource: string | null;
}> {
  // Configuration with defaults
  const grimoiresDir = config?.grimoiresDir ?? process.env.GRIMOIRES_DIR ?? '/workspace/grimoires';
  const walDir = config?.walDir ?? process.env.WAL_DIR ?? '/data/wal';
  const r2MountPath = config?.r2MountPath ?? process.env.R2_MOUNT ?? '/data/moltbot';

  console.log('[recovery/run] Starting Loa Recovery Engine');
  console.log(`[recovery/run] Grimoires: ${grimoiresDir}`);
  console.log(`[recovery/run] WAL: ${walDir}`);
  console.log(`[recovery/run] R2 Mount: ${r2MountPath}`);

  // Initialize components
  const manifestSigner = new ManifestSigner();
  const auditLogger = new AuditLogger(`${walDir}/audit.log`);
  await auditLogger.initialize();

  // Create R2 client if mount available
  let r2Client: R2Client | undefined;
  try {
    r2Client = createR2ClientFromMount(r2MountPath);
    if (await r2Client.isAvailable()) {
      console.log('[recovery/run] R2 mount available');
    } else {
      console.log('[recovery/run] R2 mount not available');
      r2Client = undefined;
    }
  } catch {
    console.log('[recovery/run] R2 client creation failed');
  }

  // Create Git client if configured
  const gitClient = createGitClientFromEnv();
  if (gitClient) {
    console.log('[recovery/run] Git fallback configured');
  }

  // Create recovery engine
  const engine = new RecoveryEngine({
    grimoiresDir,
    r2Client: r2Client
      ? {
          downloadManifest: () => r2Client!.downloadManifest(),
          downloadFile: (path) => r2Client!.downloadFile(path),
          isAvailable: () => r2Client!.isAvailable(),
        }
      : undefined,
    gitClient: gitClient
      ? {
          cloneOrPull: () => gitClient.cloneOrPull(),
          getManifest: () => gitClient.getManifest(),
          getFile: (path) => gitClient.getFile(path),
          isAvailable: () => gitClient.isAvailable(),
        }
      : undefined,
    manifestSigner,
    auditLogger,
  });

  // Run recovery
  const result = await engine.run();

  console.log(`[recovery/run] Final state: ${result.finalState}`);
  console.log(`[recovery/run] Restore source: ${result.restoreSource ?? 'none'}`);
  console.log(`[recovery/run] Restore count: ${result.restoreCount}`);

  const success =
    result.finalState === 'RUNNING' || result.finalState === 'DEGRADED';

  return {
    success,
    state: result.finalState,
    restoreSource: result.restoreSource,
  };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  runRecoveryEngine()
    .then((result) => {
      if (result.success) {
        console.log('[recovery/run] Recovery complete');
        process.exit(0);
      } else {
        console.error('[recovery/run] Recovery failed');
        process.exit(1);
      }
    })
    .catch((e) => {
      console.error('[recovery/run] Fatal error:', e);
      process.exit(1);
    });
}
