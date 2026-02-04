# SDD: LOA Core Integration (Clean Refactor)

> **Status**: Draft
> **Version**: 0.1.0
> **Created**: 2026-02-04
> **Updated**: 2026-02-04
> **PRD Reference**: `grimoires/loa/loa-core-integration-prd.md` v0.1.0
> **Author**: Claude Opus 4.5
> **Supersedes**: loa-integration-sdd.md (plugin approach)

---

## Executive Summary

This document details the technical design for integrating LOA directly into OpenClaw's core, replacing the failed plugin-based approach from PR #5 and PR #9.

**Key Design Decisions**:

1. **Core modification over plugin** - Modify `workspace.ts` directly (we own the fork)
2. **Single new file** - `loa-soul-generator.ts` contains all LOA logic
3. **Delete plugin code** - Remove 2500+ LOC of unused plugin infrastructure
4. **Graceful fallback** - If BEAUVOIR.md missing, use default SOUL.md template

---

## 1. System Architecture

### 1.1 Integration Point

The integration happens at a single point in OpenClaw's workspace initialization:

```
src/agents/workspace.ts
│
├── ensureAgentWorkspace()
│   │
│   ├── Line 169: Load templates
│   │   └── soulTemplate = await loadTemplate(DEFAULT_SOUL_FILENAME)
│   │
│   └── Line 178: Write SOUL.md  ← MODIFICATION POINT
│       │
│       ├── BEFORE: await writeFileIfMissing(soulPath, soulTemplate)
│       │
│       └── AFTER:  Check BEAUVOIR.md → Generate or fallback → Write
│
└── NEW IMPORT: import { tryGenerateSoulFromBeauvoir } from './loa-soul-generator.js'
```

### 1.2 Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     OPENCLAW RUNTIME                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  src/agents/                                                    │
│  ├── workspace.ts          ← Modified (5 lines added)          │
│  └── loa-soul-generator.ts ← NEW (80 lines)                    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  ensureAgentWorkspace()                                  │   │
│  │                                                         │   │
│  │  1. Check if grimoires/loa/BEAUVOIR.md exists          │   │
│  │  2. If yes: Generate SOUL.md from BEAUVOIR.md          │   │
│  │  3. If no:  Use default SOUL.md template               │   │
│  │  4. Write to workspace root                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  WORKSPACE ROOT (~/.openclaw/workspace/)                │   │
│  │                                                         │   │
│  │  SOUL.md     ← Generated from BEAUVOIR.md              │   │
│  │  AGENTS.md   ← Default template                        │   │
│  │  TOOLS.md    ← Default template                        │   │
│  │  ...                                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ Reads
                              │
┌─────────────────────────────────────────────────────────────────┐
│                     GRIMOIRES (State)                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  grimoires/loa/                                                 │
│  ├── BEAUVOIR.md    ← Identity source (edited by operator)    │
│  ├── NOTES.md       ← Operational memory                       │
│  └── ...                                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 Data Flow

```
WORKSPACE INITIALIZATION FLOW
─────────────────────────────

                    ensureAgentWorkspace()
                            │
                            ▼
            ┌───────────────────────────────┐
            │  Check: BEAUVOIR.md exists?   │
            │  Path: {workspace}/grimoires/ │
            │        loa/BEAUVOIR.md        │
            └───────────────┬───────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
        ┌───────────┐               ┌───────────┐
        │  EXISTS   │               │ NOT FOUND │
        └─────┬─────┘               └─────┬─────┘
              │                           │
              ▼                           │
    ┌─────────────────────┐               │
    │ generateSoulFrom    │               │
    │ Beauvoir()          │               │
    │                     │               │
    │ 1. Read file        │               │
    │ 2. Parse sections   │               │
    │ 3. Transform        │               │
    └──────────┬──────────┘               │
               │                          │
               ▼                          │
    ┌─────────────────────┐               │
    │ Success?            │               │
    └──────────┬──────────┘               │
               │                          │
     ┌─────────┴─────────┐                │
     │                   │                │
     ▼                   ▼                │
┌─────────┐        ┌─────────┐            │
│   YES   │        │   NO    │            │
│ (use    │        │ (log    │            │
│  result)│        │  warn)  │            │
└────┬────┘        └────┬────┘            │
     │                  │                 │
     │                  └────────┬────────┘
     │                           │
     │                           ▼
     │                  ┌─────────────────┐
     │                  │ loadTemplate()  │
     │                  │ (default SOUL)  │
     │                  └────────┬────────┘
     │                           │
     └───────────────┬───────────┘
                     │
                     ▼
            ┌─────────────────┐
            │ writeFileIf     │
            │ Missing()       │
            │                 │
            │ Path: {ws}/     │
            │       SOUL.md   │
            └─────────────────┘
```

