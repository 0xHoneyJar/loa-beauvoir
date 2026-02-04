# Sprint Plan: Minimal Docker Image with On-Demand Tool Loading

> **Version**: 1.0.0
> **PRD**: `grimoires/loa/minimal-dev-prd.md`
> **SDD**: `grimoires/loa/minimal-dev-sdd.md`
> **Created**: 2026-02-04

---

## Sprint Overview

| Sprint | Focus                 | Duration | Key Deliverable              |
| ------ | --------------------- | -------- | ---------------------------- |
| **1**  | Core Image Extraction | 1 day    | `Dockerfile.core` (<1GB)     |
| **2**  | Tool Loader Service   | 1 day    | Background tool installation |
| **3**  | Integration & Testing | 1 day    | Full E2E workflow            |

---

## Sprint 1: Core Image Extraction

### Objective

Create a minimal Docker image that boots fast and passes health checks without optimization tools.

### Tasks

#### Task 1.1: Create Dockerfile.core

**File**: `deploy/Dockerfile.core`

**Acceptance Criteria**:

- [ ] Image size <1GB compressed
- [ ] Contains: Node.js 22, clawdbot, yq, jq, git, ripgrep
- [ ] Does NOT contain: Rust, ck-search, beads, sentence-transformers, Python ML packages
- [ ] Gateway starts and responds to `/health`

**Implementation**:

```dockerfile
# Start from sandbox base
FROM docker.io/cloudflare/sandbox:0.7.0

# Minimal deps only: Node.js, basic tools
# NO: build-essential, pkg-config, libssl-dev, python3-pip
```

#### Task 1.2: Create tool directory structure

**Files**: Directory setup in Dockerfile

**Acceptance Criteria**:

- [ ] `/data/tools/` directory exists
- [ ] Proper permissions for tool installation
- [ ] Environment variable `LOA_TOOL_DIR` set

#### Task 1.3: Update start-loa.sh for graceful degradation

**File**: `deploy/start-loa.sh`

**Acceptance Criteria**:

- [ ] Gateway starts even without optimization tools
- [ ] Log messages indicate tools are pending
- [ ] No errors when ck/beads/transformers missing

**Implementation**:

```bash
# Check for tools and log status
check_tool_status() {
    echo "[loa] Tool Status:"
    command -v ck &>/dev/null && echo "[loa]   ck-search: installed" || echo "[loa]   ck-search: pending"
    command -v br &>/dev/null && echo "[loa]   beads_rust: installed" || echo "[loa]   beads_rust: pending"
    python3 -c "import sentence_transformers" 2>/dev/null && echo "[loa]   sentence-transformers: installed" || echo "[loa]   sentence-transformers: pending"
}
```

#### Task 1.4: Build and size verification

**Commands**:

```bash
docker build -f deploy/Dockerfile.core -t loa-core:test deploy/
docker images loa-core:test --format "{{.Size}}"
# Must be <1GB
```

**Acceptance Criteria**:

- [ ] Build completes without errors
- [ ] Image size <1GB
- [ ] Gateway starts in <30 seconds

### Sprint 1 Definition of Done

- [ ] Dockerfile.core exists and builds
- [ ] Image size verified <1GB
- [ ] Gateway health check passes
- [ ] PR created with changes

---

## Sprint 2: Tool Loader Service

### Objective

Implement background service that installs optimization tools after container startup.

### Tasks

#### Task 2.1: Create tool-loader.ts

**File**: `deploy/loa-identity/tool-loader/tool-loader.ts`

**Acceptance Criteria**:

- [ ] `ToolSpec` interface defined
- [ ] `ToolLoader` class with `run()` method
- [ ] State persistence to `/data/tools/loader-state.json`
- [ ] Dependency ordering (rust before ck-search)
- [ ] Error handling for failed installs

**Key Functions**:

```typescript
export class ToolLoader {
  async run(): Promise<void>;
  getStatus(): LoaderState;
  isComplete(): boolean;
}

export function startBackgroundLoading(): void;
```

#### Task 2.2: Create extended-health.ts

**File**: `deploy/loa-identity/health/extended-health.ts`

**Acceptance Criteria**:

- [ ] `ExtendedHealthResponse` interface
- [ ] Tool status included in response
- [ ] Capability flags (semanticSearch, taskGraph, memoryStack)

