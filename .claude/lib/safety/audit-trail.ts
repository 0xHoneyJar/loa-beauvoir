/**
 * AuditTrail - Hash-chained JSONL append-only audit log
 *
 * Implements the 12-step append protocol from SDD §3.2:
 * 1. Acquire async mutex
 * 2. Redact all string fields via SecretRedactor
 * 3. Build record with prevHash linkage
 * 4. Canonical serialize (sorted keys, excluding hash/hmac)
 * 5. Compute SHA-256 hash
 * 6. Optional HMAC-SHA256
 * 7. Serialize full record as one JSONL line
 * 8. Robust append via O_APPEND fd with short-write retry
 * 9-11. Phase-appropriate fsync (immediate or batched)
 * 12. Release mutex
 */

import type { FileHandle } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, mkdir, rename, writeFile as fsWriteFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BeauvoirLogger } from "./logger";
import type { SecretRedactor } from "./secret-redactor";
import { AsyncMutex } from "../persistence/async-mutex";

// --- Types ---

export type AuditPhase = "intent" | "result" | "denied" | "dry_run";

export interface AuditRecord {
  seq: number;
  prevHash: string;
  hash: string;
  hmac?: string;
  phase: AuditPhase;
  intentSeq?: number;
  ts: string;
  action: string;
  target: string;
  params: Record<string, unknown>;
  dedupeKey?: string;
  result?: unknown;
  error?: string;
  dryRun: boolean;
}

export interface ChainVerification {
  valid: boolean;
  recordCount: number;
  brokenAt?: number;
  expected?: string;
  actual?: string;
  hmacError?: boolean;
}

export interface AuditTrailConfig {
  path: string;
  hmacKey?: string;
  redactor: SecretRedactor;
  logger: BeauvoirLogger;
  maxSizeBytes?: number;
  now?: () => number;
}

export class AuditWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditWriteError";
  }
}

// --- Constants ---

const GENESIS_HASH = "genesis";
const MAX_WRITE_RETRIES = 3;
const BATCH_FSYNC_MS = 100;
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10MB

// Fields excluded from canonical serialization
const EXCLUDED_FIELDS = new Set(["hash", "hmac"]);

// --- Helpers ---

/**
 * Canonical serialization: JSON.stringify with sorted keys, excluding hash/hmac
 * at the root level only. Nested objects with "hash" or "hmac" keys (e.g. commit
 * SHAs in params) are preserved.
 */
function canonicalize(record: AuditRecord): string {
  let isRoot = true;
  return JSON.stringify(record, (_key, value) => {
    // For non-object values, return as-is
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return value;
    }
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    const excludeAtThisLevel = isRoot;
    isRoot = false;
    for (const k of keys) {
      if (excludeAtThisLevel && EXCLUDED_FIELDS.has(k)) continue;
      sorted[k] = value[k];
    }
    return sorted;
  });
}

/**
 * Compute SHA-256 hex digest of a string.
 */
function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Compute HMAC-SHA256 hex digest.
 */
function hmacSha256(key: string, data: string): string {
  return createHmac("sha256", key).update(data, "utf8").digest("hex");
}

// --- AuditTrail class ---

export class AuditTrail {
  private readonly config: Required<
    Pick<AuditTrailConfig, "path" | "redactor" | "logger" | "maxSizeBytes">
  > &
    Pick<AuditTrailConfig, "hmacKey" | "now">;
  private readonly mutex = new AsyncMutex();
  private fd: FileHandle | null = null;
  private seq = 0;
  private prevHash = GENESIS_HASH;
  private pendingIntents = new Set<number>();
  private intentResultIndex = new Map<number, { hasResult: boolean; error?: string }>();
  private batchFsyncTimer: NodeJS.Timeout | null = null;
  private batchFsyncPending = false;
  private closed = false;

  constructor(config: AuditTrailConfig) {
    this.config = {
      path: config.path,
      hmacKey: config.hmacKey,
      redactor: config.redactor,
      logger: config.logger,
      maxSizeBytes: config.maxSizeBytes ?? DEFAULT_MAX_SIZE,
      now: config.now,
    };
  }

