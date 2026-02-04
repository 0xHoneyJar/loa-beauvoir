# Software Design Document: Beads-OpenClaw Persistence Integration

> **Version**: 1.0.0
> **Created**: 2026-02-05
> **PRD**: `grimoires/loa/beads-openclaw-prd.md`
> **Status**: DRAFT

---

## Overview

This document describes the technical design for integrating Loa's beads_rust task management with OpenClaw's persistence infrastructure.

### Design Goals

1. **Minimal invasiveness** - Hook into existing systems, don't replace them
2. **Opt-in by default** - Enable via configuration, existing behavior unchanged
3. **Fail-safe** - Graceful degradation if any component fails
4. **Observable** - Clear logging for debugging

---

## System Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           OpenClaw Gateway                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────┐ │
│  │   WALManager   │  │   Scheduler    │  │      R2 Sync Service       │ │
│  │  (existing)    │  │  (existing)    │  │       (existing)           │ │
│  └───────┬────────┘  └───────┬────────┘  └────────────┬───────────────┘ │
│          │                   │                        │                  │
│          │ Dependency        │ Task Registration      │ Path Addition    │
│          │                   │                        │                  │
│          ▼                   ▼                        ▼                  │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    BeadsPersistenceService (NEW)                   │  │
│  │                                                                    │  │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐  │  │
│  │  │  BeadsWALAdapter │  │ BeadsScheduler   │  │ BeadsR2Config   │  │  │
│  │  │                  │  │     Tasks        │  │                 │  │  │
│  │  │ - recordTransit  │  │ - beads_health   │  │ - SYNC_PATHS    │  │  │
│  │  │ - replay         │  │ - beads_sync     │  │ - exclusions    │  │  │
│  │  │ - recover        │  │ - beads_stale    │  │                 │  │  │
│  │  └──────────────────┘  └──────────────────┘  └─────────────────┘  │  │
│  │                                                                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                      │                                   │
└──────────────────────────────────────┼───────────────────────────────────┘
                                       │
                                       ▼
                            ┌─────────────────────┐
                            │      .beads/        │
                            │  beads.db (SQLite)  │
                            │  issues.jsonl       │
                            │  config.yaml        │
                            └─────────────────────┘
```

---

## Component Design

### Component 1: BeadsWALAdapter

**Location**: `deploy/loa-identity/beads/beads-wal-adapter.ts`

**Purpose**: Record beads state transitions to WAL for crash recovery.

#### Interface

```typescript
/**
 * WAL entry for a beads state transition
 */
export interface BeadWALEntry {
  /** Unique entry ID */
  id: string;
  /** Timestamp of operation */
  timestamp: string;
  /** Operation type */
  operation: "create" | "update" | "close" | "reopen" | "label" | "comment" | "dep";
  /** Bead ID affected */
  beadId: string;
  /** Operation payload (varies by operation) */
  payload: Record<string, unknown>;
  /** SHA-256 of payload for integrity */
  checksum: string;
}

/**
 * Adapter between beads_rust operations and WAL
 */
export class BeadsWALAdapter {
  constructor(wal: WALManager, config?: BeadsWALConfig);

  /**
   * Record a beads transition to WAL
   * @returns WAL sequence number
   */
  async recordTransition(
    entry: Omit<BeadWALEntry, "id" | "timestamp" | "checksum">,
  ): Promise<number>;

  /**
   * Replay all beads transitions from WAL
   * Used for crash recovery
   */
  async replay(): Promise<BeadWALEntry[]>;

  /**
   * Get transitions since a specific sequence number
   * Used for incremental sync
   */
  async getTransitionsSince(seq: number): Promise<BeadWALEntry[]>;

  /**
   * Clear WAL entries (after successful SQLite sync)
   */
  async checkpoint(): Promise<void>;
}
```

#### Implementation Details

```typescript
import { WALManager } from "../wal/wal-manager.js";
import { createHash, randomUUID } from "crypto";

export interface BeadsWALConfig {
  /** WAL path prefix for beads entries */
  pathPrefix?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

export class BeadsWALAdapter {
  private readonly wal: WALManager;
  private readonly pathPrefix: string;
  private readonly verbose: boolean;

  constructor(wal: WALManager, config?: BeadsWALConfig) {
    this.wal = wal;
    this.pathPrefix = config?.pathPrefix ?? ".beads/wal";
    this.verbose = config?.verbose ?? false;
  }

