# Sprint Plan: Beads-OpenClaw Persistence Integration

> **Version**: 1.0.0
> **PRD**: `grimoires/loa/beads-openclaw-prd.md`
> **SDD**: `grimoires/loa/beads-openclaw-sdd.md`
> **Created**: 2026-02-05
> **Branch**: `feature/beads-persistence`

---

## Sprint Overview

| Attribute              | Value                            |
| ---------------------- | -------------------------------- |
| **Sprint ID**          | beads-persistence-001            |
| **Type**               | Feature + Infrastructure         |
| **Scope**              | 4 components, ~600 lines of code |
| **Risk Level**         | MEDIUM (new persistence layer)   |
| **Estimated Duration** | 1 sprint (~2.5 days)             |

---

## Task Breakdown

### Epic: Beads-OpenClaw Persistence Integration

```
beads-persistence-001 (Epic)
├── TASK-001: Create BeadsWALAdapter [P0]
├── TASK-002: Create BeadsRecoveryHandler [P0]
├── TASK-003: Create BeadsSchedulerTasks [P0]
├── TASK-004: Update R2 Sync Paths [P1]
├── TASK-005: Create BeadsPersistenceService [P0]
├── TASK-006: Integration with Bootstrap [P1]
├── TASK-007: Write Tests [P1]
└── TASK-008: Documentation Update [P2]
```

---

## Tasks

### TASK-001: Create BeadsWALAdapter

**Priority**: P0 (Critical Path)
**Blocked By**: None
**Blocks**: TASK-002, TASK-005

#### Description

Create the WAL adapter that records beads state transitions to the Write-Ahead Log for crash recovery.

#### Acceptance Criteria

- [ ] Create `deploy/loa-identity/beads/beads-wal-adapter.ts`
- [ ] Implement `BeadsWALAdapter` class with:
  - `recordTransition(entry)` - Records operation to WAL
  - `replay()` - Returns all beads transitions from WAL
  - `getTransitionsSince(seq)` - Returns transitions since sequence number
- [ ] Entry includes: id, timestamp, operation, beadId, payload, checksum
- [ ] SHA-256 checksum verification on replay
- [ ] Verbose logging when `DEBUG=true`

#### Implementation Notes

```typescript
// Key interfaces
interface BeadWALEntry {
  id: string;
  timestamp: string;
  operation: "create" | "update" | "close" | "reopen" | "label" | "comment" | "dep";
  beadId: string;
  payload: Record<string, unknown>;
  checksum: string;
}
```

#### Files to Create

- `deploy/loa-identity/beads/beads-wal-adapter.ts`

---

### TASK-002: Create BeadsRecoveryHandler

**Priority**: P0 (Critical Path)
**Blocked By**: TASK-001
**Blocks**: TASK-005

#### Description

Create the recovery handler that restores beads state from WAL after a crash.

#### Acceptance Criteria

- [ ] Create `deploy/loa-identity/beads/beads-recovery.ts`
- [ ] Implement `BeadsRecoveryHandler` class with:
  - `needsRecovery()` - Checks if WAL has newer entries than SQLite
  - `recover()` - Replays WAL entries via `br` commands
