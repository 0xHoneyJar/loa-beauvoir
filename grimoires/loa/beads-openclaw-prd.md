# Product Requirements Document: Beads-OpenClaw Persistence Integration

> **Version**: 1.0.0
> **Created**: 2026-02-05
> **Status**: DRAFT
> **Source**: `grimoires/loa/a2a/audits/2026-02-04-beads-review/BEADS-INTEGRATION-REVIEW.md`

---

## Executive Summary

Integrate Loa's beads_rust task management system with OpenClaw's persistence infrastructure (WAL, R2, Scheduler) to achieve crash-resilient, cloud-backed, automatically-maintained task state. This is the foundation for future cron-based task decomposition that will deliver 50%+ token savings.

---

## Problem Statement

### Current State

Beads_rust currently operates in isolation from OpenClaw's persistence layer:

```
┌─────────────────────────────────────────────────────────┐
│                    .beads/ (git-only)                   │
├─────────────────────────────────────────────────────────┤
│  beads.db (SQLite)    ←→    issues.jsonl (JSONL)        │
│       ↑                           ↑                      │
│  Session-local             Manual git commit             │
└─────────────────────────────────────────────────────────┘
```

### Problems

| Problem                  | Impact                       | Frequency          |
| ------------------------ | ---------------------------- | ------------------ |
| **No crash recovery**    | Mid-task failures lose state | Container restarts |
| **No cloud backup**      | Single point of failure      | Any failure        |
| **No health monitoring** | Silent corruption            | Unknown            |
| **Manual sync only**     | Human-dependent persistence  | Every session      |

### Unused OpenClaw Infrastructure

| Mechanism       | Purpose               | Current Beads Usage |
| --------------- | --------------------- | ------------------- |
| WAL             | Crash-resilient state | NOT USED            |
| R2 Sync         | Cloud backup (30s)    | NOT USED            |
| Scheduler       | Periodic tasks        | NOT USED            |
| Recovery Engine | Multi-source fallback | NOT USED            |

---

## Goals

### Primary Goals

1. **Crash Resilience** - Beads state survives container restarts via WAL integration
2. **Cloud Persistence** - Automatic 30-second backup to R2 storage
3. **Automated Maintenance** - Scheduled health checks, sync, and stale alerts

### Success Metrics

| Metric                       | Current     | Target           |
| ---------------------------- | ----------- | ---------------- |
| State survival after restart | 0% (lost)   | 100% (recovered) |
| Backup frequency             | Manual only | Every 30 seconds |
| Health monitoring            | None        | Every 15 minutes |
| Stale issue detection        | None        | Daily alerts     |

### Non-Goals (Future Phases)

- Run-mode unification with beads (Phase 4)
- Cron-based task decomposition (Phase 5)
- Learning extraction from sprints (Phase 6)

---

## User Stories

### US-1: Crash Recovery

**As** a developer using Loa in a container
**I want** beads state to survive unexpected container restarts
**So that** I don't lose task progress when infrastructure fails

**Acceptance Criteria:**

- [ ] WAL records every `br create/update/close/label/comment` operation
- [ ] On container start, WAL is replayed to restore SQLite state
- [ ] Recovery completes within 5 seconds for typical workloads (<100 tasks)

### US-2: Cloud Backup

**As** a developer working across multiple devices
**I want** beads state automatically synced to R2 cloud storage
**So that** I can recover from any failure and work from any machine

**Acceptance Criteria:**

- [ ] `.beads/` directory included in R2 sync paths
- [ ] Changes appear in R2 within 30 seconds
- [ ] New container instances inherit beads state from R2

### US-3: Health Monitoring

**As** a developer
**I want** automatic health checks on my beads database
**So that** I'm alerted before corruption causes problems

**Acceptance Criteria:**

- [ ] `br doctor` runs every 15 minutes via scheduler
- [ ] Unhealthy status triggers circuit breaker (stops hammer attempts)
- [ ] Console warnings for health issues

### US-4: Automatic Sync

**As** a developer
**I want** beads state automatically synced to JSONL
**So that** I don't have to remember manual `br sync` commands

**Acceptance Criteria:**

- [ ] `br sync --flush-only` runs every 5 minutes via scheduler
- [ ] Mutex prevents concurrent sync/git operations
- [ ] Failures trigger circuit breaker

