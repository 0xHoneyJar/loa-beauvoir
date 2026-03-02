# SDD: Beauvoir Production Hardening — Finn Pattern Transfer

> **Status**: Draft
> **Version**: 1.0.0
> **Created**: 2026-02-07
> **PRD Reference**: `grimoires/loa/prd.md` v1.0.0
> **Author**: Claude Opus 4.6 + Human Operator
> **Issue**: [loa-beauvoir#30](https://github.com/0xHoneyJar/loa-beauvoir/issues/30)

---

## Executive Summary

This SDD architects 9 production-hardening modules for the Beauvoir framework, adapted from loa-finn's battle-tested implementations. The design prioritizes:

1. **Crash safety** — Every mutation is audit-logged and dedup-indexed before execution
2. **Zero secret leakage** — All framework output routes through a redacting logger
3. **Failure intelligence** — Circuit breaker classifies failures; expected errors don't trip circuits
4. **Boot-time validation** — Deterministic startup with operating-mode gating

All modules are pure TypeScript (ESM), zero external dependencies, injectable clocks/filesystems for testing.

---

## 1. System Architecture

### 1.1 Module Dependency Graph

```
                    ┌──────────────────────┐
                    │   Boot Orchestrator   │ (F1)
                    │   boot/orchestrator   │
                    └──────────┬───────────┘
                               │ initializes in order
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                     ▼
  ┌───────────────┐  ┌─────────────────┐  ┌──────────────────┐
  │ Secret        │  │ Beauvoir Logger │  │ Boot ID +        │
  │ Redactor (F3) │─►│ (F3.6)         │  │ Lock Manager (F9)│
  └───────┬───────┘  └────────┬────────┘  └──────────────────┘
          │                    │
          ▼                    ▼
  ┌───────────────┐  ┌─────────────────┐  ┌──────────────────┐
  │ Audit Trail   │  │ Resilient JSON  │  │ Circuit Breaker  │
  │ (F2)          │  │ Store (F7)      │  │ (F4)             │
  └───────┬───────┘  └────────┬────────┘  └────────┬─────────┘
          │                    │                     │
          ▼                    ▼                     ▼
  ┌───────────────┐  ┌─────────────────┐  ┌──────────────────┐
  │ Idempotency   │  │ Rate Limiter    │  │ Tool Validator   │
  │ Index (F6)    │  │ (F5)            │  │ (F8)             │
  └───────────────┘  └─────────────────┘  └──────────────────┘
```

### 1.2 Directory Layout

```
.claude/lib/
├── boot/
│   └── orchestrator.ts          # F1: Boot sequence + health report
├── safety/
│   ├── audit-trail.ts           # F2: Hash-chained JSONL audit
│   ├── secret-redactor.ts       # F3: Pattern-based secret redaction
│   ├── logger.ts                # F3.6: BeauvoirLogger (redacting)
│   ├── tool-validator.ts        # F8: Boot-time tool validation
│   └── idempotency-index.ts     # F6: Dedup index
├── persistence/
│   ├── circuit-breaker.ts       # F4: Enhanced (replaces existing)
│   ├── resilient-store.ts       # F7: Resilient JSON store (replaces json-state-store)
│   ├── rate-limiter.ts          # F5: Token bucket rate limiter
│   ├── lock-manager.ts          # F9: Boot ID stale lock detection
│   ├── async-mutex.ts           # Shared: Promise-chain mutex
│   └── wal/                     # Existing WAL (unchanged)
└── workflow/
    └── engine.ts                # Existing (integrates F2, F5, F6)
```

### 1.3 Boot Initialization Order

| Step | Module                                 | Critical? | On Failure      |
| ---- | -------------------------------------- | --------- | --------------- |
| 1    | Config validation                      | Yes       | Abort boot      |
| 2    | FS validation (SSD check, O_EXCL test) | Yes       | Abort boot      |
| 3a   | SecretRedactor                         | Yes (P0)  | Abort boot      |
| 3b   | BeauvoirLogger                         | Yes (P0)  | Abort boot      |
| 3c   | AuditTrail (+ torn write recovery)     | Yes (P0)  | Abort boot      |
| 3d   | ResilientStore                         | No (P1)   | Degraded mode   |
| 3e   | CircuitBreaker                         | No (P1)   | Degraded mode   |
| 3f   | RateLimiter                            | No (P1)   | Degraded mode   |
| 3g   | IdempotencyIndex                       | No (P1)   | Degraded mode   |
| 4    | ToolValidator (cross-check MCP)        | Yes (P0)  | Abort boot      |
| 5    | Reconcile pending intents (F6.5)       | No        | Warn + continue |
| 6    | Recover stale locks (F9.5)             | No        | Warn + continue |
| 7    | Compute operating mode + health report | —         | Return report   |

---

## 2. Technology Stack

| Layer        | Choice                   | Justification                           |
| ------------ | ------------------------ | --------------------------------------- |
| Language     | TypeScript (ESM)         | Matches existing beauvoir codebase      |
| Runtime      | Node.js 22+              | LTS; required for `O_APPEND`, `flock`   |
| Crypto       | `node:crypto` (built-in) | SHA-256, HMAC-SHA256 — no external deps |
| File I/O     | `node:fs/promises`       | Atomic writes, O_EXCL, O_APPEND         |
| Testing      | Vitest                   | Matches existing test infrastructure    |
| Dependencies | Zero external            | Framework must not add npm dependencies |

### 2.1 Concurrency Model

All modules run within a single Node.js process on its single-threaded event loop. Synchronization requirements:

| Component        | Shared State                     | Synchronization                                                                                                                                             |
| ---------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AuditTrail       | File descriptor, hash chain      | AsyncMutex (serialize all appends) + LockManager (single-process)                                                                                           |
| ResilientStore   | File on disk, in-memory cache    | AsyncMutex per store instance (serialize read/write)                                                                                                        |
| CircuitBreaker   | In-memory failure records, state | None required — single-threaded event loop; no I/O yields between state reads and writes within a single `recordFailure()`/`execute()` call                 |
| RateLimiter      | In-memory token buckets          | None required — same rationale; `tryConsume()` is synchronous                                                                                               |
| IdempotencyIndex | In-memory map + ResilientStore   | Store's own mutex handles persistence; in-memory map access is synchronous                                                                                  |
| WorkflowEngine   | Run state                        | `advance()` callers MUST NOT call concurrently for the same `runId`; the engine does not internally serialize. Different `runId`s may advance concurrently. |

**Key invariant**: The `advance()` method for a given workflow run MUST NOT be called concurrently. The scheduler/caller is responsible for ensuring sequential invocation per run. This is enforced by the cron scheduler's single-run-at-a-time guarantee (existing `BeadsWorkQueue` pattern).

---

## 3. Component Design

### 3.1 Boot Orchestrator (`boot/orchestrator.ts`) — F1

**Purpose**: Deterministic startup with operating-mode gating.

```typescript
// ── Types ────────────────────────────────────────────────
type SubsystemStatus = "ok" | "degraded" | "failed";
type OperatingMode = "autonomous" | "degraded" | "dev";

interface BootConfig {
  dataDir: string;
  allowDev?: boolean; // default: false
  auditTrailPath?: string; // default: {dataDir}/audit.jsonl
  hmacKey?: string; // optional HMAC signing key
  mcpToolNames?: string[]; // available MCP tools for validation
  extraRedactionPatterns?: RedactionPattern[];
}

interface HealthReport {
  success: boolean;
  mode: OperatingMode;
  bootTimeMs: number;
  warnings: string[];
  subsystems: Record<string, SubsystemStatus>;
}

interface BootResult {
  health: HealthReport;
  services: {
    redactor: SecretRedactor;
    logger: BeauvoirLogger;
    auditTrail: AuditTrail;
    store: ResilientStoreFactory; // factory for creating typed stores
    circuitBreaker?: CircuitBreaker;
    rateLimiter?: RateLimiter;
    dedupIndex?: IdempotencyIndex;
    toolValidator?: ToolValidator;
    lockManager: LockManager;
  };
}

// ── Implementation ───────────────────────────────────────
async function boot(config: BootConfig): Promise<BootResult> {
  // Steps 1-7 per §1.3, with try/catch per subsystem
  // Returns services bag + health report
}
```

**Operating mode determination**:

- All P0 subsystems healthy + all P1 subsystems healthy → `autonomous`
- All P0 subsystems healthy + any P1 failed → `degraded`
- `config.allowDev === true` + any failure → `dev` (with loud warning)
- Any P0 failed + `allowDev !== true` → boot abort (throws)

**Mutation gating**: The `OperatingMode` is passed to the workflow engine. In `degraded` mode, the engine's `advance()` method checks each step's capability (read vs write) and rejects write steps with `PersistenceError("DEGRADED_MODE")`.

### 3.2 Audit Trail (`safety/audit-trail.ts`) — F2

**Purpose**: Tamper-evident, append-only action log with intent-result pairing.

```typescript
// ── Types ────────────────────────────────────────────────
type AuditPhase = "intent" | "result" | "denied" | "dry_run";

interface AuditRecord {
  seq: number;
  prevHash: string;
  hash: string;
  hmac?: string;
  phase: AuditPhase;
  intentSeq?: number; // links result → intent
  ts: string; // ISO-8601
  action: string; // e.g., "add_issue_comment"
  target: string; // e.g., "owner/repo#123"
  params: Record<string, unknown>;
  dedupeKey?: string;
  result?: unknown;
  error?: string;
  dryRun: boolean;
}

interface ChainVerification {
  valid: boolean;
  recordCount: number;
  brokenAt?: number; // seq number where chain broke
  expected?: string; // expected hash
  actual?: string; // actual hash
}

// ── Configuration ────────────────────────────────────────
interface AuditTrailConfig {
  path: string; // e.g., ".run/audit.jsonl"
  hmacKey?: string; // optional signing key
  redactor: SecretRedactor; // required
  maxSizeBytes?: number; // rotation threshold (default: 10MB)
  now?: () => number; // injectable clock
}

// ── Core API ─────────────────────────────────────────────
class AuditTrail {
  constructor(config: AuditTrailConfig);

  /** Initialize: recover from torn writes, verify chain tail. */
  async initialize(): Promise<void>;

  /** Record an intent before executing a mutation. Returns seq for pairing. */
  async recordIntent(
    fields: Omit<AuditRecord, "seq" | "prevHash" | "hash" | "hmac" | "phase" | "ts" | "dryRun">,
  ): Promise<number>;

  /** Record the result of a mutation. Links to intentSeq. */
  async recordResult(intentSeq: number, result: unknown, error?: string): Promise<number>;

  /** Record a denied action (policy blocked). */
  async recordDenied(
    fields: Omit<AuditRecord, "seq" | "prevHash" | "hash" | "hmac" | "phase" | "ts" | "dryRun">,
  ): Promise<number>;

  /** Verify the entire hash chain. */
  async verifyChain(): Promise<ChainVerification>;
}
```

**Append protocol**:

1. Acquire async mutex (single-writer enforced — see §3.8 AsyncMutex)
2. Redact all string fields in `params`, `result`, `error` via `redactor.redactAny()`
3. Build record with `prevHash` from last written record
4. Canonical serialize: `JSON.stringify(record, sortedKeys)` excluding `hash`/`hmac`
5. Compute `hash = SHA-256(canonical)`
6. If `hmacKey` set: `hmac = HMAC-SHA256(hmacKey, canonical)`
7. Serialize full record as one line + `\n` into a `Buffer`
8. Robust append via `O_APPEND` fd: loop `fs.write(fd, buffer, offset)` until all bytes written; treat short writes (`bytesWritten < buffer.length`) as retryable within the loop (max 3 retries per write, then throw `AuditWriteError`). Note: `O_APPEND` guarantees each `write()` starts at EOF on regular files (POSIX), but does NOT guarantee the full buffer is written atomically — the loop handles partial writes. The mutex ensures single-writer serialization.
9. **For `intent` phase (mutation)**: `fsync()` immediately — the intent MUST be durable before the mutation is allowed to execute. This is the mutation-durable guarantee.
10. **For `result`/`denied` phase**: `fsync()` immediately — confirms the side-effect outcome is persisted.
11. **For `dry_run` / telemetry phases**: schedule `fsync()` on 100ms batch timer (may lose last batch on crash — acceptable per PRD §F2.9).
12. Release mutex

**Single-process ownership**: The audit trail file MUST be owned by a single process. The `LockManager` (F9) acquires a process-level lock at boot that prevents concurrent writers. If multi-process scenarios arise, OS-level `flock(LOCK_EX)` on the fd would be required (not implemented in this version — documented as future consideration).

**Torn write recovery** (on `initialize()`):

1. Read file, split on `\n`
2. Discard last line if it doesn't parse as valid JSON
3. Truncate file to end of last valid line
4. Rebuild `prevHash` state from last valid record
5. Log warning with count of lost records

**Rotation**:

1. Check file size after each write
2. If >= `maxSizeBytes` AND no pending intent-result pairs (all intents have matching results): rename `audit.jsonl` → `audit.{timestamp}.jsonl`
3. Fsync parent directory
4. Open new `audit.jsonl` with fresh chain (prevHash = "genesis")

**Rotation safety**: Rotation is deferred while any intent lacks a matching result record. This prevents splitting intent-result pairs across files, which would break `verifyChain()` and `reconcilePending()` audit queries. The `AuditTrail` tracks pending intent seq numbers in memory (set on `recordIntent()`, cleared on `recordResult()`).

### 3.3 Secret Redactor (`safety/secret-redactor.ts`) — F3

**Purpose**: Pattern-based secret detection for strings and structured data.

```typescript
interface RedactionPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

class SecretRedactor {
  constructor(extraPatterns?: RedactionPattern[]);

  /** Redact secrets in a flat string. */
  redact(text: string): string;

  /** Deep-walk value, redacting all string leaves + known header keys. */
  redactAny(value: unknown): unknown;

  /** Create a new Error with redacted message + cause chain. */
  redactError(err: Error): Error;
}
```

**Built-in patterns** (order matters — most specific first):

1. `github_pat_[A-Za-z0-9_]{22,}` → `[REDACTED:github-pat]`
2. `ghp_[A-Za-z0-9_]{36,}` → `[REDACTED:github-pat]`
3. `ghs_[A-Za-z0-9_]{36,}` → `[REDACTED:github-app]`
4. `gho_[A-Za-z0-9_]{36,}` → `[REDACTED:github-oauth]`
5. `AKIA[0-9A-Z]{16}` → `[REDACTED:aws-key]`
6. `(?:key|token|secret|password)=[a-f0-9]{32,}` → `[REDACTED:api-key]`

**`redactAny()` logic**:

- `string` → `redact(value)`
- `Array` → `map(redactAny)`
- `object` → for each key-value:
  - If key matches `authorization|x-api-key|x-github-token|cookie|set-cookie` (case-insensitive): replace value with `[REDACTED:header]`
  - Else: `redactAny(value)`
- Primitives (number, boolean, null, undefined) → pass through

### 3.4 BeauvoirLogger (`safety/logger.ts`) — F3.6

**Purpose**: Centralized logging with mandatory redaction.

```typescript
type LogLevel = "debug" | "info" | "warn" | "error";

interface BeauvoirLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, error?: Error, data?: Record<string, unknown>): void;
}

function createLogger(
  redactor: SecretRedactor,
  options?: {
    level?: LogLevel;
    prefix?: string;
  },
): BeauvoirLogger;
```

All log methods redact `msg` via `redactor.redact()`, `data` via `redactor.redactAny()`, and errors via `redactor.redactError()` before emitting to `console`.

### 3.5 Enhanced Circuit Breaker (`persistence/circuit-breaker.ts`) — F4

**Purpose**: Replace existing consecutive-failure counter with classified rolling-window circuit breaker.

```typescript
// ── Failure Classification ───────────────────────────────
type FailureClass = "transient" | "permanent" | "expected" | "external" | "rate_limited";

interface ClassifiedError extends Error {
  failureClass?: FailureClass;
  statusCode?: number;
  retryAfter?: number; // seconds, from Retry-After header
}

/** Operation context hint for classification. */
interface OperationContext {
  /** Whether the target resource is expected to exist (e.g., fetching a known PR vs checking existence). */
  resourceShouldExist?: boolean;
  /** Override classification for specific status codes. */
  classifyOverrides?: Partial<Record<number, FailureClass>>;
}

/** Classify a GitHub API error by status code + headers + operation context. */
function classifyGitHubFailure(
  statusCode: number,
  headers: Record<string, string>,
  body?: string,
  context?: OperationContext,
): FailureClass;

// Classification rules (evaluated in order):
//
// 1. Check caller overrides first: if context.classifyOverrides[statusCode] is set, use it
//
// 2. 429 → "rate_limited" (always)
//
// 3. 403 classification (context-aware):
//    a. If Retry-After header present → "rate_limited"
//    b. If x-ratelimit-remaining header === "0" → "rate_limited"
//    c. If body contains "secondary rate limit" | "abuse detection" → "rate_limited"
//    d. Otherwise → "transient" with capped retries (NOT "permanent")
//       Rationale: GitHub 403 can indicate SSO re-auth, temporary permission
//       changes, or abuse detection without Retry-After. Treating as permanent
//       would permanently block on recoverable conditions.
//
// 4. 404 classification (context-aware):
//    a. If context.resourceShouldExist === true → "transient" (unexpected absence,
//       may indicate eventual consistency lag or permission regression)
//    b. If context.resourceShouldExist === false → "expected" (existence check)
//    c. If no context provided → "expected" (safe default for existence checks,
//       but callers performing known-resource fetches SHOULD pass context)
//
// 5. 422 → "permanent" (validation error, retrying won't help)
// 6. 500, 502, 503 → "transient"
// 7. Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND) → "external"
// 8. All others → "transient"

// ── Rolling Window ───────────────────────────────────────
interface FailureRecord {
  timestamp: number;
  failureClass: FailureClass;
}

// ── Enhanced Config ──────────────────────────────────────
interface EnhancedCircuitBreakerConfig {
  failureThreshold: number; // default: 5 (within rolling window)
  rollingWindowMs: number; // default: 3600000 (1 hour)
  openDurationMs: number; // default: 1800000 (30 minutes)
  halfOpenProbeCount: number; // default: 2
  countableClasses?: FailureClass[]; // default: ["transient", "external", "rate_limited"]
}

// ── API (backwards compatible) ───────────────────────────
class CircuitBreaker {
  constructor(
    config?: Partial<EnhancedCircuitBreakerConfig>,
    options?: {
      onStateChange?: (from, to) => void;
      now?: () => number;
    },
  );

  /** Execute through circuit breaker. Same API as existing. */
  async execute<T>(fn: () => Promise<T>): Promise<T>;

  /** Record failure with classification. Expected failures are skipped. */
  recordFailure(failureClass?: FailureClass): void;

  /** Record success. */
  recordSuccess(): void;

  /** Get current state with lazy timeout transition. */
  getState(): CircuitBreakerState;

  /** Get rolling window statistics. */
  getStats(): { total: number; byClass: Record<FailureClass, number>; windowMs: number };
}
```

**Rolling window implementation**: Array of `FailureRecord` entries. On `recordFailure()`:

1. Push new record
2. Evict records older than `rollingWindowMs`
3. If `failureClass === "expected"`: return (do not evaluate threshold)
4. Count remaining records where `class in countableClasses`
5. If count >= `failureThreshold`: transition to OPEN

**Backwards compatibility**: The existing `execute<T>(fn)` API is preserved. `recordFailure()` accepts an optional `failureClass` parameter; if omitted, defaults to `"transient"` (preserving existing behavior).

### 3.6 Token Bucket Rate Limiter (`persistence/rate-limiter.ts`) — F5

**Purpose**: Hierarchical rate limiting with GitHub-aware backoff.

```typescript
interface TokenBucket {
  tokens: number;
  capacity: number;
  refillPerHour: number;
  lastRefill: number; // timestamp
}

interface RateLimiterConfig {
  globalCapacity?: number; // default: 500
  globalRefillPerHour?: number; // default: 500
  perWorkflowCapacity?: number; // default: 100
  perWorkflowRefillPerHour?: number; // default: 100
  idleEvictionMs?: number; // default: 3600000 (1hr)
  now?: () => number; // injectable clock
}

class RateLimiter {
  constructor(config?: RateLimiterConfig);

  /** Try to consume a token. Returns { allowed, retryAfterMs?, bucket }. */
  tryConsume(workflowId: string): {
    allowed: boolean;
    retryAfterMs?: number;
    bucket: "global" | "workflow";
  };

  /** Record a rate limit response from GitHub. */
  recordRateLimit(workflowId: string, type: "primary" | "secondary", retryAfterSec?: number): void;

  /** Get backoff delay with exponential + jitter. */
  getBackoffMs(workflowId: string): number;

  /** Clean up idle per-workflow buckets. */
  cleanup(): number; // returns count evicted

  /** Shutdown cleanup timer. */
  shutdown(): void;
}
```

**Token refill**: On each `tryConsume()`, refill = `Math.min(capacity, tokens + elapsedHours * refillPerHour)`. Both global and per-workflow buckets must have tokens for `allowed: true`.

**Backoff**: Exponential with jitter: `min(maxMs, baseMs * 2^attempts) * (0.75 + Math.random() * 0.5)`. For secondary limits, `retryAfterSec * 1000` is the minimum wait.

**Cleanup**: `setInterval` every 60s removes per-workflow buckets idle > `idleEvictionMs`. Timer unref'd to not block process exit.

### 3.7 Idempotency Index (`safety/idempotency-index.ts`) — F6

**Purpose**: Dedup index for crash-safe resume of non-idempotent operations.

```typescript
type DedupStatus = "pending" | "completed" | "failed";

type CompensationStrategy = "safe_retry" | "check_then_retry" | "skip";

interface DedupEntry {
  key: string;
  status: DedupStatus;
  createdAt: string; // ISO-8601
  completedAt?: string;
  failedAt?: string; // ISO-8601, set when status transitions to "failed"
  intentSeq?: number; // links to audit trail
  compensationStrategy: CompensationStrategy;
  lastError?: string; // error message from failed execution
  attempts: number; // number of execution attempts (default: 0)
}

interface IdempotencyIndexConfig {
  store: ResilientStore<DedupState>; // backed by F7
  auditQuery?: AuditQueryFn; // optional: query audit trail for intent-result pairing
  ttlMs?: number; // default: 7 days
  now?: () => number;
}

/** Query function to check if an audit result exists for a given intentSeq. */
type AuditQueryFn = (intentSeq: number) => Promise<{ hasResult: boolean; error?: string } | null>;

class IdempotencyIndex {
  constructor(config: IdempotencyIndexConfig);

  /** Generate deterministic dedup key. */
  static generateKey(
    action: string,
    scope: string,
    resource: string,
    params: Record<string, unknown>,
  ): string;

  /** Check if operation already executed. */
  async check(key: string): Promise<DedupEntry | null>;

  /** Mark operation as pending (before execution). */
  async markPending(key: string, intentSeq: number, strategy: CompensationStrategy): Promise<void>;

  /** Mark operation as completed (after execution). */
  async markCompleted(key: string): Promise<void>;

  /** Mark operation as failed with error context. Terminal state — prevents infinite retries. */
  async markFailed(key: string, error: string): Promise<void>;

  /** Evict entries older than TTL. */
  async evict(): Promise<number>;

  /** Reconcile pending entries at boot. Returns entries needing compensation.
   *  Entries in "failed" status are NOT returned (terminal state).
   *  Entries in "pending" status are evaluated per their compensationStrategy.
   *  If auditQuery is configured, checks audit trail for existing results:
   *    - If audit result exists for intentSeq → auto-promote to "completed" (crash between steps 4-5)
   *    - If audit error exists for intentSeq → auto-promote to "failed"
   *    - If no audit result → apply compensationStrategy */
  async reconcilePending(): Promise<DedupEntry[]>;
}
```

**Key generation**: `SHA-256(JSON.stringify(sortKeys(params)))` truncated to 16 hex chars. Full key: `{action}:{scope}/{resource}:{hash16}`.

**Crash compensation table** (per PRD F6.4):

| Action                | Strategy           | Reconciliation                                |
| --------------------- | ------------------ | --------------------------------------------- |
| `create_branch`       | `safe_retry`       | Retry — idempotent                            |
| `create_pull_request` | `check_then_retry` | Check if PR exists with same head/base        |
| `add_issue_comment`   | `check_then_retry` | Check if comment with matching content exists |
| `update_pull_request` | `safe_retry`       | Retry — last-write-wins                       |
| `add_labels`          | `safe_retry`       | Retry — idempotent                            |
| `create_review`       | `check_then_retry` | Check if pending review exists                |
| Other                 | `skip`             | Log warning, skip                             |

### 3.8 Resilient JSON Store (`persistence/resilient-store.ts`) — F7

**Purpose**: Crash-safe JSON persistence with backup, quarantine, mutex, and migrations.

```typescript
interface StoreConfig<T> {
  path: string;
  schemaVersion: number;
  migrations?: Record<number, (data: unknown) => unknown>;
  maxSizeBytes?: number;          // default: 10MB
  now?: () => number;
}

interface ResilientStore<T> {
  get(): Promise<T | null>;
  set(state: T): Promise<void>;
  clear(): Promise<void>;
  exists(): Promise<boolean>;
}

class ResilientJsonStore<T> implements ResilientStore<T> {
  constructor(config: StoreConfig<T>);
}

/** Factory for creating typed stores. */
class ResilientStoreFactory {
  constructor(private baseDir: string, private logger: BeauvoirLogger);

  create<T>(name: string, config: Omit<StoreConfig<T>, "path">): ResilientStore<T>;
}
```

**Write protocol** (8-step crash-safe):

1. Serialize: `JSON.stringify({ _schemaVersion, _writeEpoch, ...state }, sortedKeys, 2)` — `_writeEpoch` is a monotonically increasing integer (per-store counter)
2. Check size: reject if > `maxSizeBytes`
3. Acquire async mutex
4. Write to `{path}.{pid}.tmp` (new file, exclusive create)
5. `fsync(tmpFd)` — ensures tmp data is durable on disk
6. If `{path}` exists: `rename({path}, {path}.bak)` then `fsync(dirFd)` — ensures bak reference is durable; if crash here, both bak and tmp exist (recovery reads bak as primary)
7. `rename({path}.{pid}.tmp, {path})` then `fsync(dirFd)` — ensures primary reference is durable; if crash after rename but before dir fsync, filesystem journal recovers the rename on ext4/APFS (documented platform assumption)
8. Release mutex

**Platform assumptions**: This protocol assumes a journaling filesystem (ext4, APFS, XFS) where rename is atomic and directory entries are recovered after journal replay. On non-journaling filesystems, step 7's dir fsync is the durability boundary. The protocol is NOT safe on raw FAT32 or similar non-journaling filesystems.

**Step count note**: The PRD specifies "7-step write protocol" counting logical operations. This SDD expands to 8 steps for implementation clarity, separating the mutex acquire/release as explicit steps. The 7 logical operations from the PRD map to steps 1-2 (prepare), 4-5 (write+fsync tmp), 6 (backup), 7 (promote).

**Read fallback chain** (5-step, per PRD):

1. Read + parse + validate `{path}` → run migrations if version < current → return
2. Read + parse + validate `{path}.bak` → log warning ("primary corrupt/missing, recovered from backup") → return
3. Scan `{path}.*.tmp` files: parse each, reject if invalid JSON or schema mismatch, accept ONLY if `_writeEpoch > max(primary._writeEpoch, bak._writeEpoch)` — this prevents resurrecting stale tmp files from old runs, PID reuse, clock skew, or backup restores. If no tmp has a higher epoch → skip to step 4.
4. Quarantine all corrupt/stale files (move to `{path}.quarantine.{timestamp}`) → return null
5. Boot cleanup: delete quarantine files older than 7 days

**Why `_writeEpoch` not `mtime`**: File modification times are unreliable across crashes, restores, and container migrations (clock skew, NTP jumps, backup extraction). A monotonically increasing integer inside the JSON payload provides a tamper-evident ordering that survives these scenarios. The epoch is incremented on every `set()` call and persisted as part of the data.

**Async Mutex** (`persistence/async-mutex.ts`): Promise-chain based, shared by audit trail and resilient store:

```typescript
class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;
  async acquire(): Promise<void>;
  release(): void;
}
```

### 3.9 Tool Validator (`safety/tool-validator.ts`) — F8

**Purpose**: Boot-time validation of action policy against MCP tool surface.

```typescript
interface ToolConstraint {
  type: "must_be" | "pattern" | "allowlist";
  param: string;
  value: unknown; // literal for must_be, regex string for pattern, string[] for allowlist
}

interface ToolRegistryEntry {
  name: string;
  capability: "read" | "write" | "admin";
  constraints?: ToolConstraint[];
}

interface ValidationResult {
  valid: boolean;
  errors: string[]; // blocking errors
  warnings: string[]; // non-blocking warnings
}

class ToolValidator {
  constructor(registry: ToolRegistryEntry[], policy: ActionPolicyDef);

  /** Validate policy against available MCP tools. */
  validateRegistry(mcpToolNames: string[]): ValidationResult;

  /** Validate params at runtime. */
  validateParams(toolName: string, params: Record<string, unknown>): string[];
}
```

**Boot validation**:

1. For each tool in `policy.allow`: verify it exists in `mcpToolNames`
2. Unknown tools → error (boot fails)
3. For each tool in registry: verify it's in `policy.allow` or `policy.deny`
4. Unregistered tools → warning (unexpected tool surface)

### 3.10 Lock Manager (`persistence/lock-manager.ts`) — F9

**Purpose**: Boot ID-aware lock management with stale detection.

```typescript
interface LockOwnership {
  id: string; // ULID
  pid: number;
  bootId: string; // per-process randomUUID (diagnostic metadata, NOT primary staleness signal)
  createdAt: number; // epoch ms
  lockVersion: number; // monotonic counter for CAS-style updates
}

interface LockManagerConfig {
  dataDir: string;
  maxAgeMs?: number; // default: 3600000 (1 hour) — backstop expiry
  bootId: string; // set once at process start via randomUUID
  now?: () => number;
}

class LockManager {
  constructor(config: LockManagerConfig);

  /** Acquire a named lock. Throws if live lock held by another. */
  async acquire(name: string): Promise<void>;

  /** Release a named lock. */
  async release(name: string): Promise<void>;

  /** Scan for and recover stale locks. Returns recovered lock names. */
  async recoverStaleLocks(): Promise<string[]>;
}
```

**Acquire protocol**:

1. Try `open(lockPath, "wx")` (O_EXCL — kernel-atomic create)
2. On success: write `LockOwnership` JSON, `fsync(fd)`, `fsync(dirFd)`, return
3. On `EEXIST`: read ownership record, evaluate staleness (see below)
4. If stale: double-read ownership (TOCTOU mitigation — re-read and confirm same content), `unlink`, retry step 1 (O_EXCL)
5. If live: throw `PersistenceError("LOCK_HELD", { pid, bootId, createdAt })`

**Staleness determination** (evaluated in order):

1. **Age backstop** (always checked first): if `now() - createdAt > maxAgeMs` → **stale** regardless of PID liveness. This prevents permanent deadlock if PID check fails.
2. **PID liveness** via `process.kill(pid, 0)`:
   - Throws `ESRCH` ("no such process") → PID is dead → **stale**
   - Throws `EPERM` ("operation not permitted") → PID exists but owned by another user → treat as **live** (conservative — avoids stealing a lock from a privileged process)
   - Returns successfully (no error) → PID exists and we have permission → **live**
3. **Boot ID** is logged as diagnostic metadata only. It is NOT used as a primary staleness criterion because per-process `randomUUID` always differs between any two processes, making "boot ID mismatch" trivially always true. Boot ID helps operators debug which process instance originally acquired the lock.

**Container/PID namespace limitations**: `process.kill(pid, 0)` checks the PID within the current PID namespace. In containerized environments where the lock file is on a shared volume across PID namespaces, PID liveness checks may give false negatives (PID appears dead in this container but is alive in another). Mitigation: the `maxAgeMs` backstop ensures eventual recovery. For cross-container scenarios, operators should use shorter `maxAgeMs` values or external coordination (documented as future consideration).

---

## 4. Data Architecture

### 4.1 Audit Trail Format (JSONL)

```jsonl
{"seq":1,"prevHash":"genesis","hash":"a1b2c3...","phase":"intent","ts":"2026-02-07T22:00:00Z","action":"add_issue_comment","target":"org/repo#42","params":{"body":"Review complete"},"dryRun":false}
{"seq":2,"prevHash":"a1b2c3...","hash":"d4e5f6...","phase":"result","intentSeq":1,"ts":"2026-02-07T22:00:01Z","action":"add_issue_comment","target":"org/repo#42","params":{},"result":{"id":123},"dryRun":false}
```

### 4.2 Resilient Store Format (JSON)

```json
{
  "_schemaVersion": 2,
  "_writeEpoch": 47,
  "entries": {
    "add_issue_comment:org/repo/42:a1b2c3d4e5f6g7h8": {
      "key": "add_issue_comment:org/repo/42:a1b2c3d4e5f6g7h8",
      "status": "completed",
      "createdAt": "2026-02-07T22:00:00Z",
      "completedAt": "2026-02-07T22:00:01Z",
      "intentSeq": 1,
      "compensationStrategy": "check_then_retry"
    }
  }
}
```

### 4.3 Lock File Format (JSON)

```json
{
  "id": "01HQXYZ...",
  "pid": 12345,
  "bootId": "550e8400-e29b-41d4-a716-446655440000",
  "createdAt": 1707350400000,
  "lockVersion": 1
}
```

### 4.4 Health Report Format (JSON)

```json
{
  "success": true,
  "mode": "autonomous",
  "bootTimeMs": 847,
  "warnings": [],
  "subsystems": {
    "secretRedactor": "ok",
    "logger": "ok",
    "auditTrail": "ok",
    "resilientStore": "ok",
    "circuitBreaker": "ok",
    "rateLimiter": "ok",
    "idempotencyIndex": "ok",
    "toolValidator": "ok",
    "lockManager": "ok"
  }
}
```

---

## 5. Integration Points

### 5.1 Workflow Engine Integration

The workflow engine's `advance()` method integrates F2, F5, and F6:

```typescript
// Inside WorkflowEngine.advance():
async advance(runId: string): Promise<void> {
  // ... existing step resolution ...

  // Rate limiting (F5)
  const rateResult = this.rateLimiter?.tryConsume(run.workflowId);
  if (rateResult && !rateResult.allowed) {
    // Schedule retry after backoff
    throw new PersistenceError("RATE_LIMITED", `Retry in ${rateResult.retryAfterMs}ms`);
  }

  // Mutation gating (F1.6)
  if (this.operatingMode === "degraded" && stepDef.capability === "write") {
    throw new PersistenceError("DEGRADED_MODE", "Write operations blocked in degraded mode");
  }

  // ── Dedup check (F6) ─────────────────────────────────────
  const dedupeKey = IdempotencyIndex.generateKey(stepDef.skill, ...);
  const existing = await this.dedupIndex?.check(dedupeKey);
  if (existing?.status === "completed") {
    stepState.status = "skipped";
    stepState.outputs = { deduped: true };
    return;
  }
  if (existing?.status === "failed") {
    // Terminal failure from previous run — do not retry automatically.
    // Operator must clear the entry or use reconcilePending() with override.
    stepState.status = "skipped";
    stepState.outputs = { deduped: true, previousError: existing.lastError };
    return;
  }

  // ── Step 1: Record intent + DURABLE FSYNC ─────────────────
  // The intent MUST be durable before any mutation executes.
  // AuditTrail.recordIntent() fsyncs immediately for mutation intents (see §3.2 step 9).
  const intentSeq = await this.auditTrail.recordIntent({
    action: stepDef.skill,
    target: resolveTarget(stepDef),
    params: stepDef.input ?? {},
  });
  // At this point: intent is fsync'd to disk. Crash here → intent exists, no pending entry.
  // On recovery: orphan intent with no pending entry is harmless (logged but not re-executed).

  // ── Step 2: Mark pending + DURABLE STORE WRITE ────────────
  await this.dedupIndex?.markPending(dedupeKey, intentSeq, getStrategy(stepDef.skill));
  // At this point: both intent (audit) and pending (dedup store) are durable.
  // Crash here → reconcilePending() will find this entry and apply compensationStrategy.

  // ── Step 3: Execute ───────────────────────────────────────
  try {
    const result = await executeWithTimeout(
      () => this.executor(stepDef, resolvedInputs), timeoutMs, stepDef.id,
    );

    // ── Step 4: Record result + DURABLE FSYNC ───────────────
    await this.auditTrail.recordResult(intentSeq, result);

    // ── Step 5: Mark completed + DURABLE STORE WRITE ────────
    await this.dedupIndex?.markCompleted(dedupeKey);

    stepState.outputs = result;
    stepState.status = "completed";
  } catch (err) {
    // ── Error path: record result AND mark failed ───────────
    // Record the error as a result in the audit trail (preserves intent-result pairing).
    await this.auditTrail.recordResult(intentSeq, null, String(err));

    // Mark dedup entry as FAILED with error context. This prevents:
    // (a) reconcilePending() from endlessly retrying a permanently failing operation
    // (b) the entry staying "pending" forever with no metadata for debugging
    await this.dedupIndex?.markFailed(dedupeKey, String(err));

    throw err;
  }
}
```

**Durable ordering guarantee**: Each numbered step above includes a durable write (fsync for audit, crash-safe store write for dedup). A crash at any point results in a deterministic state:

| Crash Point                  | Audit State           | Dedup State | Recovery Action                                                          |
| ---------------------------- | --------------------- | ----------- | ------------------------------------------------------------------------ |
| After step 1, before step 2  | Intent durable        | No entry    | Orphan intent — harmless, logged in audit                                |
| After step 2, before step 3  | Intent durable        | Pending     | `reconcilePending()` applies compensation strategy                       |
| During step 3 (execution)    | Intent durable        | Pending     | Same as above — unknown if side-effect occurred                          |
| After step 3, before step 4  | Intent durable        | Pending     | Same — result not recorded but side-effect occurred                      |
| After step 4, before step 5  | Intent+Result durable | Pending     | `reconcilePending()` can check result exists in audit and mark completed |
| After step 5                 | Intent+Result durable | Completed   | Fully consistent                                                         |
| In catch, after audit result | Intent+Error durable  | Failed      | Terminal — operator review needed                                        |

### 5.2 Action Policy Integration (F8)

The existing `ActionPolicy.isAllowed()` is enhanced with the `ToolValidator`:

```typescript
// At boot: validate policy against MCP surface
const validation = toolValidator.validateRegistry(mcpToolNames);
if (!validation.valid) {
  throw new Error(`Tool validation failed: ${validation.errors.join(", ")}`);
}

// At runtime: existing isAllowed() + constraint validation
const policyResult = actionPolicy.isAllowed(toolName, params);
if (!policyResult.allowed) {
  await auditTrail.recordDenied({ action: toolName, target, params });
  return policyResult;
}
const violations = toolValidator.validateParams(toolName, params);
if (violations.length > 0) {
  await auditTrail.recordDenied({ action: toolName, target, params });
  return { allowed: false, reason: violations.join("; ") };
}
```

---

## 6. Security Architecture

### 6.1 Secret Redaction Flow

```
All subsystem output → BeauvoirLogger → SecretRedactor.redact() → console
Audit trail records → SecretRedactor.redactAny(params) → append to JSONL
Error objects → SecretRedactor.redactError(err) → logged/thrown
```

Third-party library output is out of scope. Consumers redirect via `console` override if needed.

### 6.2 Audit Trail Integrity

| Layer                 | Protection                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Hash chain            | Detects record deletion, insertion, or modification                                                                     |
| HMAC (optional)       | Detects rewrite by attacker without signing key                                                                         |
| O_APPEND + write loop | Each write starts at EOF (POSIX guarantee); loop ensures full buffer written; single-writer mutex prevents interleaving |
| Mutex                 | Application-level single-writer serialization prevents hash chain corruption and partial interleaving                   |
| Fsync ordering        | Intent fsync before mutation execution; result fsync before acknowledgment; telemetry batched (may lose last batch)     |
| Single-process lock   | LockManager (F9) enforces single-process ownership at boot                                                              |

### 6.3 Lock Safety

| Property          | Mechanism                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Mutual exclusion  | O_EXCL (kernel-atomic file creation)                                                                                            |
| Stale detection   | Age backstop (primary) + PID liveness via `process.kill(pid, 0)` with ESRCH/EPERM handling; boot ID is diagnostic metadata only |
| No lock stealing  | Second instance fails boot if live lock detected (EPERM treated as live)                                                        |
| TOCTOU mitigation | Double-read ownership before unlink + retry O_EXCL                                                                              |
| Container safety  | `maxAgeMs` backstop ensures recovery even when PID liveness check is unreliable across PID namespaces                           |

---

## 7. Testing Strategy

### 7.1 Unit Tests (per module)

| Module           | Key Test Cases                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------- |
| SecretRedactor   | All 6 patterns, nested objects, header stripping, URL query params, error chains         |
| AuditTrail       | Hash chain integrity, intent-result pairing, rotation, torn write recovery, HMAC         |
| CircuitBreaker   | All 5 failure classes, rolling window eviction, expected-failure skip, state transitions |
| RateLimiter      | Token refill, dual-bucket depletion, backoff jitter, idle cleanup                        |
| IdempotencyIndex | Key generation determinism, TTL eviction, reconcile pending, all compensation strategies |
| ResilientStore   | Write protocol (7 steps), read fallback chain, quarantine, migrations, size limit        |
| ToolValidator    | Registry cross-check, pattern constraints, unknown tool rejection                        |
| LockManager      | O_EXCL acquire, stale detection, live-instance protection, TOCTOU double-read            |
| BootOrchestrator | Full boot, P0 failure = abort, P1 failure = degraded, dev mode, health report            |

### 7.2 Integration Tests

| Test                           | What It Validates                                                            |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Boot → Workflow → Audit        | Full path from boot through step execution with audit trail verification     |
| Crash Resume                   | Kill process mid-workflow → restart → verify dedup prevents double execution |
| Circuit Breaker + Rate Limiter | Simulate 429/403 responses → verify correct backoff + circuit state          |
| Store Corruption Recovery      | Corrupt primary JSON → verify `.bak` fallback → verify quarantine            |

### 7.3 Fake/Injectable Dependencies

All modules accept injectable `now?: () => number` for deterministic testing. The `ResilientStore` can be backed by in-memory maps for unit tests. The `AuditTrail` can write to a temp directory.

---

## 8. Performance Considerations

| Component       | Strategy                                                              | Target              |
| --------------- | --------------------------------------------------------------------- | ------------------- |
| Audit trail     | O_APPEND single-write, batched fsync for non-mutations                | <5ms p99 (mutation) |
| Circuit breaker | In-memory ring buffer, no I/O                                         | <0.1ms              |
| Rate limiter    | In-memory token counters                                              | <0.01ms             |
| Dedup index     | In-memory map, async persist                                          | <0.5ms              |
| Resilient store | Async mutex prevents contention; sorted JSON for cache-friendly diffs | <10ms p99           |
| Boot            | Parallel non-dependent inits where safe                               | <2s p95             |

---

## 9. Migration Strategy

### 9.1 Circuit Breaker

The enhanced `CircuitBreaker` is a **drop-in replacement**. Existing `execute<T>(fn)` calls work unchanged. The `recordFailure()` method gains an optional `failureClass` parameter (defaults to `"transient"`).

### 9.2 JSON State Store

The `ResilientJsonStore` replaces `JsonStateStore` as the recommended store. The interface is identical (`get/set/clear/exists`). Existing stores can migrate by:

1. Adding `_schemaVersion: 1` to existing data
2. Switching constructor from `JsonStateStore` to `ResilientJsonStore`

### 9.3 New Modules

All new modules (audit trail, redactor, logger, rate limiter, dedup, boot orchestrator, tool validator, lock manager) are additive. No existing code changes required beyond wiring in the workflow engine integration (§5.1).

---

## 10. Deployment Topology Constraints

Beauvoir is a **single-instance framework**. All production hardening modules are designed for a single process operating on a local filesystem. This is not a limitation but a deliberate architectural choice matching the deployment model:

- **Beauvoir runs as a Claude Code extension** — one process per developer/operator session
- **loa-finn (consumer)** deploys as a single container per GitHub App installation
- **No horizontal scaling** is required or planned — each installation is independent

### Flatline Review Overrides

The following adversarial concerns were raised by the Flatline Protocol skeptic review and overridden with rationale:

| ID      | Concern                                                         | Severity | Override Rationale                                                                                                                                                                                                                                                                                              |
| ------- | --------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SKP-001 | Single-process assumption breaks in multi-worker deployments    | 930      | Beauvoir is architecturally single-instance. Multi-worker/HA deployments are out of scope. LockManager prevents accidental concurrent starts.                                                                                                                                                                   |
| SKP-002 | Age backstop can cause split-brain under long-running workflows | 900      | In single-instance deployment, lock contention only occurs after crashes. The `maxAgeMs` backstop (1h default) is generous for crash recovery. Legitimate long-running workflows do not spawn competing instances. Operators can tune `maxAgeMs` for their environment.                                         |
| SKP-003 | fsync per mutation may stall; <5ms p99 unrealistic              | 760      | Beauvoir executes low-volume GitHub API mutations (typically <10/minute). fsync latency on local SSD is ~0.1-1ms; the <5ms p99 target is achievable. High-IOPS environments are not the target deployment. If needed, group-commit WAL is a documented future option.                                           |
| SKP-004 | HMAC without key management provides limited tamper resistance  | 740      | The PRD explicitly states "tamper-evident, not tamper-proof" (§F2 threat model). Hash chain detects modification; HMAC is optional defense-in-depth. Key management and off-host anchoring are documented future considerations for environments requiring stronger guarantees.                                 |
| SKP-005 | Regex-based redaction misses many secret formats                | 720      | The 6 built-in patterns cover all token types used by Beauvoir's GitHub integration. Additional patterns are injectable via `extraRedactionPatterns`. Framework consumers add domain-specific patterns at boot. Universal secret detection (JWTs, PEM blocks, high-entropy heuristics) is a future enhancement. |

## 11. Future Considerations

| Item                        | When    | Notes                                                                          |
| --------------------------- | ------- | ------------------------------------------------------------------------------ |
| Kill switch                 | Phase 4 | Three-layer mechanism; boot mode gating provides interim protection            |
| Dry-run interceptor         | Phase 4 | Read/write tool classification from F8 registry enables this                   |
| Sandbox policies            | Phase 4 | Only if bash tool support added to Beauvoir                                    |
| Multi-process locks         | Future  | flock upgrade to advisory + mandatory; distributed lock service (if HA needed) |
| Audit trail remote backup   | Future  | Ship JSONL to object storage for off-host tamper protection                    |
| HMAC key management         | Future  | KMS/secret manager integration, key rotation, compromise recovery              |
| Expanded redaction patterns | Future  | JWT, PEM, Bearer tokens, high-entropy heuristic detection                      |
| Group-commit WAL            | Future  | Batch fsync with bounded latency for high-throughput environments              |
| Lease-based locks           | Future  | Heartbeat renewal for long-running workflows in shared environments            |
