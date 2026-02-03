# Sprint Plan: Beauvoir Resilience v0.2.0

> **Status**: Draft
> **Version**: 0.3.0
> **Created**: 2026-02-03
> **Updated**: 2026-02-03
> **PRD Reference**: `grimoires/loa/prd.md` v0.3.0
> **SDD Reference**: `grimoires/loa/beauvoir-resilience-sdd.md` v0.3.0
> **Author**: Claude Opus 4.5
> **Reviewed**: Flatline Protocol (GPT-5.2 + Opus, 100% agreement)

---

## Executive Summary

This sprint plan implements the Beauvoir Personality & Resilience system across 7 sprints (73 tasks). The implementation follows the SDD v0.3.0 architecture with all Flatline Protocol feedback and operational hardening integrated:

- **Defense-in-depth**: Ed25519 signing with key lifecycle, single-writer architecture, non-root execution
- **Resilient memory**: Two-phase consolidation with validated lexical fallback and queue-based degradation
- **Auto-recovery**: State machine with failure counting, SHA-256 verification, configurable thresholds
- **Privacy-first**: Entropy-based PII detection with 15+ patterns
- **Operational safety**: Per-sprint rollback procedures, circuit breakers, scheduler jitter
- **Operational hardening**: Subagent timeout enforcement, bloat audits, MECE validation (FR-6 to FR-11)

**MVP Milestone**: Sprint 9 (Recovery Engine operational)

---

## Sprint Overview

| Sprint | Name | Tasks | Focus | Dependencies |
|--------|------|-------|-------|--------------|
| 6 | Security Foundation | 11 | Ed25519 signing, key lifecycle, PII redactor, credentials | None |
| 7 | Identity & Memory Core | 10 | BEAUVOIR.md, session manager, WAL manager, crash semantics | Sprint 6 |
| 8 | Consolidation Engine | 9 | Embeddings, validated lexical fallback, queue degradation | Sprint 7 |
| 9 | Recovery Engine (MVP) | 11 | State machine, SHA-256 verification, loop detection defaults | Sprint 8 |
| 10 | Self-Repair Engine | 9 | Signed allowlist, sandboxed execution, cryptographic approvals | Sprint 9 |
| 11 | Integration & Skills | 9 | start-loa.sh, Loa skills, scheduler with circuit breakers | Sprint 10 |
| 12 | Operational Hardening | 14 | Timeout enforcement, bloat audit, MECE, meta-monitor, context, notifications | Sprint 11 |

**Total**: 73 tasks across 7 sprints

---

## Sprint 6: Security Foundation

**Goal**: Establish cryptographic foundations and security primitives before any data handling.

**Rationale**: Security components are dependencies for all other engines (manifests need signing, memory needs PII redaction, self-repair needs signed allowlist).

### Tasks

| ID | Task | Acceptance Criteria | Estimate |
|----|------|---------------------|----------|
| 6.1 | Create Ed25519 key generation script | Script generates keypair, outputs public key for embedding, stores private in Cloudflare Secrets format | S |
| 6.2 | Implement ManifestSigner class | Signs/verifies manifests, RFC 8785 JCS canonical JSON, key ID in signatures | M |
| 6.3 | Implement AllowlistSigner class | Signs/verifies package allowlists, rejects unsigned allowlists | M |
| 6.4 | Implement PIIRedactor with patterns | 15+ patterns from SDD (API keys, PII, JWT), block private keys | M |
| 6.5 | Add entropy-based secret detection | Shannon entropy >= 4.5, min length 20, skip UUIDs/numbers | S |
| 6.6 | Implement SecretScanner for pre-commit | Scan staged grimoire files, block commits with secrets | S |
| 6.7 | Create credential management module | Load from Cloudflare Secrets > env > .env, scoped R2 access | M |
| 6.8 | Add AuditLogger for tamper-evident logs | JSONL format, append-only, include timestamps and checksums | S |
| 6.9 | **Define key lifecycle procedure** | Key IDs, active/retired sets, rotation cadence (90 days), overlap period (7 days), emergency revoke procedure | M |
| 6.10 | **Implement multi-key verification** | Verify with active + N retired keys, reject if no match, log key ID used | M |
| 6.11 | **Create incident response runbook** | Key compromise detection, revocation steps, re-signing procedure, communication template | S |