### US-5: Stale Issue Alerts

**As** a team lead
**I want** daily alerts for stale issues
**So that** I can identify blocked or forgotten work

**Acceptance Criteria:**

- [ ] Daily check for issues untouched >7 days
- [ ] Console warning with count of stale issues
- [ ] Can be disabled via configuration

---

## Requirements

### Functional Requirements

#### FR-1: WAL Integration

| ID     | Requirement                                         | Priority |
| ------ | --------------------------------------------------- | -------- |
| FR-1.1 | Create BeadsWALAdapter class that wraps WALManager  | P0       |
| FR-1.2 | Record bead transitions before SQLite writes        | P0       |
| FR-1.3 | Implement replay mechanism for crash recovery       | P0       |
| FR-1.4 | Add beads recovery to RecoveryEngine fallback chain | P1       |

#### FR-2: R2 Sync Integration

| ID     | Requirement                                  | Priority |
| ------ | -------------------------------------------- | -------- |
| FR-2.1 | Add `.beads/` to SYNC_PATHS in sync.ts       | P0       |
| FR-2.2 | Exclude `beads.db-journal` and lock files    | P1       |
| FR-2.3 | Verify bi-directional sync (upload/download) | P0       |

#### FR-3: Scheduler Tasks

| ID     | Requirement                                                     | Priority |
| ------ | --------------------------------------------------------------- | -------- |
| FR-3.1 | Register `beads_health` task (15 min, checks `br doctor`)       | P0       |
| FR-3.2 | Register `beads_sync` task (5 min, runs `br sync --flush-only`) | P0       |
| FR-3.3 | Register `beads_stale_check` task (24h, reports stale issues)   | P1       |
| FR-3.4 | All tasks have circuit breakers (3 failures, 5 min reset)       | P0       |
| FR-3.5 | `beads_sync` in mutex group with git_sync                       | P1       |

### Non-Functional Requirements

| ID    | Requirement        | Target                    |
| ----- | ------------------ | ------------------------- |
| NFR-1 | WAL replay time    | <5 seconds for 100 tasks  |
| NFR-2 | R2 sync latency    | <30 seconds after change  |
| NFR-3 | Scheduler overhead | <1% CPU when idle         |
| NFR-4 | Storage overhead   | <10% increase in WAL size |

---

## Technical Constraints

### Must Use

- Existing WALManager (`deploy/loa-identity/wal/wal-manager.ts`)
- Existing Scheduler (`deploy/loa-identity/scheduler/scheduler.ts`)
- Existing R2 sync patterns (`upstream/moltworker/src/gateway/sync.ts`)
- beads_rust CLI (`br` commands with `--json` output)

### Must Not

- Modify beads_rust source code
- Add new npm dependencies
- Change beads CLI interface
- Break existing beads functionality

### Compatibility

- Must work with existing skills that use beads
- Must not require changes to `.claude/protocols/beads-integration.md`
- Must be opt-in (existing behavior unchanged if disabled)

---

## Architecture Overview

### Target State

```
┌───────────────────────────────────────────────────────────────────┐
│                      OpenClaw Persistence Layer                    │
├───────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐   │
│  │    WAL      │    │  Scheduler  │    │    R2 Sync          │   │
│  │  Manager    │    │             │    │                     │   │
│  └──────┬──────┘    └──────┬──────┘    └──────────┬──────────┘   │
│         │                  │                       │              │
│         │ recordTransition │ beads_health          │ 30s sync     │
│         │                  │ beads_sync            │              │
│         ▼                  │ beads_stale           │              │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │                  BeadsWALAdapter                          │    │
│  │  - Records transitions to WAL                             │    │
│  │  - Replays on recovery                                    │    │
│  │  - Integrates with RecoveryEngine                         │    │
│  └──────────────────────────────────────────────────────────┘    │
│                              │                                    │
└──────────────────────────────┼────────────────────────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │      .beads/        │
                    │  beads.db (SQLite)  │
                    │  issues.jsonl       │
                    └─────────────────────┘
```

---

## Risk Assessment