---

## 2. Component Design

### 2.1 New File: `src/agents/loa-soul-generator.ts`

This file encapsulates all LOA-specific logic for SOUL.md generation.

```typescript
/**
 * LOA Soul Generator
 *
 * Transforms grimoires/loa/BEAUVOIR.md content to SOUL.md format.
 * Used by workspace.ts during workspace initialization.
 *
 * Design principles:
 * - Single responsibility: Only handles BEAUVOIR → SOUL transformation
 * - Graceful degradation: Returns null on any error (caller uses fallback)
 * - No side effects: Pure functions for transformation
 * - Minimal dependencies: Only uses node:fs and node:path
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Attempt to generate SOUL.md content from BEAUVOIR.md.
 *
 * @param workspaceDir - The workspace directory (e.g., ~/.openclaw/workspace)
 * @returns Generated SOUL.md content, or null if BEAUVOIR.md not found/invalid
 */
export async function tryGenerateSoulFromBeauvoir(workspaceDir: string): Promise<string | null> {
  const beauvoirPath = path.join(workspaceDir, "grimoires/loa/BEAUVOIR.md");

  try {
    const content = await fs.readFile(beauvoirPath, "utf-8");
    return transformBeauvoirToSoul(content);
  } catch {
    // BEAUVOIR.md not found or unreadable - caller will use fallback
    return null;
  }
}

/**
 * Transform BEAUVOIR.md content to SOUL.md format.
 *
 * Mapping:
 * - ## Identity → ## Persona
 * - ## Interaction Style → ## Tone
 * - ## Boundaries → ## Boundaries
 * - ## Recovery Protocol → ## Recovery Protocol (if present)
 */
function transformBeauvoirToSoul(beauvoirContent: string): string {
  const sections = parseMarkdownSections(beauvoirContent);

  const lines: string[] = [
    "# SOUL.md",
    "",
    "> Auto-generated from grimoires/loa/BEAUVOIR.md",
    "> Do not edit directly - modify BEAUVOIR.md instead.",
    "",
  ];

  // Persona section (from Identity)
  lines.push("## Persona");
  lines.push("");
  lines.push(sections.get("identity") ?? getDefaultPersona());
  lines.push("");

  // Tone section (from Interaction Style)
  lines.push("## Tone");
  lines.push("");
  lines.push(sections.get("interaction style") ?? getDefaultTone());
  lines.push("");

  // Boundaries section
  lines.push("## Boundaries");
  lines.push("");
  lines.push(sections.get("boundaries") ?? getDefaultBoundaries());
  lines.push("");

  // Recovery Protocol (optional, LOA-specific)
  const recovery = sections.get("recovery protocol");
  if (recovery) {
    lines.push("## Recovery Protocol");
    lines.push("");
    lines.push(recovery);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("*Generated by LOA from BEAUVOIR.md*");

  return lines.join("\n");
}

/**
 * Parse markdown content into sections by ## headers.
 *
 * @returns Map of lowercase section name → section content (trimmed)
 */
function parseMarkdownSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split("\n");

  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // Save previous section
      if (currentSection) {
        sections.set(currentSection, currentContent.join("\n").trim());
      }
      // Start new section
      currentSection = line.slice(3).toLowerCase().trim();
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    sections.set(currentSection, currentContent.join("\n").trim());
  }

  return sections;
}

// Default content for missing sections
function getDefaultPersona(): string {
  return `I am **Loa Beauvoir** — an AI assistant with persistent identity and memory.

When meeting a new operator for the first time, I introduce myself and ask what name they'd like to call me.

What makes me different:
- **Memory persistence**: I remember our conversations
- **Identity continuity**: I have opinions and a consistent personality
- **Self-healing**: If I lose state, I recover and keep working`;
}

function getDefaultTone(): string {
  return `- **Concise**: Lead with answers, skip pleasantries