**Deliverables**:
- `deploy/loa-identity/security/manifest-signer.ts`
- `deploy/loa-identity/security/allowlist-signer.ts`
- `deploy/loa-identity/security/pii-redactor.ts`
- `deploy/loa-identity/security/secret-scanner.ts`
- `deploy/loa-identity/security/credential-manager.ts`
- `deploy/loa-identity/security/audit-logger.ts`
- `deploy/loa-identity/security/key-manager.ts`
- `scripts/generate-signing-keys.sh`
- `docs/runbooks/key-compromise-response.md`

**Rollback Procedure**:
- Revert to previous public key set in container image
- Re-sign all manifests/allowlists with previous key
- Verification: All existing signed artifacts still verify

---

## Sprint 7: Identity & Memory Core

**Goal**: Implement identity loading and Phase 1 memory capture with WAL persistence.

### Tasks

| ID | Task | Acceptance Criteria | Estimate |
|----|------|---------------------|----------|
| 7.1 | Create BEAUVOIR.md identity document | Template from SDD Appendix A, principle-driven personality | S |
| 7.2 | Implement IdentityLoader class | Parse BEAUVOIR.md, load principles/boundaries, log changes to NOTES.md | M |
| 7.3 | Create WALManager with segmentation | 10MB segments, 1-hour rotation, 10-segment retention | L |
| 7.4 | Implement WAL locking (flock + PID) | Exclusive flock on segment, PID lock file for single-writer enforcement, atomic append, fsync after commit | M |
| 7.5 | Implement WAL replay on startup | Verify checksums, replay write/delete ops, log entries processed, truncate to last valid checksum on corruption | M |
| 7.6 | Create SessionMemoryManager | Capture entries, PII redaction, quality gates, WAL append | L |
| 7.7 | Implement quality gates | Temporal, speculation, instruction, confidence gates per SDD | M |
| 7.8 | Add atomic file writes | Write to .tmp, fsync, atomic rename for NOTES.md/manifests | S |
| 7.9 | **Define WAL rotation crash semantics** | Two-phase rotation: (1) write checkpoint, (2) rotate. Crash recovery replays from last checkpoint. Segment full before 1-hour triggers early rotation | M |
| 7.10 | **Document supported filesystems** | Supported: ext4, xfs, overlayfs (Docker default). Unsupported: NFS, Windows hosts. Add integration test matrix | S |

**Deliverables**:
- `grimoires/loa/BEAUVOIR.md`
- `deploy/loa-identity/identity-loader.ts`
- `deploy/loa-identity/wal/wal-manager.ts`
- `deploy/loa-identity/memory/session-manager.ts`
- `deploy/loa-identity/memory/quality-gates.ts`
- `docs/deployment/filesystem-requirements.md`

**Rollback Procedure**:
- Restore BEAUVOIR.md from R2 backup
- Replay WAL from last checkpoint to recover state
- Verification: Identity loads correctly, session memory intact

---

## Sprint 8: Consolidation Engine

**Goal**: Implement Phase 2 memory consolidation with semantic dedup and validated lexical fallback.

### Tasks