  async recordTransition(
    entry: Omit<BeadWALEntry, "id" | "timestamp" | "checksum">,
  ): Promise<number> {
    const fullEntry: BeadWALEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      checksum: this.computeChecksum(entry.payload),
    };

    const seq = await this.wal.append(
      "bead_transition",
      `${this.pathPrefix}/${entry.beadId}`,
      Buffer.from(JSON.stringify(fullEntry)),
    );

    if (this.verbose) {
      console.log(`[beads-wal] recorded ${entry.operation} for ${entry.beadId} (seq=${seq})`);
    }

    return seq;
  }

  async replay(): Promise<BeadWALEntry[]> {
    const entries: BeadWALEntry[] = [];

    await this.wal.replay((operation, path, data) => {
      if (operation === "bead_transition" && path.startsWith(this.pathPrefix)) {
        try {
          const entry = JSON.parse(data.toString()) as BeadWALEntry;
          // Verify integrity
          if (this.verifyChecksum(entry)) {
            entries.push(entry);
          } else {
            console.warn(`[beads-wal] checksum mismatch for entry ${entry.id}, skipping`);
          }
        } catch (e) {
          console.error(`[beads-wal] failed to parse entry: ${e}`);
        }
      }
    });

    // Sort by timestamp for replay order
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    console.log(`[beads-wal] replayed ${entries.length} transitions`);
    return entries;
  }

  async getTransitionsSince(seq: number): Promise<BeadWALEntry[]> {
    const allEntries = await this.wal.getEntriesSince(seq);
    return allEntries
      .filter((e) => e.operation === "bead_transition")
      .map((e) => JSON.parse(e.data.toString()) as BeadWALEntry);
  }

  private computeChecksum(payload: Record<string, unknown>): string {
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  }

  private verifyChecksum(entry: BeadWALEntry): boolean {
    const expected = this.computeChecksum(entry.payload);
    return entry.checksum === expected;
  }
}
```

#### WAL Entry Format

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-02-05T10:30:00.000Z",
  "operation": "create",
  "beadId": "beads-xyz123",
  "payload": {
    "title": "Implement feature X",
    "type": "task",
    "priority": 2,
    "status": "open"
  },
  "checksum": "a1b2c3d4e5f67890"
}
```

---

### Component 2: BeadsRecoveryHandler

**Location**: `deploy/loa-identity/beads/beads-recovery.ts`

**Purpose**: Restore beads state from WAL after crash.

#### Interface

```typescript
/**
 * Recovery handler for beads state
 */
export class BeadsRecoveryHandler {
  constructor(adapter: BeadsWALAdapter);

  /**
   * Check if recovery is needed
   */
  async needsRecovery(): Promise<boolean>;

  /**
   * Perform crash recovery by replaying WAL to SQLite
   */
  async recover(): Promise<RecoveryResult>;
}

export interface RecoveryResult {
  success: boolean;
  entriesReplayed: number;
  beadsAffected: string[];
  durationMs: number;
  error?: string;
}
```

#### Recovery Algorithm

