# Sprint Plan: LOA-OpenClaw Integration

> **Status**: Ready
> **Version**: 0.2.0
> **Created**: 2026-02-04
> **PRD**: `grimoires/loa/loa-integration-prd.md` v0.2.0
> **SDD**: `grimoires/loa/loa-integration-sdd.md` v0.2.0
> **Sprint Duration**: 2 sprints (1 week each)
> **Sequencing**: Foundation → Integration

---

## Sprint Overview

| Sprint | Focus | Goal | Tasks |
|--------|-------|------|-------|
| **Sprint 1** | Plugin Foundation | Adapter layer + SOUL.md generation | 8 tasks |
| **Sprint 2** | Memory & Recovery | Hooks + context injection + recovery | 9 tasks |

**MVP Complete After**: Sprint 2
**New Code Estimate**: ~800 LOC
**Reused Code**: ~3,200 LOC from deploy/loa-identity/

---

## Sprint 1: Plugin Foundation

**Goal**: Create plugin structure with SDK adapter and SOUL.md generation

**Duration**: Week 1

### Task 1.1: Create Plugin Directory Structure

**Description**: Set up `extensions/loa/` with proper package structure

**Acceptance Criteria**:
- [ ] `extensions/loa/package.json` exists with correct dependencies
- [ ] `extensions/loa/tsconfig.json` configured
- [ ] Directory structure matches SDD Section 3
- [ ] `pnpm install` succeeds in plugin directory

**Files to create**:
```
extensions/loa/
├── package.json
├── tsconfig.json
├── index.ts
├── types.ts
├── adapters/
│   └── .gitkeep
├── bridges/
│   └── .gitkeep
├── state/
│   └── .gitkeep
└── __tests__/
    └── .gitkeep
```

---

### Task 1.2: Implement SDK Adapter Layer

**Description**: Create hook adapter that isolates plugin from SDK changes (SDD 2.0)

**Acceptance Criteria**:
- [ ] `adapters/hook-adapter.ts` implements `HookAdapter` interface
- [ ] `validateSdkVersion()` checks required APIs exist
- [ ] Graceful error messages when APIs missing
- [ ] Unit tests for adapter validation

**PRD Reference**: FR-6 (Hook Lifecycle Contract)

**Dependencies**: 1.1

---

### Task 1.3: Create Plugin Entry Point

**Description**: Implement main plugin export with init function (SDD 2.1)

**Acceptance Criteria**:
- [ ] `index.ts` exports `OpenClawPlugin` interface
- [ ] `init()` creates hook adapter and validates SDK
- [ ] Self-test confirms all hooks registered
- [ ] Plugin loads without errors in OpenClaw

**PRD Reference**: FR-5 (Plugin Structure)

**Dependencies**: 1.2

---

### Task 1.4: Implement LoaContext Types

**Description**: Define TypeScript interfaces for LOA context (SDD 4.1)

**Acceptance Criteria**:
- [ ] `types.ts` defines `LoaContext`, `LoaConfig`, `LoaPluginState`
- [ ] Types align with existing deploy/loa-identity exports
- [ ] No `any` types

**Dependencies**: 1.1

---

### Task 1.5: Create Init Bridge

**Description**: Bridge to initialize LOA systems from existing deploy/loa-identity

**Acceptance Criteria**:
- [ ] `bridges/init.ts` creates `LoaContext` from config
- [ ] Imports IdentityLoader, SessionMemoryManager, RecoveryEngine
- [ ] Creates SoulGenerator, RetryQueue, PluginState
- [ ] Returns fully initialized context
- [ ] **Flatline: Import validation** - Verify all deploy/loa-identity imports resolve correctly at init
- [ ] Fail fast with actionable error if module resolution fails (ESM/CJS mismatch, missing exports)

**Dependencies**: 1.4

---

### Task 1.6: Implement SoulGenerator

**Description**: Transform BEAUVOIR.md to SOUL.md (SDD 2.2)

**Acceptance Criteria**:
- [ ] `bridges/soul-generator.ts` implements `SoulGenerator` class
- [ ] `generate()` reads BEAUVOIR.md via IdentityLoader
- [ ] `transformToSoul()` produces markdown matching PRD template
- [ ] FR-1.6: Checksum verification before generation
- [ ] FR-7.2: Atomic write via temp + rename
- [ ] Unit tests for transformation

**PRD Reference**: FR-1 (SOUL.md Generation)

**Dependencies**: 1.5

---

### Task 1.7: Implement Bootstrap Hook

**Description**: Register bootstrap hook that triggers SOUL.md generation with self-healing

