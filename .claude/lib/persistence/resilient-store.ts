/**
 * ResilientJsonStore — crash-safe JSON persistence with 8-step write protocol.
 *
 * Implements SDD section 3.8: atomic write (tmp+fsync+rename+dirsync),
 * read fallback chain (primary -> bak -> tmp), schema migrations,
 * and quarantine management.
 */

import * as fs from "fs";
import * as path from "path";
import type { BeauvoirLogger } from "../safety/logger.js";
import { AsyncMutex } from "./async-mutex.js";

// ── Interfaces ──────────────────────────────────────────────

export interface StoreConfig<T> {
  path: string;
  schemaVersion: number;
  migrations?: Record<number, (data: unknown) => unknown>;
  maxSizeBytes?: number;
  now?: () => number;
  logger: BeauvoirLogger;
}

export interface ResilientStore<T> {
  get(): Promise<T | null>;
  set(state: T): Promise<void>;
  clear(): Promise<void>;
  exists(): Promise<boolean>;
}

interface Envelope {
  _schemaVersion: number;
  _writeEpoch: number;
  [key: string]: unknown;
}

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Helpers ─────────────────────────────────────────────────

/** Sorted-keys replacer for deterministic JSON output. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce(
        (acc, k) => {
          acc[k] = obj[k];
          return acc;
        },
        {} as Record<string, unknown>,
      );
  }
  return value;
}

/** Parse and validate an envelope. Returns null on any failure. */
function parseEnvelope(raw: string, maxVersion: number): Envelope | null {
  try {
    const p = JSON.parse(raw);
    if (typeof p !== "object" || p === null) return null;
    if (typeof p._schemaVersion !== "number" || typeof p._writeEpoch !== "number") return null;
    if (p._schemaVersion > maxVersion) return null;
    return p as Envelope;
  } catch {
    return null;
  }
}

/** fsync a directory to ensure rename durability. */
async function fsyncDir(dirPath: string): Promise<void> {
  const fd = await fs.promises.open(dirPath, "r");
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}

