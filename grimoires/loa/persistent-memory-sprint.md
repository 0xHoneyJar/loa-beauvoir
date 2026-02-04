# Sprint Plan: Persistent Memory for Loa (Phase 4-5)

> **Version**: 1.0.0
> **PRD**: `grimoires/loa/persistent-memory-prd.md`
> **SDD**: `grimoires/loa/persistent-memory-sdd.md`
> **Prerequisites**: Phase 1-3 Sprint (beads-openclaw-sprint.md) - COMPLETED
> **Created**: 2026-02-05
> **Branch**: `feature/persistent-memory-phase-4-5`

---

## Sprint Overview

| Attribute              | Value                            |
| ---------------------- | -------------------------------- |
| **Sprint ID**          | persistent-memory-001            |
| **Type**               | Feature + Infrastructure         |
| **Scope**              | 2 phases, 2 components, ~800 LOC |
| **Risk Level**         | MEDIUM (state migration)         |
| **Estimated Duration** | 2 sprints (~4-5 days)            |

---

## Phase Overview

### Phase 4: Run-Mode Unification (Sprint 1)

Replace `.run/` state files with beads as single source of truth.

### Phase 5: Cron-Based Task Decomposition (Sprint 2)

Implement bounded 30-minute sessions via work queue scheduler.

---

## Sprint 1: Run-Mode Unification (Phase 4)

### Epic: Unified State Management

```
persistent-memory-phase4 (Epic)
├── TASK-4.1: Create BeadsRunStateManager [P0]
├── TASK-4.2: Implement State Mapping [P0]
├── TASK-4.3: Create Circuit Breaker as Bead [P0]
├── TASK-4.4: Update /run-status [P0]
├── TASK-4.5: Update /run-halt [P1]
├── TASK-4.6: Update /run-resume [P1]
├── TASK-4.7: Update /run [P1]
├── TASK-4.8: Create Migration Script [P1]
├── TASK-4.9: Write Tests [P1]
└── TASK-4.10: Deprecation Warning [P2]
```

---

### TASK-4.1: Create BeadsRunStateManager

**Priority**: P0 (Critical Path)
**Blocked By**: Phase 1-3 completion
**Blocks**: TASK-4.2, TASK-4.3, TASK-4.4

#### Description

Create the core state manager that queries and mutates run state using beads.

#### Acceptance Criteria

- [ ] Create `deploy/loa-identity/beads/beads-run-state.ts`
- [ ] Implement `BeadsRunStateManager` class with:
  - `getRunState()` - Returns READY/RUNNING/HALTED/COMPLETE
  - `getCurrentSprint()` - Returns current sprint state
  - `getSprintPlan()` - Returns all sprints
  - `startRun(sprintIds)` - Initializes a new run
  - `startSprint(sprintId)` - Begins sprint execution
  - `completeSprint(sprintId)` - Marks sprint done
  - `haltRun(reason)` - Creates circuit breaker
  - `resumeRun()` - Clears circuit breaker
- [ ] Define label schema constants
- [ ] Shell-escape all user input

#### Implementation Notes

```typescript
const LABELS = {
  RUN_CURRENT: "run:current",
  SPRINT_IN_PROGRESS: "sprint:in_progress",
  CIRCUIT_BREAKER: "circuit-breaker",
  // ... etc
};
```

#### Files to Create

- `deploy/loa-identity/beads/beads-run-state.ts`

---

### TASK-4.2: Implement State Mapping

**Priority**: P0 (Critical Path)
**Blocked By**: TASK-4.1
**Blocks**: TASK-4.4, TASK-4.5, TASK-4.6

#### Description

Implement the state query logic that maps beads labels to run states.

#### Acceptance Criteria

- [ ] READY: No beads with `run:current` label
- [ ] RUNNING: Has `run:current` bead with `sprint:in_progress` child
- [ ] HALTED: Has `run:current` bead with `circuit-breaker` label
- [ ] COMPLETE: Has `run:current` bead with no `sprint:pending` children
- [ ] Query performance <100ms

#### State Mapping

| State    | Bead Query                                       |
| -------- | ------------------------------------------------ |
| READY    | `br list --label run:current` returns []         |
| RUNNING  | `br list --label sprint:in_progress` returns [x] |
| HALTED   | run:current bead has circuit-breaker label       |
| COMPLETE | No sprint:pending or sprint:in_progress          |

---

### TASK-4.3: Create Circuit Breaker as Bead

