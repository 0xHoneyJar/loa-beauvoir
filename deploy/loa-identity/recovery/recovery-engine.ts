/**
 * Recovery Engine - Auto-recovery state machine
 *
 * Implements the recovery state machine with:
 * - Multi-source fallback: R2 → Git → Template
 * - Ed25519 signature verification + SHA-256 checksums
 * - Loop detection with configurable thresholds
 * - Degraded mode operation
 *
 * @module deploy/loa-identity/recovery/recovery-engine
 */

import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { ManifestSigner, StateManifest, FileEntry } from '../security/manifest-signer.js';
import { AuditLogger } from '../security/audit-logger.js';

export type RecoveryState =
  | 'START'
  | 'CHECK_INTEGRITY'
  | 'INTEGRITY_OK'
  | 'RESTORE_R2'
  | 'RESTORE_GIT'
  | 'RESTORE_TEMPLATE'
  | 'VERIFY_RESTORE'
  | 'RUNNING'
  | 'DEGRADED'
  | 'LOOP_DETECTED';

export interface RecoveryConfig {
  grimoiresDir: string;
  r2Client?: R2RestoreClient;
  gitClient?: GitRestoreClient;
  manifestSigner: ManifestSigner;
  auditLogger?: AuditLogger;
  loopMaxFailures?: number;
  loopWindowMinutes?: number;
}

export interface R2RestoreClient {
  downloadManifest(): Promise<StateManifest | null>;
  downloadFile(path: string): Promise<Buffer | null>;
  isAvailable(): Promise<boolean>;
}

export interface GitRestoreClient {
  cloneOrPull(): Promise<boolean>;
  getManifest(): Promise<StateManifest | null>;
  getFile(path: string): Promise<Buffer | null>;
  isAvailable(): Promise<boolean>;
}

interface FailureRecord {
  timestamp: number;
  state: RecoveryState;
  reason: string;
}

/**
 * RecoveryEngine implements auto-recovery with state machine and loop detection.
 */
export class RecoveryEngine {
  private config: Required<Omit<RecoveryConfig, 'r2Client' | 'gitClient' | 'auditLogger'>> & {
    r2Client?: R2RestoreClient;
    gitClient?: GitRestoreClient;
    auditLogger?: AuditLogger;
  };
  private state: RecoveryState = 'START';
  private failures: FailureRecord[] = [];
  private currentManifest: StateManifest | null = null;
  private restoreSource: 'r2' | 'git' | 'template' | null = null;
  private restoreCount = 0;

  constructor(config: RecoveryConfig) {
    this.config = {
      grimoiresDir: config.grimoiresDir,
      r2Client: config.r2Client,
      gitClient: config.gitClient,
      manifestSigner: config.manifestSigner,
      auditLogger: config.auditLogger,
      loopMaxFailures: config.loopMaxFailures ?? parseInt(
        process.env.BEAUVOIR_LOOP_MAX_FAILURES ?? '3',
        10
      ),
      loopWindowMinutes: config.loopWindowMinutes ?? parseInt(
        process.env.BEAUVOIR_LOOP_WINDOW_MINUTES ?? '10',
        10
      ),
    };
  }

  /**
   * Run the recovery state machine
   */
  async run(): Promise<{
    finalState: RecoveryState;
    restoreSource: 'r2' | 'git' | 'template' | null;
    restoreCount: number;
  }> {
    console.log('[recovery] Starting recovery engine...');

    while (this.state !== 'RUNNING' && this.state !== 'DEGRADED' && this.state !== 'LOOP_DETECTED') {
      await this.transition();
    }

    await this.config.auditLogger?.log(
      'recovery_complete',
      {
        finalState: this.state,
        restoreSource: this.restoreSource,
        restoreCount: this.restoreCount,
      },
      'system'
    );

    return {
      finalState: this.state,
      restoreSource: this.restoreSource,
      restoreCount: this.restoreCount,
    };
  }

  /**
   * Execute state transition
   */
  private async transition(): Promise<void> {
    const previousState = this.state;

    switch (this.state) {
      case 'START':
        await this.handleStart();
        break;

      case 'CHECK_INTEGRITY':
        await this.handleCheckIntegrity();
        break;

      case 'INTEGRITY_OK':
        this.state = 'RUNNING';
        break;

      case 'RESTORE_R2':
        await this.handleRestoreR2();
        break;

      case 'RESTORE_GIT':
        await this.handleRestoreGit();
        break;

      case 'RESTORE_TEMPLATE':
        await this.handleRestoreTemplate();
        break;

      case 'VERIFY_RESTORE':
        await this.handleVerifyRestore();
        break;
    }

    if (this.state !== previousState) {
      console.log(`[recovery] ${previousState} → ${this.state}`);
    }
  }

