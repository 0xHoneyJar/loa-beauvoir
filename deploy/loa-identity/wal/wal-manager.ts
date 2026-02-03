/**
 * WAL Manager - Segmented Write-Ahead Log with flock/PID locking
 *
 * Implements 10MB segment rotation, 1-hour rotation, and single-writer
 * enforcement via flock + PID lockfile.
 *
 * Crash Semantics:
 * - Two-phase rotation: (1) write checkpoint, (2) rotate
 * - Replay from last checkpoint on crash
 * - Truncate to last valid checksum on corruption
 *
 * @module deploy/loa-identity/wal/wal-manager
 */

import {
  appendFile,
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
  stat,
  readdir,
  open,
  type FileHandle,
} from 'fs/promises';
import { existsSync, createWriteStream, constants } from 'fs';
import { createHash } from 'crypto';
import { dirname, join, basename } from 'path';

// Import flock binding if available
let flock: ((fd: number, operation: number) => Promise<void>) | null = null;
try {
  // Try to load fs-ext for proper flock support
  const fsExt = await import('fs-ext').catch(() => null);
  if (fsExt?.flock) {
    flock = (fd: number, operation: number): Promise<void> => {
      return new Promise((resolve, reject) => {
        fsExt.flock(fd, operation, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    };
  }
} catch {
  // fs-ext not available, will use fallback
}

// flock constants
const LOCK_EX = 2; // Exclusive lock
const LOCK_NB = 4; // Non-blocking
const LOCK_UN = 8; // Unlock

export interface WALEntry {
  seq: number;
  timestamp: string;
  operation: 'write' | 'delete' | 'mkdir';
  path: string;
  checksum?: string; // SHA-256 of data
  data?: string; // Base64 encoded
  entryChecksum: string; // SHA-256 of entry without this field
}

export interface WALSegment {
  id: string;
  path: string;
  size: number;
  entries: number;
  createdAt: string;
  closedAt?: string;
}

export interface WALCheckpoint {
  lastSeq: number;
  activeSegment: string;
  segments: WALSegment[];
  lastCheckpointAt: string;
  rotationPhase: 'none' | 'checkpoint_written' | 'rotating';
}

export interface SegmentedWALConfig {
  walDir: string;
  maxSegmentSize: number; // bytes, default 10MB
  maxSegmentAge: number; // ms, default 1 hour
  maxSegments: number; // retention count, default 10
}

/**
 * SegmentedWALManager provides crash-resilient persistence with
 * segmentation, locking, and two-phase rotation.
 *
 * SECURITY: Uses flock-based locking to prevent TOCTOU race conditions.
 * The lock is held for the entire lifetime of the WAL manager.
 */
export class SegmentedWALManager {
  private config: Required<SegmentedWALConfig>;
  private checkpoint: WALCheckpoint | null = null;
  private currentSegmentPath: string | null = null;
  private currentSegmentSize = 0;
  private seq = 0;
  private lockHandle: FileHandle | null = null;
  private initialized = false;

  constructor(config: SegmentedWALConfig) {
    this.config = {
      walDir: config.walDir,
      maxSegmentSize: config.maxSegmentSize ?? 10 * 1024 * 1024, // 10MB
      maxSegmentAge: config.maxSegmentAge ?? 60 * 60 * 1000, // 1 hour
      maxSegments: config.maxSegments ?? 10,
    };
  }

  /**
   * Initialize WAL manager with lock acquisition
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure WAL directory exists
    if (!existsSync(this.config.walDir)) {
      await mkdir(this.config.walDir, { recursive: true });
    }

    // Acquire lock
    await this.acquireLock();

    // Load or create checkpoint
    await this.loadCheckpoint();

    // Handle interrupted rotation
    if (this.checkpoint!.rotationPhase !== 'none') {
      await this.recoverFromInterruptedRotation();
    }

    // Ensure we have an active segment
    if (!this.checkpoint!.activeSegment) {
      await this.createNewSegment();
    } else {
      this.currentSegmentPath = join(
        this.config.walDir,
        this.checkpoint!.activeSegment
      );
      // Get current segment size
      if (existsSync(this.currentSegmentPath)) {
        const stats = await stat(this.currentSegmentPath);
        this.currentSegmentSize = stats.size;
      }
    }

    this.seq = this.checkpoint!.lastSeq;
    this.initialized = true;

    console.log(`[wal] Initialized with seq=${this.seq}, segment=${this.checkpoint!.activeSegment}`);
  }

  /**
   * Acquire exclusive lock via flock + PID file
   *
   * SECURITY: This uses a two-layer locking strategy to prevent TOCTOU:
   * 1. flock() for atomic kernel-level locking (if available)
   * 2. PID file as a fallback and for debugging
   *
   * The lock file is kept OPEN for the lifetime of the WAL manager,
   * ensuring the flock is held continuously.
   */
  private async acquireLock(): Promise<void> {
    const lockPath = join(this.config.walDir, 'wal.lock');
    const pidPath = join(this.config.walDir, 'wal.pid');

    // Open lock file and keep it open (this is critical for flock)
    this.lockHandle = await open(lockPath, 'w');

    // Try to acquire flock (non-blocking to detect conflicts)
    if (flock) {
      try {
        await flock(this.lockHandle.fd, LOCK_EX | LOCK_NB);
        console.log('[wal] flock acquired');
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
          // Lock is held by another process
          await this.lockHandle.close();
          this.lockHandle = null;

          // Check PID for informative error
          if (existsSync(pidPath)) {
            const existingPid = await readFile(pidPath, 'utf-8');
            throw new Error(
              `WAL is locked by process ${existingPid.trim()}. Only one writer allowed.`
            );
          }
          throw new Error('WAL is locked by another process. Only one writer allowed.');
        }
        // Other flock errors - fall through to PID-based locking
        console.warn('[wal] flock failed, using PID-based locking:', err.message);
      }
    } else {
      console.warn('[wal] flock not available (install fs-ext for proper locking)');
    }

    // PID-based fallback/secondary check
    // This catches cases where flock is not available
    if (existsSync(pidPath)) {
      const existingPid = await readFile(pidPath, 'utf-8');
      const pid = parseInt(existingPid.trim(), 10);

      // Check if process is still running
      try {
        process.kill(pid, 0); // Signal 0 = check existence
        // Process is running - if we have flock, we're fine (we hold the lock)
        // If no flock, this is a conflict
        if (!flock) {
          if (this.lockHandle) {
            await this.lockHandle.close();
            this.lockHandle = null;
          }
          throw new Error(
            `WAL is locked by process ${pid}. Only one writer allowed.`
          );
        }
        // We have flock AND process is running - we won the lock, process will fail
        console.log(`[wal] Taking over from process ${pid} (we hold flock)`);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw e; // Re-throw if not "no such process"
        }
        // Process is dead, we can take over
        console.log(`[wal] Stale lock from dead process ${pid}, taking over`);
      }
    }

    // Write our PID (atomic write)
    const tempPidPath = `${pidPath}.tmp.${process.pid}`;
    await writeFile(tempPidPath, process.pid.toString(), 'utf-8');
    await rename(tempPidPath, pidPath);

    console.log(`[wal] Lock acquired (PID ${process.pid})`);
  }

  /**
   * Release lock
   *
   * SECURITY: Releases flock by closing the file handle.
   * The lock is automatically released when the process exits,
   * but explicit release is good practice.
   */
  private async releaseLock(): Promise<void> {
    const pidPath = join(this.config.walDir, 'wal.pid');

    // Release flock by closing the lock file handle
    if (this.lockHandle) {
      try {
        if (flock) {
          await flock(this.lockHandle.fd, LOCK_UN);
        }
        await this.lockHandle.close();
        this.lockHandle = null;
        console.log('[wal] flock released');
      } catch (e) {
        console.warn('[wal] Error releasing flock:', e);
      }
    }

    // Remove PID file if it's ours
    try {
      const existingPid = await readFile(pidPath, 'utf-8');
      if (parseInt(existingPid.trim(), 10) === process.pid) {
        await unlink(pidPath);
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Load checkpoint from disk
   */
  private async loadCheckpoint(): Promise<void> {
    const checkpointPath = join(this.config.walDir, 'checkpoint.json');

    if (existsSync(checkpointPath)) {
      const content = await readFile(checkpointPath, 'utf-8');
      this.checkpoint = JSON.parse(content);
    } else {
      this.checkpoint = {
        lastSeq: 0,
        activeSegment: '',
        segments: [],
        lastCheckpointAt: new Date().toISOString(),
        rotationPhase: 'none',
      };
      await this.saveCheckpoint();
    }
  }

  /**
   * Save checkpoint to disk (atomic)
   */
  private async saveCheckpoint(): Promise<void> {
    if (!this.checkpoint) return;

    const checkpointPath = join(this.config.walDir, 'checkpoint.json');
    const tempPath = `${checkpointPath}.tmp`;

    this.checkpoint.lastCheckpointAt = new Date().toISOString();

    await writeFile(tempPath, JSON.stringify(this.checkpoint, null, 2), 'utf-8');
    await this.fsync(tempPath);
    await rename(tempPath, checkpointPath);
  }

  /**
   * Create a new segment
   */
  private async createNewSegment(): Promise<void> {
    const segmentId = `segment-${Date.now()}.wal`;
    const segmentPath = join(this.config.walDir, segmentId);

    // Create empty segment file
    await writeFile(segmentPath, '', 'utf-8');

    const segment: WALSegment = {
      id: segmentId,
      path: segmentPath,
      size: 0,
      entries: 0,
      createdAt: new Date().toISOString(),
    };

    this.checkpoint!.segments.push(segment);
    this.checkpoint!.activeSegment = segmentId;
    this.currentSegmentPath = segmentPath;
    this.currentSegmentSize = 0;

    await this.saveCheckpoint();

    console.log(`[wal] Created new segment: ${segmentId}`);
  }

  /**
   * Append entry to WAL
   */
  async append(
    operation: 'write' | 'delete' | 'mkdir',
    path: string,
    data?: Buffer
  ): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check if rotation needed
    await this.maybeRotate();

    const entry: Omit<WALEntry, 'entryChecksum'> = {
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      operation,
      path,
    };

    if (data) {
      entry.checksum = this.computeChecksum(data);
      entry.data = data.toString('base64');
    }

    // Compute entry checksum
    const entryChecksum = this.computeEntryChecksum(entry);
    const fullEntry: WALEntry = { ...entry, entryChecksum };

    // Append to segment
    const line = JSON.stringify(fullEntry) + '\n';
    await appendFile(this.currentSegmentPath!, line, 'utf-8');
    await this.fsyncFile(this.currentSegmentPath!);

    this.currentSegmentSize += Buffer.byteLength(line);

    // Update checkpoint
    this.checkpoint!.lastSeq = this.seq;
    const activeSegment = this.checkpoint!.segments.find(
      (s) => s.id === this.checkpoint!.activeSegment
    );
    if (activeSegment) {
      activeSegment.size = this.currentSegmentSize;
      activeSegment.entries++;
    }

    return this.seq;
  }

  /**
   * Check if rotation is needed and perform it
   */
  private async maybeRotate(): Promise<void> {
    if (!this.currentSegmentPath) return;

    const activeSegment = this.checkpoint!.segments.find(
      (s) => s.id === this.checkpoint!.activeSegment
    );

    if (!activeSegment) return;

    const age = Date.now() - new Date(activeSegment.createdAt).getTime();
    const sizeExceeded = this.currentSegmentSize >= this.config.maxSegmentSize;
    const ageExceeded = age >= this.config.maxSegmentAge;

    if (sizeExceeded || ageExceeded) {
      await this.rotate();
    }
  }

  /**
   * Two-phase segment rotation
   */
  private async rotate(): Promise<void> {
    console.log('[wal] Starting segment rotation...');

    // Phase 1: Write checkpoint with rotation phase
    this.checkpoint!.rotationPhase = 'checkpoint_written';
    await this.saveCheckpoint();

    // Phase 2: Perform rotation
    this.checkpoint!.rotationPhase = 'rotating';

    // Close current segment
    const activeSegment = this.checkpoint!.segments.find(
      (s) => s.id === this.checkpoint!.activeSegment
    );
    if (activeSegment) {
      activeSegment.closedAt = new Date().toISOString();
    }

    // Create new segment
    await this.createNewSegment();

    // Clean up old segments
    await this.cleanupOldSegments();

    // Complete rotation
    this.checkpoint!.rotationPhase = 'none';
    await this.saveCheckpoint();

    console.log('[wal] Segment rotation complete');
  }

  /**
   * Recover from interrupted rotation
   */
  private async recoverFromInterruptedRotation(): Promise<void> {
    console.log(
      `[wal] Recovering from interrupted rotation (phase: ${this.checkpoint!.rotationPhase})`
    );

    if (this.checkpoint!.rotationPhase === 'checkpoint_written') {
      // Checkpoint was written but rotation didn't start
      // Just reset and continue with current segment
      this.checkpoint!.rotationPhase = 'none';
    } else if (this.checkpoint!.rotationPhase === 'rotating') {
      // Rotation was in progress - complete it
      await this.createNewSegment();
      await this.cleanupOldSegments();
      this.checkpoint!.rotationPhase = 'none';
    }

    await this.saveCheckpoint();
  }

  /**
   * Clean up old segments beyond retention
   */
  private async cleanupOldSegments(): Promise<void> {
    const closedSegments = this.checkpoint!.segments.filter((s) => s.closedAt);

    if (closedSegments.length <= this.config.maxSegments) {
      return;
    }

    // Sort by closed time (oldest first)
    closedSegments.sort(
      (a, b) =>
        new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime()
    );

    const toRemove = closedSegments.slice(
      0,
      closedSegments.length - this.config.maxSegments
    );

    for (const segment of toRemove) {
      try {
        await unlink(segment.path);
        const index = this.checkpoint!.segments.findIndex(
          (s) => s.id === segment.id
        );
        if (index !== -1) {
          this.checkpoint!.segments.splice(index, 1);
        }
        console.log(`[wal] Removed old segment: ${segment.id}`);
      } catch (e) {
        console.warn(`[wal] Failed to remove segment ${segment.id}:`, e);
      }
    }
  }

  /**
   * Replay WAL entries from checkpoint
   */
  async replay(
    callback: (entry: WALEntry) => Promise<void>
  ): Promise<{ replayed: number; errors: number }> {
    if (!this.initialized) {
      await this.initialize();
    }

    console.log('[wal] Replaying entries...');

    let replayed = 0;
    let errors = 0;

    // Sort segments by creation time
    const sortedSegments = [...this.checkpoint!.segments].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    for (const segment of sortedSegments) {
      if (!existsSync(segment.path)) continue;

      const content = await readFile(segment.path, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as WALEntry;

          // Verify entry checksum
          const { entryChecksum, ...entryWithoutChecksum } = entry;
          const computed = this.computeEntryChecksum(entryWithoutChecksum);

          if (computed !== entryChecksum) {
            console.warn(
              `[wal] Entry checksum mismatch at seq=${entry.seq}, truncating`
            );
            errors++;
            // Truncate - don't process further entries
            break;
          }

          await callback(entry);
          replayed++;
        } catch (e) {
          console.error('[wal] Replay error:', e);
          errors++;
        }
      }
    }

    console.log(`[wal] Replayed ${replayed} entries, ${errors} errors`);
    return { replayed, errors };
  }

  /**
   * Get all entries since a sequence number
   */
  async getEntriesSince(sinceSeq: number): Promise<WALEntry[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    const entries: WALEntry[] = [];

    for (const segment of this.checkpoint!.segments) {
      if (!existsSync(segment.path)) continue;

      const content = await readFile(segment.path, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as WALEntry;
          if (entry.seq > sinceSeq) {
            entries.push(entry);
          }
        } catch {
          // Skip invalid entries
        }
      }
    }

    return entries.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Force fsync on a file (data durability)
   */
  private async fsync(filePath: string): Promise<void> {
    const fd = await open(filePath, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  }

  /**
   * Fsync a file by path
   */
  private async fsyncFile(filePath: string): Promise<void> {
    try {
      await this.fsync(filePath);
    } catch {
      // Fsync may not be supported on all filesystems
    }
  }

  /**
   * Compute SHA-256 checksum of data
   */
  private computeChecksum(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Compute checksum of entry (for integrity verification)
   */
  private computeEntryChecksum(entry: Omit<WALEntry, 'entryChecksum'>): string {
    const sorted = JSON.stringify(entry, Object.keys(entry).sort());
    return createHash('sha256').update(sorted).digest('hex').substring(0, 16);
  }

  /**
   * Get current status
   */
  getStatus(): {
    seq: number;
    activeSegment: string;
    segmentCount: number;
    totalSize: number;
  } {
    const totalSize = this.checkpoint?.segments.reduce((sum, s) => sum + s.size, 0) ?? 0;

    return {
      seq: this.seq,
      activeSegment: this.checkpoint?.activeSegment ?? '',
      segmentCount: this.checkpoint?.segments.length ?? 0,
      totalSize,
    };
  }

  /**
   * Shutdown - save checkpoint and release lock
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    console.log('[wal] Shutting down...');

    await this.saveCheckpoint();
    await this.releaseLock();

    this.initialized = false;
    console.log('[wal] Shutdown complete');
  }
}

/**
 * Create a SegmentedWALManager with default config
 */
export function createSegmentedWALManager(
  walDir: string
): SegmentedWALManager {
  return new SegmentedWALManager({
    walDir,
    maxSegmentSize: 10 * 1024 * 1024, // 10MB
    maxSegmentAge: 60 * 60 * 1000, // 1 hour
    maxSegments: 10,
  });
}
