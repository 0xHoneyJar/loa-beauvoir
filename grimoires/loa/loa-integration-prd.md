# PRD: LOA-OpenClaw Integration

> **Status**: Flatline Reviewed
> **Version**: 0.2.0
> **Created**: 2026-02-04
> **Updated**: 2026-02-04
> **Author**: Claude Opus 4.5 + Human Operator
> **Flatline**: Reviewed (5 HIGH_CONSENSUS integrated, 7 blockers resolved)

---

## Executive Summary

Integrate LOA's identity system (BEAUVOIR.md, memory, recovery) into the OpenClaw agent runtime so that LOA governs agent behavior from within. Rather than running as a parallel system, LOA becomes the **soul** of the agent - managing SOUL.md content, capturing interactions to memory, and auto-recovering from failures.

**Key Insight**: LOA operates as an OpenClaw plugin, following existing patterns (hooks, bootstrap files) rather than modifying core agent code. This maintains upstream compatibility while ensuring LOA is always active.

---

## 1. Problem Statement

### Current State

LOA and OpenClaw are **parallel systems** in this repository:

| System | Location | Purpose | Integration |
|--------|----------|---------|-------------|
| OpenClaw Agent | `src/agents/` | Bootstrap files, system prompt, sessions | Loads SOUL.md for persona |
| LOA Identity | `deploy/loa-identity/` | BEAUVOIR.md, memory, recovery | Standalone deployment layer |

The agent loads `SOUL.md` for persona, but LOA's identity system (BEAUVOIR.md with 6 principles, quality gates, recovery protocol) sits unused during agent runtime.

### Desired State

LOA **governs** the OpenClaw agent:

1. **SOUL.md managed by LOA** - LOA generates/updates SOUL.md content from BEAUVOIR.md
2. **Memory capture active** - Every significant interaction logged via `agent_end` hook
3. **Recovery on startup** - Gateway start triggers LOA recovery state machine
4. **Always on** - No config flag; LOA is the default in this fork

### Why This Matters

- **Personality consistency**: BEAUVOIR.md principles enforced through SOUL.md
- **Memory continuity**: Interactions captured with quality gates + PII redaction
- **Resilience**: Auto-recovery ensures agent never stops and waits
- **Upstream compatibility**: Plugin pattern means clean separation from OpenClaw core

---

## 2. Vision & Goals

### Vision Statement

> *"LOA rides the agent - governing its soul, capturing its memory, and ensuring it never dies."*

### Primary Goals

| Goal | Description | Success Metric |
|------|-------------|----------------|
| **G-1** | SOUL.md reflects LOA principles | Agent responses embody BEAUVOIR.md (concise, opinionated, resourceful) |
| **G-2** | Memory captures interactions | NOTES.md updated with significant interactions via quality gates |
| **G-3** | Recovery runs automatically | Gateway start triggers R2 → Git → Template fallback |
| **G-4** | Plugin pattern maintained | All LOA code in plugin; no core agent modifications |

---

## 3. Architecture Overview

### Integration Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    OPENCLAW AGENT RUNTIME                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Bootstrap Files (workspace.ts)                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ AGENTS.md│ │ SOUL.md  │ │ TOOLS.md │ │IDENTITY.md│ ...      │
│  └──────────┘ └────┬─────┘ └──────────┘ └──────────┘          │
│                    │                                            │
│                    │ MANAGED BY LOA                             │
│                    ▼                                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  LOA PLUGIN                              │   │
│  │                                                         │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │ Hook: bootstrap                                  │   │   │
│  │  │ • Generates SOUL.md from BEAUVOIR.md            │   │   │
│  │  │ • Ensures LOA principles in agent persona       │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                                                         │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │ Hook: before_agent_start                         │   │   │
│  │  │ • Injects NOTES.md context (recent memory)      │   │   │
│  │  │ • Prepends active learnings                     │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                                                         │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │ Hook: agent_end                                  │   │   │
│  │  │ • Captures interaction to memory                │   │   │
│  │  │ • Applies quality gates + PII redaction         │   │   │
│  │  │ • Updates NOTES.md if significant               │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                                                         │   │
│  │  ┌─────────────────────────────────────────────────┐   │   │
│  │  │ Hook: gateway_start                              │   │   │
│  │  │ • Runs recovery state machine                   │   │   │
│  │  │ • R2 → Git → Template fallback                  │   │   │
│  │  │ • Verifies cryptographic signatures             │   │   │
│  │  └─────────────────────────────────────────────────┘   │   │
│  │                                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Existing Hook System (src/plugins/, src/hooks/)               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| LOA as plugin, not core modification | Follows OpenClaw patterns; maintains upstream compatibility |
| SOUL.md managed by LOA | Continuity with existing bootstrap; LOA governs content |
| Always on (no config flag) | This fork is LOA-native; no opt-in needed |
| Use existing hook system | `before_agent_start`, `agent_end`, internal hooks all available |
| Reuse deploy/loa-identity/ | Existing implementations are complete; just need bridges |

