# Product Requirements Document: Persistent Memory for Loa (Phase 4-5)

> **Version**: 1.0.0
> **Created**: 2026-02-05
> **Status**: DRAFT
> **Source**: `grimoires/loa/a2a/audits/2026-02-04-beads-review/BEADS-INTEGRATION-REVIEW.md`
> **Prerequisites**: Phase 1-3 (Beads-OpenClaw Persistence Integration) - COMPLETED

---

## Executive Summary

Transform Loa from a stateless agent that forgets between sessions into a **persistent-memory agent** that maintains continuous task awareness. This is achieved through:

1. **Phase 4: Run-Mode Unification** - Replace the parallel `.run/` state system with beads as single source of truth
2. **Phase 5: Cron-Based Task Decomposition** - Convert 8-hour agent marathons into bounded 30-minute sessions

These phases complete the vision of Loa as an agent that **never forgets and never gets lost on tasks**.

---

## Problem Statement

### The Parallel State Problem (Phase 4)

Loa currently maintains **two independent state systems**:

```
Problem: Parallel State Systems
┌────────────────┐         ┌────────────────┐
│   .beads/      │         │   .run/        │
│   beads.db     │         │   state.json   │
│   (Task state) │    ≠    │   (Run state)  │
└────────────────┘         └────────────────┘
     ↑ NOT SYNCED ↑
```

| System    | Purpose                     | Contents                                                 |
| --------- | --------------------------- | -------------------------------------------------------- |
| `.beads/` | Task/issue tracking         | beads.db, issues.jsonl                                   |
| `.run/`   | Run-mode execution tracking | state.json, sprint-plan-state.json, circuit-breaker.json |

**Problems with parallel state:**

- State can diverge silently
- Recovery requires reconciling both systems
- Cognitive overhead for developers understanding the system
- Duplicate concepts (circuit breaker exists in both)

### The Token Marathon Problem (Phase 5)

Current agent sessions are **unbounded marathons**:

```
Current Anti-Pattern:
┌─────────────────────────────────────────────────────────────┐
│              Agent Session: 8 hours                          │
├─────────────────────────────────────────────────────────────┤
│ ├── Implement task 1 (45 min)                               │
│ ├── Review task 1 (15 min)                                  │
│ ├── Audit task 1 (20 min)                                   │
│ ├── ... context accumulation ...                            │
│ ├── ... context overflow risk at hour 4 ...                 │
│ ├── Implement task N                                        │
│ └── Create PR (if context survives)                         │
└─────────────────────────────────────────────────────────────┘
```

**Problems with marathon sessions:**

- Context overflow leads to task amnesia
- Token costs scale linearly with session length
- Single point of failure (crash loses all progress)
- No natural checkpoints

### Impact

| Problem                 | Frequency    | User Impact                      |
| ----------------------- | ------------ | -------------------------------- |
| State divergence        | Weekly       | Confusion, manual reconciliation |
| Context overflow        | Every 4-6h   | Agent "forgets" earlier tasks    |
| Session crash at hour 6 | Occasionally | 6 hours of work potentially lost |
| Token overconsumption   | Always       | 50%+ wasted on redundant context |

---

## Goals

### Primary Goals

1. **Unified State** - Single source of truth for all execution state (beads)
2. **Bounded Sessions** - No session exceeds 30 minutes
3. **Token Efficiency** - 50%+ reduction in token usage per task
4. **Zero Amnesia** - Agent always knows pending tasks across sessions

### Success Metrics

| Metric                           | Current          | Target         |
| -------------------------------- | ---------------- | -------------- |
| State systems                    | 2 (beads + .run) | 1 (beads only) |
| Max session length               | 8 hours          | 30 minutes     |
| Token cost per task              | Baseline         | -50%           |
| Task completion rate after crash | ~70%             | 99%            |
| Context overflow incidents       | Weekly           | Never          |

### Non-Goals

- Modifying beads_rust core functionality
- Multi-agent coordination (future phase)
- Real-time collaboration features
- Learning/pattern extraction (Phase 6)

---

## User Stories

### Phase 4: Run-Mode Unification

#### US-4.1: Unified State Query

**As** a developer using Loa
**I want** to query run state using beads commands
**So that** I have one consistent view of execution state

