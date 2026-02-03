# SDD: Rapid Docker Development Workflow for Cloudflare Moltworker

---
version: "1.0.0"
status: Draft
date: 2026-02-03
author: simstim-agent
prd_reference: grimoires/loa/features/rapid-docker-dev/prd.md
---

## System Architecture

### Overview

The Rapid Docker Development Workflow implements a three-tier architecture separating local development iteration from CI/CD deployment and production runtime. The design leverages Docker volume mounts for sub-minute feedback during development, while GitHub Actions handles background deployment to Cloudflare Workers.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Development Workstation                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────┐     ┌─────────────────────────────────────────┐   │
│  │   Source Code   │────▶│      docker-compose.dev.yml             │   │
│  │                 │     │  ┌─────────────────────────────────┐    │   │
│  │ .claude/        │────▶│  │       loa-dev container        │    │   │
│  │ grimoires/      │────▶│  │                                 │    │   │
│  │ deploy/         │────▶│  │  Volume Mounts (bind)           │    │   │
│  │   loa-identity/ │     │  │  ├── .claude/:ro                │    │   │
│  │                 │     │  │  ├── grimoires/:rw              │    │   │
│  └─────────────────┘     │  │  └── deploy/loa-identity/:rw    │    │   │
│                          │  │                                 │    │   │
│                          │  │  start-loa-dev.sh               │    │   │
│                          │  │  └── entr → tsx watch           │    │   │
│                          │  │  └── gateway (verbose)          │    │   │
│                          │  └─────────────────────────────────┘    │   │
│                          │                                         │   │
│                          │  Ports: 18789 (gateway), 3000 (health) │   │
│                          └─────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ git push origin main
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           GitHub Actions                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  cloudflare-deploy.yml                                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐        │
│  │  build-image    │─▶│ deploy-cloudflare│─▶│   smoke-test    │        │
│  │  (docker-release│  │ (wrangler deploy)│  │ (health check)  │        │
│  │   dependency)   │  │                 │  │                 │        │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘        │
│                                                                         │
│  Secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID                   │
│           (masked, never echoed)                                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ wrangler deploy
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Cloudflare Workers                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  loa-beauvoir Worker (Moltworker)                                       │
│  ├── R2 Bucket (state persistence)                                      │
│  ├── KV Namespace (caching)                                             │
│  └── Container Runtime (sandbox:0.7.0 + clawdbot)                       │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Architecture Pattern

**Layered Development Pipeline** - Separates concerns into three tiers with different iteration speeds:

| Tier | Purpose | Iteration Speed | Rebuild Frequency |
|------|---------|-----------------|-------------------|
| Local | Hot-reload development | <5 seconds | Never (volume mount) |
| CI/CD | Automated deployment | ~10 minutes | Per push to main |
| Production | Cloudflare Workers | N/A | On CI/CD completion |

### Key Decisions

#### ADR-001: Volume Mounts for Hot-Reload
**Status:** Accepted

**Context:** Developers need fast feedback on TypeScript changes without rebuilding Docker images. The existing monolithic Dockerfile takes 15-20 minutes to build.

**Decision:** Use Docker volume mounts to bind-mount source directories into the development container. File changes on the host immediately appear in the container.

**Consequences:**
- Pro: Near-instant feedback on code changes
- Pro: No image rebuild required for source changes
- Con: macOS volume mount performance requires VirtioFS
- Con: Volume permissions must match container user

#### ADR-002: File Watcher for Automatic Restart
**Status:** Accepted

**Context:** Even with volume mounts, the gateway process must restart to pick up TypeScript changes.

**Decision:** Use `entr` (or Node-based watcher as fallback) to monitor `.ts` files and restart the gateway on changes. The restart uses `tsx` for fast TypeScript execution without compilation.

**Consequences:**
- Pro: Automatic restart on save, no manual intervention
- Pro: `tsx` is faster than `ts-node` or full compilation
- Con: Requires installing additional tools in dev image
- Con: Restart takes 2-5 seconds (not instant)

#### ADR-003: Separate Dev Image Inheriting from Production
**Status:** Accepted

**Context:** Need development tooling (entr, tsx) without bloating production image.

**Decision:** Create `Dockerfile.dev` that inherits from the production GHCR image and adds only development tools. Dev image adds <100MB over base.

