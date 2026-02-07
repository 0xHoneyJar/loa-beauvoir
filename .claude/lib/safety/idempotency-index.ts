/**
 * IdempotencyIndex - Deduplication guard for agent job operations.
 *
 * Implements SDD section 3.7: deterministic key generation, durable status tracking,
 * TTL-based eviction, and boot-time reconciliation of pending entries.
 *
 * Lifecycle: markPending -> markCompleted | markFailed
 * Failed is terminal - no further transitions allowed.
 */

import { createHash } from "node:crypto";
import type { ResilientStore } from "../persistence/resilient-store.js";

// -- Types -------------------------------------------------------

export type DedupStatus = "pending" | "completed" | "failed";
export type CompensationStrategy = "safe_retry" | "check_then_retry" | "skip";

export interface DedupEntry {
  key: string;
  status: DedupStatus;
  createdAt: string; // ISO-8601
  completedAt?: string;
  failedAt?: string;
  intentSeq?: number;
  compensationStrategy: CompensationStrategy;
  lastError?: string;
  attempts: number;
}

export interface DedupState {
  entries: Record<string, DedupEntry>;
  _schemaVersion: number;
}

export type AuditQueryFn = (
  intentSeq: number,
) => Promise<{ hasResult: boolean; error?: string } | null>;

export interface IdempotencyIndexConfig {
  store: ResilientStore<DedupState>;
  auditQuery?: AuditQueryFn;
  ttlMs?: number;
  /** Maximum number of entries before FIFO eviction kicks in. Default: 10000 */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Interface for IdempotencyIndex consumers (e.g. HardenedExecutor).
 * Allows type-safe usage without coupling to the concrete class.
 */
export interface IdempotencyIndexApi {
  check(key: string): Promise<DedupEntry | null>;
  markPending(key: string, intentSeq: number, strategy: CompensationStrategy): Promise<DedupEntry>;
  markCompleted(key: string): Promise<DedupEntry>;
  markFailed(key: string, error: string): Promise<DedupEntry>;
}

// -- Constants ---------------------------------------------------

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_ENTRIES = 10_000;
const SCHEMA_VERSION = 1;
const HASH_HEX_LENGTH = 16;

// -- Implementation ----------------------------------------------

export class IdempotencyIndex {
  private readonly store: ResilientStore<DedupState>;
  private readonly auditQuery?: AuditQueryFn;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  private state: DedupState | null = null;

  constructor(config: IdempotencyIndexConfig) {
    this.store = config.store;
    this.auditQuery = config.auditQuery;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = config.now ?? Date.now;
  }

  /**
   * Generate a deterministic dedup key from action components.
   * Format: {action}:{scope}/{resource}:{hash16}
   * Hash is SHA-256 of canonical params, truncated to 16 hex chars.
   */
  static generateKey(
    action: string,
    scope: string,
    resource: string,
    params: Record<string, unknown>,
  ): string {
    const canonical = JSON.stringify(params, Object.keys(params).sort());
    const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
    const hash16 = hash.substring(0, HASH_HEX_LENGTH);
    return `${action}:${scope}/${resource}:${hash16}`;
  }

  /**
   * Check for an existing dedup entry. Returns null if not found.
   */
  async check(key: string): Promise<DedupEntry | null> {
    const state = await this.ensureLoaded();
    return state.entries[key] ?? null;
  }