**Priority**: P0 (Critical Path)
**Blocked By**: TASK-4.1
**Blocks**: TASK-4.5, TASK-4.6

#### Description

Implement circuit breaker creation and resolution using beads.

#### Acceptance Criteria

- [ ] `createCircuitBreaker(sprintId, reason, failureCount)`:
  - Creates bead with type `debt`, priority 0
  - Adds labels: `circuit-breaker`, `same-issue-{N}x`, `sprint:{id}`
  - Adds comment with failure reason
  - Labels parent run with `circuit-breaker`
- [ ] `resolveCircuitBreaker(beadId)`:
  - Closes the circuit breaker bead
  - Removes `circuit-breaker` label from run
- [ ] `getActiveCircuitBreakers()`:
  - Returns all open circuit breaker beads

#### Files to Modify

- `deploy/loa-identity/beads/beads-run-state.ts`

---

### TASK-4.4: Update /run-status

**Priority**: P0 (Critical Path)
**Blocked By**: TASK-4.2
**Blocks**: TASK-4.7

#### Description

Update the `/run-status` command to read from beads instead of `.run/`.

#### Acceptance Criteria

- [ ] Replace `readFileSync(".run/state.json")` with `BeadsRunStateManager.getRunState()`
- [ ] Display current sprint from beads
- [ ] Show active circuit breakers
- [ ] Output format unchanged for backward compatibility
- [ ] Works when `.run/` doesn't exist

#### Files to Modify

- `.claude/skills/run-mode/SKILL.md` (or implementation file)

---

### TASK-4.5: Update /run-halt

**Priority**: P1
**Blocked By**: TASK-4.3
**Blocks**: TASK-4.9

#### Description

Update the `/run-halt` command to create circuit breaker beads.

#### Acceptance Criteria

- [ ] Replace `.run/circuit-breaker.json` writes with `createCircuitBreaker()`
- [ ] Halt labels the current sprint
- [ ] Output shows circuit breaker bead ID
- [ ] Works independently of `.run/` existence

#### Files to Modify

- `.claude/skills/run-mode/SKILL.md` (or implementation file)

---

### TASK-4.6: Update /run-resume

**Priority**: P1
**Blocked By**: TASK-4.3
**Blocks**: TASK-4.9

#### Description

Update the `/run-resume` command to resolve circuit breaker beads.

#### Acceptance Criteria

- [ ] Replace `.run/circuit-breaker.json` reads with `getActiveCircuitBreakers()`
- [ ] Call `resolveCircuitBreaker()` for each active CB
- [ ] Output shows resolved bead IDs
- [ ] Resumes from halted sprint

#### Files to Modify

- `.claude/skills/run-mode/SKILL.md` (or implementation file)

---

### TASK-4.7: Update /run

**Priority**: P1
**Blocked By**: TASK-4.4
**Blocks**: TASK-4.8

#### Description

Update the main `/run` command to use beads state manager.

#### Acceptance Criteria

- [ ] `startRun()` creates run epic bead
- [ ] Sprints linked to run via labels
- [ ] State transitions recorded via beads
- [ ] No writes to `.run/` directory
- [ ] Backward compatible output format

#### Files to Modify

- `.claude/skills/run-mode/SKILL.md` (or implementation file)

---

### TASK-4.8: Create Migration Script

**Priority**: P1
**Blocked By**: TASK-4.7
**Blocks**: TASK-4.9

#### Description

Create a migration script for existing `.run/` state.

#### Acceptance Criteria

- [ ] Create `.claude/scripts/beads/migrate-dotrun.sh`
- [ ] Implement `migrateFromDotRun(dotRunPath)` in BeadsRunStateManager
- [ ] Migrates:
  - state.json → run epic bead with labels
  - sprint-plan-state.json → sprint beads
  - circuit-breaker.json → circuit breaker bead
- [ ] Creates backup before migration
- [ ] Idempotent (safe to run multiple times)
- [ ] Outputs migration summary

#### Migration Steps

```bash
1. Backup .run/ to .run.backup.{timestamp}
2. Read state.json
3. Create run epic bead
4. Read sprint-plan-state.json
5. Create sprint beads with correct labels
6. Read circuit-breaker.json
7. Create CB bead if state=open
8. Print summary
```

#### Files to Create

- `.claude/scripts/beads/migrate-dotrun.sh`
- Migration logic in `beads-run-state.ts`

---

### TASK-4.9: Write Tests (Phase 4)

**Priority**: P1
**Blocked By**: TASK-4.8
**Blocks**: TASK-4.10

