# Loa-Finn Persistence Port Tracker

> Issue: [#24 - Port loa-finn persistence patterns](https://github.com/0xHoneyJar/loa-beauvoir/issues/24)
> Source: [loa-finn PR #5](https://github.com/0xHoneyJar/loa-finn/pull/5) | [Issue #6](https://github.com/0xHoneyJar/loa-finn/issues/6)
> Branch: `feature/port-loa-finn-persistence`

## Summary

Port 7 novel persistence patterns from loa-finn (Cloudflare Workers runtime) to
loa-beauvoir (upstream framework). These patterns have no equivalent in OpenClaw
or other agent runtimes and represent core infrastructure for crash-resilient
agent state management.

## Pattern Status

| #   | Pattern                                    | Status  | Sub-PR | Notes                   |
| --- | ------------------------------------------ | ------- | ------ | ----------------------- |
| 1   | Write-Ahead Log (WAL) with Monotonic ULIDs | Pending | -      | See existing code below |
| 2   | R2 Two-Phase Checkpoint Protocol           | Pending | -      | See existing code below |
| 3   | Recovery Cascade                           | Pending | -      | See existing code below |
| 4   | Compound Learning Cycle                    | Pending | -      | See existing code below |
| 5   | Beads Bridge                               | Pending | -      | See existing code below |
| 6   | Circuit Breaker Scheduler                  | Pending | -      | See existing code below |
| 7   | Identity Hot-Reload                        | Pending | -      | See existing code below |

## What Already Exists in loa-beauvoir

### 1. Write-Ahead Log (WAL)

**Location**: `deploy/loa-identity/wal-manager.ts`, `deploy/loa-identity/wal/wal-manager.ts`

- Top-level `wal-manager.ts` (16KB): Full WAL implementation with R2 sync, git sync, seq-based entries
- `wal/wal-manager.ts` (19KB): Segmented WAL manager variant
- Uses `crypto.randomUUID()` for IDs (NOT monotonic ULIDs yet)
- Has WAL replay, checkpoint, and compaction logic
- Tests: `wal-manager.test.ts` (8.8KB)

**Port work needed**: Migrate to monotonic ULID generation, ensure delta-record
compaction is O(1) amortized (PR #205 already contributed this to `.claude/lib/beads/`)

### 2. R2 Two-Phase Checkpoint Protocol

**Location**: `deploy/loa-identity/recovery/r2-client.ts` (6.8KB)

- Mount-only R2 access (no direct API -- security decision)
- SHA-256 verification for file integrity
- Backup/restore operations implemented
- No explicit two-phase commit protocol visible yet

**Port work needed**: Add two-phase commit (write-intent + finalize), manifest
versioning, and rollback on partial failure

### 3. Recovery Cascade

**Location**: `deploy/loa-identity/recovery/recovery-engine.ts` (18.8KB)

- Full state machine: START -> CHECK_INTEGRITY -> RESTORE_R2 -> RESTORE_GIT -> RESTORE_TEMPLATE -> VERIFY -> RUNNING/DEGRADED
- Ed25519 signature verification + SHA-256 checksums
- Loop detection with configurable thresholds
- Degraded mode operation
- Git client (`git-client.ts`, 7.2KB) and R2 client for multi-source fallback

**Port work needed**: This is fairly complete. May need adaptation for
framework-agnostic use (currently coupled to loa-identity container)

### 4. Compound Learning Cycle

**Location**: `deploy/loa-identity/learning-store.ts` (11.4KB)

- CRUD for compound learnings with persistence to grimoires
- Quality gates scoring via `quality-gates.ts` (8.9KB)
- WAL integration for crash-safe writes
- Storage: `grimoires/loa/a2a/compound/learnings.json`

**Port work needed**: Decouple from container-specific paths, make storage
backend pluggable (file vs KV vs R2)

### 5. Beads Bridge

**Location**: `deploy/loa-identity/beads/` (6 files)

- `beads-wal-adapter.ts`: Records beads state transitions to WAL
- `beads-recovery.ts`: Crash recovery for beads state
- `beads-persistence-service.ts`: Orchestrates all beads persistence
- `beads-scheduler-tasks.ts`: Scheduled maintenance tasks
- `beads-run-state.ts`: Run state management
- `beads-work-queue.ts`: Work queue with persistence

**Port work needed**: Already well-structured. Main work is extracting from
`deploy/loa-identity/` into `.claude/lib/beads/` for upstream consumption.
Upstream beads validation from `.claude/lib/beads/` is already imported.

### 6. Circuit Breaker Scheduler

**Location**: `deploy/loa-identity/scheduler/scheduler.ts` (9.7KB)

- Full scheduler with jitter, circuit breakers, and mutual exclusion
- Circuit breaker states: closed/open/half-open
- Configurable max failures, reset time, half-open retries
- Additional modules: `bloat-auditor.ts`, `mece-validator.ts`, `meta-monitor.ts`,
  `notification-sink.ts`, `timeout-enforcer.ts`

**Port work needed**: Extract circuit breaker as standalone utility. Currently
tightly coupled to the scheduler -- needs separation for use in WAL sync,
R2 checkpoints, etc.

### 7. Identity Hot-Reload

**Location**: `deploy/loa-identity/identity-loader.ts` (9.5KB)

- Parses BEAUVOIR.md identity document
- Tracks NOTES.md changes
- Checksum-based change detection
- Loads principles, boundaries, interaction style

**Also relevant**: `src/gateway/config-reload.ts`, `src/gateway/server-reload-handlers.ts`
(existing hot-reload infrastructure in the gateway)

**Port work needed**: Add filesystem watching (fsnotify/chokidar), debounced
reload, and health check integration. Bridge to existing gateway reload patterns.

## Architecture Considerations

1. **Portability**: loa-finn code is container-specific (Cloudflare Workers + Docker).
   Port needs to work in both container and local-dev contexts.
2. **No native bindings**: `better-sqlite3` not viable (breaks portability).
   Stick with file-based persistence.
3. **Upstream compatibility**: Ported code should live in `.claude/lib/` for
   framework consumption, with deploy-specific wrappers in `deploy/`.
4. **Test coverage**: loa-finn has 27 tests. Target matching coverage plus
   additional edge cases for the framework context.

## Dependencies Between Patterns

```
WAL (1) <-- R2 Checkpoint (2) <-- Recovery Cascade (3)
  ^                                    ^
  +--- Beads Bridge (5) ---------------+
                                       ^
Circuit Breaker (6) <-- Scheduler -----+

Compound Learning (4) <-- WAL (1)
Identity Hot-Reload (7) <-- independent (uses checksum-based detection)
```

**Suggested implementation order**:

1. Circuit Breaker (standalone utility, no deps)
2. WAL with ULIDs (core infrastructure)
3. R2 Two-Phase Checkpoint (depends on WAL)
4. Recovery Cascade (depends on R2 + WAL)
5. Beads Bridge (depends on WAL + Recovery)
6. Compound Learning Cycle (depends on WAL)
7. Identity Hot-Reload (independent, can parallel with 3-6)