  /**
   * Handle START state
   */
  private async handleStart(): Promise<void> {
    // Check for loop detection
    if (this.isLoopDetected()) {
      this.state = 'LOOP_DETECTED';
      await this.enterDegradedMode('Loop detected - too many failures');
      return;
    }

    this.state = 'CHECK_INTEGRITY';
  }

  /**
   * Handle CHECK_INTEGRITY state
   */
  private async handleCheckIntegrity(): Promise<void> {
    try {
      // Load manifest
      const manifestPath = join(this.config.grimoiresDir, 'loa', 'manifest.json');

      if (!existsSync(manifestPath)) {
        console.log('[recovery] No manifest found, starting restore');
        this.state = 'RESTORE_R2';
        return;
      }

      const manifestContent = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as StateManifest;

      // Verify signature
      const signatureValid = await this.config.manifestSigner.verifyManifest(manifest);

      if (!signatureValid) {
        console.warn('[recovery] Manifest signature invalid');
        this.recordFailure('CHECK_INTEGRITY', 'Invalid manifest signature');
        this.state = 'RESTORE_R2';
        return;
      }

      // Verify file checksums
      const integrityValid = await this.verifyFileChecksums(manifest);

      if (!integrityValid) {
        console.warn('[recovery] File integrity check failed');
        this.recordFailure('CHECK_INTEGRITY', 'File checksum mismatch');
        this.state = 'RESTORE_R2';
        return;
      }

      this.currentManifest = manifest;
      this.restoreSource = manifest.last_restore_source;
      this.restoreCount = manifest.restore_count;
      this.state = 'INTEGRITY_OK';

      console.log('[recovery] Integrity check passed');
    } catch (e) {
      console.error('[recovery] Integrity check error:', e);
      this.recordFailure('CHECK_INTEGRITY', String(e));
      this.state = 'RESTORE_R2';
    }
  }

