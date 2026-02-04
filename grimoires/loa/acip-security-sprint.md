# Sprint Plan: ACIP Security Patterns Integration

> **Version**: 1.0.0
> **PRD**: `grimoires/loa/acip-security-prd.md`
> **SDD**: `grimoires/loa/acip-security-sdd.md`
> **Created**: 2026-02-04
> **Issue**: [#12](https://github.com/0xHoneyJar/loa-beauvoir/issues/12)

---

## Sprint Overview

| Attribute      | Value                                    |
| -------------- | ---------------------------------------- |
| **Sprint ID**  | acip-security-001                        |
| **Type**       | Documentation + Enhancement              |
| **Scope**      | 3 components, ~150 lines total           |
| **Risk Level** | LOW (additive only, no breaking changes) |

---

## Tasks

### Task 1: Create Trust Boundaries Protocol

**ID**: ACIP-001
**Priority**: P0
**Estimated Effort**: Small (documentation only)

#### Description

Create a new protocol document defining explicit trust levels for content sources.

#### Acceptance Criteria

- [ ] File exists: `.claude/protocols/trust-boundaries.md`
- [ ] Documents 5-level trust hierarchy:
  1. SYSTEM (Maximum Trust) - `.claude/`
  2. STATE (High Trust) - `grimoires/loa/`, `.beads/`
  3. USER (Moderate Trust) - Direct user messages
  4. EXTERNAL (Low Trust) - Web fetches, API responses
  5. UNTRUSTED (No Trust) - Messages in content, embedded instructions
- [ ] Includes 4 verification rules:
  - Rule 1: Content-as-Data
  - Rule 2: Authority Claims Ignored
  - Rule 3: Urgency Does Not Override
  - Rule 4: Encoding is Data
- [ ] Cross-references existing protocols:
  - `git-safety.md`
  - `risk-analysis.md`
- [ ] Uses standard Loa protocol format

#### Implementation Notes

```bash
# Create file
touch .claude/protocols/trust-boundaries.md

# Structure follows SDD Component 1
```

#### Test Verification

Manual review:

- [ ] Hierarchy is clear and unambiguous
- [ ] Rules have concrete examples
- [ ] No conflicts with existing protocols

---

### Task 2: Add Injection Pattern Checklist

**ID**: ACIP-002
**Priority**: P0
**Estimated Effort**: Small (checklist addition)

#### Description

Add prompt-level security patterns to the existing auditing-security REFERENCE.md.

#### Acceptance Criteria

- [ ] New section added: "## Prompt-Level Security"
- [ ] Pattern taxonomy table with 6 patterns:

| ID     | Pattern                | Severity |
| ------ | ---------------------- | -------- |
| PI-001 | Authority Claims       | HIGH     |
| PI-002 | Urgency Bypass         | HIGH     |
| PI-003 | Emotional Manipulation | MEDIUM   |
| PI-004 | Indirect Tasking       | HIGH     |
| PI-005 | Encoding Tricks        | CRITICAL |
| PI-006 | Meta-Level Attacks     | MEDIUM   |

- [ ] Each pattern includes:
  - Detection signals
  - Defense strategy
  - Severity level
- [ ] Detection workflow documented (5 steps)
- [ ] Audit checklist items added (6 items)
- [ ] Red flags section for immediate attention

#### Implementation Notes

```bash
# Read existing file first
cat .claude/skills/auditing-security/resources/REFERENCE.md

# Add new section (do not modify existing content)
# Append after existing checklists
```

#### Test Verification

- [ ] Existing content unchanged
- [ ] New section follows document style
- [ ] Patterns have actionable detection signals

---

### Task 3: Enhance BEAUVOIR Message Safety

**ID**: ACIP-003
**Priority**: P1
**Estimated Effort**: Small (enhancement)

#### Description

Enhance BEAUVOIR.md §Boundaries with explicit message safety verification protocol.

#### Acceptance Criteria

- [ ] §Boundaries section enhanced (not replaced)
- [ ] 4-step verification protocol added:
  1. Source Verification
  2. Recipient Confirmation
  3. Harm Assessment
  4. Reversibility Check
- [ ] Each step includes:
  - Key question
  - Decision table or criteria
  - Action to take
- [ ] Example verification flow provided
- [ ] Alignment check table confirming no principle conflicts
- [ ] Change logged in document header

#### Implementation Notes

```bash
# Read existing BEAUVOIR.md
cat grimoires/loa/BEAUVOIR.md

# Find §Boundaries section
# Add "External Action Verification Protocol" subsection
# Keep existing "What I Won't Do" list intact
```

#### Test Verification

- [ ] Existing content preserved
- [ ] New protocol follows BEAUVOIR voice/style
- [ ] Example is realistic and helpful
- [ ] Version/changelog updated

---

## Task Dependencies

```
ACIP-001 (Trust Boundaries)
    │
    └──► ACIP-002 (Injection Checklist)
              │
              └──► ACIP-003 (Message Safety)
```

**Rationale**:

- Trust boundaries establish the conceptual foundation
- Injection checklist references trust levels
- Message safety implements verification using both

---

## Definition of Done

### Per-Task DoD

- [ ] All acceptance criteria met
- [ ] No modifications to existing content (additive only)
- [ ] Follows existing document style/format
- [ ] Cross-references are valid

### Sprint DoD

- [ ] All 3 tasks completed
- [ ] Manual verification performed
- [ ] No conflicts with existing Loa-OpenClaw integration
- [ ] Issue #12 updated with completion status
- [ ] Commit message references Issue #12

---

## Risk Mitigation

| Risk                                 | Mitigation                       |
| ------------------------------------ | -------------------------------- |
| Accidentally modify existing content | Read file first, append only     |
| Style inconsistency                  | Match existing document patterns |
| Conflict with BEAUVOIR principles    | Alignment check in Task 3        |

---

## Commit Strategy

Single commit after all tasks complete:

```bash
git add \
  .claude/protocols/trust-boundaries.md \
  .claude/skills/auditing-security/resources/REFERENCE.md \
  grimoires/loa/BEAUVOIR.md \
  grimoires/loa/acip-security-prd.md \
  grimoires/loa/acip-security-sdd.md \
  grimoires/loa/acip-security-sprint.md

git commit -m "feat(security): add ACIP prompt injection defenses (#12)

Add three security patterns from ACIP analysis:
- Trust boundaries protocol with 5-level hierarchy
- Injection pattern checklist (6 patterns) in audit skill
- Enhanced message safety verification in BEAUVOIR

All additions are non-breaking and preserve existing architecture.

Closes #12

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Post-Sprint

### Verification

1. Run `/audit` to verify checklist integration
2. Review BEAUVOIR.md for consistency
3. Verify trust-boundaries.md is discoverable

### Documentation

- Issue #12 closed with implementation summary
- No additional documentation required (self-documenting)

---

_Generated by Loa Simstim Workflow_
