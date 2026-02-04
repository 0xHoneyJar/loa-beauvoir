# Beads Integration Review: Loa × OpenClaw Architecture

> **Review Date**: 2026-02-05
> **Reviewer**: Claude Opus 4.5
> **Scope**: beads_rust integration, skill persistence, cron decomposition
> **Branch**: feature/loa-review

---

## Executive Summary

Loa's beads_rust integration is **architecturally sound** but has **significant gaps in OpenClaw persistence integration**. The current implementation uses SQLite + JSONL sync which survives git operations but **does not leverage OpenClaw's WAL, R2, or scheduler infrastructure**.

**Verdict**: Requires enhancement to achieve elite-tier integration.

### Key Findings

| Area                        | Status        | Priority |
| --------------------------- | ------------- | -------- |
| Beads core implementation   | ✅ Solid      | -        |
| Skill integration           | ⚠️ Partial    | HIGH     |
| Persistent storage (R2/WAL) | ❌ Missing    | CRITICAL |
| Cron job decomposition      | ❌ Missing    | HIGH     |
| Run-mode state alignment    | ⚠️ Misaligned | MEDIUM   |

---

## Current Architecture Analysis

### Beads Storage Model

```
Current:
┌─────────────────────────────────────────────────────────┐
│                    .beads/ (git-tracked)                │
├─────────────────────────────────────────────────────────┤
│  beads.db (SQLite)    ←→    issues.jsonl (JSONL)        │
│       ↑                           ↑                      │
│  Fast queries              Git collaboration             │
│  Session-local             Cross-session                 │
└─────────────────────────────────────────────────────────┘
                              ↓
                    git commit/push (manual)
```

**Problem**: No integration with OpenClaw's persistence layer:

- R2 sync (30s interval) doesn't include `.beads/`
- WAL doesn't record bead state transitions
- No crash recovery for mid-task failures
- No cron-based consolidation or health checks

### What OpenClaw Provides (Unused)

| Mechanism           | Purpose               | Current Beads Usage |
| ------------------- | --------------------- | ------------------- |
| **WAL**             | Crash-resilient state | NOT USED            |
| **R2 Sync**         | Cloud backup (30s)    | NOT USED            |
| **Scheduler**       | Periodic tasks        | NOT USED            |
| **Memory/Learning** | Semantic extraction   | NOT USED            |
| **Recovery Engine** | Multi-source fallback | NOT USED            |

---

## Skill Integration Audit

### Current State Matrix

| Skill                  | Beads? | Session Start           | Session End            | Gaps                      |
| ---------------------- | ------ | ----------------------- | ---------------------- | ------------------------- |
| **planning-sprints**   | ✅     | `br sync --import-only` | `br sync --flush-only` | No WAL recording          |
| **implementing-tasks** | ✅     | `br sync --import-only` | `br sync --flush-only` | No crash recovery         |
| **reviewing-code**     | ✅     | `br sync --import-only` | `br sync --flush-only` | OK for read-heavy         |
| **auditing-security**  | ✅     | `br sync --import-only` | `br sync --flush-only` | OK for read-heavy         |
| **run-mode**           | ❌     | Custom `.run/` state    | Custom `.run/` state   | **PARALLEL STATE SYSTEM** |
| **autonomous-agent**   | ❌     | Trajectory only         | Trajectory only        | Orchestrator, OK          |

### Critical Issue: Run-Mode Parallel State

Run-mode maintains its own state machine in `.run/`:

- `state.json` - Run progress
- `sprint-plan-state.json` - Multi-sprint tracking
- `circuit-breaker.json` - Failure handling

**This duplicates beads concepts without integration.**

```
Problem:
┌────────────────┐         ┌────────────────┐
│   .beads/      │         │   .run/        │
│   beads.db     │         │   state.json   │
│   (Task state) │    ≠    │   (Run state)  │
└────────────────┘         └────────────────┘
     ↑ NOT SYNCED ↑
```

---

## Elite-Tier Enhancement Plan

### Phase 1: WAL Integration (CRITICAL)

Record every bead state transition to WAL for crash recovery.

**New file**: `deploy/loa-identity/beads/beads-wal-adapter.ts`

```typescript
interface BeadWALEntry {
  operation: "create" | "update" | "close" | "label" | "comment";
  beadId: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

class BeadsWALAdapter {
  constructor(private wal: WALManager) {}

  async recordTransition(entry: BeadWALEntry): Promise<number> {
    return this.wal.append(
      "bead_transition",
      `.beads/transitions/${entry.beadId}`,
      Buffer.from(JSON.stringify(entry)),
    );
  }

  async replayTransitions(since?: number): Promise<BeadWALEntry[]> {
    const entries: BeadWALEntry[] = [];
    await this.wal.replay((op, path, data) => {
      if (op === "bead_transition") {
        entries.push(JSON.parse(data.toString()));
      }
    });
    return entries;
  }
}
```

