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

## Commands

```bash
# Build container locally
docker build -f deploy/Dockerfile -t loa-beauvoir:dev .

# Run locally
docker run -it --rm -p 18789:18789 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  loa-beauvoir:dev

# Deploy to Cloudflare
cd deploy/cloudflare && npm run deploy

# Update upstreams
git subtree pull --prefix=upstream/devcontainer devcontainer main --squash
git subtree pull --prefix=upstream/moltworker moltworker main --squash
```

## Version Management

See `versions.json` for pinned upstream commits. Always test after pulling updates.
