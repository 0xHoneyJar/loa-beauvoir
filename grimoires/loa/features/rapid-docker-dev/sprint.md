# Sprint Plan: Rapid Docker Development Workflow

---
version: "1.0.0"
status: Draft
date: 2026-02-03
author: simstim-agent
prd_reference: grimoires/loa/features/rapid-docker-dev/prd.md
sdd_reference: grimoires/loa/features/rapid-docker-dev/sdd.md
sprint_id: rapid-docker-dev-s1
---

## Sprint Goal

Implement the three-tier Docker development workflow enabling <5 second local iteration and automated CI/CD deployment to Cloudflare Workers.

## Sprint Duration

Single sprint - estimated 7 tasks across 3 phases.

---

## Tasks

### Task 1: Create .env.local.example Template

**Priority:** P0 (Blocking)
**Estimated Effort:** XS
**Dependencies:** None

**Description:**
Create the `.env.local.example` template file documenting all required and optional environment variables for local development.

**Acceptance Criteria:**
- [ ] `.env.local.example` exists at repo root
- [ ] Documents ANTHROPIC_API_KEY (required)
- [ ] Documents CLAWDBOT_GATEWAY_TOKEN (optional)
- [ ] Documents R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (optional)
- [ ] `.env.local` ADDED to root `.gitignore` (currently missing - only `deploy/.env.local` exists)

**Files to Create/Modify:**
- CREATE: `.env.local.example`
- MODIFY: `.gitignore` - add `.env.local` at root level

**BLOCKING:** Task 4 depends on this for env_file configuration.

---

### Task 2: Create deploy/start-loa-dev.sh

**Priority:** P0 (Blocking)
**Estimated Effort:** S
**Dependencies:** None

**Description:**
Create the development startup script with file watching and automatic restart using the `entr -r` single-process pattern.

**Acceptance Criteria:**
- [ ] Script uses `entr -r` pattern (no race conditions)
- [ ] Fallback to direct gateway start if entr unavailable
- [ ] Watches `deploy/loa-identity/**/*.ts` for changes
- [ ] Logs timestamps on restart events
- [ ] Respects `BEAUVOIR_DEV_MODE=1` to skip recovery

**Files to Create/Modify:**
- CREATE: `deploy/start-loa-dev.sh`

**Implementation Notes:**
```bash
# Key pattern from SDD - single process, no background jobs
find ... | entr -d -r sh -c 'clawdbot gateway ...'
```

---

### Task 3: Create deploy/Dockerfile.dev

**Priority:** P0 (Blocking)
**Estimated Effort:** S
**Dependencies:** Task 2

**Description:**
Create the lightweight development Dockerfile that inherits from the production GHCR image and adds development tools (entr, tsx).

**Acceptance Criteria:**
- [ ] Inherits from `ghcr.io/0xhoneyjar/loa-beauvoir:main`
- [ ] Installs entr, inotify-tools, curl via apt
- [ ] Installs tsx globally via npm
- [ ] Copies start-loa-dev.sh to /usr/local/bin/
- [ ] Includes HEALTHCHECK directive
- [ ] Build context is repo root (`.`)

**Files to Create/Modify:**
- CREATE: `deploy/Dockerfile.dev`

**Verification:**
```bash
docker build -f deploy/Dockerfile.dev -t loa-dev:local .
docker run --rm loa-dev:local entr --help
docker run --rm loa-dev:local tsx --version
```

---

### Task 4: Create docker-compose.dev.yml

**Priority:** P0 (Blocking)
**Estimated Effort:** S
**Dependencies:** Task 1, Task 3

**Description:**
Create the development Docker Compose configuration with volume mounts, env_file, and healthcheck.

**Acceptance Criteria:**
- [ ] Uses `build:` directive pointing to deploy/Dockerfile.dev
- [ ] Loads credentials from `.env.local` via env_file
- [ ] Mounts `.claude/`, `grimoires/`, `deploy/loa-identity/`
- [ ] Uses named volume `loa-dev-data-v1` for persistence
- [ ] Configures 4GB memory limit
- [ ] Exposes ports 18789 and 3000
- [ ] Includes healthcheck configuration

**Files to Create/Modify:**
- CREATE: `docker-compose.dev.yml`

**Verification:**
```bash
make dev  # Should start container and pass healthcheck
make dev-shell  # Should open bash in container
```

---

### Task 5: Create Root Makefile