**Integration points**:

1. Hook into `br` command wrapper
2. Record before SQLite write
3. Replay on session start (crash recovery)

### Phase 2: R2 Sync Integration (HIGH)

Add `.beads/` to R2 sync path.

**Modify**: `upstream/moltworker/src/gateway/sync.ts`

```typescript
const SYNC_PATHS = [
  ".openclaw/config",
  ".openclaw/credentials",
  "grimoires/loa/a2a/compound/", // Existing
  ".beads/", // NEW: Add beads directory
];
```

**R2 Sync benefits**:

- 30-second cloud backup
- Multi-device sync
- Recovery fallback source

### Phase 3: Scheduler Integration (HIGH)

Add beads-specific scheduled tasks.

**New tasks in** `createBeauvoirScheduler()`:

```typescript
// Beads health check - every 15 minutes
scheduler.register({
  id: "beads_health",
  name: "Beads Health Check",
  intervalMs: 15 * 60 * 1000,
  jitterMs: 60 * 1000,
  handler: async () => {
    const result = await execAsync("br doctor --json");
    if (JSON.parse(result).status !== "healthy") {
      throw new Error("Beads unhealthy");
    }
  },
});

// Beads sync - every 5 minutes (supplement git sync)
scheduler.register({
  id: "beads_sync",
  name: "Beads Sync",
  intervalMs: 5 * 60 * 1000,
  jitterMs: 30 * 1000,
  handler: async () => {
    await execAsync("br sync --flush-only");
  },
  mutexGroup: "beads",
});

// Stale issue alert - daily
scheduler.register({
  id: "beads_stale_check",
  name: "Beads Stale Check",
  intervalMs: 24 * 60 * 60 * 1000,
  jitterMs: 60 * 60 * 1000,
  handler: async () => {
    const stale = await execAsync("br stale --days 7 --json");
    const issues = JSON.parse(stale);
    if (issues.length > 0) {
      console.warn(`[beads] ${issues.length} stale issues found`);
      // Could trigger notification
    }
  },
});
```

### Phase 4: Run-Mode Unification (MEDIUM)

Unify run-mode state with beads.

**Strategy**: Use beads as the source of truth, run-mode reads from it.

**Changes to `.claude/skills/run-mode/SKILL.md`**:

```yaml
# Session state moves to beads
Run State Mapping:
  READY     → No in_progress epics
  RUNNING   → Has in_progress epic with sprint:current label
  HALTED    → Has in_progress epic with circuit-breaker label
  COMPLETE  → All sprint epics closed

# Circuit breaker becomes a bead
br create "Circuit Breaker: Sprint N" --type debt --priority 0
br label add <id> circuit-breaker same-issue-3x
```

**Benefits**:

- Single source of truth
- Persistent across sessions
- Git-trackable run history
- Query-able with `br list`

### Phase 5: Cron Job Decomposition (HIGH)

Convert long-running agent tasks to reliable cron jobs.

**Current anti-pattern** (token-heavy, unreliable):

```
Agent session: 8 hours
├── Implement task 1 (45 min)
├── Review task 1 (15 min)
├── Audit task 1 (20 min)
├── ... context overflow risk ...
├── Implement task N
└── Create PR
```

**Elite pattern** (cron-based, token-efficient):

```typescript
// Cron-triggered task execution
scheduler.register({
  id: "beads_work_queue",
  name: "Beads Work Queue Processor",
  intervalMs: 5 * 60 * 1000, // Check every 5 minutes
  handler: async () => {
    // Get ready work
    const ready = await execAsync("br ready --json");
    const tasks = JSON.parse(ready);

    if (tasks.length === 0) return;

    // Claim first task
    const task = tasks[0];
    await execAsync(`br update ${task.id} --status in_progress`);

    // Trigger single-task agent session
    await triggerAgentSession({
      task: task.id,
      mode: "single-task", // NEW: Exit after one task
      timeout: "30m",
    });
  },
  circuitBreaker: {
    maxFailures: 3,
    resetTimeMs: 30 * 60 * 1000, // 30 min cooldown
  },
});
```

**Single-task agent session**:

```
Session: ~30 minutes (bounded)
├── Import state (br sync)
├── Get assigned task (already claimed)
├── Implement task
├── Mark complete (br close)
├── Export state (br sync)
└── Exit (cron reschedules next)
```

**Benefits**:

- **Token savings**: 30min sessions vs 8hr sessions
- **Reliability**: Cron ensures progress even with failures
- **Observability**: Each task is a discrete unit
- **Recovery**: Failed task retries automatically

### Phase 6: Memory/Learning Integration (FUTURE)

Extract patterns from bead history for learning store.