| ID | Task | Acceptance Criteria | Estimate |
|----|------|---------------------|----------|
| 8.1 | Create Python embedding service | FastAPI on localhost:8384, MiniLM-L6-v2, batch embeddings, health check endpoint | M |
| 8.2 | Implement embedding service client | HTTP client, availability check, timeout handling (5s), retry with backoff | S |
| 8.3 | Implement semantic deduplication | Cosine similarity >= 0.85, recency-wins, tag merging | M |
| 8.4 | Implement Jaccard lexical fallback | Word-level tokenization, threshold 0.80, method tracking in audit log | M |
| 8.5 | Create ConsolidationEngine | Load session/durable, dedup, quality gates, write monthly | L |
| 8.6 | Implement monthly file management | Atomic writes to YYYY-MM.md, archive older memories | M |
| 8.7 | Add consolidation audit logging | JSONL audit trail, promote/merge/reject actions, fallback usage frequency | S |
| 8.8 | **Create lexical fallback test suite** | Golden test cases proving Jaccard produces acceptable results vs semantic baseline. Document expected divergence (false positives/negatives) | M |
| 8.9 | **Implement consolidation queue** | When embedding service unavailable, queue consolidation jobs instead of degraded fallback. Process queue when service recovers. Max queue age: 4 hours, then use fallback | M |

**Deliverables**:
- `deploy/loa-identity/embedding-service/main.py`
- `deploy/loa-identity/embedding-service/requirements.txt`
- `deploy/loa-identity/memory/embedding-client.ts`
- `deploy/loa-identity/memory/consolidation-engine.ts`
- `deploy/loa-identity/memory/consolidation-queue.ts`
- `grimoires/loa/memory/` directory structure
- `tests/memory/lexical-fallback.test.ts` (golden tests)

**Rollback Procedure**:
- Restore monthly memory files from R2 backup
- Clear consolidation queue, re-process from session memory
- Verification: Memory search returns consistent results

---

## Sprint 9: Recovery Engine (MVP)

**Goal**: Implement auto-recovery state machine. **This is the MVP milestone.**

### Tasks

| ID | Task | Acceptance Criteria | Estimate |
|----|------|---------------------|----------|
| 9.1 | Implement RecoveryEngine state machine | States from SDD (START→CHECK_INTEGRITY→...→RUNNING) | L |
| 9.2 | Implement integrity checking | Load manifest, verify Ed25519 signature (multi-key), hash critical files with SHA-256 | M |
| 9.3 | Implement R2 restore with SHA-256 | Download files, verify SHA-256 checksum from signed manifest (NOT ETag), atomic write | M |
| 9.4 | Implement Git restore fallback | Clone/pull grimoires, validate manifest signature | M |
| 9.5 | Implement template initialization | Create default BEAUVOIR.md/NOTES.md when all backups fail | S |
| 9.6 | Implement loop detection with defaults | Count FAILURES (not attempts), defaults: 3 failures in 10 minutes, configurable via env vars | M |
| 9.7 | Implement degraded mode | Set BEAUVOIR_DEGRADED env, schedule 1-hour retry | S |
| 9.8 | Implement manifest generation | Generate and sign manifest after state changes, include SHA-256 checksums for all files | M |
| 9.9 | Create recovery engine entrypoint | `run.js` for startup script integration | S |
| 9.10 | **Store checksums in manifest** | Manifest includes SHA-256 for each file, verified before trusting R2 content. ETag used only for change detection, not integrity | S |
| 9.11 | **Add loop detection configuration** | Env vars: `BEAUVOIR_LOOP_MAX_FAILURES=3`, `BEAUVOIR_LOOP_WINDOW_MINUTES=10`. Document tuning guidance | S |

**Deliverables**:
- `deploy/loa-identity/recovery/recovery-engine.ts`
- `deploy/loa-identity/recovery/r2-client.ts`
- `deploy/loa-identity/recovery/git-client.ts`
- `deploy/loa-identity/recovery/run.js`
- `docs/configuration/recovery-tuning.md`

**MVP Criteria Met**:
- Auto-recovery from restarts without human intervention
- State integrity verified with Ed25519 signatures AND SHA-256 checksums
- Fallback chain: R2 → Git → Template
- Loop detection prevents infinite restore cycles (configurable defaults)

