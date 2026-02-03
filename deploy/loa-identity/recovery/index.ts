/**
 * Recovery Module - Auto-recovery state machine
 *
 * @module deploy/loa-identity/recovery
 */

export {
  RecoveryEngine,
  createRecoveryEngine,
  type RecoveryState,
  type RecoveryConfig,
  type R2RestoreClient,
  type GitRestoreClient,
} from './recovery-engine.js';

export {
  R2Client,
  createR2ClientFromMount,
  createR2ClientFromEnv,
  type R2MountConfig,
} from './r2-client.js';

export {
  GitClient,
  createGitClient,
  createGitClientFromEnv,
  type GitClientConfig,
} from './git-client.js';

export { runRecoveryEngine } from './run.js';
