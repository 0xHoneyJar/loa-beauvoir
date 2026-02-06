# SDD: Wire BeadsWorkQueue to Beauvoir Scheduler

> **Status**: Draft
> **PRD**: `grimoires/loa/scheduler-wiring-prd.md`
> **Created**: 2026-02-06
> **Target**: `deploy/loa-identity/` (Identity host only)

---

## 1. Overview

This SDD describes the wiring changes needed to connect two existing, tested subsystems:

1. **Beauvoir Scheduler** (`deploy/loa-identity/scheduler/scheduler.ts`) — timer-based task scheduler with circuit breakers, jitter, and mutex groups
2. **BeadsWorkQueue** (`deploy/loa-identity/beads/beads-work-queue.ts`) — periodic task processor that claims ready beads and triggers bounded agent sessions

Both are fully implemented and tested. The only work is wiring: calling `scheduler.start()` and `registerWorkQueueTask()` in the initialization flow.

## 2. Current Architecture (Before)

```
deploy/loa-identity/index.ts
  │
  ├── createBeauvoirScheduler()        → Scheduler { running: false }
  │
  ├── createBeadsPersistenceService(config, wal, scheduler)
  │     └── constructor:
  │           └── registerBeadsSchedulerTasks(scheduler, ...)
  │                 ├── beads_health      ── registered ✓
  │                 ├── beads_sync        ── registered ✓
  │                 └── beads_stale_check ── registered ✓
  │                 (registerWorkQueueTask NOT called ✗)
  │
  ├── beadsPersistence.initialize()    → crash recovery
  │
  └── return { scheduler, ... }        → scheduler.start() NEVER called ✗
                                          running stays false
                                          scheduleTask() returns early
                                          ALL tasks are inert
```

## 3. Target Architecture (After)

```
deploy/loa-identity/index.ts
  │
  ├── createBeauvoirScheduler()        → Scheduler { running: false }
  │
  ├── createBeadsPersistenceService(config, wal, scheduler, runStateManager)
  │     └── constructor:
  │           ├── registerBeadsSchedulerTasks(scheduler, ...)
  │           │     ├── beads_health      ── registered ✓
  │           │     ├── beads_sync        ── registered ✓
  │           │     └── beads_stale_check ── registered ✓
  │           │
  │           └── [if workQueue.enabled]:
  │                 createBeadsWorkQueue(wqConfig, runStateManager, { brCommand })
  │                 registerWorkQueueTask(scheduler, workQueue, config.scheduler)
  │                   └── beads_work_queue ── registered ✓
  │
  ├── beadsPersistence.initialize()    → crash recovery
  │
  ├── scheduler.start()               → running = true ✓   [NEW]
  │     └── scheduleTask() for each registered task
  │           └── setTimeout(handler, intervalMs ± jitterMs)
  │
  └── return { scheduler, shutdown }       [NEW: returns cleanup handle]
      │
      └── caller manages shutdown lifecycle
          (e.g., process.on("SIGTERM", shutdown) in top-level entrypoint)
```

## 4. Dependency Discovery: RunStateManager

**Critical finding**: `BeadsWorkQueue` constructor requires `runStateManager: IBeadsRunStateManager` — an interface that provides `getRunState()` (returns `"RUNNING"`, `"PAUSED"`, etc.) and sprint plan queries. The current `BeadsPersistenceService` does NOT hold a reference to a `runStateManager`.

### Resolution

Use an **options object** for new dependencies to avoid positional-arg ambiguity and ensure forward-compatible API evolution:

```typescript
// Before:
constructor(config, wal?, scheduler?)

// After:
constructor(config, opts?: {
  wal?: SegmentedWALManager;
  scheduler?: Scheduler;
  runStateManager?: IBeadsRunStateManager;
})
```

The factory function changes accordingly:

```typescript
// Before:
createBeadsPersistenceService(config, wal, scheduler)

// After:
createBeadsPersistenceService(config, opts?: {
  wal?: SegmentedWALManager;
  scheduler?: Scheduler;
  runStateManager?: IBeadsRunStateManager;
})
```

In `index.ts`, the caller creates a `BeadsRunStateManager` instance and passes it:

```typescript
const { createBeadsRunStateManager } = await import("./beads/index.js");
const runStateManager = createBeadsRunStateManager({ verbose: false });

beadsPersistence = createBeadsPersistenceService(config, {
  wal: walManager,
  scheduler,
  runStateManager,
});
```