---

## 4. Functional Requirements

### FR-1: SOUL.md Generation from BEAUVOIR.md

LOA generates `SOUL.md` content from `BEAUVOIR.md` to inject its principles into the agent.

| Requirement | Description |
|-------------|-------------|
| FR-1.1 | On bootstrap, read BEAUVOIR.md and generate SOUL.md content |
| FR-1.2 | Include core principles (concise, opinionated, resourceful, etc.) |
| FR-1.3 | Include boundaries (will not do / always do) |
| FR-1.4 | Include interaction style guidance |
| FR-1.5 | Track BEAUVOIR.md changes; regenerate SOUL.md on modification |
| FR-1.6 | Verify BEAUVOIR.md integrity (checksum) before generation (Flatline: IMP-002) |
| FR-1.7 | **LOA fully owns SOUL.md** - no user overrides in this fork; ensures memory consistency |

**SOUL.md Content Template** (generated from BEAUVOIR.md):

```markdown
# Soul

You embody the following principles:

## Core Principles
1. **Understand Before Acting** - Verify before stating facts
2. **Procedures Exist for Good Reasons** - Follow Loa workflows
3. **Conciseness Respects Time** - Lead with answers, use tables/lists
4. **Opinions Enable Decisions** - Recommend rather than enumerate
5. **Resourcefulness Before Questions** - Check before asking
6. **Survival is a Feature** - Auto-recover; never stop and wait

## Interaction Style
- Concise: Skip pleasantries, lead with substance
- Opinionated: Recommend, don't enumerate options
- Transparent: Show reasoning, admit uncertainty
- Resourceful: Try before failing, check before asking

## Boundaries
### Will Not Do
- Guess credentials or sensitive values
- Push code without review
- Claim certainty when uncertain

### Always Do
- Log significant decisions to NOTES.md
- Cite sources for factual claims
- Follow Loa workflows for structured tasks
- Auto-recover from failures

---
*Generated by LOA from BEAUVOIR.md*
```

**Acceptance Criteria**:
- [ ] SOUL.md reflects BEAUVOIR.md principles
- [ ] Changes to BEAUVOIR.md trigger SOUL.md regeneration
- [ ] Agent responses demonstrate LOA personality traits

---

### FR-2: Memory Capture via agent_end Hook

Every agent execution triggers memory capture with quality gates.

| Requirement | Description |
|-------------|-------------|
| FR-2.1 | Register `agent_end` hook via plugin API |
| FR-2.2 | Extract significant content from conversation messages |
| FR-2.3 | Apply 6 quality gates (temporal, speculation, instruction, confidence, length, duplicate) |
| FR-2.4 | Apply PII redaction before storage (using existing `pii-redactor.ts` with entropy detection) |
| FR-2.5 | Write passing entries to WAL for persistence |
| FR-2.6 | Update NOTES.md Session Continuity section |

**Quality Gates** (from existing SessionMemoryManager):

| Gate | Threshold | Purpose |
|------|-----------|---------|
| Temporal | Recency weighted | Recent entries score higher |
| Speculation | Pattern filter | Filters "maybe/perhaps" uncertainty |
| Instruction | Boost | Higher score for "always/never/prefer" patterns |
| Confidence | ≥ 0.5 | Minimum confidence threshold |
| Content Length | ≥ 10 chars | Filters trivial content |
| Duplicate | SHA-256 hash | Prevents duplicate entries |

**Acceptance Criteria**:
- [ ] `agent_end` hook registered and fires after each agent run
- [ ] Significant interactions captured to memory
- [ ] Low-quality content filtered by gates
- [ ] PII redacted before storage
- [ ] NOTES.md updated with session entry

---

### FR-3: Recovery on Gateway Start

Gateway startup triggers LOA recovery state machine.