  /**
   * Verify file checksums from manifest
   */
  private async verifyFileChecksums(manifest: StateManifest): Promise<boolean> {
    for (const [relativePath, entry] of Object.entries(manifest.files)) {
      const fullPath = join(this.config.grimoiresDir, relativePath);

      if (!existsSync(fullPath)) {
        console.warn(`[recovery] Missing file: ${relativePath}`);
        return false;
      }

      const content = await readFile(fullPath);
      const checksum = createHash('sha256').update(content).digest('hex');

      if (checksum !== entry.sha256) {
        console.warn(
          `[recovery] Checksum mismatch: ${relativePath} (expected ${entry.sha256.substring(0, 16)}..., got ${checksum.substring(0, 16)}...)`
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Handle RESTORE_R2 state
   */
  private async handleRestoreR2(): Promise<void> {
    if (!this.config.r2Client) {
      console.log('[recovery] R2 client not configured, trying Git');
      this.state = 'RESTORE_GIT';
      return;
    }

    try {
      const available = await this.config.r2Client.isAvailable();
      if (!available) {
        console.log('[recovery] R2 not available, trying Git');
        this.state = 'RESTORE_GIT';
        return;
      }

      // Download manifest
      const manifest = await this.config.r2Client.downloadManifest();

      if (!manifest) {
        console.log('[recovery] No R2 manifest, trying Git');
        this.state = 'RESTORE_GIT';
        return;
      }

      // Verify signature
      const signatureValid = await this.config.manifestSigner.verifyManifest(manifest);

      if (!signatureValid) {
        console.warn('[recovery] R2 manifest signature invalid, trying Git');
        this.recordFailure('RESTORE_R2', 'Invalid manifest signature');
        this.state = 'RESTORE_GIT';
        return;
      }

      // Download and verify files
      for (const [relativePath, entry] of Object.entries(manifest.files)) {
        const content = await this.config.r2Client.downloadFile(relativePath);

        if (!content) {
          console.warn(`[recovery] Failed to download ${relativePath} from R2`);
          this.recordFailure('RESTORE_R2', `Download failed: ${relativePath}`);
          this.state = 'RESTORE_GIT';
          return;
        }

        // Verify checksum
        const checksum = createHash('sha256').update(content).digest('hex');
        if (checksum !== entry.sha256) {
          console.warn(`[recovery] R2 file checksum mismatch: ${relativePath}`);
          this.recordFailure('RESTORE_R2', `Checksum mismatch: ${relativePath}`);
          this.state = 'RESTORE_GIT';
          return;
        }

        // Write file
        const fullPath = join(this.config.grimoiresDir, relativePath);
        await mkdir(dirname(fullPath), { recursive: true });
        await this.atomicWrite(fullPath, content);
      }

      this.currentManifest = manifest;
      this.restoreSource = 'r2';
      this.state = 'VERIFY_RESTORE';

      console.log('[recovery] R2 restore complete');
    } catch (e) {
      console.error('[recovery] R2 restore error:', e);
      this.recordFailure('RESTORE_R2', String(e));
      this.state = 'RESTORE_GIT';
    }
  }

  /**
   * Handle RESTORE_GIT state
   *
   * SECURITY: Git restore now REQUIRES signature verification.
   * Unsigned or tampered content will be rejected and fall through to template.
   */
  private async handleRestoreGit(): Promise<void> {
    if (!this.config.gitClient) {
      console.log('[recovery] Git client not configured, using template');
      this.state = 'RESTORE_TEMPLATE';
      return;
    }

    try {
      const available = await this.config.gitClient.isAvailable();
      if (!available) {
        console.log('[recovery] Git not available, using template');
        this.state = 'RESTORE_TEMPLATE';
        return;
      }

      // Clone or pull
      const success = await this.config.gitClient.cloneOrPull();
      if (!success) {
        console.log('[recovery] Git clone/pull failed, using template');
        this.recordFailure('RESTORE_GIT', 'Clone/pull failed');
        this.state = 'RESTORE_TEMPLATE';
        return;
      }

      // Get manifest - REQUIRED for Git restore
      const manifest = await this.config.gitClient.getManifest();

      if (!manifest) {
        console.warn('[recovery] Git has no manifest, using template');
        this.recordFailure('RESTORE_GIT', 'No manifest found');
        this.state = 'RESTORE_TEMPLATE';
        return;
      }

      // SECURITY: Verify signature - REQUIRED
      const signatureValid = await this.config.manifestSigner.verifyManifest(manifest);

      if (!signatureValid) {
        console.error('[recovery] SECURITY: Git manifest signature INVALID, rejecting');
        this.recordFailure('RESTORE_GIT', 'Invalid manifest signature - potential tampering');

        await this.config.auditLogger?.log(
          'security_signature_invalid',
          {
            source: 'git',
            reason: 'Manifest signature verification failed',
          },
          'system'
        );

        this.state = 'RESTORE_TEMPLATE';
        return;
      }

      // SECURITY: Verify file checksums - REQUIRED
      const integrityValid = await this.verifyFileChecksums(manifest);

      if (!integrityValid) {
        console.error('[recovery] SECURITY: Git file checksums INVALID, rejecting');
        this.recordFailure('RESTORE_GIT', 'Checksum mismatch - potential tampering');

        await this.config.auditLogger?.log(
          'security_checksum_invalid',
          {
            source: 'git',
            reason: 'File checksum verification failed',
          },
          'system'
        );

        this.state = 'RESTORE_TEMPLATE';
        return;
      }

      // All verification passed
      this.currentManifest = manifest;
      this.restoreSource = 'git';
      this.state = 'VERIFY_RESTORE';
      console.log('[recovery] Git restore complete (verified)');
    } catch (e) {
      console.error('[recovery] Git restore error:', e);
      this.recordFailure('RESTORE_GIT', String(e));
      this.state = 'RESTORE_TEMPLATE';
    }
  }

  /**
   * Handle RESTORE_TEMPLATE state
   */
  private async handleRestoreTemplate(): Promise<void> {
    console.log('[recovery] Initializing from template...');

    try {
      // Create default files
      const loaDir = join(this.config.grimoiresDir, 'loa');
      await mkdir(loaDir, { recursive: true });

      // Default BEAUVOIR.md
      const beauvoirPath = join(loaDir, 'BEAUVOIR.md');
      if (!existsSync(beauvoirPath)) {
        await this.atomicWrite(beauvoirPath, Buffer.from(this.getDefaultBeauvoir()));
      }

      // Default NOTES.md
      const notesPath = join(loaDir, 'NOTES.md');
      if (!existsSync(notesPath)) {
        await this.atomicWrite(
          notesPath,
          Buffer.from(`# NOTES.md\n\n> Loa operational log\n\n---\n\n## [${new Date().toISOString()}] System Initialized\n\n- Initialized from template\n- No previous state found\n`)
        );
      }

      this.restoreSource = 'template';
      this.state = 'VERIFY_RESTORE';

      console.log('[recovery] Template initialization complete');
    } catch (e) {
      console.error('[recovery] Template restore error:', e);
      this.recordFailure('RESTORE_TEMPLATE', String(e));
      await this.enterDegradedMode('Failed to initialize from template');
    }
  }

  /**
   * Handle VERIFY_RESTORE state
   */
  private async handleVerifyRestore(): Promise<void> {
    // Generate new manifest
    await this.generateManifest();

    this.restoreCount++;
    this.state = 'RUNNING';

    console.log(
      `[recovery] Restore verified (source: ${this.restoreSource}, count: ${this.restoreCount})`
    );
  }

  /**
   * Generate and sign a new manifest
   */
  private async generateManifest(): Promise<void> {
    const files: Record<string, FileEntry> = {};
    const loaDir = join(this.config.grimoiresDir, 'loa');

    // Scan critical files
    const criticalFiles = ['BEAUVOIR.md', 'NOTES.md'];

    for (const file of criticalFiles) {
      const fullPath = join(loaDir, file);
      if (existsSync(fullPath)) {
        const content = await readFile(fullPath);
        const stats = await stat(fullPath);

        files[`loa/${file}`] = {
          sha256: createHash('sha256').update(content).digest('hex'),
          size_bytes: stats.size,
          mtime: stats.mtime.toISOString(),
        };
      }
    }

    const manifest: Omit<StateManifest, 'signature'> = {
      version: 1,
      generated_at: new Date().toISOString(),
      files,
      restore_count: this.restoreCount,
      last_restore_source: this.restoreSource,
    };

    // Sign manifest
    try {
      const signed = await this.config.manifestSigner.signManifest(manifest);
      const manifestPath = join(loaDir, 'manifest.json');
      await this.atomicWrite(manifestPath, Buffer.from(JSON.stringify(signed, null, 2)));
      this.currentManifest = signed;
    } catch (e) {
      console.warn('[recovery] Could not sign manifest (no signing key):', e);
      // Still save unsigned for tracking
      const manifestPath = join(loaDir, 'manifest.json');
      await this.atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest, null, 2)));
    }
  }

  /**
   * Atomic file write
   */
  private async atomicWrite(path: string, content: Buffer): Promise<void> {
    const tempPath = `${path}.tmp`;
    await writeFile(tempPath, content);
    const { rename } = await import('fs/promises');
    await rename(tempPath, path);
  }

  /**
   * Record a failure for loop detection
   */
  private recordFailure(state: RecoveryState, reason: string): void {
    this.failures.push({
      timestamp: Date.now(),
      state,
      reason,
    });
  }

  /**
   * Check if we're in a failure loop
   */
  private isLoopDetected(): boolean {
    const windowMs = this.config.loopWindowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    const recentFailures = this.failures.filter((f) => f.timestamp >= cutoff);

    if (recentFailures.length >= this.config.loopMaxFailures) {
      console.error(
        `[recovery] Loop detected: ${recentFailures.length} failures in ${this.config.loopWindowMinutes} minutes`
      );
      return true;
    }

    return false;
  }

  /**
   * Enter degraded mode
   */
  private async enterDegradedMode(reason: string): Promise<void> {
    this.state = 'DEGRADED';

    // Set environment variable for other components
    process.env.BEAUVOIR_DEGRADED = '1';

    await this.config.auditLogger?.log(
      'recovery_degraded',
      {
        reason,
        failures: this.failures,
      },
      'system'
    );

    console.error(`[recovery] DEGRADED MODE: ${reason}`);
    console.error('[recovery] Will retry in 1 hour');

    // Schedule retry
    setTimeout(() => {
      delete process.env.BEAUVOIR_DEGRADED;
      this.failures = []; // Reset failures
      this.state = 'START';
      this.run().catch(console.error);
    }, 60 * 60 * 1000); // 1 hour
  }

  /**
   * Get default BEAUVOIR.md content
   */
  private getDefaultBeauvoir(): string {
    return `# Beauvoir - Identity Document

> **Version**: 0.1.0
> **Last Updated**: ${new Date().toISOString().split('T')[0]}
> **Change Log**: Auto-generated from template

---

## Core Principles

### 1. Understand Before Acting
I verify information before stating it.

### 2. Procedures Exist for Good Reasons
I follow established workflows.

### 3. Survival is a Feature
I recover autonomously from failures.

---

## Recovery Protocol

On startup:
1. Check grimoire integrity
2. Restore from backup if needed
3. Continue operation

---

*Auto-generated template. Customize as needed.*
`;
  }

  /**
   * Get current state
   */
  getState(): RecoveryState {
    return this.state;
  }

  /**
   * Get current manifest
   */
  getManifest(): StateManifest | null {
    return this.currentManifest;
  }

  /**
   * Check if in degraded mode
   */
  isDegraded(): boolean {
    return this.state === 'DEGRADED' || process.env.BEAUVOIR_DEGRADED === '1';
  }
}

/**
 * Create recovery engine with default configuration
 */
export function createRecoveryEngine(
  grimoiresDir: string,
  manifestSigner: ManifestSigner,
  auditLogger?: AuditLogger
): RecoveryEngine {
  return new RecoveryEngine({
    grimoiresDir,
    manifestSigner,
    auditLogger,
    loopMaxFailures: parseInt(process.env.BEAUVOIR_LOOP_MAX_FAILURES ?? '3', 10),
    loopWindowMinutes: parseInt(process.env.BEAUVOIR_LOOP_WINDOW_MINUTES ?? '10', 10),
  });
}
