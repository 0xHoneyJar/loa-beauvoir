# Loa Cloud Stack - Deploy Layer

This directory contains the Loa-specific deployment configuration that sits on top of the upstream subtrees.

## Architecture

```
deploy/                     # Layer 3: Your code (this directory)
├── Dockerfile              # Extends upstream with Loa identity
├── start-loa.sh            # Replaces moltbot identity entirely
├── versions.json           # Upstream version pins
├── loa-identity/           # Loa-specific overrides
│   ├── infra-lib.sh        # Infrastructure functions (from moltworker)
│   ├── wal-manager.ts      # Write-ahead log implementation
│   └── skills/             # Loa deployment skills
├── cloudflare/             # Cloudflare-specific config
│   └── wrangler.toml       # Workers deployment config
└── tests/                  # Deployment tests
```

## Layer Separation

| Layer | Location | Purpose | Modify? |
|-------|----------|---------|---------|
| L0 | `.claude/` | Loa System Zone | NO - use `/update-loa` |
| L1 | `upstream/devcontainer/` | Runtime (Ubuntu, Node, tools) | NO - use subtree pull |
| L2 | `upstream/moltworker/` | Cloud infra (R2, Workers) | NO - use subtree pull |
| L3 | `deploy/` | Loa identity layer | YES - your code |

## Identity Isolation

The `start-loa.sh` script:
1. Sources infrastructure functions from moltworker (R2 mount, channel tokens)
2. **Never loads AGENTS.md** from moltworker
3. Sets `CLAUDE_CONFIG_DIR=/workspace/.claude` (Loa System Zone)
4. Starts OpenClaw gateway with Loa identity

This ensures **100% Loa identity** with no moltbot hangover.

## Local Development

### Build the Container

```bash
# Build from repo root
docker build -f deploy/Dockerfile -t loa-beauvoir:dev .

# Verify build succeeded
docker images | grep loa-beauvoir
```

### Run Locally (Without Cloudflare)

```bash
# Minimal run (no channels, just gateway)
docker run -it --rm -p 18789:18789 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  loa-beauvoir:dev

# With Telegram channel
docker run -it --rm -p 18789:18789 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN \
  loa-beauvoir:dev

# With all channels
docker run -it --rm -p 18789:18789 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN \
  -e DISCORD_BOT_TOKEN=$DISCORD_BOT_TOKEN \
  -e SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN \
  -e SLACK_APP_TOKEN=$SLACK_APP_TOKEN \
  loa-beauvoir:dev

# With persistent grimoires (mount local directory)
docker run -it --rm -p 18789:18789 \
  -v $(pwd)/grimoires:/workspace/grimoires \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  loa-beauvoir:dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `GATEWAY_TOKEN` | No | Token for gateway auth (or use device pairing) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `SLACK_BOT_TOKEN` | No | Slack bot token |
| `SLACK_APP_TOKEN` | No | Slack app token |
| `AI_GATEWAY_BASE_URL` | No | Custom Anthropic API endpoint (e.g., Cloudflare AI Gateway) |

### Verify Gateway is Running

```bash
# Check gateway is listening
curl -s http://localhost:18789/health

# Check with verbose output
curl -v http://localhost:18789/health
```

### Deploy to Cloudflare (Sprint 4)

```bash
cd deploy/cloudflare
npm run deploy
```

## Upstream Management

### Update Upstreams

```bash
# Fetch latest from both upstreams
git fetch devcontainer main
git fetch moltworker main

# Preview changes
git log HEAD..devcontainer/main --oneline
git log HEAD..moltworker/main --oneline

# Pull with squash (creates single merge commit)
git subtree pull --prefix=upstream/devcontainer devcontainer main --squash
git subtree pull --prefix=upstream/moltworker moltworker main --squash

# Test after pulling
docker build -f deploy/Dockerfile -t loa-beauvoir:test .
docker run --rm loa-beauvoir:test echo "Build successful"

# If tests pass, update versions.json
# If tests fail: git reset --hard HEAD~1
```

### Contribute Upstream

```bash
# Create improvement in upstream directory
# (e.g., fix a bug in upstream/moltworker/src/...)

# Push to upstream repo
git subtree push --prefix=upstream/moltworker moltworker feature/my-improvement

# Create PR on upstream repo
gh pr create --repo cloudflare/moltworker
```

## Version Management

See `versions.json` for pinned upstream commits. Always test after pulling updates.

## Troubleshooting

### Container won't start
- Check `ANTHROPIC_API_KEY` is set
- Verify Docker has enough memory (4GB+ recommended)
- Check logs: `docker logs <container_id>`

### Gateway not responding
- Verify port 18789 is not in use: `lsof -i :18789`
- Check gateway started: look for "[loa] Starting OpenClaw Gateway" in logs

### Identity issues (seeing moltbot instead of Loa)
- Verify `CLAUDE_CONFIG_DIR=/workspace/.claude` in container
- Check `/workspace/.claude/AGENTS.md` exists
- The `start-loa.sh` script should show "Loa identity initialized"