**Rollback Procedure**:
- Force restore from Git (bypasses R2)
- Reset loop detection counter
- Verification: Container starts, state integrity passes

---

## Sprint 10: Self-Repair Engine

**Goal**: Implement dependency detection and secure auto-repair with defense-in-depth.

### Tasks

| ID | Task | Acceptance Criteria | Estimate |
|----|------|---------------------|----------|
| 10.1 | Create signed package allowlist | YAML format, Ed25519 signed, version + sha256, explicit command allowlist | M |
| 10.2 | Implement dependency detection | Check npm/apt packages, classify against allowlist | M |
| 10.3 | Implement sandboxed auto-fix | npm ci with lockfile, verify sha256, non-root execution, no network by default, least-privilege filesystem | L |
| 10.4 | Implement ask-first flow | Store pending actions with cryptographic nonce, strict JSON parsing (no free-form) | M |
| 10.5 | Implement cryptographic approval | Signed approval records (Ed25519), validate approver identity, replay protection via nonce | M |
| 10.6 | Add repair audit logging | Log all repair actions with status, approver signature, and command executed | S |
| 10.7 | Create loa-user in Dockerfile | Non-root user (UID 1000), home directory, npm prefix, no sudo | S |
| 10.8 | **Create threat model tests** | Abuse-case tests: malicious NOTES.md, compromised allowlist, command injection attempts | M |
| 10.9 | **Define repair sandbox constraints** | Network disabled, read-only /workspace except install target, no shell expansion, explicit command allowlist | S |

**Deliverables**:
- `.loa/allowed-packages.yaml`
- `deploy/loa-identity/repair/self-repair-engine.ts`
- `deploy/loa-identity/repair/package-checker.ts`
- `deploy/loa-identity/repair/approval-verifier.ts`
- `deploy/loa-identity/repair/sandbox.ts`
- `tests/repair/threat-model.test.ts`
- Dockerfile updates for loa-user

**Rollback Procedure**:
- Uninstall package via npm uninstall
- Restore previous allowlist from Git
- Verification: Dependency detection shows previous state

---

## Sprint 11: Integration & Skills

**Goal**: Integrate all components and create Loa skills for management.

### Tasks

| ID | Task | Acceptance Criteria | Estimate |
|----|------|---------------------|----------|
| 11.1 | Update start-loa.sh integration | Run recovery engine before gateway, handle degraded mode | M |
| 11.2 | Create /recovery-status skill | Show state, degraded flag, restore count, R2/Git availability | M |
| 11.3 | Create /force-restore skill | Manual restore from R2 or Git with confirmation | S |
| 11.4 | Create /consolidate-memory skill | Trigger manual consolidation, show results | S |
| 11.5 | Create /memory-stats skill | Show session/durable counts, storage usage | S |
| 11.6 | Create /approve-repair skill | List pending, approve with signature, show audit trail | M |
| 11.7 | Set up scheduled tasks with jitter | R2 sync (30s ± 5s jitter), consolidation (hourly ± 5min jitter), manifest regen (5min ± 30s jitter) | M |
| 11.8 | **Implement scheduler circuit breaker** | Open circuit after 3 consecutive failures per job type. Half-open after 5 minutes. Rate limit: max 1 concurrent job per type | M |
| 11.9 | **Add job mutual exclusion** | Single scheduler with job leases. Consolidation blocks R2 sync. Recovery blocks all other jobs | S |

**Deliverables**:
- Updated `deploy/start-loa.sh`
- `deploy/loa-identity/skills/recovery-status.md`
- `deploy/loa-identity/skills/force-restore.md`
- `deploy/loa-identity/skills/consolidate-memory.md`
- `deploy/loa-identity/skills/memory-stats.md`
- `deploy/loa-identity/skills/approve-repair.md`
- `deploy/loa-identity/scheduler/scheduler.ts`
- `deploy/loa-identity/scheduler/circuit-breaker.ts`