```typescript
export class BeadsRecoveryHandler {
  private readonly adapter: BeadsWALAdapter;
  private readonly beadsDir: string;

  constructor(adapter: BeadsWALAdapter, beadsDir = ".beads") {
    this.adapter = adapter;
    this.beadsDir = beadsDir;
  }

  async needsRecovery(): Promise<boolean> {
    // Check if WAL has entries newer than SQLite's last sync
    const lastSync = await this.getLastSyncTime();
    const walEntries = await this.adapter.replay();

    if (walEntries.length === 0) return false;

    const newestWAL = new Date(walEntries[walEntries.length - 1].timestamp);
    return newestWAL > lastSync;
  }

  async recover(): Promise<RecoveryResult> {
    const start = Date.now();
    const entries = await this.adapter.replay();
    const affectedBeads = new Set<string>();

    try {
      // Group entries by bead for efficient replay
      const byBead = this.groupByBead(entries);

      for (const [beadId, beadEntries] of byBead) {
        await this.replayBeadEntries(beadId, beadEntries);
        affectedBeads.add(beadId);
      }

      // Sync to ensure JSONL is updated
      await this.execBr("sync --flush-only");

      return {
        success: true,
        entriesReplayed: entries.length,
        beadsAffected: Array.from(affectedBeads),
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return {
        success: false,
        entriesReplayed: 0,
        beadsAffected: [],
        durationMs: Date.now() - start,
        error: String(e),
      };
    }
  }

  private async replayBeadEntries(beadId: string, entries: BeadWALEntry[]): Promise<void> {
    for (const entry of entries) {
      switch (entry.operation) {
        case "create":
          await this.execBr(
            `create "${entry.payload.title}" --type ${entry.payload.type} --priority ${entry.payload.priority} --json`,
          );
          break;
        case "update":
          const updates = Object.entries(entry.payload)
            .map(([k, v]) => `--${k} "${v}"`)
            .join(" ");
          await this.execBr(`update ${beadId} ${updates}`);
          break;
        case "close":
          await this.execBr(`close ${beadId} --reason "${entry.payload.reason}"`);
          break;
        case "label":
          if (entry.payload.action === "add") {
            await this.execBr(`label add ${beadId} ${entry.payload.labels}`);
          } else {
            await this.execBr(`label remove ${beadId} ${entry.payload.label}`);
          }
          break;
        case "comment":
          await this.execBr(`comments add ${beadId} "${entry.payload.text}"`);
          break;
        // ... other operations
      }
    }
  }

  private async execBr(args: string): Promise<string> {
    const { execAsync } = await import("../utils/exec.js");
    return execAsync(`br ${args}`, { cwd: this.beadsDir });
  }

  private groupByBead(entries: BeadWALEntry[]): Map<string, BeadWALEntry[]> {
    const map = new Map<string, BeadWALEntry[]>();
    for (const entry of entries) {
      const list = map.get(entry.beadId) ?? [];
      list.push(entry);
      map.set(entry.beadId, list);
    }
    return map;
  }

  private async getLastSyncTime(): Promise<Date> {
    try {
      const { statSync } = await import("fs");
      const stats = statSync(`${this.beadsDir}/beads.db`);
      return stats.mtime;
    } catch {
      return new Date(0); // Never synced
    }
  }
}
```

---

### Component 3: Scheduler Tasks

**Location**: `deploy/loa-identity/beads/beads-scheduler-tasks.ts`

**Purpose**: Register periodic beads maintenance tasks with the scheduler.

#### Task Definitions