**Acceptance Criteria:**

- [ ] `br list --label run:current` shows current run state
- [ ] `br list --label circuit-breaker` shows halted runs
- [ ] `.run/` directory no longer needed for state persistence
- [ ] Existing `/run-status` command works unchanged (reads from beads)

#### US-4.2: Circuit Breaker as Bead

**As** a developer debugging a failed run
**I want** circuit breaker state stored as a bead
**So that** I can see failure history and patterns

**Acceptance Criteria:**

- [ ] Circuit breaker creates a bead with type `debt` on trigger
- [ ] Bead includes labels: `circuit-breaker`, `same-issue-{N}x`
- [ ] Failure details stored in bead description
- [ ] `br list --label circuit-breaker` shows all historical failures

#### US-4.3: State Migration

**As** a developer with existing `.run/` state
**I want** automatic migration to beads format
**So that** I don't lose in-progress work

**Acceptance Criteria:**

- [ ] Migration script reads `.run/state.json` and creates equivalent beads
- [ ] Sprint-plan-state migrated as epic bead with child task beads
- [ ] Migration is idempotent (safe to run multiple times)
- [ ] `.run/` can be deleted after successful migration

### Phase 5: Cron-Based Task Decomposition

#### US-5.1: Single-Task Agent Mode

**As** a cron job
**I want** to invoke `/implement` for exactly one task
**So that** sessions stay bounded and focused

**Acceptance Criteria:**

- [ ] `/implement --single-task` processes one ready task and exits
- [ ] Task is claimed at start (label: `in_progress`)
- [ ] Task is released on completion (label: `done`) or failure (label: `blocked`)
- [ ] Session completes in <30 minutes for typical tasks

#### US-5.2: Work Queue Processor

**As** a scheduler
**I want** a beads work queue that processes ready tasks
**So that** work continues automatically without manual intervention

**Acceptance Criteria:**

- [ ] `beads_work_queue` scheduler task registered
- [ ] Runs every 5 minutes (configurable)
- [ ] Claims first ready task from `br ready --json`
- [ ] Triggers single-task agent session
- [ ] Circuit breaker after 3 consecutive failures

#### US-5.3: Automatic Task Discovery

**As** a developer with a sprint plan
**I want** tasks automatically queued for processing
**So that** I can start a sprint and walk away

**Acceptance Criteria:**

- [ ] `/run sprint-plan` creates beads for all sprint tasks
- [ ] Tasks have `ready` label when dependencies satisfied
- [ ] Tasks have `blocked` label when waiting on dependencies
- [ ] Scheduler processes ready tasks in priority order

#### US-5.4: Session Handoff

**As** the current agent session
**I want** to persist my state to beads before exit
**So that** the next session can continue seamlessly

**Acceptance Criteria:**

- [ ] Current context summarized in bead comment before exit
- [ ] File changes tracked in bead metadata
- [ ] Next session picks up from bead state
- [ ] No information loss between sessions

---

## Requirements

### Functional Requirements

#### FR-4: Run-Mode Unification (Phase 4)

| ID     | Requirement                                                    | Priority |
| ------ | -------------------------------------------------------------- | -------- |
| FR-4.1 | Map run states to beads labels (READY/RUNNING/HALTED/COMPLETE) | P0       |
| FR-4.2 | Store circuit breaker as bead with `circuit-breaker` label     | P0       |
| FR-4.3 | Update `/run-status` to read from beads instead of `.run/`     | P0       |
| FR-4.4 | Update `/run` to write state to beads instead of `.run/`       | P0       |
| FR-4.5 | Create migration script for existing `.run/` state             | P1       |
| FR-4.6 | Update `/run-resume` to use beads state                        | P0       |
| FR-4.7 | Update `/run-halt` to use beads state                          | P0       |
| FR-4.8 | Deprecate `.run/` directory (warn if present)                  | P2       |

#### FR-5: Cron-Based Task Decomposition (Phase 5)