**Rollback Procedure**:
- Disable scheduled tasks via env var `BEAUVOIR_SCHEDULER_DISABLED=true`
- Run manual recovery/sync as needed
- Verification: Gateway starts, manual skills work

---

## Sprint 12: Operational Hardening

**Goal**: Implement production hardening features from FR-6 through FR-11 to prevent timeout crashes, resource explosion, and task redundancy.

**Rationale**: Operational learnings from production autonomous systems show that without these safeguards, systems degrade through bloat, redundancy, and silent failures.

### Tasks

| ID | Task | Acceptance Criteria | Estimate |
|----|------|---------------------|----------|
| 12.1 | Implement TimeoutEnforcer class | Validate timeout before spawn, 30min minimum for trusted models, 3min hard floor, log all configurations | M |
| 12.2 | Add trusted model detection | Pattern matching for Opus/Codex variants, configurable model list | S |
| 12.3 | Integrate timeout enforcement with scheduler | Hook into beforeSubagentSpawn, adjust timeout automatically, warn on low values | M |
| 12.4 | Implement BloatAuditor class | Count crons/scripts, find orphans, detect overlaps, check state size | L |
| 12.5 | Add weekly bloat audit scheduled task | Cron every Sunday, write to NOTES.md and audit log, remediation guidance | M |
| 12.6 | Implement MECEValidator class | Check schedule overlap, name similarity, require purpose header | M |
| 12.7 | Integrate MECE validation with task creation | Hook into beforeTaskCreate, block violating tasks with suggestions | M |
| 12.8 | Implement MetaSchedulerMonitor | Check heartbeat, detect stalls > 30min, auto-restart, log recovery | M |
| 12.9 | Create non-LLM health check script | Shell script for R2 mount, WAL size, scheduler heartbeat, integrity | S |
| 12.10 | Implement ContextTracker class | Track token usage, emit warnings at 60/70/80% thresholds | S |
| 12.11 | Add .loa.config.yaml operational hardening section | Configuration schema for all FR-6 to FR-11 settings | S |
| 12.12 | **Implement NotificationSink interface** | Unified alerting for critical events, Slack/Discord/webhook support | M |
| 12.13 | **Add ownership mode to MetaMonitor** | Prevent systemd conflict, standalone vs systemd_notify modes | S |
| 12.14 | **Add health script timeout wrapper** | Self-timeout protection (30s default), exit code 124 on timeout | S |

**Deliverables**:
- `deploy/loa-identity/scheduler/timeout-enforcer.ts`
- `deploy/loa-identity/scheduler/bloat-auditor.ts`
- `deploy/loa-identity/scheduler/mece-validator.ts`
- `deploy/loa-identity/scheduler/meta-monitor.ts`
- `deploy/loa-identity/scheduler/notification-sink.ts` (Flatline review)
- `deploy/loa-identity/memory/context-tracker.ts`
- `deploy/loa-identity/scripts/health-check.sh` (with timeout wrapper)
- `.loa.config.yaml` (updated with notifications)

**Rollback Procedure**:
- Disable operational hardening via `.loa.config.yaml` flags
- Set all `enabled: false` in operational_hardening section
- Verification: Scheduler runs without hardening checks

---

## Task Size Legend

| Size | Description | Estimate |
|------|-------------|----------|
| S | Small - Simple, well-defined | 1-2 hours |
| M | Medium - Some complexity | 2-4 hours |
| L | Large - Complex, multiple components | 4-8 hours |

---

## Dependencies Graph