**Fail-fast when misconfigured**: If `config.scheduler.workQueue.enabled === true` but `runStateManager` is not provided, the constructor throws:

```typescript
if (config.scheduler?.workQueue?.enabled && !opts?.runStateManager) {
  throw new Error(
    "[beads-persistence] workQueue.enabled=true requires a runStateManager. " +
      "Pass createBeadsRunStateManager() or disable workQueue.",
  );
}
```

This prevents the silent-skip footgun where an operator enables the work queue but forgets the dependency.

## 5. File-by-File Changes

### 5.1 `deploy/loa-identity/index.ts`

**Lines affected**: 162-182

Changes:

1. Create `runStateManager` via `createBeadsRunStateManager()`
2. Build a single normalized `schedulerConfig` (single source of truth for all scheduler tasks)
3. Pass options object to `createBeadsPersistenceService()`
4. Add try/catch around `initialize()` + `scheduler.start()` (fail-fast on init error)
5. Return a `shutdown()` cleanup function — do NOT register global signal handlers here

```typescript
if (beadsConfig?.enabled !== false) {
  const { createBeadsPersistenceService, createDefaultBeadsConfig, createBeadsRunStateManager } =
    await import("./beads/index.js");

  const runStateManager = createBeadsRunStateManager({ verbose: false });

  // Single source of truth for scheduler config — normalize once, pass everywhere
  const schedulerConfig = {
    healthCheck: { enabled: true, ...beadsConfig?.scheduler?.healthCheck },
    autoSync: { enabled: true, ...beadsConfig?.scheduler?.autoSync },
    staleCheck: { enabled: true, ...beadsConfig?.scheduler?.staleCheck },
    workQueue: { enabled: false, ...beadsConfig?.scheduler?.workQueue },
  };

  beadsPersistence = createBeadsPersistenceService(
    createDefaultBeadsConfig({
      enabled: beadsConfig?.enabled ?? true,
      beadsDir: beadsConfig?.beadsDir ?? ".beads",
      scheduler: schedulerConfig,
    }),
    { wal: walManager, scheduler, runStateManager },
  );

  try {
    await beadsPersistence.initialize();
    scheduler.start();
    console.log("[loa] Beads persistence initialized, scheduler started");
  } catch (err) {
    scheduler.stop(); // Defensive: prevent timer leaks
    throw err;
  }
}

// Return cleanup handle — caller (top-level entrypoint) owns signal registration
let stopped = false;
const shutdown = () => {
  if (stopped) return; // Idempotent
  stopped = true;
  scheduler.stop();
};
return { identity, recovery, memory, scheduler, beads: beadsPersistence, shutdown };
```

**Signal handler ownership**: The `shutdown()` function is returned to the caller. The top-level executable entrypoint (e.g., `main.ts` or CLI) registers signal handlers:

```typescript
const ctx = await initIdentity(config);
process.once("SIGTERM", ctx.shutdown);
process.once("SIGINT", ctx.shutdown);
```

This avoids accumulating global listeners in tests, hot-reload, or multi-service compositions. Using `process.once()` instead of `process.on()` prevents duplicate handler accumulation.

### 5.2 `deploy/loa-identity/beads/beads-persistence-service.ts`

**Lines affected**: Constructor (85-122), factory (296-302), createDefaultBeadsConfig (307-326)

Changes:

1. Convert constructor to options-object pattern for new dependencies
2. Fail-fast if `workQueue.enabled` but `runStateManager` missing
3. After `registerBeadsSchedulerTasks()`, conditionally create WorkQueue and register
4. Both `registerBeadsSchedulerTasks` and `registerWorkQueueTask` receive the same normalized `schedulerConfig`
5. Update factory function to match

