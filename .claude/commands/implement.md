---
name: "implement"
version: "1.2.0"
description: |
  Execute sprint tasks with production-quality code and tests.
  Automatically checks for and addresses audit/review feedback before new work.
  Resolves local sprint IDs to global IDs via Sprint Ledger.
  If beads_rust is installed, handles task lifecycle automatically (no manual br commands).

arguments:
  - name: "sprint_id"
    type: "string"
    pattern: "^sprint-[0-9]+$"
    required: true
    description: "Sprint to implement (e.g., sprint-1)"
    examples: ["sprint-1", "sprint-2", "sprint-10"]
  - name: "single_task"
    type: "boolean"
    flag: "--single-task"
    required: false
    default: false
    description: "Process only one task in bounded session mode (30-min window)"

agent: "implementing-tasks"
agent_path: "skills/implementing-tasks/"

context_files:
  - path: ".claude/context/gpt-review-active.md"
    required: false
    purpose: "GPT cross-model review instructions (if enabled)"
  - path: "grimoires/loa/a2a/integration-context.md"
    required: false
    purpose: "Organizational context and MCP tools"
  - path: "grimoires/loa/prd.md"
    required: true
    purpose: "Product requirements for grounding"
  - path: "grimoires/loa/sdd.md"
    required: true
    purpose: "Architecture decisions"
  - path: "grimoires/loa/sprint.md"
    required: true
    purpose: "Sprint tasks and acceptance criteria"
  - path: "grimoires/loa/ledger.json"
    required: false
    purpose: "Sprint Ledger for ID resolution"
  - path: "grimoires/loa/a2a/$ARGUMENTS.sprint_id/auditor-sprint-feedback.md"
    required: false
    priority: 1
    purpose: "Security audit feedback (checked FIRST)"
  - path: "grimoires/loa/a2a/$ARGUMENTS.sprint_id/engineer-feedback.md"
    required: false
    priority: 2
    purpose: "Senior lead feedback"

pre_flight:
  - check: "pattern_match"
    value: "$ARGUMENTS.sprint_id"
    pattern: "^sprint-[0-9]+$"
    error: "Invalid sprint ID. Expected format: sprint-N (e.g., sprint-1)"

  - check: "file_exists"
    path: "grimoires/loa/prd.md"
    error: "PRD not found. Run /plan-and-analyze first."

  - check: "file_exists"
    path: "grimoires/loa/sdd.md"
    error: "SDD not found. Run /architect first."

  - check: "file_exists"
    path: "grimoires/loa/sprint.md"
    error: "Sprint plan not found. Run /sprint-plan first."

  - check: "content_contains"
    path: "grimoires/loa/sprint.md"
    pattern: "$ARGUMENTS.sprint_id"
    error: "Sprint $ARGUMENTS.sprint_id not found in sprint.md"

  - check: "script"
    script: ".claude/scripts/validate-sprint-id.sh"
    args: ["$ARGUMENTS.sprint_id"]
    store_result: "sprint_resolution"
    purpose: "Resolve local sprint ID to global ID via ledger"

outputs:
  - path: "grimoires/loa/a2a/$RESOLVED_SPRINT_ID/"
    type: "directory"
    description: "Sprint A2A directory (uses global ID)"
  - path: "grimoires/loa/a2a/$RESOLVED_SPRINT_ID/reviewer.md"
    type: "file"
    description: "Implementation report for senior review"
  - path: "grimoires/loa/a2a/index.md"
    type: "file"
    description: "Sprint index (updated)"
  - path: "grimoires/loa/ledger.json"
    type: "file"
    description: "Sprint Ledger (status updated)"
  - path: "app/src/**/*"
    type: "glob"
    description: "Implementation code and tests"

mode:
  default: "foreground"
  allow_background: true
---

# Implement Sprint

## Purpose

Execute assigned sprint tasks with production-quality code, comprehensive tests, and detailed implementation report for senior review.

## Invocation

```
/implement sprint-1
/implement sprint-1 background
/implement sprint-1 --single-task     # Process only one task in bounded session
```

## Agent

Launches `implementing-tasks` from `skills/implementing-tasks/`.

See: `skills/implementing-tasks/SKILL.md` for full workflow details.

## Workflow

1. **Pre-flight**: Validate sprint ID, check setup, verify prerequisites
2. **Directory Setup**: Create `grimoires/loa/a2a/{sprint_id}/` if needed
3. **Feedback Check**: Audit feedback (priority 1) → Engineer feedback (priority 2)
4. **Context Loading**: Read PRD, SDD, sprint plan for requirements
5. **Implementation**: Execute tasks with production-quality code and tests
6. **Report Generation**: Create `reviewer.md` with full implementation details
7. **Index Update**: Update `grimoires/loa/a2a/index.md` with sprint status
8. **Analytics**: Update usage metrics (THJ users only)