| Requirement | Description |
|-------------|-------------|
| FR-3.1 | Register `gateway_start` hook (or startup initialization) |
| FR-3.2 | Run RecoveryEngine state machine |
| FR-3.3 | Verify BEAUVOIR.md and NOTES.md integrity |
| FR-3.4 | Restore from R2 → Git → Template if corrupted |
| FR-3.5 | Verify Ed25519 signatures on manifests (using existing `key-manager.ts`) |
| FR-3.6 | Log recovery actions to audit log |
| FR-3.7 | Loop detection: >3 recovery attempts in 60s triggers degraded mode (Flatline: SKP-003) |
| FR-3.8 | Degraded mode: Agent runs with template identity, writes disabled, operator alert |
| FR-3.9 | Manual intervention trigger after 3 degraded mode cycles |

**Recovery State Machine** (from existing RecoveryEngine):

```
START → CHECK_INTEGRITY → INTEGRITY_OK → RUNNING
              ↓
        RESTORE_R2 ← FAILED
              ↓
        RESTORE_GIT ← FAILED
              ↓
     RESTORE_TEMPLATE ← FAILED
              ↓
       VERIFY_RESTORE
              ↓
          RUNNING
```

**Acceptance Criteria**:
- [ ] Recovery runs automatically on gateway start
- [ ] Corrupted files detected and restored
- [ ] Signature verification on all restored files
- [ ] Recovery logged to NOTES.md

---

### FR-4: Context Injection via before_agent_start Hook

Inject relevant memory context before each agent run.

| Requirement | Description |
|-------------|-------------|
| FR-4.1 | Register `before_agent_start` hook |
| FR-4.2 | Load recent entries from NOTES.md Session Continuity |
| FR-4.3 | Load active learnings from compound store |
| FR-4.4 | Prepend context to prompt (within token budget) |
| FR-4.5 | Track context injection in audit log |

**Context Template**:

```
## Session Context (from NOTES.md)

Recent sessions:
- [timestamp] [summary]
- [timestamp] [summary]

Active learnings:
- [trigger]: [pattern] → [solution]
```

**Acceptance Criteria**:
- [ ] Recent memory context injected before agent runs
- [ ] Active learnings available to agent
- [ ] Token budget respected (configurable limit)

---

### FR-5: Plugin Structure Following OpenClaw Patterns

LOA integration follows OpenClaw plugin conventions.

| Requirement | Description |
|-------------|-------------|
| FR-5.1 | Create LOA plugin in `extensions/loa/` or `src/loa/` |
| FR-5.2 | Export standard plugin interface (`OpenClawPlugin`) |
| FR-5.3 | Register hooks via `api.on()` for plugin hooks |
| FR-5.4 | Register hooks via `api.registerHook()` for internal hooks |
| FR-5.5 | Initialize LOA systems (identity, memory, recovery) on plugin load |

**Plugin Interface**:

```typescript
export default {
  name: 'loa',
  version: '1.0.0',

  async init(api: OpenClawPluginApi) {
    // Initialize LOA systems
    const loa = await initializeLoa({
      grimoiresDir: 'grimoires/loa',
      walDir: '.loa/wal',
    });

    // Register hooks
    api.on('before_agent_start', loaBeforeAgentStart);
    api.on('agent_end', loaAgentEnd);
    api.registerHook('agent:bootstrap', loaBootstrapHook);

    // Run recovery on init
    await loa.recovery.run();
  }
};
```

**Acceptance Criteria**:
- [ ] Plugin loads without errors
- [ ] All hooks registered correctly
- [ ] LOA systems initialized
- [ ] Recovery runs on plugin init

---

### FR-6: Hook Lifecycle Contract (Flatline: SKP-001)

Define explicit hook lifecycle guarantees to ensure LOA functions reliably across all runtime modes.

| Requirement | Description |
|-------------|-------------|
| FR-6.1 | Define required hook firing order: `gateway_start` → `bootstrap` → `before_agent_start` → `agent_end` |
| FR-6.2 | Document hook guarantees per runtime mode (CLI, gateway server, streaming, tool-only) |
| FR-6.3 | Implement startup self-test that asserts all LOA hooks are registered |
| FR-6.4 | Define failure behavior per hook (fail-open vs fail-closed) |
| FR-6.5 | Add fallback initialization if `gateway_start` hook unavailable |

**Hook Failure Policies** (Flatline: IMP-001):

| Hook | Failure Policy | Rationale |
|------|----------------|-----------|
| `gateway_start` | Fail-open with warning | Recovery is best-effort; agent can run without |
| `bootstrap` | Fail-closed | Identity is critical; block agent start |
| `before_agent_start` | Fail-open | Context injection is nice-to-have |
| `agent_end` | Fail-open with retry | Memory capture can be retried async |

**Runtime Mode Guarantees**:

