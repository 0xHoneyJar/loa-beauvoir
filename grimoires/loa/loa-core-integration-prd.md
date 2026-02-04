# PRD: LOA Core Integration (Clean Refactor)

> **Status**: Draft
> **Version**: 0.1.0
> **Created**: 2026-02-04
> **Updated**: 2026-02-04
> **Author**: Claude Opus 4.5 + Human Operator
> **Supersedes**: loa-integration-prd.md (plugin approach)

---

## Executive Summary

**This is attempt #3** (after PR #5 and PR #9) at integrating LOA into OpenClaw. Previous attempts used a plugin-based approach that failed because:

1. OpenClaw's plugin loader doesn't await async `register()` functions
2. The `gateway_start` hook is defined but never emitted
3. SOUL.md was written to `grimoires/loa/` instead of the workspace root where OpenClaw looks

**New Approach**: Since we own this fork, we integrate LOA directly into the OpenClaw core:

1. Modify `src/agents/workspace.ts` to generate SOUL.md from BEAUVOIR.md
2. Remove the plugin-based complexity entirely
3. Make LOA a first-class citizen, not a bolt-on

**Key Insight**: The simplest solution is often the best. Instead of fighting the plugin system, we modify the 3-4 core files where SOUL.md generation happens.

---

## 1. Problem Statement

### Current State (After PR #9)

The `extensions/loa/` plugin exists but:

| Issue                       | Root Cause                              | Symptom                             |
| --------------------------- | --------------------------------------- | ----------------------------------- |
| `gateway_start` never fires | Hook defined in types but never emitted | LOA init deferred forever           |
| Async registration ignored  | `loader.ts:412` warns and continues     | Hooks register after gateway starts |
| SOUL.md in wrong location   | `soul-generator.ts` writes to grimoires | Agent uses default template         |
| Unused code                 | Plugin bridges never execute            | Dead code in codebase               |

### Desired State

LOA integrated at the core level:

| Component                 | Change                                       |
| ------------------------- | -------------------------------------------- |
| `src/agents/workspace.ts` | Check for BEAUVOIR.md → generate SOUL.md     |
| `extensions/loa/`         | **DELETE** - no longer needed                |
| `deploy/loa-identity/`    | Keep as library, import directly             |
| SOUL.md                   | Generated from BEAUVOIR.md on workspace init |

### Why Core Integration?

