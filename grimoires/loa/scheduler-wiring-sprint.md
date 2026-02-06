# Sprint Plan: Wire BeadsWorkQueue to Beauvoir Scheduler

> **PRD**: `grimoires/loa/scheduler-wiring-prd.md`
> **SDD**: `grimoires/loa/scheduler-wiring-sdd.md`
> **Status**: COMPLETED
> **Estimated LOC**: ~120 (production) + ~80 (tests)

---

## Sprint Overview

Wire the fully-implemented BeadsWorkQueue and Scheduler subsystems together. Two wiring gaps prevent any scheduled task from ever firing: `scheduler.start()` is never called, and `registerWorkQueueTask()` is never called.

**Branch**: `feature/beads-bridge` (continues existing work)

## Task Dependency Graph

```
TASK-1.1 (refactor constructor)
    │
    ├── TASK-1.2 (register work queue)
    │       │
    │       ├── TASK-1.3 (start scheduler + fail-fast)
    │       │       │
    │       │       └── TASK-1.4 (return shutdown handle)
    │       │
    │       └── TASK-1.5b (tests for WorkQueue registration)
    │
    └── TASK-1.5 (tests for constructor refactor)

TASK-1.3 ──► TASK-1.6 (tests for init flow)
TASK-1.4 + TASK-1.6 ──► TASK-1.7 (tests for shutdown)
```

---

## Tasks

### TASK-1.1: Refactor BeadsPersistenceService constructor to options object

**File**: `deploy/loa-identity/beads/beads-persistence-service.ts`
**Priority**: P0 (blocking)
**Depends on**: None

Convert the constructor from positional args to an options object pattern:

```typescript
// Before: constructor(config, wal?, scheduler?)
// After:  constructor(config, opts?: { wal?, scheduler?, runStateManager? })
```

**Acceptance Criteria**:

- Constructor accepts `opts?: { wal?, scheduler?, runStateManager? }`
- Existing WAL setup uses `opts.wal` instead of positional `wal`
- Existing scheduler registration uses `opts.scheduler` instead of positional `scheduler`
- `createBeadsPersistenceService()` factory updated to match
- If `config.scheduler?.workQueue?.enabled === true` and `opts.runStateManager` is missing, throw with clear error message
- All existing tests still pass (update call sites in test files)

**Estimated LOC**: ~30

---

### TASK-1.2: Register WorkQueue in constructor

**File**: `deploy/loa-identity/beads/beads-persistence-service.ts`
**Priority**: P0 (blocking)
**Depends on**: TASK-1.1

After `registerBeadsSchedulerTasks()`, conditionally create `BeadsWorkQueue` and call `registerWorkQueueTask()`.

**Acceptance Criteria**:

- Import `BeadsWorkQueue`, `createBeadsWorkQueue`, `registerWorkQueueTask`
- Build single normalized `schedulerConfig` (includes `beadsDir`, `brCommand`)
- Pass same `schedulerConfig` to both `registerBeadsSchedulerTasks` and `registerWorkQueueTask`
- WorkQueue only created when `config.scheduler?.workQueue?.enabled` is true
- WorkQueue receives `runStateManager` from `opts` and `brCommand` from config
- Log message when work queue registers: `"[beads-persistence] Work queue registered"`

**Estimated LOC**: ~25

---

### TASK-1.3: Call scheduler.start() after initialize()

**File**: `deploy/loa-identity/index.ts`
**Priority**: P0 (blocking)
**Depends on**: TASK-1.2

Add `scheduler.start()` after successful `beadsPersistence.initialize()`, wrapped in try/catch for fail-fast.

**Acceptance Criteria**:

- `scheduler.start()` called only after `initialize()` resolves
- On `initialize()` rejection: `scheduler.stop()` called defensively inside its own try/catch (stop errors logged but do not mask original init error), then original error rethrown
- Log: `"[loa] Beads persistence initialized, scheduler started"`
- Create `runStateManager` via `createBeadsRunStateManager({ verbose: false })`
- Build normalized `schedulerConfig` with `workQueue.enabled` defaulting to `false`
- Pass `{ wal: walManager, scheduler, runStateManager }` opts to factory

```typescript
// Fail-fast pattern:
try {
  await beadsPersistence.initialize();
  scheduler.start();
} catch (err) {
  try {
    scheduler.stop();
  } catch (stopErr) {
    console.error("[loa] Defensive scheduler.stop() failed:", stopErr);
  }
  throw err; // Always rethrow original error
}
```

**Estimated LOC**: ~25

---

### TASK-1.4: Return shutdown handle from init

**File**: `deploy/loa-identity/index.ts`
**Priority**: P1
**Depends on**: TASK-1.3

