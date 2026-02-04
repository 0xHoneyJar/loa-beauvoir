# /run-resume Command

## Purpose

Resume a halted run from last checkpoint. Resolves circuit breakers, validates branch integrity, and continues execution.

**Primary data source**: BeadsRunStateManager (Phase 4+)
**Fallback**: .run/ state files (legacy, deprecated)

## Usage

```
/run-resume
/run-resume --reset-ice
/run-resume --force
/run-resume --legacy        # Force .run/ files only (deprecated)
```

## Options

| Option        | Description                                  | Default |
| ------------- | -------------------------------------------- | ------- |
| `--reset-ice` | Resolve all circuit breakers before resuming | false   |
| `--force`     | Skip branch divergence check                 | false   |
| `--legacy`    | Use .run/ files only (deprecated)            | false   |

## Pre-flight Checks

### Primary: BeadsRunStateManager

```typescript
import { createBeadsRunStateManager } from "deploy/loa-identity/beads/index.js";

async function preflightResume(resetIce: boolean, force: boolean) {
  const manager = createBeadsRunStateManager();
  const state = await manager.getRunState();

  // 1. Verify state is HALTED
  if (state === "READY") {
    console.log("ERROR: No run in progress");
    console.log("Start a new run with /run sprint-N");
    process.exit(1);
  }

  if (state === "RUNNING") {
    console.log("ERROR: Run is already in progress");
    console.log("Use /run-status to check current state.");
    process.exit(1);
  }

  if (state === "COMPLETE") {
    console.log("ERROR: Run is already complete");
    console.log("Start a new run with /run sprint-N");
    process.exit(1);
  }

  // state === 'HALTED' - this is what we want

  // 2. Check for active circuit breakers
  const circuitBreakers = await manager.getActiveCircuitBreakers();

  if (circuitBreakers.length > 0 && !resetIce) {
    console.log("WARNING: Circuit breaker is OPEN");
    console.log("");

    for (const cb of circuitBreakers) {
      console.log(`Circuit breaker: ${cb.beadId}`);
      console.log(`  Sprint:    ${cb.sprintId}`);
      console.log(`  Reason:    ${cb.reason}`);
      console.log(`  Failures:  ${cb.failureCount}x`);
      console.log(`  Created:   ${cb.createdAt}`);
    }

    console.log("");
    console.log("To resolve circuit breakers and continue:");
    console.log("  /run-resume --reset-ice");
    console.log("");
    console.log("To view circuit breakers:");
    console.log("  br list --label circuit-breaker --status open");
    process.exit(1);
  }

  // 3. Verify branch matches (if not --force)
  if (!force) {
    await checkBranchDivergence();
  }
}
```

### Check Branch Divergence

```typescript
async function checkBranchDivergence() {
  const exec = promisify(require("child_process").exec);

  const { stdout: currentBranch } = await exec("git branch --show-current");
  const branch = currentBranch.trim();

  // Fetch latest from remote
  try {
    await exec(`git fetch origin ${branch}`);
  } catch {
    // Remote branch may not exist, that's fine
    return;
  }

  const { stdout: localHead } = await exec("git rev-parse HEAD");
  let remoteHead: string;
  try {
    const { stdout } = await exec(`git rev-parse origin/${branch}`);
    remoteHead = stdout.trim();
  } catch {
    // Remote branch doesn't exist yet
    return;
  }

  // Check if they're the same
  if (localHead.trim() === remoteHead) {
    return;
  }

  // Check if local is ahead of remote (that's fine)
  try {
    await exec(`git merge-base --is-ancestor origin/${branch} HEAD`);
    return; // Local is ahead, that's fine
  } catch {
    // Branch has diverged
  }

  console.log("ERROR: Branch has diverged from remote");
  console.log("");
  console.log(`Local:  ${localHead.trim()}`);
  console.log(`Remote: ${remoteHead}`);
  console.log("");
  console.log("This can happen if:");
  console.log("  - Someone else pushed to the branch");
  console.log("  - You made changes outside of Run Mode");
  console.log("");
  console.log("To force resume (may cause conflicts):");
  console.log("  /run-resume --force");
  console.log("");
  console.log(`To sync with remote first:`);
  console.log(`  git pull --rebase origin ${branch}`);
  process.exit(1);
}
```

## Execution Flow

### Resume Run

```typescript
import { createBeadsRunStateManager } from "deploy/loa-identity/beads/index.js";

async function resumeRun(resetIce: boolean) {
  const manager = createBeadsRunStateManager();

  // Get current sprint info
  const currentSprint = await manager.getCurrentSprint();
  const sprints = await manager.getSprintPlan();

  console.log("[RESUME] Continuing run...");
  if (currentSprint) {
    console.log(`Sprint: ${currentSprint.sprintNumber}`);
    console.log(`Tasks: ${currentSprint.tasksCompleted}/${currentSprint.tasksTotal}`);
  }

  // Reset circuit breakers if requested
  if (resetIce) {
    await resetCircuitBreakers(manager);
  }

  // Resume the run (this clears HALTED state)
  await manager.resumeRun();

  console.log("");
  console.log("✓ State updated to RUNNING");
  console.log("");
  console.log("Run will resume execution.");

  // Continue execution based on current sprint
  if (currentSprint) {
    console.log(`Continuing sprint ${currentSprint.sprintNumber}...`);
  } else {
    // Find next pending sprint
    const pendingSprints = sprints.filter((s) => s.status === "pending");
    if (pendingSprints.length > 0) {
      console.log(`Starting sprint ${pendingSprints[0].sprintNumber}...`);
    }
  }
}
```

