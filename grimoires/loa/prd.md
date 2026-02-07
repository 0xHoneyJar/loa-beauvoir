# PRD: Beauvoir Production Hardening — Finn Pattern Transfer

> **Status**: Draft
> **Version**: 1.0.0
> **Created**: 2026-02-07
> **Author**: Claude Opus 4.6 + Human Operator
> **Issue**: [loa-beauvoir#30](https://github.com/0xHoneyJar/loa-beauvoir/issues/30)
> **Repo**: `0xHoneyJar/loa-beauvoir`
> **Cycle**: cycle-004 (Production Hardening)

---

## Executive Summary

Elevate Beauvoir's framework components from development-grade to production-grade by adapting battle-tested patterns from loa-finn. The existing Beauvoir subsystems (WAL, circuit breaker, action policy, workflow engine, JSON state store) form a solid foundation but lack the safety layers, observability hooks, and operational resilience needed for unattended autonomous agent execution.

This is a **beauvoir-only** effort. Finn already has these patterns; this cycle ports and adapts them into Beauvoir's framework architecture so that any consumer (Finn, future runtimes) inherits production-grade behavior from the framework itself.

---

## 1. Problem Statement

### Current State

Beauvoir has 5,000+ lines of production code across 5 subsystems:

- **WAL Manager** (630 LOC): Segmented WAL with fsync, flock, compaction, disk pressure monitoring
- **Circuit Breaker** (166 LOC): Simple consecutive-failure counter, lazy timeouts
- **Action Policy** (94 LOC): Tool allowlist/denylist with basic constraints
- **Workflow Engine** (309 LOC): Sequential step execution with crash recovery, per-step timeouts
- **JSON State Store** (152 LOC): Atomic writes with fsync + directory sync (L-1 fix)

However:

1. **No structured boot sequence.** Component initialization is ad-hoc — each subsystem has its own lazy init pattern. No health checks, no startup validation, no dependency ordering.

2. **No audit trail.** Workflow actions (GitHub mutations, policy decisions) leave no tamper-evident record. Impossible to answer "what did the agent do at 3am?" after the fact.

3. **No secret redaction.** Log output, error messages, and crash dumps could leak GitHub tokens, API keys, or other secrets.

4. **Naive circuit breaker.** Every failure type (transient 5xx, permanent 422, expected 404) counts equally toward the trip threshold. Expected failures (404 "not found") can false-trigger the circuit, blocking legitimate operations.

5. **No rate limiting.** Workflow steps call GitHub APIs without any throttling. A runaway workflow can exhaust API quotas and trigger GitHub's secondary abuse limits.

6. **No idempotency protection.** When workflows resume from checkpoint after crash, non-idempotent operations (add_issue_comment, create_pull_request) can execute twice.

7. **No backup/recovery for JSON stores.** The atomic write pattern prevents partial writes but a corrupted final file has no fallback. No schema migration support for evolving state formats.

8. **Boot-time tool validation missing.** Action policies validate at runtime only. Unknown tools slip through until first call. No boot-time cross-check against available MCP tools.

9. **PID-based lock staleness is fragile.** WAL manager detects stale locks via `process.kill(pid, 0)`, which doesn't work across containers or after PID recycling.

### Desired State

A framework where:

- **Boot orchestration** validates all subsystems in deterministic order with graceful degradation
- **Every autonomous mutation** is recorded in a hash-chained, tamper-evident audit trail
- **Secrets never leak** — all output channels run through redaction before logging
- **Circuit breaker** classifies failures by type, using rolling windows instead of consecutive counts
- **Rate limiting** prevents API quota exhaustion with hierarchical global + per-workflow buckets
- **Crash-resume** is idempotent — dedup index prevents double-execution of mutations
- **JSON stores** have backup/quarantine/migration support for operational resilience
- **Tool policies** are validated at boot against the actual MCP tool surface
- **Locks use boot IDs** for reliable stale detection across containers

### Why Now?

- Beauvoir's Agent Jobs cycle (cycle-003) builds autonomous GitHub workflows that run unattended
- Finn already has production-grade implementations of all 12 patterns (proven in CI)
- The patterns must live in Beauvoir (framework) so all consumers inherit safety guarantees
- The Bridgebuilder template (PR #29) is the first workflow that will run autonomously — it needs these production guardrails before deployment

---

## 2. Vision & Goals

### Vision Statement

> _"Every Beauvoir subsystem production-hardened. Every mutation auditable. Every crash recoverable. Zero secrets leaked."_

### Primary Goals

| Goal    | Description                   | Success Metric                                                                              |
| ------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| **G-1** | Structured boot orchestration | All subsystems validated in deterministic order; framework starts in <2s with health report |
| **G-2** | Tamper-evident audit trail    | Hash-chained JSONL with intent-result pairing; chain verification passes after any crash    |
| **G-3** | Secret redaction              | Zero secrets in logs/audit/errors; tested against known token patterns                      |
| **G-4** | Enhanced circuit breaker      | 5-class failure taxonomy; expected failures (404) don't trip circuit; rolling window stats  |
| **G-5** | Hierarchical rate limiting    | Global + per-workflow token buckets; exponential backoff with jitter                        |
| **G-6** | Crash-safe idempotency        | Dedup index prevents double-execution on resume; 7-day TTL auto-eviction                    |
| **G-7** | Resilient JSON stores         | Backup/quarantine/mutex/migration support on all JSON state files                           |
| **G-8** | Boot-time tool validation     | Action policy validated against MCP tool surface at startup                                 |
| **G-9** | Boot ID stale detection       | Locks use boot ID instead of PID for container-safe staleness                               |

### Non-Goals

- **Finn modifications**: This cycle only touches Beauvoir. Finn will consume via its existing dependency.
- **New workflow templates**: No new templates. Existing Bridgebuilder and pipeline templates are sufficient for validation.
- **Dashboard/UI**: Observability dashboard lives in Finn (cycle-003 sprint-6). Beauvoir provides data hooks only.
- **Multi-process coordination**: Single-writer assumption preserved. Full multi-process support is future scope.
- **Kill switch / dry-run / sandbox policies**: Deferred to Phase 4 (operational excellence). Low priority for MVP.

---

## 3. Users & Stakeholders

### Primary Users

| Persona                               | Role                             | Need                                                                       |
| ------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| **Framework Consumer** (Finn runtime) | Imports Beauvoir modules         | Production-safe defaults, no configuration footguns                        |
| **Workflow Author**                   | Writes YAML workflow definitions | Confidence that crashes don't corrupt state or duplicate mutations         |
| **Operator**                          | Monitors autonomous agents       | Audit trail answers "what happened?", boot health answers "is it working?" |

### Stakeholders

| Stakeholder      | Interest                                                      |
| ---------------- | ------------------------------------------------------------- |
| Security Auditor | Tamper-evident audit trail, secret redaction, boot validation |
| DevOps           | Boot orchestration, health checks, graceful degradation       |

---

## 4. Functional Requirements

### Feature 1: Boot Orchestration

**Priority**: P0 — Required for all other features

Deterministic startup sequence that validates subsystems in dependency order with graceful degradation.

**Operating Modes**: Boot produces a health report that determines the operating mode:

- **`autonomous`**: All P0 + P1 subsystems healthy. Framework may execute unattended mutations.
- **`degraded`**: P0 subsystems healthy, one or more P1 subsystems failed. Framework may execute read-only operations only. Mutations are blocked until degraded subsystems recover. Logged as warning.
- **`dev`**: Explicit opt-in via config flag `boot.allowDev: true`. Permits operation with missing subsystems for local development/testing only. Never permitted in production (flag must be absent or false).

| Req  | Description           | Acceptance Criteria                                                                                         |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------- |
| F1.1 | 7-step boot sequence  | Config → FS validate → Subsystem init → Tool validation → Reconcile intents → Recover locks → Health report |
| F1.2 | Operating modes       | `autonomous` (all ok), `degraded` (P0 ok, P1 failed — read-only), `dev` (explicit opt-in)                   |
| F1.3 | Fail-fast on critical | Audit trail, secret redactor, or action policy failure = boot abort with clear error                        |
| F1.4 | Health report         | Returns `{ success, mode, warnings[], subsystems: Record<string, 'ok'\|'degraded'\|'failed'> }`             |
| F1.5 | Dependency injection  | All subsystem init callbacks are optional for testing                                                       |
| F1.6 | Mutation gating       | In `degraded` mode, workflow engine rejects mutation steps with clear error; read-only steps proceed        |

### Feature 2: Hash-Chained Audit Trail

**Priority**: P0 — Required for autonomous operations

Tamper-evident, append-only action log with intent-result pairing.

**Threat Model**: The audit trail is **tamper-evident**, not tamper-proof. A local attacker with filesystem access can rewrite history by recomputing hashes. HMAC signing raises the bar (requires the signing key) but is optional because most deployments run in single-tenant containers where filesystem access implies full compromise. The primary goal is detecting accidental corruption, truncation, and unauthorized modification by non-root processes.

| Req   | Description             | Acceptance Criteria                                                                                                                                                                                     |
| ----- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F2.1  | JSONL with hash chain   | Each record has SHA-256 hash of content + `prevHash`                                                                                                                                                    |
| F2.2  | Intent-result pairing   | `recordIntent()` returns seq; `recordResult(intentSeq, ...)` links back                                                                                                                                 |
| F2.3  | 4 event phases          | `intent`, `result`, `denied`, `dry_run`                                                                                                                                                                 |
| F2.4  | Canonical serialization | Sorted keys, deterministic JSON for reproducible hashes                                                                                                                                                 |
| F2.5  | Chain verification      | `verifyChain()` returns `{ valid, brokenAt?, expected?, actual? }`                                                                                                                                      |
| F2.6  | Log rotation            | Rotate at 10MB; atomic: write new segment header, fsync, rename active→archive, fsync dir                                                                                                               |
| F2.7  | Optional HMAC signing   | HMAC-SHA256 with configurable key for authenticity                                                                                                                                                      |
| F2.8  | Secret redaction        | All recorded content passes through SecretRedactor before write                                                                                                                                         |
| F2.9  | Append protocol         | Open file with `O_APPEND`; each record is a single `write()` call (line + `\n`); fsync after every `result`/`denied` record (mutation-durable); telemetry/intent records may batch fsync on 100ms timer |
| F2.10 | Torn write recovery     | On startup, truncate active log to last complete line (`\n`-terminated), then verify chain from that point; log warning if records were lost                                                            |
| F2.11 | Structured redaction    | `redactAny(value)` walks objects/arrays recursively, redacts string values, and explicitly redacts known header keys (`Authorization`, `x-api-key`) and URL query params before serialization           |

### Feature 3: Secret Redactor

**Priority**: P0 — Required before any logging

Pattern-based secret detection and replacement with a defined enforcement boundary.

**Enforcement boundary**: Beauvoir provides a `Logger` interface that all framework subsystems (audit trail, workflow engine, circuit breaker, rate limiter, boot orchestrator) MUST use for output. The logger routes all messages through the redactor before emission. Third-party library internal logging (e.g., Node.js `console.warn` from dependencies) is explicitly out of scope — consumers are responsible for redirecting those if needed.

| Req  | Description          | Acceptance Criteria                                                                                                                            |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| F3.1 | Built-in patterns    | GitHub tokens (ghp*, github_pat*, ghs*, gho*), AWS keys (AKIA...), generic API keys, `Authorization` / `x-api-key` header values               |
| F3.2 | Typed placeholders   | `[REDACTED:github-pat]`, `[REDACTED:aws-key]`, `[REDACTED:api-key]`                                                                            |
| F3.3 | Extensible           | Constructor accepts additional `{ name, pattern }[]`                                                                                           |
| F3.4 | String redaction     | `redact(text: string): string` for flat string content                                                                                         |
| F3.5 | Structured redaction | `redactAny(value: unknown): unknown` walks objects/arrays, redacts string leaves, and explicitly strips known header keys and URL query params |
| F3.6 | Logger interface     | `BeauvoirLogger` with `info/warn/error/debug` methods; all subsystems use this; all output passes through redactor before emission             |
| F3.7 | Error redaction      | `redactError(err: Error): Error` creates a new Error with redacted `message` and redacted `cause` chain; original stack trace preserved        |

### Feature 4: Enhanced Circuit Breaker

**Priority**: P1 — Required for reliable GitHub integration

Replace consecutive-failure counter with classified, rolling-window circuit breaker.

| Req  | Description             | Acceptance Criteria                                                           |
| ---- | ----------------------- | ----------------------------------------------------------------------------- |
| F4.1 | 5 failure classes       | `transient`, `permanent`, `expected`, `external`, `rate_limited`              |
| F4.2 | Expected failures skip  | 404 "not found" does NOT count toward circuit trip                            |
| F4.3 | Rolling window          | Timestamped ring buffer; old failures auto-evict                              |
| F4.4 | GitHub classifier       | `classifyGitHubFailure(statusCode, headers)` returns failure class            |
| F4.5 | Configurable thresholds | `failureThreshold`, `rollingWindowMs`, `openDurationMs`, `halfOpenProbeCount` |
| F4.6 | State transition events | EventEmitter for `open`, `half-open`, `close` transitions                     |
| F4.7 | Backwards compatible    | Same `execute<T>(fn)` API as existing circuit breaker                         |

### Feature 5: Token Bucket Rate Limiter

**Priority**: P1 — Required for GitHub API safety

Hierarchical rate limiting with exponential backoff. Bucket defaults are **safety defaults**, not GitHub quota mirrors — they are intentionally conservative to prevent abuse-limit triggers. All values are configurable.

**GitHub classification**: Use response headers for authoritative classification:

- **Primary rate limit**: `X-RateLimit-Remaining: 0` with `X-RateLimit-Reset` timestamp, OR HTTP 429
- **Secondary/abuse limit**: HTTP 403 with `Retry-After` header present AND response body containing `"secondary rate limit"` or `"abuse detection"`
- **Generic 403**: No `Retry-After` header → classify as `permanent` failure (not rate-limited)

| Req  | Description                 | Acceptance Criteria                                                                                                                                                              |
| ---- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F5.1 | Two-tier buckets            | Global (configurable, default 500/hr) + per-workflow (configurable, default 100/hr)                                                                                              |
| F5.2 | Time-based refill           | `elapsedHours * refillPerHour`, capped at capacity                                                                                                                               |
| F5.3 | Header-based classification | Use `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`, and response body patterns; separate primary (429) from secondary (403+Retry-After+body match) from generic 403 |
| F5.4 | Exponential backoff         | With jitter (±25%), base 1s, max 60s; for secondary limits, respect `Retry-After` header as minimum wait                                                                         |
| F5.5 | Lazy initialization         | Per-workflow buckets created on first use                                                                                                                                        |
| F5.6 | Idle cleanup                | Evict per-workflow buckets after 1hr idle                                                                                                                                        |
| F5.7 | Integration tests           | Simulate GitHub responses (429, 403+Retry-After, 403 without) and verify correct backoff/classification behavior                                                                 |

### Feature 6: Idempotency Index

**Priority**: P1 — Required for crash-safe resume

Deduplication index for non-idempotent operations.

**Persistence & write ordering**: The dedup index is persisted via the Resilient JSON Store (F7). The execution protocol for non-idempotent operations follows this strict ordering:

1. `recordIntent()` in audit trail (F2) — durable (fsync'd)
2. `markPending(key)` in dedup index — durable (store flush)
3. Execute the side-effect (e.g., GitHub API call)
4. `recordResult(intentSeq)` in audit trail — durable (fsync'd)
5. `markCompleted(key)` in dedup index — durable (store flush)

On crash between steps 2-3: boot reconciliation finds `pending` entry → runs per-action reconciliation strategy.
On crash between 3-5: boot reconciliation finds `pending` entry → checks remote state (e.g., "does this comment already exist?") before retrying.

| Req  | Description              | Acceptance Criteria                                                                                                                                                |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F6.1 | Deterministic keys       | `{action}:{scope}/{resource}:{stateHash(16)}`                                                                                                                      |
| F6.2 | 3 statuses               | `pending`, `completed`, `unknown` (orphan reconciliation)                                                                                                          |
| F6.3 | TTL auto-eviction        | 7-day default, configurable                                                                                                                                        |
| F6.4 | Crash compensation table | Per-action strategy: `safe_retry` (create_branch — idempotent), `check_then_retry` (add_issue_comment — check if comment exists), `skip` (non-critical enrichment) |
| F6.5 | Boot reconciliation      | Reconcile `pending` entries at startup per crash compensation table                                                                                                |
| F6.6 | Storage backend          | Uses Resilient JSON Store (F7) for persistence; one index file per workflow run                                                                                    |
| F6.7 | Write ordering           | Steps 1-5 above enforced; audit trail intent MUST be durable before side-effect executes                                                                           |

### Feature 7: Resilient JSON Store

**Priority**: P1 — Required for all state persistence

Enhance JSON state store with backup, quarantine, mutex, and migrations.

**Crash-safe write protocol** (exact ordering):

1. Serialize state to JSON (sorted keys)
2. Check serialized size against limit
3. Write to `{path}.{pid}.tmp` with fsync
4. Fsync parent directory (ensures temp file durable)
5. Rename current `{path}` → `{path}.bak` (preserves last-known-good)
6. Rename `{path}.{pid}.tmp` → `{path}` (atomic swap)
7. Fsync parent directory (ensures rename durable)

**Read fallback chain** (exact ordering):

1. Read `{path}` → parse JSON → validate schema version → return if valid
2. Read `{path}.bak` → parse JSON → validate schema version → return if valid (log warning)
3. Read `{path}.{pid}.tmp` only if it passes full parse + schema validation AND its mtime is newer than primary (log warning)
4. If all sources corrupt: move corrupt files to `{path}.quarantine.{timestamp}`, log error, return null
5. Quarantine retention: 7 days, cleaned during boot orchestration

| Req  | Description           | Acceptance Criteria                                                                    |
| ---- | --------------------- | -------------------------------------------------------------------------------------- |
| F7.1 | Crash-safe write      | 7-step protocol above; `.bak` is always last-known-good from previous successful write |
| F7.2 | Read fallback chain   | 5-step protocol above; never trusts `.tmp` without full validation + recency check     |
| F7.3 | Async mutex           | Promise-chain write serialization (no external deps)                                   |
| F7.4 | Schema migrations     | `_schemaVersion` field with chained upgrade functions                                  |
| F7.5 | Size limit            | Configurable max size (default 10MB); reject oversized writes before writing temp      |
| F7.6 | Sorted keys           | Deterministic JSON output for diffability                                              |
| F7.7 | Quarantine management | Corrupt files moved to `{path}.quarantine.{timestamp}`; 7-day retention; boot cleanup  |

### Feature 8: Boot-Time Tool Validation

**Priority**: P2 — Enhances safety posture

Validate action policy against actual MCP tool surface at startup.

| Req  | Description            | Acceptance Criteria                                               |
| ---- | ---------------------- | ----------------------------------------------------------------- |
| F8.1 | Registry cross-check   | At boot, verify all policy-allowed tools exist in MCP             |
| F8.2 | Unknown tool rejection | Boot fails if unknown tools in allow list                         |
| F8.3 | Pattern constraints    | `must_be`, `pattern` (regex), `allowlist` (enum) constraint types |
| F8.4 | Runtime validation     | `validateParams(toolName, params)` returns violations array       |

### Feature 9: Boot ID Stale Lock Detection

**Priority**: P2 — Enhances container safety

Enhance lock acquisition with boot ID metadata for reliable stale detection.

**Lock semantics**: The **primary lock mechanism** remains O_EXCL (`wx` flag) atomic file creation or `flock` (whichever the subsystem uses). Boot ID is **diagnostic metadata** stored inside the lock file, NOT the primary staleness condition. A lock is considered stale only when ALL of the following are true:

1. The lock file exists (O_EXCL acquisition failed)
2. The owner process cannot be verified as alive (PID check fails or boot ID mismatches current host)
3. The lock age exceeds `maxAgeMs` (default: 1 hour)

A second instance CANNOT steal a lock from a live first instance — the O_EXCL/flock mechanism prevents this.

| Req  | Description              | Acceptance Criteria                                                                        |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------ |
| F9.1 | Boot ID generation       | `randomUUID()` per process instance, stored in lock ownership record                       |
| F9.2 | Lock ownership record    | `{ id, pid, bootId, startedAt }` written atomically into lock file                         |
| F9.3 | Staleness criteria       | Stale = PID check fails AND (boot ID mismatch OR age > maxAgeMs); BOTH conditions required |
| F9.4 | TOCTOU mitigation        | Double-read ownership before unlink; re-acquire with O_EXCL after unlink                   |
| F9.5 | Boot scan                | `recoverStaleLocks()` runs during boot orchestration; alerts on stale locks found          |
| F9.6 | Live instance protection | A second instance that detects a live lock holder MUST fail boot (not steal the lock)      |

---

## 5. Technical & Non-Functional Requirements

### Performance

All targets measured on SSD storage. Percentile-based where latency-sensitive.

| Requirement                    | Target                                               | Notes                                                                |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------- |
| Boot time                      | <2s p95 for full validation sequence                 | Benchmark harness required                                           |
| Audit trail append (mutation)  | <5ms p99 per record (includes fsync)                 | `result`/`denied` records are individually fsync'd for durability    |
| Audit trail append (telemetry) | <0.5ms p95 per record (batched fsync on 100ms timer) | `intent`/`dry_run` records may lose last batch on crash — acceptable |
| Circuit breaker overhead       | <0.1ms per `execute()` call                          | In-memory only, no I/O                                               |
| Rate limiter check             | <0.01ms per `tryConsume()` call                      | In-memory only, no I/O                                               |
| Dedup lookup                   | <0.5ms per key check                                 | In-memory map; persisted async                                       |

### Security

| Requirement      | Description                                                          |
| ---------------- | -------------------------------------------------------------------- |
| Secret redaction | All output channels (audit, logs, errors) must pass through redactor |
| HMAC signing     | Audit trail supports optional HMAC for authenticity verification     |
| Hash chain       | SHA-256 chain prevents silent record deletion or modification        |
| Boot validation  | Unknown tools rejected; prevents policy bypass via tool injection    |

### Reliability

| Requirement          | Description                                                 |
| -------------------- | ----------------------------------------------------------- |
| Crash recovery       | All state files survive power loss (atomic writes + fsync)  |
| Backup fallback      | Corrupted primary file recoverable from `.bak`              |
| Graceful degradation | Non-critical subsystem failure doesn't crash framework      |
| Idempotent resume    | Crash-interrupted workflows resume without double mutations |

### Testing

| Requirement        | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| Unit test coverage | >80% lines/branches for all new modules                          |
| Integration tests  | Boot sequence, crash-resume, circuit breaker state machine       |
| Chaos tests        | Simulated crashes mid-write for backup/quarantine recovery       |
| Secret detection   | Test suite with known token patterns must achieve 100% detection |

---

## 6. Scope & Prioritization

### MVP (This Cycle)

| Priority | Features                                                             | Rationale                                |
| -------- | -------------------------------------------------------------------- | ---------------------------------------- |
| P0       | F1 (Boot), F2 (Audit Trail), F3 (Secret Redactor)                    | Foundation for all autonomous operations |
| P1       | F4 (Circuit Breaker), F5 (Rate Limiter), F6 (Dedup), F7 (JSON Store) | Reliability and data integrity           |
| P2       | F8 (Tool Validation), F9 (Boot ID)                                   | Enhanced safety posture                  |

### Explicitly Out of Scope

- Multi-process coordination / distributed locks
- Dashboard UI (lives in Finn)
- New workflow templates

### Finn Pattern Exclusion Table (12 total → 9 in scope)

Finn has 12 transferable patterns. This cycle includes 9. The 3 excluded patterns and rationale:

| #   | Finn Pattern                                          | Status             | Rationale for Exclusion                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | **Kill Switch** (`src/cron/kill-switch.ts`)           | Deferred — Phase 4 | Operational convenience, not safety-critical. The boot operating modes (F1.2) provide equivalent protection: `degraded` mode blocks mutations, and operators can stop the process directly. Kill switch adds value only for multi-job orchestration which is out of scope. |
| 11  | **Dry-Run Interceptor** (`src/cron/dry-run.ts`)       | Deferred — Phase 4 | Development/testing tool, not production requirement. Beauvoir's action policy (F8) already prevents unauthorized mutations. Dry-run adds execution preview which is valuable but not needed for the stated security/reliability goals.                                    |
| 12  | **Sandbox Policies** (`src/cron/sandbox-policies.ts`) | Deferred — Phase 4 | Only relevant if Beauvoir exposes bash tool capabilities. Current framework does not. Kept as reference for future bash tool safety.                                                                                                                                       |

None of the excluded patterns are required for the stated security (G-2, G-3), reliability (G-4 through G-7), or operational (G-1, G-8, G-9) goals.

---

## 7. Risks & Dependencies

### Technical Risks

| Risk                        | Severity | Mitigation                                              |
| --------------------------- | -------- | ------------------------------------------------------- |
| Audit trail I/O overhead    | Medium   | Batch fsync, async append with flush-on-close           |
| Circuit breaker migration   | Low      | Backwards-compatible API; old config still works        |
| Schema migration complexity | Medium   | Start with single-step migrations; chain only if needed |

### Dependencies

| Dependency                        | Type           | Status                                 |
| --------------------------------- | -------------- | -------------------------------------- |
| Finn reference implementations    | Code reference | Available (src/cron/, src/safety/)     |
| Existing Beauvoir WAL             | Internal       | Production (630 LOC, tested)           |
| Existing Beauvoir circuit breaker | Internal       | Production (166 LOC, replace in-place) |
| Existing Beauvoir action policy   | Internal       | Production (94 LOC, enhance)           |
| Existing Beauvoir workflow engine | Internal       | Production (309 LOC, integrate)        |

---

## Appendix A: Finn Source Mapping

| Beauvoir Feature        | Finn Source                     | Category |
| ----------------------- | ------------------------------- | -------- |
| Boot Orchestration (F1) | `src/boot/agent-jobs-boot.ts`   | ADAPT    |
| Audit Trail (F2)        | `src/safety/audit-trail.ts`     | IMPORT   |
| Secret Redactor (F3)    | `src/safety/secret-redactor.ts` | IMPORT   |
| Circuit Breaker (F4)    | `src/cron/circuit-breaker.ts`   | ADAPT    |
| Rate Limiter (F5)       | `src/cron/rate-limiter.ts`      | IMPORT   |
| Dedup Index (F6)        | `src/cron/idempotency.ts`       | IMPORT   |
| JSON Store (F7)         | `src/cron/store.ts`             | ADAPT    |
| Tool Validation (F8)    | `src/safety/tool-registry.ts`   | ADAPT    |
| Boot ID Locks (F9)      | `src/cron/concurrency.ts`       | ADAPT    |

## Appendix B: Existing Beauvoir Component Inventory

| Component           | File                                                        | LOC | Status                 |
| ------------------- | ----------------------------------------------------------- | --- | ---------------------- |
| WAL Manager         | `.claude/lib/persistence/wal/wal-manager.ts`                | 630 | Production             |
| Circuit Breaker     | `.claude/lib/persistence/circuit-breaker.ts`                | 166 | Replace (F4)           |
| Action Policy       | `.claude/lib/safety/action-policy.ts`                       | 94  | Enhance (F8)           |
| Workflow Engine     | `.claude/lib/workflow/engine.ts`                            | 309 | Integrate (F2, F5, F6) |
| JSON State Store    | `.claude/lib/beads/reference/json-state-store.ts`           | 152 | Replace (F7)           |
| Interfaces          | `.claude/lib/beads/interfaces.ts`                           | 628 | Extend                 |
| Recovery Engine     | `.claude/lib/persistence/recovery-engine.ts`                | 139 | Integrate (F1)         |
| Checkpoint Protocol | `.claude/lib/persistence/checkpoint/checkpoint-protocol.ts` | 172 | Integrate (F7)         |
| Validation          | `.claude/lib/beads/validation.ts`                           | 302 | Reuse                  |