```typescript
// Extract learnings from completed sprints
async function extractSprintLearnings(sprintId: string) {
  const epic = await execAsync(`br show ${sprintId} --json`);
  const tasks = await execAsync(`br list --json`);

  // Find tasks in this sprint
  const sprintTasks = JSON.parse(tasks).filter((t) => t.labels?.includes(`epic:${sprintId}`));

  // Calculate metrics
  const metrics = {
    totalTasks: sprintTasks.length,
    discoveredBugs: sprintTasks.filter((t) =>
      t.labels?.some((l) => l.startsWith("discovered-during:")),
    ).length,
    avgCloseTime: calculateAvgCloseTime(sprintTasks),
    blockingPatterns: findBlockingPatterns(sprintTasks),
  };

  // Store as learning
  return {
    trigger: `sprint_completed:${sprintId}`,
    pattern: `Sprint had ${metrics.discoveredBugs} discovered issues (${((metrics.discoveredBugs / metrics.totalTasks) * 100).toFixed(0)}% discovery rate)`,
    recommendation:
      metrics.discoveredBugs > 3
        ? "Consider more thorough upfront design"
        : "Discovery rate acceptable",
  };
}
```

---

## Implementation Priority Matrix

| Phase                   | Effort | Impact   | Dependencies   | Sprint |
| ----------------------- | ------ | -------- | -------------- | ------ |
| 1. WAL Integration      | Medium | CRITICAL | WAL manager    | 1      |
| 2. R2 Sync              | Small  | HIGH     | R2 client      | 1      |
| 3. Scheduler Tasks      | Small  | HIGH     | Scheduler      | 1      |
| 4. Run-Mode Unification | Large  | MEDIUM   | Phase 1-3      | 2      |
| 5. Cron Decomposition   | Large  | HIGH     | Phase 3        | 2      |
| 6. Learning Integration | Medium | LOW      | Learning store | 3      |

---

## Specific File Changes Required

### New Files

```
deploy/loa-identity/beads/
├── beads-wal-adapter.ts      # WAL integration
├── beads-recovery.ts         # Crash recovery from WAL
└── beads-cron-worker.ts      # Single-task agent trigger

.claude/scripts/beads/
├── cron-process-task.sh      # Called by cron worker
└── recover-from-wal.sh       # WAL replay utility
```

### Modified Files

| File                                              | Change                                         |
| ------------------------------------------------- | ---------------------------------------------- |
| `upstream/moltworker/src/gateway/sync.ts`         | Add `.beads/` to SYNC_PATHS                    |
| `deploy/loa-identity/scheduler/scheduler.ts`      | Add beads tasks to `createBeauvoirScheduler()` |
| `deploy/loa-identity/recovery/recovery-engine.ts` | Add beads recovery source                      |
| `.claude/skills/run-mode/SKILL.md`                | Document beads integration                     |
| `.claude/skills/implementing-tasks/SKILL.md`      | Add single-task mode                           |
| `.claude/protocols/beads-integration.md`          | Document WAL/cron patterns                     |

---

## Risk Analysis

| Risk                 | Likelihood | Impact | Mitigation                     |
| -------------------- | ---------- | ------ | ------------------------------ |
| WAL corruption       | Low        | High   | Checksums + backup             |
| R2 sync conflict     | Medium     | Medium | Last-write-wins + manual merge |
| Cron thundering herd | Low        | Medium | Jitter (already implemented)   |
| Beads SQLite lock    | Medium     | Low    | Single-writer via mutex        |

---

## Success Criteria

### Phase 1 Complete When:

- [ ] Beads state survives container restart
- [ ] WAL records every `br create/update/close`
- [ ] Crash recovery replays WAL to SQLite

### Phase 2 Complete When:

- [ ] `.beads/` appears in R2 within 30 seconds of change
- [ ] New container instance inherits beads state from R2

### Phase 3 Complete When:

- [ ] `beads_health` task running in scheduler
- [ ] `beads_sync` task running every 5 minutes
- [ ] Stale issues generate console warnings

### Phase 4 Complete When:

- [ ] Run-mode reads state from beads
- [ ] Circuit breaker is a bead with labels
- [ ] `.run/` directory deprecated

### Phase 5 Complete When:

- [ ] Single-task agent mode implemented
- [ ] Cron triggers task processing every 5 minutes
- [ ] Average session length < 30 minutes
- [ ] Token usage reduced by >50%

---

## Conclusion

Loa's beads integration has a **solid foundation** but requires **deep OpenClaw integration** to achieve elite-tier reliability. The proposed enhancements leverage OpenClaw's existing infrastructure (WAL, R2, Scheduler) to provide:

1. **Crash resilience** via WAL
2. **Cloud persistence** via R2
3. **Automated maintenance** via Scheduler
4. **Token efficiency** via cron decomposition
5. **Unified state** via run-mode alignment

The cron decomposition pattern is particularly powerful - converting 8-hour agent marathons into 30-minute bounded sessions dramatically improves reliability and cost efficiency.

**Recommended next step**: Create PRD/SDD/Sprint for Phase 1-3 as a single sprint.

---

_"The Loa rides through storms - but now with persistent memory."_
