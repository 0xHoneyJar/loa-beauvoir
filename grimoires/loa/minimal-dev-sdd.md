# SDD: Minimal Docker Image with On-Demand Tool Loading

> **Version**: 1.0.0
> **PRD Reference**: `grimoires/loa/minimal-dev-prd.md`
> **Created**: 2026-02-04

---

## Architecture Overview

This design implements a two-phase deployment model: immediate core functionality followed by background tool enhancement.

```
┌─────────────────────────────────────────────────────────────────┐
│                    SYSTEM ARCHITECTURE                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    CONTAINER RUNTIME                      │    │
│  │                                                           │    │
│  │  ┌─────────────┐     ┌─────────────┐     ┌───────────┐  │    │
│  │  │   Gateway   │     │ Tool Loader │     │  Health   │  │    │
│  │  │  (core)     │     │ (deferred)  │     │  Server   │  │    │
│  │  └──────┬──────┘     └──────┬──────┘     └─────┬─────┘  │    │
│  │         │                   │                   │        │    │
│  │         │                   │                   │        │    │
│  │         ▼                   ▼                   ▼        │    │
│  │  ┌─────────────────────────────────────────────────────┐│    │
│  │  │              /data/tools (R2 Volume)                ││    │
│  │  │  ┌─────┐ ┌─────┐ ┌────────┐ ┌─────────┐           ││    │
│  │  │  │rust │ │ ck  │ │ beads  │ │ python  │           ││    │
│  │  │  └─────┘ └─────┘ └────────┘ └─────────┘           ││    │
│  │  └─────────────────────────────────────────────────────┘│    │
│  │                                                           │    │
│  └───────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Detailed Design

### 1. Dockerfile Refactoring

**File**: `deploy/Dockerfile.core`

```dockerfile
# =============================================================================
# Loa Core Image - Minimal runtime for rapid deployment
# =============================================================================
# Size target: <800MB compressed
# Boot time: <30 seconds
# Contains: Node.js 22, Gateway, basic tools
# Does NOT contain: Rust, ck-search, beads, sentence-transformers
# =============================================================================

FROM docker.io/cloudflare/sandbox:0.7.0

ARG CACHE_BUST=2026-02-04-core-v1

# -----------------------------------------------------------------------------
# Stage 1: Minimal System Dependencies
# -----------------------------------------------------------------------------
ENV NODE_VERSION=22.13.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    xz-utils \
    ca-certificates \
    rsync \
    ripgrep \
    jq \
    git \
    curl \
    && curl -fsSLk https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install yq (lightweight YAML processor)
RUN curl -fsSL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /usr/local/bin/yq \
    && chmod +x /usr/local/bin/yq

# Install pnpm
RUN npm install -g pnpm@10

# -----------------------------------------------------------------------------
# Stage 2: Gateway Installation
# -----------------------------------------------------------------------------
RUN npm install -g clawdbot@2026.1.24-3

# Directory structure
RUN mkdir -p \
    /workspace/.claude \
    /workspace/grimoires/loa \
    /workspace/deploy/loa-identity \
    /data/tools \
    /data/wal \
    /root/.openclaw

# -----------------------------------------------------------------------------
# Stage 3: Loa Identity Layer
# -----------------------------------------------------------------------------
ARG LOA_REPO=https://github.com/0xHoneyJar/loa-beauvoir.git
ARG LOA_BRANCH=main

RUN git clone --depth 1 --branch ${LOA_BRANCH} ${LOA_REPO} /tmp/loa-repo \
    && cp -r /tmp/loa-repo/.claude/* /workspace/.claude/ \
    && cp -r /tmp/loa-repo/grimoires/* /workspace/grimoires/ \
    && rm -rf /tmp/loa-repo

# Copy startup and tool loader
COPY start-loa.sh /usr/local/bin/start-loa.sh
COPY loa-identity/ /workspace/deploy/loa-identity/

RUN chmod +x /usr/local/bin/start-loa.sh \
    && ln -sf /usr/local/bin/start-loa.sh /usr/local/bin/start-moltbot.sh

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
WORKDIR /workspace

ENV CLAUDE_CONFIG_DIR=/workspace/.claude
ENV NODE_OPTIONS="--max-old-space-size=4096"
ENV LOA_TOOL_DIR=/data/tools
ENV LOA_DEFERRED_TOOLS=true

EXPOSE 3000 18789
```

### 2. Tool Loader Service

**File**: `deploy/loa-identity/tool-loader/tool-loader.ts`

```typescript
/**
 * Tool Loader Service
 *
 * Manages deferred installation of optimization tools after container startup.
 * Implements the "netinstall" pattern - core boots fast, tools load in background.
 */

import { spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface ToolSpec {
  name: string;
  version: string;
  installType: "cargo" | "pip" | "binary" | "script";
  installCmd: string[];
  verifyCmd: string[];
  binaryPath?: string;
  priority: number; // Lower = higher priority
  estimatedSeconds: number;
  dependencies?: string[];
}

export interface ToolStatus {
  name: string;
  status: "pending" | "installing" | "installed" | "failed" | "skipped";
  version?: string;
  installedAt?: string;
  error?: string;
}

export interface LoaderState {
  startedAt: string;
  completedAt?: string;
  tools: Record<string, ToolStatus>;
}

const TOOL_DIR = process.env.LOA_TOOL_DIR ?? "/data/tools";
const STATE_FILE = join(TOOL_DIR, "loader-state.json");

const TOOLS: ToolSpec[] = [
  {
    name: "rust",
    version: "stable",
    installType: "script",
    installCmd: [
      "sh",
      "-c",
      'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable',
    ],
    verifyCmd: ["rustc", "--version"],
    priority: 1,
    estimatedSeconds: 120,
  },
  {
    name: "ck-search",
    version: "latest",
    installType: "cargo",
    installCmd: ["cargo", "install", "ck-search"],
    verifyCmd: ["ck", "--version"],
    binaryPath: "/root/.cargo/bin/ck",
    priority: 2,
    estimatedSeconds: 300,
    dependencies: ["rust"],
  },
  {
    name: "beads_rust",
    version: "latest",
    installType: "cargo",
    installCmd: ["cargo", "install", "beads_rust"],
    verifyCmd: ["br", "--version"],
    binaryPath: "/root/.cargo/bin/br",
    priority: 3,
    estimatedSeconds: 180,
    dependencies: ["rust"],
  },
  {
    name: "sentence-transformers",
    version: "latest",
    installType: "pip",
    installCmd: ["pip3", "install", "--no-cache-dir", "sentence-transformers"],
    verifyCmd: [
      "python3",
      "-c",
      'from sentence_transformers import SentenceTransformer; print("OK")',
    ],
    priority: 4,
    estimatedSeconds: 300,
  },
];

export class ToolLoader {
  private state: LoaderState;
  private installing = false;

  constructor() {
    this.state = this.loadState();
  }

  private loadState(): LoaderState {
    if (existsSync(STATE_FILE)) {
      try {
        return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      } catch {
        // Corrupted state, start fresh
      }
    }

    return {
      startedAt: new Date().toISOString(),
      tools: Object.fromEntries(
        TOOLS.map((t) => [t.name, { name: t.name, status: "pending" as const }]),
      ),
    };
  }

  private saveState(): void {
    mkdirSync(TOOL_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  private async runCommand(cmd: string[]): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        env: {
          ...process.env,
          PATH: `/root/.cargo/bin:${process.env.PATH}`,
          RUSTUP_HOME: "/root/.rustup",
          CARGO_HOME: "/root/.cargo",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      proc.stdout?.on("data", (d) => (output += d.toString()));
      proc.stderr?.on("data", (d) => (output += d.toString()));

      proc.on("close", (code) => {
        resolve({ ok: code === 0, output: output.trim() });
      });

      proc.on("error", (err) => {
        resolve({ ok: false, output: err.message });
      });
    });
  }

  private async isInstalled(tool: ToolSpec): Promise<boolean> {
    // Check binary path if specified
    if (tool.binaryPath && existsSync(tool.binaryPath)) {
      const result = await this.runCommand(tool.verifyCmd);
      return result.ok;
    }

    // Try verify command
    const result = await this.runCommand(tool.verifyCmd);
    return result.ok;
  }

  private async installTool(tool: ToolSpec): Promise<boolean> {
    console.log(`[tool-loader] Installing ${tool.name}...`);

    this.state.tools[tool.name] = {
      name: tool.name,
      status: "installing",
    };
    this.saveState();

    const result = await this.runCommand(tool.installCmd);

    if (result.ok) {
      this.state.tools[tool.name] = {
        name: tool.name,
        status: "installed",
        installedAt: new Date().toISOString(),
      };
      console.log(`[tool-loader] ✓ ${tool.name} installed`);
    } else {
      this.state.tools[tool.name] = {
        name: tool.name,
        status: "failed",
        error: result.output.slice(0, 500),
      };
      console.error(`[tool-loader] ✗ ${tool.name} failed: ${result.output.slice(0, 200)}`);
    }

    this.saveState();
    return result.ok;
  }

  async run(): Promise<void> {
    if (this.installing) {
      console.log("[tool-loader] Already running");
      return;
    }

    if (process.env.LOA_DEFERRED_TOOLS === "false") {
      console.log("[tool-loader] Deferred tools disabled, skipping");
      return;
    }

    this.installing = true;
    console.log("[tool-loader] Starting deferred tool installation...");

    // Sort by priority
    const sortedTools = [...TOOLS].sort((a, b) => a.priority - b.priority);

    for (const tool of sortedTools) {
      // Skip if already installed
      if (await this.isInstalled(tool)) {
        this.state.tools[tool.name] = {
          name: tool.name,
          status: "installed",
          installedAt: "pre-existing",
        };
        this.saveState();
        console.log(`[tool-loader] ${tool.name} already installed`);
        continue;
      }

      // Check dependencies
      if (tool.dependencies) {
        const unmetDeps = tool.dependencies.filter(
          (dep) => this.state.tools[dep]?.status !== "installed",
        );
        if (unmetDeps.length > 0) {
          console.log(`[tool-loader] ${tool.name} waiting for: ${unmetDeps.join(", ")}`);
          this.state.tools[tool.name] = {
            name: tool.name,
            status: "pending",
          };
          continue;
        }
      }

      await this.installTool(tool);
    }

    // Second pass for tools with dependencies
    for (const tool of sortedTools) {
      if (this.state.tools[tool.name].status === "pending" && tool.dependencies) {
        const allDepsInstalled = tool.dependencies.every(
          (dep) => this.state.tools[dep]?.status === "installed",
        );
        if (allDepsInstalled) {
          await this.installTool(tool);
        }
      }
    }

    this.state.completedAt = new Date().toISOString();
    this.saveState();

    const installed = Object.values(this.state.tools).filter(
      (t) => t.status === "installed",
    ).length;
    const failed = Object.values(this.state.tools).filter((t) => t.status === "failed").length;

    console.log(`[tool-loader] Complete: ${installed} installed, ${failed} failed`);
    this.installing = false;
  }

  getStatus(): LoaderState {
    return this.state;
  }

  isComplete(): boolean {
    return Object.values(this.state.tools).every(
      (t) => t.status === "installed" || t.status === "failed" || t.status === "skipped",
    );
  }
}

// Singleton
let loaderInstance: ToolLoader | null = null;

export function getToolLoader(): ToolLoader {
  if (!loaderInstance) {
    loaderInstance = new ToolLoader();
  }
  return loaderInstance;
}

/**
 * Start background tool loading (non-blocking)
 */
export function startBackgroundLoading(): void {
  const loader = getToolLoader();

  // Run after a short delay to let gateway fully start
  setTimeout(() => {
    loader.run().catch((err) => {
      console.error("[tool-loader] Background loading failed:", err);
    });
  }, 5000);
}
```

### 3. Health Endpoint Extension

**File**: `deploy/loa-identity/health/extended-health.ts`

```typescript
/**
 * Extended Health Check
 *
 * Provides detailed status including tool loading progress.
 */

import { getToolLoader } from "../tool-loader/tool-loader.js";

export interface ExtendedHealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  gateway: "running" | "stopped";
  uptime: number;
  tools: {
    loading: boolean;
    complete: boolean;
    status: Record<string, string>;
  };
  capabilities: {
    semanticSearch: boolean; // ck-search
    taskGraph: boolean; // beads_rust
    memoryStack: boolean; // sentence-transformers
  };
}

