# Cross-Repo Pattern Extraction Research

**Date**: 2026-02-06
**Author**: Claude Opus 4.6
**Repos Analyzed**: loa-beauvoir, loa-finn, loa (upstream)
**Method**: Deep analysis of all merged PRs, open issues, source code, and deployment patterns

---

## Executive Summary

After comprehensive analysis of all three repositories (987 upstream framework files, 14,709 LOC in beauvoir's deploy layer, 2,923 LOC in finn's source), we identified **25 extractable patterns** totaling ~8,383 LOC that should be consolidated into the upstream loa framework's `.claude/lib/` directory.

The strongest extraction signals come from **convergent evolution**: both beauvoir and finn independently built circuit breakers, WALs, identity loaders, quality gates, and schedulers. When two repos solve the same problem independently, it belongs in the framework.

**Key finding**: Finn proved that beauvoir's persistence design works in production (3-tier WAL -> R2 -> Git), while beauvoir proved that finn's patterns need hardening (input validation, injection prevention, clock injection for testing). The framework should offer both "lite" and "full" variants where appropriate.

---

## 1. What Upstream Loa Already Has

### `.claude/lib/beads/` (v1.31.0) -- Already Upstream

- Validation suite (shell injection, path traversal, input sanitization)
- Label constants + utilities (run state, sprint, lineage, classification)
- Abstract interfaces (IBrExecutor, IWALAdapter, IScheduler, IStateStore)
- RunStateManager (batch queries, circuit breakers via labels)
- GapDetector (session continuity recovery)
- ContextCompiler (token-budget-aware context assembly)
- Reference implementations (FileWAL, IntervalScheduler, JsonStateStore)

### `.claude/lib/persistence/` (PR #220) -- Already Upstream

- CircuitBreaker (closed/open/half-open, injectable clock)
- WALManager (segmented, delta compaction, disk pressure, flock)
- Checkpoint protocol (atomic writes, manifest verification)
- Recovery engine (multi-source: git, mount, template)
- Ed25519 manifest signing
- Learning store + quality gates
- Identity loader + file watcher
- Beads adapters (WAL bridge, recovery handler)

### Total Already Upstream: ~9,000 LOC across 47 TypeScript files, 14 test suites

---

## 2. Convergent Patterns (Both Repos Built Independently)

These are the highest-priority extractions. Independent evolution of the same pattern is the strongest signal that it belongs in the framework.

### 2.1 Circuit Breaker (CONVERGE)

| Aspect | Finn (`src/scheduler/circuit-breaker.ts`) | Beauvoir (`.claude/lib/persistence/circuit-breaker.ts`) |
| ------ | ----------------------------------------- | ------------------------------------------------------- |
| LOC    | 139                                       | 167                                                     |
| States | lowercase                                 | UPPERCASE                                               |
| Clock  | `Date.now()` direct                       | Injectable `nowFn` for testing                          |
| Extra  | Task ID tracking, probe counter           | Half-open retries, `msUntilReset()`                     |

**Recommendation**: Beauvoir's version is more testable (injectable clock) and already upstream. Merge finn's task-ID tracking and probe counter into the upstream version.

### 2.2 Write-Ahead Log (INTERFACE + VARIANTS)

| Aspect        | Finn (`src/persistence/wal.ts`) | Beauvoir (`.claude/lib/persistence/wal/`) |
| ------------- | ------------------------------- | ----------------------------------------- |
| LOC           | 226                             | ~700 (4 files)                            |
| IDs           | ULID                            | Custom time-sortable                      |
| Checksums     | SHA-256 data only               | SHA-256 data + entry                      |
| Locking       | None (sync appends)             | flock + PID fallback                      |
| Compaction    | None (relies on pruning)        | Delta-based                               |
| Disk pressure | Hysteresis 100/150MB            | Configurable thresholds                   |