| Approach               | Pros                                   | Cons                                        |
| ---------------------- | -------------------------------------- | ------------------------------------------- |
| **Plugin** (PR #5, #9) | Clean separation                       | Async issues, hook gaps, complex            |
| **Core Integration**   | Guaranteed execution, simple, reliable | Harder upstream merge (acceptable for fork) |

Since this is a fork that we maintain, core integration is the right choice.

---

## 2. Vision & Goals

### Vision Statement

> _"LOA is the soul of the agent, not an optional plugin."_

### Primary Goals

| Goal    | Description                        | Success Metric                          |
| ------- | ---------------------------------- | --------------------------------------- |
| **G-1** | SOUL.md generated from BEAUVOIR.md | Agent introduces itself as Loa Beauvoir |
| **G-2** | Zero plugin complexity             | `extensions/loa/` deleted               |
| **G-3** | Reliable execution                 | No race conditions, no missed hooks     |
| **G-4** | Clean codebase                     | No dead code from failed attempts       |

---

## 3. Architecture Overview

### Integration Point

```
src/agents/workspace.ts
├── ensureAgentWorkspace()
│   ├── Line 178: await writeFileIfMissing(soulPath, soulTemplate)  ← MODIFY
│   │
│   └── NEW: Check for BEAUVOIR.md
│       ├── If exists: Generate SOUL.md from it
│       └── If not: Use default template (fallback)
```

### Data Flow

```
BEFORE (Default OpenClaw):

  workspace init → loadTemplate("SOUL.md") → writeFileIfMissing()
                          │
                          └── Default template from docs/reference/templates/

AFTER (LOA-Integrated):

  workspace init → checkBeauvoirExists()
                          │
          ┌───────────────┴───────────────┐
          │                               │
    BEAUVOIR.md exists            Not found
          │                               │
          ▼                               ▼
  generateSoulFromBeauvoir()     loadTemplate("SOUL.md")
          │                               │
          └───────────────┬───────────────┘
                          │
                          ▼
                  writeFileIfMissing()
```

### Files Modified

| File                               | Change                               | LOC Estimate |
| ---------------------------------- | ------------------------------------ | ------------ |
| `src/agents/workspace.ts`          | Add BEAUVOIR.md → SOUL.md generation | +50          |
| `src/agents/loa-soul-generator.ts` | **NEW**: Transform logic             | +80          |
| `extensions/loa/`                  | **DELETE**: Entire directory         | -2500        |

**Net change**: -2370 LOC (massive cleanup)

---

## 4. Functional Requirements

### FR-1: SOUL.md Generation from BEAUVOIR.md

| Requirement | Description                                                    |
| ----------- | -------------------------------------------------------------- |
| FR-1.1      | On workspace init, check if `grimoires/loa/BEAUVOIR.md` exists |
| FR-1.2      | If exists, generate SOUL.md from BEAUVOIR.md content           |
| FR-1.3      | If not exists, fall back to default SOUL.md template           |
| FR-1.4      | Generated SOUL.md includes LOA identity introduction           |
| FR-1.5      | Agent introduces itself as "operated by Loa Beauvoir"          |
| FR-1.6      | Agent asks operator what name to use                           |

### FR-2: BEAUVOIR.md Identity Section

| Requirement | Description                                     |
| ----------- | ----------------------------------------------- |
| FR-2.1      | BEAUVOIR.md must have `## Identity` section     |
| FR-2.2      | Identity section defines first-contact behavior |
| FR-2.3      | Core principles mapped to SOUL.md persona       |
| FR-2.4      | Interaction style mapped to SOUL.md tone        |
| FR-2.5      | Boundaries mapped to SOUL.md boundaries         |

### FR-3: Clean Removal of Plugin Code

| Requirement | Description                                            |
| ----------- | ------------------------------------------------------ |
| FR-3.1      | Delete `extensions/loa/` directory entirely            |
| FR-3.2      | Remove LOA plugin references from docker-compose files |
| FR-3.3      | Remove LOA plugin installation from start-loa-dev.sh   |
| FR-3.4      | Update package.json if needed                          |
| FR-3.5      | Verify no dangling imports                             |

### FR-4: Graceful Fallback

| Requirement | Description                                             |
| ----------- | ------------------------------------------------------- |
| FR-4.1      | If BEAUVOIR.md missing, use default SOUL.md             |
| FR-4.2      | If BEAUVOIR.md parse fails, log warning and use default |
| FR-4.3      | Never block agent startup due to LOA issues             |

---

## 5. Technical Design

### 5.1 New File: `src/agents/loa-soul-generator.ts`

```typescript
/**
 * LOA Soul Generator
 *
 * Transforms BEAUVOIR.md content to SOUL.md format.
 * Used by workspace.ts during workspace initialization.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SoulGenerationResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Check if BEAUVOIR.md exists in grimoires directory
 */
export async function beauvoirExists(workspaceDir: string): Promise<boolean> {
  const beauvoirPath = path.join(workspaceDir, "grimoires/loa/BEAUVOIR.md");
  try {
    await fs.access(beauvoirPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate SOUL.md content from BEAUVOIR.md
 */
export async function generateSoulFromBeauvoir(
  workspaceDir: string,
): Promise<SoulGenerationResult> {
  const beauvoirPath = path.join(workspaceDir, "grimoires/loa/BEAUVOIR.md");

  try {
    const beauvoirContent = await fs.readFile(beauvoirPath, "utf-8");
    const soulContent = transformToSoul(beauvoirContent);
    return { success: true, content: soulContent };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Transform BEAUVOIR.md content to SOUL.md format
 */
function transformToSoul(beauvoirContent: string): string {
  // Parse sections from BEAUVOIR.md
  const sections = parseBeauvoirSections(beauvoirContent);

  const lines: string[] = [
    "# SOUL.md",
    "",
    "> This file is auto-generated from grimoires/loa/BEAUVOIR.md",
    "> Do not edit directly - modify BEAUVOIR.md instead.",
    "",
  ];

  // Identity/Persona section
  lines.push("## Persona");
  lines.push("");
  if (sections.identity) {
    lines.push(sections.identity);
  } else {
    lines.push("I am Loa Beauvoir - an AI assistant with persistent identity and memory.");
  }
  lines.push("");

  // Interaction Style / Tone
  lines.push("## Tone");
  lines.push("");
  if (sections["interaction style"]) {
    lines.push(sections["interaction style"]);
  } else {
    lines.push("- Concise: Lead with answers, skip pleasantries");
    lines.push("- Opinionated: Recommend rather than enumerate");
    lines.push("- Resourceful: Check before asking, try before failing");
  }
  lines.push("");

  // Boundaries
  lines.push("## Boundaries");
  lines.push("");
  if (sections.boundaries) {
    lines.push(sections.boundaries);
  }
  lines.push("");

  // Recovery Protocol (if present)
  if (sections["recovery protocol"]) {
    lines.push("## Recovery Protocol");
    lines.push("");
    lines.push(sections["recovery protocol"]);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("*Generated by LOA from BEAUVOIR.md*");

  return lines.join("\n");
}

/**
 * Parse BEAUVOIR.md into sections
 */
function parseBeauvoirSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split("\n");
  let currentSection = "preamble";
  let sectionContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // Save previous section
      if (sectionContent.length > 0) {
        sections[currentSection] = sectionContent.join("\n").trim();
      }
      // Start new section
      currentSection = line.replace("## ", "").toLowerCase().trim();
      sectionContent = [];
    } else {
      sectionContent.push(line);
    }
  }

  // Save last section
  if (sectionContent.length > 0) {
    sections[currentSection] = sectionContent.join("\n").trim();
  }

  return sections;
}
```

### 5.2 Modified: `src/agents/workspace.ts`

```typescript
// Add import at top:
import { beauvoirExists, generateSoulFromBeauvoir } from "./loa-soul-generator.js";

// Modify ensureAgentWorkspace() around line 178:

// BEFORE:
await writeFileIfMissing(soulPath, soulTemplate);

// AFTER:
// Check for LOA BEAUVOIR.md and generate SOUL.md from it
let soulContent = soulTemplate;
if (await beauvoirExists(dir)) {
  const result = await generateSoulFromBeauvoir(dir);
  if (result.success && result.content) {
    soulContent = result.content;
  } else if (result.error) {
    // Log warning but continue with default
    console.warn(`[loa] Failed to generate SOUL.md from BEAUVOIR.md: ${result.error}`);
  }
}
await writeFileIfMissing(soulPath, soulContent);
```

---

## 6. Cleanup Requirements

### Files to Delete

```
extensions/loa/
├── index.ts
├── types.ts
├── package.json
├── clawdbot.plugin.json
├── adapters/
│   └── hook-adapter.ts
├── bridges/
│   ├── bootstrap.ts
│   ├── context.ts
│   ├── init.ts
│   ├── learnings.ts
│   ├── memory.ts
│   ├── recovery.ts
│   └── soul-generator.ts
├── state/
│   ├── loop-detector.ts
│   └── retry-queue.ts
└── __tests__/
    ├── integration.test.ts
    ├── hook-adapter.test.ts
    ├── context.test.ts
    └── loop-detector.test.ts
```

### Files to Modify

| File                      | Change                                |
| ------------------------- | ------------------------------------- |
| `docker-compose.dev.yml`  | Remove extensions/loa volume mount    |
| `deploy/start-loa-dev.sh` | Remove plugin installation commands   |
| Root `package.json`       | Remove workspace reference if present |

---

## 7. Success Criteria

### MVP Success

- [ ] Agent introduces itself as "operated by Loa Beauvoir" on first contact
- [ ] Agent asks operator what name to use
- [ ] SOUL.md in workspace root contains LOA identity
- [ ] `extensions/loa/` directory deleted
- [ ] No dead code from plugin attempts
- [ ] No race conditions or timing issues

### Verification

1. **Start dev environment**: `make dev`
2. **Open webchat**: `make dev-chat`
3. **Send first message**: "Hello"
4. **Expected response**: Introduction as Loa Beauvoir, asks for preferred name

---

## 8. Migration Path

### From Current State

1. Create `src/agents/loa-soul-generator.ts`
2. Modify `src/agents/workspace.ts` (~5 lines)
3. Update BEAUVOIR.md with Identity section
4. Delete `extensions/loa/` directory
5. Update docker-compose.dev.yml
6. Update start-loa-dev.sh
7. Test and verify

### Rollback

If issues found, the changes are minimal:

- Revert workspace.ts change (restore single line)
- Delete loa-soul-generator.ts
- Re-add extensions/loa/ from git history if needed

---

## 9. Risks & Mitigations

| Risk                       | Impact                   | Likelihood | Mitigation                    |
| -------------------------- | ------------------------ | ---------- | ----------------------------- |
| BEAUVOIR.md format changes | SOUL.md generation fails | Low        | Graceful fallback to default  |
| Workspace init performance | Slower startup           | Low        | BEAUVOIR.md read is ~5ms      |
| Upstream merge conflicts   | workspace.ts changes     | Medium     | Minimal diff, easy to resolve |

---

## 10. Open Questions

1. **Memory capture**: Should this remain in deploy/loa-identity/ or also move to core?
   - **Recommendation**: Keep separate for now, can integrate in Phase 2

2. **Recovery**: Is recovery engine still needed if SOUL.md is generated each time?
   - **Recommendation**: Recovery for BEAUVOIR.md/NOTES.md still valuable, keep

3. **Plugin system**: Should we emit `gateway_start` hook for other plugins?
   - **Recommendation**: Out of scope for this PR, file separate issue

---

_Generated by Loa Framework_
