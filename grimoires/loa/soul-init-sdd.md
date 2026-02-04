# SDD: LOA-OpenClaw Path Integration Refactor

> **Version**: 1.0.0
> **PRD Reference**: `grimoires/loa/soul-init-prd.md`
> **Created**: 2026-02-04

---

## Architecture Overview

This is a **surgical refactor** - minimal code changes to add environment variable support for the BEAUVOIR.md path. No architectural changes to OpenClaw or the persistence system.

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Workspace                        │
│                  (~/.openclaw/workspace/)                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────┐    ┌──────────────────┐    ┌─────────────┐    │
│  │ SOUL.md │◄───│ loa-soul-gen.ts  │◄───│ BEAUVOIR.md │    │
│  │ (root)  │    │                  │    │ (configurable)   │
│  └─────────┘    └────────┬─────────┘    └─────────────┘    │
│                          │                     ▲            │
│                          │                     │            │
│                   ┌──────▼──────┐              │            │
│                   │ ENV CHECK   │──────────────┘            │
│                   │LOA_SOUL_SRC │                           │
│                   └─────────────┘                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Detailed Design

### 1. Modified Function: `tryGenerateSoulFromBeauvoir`

**File**: `src/agents/loa-soul-generator.ts`

**Before**:

```typescript
export async function tryGenerateSoulFromBeauvoir(workspaceDir: string): Promise<string | null> {
  const beauvoirPath = path.join(workspaceDir, "grimoires/loa/BEAUVOIR.md");

  try {
    const content = await fs.readFile(beauvoirPath, "utf-8");
    return transformBeauvoirToSoul(content);
  } catch {
    return null;
  }
}
```

**After**:

```typescript
export async function tryGenerateSoulFromBeauvoir(workspaceDir: string): Promise<string | null> {
  // Support configurable path via environment variable (Loa v1.27.0 pattern)
  const beauvoirPath =
    process.env.LOA_SOUL_SOURCE ?? path.join(workspaceDir, "grimoires/loa/BEAUVOIR.md");

  try {
    const content = await fs.readFile(beauvoirPath, "utf-8");
    return transformBeauvoirToSoul(content);
  } catch {
    // BEAUVOIR.md not found or unreadable - caller will use fallback
    return null;
  }
}
```

**Change**: +2 lines, 0 lines removed

### 2. Startup Script Updates

#### `deploy/start-loa.sh`

Add after the `GRIMOIRE_DIR` definition (~line 26):

```bash
# LOA Soul Source - configurable BEAUVOIR.md path
# Follows Loa v1.27.0 path-lib.sh pattern
export LOA_SOUL_SOURCE="${LOA_SOUL_SOURCE:-$GRIMOIRE_DIR/BEAUVOIR.md}"
```

#### `deploy/start-loa-dev.sh`

Add in the environment logging section (~line 22):

```bash
echo "[loa-dev] LOA_SOUL_SOURCE=${LOA_SOUL_SOURCE:-$GRIMOIRE_DIR/BEAUVOIR.md}"
```

### 3. Path Resolution Flow

```
tryGenerateSoulFromBeauvoir(workspaceDir)
    │
    ▼
┌───────────────────────────────────────┐
│ process.env.LOA_SOUL_SOURCE set?      │
└───────────────────────────────────────┘
    │                    │
    │ Yes                │ No
    ▼                    ▼
┌─────────────┐    ┌─────────────────────────────────┐
│ Use env var │    │ Use default:                    │
│ (absolute)  │    │ {workspaceDir}/grimoires/loa/   │
└─────────────┘    │ BEAUVOIR.md                     │
    │              └─────────────────────────────────┘
    │                    │
    └────────┬───────────┘
             ▼
┌───────────────────────────────────────┐
│ fs.readFile(beauvoirPath)             │
└───────────────────────────────────────┘
    │                    │
    │ Success            │ Error
    ▼                    ▼
┌─────────────┐    ┌─────────────────────┐
│ Transform   │    │ Return null         │
│ to SOUL.md  │    │ (use default tmpl)  │
└─────────────┘    └─────────────────────┘
```

---

## Data Model

No data model changes. The transformation logic remains identical.

---

## API Changes

No API changes. The function signature remains:

```typescript
tryGenerateSoulFromBeauvoir(workspaceDir: string): Promise<string | null>
```

---

## Configuration

### Environment Variables

| Variable          | Type          | Default                                 | Description                  |
| ----------------- | ------------- | --------------------------------------- | ---------------------------- |
| `LOA_SOUL_SOURCE` | string (path) | `{workspace}/grimoires/loa/BEAUVOIR.md` | Absolute path to BEAUVOIR.md |

### Usage Examples

```bash
# Default (no change needed)
# Uses: /root/.openclaw/workspace/grimoires/loa/BEAUVOIR.md

# Custom location
export LOA_SOUL_SOURCE="/custom/path/to/BEAUVOIR.md"

# Via docker-compose
environment:
  LOA_SOUL_SOURCE: /data/identity/BEAUVOIR.md
```

---

## Testing Strategy

### Unit Tests

**File**: `src/agents/__tests__/loa-soul-generator.test.ts` (new or extend existing)

```typescript
describe("tryGenerateSoulFromBeauvoir", () => {
  it("uses LOA_SOUL_SOURCE env var when set", async () => {
    process.env.LOA_SOUL_SOURCE = "/custom/BEAUVOIR.md";
    // Mock fs.readFile to track called path
    // Assert custom path was used
  });

  it("falls back to default path when env var not set", async () => {
    delete process.env.LOA_SOUL_SOURCE;
    // Assert default path constructed from workspaceDir
  });

  it("returns null when file not found (either path)", async () => {
    // Assert graceful degradation
  });
});
```

### E2E Tests

1. **Dev container with default**: `make dev` → verify SOUL.md generated
2. **Dev container with custom path**: Set `LOA_SOUL_SOURCE` → verify custom path used
3. **Prod container**: Deploy → verify persistence unchanged

---

## Security Considerations

- **Path traversal**: The env var accepts any path. This is intentional for flexibility but requires trust in deployment configuration.
- **No secrets involved**: BEAUVOIR.md contains identity config, not secrets.

---

## Rollback Plan

If issues arise:

1. Remove env var from startup scripts
2. Revert the 2-line change in `loa-soul-generator.ts`
3. Rebuild container

**Rollback time**: < 5 minutes

---

## Implementation Checklist

- [ ] Modify `src/agents/loa-soul-generator.ts` (2 lines)
- [ ] Update `deploy/start-loa.sh` (3 lines)
- [ ] Update `deploy/start-loa-dev.sh` (1 line)
- [ ] Add unit test for env var override
- [ ] Test dev container
- [ ] Test prod deployment (or verify no regression)

---

_Generated by Loa Simstim Workflow_