**Consequences:**
- Pro: Dev environment matches production runtime
- Pro: No need to rebuild heavy Rust/Python layers
- Con: Requires GHCR image to be pre-built
- Con: May need multi-arch support (amd64/arm64)

#### ADR-004: GitHub Actions for CI/CD
**Status:** Accepted

**Context:** Need automated deployment on push to main without manual wrangler commands.

**Decision:** Create new `cloudflare-deploy.yml` workflow that runs `wrangler deploy`. Note: wrangler builds the container image from `deploy/Dockerfile` during deployment - it does NOT pull pre-built images from GHCR.

**Consequences:**
- Pro: Automated deployment, no manual steps
- Pro: Cloudflare handles container building and caching
- Con: Adds deployment time (~10-15 min) to push-to-main cycle
- Con: Requires managing Cloudflare secrets in GitHub
- Con: Container build happens in Cloudflare, not in our CI (less control over caching)

**Important:** The `docker-release.yml` workflow builds images for *local development* (Dockerfile.dev base) and *direct container usage*, NOT for Cloudflare Workers deployment. Cloudflare Workers Containers builds from Dockerfile during `wrangler deploy`.

#### ADR-005: Concurrency Control for Deployments
**Status:** Accepted

**Context:** Rapid successive pushes to main could cause concurrent wrangler deployments that conflict or waste resources.

**Decision:** Use GitHub Actions concurrency groups to cancel in-flight deployments when a new push arrives. Only the latest commit deploys.

**Consequences:**
- Pro: Prevents wasted CI/CD resources
- Pro: Ensures latest code always wins
- Con: Intermediate commits never deploy to production

## Component Design

### C1: docker-compose.dev.yml

**Purpose:** Define the development container configuration with volume mounts and environment variables.

**Responsibilities:**
- Mount source directories for hot-reload
- Configure memory limits matching production (4GB)
- Expose gateway and health ports
- Set development-mode environment variables
- Reference lightweight dev image

**Interfaces:**
- CLI: `docker compose -f docker-compose.dev.yml up`
- CLI: `docker compose -f docker-compose.dev.yml exec loa-dev bash`

**Technology:** Docker Compose v2

**File Structure:**
```yaml
services:
  loa-dev:
    build:
      context: .
      dockerfile: deploy/Dockerfile.dev
    image: loa-dev:local
    env_file:
      - .env.local  # Contains ANTHROPIC_API_KEY, CLAWDBOT_GATEWAY_TOKEN, etc.
    volumes:
      - ./.claude:/workspace/.claude:ro
      - ./grimoires:/workspace/grimoires:rw
      - ./deploy/loa-identity:/workspace/deploy/loa-identity:rw
      - loa-data:/data  # Persist WAL, beads between restarts
    environment:
      BEAUVOIR_DEV_MODE: "1"
      CLAUDE_CONFIG_DIR: /workspace/.claude
      NODE_OPTIONS: "--max-old-space-size=4096"
    ports:
      - "18789:18789"
      - "3000:3000"
    deploy:
      resources:
        limits:
          memory: 4G
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:18789/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s
    command: ["/usr/local/bin/start-loa-dev.sh"]

volumes:
  loa-data:
    name: loa-dev-data-v1  # Update version when breaking changes occur
```

**Required `.env.local` file (gitignored):**
```bash
# Required for AI operations
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Gateway authentication
CLAWDBOT_GATEWAY_TOKEN=

# Optional: R2 state sync (only needed if testing R2 persistence)
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```

### C2: Dockerfile.dev

**Purpose:** Lightweight development image extending production with dev tools.

**Responsibilities:**
- Inherit from production GHCR image
- Add file watcher (`entr`)
- Add TypeScript runner (`tsx`)
- Configure non-root user (optional, for volume permissions)

**Interfaces:**
- Build: `docker build -f deploy/Dockerfile.dev -t loa-dev:local .` (from repo root)

**Dependencies:**
- Base: `ghcr.io/0xhoneyjar/loa-beauvoir:main` (pre-built production image)
- Fallback: Build from `deploy/Dockerfile` locally if GHCR unavailable

**Technology:** Docker