```typescript
import { Scheduler } from "../scheduler/scheduler.js";
import { execAsync } from "../utils/exec.js";

export interface BeadsSchedulerConfig {
  healthCheck?: {
    enabled?: boolean;
    intervalMs?: number;
    jitterMs?: number;
  };
  autoSync?: {
    enabled?: boolean;
    intervalMs?: number;
    jitterMs?: number;
  };
  staleCheck?: {
    enabled?: boolean;
    intervalMs?: number;
    jitterMs?: number;
    staleDays?: number;
  };
}

const DEFAULT_CONFIG: Required<BeadsSchedulerConfig> = {
  healthCheck: {
    enabled: true,
    intervalMs: 15 * 60 * 1000, // 15 minutes
    jitterMs: 60 * 1000, // 1 minute
  },
  autoSync: {
    enabled: true,
    intervalMs: 5 * 60 * 1000, // 5 minutes
    jitterMs: 30 * 1000, // 30 seconds
  },
  staleCheck: {
    enabled: true,
    intervalMs: 24 * 60 * 60 * 1000, // 24 hours
    jitterMs: 60 * 60 * 1000, // 1 hour
    staleDays: 7,
  },
};

/**
 * Register beads maintenance tasks with the scheduler
 */
export function registerBeadsSchedulerTasks(
  scheduler: Scheduler,
  config?: BeadsSchedulerConfig,
): void {
  const cfg = mergeConfig(DEFAULT_CONFIG, config);

  // Health check task
  if (cfg.healthCheck.enabled) {
    scheduler.register({
      id: "beads_health",
      name: "Beads Health Check",
      intervalMs: cfg.healthCheck.intervalMs,
      jitterMs: cfg.healthCheck.jitterMs,
      handler: createHealthCheckHandler(),
      circuitBreaker: {
        maxFailures: 3,
        resetTimeMs: 5 * 60 * 1000,
        halfOpenRetries: 1,
      },
    });
  }

  // Auto-sync task
  if (cfg.autoSync.enabled) {
    scheduler.register({
      id: "beads_sync",
      name: "Beads Auto Sync",
      intervalMs: cfg.autoSync.intervalMs,
      jitterMs: cfg.autoSync.jitterMs,
      handler: createSyncHandler(),
      mutexGroup: "sync", // Mutex with git_sync
      circuitBreaker: {
        maxFailures: 3,
        resetTimeMs: 5 * 60 * 1000,
        halfOpenRetries: 1,
      },
    });
  }

  // Stale check task
  if (cfg.staleCheck.enabled) {
    scheduler.register({
      id: "beads_stale_check",
      name: "Beads Stale Check",
      intervalMs: cfg.staleCheck.intervalMs,
      jitterMs: cfg.staleCheck.jitterMs,
      handler: createStaleCheckHandler(cfg.staleCheck.staleDays),
      circuitBreaker: {
        maxFailures: 3,
        resetTimeMs: 60 * 60 * 1000, // 1 hour reset for daily task
        halfOpenRetries: 1,
      },
    });
  }

  console.log("[beads-scheduler] Registered beads maintenance tasks");
}

function createHealthCheckHandler(): () => Promise<void> {
  return async () => {
    try {
      const result = await execAsync("br doctor --json");
      const status = JSON.parse(result);

      if (status.status !== "healthy") {
        console.warn(`[beads-scheduler] Health check warning: ${status.message}`);
        throw new Error(`Beads unhealthy: ${status.message}`);
      }

      console.log("[beads-scheduler] Health check passed");
    } catch (e) {
      // br doctor might not have --json flag, try without
      const result = await execAsync("br doctor");
      if (result.includes("ERROR") || result.includes("FAIL")) {
        throw new Error(`Beads unhealthy: ${result}`);
      }
      console.log("[beads-scheduler] Health check passed (text mode)");
    }
  };
}

function createSyncHandler(): () => Promise<void> {
  return async () => {
    await execAsync("br sync --flush-only");
    console.log("[beads-scheduler] Auto sync completed");
  };
}

function createStaleCheckHandler(staleDays: number): () => Promise<void> {
  return async () => {
    try {
      const result = await execAsync(`br stale --days ${staleDays} --json`);
      const staleIssues = JSON.parse(result);

      if (staleIssues.length > 0) {
        console.warn(
          `[beads-scheduler] Found ${staleIssues.length} stale issues (>${staleDays} days old):`,
        );
        for (const issue of staleIssues.slice(0, 5)) {
          console.warn(`  - ${issue.id}: ${issue.title}`);
        }
        if (staleIssues.length > 5) {
          console.warn(`  ... and ${staleIssues.length - 5} more`);
        }
      } else {
        console.log("[beads-scheduler] No stale issues found");
      }
    } catch (e) {
      // br stale might not exist, skip gracefully
      console.log("[beads-scheduler] Stale check skipped (command not available)");
    }
  };
}

function mergeConfig(
  defaults: Required<BeadsSchedulerConfig>,
  overrides?: BeadsSchedulerConfig,
): Required<BeadsSchedulerConfig> {
  if (!overrides) return defaults;
  return {
    healthCheck: { ...defaults.healthCheck, ...overrides.healthCheck },
    autoSync: { ...defaults.autoSync, ...overrides.autoSync },
    staleCheck: { ...defaults.staleCheck, ...overrides.staleCheck },
  };
}
```

---

### Component 4: R2 Sync Configuration

**Location**: Modify `upstream/moltworker/src/gateway/sync.ts`

**Purpose**: Include `.beads/` in R2 sync paths.

#### Changes Required

```typescript
// In upstream/moltworker/src/gateway/sync.ts

// EXISTING paths
const SYNC_PATHS = [".openclaw/config", ".openclaw/credentials", "grimoires/loa/a2a/compound/"];

// ADD: Beads directory
const BEADS_SYNC_PATH = ".beads/";

// EXCLUSIONS: Don't sync SQLite journals and locks
const BEADS_EXCLUSIONS = [
  ".beads/beads.db-journal",
  ".beads/beads.db-wal",
  ".beads/beads.db-shm",
  ".beads/*.lock",
];

// In sync function, add beads path
export async function syncToR2(localDir: string, r2Client: R2Client): Promise<SyncResult> {
  const allPaths = [...SYNC_PATHS, BEADS_SYNC_PATH];

  for (const path of allPaths) {
    const fullPath = join(localDir, path);
    if (!existsSync(fullPath)) continue;

    // Apply exclusions for beads
    const exclusions = path === BEADS_SYNC_PATH ? BEADS_EXCLUSIONS : [];

    await syncDirectory(fullPath, r2Client, exclusions);
  }
}
```