| Risk                   | Likelihood | Impact | Mitigation                                  |
| ---------------------- | ---------- | ------ | ------------------------------------------- |
| WAL corruption         | Low        | High   | SHA-256 checksums per entry                 |
| R2 sync conflict       | Medium     | Medium | Last-write-wins, manual merge for conflicts |
| Scheduler hammering    | Low        | Low    | Circuit breakers with 5-min reset           |
| SQLite lock contention | Medium     | Low    | Single-writer via mutex group               |
| Recovery loop          | Low        | High   | Max 3 failures in 10-min window             |

---

## Dependencies

### External

- R2 storage account (already configured)
- beads_rust binary installed (`br` command)

### Internal

- WALManager from `deploy/loa-identity/wal/`
- Scheduler from `deploy/loa-identity/scheduler/`
- RecoveryEngine from `deploy/loa-identity/recovery/`

---

## Configuration

### New Configuration Keys

```yaml
# In .loa.config.yaml or environment
beads:
  persistence:
    enabled: true # Master switch for all persistence features

  wal:
    enabled: true # Record transitions to WAL
    replay_on_start: true # Replay WAL on container start

  r2:
    enabled: true # Include in R2 sync
    sync_interval_ms: 30000 # Sync frequency (default: 30s)

  scheduler:
    health_check:
      enabled: true
      interval_ms: 900000 # 15 minutes
    auto_sync:
      enabled: true
      interval_ms: 300000 # 5 minutes
    stale_check:
      enabled: true
      interval_ms: 86400000 # 24 hours
      stale_days: 7 # Issues older than this are stale
```

### Environment Variables

| Variable                | Purpose                        | Default |
| ----------------------- | ------------------------------ | ------- |
| `LOA_BEADS_PERSISTENCE` | Enable/disable all persistence | `true`  |
| `LOA_BEADS_WAL_ENABLED` | Enable WAL recording           | `true`  |
| `LOA_BEADS_R2_ENABLED`  | Enable R2 sync                 | `true`  |

---

## Rollout Plan

### Phase 1: Development (This Sprint)

1. Implement BeadsWALAdapter
2. Add scheduler tasks
3. Update R2 sync paths
4. Add to recovery engine

### Phase 2: Testing

1. Unit tests for WAL adapter
2. Integration tests for scheduler tasks
3. Manual testing of crash recovery

### Phase 3: Documentation

1. Update beads-integration.md protocol
2. Add troubleshooting guide
3. Update CLAUDE.md with new config

---

## Success Criteria

| Criteria                | Verification                                |
| ----------------------- | ------------------------------------------- |
| WAL records transitions | Logs show `[beads-wal] recorded transition` |
| Crash recovery works    | After kill -9, state restored on restart    |
| R2 sync includes beads  | `.beads/` visible in R2 bucket              |
| Health checks running   | Scheduler status shows `beads_health` task  |
| Auto-sync running       | Scheduler status shows `beads_sync` task    |
| Stale alerts working    | Console warning for stale issues            |

---

## Open Questions

1. **Q**: Should WAL record all bead operations or just state-changing ones?
   **A**: State-changing only (create, update, close, label, comment). Queries are idempotent.

2. **Q**: How to handle WAL replay conflicts with existing SQLite state?
   **A**: WAL is authoritative after crash. Clear SQLite and replay from WAL.

3. **Q**: Should stale check create beads issues for tracking?
   **A**: No, just console warnings. Keep it simple for v1.

---

## Appendix

### Related Documents

- Beads Integration Review: `grimoires/loa/a2a/audits/2026-02-04-beads-review/BEADS-INTEGRATION-REVIEW.md`
- Beads Protocol: `.claude/protocols/beads-integration.md`
- WAL Manager: `deploy/loa-identity/wal/wal-manager.ts`
- Scheduler: `deploy/loa-identity/scheduler/scheduler.ts`

### Glossary

| Term            | Definition                                                |
| --------------- | --------------------------------------------------------- |
| WAL             | Write-Ahead Log - crash-resilient sequential log          |
| R2              | Cloudflare R2 - S3-compatible object storage              |
| beads_rust      | Rust-based issue tracker CLI (`br` command)               |
| Circuit breaker | Pattern that stops retry attempts after repeated failures |

---

_Generated by Loa Simstim Workflow_