#### Description

Write tests for Phase 4 components.

#### Acceptance Criteria

- [ ] Create `deploy/loa-identity/beads/__tests__/beads-run-state.test.ts`
- [ ] Test cases:
  - `getRunState()` returns correct state for each scenario
  - `createCircuitBreaker()` creates bead with correct labels
  - `resolveCircuitBreaker()` closes bead and removes labels
  - `migrateFromDotRun()` preserves all state
- [ ] All tests pass with `pnpm test`

#### Test Matrix

| Test Case                           | Type        |
| ----------------------------------- | ----------- |
| getRunState returns READY           | Unit        |
| getRunState returns RUNNING         | Unit        |
| getRunState returns HALTED          | Unit        |
| getRunState returns COMPLETE        | Unit        |
| createCircuitBreaker creates bead   | Unit        |
| resolveCircuitBreaker closes bead   | Unit        |
| Migration preserves sprints         | Integration |
| Migration preserves circuit breaker | Integration |

#### Files to Create

- `deploy/loa-identity/beads/__tests__/beads-run-state.test.ts`

---

### TASK-4.10: Deprecation Warning

**Priority**: P2
**Blocked By**: TASK-4.9
**Blocks**: None

#### Description

Add deprecation warning when `.run/` directory is detected.

#### Acceptance Criteria

- [ ] On startup, check if `.run/` exists
- [ ] If exists, log warning: "Deprecated: .run/ directory detected. Run migration with /run-migrate"
- [ ] Warning appears once per session
- [ ] Can be silenced via config: `beads.run_mode.deprecate_dotrun: false`

---

## Sprint 2: Cron-Based Task Decomposition (Phase 5)

### Epic: Bounded Session Execution

```
persistent-memory-phase5 (Epic)
├── TASK-5.1: Create BeadsWorkQueue [P0]
├── TASK-5.2: Implement Task Claiming [P0]
├── TASK-5.3: Implement Session Handoff [P0]
├── TASK-5.4: Add --single-task to /implement [P0]
├── TASK-5.5: Register Work Queue Scheduler Task [P1]
├── TASK-5.6: Update /run sprint-plan [P1]
├── TASK-5.7: Implement Session Timeout [P1]
├── TASK-5.8: Write Tests [P1]
└── TASK-5.9: Documentation [P2]
```

---

### TASK-5.1: Create BeadsWorkQueue

**Priority**: P0 (Critical Path)
**Blocked By**: Phase 4 completion
**Blocks**: TASK-5.2, TASK-5.5

#### Description

Create the work queue component that processes ready tasks.

#### Acceptance Criteria

- [ ] Create `deploy/loa-identity/beads/beads-work-queue.ts`
- [ ] Implement `BeadsWorkQueue` class with:
  - `register(scheduler)` - Registers with scheduler
  - `claimNextTask()` - Claims ready task
  - `releaseTask(id, status)` - Releases task
  - `recordHandoff(id, context)` - Records session state
- [ ] Configurable via `WorkQueueConfig`
- [ ] Circuit breaker for consecutive failures

#### Files to Create

- `deploy/loa-identity/beads/beads-work-queue.ts`

---

### TASK-5.2: Implement Task Claiming

**Priority**: P0 (Critical Path)
**Blocked By**: TASK-5.1
**Blocks**: TASK-5.4

#### Description

Implement the task claiming and release protocol.

#### Acceptance Criteria

- [ ] `claimNextTask()`:
  - Queries `br list --label ready --status open`
  - Sorts by priority (lower = higher)
  - Removes `ready` label, adds `in_progress`
  - Adds `session:{uuid}` label
  - Returns `TaskClaim` with taskId, sessionId, claimedAt
- [ ] `releaseTask(id, "done")`:
  - Removes `in_progress`, adds `done`
  - Closes the bead
- [ ] `releaseTask(id, "blocked", reason)`:
  - Removes `in_progress`, adds `blocked`
  - Adds comment with reason

#### Label Transitions

```
ready → in_progress → done (close)
       ↘ blocked (open, needs attention)
```

---

### TASK-5.3: Implement Session Handoff

**Priority**: P0 (Critical Path)
**Blocked By**: TASK-5.2
**Blocks**: TASK-5.4, TASK-5.7

#### Description

Implement the session handoff protocol for context preservation.

#### Acceptance Criteria

- [ ] `recordHandoff(taskId, context)`:
  - Creates comment with structured handoff data
  - Includes: sessionId, filesChanged, currentState, nextSteps, tokensUsed
  - Adds `handoff:{sessionId}` label