  /**
   * Initialize the audit trail: open fd, recover state from existing file.
   */
  async initialize(): Promise<void> {
    const dir = dirname(this.config.path);
    await mkdir(dir, { recursive: true });

    // Read existing file to recover state
    let existingContent = "";
    try {
      existingContent = await readFile(this.config.path, "utf8");
    } catch (err: unknown) {
      // File doesn't exist yet; that's fine
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    // Parse existing records, recovering from torn writes and chain breaks (TASK-1.5)
    if (existingContent.length > 0) {
      const lines = existingContent.split("\n").filter((l) => l.trim().length > 0);
      const validRecords: AuditRecord[] = [];
      let parseErrors = 0;
      let chainBreaks = 0;
      let expectedPrevHash = GENESIS_HASH;

      for (const line of lines) {
        // Step 1: JSON parse validation
        let record: AuditRecord;
        try {
          record = JSON.parse(line) as AuditRecord;
        } catch {
          parseErrors++;
          this.config.logger.warn("Discarding corrupt audit line during recovery", {
            line: line.substring(0, 100),
          });
          break;
        }

        // Step 2: Validate prevHash chain linkage
        if (record.prevHash !== expectedPrevHash) {
          chainBreaks++;
          this.config.logger.warn("Chain break detected during recovery", {
            seq: record.seq,
            expected: expectedPrevHash,
            actual: record.prevHash,
          });
          break;
        }

        // Step 3: Re-derive canonical form and verify hash integrity
        const canonical = canonicalize(record);
        const computedHash = sha256(canonical);
        if (record.hash !== computedHash) {
          chainBreaks++;
          this.config.logger.warn("Hash mismatch detected during recovery", {
            seq: record.seq,
            expected: computedHash,
            actual: record.hash,
          });
          break;
        }

        // Step 4: If HMAC enabled, validate HMAC signature
        if (this.config.hmacKey && record.hmac !== undefined) {
          const computedHmac = hmacSha256(this.config.hmacKey, canonical);
          if (record.hmac !== computedHmac) {
            chainBreaks++;
            this.config.logger.warn("HMAC mismatch detected during recovery", {
              seq: record.seq,
            });
            break;
          }
        }

        validRecords.push(record);
        expectedPrevHash = record.hash;

        // Rebuild pending intents and intent->result index during recovery (TASK-1.8)
        if (record.phase === "intent") {
          this.pendingIntents.add(record.seq);
        }
        if (record.phase === "result" && record.intentSeq !== undefined) {
          this.pendingIntents.delete(record.intentSeq);
          this.intentResultIndex.set(record.intentSeq, {
            hasResult: true,
            error: record.error,
          });
        }
      }

      if (validRecords.length > 0) {
        const lastRecord = validRecords[validRecords.length - 1];
        this.seq = lastRecord.seq;
        this.prevHash = lastRecord.hash;
      }

      // If we discarded lines, rewrite the file atomically using the same
      // tmp+fsync+rename+dirsync pattern as ResilientJsonStore.set() to ensure
      // the recovery path is at least as crash-safe as the happy path.
      const discarded = lines.length - validRecords.length;
      if (discarded > 0) {
        this.config.logger.warn(
          `Torn write recovery: discarded ${discarded} records (${parseErrors} parse errors, ${chainBreaks} chain breaks)`,
        );
        const validContent =
          validRecords.map((r) => JSON.stringify(r)).join("\n") +
          (validRecords.length > 0 ? "\n" : "");
        const tmpPath = `${this.config.path}.${process.pid}.recovery.tmp`;
        const tmpFd = await open(
          tmpPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
        );
        try {
          await tmpFd.writeFile(validContent, "utf8");
          await tmpFd.sync();
        } finally {
          await tmpFd.close();
        }
        await rename(tmpPath, this.config.path);
        const dirFd = await open(dir, constants.O_RDONLY);
        await dirFd.sync();
        await dirFd.close();
      }
    }

    // Open fd with O_APPEND | O_WRONLY | O_CREAT
    this.fd = await open(
      this.config.path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
    );

    this.config.logger.info("Audit trail initialized", {
      path: this.config.path,
      recoveredSeq: this.seq,
    });
  }

  /**
   * Record an intent (pre-mutation). Returns monotonic seq number.
   * Fsyncs immediately for mutation-durable guarantee.
   */
  async recordIntent(
    action: string,
    target: string,
    params: Record<string, unknown>,
    dedupeKey?: string,
  ): Promise<number> {
    // pendingIntents tracking moved inside appendRecord (before checkRotation)
    return this.appendRecord({
      phase: "intent",
      action,
      target,
      params,
      dedupeKey,
      dryRun: false,
    });
  }

  /**
   * Record a result, linked to a prior intent via intentSeq.
   * Fsyncs immediately.
   */
  async recordResult(
    intentSeq: number,
    action: string,
    target: string,
    result?: unknown,
    error?: string,
  ): Promise<number> {
    // pendingIntents + intentResultIndex managed inside appendRecord
    // (after durable append, before checkRotation)
    return this.appendRecord({
      phase: "result",
      intentSeq,
      action,
      target,
      params: {},
      result,
      error,
      dryRun: false,
    });
  }

  /**
   * Record a denied action (policy-blocked). Fsyncs immediately.
   */
  async recordDenied(
    action: string,
    target: string,
    params: Record<string, unknown>,
    error: string,
  ): Promise<number> {
    return this.appendRecord({
      phase: "denied",
      action,
      target,
      params,
      error,
      dryRun: false,
    });
  }

  /**
   * Record a dry-run action. Uses batched fsync (100ms timer).
   */
  async recordDryRun(
    action: string,
    target: string,
    params: Record<string, unknown>,
  ): Promise<number> {
    return this.appendRecord({
      phase: "dry_run",
      action,
      target,
      params,
      dryRun: true,
    });
  }

  /**
   * Verify the hash chain integrity of the entire audit log.
   * If hmacKey is provided, also verifies HMAC on records that have one.
   * Records without an hmac field (written without a key) are not flagged.
   */
  async verifyChain(hmacKey?: string): Promise<ChainVerification> {
    let content: string;
    try {
      content = await readFile(this.config.path, "utf8");
    } catch {
      return { valid: true, recordCount: 0 };
    }

    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      return { valid: true, recordCount: 0 };
    }

    let expectedPrevHash = GENESIS_HASH;

    for (let i = 0; i < lines.length; i++) {
      let record: AuditRecord;
      try {
        record = JSON.parse(lines[i]) as AuditRecord;
      } catch {
        return {
          valid: false,
          recordCount: i,
          brokenAt: i,
          expected: "valid JSON",
          actual: "parse error",
        };
      }

      // Verify prevHash linkage
      if (record.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          recordCount: i,
          brokenAt: i,
          expected: expectedPrevHash,
          actual: record.prevHash,
        };
      }

      // Re-derive canonical form and verify hash
      const canonical = canonicalize(record);
      const computedHash = sha256(canonical);
      if (record.hash !== computedHash) {
        return {
          valid: false,
          recordCount: i,
          brokenAt: i,
          expected: computedHash,
          actual: record.hash,
        };
      }

      // Verify HMAC if key provided and record carries an hmac field
      if (hmacKey !== undefined && record.hmac !== undefined) {
        const expectedHmac = hmacSha256(hmacKey, canonical);
        if (record.hmac !== expectedHmac) {
          return {
            valid: false,
            recordCount: i,
            brokenAt: i,
            expected: expectedHmac,
            actual: record.hmac,
            hmacError: true,
          };
        }
      }

      expectedPrevHash = record.hash;
    }