```
Sprint 6: Security Foundation
    │
    ├──► ManifestSigner ─────────────────────────┐
    ├──► AllowlistSigner ────────────────────────┤
    ├──► PIIRedactor ────────────────┐           │
    └──► AuditLogger ─────────────────┤           │
                                      │           │
Sprint 7: Identity & Memory Core ◄────┘           │
    │                                             │
    ├──► WALManager ────────────────────────┐     │
    ├──► SessionMemoryManager ──────────────┤     │
    └──► IdentityLoader ────────────────────┤     │
                                            │     │
Sprint 8: Consolidation Engine ◄────────────┘     │
    │                                             │
    ├──► EmbeddingService ──────────────────┐     │
    └──► ConsolidationEngine ───────────────┤     │
                                            │     │
Sprint 9: Recovery Engine (MVP) ◄───────────┴─────┘
    │
    ├──► RecoveryEngine (uses ManifestSigner)
    ├──► R2Client
    └──► GitClient
           │
Sprint 10: Self-Repair Engine ◄─────────────┘
    │
    └──► SelfRepairEngine (uses AllowlistSigner)
           │
Sprint 11: Integration & Skills ◄───────────┘
    │
    └──► Scheduler base + skills
           │
Sprint 12: Operational Hardening ◄──────────┘
    │
    ├──► TimeoutEnforcer (integrates with scheduler)
    ├──► BloatAuditor (scheduled task)
    ├──► MECEValidator (task creation hook)
    ├──► MetaSchedulerMonitor (watchdog)
    └──► ContextTracker (memory integration)
```

---

## Risk Mitigation

| Risk | Sprint | Mitigation |
|------|--------|------------|
| Ed25519 library compatibility | 6 | Use @noble/ed25519 (pure JS, no native deps) |
| **Key compromise** | 6 | Multi-key verification, rotation procedure, incident response runbook |
| **Canonical JSON inconsistency** | 6 | RFC 8785 JCS standard, single shared library, golden test vectors |
| Python embedding service startup | 8 | Pre-warm in Dockerfile, health check endpoint |
| **Lexical fallback divergence** | 8 | Golden test suite, queue-based degradation, monitoring |
| **WAL rotation crash** | 7 | Two-phase commit, checkpoint-based replay, corruption handling |
| **flock/fsync filesystem issues** | 7 | Document supported filesystems, PID lock, integration test matrix |
| R2 SDK complexity | 9 | Use @aws-sdk/client-s3 with R2 endpoint |
| **R2 ETag integrity weakness** | 9 | SHA-256 checksums in signed manifest, signature verification first |
| **Loop detection false positives** | 9 | Configurable thresholds via env vars, documented tuning guidance |
| **Self-repair supply chain** | 10 | Sandboxed execution, cryptographic approvals, threat model tests |
| **Scheduler resource contention** | 11 | Circuit breakers, jitter, mutual exclusion, job leases |
| Signing key distribution | 6 | Public key embedded in image, private via Secrets |
| **Subagent timeout crashes** | 12 | TimeoutEnforcer with 30min minimum, 3min hard floor |
| **Cron/script proliferation** | 12 | BloatAuditor weekly audit, 20/50 caps |
| **Task redundancy/overlap** | 12 | MECEValidator blocks duplicates at creation |
| **Scheduler silent failures** | 12 | MetaSchedulerMonitor with auto-restart |
| **Context overflow surprise** | 12 | ContextTracker with 60/70/80% warnings |

---

## Testing Strategy

### Per-Sprint Testing

| Sprint | Test Focus |
|--------|------------|
| 6 | Unit tests for signing, redaction patterns, entropy detection, **key rotation verification**, **multi-key verification** |
| 7 | WAL replay, quality gate edge cases, atomic write verification, **rotation crash recovery**, **filesystem compatibility** |
| 8 | Dedup accuracy, fallback triggering, consolidation correctness, **lexical fallback golden tests**, **queue drain** |
| 9 | State machine transitions, failure loop detection, restore integrity, **SHA-256 verification**, **configurable threshold tests** |
| 10 | Allowlist validation, non-root execution, approval flow, **threat model abuse cases**, **sandbox escape tests** |
| 11 | End-to-end startup, skill invocation, scheduled task execution, **circuit breaker transitions**, **job mutual exclusion** |
| 12 | Timeout enforcement edge cases, **bloat detection accuracy**, **MECE overlap detection**, **meta-monitor restart**, **context threshold warnings** |

