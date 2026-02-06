# Contributing to OpenClaw

Welcome to the lobster tank! 🦞

## Quick Links

- **GitHub:** https://github.com/openclaw/openclaw
- **Discord:** https://discord.gg/qkhbAGHRBT
- **X/Twitter:** [@steipete](https://x.com/steipete) / [@openclaw](https://x.com/openclaw)

## Maintainers

- **Peter Steinberger** - Benevolent Dictator
  - GitHub: [@steipete](https://github.com/steipete) · X: [@steipete](https://x.com/steipete)

- **Shadow** - Discord + Slack subsystem
  - GitHub: [@thewilloftheshadow](https://github.com/thewilloftheshadow) · X: [@4shad0wed](https://x.com/4shad0wed)

- **Jos** - Telegram, API, Nix mode
  - GitHub: [@joshp123](https://github.com/joshp123) · X: [@jjpcodes](https://x.com/jjpcodes)

- **Christoph Nakazawa** - JS Infra
  - GitHub: [@cpojer](https://github.com/cpojer) · X: [@cnakazawa](https://x.com/cnakazawa)

## How to Contribute

1. **Bugs & small fixes** → Open a PR!
2. **New features / architecture** → Start a [GitHub Discussion](https://github.com/openclaw/openclaw/discussions) or ask in Discord first
3. **Questions** → Discord #setup-help

## Before You PR

- Test locally with your OpenClaw instance
- Run tests: `pnpm build && pnpm check && pnpm test`
- Keep PRs focused (one thing per PR)
- Describe what & why

## Control UI Decorators

The Control UI uses Lit with **legacy** decorators (current Rollup parsing does not support
`accessor` fields required for standard decorators). When adding reactive fields, keep the
legacy style:

```ts
@state() foo = "bar";
@property({ type: Number }) count = 0;
```

The root `tsconfig.json` is configured for legacy decorators (`experimentalDecorators: true`)
with `useDefineForClassFields: false`. Avoid flipping these unless you are also updating the UI
build tooling to support standard decorators.

## AI/Vibe-Coded PRs Welcome! 🤖

Built with Codex, Claude, or other AI tools? **Awesome - just mark it!**

Please include in your PR:

- [ ] Mark as AI-assisted in the PR title or description
- [ ] Note the degree of testing (untested / lightly tested / fully tested)
- [ ] Include prompts or session logs if possible (super helpful!)
- [ ] Confirm you understand what the code does

AI PRs are first-class citizens here. We just want transparency so reviewers know what to look for.

## Current Focus & Roadmap 🗺

We are currently prioritizing:

- **Stability**: Fixing edge cases in channel connections (WhatsApp/Telegram).
- **UX**: Improving the onboarding wizard and error messages.
- **Skills**: Expanding the library of bundled skills and improving the Skill Creation developer experience.
- **Performance**: Optimizing token usage and compaction logic.

Check the [GitHub Issues](https://github.com/openclaw/openclaw/issues) for "good first issue" labels!

## Loa Framework Contributing Guide

For comprehensive remediation steps including before/after examples, see the **Git Safety Protocol** section in [CLAUDE.md](./CLAUDE.md#remediation-steps).

### Using the `/contribute` Command

If you **intentionally** want to contribute to Loa, use the `/contribute` command in Claude Code. This provides a guided flow that:

1. Verifies your branch and remote configuration
2. Runs pre-contribution checks (secrets scanning, tests)
3. Ensures your commits are properly signed off (DCO)
4. Creates a standards-compliant PR

```bash
claude
/contribute
```

## Getting Started

### Prerequisites

- [Claude Code](https://claude.ai/code) installed and configured
- Git 2.x or later
- Node.js 18+ (for running tests and linting)

### Setting Up Your Development Environment

1. **Fork the repository** on GitHub

2. **Clone your fork**

   ```bash
   git clone https://github.com/YOUR_USERNAME/loa.git
   cd loa
   ```

3. **Add upstream remote**

   ```bash
   git remote add upstream https://github.com/0xHoneyJar/loa.git
   ```

4. **Create a feature branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

5. **Start Claude Code and run setup**
   ```bash
   claude
   /setup
   ```

## Development Workflow

### Branch Naming Convention

Use descriptive branch names following these patterns:

| Type          | Pattern                | Example                           |
| ------------- | ---------------------- | --------------------------------- |
| Feature       | `feature/description`  | `feature/add-typescript-agent`    |
| Bug fix       | `fix/description`      | `fix/analytics-json-parsing`      |
| Documentation | `docs/description`     | `docs/update-contribution-guide`  |
| Refactor      | `refactor/description` | `refactor/agent-prompt-structure` |
| CI/Infra      | `ci/description`       | `ci/add-lint-workflow`            |

### Keeping Your Fork Updated

```bash
# Fetch upstream changes
git fetch upstream

# Merge upstream main into your branch
git merge upstream/main

# Or rebase (for cleaner history)
git rebase upstream/main
```

### Making Changes

1. **Sync with upstream** before starting work
2. **Create a feature branch** from `main`
3. **Make focused commits** with clear messages
4. **Test your changes** locally
5. **Push to your fork** and create a PR

## Submitting Changes

### Pull Request Process

1. **Ensure your PR addresses a single concern**
   - One feature, one bug fix, or one documentation update per PR
   - Large changes should be broken into smaller PRs

2. **Write a clear PR description**
   - What does this PR do?
   - Why is this change needed?
   - How was it tested?

3. **Link related issues**
   - Use keywords like `Closes #123` or `Fixes #456`

4. **Wait for CI to pass**
   - All automated checks must pass
   - Secret scanning and security audits must pass

5. **Request review**
   - At least one maintainer approval required
   - Address review feedback promptly

### Developer Certificate of Origin (DCO)

All contributions to Loa must include a DCO sign-off. This certifies that you wrote the code or have the right to submit it.

**Add to every commit:**

```
Signed-off-by: Your Name <your.email@example.com>
```

**Easiest method - use the `-s` flag:**

```bash
git commit -s -m "feat(agents): add code-reviewer agent"
```

**Configure git to sign-off automatically:**

```bash
git config user.name "Your Name"
git config user.email "your.email@example.com"
```

### Commit Message Guidelines

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

Longer description if needed.

Closes #123

Signed-off-by: Your Name <your.email@example.com>
```

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `ci`: CI/CD changes
- `chore`: Maintenance tasks

**Examples:**

```
feat(agents): add code-reviewer agent for automated PR reviews

fix(analytics): handle missing usage.json gracefully

docs(readme): add troubleshooting section for MCP setup
```

## Style Guidelines

### Skills (Agents)

Skills live in `.claude/skills/` using a 3-level architecture:

```
.claude/skills/{skill-name}/
├── index.yaml          # Level 1: Metadata (~100 tokens)
├── SKILL.md            # Level 2: KERNEL instructions (~2000 tokens)
└── resources/          # Level 3: References, templates, scripts
```

**Naming convention**: Use gerund form (action-ing) for skill directories:

- `discovering-requirements` (not `prd-architect`)
- `implementing-tasks` (not `sprint-task-implementer`)
- `reviewing-implementations` (not `senior-tech-lead-reviewer`)

When modifying skills:

- **index.yaml**: Keep metadata lean (~100 tokens), include triggers, examples, mcp_dependencies
- **SKILL.md**: Core instructions only (~2000 tokens), reference resources for details
- **resources/**: Templates, examples, and detailed reference materials
- Maintain consistent persona and expertise level
- Include clear phase transitions
- Provide structured output formats

### Command Definitions

Commands in `.claude/commands/` use thin routing layer with YAML frontmatter:

```yaml
---
name: "command-name"
version: "1.0.0"
description: "What this command does"
agent: "skill-name" # For agent commands
agent_path: ".claude/skills/" # Skill directory
mcp_source: ".claude/mcp-registry.yaml" # Reference MCP registry
mcp_requirements: # Required MCPs
  - server: "linear"
    required: true
pre_flight: # Validation checks
  - check: "file_exists"
    path: "some-file.md"
---
```

When creating or modifying commands:

- Use clear, descriptive command names
- Add pre-flight checks for prerequisites
- Reference MCP registry for integrations
- Handle error cases gracefully
- Update CLAUDE.md with new commands

### MCP Registry

MCP server configurations are centralized in `.claude/mcp-registry.yaml`:

```yaml
servers:
  linear:
    name: "Linear"
    description: "Issue tracking"
    scopes: [issues, projects]
    required_by:
      - skill: "planning-sprints"
        reason: "Can sync sprint tasks to Linear"
    setup:
      steps: [...]
groups:
  essential:
    servers: [github]
```

Helper scripts for MCP operations:

```bash
.claude/scripts/mcp-registry.sh list      # List all servers
.claude/scripts/mcp-registry.sh info <server>  # Server details
.claude/scripts/mcp-registry.sh setup <server> # Setup instructions
.claude/scripts/validate-mcp.sh <servers>      # Validate configuration
```

When adding MCP integrations:

- Add server definition to `.claude/mcp-registry.yaml`
- Include setup instructions with required env vars
- Add to appropriate server groups
- Update skills/commands that depend on it

### Helper Scripts

Scripts in `.claude/scripts/` follow these conventions:

- **Fail fast**: `set -euo pipefail` in all scripts
- **Parseable output**: Structured return values (e.g., `KEY|value`)
- **Exit codes**: 0=success, 1=error, 2=invalid input
- **No side effects**: Scripts read state, don't modify it
- **Cross-platform**: Use `compat-lib.sh` for `sed -i`, `readlink -f`, `stat`, `sort -V`, `mktemp --suffix`, and `find -printf`. See `.claude/protocols/cross-platform-shell.md`

### Documentation

- Use clear, concise language
- Include code examples where helpful
- Keep line lengths reasonable (< 100 chars)
- Update related docs when making changes

## Testing

### Running Tests

```bash
# Run linting
npm run lint

# Run all tests
npm test

# Run specific test suite
npm test -- --grep "agent"
```

### What to Test

- New agent prompts should include example interactions
- Command changes should be tested with `/command help`
- Documentation changes should be previewed locally

### CI Checks

All PRs must pass:

1. **Secret Scanning** - No secrets in code
2. **Security Audit** - No critical vulnerabilities
3. **Linting** - Code style compliance
4. **Tests** - All tests passing

## Documentation

### Updating Documentation

When your changes affect documentation:

1. **README.md** - User-facing feature descriptions
2. **PROCESS.md** - Workflow documentation
3. **CLAUDE.md** - Agent and command reference
4. **CHANGELOG.md** - Version history (maintainers will update)

### Documentation Standards

- Keep explanations beginner-friendly
- Include command examples
- Update table of contents if adding sections
- Check for broken links

## Community

### Getting Help

- **Issues**: Use GitHub Issues for bugs and feature requests
- **Discussions**: Use GitHub Discussions for questions
- **Discord**: Join our Discord for real-time chat

### Recognition

Contributors are recognized in:

- GitHub contributor graphs
- Release notes (for significant contributions)
- Special thanks in documentation

## Types of Contributions

### We Welcome

- Bug fixes and issue reports
- Documentation improvements
- New skill definitions (3-level architecture)
- Command enhancements
- MCP registry additions
- Helper script improvements
- Security improvements
- Performance optimizations
- Test coverage improvements

### Before Starting Large Changes

For significant changes (new skills, workflow modifications, architecture changes):

1. **Open an issue first** to discuss the proposal
2. **Get maintainer feedback** before implementing
3. **Consider breaking into smaller PRs** for easier review

## Command Optimization (v0.19.0)

When writing or modifying commands, follow these patterns to maximize efficiency.

### Parallel Call Patterns

Use parallel tool calls when operations are independent:

**Good - Independent operations in parallel:**

```javascript
// Check multiple files simultaneously
await Promise.all([
  read("grimoires/loa/prd.md"),
  read("grimoires/loa/sdd.md"),
  read("grimoires/loa/sprint.md"),
]);
```

**Bad - Sequential when parallel is possible:**

```javascript
// Unnecessarily slow
await read("grimoires/loa/prd.md");
await read("grimoires/loa/sdd.md");
await read("grimoires/loa/sprint.md");
```

### Sequential When Dependencies Exist

Use sequential calls when operations depend on each other:

**Good - Sequential for dependencies:**

```javascript
// Must be sequential - commit depends on add
await bash("git add .");
await bash('git commit -m "message"');
```

**Bad - Parallel with dependencies:**

```javascript
// Will fail - commit runs before add completes
await Promise.all([
  bash("git add ."),
  bash('git commit -m "message"'), // Error: nothing to commit
]);
```

### Command Invocation Examples

**Good command invocations:**

```bash
# Explicit, single purpose
/implement sprint-1

# Clear target with options
/review-sprint sprint-1

# Specific file reference
/translate @grimoires/loa/sdd.md for executives
```

**Bad command invocations:**

```bash
# Vague, no target
/implement

# Multiple sprints at once (not supported)
/implement sprint-1 sprint-2

# Missing required context
/review-sprint  # No sprint specified
```

### Pre-flight Check Patterns

Commands should validate prerequisites before execution:

**Good - Validate then execute:**

```yaml
pre_flight:
  - check: "file_exists"
    path: "grimoires/loa/prd.md"
    message: "PRD not found. Run /plan-and-analyze first."
  - check: "pattern_match"
    value: "$ARGUMENTS.sprint_id"
    pattern: "^sprint-[0-9]+$"
    message: "Sprint ID must be in format: sprint-N"
```

**Bad - Execute without validation:**

```yaml
# Missing pre-flight checks - will fail confusingly
pre_flight: []
```

### Context Loading Optimization

Load context efficiently based on command needs:

**Good - Load only what's needed:**

```yaml
context_files:
  priority_1: # Always load
    - "grimoires/loa/sprint.md"
  priority_2: # Load if exists
    - "grimoires/loa/a2a/sprint-$SPRINT_ID/reviewer.md"
  optional: # Load on demand
    - "grimoires/loa/prd.md"
    - "grimoires/loa/sdd.md"
```

**Bad - Load everything always:**

```yaml
context_files:
  priority_1:
    - "grimoires/loa/**/*.md" # Loads entire state zone
```

### Error Message Quality

Provide actionable error messages:

**Good - Actionable error:**

```
Error: Sprint-1 not found in ledger.

To fix:
1. Run '/sprint-plan' to register sprints
2. Or run '/ledger init' if this is an existing project
```

**Bad - Cryptic error:**

```
Error: Not found
```

### Command Documentation

Every command should document:

1. **Purpose**: What the command does
2. **Prerequisites**: What must exist before running
3. **Arguments**: Required and optional parameters
4. **Outputs**: Files created or modified
5. **Examples**: At least 2-3 usage examples

See `.claude/commands/implement.md` for a well-documented command example.

## License

By contributing to Loa, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE.md).

---

Thank you for contributing to Loa! Your efforts help make AI-assisted development better for everyone.