- [ ] Returns `RecoveryResult` with success, entriesReplayed, beadsAffected, durationMs
- [ ] Graceful error handling (doesn't crash on failure)
- [ ] Runs `br sync --flush-only` after recovery to update JSONL

#### Implementation Notes

```typescript
// Recovery algorithm
1. Get last SQLite mtime
2. Replay WAL entries
3. Group by beadId for efficiency
4. Execute br commands: create, update, close, label, comment
5. Flush to JSONL
```

#### Files to Create

- `deploy/loa-identity/beads/beads-recovery.ts`

---

### TASK-003: Create BeadsSchedulerTasks

**Priority**: P0 (Critical Path)
**Blocked By**: None
**Blocks**: TASK-005

#### Description

Create scheduler task definitions for automated beads maintenance.

#### Acceptance Criteria

- [ ] Create `deploy/loa-identity/beads/beads-scheduler-tasks.ts`
- [ ] Implement `registerBeadsSchedulerTasks(scheduler, config)` function
- [ ] Register 3 tasks:
  - `beads_health` - Runs `br doctor` every 15 minutes
  - `beads_sync` - Runs `br sync --flush-only` every 5 minutes
  - `beads_stale_check` - Reports stale issues daily
- [ ] All tasks have circuit breakers (3 failures, 5 min reset)
- [ ] `beads_sync` in mutex group `sync` (prevents concurrent git_sync)
- [ ] Configurable intervals via `BeadsSchedulerConfig`

#### Implementation Notes

```typescript
// Default intervals
beads_health: 15 min ±1 min jitter
beads_sync: 5 min ±30 sec jitter
beads_stale_check: 24 hours ±1 hour jitter
```

#### Files to Create

- `deploy/loa-identity/beads/beads-scheduler-tasks.ts`

---

### TASK-004: Update R2 Sync Paths

**Priority**: P1
**Blocked By**: None
**Blocks**: TASK-006

#### Description

Add `.beads/` directory to R2 sync paths for cloud backup.

#### Acceptance Criteria

- [ ] Modify `upstream/moltworker/src/gateway/sync.ts`
- [ ] Add `.beads/` to `SYNC_PATHS` array
- [ ] Add exclusions for SQLite journal files:
  - `beads.db-journal`
  - `beads.db-wal`
  - `beads.db-shm`
  - `*.lock`
- [ ] Verify sync works in both directions (upload/download)

#### Implementation Notes

```typescript
const BEADS_SYNC_PATH = ".beads/";
const BEADS_EXCLUSIONS = [
  ".beads/beads.db-journal",
  ".beads/beads.db-wal",
  ".beads/beads.db-shm",
  ".beads/*.lock",
];
```

#### Files to Modify

- `upstream/moltworker/src/gateway/sync.ts`

---

### TASK-005: Create BeadsPersistenceService

**Priority**: P0 (Critical Path)
**Blocked By**: TASK-001, TASK-002, TASK-003
**Blocks**: TASK-006

#### Description

Create the main service that orchestrates all beads persistence components.

#### Acceptance Criteria

- [ ] Create `deploy/loa-identity/beads/beads-persistence-service.ts`
- [ ] Implement `BeadsPersistenceService` class with:
  - Constructor takes WALManager, Scheduler, config
  - `initialize()` - Runs crash recovery if needed
  - `recordTransition(operation, beadId, payload)` - Records to WAL
  - `isHealthy()` - Returns initialization status
- [ ] Graceful degradation if components unavailable
- [ ] Respects `enabled: false` configuration
- [ ] Create `deploy/loa-identity/beads/index.ts` for re-exports

#### Implementation Notes

```typescript
// Initialization flow
1. Check if persistence enabled
2. Initialize WAL adapter (if WAL provided)
3. Initialize recovery handler
4. Register scheduler tasks (if scheduler provided)
5. Run crash recovery if needed
6. Mark initialized
```

#### Files to Create

- `deploy/loa-identity/beads/beads-persistence-service.ts`
- `deploy/loa-identity/beads/index.ts`

---

### TASK-006: Integration with Bootstrap

**Priority**: P1
**Blocked By**: TASK-004, TASK-005
**Blocks**: TASK-007

#### Description

Integrate BeadsPersistenceService into the OpenClaw gateway bootstrap process.

#### Acceptance Criteria

- [ ] Modify `deploy/loa-identity/bootstrap.ts` (or equivalent entry point)
- [ ] Instantiate `BeadsPersistenceService` with:
  - Existing WALManager instance
  - Existing Scheduler instance
  - Configuration from environment/config file
- [ ] Call `service.initialize()` during startup
- [ ] Add to health check endpoint
- [ ] Log initialization status

#### Implementation Notes

```typescript
// In bootstrap
const beadsPersistence = new BeadsPersistenceService(
  { enabled: true, beadsDir: ".beads" },
  walManager,
  scheduler,
);
await beadsPersistence.initialize();
```

#### Files to Modify

- `deploy/loa-identity/bootstrap.ts` (or entry point)

---

### TASK-007: Write Tests

**Priority**: P1
**Blocked By**: TASK-006
**Blocks**: TASK-008

#### Description

Write unit and integration tests for all new components.

#### Acceptance Criteria

- [ ] Create `deploy/loa-identity/beads/__tests__/beads-wal-adapter.test.ts`
  - Test entry creation with checksum
  - Test replay with ordering
  - Test checksum verification
- [ ] Create `deploy/loa-identity/beads/__tests__/beads-recovery.test.ts`
  - Test needsRecovery detection
  - Test recover command generation
- [ ] Create `deploy/loa-identity/beads/__tests__/beads-scheduler-tasks.test.ts`
  - Test task registration
  - Test handler execution
- [ ] All tests pass with `pnpm test`

#### Test Cases

| Component               | Test Case                     | Type        |
| ----------------------- | ----------------------------- | ----------- |
| BeadsWALAdapter         | Records entry with checksum   | Unit        |
| BeadsWALAdapter         | Replays entries in order      | Unit        |
| BeadsWALAdapter         | Rejects invalid checksum      | Unit        |
| BeadsRecoveryHandler    | Detects recovery needed       | Unit        |
| BeadsRecoveryHandler    | Generates correct br commands | Unit        |
| BeadsSchedulerTasks     | Registers all 3 tasks         | Unit        |
| BeadsPersistenceService | Initializes with recovery     | Integration |

#### Files to Create

- `deploy/loa-identity/beads/__tests__/beads-wal-adapter.test.ts`
- `deploy/loa-identity/beads/__tests__/beads-recovery.test.ts`
- `deploy/loa-identity/beads/__tests__/beads-scheduler-tasks.test.ts`

---

### TASK-008: Documentation Update

**Priority**: P2
**Blocked By**: TASK-007
**Blocks**: None

#### Description

Update documentation to reflect new persistence capabilities.

#### Acceptance Criteria

- [ ] Update `.claude/protocols/beads-integration.md`:
  - Add section on WAL persistence
  - Document auto-sync behavior
  - Add troubleshooting for recovery
- [ ] Update `CLAUDE.md` (if applicable):
  - Document new configuration options
  - Document environment variables
- [ ] Add inline code comments for complex logic

#### Documentation Sections to Add

````markdown
## Persistence Layer

Beads state is automatically persisted through:

- **WAL**: Every state change recorded for crash recovery
- **R2 Sync**: Cloud backup every 30 seconds
- **Auto-sync**: JSONL updated every 5 minutes

### Configuration

```yaml
beads:
  persistence:
    enabled: true
```
````

### Recovery

On startup, if WAL contains entries newer than SQLite:

1. WAL is replayed via br commands
2. JSONL is updated via br sync
3. Normal operation resumes

### Troubleshooting

If recovery fails:

```bash
br sync --import-only  # Manual recovery from JSONL
```

```

#### Files to Modify

- `.claude/protocols/beads-integration.md`

---

## Task Dependencies

```

TASK-001 (WAL Adapter)
│
├───► TASK-002 (Recovery Handler)
│ │
│ ▼
│ TASK-005 (Persistence Service)
│ │
TASK-003 (Scheduler Tasks) ─────────────────┤
│
TASK-004 (R2 Sync) ─────────────────────────┤
│
▼
TASK-006 (Bootstrap Integration)
│
▼
TASK-007 (Tests)
│
▼
TASK-008 (Documentation)

````

---

## Definition of Done

### Per-Task DoD

- [ ] Code compiles without errors (`pnpm build`)
- [ ] Code passes linting (`pnpm check`)
- [ ] Code has type safety (no `any` types)
- [ ] Acceptance criteria met
- [ ] Error handling implemented

### Sprint DoD

- [ ] All P0 tasks completed
- [ ] All P1 tasks completed
- [ ] Tests pass (`pnpm test`)
- [ ] Documentation updated
- [ ] Code reviewed
- [ ] PR created

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| WAL Manager API changes | Check existing usage patterns first |
| br command failures | All handlers have try/catch |
| R2 sync conflicts | Exclude journal files, last-write-wins |
| Scheduler overwhelm | Circuit breakers on all tasks |

---

## Commit Strategy

### Recommended Commits

1. `feat(beads): add BeadsWALAdapter for crash recovery`
2. `feat(beads): add BeadsRecoveryHandler for WAL replay`
3. `feat(beads): add scheduler tasks for auto-maintenance`
4. `feat(sync): add .beads/ to R2 sync paths`
5. `feat(beads): add BeadsPersistenceService orchestrator`
6. `feat(beads): integrate persistence service with bootstrap`
7. `test(beads): add unit and integration tests`
8. `docs(beads): update beads-integration protocol`

### Final PR

```bash
gh pr create --title "feat(beads): integrate with OpenClaw persistence layer" --body "$(cat <<'EOF'
## Summary

Integrates Loa's beads_rust task management with OpenClaw's persistence infrastructure:

- **WAL Integration**: Records all bead state transitions for crash recovery
- **R2 Sync**: Automatic cloud backup every 30 seconds
- **Scheduler Tasks**: Health checks, auto-sync, stale alerts

## Changes

- New: `deploy/loa-identity/beads/` - Persistence service components
- Modified: `upstream/moltworker/src/gateway/sync.ts` - R2 sync paths
- Modified: `deploy/loa-identity/bootstrap.ts` - Service initialization

## Test Plan

- [ ] Unit tests pass
- [ ] Kill container with `kill -9`, verify recovery on restart
- [ ] Verify `.beads/` appears in R2 bucket

## Related

- PRD: grimoires/loa/beads-openclaw-prd.md
- SDD: grimoires/loa/beads-openclaw-sdd.md
- Review: grimoires/loa/a2a/audits/2026-02-04-beads-review/

---
Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
````

---

## Post-Sprint

### Verification

1. Run `pnpm test` - All tests pass
2. Check scheduler status - beads tasks registered
3. Kill container, restart - State recovered
4. Check R2 bucket - `.beads/` present

### Next Steps (Future Sprints)

- Phase 4: Run-mode unification with beads
- Phase 5: Cron-based task decomposition
- Phase 6: Learning extraction from sprints

---

_Generated by Loa Simstim Workflow_