**Acceptance Criteria**:
- [ ] `bridges/bootstrap.ts` exports hook handler
- [ ] Hook calls `soulGenerator.generate()` on agent bootstrap
- [ ] **Flatline: Self-healing bootstrap** - On failure, retry with exponential backoff (3 attempts in 60s window)
- [ ] Allow agent to start in degraded mode after grace period (LOA attempts recovery in background)
- [ ] **Status visibility** - Log/emit event when LOA is not in control ("LOA disconnected")
- [ ] **Status visibility** - Log/emit event when LOA recovers ("LOA reconnected and riding")
- [ ] SOUL.md regenerated when BEAUVOIR.md changes
- [ ] Background recovery task continues attempting to restore LOA identity

**PRD Reference**: FR-1, FR-6

**Dependencies**: 1.6

---

### Task 1.8: Sprint 1 Integration Test

**Description**: Verify plugin loads and SOUL.md generates correctly

**Acceptance Criteria**:
- [ ] Plugin loads in OpenClaw test harness
- [ ] BEAUVOIR.md → SOUL.md transformation verified
- [ ] Checksum embedded in SOUL.md footer
- [ ] No errors in console output

**Dependencies**: 1.7

---

### Sprint 1 Definition of Done

- [ ] Plugin directory structure created
- [ ] SDK adapter layer implemented with validation
- [ ] SoulGenerator produces correct SOUL.md
- [ ] Bootstrap hook triggers generation
- [ ] All unit tests passing
- [ ] Integration test passes
- [ ] Commit: `feat(loa): plugin foundation with SOUL.md generation`

---

## Sprint 2: Memory & Recovery

**Goal**: Implement memory capture, context injection, and recovery

**Duration**: Week 2

### Task 2.1: Implement MemoryCapture Hook

**Description**: Capture interactions via agent_end hook (SDD 2.3)

**Acceptance Criteria**:
- [ ] `bridges/memory.ts` exports `loaAgentEnd` handler
- [ ] **Flatline: Use existing 6 quality gates** from SessionMemoryManager for "significant content":
  - Length gate (min chars)
  - Entropy gate (information density)
  - Uniqueness gate (not duplicate of recent)
  - Recency gate (time-based filtering)
  - Relevance gate (topic alignment)
  - PII gate (redaction check)
- [ ] Calls SessionMemoryManager.capture() with quality-gated content
- [ ] FR-6.4: Fail-open with retry queue
- [ ] Unit tests for capture logic

**PRD Reference**: FR-2 (Memory Capture)

**Dependencies**: Sprint 1 complete

---

### Task 2.2: Implement RetryQueue

**Description**: Async retry for failed memory captures (SDD 6.2)

**Acceptance Criteria**:
- [ ] `state/retry-queue.ts` implements `RetryQueue` class
- [ ] Exponential backoff between retries
- [ ] Max 3 attempts before logging failure
- [ ] Queue processing doesn't block main thread

**Dependencies**: 2.1

---

### Task 2.3: Implement ContextInjector Hook

**Description**: Inject memory context via before_agent_start hook (SDD 2.4)

**Acceptance Criteria**:
- [ ] `bridges/context.ts` exports `loaBeforeAgentStart` handler
- [ ] Loads recent sessions from NOTES.md
- [ ] Loads active learnings from store
- [ ] **Flatline: Input sanitization** - Sanitize/escape memory content before injection:
  - Strip or escape XML-like tags that could be interpreted as system directives
  - Block known prompt injection patterns (e.g., "ignore previous instructions")
  - Validate content structure before prepending
- [ ] FR-8: Token budget with prioritization
- [ ] Returns `{ prependContext }` result
- [ ] FR-6.4: Fail-open policy

**PRD Reference**: FR-4 (Context Injection), FR-8 (Token Budget)

**Dependencies**: 2.1, 2.4

---

### Task 2.4: Implement LearningStore Interface

**Description**: Define and implement `getActive()` method (Flatline: IMP-008)

**Acceptance Criteria**:
- [ ] `bridges/learnings.ts` wraps existing LearningStore
- [ ] `getActive(limit)` returns top N learnings by effectiveness
- [ ] Filters out archived/inactive learnings
- [ ] Returns empty array if no learnings exist

**Dependencies**: Sprint 1 complete

---

### Task 2.5: Implement LoopDetector

**Description**: Track recovery attempts for loop detection (SDD 2.5)

**Acceptance Criteria**:
- [ ] `state/loop-detector.ts` implements loop tracking
- [ ] Configurable via env vars (LOA_RECOVERY_WINDOW_MS, LOA_RECOVERY_MAX_ATTEMPTS)
- [ ] Distinguishes crash vs graceful shutdown
- [ ] Unit tests for detection logic

**PRD Reference**: FR-3.7-3.9