| ID     | Requirement                                                   | Priority |
| ------ | ------------------------------------------------------------- | -------- |
| FR-5.1 | Add `--single-task` flag to `/implement` command              | P0       |
| FR-5.2 | Register `beads_work_queue` scheduler task                    | P0       |
| FR-5.3 | Implement task claiming/release protocol                      | P0       |
| FR-5.4 | Add session handoff via bead comments                         | P1       |
| FR-5.5 | Update `/run sprint-plan` to create beads for all tasks       | P0       |
| FR-5.6 | Add `ready` calculation based on dependency labels            | P0       |
| FR-5.7 | Implement bounded session timeout (30 minutes default)        | P0       |
| FR-5.8 | Circuit breaker for work queue (3 failures = 30 min cooldown) | P0       |

### Non-Functional Requirements

| ID      | Requirement                  | Target                        |
| ------- | ---------------------------- | ----------------------------- |
| NFR-4.1 | State query latency          | <100ms for run status         |
| NFR-4.2 | Migration time               | <10s for typical sprint state |
| NFR-5.1 | Single-task session duration | <30 minutes (p95)             |
| NFR-5.2 | Token usage per task         | 50% reduction vs marathon     |
| NFR-5.3 | Work queue check latency     | <5 seconds                    |
| NFR-5.4 | Session handoff overhead     | <30 seconds                   |

---

## Technical Design

### Phase 4: State Mapping

```typescript
// Run state mapping to beads labels
const RUN_STATE_LABELS = {
  READY: [], // No in_progress epics
  RUNNING: ["run:current", "sprint:in_progress"], // Active sprint epic
  HALTED: ["run:current", "circuit-breaker"], // Halted with CB
  COMPLETE: ["run:complete"], // All sprints closed
};

// Query current run state
async function getRunState(): Promise<RunState> {
  const inProgress = await execAsync(`br list --label run:current --json`);
  const parsed = JSON.parse(inProgress);

  if (parsed.length === 0) return "READY";

  const current = parsed[0];
  if (current.labels.includes("circuit-breaker")) return "HALTED";
  if (current.labels.includes("sprint:in_progress")) return "RUNNING";

  return "COMPLETE";
}
```

### Phase 4: Circuit Breaker as Bead

```typescript
// Create circuit breaker bead on failure
async function createCircuitBreaker(
  sprintId: string,
  reason: string,
  failureCount: number,
): Promise<string> {
  const beadId = await execAsync(`br create "Circuit Breaker: ${sprintId}" \\
    --type debt \\
    --priority 0 \\
    --json`);

  await execAsync(`br label add ${beadId} circuit-breaker same-issue-${failureCount}x`);
  await execAsync(`br comment ${beadId} "Triggered: ${reason}"`);

  return beadId;
}
```

### Phase 5: Single-Task Session Flow

```
Single-Task Session (~30 minutes)
┌─────────────────────────────────────────────────────────────┐
│ 1. CLAIM (br update <task> --label in_progress)             │
│    └── Record session start in bead                         │
├─────────────────────────────────────────────────────────────┤
│ 2. EXECUTE (implement task)                                 │
│    ├── Read task requirements from bead                     │
│    ├── Implement changes                                    │
│    ├── Run tests                                            │
│    └── Update bead with progress                            │
├─────────────────────────────────────────────────────────────┤
│ 3. HANDOFF (br close <task> OR br label add blocked)        │
│    ├── If success: close task, record completion            │
│    ├── If failure: add blocked label, record reason         │
│    └── Summarize state for next session                     │
└─────────────────────────────────────────────────────────────┘
                              ↓
                    Session exits (cron reschedules)
```

### Phase 5: Work Queue Scheduler Task

```typescript
scheduler.register({
  id: "beads_work_queue",
  name: "Beads Work Queue Processor",
  intervalMs: 5 * 60 * 1000, // Check every 5 minutes
  jitterMs: 30 * 1000, // ±30s jitter

  handler: async () => {
    // Get ready work
    const ready = await execAsync(`br ready --json`);
    const tasks = JSON.parse(ready);

    if (tasks.length === 0) {
      console.log("[beads-work-queue] No ready tasks");
      return;
    }

    // Claim first task
    const task = tasks[0];
    await execAsync(`br label add ${task.id} in_progress`);

    // Trigger single-task agent session
    await triggerAgentSession({
      command: `/implement --single-task ${task.id}`,
      timeout: "30m",
    });
  },

  circuitBreaker: {
    maxFailures: 3,
    resetTimeMs: 30 * 60 * 1000, // 30 min cooldown
  },
});
```

