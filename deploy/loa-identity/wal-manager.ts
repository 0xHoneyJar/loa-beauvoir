/**
 * Loa Cloud Stack - WAL (Write-Ahead Log) Manager
 *
 * Provides crash-resilient persistence for grimoire state.
 *
 * Write Path:
 *   1. Append to WAL (immediate)
 *   2. Sync to R2 (every 30 seconds)
 *   3. Sync to Git (on conversation end or hourly)
 *
 * Recovery Path:
 *   1. On container start, replay WAL from last R2 checkpoint
 *   2. Max data loss: 30 seconds
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { WALEntry, WALCheckpoint, SyncStatus } from './types';

// =============================================================================
// Configuration
// =============================================================================

const WAL_DIR = process.env.WAL_DIR || '/data/wal';
const GRIMOIRES_DIR = process.env.GRIMOIRES_DIR || '/workspace/grimoires';
const BEADS_DIR = process.env.BEADS_DIR || '/workspace/.beads';
const R2_MOUNT = process.env.R2_MOUNT || '/data/moltbot';

const R2_SYNC_INTERVAL_MS = 30_000; // 30 seconds
const GIT_SYNC_INTERVAL_MS = 3600_000; // 1 hour

// =============================================================================
// WAL Manager Class
// =============================================================================

export class WALManager {
  private walDir: string;
  private currentWalFile: string;
  private seq: number = 0;
  private checkpoint: WALCheckpoint;
  private r2SyncTimer: NodeJS.Timeout | null = null;
  private gitSyncTimer: NodeJS.Timeout | null = null;

  constructor(walDir: string = WAL_DIR) {
    this.walDir = walDir;
    this.currentWalFile = path.join(walDir, 'current.wal');
    this.checkpoint = this.loadCheckpoint();
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize WAL manager - call on startup
   */
  async initialize(): Promise<void> {
    // Ensure WAL directory exists
    await fs.promises.mkdir(this.walDir, { recursive: true });

    // Load checkpoint
    this.checkpoint = this.loadCheckpoint();
    this.seq = this.checkpoint.entry_count;

    console.log(`[wal] Initialized with ${this.seq} entries`);
  }

  /**
   * Load checkpoint from disk
   */
  private loadCheckpoint(): WALCheckpoint {
    const checkpointPath = path.join(this.walDir, 'checkpoint.json');
    try {
      const data = fs.readFileSync(checkpointPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return {
        last_r2_seq: 0,
        last_git_seq: 0,
        current_wal: this.currentWalFile,
        entry_count: 0,
      };
    }
  }

  /**
   * Save checkpoint to disk
   */
  private async saveCheckpoint(): Promise<void> {
    const checkpointPath = path.join(this.walDir, 'checkpoint.json');
    const tempPath = `${checkpointPath}.tmp`;

    await fs.promises.writeFile(tempPath, JSON.stringify(this.checkpoint, null, 2));
    await fs.promises.rename(tempPath, checkpointPath);
  }

  // ---------------------------------------------------------------------------
  // Write Operations
  // ---------------------------------------------------------------------------

  /**
   * Write a file with WAL protection
   */
  async write(relativePath: string, content: Buffer | string): Promise<void> {
    const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const checksum = this.computeChecksum(contentBuffer);

    const entry: WALEntry = {
      ts: Date.now(),
      seq: this.seq++,
      op: 'write',
      path: relativePath,
      checksum,
      data: contentBuffer.toString('base64'),
    };

    // 1. Append to WAL (atomic via temp file + rename)
    await this.appendEntry(entry);

    // 2. Write to actual file
    const fullPath = this.resolveFullPath(relativePath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, contentBuffer);

    // 3. Update checkpoint
    this.checkpoint.entry_count = this.seq;
    await this.saveCheckpoint();

    console.log(`[wal] Write: ${relativePath} (${contentBuffer.length} bytes)`);
  }

  /**
   * Delete a file with WAL protection
   */
  async delete(relativePath: string): Promise<void> {
    const entry: WALEntry = {
      ts: Date.now(),
      seq: this.seq++,
      op: 'delete',
      path: relativePath,
    };

    await this.appendEntry(entry);

    const fullPath = this.resolveFullPath(relativePath);
    await fs.promises.unlink(fullPath).catch(() => {});

    this.checkpoint.entry_count = this.seq;
    await this.saveCheckpoint();

    console.log(`[wal] Delete: ${relativePath}`);
  }

  /**
   * Create a directory with WAL protection
   */
  async mkdir(relativePath: string): Promise<void> {
    const entry: WALEntry = {
      ts: Date.now(),
      seq: this.seq++,
      op: 'mkdir',
      path: relativePath,
    };

    await this.appendEntry(entry);

    const fullPath = this.resolveFullPath(relativePath);
    await fs.promises.mkdir(fullPath, { recursive: true });

    this.checkpoint.entry_count = this.seq;
    await this.saveCheckpoint();

    console.log(`[wal] Mkdir: ${relativePath}`);
  }

  // ---------------------------------------------------------------------------
  // WAL Entry Management
  // ---------------------------------------------------------------------------

  /**
   * Append an entry to the WAL file (atomic)
   */
  private async appendEntry(entry: WALEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n';
    const tempFile = `${this.currentWalFile}.tmp`;

    // Read existing WAL
    let existing = '';
    try {
      existing = await fs.promises.readFile(this.currentWalFile, 'utf8');
    } catch {
      // File doesn't exist yet
    }

    // Write to temp file and rename (atomic on POSIX)
    await fs.promises.writeFile(tempFile, existing + line);
    await fs.promises.rename(tempFile, this.currentWalFile);
  }

  /**
   * Read all entries from WAL
   */
  async readAllEntries(): Promise<WALEntry[]> {
    try {
      const data = await fs.promises.readFile(this.currentWalFile, 'utf8');
      return data
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as WALEntry);
    } catch {
      return [];
    }
  }

  /**
   * Get entries that haven't been synced to R2
   */
  async getUnsyncedR2Entries(): Promise<WALEntry[]> {
    const entries = await this.readAllEntries();
    return entries.filter((e) => e.seq > this.checkpoint.last_r2_seq);
  }

  /**
   * Get entries that haven't been synced to git
   */
  async getUnsyncedGitEntries(): Promise<WALEntry[]> {
    const entries = await this.readAllEntries();
    return entries.filter((e) => e.seq > this.checkpoint.last_git_seq);
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  /**
   * Replay WAL entries to restore state
   */
  async replay(): Promise<number> {
    console.log('[wal] Replaying WAL entries...');

    const entries = await this.readAllEntries();
    const sorted = entries.sort((a, b) => a.seq - b.seq);

    let replayed = 0;
    for (const entry of sorted) {
      try {
        if (entry.op === 'write' && entry.data) {
          // Verify checksum before replay
          const content = Buffer.from(entry.data, 'base64');
          const checksum = this.computeChecksum(content);

          if (entry.checksum && checksum !== entry.checksum) {
            console.warn(`[wal] Checksum mismatch for ${entry.path}, skipping`);
            continue;
          }

          const fullPath = this.resolveFullPath(entry.path);
          await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.promises.writeFile(fullPath, content);
          replayed++;
        } else if (entry.op === 'delete') {
          const fullPath = this.resolveFullPath(entry.path);
          await fs.promises.unlink(fullPath).catch(() => {});
          replayed++;
        } else if (entry.op === 'mkdir') {
          const fullPath = this.resolveFullPath(entry.path);
          await fs.promises.mkdir(fullPath, { recursive: true });
          replayed++;
        }
      } catch (err) {
        console.error(`[wal] Error replaying entry ${entry.seq}:`, err);
      }
    }

    // Update sequence number
    if (sorted.length > 0) {
      this.seq = sorted[sorted.length - 1].seq + 1;
    }

    console.log(`[wal] Replayed ${replayed} entries`);
    return replayed;
  }

  // ---------------------------------------------------------------------------
  // R2 Sync
  // ---------------------------------------------------------------------------

  /**
   * Sync unsynced entries to R2
   */
  async syncToR2(): Promise<number> {
    const entries = await this.getUnsyncedR2Entries();
    if (entries.length === 0) {
      return 0;
    }

    console.log(`[wal] Syncing ${entries.length} entries to R2...`);

    let synced = 0;
    for (const entry of entries) {
      try {
        const r2Path = path.join(R2_MOUNT, entry.path);

        if (entry.op === 'write' && entry.data) {
          await fs.promises.mkdir(path.dirname(r2Path), { recursive: true });
          await fs.promises.writeFile(r2Path, Buffer.from(entry.data, 'base64'));
          synced++;
        } else if (entry.op === 'delete') {
          await fs.promises.unlink(r2Path).catch(() => {});
          synced++;
        } else if (entry.op === 'mkdir') {
          await fs.promises.mkdir(r2Path, { recursive: true });
          synced++;
        }

        // Mark entry as synced
        entry.synced_r2 = Date.now();
      } catch (err) {
        console.error(`[wal] R2 sync error for ${entry.path}:`, err);
      }
    }

    // Update checkpoint
    if (entries.length > 0) {
      this.checkpoint.last_r2_seq = entries[entries.length - 1].seq;
      this.checkpoint.last_r2_sync = new Date().toISOString();
      await this.saveCheckpoint();
    }

    // Write sync timestamp to R2
    try {
      await fs.promises.writeFile(
        path.join(R2_MOUNT, '.last-sync'),
        new Date().toISOString()
      );
    } catch {
      // R2 might not be mounted
    }

    console.log(`[wal] Synced ${synced} entries to R2`);
    return synced;
  }

  /**
   * Start background R2 sync (every 30 seconds)
   */
  startR2Sync(): void {
    if (this.r2SyncTimer) return;

    this.r2SyncTimer = setInterval(async () => {
      try {
        await this.syncToR2();
      } catch (err) {
        console.error('[wal] R2 sync error:', err);
      }
    }, R2_SYNC_INTERVAL_MS);

    console.log(`[wal] R2 sync started (every ${R2_SYNC_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Stop background R2 sync
   */
  stopR2Sync(): void {
    if (this.r2SyncTimer) {
      clearInterval(this.r2SyncTimer);
      this.r2SyncTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Git Sync
  // ---------------------------------------------------------------------------

  /**
   * Sync state to git
   */
  async syncToGit(): Promise<boolean> {
    const entries = await this.getUnsyncedGitEntries();
    if (entries.length === 0) {
      console.log('[wal] No changes to sync to git');
      return false;
    }

    console.log(`[wal] Syncing ${entries.length} changes to git...`);

    try {
      const { execSync } = await import('child_process');
      const cwd = '/workspace';

      // Stage grimoires and .beads
      execSync('git add grimoires/ .beads/ 2>/dev/null || true', { cwd });

      // Check if there are changes to commit
      const status = execSync('git status --porcelain grimoires/ .beads/', { cwd }).toString();
      if (!status.trim()) {
        console.log('[wal] No git changes to commit');
        return false;
      }

      // Commit
      const commitMsg = `chore(loa): sync state [${entries.length} changes]

Co-Authored-By: Loa Framework <noreply@loa.dev>`;
      execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd });

      // Push
      execSync('git push', { cwd });

      // Update checkpoint
      this.checkpoint.last_git_seq = entries[entries.length - 1].seq;
      this.checkpoint.last_git_sync = new Date().toISOString();
      await this.saveCheckpoint();

      console.log('[wal] Git sync complete');
      return true;
    } catch (err) {
      console.error('[wal] Git sync error:', err);
      return false;
    }
  }

  /**
   * Start background git sync (hourly)
   */
  startGitSync(): void {
    if (this.gitSyncTimer) return;

    this.gitSyncTimer = setInterval(async () => {
      try {
        await this.syncToGit();
      } catch (err) {
        console.error('[wal] Git sync error:', err);
      }
    }, GIT_SYNC_INTERVAL_MS);

    console.log(`[wal] Git sync started (every ${GIT_SYNC_INTERVAL_MS / 3600000}h)`);
  }

  /**
   * Stop background git sync
   */
  stopGitSync(): void {
    if (this.gitSyncTimer) {
      clearInterval(this.gitSyncTimer);
      this.gitSyncTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Get current sync status
   */
  async getStatus(): Promise<SyncStatus> {
    const entries = await this.readAllEntries();
    const pendingR2 = entries.filter((e) => e.seq > this.checkpoint.last_r2_seq).length;
    const pendingGit = entries.filter((e) => e.seq > this.checkpoint.last_git_seq).length;

    // Check R2 connectivity
    let r2Connected = false;
    try {
      await fs.promises.access(R2_MOUNT);
      r2Connected = true;
    } catch {
      // R2 not mounted
    }

    return {
      wal: {
        entries_pending_r2: pendingR2,
        entries_pending_git: pendingGit,
        last_write: entries.length > 0 ? new Date(entries[entries.length - 1].ts).toISOString() : null,
      },
      r2: {
        connected: r2Connected,
        last_sync: this.checkpoint.last_r2_sync || null,
        bytes_synced: 0, // TODO: track this
      },
      git: {
        last_sync: this.checkpoint.last_git_sync || null,
        last_commit: null, // TODO: get from git log
        pending_changes: pendingGit,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Compute SHA-256 checksum of content
   */
  private computeChecksum(content: Buffer): string {
    return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Resolve a relative path to full path
   * @throws Error if path traversal is detected
   */
  private resolveFullPath(relativePath: string): string {
    // Security: Defense-in-depth guard against path traversal
    if (relativePath.includes('..')) {
      throw new Error(`Invalid path: traversal not allowed (${relativePath})`);
    }

    if (relativePath.startsWith('.beads/')) {
      return path.join(BEADS_DIR, relativePath.replace('.beads/', ''));
    }
    return path.join(GRIMOIRES_DIR, relativePath);
  }

  /**
   * Shutdown - flush and stop timers
   */
  async shutdown(): Promise<void> {
    console.log('[wal] Shutting down...');

    this.stopR2Sync();
    this.stopGitSync();

    // Final sync
    await this.syncToR2();
    await this.syncToGit();

    console.log('[wal] Shutdown complete');
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let instance: WALManager | null = null;

export function getWALManager(): WALManager {
  if (!instance) {
    instance = new WALManager();
  }
  return instance;
}

export default WALManager;
