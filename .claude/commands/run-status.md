# /run-status Command

## Purpose

Display current run state and progress. Shows run details, cycle progress, metrics, and circuit breaker status.

**Primary data source**: BeadsRunStateManager (Phase 4+)
**Fallback**: .run/ state files (legacy, deprecated)

## Usage

```
/run-status
/run-status --json
/run-status --verbose
/run-status --legacy        # Force .run/ files only (deprecated)
```

## Options

| Option      | Description                       | Default |
| ----------- | --------------------------------- | ------- |
| `--json`    | Output as JSON                    | false   |
| `--verbose` | Show detailed breakdown           | false   |
| `--legacy`  | Use .run/ files only (deprecated) | false   |

## Output

### Standard Output

```
╔══════════════════════════════════════════════════════════════╗
║                    RUN MODE STATUS                            ║
╠══════════════════════════════════════════════════════════════╣
║ State:     RUNNING                                            ║
║ Source:    beads (unified)                                    ║
║ Branch:    feature/sprint-3                                   ║
╠══════════════════════════════════════════════════════════════╣
║ SPRINT PROGRESS                                               ║
║ ─────────────────────────────────────────────────────────────║
║ [✓] Sprint 1  (3/3 tasks)                                     ║
║ [→] Sprint 2  (1/5 tasks, in_progress)                        ║
║ [ ] Sprint 3  (0/4 tasks, pending)                            ║
║                                                               ║
║ Progress: 1/3 sprints (33%)                                   ║
╠══════════════════════════════════════════════════════════════╣
║ CIRCUIT BREAKER: CLOSED                                       ║
╚══════════════════════════════════════════════════════════════╝
```

## Implementation

### Primary: BeadsRunStateManager Query

```typescript
import { createBeadsRunStateManager } from "deploy/loa-identity/beads/index.js";

async function checkRunStatusBeads() {
  const manager = createBeadsRunStateManager();

  // Get run state
  const state = await manager.getRunState();

  if (state === "READY") {
    console.log("No run in progress.");
    console.log("");
    console.log("Start a new run with:");
    console.log("  /run sprint-N");
    console.log("  /run sprint-plan");
    return;
  }

  // Get sprint plan
  const sprints = await manager.getSprintPlan();

  // Get circuit breakers
  const circuitBreakers = await manager.getActiveCircuitBreakers();

  // Display status
  displayStatus(state, sprints, circuitBreakers);
}
```

### Fallback: Legacy .run/ Files (Deprecated)

```bash
check_run_status_legacy() {
  local state_file=".run/state.json"
  local cb_file=".run/circuit-breaker.json"

  # Check if run is in progress
  if [[ ! -f "$state_file" ]]; then
    echo "No run in progress."
    echo ""
    echo "Start a new run with:"
    echo "  /run sprint-N"
    echo "  /run sprint-plan"
    return 0
  fi

  # DEPRECATED: Load state from files
  echo "[DEPRECATION WARNING] Using legacy .run/ files. Migrate to beads with:"
  echo "  BeadsRunStateManager.migrateFromDotRun('.run')"
  echo ""

  local run_id=$(jq -r '.run_id' "$state_file")
  local state=$(jq -r '.state' "$state_file")
  local target=$(jq -r '.target' "$state_file")
  local branch=$(jq -r '.branch' "$state_file")
  local phase=$(jq -r '.phase' "$state_file")

  # Calculate runtime
  local started=$(jq -r '.timestamps.started' "$state_file")
  local runtime=$(calculate_runtime "$started")

  # Load circuit breaker
  local cb_state=$(jq -r '.state' "$cb_file")
  local same_issue=$(jq '.triggers.same_issue.count' "$cb_file")
  local same_threshold=$(jq '.triggers.same_issue.threshold' "$cb_file")
  local no_progress=$(jq '.triggers.no_progress.count' "$cb_file")
  local no_progress_threshold=$(jq '.triggers.no_progress.threshold' "$cb_file")
  local current_cycle=$(jq '.cycles.current' "$state_file")
  local cycle_limit=$(jq '.cycles.limit' "$state_file")
  local timeout_hours=$(jq '.options.timeout_hours' "$state_file")

  # Load metrics
  local files_changed=$(jq '.metrics.files_changed' "$state_file")
  local files_deleted=$(jq '.metrics.files_deleted' "$state_file")
  local commits=$(jq '.metrics.commits' "$state_file")
  local findings_fixed=$(jq '.metrics.findings_fixed' "$state_file")

  # Display status
  display_status_legacy
}
```

