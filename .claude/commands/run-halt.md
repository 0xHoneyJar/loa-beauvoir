# /run-halt Command

## Purpose

Gracefully stop a running run. Creates circuit breaker bead, commits state, pushes to branch, and creates draft PR marked as incomplete.

**Primary data source**: BeadsRunStateManager (Phase 4+)
**Fallback**: .run/ state files (legacy, deprecated)

## Usage

```
/run-halt
/run-halt --force
/run-halt --reason "Need to review approach"
/run-halt --legacy        # Force .run/ files only (deprecated)
```

## Options

| Option           | Description                                   | Default       |
| ---------------- | --------------------------------------------- | ------------- |
| `--force`        | Stop immediately without completing phase     | false         |
| `--reason "..."` | Reason for halt (included in circuit breaker) | "Manual halt" |
| `--legacy`       | Use .run/ files only (deprecated)             | false         |

## Pre-flight Checks

### Primary: BeadsRunStateManager

```typescript
import { createBeadsRunStateManager } from "deploy/loa-identity/beads/index.js";

async function preflightHalt() {
  const manager = createBeadsRunStateManager();
  const state = await manager.getRunState();

  if (state === "READY") {
    console.log("ERROR: No run in progress");
    console.log("Nothing to halt.");
    process.exit(1);
  }

  if (state === "COMPLETE") {
    console.log("ERROR: Run already completed");
    process.exit(1);
  }

  if (state === "HALTED") {
    console.log("Run is already halted.");
    console.log("Use /run-resume to continue or resolve circuit breakers.");
    process.exit(0);
  }
}
```

### Fallback: Legacy .run/ Files (Deprecated)

```bash
preflight_halt_legacy() {
  local state_file=".run/state.json"

  # DEPRECATED: Using legacy files
  echo "[DEPRECATION WARNING] Using legacy .run/ files."
  echo "Migrate to beads with: BeadsRunStateManager.migrateFromDotRun('.run')"
  echo ""

  # Check if run is in progress
  if [[ ! -f "$state_file" ]]; then
    echo "ERROR: No run in progress"
    echo "Nothing to halt."
    exit 1
  fi

  # Check current state
  local current_state=$(jq -r '.state' "$state_file")

  if [[ "$current_state" == "JACKED_OUT" ]]; then
    echo "ERROR: Run already completed"
    exit 1
  fi

  if [[ "$current_state" == "HALTED" ]]; then
    echo "Run is already halted."
    echo "Use /run-resume to continue or clean up with:"
    echo "  rm -rf .run/"
    exit 0
  fi
}
```

## Execution Flow

### Graceful Halt (Default)

```
1. Check current state via BeadsRunStateManager.getRunState()
2. If phase incomplete:
   - Wait for phase completion (if possible)
   - Or skip to commit
3. Create circuit breaker bead with reason
4. Commit current changes
5. Push to feature branch
6. Create draft PR marked INCOMPLETE
7. Output summary
```

### Force Halt

```
1. Immediately interrupt current operation
2. Create circuit breaker bead with reason + FORCE flag
3. Commit any staged changes
4. Push to feature branch
5. Create draft PR marked INCOMPLETE
6. Output summary with warning
```

## Implementation

### Primary: BeadsRunStateManager

```typescript
import { createBeadsRunStateManager } from "deploy/loa-identity/beads/index.js";

async function haltRun(force: boolean, reason: string) {
  const manager = createBeadsRunStateManager();

  console.log("[HALT] Stopping run...");
  console.log(`Reason: ${reason}`);

  if (force) {
    console.log("");
    console.log("WARNING: Force halt - current phase interrupted");
  } else {
    // Complete current phase if safe
    await completeCurrentPhase();
  }

  // Create circuit breaker (this marks run as HALTED)
  const circuitBreaker = await manager.haltRun(reason);
  console.log(`✓ Circuit breaker created: ${circuitBreaker.beadId}`);

  // Get current sprint info
  const currentSprint = await manager.getCurrentSprint();

  // Commit any pending changes
  await commitPendingChanges(reason, currentSprint);

  // Push to branch
  const branch = getCurrentBranch();
  await pushToBranch(branch);

  // Create incomplete PR
  await createIncompletePR(currentSprint, reason, circuitBreaker);

  // Output summary
  outputHaltSummary(currentSprint, branch, reason, circuitBreaker);
}
```

### Create Circuit Breaker

```typescript
async function createCircuitBreaker(reason: string) {
  const manager = createBeadsRunStateManager();

  // haltRun() internally creates a circuit breaker bead:
  // - type: debt
  // - priority: 0 (critical)
  // - labels: circuit-breaker, same-issue-1x
  // - Adds comment with failure reason
  // - Labels parent run with circuit-breaker

  return await manager.haltRun(reason);
}
```

### Complete Current Phase

```typescript
async function completeCurrentPhase() {
  const manager = createBeadsRunStateManager();
  const sprint = await manager.getCurrentSprint();

  if (!sprint) {
    console.log("No active sprint phase");
    return;
  }

  console.log(`Completing phase for sprint ${sprint.sprintNumber}...`);
  console.log("✓ Phase can be resumed");
}
```

### Commit Pending Changes