---

### Component 5: BeadsPersistenceService

**Location**: `deploy/loa-identity/beads/beads-persistence-service.ts`

**Purpose**: Main entry point that orchestrates all beads persistence components.

```typescript
import { WALManager } from "../wal/wal-manager.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { BeadsWALAdapter } from "./beads-wal-adapter.js";
import { BeadsRecoveryHandler } from "./beads-recovery.js";
import { registerBeadsSchedulerTasks, BeadsSchedulerConfig } from "./beads-scheduler-tasks.js";

export interface BeadsPersistenceConfig {
  enabled: boolean;
  beadsDir: string;
  wal?: {
    enabled?: boolean;
    replayOnStart?: boolean;
  };
  scheduler?: BeadsSchedulerConfig;
}

/**
 * Main service that coordinates beads persistence
 */
export class BeadsPersistenceService {
  private readonly config: BeadsPersistenceConfig;
  private readonly walAdapter?: BeadsWALAdapter;
  private readonly recoveryHandler?: BeadsRecoveryHandler;
  private initialized = false;

  constructor(config: BeadsPersistenceConfig, wal?: WALManager, scheduler?: Scheduler) {
    this.config = config;

    if (!config.enabled) {
      console.log("[beads-persistence] Disabled by configuration");
      return;
    }

    // Initialize WAL adapter if WAL provided
    if (wal && config.wal?.enabled !== false) {
      this.walAdapter = new BeadsWALAdapter(wal, {
        verbose: process.env.DEBUG === "true",
      });
      this.recoveryHandler = new BeadsRecoveryHandler(this.walAdapter, config.beadsDir);
    }

    // Register scheduler tasks if scheduler provided
    if (scheduler) {
      registerBeadsSchedulerTasks(scheduler, config.scheduler);
    }
  }

  /**
   * Initialize service - call on startup
   */
  async initialize(): Promise<void> {
    if (this.initialized || !this.config.enabled) return;

    // Check for and perform crash recovery if needed
    if (this.recoveryHandler && this.config.wal?.replayOnStart !== false) {
      const needsRecovery = await this.recoveryHandler.needsRecovery();
      if (needsRecovery) {
        console.log("[beads-persistence] Crash recovery needed, replaying WAL...");
        const result = await this.recoveryHandler.recover();
        if (result.success) {
          console.log(
            `[beads-persistence] Recovery complete: ${result.entriesReplayed} entries, ` +
              `${result.beadsAffected.length} beads affected (${result.durationMs}ms)`,
          );
        } else {
          console.error(`[beads-persistence] Recovery failed: ${result.error}`);
          // Don't throw - let the service start in degraded mode
        }
      }
    }

    this.initialized = true;
    console.log("[beads-persistence] Initialized");
  }

  /**
   * Record a beads transition (call from br command wrapper)
   */
  async recordTransition(
    operation: string,
    beadId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.walAdapter) return;

    await this.walAdapter.recordTransition({
      operation: operation as any,
      beadId,
      payload,
    });
  }

  /**
   * Check if service is healthy
   */
  isHealthy(): boolean {
    return this.initialized;
  }
}
```

---

## Data Flow

### Write Path (Recording Transitions)

```
┌────────────────────────────────────────────────────────────────────────┐
│                         br create/update/close                          │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  BeadsPersistenceService.recordTransition()                             │
│    1. Create WAL entry with timestamp + checksum                        │
│    2. Append to WAL (atomic)                                            │
│    3. Return success (SQLite write happens separately by br)            │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         WAL Segment File                                │
│  {operation, beadId, payload, checksum}                                 │
└────────────────────────────────────────────────────────────────────────┘
```

### Recovery Path (After Crash)

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Container Startup                                  │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  BeadsPersistenceService.initialize()                                   │
│    1. Check if WAL has entries newer than SQLite                        │
│    2. If yes: BeadsRecoveryHandler.recover()                            │
│       - Replay WAL entries to SQLite via br commands                    │
│       - br sync --flush-only to update JSONL                            │
│    3. Mark initialized                                                  │
└────────────────────────────────────────────────────────────────────────┘
```

### Sync Path (Periodic)

```
┌────────────────────────────────────────────────────────────────────────┐
│                    Scheduler: beads_sync (every 5 min)                  │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  br sync --flush-only                                                   │
│    SQLite → issues.jsonl                                                │
└────────────────────────────┬───────────────────────────────────────────┘
                             │
                             ▼ (30 seconds later)