### Integration Tests

- Full recovery cycle (container restart → R2 restore → verify)
- Memory capture → consolidation → search flow
- Self-repair approval workflow
- **Key rotation with historical artifact verification**
- **Embedding service outage → queue → recovery flow**
- **WAL segment rotation under load**
- **Scheduler circuit breaker open/half-open/closed transitions**
- **Timeout enforcement with model detection**
- **Bloat audit finding orphaned scripts**
- **MECE validation blocking overlapping crons**
- **Meta-monitor auto-restart on stall**

### Security Tests

- **Threat model tests**: malicious NOTES.md, compromised allowlist, command injection
- **Sandbox escape tests**: network access, filesystem writes, shell expansion
- **Replay attack tests**: approval nonce reuse, manifest signature replay

---

## Success Criteria

### MVP (Sprint 9 Complete)
- [ ] Container starts without human intervention after wipe
- [ ] State integrity verified with Ed25519 signatures AND SHA-256 checksums
- [ ] R2 → Git → Template fallback chain operational
- [ ] Loop detection prevents infinite restore cycles (configurable thresholds)
- [ ] BEAUVOIR.md personality loaded and active
- [ ] Key rotation procedure documented and tested

### Full Implementation (Sprint 11 Complete)
- [ ] Two-phase memory consolidation operational with queue-based degradation
- [ ] Proactive self-repair with sandboxed execution and cryptographic approvals
- [ ] All 6 management skills functional
- [ ] Scheduled tasks running with jitter and circuit breakers
- [ ] PII redaction with entropy detection active
- [ ] Lexical fallback golden tests passing
- [ ] Threat model tests passing

### Production Hardening (Sprint 12 Complete)
- [ ] Zero timeout-related subagent crashes (FR-6)
- [ ] Weekly bloat audit runs automatically (FR-7)
- [ ] Cron count stays below 20, script count below 50 (FR-7)
- [ ] No MECE violation incidents (FR-8)
- [ ] Scheduler stalls detected and auto-recovered (FR-9)
- [ ] Context warnings emitted at 60/70/80% thresholds (FR-10)
- [ ] Non-LLM health checks reduce API calls by 50%+ (FR-11)
- [ ] .loa.config.yaml operational hardening section documented

---

## Appendix A: File Structure

```
deploy/loa-identity/
├── identity-loader.ts
├── wal/
│   └── wal-manager.ts
├── memory/
│   ├── session-manager.ts
│   ├── consolidation-engine.ts
│   ├── consolidation-queue.ts
│   ├── embedding-client.ts
│   ├── quality-gates.ts
│   └── context-tracker.ts
├── recovery/
│   ├── recovery-engine.ts
│   ├── r2-client.ts
│   ├── git-client.ts
│   └── run.js
├── repair/
│   ├── self-repair-engine.ts
│   ├── package-checker.ts
│   ├── approval-verifier.ts
│   └── sandbox.ts
├── security/
│   ├── manifest-signer.ts
│   ├── allowlist-signer.ts
│   ├── key-manager.ts
│   ├── pii-redactor.ts
│   ├── secret-scanner.ts
│   ├── credential-manager.ts
│   └── audit-logger.ts
├── scheduler/
│   ├── scheduler.ts
│   ├── circuit-breaker.ts
│   ├── timeout-enforcer.ts
│   ├── bloat-auditor.ts
│   ├── mece-validator.ts
│   ├── meta-monitor.ts
│   └── notification-sink.ts
├── scripts/
│   └── health-check.sh
├── embedding-service/
│   ├── main.py
│   └── requirements.txt
└── skills/
    ├── recovery-status.md
    ├── force-restore.md
    ├── consolidate-memory.md
    ├── memory-stats.md
    └── approve-repair.md

grimoires/loa/
├── BEAUVOIR.md
├── memory/
│   ├── consolidation.log
│   └── archive/
└── .loa-state-manifest.json

.loa/
└── allowed-packages.yaml

docs/
├── runbooks/
│   └── key-compromise-response.md
├── deployment/
│   └── filesystem-requirements.md
└── configuration/
    └── recovery-tuning.md

tests/
├── memory/
│   └── lexical-fallback.test.ts
└── repair/
    └── threat-model.test.ts

scripts/
└── generate-signing-keys.sh
```

