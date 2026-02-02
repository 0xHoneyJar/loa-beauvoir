# Loa Identity Layer

This directory contains the Loa-specific identity configuration that replaces moltworker's default identity.

## Files

| File | Purpose |
|------|---------|
| `infra-lib.sh` | Infrastructure functions extracted from moltworker (R2 mount, channel config) |
| `wal-manager.ts` | Write-ahead log for crash recovery |
| `learning-types.ts` | TypeScript types for compound learning |
| `quality-gates.ts` | 4-gate quality filter for learnings |
| `learning-store.ts` | CRUD operations for learnings |
| `skills/` | Deployment-specific skills |

## Identity Isolation Guarantee

This layer ensures that:
1. Moltworker's `AGENTS.md` is **never loaded**
2. Loa's `.claude/` System Zone is the **only identity source**
3. All moltworker functionality (R2, channels) works **without** moltbot personality

## Key Design Decisions

- **Infrastructure functions only**: We extract R2 mount, channel token handling, etc. from moltworker but NOT identity
- **Complete identity replacement**: `start-loa.sh` sets `CLAUDE_CONFIG_DIR` to Loa's System Zone
- **No AGENTS.md loading**: The startup flow never reads moltworker's identity file