**Build Context:** Repository root (`.`), NOT `deploy/` directory. This allows copying files from multiple directories.

**File Structure:**
```dockerfile
# Lightweight dev image - inherits heavy Rust/Python from production
# Build context: repo root (not deploy/)
ARG BASE_IMAGE=ghcr.io/0xhoneyjar/loa-beauvoir:main
FROM ${BASE_IMAGE}

# Install development tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    entr \
    inotify-tools \
    curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install tsx globally for fast TypeScript execution
RUN npm install -g tsx

# Copy dev startup script (path relative to repo root context)
COPY deploy/start-loa-dev.sh /usr/local/bin/start-loa-dev.sh
RUN chmod +x /usr/local/bin/start-loa-dev.sh

WORKDIR /workspace

# Health check for container orchestration
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -sf http://localhost:18789/health || exit 1

# Override entrypoint for dev mode
ENTRYPOINT ["/usr/local/bin/start-loa-dev.sh"]
```

**Fallback Build (if GHCR unavailable):**
```bash
# Build production base image locally first
docker build -f deploy/Dockerfile -t loa-base:local deploy/
# Then build dev image on top
docker build -f deploy/Dockerfile.dev --build-arg BASE_IMAGE=loa-base:local -t loa-dev:local .
```

### C3: start-loa-dev.sh

**Purpose:** Development startup script with file watching and automatic restart.

**Responsibilities:**
- Skip recovery engine (BEAUVOIR_DEV_MODE=1)
- Start file watcher for `.ts` changes
- Restart gateway on file change
- Run gateway in verbose mode
- Log restart events with timestamps

**Interfaces:**
- Called by: `docker-compose.dev.yml` command
- Watches: `deploy/loa-identity/**/*.ts`
- Restarts: `clawdbot gateway`

**Technology:** Bash + entr

**File Structure:**
```bash
#!/bin/bash
# =============================================================================
# Development Startup Script - Hot-Reload with File Watching
# =============================================================================
# Uses entr -r pattern: single process that restarts on file changes.
# No race conditions between watcher and gateway processes.
# =============================================================================

# Don't use set -e with entr (it exits on file changes by design)
# set -e

echo "[loa-dev] Starting development mode..."
echo "[loa-dev] BEAUVOIR_DEV_MODE=${BEAUVOIR_DEV_MODE:-not set}"

# Skip recovery engine in dev mode
if [ "${BEAUVOIR_DEV_MODE:-0}" = "1" ]; then
    echo "[loa-dev] Skipping recovery engine (dev mode)"
fi

# Verify entr is installed
if ! command -v entr &>/dev/null; then
    echo "[loa-dev] WARNING: entr not installed, running without hot-reload"
    echo "[loa-dev] Changes require manual container restart"
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind lan
fi

# Create workspace directories if needed
mkdir -p /workspace/deploy/loa-identity

echo "[loa-dev] Watching for .ts changes in deploy/loa-identity/..."
echo "[loa-dev] Press Ctrl+C to stop"

# Single process pattern: entr -r restarts the command on file changes
# -d: track directories for new files
# -r: reload mode (restart command on change, send SIGTERM first)
# The exec ensures the container stays alive with the gateway process
while true; do
    find /workspace/deploy/loa-identity -name "*.ts" 2>/dev/null | \
        entr -d -r sh -c '
            echo "[loa-dev] $(date -Iseconds) File change detected, restarting gateway..."
            clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind lan
        '

    # entr exits when a new file is added (-d flag), loop to pick up new files
    echo "[loa-dev] Rescanning for new files..."
    sleep 1
done
```

**Key Design Decisions:**
1. **Single process pattern** - `entr -r` manages both watching and restarting; no competing processes
2. **No `set -e`** - `entr` exits normally on file changes, which would terminate the script
3. **Fallback mode** - If `entr` is missing, runs gateway directly without hot-reload
4. **Loop for new files** - `entr -d` exits when new files are created; outer loop rescans

### C4: Makefile

**Purpose:** Developer-friendly commands for common operations.

**Responsibilities:**
- `make dev` - Start local development environment
- `make dev-shell` - Shell into container
- `make dev-logs` - Follow container logs
- `make dev-down` - Stop development environment
- `make dev-clean` - Remove persistent state
- `make deploy-cf` - Manual Cloudflare deploy

