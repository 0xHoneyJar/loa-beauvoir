# PRD: Beauvoir Personality & Resilience

> **Status**: Draft
> **Version**: 0.2.0
> **Created**: 2026-02-03
> **Updated**: 2026-02-03
> **Author**: Claude Opus 4.5 + Human Operator
> **Reviewed**: Flatline Protocol (GPT-5.2 + Opus, 80% agreement)

## Executive Summary

**The Problem**: The previous agent (moltbot/openclaw) was personable and responsive but unreliable - it hallucinated, lost memory on restarts, and stopped functioning after system wipes until a human intervened.

**The Solution**: A resilience-first personality layer for Beauvoir that combines:
- Procedural, structured workflows (less hallucination)
- Auto-recovery from wipes without human intervention
- Proactive self-repair with security guardrails
- Durable memory with two-phase consolidation and privacy controls

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
3. **Proactively self-repair** by installing missing dependencies (with security guardrails)
4. **Maintain personality continuity** across sessions
5. **Consolidate durable memories** while discarding ephemeral context
6. **Protect privacy** by redacting sensitive data before storage

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

**Recovery State Machine**:
```
┌─────────────┐
│    START    │
└──────┬──────┘
       ▼
┌─────────────────┐
│ Check Integrity │──────────────────┐
│  (hash verify)  │                  │
└──────┬──────────┘                  │
       │ MISMATCH                    │ VALID
       ▼                             ▼
┌─────────────────┐          ┌──────────────┐
│   Try R2 First  │          │   RUNNING    │
└──────┬──────────┘          └──────────────┘
       │
       ├── R2 Available + Valid ──► RESTORE_R2
       │
       ├── R2 Unavailable ────────► TRY_GIT
       │
       └── R2 Corrupted ──────────► TRY_GIT
                                        │
       ┌────────────────────────────────┘
       ▼
┌─────────────────┐
│    Try Git      │
└──────┬──────────┘
       │
       ├── Git Available + Valid ─► RESTORE_GIT
       │
       ├── Git Unavailable ───────► OFFLINE_MODE
       │
       └── Git Corrupted ─────────► TEMPLATE_INIT
                                        │
       ┌────────────────────────────────┘
       ▼
┌─────────────────┐
│  DEGRADED_MODE  │ (max 3 retries, then ALERT_HUMAN)
└─────────────────┘
```

**State Integrity Specification**:

| File | Hash Algorithm | Canonicalization |
|------|----------------|------------------|
| `NOTES.md` | SHA256 | Strip trailing whitespace, normalize line endings to LF |
| `BEAUVOIR.md` | SHA256 | Strip trailing whitespace, normalize line endings to LF |
| `memory/*.md` | SHA256 per file | Same as above |

**Manifest Format** (`.loa-state-manifest.json`):
```json
{
  "version": 1,
  "generated_at": "2026-02-03T10:00:00Z",
  "files": {
    "grimoires/loa/NOTES.md": {
      "sha256": "abc123...",
      "size_bytes": 4096,
      "mtime": "2026-02-03T09:59:00Z"
    },
    "grimoires/loa/BEAUVOIR.md": {
      "sha256": "def456...",
      "size_bytes": 2048,
      "mtime": "2026-02-02T14:00:00Z"
    }
  },
  "restore_count": 0,
  "last_restore_source": null
}
```

**Conflict Resolution (R2 vs Git)**:
1. Compare manifest timestamps from both sources
2. If timestamps within 5 minutes: prefer R2 (hot state)
3. If timestamps diverge >5 minutes: compare file-by-file
4. For each file: prefer source with newer `mtime` AND valid hash
5. Log conflict resolution decisions to NOTES.md

**Loop Detection**:
- Track `restore_count` in manifest
- If `restore_count >= 3` within 10 minutes: enter DEGRADED_MODE
- DEGRADED_MODE: Boot with local-only state, log alert, continue operation
- After 1 hour in DEGRADED_MODE: retry recovery once

**Offline/Degraded Behavior**:
- If R2 unreachable: retry with exponential backoff (5s, 10s, 20s), max 3 attempts
- If all remotes fail: boot with existing local state (even if stale)
- Set `BEAUVOIR_DEGRADED=true` environment variable
- Log to NOTES.md: `[DEGRADED] Operating without remote backup since {timestamp}`

### FR-3: Proactive Self-Repair

When Beauvoir detects missing dependencies or configuration:

| Detection | Action | Security Level |
|-----------|--------|----------------|
| Missing tool in allowlist | Auto-install from pinned version | Auto-fix |
| Missing tool NOT in allowlist | Log warning, request human approval | Ask-first |
| Missing config value | Check environment, R2, then ASK user | Ask-first |
| Missing API key | Log warning, request via AskUserQuestion | Alert-only |
| Corrupted file | Restore from backup, log event | Auto-fix |