**Priority:** P0 (Blocking)
**Estimated Effort:** XS
**Dependencies:** Task 4

**Description:**
Create the developer-friendly Makefile at project root with standard commands.

**Acceptance Criteria:**
- [ ] `make help` shows available commands
- [ ] `make dev` starts environment (checks for .env.local)
- [ ] `make dev-build` rebuilds image then starts
- [ ] `make dev-shell` opens bash in container
- [ ] `make dev-logs` follows container logs
- [ ] `make dev-down` stops environment
- [ ] `make dev-clean` removes volumes and state
- [ ] `make deploy-cf` runs manual Cloudflare deploy

**Files to Create/Modify:**
- CREATE: `Makefile` (at repo root)

**Note:** Check for existing Makefile in repo root - may need to merge.

---

### Task 6: Create .github/workflows/cloudflare-deploy.yml

**Priority:** P1 (Important)
**Estimated Effort:** M
**Dependencies:** None (can parallelize)

**Description:**
Create the GitHub Actions workflow for automated Cloudflare deployment with smoke test and rollback.

**Acceptance Criteria:**
- [ ] Triggers on push to main with path filters
- [ ] Uses concurrency group with cancel-in-progress
- [ ] Secrets passed at step level (not workflow level)
- [ ] Runs wrangler deploy
- [ ] Smoke test with exponential backoff retry
- [ ] Rollback step on failure
- [ ] Posts deployment status to GitHub commit (via workflow conclusion)

**Files to Create/Modify:**
- CREATE: `.github/workflows/cloudflare-deploy.yml`

**Required Secrets (document in PR):**
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CF_SUBDOMAIN`

---

## Task Dependencies Graph

```
Task 1 (.env.local + .gitignore)  ──────────────────┐
                                                     │
Task 2 (start-loa-dev.sh)  ───▶ Task 3 (Dockerfile.dev) ───┬───▶ Task 4 (compose) ───▶ Task 5 (Makefile)
                                                     │     │
                                                     └─────┘
Task 6 (CI/CD workflow)  ───────────────────────────────────  (parallel)

Task 7 (Documentation)  ────────────────────────────────────  (after Task 5)
```

**Critical Path:** Tasks 1 + 2 → 3 → 4 → 5 → 7

**Parallel Work:** Task 6 can be done in parallel with critical path.

---

## Definition of Done

### Sprint Complete When:
1. All tasks have acceptance criteria met
2. `make dev` starts a working development environment
3. TypeScript changes in `deploy/loa-identity/` trigger gateway restart within 5 seconds
4. CI/CD workflow file exists (deployment testing requires secrets configuration)
5. Documentation updated (README or deploy/README.md mentions new workflow)

### Verification Commands:
```bash
# Local development verification
cp .env.local.example .env.local
# (fill in ANTHROPIC_API_KEY)
make dev

# In another terminal, edit a file and observe restart
echo "// test" >> deploy/loa-identity/types.ts
# Should see "[loa-dev] File change detected, restarting gateway..."

# Cleanup
make dev-clean
git checkout deploy/loa-identity/types.ts
```

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| GHCR image unavailable | Dockerfile.dev includes fallback build instructions |
| entr not available in base | start-loa-dev.sh has fallback to direct gateway start |
| macOS volume performance | Document VirtioFS requirement in README |
| CI/CD secrets not configured | Workflow validates secrets before deploy step |

---

### Task 7: Update Documentation

**Priority:** P1 (Important)
**Estimated Effort:** XS
**Dependencies:** Task 5

**Description:**
Update documentation to describe the new development workflow.

**Acceptance Criteria:**
- [ ] `deploy/README.md` documents `make dev` quick start
- [ ] Documents required secrets for CI/CD (CLOUDFLARE_API_TOKEN, etc.)
- [ ] Mentions VirtioFS requirement for macOS Docker Desktop
- [ ] Notes difference between `docker-compose.yml` (standalone) and `docker-compose.dev.yml` (hot-reload)

**Files to Create/Modify:**
- MODIFY: `deploy/README.md`

---

## Out of Scope for This Sprint

- Multi-stage Dockerfile refactor (FR-6 in PRD) - create tracking issue after sprint
- Preview deployments for PRs
- Kubernetes deployment configuration
- Monitoring and alerting setup

**Follow-up:** Create GitHub issue for FR-6 (Multi-Stage Dockerfile Refactor) after sprint completion.