    return { valid: true, recordCount: lines.length };
  }

  /**
   * Get the set of pending (unresolved) intent sequence numbers.
   */
  getPendingIntents(): ReadonlySet<number> {
    return this.pendingIntents;
  }

  /**
   * Query whether a result record exists for a given intentSeq.
   * Returns { hasResult: true } for success, { hasResult: true, error } for
   * error results, or null if no result has been recorded yet.
   * Index is built during initialize() and kept current by recordResult().
   */
  async findResultByIntentSeq(
    intentSeq: number,
  ): Promise<{ hasResult: boolean; error?: string } | null> {
    const entry = this.intentResultIndex.get(intentSeq);
    return entry ?? null;
  }

  /**
   * Close the audit trail: flush pending fsync, close fd.
   */
  async close(): Promise<void> {
    if (this.closed) return;

    // Acquire mutex to wait for any in-flight appendRecord to complete
    await this.mutex.acquire();
    try {
      if (this.closed) return; // re-check after acquiring
      this.closed = true;

      // Clear batch timer
      if (this.batchFsyncTimer) {
        clearTimeout(this.batchFsyncTimer);
        this.batchFsyncTimer = null;
      }

      // Flush any pending batched fsync
      if (this.batchFsyncPending && this.fd) {
        try {
          await this.fd.sync();
        } catch {
          // Best-effort on close
        }
        this.batchFsyncPending = false;
      }

      // Close fd
      if (this.fd) {
        await this.fd.close();
        this.fd = null;
      }
    } finally {
      this.mutex.release();
    }
  }

  // --- Private: 12-step append protocol ---

  private async appendRecord(opts: {
    phase: AuditPhase;
    action: string;
    target: string;
    params: Record<string, unknown>;
    dedupeKey?: string;
    intentSeq?: number;
    result?: unknown;
    error?: string;
    dryRun: boolean;
  }): Promise<number> {
    if (this.closed) {
      throw new AuditWriteError("Audit trail is closed");
    }
    if (!this.fd) {
      throw new AuditWriteError("Audit trail not initialized (fd is null)");
    }

    // Step 1: Acquire mutex
    await this.mutex.acquire();
    try {
      // Step 2: Redact all string fields
      const redactor = this.config.redactor;
      const redactedParams = redactor.redactAny(opts.params) as Record<string, unknown>;
      const redactedResult =
        opts.result !== undefined ? redactor.redactAny(opts.result) : undefined;
      const redactedError = opts.error !== undefined ? redactor.redact(opts.error) : undefined;

      // Step 3: Build record with prevHash
      // Increment seq optimistically; rolled back on write failure to prevent gaps
      const newSeq = ++this.seq;
      const savedPrevHash = this.prevHash;
      const now = this.config.now ? this.config.now() : Date.now();
      const record: AuditRecord = {
        seq: newSeq,
        prevHash: this.prevHash,
        hash: "", // placeholder, computed below
        phase: opts.phase,
        ts: new Date(now).toISOString(),
        action: opts.action,
        target: opts.target,
        params: redactedParams,
        dryRun: opts.dryRun,
      };

      // Optional fields
      if (opts.intentSeq !== undefined) {
        record.intentSeq = opts.intentSeq;
      }
      if (opts.dedupeKey !== undefined) {
        record.dedupeKey = opts.dedupeKey;
      }
      if (redactedResult !== undefined) {
        record.result = redactedResult;
      }
      if (redactedError !== undefined) {
        record.error = redactedError;
      }

      // Step 4: Canonical serialize (sorted keys, excludes hash/hmac)
      const canonical = canonicalize(record);

      // Step 5: Compute SHA-256 hash
      record.hash = sha256(canonical);

      // Step 6: Optional HMAC (explicit undefined check to avoid empty-string bypass)
      if (this.config.hmacKey !== undefined) {
        record.hmac = hmacSha256(this.config.hmacKey, canonical);
      }

      // Step 7: Serialize full record as one line + \n
      const line = JSON.stringify(record) + "\n";
      const buffer = Buffer.from(line, "utf8");

      // Step 8: Robust append with short-write retry
      try {
        await this.robustWrite(buffer);
      } catch (writeErr) {
        // Rollback seq to prevent gaps on write failure
        this.seq = newSeq - 1;
        this.prevHash = savedPrevHash;
        throw writeErr;
      }

      // Steps 9-11: Phase-appropriate fsync
      if (opts.phase === "intent" || opts.phase === "result" || opts.phase === "denied") {
        // Immediate fsync for mutation-critical phases
        await this.fd!.sync();
      } else {
        // Batched fsync for dry_run/telemetry
        this.scheduleBatchFsync();
      }

      // Update chain state
      this.prevHash = record.hash;

      // Track pending intents inside mutex so checkRotation sees them
      if (opts.phase === "intent") {
        this.pendingIntents.add(newSeq);
      }

      // Resolve pending intents after durable append, before rotation check
      if (opts.phase === "result" && opts.intentSeq !== undefined) {
        this.pendingIntents.delete(opts.intentSeq);
        this.intentResultIndex.set(opts.intentSeq, { hasResult: true, error: redactedError });
      }

      // Check rotation after chain update, still inside mutex
      await this.checkRotation();

      return newSeq;
    } finally {
      // Step 12: Release mutex
      this.mutex.release();
    }
  }

  /**
   * Write buffer to fd with retry on short writes. Max 3 retries per write.
   */
  private async robustWrite(buffer: Buffer): Promise<void> {
    let offset = 0;
    let retries = 0;

    while (offset < buffer.length) {
      const result = await this.fd!.write(buffer, offset, buffer.length - offset);
      const bytesWritten = result.bytesWritten;

      if (bytesWritten <= 0) {
        retries++;
        if (retries > MAX_WRITE_RETRIES) {
          throw new AuditWriteError(
            `Failed to write audit record after ${MAX_WRITE_RETRIES} retries (0 bytes written)`,
          );
        }
        continue;
      }

      offset += bytesWritten;

      // If short write (didn't write everything), count as retry
      if (offset < buffer.length) {
        retries++;
        if (retries > MAX_WRITE_RETRIES) {
          throw new AuditWriteError(
            `Failed to write audit record after ${MAX_WRITE_RETRIES} retries (short write at offset ${offset}/${buffer.length})`,
          );
        }
      }
    }
  }

  /**
   * Rotate audit log if it exceeds maxSizeBytes and no intents are pending.
   * Renames current file to {path}.{timestamp}.jsonl, fsyncs parent dir,
   * resets chain state, and opens a fresh fd.
   */
  private async checkRotation(): Promise<void> {
    if (!this.fd) return;

    const stat = await this.fd.stat();
    if (stat.size < this.config.maxSizeBytes) return;

    // Defer rotation while any intent lacks a matching result
    if (this.pendingIntents.size > 0) {
      this.config.logger.info(`Rotation deferred: ${this.pendingIntents.size} pending intents`);
      return;
    }

    // Close current fd before rename
    await this.fd.close();
    this.fd = null;

    // Generate filesystem-safe timestamp for archive name
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = `${this.config.path}.${timestamp}.jsonl`;

    // Rename current file to archive
    await rename(this.config.path, archivePath);

    // Fsync parent directory to persist the rename
    const dirFd = await open(dirname(this.config.path), constants.O_RDONLY);
    await dirFd.sync();
    await dirFd.close();

    // Reset chain state for fresh file
    this.prevHash = GENESIS_HASH;
    this.seq = 0;
    this.intentResultIndex.clear();

    // Open new fd
    this.fd = await open(
      this.config.path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
    );

    this.config.logger.info("Audit trail rotated", {
      archivePath,
      path: this.config.path,
    });
  }

  /**
   * Schedule a batched fsync after 100ms. Timer is unref'd so it won't block exit.
   */
  private scheduleBatchFsync(): void {
    this.batchFsyncPending = true;
    if (this.batchFsyncTimer) return; // already scheduled

    this.batchFsyncTimer = setTimeout(async () => {
      this.batchFsyncTimer = null;
      if (this.fd && this.batchFsyncPending) {
        try {
          await this.fd.sync();
          this.batchFsyncPending = false;
        } catch (err) {
          this.config.logger.error("Batched fsync failed", err);
        }
      }
    }, BATCH_FSYNC_MS);
    this.batchFsyncTimer.unref();
  }
}
