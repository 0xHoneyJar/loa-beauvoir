# Plan: Integration Strategy Evaluation

## Question
Should we continue with git subtrees within loa-beauvoir, or fork moltworker directly?

---

## Option 1: Git Subtrees in loa-beauvoir (Current Plan)

```
loa-beauvoir/
├── .claude/                    # L0: Loa System Zone (managed)
├── grimoires/loa/              # Loa State Zone
├── upstream/
│   ├── devcontainer/           # L1: Subtree from trailofbits
│   └── moltworker/             # L2: Subtree from cloudflare
└── deploy/                     # L3: Your code (Loa identity layer)
    ├── Dockerfile
    ├── start-loa.sh            # Replaces moltbot identity entirely
    └── loa-identity/
```

**How it works:**
- Subtrees bring upstream code into your repo
- `deploy/start-loa.sh` imports infra functions but **never loads AGENTS.md**
- Loa System Zone (`/.claude/`) is the only identity source
- Updates: `git subtree pull --prefix=upstream/moltworker moltworker main --squash`
- Contributions: `git subtree push --prefix=upstream/moltworker moltworker feature/x`

---

## Option 2: Fork moltworker Directly

```
moltworker (your fork)/
├── Dockerfile                  # Modify directly
├── start-moltbot.sh → start-loa.sh  # Rename and modify
├── src/                        # Workers proxy code
└── wrangler.jsonc

loa-beauvoir/ (separate repo)
├── .claude/                    # Loa System Zone
└── grimoires/loa/              # Loa State Zone
```

**How it works:**
- Fork cloudflare/moltworker to your account
- Modify files directly in fork
- Keep loa-beauvoir as separate Loa-only repo
- Sync fork with upstream via GitHub's "Sync fork" button

---

## Analysis

| Criterion | Subtrees (Option 1) | Fork (Option 2) |
|-----------|-------------------|-----------------|
| **100% Loa identity** | ✅ Architectural guarantee - deploy/ layer replaces identity | ⚠️ Must actively delete moltbot references |
| **Upstream updates** | ✅ `git subtree pull` (both repos) | ⚠️ GitHub sync (moltworker only) |
| **devcontainer handling** | ✅ Same pattern | ❌ Needs separate approach |
| **Single source of truth** | ✅ All in loa-beauvoir | ❌ Split across repos |
| **Contribution flow** | ✅ `git subtree push` creates PR | ✅ Standard fork PR |
| **Compound learning** | ✅ All layers in grimoires/ | ⚠️ Where do learnings live? |
| **Repo complexity** | ⚠️ Subtrees add code | ✅ Smaller repos |
| **Learning curve** | ⚠️ Subtree commands unfamiliar | ✅ Standard git/fork |

---

## Recommendation: Continue with Subtrees (Option 1)

**Primary reason: Identity isolation is architectural, not procedural.**

With subtrees:
- The `upstream/` directories are clearly marked "DO NOT MODIFY"
- Your code lives only in `deploy/`
- `deploy/start-loa.sh` sources moltworker's **infra functions only** (R2 mount, channel tokens)
- The AGENTS.md and moltbot identity are **never loaded** - guaranteed by startup flow
- Zero risk of moltbot personality bleeding through

With a fork:
- You're editing a codebase with moltbot references throughout
- Upstream syncs might re-introduce moltbot patterns
- The boundary between "upstream infra" and "Loa identity" is blurred
- You'd need discipline to not accidentally load default identity

**Secondary reasons:**
1. Both devcontainer AND moltworker managed identically
2. All Loa artifacts (grimoires, learnings, deploy config) in one repo
3. Compound learning can target improvements to any layer from one place
4. Sprint plan already designed for this architecture

---

## Identity Isolation Proof (from SDD)

The `start-loa.sh` entrypoint:

```bash
# Phase 1: Infrastructure only (no identity)
source_moltworker_infra()  # R2 mount, channel tokens

# Phase 3: Loa identity (REPLACES moltbot entirely)
initialize_loa_identity()
  export CLAUDE_CONFIG_DIR="/workspace/.claude"  # Loa System Zone
  # AGENTS.md is NEVER read
```

The Dockerfile copies Loa's `.claude/` directory, not moltworker's identity files.

---

## Concerns Addressed

**"Maintainability - ability to pull from upstream"**
- Subtrees are designed for this: `git subtree pull --squash` brings updates cleanly
- `deploy/versions.json` tracks which commits are tested
- If conflict: `git reset --hard HEAD~1` to abort

**"100% Loa identity - no hangover from old agent"**
- The layer architecture guarantees this
- Your deploy/ layer sits on top and controls what loads
- Moltbot's AGENTS.md exists in `upstream/moltworker/` but is never referenced
- Identity source is exclusively `/.claude/` (Loa System Zone)

**"Ability for Loa to improve all layers"**
- Compound learning in `grimoires/loa/a2a/compound/`
- Each learning has `target: 'loa' | 'devcontainer' | 'moltworker' | 'openclaw'`
- Improvements to upstream flow via `git subtree push` → PR → human review

---

## Verdict

**Stay with the current approach.** The PRD, SDD, and Sprint Plan are well-designed for your requirements:

1. 100% Loa identity via architectural layer separation
2. Clean upstream update path via subtrees
3. Contribution flow via subtree push → PR
4. Compound learning unified in grimoires/
5. Both devcontainer and moltworker handled consistently

The Sprint Plan's 5 sprints build this incrementally:
- Sprint 1: Set up subtrees + deploy structure
- Sprint 2: Create identity-replacing Dockerfile + start-loa.sh
- Sprint 3-4: Persistence + deployment
- Sprint 5: Compound learning

No changes to the current architecture are recommended.

---

## Next Step

Run `/implement sprint-1` to begin the Foundation sprint (subtrees + deploy structure).
