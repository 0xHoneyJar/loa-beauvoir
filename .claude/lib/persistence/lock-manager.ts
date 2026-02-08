/**
 * LockManager - File-based advisory locks with O_EXCL atomic creation.
 *
 * Uses kernel-level O_EXCL to guarantee exactly one writer holds each named lock.
 * Stale locks (dead PIDs or age backstop) are recovered via double-read TOCTOU
 * mitigation before unlink.
 */

import { randomUUID } from "node:crypto";
import { open, readFile, unlink, readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { BeauvoirLogger } from "../safety/logger.js";
import { PersistenceError } from "./types.js";

// ── Interfaces ──────────────────────────────────────────────

export interface LockOwnership {
  id: string;
  pid: number;
  bootId: string;
  createdAt: number;
  lockVersion: number;
}

export interface LockManagerConfig {
  dataDir: string;
  maxAgeMs?: number;
  bootId: string;
  now?: () => number;
  logger: BeauvoirLogger;
}

// ── Constants ───────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 3_600_000; // 1 hour
const LOCK_SUFFIX = ".lock";

// ── Lock Manager ────────────────────────────────────────────

export class LockManager {
  private readonly locksDir: string;
  private readonly maxAgeMs: number;
  private readonly bootId: string;
  private readonly now: () => number;
  private readonly logger: BeauvoirLogger;
  private lockVersion = 0;

  constructor(config: LockManagerConfig) {
    this.locksDir = join(config.dataDir, "locks");
    this.maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.bootId = config.bootId;
    this.now = config.now ?? Date.now;
    this.logger = config.logger;
  }

  /** Acquire a named lock via O_EXCL atomic create. */
  async acquire(name: string): Promise<void> {
    await mkdir(this.locksDir, { recursive: true });
    const lockPath = this.lockFilePath(name);

    try {
      await this.writeLockFile(lockPath);
      this.logger.info(`Lock acquired: ${name}`);
    } catch (err: unknown) {
      if (isEExist(err)) {
        await this.handleExistingLock(name, lockPath);
        return;
      }
      throw err;
    }
  }

  /** Release a named lock by unlinking its lock file. Verifies ownership (PID + bootId). */
  async release(name: string): Promise<void> {
    const lockPath = this.lockFilePath(name);
    try {
      // Verify ownership before releasing to prevent accidental cross-process release
      const ownership = await this.readOwnership(lockPath);
      if (ownership && (ownership.pid !== process.pid || ownership.bootId !== this.bootId)) {
        this.logger.warn(`Lock release denied: ${name} not owned by this process`, {
          ownerPid: ownership.pid,
          ownerBootId: ownership.bootId,
          ourPid: process.pid,
          ourBootId: this.bootId,
        });
        return;
      }
      await unlink(lockPath);
      this.logger.info(`Lock released: ${name}`);
    } catch (err: unknown) {
      // ENOENT is fine — lock was already gone
      if (!isENoent(err)) throw err;
      this.logger.warn(`Lock release: file already absent for ${name}`);
    }
  }

  /** Scan all lock files, recover stale ones, return recovered names. */
  async recoverStaleLocks(): Promise<string[]> {
    await mkdir(this.locksDir, { recursive: true });
    const recovered: string[] = [];

    let entries: string[];
    try {
      entries = await readdir(this.locksDir);
    } catch {
      return recovered;
    }

    for (const entry of entries) {
      if (!entry.endsWith(LOCK_SUFFIX)) continue;
      const name = entry.slice(0, -LOCK_SUFFIX.length);
      const lockPath = join(this.locksDir, entry);

      const ownership = await this.readOwnership(lockPath);
      if (!ownership) continue;

      if (this.isStale(ownership)) {
        // Double-read TOCTOU mitigation
        const second = await this.readOwnership(lockPath);
        if (!second || second.id !== ownership.id) {
          this.logger.warn(`TOCTOU: lock ${name} changed between reads, skipping`);
          continue;
        }
        try {
          await unlink(lockPath);
          recovered.push(name);
          this.logger.info(`Recovered stale lock: ${name}`, {
            pid: ownership.pid,
            bootId: ownership.bootId,
            ageMs: this.now() - ownership.createdAt,
          });
        } catch (err: unknown) {
          if (!isENoent(err)) {
            this.logger.warn(`Failed to unlink stale lock ${name}`, err);
          }
        }
      }
    }

    return recovered;
  }

  // ── Private helpers ─────────────────────────────────────────

  private lockFilePath(name: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new PersistenceError(
        "INVALID_LOCK_NAME",
        `Lock name must match /^[a-zA-Z0-9_-]+$/: "${name}"`,
      );
    }
    return join(this.locksDir, `${name}${LOCK_SUFFIX}`);
  }

  /** Write lock ownership record with fsync on fd and parent directory. */
  private async writeLockFile(lockPath: string): Promise<void> {
    const ownership: LockOwnership = {
      id: randomUUID(),
      pid: process.pid,
      bootId: this.bootId,
      createdAt: this.now(),
      lockVersion: ++this.lockVersion,
    };

    // O_EXCL | O_CREAT | O_WRONLY — kernel-atomic create
    const fd = await open(lockPath, "wx");
    try {
      const data = Buffer.from(JSON.stringify(ownership) + "\n");
      await fd.write(data);
      await fd.datasync();
    } finally {
      await fd.close();
    }

    // Fsync parent directory to ensure the directory entry is durable
    await this.fsyncDir(dirname(lockPath));
  }

  /** Fsync a directory fd to persist directory entries. Tolerates EINVAL/ENOTSUP on overlayfs/NFS. */
  private async fsyncDir(dirPath: string): Promise<void> {
    let dirFd: import("node:fs/promises").FileHandle | undefined;
    try {
      dirFd = await open(dirPath, "r");
      await dirFd.sync();
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP") throw err;
    } finally {
      await dirFd?.close();
    }
  }

  /** Safely read and parse a lock ownership record. Protected for test seam. */
  protected async readOwnership(lockPath: string): Promise<LockOwnership | null> {
    try {
      const raw = await readFile(lockPath, "utf-8");
      return JSON.parse(raw) as LockOwnership;
    } catch {
      return null;
    }
  }

  /** Determine if a lock is stale (age backstop first, then PID liveness). */
  private isStale(ownership: LockOwnership): boolean {
    // Age backstop — always checked first
    const age = this.now() - ownership.createdAt;
    if (age > this.maxAgeMs) {
      this.logger.debug(`Lock stale: age ${age}ms > maxAge ${this.maxAgeMs}ms`);
      return true;
    }

    // PID liveness check
    try {
      process.kill(ownership.pid, 0);
      // Signal 0 succeeded — process is alive
      return false;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // No such process — PID is dead
        this.logger.debug(`Lock stale: PID ${ownership.pid} is dead (ESRCH)`);
        return true;
      }
      // EPERM — process exists but owned by another user; conservative = live
      return false;
    }
  }

  /** Handle an existing lock file: evaluate staleness and either recover or throw. */
  private async handleExistingLock(name: string, lockPath: string): Promise<void> {
    const ownership = await this.readOwnership(lockPath);
    if (!ownership) {
      // File vanished or unreadable — retry acquire
      await this.writeLockFile(lockPath);
      this.logger.info(`Lock acquired (retry): ${name}`);
      return;
    }

    if (this.isStale(ownership)) {
      // Double-read TOCTOU mitigation: confirm the file hasn't changed
      const second = await this.readOwnership(lockPath);
      if (!second || second.id !== ownership.id) {
        this.logger.warn(`TOCTOU: lock ${name} changed between reads during acquire`);
        throw new PersistenceError(
          "LOCK_CONTENTION",
          `Lock "${name}" contention: ownership changed during stale recovery`,
        );
      }

      await unlink(lockPath);
      this.logger.info(`Stale lock removed: ${name}`, {
        pid: ownership.pid,
        bootId: ownership.bootId,
      });

      // Retry acquire after removing stale lock. Between unlink and writeLockFile,
      // another process may have created the lock — catch EEXIST and rethrow as
      // LOCK_CONTENTION instead of a raw fs error.
      try {
        await this.writeLockFile(lockPath);
      } catch (writeErr: unknown) {
        if (isEExist(writeErr)) {
          throw new PersistenceError(
            "LOCK_CONTENTION",
            `Lock "${name}" contention: another process acquired the lock during stale recovery`,
          );
        }
        throw writeErr;
      }
      this.logger.info(`Lock acquired (after stale recovery): ${name}`);
      return;
    }

    // Lock is live — throw contention error
    throw new PersistenceError(
      "LOCK_CONTENTION",
      `Lock "${name}" held by PID ${ownership.pid} (boot ${ownership.bootId}, age ${this.now() - ownership.createdAt}ms)`,
    );
  }
}

// ── Error helpers ───────────────────────────────────────────

function isEExist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "EEXIST";
}

function isENoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}