### State Query Logic

The BeadsRunStateManager determines state by querying beads labels:

| State    | Query                                | Condition                     |
| -------- | ------------------------------------ | ----------------------------- |
| READY    | `br list --label run:current`        | Returns empty                 |
| RUNNING  | `br list --label sprint:in_progress` | Returns sprint bead           |
| HALTED   | `br list --label circuit-breaker`    | Run has circuit-breaker label |
| COMPLETE | `br list --label sprint:pending`     | No pending sprints            |

### Display Status (Unified)

```typescript
function displayStatus(
  state: RunState,
  sprints: SprintState[],
  circuitBreakers: CircuitBreakerRecord[],
) {
  const width = 60;

  // Header
  console.log(boxTop(width));
  console.log(boxCenter("RUN MODE STATUS", width));
  console.log(boxSeparator(width));

  // State info
  console.log(boxLine(`State:     ${state}`, width));
  console.log(boxLine(`Source:    beads (unified)`, width));
  console.log(boxLine(`Branch:    ${getCurrentBranch()}`, width));

  // Sprint progress
  console.log(boxSeparator(width));
  console.log(boxCenter("SPRINT PROGRESS", width));
  console.log(boxLineThin(width));

  let completed = 0;
  for (const sprint of sprints) {
    const status =
      sprint.status === "completed"
        ? "✓"
        : sprint.status === "in_progress"
          ? "→"
          : sprint.status === "halted"
            ? "!"
            : " ";
    const taskInfo = `(${sprint.tasksCompleted}/${sprint.tasksTotal} tasks${sprint.status !== "pending" ? ", " + sprint.status : ""})`;
    console.log(boxLine(`[${status}] Sprint ${sprint.sprintNumber}  ${taskInfo}`, width));
    if (sprint.status === "completed") completed++;
  }

  console.log(boxLine("", width));
  const progress = sprints.length > 0 ? Math.round((completed / sprints.length) * 100) : 0;
  console.log(boxLine(`Progress: ${completed}/${sprints.length} sprints (${progress}%)`, width));

  // Circuit breaker
  console.log(boxSeparator(width));
  const cbState = circuitBreakers.length > 0 ? "OPEN" : "CLOSED";
  console.log(boxCenter(`CIRCUIT BREAKER: ${cbState}`, width));

  if (circuitBreakers.length > 0) {
    console.log(boxLineThin(width));
    for (const cb of circuitBreakers) {
      console.log(boxLine(`Sprint: ${cb.sprintId}`, width));
      console.log(boxLine(`Reason: ${cb.reason}`, width));
      console.log(boxLine(`Failures: ${cb.failureCount}`, width));
    }
  }

  console.log(boxBottom(width));
}
```

### JSON Output

```typescript
async function outputJson() {
  const manager = createBeadsRunStateManager();

  const state = await manager.getRunState();
  const sprints = await manager.getSprintPlan();
  const circuitBreakers = await manager.getActiveCircuitBreakers();
  const currentSprint = await manager.getCurrentSprint();

  const output = {
    source: "beads",
    state,
    currentSprint,
    sprints,
    circuitBreakers,
    computed: {
      sprintsCompleted: sprints.filter((s) => s.status === "completed").length,
      sprintsTotal: sprints.length,
      activeCircuitBreakers: circuitBreakers.length,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}
```

### Verbose Output

