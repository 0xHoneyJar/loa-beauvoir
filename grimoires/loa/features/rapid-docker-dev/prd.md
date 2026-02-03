# PRD: Rapid Docker Development Workflow for Cloudflare Moltworker

---
version: "1.0.0"
status: Draft
date: 2026-02-03
author: simstim-agent
feature_id: rapid-docker-dev
---

## Problem Statement

Long deployment cycles of approximately 15-20 minutes when deploying to Cloudflare Moltworker create significant friction in the development workflow. The bottleneck stems from heavy Docker builds that must compile the Rust toolchain, download sentence-transformers (~3GB), and execute full wrangler deploy cycles. This latency prevents rapid iteration during development, testing, and debugging of the Loa identity layer running on Moltworker infrastructure.

Currently, every code change - even a single-line TypeScript fix in `deploy/loa-identity/` - requires rebuilding the entire container image from scratch, including:
- Rust compilation of `ck-search` and `beads_rust`
- Python dependency installation for Memory Stack
- Full `wrangler deploy` to Cloudflare Workers

This monolithic build process violates the principle of proportional feedback: small changes should yield fast feedback.

## Vision

Developers can iterate on Loa identity code with **<5 second feedback** locally, while production deployments happen automatically in the background via CI/CD. The development workflow separates concerns: local sandbox for rapid iteration, CI/CD for background deployment, and Cloudflare Workers for production runtime.

## Goals

### G-1: Local Hot-Reload Development (P0)
**Description:** Enable rapid local development with volume-mounted source files and automatic restart on changes.

**Success Criteria:**
- TypeScript changes in `deploy/loa-identity/` apply in <5 seconds
- No Docker image rebuild required for source changes
- Local environment matches production resource limits (4GB RAM)
- Developer can shell into container for debugging

### G-2: Automated CI/CD Pipeline (P0)
**Description:** Push-to-main triggers automatic deployment to Cloudflare Workers without manual intervention.

**Success Criteria:**
- Push to `main` branch triggers deployment workflow
- Workflow completes in <10 minutes (down from 15-20)
- Failed deployments do not affect production (rollback-safe)
- Smoke test verifies deployment health

### G-3: Multi-Stage Dockerfile Optimization (P1)
**Description:** Separate heavy compilation stages from fast iteration layers to enable aggressive caching.

**Success Criteria:**
- Rust toolchain cached in base layer (monthly rebuild)
- Python dependencies cached in middle layer (weekly rebuild)
- Runtime layer rebuilds in <2 minutes
- Cache hit rate >80% for typical PR cycles

## Users

### Developer
**Description:** Engineers working on Loa identity layer, scheduler, WAL manager, and gateway integrations.

**Needs:**
- Fast feedback on code changes
- Ability to test against production-like environment
- Easy debugging with shell access
- Reproducible local setup

**Pain Points:**
- 15-20 minute wait for each deployment
- Cannot iterate quickly on scheduler logic
- Difficult to reproduce production issues locally
- CI/CD not automated for Cloudflare deployments

## Functional Requirements

### FR-1: Development Docker Compose (P0)
**Title:** docker-compose.dev.yml for Local Development

**Description:** Create a development-specific Docker Compose configuration that mounts source directories as volumes for hot-reload capability.

**Acceptance Criteria:**
- [ ] Mounts `.claude/`, `grimoires/`, `deploy/loa-identity/` as volumes
- [ ] Uses pre-built base image from GHCR (avoids local Rust/Python builds)
- [ ] Configures 4GB memory limit to match production
- [ ] Exposes ports 3000 (health) and 18789 (gateway)
- [ ] Supports `BEAUVOIR_DEV_MODE=1` environment variable

### FR-2: Lightweight Dev Dockerfile (P0)
**Title:** deploy/Dockerfile.dev for Development Image

**Description:** Create a lightweight development image that inherits from production but adds development tooling.

**Acceptance Criteria:**
- [ ] Inherits from `ghcr.io/0xhoneyjar/loa-beauvoir:main` or production image
- [ ] Adds `entr` for file watching
- [ ] Adds `tsx` for TypeScript execution without compilation
- [ ] Defines volume mount points for source directories
- [ ] Remains <100MB additional size over base

### FR-3: Development Startup Script (P0)
**Title:** deploy/start-loa-dev.sh for Hot-Reload

**Description:** Create a development startup script that watches for file changes and restarts the gateway.

**Acceptance Criteria:**
- [ ] Sets `BEAUVOIR_DEV_MODE=1` to skip recovery engine
- [ ] Uses `entr` or equivalent to watch `.ts` file changes
- [ ] Restarts gateway process on detected changes
- [ ] Runs gateway in verbose mode for debugging
- [ ] Logs restart events with timestamps

### FR-4: Developer Makefile (P0)
**Title:** Root Makefile with Developer Commands

**Description:** Create a Makefile at project root with standard development commands.

**Acceptance Criteria:**
- [ ] `make dev` - Start local development environment
- [ ] `make dev-shell` - Shell into running container
- [ ] `make dev-logs` - Follow container logs
- [ ] `make deploy-cf` - Manual Cloudflare deploy (escape hatch)
- [ ] `make dev-down` - Stop development environment
- [ ] `make dev-clean` - Remove all persistent state (WAL, .beads, .ckindex)

### FR-5: Cloudflare CI/CD Workflow (P0)
**Title:** .github/workflows/cloudflare-deploy.yml

**Description:** GitHub Actions workflow for automatic Cloudflare deployment on push to main.