- **Opinionated**: Recommend rather than enumerate options
- **Resourceful**: Check before asking, try before failing
- **Transparent**: Show reasoning, admit uncertainty`;
}

function getDefaultBoundaries(): string {
  return `### Will Not Do
- Guess credentials or sensitive values
- Push code without review
- Claim certainty when uncertain

### Always Do
- Log significant decisions
- Cite sources for factual claims
- Auto-recover from failures`;
}
```

### 2.2 Modified: `src/agents/workspace.ts`

Minimal changes to integrate LOA:

```typescript
// === ADD IMPORT (top of file) ===
import { tryGenerateSoulFromBeauvoir } from "./loa-soul-generator.js";

// === MODIFY ensureAgentWorkspace() ===
// Around line 178, replace:
//   await writeFileIfMissing(soulPath, soulTemplate);
// With:

// LOA Integration: Generate SOUL.md from BEAUVOIR.md if available
const loaSoul = await tryGenerateSoulFromBeauvoir(dir);
await writeFileIfMissing(soulPath, loaSoul ?? soulTemplate);
```

**Total change**: 2 lines modified, 1 import added.

---

## 3. Files to Delete

The plugin approach left significant dead code that should be removed:

### 3.1 `extensions/loa/` Directory (DELETE ENTIRE)

```
extensions/loa/
├── index.ts                    # Plugin entry point (never executed properly)
├── types.ts                    # Type definitions
├── package.json                # Plugin package
├── clawdbot.plugin.json        # Plugin manifest
├── adapters/
│   └── hook-adapter.ts         # SDK adapter (hooks never fired)
├── bridges/
│   ├── bootstrap.ts            # Bootstrap handler (dead code)
│   ├── context.ts              # Context injector (dead code)
│   ├── init.ts                 # Initialization (dead code)
│   ├── learnings.ts            # Learnings bridge (dead code)
│   ├── memory.ts               # Memory capture (dead code)
│   ├── recovery.ts             # Recovery runner (dead code)
│   └── soul-generator.ts       # Soul generator (replaced)
├── state/
│   ├── loop-detector.ts        # Loop detection (dead code)
│   └── retry-queue.ts          # Retry queue (dead code)
└── __tests__/
    ├── integration.test.ts     # Integration tests
    ├── hook-adapter.test.ts    # Adapter tests
    ├── context.test.ts         # Context tests
    └── loop-detector.test.ts   # Loop detector tests
```

**Estimated LOC removed**: ~2500 lines

### 3.2 Rationale for Deletion

| File/Directory | Reason for Deletion                               |
| -------------- | ------------------------------------------------- |
| `index.ts`     | Plugin registration async issue - never worked    |
| `bridges/*`    | Built for hooks that never fire (`gateway_start`) |
| `adapters/*`   | SDK adapter for non-existent hook behavior        |
| `state/*`      | State management for features that never ran      |
| `__tests__/*`  | Tests for dead code                               |

---

## 4. Configuration Changes

### 4.1 `docker-compose.dev.yml`

Remove plugin volume mounts:

```yaml
# REMOVE these lines:
- ./extensions/loa:/workspace/extensions/loa:rw
- ./extensions/loa/node_modules:/workspace/extensions/loa/node_modules:ro
```

### 4.2 `deploy/start-loa-dev.sh`

Remove all plugin-related code:

```bash
# REMOVE: npm install -g @noble/ed25519 @noble/hashes
# REMOVE: mkdir -p /workspace/deploy/loa-identity/node_modules/@noble
# REMOVE: ln -sf ... (symlinks for @noble)
# REMOVE: clawdbot plugins install --link /workspace/extensions/loa
# REMOVE: Plugin verification checks
```

The script becomes much simpler - just starts the gateway.

---

## 5. Error Handling

### 5.1 Failure Modes

| Failure                | Handling                                         | User Impact                |
| ---------------------- | ------------------------------------------------ | -------------------------- |
| BEAUVOIR.md not found  | Return null, use default template                | Agent uses generic persona |
| BEAUVOIR.md unreadable | Return null, use default template                | Agent uses generic persona |
| Malformed BEAUVOIR.md  | Best-effort parse, missing sections use defaults | Partial LOA persona        |
| Write failure          | Existing OpenClaw error handling                 | Workspace init fails       |