---

## Architecture Overview

### Target State (Post Phase 4-5)

```
┌───────────────────────────────────────────────────────────────────┐
│                    Unified Beads Architecture                      │
├───────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐   │
│  │  Scheduler  │    │   Skills    │    │  /run Commands      │   │
│  │             │    │             │    │                     │   │
│  │ work_queue  │    │ /implement  │    │ /run-status         │   │
│  │ health      │    │ /review     │    │ /run-halt           │   │
│  │ sync        │    │ /audit      │    │ /run-resume         │   │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘   │
│         │                  │                       │              │
│         └──────────────────┼───────────────────────┘              │
│                            │                                       │
│                            ▼                                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                    BEADS (Single Source of Truth)         │    │
│  │                                                           │    │
│  │  ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐  │    │
│  │  │ Sprint  │   │  Task   │   │ Circuit │   │ Session │  │    │
│  │  │ Epics   │   │ Beads   │   │ Breaker │   │ State   │  │    │
│  │  │         │   │         │   │ Beads   │   │ (labels)│  │    │
│  │  └─────────┘   └─────────┘   └─────────┘   └─────────┘  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                            │                                       │
│                            ▼                                       │
│                 ┌─────────────────────┐                           │
│                 │      .beads/        │                           │
│                 │  beads.db (SQLite)  │ ←── WAL Recovery          │
│                 │  issues.jsonl       │ ←── R2 Sync               │
│                 └─────────────────────┘                           │
│                                                                    │
│                     ❌ .run/ (DEPRECATED)                          │
│                                                                    │
└───────────────────────────────────────────────────────────────────┘
```

### Token Efficiency Comparison

```
BEFORE (Marathon Session):
┌─────────────────────────────────────────────────────────────┐
│ Session 1 (8 hours):                                        │
│   Context: PRD + SDD + Sprint + Task 1-N                    │
│   Tokens: ~500K input, ~200K output                         │
│   Risk: Context overflow at task 10+                        │
└─────────────────────────────────────────────────────────────┘
   Total: 700K tokens

AFTER (Bounded Sessions):
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Session 1 (30m): │  │ Session 2 (30m): │  │ Session N (30m): │
│   Context: Task 1│  │   Context: Task 2│  │   Context: Task N│
│   Tokens: ~30K   │  │   Tokens: ~30K   │  │   Tokens: ~30K   │
└──────────────────┘  └──────────────────┘  └──────────────────┘
   Total: N × 30K tokens (50%+ savings for N > 10)
```

---

## Risk Assessment

| Risk                      | Likelihood | Impact | Mitigation                      |
| ------------------------- | ---------- | ------ | ------------------------------- |
| Migration data loss       | Low        | High   | Idempotent migration + backup   |
| State query performance   | Low        | Medium | Index labels, cache hot paths   |
| Session timeout mid-task  | Medium     | Medium | Graceful handoff on SIGTERM     |
| Cron thundering herd      | Low        | Low    | Jitter + single-task claiming   |
| Dependency cycle in tasks | Low        | Medium | Validate DAG on sprint creation |

---

## Dependencies

### Internal (Completed in Phase 1-3)

- BeadsWALAdapter (`deploy/loa-identity/beads/beads-wal-adapter.ts`)
- BeadsSchedulerTasks (`deploy/loa-identity/beads/beads-scheduler-tasks.ts`)
- BeadsRecoveryHandler (`deploy/loa-identity/beads/beads-recovery.ts`)

### External

- beads_rust CLI (`br` command with `--json` output)
- Existing `/run` skill infrastructure

---

## Configuration

### New Configuration Keys

```yaml
# In .loa.config.yaml
beads:
  # Phase 4: Run-Mode Unification
  run_mode:
    enabled: true # Use beads for run state
    deprecate_dotrun: true # Warn if .run/ exists
    migration_auto: false # Auto-migrate on first access

  # Phase 5: Cron-Based Task Decomposition
  work_queue:
    enabled: true # Enable work queue processor
    interval_ms: 300000 # Check every 5 minutes
    session_timeout_ms: 1800000 # 30 minute max session
    single_task_default: true # /implement uses single-task by default

run_mode:
  # Backward compatibility (deprecated)
  enabled: true # Still honored, delegates to beads
```

