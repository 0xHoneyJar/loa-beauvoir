# PRD: LOA-OpenClaw Path Integration Refactor

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-04
> **Branch**: feature/soul-init

---

## Executive Summary

Refactor the LOA-OpenClaw integration to use configurable paths instead of hardcoded values, aligning with Loa framework v1.27.0's configurable paths feature. This enables zero-code changes when deploying to different environments while maintaining persistence guarantees.

---

## Problem Statement

### Current State

The `loa-soul-generator.ts` file hardcodes the BEAUVOIR.md path:

```typescript
const beauvoirPath = path.join(workspaceDir, "grimoires/loa/BEAUVOIR.md");
```

This creates coupling between:

1. LOA identity source location
2. OpenClaw workspace structure
3. Deployment environment assumptions

### Impact

- **Inflexibility**: Cannot relocate BEAUVOIR.md without code changes
- **Environment mismatch**: Dev/prod may have different directory structures
- **Integration friction**: Grafting LOA into OpenClaw requires understanding internal paths

### Root Cause

The original implementation prioritized quick integration over configurability. With Loa v1.27.0's `path-lib.sh` providing a pattern for configurable paths, we can now align with framework conventions.

---

## Goals

### Primary Goals

| Goal                    | Metric                         | Priority |
| ----------------------- | ------------------------------ | -------- |
| **Zero data loss**      | No persistence regressions     | P0       |
| **Configurable paths**  | BEAUVOIR.md path via env var   | P0       |
| **Backward compatible** | Existing deployments unchanged | P0       |

### Non-Goals

- Changing OpenClaw's workspace structure
- Modifying the persistence/R2 backup system
- Adding new configuration file formats

---

## Proposed Solution

### Overview

Add environment variable support to `loa-soul-generator.ts` following Loa's `path-lib.sh` pattern:

```typescript
// Before: Hardcoded
const beauvoirPath = path.join(workspaceDir, "grimoires/loa/BEAUVOIR.md");

// After: Configurable with default
const beauvoirPath =
  process.env.LOA_SOUL_SOURCE ?? path.join(workspaceDir, "grimoires/loa/BEAUVOIR.md");
```

### Environment Variables

| Variable          | Description                  | Default                                 |
| ----------------- | ---------------------------- | --------------------------------------- |
| `LOA_SOUL_SOURCE` | Absolute path to BEAUVOIR.md | `{workspace}/grimoires/loa/BEAUVOIR.md` |

### Behavior

1. **If `LOA_SOUL_SOURCE` is set**: Use the specified absolute path
2. **If not set**: Use the default path (current behavior)
3. **If file not found**: Return null, fallback to default SOUL.md template

---

## Technical Design

### Changes Required

| File                               | Change                   | LOC |
| ---------------------------------- | ------------------------ | --- |
| `src/agents/loa-soul-generator.ts` | Add env var check        | ~5  |
| `deploy/start-loa.sh`              | Export `LOA_SOUL_SOURCE` | ~2  |
| `deploy/start-loa-dev.sh`          | Export `LOA_SOUL_SOURCE` | ~2  |

**Total**: ~9 lines changed

### Path Resolution Logic

```typescript
function resolveSoulSourcePath(workspaceDir: string): string {
  // 1. Check environment variable (absolute path)
  if (process.env.LOA_SOUL_SOURCE) {
    return process.env.LOA_SOUL_SOURCE;
  }

  // 2. Default: relative to workspace
  return path.join(workspaceDir, "grimoires/loa/BEAUVOIR.md");
}
```

### Persistence Guarantee

The existing persistence model is **unchanged**:

| Environment | Persistence Mechanism  | BEAUVOIR.md Location                   |
| ----------- | ---------------------- | -------------------------------------- |
| Dev         | Volume mount from host | `/workspace/grimoires/loa/BEAUVOIR.md` |
| Prod        | R2 backup/restore      | `/workspace/grimoires/loa/BEAUVOIR.md` |

The symlink at `/root/.openclaw/workspace/grimoires/loa` → `/workspace/grimoires/loa` ensures the path works from the workspace context.

---

## Acceptance Criteria

### Functional

- [ ] `LOA_SOUL_SOURCE` env var overrides default BEAUVOIR.md path
- [ ] Unset env var uses default path (backward compatible)
- [ ] Invalid path returns null (graceful degradation)
- [ ] SOUL.md generated correctly from custom path

### Non-Functional

- [ ] No changes to persistence behavior
- [ ] No changes to R2 backup/restore
- [ ] Existing deployments work without modification

### Testing

- [ ] Unit test: env var override
- [ ] Unit test: default path fallback
- [ ] E2E test: container startup with custom path
- [ ] E2E test: container startup without env var (regression)

---

## Rollout Plan

### Phase 1: Implementation

- Modify `loa-soul-generator.ts`
- Update startup scripts

### Phase 2: Testing

- Run existing E2E tests
- Verify dev container works
- Verify prod deployment unchanged

### Phase 3: Documentation

- Update BEAUVOIR.md comment header
- Update grimoires README if present

---

## Risks & Mitigations

| Risk                          | Likelihood | Impact | Mitigation                           |
| ----------------------------- | ---------- | ------ | ------------------------------------ |
| Path resolution edge cases    | Low        | Medium | Validate absolute vs relative paths  |
| Env var not propagated        | Low        | High   | Test in both dev and prod containers |
| Breaking existing deployments | Very Low   | High   | Default maintains current behavior   |

---

## Dependencies

- Loa v1.27.0 (already merged) - provides pattern reference
- No external dependencies required

---

## Success Metrics

| Metric              | Target  | Measurement              |
| ------------------- | ------- | ------------------------ |
| Code change size    | <15 LOC | Git diff                 |
| Regression rate     | 0%      | E2E test pass rate       |
| Deployment friction | None    | No config changes needed |

---

_Generated by Loa Simstim Workflow_