export function getExtendedHealth(startTime: number): ExtendedHealthResponse {
  const loader = getToolLoader();
  const loaderState = loader.getStatus();

  const toolStatus: Record<string, string> = {};
  for (const [name, status] of Object.entries(loaderState.tools)) {
    toolStatus[name] = status.status;
  }

  const hasck = loaderState.tools["ck-search"]?.status === "installed";
  const hasBeads = loaderState.tools["beads_rust"]?.status === "installed";
  const hasTransformers = loaderState.tools["sentence-transformers"]?.status === "installed";

  return {
    status: "healthy",
    gateway: "running",
    uptime: Math.floor((Date.now() - startTime) / 1000),
    tools: {
      loading: !loader.isComplete(),
      complete: loader.isComplete(),
      status: toolStatus,
    },
    capabilities: {
      semanticSearch: hasck,
      taskGraph: hasBeads,
      memoryStack: hasTransformers,
    },
  };
}
```

### 4. Startup Script Updates

**File**: `deploy/start-loa.sh` (additions)

```bash
# Near the end, after gateway setup but before exec:

# =============================================================================
# DEFERRED TOOL LOADING
# Start background tool installation if enabled
# =============================================================================

if [ "${LOA_DEFERRED_TOOLS:-true}" = "true" ]; then
    echo "[loa] Starting deferred tool loader in background..."

    # Run tool loader as background process
    node --experimental-specifier-resolution=node \
        -e "import('./deploy/loa-identity/tool-loader/tool-loader.js').then(m => m.startBackgroundLoading())" \
        &

    echo "[loa] Tool loader PID: $!"
