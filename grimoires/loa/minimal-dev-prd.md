# PRD: Minimal Docker Image with On-Demand Tool Loading

> **Version**: 1.0.0
> **Status**: Draft
> **Created**: 2026-02-04
> **Branch**: feature/minimal-dev

---

## Executive Summary

Implement a "netinstall" pattern for Loa Docker images, enabling rapid initial deployment with minimal image size (~800MB), followed by on-demand loading of optimization tools (ck-search, beads_rust, sentence-transformers) at runtime. This addresses frequent deployment failures caused by large image pushes timing out.

---

## Problem Statement

### Current State

The production Dockerfile has **disabled** critical optimization tools to keep image size manageable:

```dockerfile
# NOTE: The following are disabled to keep image size under 6GB:
# - Rust toolchain + ck-search (~500MB compiled)
# - sentence-transformers + PyTorch + CUDA (~8GB)
# - patchright + Chromium (~170MB)
```

Evidence from Docker image sizes:

- `loa-dev:local` - 2.31GB (minimal)
- `loa-beauvoir-sandbox` - 2.84GB (production current)
- Full image with tools - **14GB** (causes push timeouts)

### Impact

| Issue                      | Severity | Frequency                      |
| -------------------------- | -------- | ------------------------------ |
| Image push timeout         | HIGH     | Every full rebuild             |
| CI/CD failures             | HIGH     | ~30% of deploys without cache  |
| Cold start delays          | MEDIUM   | Every container restart        |
| Missing optimization tools | MEDIUM   | Permanent (currently disabled) |

### Root Cause

Cloudflare container registry has practical limits for image size and push duration. Large images with Rust compilation, PyTorch, and Chromium exceed these limits without layer caching.

---

## Goals

### Primary Goals

| Goal                   | Metric                       | Priority |
| ---------------------- | ---------------------------- | -------- |
| **Minimal base image** | <1GB compressed              | P0       |
| **Reliable deploys**   | 0% push timeouts             | P0       |
| **Tool availability**  | All tools loadable on-demand | P1       |
| **Fast iteration**     | First deploy <5 minutes      | P1       |

### Non-Goals

- Reducing total storage usage (tools still get downloaded)
- Changing the tool set itself
- Modifying Cloudflare Workers architecture

---

## Proposed Solution

### Overview: The Netinstall Pattern

Inspired by Linux netinstall ISOs which provide minimal bootable systems that fetch packages on first boot:

```
┌─────────────────────────────────────────────────────────────┐
│                    DEPLOYMENT FLOW                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  BUILD TIME                    RUNTIME (First Boot)         │
│  ──────────                    ────────────────────          │
│                                                              │
│  ┌──────────────┐              ┌──────────────────┐         │
│  │ Minimal Base │    Push      │ Health Check OK  │         │
│  │   (~800MB)   │ ──────────▶  │ Gateway Running  │         │
│  └──────────────┘              └────────┬─────────┘         │
│                                         │                    │
│                                         ▼                    │
│                                ┌──────────────────┐         │
│                                │ Tool Loader      │         │
│                                │ (Background)     │         │
│                                └────────┬─────────┘         │
│                                         │                    │
│                                         ▼                    │
│                                ┌──────────────────┐         │
│                                │ Full Capability  │         │
│                                │ (All Tools)      │         │
│                                └──────────────────┘         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Image Tiers

| Tier     | Name       | Size   | Contains                      | When to Use           |
| -------- | ---------- | ------ | ----------------------------- | --------------------- |
| **Core** | `loa-core` | ~800MB | Node, Gateway, Loa identity   | Always (required)     |
| **Dev**  | `loa-dev`  | ~1.5GB | Core + dev tools (entr, tsx)  | Local development     |
| **Full** | `loa-full` | ~4GB   | Core + all optimization tools | Pre-warmed production |

### Tool Loading Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                 TOOL LOADING PRIORITY                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  IMMEDIATE (blocking startup)                               │
│  ──────────────────────────────                             │
│  ✓ Node.js 22                                               │
│  ✓ clawdbot gateway                                         │
│  ✓ yq, jq, git                                              │
│                                                              │
│  DEFERRED (background after health OK)                      │
│  ──────────────────────────────────────                     │
│  → Rust toolchain + ck-search       (~5 min install)        │
│  → beads_rust                       (~2 min install)        │
│  → sentence-transformers            (~3 min install)        │
│  → patchright + Chromium            (~2 min install)        │
│                                                              │
│  ON-DEMAND (when first used)                                │
│  ───────────────────────────                                │
│  → Model downloads (all-MiniLM-L6-v2)                       │
│  → Chromium browser binary                                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Technical Design

### 1. Multi-Stage Dockerfile

```dockerfile
# Stage 1: Core (always built)
FROM cloudflare/sandbox:0.7.0 AS core
# Minimal: Node.js, gateway, basic tools