/** List files in storePath's directory matching a pattern. */
async function listSiblings(
  storePath: string,
  test: (name: string, base: string) => boolean,
): Promise<string[]> {
  const dir = path.dirname(storePath);
  const base = path.basename(storePath);
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.filter((e) => test(e, base)).map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

function globTmpFiles(storePath: string): Promise<string[]> {
  // Matches both old format (.{pid}.tmp) and new format (.{pid}.{epoch}.tmp)
  return listSiblings(
    storePath,
    (e, base) => e.startsWith(`${base}.`) && e.endsWith(".tmp") && /\.\d+(\.\d+)?\.tmp$/.test(e),
  );
}

function globQuarantineFiles(storePath: string): Promise<string[]> {
  return listSiblings(storePath, (e, base) => e.startsWith(`${base}.quarantine.`));
}

async function unlinkSafe(p: string): Promise<void> {
  try {
    await fs.promises.unlink(p);
  } catch {
    /* missing is ok */
  }
}

// ── Implementation ──────────────────────────────────────────

export class ResilientJsonStore<T> implements ResilientStore<T> {
  private readonly storePath: string;
  private readonly schemaVersion: number;
  private readonly migrations: Record<number, (data: unknown) => unknown>;
  private readonly maxSizeBytes: number;
  private readonly now: () => number;
  private readonly logger: BeauvoirLogger;
  private readonly mutex = new AsyncMutex();
  private writeEpoch = 0;

  constructor(config: StoreConfig<T>) {
    this.storePath = config.path;
    this.schemaVersion = config.schemaVersion;
    this.migrations = config.migrations ?? {};
    this.maxSizeBytes = config.maxSizeBytes ?? DEFAULT_MAX_SIZE;
    this.now = config.now ?? Date.now;
    this.logger = config.logger;
  }

  async get(): Promise<T | null> {
    const result = await this.readFallbackChain();
    if (result === null) return null;

    let { envelope } = result;
    if (envelope._schemaVersion < this.schemaVersion) {
      envelope = this.runMigrations(envelope);
      try {
        await this.set(this.extractState(envelope) as T);
      } catch (err) {
        this.logger.warn("Failed to write back migrated state", err);
      }
    }

    if (envelope._writeEpoch > this.writeEpoch) {
      this.writeEpoch = envelope._writeEpoch;
    }
    return this.extractState(envelope) as T;
  }

  async set(state: T): Promise<void> {
    // Step 1: Serialize with monotonic epoch
    this.writeEpoch++;
    const envelope: Envelope = {
      _schemaVersion: this.schemaVersion,
      _writeEpoch: this.writeEpoch,
      ...(state as Record<string, unknown>),
    };
    const json = JSON.stringify(envelope, sortedReplacer, 2);

    // Step 2: Size guard (before touching disk)
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > this.maxSizeBytes) {
      this.writeEpoch--;
      throw new Error(`State size ${bytes} bytes exceeds maximum ${this.maxSizeBytes} bytes`);
    }

    // Step 3: Acquire mutex
    await this.mutex.acquire();
    try {
      const dir = path.dirname(this.storePath);
      await fs.promises.mkdir(dir, { recursive: true });
      // Include writeEpoch as a nonce so a stale tmp from a prior crashed set()
      // on the same PID doesn't block subsequent writes with EEXIST.
      const tmpPath = `${this.storePath}.${process.pid}.${this.writeEpoch}.tmp`;

      // Step 4: Write tmp (exclusive create) + Step 5: fsync tmp
      const tmpFd = await fs.promises.open(tmpPath, "wx");
      try {
        await tmpFd.writeFile(json, "utf8");
        await tmpFd.sync();
      } finally {
        await tmpFd.close();
      }

      // Step 6: Backup existing primary (rename + dirsync)
      try {
        await fs.promises.access(this.storePath);
        await fs.promises.rename(this.storePath, `${this.storePath}.bak`);
        await fsyncDir(dir);
      } catch {
        /* primary doesn't exist yet */
      }

      // Step 7: Promote tmp to primary (rename + dirsync)
      await fs.promises.rename(tmpPath, this.storePath);
      await fsyncDir(dir);
    } finally {
      // Step 8: Release mutex
      this.mutex.release();
    }
  }

  async clear(): Promise<void> {
    await this.mutex.acquire();
    try {
      await unlinkSafe(this.storePath);
      await unlinkSafe(`${this.storePath}.bak`);
      for (const t of await globTmpFiles(this.storePath)) await unlinkSafe(t);
      this.writeEpoch = 0;
    } finally {
      this.mutex.release();
    }
  }

  async exists(): Promise<boolean> {
    try {
      await fs.promises.access(this.storePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Delete quarantine files older than 7 days. */
  async cleanupQuarantine(): Promise<number> {
    const cutoff = this.now() - QUARANTINE_MAX_AGE_MS;
    let deleted = 0;
    for (const f of await globQuarantineFiles(this.storePath)) {
      try {
        const stat = await fs.promises.stat(f);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.unlink(f);
          deleted++;
          this.logger.info(`Cleaned up quarantine file: ${path.basename(f)}`);
        }
      } catch {
        /* skip inaccessible */
      }
    }
    return deleted;
  }

  // ── Private ─────────────────────────────────────────────

  private async readFallbackChain(): Promise<{ envelope: Envelope } | null> {
    let bestEpoch = -1;
    let bestEnvelope: Envelope | null = null;
    let source = "none";

    // Step 1: Try primary
    const primary = await this.tryReadFile(this.storePath);
    if (primary) {
      bestEnvelope = primary;
      bestEpoch = primary._writeEpoch;
      source = "primary";
    }

    // Step 2: Try .bak (only if primary failed)
    if (!bestEnvelope) {
      const bak = await this.tryReadFile(`${this.storePath}.bak`);
      if (bak) {
        this.logger.warn("Primary corrupt/missing, falling back to .bak");
        bestEnvelope = bak;
        bestEpoch = bak._writeEpoch;
        source = "bak";
      }
    }

    // Step 3: Scan tmp files — pick highest epoch, accept only if > primary/bak
    let tmpBest: Envelope | null = null;
    let tmpBestEpoch = -1;
    for (const tp of await globTmpFiles(this.storePath)) {
      const env = await this.tryReadFile(tp);
      if (env && env._writeEpoch > tmpBestEpoch) {
        tmpBest = env;
        tmpBestEpoch = env._writeEpoch;
      }
    }
    if (tmpBest && tmpBestEpoch > bestEpoch) {
      this.logger.warn("Recovering from tmp file with higher epoch");
      bestEnvelope = tmpBest;
      bestEpoch = tmpBestEpoch;
      source = "tmp";
    }

    // Step 4: Quarantine if no valid source found
    if (!bestEnvelope) {
      await this.quarantineCorruptFiles();
      return null;
    }

    // Cleanup stale tmp files (epoch <= chosen source)
    await this.cleanupStaleTmpFiles(bestEpoch);
    this.logger.debug(`Read state from ${source} (epoch=${bestEpoch})`);
    return { envelope: bestEnvelope };
  }

  private async tryReadFile(filePath: string): Promise<Envelope | null> {
    try {
      const raw = await fs.promises.readFile(filePath, "utf8");
      return parseEnvelope(raw, this.schemaVersion);
    } catch {
      return null;
    }
  }

  private runMigrations(envelope: Envelope): Envelope {
    let current = { ...envelope };
    for (let v = current._schemaVersion + 1; v <= this.schemaVersion; v++) {
      const migrate = this.migrations[v];
      if (!migrate) throw new Error(`Missing migration from version ${v - 1} to ${v}`);
      current = migrate(current) as Envelope;
      current._schemaVersion = v;
    }
    return current;
  }

  private extractState(envelope: Envelope): unknown {
    const { _schemaVersion, _writeEpoch, ...state } = envelope;
    return state;
  }

  private async quarantineCorruptFiles(): Promise<void> {
    const ts = this.now();
    const candidates = [
      this.storePath,
      `${this.storePath}.bak`,
      ...(await globTmpFiles(this.storePath)),
    ];
    for (const f of candidates) {
      try {
        await fs.promises.access(f);
        const dest = `${this.storePath}.quarantine.${ts}`;
        await fs.promises.rename(f, dest);
        this.logger.warn(`Quarantined corrupt file: ${path.basename(f)} -> ${path.basename(dest)}`);
      } catch {
        /* file doesn't exist */
      }
    }
  }

  private async cleanupStaleTmpFiles(maxEpoch: number): Promise<void> {
    for (const tp of await globTmpFiles(this.storePath)) {
      const env = await this.tryReadFile(tp);
      if (!env || env._writeEpoch <= maxEpoch) await unlinkSafe(tp);
    }
  }
}

// ── Factory ─────────────────────────────────────────────────

export interface ResilientStoreFactoryConfig {
  baseDir: string;
  logger: BeauvoirLogger;
}

export class ResilientStoreFactory {
  private readonly baseDir: string;
  private readonly logger: BeauvoirLogger;

  constructor(config: ResilientStoreFactoryConfig) {
    this.baseDir = config.baseDir;
    this.logger = config.logger;
  }

  create<T>(name: string, config: Omit<StoreConfig<T>, "path" | "logger">): ResilientJsonStore<T> {
    return new ResilientJsonStore<T>({
      ...config,
      path: path.join(this.baseDir, `${name}.json`),
      logger: this.logger,
    });
  }
}