### Reset Circuit Breakers

```typescript
async function resetCircuitBreakers(manager: BeadsRunStateManager) {
  console.log("Resolving circuit breakers...");

  const circuitBreakers = await manager.getActiveCircuitBreakers();

  for (const cb of circuitBreakers) {
    console.log(`  Resolving ${cb.beadId}...`);
    await manager.resolveCircuitBreaker(cb.beadId);
  }

  console.log(`✓ ${circuitBreakers.length} circuit breaker(s) resolved`);
}
```

## Output

### Successful Resume

```
[RESUME] Continuing run...
Sprint: 2
Tasks: 3/5

✓ State updated to RUNNING

Run will resume execution.
Continuing sprint 2...
```

### With Circuit Breaker Reset

```
[RESUME] Continuing run...
Sprint: 2
Tasks: 2/5

Resolving circuit breakers...
  Resolving cb-abc123...
✓ 1 circuit breaker(s) resolved

✓ State updated to RUNNING

Run will resume execution.
Continuing sprint 2...
```

## Error Cases

### No Run In Progress

```
ERROR: No run in progress
Start a new run with /run sprint-N
```

### Run Already Running

```
ERROR: Run is already in progress
Use /run-status to check current state.
```

### Run Complete

```
ERROR: Run is already complete
Start a new run with /run sprint-N
```

### Circuit Breaker Open

```
WARNING: Circuit breaker is OPEN

Circuit breaker: cb-abc123
  Sprint:    sprint-2
  Reason:    Same finding repeated 3 times
  Failures:  3x
  Created:   2026-01-19T14:25:00Z

To resolve circuit breakers and continue:
  /run-resume --reset-ice

To view circuit breakers:
  br list --label circuit-breaker --status open
```

### Branch Diverged

```
ERROR: Branch has diverged from remote

Local:  abc1234
Remote: def5678

This can happen if:
  - Someone else pushed to the branch
  - You made changes outside of Run Mode

To force resume (may cause conflicts):
  /run-resume --force

To sync with remote first:
  git pull --rebase origin feature/sprint-2
```

## State After Resume

### Beads State Query

```typescript
const manager = createBeadsRunStateManager();
const state = await manager.getRunState(); // Returns "RUNNING"
const cbs = await manager.getActiveCircuitBreakers(); // Returns [] (empty)
```

### Beads Commands

```bash
# Run bead no longer has circuit-breaker label
br show <run-id>
# Labels: run:current

# Circuit breaker beads are closed
br list --label circuit-breaker --status open
# Returns: []

# In-progress sprint
br list --label sprint:in_progress
# Returns: [{ id: "sprint-x", ... }]
```

## How Circuit Breaker Resolution Works

When `--reset-ice` is used:

1. Query all open circuit breakers: `br list --label circuit-breaker --status open`
2. For each circuit breaker:
   - Close the bead: `br close <cb-id>`
   - Add resolution comment: `br comments add <cb-id> "Resolved at <timestamp>"`
3. Remove circuit-breaker label from run: `br label remove <run-id> circuit-breaker`

This changes the run state from HALTED back to RUNNING.

## Example Session

```
> /run-resume --reset-ice

[RESUME] Continuing run...
Sprint: 2
Tasks: 3/5

Resolving circuit breakers...
  Resolving cb-abc123...
✓ 1 circuit breaker(s) resolved

✓ State updated to RUNNING

Run will resume execution.
Continuing sprint 2...

[RUNNING] Sprint 2 continuing...
→ Task: task-4 (3/5)
  Implementing...
  ✓ Implementation complete

→ Task: task-5 (4/5)
  Implementing...
  ✓ Implementation complete

[REVIEW] Running /review-sprint 2...
  ✓ All good

[AUDIT] Running /audit-sprint 2...
  ✓ APPROVED

[COMPLETE] Sprint 2 finished!
...
```

## Fallback: Legacy .run/ Files (Deprecated)

```bash
preflight_resume_legacy() {
  local state_file=".run/state.json"
  local cb_file=".run/circuit-breaker.json"

  # DEPRECATED
  echo "[DEPRECATION WARNING] Using legacy .run/ files."
  echo "Migrate to beads with: BeadsRunStateManager.migrateFromDotRun('.run')"
  echo ""

  # 1. Verify state file exists
  if [[ ! -f "$state_file" ]]; then
    echo "ERROR: No run state found"
    echo "Start a new run with /run sprint-N"
    exit 1
  fi

  # ... rest of legacy implementation
}
```

## Related

- `/run-halt` - Stop execution
- `/run-status` - Check current state
- `/run sprint-N` - Start new run
- `BeadsRunStateManager` - TypeScript API for state management
