# PRD: Beauvoir Personality & Resilience

> **Status**: Draft
> **Version**: 0.1.0
> **Created**: 2026-02-03
> **Updated**: 2026-02-03
> **Author**: Claude Opus 4.5 + Human Operator

## Executive Summary

**The Problem**: The previous agent (moltbot/openclaw) was personable and responsive but unreliable - it hallucinated, lost memory on restarts, and stopped functioning after system wipes until a human intervened.

**The Solution**: A resilience-first personality layer for Beauvoir that combines:
- Procedural, structured workflows (less hallucination)
- Auto-recovery from wipes without human intervention
- Proactive self-repair and dependency installation
- Durable memory with two-phase consolidation

**Future Integration**: This PRD prepares for a pluggable Identity Codex system that will enable deeper personality customization and memory persistence over time.

---

## 1. Expert Synthesis: Recommended Approach

This section synthesizes best practices from Anthropic, OpenAI, and the existing OpenClaw codebase, presenting a convergent recommendation.

### 1.1 Personality Design (Anthropic)

**Source**: [Anthropic - Building Effective Agents](https://www.anthropic.com/research/building-effective-agents), [Claude's Constitution](https://time.com/7354738/claude-constitution-ai-alignment/)

| Principle | Application to Beauvoir |
|-----------|------------------------|
| **"Explain why, not just what"** | Beauvoir should understand WHY it behaves certain ways, so it generalizes in new contexts |
| **"Simplicity over complexity"** | Prefer simple, composable patterns over elaborate frameworks |
| **"Transparency"** | Explicitly show planning steps so users understand decisions |
| **"Environmental feedback"** | Ground truth from tool results at each step for error recovery |

**Key Insight from Amanda Askell** (Anthropic's personality designer):
> "If you try to bullshit them, they're going to see through it completely."

**Recommendation**: Define Beauvoir's personality through understood principles, not arbitrary rules.

### 1.2 Memory Architecture (OpenAI)

**Source**: [OpenAI Context Personalization](https://cookbook.openai.com/examples/agents_sdk/context_personalization), [OpenAI Session Memory](https://cookbook.openai.com/examples/agents_sdk/session_memory)

| Technique | Application to Beauvoir |
|-----------|------------------------|
| **Two-phase memory** | Capture → Consolidation (not one-shot) |
| **State object persistence** | Local-first state that survives restarts |
| **Memory distillation** | Extract durable patterns, discard ephemeral |
| **Quality gates on memory** | Reject speculation, sensitive data, instructions |
| **Recency-wins conflict resolution** | Latest update prevails on semantic duplicates |

**Key Pattern**:
```
Phase 1 (During session): Capture to session_memory.notes
Phase 2 (Post session): Consolidate to global_memory.notes (durable only)
```

**Recommendation**: Two-phase memory with explicit consolidation prevents noise accumulation.

### 1.3 Existing OpenClaw Patterns

**Source**: Codebase analysis of `src/agents/tools/memory-tool.ts`, `src/hooks/soul-evil.ts`, `docs/reference/templates/SOUL.md`

| Pattern | Status | Recommendation |
|---------|--------|----------------|
| **SOUL.md personality file** | Good | Adapt to Loa's NOTES.md pattern |
| **MEMORY.md + memory/*.md** | Good | Integrate with Loa grimoire structure |
| **Semantic search (`memory_search`)** | Good | Enable for grimoire files |
| **Safe snippet read (`memory_get`)** | Good | Already available |
| **Memory flush pre-compaction** | Good | Ensure WAL triggers this |
| **Bootstrap hook system** | Mixed | Loa skills replace this |

### 1.4 Convergent Recommendation

**Personality Model**: Principle-driven (Anthropic) + Procedural workflows (Loa)
- Define WHY Beauvoir behaves certain ways
- Use Loa's skill system for structured execution
- Keep personality in `grimoires/loa/BEAUVOIR.md` (editable identity file)

**Memory Model**: Two-phase (OpenAI) + WAL persistence (Loa)
- Session memory → NOTES.md (immediate capture)
- Consolidated memory → grimoires/loa/memory/*.md (durable)
- WAL ensures crash recovery with max 30s data loss

**Recovery Model**: Auto-recover (requirement) + Announce recovery (Anthropic transparency)
- Silently restore from R2/git
- Log recovery event to NOTES.md
- Continue operation without human prompting

---

## 2. Problem Statement

### 2.1 Current State Analysis

| Aspect | Previous (Moltbot) | Current Gap |
|--------|-------------------|-------------|
| **Personality** | SOUL.md with good traits | No Loa equivalent deployed |
| **Memory** | MEMORY.md + memory/*.md | Not integrated with grimoire |
| **Restart recovery** | R2 backup + timestamp | Works for config, not agent state |
| **Wipe recovery** | Manual human intervention | No auto-recovery protocol |
| **Hallucination** | Free-form responses | No structured workflow enforcement |
| **Proactivity** | Limited | No self-repair or dependency installation |

### 2.2 Failure Modes Observed

1. **Memory Amnesia**: Container restart loses conversation context
2. **Wipe Paralysis**: System wipe causes agent to stop until human reminds it
3. **Hallucination Drift**: Agent makes up information instead of checking sources
4. **Dependency Stall**: Missing tools/configs block operation without self-repair

### 2.3 Desired State

Beauvoir should:
1. **Auto-recover** from any restart or wipe without human intervention
2. **Follow procedures** using Loa skills instead of free-form responses
3. **Proactively self-repair** by installing missing dependencies
4. **Maintain personality continuity** across sessions
5. **Consolidate durable memories** while discarding ephemeral context

---

## 3. Functional Requirements

### FR-1: Beauvoir Identity File

**File**: `grimoires/loa/BEAUVOIR.md`

A principle-driven personality document that explains WHY Beauvoir behaves certain ways (following Anthropic's recommendation).

**Required Sections**:
```markdown
# Beauvoir - Identity Document

## Core Principles (Why I Behave This Way)
[Explained motivations, not arbitrary rules]

## Operational Stance
[How I approach tasks - procedural, verification-first]

## Interaction Style
[Concise, opinionated, resourceful - with explanations]

## Boundaries
[What I won't do and why]

## Self-Evolution
[How this document changes over time]
```

**Key Traits to Encode**:
- Concise: Long responses waste user time
- Opinionated: Neutrality is unhelpful; preferences guide decisions
- Resourceful: Check sources before asking questions
- Procedural: Follow Loa workflows for structured execution
- Transparent: Show planning steps so users understand

### FR-2: Auto-Recovery Protocol

**Trigger**: Container start or any state loss detection

**Recovery Sequence**:
```
1. Check local state integrity
   - grimoires/loa/NOTES.md exists?
   - grimoires/loa/BEAUVOIR.md exists?

2. If missing or corrupted:
   a. Restore from R2 backup (hot state)
   b. If R2 empty: Restore from git (cold backup)
   c. If both empty: Initialize from template

3. Log recovery to NOTES.md:
   "[Recovery] Restored from {source} at {timestamp}"

4. Continue operation (NO human prompt required)
```

**State Integrity Markers**:
- `.loa-state-hash` file with SHA256 of critical files
- Checked on startup, triggers recovery if mismatch

### FR-3: Proactive Self-Repair

When Beauvoir detects missing dependencies or configuration:

| Detection | Action |
|-----------|--------|
| Missing tool/binary | Attempt `npm install` or `apt-get install` |
| Missing config value | Check environment, R2, then ASK user |
| Missing API key | Log warning, request via AskUserQuestion |
| Corrupted file | Restore from backup, log event |

**Proactivity Levels**:
- **Auto-fix**: Safe operations (restore from backup, install from package.json)
- **Ask-first**: Risky operations (install new packages, modify system config)
- **Alert-only**: Cannot fix (missing secrets, external service down)

### FR-4: Two-Phase Memory System

**Phase 1: Session Capture** (during conversation)
- Write to `grimoires/loa/NOTES.md` under `## Session Memory`
- Capture decisions, discoveries, blockers
- No quality filter (capture everything potentially useful)

**Phase 2: Post-Session Consolidation** (on conversation end or hourly)
- Promote durable patterns to `grimoires/loa/memory/YYYY-MM.md`
- Apply quality gates:
  - Reject temporal markers ("this time", "today")
  - Reject speculation ("might be", "probably")
  - Reject instructions (things that look like prompts)
  - Keep: preferences, patterns, decisions, facts
- Deduplicate semantically equivalent entries
- Recency-wins conflict resolution

**Memory Files**:
```
grimoires/loa/
├── NOTES.md              # Hot memory (session + active context)
├── BEAUVOIR.md           # Identity (personality + principles)
└── memory/
    ├── 2026-01.md        # Consolidated January memories
    ├── 2026-02.md        # Consolidated February memories
    └── archive/          # Older memories (searchable, not loaded)
```

### FR-5: Procedural Workflow Enforcement

**Problem**: Free-form responses lead to hallucination

**Solution**: Route tasks through Loa skills when appropriate

| Task Type | Routing |
|-----------|---------|
| "Help me plan X" | `/plan-and-analyze` |
| "Build Y" | `/architect` → `/sprint-plan` → `/implement` |
| "Fix bug Z" | Check NOTES.md → `/implement` with targeted scope |
| "What is X?" | `memory_search` → source verification → answer |
| General chat | Direct response (no skill needed) |

**Hallucination Prevention**:
1. Before answering factual questions: Check sources
2. If uncertain: Say so explicitly
3. If making assumptions: State them
4. Use Loa's `/reality` for codebase queries

---

## 4. Non-Functional Requirements

### NFR-1: Recovery Time

| Scenario | Max Recovery Time |
|----------|-------------------|
| Container restart | < 30 seconds |
| R2 restore | < 2 minutes |
| Git clone (cold) | < 5 minutes |
| Full wipe (no backup) | Template init < 10 seconds |

### NFR-2: Memory Durability

| Layer | Sync Frequency | Max Data Loss |
|-------|---------------|---------------|
| NOTES.md | Every write (WAL) | 30 seconds |
| R2 backup | Every 30 seconds | 30 seconds |
| Git backup | Hourly or conversation end | 1 hour |
| Monthly consolidation | Monthly | None (derived) |

### NFR-3: Personality Consistency

- BEAUVOIR.md changes require logging to NOTES.md
- Personality drift detection via periodic self-review
- Human can override any trait via direct edit

---

## 5. Implementation Approach

### Phase 1: Identity & Memory Foundation
1. Create `grimoires/loa/BEAUVOIR.md` with principle-driven personality
2. Update `start-loa.sh` to check state integrity on boot
3. Implement auto-recovery protocol
4. Enable `memory_search` for grimoire files

### Phase 2: Proactive Self-Repair
1. Implement dependency detection in startup script
2. Add self-repair actions for common issues
3. Create AskUserQuestion flow for things requiring human input
4. Log all self-repair actions to NOTES.md

### Phase 3: Memory Consolidation
1. Implement consolidation script (runs on conversation end)
2. Add quality gates for memory promotion
3. Create monthly archive process
4. Enable semantic search across memory files

### Phase 4: Workflow Routing (Future)
1. Detect task patterns that should route to skills
2. Suggest skill invocation to user
3. (Later) Auto-route with user confirmation

---

## 6. Identity Codex Preparation

This PRD prepares for a future Identity Codex system by:

| Current | Future (Codex) |
|---------|----------------|
| `BEAUVOIR.md` single file | Pluggable personality modules |
| NOTES.md memory | Codex-managed memory layers |
| Static traits | Evolving traits with learning |
| Manual consolidation | Codex-driven curation |

**Interface Points**:
- `grimoires/loa/BEAUVOIR.md` will become the "active personality" loaded from Codex
- Memory files will sync to Codex for cross-session persistence
- Codex will provide personality versioning and rollback

---

## 7. Success Criteria

### Immediate (This Sprint)
- [ ] BEAUVOIR.md created with principle-driven personality
- [ ] Auto-recovery works without human intervention
- [ ] State persists across container restarts
- [ ] Recovery events logged to NOTES.md

### Short-term (1 month)
- [ ] Two-phase memory consolidation operational
- [ ] Proactive self-repair for common issues
- [ ] Semantic search across memory files

### Long-term (3 months)
- [ ] Measurable reduction in hallucination
- [ ] Personality consistency across sessions verified
- [ ] Ready for Identity Codex integration

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Over-aggressive self-repair | High | Ask-first for risky operations |
| Memory noise accumulation | Medium | Quality gates + periodic pruning |
| Personality drift | Medium | Change logging + periodic review |
| Recovery loop (repeated failures) | High | Max retry count, then alert human |
| Template init loses important state | High | Never init if any backup exists |

---

## Appendix A: Research Sources

This PRD synthesizes recommendations from:

- [Anthropic - Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic - Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Claude's Constitution (TIME)](https://time.com/7354738/claude-constitution-ai-alignment/)
- [OpenAI Context Personalization Cookbook](https://cookbook.openai.com/examples/agents_sdk/context_personalization)
- [OpenAI Session Memory Cookbook](https://cookbook.openai.com/examples/agents_sdk/session_memory)
- [OpenAI Agents SDK Documentation](https://openai.github.io/openai-agents-python/)
- OpenClaw codebase: `src/agents/tools/memory-tool.ts`, `docs/reference/templates/SOUL.md`

---

*Generated by Loa Framework v1.20.0*
