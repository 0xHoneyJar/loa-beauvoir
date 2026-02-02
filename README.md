# Loa Beauvoir

> *"Vodou isn't concerned with notions of salvation and transcendence. What it's about is getting things done."*
> — Beauvoir, Count Zero

<p align="center">
  <strong>A self-improving AI deployment where the agent is compartmentalized from the infrastructure</strong>
</p>

---

**Loa Beauvoir** is a cloud deployment pattern for AI assistants that cleanly separates the **agent identity** from the **runtime infrastructure**. Named after [Beauvoir](https://martin-ueding.de/posts/characters-in-count-zero/), the character in William Gibson's *Count Zero* who explains how the [Loa](http://project.cyberpunk.ru/idb/voodoo_in_neuromancer.html)—fragmented AI entities—interface with humanity through practical structures.

This repository demonstrates how to deploy [OpenClaw](https://github.com/openclaw/openclaw) (the messaging gateway) with [Loa](https://github.com/0xHoneyJar/loa) (the AI identity framework) to [Cloudflare Workers](https://developers.cloudflare.com/workers/), using patterns from [moltworker](https://github.com/cloudflare/moltworker) and [claude-code-devcontainer](https://github.com/trailofbits/claude-code-devcontainer).

## The Problem

Running AI assistants in the cloud today means:
- Static identity baked into container images
- No memory across sessions
- No mechanism for self-improvement
- No separation between "what the AI is" and "how it runs"

Every deployment is a **static snapshot** that executes tasks but doesn't evolve.

## The Approach

Loa Beauvoir introduces **layer separation**—the AI agent's identity is architecturally isolated from the infrastructure it runs on:

```
┌─────────────────────────────────────────────────────────────────┐
│                    LAYER ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Layer 3: Loa Identity (YOUR CODE)                      │   │
│  │  Location: deploy/                                       │   │
│  │  • Dockerfile, start-loa.sh                             │   │
│  │  • Skills, memory, compound learning                    │   │
│  │  ✓ EDITABLE - your customizations                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │ imports                              │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Layer 2: Moltworker Infrastructure (UPSTREAM)          │   │
│  │  Location: upstream/moltworker/                          │   │
│  │  • Cloudflare Workers proxy, R2 storage, channels       │   │
│  │  ⚠️ DO NOT MODIFY - pull updates via subtree            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │ imports                              │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Layer 1: Devcontainer Runtime (UPSTREAM)               │   │
│  │  Location: upstream/devcontainer/                        │   │
│  │  • Ubuntu, Node, Claude Code, sandboxing                │   │
│  │  ⚠️ DO NOT MODIFY - pull updates via subtree            │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Layer 0: Loa Framework (MANAGED)                       │   │
│  │  Location: .claude/                                      │   │
│  │  • Agent skills, protocols, compound learning           │   │
│  │  ⚠️ DO NOT MODIFY - use /update-loa for updates         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**The key insight**: Your `deploy/start-loa.sh` imports infrastructure functions from moltworker (R2 mount, channel tokens) but **never loads** moltworker's identity. The `CLAUDE_CONFIG_DIR` points exclusively to the Loa System Zone.

## Why This Matters

### 1. Identity Isolation

The agent's personality, skills, and memory are **architecturally separate** from the runtime. You can update infrastructure without touching identity, and vice versa.

### 2. Upstream Compatibility

Git subtrees let you pull updates from upstream projects cleanly:

```bash
git subtree pull --prefix=upstream/moltworker moltworker main --squash
```

Your customizations in `deploy/` are never affected.

### 3. Compound Learning

[Loa's compound learning](https://github.com/0xHoneyJar/loa) allows the AI to improve not just its work, but the entire stack:

| Target | What Improves |
|--------|--------------|
| `loa` | The AI's own skills and patterns |
| `devcontainer` | The runtime environment |
| `moltworker` | The deployment infrastructure |
| `openclaw` | The messaging gateway |

Improvements flow back to upstream repos through proper PR processes.

### 4. Crash-Resilient Persistence

Three-tier persistence with max 30 seconds data loss:

```
WAL (every write) → R2 (every 30s) → Git (hourly)
```

## Repository Structure

```
loa-beauvoir/
├── .claude/                    # L0: Loa System Zone (framework-managed)
├── grimoires/loa/              # Loa State Zone (memory, learnings)
├── upstream/
│   ├── devcontainer/           # L1: trailofbits/claude-code-devcontainer
│   └── moltworker/             # L2: cloudflare/moltworker
└── deploy/                     # L3: Your Loa identity layer
    ├── Dockerfile              # Extends cloudflare/sandbox with Loa
    ├── start-loa.sh            # Identity-isolating entrypoint
    ├── versions.json           # Upstream version pins
    ├── loa-identity/
    │   ├── types.ts            # WAL, Learning types
    │   ├── wal-manager.ts      # Write-ahead log
    │   ├── quality-gates.ts    # 4-gate learning filter
    │   ├── learning-store.ts   # CRUD for compound learnings
    │   └── skills/             # Deployment-specific skills
    └── cloudflare/
        └── wrangler.toml       # Cloudflare Workers config
```

## Quick Start

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/) with Workers Paid ($5/month)
- [Anthropic API key](https://console.anthropic.com/)
- Node.js 22+

### Deploy

```bash
# Clone
git clone https://github.com/0xHoneyJar/loa-beauvoir
cd loa-beauvoir

# Build container locally (optional, for testing)
docker build -f deploy/Dockerfile -t loa-beauvoir:dev .

# Deploy to Cloudflare
cd deploy/cloudflare
npm install
npm run r2:create                  # Create R2 bucket
npm run secret:anthropic           # Set API key
npm run secret:r2-key              # Set R2 credentials
npm run secret:r2-secret
npm run secret:cf-account
npm run deploy                     # Deploy
```

### Messaging Channels

Configure any/all:

```bash
npm run secret:telegram     # Telegram bot token
npm run secret:discord      # Discord bot token
npm run secret:slack-bot    # Slack bot token
npm run secret:slack-app    # Slack app token
```

## Acknowledgments

This project builds on:

- **[OpenClaw](https://github.com/openclaw/openclaw)** — Personal AI assistant gateway (messaging, channels, control plane)
- **[Loa Framework](https://github.com/0xHoneyJar/loa)** — Agent-driven development with compound learning
- **[moltworker](https://github.com/cloudflare/moltworker)** — Cloudflare Workers deployment pattern for AI assistants
- **[claude-code-devcontainer](https://github.com/trailofbits/claude-code-devcontainer)** — Sandboxed Claude Code environment from Trail of Bits

### The Sprawl Connection

The naming comes from William Gibson's [Sprawl trilogy](https://en.wikipedia.org/wiki/Sprawl_trilogy):

- **Loa** — In *Count Zero*, the [Loa are fragmented AI entities](http://project.cyberpunk.ru/idb/voodoo_in_neuromancer.html) that interface with humanity through voodoo constructs. They emerged from Wintermute/Neuromancer and found that Haitian vodou provided the best structures for communication.

- **Beauvoir** — A [character in *Count Zero*](https://martin-ueding.de/posts/characters-in-count-zero/) who explains vodou to Bobby Newmark: *"It isn't concerned with notions of salvation and transcendence. What it's about is getting things done."*

The framework embraces this philosophy: practical structures for getting things done, not abstract philosophies.

## Documentation

- [Deploy Guide](deploy/README.md) — Local development and Cloudflare deployment
- [PRD](grimoires/loa/prd.md) — Product requirements document
- [SDD](grimoires/loa/sdd.md) — System design document
- [Sprint Plan](grimoires/loa/sprint.md) — Implementation roadmap

## Contributing

Improvements discovered through compound learning can flow back to upstream:

```bash
# Push improvement to upstream repo
git subtree push --prefix=upstream/moltworker moltworker feature/my-improvement

# Create PR
gh pr create --repo cloudflare/moltworker
```

See Loa's [/contribute](https://github.com/0xHoneyJar/loa) command for the full workflow.

## License

MIT — see individual upstream projects for their licenses.

---

<p align="center">
  <em>"Jack in. The grimoire awaits."</em>
</p>
