# Agent Working Memory (NOTES.md)

> This file persists agent context across sessions and compaction cycles.
> Updated automatically by agents. Manual edits are preserved.

## Active Sub-Goals
<!-- Current objectives being pursued -->
- **PRD complete**: Loa Cloud Stack (loa-beauvoir) v0.2.0
- **SDD complete**: System architecture designed v0.1.0
- **Sprint Plan complete**: 5 sprints, 35 tasks total
- Next: `/implement sprint-1` to begin Foundation sprint

## Discovered Technical Debt
<!-- Issues found during implementation that need future attention -->

## Blockers & Dependencies
<!-- External factors affecting progress -->

## Session Continuity
<!-- Key context to restore on next session -->
| Timestamp | Agent | Summary |
|-----------|-------|---------|
| 2026-02-02 | claude-opus-4.5 | Updated Loa v1.7.2 → v1.16.0, resolved merge conflicts, generated reality artifacts |
| 2026-02-02 | claude-opus-4.5 | Completed PRD discovery for Loa Cloud Stack - self-improving deployment pattern |
| 2026-02-02 | claude-opus-4.5 | Completed SDD - 3-layer architecture, WAL persistence, identity isolation |
| 2026-02-02 | claude-opus-4.5 | Completed Sprint Plan - 5 sprints (35 tasks), MVP at sprint 4 |

## Decision Log
<!-- Major decisions with rationale -->
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-02 | Keep CLAUDE.md as symlink to AGENTS.md | Project uses AGENTS.md for all agent instructions, CLAUDE.md symlink maintains compatibility |
| 2026-02-02 | Accept upstream .loa.config.yaml | Latest config has all v1.16.0 features, can be customized later |
| 2026-02-02 | Merge .gitignore (project + framework patterns) | Both sets of exclusions are needed for proper operation |
| 2026-02-02 | Git subtrees for upstream management | Easier updates, code directly in repo, Loa can analyze/propose changes |
| 2026-02-02 | R2 + Git dual persistence | Hot state in R2, cold backup to git for durability |
| 2026-02-02 | Loa improves ALL layers | Not just identity - compound learning feeds back to Loa, devcontainer, moltworker, OpenClaw |
| 2026-02-02 | MVP = Deploy + Chat + Learn | Auto-PR generation deferred to Phase 2 |

## Project Context
<!-- Quick reference for agents -->

**Project**: OpenClaw v2026.2.1
**Type**: Personal AI Assistant Gateway (multi-channel messaging)
**Stack**: TypeScript/Node.js 22+ (ESM), pnpm 10.23.0
**Key Dirs**: `src/`, `extensions/`, `apps/` (mobile/desktop)

### Channels Supported
- Built-in: WhatsApp, Telegram, Slack, Discord, Signal, iMessage
- Extensions: MS Teams, Matrix, Zalo, LINE, Google Chat, Mattermost

### Reality Files
- `grimoires/loa/reality/index.md` - Architecture overview
- `grimoires/loa/reality/modules.md` - Module map
- `grimoires/loa/reality/dependencies.md` - Key dependencies
- `grimoires/loa/reality/config.md` - Configuration system
- `grimoires/loa/reality/plugins.md` - Plugin architecture
