# Sprint Plan: LOA Core Integration (Clean Refactor)

> **Status**: Ready for Implementation
> **Version**: 0.1.0
> **Created**: 2026-02-04
> **PRD Reference**: `grimoires/loa/loa-core-integration-prd.md`
> **SDD Reference**: `grimoires/loa/loa-core-integration-sdd.md`
> **Supersedes**: loa-integration-sprint.md (plugin approach)

---

## Sprint Overview

| Metric             | Value                                           |
| ------------------ | ----------------------------------------------- |
| **Sprint ID**      | loa-core-integration-1                          |
| **Duration**       | 1 sprint (single session)                       |
| **Goal**           | LOA as first-class citizen via core integration |
| **Net LOC Change** | -2400 (cleanup of dead plugin code)             |

---

## Sprint 1: Core Integration & Cleanup

### Objective

Integrate LOA into OpenClaw core and remove all dead plugin code from PR #5 and PR #9.

### Tasks

#### Task 1.1: Create loa-soul-generator.ts

**File**: `src/agents/loa-soul-generator.ts`

| Attribute     | Value |
| ------------- | ----- |
| Estimated LOC | 80    |
| Complexity    | Low   |
| Dependencies  | None  |

**Acceptance Criteria**:

- [ ] Exports `tryGenerateSoulFromBeauvoir(workspaceDir): Promise<string | null>`
- [ ] Returns null if BEAUVOIR.md not found (graceful fallback)
- [ ] Parses BEAUVOIR.md sections: Identity, Interaction Style, Boundaries, Recovery Protocol
- [ ] Generates SOUL.md with Persona, Tone, Boundaries sections
- [ ] Includes "Auto-generated from BEAUVOIR.md" header
- [ ] Pure functions, no side effects beyond file read

---

#### Task 1.2: Modify workspace.ts

**File**: `src/agents/workspace.ts`

| Attribute     | Value    |
| ------------- | -------- |
| Estimated LOC | +3 lines |
| Complexity    | Trivial  |
| Dependencies  | Task 1.1 |

**Changes**:

```typescript
// Add import at top:
import { tryGenerateSoulFromBeauvoir } from "./loa-soul-generator.js";

// Modify line ~178, replace:
//   await writeFileIfMissing(soulPath, soulTemplate);
// With:
const loaSoul = await tryGenerateSoulFromBeauvoir(dir);
await writeFileIfMissing(soulPath, loaSoul ?? soulTemplate);
```

**Acceptance Criteria**:

- [ ] Import added for loa-soul-generator
- [ ] SOUL.md generated from BEAUVOIR.md when available
- [ ] Falls back to default template when BEAUVOIR.md missing
- [ ] No changes to function signature or return type

---

#### Task 1.3: Update BEAUVOIR.md

**File**: `grimoires/loa/BEAUVOIR.md`

| Attribute     | Value     |
| ------------- | --------- |
| Estimated LOC | +20 lines |
| Complexity    | Low       |
| Dependencies  | None      |

**Required Changes**:

- [ ] Ensure `## Identity` section exists at top
- [ ] Identity section includes first-contact introduction
- [ ] Instructs agent to introduce as "Loa Beauvoir"
- [ ] Instructs agent to ask for operator's preferred name

**Identity Section Template**:

```markdown
## Identity

I am **Loa Beauvoir** — an AI assistant with persistent identity and memory.

When meeting a new operator for the first time, I introduce myself:

> "Hello. I'm operated by Loa Beauvoir — an AI with memory that persists between conversations. What name would you like to call me?"

I remember the name they choose and use it. If they don't specify, I go by "Loa."
```

---

#### Task 1.4: Delete extensions/loa/ Directory

**Directory**: `extensions/loa/`

| Attribute       | Value                   |
| --------------- | ----------------------- |
| Files to Delete | ~15 files               |
| LOC Removed     | ~2500                   |
| Complexity      | Low (just deletion)     |
| Dependencies    | Tasks 1.1, 1.2 complete |

**Files to Delete**:

```
extensions/loa/
├── index.ts
├── types.ts
├── package.json
├── clawdbot.plugin.json
├── adapters/hook-adapter.ts
├── bridges/bootstrap.ts
├── bridges/context.ts
├── bridges/init.ts
├── bridges/learnings.ts
├── bridges/memory.ts
├── bridges/recovery.ts
├── bridges/soul-generator.ts
├── state/loop-detector.ts
├── state/retry-queue.ts
└── __tests__/*.ts
```