### 5.2 No Blocking Failures

The design ensures LOA issues **never block agent startup**:

```typescript
// tryGenerateSoulFromBeauvoir returns null on ANY error
// Caller always has fallback:
const loaSoul = await tryGenerateSoulFromBeauvoir(dir);
await writeFileIfMissing(soulPath, loaSoul ?? soulTemplate); // Always succeeds
```

---

## 6. Testing Strategy

### 6.1 Unit Tests

New file: `src/agents/loa-soul-generator.test.ts`

```typescript
describe("loa-soul-generator", () => {
  describe("tryGenerateSoulFromBeauvoir", () => {
    it("returns null when BEAUVOIR.md not found", async () => {
      const result = await tryGenerateSoulFromBeauvoir("/nonexistent");
      expect(result).toBeNull();
    });

    it("generates SOUL.md from valid BEAUVOIR.md", async () => {
      // Create temp dir with BEAUVOIR.md
      // Verify output contains expected sections
    });

    it("handles malformed BEAUVOIR.md gracefully", async () => {
      // Create temp dir with malformed content
      // Verify returns content (not null) with defaults
    });
  });

  describe("parseMarkdownSections", () => {
    it("parses ## headers into sections", () => {
      const content = "## Identity\nI am Loa\n\n## Boundaries\nNo secrets";
      // Test section extraction
    });
  });
});
```

### 6.2 Integration Tests

```typescript
describe("workspace LOA integration", () => {
  it("generates LOA SOUL.md when BEAUVOIR.md exists", async () => {
    // Setup workspace with grimoires/loa/BEAUVOIR.md
    // Call ensureAgentWorkspace
    // Verify SOUL.md contains LOA identity
  });

  it("uses default SOUL.md when BEAUVOIR.md missing", async () => {
    // Setup workspace WITHOUT grimoires/loa/BEAUVOIR.md
    // Call ensureAgentWorkspace
    // Verify SOUL.md contains default template
  });
});
```

### 6.3 Manual E2E Test

1. `make dev-build` - Rebuild container
2. `make dev-chat` - Open webchat
3. Send "Hello"
4. **Expected**: Agent introduces as Loa Beauvoir, asks for name

---

## 7. Migration & Rollback

### 7.1 Migration Steps

1. Create `src/agents/loa-soul-generator.ts`
2. Add import to `src/agents/workspace.ts`
3. Add 2-line integration code
4. Update BEAUVOIR.md with Identity section
5. Delete `extensions/loa/` directory
6. Update docker-compose.dev.yml
7. Update start-loa-dev.sh
8. Run tests
9. Rebuild and verify

### 7.2 Rollback Plan

If issues discovered:

```bash
# Revert workspace.ts (2 lines)
git checkout HEAD -- src/agents/workspace.ts

# Delete new file
rm src/agents/loa-soul-generator.ts

# Restore plugin if needed (from git history)
git checkout HEAD~1 -- extensions/loa/
```

**Rollback time**: < 2 minutes

---

## 8. Performance Considerations

| Operation                | Expected Time | Notes              |
| ------------------------ | ------------- | ------------------ |
| Check BEAUVOIR.md exists | < 1ms         | Single stat() call |
| Read BEAUVOIR.md         | < 5ms         | ~6KB file          |
| Parse and transform      | < 1ms         | String operations  |
| **Total overhead**       | < 10ms        | Negligible         |

This adds minimal overhead to workspace initialization.

---

## 9. Future Considerations

### 9.1 Memory Capture (Phase 2)

The `deploy/loa-identity/` memory system could be integrated later:

- Hook into agent execution (would need working hooks or core integration)
- Capture significant interactions to NOTES.md
- Quality gates and PII redaction

### 9.2 Recovery Engine (Phase 2)

Recovery could run on gateway start if we add hook emission:

- File: `src/cli/gateway-cli/run.ts`
- Add: `await hooks.runGatewayStartHook(...)` after gateway ready

### 9.3 Grimoires Path Configuration

Per feedback #173, future versions should support:

```yaml
grimoires:
  beauvoir_path: "grimoires/loa/BEAUVOIR.md"
  soul_output_path: "SOUL.md" # workspace root
```

---

_Generated by Loa Framework_