```typescript
constructor(
  config: BeadsPersistenceConfig,
  opts?: {
    wal?: SegmentedWALManager;
    scheduler?: Scheduler;
    runStateManager?: IBeadsRunStateManager;
  },
) {
  this.config = config;
  const { wal, scheduler, runStateManager } = opts ?? {};
  this.scheduler = scheduler;

  // Fail-fast: workQueue enabled but no runStateManager
  if (config.scheduler?.workQueue?.enabled && !runStateManager) {
    throw new Error(
      "[beads-persistence] workQueue.enabled=true requires a runStateManager. " +
      "Pass createBeadsRunStateManager() or disable workQueue."
    );
  }

  // ... existing WAL setup (unchanged, uses `wal` from opts) ...

  if (scheduler) {
    // Single normalized config — passed to BOTH maintenance tasks and work queue
    const schedulerConfig = {
      ...config.scheduler,
      beadsDir: config.beadsDir,
      brCommand: config.brCommand,
    };

    registerBeadsSchedulerTasks(scheduler, schedulerConfig);

    // Register work queue if enabled (runStateManager guaranteed present by guard above)
    if (config.scheduler?.workQueue?.enabled && runStateManager) {
      const workQueue = createBeadsWorkQueue(
        {
          enabled: true,
          intervalMs: config.scheduler.workQueue.intervalMs,
          jitterMs: config.scheduler.workQueue.jitterMs,
          sessionTimeoutMs: config.scheduler.workQueue.sessionTimeoutMs,
        },
        runStateManager,
        { brCommand: config.brCommand },
      );
      registerWorkQueueTask(scheduler, workQueue, schedulerConfig);
    }
  }
}
```

**Key design decisions**:

