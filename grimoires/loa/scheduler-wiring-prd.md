# PRD: Wire BeadsWorkQueue to Beauvoir Scheduler

> **Status**: Draft
> **Created**: 2026-02-06
> **Author**: Claude Opus 4.6 + Human Operator
> **Target**: `deploy/loa-identity/` (Identity host only)
> **Depends on**: PR #20 (BeadsWorkQueue), PR #27 (beads-bridge)

---

## Problem Statement

The BeadsWorkQueue is **fully implemented and tested** (PR #20, 23 tests pass) but **never executes at runtime** because of two wiring gaps in the initialization flow:

1. **`registerWorkQueueTask()` is never called.** The `BeadsPersistenceService` constructor calls `registerBeadsSchedulerTasks()` (which registers health check, auto-sync, and stale check) but does NOT call `registerWorkQueueTask()`. The function is exported but dead code.

2. **`scheduler.start()` is never called.** In `deploy/loa-identity/index.ts`, the scheduler is created, passed to `BeadsPersistenceService`, tasks are registered, but `scheduler.start()` is never invoked. The scheduler has a `running` guard (`scheduleTask()` returns early if `!this.running`), so all registered tasks — including the maintenance tasks that ARE registered — never fire.

**Impact**: The entire beads scheduling subsystem (health checks, auto-sync, stale checks, AND the work queue) is inert. No periodic task has ever run.

## Root Cause Analysis

```
deploy/loa-identity/index.ts (lines 147-182):
  1. createBeauvoirScheduler()                    -- creates Scheduler, running=false
  2. createBeadsPersistenceService(..., scheduler) -- passes scheduler to constructor
  3. constructor calls registerBeadsSchedulerTasks()  -- registers 3 maintenance tasks
  4. constructor does NOT call registerWorkQueueTask() -- work queue stays dead
  5. await beadsPersistence.initialize()           -- crash recovery only
  6. return { scheduler, ... }                     -- scheduler.start() NEVER called
                                                      running stays false
                                                      scheduleTask() returns early
                                                      nothing ever fires
```

## Goals

| ID      | Description                                         | Success Metric                                                                      |
| ------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **G-1** | All registered scheduler tasks fire on schedule     | Scheduler logs show task executions within `intervalMs +/- jitterMs`                |
| **G-2** | Work queue processes ready beads autonomously       | Tasks with `ready` label get claimed, dispatched to agent sessions, and completed   |
| **G-3** | Circuit breaker protects against cascading failures | After `maxFailures` (3) consecutive failures, task pauses for `resetTimeMs` (30min) |
| **G-4** | Config-driven enablement                            | `workQueue.enabled` toggleable without code changes                                 |
| **G-5** | Portable design                                     | loa-finn can adopt the same wiring pattern with minimal changes                     |

## Non-Goals

- Modifying BeadsWorkQueue internals (already tested and working)
- Modifying Scheduler internals (already tested and working)
- Adding new scheduler tasks beyond the work queue
- Modifying the beads-bridge (Phase 1 MVP, already merged)
- Cross-host scheduling (identity host only)

## Scope of Changes

### Change 1: Call `scheduler.start()` after initialization

**File**: `deploy/loa-identity/index.ts`
**Lines**: After line 179 (`console.log("[loa] Beads persistence initialized")`)

Start the scheduler **only after** all tasks are registered and `initialize()` resolves successfully. This unblocks ALL scheduler tasks (health, sync, stale, and work queue when enabled).

```typescript
// Start scheduler only after successful initialization
await beadsPersistence.initialize();
scheduler.start();
console.log("[loa] Scheduler started");
```

**Init failure handling (fail-fast)**: If `initialize()` rejects, `scheduler.start()` must NOT be called. The caller should call `scheduler.stop()` defensively (safe even if never started — `stop()` just clears any timers and sets `running = false`) before rethrowing/exiting. This prevents tasks from running against an uninitialized persistence layer.

```typescript
try {
  await beadsPersistence.initialize();
  scheduler.start();
  console.log("[loa] Scheduler started");
} catch (err) {
  scheduler.stop(); // Defensive: clear any timers, prevent leaks
  throw err; // Fail-fast: caller handles exit
}
```

Also ensure `scheduler.stop()` is called on graceful shutdown (`SIGTERM`/`SIGINT`) to clean up `setTimeout` handles and prevent orphaned timers.

### Change 2: Register WorkQueue task in BeadsPersistenceService

**File**: `deploy/loa-identity/beads/beads-persistence-service.ts`
**Lines**: Constructor, after `registerBeadsSchedulerTasks()` (line 118)

Create a `BeadsWorkQueue` instance and call `registerWorkQueueTask()`:

```typescript
if (scheduler) {
  const schedulerConfig = {
    ...config.scheduler,
    beadsDir: config.beadsDir,
    brCommand: config.brCommand,
  };

  registerBeadsSchedulerTasks(scheduler, schedulerConfig);

  // Register work queue task (Phase 5 — cron-driven dispatch)
  // config.scheduler is BeadsSchedulerConfig which contains workQueue?: { enabled?, intervalMs?, ... }
  // registerWorkQueueTask reads config.scheduler.workQueue.enabled internally
  if (config.scheduler?.workQueue?.enabled) {
    const workQueue = new BeadsWorkQueue(/* WorkQueueConfig from config.scheduler.workQueue */);
    registerWorkQueueTask(scheduler, workQueue, config.scheduler);
  }
}
```

**Config type chain** (authoritative path):

1. External: `beadsConfig.scheduler.workQueue.enabled` (passed via `createDefaultBeadsConfig()`)
2. Internal: `BeadsPersistenceConfig.scheduler` → `BeadsSchedulerConfig.workQueue` → `{ enabled?, intervalMs?, ... }`
3. `registerWorkQueueTask(scheduler, workQueue, config.scheduler)` reads `config.scheduler.workQueue.enabled` via `mergeConfig(DEFAULT_CONFIG, config)` internally

This requires:

- Importing `BeadsWorkQueue` and `registerWorkQueueTask` from their respective modules
- The enable check reads `config.scheduler?.workQueue?.enabled` — the same nested path used by `registerWorkQueueTask` internally

### Change 3: Enable work queue in config

**File**: `deploy/loa-identity/beads/beads-scheduler-tasks.ts`
**Line**: `DEFAULT_CONFIG.workQueue.enabled` (currently `false`)

Keep the default as `false` (safe default). Enable via the `scheduler.workQueue` path in `createDefaultBeadsConfig()`:

```typescript
// index.ts — canonical config path: beadsConfig.scheduler.workQueue.enabled
beadsPersistence = createBeadsPersistenceService(
  createDefaultBeadsConfig({
    enabled: beadsConfig?.enabled ?? true,
    beadsDir: beadsConfig?.beadsDir ?? ".beads",
    scheduler: {
      ...beadsConfig?.scheduler,
      workQueue: {
        enabled: beadsConfig?.scheduler?.workQueue?.enabled ?? false,
        ...beadsConfig?.scheduler?.workQueue,
      },
    },
  }),
  walManager,
  scheduler,
);
```

**Config path consistency**: The external config, internal `BeadsPersistenceConfig.scheduler.workQueue.enabled`, and `registerWorkQueueTask`'s internal `mergeConfig()` all read the same nested path: `scheduler.workQueue.enabled`. There is no top-level `beadsConfig.workQueue` shorthand — the canonical path is always `scheduler.workQueue.enabled`.

### Change 4: Graceful shutdown

**File**: `deploy/loa-identity/index.ts`

Return `scheduler` in the init result (already done) and ensure callers invoke `scheduler.stop()` on `SIGTERM`/`SIGINT`. This clears `setTimeout` handles and prevents orphaned timers.

## Configuration

All config flows through the existing `BeadsPersistenceConfig.scheduler` path:

```typescript
{
  scheduler: {
    healthCheck: { enabled: true, intervalMs: 900_000 },   // 15 min (existing)
    autoSync:    { enabled: true, intervalMs: 300_000 },   // 5 min (existing)
    staleCheck:  { enabled: true, intervalMs: 86_400_000 }, // 24h (existing)
    workQueue: {
      enabled: true,             // NEW: flip to true
      intervalMs: 300_000,       // 5 min check cycle
      jitterMs: 30_000,          // +/- 30s
      sessionTimeoutMs: 1_800_000, // 30 min session window
    },
  },
}
```

Operator enables the work queue by passing `workQueue.enabled: true` in the beads config. Environment variable override (`BEADS_WORK_QUEUE=1`) is a nice-to-have but not required for MVP.

## Handler Chain (existing, just needs wiring)

```
scheduler fires beads_work_queue task every 5 min (+/- 30s jitter)
  |
  v
BeadsWorkQueue.createHandler()
  |
  +-- Check run state (must be RUNNING)
  +-- claimNextTask() -- finds ready beads, claims via label
  +-- triggerAgentSession() -- spawns bounded agent session
  |
  v
Agent session runs for up to 30 min
  |
  v
Circuit breaker: 3 consecutive failures -> 30 min cooldown
```

## Risks & Mitigations

| Risk                                                              | Impact                                               | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting scheduler fires maintenance tasks unexpectedly           | Low — health check, sync, stale check are idempotent | **Verified from source** (`deploy/loa-identity/scheduler/scheduler.ts` lines 106-145): `start()` iterates `this.tasks` and calls `scheduleTask(task)` for each. `scheduleTask()` computes `const jitter = Math.floor(Math.random() * task.jitterMs * 2) - task.jitterMs; const delay = Math.max(1000, task.intervalMs + jitter);` then calls `setTimeout(() => this.executeTask(task.id), delay)`. The `Math.max(1000, ...)` floor guarantees a minimum 1-second delay. For a 5-min/30s-jitter task, first execution is ~4.5-5.5 minutes after `start()`. No task handler is ever invoked synchronously within `start()`. **However**, even if this implementation changed, all task handlers are required to be idempotent and safe to run at any time after `initialize()` succeeds (which is guaranteed by the ordering in Change 1). |
| Work queue claims task but agent session fails repeatedly         | Medium                                               | Circuit breaker (3 failures -> 30 min pause) already built into WorkQueue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scheduler.start()` called before all tasks registered            | Low                                                  | Start is called AFTER `registerBeadsSchedulerTasks()` + `registerWorkQueueTask()` in constructor, AFTER `initialize()` succeeds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Multiple scheduler instances (if index.ts called twice)           | Low                                                  | `scheduler.start()` is idempotent (checks `if (this.running) return`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `initialize()` fails (corrupt WAL, permissions, missing beadsDir) | Medium                                               | **Fail-fast**: `scheduler.start()` is only called after `initialize()` resolves successfully. If `initialize()` rejects, the scheduler is never started and `scheduler.stop()` is called defensively before rethrowing. No timers leak. See Change 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Estimated Changes

| File                                                     | Change                                                            | LOC     |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| `deploy/loa-identity/index.ts`                           | Add `scheduler.start()` + shutdown hook + config pass-through     | ~15     |
| `deploy/loa-identity/beads/beads-persistence-service.ts` | Create WorkQueue + call `registerWorkQueueTask()`                 | ~15     |
| `deploy/loa-identity/beads/beads-persistence-service.ts` | Import statements                                                 | ~3      |
| Tests (new)                                              | Verify scheduler starts, work queue registers, shutdown cleans up | ~60     |
| **Total**                                                |                                                                   | **~93** |

## Test Plan

All existing tests must pass without modification. New tests are added alongside existing ones.

1. **Unit (new)**: Scheduler starts after initialization, `running === true`
2. **Unit (new)**: WorkQueue registers when `config.scheduler.workQueue.enabled === true`
3. **Unit (new)**: WorkQueue does NOT register when `enabled === false` (default)
4. **Unit (new)**: `scheduler.stop()` clears all timers
5. **Unit (new)**: `scheduler.start()` is NOT called when `initialize()` rejects
6. **Integration (new)**: Full init flow with work queue enabled → scheduler has `beads_work_queue` task registered
7. **Existing (unchanged)**: All 23 WorkQueue tests + all scheduler tests continue to pass (no behavioral changes to those modules)

## Portability Notes (loa-finn)

The wiring pattern is intentionally generic:

- `Scheduler` accepts any `{ id, handler, intervalMs }` registration
- `BeadsWorkQueue` accepts any `ISchedulerRegistry` (interface, not concrete class)
- loa-finn can reimplement the init flow with its own scheduler instance and the same `register()` call

No loa-beauvoir-specific abstractions are introduced. The work queue and scheduler communicate through the `ISchedulerRegistry` interface, which loa-finn can implement independently.

## Success Criteria

- [ ] `scheduler.start()` is called only after `initialize()` resolves successfully
- [ ] `scheduler.start()` is NOT called when `initialize()` rejects (fail-fast)
- [ ] `scheduler.stop()` is called on graceful shutdown (`SIGTERM`/`SIGINT`)
- [ ] Work queue task registers when `scheduler.workQueue.enabled: true`
- [ ] Work queue task does NOT register when `scheduler.workQueue.enabled: false` (default)
- [ ] Health check, auto-sync, and stale check tasks fire on schedule (they were registered but never ran)
- [ ] All existing test suites pass without modification
- [ ] New tests cover the wiring (start, register, shutdown, init-failure guard)

---

_Generated by Loa Framework -- PRD grounded in codebase analysis of deploy/loa-identity/_