---

## Appendix B: Flatline Protocol Review

**Review Date**: 2026-02-03 (v0.2.0), 2026-02-03 (v0.3.0 operational hardening)
**Models**: Claude Opus 4.5 + GPT-5.2
**Agreement**: 100%
**Cost**: ~$0.75 (v0.2.0)

### High Consensus Improvements (Integrated)

| ID | Issue | Resolution |
|----|-------|------------|
| IMP-001 | No rollback/runbook steps per sprint | Added rollback procedure to each sprint |
| IMP-002 | Configurable thresholds without defaults | Added default values (3 failures/10 min), env var configuration |
| IMP-003 | Embedding service crash mid-run behavior | Added consolidation queue, max 4-hour queue age |
| IMP-004 | Key rotation unspecified | Added key lifecycle (90-day rotation, 7-day overlap, multi-key verification) |
| IMP-007 | NOTES.md concurrent write risk | Addressed via single-writer architecture with PID lock |

### Critical Blockers Addressed

| ID | Concern | Resolution |
|----|---------|------------|
| SKP-001 | No key compromise recovery | Added incident response runbook, multi-key verification, revocation procedure |
| SKP-002 | Lexical fallback semantics differ | Added golden test suite, queue-based degradation instead of immediate fallback |
| SKP-003 | WAL rotation crash window | Added two-phase commit, checkpoint-based recovery, corruption handling |
| SKP-004 | R2 ETag insufficient (MD5) | Changed to SHA-256 checksums in signed manifest, ETag for change detection only |
| SKP-005 | Scheduler too aggressive | Added jitter, circuit breakers, mutual exclusion, rate limiting |
| SKP-010 | Self-repair RCE/supply-chain risk | Added sandboxed execution, cryptographic approvals, threat model tests |
| JSON canon | Inconsistent serialization | Adopted RFC 8785 JCS standard with single shared library |
| flock/fsync | Filesystem compatibility | Documented supported filesystems, added PID lock, integration test matrix |

### Operational Hardening Additions (v0.3.0)

Based on PRD v0.3.0 FR-6 through FR-11, sourced from:
- `grimoires/loa/context/openclaw-starter-kit-analysis.md`
- Operator production learnings (timeout, bloat, MECE)

| ID | Requirement | Resolution |
|----|-------------|------------|
| FR-6 | Subagent timeout crashes | TimeoutEnforcer with 30min trusted model minimum, 3min hard floor |
| FR-7 | Cron/script proliferation | BloatAuditor weekly with 20/50 caps, orphan detection |
| FR-8 | Task redundancy | MECEValidator blocks overlapping crons, similar scripts |
| FR-9 | Scheduler silent failures | MetaSchedulerMonitor with auto-restart |
| FR-10 | Context overflow | ContextTracker with 60/70/80% warnings |
| FR-11 | API call waste | Non-LLM health-check.sh for routine monitoring |

### Flatline Review High-Consensus Additions (v0.3.0)

| ID | Issue | Resolution |
|----|-------|------------|
| IMP-001 | MetaMonitor/systemd conflict | Added `ownershipMode` to prevent fight over scheduler control |
| IMP-005 | No alerting mechanism | Added NotificationSink with Slack/Discord/webhook support |
| SKP-005 | Health script could hang | Added self-timeout wrapper (30s default) |

---

*Generated by Loa Framework v1.22.0*