**Response Format**:

```json
{
  "status": "healthy",
  "tools": {
    "loading": true,
    "complete": false,
    "status": { "rust": "installing", "ck-search": "pending" }
  },
  "capabilities": {
    "semanticSearch": false,
    "taskGraph": false,
    "memoryStack": false
  }
}
```

#### Task 2.3: Integrate tool loader into startup

**File**: `deploy/start-loa.sh`

**Acceptance Criteria**:

- [ ] Tool loader starts in background after gateway
- [ ] `LOA_DEFERRED_TOOLS` env var controls behavior
- [ ] Tool loader PID logged

**Implementation**:

```bash
if [ "${LOA_DEFERRED_TOOLS:-true}" = "true" ]; then
    echo "[loa] Starting deferred tool loader..."
    tsx /workspace/deploy/loa-identity/tool-loader/tool-loader.ts &
    echo "[loa] Tool loader started (PID: $!)"
fi
```

#### Task 2.4: Add unit tests

**File**: `deploy/loa-identity/tool-loader/__tests__/tool-loader.test.ts`

**Acceptance Criteria**:

- [ ] Test: dependency ordering
- [ ] Test: state persistence
- [ ] Test: failure handling
- [ ] Test: already-installed detection

### Sprint 2 Definition of Done

- [ ] tool-loader.ts implemented
- [ ] extended-health.ts implemented
- [ ] Integration into start-loa.sh
- [ ] Unit tests passing
- [ ] PR created with changes

---

## Sprint 3: Integration & Testing

### Objective

Full end-to-end testing and CI/CD integration.

### Tasks

#### Task 3.1: E2E test - core image boot

**File**: `deploy/__tests__/core-image.e2e.test.ts`

**Acceptance Criteria**:

- [ ] Build core image
- [ ] Start container
- [ ] Verify health check in <30s
- [ ] Verify gateway responds

#### Task 3.2: E2E test - tool loading

**File**: `deploy/__tests__/tool-loader.e2e.test.ts`

**Acceptance Criteria**:

- [ ] Start core container
- [ ] Wait for tool loading (max 15 min)
- [ ] Verify all tools installed
- [ ] Verify extended health shows capabilities

#### Task 3.3: E2E test - persistence

**Acceptance Criteria**:

- [ ] Start container, let tools install
- [ ] Stop container
- [ ] Restart container
- [ ] Verify tools still available (no reinstall)

#### Task 3.4: Update CI/CD workflow

**File**: `.github/workflows/cloudflare-deploy.yml`

**Changes**:

- [ ] Build `Dockerfile.core` instead of `Dockerfile`
- [ ] Add step to verify image size
- [ ] Update smoke test for extended health

#### Task 3.5: Update documentation

**Files**:

- `docs/DEVELOPMENT-WORKFLOW.md`
- `deploy/README.md`

**Acceptance Criteria**:

- [ ] Document netinstall pattern
- [ ] Document tool loading behavior
- [ ] Document troubleshooting for tool failures

### Sprint 3 Definition of Done

- [ ] All E2E tests passing
- [ ] CI/CD updated and working
- [ ] Documentation updated
- [ ] Final PR merged

---

## Risk Mitigation

| Risk                                 | Mitigation                                     |
| ------------------------------------ | ---------------------------------------------- |
| Rust compilation fails on low memory | Use pre-compiled binaries from GitHub releases |
| Tool loader crashes                  | Supervisor pattern with restart                |
| R2 volume not mounted                | Detect and use ephemeral /tmp with warning     |
| Network issues during install        | Exponential backoff, 3 retries                 |

---

## Success Metrics

| Metric            | Sprint 1 | Sprint 2 | Sprint 3 |
| ----------------- | -------- | -------- | -------- |
| Core image size   | <1GB     | -        | -        |
| Boot time         | <30s     | <30s     | <30s     |
| Push timeout rate | 0%       | 0%       | 0%       |
| Tool availability | 0%       | 50%      | 100%     |

---

## Dependencies

- Existing `cloudflare/sandbox:0.7.0` base image
- R2 volume mount for tool persistence
- GitHub releases for pre-compiled binaries (optional)

---

_Generated by Loa Simstim Workflow_