## Arguments

| Argument        | Description                                                   | Required |
| --------------- | ------------------------------------------------------------- | -------- |
| `sprint_id`     | Which sprint to implement (e.g., `sprint-1`)                  | Yes      |
| `background`    | Run as subagent for parallel execution                        | No       |
| `--single-task` | Process only one task in bounded session mode (30-min window) | No       |

## Outputs

| Path                                        | Description                   |
| ------------------------------------------- | ----------------------------- |
| `grimoires/loa/a2a/{sprint_id}/reviewer.md` | Implementation report         |
| `grimoires/loa/a2a/index.md`                | Updated sprint index          |
| `app/src/**/*`                              | Implementation code and tests |

## Error Handling

| Error                           | Cause                   | Resolution                    |
| ------------------------------- | ----------------------- | ----------------------------- |
| "Invalid sprint ID"             | Wrong format            | Use `sprint-N` format         |
| "PRD not found"                 | Missing prd.md          | Run `/plan-and-analyze` first |
| "SDD not found"                 | Missing sdd.md          | Run `/architect` first        |
| "Sprint plan not found"         | Missing sprint.md       | Run `/sprint-plan` first      |
| "Sprint not found in sprint.md" | Sprint doesn't exist    | Verify sprint number          |
| "Sprint is already COMPLETED"   | COMPLETED marker exists | Move to next sprint           |

## Sprint Ledger Integration

When a Sprint Ledger exists (`grimoires/loa/ledger.json`):

1. **ID Resolution**: Resolves `sprint-1` (local) to global ID (e.g., `3`)
2. **Directory Mapping**: Uses `a2a/sprint-3/` instead of `a2a/sprint-1/`
3. **Status Update**: Sets sprint status to `in_progress` in ledger
4. **Completion**: On approval, status updated to `completed`

### Example Resolution

```bash
# In cycle-002, sprint-1 maps to global sprint-3
/implement sprint-1
# → Resolving sprint-1 to global sprint-3
# → Using directory: grimoires/loa/a2a/sprint-3/
# → Setting status: in_progress
```

### Legacy Mode

Without a ledger, sprint IDs are used directly (sprint-1 → a2a/sprint-1/).

## Feedback Loop

```
/implement sprint-N
      ↓
[reviewer.md created]
      ↓
/review-sprint sprint-N
      ↓
[feedback or approval]
      ↓
If feedback: /implement sprint-N (addresses feedback)
If approved: /audit-sprint sprint-N
```

## beads_rust Integration

When beads_rust is installed, the agent handles task lifecycle:

1. **Session Start**: `br sync --import-only` to import latest state
2. **Get Work**: `br ready` to find unblocked tasks
3. **Claim Task**: `br update <id> --status in_progress`
4. **Log Discoveries**: `.claude/scripts/beads/log-discovered-issue.sh` for found bugs
5. **Complete Task**: `br close <id> --reason "..."`
6. **Session End**: `br sync --flush-only` before commit

**No manual `br` commands required.** The agent handles everything internally.

**Protocol Reference**: See `.claude/protocols/beads-integration.md`

## Single-Task Mode (`--single-task`)

When the `--single-task` flag is provided, the agent operates in bounded session mode:

### Behavior

1. **Task Claiming**: Claims ONE ready task from BeadsWorkQueue using priority ordering
2. **Session Tracking**: Adds `session:<uuid>` label for traceability
3. **Bounded Execution**: Works on the single task within the 30-minute session window
4. **Session Handoff**: Records context (files changed, progress, next steps) for continuation
5. **Release**: Marks task as `done` or `blocked` (never leaves `in_progress` without handoff)

### Work Queue Integration

When single-task mode is active, the agent:

```bash
# 1. Claim next ready task (highest priority first)
claim = workQueue.claimNextTask()

# 2. Get previous session context if resuming
previous = workQueue.getPreviousHandoff(taskId)

# 3. Execute work within bounded window...

# 4. Record handoff before session ends
workQueue.recordHandoff(taskId, {
  sessionId,
  filesChanged,
  currentState,
  nextSteps,
  tokensUsed
})

# 5. Release task with appropriate status
workQueue.releaseTask(taskId, "done" | "blocked", reason?)
```

### Use Cases

- **Token Budget Management**: Process one task per context window
- **Parallel Agent Execution**: Multiple agents work different tasks concurrently
- **Fault Tolerance**: Session crashes preserve handoff context
- **Time Banking**: Scheduler allocates fixed time windows per task

### Label Flow

```
TASK_READY → (claim) → TASK_IN_PROGRESS + session:<uuid>
    → (complete) → TASK_DONE + close
    → (blocked) → TASK_BLOCKED + handoff:<session>
```

**Protocol Reference**: See `deploy/loa-identity/beads/beads-work-queue.ts`