**Recommendation**: Keep beauvoir's full WAL upstream. Add a `LiteWAL` reference implementation based on finn's simpler approach for single-process deployments. Finn's PR #7 explicitly asks for this convergence.

### 2.3 Identity Loader (TWO TIERS)

| Aspect     | Finn (`src/agent/identity.ts`) | Beauvoir (`.claude/lib/persistence/identity/`) |
| ---------- | ------------------------------ | ---------------------------------------------- |
| LOC        | 84                             | 286                                            |
| Parsing    | Raw content (inject as prompt) | Structured (principles, boundaries)            |
| Hot-reload | fs.watch + debounce            | FileWatcher abstraction                        |

**Recommendation**: Already upstream (beauvoir's version). Finn's simpler "load and inject" is a valid use case -- consider adding a `loadRaw()` method to the existing IdentityLoader.

### 2.4 Quality Gates (ALREADY CONVERGED)

Beauvoir's 4-gate numeric scorer (`IQualityGateScorer` interface) is already upstream. Finn's inline binary pass/fail gates are a simpler version. No action needed -- upstream version is sufficient.

### 2.5 Scheduler + Circuit Breaker Integration

Both repos wire circuit breakers into scheduled tasks. Neither has a reusable upstream implementation:

- Finn: `src/scheduler/scheduler.ts` (132 LOC) + CB integration
- Beauvoir: `deploy/loa-identity/scheduler/scheduler.ts` (389 LOC) with jitter, mutual exclusion groups

**Recommendation**: Extract beauvoir's scheduler (more features) with finn's simpler CB wiring pattern.

---

## 3. Beauvoir-Only Patterns (Extraction Candidates)

Patterns that exist only in beauvoir's `deploy/loa-identity/` and are generic enough for the framework.

### Tier 1: LOW Complexity (~2,500 LOC total)

| Pattern                    | File                             | LOC | Why Generic                                                                                                                          |
| -------------------------- | -------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **PII Redactor**           | `security/pii-redactor.ts`       | 386 | Every agent persisting memories needs PII filtering. 15+ built-in patterns, Shannon entropy detection.                               |
| **Audit Logger**           | `security/audit-logger.ts`       | 285 | Tamper-evident JSONL with SHA-256 hash chaining. Universal for agent operations.                                                     |
| **Quality Gates (Memory)** | `memory/quality-gates.ts`        | 393 | 6 filter functions for memory entries (temporal, speculation, instruction, confidence, quality, technical). Pure functions, no deps. |
| **Notification Sink**      | `scheduler/notification-sink.ts` | 459 | Multi-channel alerting (Slack, Discord, webhook, log). Composite pattern. Simple interface.                                          |
| **Context Tracker**        | `memory/context-tracker.ts`      | 374 | Token usage monitoring with 60/70/80% thresholds. Model-agnostic.                                                                    |
| **Timeout Enforcer**       | `scheduler/timeout-enforcer.ts`  | 273 | Enforces minimum timeouts for trusted models. Prevents premature agent termination.                                                  |
| **MECE Validator**         | `scheduler/mece-validator.ts`    | 317 | Detects overlapping/duplicate scheduled tasks. Prevents agent task proliferation.                                                    |

### Tier 2: MEDIUM Complexity (~2,500 LOC total)

| Pattern             | File                             | LOC   | Why Generic                                                                                           |
| ------------------- | -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| **Scheduler**       | `scheduler/scheduler.ts`         | 389   | Periodic tasks with jitter, per-task circuit breakers, mutual exclusion groups.                       |
| **Sprint Ingester** | `beads/beads-sprint-ingester.ts` | 793   | Parses sprint markdown into beads tasks. Kahn's algorithm cycle detection. Already tested (40 tests). |
| **Work Queue**      | `beads/beads-work-queue.ts`      | 1,087 | Priority-based task claiming, 30-min bounded sessions, structured handoff protocol.                   |
| **Bloat Auditor**   | `scheduler/bloat-auditor.ts`     | 499   | Detects resource proliferation (crons, scripts, state files). Remediation suggestions.                |

### Tier 3: HIGH Complexity

| Pattern                    | File                             | LOC | Blocker                                |
| -------------------------- | -------------------------------- | --- | -------------------------------------- |
| **Consolidation Engine**   | `memory/consolidation-engine.ts` | 543 | Requires embedding service (HTTP API). |
| **Session Memory Manager** | `memory/session-manager.ts`      | 452 | Depends on SegmentedWAL + PIIRedactor. |

---

## 4. Finn-Only Patterns (Extraction Candidates)

Patterns finn has that neither beauvoir nor upstream provides.

### Tier 1: HIGH Value

| Pattern                     | File                          | LOC | Why Generic                                                                                                                                               |
| --------------------------- | ----------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Beads CLI Bridge**        | `src/beads/bridge.ts`         | 150 | Typed TypeScript wrapper for `br` CLI. Health check, version compat, timeout handling. Replaces shell scripts.                                            |
| **Compound Learning Cycle** | `src/learning/compound.ts`    | 187 | End-to-end: trajectory logging -> pattern extraction -> quality gates -> persistence. Minimal implementation of what beauvoir configs in 200+ YAML lines. |
| **Recovery Cascade**        | `src/persistence/recovery.ts` | 199 | Boot-time recovery: WAL -> R2 -> Git -> template fallback. Conflict detection between local and remote WAL heads.                                         |
| **Health Aggregator**       | `src/scheduler/health.ts`     | 119 | Aggregates subsystem health into composite status (healthy/degraded/unhealthy).                                                                           |
| **Graceful Shutdown**       | `src/index.ts` (partial)      | 42  | Drain -> sync -> exit with force timeout. Guards against double invocation.                                                                               |

### Tier 2: MEDIUM Value (Cloud-Dependent)

| Pattern               | File                          | LOC | Dependency                            |
| --------------------- | ----------------------------- | --- | ------------------------------------- |
| **Object Store Sync** | `src/persistence/r2-sync.ts`  | 210 | `@aws-sdk/client-s3` (S3-compatible)  |
| **Git Archival Sync** | `src/persistence/git-sync.ts` | 235 | `git` binary (worktree-based, clever) |
| **WAL Pruner**        | `src/persistence/pruner.ts`   | 56  | Coordinated multi-target pruning      |

### Tier 3: Web Gateway (If Needed)

| Pattern              | File                        | LOC | Dependency       |
| -------------------- | --------------------------- | --- | ---------------- |
| **HTTP/WS Gateway**  | `src/gateway/` (5 files)    | 667 | `hono`, `ws`     |
| **Timing-Safe Auth** | `src/gateway/auth.ts`       | 85  | Node.js `crypto` |
| **Rate Limiter**     | `src/gateway/rate-limit.ts` | 89  | None             |

---

## 5. Proposed Module Organization

Based on all findings, here is the recommended `.claude/lib/` structure for upstream loa:

```
.claude/lib/
  beads/                  # [EXISTS] Beads TypeScript runtime
  persistence/            # [EXISTS] WAL, checkpoint, recovery, circuit breaker

  security/               # [NEW] Extracted from beauvoir
    pii-redactor.ts       #   PII detection/redaction (386 LOC)
    audit-logger.ts       #   Tamper-evident JSONL logging (285 LOC)
    index.ts              #   Barrel exports

  memory/                 # [NEW] Extracted from beauvoir + finn
    quality-gates.ts      #   Memory filtering (6 gates) (393 LOC)
    context-tracker.ts    #   Token budget monitoring (374 LOC)
    compound-learning.ts  #   Trajectory -> patterns -> persist (187 LOC)
    index.ts

  scheduler/              # [NEW] Extracted from beauvoir + finn
    scheduler.ts          #   Periodic tasks + circuit breakers (389 LOC)
    notification-sink.ts  #   Multi-channel alerting (459 LOC)
    timeout-enforcer.ts   #   Model-aware timeout governance (273 LOC)
    mece-validator.ts     #   Duplicate task detection (317 LOC)
    health-aggregator.ts  #   Composite health status (119 LOC)
    bloat-auditor.ts      #   Resource proliferation guard (499 LOC)
    index.ts

  bridge/                 # [NEW] Extracted from finn
    beads-bridge.ts       #   Typed br CLI wrapper (150 LOC)
    index.ts

  sync/                   # [NEW] Extracted from finn (cloud-tier)
    recovery-cascade.ts   #   Boot-time multi-source recovery (199 LOC)
    object-store-sync.ts  #   S3-compatible sync (210 LOC)
    git-archival-sync.ts  #   Worktree-based git backup (235 LOC)
    wal-pruner.ts         #   Coordinated multi-target pruning (56 LOC)
    graceful-shutdown.ts  #   Drain -> sync -> exit (42 LOC)
    index.ts
```

**Total new code**: ~4,973 LOC across 6 new modules

---

## 6. Extraction Constraints

All new `.claude/lib/` code MUST:

1. **No npm dependencies** -- Use only Node.js built-ins (`fs`, `path`, `crypto`, `child_process`, `util`)
2. **Relative imports only** within the module directory
3. **No package.json** -- The upstream repo is a pure dotfile framework
4. **Include vitest tests** alongside the source
5. **Work without compilation** -- Raw `.ts` consumed by bun/tsx/jiti
6. **Use `.js` extensions** in imports (matching persistence library convention)
7. **Constructor injection** for all dependencies (no singletons, no `process.env` reads)
8. **Factory functions** alongside classes (`createXxx()` convention)
9. **Graceful degradation** for optional dependencies (`fs-ext`, `br`)
10. **No breaking changes** to existing `beads/` or `persistence/` APIs

### Special Considerations

- **`@aws-sdk/client-s3`**: The object-store-sync pattern cannot use npm deps. Options: (a) make it interface-only with a reference implementation that users wire up, or (b) use raw `fetch()` against S3-compatible APIs (no SDK). Recommend option (a).
- **`ulid`**: Finn's WAL uses the `ulid` package. The upstream equivalent uses custom time-sortable IDs. Stick with the upstream pattern (no npm dep).
- **`hono`/`ws`**: Gateway patterns have npm deps. These should remain reference implementations in docs, not `.claude/lib/`.

---

## 7. Prioritized Roadmap

### Sprint 1: Security + Memory Foundations (~1,600 LOC)

_LOW complexity, HIGH value, no dependencies_

| Task                            | LOC  | Source   | Priority |
| ------------------------------- | ---- | -------- | -------- |
| Extract PII Redactor            | 386  | beauvoir | P0       |
| Extract Audit Logger            | 285  | beauvoir | P0       |
| Extract Memory Quality Gates    | 393  | beauvoir | P0       |
| Extract Context Tracker         | 374  | beauvoir | P1       |
| Extract Compound Learning Cycle | 187  | finn     | P1       |
| Write tests for all 5 modules   | ~400 | new      | P0       |

### Sprint 2: Scheduler + Operational Hardening (~2,100 LOC)

_MEDIUM complexity, operational patterns_

| Task                                    | LOC  | Source                 | Priority |
| --------------------------------------- | ---- | ---------------------- | -------- |
| Extract Scheduler (with CB integration) | 389  | beauvoir+finn converge | P0       |
| Extract Notification Sink               | 459  | beauvoir               | P1       |
| Extract Health Aggregator               | 119  | finn                   | P1       |
| Extract Timeout Enforcer                | 273  | beauvoir               | P1       |
| Extract MECE Validator                  | 317  | beauvoir               | P2       |
| Extract Bloat Auditor                   | 499  | beauvoir               | P2       |
| Write tests for all 6 modules           | ~600 | new                    | P0       |

### Sprint 3: Beads + Sync Layer (~1,700 LOC)

_MEDIUM complexity, cross-repo convergence_

| Task                                            | LOC  | Source           | Priority |
| ----------------------------------------------- | ---- | ---------------- | -------- |
| Extract Beads CLI Bridge                        | 150  | finn             | P0       |
| Extract Sprint Ingester                         | 793  | beauvoir         | P1       |
| Extract Recovery Cascade                        | 199  | finn             | P1       |
| Extract Graceful Shutdown                       | 42   | finn             | P2       |
| Extract WAL Pruner                              | 56   | finn             | P2       |
| Converge Circuit Breaker (add task ID tracking) | +30  | finn -> upstream | P1       |
| Write tests                                     | ~400 | new              | P0       |

### Sprint 4: Work Queue + Cloud Sync (~1,500 LOC)

_MEDIUM-HIGH complexity, largest single pattern_

| Task                                             | LOC   | Source   | Priority |
| ------------------------------------------------ | ----- | -------- | -------- |
| Extract Work Queue                               | 1,087 | beauvoir | P0       |
| Extract Object Store Sync (interface + ref impl) | 210   | finn     | P2       |
| Extract Git Archival Sync                        | 235   | finn     | P2       |
| Write tests                                      | ~400  | new      | P0       |

---

## 8. Cross-Cutting Observations

### 8.1 Finn validates beauvoir's design

Finn's 3-tier persistence (WAL -> R2 -> Git) is the first production proof that the persistence architecture designed in beauvoir actually works end-to-end. The framework should document this validated pattern.

### 8.2 The "kayak vs container ship" insight

Finn proves a complete Loa agent can run in ~2,900 LOC. The framework should support both minimal and full deployments. The proposed module structure (separate packages per concern) enables this: a minimal agent imports `security/` + `bridge/`, a full deployment adds `scheduler/` + `sync/` + `memory/`.

### 8.3 Test infrastructure gap

Both repos use the "temporary package.json" pattern to run vitest tests. The upstream should ship a `run-lib-tests.sh` script that handles this automatically.

### 8.4 Import extension inconsistency

The beads library uses extensionless imports (`from "./validation"`), while the persistence library uses `.js` extensions (`from "./types.js"`). New modules should standardize on `.js` extensions (ESM-compatible).

### 8.5 Naming convention

- Framework code (`.claude/lib/`): Generic names (`WALManager`, `CircuitBreaker`)
- Container code (`deploy/`, `src/`): Prefixed names (`SegmentedWALManager`, `BeadsPersistenceService`)
- Extracted patterns drop their prefixes and become framework-grade

---

## Appendix A: Files Analyzed

### loa-beauvoir

- 14 merged PRs, 2 open PRs
- `deploy/loa-identity/`: 14,709 LOC across ~50 TypeScript files
- `.claude/lib/`: 8,945 LOC across 47 TypeScript files
- 338 tests across 14 test suites

### loa-finn

- 6 merged PRs, 1 open PR (convergence question)
- `src/`: 2,923 LOC across 23 TypeScript files
- 14 extraction candidate patterns identified

### loa (upstream)

- 87 merged PRs, 2 open PRs, 30+ open issues
- 987 total files, 160+ shell scripts
- `.claude/lib/beads/`: ~3,681 LOC
- `.claude/lib/persistence/`: ~3,330 LOC source + ~1,800 LOC tests
- Contributors: janitooor (75), zkSoju (6), ZERGUCCI (2), gumibera (1)

### Key Cross-Repo PRs

- **beauvoir PR #25**: Portable persistence framework (7 patterns, 56 tests)
- **beauvoir PR #205**: Isomorphic optimizations (WAL, batch queries, SEC-001 fix)
- **beauvoir PR #209**: MLP v0.2 (gap detection, lineage, classification)
- **upstream PR #220**: Persistence framework (extracted from beauvoir)
- **finn PR #7**: Upstream convergence question (WAL overlap)