Return an idempotent `shutdown()` function instead of registering global signal handlers.

**Acceptance Criteria**:

- `shutdown()` function returned in init result object
- `shutdown()` calls `scheduler.stop()` exactly once (guarded by `stopped` flag)
- No `process.on("SIGTERM")` or `process.on("SIGINT")` inside init
- Comment documents that caller is responsible for signal registration

**Estimated LOC**: ~10

---

### TASK-1.5: Tests for constructor refactor (options object only)

**File**: `deploy/loa-identity/beads/__tests__/beads-persistence-service.test.ts`
**Priority**: P0 (blocking)
**Depends on**: TASK-1.1

**Scope**: Only tests for the constructor refactor from TASK-1.1. Does NOT test WorkQueue registration (that is TASK-1.5b).

**Acceptance Criteria**:

- Test: constructor accepts options object (wal, scheduler, runStateManager)
- Test: backward-compatible — works with no opts (all optional)
- Test: throws when `workQueue.enabled=true` but `runStateManager` missing
- Test: does NOT throw when `workQueue.enabled=false` and `runStateManager` missing
- Update existing test call sites from positional args to options object

**Estimated LOC**: ~25

---

### TASK-1.5b: Tests for WorkQueue registration

**File**: `deploy/loa-identity/beads/__tests__/beads-persistence-service.test.ts`
**Priority**: P1
**Depends on**: TASK-1.2

**Test seam**: Use `vi.mock()` on `"../beads-work-queue.js"` and `"../beads-scheduler-tasks.js"` to spy on `createBeadsWorkQueue` and `registerWorkQueueTask` calls during construction.

**Acceptance Criteria**:

- Test: `registerWorkQueueTask` called when `workQueue.enabled=true` + runStateManager present
- Test: `registerWorkQueueTask` NOT called when `workQueue.enabled=false`
- Test: same `schedulerConfig` object (with beadsDir, brCommand) passed to both `registerBeadsSchedulerTasks` and `registerWorkQueueTask`

**Estimated LOC**: ~20

---

### TASK-1.6: Tests for init flow (start + fail-fast)

**File**: `deploy/loa-identity/beads/__tests__/index.test.ts` (new)
**Priority**: P1
**Depends on**: TASK-1.3

**Test seam**: Mock the `"./beads/index.js"` dynamic import to provide spied `createBeadsPersistenceService` and `createBeadsRunStateManager` factories. Use a mock `Scheduler` with spied `start()` and `stop()` methods.

**Acceptance Criteria**:

- Test: `scheduler.start()` called after `initialize()` resolves successfully
- Test: `scheduler.start()` NOT called when `initialize()` rejects
- Test: on init failure, `scheduler.stop()` called defensively (wrapped in try/catch so stop errors don't mask original error)
- Test: original `initialize()` error is rethrown even if `scheduler.stop()` also throws
- WorkQueue registration assertions are covered in TASK-1.5b (not here — registration happens during construction, not during init)

**Estimated LOC**: ~30

---

### TASK-1.7: Tests for shutdown handle

**File**: `deploy/loa-identity/beads/__tests__/index.test.ts`
**Priority**: P1
**Depends on**: TASK-1.4, TASK-1.6

**Acceptance Criteria**:

- Test: `shutdown()` calls `scheduler.stop()` exactly once
- Test: double `shutdown()` call is safe — `scheduler.stop()` called only once (idempotent via `stopped` guard)
- Test: `shutdown()` does not throw even if `scheduler.stop()` throws

**Estimated LOC**: ~15

---

## Execution Order

1. TASK-1.1 (constructor refactor) — foundation
2. TASK-1.5 (tests for constructor) — validate foundation (constructor-only, no WorkQueue)
3. TASK-1.2 (register work queue) — core wiring
4. TASK-1.5b (tests for WorkQueue registration) — validate wiring via vi.mock spies
5. TASK-1.3 (scheduler start + fail-fast) — activate everything
6. TASK-1.4 (shutdown handle) — cleanup
7. TASK-1.6 (init flow tests) — validate start/fail-fast
8. TASK-1.7 (shutdown tests) — validate cleanup

## Gate Checks

After all tasks complete:

- [x] `pnpm build` passes (type-check) — no new errors in modified files
- [x] `pnpm test` passes (all existing + new tests) — 155 pass, 0 regressions
- [x] No new lint warnings from `pnpm check`

## Risk Notes

- **Constructor refactor touches existing call sites**: All callers of `createBeadsPersistenceService()` must be updated. There is exactly 1 caller in `index.ts` (line 169) and test files.
- **Existing `beads-persistence-service.test.ts` call sites**: Must update from positional args to options object. These are the only changes needed in existing test files.

---

_Generated by Loa Framework_