**Interfaces:**
- CLI: `make <target>`

**Technology:** GNU Make

**File Structure:**
```makefile
.PHONY: dev dev-build dev-shell dev-logs dev-down dev-clean deploy-cf help

# Default target
help:
	@echo "Loa Development Commands:"
	@echo "  make dev        - Start local dev environment (uses cached image)"
	@echo "  make dev-build  - Rebuild dev image and start"
	@echo "  make dev-shell  - Shell into running container"
	@echo "  make dev-logs   - Follow container logs"
	@echo "  make dev-down   - Stop development environment"
	@echo "  make dev-clean  - Stop and remove all state (WAL, beads, etc.)"
	@echo "  make deploy-cf  - Manual Cloudflare deploy (escape hatch)"

# Development environment (uses cached image if available)
dev:
	@test -f .env.local || (echo "ERROR: .env.local not found. Copy from .env.local.example" && exit 1)
	docker compose -f docker-compose.dev.yml up

# Rebuild image before starting (use when Dockerfile.dev changes)
dev-build:
	@test -f .env.local || (echo "ERROR: .env.local not found. Copy from .env.local.example" && exit 1)
	docker compose -f docker-compose.dev.yml up --build

dev-shell:
	docker compose -f docker-compose.dev.yml exec loa-dev bash

dev-logs:
	docker compose -f docker-compose.dev.yml logs -f

dev-down:
	docker compose -f docker-compose.dev.yml down

# Full cleanup: remove containers, volumes, and local state
dev-clean:
	docker compose -f docker-compose.dev.yml down -v --remove-orphans
	@echo "Note: Volume 'loa-dev-data-v1' removed. Local .beads/.ckindex are inside the volume."

# Manual Cloudflare deployment (escape hatch when CI/CD is broken)
deploy-cf:
	cd deploy/cloudflare && npm run deploy
```

**Usage Notes:**
- `make dev` checks for `.env.local` before starting
- `make dev-build` is separate from `make dev` to avoid unnecessary rebuilds
- `dev-clean` removes the named volume; state files are inside the volume, not host filesystem

### C5: cloudflare-deploy.yml

**Purpose:** GitHub Actions workflow for automated deployment to Cloudflare Workers.

**Responsibilities:**
- Trigger on push to main (filtered by paths)
- Wait for docker-release.yml to complete
- Execute wrangler deploy with secrets
- Run smoke test against deployed endpoint
- Use concurrency group to cancel stale deployments

**Interfaces:**
- Trigger: Push to main branch
- Secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
- Output: Deployment URL, smoke test results

**Dependencies:**
- Workflow: docker-release.yml (image build)
- External: Cloudflare API

**Technology:** GitHub Actions

**File Structure:**
```yaml
name: Cloudflare Deploy

on:
  push:
    branches: [main]
    paths:
      - 'deploy/**'
      - '.claude/**'
      - 'grimoires/**'

concurrency:
  group: cloudflare-deploy
  cancel-in-progress: true

# Note: Secrets are passed at step level, not workflow level, for security

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: Install wrangler
        run: npm install -g wrangler

      - name: Deploy to Cloudflare Workers
        working-directory: deploy/cloudflare
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          echo "::group::Wrangler Deploy"
          wrangler deploy
          echo "::endgroup::"

      - name: Smoke test with retry
        env:
          WORKER_URL: https://loa-beauvoir.${{ secrets.CF_SUBDOMAIN }}.workers.dev
        run: |
          echo "Testing endpoint: $WORKER_URL/sandbox-health"
          for i in 1 2 3 4 5 6; do
            echo "Attempt $i/6..."
            if curl -sf "$WORKER_URL/sandbox-health"; then
              echo "Health check passed!"
              exit 0
            fi
            echo "Waiting $((i * 10)) seconds before retry..."
            sleep $((i * 10))
          done
          echo "Health check failed after 6 attempts"
          exit 1

      - name: Rollback on failure
        if: failure()
        working-directory: deploy/cloudflare
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          echo "Deployment failed, initiating rollback..."
          wrangler rollback --message "Automated rollback due to smoke test failure" || echo "Rollback not available"
```