- [ ] Handoff comment format is parseable
- [ ] Next session can read previous handoff

#### Handoff Format

```
--- SESSION HANDOFF ---
Session: abc-123
Timestamp: 2026-02-05T10:30:00Z
Tokens used: 15000

Files changed:
  - src/foo.ts
  - src/bar.ts

Current state:
Implemented the main logic, tests pending.

Next steps:
  1. Write unit tests
  2. Run linter
  3. Update docs
--- END HANDOFF ---
```

---

### TASK-5.4: Add --single-task to /implement

**Priority**: P0 (Critical Path)
**Blocked By**: TASK-5.2, TASK-5.3
**Blocks**: TASK-5.5

#### Description

Add single-task mode to the /implement command.

#### Acceptance Criteria

- [ ] Add `--single-task` flag to /implement
- [ ] Add `--task-id <id>` for explicit task selection
- [ ] Add `--timeout <minutes>` (default: 30)
- [ ] Single-task mode:
  - Claims or uses provided task
  - Processes exactly one task
  - Records handoff on exit/timeout
  - Exits after completion
- [ ] Environment variables: `LOA_SINGLE_TASK_MODE`, `LOA_TASK_ID`

#### Usage

```bash
/implement --single-task                    # Auto-claim next ready
/implement --single-task --task-id abc123   # Specific task
/implement --single-task --timeout 20       # 20 minute limit
```

#### Files to Modify

- `.claude/skills/implementing-tasks/SKILL.md`

---

### TASK-5.5: Register Work Queue Scheduler Task

**Priority**: P1
**Blocked By**: TASK-5.1, TASK-5.4
**Blocks**: TASK-5.6

#### Description

Register the work queue processor with the scheduler.

#### Acceptance Criteria

- [ ] Register `beads_work_queue` task in scheduler
- [ ] Runs every 5 minutes (configurable)
- [ ] Only processes if run state is RUNNING
- [ ] Claims first ready task
- [ ] Triggers single-task agent session
- [ ] Circuit breaker: 3 failures → 30 min cooldown
- [ ] Respects `enabled` config

#### Scheduler Task Config

```typescript
{
  id: "beads_work_queue",
  name: "Beads Work Queue Processor",
  intervalMs: 5 * 60 * 1000,  // 5 minutes
  jitterMs: 30 * 1000,         // ±30 seconds
  circuitBreaker: {
    maxFailures: 3,
    resetTimeMs: 30 * 60 * 1000,  // 30 minutes
  }
}
```

---

### TASK-5.6: Update /run sprint-plan

**Priority**: P1
**Blocked By**: TASK-5.5
**Blocks**: TASK-5.8

#### Description

Update sprint-plan to create task beads for work queue processing.

#### Acceptance Criteria

- [ ] Creates bead for each sprint task
- [ ] Task beads linked to sprint via `epic:{sprintId}` label
- [ ] Initial label: `ready` (or `blocked` if has deps)
- [ ] Dependencies tracked via `blocked-by:{taskId}` label
- [ ] Work queue can process these tasks automatically

#### Task Creation

```bash
# For each task in sprint
br create "Task: {title}" --type task --priority {p}
br label add {id} epic:{sprintId}
br label add {id} ready  # or blocked if deps
```

---

### TASK-5.7: Implement Session Timeout

**Priority**: P1
**Blocked By**: TASK-5.3
**Blocks**: TASK-5.8

#### Description

Implement graceful timeout handling for single-task sessions.

#### Acceptance Criteria

- [ ] `timeout` command wrapper with configurable duration
- [ ] SIGTERM handler records handoff before exit
- [ ] Task remains `in_progress` on timeout (not released)
- [ ] Next session picks up from handoff
- [ ] Logs timeout with task ID

#### Timeout Flow

```
1. Session starts with 30m timeout
2. At timeout, SIGTERM sent
3. Handler catches SIGTERM
4. Records handoff with current state
5. Exits cleanly (code 0)
6. Task stays in_progress for next session
```

---

### TASK-5.8: Write Tests (Phase 5)

**Priority**: P1
**Blocked By**: TASK-5.6, TASK-5.7
**Blocks**: TASK-5.9

#### Description

Write tests for Phase 5 components.

#### Acceptance Criteria

