# Sprint Plan: Beauvoir Production Hardening — Finn Pattern Transfer

> **Version**: 1.0.0
> **PRD**: `grimoires/loa/prd.md` v1.0.0
> **SDD**: `grimoires/loa/sdd.md` v1.0.0
> **Issue**: [loa-beauvoir#30](https://github.com/0xHoneyJar/loa-beauvoir/issues/30)
> **Created**: 2026-02-08
> **Branch**: `feature/production-hardening`
> **Repo**: `0xHoneyJar/loa-beauvoir` (framework only)

---

## Sprint Overview

| Attribute              | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| **Sprint IDs**         | prodharden-001 through prodharden-003 (global: 18–20)          |
| **Type**               | Framework Hardening (Beauvoir only)                            |
| **Scope**              | 3 sprints, 9 features (F1–F9), ~2500 LOC, 27 tasks             |
| **Risk Level**         | MEDIUM (framework internals, no external API changes)          |
| **Estimated Duration** | 3 sprints (~6 days, incl. 1-day buffer)                        |
| **Team**               | 1 AI agent (Claude Opus 4.6) + 1 human operator (reviewer)     |
| **Review Policy**      | All modules require unit tests. Integration tests in Sprint 3. |

---

## Sprint Sequencing Rationale

```
Sprint 1: Foundation (P0)          Sprint 2: Resilience (P1)        Sprint 3: Integration (P1+P2)
┌─────────────────────┐            ┌─────────────────────┐          ┌─────────────────────┐
│ AsyncMutex          │───────────►│ ResilientStore (F7) │─────────►│ IdempotencyIndex(F6)│
│ SecretRedactor (F3) │            │ CircuitBreaker (F4) │          │ LockManager (F9)    │
│ BeauvoirLogger(F3.6)│            │ RateLimiter (F5)    │          │ ToolValidator (F8)  │
│ AuditTrail (F2)     │            └─────────────────────┘          │ BootOrchestrator(F1)│
└─────────────────────┘                                             │ Engine Integration  │
                                                                    └─────────────────────┘
```

**Why this order**:

1. Sprint 1 builds the **security foundation** — nothing should log, persist, or execute until redaction and audit are in place
2. Sprint 2 builds **resilient persistence** — the store, breaker, and limiter depend on the mutex/logger from Sprint 1
3. Sprint 3 **wires everything together** — dedup needs the store (Sprint 2) + audit trail (Sprint 1); boot orchestrator initializes all modules in order

---

## Sprint 1: Security Foundation (P0)

**Global ID**: 18
**Goal**: Build the security primitives that ALL subsequent modules depend on — mutex, secret redaction, logging, and audit trail. After this sprint, the framework can redact secrets and audit-log every mutation.

### Epic: Security-First Primitives

```
prodharden-sprint1 (Epic)
├── TASK-1.1: AsyncMutex — Promise-chain write serialization [P0]
├── TASK-1.2: SecretRedactor — pattern-based redaction engine [P0]
├── TASK-1.3: BeauvoirLogger — redacting logger interface [P0]
├── TASK-1.4: AuditTrail — hash-chained JSONL with intent-result pairing [P0]
├── TASK-1.5: AuditTrail torn write recovery [P0]
├── TASK-1.6: AuditTrail rotation with intent-pair safety [P0]
├── TASK-1.7: AuditTrail HMAC signing (optional) [P1]
├── TASK-1.8: AuditTrail — Query API for Reconciliation [P0]
└── TASK-1.9: Sprint 1 unit tests [P0]
```

### TASK-1.1: AsyncMutex

**File**: `.claude/lib/persistence/async-mutex.ts`
**Description**: Promise-chain mutex shared by audit trail and resilient store. No external dependencies. Supports `acquire()` / `release()` with FIFO ordering.
**Acceptance Criteria**:

- [ ] `acquire(timeoutMs?: number)` returns a Promise that resolves when lock is obtained; rejects with `MutexTimeoutError` after `timeoutMs` (default: 30000ms)
- [ ] `release()` immediately grants lock to next waiter in FIFO order
- [ ] Concurrent `acquire()` calls serialize correctly
- [ ] No deadlock if `release()` is called without `acquire()`
- [ ] Owner tracking: `isHeld()` returns boolean, `holdDuration()` returns ms since acquire
- [ ] Max hold time (lease): if holder exceeds `maxHoldMs` (default: 60000ms), lock is auto-released and next waiter is granted; a warning is logged
- [ ] Unit tests: concurrent access, FIFO ordering, reentrant safety, timeout rejection, lease auto-release
      **Estimated LOC**: ~60
      **Dependencies**: None

### TASK-1.2: SecretRedactor

**File**: `.claude/lib/safety/secret-redactor.ts`
**Description**: Pattern-based secret detection for strings and structured data. 6 built-in patterns (GitHub PAT, ghp*, ghs*, gho\_, AWS key, generic API key). Extensible via constructor.
**Acceptance Criteria**:

- [ ] `redact(text)` replaces all 6 built-in patterns with typed placeholders
- [ ] `redactAny(value)` deep-walks objects/arrays, redacts string leaves
- [ ] `redactAny()` strips known header keys (`authorization`, `x-api-key`, `cookie`, etc.)
- [ ] `redactError(err)` creates new Error with redacted message + cause chain
- [ ] Constructor accepts `extraPatterns` for consumer extensibility
- [ ] Patterns applied most-specific-first (github*pat* before generic)
- [ ] Unit tests: all 6 patterns, nested objects, header stripping, error chains, edge cases (empty string, null, undefined)
      **Estimated LOC**: ~120
      **Dependencies**: None

### TASK-1.3: BeauvoirLogger

**File**: `.claude/lib/safety/logger.ts`
**Description**: Centralized logging interface that routes all output through SecretRedactor. All framework subsystems MUST use this logger.
**Acceptance Criteria**:

- [ ] `createLogger(redactor, options?)` returns `BeauvoirLogger` interface
- [ ] `debug/info/warn/error` methods all redact message + data before emitting
- [ ] `error()` method redacts error objects via `redactError()`
- [ ] Configurable log level filtering (default: `info`)
- [ ] Optional prefix for subsystem identification (e.g., `[audit-trail]`)
- [ ] Unit tests: redaction happens before output, level filtering, prefix formatting
      **Estimated LOC**: ~60
      **Dependencies**: TASK-1.2

### TASK-1.4: AuditTrail — Core

**File**: `.claude/lib/safety/audit-trail.ts`
**Description**: Hash-chained JSONL append-only audit log. Implements the 12-step append protocol from SDD §3.2. SHA-256 hash chain with canonical serialization. Intent-result pairing via seq numbers.
**Acceptance Criteria**:

- [ ] `recordIntent()` returns monotonic seq number, fsyncs immediately (mutation-durable)
- [ ] `recordResult(intentSeq, result, error?)` links to intent, fsyncs immediately
- [ ] `recordDenied()` records policy-blocked actions, fsyncs immediately
- [ ] Hash chain: each record's `hash = SHA-256(canonical)` with `prevHash` linkage
- [ ] Canonical serialization: sorted keys, excludes `hash`/`hmac` fields
- [ ] `verifyChain()` validates entire file and reports broken links
- [ ] Robust append loop: handles short writes with retry (max 3)
- [ ] O_APPEND fd opened at init, mutex serializes all writes
- [ ] All params/result/error fields redacted via SecretRedactor before write
- [ ] Dry-run/telemetry records use batched fsync (100ms timer)
- [ ] Unit tests: chain integrity, intent-result pairing, redaction, short write handling
      **Estimated LOC**: ~300
      **Dependencies**: TASK-1.1, TASK-1.2, TASK-1.3

### TASK-1.5: AuditTrail — Torn Write Recovery + Chain Validation

**Description**: Extension of TASK-1.4. On `initialize()`, recover from partial writes AND validate hash chain integrity at the tail.
**Acceptance Criteria**:

- [ ] Reads file, splits on `\n`, discards last line if invalid JSON
- [ ] Scans sequentially and truncates at the last record that maintains a valid `prevHash` chain (valid JSON but wrong prevHash → truncate at that point)
- [ ] When HMAC enabled: also validate HMAC at tail; HMAC mismatch → truncate at that point
- [ ] Truncates file to end of last valid, chain-consistent line
- [ ] Rebuilds `prevHash` state from last valid record
- [ ] Logs warning with count of lost records (both parse failures and chain breaks)
- [ ] Unit tests: corrupt last line, valid JSON but wrong prevHash, HMAC mismatch at tail, mid-file corruption, empty file, all-corrupt file, clean file (no-op)
      **Estimated LOC**: ~70 (within audit-trail.ts)
      **Dependencies**: TASK-1.4

### TASK-1.6: AuditTrail — Rotation

**Description**: Extension of TASK-1.4. Rotate log when file exceeds `maxSizeBytes`.
**Acceptance Criteria**:

- [ ] Rotation deferred while any intent lacks a matching result (intent-pair safety)
- [ ] Tracks pending intent seq numbers in memory
- [ ] Renames `audit.jsonl` → `audit.{timestamp}.jsonl`
- [ ] Fsyncs parent directory after rename
- [ ] Opens new file with fresh chain (`prevHash = "genesis"`)
- [ ] Unit tests: rotation trigger, deferred rotation, fresh chain after rotation
      **Estimated LOC**: ~40 (within audit-trail.ts)
      **Dependencies**: TASK-1.4

### TASK-1.7: AuditTrail — HMAC Signing

**Description**: Extension of TASK-1.4. Optional HMAC-SHA256 signing of audit records.
**Acceptance Criteria**:

- [ ] If `hmacKey` provided, each record gets `hmac = HMAC-SHA256(key, canonical)`
- [ ] `verifyChain()` validates HMAC when key is available
- [ ] Missing HMAC on records written without key → no validation error
- [ ] Unit tests: HMAC present when key set, verification passes/fails, key-less mode
      **Estimated LOC**: ~30 (within audit-trail.ts)
      **Dependencies**: TASK-1.4

### TASK-1.8: AuditTrail — Query API for Reconciliation

**Description**: Add query methods to AuditTrail that support boot-time reconciliation. The IdempotencyIndex (Sprint 3) needs to check whether a result record exists for a given intentSeq.
**Acceptance Criteria**:

- [ ] `findResultByIntentSeq(intentSeq: number): Promise<{ hasResult: boolean; error?: string } | null>` — scans current audit file for a `result` phase record linking to the given intentSeq
- [ ] Returns `{ hasResult: true }` if result exists, `{ hasResult: true, error }` if error result exists, `null` if no result found
- [ ] Efficient: reads file once, builds in-memory index of intent→result mappings during `initialize()`
- [ ] Index refreshed on each `recordResult()` call (no re-read needed)
- [ ] Unit tests: find existing result, find error result, no result found, multiple intents
      **Estimated LOC**: ~40 (within audit-trail.ts)
      **Dependencies**: TASK-1.4

### TASK-1.9: Sprint 1 Unit Tests

**Description**: Comprehensive test suite for all Sprint 1 modules.
**Acceptance Criteria**:

- [ ] `async-mutex.test.ts`: concurrent serialization, FIFO, reentrant safety
- [ ] `secret-redactor.test.ts`: all 6 patterns, nested objects, headers, errors
- [ ] `logger.test.ts`: redaction before output, levels, prefix
- [ ] `audit-trail.test.ts`: chain integrity, intent-result, rotation, torn write (incl. chain-break and HMAC-mismatch tail), query API, HMAC
- [ ] All tests pass with `pnpm test`
- [ ] > 80% branch coverage on all new files
      > **Dependencies**: TASK-1.1 through TASK-1.8

### Sprint 1 Acceptance Gate

- [ ] All 9 tasks completed
- [ ] `pnpm test` passes with >80% coverage on new files
- [ ] AuditTrail can record intent → execute → record result with verified hash chain
- [ ] SecretRedactor catches all 6 built-in token patterns
- [ ] No secrets visible in audit trail output

---

## Sprint 2: Resilient Persistence (P1)

**Global ID**: 19
**Goal**: Build the resilient persistence layer — crash-safe JSON store, classified circuit breaker, and token bucket rate limiter. After this sprint, all state persistence is crash-safe with backup/recovery.

### Epic: Persistence Hardening

```
prodharden-sprint2 (Epic)
├── TASK-2.1: ResilientJsonStore — 8-step crash-safe write protocol [P0]
├── TASK-2.2: ResilientJsonStore — 5-step read fallback with _writeEpoch [P0]
├── TASK-2.3: ResilientJsonStore — schema migrations [P1]
├── TASK-2.4: ResilientJsonStore — quarantine management [P1]
├── TASK-2.5: ResilientStoreFactory [P0]
├── TASK-2.6: Enhanced CircuitBreaker — rolling window + 5-class taxonomy [P0]
├── TASK-2.7: CircuitBreaker — context-aware GitHub classifier [P0]
├── TASK-2.8: TokenBucket RateLimiter — hierarchical + backoff [P0]
├── TASK-2.9: RateLimiter — idle bucket cleanup [P1]
└── TASK-2.10: Sprint 2 unit tests [P0]
```

### TASK-2.1: ResilientJsonStore — Write Protocol

**File**: `.claude/lib/persistence/resilient-store.ts`
**Description**: 8-step crash-safe write protocol per SDD §3.8. Serialize → size check → mutex → write tmp → fsync tmp → rename bak → rename primary → fsync dir → release mutex. Includes `_writeEpoch` monotonic counter.
**Acceptance Criteria**:

- [ ] `set(state)` follows exact 8-step protocol
- [ ] `_writeEpoch` incremented on every write, persisted in JSON
- [ ] `_schemaVersion` included in all writes
- [ ] Size check rejects writes > `maxSizeBytes` before touching disk
- [ ] Sorted keys for deterministic JSON output
- [ ] PID-namespaced tmp files (`{path}.{pid}.tmp`)
- [ ] Fsync of tmp fd before any renames
- [ ] Directory fsync after each rename
- [ ] Unit tests: write roundtrip, size rejection, sorted output
      **Estimated LOC**: ~150
      **Dependencies**: Sprint 1 (TASK-1.1 AsyncMutex, TASK-1.3 Logger)

### TASK-2.2: ResilientJsonStore — Read Fallback + Tmp Lifecycle

**Description**: 5-step read fallback with `_writeEpoch` ordering per SDD §3.8. Includes explicit tmp file naming, globbing, selection, and cleanup rules.
**Acceptance Criteria**:

- [ ] Reads primary → bak → tmp in order
- [ ] Tmp file naming: `{path}.{pid}.tmp` — PID-namespaced to avoid collisions
- [ ] Tmp globbing: scan `{path}.*.tmp` (all PID-namespaced tmp files)
- [ ] Tmp selection: parse each, pick the one with highest `_writeEpoch` that passes JSON parse + schema validation
- [ ] Tmp accepted ONLY if `_writeEpoch > max(primary._writeEpoch, bak._writeEpoch)`
- [ ] Invalid JSON or schema mismatch → skip to next source
- [ ] Logs warnings when falling back to bak or tmp
- [ ] **Tmp cleanup**: after successful read from any source, delete ALL `{path}.*.tmp` files with `_writeEpoch <= chosen source's epoch` (prevents stale tmp accumulation)
- [ ] On successful write (TASK-2.1 step 7 complete): delete the tmp file (rename already moved it; this is a safety no-op)
- [ ] Unit tests: primary ok, primary corrupt/bak ok, all corrupt → null, tmp with higher epoch accepted, tmp with lower epoch rejected, multiple tmp files (pick highest epoch), stale tmp cleanup
      **Estimated LOC**: ~100 (within resilient-store.ts)
      **Dependencies**: TASK-2.1

### TASK-2.3: ResilientJsonStore — Schema Migrations

**Description**: Chained upgrade functions via `_schemaVersion`.
**Acceptance Criteria**:

- [ ] `migrations` config maps version → transform function
- [ ] On read, if `_schemaVersion < current`, run migrations in order
- [ ] After migration, write back with new version
- [ ] Unit tests: v1→v2 migration, v1→v3 chained migration, missing migration → error
      **Estimated LOC**: ~40 (within resilient-store.ts)
      **Dependencies**: TASK-2.1

### TASK-2.4: ResilientJsonStore — Quarantine Management

**Description**: Move corrupt files to quarantine, with 7-day retention cleanup.
**Acceptance Criteria**:

- [ ] Corrupt files moved to `{path}.quarantine.{timestamp}`
- [ ] `cleanupQuarantine()` deletes files older than 7 days
- [ ] Quarantine logged at `warn` level
- [ ] Unit tests: quarantine creation, cleanup retention
      **Estimated LOC**: ~30 (within resilient-store.ts)
      **Dependencies**: TASK-2.1

### TASK-2.5: ResilientStoreFactory

**Description**: Factory for creating typed stores with shared base directory and logger.
**Acceptance Criteria**:

- [ ] `create<T>(name, config)` returns `ResilientStore<T>` at `{baseDir}/{name}.json`
- [ ] All stores share the same logger
- [ ] Unit tests: factory creates stores at correct paths
      **Estimated LOC**: ~20
      **Dependencies**: TASK-2.1

### TASK-2.6: Enhanced CircuitBreaker — Rolling Window

**File**: `.claude/lib/persistence/circuit-breaker.ts` (replace existing)
**Description**: Replace consecutive-failure counter with rolling-window circuit breaker. 5 failure classes. Expected failures (`expected`) don't trip circuit. Backwards-compatible `execute<T>(fn)` API.
**Acceptance Criteria**:

- [ ] `recordFailure(failureClass?)` pushes to timestamped ring buffer
- [ ] Old records evicted beyond `rollingWindowMs`
- [ ] `expected` class failures don't count toward threshold
- [ ] Only `countableClasses` (default: transient, external, rate_limited) trip circuit
- [ ] State transitions: CLOSED → OPEN → HALF_OPEN → CLOSED
- [ ] `halfOpenProbeCount` probes before closing
- [ ] `execute<T>(fn)` API preserved (backwards compatible)
- [ ] `recordFailure()` without args defaults to `transient`
- [ ] `getStats()` returns rolling window breakdown by class
- [ ] `onStateChange` callback fires on transitions
- [ ] Injectable `now()` for testing
- [ ] Unit tests: all 5 classes, window eviction, expected-skip, state machine, backwards compat
      **Estimated LOC**: ~200
      **Dependencies**: None (replaces existing file)

### TASK-2.6b: CircuitBreaker — Backwards Compatibility Contract

**Description**: Define and test the backwards compatibility contract for the circuit breaker replacement. Ensures existing consumers (workflow engine, cron service) continue working without changes.
**Acceptance Criteria**:

- [ ] **Compatibility contract documented** in code comments: `execute<T>(fn)` signature unchanged; `recordFailure()` without args defaults to `transient`; default thresholds produce equivalent behavior to old consecutive-failure counter (5 failures in 1hr window ≈ old 3 consecutive with typical failure patterns)
- [ ] No persisted breaker state exists (current breaker is in-memory only) — no state migration needed
- [ ] Old config shape (`{ maxFailures, resetTimeMs, halfOpenRetries }`) accepted via adapter if present, mapped to new config
- [ ] **Old usage pattern test**: exercise exact call patterns from existing `engine.ts` and `cron-service.ts` consumers against new breaker — verify same observable behavior
- [ ] Test: `execute()` with no `failureClass` provided → counts as transient → trips after threshold
- [ ] Test: state transitions match old CLOSED → OPEN → HALF_OPEN → CLOSED flow
      **Estimated LOC**: ~30 (adapter code) + ~50 (compat tests)
      **Dependencies**: TASK-2.6

### TASK-2.7: CircuitBreaker — GitHub Classifier

**Description**: Context-aware GitHub failure classification per SDD §3.5.
**Acceptance Criteria**:

- [ ] `classifyGitHubFailure(statusCode, headers, body?, context?)` returns FailureClass
- [ ] 429 → always `rate_limited`
- [ ] 403 + Retry-After → `rate_limited`
- [ ] 403 + x-ratelimit-remaining: "0" → `rate_limited`
- [ ] 403 + body "secondary rate limit" → `rate_limited`
- [ ] 403 otherwise → `transient` (NOT permanent)
- [ ] 404 + `resourceShouldExist: true` → `transient`
- [ ] 404 + `resourceShouldExist: false` → `expected`
- [ ] 404 no context → `expected`
- [ ] 422 → `permanent`
- [ ] 500/502/503 → `transient`
- [ ] Network errors → `external`
- [ ] Context overrides honored
- [ ] Unit tests: all classification rules, context variations, override behavior
      **Estimated LOC**: ~60 (within circuit-breaker.ts)
      **Dependencies**: TASK-2.6

### TASK-2.8: TokenBucket RateLimiter

**File**: `.claude/lib/persistence/rate-limiter.ts`
**Description**: Hierarchical rate limiter with global + per-workflow token buckets. Exponential backoff with jitter. GitHub header-based classification.
**Acceptance Criteria**:

- [ ] `tryConsume(workflowId)` checks both global and per-workflow buckets
- [ ] Returns `{ allowed, retryAfterMs?, bucket }` indicating which bucket is depleted
- [ ] Time-based token refill: `min(capacity, tokens + elapsedHours * refillPerHour)`
- [ ] `recordRateLimit()` adjusts buckets based on primary/secondary type
- [ ] `getBackoffMs()` returns exponential backoff with ±25% jitter
- [ ] Per-workflow buckets created lazily on first `tryConsume()`
- [ ] Injectable `now()` for testing
- [ ] Unit tests: token refill, dual-bucket depletion, backoff jitter range, secondary rate limit respect
      **Estimated LOC**: ~150
      **Dependencies**: None

### TASK-2.9: RateLimiter — Idle Bucket Cleanup

**Description**: Periodic cleanup of idle per-workflow buckets.
**Acceptance Criteria**:

- [ ] `setInterval` every 60s removes buckets idle > `idleEvictionMs` (default: 1hr)
- [ ] Timer is `unref()`'d to not block process exit
- [ ] `cleanup()` returns count of evicted buckets
- [ ] `shutdown()` clears the interval
- [ ] Unit tests: idle eviction, shutdown cleanup
      **Estimated LOC**: ~30 (within rate-limiter.ts)
      **Dependencies**: TASK-2.8

### TASK-2.10: Sprint 2 Unit Tests

**Description**: Comprehensive test suite for all Sprint 2 modules.
**Acceptance Criteria**:

- [ ] `resilient-store.test.ts`: write protocol, read fallback, migrations, quarantine, factory
- [ ] `circuit-breaker.test.ts`: rolling window, 5 classes, GitHub classifier, backwards compat
- [ ] `rate-limiter.test.ts`: token refill, dual bucket, backoff, idle cleanup
- [ ] All tests pass with `pnpm test`
- [ ] > 80% branch coverage on all new/modified files
      > **Dependencies**: TASK-2.1 through TASK-2.9

### Sprint 2 Acceptance Gate

- [ ] All 10 tasks completed
- [ ] `pnpm test` passes with >80% coverage on new/modified files
- [ ] ResilientStore survives simulated crash (corrupt primary → bak recovery)
- [ ] CircuitBreaker: 404 does NOT trip circuit; 403+Retry-After classified as rate_limited
- [ ] RateLimiter: depleted bucket returns `allowed: false` with correct `retryAfterMs`

---

## Sprint 3: Integration & Boot (P1 + P2)

**Global ID**: 20
**Goal**: Wire everything together — idempotency index on top of the resilient store, lock manager with boot ID staleness, tool validator, boot orchestrator, and workflow engine integration. After this sprint, the framework boots with full production hardening.

### Epic: Boot Orchestration & Integration

```
prodharden-sprint3 (Epic)
├── TASK-3.1: IdempotencyIndex — dedup with crash compensation [P0]
├── TASK-3.2: IdempotencyIndex — reconcilePending with audit query [P0]
├── TASK-3.3: LockManager — O_EXCL + stale detection [P0]
├── TASK-3.4: ToolValidator — boot-time registry cross-check [P2]
├── TASK-3.5: BootOrchestrator — 7-step deterministic startup [P0]
├── TASK-3.6: Workflow engine integration (F2+F5+F6) [P0]
├── TASK-3.7: Integration test: boot → workflow → audit [P0]
├── TASK-3.8: Integration test: crash resume with dedup [P0]
└── TASK-3.9: Sprint 3 unit + integration tests [P0]
```

### TASK-3.1: IdempotencyIndex — Core

**File**: `.claude/lib/safety/idempotency-index.ts`
**Description**: Dedup index backed by ResilientStore. Deterministic key generation, 3 statuses (pending/completed/failed), TTL eviction, crash compensation table.
**Acceptance Criteria**:

- [ ] `generateKey(action, scope, resource, params)` is deterministic (SHA-256 truncated)
- [ ] `check(key)` returns existing entry or null
- [ ] `markPending(key, intentSeq, strategy)` creates durable entry
- [ ] `markCompleted(key)` transitions pending → completed
- [ ] `markFailed(key, error)` transitions pending → failed (terminal state)
- [ ] `evict()` removes entries older than `ttlMs` (7 days default)
- [ ] Crash compensation table maps actions to strategies
- [ ] **Concurrent pending semantics**: if `check(key)` returns `pending`, caller behavior depends on `onPendingConflict` config: `'wait'` (poll with backoff until resolved, max 30s), `'skip'` (return conflict error immediately), or `'fail'` (throw `DuplicateExecutionError`). Default: `'skip'`
- [ ] **Lock coordination**: `markPending()` acquires the LockManager file lock for the dedup store before write; `markCompleted()`/`markFailed()` likewise. This ensures the check-then-mark critical section is atomic even across restarts
- [ ] Unit tests: key determinism, status transitions, TTL eviction, failed as terminal, concurrent pending conflict (skip/wait/fail modes)
      **Estimated LOC**: ~150
      **Dependencies**: Sprint 2 TASK-2.1 (ResilientStore), Sprint 1 TASK-1.4 (AuditTrail types)

### TASK-3.2: IdempotencyIndex — Reconcile Pending

**Description**: Boot-time reconciliation of pending entries with optional audit trail query.
**Acceptance Criteria**:

- [ ] `reconcilePending()` returns pending entries needing compensation
- [ ] Failed entries are NOT returned (terminal state)
- [ ] If `auditQuery` configured: checks audit trail for matching result
  - Audit result exists → auto-promote to completed
  - Audit error exists → auto-promote to failed
  - No audit result → return for compensation
- [ ] Without `auditQuery`: all pending entries returned for compensation
- [ ] Unit tests: reconcile with/without audit query, auto-promotion, strategy filtering
      **Estimated LOC**: ~60 (within idempotency-index.ts)
      **Dependencies**: TASK-3.1

### TASK-3.3: LockManager

**File**: `.claude/lib/persistence/lock-manager.ts`
**Description**: Boot ID-aware lock management with O_EXCL acquire, PID liveness check, age backstop, TOCTOU double-read protection.
**Acceptance Criteria**:

- [ ] `acquire(name)` uses O_EXCL atomic create
- [ ] Lock file contains `{ id, pid, bootId, createdAt, lockVersion }`
- [ ] Fsync lock fd + directory fd after write
- [ ] On EEXIST: read ownership, evaluate staleness
- [ ] Age backstop checked first: `age > maxAgeMs` → stale
- [ ] PID liveness: `process.kill(pid, 0)` with ESRCH (dead) / EPERM (live) handling
- [ ] Boot ID logged as diagnostic only (not staleness criterion)
- [ ] Double-read TOCTOU mitigation before unlink
- [ ] `release(name)` unlinks lock file
- [ ] `recoverStaleLocks()` scans all locks and recovers stale ones
- [ ] Unit tests: acquire, release, stale detection (age, PID dead), live lock protection, TOCTOU
      **Estimated LOC**: ~180
      **Dependencies**: Sprint 1 TASK-1.3 (Logger)

### TASK-3.4: ToolValidator

**File**: `.claude/lib/safety/tool-validator.ts`
**Description**: Boot-time validation of action policy against MCP tool surface.
**Acceptance Criteria**:

- [ ] `validateRegistry(mcpToolNames)` returns `{ valid, errors, warnings }`
- [ ] Unknown tools in policy → error (boot fails)
- [ ] Unregistered MCP tools → warning
- [ ] `validateParams(toolName, params)` returns violations
- [ ] `must_be`, `pattern`, `allowlist` constraint types supported
- [ ] Unit tests: registry cross-check, constraint validation, unknown tool rejection
      **Estimated LOC**: ~100
      **Dependencies**: None (uses ActionPolicy types)

### TASK-3.5: BootOrchestrator

**File**: `.claude/lib/boot/orchestrator.ts`
**Description**: 7-step deterministic boot sequence per SDD §1.3. Initializes all subsystems in dependency order. Determines operating mode. Returns health report + services bag.
**Acceptance Criteria**:

- [ ] `boot(config)` follows 7-step initialization order
- [ ] P0 failure → abort (throws)
- [ ] P1 failure → degraded mode (services bag has undefined for failed subsystems)
- [ ] `allowDev: true` → dev mode on any failure (with loud warning)
- [ ] Health report includes all subsystem statuses, boot time, warnings
- [ ] Operating mode: autonomous / degraded / dev
- [ ] Reconciles pending intents (Step 5)
- [ ] Recovers stale locks (Step 6)
- [ ] **Graceful shutdown**: `shutdown()` method handles SIGTERM/SIGINT — stops accepting new work, drains in-flight operations (time-bounded: 10s default), flushes audit trail + store buffers, releases all locks, emits `'shutdown'` event. Returns only after drain completes or timeout
- [ ] Unit tests: full boot, P0 abort, P1 degraded, dev mode, health report, graceful shutdown (drain + flush + lock release)
      **Estimated LOC**: ~250
      **Dependencies**: ALL Sprint 1 + Sprint 2 modules, TASK-3.1 through TASK-3.4

### TASK-3.6: Workflow Engine Integration (F2+F4+F5+F6)

**File**: `.claude/lib/workflow/engine.ts` (modify existing)
**Description**: Wire audit trail (F2), circuit breaker (F4), rate limiter (F5), and idempotency index (F6) into the workflow engine's `advance()` method per SDD §5.1. Implements 5-step durable ordering. Wraps GitHub/tool execution with CircuitBreaker.
**Acceptance Criteria**:

- [ ] Rate limiter check before execution
- [ ] Mutation gating in degraded mode
- [ ] Dedup check: completed → skip, failed → skip with error context
- [ ] Step 1: recordIntent + fsync (durable before mutation)
- [ ] Step 2: markPending + durable store write
- [ ] Step 3: execute **wrapped in CircuitBreaker.execute()** — failures classified via `classifyGitHubFailure()` and fed to breaker
- [ ] Step 4: recordResult + fsync
- [ ] Step 5: markCompleted + durable store write
- [ ] Error path: recordResult + markFailed (terminal, prevents infinite retry)
- [ ] CircuitBreaker OPEN state → throw `PersistenceError("CIRCUIT_OPEN")` before execution
- [ ] **BootOrchestrator wiring**: engine receives all services via constructor/config: `{ auditTrail, circuitBreaker, rateLimiter, dedupIndex, operatingMode }`
- [ ] Unit tests: full 5-step flow, dedup skip, degraded mode gating, error path, circuit breaker open rejection, failure classification
      **Estimated LOC**: ~100 (modifications to existing engine.ts)
      **Dependencies**: TASK-3.1, TASK-3.5

### TASK-3.7: Integration Test — Boot → Workflow → Audit

**Description**: End-to-end test: boot framework → execute workflow step → verify audit trail.
**Acceptance Criteria**:

- [ ] Boot with all subsystems
- [ ] Execute a mock workflow step (simulated GitHub API call)
- [ ] Verify audit trail has intent + result records
- [ ] Verify hash chain integrity via `verifyChain()`
- [ ] Verify dedup index has completed entry
- [ ] Verify all log output was redacted
      **Estimated LOC**: ~80
      **Dependencies**: TASK-3.5, TASK-3.6

### TASK-3.8: Integration Test — Crash Resume

**Description**: Simulate crash mid-workflow and verify dedup prevents double execution. Uses a **child-process crash harness**: test spawns a child Node process that executes workflow steps up to a configurable barrier, then the parent SIGKILLs the child. A second process boots fresh and verifies recovery invariants.

**Crash Harness Mechanism**:

- Test helper `spawnCrashWorker(options)` forks a child process via `child_process.fork()`
- Child accepts `crashAfterStep: 'intent' | 'pending' | 'execute' | 'result'` to control where it stops
- Child signals readiness to parent via IPC `{ ready: true, step: N }` after completing the target step
- Parent sends SIGKILL to child immediately after receiving the signal (simulates unclean crash)
- Parent waits for child exit, then boots a fresh framework instance in-process for recovery verification
- All processes share the same `dataDir` (tmp directory per test) for on-disk state

**On-Disk Invariants Checked After Crash**:
| Crash Point | Audit Trail | Dedup Store | Result Store |
|---|---|---|---|
| After `recordIntent` | Has intent record, no result | No entry | No entry |
| After `markPending` | Has intent record | Entry with status `pending` | No entry |
| After `execute` | Has intent record | Entry with status `pending` | No entry (result not yet recorded) |
| After `recordResult` | Has intent + result records | Entry with status `pending` (not yet completed) | No entry (store write follows) |

**Acceptance Criteria**:

- [ ] `spawnCrashWorker()` helper implemented in test utils — forks child, accepts crashAfterStep, SIGKILLs on signal
- [ ] Crash after `recordIntent`: recovery boot finds intent in audit, no pending dedup, workflow re-executes cleanly
- [ ] Crash after `markPending`: `reconcilePending()` finds entry, queries audit trail, retries (safe_retry) or checks remote (check_then_retry)
- [ ] Crash after `execute` (pre-result): `reconcilePending()` finds pending entry with no audit result, retries safely
- [ ] Crash after `recordResult` (pre-complete): `reconcilePending()` finds pending entry, finds matching audit result, auto-promotes to completed without re-execution
- [ ] Verify on-disk invariants table above for each crash point
- [ ] Verify no duplicate side-effects (mock tool execution counter = 1 after recovery for each scenario)
- [ ] All crash scenarios use real filesystem (tmpdir), not mocks
      **Estimated LOC**: ~200
      **Dependencies**: TASK-3.7

### TASK-3.9: Sprint 3 Tests

**Description**: Comprehensive test suite for all Sprint 3 modules plus integration.
**Acceptance Criteria**:

- [ ] `idempotency-index.test.ts`: key generation, status transitions, TTL, reconcile
- [ ] `lock-manager.test.ts`: acquire, release, stale detection, TOCTOU
- [ ] `tool-validator.test.ts`: registry cross-check, constraints
- [ ] `boot-orchestrator.test.ts`: full boot, modes, health report
- [ ] `engine-integration.test.ts`: 5-step durable ordering, dedup, crash resume
- [ ] All tests pass with `pnpm test`
- [ ] > 80% branch coverage on all new/modified files
      > **Dependencies**: TASK-3.1 through TASK-3.8

### Sprint 3 Acceptance Gate

- [ ] All 9 tasks completed
- [ ] `pnpm test` passes with >80% coverage on all new/modified files
- [ ] Full boot → workflow → audit trail integration works end-to-end
- [ ] Crash resume: pending entry reconciled correctly, no double execution
- [ ] Boot in degraded mode: mutation steps blocked, read steps proceed
- [ ] Tool validator rejects unknown tools at boot

---

## Phase Gate Failure Playbook

| Step                | Action                                                            | Owner            |
| ------------------- | ----------------------------------------------------------------- | ---------------- |
| 1. **Identify**     | Classify failure: test regression, new bug, environment issue     | AI agent         |
| 2. **Reopen**       | Move failed tasks back to `in_progress`                           | AI agent         |
| 3. **Scope-reduce** | If >2 retries, defer P1/P2 tasks (HMAC, quarantine, idle cleanup) | AI agent → human |
| 4. **Retry**        | Max 2 retry cycles per gate                                       | AI agent         |
| 5. **Escalate**     | Create GitHub issue with diagnostics, halt sprint                 | AI agent → human |

**Partially-Integrated Work Policy** (when a later sprint gate fails):

| Scenario                                                    | Action                                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sprint 2 gate fails, Sprint 1 code already merged to branch | Sprint 1 code stays — it's self-contained and tested. Fix Sprint 2 in-place.                                                                                                       |
| Sprint 3 integration gate fails                             | Diagnose root cause. If a Sprint 2 module is faulty, revert that module + its dependents via `git revert` (not branch reset). Re-run Sprint 2 gate.                                |
| >3 gate failures across any sprint                          | Halt plan. Create draft PR with "[INCOMPLETE]" tag. Document which sprints passed and which are unstable. Human decides: scope-cut (ship passing sprints only) or extend timeline. |
| Individual task regression in passing sprint                | Cherry-pick fix into the sprint. Do NOT revert the entire sprint.                                                                                                                  |

All work lives on a single feature branch (`feature/production-hardening`). There are no feature flags — each sprint's modules are inert until wired by BootOrchestrator in Sprint 3. This provides natural isolation: Sprint 1+2 modules exist as library code that is only activated during Sprint 3 integration.

---

## Risk Assessment

| Risk                                                | Severity | Mitigation                                                               |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| Audit trail I/O overhead (fsync per mutation)       | Medium   | Low mutation volume (<10/min); SSD target; group-commit as future option |
| Circuit breaker migration breaks existing consumers | Low      | Backwards-compatible API; `recordFailure()` defaults to `transient`      |
| Resilient store write protocol complexity           | Medium   | Extensive unit tests; crash simulation in integration tests              |
| Cross-dependency cascade during boot                | Medium   | Boot orchestrator catches per-subsystem and maps to degraded mode        |
| Lock manager PID check unreliable in containers     | Low      | Age backstop (maxAgeMs) ensures eventual recovery; documented limitation |

---

## Success Metrics

| Metric                           | Target                                 |
| -------------------------------- | -------------------------------------- |
| Total new LOC                    | ~2500                                  |
| Unit test coverage               | >80% branches on all new files         |
| Integration tests passing        | 2 end-to-end scenarios                 |
| Boot time                        | <2s on SSD                             |
| Audit chain verification         | 100% integrity after any test scenario |
| Secret detection                 | 100% on all 6 built-in patterns        |
| Zero external dependencies added | 0 new npm packages                     |

---

## Sprint Assumptions & Scope Boundaries

> _Flatline Protocol sprint review raised 7 skeptic concerns (SKP-001 through SKP-010) and 1 disputed improvement (IMP-010). All were reviewed and overridden per single-instance deployment topology (SDD §10). Rationales below._

### Deployment Topology (inherited from SDD §10)

Beauvoir is a **single-instance, single-process** framework. There is no multi-node clustering, shared filesystem access, or cross-host state. This architectural constraint simplifies many concerns raised by the adversarial review.

### Override Rationale Table

| ID      | Concern                                                                | Override Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SKP-001 | Template artifacts `{{DOCUMENT_CONTENT}}` in headings                  | **False positive.** Verified: no template placeholders exist in sprint.md. All headings are clean.                                                                                                                                                                                                                                                                                                                                                              |
| SKP-002 | fsync-per-mutation + verifyChain full scan perf risk                   | Mutation volume is <10/min in production. SSD target. `initialize()` index build is one-time at boot on a bounded file (rotation at 10MB). Group-commit is documented as future optimization in SDD §11. Boot time <2s metric covers this.                                                                                                                                                                                                                      |
| SKP-003 | Canonical serialization underspecified                                 | TASK-1.4 acceptance criteria specifies "canonical serialization: sorted keys, deterministic JSON.stringify replacement." Implementation will use `JSON.stringify(obj, Object.keys(obj).sort())` pattern which is deterministic for the record types we control (no Dates, BigInt, undefined in audit records). Golden test vectors are covered by TASK-1.9 audit chain integrity tests. RFC 8785 is overkill for internal-only audit logs.                      |
| SKP-004 | SecretRedactor missing JWT/private key patterns + deep-walk edge cases | The 6 patterns cover the secrets actually present in the Beauvoir+Finn ecosystem (GitHub tokens, HMAC keys, API keys). JWT and private keys are not used by this framework. Cycle detection + max depth (10) are standard implementation practices covered by TASK-1.2 acceptance criteria "nested objects." Additional patterns are trivially addable post-MVP.                                                                                                |
| SKP-005 | Audit truncation mid-file can lose valid suffix                        | TASK-1.5 already differentiates tail-torn-write (truncate last record) from mid-file corruption. Mid-file corruption with valid suffix is astronomically unlikely on single-process append-only files. If it occurs, the truncation preserves the longest valid prefix — this is the standard recovery strategy for append-only logs (WAL, binlog). The alternative (quarantine + new file) adds complexity without meaningful safety gain for single-instance. |
| SKP-007 | Store protocol OS/FS-dependent                                         | Target platform is Linux (Docker container on SSD). POSIX rename atomicity and directory fsync are guaranteed on ext4/xfs. Windows and network FS are explicitly out of scope (SDD §10). Container overlay FS (overlayfs) correctly delegates fsync to the underlying filesystem. PID-namespaced tmp files are safe in single-instance (no cross-host access).                                                                                                  |
| SKP-010 | Timeline unrealistic                                                   | Timeline is aggressive but appropriate for AI-agent development where the agent writes ~500 LOC/hour with tests. The 1-day buffer, scope-reduction playbook (defer P1/P2 tasks), and phased gate structure provide escape valves. The crash harness (TASK-3.8) is complex but bounded (~200 LOC).                                                                                                                                                               |
| IMP-010 | ActionPolicy/compensation strategy needs formal definition             | The crash compensation table in TASK-3.1 already maps actions to strategies (`safe_retry`, `check_then_retry`, `skip`). This is sufficient for the 3 strategies Beauvoir supports. A formal ActionPolicy schema adds abstraction without adding safety.                                                                                                                                                                                                         |