**Security Guardrails**:

**Package Allowlist** (auto-install permitted):
```yaml
# .loa/allowed-packages.yaml
npm:
  - name: "clawdbot"
    version: "2026.1.24-3"
    sha256: "abc123..."  # Optional: verify package integrity
  - name: "pnpm"
    version: "10.*"

apt:
  - name: "ripgrep"
    version: "*"
  - name: "jq"
    version: "*"
  - name: "git"
    version: "*"
```

**Installation Security**:
1. All installs run in a sandboxed context (if available)
2. Network installs require: package in allowlist OR explicit human approval
3. Log all install actions with package name, version, source hash
4. Use lockfiles (`package-lock.json`, `pnpm-lock.yaml`) when available
5. NEVER run `npm install` with arbitrary `package.json` from untrusted source

**Proactivity Levels**:
- **Auto-fix**: Safe operations (restore from backup, install from allowlist)
- **Ask-first**: Risky operations (install new packages, modify system config)
- **Alert-only**: Cannot fix (missing secrets, external service down, package not in allowlist)

### FR-4: Two-Phase Memory System

**Phase 1: Session Capture** (during conversation)
- Write to `grimoires/loa/NOTES.md` under `## Session Memory`
- Capture decisions, discoveries, blockers
- Apply **capture-time redaction** (see FR-6 Privacy)
- Use atomic writes (write to `.tmp`, then rename)

**Phase 2: Post-Session Consolidation** (on conversation end or hourly)
- Promote durable patterns to `grimoires/loa/memory/YYYY-MM.md`
- Apply quality gates (see below)
- Deduplicate using semantic similarity
- Recency-wins conflict resolution with timestamps

**Memory Entry Schema**:
```yaml
# Each memory entry follows this structure
- id: "mem-2026-02-03-001"
  type: "decision" | "fact" | "preference" | "pattern" | "error"
  content: "User prefers TypeScript over JavaScript"
  source: "conversation" | "observation" | "inference"
  confidence: 0.95  # 0.0-1.0
  timestamp: "2026-02-03T10:00:00Z"
  scope: "project" | "global"
  tags: ["language", "preference"]
```

**Semantic Deduplication Algorithm**:
- Embedding model: `all-MiniLM-L6-v2` (384 dimensions)
- Similarity threshold: 0.85 (entries above this are considered duplicates)
- On duplicate detection:
  1. Keep entry with higher confidence
  2. If confidence equal: keep newer entry (recency-wins)
  3. Merge tags from both entries
  4. Log merge decision to consolidation audit trail

**Quality Gates**:
| Gate | Rule | Action |
|------|------|--------|
| Temporal | Contains "today", "this time", "just now" | Reject |
| Speculation | Contains "might be", "probably", "I think" | Reject unless confidence >= 0.8 |
| Instruction | Looks like a prompt/command | Reject |
| PII | Contains email, phone, API key patterns | Redact or Reject |
| Confidence | confidence < 0.5 | Reject |

**Memory Files**:
```
grimoires/loa/
├── NOTES.md              # Hot memory (session + active context)
├── BEAUVOIR.md           # Identity (personality + principles)
└── memory/
    ├── 2026-01.md        # Consolidated January memories
    ├── 2026-02.md        # Consolidated February memories
    ├── consolidation.log # Audit trail of merge decisions
    └── archive/          # Older memories (searchable, not loaded)
```

**WAL Implementation**:
- Format: Append-only with commit markers
- Each write: `[TIMESTAMP] [OPERATION] [DATA] [COMMIT_MARKER]`
- Commit marker: SHA256 of the entry
- fsync after each commit marker
- On crash: replay from last valid commit marker
- Verify via `sha256sum` comparison before accepting replay

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

### FR-6: Privacy & Security Requirements

**Capture-Time Redaction**:
Before writing ANY memory entry, scan and redact:

| Pattern | Action | Replacement |
|---------|--------|-------------|
| API keys (`sk-...`, `sk-ant-...`) | Redact | `[REDACTED_API_KEY]` |
| Passwords in URLs | Redact | `[REDACTED_PASSWORD]` |
| Email addresses | Redact unless explicit consent | `[REDACTED_EMAIL]` |
| Phone numbers | Redact | `[REDACTED_PHONE]` |
| Credit card numbers | Redact | `[REDACTED_CC]` |
| AWS keys (`AKIA...`) | Redact | `[REDACTED_AWS_KEY]` |
| Private keys (PEM format) | Reject entirely | Do not store |

**Storage Security**:
| Location | Encryption | Access Control |
|----------|------------|----------------|
| Local grimoires | None (container isolation) | File permissions 600 |
| R2 backup | Encryption-at-rest (R2 default) | IAM-scoped credentials |
| Git backup | None (public repo risk) | Exclude secrets via `.gitignore` |