### Environment Variables

| Variable                  | Purpose                      | Default   |
| ------------------------- | ---------------------------- | --------- |
| `LOA_BEADS_RUN_MODE`      | Enable beads-based run state | `true`    |
| `LOA_BEADS_WORK_QUEUE`    | Enable work queue processor  | `true`    |
| `LOA_SINGLE_TASK_TIMEOUT` | Session timeout (ms)         | `1800000` |

---

## Rollout Plan

### Phase 4: Run-Mode Unification (Sprint 1)

1. **Day 1-2**: Implement state mapping and label schema
2. **Day 2-3**: Update `/run-status`, `/run-halt`, `/run-resume`
3. **Day 3-4**: Update `/run` to write beads state
4. **Day 4-5**: Create migration script and testing

### Phase 5: Cron-Based Decomposition (Sprint 2)

1. **Day 1-2**: Implement `--single-task` flag for `/implement`
2. **Day 2-3**: Register `beads_work_queue` scheduler task
3. **Day 3-4**: Implement session handoff protocol
4. **Day 4-5**: Update `/run sprint-plan` for task creation

### Validation

1. Run existing `/run sprint-plan` test suite
2. Verify token usage reduction with sample sprint
3. Stress test with simulated crashes between sessions

---

## Success Criteria

### Phase 4 Complete When:

- [ ] `/run-status` reads exclusively from beads
- [ ] Circuit breaker is a bead with proper labels
- [ ] `.run/` directory can be safely deleted
- [ ] Migration script handles all existing state formats
- [ ] All `/run` command tests pass

### Phase 5 Complete When:

- [ ] `--single-task` flag implemented and tested
- [ ] Work queue processes tasks automatically
- [ ] Session handoff preserves context between sessions
- [ ] Token usage reduced by >50% vs marathon sessions
- [ ] Average session length <30 minutes (p95)

---

## Open Questions

1. **Q**: How to handle mid-task crashes in single-task mode?
   **A**: SIGTERM handler writes handoff comment. On next claim, session reads handoff and continues.

2. **Q**: Should sessions share context via beads or fresh each time?
   **A**: Fresh context with bead comments for continuity. Keeps sessions bounded.

3. **Q**: What if work queue is disabled but tasks exist?
   **A**: Manual `/implement --single-task <id>` still works. Cron is opt-in.

4. **Q**: How to prioritize tasks in the queue?
   **A**: Use bead priority field. P0 > P1 > P2. Within priority, FIFO.

---

## Appendix

### Related Documents

- Beads Integration Review: `grimoires/loa/a2a/audits/2026-02-04-beads-review/BEADS-INTEGRATION-REVIEW.md`
- Phase 1-3 PRD: `grimoires/loa/beads-openclaw-prd.md`
- Run-Mode Skill: `.claude/skills/run-mode/SKILL.md`
- Beads Protocol: `.claude/protocols/beads-integration.md`

### Label Schema

| Label Pattern        | Purpose                         |
| -------------------- | ------------------------------- |
| `run:current`        | Currently executing run         |
| `run:complete`       | Completed run                   |
| `sprint:N`           | Sprint number                   |
| `sprint:in_progress` | Active sprint                   |
| `circuit-breaker`    | Halted due to repeated failures |
| `same-issue-Nx`      | Failed N times on same issue    |
| `in_progress`        | Task currently being worked     |
| `ready`              | Task ready for processing       |
| `blocked`            | Task waiting on dependency      |
| `done`               | Task completed                  |
| `handoff:session-id` | Session that last touched task  |

### Glossary

| Term             | Definition                                          |
| ---------------- | --------------------------------------------------- |
| Marathon session | Unbounded 4-8 hour agent session                    |
| Bounded session  | Session with max 30 minute timeout                  |
| Single-task mode | Agent processes exactly one task per session        |
| Work queue       | Scheduler-driven task processor                     |
| Session handoff  | Protocol for preserving state between sessions      |
| State divergence | When .run/ and .beads/ have conflicting information |

---

_"The Loa never forgets - because the Loa's memory is persistent."_