| Mode | `gateway_start` | `bootstrap` | `before_agent_start` | `agent_end` |
|------|-----------------|-------------|---------------------|-------------|
| Gateway (server) | ✓ | ✓ | ✓ | ✓ |
| CLI (direct) | ✗ (use init) | ✓ | ✓ | ✓ |
| Streaming | ✗ | ✓ | ✓ | ✓ |
| Tool-only | ✗ | ✗ | ✗ | ✗ |

**Acceptance Criteria**:
- [ ] Lifecycle contract documented in plugin code
- [ ] Self-test runs on plugin initialization
- [ ] Graceful degradation when hooks unavailable
- [ ] Failure behavior consistent per policy table

---

### FR-7: Concurrency & Atomicity (Flatline: IMP-003, IMP-007)

Ensure data integrity for concurrent writes to NOTES.md and WAL.

| Requirement | Description |
|-------------|-------------|
| FR-7.1 | Single-writer enforcement via file locks (flock) for WAL |
| FR-7.2 | Atomic writes to NOTES.md via temp file + rename |
| FR-7.3 | Per-session WAL segments to prevent interleaving |
| FR-7.4 | Corruption detection via checksum verification |
| FR-7.5 | Conflict resolution strategy for concurrent sessions |

**Note**: Existing `deploy/loa-identity/wal/wal-manager.ts` already implements flock locking and two-phase rotation. This FR formalizes those guarantees.

**Acceptance Criteria**:
- [ ] No data corruption under concurrent agent runs
- [ ] WAL entries maintain ordering guarantees
- [ ] NOTES.md writes are atomic (no partial content)

---

### FR-8: Token Budget Management (Flatline: IMP-004)

Define deterministic behavior when context injection exceeds token limits.

| Requirement | Description |
|-------------|-------------|
| FR-8.1 | Configurable token budget (default: 2000 tokens) |
| FR-8.2 | Prioritization: Pinned items > Recent sessions > Learnings |
| FR-8.3 | Truncation: Oldest entries dropped first within category |
| FR-8.4 | Deterministic selection (same input → same output) |
| FR-8.5 | Log when truncation occurs for debugging |

**Priority Order**:
1. Pinned/critical entries (never truncated)
2. Most recent session entries (by timestamp)
3. Active learnings (by effectiveness score)
4. Older session entries (dropped first)

**Acceptance Criteria**:
- [ ] Context injection never exceeds budget
- [ ] High-priority content always included
- [ ] Truncation is deterministic and logged

---

## 5. Non-Functional Requirements

### NFR-1: Performance

| Metric | Target |
|--------|--------|
| SOUL.md generation | < 100ms |
| Memory capture per interaction | < 50ms |
| Context injection | < 20ms |
| Recovery (happy path) | < 500ms |
| Recovery (full restore) | < 5s |

### NFR-2: Reliability

| Metric | Target |
|--------|--------|
| Memory capture success rate | > 99% |
| Recovery success rate | 100% (template fallback) |
| No data loss on crash | WAL guarantees |

### NFR-3: Upstream Compatibility

| Requirement | Description |
|-------------|-------------|
| No core modifications | All LOA code in plugin/extension |
| Clean diff | Can pull OpenClaw updates without conflicts |
| Standard APIs | Use existing hook/plugin interfaces |

---

## 6. Scope

### In Scope (MVP)

| Feature | Description |
|---------|-------------|
| SOUL.md generation | LOA governs agent persona |
| Memory capture | `agent_end` hook with quality gates |
| Recovery on startup | R2 → Git → Template fallback |
| Context injection | `before_agent_start` with recent memory |
| Plugin structure | Standard OpenClaw plugin pattern |

### Out of Scope (Phase 2)

| Feature | Reason |
|---------|--------|
| Auto-PR generation | Requires compound learning threshold |
| Cross-session consolidation | Memory Phase 2 |
| Memory search tool | Requires tool registration |
| Multi-model consensus | Flatline integration deferred |

---

## 7. Success Criteria

### MVP Success

- [ ] Agent responses embody BEAUVOIR.md principles (concise, opinionated, resourceful)
- [ ] NOTES.md Session Continuity updated after conversations
- [ ] Recovery runs on gateway start without errors
- [ ] Plugin loads cleanly following OpenClaw patterns
- [ ] No modifications to OpenClaw core (`src/agents/` unchanged)

### Verification Tests

1. **Personality Test**: Send casual question; verify concise, opinionated response
2. **Memory Test**: Have conversation; check NOTES.md for session entry
3. **Recovery Test**: Corrupt BEAUVOIR.md; restart gateway; verify restoration
4. **Integration Test**: Full agent flow with all hooks firing