- Options object avoids positional-arg ambiguity (GPT issue #3)
- Same `schedulerConfig` object passed to both `registerBeadsSchedulerTasks` and `registerWorkQueueTask` (GPT issue #2)
- Fail-fast throw prevents silent skip footgun (GPT issue #5)

### 5.3 `deploy/loa-identity/beads/index.ts`

**Lines affected**: Exports section

Changes: Re-export `createBeadsRunStateManager` if not already exported (it is — line 67).

No changes needed — `createBeadsRunStateManager` is already exported from the barrel.

### 5.4 No changes to:

- `scheduler.ts` — no behavioral changes
- `beads-work-queue.ts` — no behavioral changes
- `beads-scheduler-tasks.ts` — no behavioral changes (DEFAULT_CONFIG.workQueue.enabled stays `false`)

## 6. Config Flow (End-to-End)

```
External caller (index.ts)
  │
  │  beadsConfig?.scheduler?.workQueue?.enabled ?? false
  │
  ▼
createDefaultBeadsConfig({
  scheduler: {
    workQueue: { enabled: true, intervalMs: 300_000, ... }
  }
})
  │
  │  BeadsPersistenceConfig.scheduler: BeadsSchedulerConfig
  │
  ▼
BeadsPersistenceService constructor
  │
  │  config.scheduler?.workQueue?.enabled  ← guard
  │
  ▼
createBeadsWorkQueue({ enabled: true, ... }, runStateManager)
  │
  │  WorkQueueConfig.enabled
  │
  ▼
registerWorkQueueTask(scheduler, workQueue, config.scheduler)
  │
  │  mergeConfig(DEFAULT_CONFIG, config).workQueue.enabled  ← second guard
  │
  ▼
workQueue.register(scheduler)
  │
  │  this.config.enabled  ← third guard
  │
  ▼
scheduler.register({ id: "beads_work_queue", handler, ... })
```

Three layers of enable checks ensure the work queue only runs when explicitly opted in.

## 7. Initialization Ordering

```
1. createBeauvoirScheduler()              → scheduler (running=false)
2. createBeadsRunStateManager()           → runStateManager
3. createBeadsPersistenceService(config, { wal, scheduler, runStateManager })
     ├── [guard] workQueue.enabled && !runStateManager → throw
     ├── registerBeadsSchedulerTasks(schedulerConfig)  → 3 maintenance tasks
     └── registerWorkQueueTask(schedulerConfig)        → 1 work queue task (if enabled)
4. beadsPersistence.initialize()          → WAL crash recovery
5. scheduler.start()                      → running=true, schedules all tasks
     └── setTimeout(handler, intervalMs ± jitterMs) for each (line 135-145)
6. return { shutdown }                    → caller owns signal registration
7. [caller] process.once("SIGTERM", shutdown)
```

**Critical constraints**:

- Step 5 only executes after Step 4 succeeds. If Step 4 rejects, `scheduler.stop()` is called defensively and error is rethrown.
- Step 3 throws if `workQueue.enabled` but `runStateManager` missing (fail-fast).
- Signal handlers are registered by the **caller** (Step 7), not inside init (prevents accumulation in tests/hot-reload).

## 8. Error Handling

| Scenario                                            | Behavior                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `initialize()` rejects                              | `scheduler.stop()` called, error rethrown (fail-fast)                                                |
| `workQueue.enabled` + no `runStateManager`          | **Throws** with clear error message (fail-fast, not silent skip)                                     |
| `runStateManager` not provided + workQueue disabled | No error — work queue not needed (backward-compatible)                                               |
| `workQueue.enabled` is `false` (default)            | Work queue not registered, no runtime cost                                                           |
| Task handler throws                                 | Scheduler circuit breaker increments failure count; after 3 failures, task paused for 30 min         |
| `SIGTERM` / `SIGINT`                                | Caller invokes returned `shutdown()` which calls `scheduler.stop()` (idempotent via `stopped` guard) |
| Scheduler already running                           | `start()` returns early — line 107: `if (this.running) return;`                                      |

### Verified Scheduler Behavior (Source Citations)

All claims about `Scheduler` behavior are verified from `deploy/loa-identity/scheduler/scheduler.ts`:

| Method           | Lines   | Behavior                                                                                                                                                                                                                                  |
| ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `register()`     | 71-101  | Stores task in `this.tasks` Map, does NOT schedule (no setTimeout). Safe to call before `start()`.                                                                                                                                        |
| `start()`        | 106-116 | Guards with `if (this.running) return` (idempotent). Sets `this.running = true`. Iterates `this.tasks.values()` and calls `scheduleTask()` for each.                                                                                      |
| `scheduleTask()` | 135-145 | Guards with `if (!this.running) return`. Computes `delay = Math.max(1000, task.intervalMs + jitter)`. Calls `setTimeout(handler, delay)`. Stores timer handle in `this.timers` Map. First execution is always delayed (minimum 1 second). |
| `stop()`         | 121-130 | Sets `this.running = false`. Iterates `this.timers`, calls `clearTimeout()` for each, deletes from Map. Safe to call when not started (empty timers Map).                                                                                 |

## 9. Testing Strategy

All existing tests pass without modification. New tests are added.

### New Tests

| Test                                                  | File                                          | Validates                                                        |
| ----------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Scheduler starts after init                           | `__tests__/index.test.ts`                     | `scheduler.start()` called after `initialize()`                  |
| Scheduler NOT started on init failure                 | `__tests__/index.test.ts`                     | `scheduler.stop()` called, `start()` not called                  |
| WorkQueue registers when enabled                      | `__tests__/beads-persistence-service.test.ts` | `beads_work_queue` task in scheduler                             |
| WorkQueue skipped when disabled                       | `__tests__/beads-persistence-service.test.ts` | No `beads_work_queue` task                                       |
| WorkQueue skipped when no runStateManager             | `__tests__/beads-persistence-service.test.ts` | Backward-compatible                                              |
| Shutdown function stops scheduler                     | `__tests__/index.test.ts`                     | Returned `shutdown()` calls `scheduler.stop()`                   |
| Shutdown is idempotent                                | `__tests__/index.test.ts`                     | Double `shutdown()` call doesn't throw                           |
| No handler fires after stop                           | `__tests__/scheduler.test.ts`                 | Using fake timers: stop(), advance time, verify no handler calls |
| Throws when workQueue enabled without runStateManager | `__tests__/beads-persistence-service.test.ts` | Clear error message                                              |

### Existing Test Suites (Unchanged)

- `beads-work-queue.test.ts` — 23 tests (WorkQueue internals)
- `scheduler.test.ts` — Scheduler register/start/stop/circuit-breaker
- `beads-scheduler-tasks.test.ts` — Task registration logic
- `beads-persistence-service.test.ts` — Service lifecycle

## 10. Portability Notes (loa-finn)

The wiring uses only:

- `ISchedulerRegistry` interface (not concrete `Scheduler` class) for WorkQueue registration
- `IBeadsRunStateManager` interface for run state queries
- Standard constructor dependency injection

loa-finn can implement its own `Scheduler` satisfying `ISchedulerRegistry` and its own `IBeadsRunStateManager`, then call the same `createBeadsWorkQueue()` + `register()` pattern.

---

_Generated by Loa Framework -- SDD grounded in codebase analysis of deploy/loa-identity/_