```typescript
async function outputVerbose() {
  const manager = createBeadsRunStateManager();

  // Standard status
  await checkRunStatusBeads();

  const state = await manager.getRunState();
  if (state === "READY") return;

  // Sprint details
  console.log("");
  console.log("=== Sprint Details ===");
  const sprints = await manager.getSprintPlan();
  for (const sprint of sprints) {
    console.log(`Sprint ${sprint.sprintNumber}: ${sprint.status}`);
    console.log(`  Tasks: ${sprint.tasksCompleted}/${sprint.tasksTotal}`);
    if (sprint.currentTaskId) {
      console.log(`  Current: ${sprint.currentTaskId}`);
    }
  }

  // Circuit breaker history
  console.log("");
  console.log("=== Circuit Breaker History ===");
  const cbs = await manager.getActiveCircuitBreakers();
  if (cbs.length === 0) {
    console.log("No circuit breaker trips");
  } else {
    for (const cb of cbs) {
      console.log(`[${cb.createdAt}] ${cb.reason} (${cb.failureCount}x)`);
    }
  }
}
```

## No Run In Progress

When no run is active:

```
No run in progress.

Start a new run with:
  /run sprint-N
  /run sprint-plan
```

## Sprint Plan Status

When running a sprint plan, additional info is shown:

```
╔══════════════════════════════════════════════════════════════╗
║                 RUN MODE STATUS (Sprint Plan)                 ║
╠══════════════════════════════════════════════════════════════╣
║ State:     RUNNING                                            ║
║ Source:    beads (unified)                                    ║
║ Branch:    feature/release                                    ║
╠══════════════════════════════════════════════════════════════╣
║ SPRINT PROGRESS                                               ║
║ ─────────────────────────────────────────────────────────────║
║ [✓] Sprint 1  (3/3 tasks)                                     ║
║ [✓] Sprint 2  (5/5 tasks)                                     ║
║ [→] Sprint 3  (2/4 tasks, in_progress)                        ║
║ [ ] Sprint 4  (0/3 tasks, pending)                            ║
║                                                               ║
║ Progress: 2/4 sprints (50%)                                   ║
╠══════════════════════════════════════════════════════════════╣
║ CIRCUIT BREAKER: CLOSED                                       ║
╚══════════════════════════════════════════════════════════════╝
```

## State Indicators

| State    | Display  | Meaning                 |
| -------- | -------- | ----------------------- |
| READY    | No run   | No active run           |
| RUNNING  | Running  | Active execution        |
| HALTED   | HALTED   | Circuit breaker tripped |
| COMPLETE | Complete | All sprints completed   |

## Sprint Status Indicators

| Status      | Icon    | Meaning                    |
| ----------- | ------- | -------------------------- |
| completed   | ✓       | Sprint finished            |
| in_progress | →       | Currently executing        |
| halted      | !       | Stopped by circuit breaker |
| pending     | (space) | Not yet started            |

## Circuit Breaker States

| State  | Display | Meaning                               |
| ------ | ------- | ------------------------------------- |
| CLOSED | CLOSED  | Normal operation (no active breakers) |
| OPEN   | OPEN    | Halted, manual intervention needed    |

## Migration from .run/ Files

To migrate existing state:

```typescript
const manager = createBeadsRunStateManager();
const result = await manager.migrateFromDotRun(".run");

console.log(`Migrated ${result.migratedSprints} sprints`);
console.log(`Migrated ${result.migratedTasks} tasks`);
if (result.circuitBreakersCreated > 0) {
  console.log(`Created ${result.circuitBreakersCreated} circuit breakers`);
}
if (result.warnings.length > 0) {
  console.log("Warnings:", result.warnings);
}
```

## Example Usage

```bash
# Quick status check
/run-status

# Full details
/run-status --verbose

# For scripting
/run-status --json | jq '.state'

# Legacy mode (deprecated)
/run-status --legacy
```

## Related

- `/run sprint-N` - Start a run
- `/run-halt` - Stop execution
- `/run-resume` - Continue from halt
- `BeadsRunStateManager` - TypeScript API for state management