┌────────────────────────────────────────────────────────────────────────┐
│  R2 Sync Service                                                        │
│    .beads/ → R2 bucket                                                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

### New Files

```
deploy/loa-identity/beads/
├── beads-wal-adapter.ts          # WAL integration adapter
├── beads-recovery.ts             # Crash recovery handler
├── beads-scheduler-tasks.ts      # Scheduler task registration
├── beads-persistence-service.ts  # Main orchestration service
├── index.ts                      # Re-exports
└── __tests__/
    ├── beads-wal-adapter.test.ts
    ├── beads-recovery.test.ts
    └── beads-scheduler-tasks.test.ts
```

### Modified Files

| File                                              | Change                             |
| ------------------------------------------------- | ---------------------------------- |
| `upstream/moltworker/src/gateway/sync.ts`         | Add `.beads/` to SYNC_PATHS        |
| `deploy/loa-identity/bootstrap.ts`                | Initialize BeadsPersistenceService |
| `deploy/loa-identity/recovery/recovery-engine.ts` | Add beads to recovery chain        |

---

## Error Handling

### WAL Write Failures

```typescript
try {
  await walAdapter.recordTransition(entry);
} catch (e) {
  // Log but don't block - SQLite write will still happen
  console.error(`[beads-wal] Failed to record transition: ${e}`);
  // Metrics: increment wal_write_failures
}
```

### Recovery Failures

```typescript
const result = await recoveryHandler.recover();
if (!result.success) {
  console.error(`[beads-recovery] Recovery failed: ${result.error}`);
  // Don't throw - start in degraded mode
  // Operator can manually run: br sync --import-only
}
```

### Scheduler Task Failures

- Circuit breaker opens after 3 consecutive failures
- Resets after 5 minutes
- Half-open retry with single attempt

---

## Testing Strategy

### Unit Tests

| Test                               | Coverage                 |
| ---------------------------------- | ------------------------ |
| BeadsWALAdapter.recordTransition   | Entry creation, checksum |
| BeadsWALAdapter.replay             | Entry parsing, ordering  |
| BeadsRecoveryHandler.needsRecovery | Timestamp comparison     |
| BeadsRecoveryHandler.recover       | Command generation       |

### Integration Tests

| Test                           | Coverage            |
| ------------------------------ | ------------------- |
| Full write-crash-recover cycle | End-to-end recovery |
| Scheduler task execution       | All 3 tasks run     |
| R2 sync includes beads         | .beads/ in bucket   |

### Manual Tests

1. Kill container with `kill -9`
2. Restart container
3. Verify beads state matches pre-crash

---

## Configuration Reference

```yaml
# Full configuration schema
beads:
  persistence:
    enabled: true

  wal:
    enabled: true
    replay_on_start: true
    path_prefix: ".beads/wal"
    verbose: false

  scheduler:
    health_check:
      enabled: true
      interval_ms: 900000 # 15 min
      jitter_ms: 60000 # 1 min
    auto_sync:
      enabled: true
      interval_ms: 300000 # 5 min
      jitter_ms: 30000 # 30 sec
    stale_check:
      enabled: true
      interval_ms: 86400000 # 24 hours
      jitter_ms: 3600000 # 1 hour
      stale_days: 7

  r2:
    enabled: true
    exclusions:
      - "*.lock"
      - "beads.db-*"
```

---

## Security Considerations

1. **Checksum verification** - All WAL entries have SHA-256 checksums
2. **No sensitive data in beads** - Task titles/descriptions only
3. **R2 encryption** - Inherits from existing R2 configuration
4. **SQLite journal excluded** - Prevents incomplete state sync

---

## Appendix

### Command Wrapper Pattern

For WAL recording to work, `br` commands need to trigger `recordTransition()`. Options:

**Option A: Shell wrapper** (Recommended)

```bash
#!/bin/bash
# .claude/scripts/beads/br-wrapper.sh
# Call this instead of br directly

# Record to WAL first
node -e "require('./deploy/loa-identity/beads').recordTransition('$1', '$2', '$3')"

# Execute actual br command
br "$@"
```

**Option B: Hooks in skills**
Skills call `recordTransition()` before `br` commands.

**Option C: File watch**
Watch `.beads/beads.db` for changes and infer operations.

---

_Generated by Loa Simstim Workflow_
