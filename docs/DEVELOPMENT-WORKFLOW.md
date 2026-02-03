# Loa Beauvoir Development Workflow

> Rapid development using the three-tier deployment architecture

## Overview

This setup enables **<5 second iteration cycles** during development while maintaining production-grade deployments.

```
┌─────────────────────────────────────────────────────────────────┐
│                    THREE-TIER ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   TIER 1     │    │   TIER 2     │    │   TIER 3     │       │
│  │ Local Docker │───▶│ GitHub CI/CD │───▶│  Cloudflare  │       │
│  │  Hot-Reload  │    │  Auto-Deploy │    │   Workers    │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│       <5s               Background         Production            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

| Tier | Environment | Cycle Time | Purpose |
|------|-------------|------------|---------|
| **1** | Local Docker | <5 seconds | Edit → Test → Iterate |
| **2** | GitHub Actions | Background | Auto-deploy on push |
| **3** | Cloudflare Workers | Production | Live deployment |

## Quick Start

```bash
# 1. Configure credentials (one-time)
cp .env.local.example .env.local
# Edit .env.local with ANTHROPIC_API_KEY

# 2. Start local development
make dev

# 3. Edit code - changes auto-reload
vim deploy/loa-identity/scheduler/scheduler.ts

# 4. When ready, push to deploy
git add . && git commit -m "feat: my changes"
git push origin main
# CI/CD handles Tier 2 & 3 automatically
```

---

## Tier 1: Local Development (Hot-Reload)

### Starting the Dev Environment

```bash
make dev           # Start with hot-reload
make dev-build     # Rebuild image and start (use after Dockerfile changes)
make dev-logs      # Follow container logs
make dev-shell     # Shell into running container
make dev-down      # Stop environment
make dev-clean     # Stop and remove all state
```

### How Hot-Reload Works

```
┌────────────────────────────────────────────────────┐
│                 HOT-RELOAD FLOW                     │
├────────────────────────────────────────────────────┤
│                                                     │
│  1. You edit: deploy/loa-identity/**/*.ts          │
│                     │                               │
│                     ▼                               │
│  2. entr detects file change                       │
│                     │                               │
│                     ▼                               │
│  3. Gateway process receives SIGTERM               │
│                     │                               │
│                     ▼                               │
│  4. New gateway starts with updated code           │
│                     │                               │
│                     ▼                               │
│  5. Ready to test (~3-5 seconds total)             │
│                                                     │
└────────────────────────────────────────────────────┘
```

### Volume Mounts

| Host Path | Container Path | Mode | Purpose |
|-----------|----------------|------|---------|
| `./.claude` | `/workspace/.claude` | `ro` | System Zone (framework) |
| `./grimoires` | `/workspace/grimoires` | `rw` | State Zone (your data) |
| `./deploy/loa-identity` | `/workspace/deploy/loa-identity` | `rw` | **Hot-reload target** |
| `loa-data` volume | `/data` | `rw` | Persistent state (WAL, beads) |

### What You Can Edit (Hot-Reload)

| Location | Hot-Reload? | Notes |
|----------|-------------|-------|
| `deploy/loa-identity/**/*.ts` | ✅ Yes | Changes apply in <5s |
| `grimoires/**` | ✅ Yes | Grimoire changes persist |
| `.claude/scripts/**` | ⚠️ Partial | May need container restart |
| `deploy/Dockerfile` | ❌ No | Run `make dev-build` |
| `docker-compose.dev.yml` | ❌ No | Run `make dev-down && make dev` |

### Testing Changes

```bash
# Health check
curl http://localhost:18789/health

# Gateway status
curl http://localhost:18789/sandbox-health

# View logs in real-time
make dev-logs

# Debug inside container
make dev-shell
```

---

## Tier 2: GitHub Actions CI/CD

### Automatic Triggers

The workflow triggers on push to `main` when these paths change:

```yaml
paths:
  - 'deploy/**'
  - '.claude/**'
  - 'grimoires/**'
```

### Workflow Steps

```
Push to main
     │
     ▼
┌─────────────────┐
│ 1. Checkout     │
│ 2. Setup Node   │
│ 3. Install      │
│    wrangler     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 4. wrangler     │  ◄── Builds container image
│    deploy       │      Pushes to CF registry
└────────┬────────┘      Deploys Worker
         │
         ▼
┌─────────────────┐
│ 5. Smoke test   │  ◄── 6 retries with backoff
│    /health      │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
 SUCCESS   FAILURE
    │         │
    ▼         ▼
  Done    Rollback
```

### Required Secrets

Configure in GitHub → Settings → Secrets:

| Secret | Value | How to Get |
|--------|-------|------------|
| `CLOUDFLARE_API_TOKEN` | API token | Cloudflare Dashboard → API Tokens |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID | Cloudflare Dashboard → Overview |
| `CF_SUBDOMAIN` | Your subdomain | Usually your account name |

### Manual Deploy (Escape Hatch)

```bash
# If CI/CD is broken, deploy manually:
make deploy-cf

# Or directly:
cd deploy/cloudflare
wrangler deploy
```

---

## Tier 3: Cloudflare Workers Production

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   CLOUDFLARE WORKERS                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐    │
│  │   Worker    │────▶│   Durable   │────▶│  Container  │    │
│  │  (Edge)     │     │   Object    │     │  (Sandbox)  │    │
│  └─────────────┘     └─────────────┘     └─────────────┘    │
│        │                    │                    │           │
│        │                    │                    │           │
│        ▼                    ▼                    ▼           │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐    │
│  │   Assets    │     │   SQLite    │     │     R2      │    │
│  │   (UI)      │     │   (State)   │     │  (Storage)  │    │
│  └─────────────┘     └─────────────┘     └─────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `https://loa-beauvoir.{subdomain}.workers.dev` | Main entry (CF Access protected) |
| `/sandbox-health` | Container health check |
| `/health` | Worker health check |

### Monitoring

```bash
# List deployments
wrangler deployments list

# View logs (tail)
wrangler tail

# Check container status
wrangler containers list
```

### Rollback

```bash
# Rollback to previous version
wrangler rollback

# Rollback to specific version
wrangler rollback --version <version-id>
```

---

## Best Practices

### 1. Development Flow

```
┌─────────────────────────────────────────────────────────────┐
│                 RECOMMENDED WORKFLOW                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Start fresh session                                      │
│     └─▶ make dev                                             │
│                                                              │
│  2. Make changes in deploy/loa-identity/                     │
│     └─▶ Watch logs: make dev-logs                            │
│                                                              │
│  3. Test locally                                             │
│     └─▶ curl localhost:18789/health                          │
│                                                              │
│  4. Commit with clear message                                │
│     └─▶ git commit -m "feat(scheduler): add timeout"         │
│                                                              │
│  5. Push to deploy                                           │
│     └─▶ git push origin main                                 │
│                                                              │
│  6. Monitor CI/CD                                            │
│     └─▶ gh run watch                                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 2. Commit Message Convention

```
<type>(<scope>): <description>

Types:
  feat     - New feature
  fix      - Bug fix
  refactor - Code change (no feature/fix)
  docs     - Documentation
  chore    - Maintenance

Examples:
  feat(scheduler): add timeout enforcement
  fix(recovery): handle R2 connection failure
  refactor(memory): simplify consolidation logic
```

### 3. When to Use Each Tier

| Scenario | Use Tier |
|----------|----------|
| Rapid iteration, testing ideas | **Tier 1** (local) |
| Code review changes | **Tier 1** (local) |
| Deploying tested changes | **Tier 2** (push to main) |
| Emergency hotfix | **Tier 3** (manual deploy) |
| Rollback production | **Tier 3** (wrangler rollback) |

### 4. Avoid These Mistakes

| Mistake | Why It's Bad | Do This Instead |
|---------|--------------|-----------------|
| Editing `.claude/` directly | Framework files, may be overwritten | Use `/update-loa` |
| Pushing untested code | CI/CD will deploy it | Test locally first |
| Hardcoding secrets | Security risk | Use `.env.local` or secrets |
| Ignoring CI failures | Production may be broken | Fix immediately or rollback |
| Long-running dev container | State drift | Restart daily: `make dev-clean && make dev` |

### 5. Security Checklist

- [ ] Never commit `.env.local`
- [ ] Never log API keys or tokens
- [ ] Use step-level secrets in GitHub Actions
- [ ] Review code before pushing to main
- [ ] Check CI/CD status after push

---

## Troubleshooting

### Local Development Issues

**Container won't start**
```bash
# Check if ports are in use
lsof -i :18789 :3000

# Check Docker logs
docker logs $(docker ps -q --filter name=loa-dev)

# Rebuild from scratch
make dev-clean && make dev-build
```

**Hot-reload not working**
```bash
# Check entr is running
make dev-shell
pgrep entr

# Manually trigger restart
touch deploy/loa-identity/index.ts
```

**Out of memory**
```bash
# Check container resources
docker stats

# Increase Docker memory limit in Docker Desktop settings
```

### CI/CD Issues

**Build failing**
```bash
# Check workflow logs
gh run view --log-failed

# Test locally first
docker build -f deploy/Dockerfile deploy/
```

**Deploy failing with "Unauthorized"**
```bash
# Verify secrets are set
gh secret list

# Re-create API token with correct scopes:
# - Workers Scripts: Edit
# - Workers Containers: Edit
# - R2 Storage: Edit
```

### Production Issues

**Container not starting**
```bash
# Check container logs
wrangler tail

# List container status
wrangler containers list

# Check for resource limits
wrangler containers describe loa-beauvoir-sandbox
```

**Rollback needed**
```bash
# View deployment history
wrangler deployments list

# Rollback
wrangler rollback
```

---

## Quick Reference

### Make Commands

| Command | Description |
|---------|-------------|
| `make dev` | Start hot-reload environment |
| `make dev-build` | Rebuild and start |
| `make dev-shell` | Shell into container |
| `make dev-logs` | Follow logs |
| `make dev-down` | Stop environment |
| `make dev-clean` | Stop and remove all state |
| `make deploy-cf` | Manual Cloudflare deploy |

### Wrangler Commands

| Command | Description |
|---------|-------------|
| `wrangler deploy` | Deploy to Cloudflare |
| `wrangler tail` | Stream logs |
| `wrangler rollback` | Rollback deployment |
| `wrangler containers list` | List containers |
| `wrangler deployments list` | List deployments |
| `wrangler secret put <NAME>` | Add secret |

### Git Workflow

```bash
# Feature development
git checkout -b feature/my-feature
# ... make changes ...
git add -p  # Interactive staging
git commit -m "feat: description"
git push origin feature/my-feature
# Create PR, merge to main

# Hotfix
git checkout main
git pull
# ... make fix ...
git commit -m "fix: description"
git push origin main
# CI/CD auto-deploys
```

---

## Related Documentation

- [Deploy README](../deploy/README.md) - Layer architecture details
- [PRD](../grimoires/loa/features/rapid-docker-dev/prd.md) - Product requirements
- [SDD](../grimoires/loa/features/rapid-docker-dev/sdd.md) - Technical design
- [Sprint Plan](../grimoires/loa/features/rapid-docker-dev/sprint.md) - Implementation details