**Secret Scanning**:
- Run secret scan before any git commit of grimoire files
- Use pattern matching for common secret formats
- Block commit if secrets detected, log warning

**Data Retention**:
| Data Type | Retention | Purge Method |
|-----------|-----------|--------------|
| Session memory (NOTES.md) | Until consolidation | Overwrite on consolidation |
| Consolidated memory | 90 days | Archive then delete |
| Error logs | 30 days | Delete |
| API keys | NEVER stored | N/A |

---

## 4. Non-Functional Requirements

### NFR-1: Recovery Time

| Scenario | Max Recovery Time |
|----------|-------------------|
| Container restart (local valid) | < 10 seconds |
| Container restart (R2 restore) | < 30 seconds |
| R2 restore (full) | < 2 minutes |
| Git clone (cold) | < 5 minutes |
| Full wipe (no backup) | Template init < 10 seconds |
| Degraded mode boot | < 15 seconds |

### NFR-2: Memory Durability

| Layer | Sync Frequency | Max Data Loss | Verification |
|-------|---------------|---------------|--------------|
| NOTES.md | Every write (WAL) | 30 seconds | SHA256 commit markers |
| R2 backup | Every 30 seconds | 30 seconds | ETag verification |
| Git backup | Hourly or conversation end | 1 hour | Commit hash |
| Monthly consolidation | Monthly | None (derived) | Consolidation audit log |

**WAL Guarantees**:
- fsync after each commit marker
- Atomic rename for file updates
- Crash replay verified against checksums
- Max replay time: 5 seconds for 1000 entries

### NFR-3: Personality Consistency

- BEAUVOIR.md changes require logging to NOTES.md
- Personality drift detection via periodic self-review
- Human can override any trait via direct edit

---

## 5. Implementation Approach

### Phase 1: Identity & Memory Foundation
1. Create `grimoires/loa/BEAUVOIR.md` with principle-driven personality
2. Update `start-loa.sh` to check state integrity on boot
3. Implement auto-recovery protocol with state machine
4. Enable `memory_search` for grimoire files
5. Implement capture-time redaction

### Phase 2: Proactive Self-Repair
1. Create `.loa/allowed-packages.yaml` allowlist
2. Implement dependency detection in startup script
3. Add sandboxed self-repair for allowlisted packages
4. Create AskUserQuestion flow for non-allowlisted packages
5. Log all self-repair actions to NOTES.md

### Phase 3: Memory Consolidation
1. Implement consolidation script with embedding model
2. Add quality gates for memory promotion
3. Implement semantic deduplication (0.85 threshold)
4. Create monthly archive process
5. Enable semantic search across memory files

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
- [ ] Capture-time redaction operational

### Short-term (1 month)
- [ ] Two-phase memory consolidation operational
- [ ] Proactive self-repair with security allowlist
- [ ] Semantic search across memory files
- [ ] Secret scanning before git commits

### Long-term (3 months)
- [ ] Measurable reduction in hallucination
- [ ] Personality consistency across sessions verified
- [ ] Ready for Identity Codex integration
- [ ] Zero secret leakage incidents

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Over-aggressive self-repair | High | Package allowlist + human approval for unlisted |
| Memory noise accumulation | Medium | Quality gates + semantic dedup + periodic pruning |
| Personality drift | Medium | Change logging + periodic review |
| Recovery loop (repeated failures) | High | Max 3 retries + DEGRADED_MODE + human alert |
| Template init loses important state | High | Never init if any backup exists |
| R2/Git conflict causes data loss | High | File-by-file comparison + recency preference |
| State hash mismatch false positives | Medium | Canonicalization rules + manifest versioning |
| Secret leakage to git | Critical | Capture-time redaction + pre-commit scanning |
| Supply chain attack via self-repair | Critical | Package allowlist + version pinning + hash verification |
| Infinite restore loop | High | Loop detection (3 attempts/10min) + DEGRADED_MODE |

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

## Appendix B: Flatline Protocol Review

**Review Date**: 2026-02-03
**Models**: Claude Opus 4.5 + GPT-5.2
**Agreement**: 80%
**Cost**: $0.73

### High Consensus Improvements (Integrated)
1. Recovery hash specification - Added manifest format, canonicalization rules
2. R2/Git divergence handling - Added conflict resolution algorithm
3. WAL/concurrency specification - Added atomic write rules, fsync policy
4. Retry/backoff parameters - Added explicit limits and exponential backoff

### Blockers Addressed
1. Self-repair security - Added package allowlist, version pinning, sandboxing
2. State hash loop risk - Added loop detection, DEGRADED_MODE
3. Memory privacy - Added FR-6 Privacy & Security Requirements
4. Semantic dedup algorithm - Specified embedding model and threshold

---

*Generated by Loa Framework v1.22.0*