# Stage 2: Tool Installer (cached separately)
FROM core AS installer
# Pre-compiled binaries fetched from releases

# Stage 3: Runtime (uses core + mounts installer artifacts)
FROM core AS runtime
# Volume mounts for optional tools
```

### 2. Tool Loader Service

New service: `deploy/loa-identity/tool-loader/`

```typescript
interface ToolSpec {
  name: string;
  version: string;
  installCmd: string[];
  verifyCmd: string;
  priority: "deferred" | "on-demand";
  estimatedTime: number; // seconds
}

const TOOLS: ToolSpec[] = [
  {
    name: "ck-search",
    version: "latest",
    installCmd: ["cargo", "install", "ck-search"],
    verifyCmd: "ck --version",
    priority: "deferred",
    estimatedTime: 300,
  },
  // ...
];
```

### 3. Persistent Tool Cache

Tools installed at runtime persist to R2-backed volume:

```
/data/tools/
├── rust/           # Rust toolchain + cargo registry
│   └── .installed  # Version marker
├── ck/             # ck-search binary
├── beads/          # beads_rust binary
├── python/         # Python venv with ML packages
└── browser/        # Chromium installation
```

### 4. Health Check Stages

```bash
# Stage 1: Basic health (immediate)
/health → 200 OK

# Stage 2: Extended health (after tool loading)
/health?full=true → 200 OK + tool status

# Response example:
{
  "status": "healthy",
  "gateway": "running",
  "tools": {
    "ck-search": "installed",
    "beads_rust": "installing",
    "sentence-transformers": "pending"
  }
}
```

---

## Acceptance Criteria

### Functional

- [ ] Core image builds and deploys in <5 minutes
- [ ] Core image size <1GB compressed
- [ ] Gateway starts and passes health check before tools load
- [ ] Tools load in background without blocking gateway
- [ ] Tool status visible via extended health endpoint
- [ ] Tools persist across container restarts (R2 volume)
- [ ] Graceful degradation when tools unavailable

### Non-Functional

- [ ] Zero push timeouts for core image
- [ ] Tool loading completes within 15 minutes
- [ ] No regression in functionality once tools loaded
- [ ] Backward compatible with existing deployment scripts

### Testing

- [ ] E2E: Deploy core image, verify gateway health
- [ ] E2E: Verify tool loading completes
- [ ] E2E: Verify tools work after loading
- [ ] E2E: Verify tools persist after restart
- [ ] Integration: Existing CI/CD works unchanged

---

## Rollout Plan

### Phase 1: Core Image Extraction (Sprint 1)

- Create minimal Dockerfile.core
- Extract tool installation to separate script
- Verify gateway works without tools

### Phase 2: Tool Loader Service (Sprint 2)

- Implement background tool loader
- Add health check extensions
- Add R2 volume persistence

### Phase 3: Integration (Sprint 3)

- Update CI/CD workflows
- Update documentation
- Deprecate old full-image approach

---

## Risks & Mitigations

| Risk                               | Likelihood | Impact | Mitigation                                    |
| ---------------------------------- | ---------- | ------ | --------------------------------------------- |
| Tool installation fails at runtime | Medium     | Medium | Retry logic + fallback to degraded mode       |
| R2 volume not mounted              | Low        | High   | Detect and warn, install to ephemeral storage |
| Rust compilation OOM               | Medium     | Medium | Use pre-compiled binaries from releases       |
| Network issues during tool fetch   | Low        | Medium | Exponential backoff + partial progress        |

---

## Dependencies

- Cloudflare R2 volume mounts (already available)
- Pre-compiled tool binaries (new: GitHub releases)
- No new external dependencies required

---

## Success Metrics

| Metric            | Current  | Target | Measurement     |
| ----------------- | -------- | ------ | --------------- |
| Push timeout rate | ~30%     | 0%     | CI/CD logs      |
| Core image size   | 2.84GB   | <1GB   | Docker inspect  |
| First deploy time | 15+ min  | <5 min | CI/CD timing    |
| Tool availability | Disabled | 100%   | Health endpoint |

---

_Generated by Loa Simstim Workflow_