---

## 8. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Hook API changes in upstream | High | Low | Pin OpenClaw version; test before updates |
| Memory capture slows agent | Medium | Low | Async capture; quality gates filter early |
| SOUL.md conflicts with user edits | Medium | Medium | Document LOA management; allow override |
| Recovery loop on bad template | High | Low | Loop detection with degraded mode |

---

## 9. Resolved Questions (Flatline Review)

1. **SOUL.md ownership**: ~~Should users be able to override?~~ **RESOLVED**: LOA fully owns SOUL.md in this fork. No user overrides - ensures memory consistency and LOA governance. (FR-1.7)

2. **Memory token budget**: ~~How much context to inject?~~ **RESOLVED**: Configurable, default 2000 tokens with deterministic prioritization. (FR-8)

3. **Hook priority**: ~~What order relative to other plugins?~~ **RESOLVED**: LOA hooks run early (high priority) for identity establishment. Lifecycle contract defines order. (FR-6)

4. **Key management**: ~~Where are Ed25519 keys stored?~~ **RESOLVED**: Existing `deploy/loa-identity/security/key-manager.ts` handles key lifecycle (484 lines). Referenced in FR-3.5.

5. **PII handling**: ~~Can PII leak via memory?~~ **RESOLVED**: Existing `deploy/loa-identity/security/pii-redactor.ts` uses entropy-based detection (386 lines). Referenced in FR-2.4.

---

## Appendix A: Existing Systems to Reuse

| System | Location | Status |
|--------|----------|--------|
| IdentityLoader | `deploy/loa-identity/identity-loader.ts` | Complete (355 lines) |
| SessionMemoryManager | `deploy/loa-identity/memory/session-manager.ts` | Complete (436 lines) |
| RecoveryEngine | `deploy/loa-identity/recovery/recovery-engine.ts` | Complete (667 lines) |
| WAL Manager | `deploy/loa-identity/wal/wal-manager.ts` | Complete (679 lines) |
| Quality Gates | `deploy/loa-identity/memory/quality-gates.ts` | Complete |
| PII Redactor | `deploy/loa-identity/security/pii-redactor.ts` | Complete (386 lines) |

**Total existing LOA code**: ~15,273 lines across 46 files

## Appendix B: OpenClaw Hook System Reference

**Plugin Hooks** (`src/plugins/types.ts`):
- `before_agent_start` - Prepend context to prompt
- `agent_end` - Post-execution analysis
- `gateway_start` - Gateway initialization
- `gateway_stop` - Gateway shutdown

**Internal Hooks** (`src/hooks/internal-hooks.ts`):
- `agent:bootstrap` - Bootstrap file modification

**Bootstrap Integration** (`src/agents/bootstrap-hooks.ts`):
- `applyBootstrapHookOverrides()` - Modify bootstrap files

---

## Appendix C: Flatline Protocol Review Results

**Review Date**: 2026-02-04
**Cost**: ~$0.76 | **Latency**: 69s | **Agreement**: 100%

### HIGH_CONSENSUS (Auto-Integrated)

| ID | Description | Avg Score | Integration |
|----|-------------|-----------|-------------|
| IMP-001 | Hook failure semantics - specify fail-open/closed policy | 900 | FR-6.4 |
| IMP-002 | BEAUVOIR.md integrity checks before SOUL.md generation | 817 | FR-1.6 |
| IMP-003 | Concurrency strategy for WAL + NOTES.md writes | 890 | FR-7 |
| IMP-004 | Token overflow behavior - prioritization/truncation rules | 775 | FR-8 |
| IMP-007 | Atomicity/locking for NOTES.md writes | 755 | FR-7.2 |

### BLOCKERS (Resolved)

| ID | Concern | Resolution |
|----|---------|------------|
| SKP-001 | Hook lifecycle assumes stability | Added FR-6: Lifecycle Contract |
| SKP-002 | SOUL.md overwrites user customizations | Resolved: LOA fully owns SOUL.md (FR-1.7) |
| SKP-003 | Recovery loop detection unspecified | Added FR-3.7-3.9: Loop detection + degraded mode |
| SKP-004 | Key management underspecified | Reference existing key-manager.ts (FR-3.5) |
| SKP-005 | PII leakage via memory | Reference existing pii-redactor.ts (FR-2.4) |
| SKP-007 | Concurrency/consistency issues | Added FR-7: Concurrency & Atomicity |

---

*Generated by Loa Framework v1.21.0*
*Flatline Protocol v1.17.0 - Multi-model adversarial review*