**Required GitHub Secrets:**
| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | API token with Workers + R2 scope |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account identifier |
| `CF_SUBDOMAIN` | Workers subdomain (e.g., `your-account`) |

**Note:** The `wait-for-image` job was removed. Cloudflare Workers Containers builds the image from `deploy/Dockerfile` during `wrangler deploy`, so we don't need to wait for GHCR image builds.

## Security Architecture

### Credential Handling

#### Local Development

| Credential | Source | Storage | Notes |
|------------|--------|---------|-------|
| ANTHROPIC_API_KEY | User | `.env.local` (gitignored) | Required for AI operations |
| R2_ACCESS_KEY_ID | User | `.env.local` (gitignored) | Optional, for R2 state sync |
| R2_SECRET_ACCESS_KEY | User | `.env.local` (gitignored) | Optional, for R2 state sync |
| CLAWDBOT_GATEWAY_TOKEN | User | `.env.local` (gitignored) | Optional, for gateway auth |

**Security Controls:**
- `.env.local` added to `.gitignore` (already present)
- `.env.example` documents required variables without values
- No credentials in shell history (docker compose reads from file)

#### CI/CD

| Secret | Scope | Usage |
|--------|-------|-------|
| CLOUDFLARE_API_TOKEN | Cloudflare Workers + R2 | wrangler deploy |
| CLOUDFLARE_ACCOUNT_ID | Account identifier | wrangler configuration |
| GITHUB_TOKEN | Repository | Wait for workflow completion |

**Security Controls:**
- All secrets via `${{ secrets.* }}` syntax (auto-masked)
- Never echoed or interpolated in shell strings
- Minimum scope tokens (Workers + R2 only, not full account)
- Rotation procedure documented in deploy/README.md

### Encryption

| Layer | At Rest | In Transit |
|-------|---------|------------|
| Local Dev | None (volume mounts) | N/A (localhost) |
| GitHub Actions | GitHub encryption | TLS |
| Cloudflare Workers | Cloudflare encryption | TLS |
| R2 Storage | AES-256 (Cloudflare) | TLS |

## Deployment Architecture

### Target Environment

Three deployment targets with different purposes:

1. **Local Development** - Developer workstation with Docker
2. **GitHub Actions** - CI/CD pipeline runner
3. **Cloudflare Workers** - Production runtime

### Infrastructure Components

| Component | Provider | Configuration |
|-----------|----------|---------------|
| Container Runtime | Docker Desktop | VirtioFS enabled, 8GB+ RAM |
| CI/CD | GitHub Actions | ubuntu-latest runner |
| Edge Runtime | Cloudflare Workers | Paid plan for container support |
| Object Storage | Cloudflare R2 | State persistence bucket |

### CI/CD Pipeline

```
Push to main → Path filter → Wait for image → Deploy → Smoke test
                   │              │              │          │
                   ▼              ▼              ▼          ▼
           deploy/**        docker-release   wrangler    curl health
           .claude/**       workflow done     deploy      endpoint
           grimoires/**
```

**Stages:**
1. **Filter** - Only trigger if relevant paths changed
2. **Wait** - Wait for docker-release.yml to complete image build
3. **Deploy** - Run wrangler deploy with Cloudflare credentials
4. **Verify** - Smoke test the deployed endpoint

## Technical Constraints

| Constraint | Rationale | Impact |
|------------|-----------|--------|
| Docker Desktop 4.25+ | VirtioFS required for macOS volume performance | Linux developers unaffected |
| 4GB memory limit | Match production Moltworker constraints | Prevents local-only memory bugs |
| Node 22 | Required by clawdbot runtime | Match production runtime |
| tsx global install | Fast TypeScript execution for dev | ~50MB additional size |
| entr for file watching | Lightweight, efficient file watcher | ~1MB additional size |

## Sources

- **Context File:** `grimoires/loa/context/rapid-docker-dev-workflow.md`
- **Existing Dockerfile:** `deploy/Dockerfile:1-157`
- **Existing Start Script:** `deploy/start-loa.sh:1-283`
- **Docker Release Workflow:** `.github/workflows/docker-release.yml:1-144`
- **Docker Compose:** `docker-compose.yml:1-46`
- **PRD:** `grimoires/loa/features/rapid-docker-dev/prd.md`