fi
```

---

## Data Model

### Loader State Schema

**File**: `/data/tools/loader-state.json`

```json
{
  "startedAt": "2026-02-04T11:00:00Z",
  "completedAt": "2026-02-04T11:15:00Z",
  "tools": {
    "rust": {
      "name": "rust",
      "status": "installed",
      "version": "1.75.0",
      "installedAt": "2026-02-04T11:02:00Z"
    },
    "ck-search": {
      "name": "ck-search",
      "status": "installed",
      "installedAt": "2026-02-04T11:07:00Z"
    },
    "beads_rust": {
      "name": "beads_rust",
      "status": "installed",
      "installedAt": "2026-02-04T11:10:00Z"
    },
    "sentence-transformers": {
      "name": "sentence-transformers",
      "status": "failed",
      "error": "pip install failed: out of memory"
    }
  }
}
```

---

## API Changes

### Extended Health Endpoint

**Endpoint**: `GET /health?full=true`

**Response**:

```json
{
  "status": "healthy",
  "gateway": "running",
  "uptime": 3600,
  "tools": {
    "loading": false,
    "complete": true,
    "status": {
      "rust": "installed",
      "ck-search": "installed",
      "beads_rust": "installed",
      "sentence-transformers": "installed"
    }
  },
  "capabilities": {
    "semanticSearch": true,
    "taskGraph": true,
    "memoryStack": true
  }
}
```

---

## Configuration

### Environment Variables

| Variable             | Type    | Default       | Description                     |
| -------------------- | ------- | ------------- | ------------------------------- |
| `LOA_TOOL_DIR`       | string  | `/data/tools` | Tool installation directory     |
| `LOA_DEFERRED_TOOLS` | boolean | `true`        | Enable/disable deferred loading |
| `LOA_TOOL_TIMEOUT`   | number  | `1800`        | Max seconds per tool install    |

---

## Testing Strategy

### Unit Tests

**File**: `deploy/loa-identity/tool-loader/__tests__/tool-loader.test.ts`

```typescript
describe("ToolLoader", () => {
  it("detects already installed tools", async () => {
    // Mock existsSync and runCommand
  });

  it("respects dependency order", async () => {
    // Verify rust installs before ck-search
  });

  it("handles installation failures gracefully", async () => {
    // Mock failed install, verify state
  });

  it("persists state across restarts", async () => {
    // Create state, reload, verify
  });
});
```

### E2E Tests

1. **Core image boot test**: Build and start core image, verify health in <30s
2. **Tool loading test**: Start container, wait, verify all tools installed
3. **Persistence test**: Stop container, restart, verify tools still available
4. **Degraded mode test**: Start without R2 volume, verify graceful degradation

---

## Security Considerations

- **Tool source verification**: Only install from trusted sources (crates.io, PyPI)
- **No secrets in tool loader**: Credentials handled separately
- **Sandboxed installation**: Tools install in isolated directories
- **Audit logging**: All installs logged to audit trail

---

## Rollback Plan

If issues arise:

1. Set `LOA_DEFERRED_TOOLS=false` to disable tool loading
2. Use existing full Dockerfile as fallback
3. Pre-built tools can be baked into image if needed

---

## Implementation Checklist

### Sprint 1: Core Image

- [ ] Create `deploy/Dockerfile.core`
- [ ] Remove tool installation from main Dockerfile
- [ ] Verify core image builds and runs
- [ ] Add CI/CD workflow for core image

### Sprint 2: Tool Loader

- [ ] Create `deploy/loa-identity/tool-loader/tool-loader.ts`
- [ ] Create `deploy/loa-identity/health/extended-health.ts`
- [ ] Update `start-loa.sh` to launch tool loader
- [ ] Add unit tests

### Sprint 3: Integration

- [ ] E2E tests for full flow
- [ ] Update documentation
- [ ] Update CI/CD to use new pattern
- [ ] Deprecation notice for old approach

---

_Generated by Loa Simstim Workflow_