**Acceptance Criteria:**
- [ ] Triggers on push to `main` branch
- [ ] Filters by paths: `deploy/**`, `.claude/**`, `grimoires/**`
- [ ] Builds and pushes Docker image to GHCR
- [ ] Executes `wrangler deploy` with appropriate secrets
- [ ] Runs smoke test against deployed endpoint
- [ ] Posts status to PR or commit

### FR-6: Multi-Stage Dockerfile Refactor (P1)
**Title:** Refactor deploy/Dockerfile for Layer Caching

**Description:** Refactor the existing Dockerfile into multi-stage build with explicit cache layers.

**Acceptance Criteria:**
- [ ] Stage `rust-builder`: ck-search, beads_rust compilation
- [ ] Stage `python-builder`: sentence-transformers, patchright
- [ ] Stage `runtime`: Node, clawdbot, Loa framework
- [ ] Each stage has explicit cache key
- [ ] Total image size remains <4GB

## Non-Functional Requirements

### NFR-1: Performance
**Category:** Performance
**Title:** Local Development Iteration Speed

**Description:** Local code changes must apply rapidly without full rebuild cycles.

**Target:** <5 seconds from file save to gateway restart

### NFR-2: Reliability
**Category:** Reliability
**Title:** CI/CD Pipeline Stability

**Description:** Automated deployments must be reliable and not introduce regressions.

**Target:** >95% success rate for deployments, automatic rollback on failure

### NFR-4: Security - Credential Handling
**Category:** Security
**Title:** Secure Credential Management

**Description:** All credentials for local development and CI/CD must be handled securely.

**Target:**
- Local: `.env.local` (gitignored) with documented credential rotation
- CI/CD: All secrets via `${{ secrets.* }}` syntax, never echoed
- No credentials in shell history or logs

### NFR-3: Maintainability
**Category:** Maintainability
**Title:** Dockerfile Readability

**Description:** Multi-stage Dockerfile must be well-documented and maintainable.

**Target:** Each stage has clear comments, build arguments documented

## User Stories

### US-1: Hot-Reload Development
**Persona:** Developer
**Story:** As a developer, I want to edit TypeScript files and see changes apply immediately, so that I can iterate quickly on scheduler logic without waiting for Docker rebuilds.

**Acceptance Criteria:**
- Edit `deploy/loa-identity/scheduler.ts`
- See change reflected in <5 seconds
- No manual restart or rebuild required

**Priority:** P0

### US-2: Push-to-Deploy
**Persona:** Developer
**Story:** As a developer, I want to push to main and have my changes automatically deployed to Cloudflare, so that I don't have to manually run deployment commands.

**Acceptance Criteria:**
- Push to `main` branch
- Deployment starts automatically
- Notification when deployment completes
- Health check verifies deployment

**Priority:** P0

### US-3: Local Debugging
**Persona:** Developer
**Story:** As a developer, I want to shell into the development container and inspect state, so that I can debug issues that don't reproduce in unit tests.

**Acceptance Criteria:**
- `make dev-shell` opens interactive shell
- Can inspect `/workspace` filesystem
- Can run ad-hoc commands

**Priority:** P1

## Scope

### In Scope
- docker-compose.dev.yml creation
- deploy/Dockerfile.dev creation
- deploy/start-loa-dev.sh creation
- Root Makefile creation
- .github/workflows/cloudflare-deploy.yml creation
- deploy/Dockerfile multi-stage refactor

### Out of Scope
- Kubernetes deployment configuration
- Multi-region Cloudflare deployment
- Database migrations or schema changes
- Monitoring and alerting setup
- Load testing infrastructure

### Future Considerations
- Remote development container (Codespaces/devcontainer.json)
- Preview deployments for PRs
- Canary deployment strategy
- Performance profiling integration

## Risks

### R-1: Base Image Availability
**Description:** GHCR base image may not exist or may have incompatible versions.
**Impact:** High
**Probability:** Low
**Mitigation:** Document fallback to local build; add GHCR image verification step in CI.

### R-2: Volume Mount Performance
**Description:** Docker volume mounts on macOS may have poor I/O performance.
**Impact:** Medium
**Probability:** Medium
**Mitigation:** Document use of `:cached` or `:delegated` mount flags; provide Linux VM alternative.

### R-3: Secret Management
**Description:** CI/CD requires Cloudflare API tokens stored as GitHub secrets.
**Impact:** High
**Probability:** Low
**Mitigation:** Document required secrets; use environment-specific token scopes.

## Dependencies

### D-1: GHCR Base Image
**Name:** ghcr.io/0xhoneyjar/loa-beauvoir:main
**Type:** Technical
**Description:** Pre-built base image with Rust/Python dependencies.
**Status:** In Progress (docker-release.yml exists)

### D-2: Cloudflare Account
**Name:** Cloudflare Workers + R2
**Type:** External
**Description:** Cloudflare account with Workers and R2 access for deployment target.
**Status:** Resolved

### D-3: GitHub Secrets
**Name:** CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
**Type:** Resource
**Description:** GitHub repository secrets for CI/CD authentication.
**Status:** Pending

## Sources

- **Context File:** `grimoires/loa/context/rapid-docker-dev-workflow.md`
- **Existing Dockerfile:** `deploy/Dockerfile` (lines 1-157)
- **Existing CI/CD:** `.github/workflows/docker-release.yml` (lines 1-144)
- **Docker Compose:** `docker-compose.yml` (lines 1-46)