- [ ] Create `deploy/loa-identity/beads/__tests__/beads-work-queue.test.ts`
- [ ] Test cases:
  - `claimNextTask()` claims highest priority
  - `releaseTask("done")` closes bead
  - `releaseTask("blocked")` adds blocked label
  - `recordHandoff()` creates structured comment
  - Scheduler task processes ready tasks
  - Timeout triggers handoff
- [ ] All tests pass with `pnpm test`

#### Test Matrix

| Test Case                           | Type        |
| ----------------------------------- | ----------- |
| claimNextTask returns highest prio  | Unit        |
| claimNextTask returns null if empty | Unit        |
| releaseTask done closes bead        | Unit        |
| releaseTask blocked adds label      | Unit        |
| recordHandoff creates comment       | Unit        |
| Work queue processes tasks          | Integration |
| Timeout triggers handoff            | Integration |

#### Files to Create

- `deploy/loa-identity/beads/__tests__/beads-work-queue.test.ts`

---

### TASK-5.9: Documentation

**Priority**: P2
**Blocked By**: TASK-5.8
**Blocks**: None

#### Description

Update documentation for Phase 4-5 features.

#### Acceptance Criteria

- [ ] Update `.claude/protocols/beads-integration.md`:
  - Add section on run state management
  - Document work queue behavior
  - Document single-task mode
  - Add session handoff protocol
- [ ] Update run-mode skill documentation:
  - Document beads integration
  - Remove references to `.run/`
  - Add migration instructions
- [ ] Add inline code comments

#### Documentation Sections

````markdown
## Run State Management

Run state is now stored in beads, not `.run/` files.

### State Mapping

| State    | Beads Query                   |
| -------- | ----------------------------- |
| READY    | No `run:current` beads        |
| RUNNING  | Has `sprint:in_progress` bead |
| HALTED   | Has `circuit-breaker` label   |
| COMPLETE | All sprints closed            |

### Migration

```bash
.claude/scripts/beads/migrate-dotrun.sh
```
````

## Work Queue

The work queue automatically processes ready tasks:

1. Scheduler checks every 5 minutes
2. Claims first ready task by priority
3. Triggers single-task agent session
4. Session processes one task and exits
5. Next tick picks up more work

### Single-Task Mode

```bash
/implement --single-task           # Process one task
/implement --single-task --timeout 20  # 20 min limit
```

```

---

## Task Dependencies

### Sprint 1 (Phase 4)

```

TASK-4.1 (RunStateManager)
│
├───► TASK-4.2 (State Mapping)
│ │
│ ├───► TASK-4.4 (/run-status) ───► TASK-4.7 (/run)
│ │ │
│ └───► TASK-4.5 (/run-halt) │
│ └───► TASK-4.6 (/run-resume) │
│ │
└───► TASK-4.3 (Circuit Breaker) │
│ │
└───► TASK-4.5 │
└───► TASK-4.6 │
│
▼
TASK-4.8 (Migration)
│
▼
TASK-4.9 (Tests)
│
▼
TASK-4.10 (Deprecation)

```

### Sprint 2 (Phase 5)

```

TASK-5.1 (WorkQueue)
│
├───► TASK-5.2 (Task Claiming)
│ │
│ └───► TASK-5.3 (Session Handoff)
│ │
│ └───► TASK-5.4 (--single-task)
│ │
│ ▼
└─────────────────────► TASK-5.5 (Scheduler Task)
│
▼
TASK-5.6 (/run sprint-plan)
│
│ TASK-5.7 (Timeout)
│ │
▼ ▼
TASK-5.8 (Tests)
│
▼
TASK-5.9 (Documentation)

````

---

## Definition of Done

### Per-Task DoD

- [ ] Code compiles without errors (`pnpm build`)
- [ ] Code passes linting (`pnpm check`)
- [ ] Code has type safety (no `any` types)
- [ ] Shell commands properly escaped
- [ ] Acceptance criteria met
- [ ] Error handling implemented

### Sprint 1 DoD (Phase 4)

- [ ] All P0 and P1 tasks completed
- [ ] Tests pass (`pnpm test`)
- [ ] `/run-status` reads from beads
- [ ] Circuit breaker creates/resolves beads
- [ ] Migration script works
- [ ] PR created

### Sprint 2 DoD (Phase 5)

- [ ] All P0 and P1 tasks completed
- [ ] Tests pass (`pnpm test`)
- [ ] Work queue processes tasks
- [ ] Single-task mode works
- [ ] Session handoff preserves state
- [ ] Documentation updated
- [ ] PR created

---

## Risk Mitigation