  /**
   * Create a pending dedup entry. Durably persisted.
   */
  async markPending(
    key: string,
    intentSeq: number,
    strategy: CompensationStrategy,
  ): Promise<DedupEntry> {
    const state = await this.ensureLoaded();

    // Guard: never overwrite a completed or failed (terminal) entry
    const existing = state.entries[key];
    if (existing && (existing.status === "completed" || existing.status === "failed")) {
      return existing;
    }

    const entry: DedupEntry = {
      key,
      status: "pending",
      createdAt: new Date(this.now()).toISOString(),
      intentSeq,
      compensationStrategy: strategy,
      attempts: 1,
    };
    state.entries[key] = entry;

    // Proactive FIFO cap: evict oldest entries if we exceed maxEntries
    const keys = Object.keys(state.entries);
    if (keys.length > this.maxEntries) {
      const sorted = Object.entries(state.entries).sort(
        ([, a], [, b]) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      const excess = sorted.length - this.maxEntries;
      for (let i = 0; i < excess; i++) {
        delete state.entries[sorted[i][0]];
      }
    }

    await this.persist();
    return entry;
  }

  /**
   * Transition pending to completed. Throws if entry is failed (terminal).
   */
  async markCompleted(key: string): Promise<DedupEntry> {
    const state = await this.ensureLoaded();
    const entry = state.entries[key];
    if (!entry) {
      throw new Error(`IdempotencyIndex: no entry found for key "${key}"`);
    }
    if (entry.status === "failed") {
      throw new Error(`IdempotencyIndex: cannot transition failed -> completed for key "${key}"`);
    }
    entry.status = "completed";
    entry.completedAt = new Date(this.now()).toISOString();
    await this.persist();
    return entry;
  }

  /**
   * Transition pending to failed (terminal). Sets failedAt + lastError.
   */
  async markFailed(key: string, error: string): Promise<DedupEntry> {
    const state = await this.ensureLoaded();
    const entry = state.entries[key];
    if (!entry) {
      throw new Error(`IdempotencyIndex: no entry found for key "${key}"`);
    }
    entry.status = "failed";
    entry.failedAt = new Date(this.now()).toISOString();
    entry.lastError = error;
    await this.persist();
    return entry;
  }

  /**
   * Remove entries older than ttlMs and enforce FIFO max entries cap.
   * Returns count of evicted entries.
   */
  async evict(): Promise<number> {
    const state = await this.ensureLoaded();
    const cutoff = this.now() - this.ttlMs;
    let evicted = 0;

    // Phase 1: TTL-based eviction
    for (const [key, entry] of Object.entries(state.entries)) {
      const createdMs = new Date(entry.createdAt).getTime();
      if (createdMs < cutoff) {
        delete state.entries[key];
        evicted++;
      }
    }

    // Phase 2: FIFO cap — evict oldest entries if count exceeds maxEntries
    const entries = Object.entries(state.entries);
    if (entries.length > this.maxEntries) {
      const sorted = entries.sort(
        ([, a], [, b]) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      const excess = sorted.length - this.maxEntries;
      for (let i = 0; i < excess; i++) {
        delete state.entries[sorted[i][0]];
        evicted++;
      }
    }

    if (evicted > 0) {
      await this.persist();
    }
    return evicted;
  }

  /**
   * Boot-time reconciliation of pending entries.
   *
   * Returns pending entries needing compensation. Failed entries are
   * never returned (terminal state). If auditQuery is configured,
   * entries with audit results are auto-promoted before returning.
   */
  async reconcilePending(): Promise<DedupEntry[]> {
    const state = await this.ensureLoaded();
    const pendingEntries = Object.values(state.entries).filter((e) => e.status === "pending");

    if (pendingEntries.length === 0) {
      return [];
    }

    // Without auditQuery, return all pending entries as-is
    if (!this.auditQuery) {
      return pendingEntries;
    }

    const needsCompensation: DedupEntry[] = [];
    let mutated = false;

    for (const entry of pendingEntries) {
      if (entry.intentSeq === undefined) {
        needsCompensation.push(entry);
        continue;
      }

      const auditResult = await this.auditQuery(entry.intentSeq);

      if (auditResult === null) {
        // No audit trail result -- needs compensation
        needsCompensation.push(entry);
        continue;
      }

      if (auditResult.error) {
        // Audit shows error -- auto-promote to failed
        entry.status = "failed";
        entry.failedAt = new Date(this.now()).toISOString();
        entry.lastError = auditResult.error;
        mutated = true;
      } else if (auditResult.hasResult) {
        // Audit shows success -- auto-promote to completed
        entry.status = "completed";
        entry.completedAt = new Date(this.now()).toISOString();
        mutated = true;
      } else {
        needsCompensation.push(entry);
      }
    }

    if (mutated) {
      await this.persist();
    }

    return needsCompensation;
  }

  // -- Private ---------------------------------------------------

  /** Lazy-load state from store on first access. */
  private async ensureLoaded(): Promise<DedupState> {
    if (this.state) return this.state;

    const stored = await this.store.get();
    this.state = stored ?? { entries: {}, _schemaVersion: SCHEMA_VERSION };
    return this.state;
  }

  /** Persist in-memory state to durable store. */
  private async persist(): Promise<void> {
    if (!this.state) return;
    await this.store.set(this.state);
  }
}