**Dependencies**: Sprint 1 complete

---

### Task 2.6: Implement RecoveryRunner

**Description**: Run recovery on plugin initialization (SDD 2.5)

**Acceptance Criteria**:
- [ ] `bridges/recovery.ts` exports `runRecovery` function
- [ ] Calls RecoveryEngine.run()
- [ ] Integrates loop detection
- [ ] FR-3.8: Enters degraded mode after max attempts
- [ ] Logs recovery actions to audit log

**PRD Reference**: FR-3 (Recovery)

**Dependencies**: 2.5

---

### Task 2.7: Wire Recovery into Plugin Init

**Description**: Ensure recovery runs before hooks are registered

**Acceptance Criteria**:
- [ ] `init()` calls `runRecovery(loa)` before hook registration
- [ ] Plugin blocks on recovery completion
- [ ] Degraded mode flag accessible to other hooks
- [ ] Hooks skip memory writes if degraded

**Dependencies**: 2.6

---

### Task 2.8: Add Conflict Logging

**Description**: Log overwrites for last-write-wins auditing (Flatline: SKP-004)

**Acceptance Criteria**:
- [ ] NOTES.md writes log previous hash if overwriting
- [ ] WAL segment conflicts logged to audit log
- [ ] Conflict rate trackable via logs

**PRD Reference**: FR-7.5

**Dependencies**: 2.1

---

### Task 2.9: Sprint 2 E2E Test

**Description**: Full integration test with all hooks firing

**Acceptance Criteria**:
- [ ] Plugin initializes with recovery
- [ ] Send message → agent_end captures memory
- [ ] Next message → before_agent_start injects context
- [ ] NOTES.md updated with session entry
- [ ] Recovery from corrupted state works

**Dependencies**: 2.7, 2.8

---

### Sprint 2 Definition of Done

- [ ] Memory capture via agent_end hook working
- [ ] Context injection via before_agent_start working
- [ ] Recovery runs on plugin init
- [ ] Loop detection functional
- [ ] Conflict logging enabled
- [ ] All unit tests passing
- [ ] E2E test passes
- [ ] **MVP COMPLETE**
- [ ] Commit: `feat(loa): memory capture, context injection, and recovery`

---

## Task Dependencies

```
Sprint 1:
1.1 ──► 1.2 ──► 1.3
  │       │
  └──► 1.4 ──► 1.5 ──► 1.6 ──► 1.7 ──► 1.8

Sprint 2:
2.1 ──► 2.2
  │
  └──► 2.3
  │
  └──► 2.8
2.4 ──► 2.3
2.5 ──► 2.6 ──► 2.7 ──► 2.9
```

---

## Risk Register

| Risk | Sprint | Mitigation |
|------|--------|------------|
| OpenClaw SDK mismatch | 1 | Adapter layer + SDK validation |
| IdentityLoader import issues | 1 | Test imports early in 1.5, fail-fast validation |
| Memory capture performance | 2 | Async retry queue, 6 quality gates filter |
| Recovery blocks startup | 2 | Configurable timeouts, degraded mode |
| Bootstrap bricks agent | 1 | Self-healing with grace period (Flatline) |
| Prompt injection via memory | 2 | Input sanitization before injection (Flatline) |
| ESM/CJS module mismatch | 1 | Import validation at init (Flatline) |

---

## Success Metrics

### Sprint 1 Metrics

- [ ] Plugin loads in OpenClaw
- [ ] SOUL.md generates from BEAUVOIR.md
- [ ] Checksum verification works
- [ ] Unit tests pass

### Sprint 2 Metrics (MVP)

- [ ] Memory captured after conversations
- [ ] Context injected before agent runs
- [ ] Recovery runs on startup
- [ ] Agent embodies LOA personality (concise, opinionated, resourceful)

---

## Appendix: Task Quick Reference

### Sprint 1 Tasks
- 1.1 Create Plugin Directory Structure
- 1.2 Implement SDK Adapter Layer
- 1.3 Create Plugin Entry Point
- 1.4 Implement LoaContext Types
- 1.5 Create Init Bridge
- 1.6 Implement SoulGenerator
- 1.7 Implement Bootstrap Hook
- 1.8 Sprint 1 Integration Test

### Sprint 2 Tasks
- 2.1 Implement MemoryCapture Hook
- 2.2 Implement RetryQueue
- 2.3 Implement ContextInjector Hook
- 2.4 Implement LearningStore Interface
- 2.5 Implement LoopDetector
- 2.6 Implement RecoveryRunner
- 2.7 Wire Recovery into Plugin Init
- 2.8 Add Conflict Logging
- 2.9 Sprint 2 E2E Test

---

*Generated by Loa Framework v1.21.0*