| Risk                            | Mitigation                             |
| ------------------------------- | -------------------------------------- |
| State migration loses data      | Backup before migration, idempotent    |
| br command interface changes    | Pin br version, integration tests      |
| Session timeout race condition  | SIGTERM handler, graceful shutdown     |
| Work queue thundering herd      | Jitter, single-task claiming           |
| Backward compatibility          | Deprecation warnings, migration path   |

---

## Commit Strategy

### Sprint 1 Commits (Phase 4)

1. `feat(beads): add BeadsRunStateManager for unified state`
2. `feat(beads): implement circuit breaker as bead`
3. `refactor(run): update /run-status to use beads`
4. `refactor(run): update /run-halt and /run-resume`
5. `refactor(run): update /run to use beads state`
6. `feat(beads): add .run migration script`
7. `test(beads): add run state manager tests`
8. `chore(run): add deprecation warning for .run/`

### Sprint 2 Commits (Phase 5)

1. `feat(beads): add BeadsWorkQueue for task processing`
2. `feat(beads): implement task claiming protocol`
3. `feat(beads): implement session handoff`
4. `feat(implement): add --single-task mode`
5. `feat(scheduler): register beads_work_queue task`
6. `feat(run): update sprint-plan to create task beads`
7. `feat(implement): add session timeout handling`
8. `test(beads): add work queue tests`
9. `docs(beads): update integration documentation`

### Final PRs

#### Sprint 1 PR

```bash
gh pr create --title "feat(beads): run-mode unification with beads (Phase 4)" --body "$(cat <<'EOF'
## Summary

Replaces `.run/` state files with beads as single source of truth.

- **State Mapping**: Run states (READY/RUNNING/HALTED/COMPLETE) now query beads
- **Circuit Breaker**: Failures create debt beads with proper labels
- **Migration**: Script to migrate existing `.run/` state
- **Deprecation**: Warning when `.run/` detected

## Changes

- New: `deploy/loa-identity/beads/beads-run-state.ts`
- New: `.claude/scripts/beads/migrate-dotrun.sh`
- Modified: Run-mode skill commands

## Test Plan

- [ ] `/run-status` shows state from beads
- [ ] `/run-halt` creates circuit breaker bead
- [ ] `/run-resume` resolves circuit breaker
- [ ] Migration preserves existing state

## Related

- PRD: grimoires/loa/persistent-memory-prd.md
- SDD: grimoires/loa/persistent-memory-sdd.md

---
Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
````

#### Sprint 2 PR

```bash
gh pr create --title "feat(beads): cron-based task decomposition (Phase 5)" --body "$(cat <<'EOF'
## Summary

Implements bounded 30-minute sessions via work queue scheduler.

- **Work Queue**: Scheduler task processes ready tasks automatically
- **Single-Task Mode**: `/implement --single-task` for bounded sessions
- **Session Handoff**: Context preserved between sessions
- **Token Efficiency**: 50%+ reduction vs marathon sessions

## Changes

- New: `deploy/loa-identity/beads/beads-work-queue.ts`
- Modified: `/implement` skill with --single-task flag
- Modified: `/run sprint-plan` creates task beads

## Test Plan

- [ ] Work queue claims and processes tasks
- [ ] Single-task mode completes one task
- [ ] Session timeout triggers handoff
- [ ] Handoff preserves context for next session

## Related

- PRD: grimoires/loa/persistent-memory-prd.md
- SDD: grimoires/loa/persistent-memory-sdd.md

---
Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Post-Sprint

### Verification

#### Sprint 1

1. Delete `.run/` directory
2. Run `/run-status` - Should show READY from beads
3. Start a run - Verify beads created
4. Halt run - Verify circuit breaker bead
5. Resume run - Verify CB resolved

#### Sprint 2

1. Start `/run sprint-plan` - Task beads created
2. Wait 5 minutes - Work queue claims task
3. Verify single-task session runs
4. Check handoff on task bead
5. Kill session - Verify handoff recorded

### Success Metrics

| Metric               | Target            | Verification                  |
| -------------------- | ----------------- | ----------------------------- |
| State systems        | 1 (beads only)    | `.run/` not created           |
| Session length       | <30 minutes (p95) | Scheduler logs                |
| Token usage          | -50% per task     | Compare before/after          |
| Context preservation | 100%              | Handoff readable by next sess |

### Next Steps (Future Phases)

- Phase 6: Learning extraction from sprints
- Multi-agent coordination
- Real-time collaboration

---

_Generated by Loa Simstim Workflow_