**Acceptance Criteria**:

- [ ] Entire extensions/loa/ directory deleted
- [ ] No dangling imports elsewhere in codebase
- [ ] Build passes without plugin

---

#### Task 1.5: Update docker-compose.dev.yml

**File**: `docker-compose.dev.yml`

| Attribute       | Value    |
| --------------- | -------- |
| Lines to Remove | 2        |
| Complexity      | Trivial  |
| Dependencies    | Task 1.4 |

**Remove these volume mounts**:

```yaml
# DELETE:
- ./extensions/loa:/workspace/extensions/loa:rw
- ./extensions/loa/node_modules:/workspace/extensions/loa/node_modules:ro
```

**Keep these** (still needed):

```yaml
- ./grimoires:/workspace/grimoires:rw
```

---

#### Task 1.6: Update start-loa-dev.sh

**File**: `deploy/start-loa-dev.sh`

| Attribute       | Value    |
| --------------- | -------- |
| Lines to Remove | ~30      |
| Complexity      | Low      |
| Dependencies    | Task 1.4 |

**Remove**:

- `npm install -g @noble/ed25519 @noble/hashes` block
- `node_modules/@noble` symlink creation
- `clawdbot plugins install --link` command
- Plugin verification checks (`clawdbot plugins list`)

**Keep**:

- Gateway startup command
- Grimoires symlink (if still needed)
- Environment variable logging
- Device auto-approval (if still needed for webchat)

---

#### Task 1.7: Test End-to-End

| Attribute    | Value              |
| ------------ | ------------------ |
| Complexity   | Medium             |
| Dependencies | All previous tasks |

**Test Procedure**:

1. **Rebuild container**:

   ```bash
   make dev-build
   ```

2. **Start environment**:

   ```bash
   make dev
   ```

3. **Open webchat**:

   ```bash
   make dev-chat
   ```

4. **Send first message**: "Hello"

5. **Verify response**:
   - [ ] Agent introduces itself as Loa Beauvoir
   - [ ] Agent asks for operator's preferred name
   - [ ] No generic "fresh instance, blank slate" message

6. **Check SOUL.md**:
   ```bash
   docker compose -f docker-compose.dev.yml exec loa-dev cat /root/.openclaw/workspace/SOUL.md
   ```

   - [ ] Contains "Auto-generated from BEAUVOIR.md"
   - [ ] Contains Persona section with LOA identity
   - [ ] Contains Tone and Boundaries sections

---

### Task Dependencies

```
Task 1.1 ─────┐
              ├──► Task 1.2 ───┐
Task 1.3 ─────┘                │
                               ├──► Task 1.4 ───┬──► Task 1.5 ───┐
                               │                │                │
                               │                └──► Task 1.6 ───┼──► Task 1.7
                               │                                 │
                               └─────────────────────────────────┘
```

---

## Definition of Done

### Sprint Complete When:

- [ ] `src/agents/loa-soul-generator.ts` created and working
- [ ] `src/agents/workspace.ts` modified (3 lines)
- [ ] `grimoires/loa/BEAUVOIR.md` has Identity section
- [ ] `extensions/loa/` directory deleted
- [ ] `docker-compose.dev.yml` updated
- [ ] `deploy/start-loa-dev.sh` simplified
- [ ] E2E test passes (agent introduces as Loa Beauvoir)
- [ ] No build errors
- [ ] No dead code remaining from plugin approach

### Quality Gates:

- [ ] Build passes: `pnpm build`
- [ ] Lint passes: `pnpm check`
- [ ] Tests pass: `pnpm test` (or at least no regressions)
- [ ] Manual E2E verification complete

---

## Risks & Mitigations

| Risk                                | Likelihood | Impact | Mitigation               |
| ----------------------------------- | ---------- | ------ | ------------------------ |
| BEAUVOIR.md path wrong in container | Medium     | Low    | Verify path, add logging |
| Workspace init order issues         | Low        | Medium | Test thoroughly          |
| Missing sections in BEAUVOIR.md     | Low        | Low    | Default content fallback |

---

## Rollback Plan

If critical issues found:

1. Revert workspace.ts:

   ```bash
   git checkout HEAD -- src/agents/workspace.ts
   ```

2. Delete new file:

   ```bash
   rm src/agents/loa-soul-generator.ts
   ```

3. Restore plugin (if needed):
   ```bash
   git checkout HEAD~1 -- extensions/loa/
   ```

**Rollback time**: < 2 minutes

---

_Generated by Loa Framework_