```typescript
async function commitPendingChanges(reason: string, sprint: SprintState | null) {
  const exec = promisify(require("child_process").exec);

  // Check for uncommitted changes
  const { stdout: diffOutput } = await exec(
    'git diff --quiet && git diff --staged --quiet || echo "changes"',
  );

  if (!diffOutput.includes("changes")) {
    console.log("No pending changes to commit");
    return;
  }

  console.log("Committing pending changes...");

  // Stage all changes
  await exec("git add -A");

  // Commit with halt message
  const commitMessage = `WIP: Run halted - ${reason}

This commit contains work-in-progress from an interrupted Run Mode session.
Use /run-resume to continue from this point.

Sprint: ${sprint?.sprintNumber ?? "unknown"}
State: HALTED (circuit breaker active)
`;

  await exec(`git commit -m '${commitMessage.replace(/'/g, "'\\''")}'`);
  console.log("✓ Changes committed");
}
```

### Create Incomplete PR

```typescript
async function createIncompletePR(
  sprint: SprintState | null,
  reason: string,
  circuitBreaker: CircuitBreakerRecord,
) {
  const manager = createBeadsRunStateManager();
  const sprints = await manager.getSprintPlan();

  const completed = sprints.filter((s) => s.status === "completed").length;

  const body = `## Run Mode Implementation - INCOMPLETE

### Status: HALTED

**Halt Reason:** ${reason}
**Circuit Breaker:** ${circuitBreaker.beadId}

### Sprint Progress

| Sprint | Status | Tasks |
|--------|--------|-------|
${sprints.map((s) => `| Sprint ${s.sprintNumber} | ${s.status} | ${s.tasksCompleted}/${s.tasksTotal} |`).join("\n")}

**Progress:** ${completed}/${sprints.length} sprints (${Math.round((completed / sprints.length) * 100)}%)

---
:warning: **INCOMPLETE** - This PR represents partial work.

### To Resume
\`\`\`
/run-resume
\`\`\`

### To Reset Circuit Breaker and Resume
\`\`\`
/run-resume --reset-ice
\`\`\`

:robot: Generated autonomously with Run Mode (beads-backed)
`;

  // Create/update PR via ICE
  await runModeIce.prCreate(
    `[INCOMPLETE] Run Mode: Sprint ${sprint?.sprintNumber ?? "unknown"}`,
    body,
    { draft: true },
  );

  console.log("✓ PR created/updated");
}
```

### Output Summary

```typescript
function outputHaltSummary(
  sprint: SprintState | null,
  branch: string,
  reason: string,
  circuitBreaker: CircuitBreakerRecord,
) {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                    RUN HALTED                                 ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║ Sprint:    ${sprint?.sprintNumber ?? "unknown"}`);
  console.log(`║ Branch:    ${branch}`);
  console.log(`║ Reason:    ${reason}`);
  console.log(`║ Circuit:   ${circuitBreaker.beadId}`);
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║ State stored in beads (unified)");
  console.log("║");
  console.log("║ To resume:");
  console.log("║   /run-resume");
  console.log("║");
  console.log("║ To reset circuit breaker and resume:");
  console.log("║   /run-resume --reset-ice");
  console.log("║");
  console.log("║ To view circuit breakers:");
  console.log("║   br list --label circuit-breaker --status open");
  console.log("╚══════════════════════════════════════════════════════════════╝");
}
```

## Circuit Breaker as Bead

When halting, a circuit breaker bead is created:

```
br create \
  --title "Circuit Breaker: Sprint X" \
  --type debt \
  --priority 0 \
  --label circuit-breaker \
  --label same-issue-1x

br comments add <cb-id> "Triggered: <reason>"
br label add <run-id> circuit-breaker
```

This ensures:

- The run state shows HALTED
- The reason is preserved in bead comments
- Circuit breakers are queryable via `br list --label circuit-breaker`

## State After Halt

### Beads State

```bash
# Run bead has circuit-breaker label
br show <run-id>
# Labels: run:current, circuit-breaker

# Circuit breaker bead exists
br list --label circuit-breaker --status open
# Returns: [{ id: "cb-xyz", ... }]

# Current sprint preserved
br list --label sprint:in_progress
# Returns: [{ id: "sprint-x", ... }]
```

### Query State

```typescript
const manager = createBeadsRunStateManager();
const state = await manager.getRunState(); // Returns "HALTED"
const cbs = await manager.getActiveCircuitBreakers(); // Returns circuit breaker records
```

## Example Session

```
> /run-halt --reason "Need to review architecture approach"

[HALT] Stopping run...
Reason: Need to review architecture approach

Completing phase for sprint 2...
✓ Phase can be resumed

✓ Circuit breaker created: cb-abc123

Committing pending changes...
✓ Changes committed

Pushing to feature/sprint-2...
✓ Pushed to feature/sprint-2

Creating draft PR...
✓ PR created/updated

╔══════════════════════════════════════════════════════════════╗
║                    RUN HALTED                                 ║
╠══════════════════════════════════════════════════════════════╣
║ Sprint:    2
║ Branch:    feature/sprint-2
║ Reason:    Need to review architecture approach
║ Circuit:   cb-abc123
╠══════════════════════════════════════════════════════════════╣
║ State stored in beads (unified)
║
║ To resume:
║   /run-resume
║
║ To reset circuit breaker and resume:
║   /run-resume --reset-ice
║
║ To view circuit breakers:
║   br list --label circuit-breaker --status open
╚══════════════════════════════════════════════════════════════╝
```

## Related

- `/run-status` - Check current state
- `/run-resume` - Continue from halt
- `/run sprint-N` - Start new run
- `BeadsRunStateManager` - TypeScript API for state management
