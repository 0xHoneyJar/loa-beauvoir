# Agent Working Memory (NOTES.md)

> This file persists agent context across sessions and compaction cycles.
> Updated automatically by agents. Manual edits are preserved.

## Active Sub-Goals
<!-- Current objectives being pursued -->
- **Infrastructure PRD complete**: Loa Cloud Stack (loa-beauvoir) v0.2.0
- **Resilience PRD created**: Beauvoir Personality & Resilience v0.1.0
- **SDD complete**: System architecture designed v0.1.0
- **Sprint Plan complete**: 5 sprints, 35 tasks total
- **All sprints implemented**: Foundation, Container, Persistence, Deployment, Learning
- **Container deployed**: Gateway connects, Telegram pending pairing approval
- **Identity created**: BEAUVOIR.md with principle-driven personality
- Next: Implement two-phase memory consolidation, enable memory_search for grimoires

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
| 2026-02-02 | claude-opus-4.5 | Implemented all 5 sprints: upstream subtrees, Dockerfile, WAL persistence, Cloudflare config, compound learning |
| 2026-02-03 | claude-opus-4.5 | Fixed container startup (removed ENTRYPOINT), gateway now connects |
| 2026-02-03 | claude-opus-4.5 | Updated Loa v1.16.0 → v1.20.0 (guardrails, retrospective learning) |
| 2026-02-03 | claude-opus-4.5 | Created PRD: Beauvoir Personality & Resilience - principle-driven identity |
| 2026-02-03 | claude-opus-4.5 | Created BEAUVOIR.md identity document, updated start-loa.sh with recovery protocol |
| 2026-02-03 | claude-opus-4.5 | Updated Loa v1.20.0 → v1.21.0 (Flatline Protocol multi-model review) |
| 2026-02-03 | claude-opus-4.5 | Added Loa optimizations to Dockerfile: Rust/cargo, ck-search, beads_rust, memory stack, patchright |
| 2026-02-03 | claude-opus-4.5 | Successfully deployed container to Cloudflare - moved clawdbot to runtime install to fix registry push timeouts |

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
