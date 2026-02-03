# SDD: Beauvoir Personality & Resilience

> **Status**: Draft
> **Version**: 0.3.0
> **Created**: 2026-02-03
> **Updated**: 2026-02-03
> **PRD Reference**: `grimoires/loa/prd.md` v0.3.0
> **Author**: Claude Opus 4.5
> **Reviewed**: Flatline Protocol (GPT-5.2 + Opus, 100% agreement)

---

## Executive Summary

This document details the technical architecture for implementing Beauvoir's resilience layer - a system that ensures personality continuity, auto-recovery from failures, and durable memory across sessions. The design prioritizes:

1. **Auto-recovery** - Boot without human intervention after wipes/restarts
2. **Two-phase memory** - Capture fast, consolidate durable patterns with fallback strategies
3. **Proactive self-repair** - Fix missing dependencies within cryptographically-verified security guardrails
4. **Privacy-first** - Redact sensitive data at capture time with entropy-based detection
5. **Defense-in-depth** - Signed manifests, single-writer architecture, non-root execution

---

## 1. System Architecture

### 1.1 High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        BEAUVOIR RESILIENCE LAYER                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────┐   ┌───────────────────┐   ┌───────────────────────┐ │
│  │  Identity Engine  │   │   Memory Engine   │   │   Recovery Engine     │ │
│  │                   │   │                   │   │                       │ │
│  │  ┌─────────────┐  │   │  ┌─────────────┐  │   │  ┌─────────────────┐  │ │
│  │  │ BEAUVOIR.md │  │   │  │Session Layer│  │   │  │ State Validator │  │ │
│  │  │ (Personality)│  │   │  │  NOTES.md   │  │   │  │ (Hash Verify)   │  │ │
│  │  └─────────────┘  │   │  └──────┬──────┘  │   │  └────────┬────────┘  │ │
│  │                   │   │         │         │   │           │           │ │
│  │  ┌─────────────┐  │   │         ▼         │   │  ┌────────▼────────┐  │ │
│  │  │Personality  │  │   │  ┌─────────────┐  │   │  │ Recovery State  │  │ │
│  │  │ Principles  │  │   │  │Consolidation│  │   │  │    Machine      │  │ │
│  │  └─────────────┘  │   │  │   Engine    │  │   │  └────────┬────────┘  │ │
│  │                   │   │  └──────┬──────┘  │   │           │           │ │
│  └───────────────────┘   │         │         │   │  ┌────────▼────────┐  │ │
│                          │         ▼         │   │  │   Self-Repair   │  │ │
│                          │  ┌─────────────┐  │   │  │     Engine      │  │ │
│                          │  │ Durable     │  │   │  └─────────────────┘  │ │
│                          │  │ memory/*.md │  │   │                       │ │
│                          │  └─────────────┘  │   └───────────────────────┘ │
│                          │                   │                              │
│                          └───────────────────┘                              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         PERSISTENCE LAYER                            │   │
│  │                                                                      │   │
│  │   ┌──────────┐      ┌──────────┐      ┌──────────┐      ┌────────┐  │   │
│  │   │   WAL    │─────►│  Local   │─────►│    R2    │─────►│  Git   │  │   │
│  │   │(Segmented│      │   FS     │      │ (Hot)    │      │ (Cold) │  │   │
│  │   │+ Locked) │      │          │      │ +ETag    │      │+Signed │  │   │
│  │   └──────────┘      └──────────┘      └──────────┘      └────────┘  │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         SECURITY LAYER                               │   │
│  │                                                                      │   │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │   │
│  │   │ PII Redactor │    │Secret Scanner│    │  Package Allowlist   │  │   │
│  │   │(Capture-time)│    │ (Pre-commit) │    │  (Ed25519 Signed)    │  │   │
│  │   │ +Entropy Det │    │ +Entropy Det │    │  (Non-root install)  │  │   │
│  │   └──────────────┘    └──────────────┘    └──────────────────────┘  │   │
│  │                                                                      │   │
│  │   ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │   │
│  │   │  Manifest    │    │  Credential  │    │    Audit Logger      │  │   │
│  │   │   Signer     │    │   Manager    │    │  (Tamper-evident)    │  │   │
│  │   │  (Ed25519)   │    │ (Scoped IAM) │    │                      │  │   │
│  │   └──────────────┘    └──────────────┘    └──────────────────────┘  │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MEMORY DATA FLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User Interaction                                                           │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────┐                                                        │
│  │  PII Redactor   │◄──── Pattern matching (API keys, emails, etc.)         │
│  └────────┬────────┘                                                        │
│           │                                                                 │
│           ▼                                                                 │
│  ┌─────────────────┐      ┌─────────────────┐                               │
│  │  Session Write  │─────►│  WAL Append     │                               │
│  │  (NOTES.md)     │      │  + fsync        │                               │
│  └────────┬────────┘      └─────────────────┘                               │
│           │                                                                 │
│           │◄───────────────────────────────────── Every write               │
│           │                                                                 │
│           ▼                                                                 │
│  ┌─────────────────┐                                                        │
│  │  R2 Sync        │◄──── Every 30 seconds                                  │
│  └─────────────────┘                                                        │
│                                                                             │
│  ══════════════════════════════════════════════════════════════════════════ │
│  PHASE 2: CONSOLIDATION (Hourly or on conversation end)                     │
│  ══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│  ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐     │
│  │  Quality Gates  │─────►│  Embedding Gen  │─────►│ Semantic Dedup  │     │
│  │  (Reject noise) │      │ (MiniLM-L6-v2)  │      │ (0.85 threshold)│     │
│  └─────────────────┘      └─────────────────┘      └────────┬────────┘     │
│                                                              │              │
│                                                              ▼              │
│                                                   ┌─────────────────┐       │
│                                                   │  memory/*.md    │       │
│                                                   │  (Durable)      │       │
│                                                   └────────┬────────┘       │
│                                                            │               │
│                                                            ▼               │
│                                                   ┌─────────────────┐       │
│                                                   │  Git Commit     │       │
│                                                   └─────────────────┘       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Recovery State Machine

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      RECOVERY STATE MACHINE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                           ┌─────────────┐                                   │
│                           │    START    │                                   │
│                           └──────┬──────┘                                   │
│                                  │                                          │
│                                  ▼                                          │
│                      ┌───────────────────────┐                              │
│                      │   CHECK_INTEGRITY     │                              │
│                      │   (Load manifest,     │                              │
│                      │    verify hashes)     │                              │
│                      └───────────┬───────────┘                              │
│                                  │                                          │
│              ┌───────────────────┼───────────────────┐                      │
│              │ VALID             │ MISSING           │ MISMATCH             │
│              ▼                   ▼                   ▼                      │
│       ┌──────────┐        ┌──────────┐        ┌──────────┐                  │
│       │ RUNNING  │        │ TRY_R2   │        │ TRY_R2   │                  │
│       └──────────┘        └────┬─────┘        └────┬─────┘                  │
│                                │                   │                        │
│                    ┌───────────┴───────────┐       │                        │
│                    │                       │       │                        │
│              R2 OK + VALID          R2 FAIL/CORRUPT                         │
│                    │                       │       │                        │
│                    ▼                       ▼       ▼                        │
│             ┌──────────┐            ┌──────────────────┐                    │
│             │RESTORE_R2│            │     TRY_GIT      │                    │
│             └────┬─────┘            └────────┬─────────┘                    │
│                  │                           │                              │
│                  ▼                ┌──────────┴──────────┐                   │
│             ┌──────────┐         │                      │                   │
│             │ RUNNING  │    GIT OK + VALID         GIT FAIL/CORRUPT         │
│             └──────────┘         │                      │                   │
│                                  ▼                      ▼                   │
│                           ┌──────────┐         ┌───────────────┐            │
│                           │RESTORE_GIT│         │ TEMPLATE_INIT │            │
│                           └────┬─────┘         └───────┬───────┘            │
│                                │                       │                    │
│                                ▼                       ▼                    │
│                           ┌──────────┐         ┌──────────────┐             │
│                           │ RUNNING  │         │DEGRADED_MODE │             │
│                           └──────────┘         └──────┬───────┘             │
│                                                       │                     │
│                                              (retry_count >= 3)             │
│                                                       │                     │
│                                                       ▼                     │
│                                              ┌───────────────┐              │
│                                              │ ALERT_HUMAN   │              │
│                                              │ (Log + notify)│              │
│                                              └───────────────┘              │
│                                                                             │
│  ═══════════════════════════════════════════════════════════════════════    │
│  Loop Detection: If 3 restore FAILURES within 10 minutes → DEGRADED_MODE   │
│  (Count failures, not attempts. Valid local state skips restore entirely)  │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.4 Concurrency Model (Single-Writer Architecture)

**Design Decision**: Single-writer pattern to avoid WAL corruption and race conditions.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SINGLE-WRITER ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                    WRITE COORDINATOR (Single Process)                 │  │
│  │                                                                       │  │
│  │   All writes serialized through coordinator:                         │  │
│  │   - Memory capture → WAL append → NOTES.md update                    │  │
│  │   - Consolidation → Monthly file → Session clear                     │  │
│  │   - Manifest regen → Atomic write (temp + rename)                    │  │
│  │   - R2 sync → ETag verification                                      │  │
│  │                                                                       │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│              ┌────────────────────┼────────────────────┐                   │
│              │                    │                    │                   │
│              ▼                    ▼                    ▼                   │
│       ┌──────────┐         ┌──────────┐         ┌──────────┐              │
│       │ Memory   │         │  WAL     │         │ Manifest │              │
│       │ Capture  │         │ Manager  │         │  Regen   │              │
│       │ Queue    │         │ (flock)  │         │          │              │
│       └──────────┘         └──────────┘         └──────────┘              │
│                                                                             │
│  LOCKING STRATEGY:                                                          │
│  - WAL: flock(LOCK_EX) on segment file during append                       │
│  - NOTES.md: Write to .tmp, atomic rename                                  │
│  - Manifest: Write to .tmp, atomic rename                                  │
│  - Consolidation: Global lock during execution                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.5 Credential Management Architecture

**Requirement**: Secure storage and rotation for R2 and other service credentials.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CREDENTIAL MANAGEMENT                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  CREDENTIAL SOURCES (Priority Order):                                       │
│  1. Cloudflare Secrets (encrypted at rest, scoped to worker)               │
│  2. Environment variables (container injection)                             │
│  3. Local .env file (development only, never in production)                │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  R2 Credentials                                                      │   │
│  │                                                                      │   │
│  │  Storage:      Cloudflare Secrets (R2_ACCESS_KEY_ID,                │   │
│  │                R2_SECRET_ACCESS_KEY)                                 │   │
│  │  Scope:        Read/write to loa-beauvoir-data bucket only          │   │
│  │  Rotation:     Manual, via Cloudflare dashboard                     │   │
│  │  Least Priv:   No ListAllBuckets, no cross-bucket access            │   │
│  │  Audit:        Cloudflare audit logs for credential access          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Ed25519 Signing Keys (for manifests/allowlists)                    │   │
│  │                                                                      │   │
│  │  Private Key:  Cloudflare Secrets (LOA_SIGNING_KEY)                 │   │
│  │  Public Key:   Embedded in container image (verify only)            │   │
│  │  Usage:        Sign manifests and allowlists at write time          │   │
│  │  Verification: Verify on load, reject unsigned/invalid              │   │
│  │  Rotation:     Generate new keypair, update image + secrets         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  NEVER STORED:                                                              │
│  - API keys (Anthropic, OpenAI) - injected at runtime only                 │
│  - User passwords or tokens                                                 │
│  - Private keys in grimoires or memory                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Design

### 2.1 Identity Engine

**Purpose**: Manage Beauvoir's personality document and ensure principle-driven behavior.

**File**: `grimoires/loa/BEAUVOIR.md`

**Schema**:
```markdown
# Beauvoir - Identity Document

## Core Principles (Why I Behave This Way)
<!-- Explained motivations that can generalize to new contexts -->

## Operational Stance
<!-- Procedural, verification-first approach -->

## Interaction Style
<!-- Concise, opinionated, resourceful -->

## Boundaries
<!-- What I won't do and why -->

## Self-Evolution
<!-- How this document changes over time -->
```

**Identity Loader** (`deploy/loa-identity/identity-loader.ts`):

```typescript
interface BeauvoirIdentity {
  principles: Principle[];
  operationalStance: string;
  interactionStyle: InteractionStyle;
  boundaries: Boundary[];
  evolutionRules: EvolutionRule[];
  lastModified: Date;
  version: string;
}

interface Principle {
  name: string;
  why: string;        // Explanation, not just rule
  examples: string[]; // How it applies
}

interface InteractionStyle {
  concise: boolean;
  opinionated: boolean;
  resourceful: boolean;
  procedural: boolean;
  transparent: boolean;
}

interface Boundary {
  action: string;
  reason: string;
  exceptions?: string[];
}

interface EvolutionRule {
  trigger: string;
  change: string;
  approval: 'auto' | 'human';
}

class IdentityLoader {
  private identityPath = '/workspace/grimoires/loa/BEAUVOIR.md';

  async load(): Promise<BeauvoirIdentity> {
    const content = await fs.readFile(this.identityPath, 'utf-8');
    return this.parseIdentity(content);
  }

  async update(changes: Partial<BeauvoirIdentity>): Promise<void> {
    const current = await this.load();
    const updated = { ...current, ...changes, lastModified: new Date() };

    // Log change to NOTES.md
    await this.logIdentityChange(current, updated);

    // Write updated identity
    await this.writeIdentity(updated);
  }

  private async logIdentityChange(
    before: BeauvoirIdentity,
    after: BeauvoirIdentity
  ): Promise<void> {
    const diff = this.computeDiff(before, after);
    const entry = `| ${new Date().toISOString()} | identity | ${diff} |`;
    await this.appendToNotes(entry);
  }
}
```

### 2.2 Memory Engine

**Purpose**: Implement two-phase memory with session capture and durable consolidation.

#### 2.2.1 Session Memory Manager

```typescript
// deploy/loa-identity/memory/session-manager.ts

interface MemoryEntry {
  id: string;
  type: 'decision' | 'fact' | 'preference' | 'pattern' | 'error';
  content: string;
  source: 'conversation' | 'observation' | 'inference';
  confidence: number;  // 0.0 - 1.0
  timestamp: Date;
  scope: 'project' | 'global';
  tags: string[];
  embedding?: number[];  // 384-dim MiniLM vector
}

interface QualityGate {
  name: string;
  check: (entry: MemoryEntry) => boolean;
  action: 'reject' | 'redact' | 'warn';
}

class SessionMemoryManager {
  private notesPath = '/workspace/grimoires/loa/NOTES.md';
  private walPath = '/data/wal/memory.wal';
  private redactor: PIIRedactor;
  private qualityGates: QualityGate[];

  constructor() {
    this.redactor = new PIIRedactor();
    this.qualityGates = this.initializeGates();
  }

  async capture(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<string | null> {
    // Step 1: Redact PII
    const redacted = await this.redactor.process(entry.content);
    if (redacted.blocked) {
      console.log(`[memory] Entry blocked: ${redacted.reason}`);
      return null;
    }

    const fullEntry: MemoryEntry = {
      ...entry,
      id: this.generateId(),
      timestamp: new Date(),
      content: redacted.content,
    };

    // Step 2: Quality gates
    for (const gate of this.qualityGates) {
      if (!gate.check(fullEntry)) {
        if (gate.action === 'reject') {
          console.log(`[memory] Entry rejected by ${gate.name}`);
          return null;
        }
        if (gate.action === 'warn') {
          console.log(`[memory] Warning from ${gate.name}`);
        }
      }
    }

    // Step 3: Write to WAL
    await this.appendToWAL(fullEntry);

    // Step 4: Update NOTES.md
    await this.appendToNotes(fullEntry);

    return fullEntry.id;
  }

  private initializeGates(): QualityGate[] {
    return [
      {
        name: 'temporal',
        check: (e) => !/(today|this time|just now|right now)/i.test(e.content),
        action: 'reject',
      },
      {
        name: 'speculation',
        check: (e) => {
          const speculative = /(might be|probably|I think|maybe)/i.test(e.content);
          return !speculative || e.confidence >= 0.8;
        },
        action: 'reject',
      },
      {
        name: 'instruction',
        check: (e) => !this.looksLikeInstruction(e.content),
        action: 'reject',
      },
      {
        name: 'confidence',
        check: (e) => e.confidence >= 0.5,
        action: 'reject',
      },
    ];
  }

  /**
   * Append to WAL with proper locking and consistent schema
   * Schema matches Section 3.2: seq, base64 data, SHA256 checksum
   */
  private async appendToWAL(entry: MemoryEntry): Promise<void> {
    // Acquire exclusive lock on WAL segment
    const lockFd = await this.acquireWALLock();

    try {
      // Get next sequence number from current segment
      const seq = await this.getNextSequenceNumber();

      // Encode data as base64 (matches schema specification)
      const jsonData = JSON.stringify(entry);
      const base64Data = Buffer.from(jsonData).toString('base64');

      const walEntry: WALEntry = {
        ts: Date.now(),
        seq,
        op: 'write',
        path: 'session',
        data: base64Data,
        checksum: this.sha256(base64Data),  // Checksum of base64 data
      };

      const line = JSON.stringify(walEntry) + '\n';
      await fs.appendFile(this.walPath, line);
      await this.fsync(this.walPath);

      // Check if segment rotation needed
      await this.maybeRotateSegment();

    } finally {
      // Release lock
      await this.releaseWALLock(lockFd);
    }
  }

  /**
   * Acquire exclusive flock on WAL segment
   */
  private async acquireWALLock(): Promise<number> {
    const fd = await fs.open(this.walPath + '.lock', 'w');
    await flock(fd.fd, LOCK_EX);
    return fd.fd;
  }

  /**
   * Release flock
   */
  private async releaseWALLock(fd: number): Promise<void> {
    await flock(fd, LOCK_UN);
    await fs.close(fd);
  }
}
```

#### 2.2.2 Memory Consolidation Engine

**Runtime Environment**: Python 3.11+ sidecar service (pre-installed in container).

**Embedding Strategy**: Semantic embeddings with lexical fallback.

```typescript
// deploy/loa-identity/memory/consolidation-engine.ts

interface ConsolidationResult {
  promoted: number;
  deduplicated: number;
  rejected: number;
  merged: MergeRecord[];
  fallbackUsed: boolean;  // True if lexical dedup was used
}

interface MergeRecord {
  kept: string;
  discarded: string;
  similarity: number;
  reason: string;
  method: 'semantic' | 'lexical';  // Which dedup method was used
}

interface EmbeddingService {
  generateEmbeddings(texts: string[]): Promise<number[][] | null>;
  isAvailable(): Promise<boolean>;
}

class ConsolidationEngine {
  private embeddingService: EmbeddingService;
  private similarityThreshold = 0.85;
  private lexicalThreshold = 0.80;  // Jaccard threshold for fallback
  private memoryDir = '/workspace/grimoires/loa/memory';
  private auditLog = '/workspace/grimoires/loa/memory/consolidation.log';

  constructor(embeddingService: EmbeddingService) {
    this.embeddingService = embeddingService;
  }

  /**
   * Python embedding service wrapper
   * Calls pre-installed sentence-transformers via HTTP on localhost:8384
   * Model: all-MiniLM-L6-v2 (pre-cached in container image)
   */
  static async createWithPythonService(): Promise<ConsolidationEngine> {
    const service = new PythonEmbeddingService('http://localhost:8384');
    return new ConsolidationEngine(service);
  }

  async consolidate(): Promise<ConsolidationResult> {
    // Step 1: Load session entries from NOTES.md
    const sessionEntries = await this.loadSessionEntries();

    // Step 2: Load existing durable memories
    const durableEntries = await this.loadDurableEntries();

    // Step 3: Check embedding service availability
    const embeddingsAvailable = await this.embeddingService.isAvailable();
    let fallbackUsed = false;
    let unique: MemoryEntry[];
    let merged: MergeRecord[];

    if (embeddingsAvailable) {
      // Step 4a: Generate embeddings for new entries
      const embeddings = await this.embeddingService.generateEmbeddings(
        sessionEntries.map(e => e.content)
      );

      if (embeddings) {
        // Attach embeddings to entries
        sessionEntries.forEach((entry, i) => {
          entry.embedding = embeddings[i];
        });

        // Step 5a: Semantic deduplication
        ({ unique, merged } = await this.deduplicateEntriesSemantic(
          sessionEntries,
          durableEntries
        ));
      } else {
        // Embedding generation failed, use fallback
        fallbackUsed = true;
        ({ unique, merged } = this.deduplicateEntriesLexical(
          sessionEntries,
          durableEntries
        ));
      }
    } else {
      // Step 4b/5b: Fallback to lexical deduplication
      console.log('[consolidation] Embedding service unavailable, using lexical fallback');
      fallbackUsed = true;
      ({ unique, merged } = this.deduplicateEntriesLexical(
        sessionEntries,
        durableEntries
      ));
    }

    // Step 6: Apply quality gates (stricter for consolidation)
    const { passed, rejected } = this.applyConsolidationGates(unique);

    // Step 7: Write to monthly file (atomic via temp + rename)
    const monthFile = this.getMonthlyFile();
    await this.appendToMonthlyFileAtomic(monthFile, passed);

    // Step 8: Log audit trail
    await this.logConsolidation({ promoted: passed, merged, rejected, fallbackUsed });

    // Step 9: Clear session memory section
    await this.clearSessionMemory();

    return {
      promoted: passed.length,
      deduplicated: merged.length,
      rejected: rejected.length,
      merged,
      fallbackUsed,
    };
  }

  /**
   * Lexical deduplication using Jaccard similarity
   * Fallback when embedding service is unavailable
   */
  private deduplicateEntriesLexical(
    newEntries: MemoryEntry[],
    existingEntries: MemoryEntry[]
  ): { unique: MemoryEntry[], merged: MergeRecord[] } {
    const unique: MemoryEntry[] = [];
    const merged: MergeRecord[] = [];

    for (const entry of newEntries) {
      let isDuplicate = false;

      for (const existing of existingEntries) {
        const similarity = this.jaccardSimilarity(
          entry.content,
          existing.content
        );

        if (similarity >= this.lexicalThreshold) {
          isDuplicate = true;
          const keepNew = entry.confidence > existing.confidence ||
            (entry.confidence === existing.confidence &&
             entry.timestamp > existing.timestamp);

          merged.push({
            kept: keepNew ? entry.id : existing.id,
            discarded: keepNew ? existing.id : entry.id,
            similarity,
            reason: keepNew ? 'newer+same_confidence' : 'lower_confidence',
            method: 'lexical',
          });

          if (keepNew) {
            entry.tags = [...new Set([...entry.tags, ...existing.tags])];
            unique.push(entry);
            const idx = existingEntries.indexOf(existing);
            existingEntries.splice(idx, 1);
          }
          break;
        }
      }

      if (!isDuplicate) {
        unique.push(entry);
      }
    }

    return { unique, merged };
  }

  /**
   * Jaccard similarity between two text strings
   * Uses word-level tokenization
   */
  private jaccardSimilarity(a: string, b: string): number {
    const tokenize = (s: string) => new Set(
      s.toLowerCase().split(/\s+/).filter(t => t.length > 2)
    );
    const setA = tokenize(a);
    const setB = tokenize(b);
    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    return intersection.size / union.size;
  }

  /**
   * Semantic deduplication using embedding cosine similarity
   * Primary method when embedding service is available
   */
  private async deduplicateEntriesSemantic(
    newEntries: MemoryEntry[],
    existingEntries: MemoryEntry[]
  ): Promise<{ unique: MemoryEntry[], merged: MergeRecord[] }> {
    const unique: MemoryEntry[] = [];
    const merged: MergeRecord[] = [];

    for (const entry of newEntries) {
      let isDuplicate = false;

      for (const existing of existingEntries) {
        const similarity = this.cosineSimilarity(
          entry.embedding!,
          existing.embedding!
        );

        if (similarity >= this.similarityThreshold) {
          isDuplicate = true;

          // Recency-wins: keep newer if equal confidence
          const keepNew = entry.confidence > existing.confidence ||
            (entry.confidence === existing.confidence &&
             entry.timestamp > existing.timestamp);

          merged.push({
            kept: keepNew ? entry.id : existing.id,
            discarded: keepNew ? existing.id : entry.id,
            similarity,
            reason: keepNew ? 'newer+same_confidence' : 'lower_confidence',
            method: 'semantic',
          });

          if (keepNew) {
            // Merge tags from both
            entry.tags = [...new Set([...entry.tags, ...existing.tags])];
            unique.push(entry);
            // Remove old from existing
            const idx = existingEntries.indexOf(existing);
            existingEntries.splice(idx, 1);
          }

          break;
        }
      }

      if (!isDuplicate) {
        unique.push(entry);
      }
    }

    return { unique, merged };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private getMonthlyFile(): string {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${this.memoryDir}/${year}-${month}.md`;
  }
}
```

### 2.3 Recovery Engine

**Purpose**: Implement auto-recovery state machine with integrity verification.

```typescript
// deploy/loa-identity/recovery/recovery-engine.ts

interface StateManifest {
  version: 1;
  generated_at: string;
  files: Record<string, FileManifestEntry>;
  restore_count: number;
  last_restore_source: 'r2' | 'git' | 'template' | null;
}

interface FileManifestEntry {
  sha256: string;
  size_bytes: number;
  mtime: string;
}

type RecoveryState =
  | 'START'
  | 'CHECK_INTEGRITY'
  | 'TRY_R2'
  | 'RESTORE_R2'
  | 'TRY_GIT'
  | 'RESTORE_GIT'
  | 'TEMPLATE_INIT'
  | 'DEGRADED_MODE'
  | 'ALERT_HUMAN'
  | 'RUNNING';

interface RecoveryConfig {
  retryWindow: number;      // ms, default 10 minutes
  maxFailures: number;      // default 3
  r2RetryBackoff: number[]; // ms, exponential backoff [5000, 10000, 20000]
}

class RecoveryEngine {
  private state: RecoveryState = 'START';
  private manifestPath = '/workspace/grimoires/loa/.loa-state-manifest.json';
  private config: RecoveryConfig;
  private recentFailures: number[] = [];  // Track FAILURES, not attempts
  private signer: ManifestSigner;

  constructor(config?: Partial<RecoveryConfig>) {
    this.config = {
      retryWindow: config?.retryWindow ?? 10 * 60 * 1000,
      maxFailures: config?.maxFailures ?? 3,
      r2RetryBackoff: config?.r2RetryBackoff ?? [5000, 10000, 20000],
    };
    this.signer = new ManifestSigner();
  }

  async run(): Promise<RecoveryState> {
    this.state = 'CHECK_INTEGRITY';

    while (this.state !== 'RUNNING' && this.state !== 'ALERT_HUMAN') {
      console.log(`[recovery] State: ${this.state}`);

      switch (this.state) {
        case 'CHECK_INTEGRITY':
          this.state = await this.checkIntegrity();
          break;

        case 'TRY_R2':
          this.state = await this.tryR2();
          break;

        case 'RESTORE_R2':
          this.state = await this.restoreR2();
          break;

        case 'TRY_GIT':
          this.state = await this.tryGit();
          break;

        case 'RESTORE_GIT':
          this.state = await this.restoreGit();
          break;

        case 'TEMPLATE_INIT':
          this.state = await this.templateInit();
          break;

        case 'DEGRADED_MODE':
          this.state = await this.enterDegradedMode();
          break;
      }
    }

    return this.state;
  }

  private async checkIntegrity(): Promise<RecoveryState> {
    const manifest = await this.loadManifest();

    if (!manifest) {
      console.log('[recovery] No manifest found, need restore');
      return 'TRY_R2';
    }

    // Verify manifest signature (Ed25519)
    if (!await this.signer.verifyManifest(manifest)) {
      console.log('[recovery] Manifest signature invalid, need restore');
      return 'TRY_R2';
    }

    const criticalFiles = [
      'grimoires/loa/NOTES.md',
      'grimoires/loa/BEAUVOIR.md',
    ];

    for (const file of criticalFiles) {
      const entry = manifest.files[file];
      if (!entry) {
        console.log(`[recovery] Missing file in manifest: ${file}`);
        return 'TRY_R2';
      }

      // Check if file exists locally first
      const exists = await this.fileExists(`/workspace/${file}`);
      if (!exists) {
        console.log(`[recovery] File missing: ${file}`);
        return 'TRY_R2';
      }

      const hash = await this.hashFile(`/workspace/${file}`);
      if (hash !== entry.sha256) {
        console.log(`[recovery] Hash mismatch for ${file}`);
        return 'TRY_R2';
      }
    }

    console.log('[recovery] Integrity check passed (signature verified)');
    return 'RUNNING';
  }

  private async tryR2(): Promise<RecoveryState> {
    // Check failure loop detection (count FAILURES, not attempts)
    if (this.isInFailureLoop()) {
      console.log('[recovery] Failure loop detected, entering degraded mode');
      return 'DEGRADED_MODE';
    }

    // Exponential backoff for R2 connection
    for (let attempt = 0; attempt < this.config.r2RetryBackoff.length; attempt++) {
      const r2Available = await this.checkR2Connection();
      if (r2Available) {
        break;
      }
      if (attempt < this.config.r2RetryBackoff.length - 1) {
        console.log(`[recovery] R2 unavailable, retry in ${this.config.r2RetryBackoff[attempt]}ms`);
        await this.sleep(this.config.r2RetryBackoff[attempt]);
      }
    }

    const r2Available = await this.checkR2Connection();
    if (!r2Available) {
      console.log('[recovery] R2 not available after retries, trying git');
      this.recordFailure();  // Count as failure
      return 'TRY_GIT';
    }

    const r2Manifest = await this.fetchR2Manifest();
    if (!r2Manifest) {
      console.log('[recovery] R2 manifest not found, trying git');
      this.recordFailure();
      return 'TRY_GIT';
    }

    // Verify R2 manifest signature
    if (!await this.signer.verifyManifest(r2Manifest)) {
      console.log('[recovery] R2 manifest signature invalid, trying git');
      this.recordFailure();
      return 'TRY_GIT';
    }

    return 'RESTORE_R2';
  }

  private async restoreR2(): Promise<RecoveryState> {
    try {
      // Pull with ETag verification
      await this.pullFromR2WithEtagVerification();
      await this.recordRestore('r2');
      console.log('[recovery] Restored from R2');
      return 'RUNNING';
    } catch (e) {
      console.error('[recovery] R2 restore failed:', e);
      this.recordFailure();  // Count as failure
      return 'TRY_GIT';
    }
  }

  /**
   * Pull from R2 with ETag verification to detect corruption
   */
  private async pullFromR2WithEtagVerification(): Promise<void> {
    const files = await this.listR2Files();
    for (const file of files) {
      const { data, etag } = await this.downloadR2File(file.key);
      const computedEtag = this.computeEtag(data);
      if (etag !== computedEtag) {
        throw new Error(`ETag mismatch for ${file.key}: expected ${etag}, got ${computedEtag}`);
      }
      await this.writeFileAtomic(`/workspace/${file.key}`, data);
    }
  }

  private async tryGit(): Promise<RecoveryState> {
    const gitAvailable = await this.checkGitConnection();
    if (!gitAvailable) {
      console.log('[recovery] Git not available');
      return 'TEMPLATE_INIT';
    }

    return 'RESTORE_GIT';
  }

  private async restoreGit(): Promise<RecoveryState> {
    try {
      await this.pullFromGit();
      await this.recordRestore('git');
      console.log('[recovery] Restored from Git');
      return 'RUNNING';
    } catch (e) {
      console.error('[recovery] Git restore failed:', e);
      return 'TEMPLATE_INIT';
    }
  }

  private async templateInit(): Promise<RecoveryState> {
    console.log('[recovery] Initializing from template');

    // Create minimal BEAUVOIR.md
    await this.createDefaultIdentity();

    // Create empty NOTES.md
    await this.createEmptyNotes();

    // Generate new manifest
    await this.generateManifest('template');

    // Log warning
    await this.logRecoveryEvent('Template initialization - previous state lost');

    return 'DEGRADED_MODE';
  }

  private async enterDegradedMode(): Promise<RecoveryState> {
    // Set environment variable
    process.env.BEAUVOIR_DEGRADED = 'true';

    // Log to NOTES.md
    const timestamp = new Date().toISOString();
    await this.logRecoveryEvent(
      `[DEGRADED] Operating without remote backup since ${timestamp}`
    );

    // Schedule retry in 1 hour
    setTimeout(() => this.retryRecovery(), 60 * 60 * 1000);

    // Continue operation with local state
    console.log('[recovery] Entering degraded mode, will retry in 1 hour');
    return 'RUNNING';
  }

  /**
   * Check if we're in a failure loop
   * Key difference: counts FAILURES, not attempts
   * If local state is valid, we don't attempt restore at all
   */
  private isInFailureLoop(): boolean {
    const now = Date.now();
    this.recentFailures = this.recentFailures.filter(
      t => now - t < this.config.retryWindow
    );
    return this.recentFailures.length >= this.config.maxFailures;
  }

  /**
   * Record a restore failure (not an attempt)
   */
  private recordFailure(): void {
    this.recentFailures.push(Date.now());
  }

  /**
   * Record successful restore
   * Success clears the failure counter
   */
  private async recordRestore(source: 'r2' | 'git' | 'template'): Promise<void> {
    // Clear failures on success
    this.recentFailures = [];

    const manifest = await this.loadManifest() || this.defaultManifest();
    manifest.restore_count++;
    manifest.last_restore_source = source;

    // Sign the manifest before saving
    const signedManifest = await this.signer.signManifest(manifest);
    await this.saveManifest(signedManifest);
  }

  private canonicalize(content: string): string {
    // Strip trailing whitespace from each line
    // Normalize line endings to LF
    return content
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n');
  }

  private async hashFile(path: string): Promise<string | null> {
    try {
      const content = await fs.readFile(path, 'utf-8');
      const canonical = this.canonicalize(content);
      return crypto.createHash('sha256').update(canonical).digest('hex');
    } catch {
      return null;
    }
  }
}
```

### 2.4 Self-Repair Engine

**Purpose**: Automatically fix missing dependencies within security guardrails.

**Security Model**:
- Allowlist is Ed25519 signed (prevents tampering)
- Packages installed as non-root user (`loa-user`, UID 1000)
- npm installs use `npm ci` with lockfile (reproducible)
- apt packages pre-installed in container image (no runtime apt)
- All repairs logged to tamper-evident audit log

```typescript
// deploy/loa-identity/repair/self-repair-engine.ts

interface SignedPackageAllowlist {
  version: number;
  npm: PackageSpec[];
  apt: PackageSpec[];  // Reference only - must be pre-installed
  signature: string;   // Ed25519 signature of content
}

interface PackageSpec {
  name: string;
  version: string;      // Exact version (no ranges for security)
  sha256: string;       // Required integrity check
  lockfile?: string;    // Path to lockfile for npm ci
}

type RepairLevel = 'auto-fix' | 'ask-first' | 'alert-only';

interface RepairAction {
  id: string;           // Unique action ID for approval
  type: 'install' | 'restore' | 'configure';
  target: string;
  level: RepairLevel;
  status: 'pending' | 'approved' | 'completed' | 'failed';
  requestedAt: Date;
  approvedBy?: string;  // Human identifier if ask-first
}

class SelfRepairEngine {
  private allowlistPath = '/workspace/.loa/allowed-packages.yaml';
  private allowlist: SignedPackageAllowlist | null = null;
  private signer: AllowlistSigner;
  private auditLog: AuditLogger;
  private userId = 1000;  // loa-user (non-root)

  constructor() {
    this.signer = new AllowlistSigner();
    this.auditLog = new AuditLogger('/workspace/.loa/repair-audit.log');
  }

  async initialize(): Promise<void> {
    const rawAllowlist = await this.loadAllowlist();

    // Verify allowlist signature (CRITICAL)
    if (!await this.signer.verifyAllowlist(rawAllowlist)) {
      throw new Error(
        'Allowlist signature verification failed. ' +
        'Self-repair is disabled until a valid signed allowlist is provided.'
      );
    }

    this.allowlist = rawAllowlist;
    await this.auditLog.log('initialize', { allowlist_version: rawAllowlist.version });
  }

  async detectMissingDependencies(): Promise<RepairAction[]> {
    const actions: RepairAction[] = [];

    // Check npm packages
    const requiredNpm = ['clawdbot'];
    for (const pkg of requiredNpm) {
      if (!await this.isNpmInstalled(pkg)) {
        const inAllowlist = this.allowlist.npm.some(p => p.name === pkg);
        actions.push({
          type: 'install',
          target: `npm:${pkg}`,
          level: inAllowlist ? 'auto-fix' : 'ask-first',
          status: 'pending',
        });
      }
    }

    // Check apt packages
    const requiredApt = ['ripgrep', 'jq', 'git'];
    for (const pkg of requiredApt) {
      if (!await this.isAptInstalled(pkg)) {
        const inAllowlist = this.allowlist.apt.some(p => p.name === pkg);
        actions.push({
          type: 'install',
          target: `apt:${pkg}`,
          level: inAllowlist ? 'auto-fix' : 'ask-first',
          status: 'pending',
        });
      }
    }

    return actions;
  }

  async executeRepairs(actions: RepairAction[]): Promise<void> {
    for (const action of actions) {
      if (action.level === 'auto-fix') {
        await this.executeRepair(action);
      } else if (action.level === 'ask-first') {
        // Log and request approval
        await this.requestApproval(action);
      } else {
        // Alert only
        await this.logAlert(action);
      }
    }
  }

  /**
   * Execute a repair action with full security controls
   * - Runs as non-root (loa-user)
   * - Uses npm ci for reproducibility
   * - Verifies integrity after install
   * - Logs all actions to audit trail
   */
  private async executeRepair(action: RepairAction): Promise<void> {
    const [type, name] = action.target.split(':');

    console.log(`[repair] Auto-fixing: ${action.target}`);
    await this.auditLog.log('repair_start', { action });

    try {
      if (type === 'npm') {
        const spec = this.allowlist!.npm.find(p => p.name === name);
        if (!spec) {
          throw new Error(`Package ${name} not in signed allowlist`);
        }

        // Use npm ci with lockfile for reproducibility (NOT npm install)
        if (spec.lockfile) {
          // Install from lockfile (most secure)
          await this.execAsUser(
            `cd /workspace && npm ci --prefix .loa/packages/${name}`,
            this.userId
          );
        } else {
          // Install specific version with integrity check
          await this.execAsUser(
            `npm install --prefix /home/loa-user/.local ${name}@${spec.version}`,
            this.userId
          );
        }

        // Verify integrity (REQUIRED, not optional)
        const installed = await this.getNpmPackageHash(name);
        if (installed !== spec.sha256) {
          // Rollback on integrity failure
          await this.execAsUser(
            `npm uninstall --prefix /home/loa-user/.local ${name}`,
            this.userId
          );
          throw new Error(`Integrity check failed for ${name}: expected ${spec.sha256}, got ${installed}`);
        }
      } else if (type === 'apt') {
        // APT packages must be pre-installed in container image
        // Runtime apt-get is disabled for security
        const spec = this.allowlist!.apt.find(p => p.name === name);
        if (!spec) {
          throw new Error(`APT package ${name} not in signed allowlist`);
        }

        // Check if already installed
        const isInstalled = await this.isAptInstalled(name);
        if (!isInstalled) {
          throw new Error(
            `APT package ${name} is in allowlist but not pre-installed. ` +
            `Add it to the Dockerfile and rebuild the container image.`
          );
        }
      }

      action.status = 'completed';
      await this.auditLog.log('repair_success', { action });

    } catch (e) {
      action.status = 'failed';
      await this.auditLog.log('repair_failed', { action, error: String(e) });
      throw e;
    }
  }

  /**
   * Execute command as non-root user
   */
  private async execAsUser(command: string, uid: number): Promise<void> {
    await exec(`su -c '${command}' loa-user`);
  }

  /**
   * Request human approval for non-allowlisted packages
   */
  private async requestApproval(action: RepairAction): Promise<void> {
    // Log request to NOTES.md
    const entry = `[REPAIR REQUEST] ${action.target} - requires human approval (ID: ${action.id})`;
    await this.appendToNotes(entry);

    // Store pending action for later approval
    await this.storePendingAction(action);

    await this.auditLog.log('approval_requested', { action });
    console.log(`[repair] Requesting approval for: ${action.target} (ID: ${action.id})`);
  }

  /**
   * Approve a pending repair action (called via skill)
   * Requires human authentication context
   */
  async approveRepair(actionId: string, approvedBy: string): Promise<void> {
    const action = await this.loadPendingAction(actionId);
    if (!action) {
      throw new Error(`No pending action with ID ${actionId}`);
    }

    action.status = 'approved';
    action.approvedBy = approvedBy;
    await this.auditLog.log('approval_granted', { action, approvedBy });

    // Execute the approved repair
    await this.executeRepair(action);
  }
}
```

### 2.5 Security Layer

#### 2.5.1 PII Redactor

**Features**:
- Pattern-based detection for known secret formats
- Entropy-based detection for unknown high-entropy strings
- Configurable pattern extension

```typescript
// deploy/loa-identity/security/pii-redactor.ts

interface RedactionResult {
  content: string;
  blocked: boolean;
  reason?: string;
  redactions: RedactionRecord[];
}

interface RedactionRecord {
  type: string;
  original: string;       // Truncated for logging
  replacement: string;
  position: number;
  method: 'pattern' | 'entropy';
}

interface PIIRedactorConfig {
  entropyThreshold: number;     // Shannon entropy threshold (default: 4.5)
  minEntropyLength: number;     // Minimum string length for entropy check (default: 20)
  customPatterns?: Map<string, PatternSpec>;
}

interface PatternSpec {
  regex: RegExp;
  replacement: string;
  block?: boolean;
}

class PIIRedactor {
  private patterns: Map<string, PatternSpec>;
  private config: PIIRedactorConfig;

  constructor(config?: Partial<PIIRedactorConfig>) {
    this.config = {
      entropyThreshold: config?.entropyThreshold ?? 4.5,
      minEntropyLength: config?.minEntropyLength ?? 20,
    };

    this.patterns = new Map([
      // === API Keys ===
      ['api_key_openai', {
        regex: /sk-proj-[A-Za-z0-9_-]{48,}/g,
        replacement: '[REDACTED_API_KEY]',
      }],
      ['api_key_anthropic', {
        regex: /sk-ant-api[A-Za-z0-9_-]{40,}/g,
        replacement: '[REDACTED_API_KEY]',
      }],
      ['api_key_github', {
        regex: /ghp_[A-Za-z0-9]{36,}/g,
        replacement: '[REDACTED_GITHUB_TOKEN]',
      }],
      ['api_key_github_oauth', {
        regex: /gho_[A-Za-z0-9]{36,}/g,
        replacement: '[REDACTED_GITHUB_TOKEN]',
      }],
      ['api_key_stripe_live', {
        regex: /sk_live_[A-Za-z0-9]{24,}/g,
        replacement: '[REDACTED_STRIPE_KEY]',
      }],
      ['api_key_stripe_test', {
        regex: /sk_test_[A-Za-z0-9]{24,}/g,
        replacement: '[REDACTED_STRIPE_KEY]',
      }],
      ['api_key_slack', {
        regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
        replacement: '[REDACTED_SLACK_TOKEN]',
      }],
      ['api_key_discord', {
        regex: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/g,
        replacement: '[REDACTED_DISCORD_TOKEN]',
      }],

      // === Cloud Provider Keys ===
      ['aws_key', {
        regex: /AKIA[A-Z0-9]{16}/g,
        replacement: '[REDACTED_AWS_KEY]',
      }],
      ['aws_secret', {
        regex: /[A-Za-z0-9/+=]{40}(?=\s|$|")/g,  // AWS secret key pattern
        replacement: '[REDACTED_AWS_SECRET]',
      }],
      ['gcp_key', {
        regex: /AIza[A-Za-z0-9_-]{35}/g,
        replacement: '[REDACTED_GCP_KEY]',
      }],

      // === Personal Information ===
      ['email', {
        regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        replacement: '[REDACTED_EMAIL]',
      }],
      ['phone', {
        regex: /\+?[1-9]\d{1,14}|\(\d{3}\)\s*\d{3}[-.\s]?\d{4}/g,
        replacement: '[REDACTED_PHONE]',
      }],
      ['ssn', {
        regex: /\b\d{3}-\d{2}-\d{4}\b/g,
        replacement: '[REDACTED_SSN]',
      }],
      ['credit_card', {
        regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
        replacement: '[REDACTED_CC]',
      }],

      // === Credentials in URLs ===
      ['password_in_url', {
        regex: /:\/\/[^:]+:([^@]+)@/g,
        replacement: '://[REDACTED_PASSWORD]@',
      }],

      // === Private Keys (BLOCK) ===
      ['private_key_pem', {
        regex: /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
        replacement: '',
        block: true,
      }],

      // === JWT Tokens ===
      ['jwt_token', {
        regex: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
        replacement: '[REDACTED_JWT]',
      }],

      // === Base64 encoded secrets (high entropy) ===
      // Note: This is supplemented by entropy detection below
    ]);

    // Merge custom patterns
    if (config?.customPatterns) {
      for (const [key, spec] of config.customPatterns) {
        this.patterns.set(key, spec);
      }
    }
  }

  /**
   * Calculate Shannon entropy of a string
   * Higher entropy = more random = more likely a secret
   */
  private calculateEntropy(str: string): number {
    const freq = new Map<string, number>();
    for (const char of str) {
      freq.set(char, (freq.get(char) || 0) + 1);
    }
    let entropy = 0;
    for (const count of freq.values()) {
      const p = count / str.length;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  /**
   * Check if a string looks like a high-entropy secret
   */
  private isHighEntropySecret(str: string): boolean {
    if (str.length < this.config.minEntropyLength) return false;

    // Skip common high-entropy but non-secret patterns
    if (/^[0-9a-f-]{32,}$/i.test(str)) return false;  // UUIDs
    if (/^\d+$/.test(str)) return false;  // Pure numbers

    const entropy = this.calculateEntropy(str);
    return entropy >= this.config.entropyThreshold;
  }

  process(content: string): RedactionResult {
    const redactions: RedactionRecord[] = [];
    let result = content;

    // Phase 1: Pattern-based detection
    for (const [type, { regex, replacement, block }] of this.patterns) {
      const matches = content.matchAll(new RegExp(regex.source, regex.flags));

      for (const match of matches) {
        if (block) {
          return {
            content: '',
            blocked: true,
            reason: `Contains ${type} - blocked entirely`,
            redactions: [],
          };
        }

        redactions.push({
          type,
          original: match[0].substring(0, 10) + '...',  // Truncate for logging
          replacement,
          position: match.index!,
          method: 'pattern',
        });
      }

      result = result.replace(regex, replacement);
    }

    // Phase 2: Entropy-based detection for unknown secrets
    // Find potential secrets by looking for high-entropy alphanumeric strings
    const entropyPattern = /[A-Za-z0-9_\-+/=]{20,}/g;
    const entropyMatches = result.matchAll(entropyPattern);

    for (const match of entropyMatches) {
      const str = match[0];

      // Skip if already redacted
      if (str.includes('REDACTED')) continue;

      if (this.isHighEntropySecret(str)) {
        redactions.push({
          type: 'high_entropy_secret',
          original: str.substring(0, 10) + '...',
          replacement: '[REDACTED_HIGH_ENTROPY]',
          position: match.index!,
          method: 'entropy',
        });

        result = result.replace(str, '[REDACTED_HIGH_ENTROPY]');
      }
    }

    return {
      content: result,
      blocked: false,
      redactions,
    };
  }

  /**
   * Add custom patterns at runtime
   * Useful for project-specific secret formats
   */
  addPattern(name: string, spec: PatternSpec): void {
    this.patterns.set(name, spec);
  }
}
```

#### 2.5.2 Secret Scanner

```typescript
// deploy/loa-identity/security/secret-scanner.ts

interface ScanResult {
  clean: boolean;
  findings: SecretFinding[];
}

interface SecretFinding {
  file: string;
  line: number;
  type: string;
  snippet: string;
}

class SecretScanner {
  private redactor: PIIRedactor;

  constructor() {
    this.redactor = new PIIRedactor();
  }

  async scanForGitCommit(files: string[]): Promise<ScanResult> {
    const findings: SecretFinding[] = [];

    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const result = this.redactor.process(lines[i]);

        if (result.blocked || result.redactions.length > 0) {
          findings.push({
            file,
            line: i + 1,
            type: result.redactions[0]?.type || 'sensitive_content',
            snippet: lines[i].substring(0, 50) + '...',
          });
        }
      }
    }

    return {
      clean: findings.length === 0,
      findings,
    };
  }

  async preCommitHook(): Promise<boolean> {
    // Get staged files in grimoires/
    const { stdout } = await exec(
      'git diff --cached --name-only -- grimoires/'
    );
    const files = stdout.trim().split('\n').filter(Boolean);

    if (files.length === 0) return true;

    const result = await this.scanForGitCommit(
      files.map(f => `/workspace/${f}`)
    );

    if (!result.clean) {
      console.error('[security] Secrets detected in staged files:');
      for (const finding of result.findings) {
        console.error(`  ${finding.file}:${finding.line} - ${finding.type}`);
      }
      console.error('[security] Commit blocked. Remove secrets and try again.');
      return false;
    }

    return true;
  }
}
```

---

## 3. Data Models

### 3.1 State Manifest Schema

```typescript
// File: .loa-state-manifest.json

interface StateManifest {
  version: 1;
  generated_at: string;  // ISO 8601
  files: Record<string, FileEntry>;
  restore_count: number;
  last_restore_source: 'r2' | 'git' | 'template' | null;

  // Cryptographic signature (Ed25519)
  signature: {
    algorithm: 'ed25519';
    public_key_id: string;  // Key identifier for rotation
    value: string;          // Base64-encoded signature
  };
}

interface FileEntry {
  sha256: string;         // Hash of canonicalized content
  size_bytes: number;
  mtime: string;          // ISO 8601
}

/**
 * Manifest Signer - Ed25519 signing for tamper detection
 */
class ManifestSigner {
  private publicKey: Uint8Array;  // Embedded in container image
  private privateKeyEnvVar = 'LOA_SIGNING_KEY';

  /**
   * Sign manifest (called at generation time)
   */
  async signManifest(manifest: Omit<StateManifest, 'signature'>): Promise<StateManifest> {
    const privateKey = this.loadPrivateKey();
    const content = this.canonicalizeForSigning(manifest);
    const signature = await ed25519.sign(content, privateKey);

    return {
      ...manifest,
      signature: {
        algorithm: 'ed25519',
        public_key_id: this.getPublicKeyId(),
        value: Buffer.from(signature).toString('base64'),
      },
    };
  }

  /**
   * Verify manifest signature (called at load time)
   */
  async verifyManifest(manifest: StateManifest): Promise<boolean> {
    if (!manifest.signature) return false;
    if (manifest.signature.algorithm !== 'ed25519') return false;

    const content = this.canonicalizeForSigning(manifest);
    const signature = Buffer.from(manifest.signature.value, 'base64');

    return ed25519.verify(signature, content, this.publicKey);
  }

  /**
   * Canonical form for signing (deterministic JSON)
   */
  private canonicalizeForSigning(manifest: Omit<StateManifest, 'signature'>): string {
    // Remove signature field if present, sort keys, stringify
    const { signature, ...rest } = manifest as any;
    return JSON.stringify(rest, Object.keys(rest).sort());
  }
}
```

### 3.2 WAL Entry Schema

```typescript
// File: /data/wal/memory.wal (JSONL format)

interface WALEntry {
  ts: number;             // Unix timestamp (ms)
  seq: number;            // Sequence number (monotonic within segment)
  op: 'write' | 'delete' | 'consolidate' | 'checkpoint';
  path: string;           // Relative path
  data?: string;          // Base64 encoded (for write ops)
  checksum: string;       // SHA256 of base64 data
  segment?: number;       // Segment number (for multi-segment WAL)
}
```

### 3.2.1 WAL Segmentation and Compaction

**Problem**: Unbounded WAL growth causes disk fill and slow recovery.

**Solution**: Segmented WAL with rotation and compaction.

```typescript
// deploy/loa-identity/wal/wal-manager.ts

interface WALConfig {
  segmentMaxSize: number;     // Max bytes per segment (default: 10MB)
  segmentMaxAge: number;      // Max age before rotation (default: 1 hour)
  retentionSegments: number;  // Segments to keep (default: 10)
  checkpointInterval: number; // Checkpoint every N writes (default: 100)
}

class WALManager {
  private config: WALConfig;
  private currentSegment: number = 0;
  private currentSeq: number = 0;
  private segmentPath: string;
  private lockPath: string;

  constructor(config?: Partial<WALConfig>) {
    this.config = {
      segmentMaxSize: config?.segmentMaxSize ?? 10 * 1024 * 1024,  // 10MB
      segmentMaxAge: config?.segmentMaxAge ?? 60 * 60 * 1000,      // 1 hour
      retentionSegments: config?.retentionSegments ?? 10,
      checkpointInterval: config?.checkpointInterval ?? 100,
    };
  }

  /**
   * Rotate to new segment when size/age limit reached
   */
  async maybeRotateSegment(): Promise<void> {
    const stats = await fs.stat(this.segmentPath);
    const age = Date.now() - stats.mtimeMs;

    if (stats.size >= this.config.segmentMaxSize ||
        age >= this.config.segmentMaxAge) {
      await this.rotateSegment();
    }
  }

  /**
   * Rotate to new segment
   */
  private async rotateSegment(): Promise<void> {
    // Write checkpoint marker to current segment
    await this.writeCheckpoint();

    // Increment segment number
    this.currentSegment++;
    this.currentSeq = 0;

    // Update segment path
    this.segmentPath = `/data/wal/segment-${this.currentSegment}.wal`;

    // Compact old segments (async, non-blocking)
    this.compactOldSegments().catch(e => {
      console.error('[wal] Compaction failed:', e);
    });
  }

  /**
   * Compact old segments beyond retention limit
   */
  private async compactOldSegments(): Promise<void> {
    const segments = await this.listSegments();
    const toDelete = segments.slice(0, -this.config.retentionSegments);

    for (const segment of toDelete) {
      // Verify segment is fully synced to R2 before deletion
      if (await this.isSegmentSynced(segment)) {
        await fs.unlink(segment);
        console.log(`[wal] Compacted segment: ${segment}`);
      }
    }
  }

  /**
   * Write checkpoint marker for recovery
   */
  private async writeCheckpoint(): Promise<void> {
    const checkpoint: WALEntry = {
      ts: Date.now(),
      seq: this.currentSeq++,
      op: 'checkpoint',
      path: '',
      checksum: this.sha256('checkpoint'),
      segment: this.currentSegment,
    };

    await this.appendEntry(checkpoint);
  }

  /**
   * Replay WAL from last checkpoint
   * Used on container restart
   */
  async replay(): Promise<number> {
    const segments = await this.listSegments();
    let entriesReplayed = 0;

    for (const segmentPath of segments) {
      const entries = await this.readSegment(segmentPath);

      for (const entry of entries) {
        // Verify checksum before replay
        if (entry.data) {
          const computed = this.sha256(entry.data);
          if (computed !== entry.checksum) {
            console.error(`[wal] Checksum mismatch at seq ${entry.seq}, skipping`);
            continue;
          }
        }

        if (entry.op === 'write') {
          const data = Buffer.from(entry.data!, 'base64');
          await this.writeFileAtomic(`/workspace/${entry.path}`, data);
          entriesReplayed++;
        } else if (entry.op === 'delete') {
          await fs.unlink(`/workspace/${entry.path}`).catch(() => {});
          entriesReplayed++;
        }
      }
    }

    console.log(`[wal] Replayed ${entriesReplayed} entries`);
    return entriesReplayed;
  }
}
```

**WAL Directory Structure**:
```
/data/wal/
├── segment-0.wal         # Oldest segment
├── segment-1.wal
├── segment-2.wal         # Current segment
├── wal.lock              # flock for exclusive write access
└── checkpoint.json       # Last checkpoint metadata
```

### 3.3 Memory Entry Schema

```typescript
// Used in NOTES.md and memory/*.md

interface MemoryEntry {
  id: string;             // Format: mem-YYYY-MM-DD-NNN
  type: 'decision' | 'fact' | 'preference' | 'pattern' | 'error';
  content: string;
  source: 'conversation' | 'observation' | 'inference';
  confidence: number;     // 0.0 - 1.0
  timestamp: string;      // ISO 8601
  scope: 'project' | 'global';
  tags: string[];
}
```

### 3.4 Package Allowlist Schema

```yaml
# File: .loa/allowed-packages.yaml

npm:
  - name: "clawdbot"
    version: "2026.1.24-3"
    sha256: "abc123..."     # Optional integrity check
  - name: "pnpm"
    version: "10.*"

apt:
  - name: "ripgrep"
    version: "*"
  - name: "jq"
    version: "*"
  - name: "git"
    version: "*"
  - name: "curl"
    version: "*"
```

### 3.5 Consolidation Audit Log Schema

```typescript
// File: grimoires/loa/memory/consolidation.log (JSONL)

interface ConsolidationLogEntry {
  timestamp: string;
  action: 'promote' | 'merge' | 'reject';
  entry_id: string;
  details: {
    merged_with?: string;
    similarity?: number;
    rejection_reason?: string;
    quality_gate?: string;
  };
}
```

---

## 4. API Contracts

### 4.1 Recovery Engine API

```typescript
interface IRecoveryEngine {
  /**
   * Run the recovery state machine
   * @returns Final state after recovery completes
   */
  run(): Promise<RecoveryState>;

  /**
   * Force a manual restore from specific source
   * @param source - 'r2' | 'git'
   */
  forceRestore(source: 'r2' | 'git'): Promise<void>;

  /**
   * Get current recovery status
   */
  getStatus(): RecoveryStatus;

  /**
   * Generate new state manifest
   */
  generateManifest(): Promise<StateManifest>;
}

interface RecoveryStatus {
  state: RecoveryState;
  degraded: boolean;
  lastRestore: Date | null;
  restoreCount: number;
  r2Available: boolean;
  gitAvailable: boolean;
}
```

### 4.2 Memory Engine API

```typescript
interface IMemoryEngine {
  /**
   * Capture a new memory entry (Phase 1)
   * @returns Entry ID if captured, null if rejected
   */
  capture(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<string | null>;

  /**
   * Run consolidation (Phase 2)
   * @returns Consolidation result summary
   */
  consolidate(): Promise<ConsolidationResult>;

  /**
   * Search memories semantically
   * @param query - Search query
   * @param limit - Max results
   */
  search(query: string, limit?: number): Promise<MemoryEntry[]>;

  /**
   * Get memory statistics
   */
  getStats(): MemoryStats;
}

interface MemoryStats {
  sessionEntries: number;
  durableEntries: number;
  lastConsolidation: Date | null;
  storageBytes: number;
}
```

### 4.3 Self-Repair Engine API

```typescript
interface ISelfRepairEngine {
  /**
   * Detect missing dependencies
   */
  detectMissing(): Promise<RepairAction[]>;

  /**
   * Execute auto-fixable repairs
   */
  executeAutoFixes(): Promise<RepairResult>;

  /**
   * Get pending approval requests
   */
  getPendingApprovals(): RepairAction[];

  /**
   * Approve a pending repair action
   */
  approveRepair(actionId: string): Promise<void>;
}

interface RepairResult {
  completed: number;
  failed: number;
  pendingApproval: number;
}
```

### 4.4 Security API

```typescript
interface ISecurityLayer {
  /**
   * Redact PII from content
   */
  redactPII(content: string): RedactionResult;

  /**
   * Scan files for secrets before git commit
   */
  scanForSecrets(files: string[]): Promise<ScanResult>;

  /**
   * Validate package against allowlist
   */
  validatePackage(type: 'npm' | 'apt', name: string, version: string): boolean;
}
```

---

## 5. Integration Points

### 5.1 Integration with start-loa.sh

The recovery engine integrates with the existing startup script:

```bash
# deploy/start-loa.sh additions

# ============================================================================
# BEAUVOIR RESILIENCE INTEGRATION
# ============================================================================

run_recovery_engine() {
    echo "[loa] Running Beauvoir recovery engine..."

    # Run TypeScript recovery engine via Node
    node --experimental-specifier-resolution=node \
        /workspace/deploy/loa-identity/recovery/run.js

    local exit_code=$?

    if [ $exit_code -ne 0 ]; then
        echo "[loa] Recovery engine failed, starting in degraded mode"
        export BEAUVOIR_DEGRADED=true
    fi

    # Check degraded mode
    if [ "$BEAUVOIR_DEGRADED" = "true" ]; then
        echo "[loa] WARNING: Operating in degraded mode"
    fi
}

# Run before gateway start
run_recovery_engine

# Existing gateway start...
```

### 5.2 Integration with WAL System

The existing WAL in `sdd.md` is extended:

```typescript
// Extension to existing WALManager

class ExtendedWALManager extends WALManager {
  private memoryEngine: MemoryEngine;

  // Hook into write operations
  async write(path: string, content: Buffer): Promise<void> {
    // Existing WAL write
    await super.write(path, content);

    // If grimoire file, capture to memory engine
    if (path.startsWith('grimoires/')) {
      await this.memoryEngine.captureFromFile(path, content);
    }
  }
}
```

### 5.3 Integration with Loa Skills

New skills for managing resilience:

| Skill | File | Purpose |
|-------|------|---------|
| `/recovery-status` | `skills/recovery-status.md` | Show recovery engine status |
| `/force-restore` | `skills/force-restore.md` | Manual restore from R2/git |
| `/consolidate-memory` | `skills/consolidate-memory.md` | Trigger memory consolidation |
| `/memory-stats` | `skills/memory-stats.md` | Show memory statistics |
| `/approve-repair` | `skills/approve-repair.md` | Approve pending self-repairs |

### 5.4 Scheduled Tasks

```typescript
// Scheduled via cron or container scheduler

interface ScheduledTasks {
  // R2 sync every 30 seconds (existing)
  r2Sync: '*/30 * * * * *';

  // Memory consolidation hourly
  consolidation: '0 * * * *';

  // State manifest regeneration every 5 minutes
  manifestRegen: '*/5 * * * *';

  // Monthly archive creation
  monthlyArchive: '0 0 1 * *';

  // Degraded mode retry (if applicable)
  degradedRetry: 'on_degraded_mode_hourly';
}
```

---

## 6. File Structure

### 6.1 New Files to Create

```
deploy/loa-identity/
├── identity-loader.ts          # Identity engine
├── memory/
│   ├── session-manager.ts      # Phase 1: capture
│   ├── consolidation-engine.ts # Phase 2: consolidate
│   └── semantic-search.ts      # Memory search
├── recovery/
│   ├── recovery-engine.ts      # State machine
│   └── run.js                  # Entrypoint
├── repair/
│   └── self-repair-engine.ts   # Dependency repair
├── security/
│   ├── pii-redactor.ts         # PII redaction
│   └── secret-scanner.ts       # Pre-commit scanning
└── skills/
    ├── recovery-status.md
    ├── force-restore.md
    ├── consolidate-memory.md
    ├── memory-stats.md
    └── approve-repair.md

grimoires/loa/
├── BEAUVOIR.md                 # Identity document (create)
├── memory/                     # Durable memory (create)
│   ├── consolidation.log       # Audit trail
│   └── archive/                # Old memories
└── .loa-state-manifest.json    # State manifest (auto-generated)

.loa/
└── allowed-packages.yaml       # Self-repair allowlist

.git/hooks/
└── pre-commit                  # Secret scanning hook
```

### 6.2 Modified Files

| File | Change |
|------|--------|
| `deploy/start-loa.sh` | Add recovery engine integration |
| `grimoires/loa/NOTES.md` | Add Session Memory section |
| `.gitignore` | Add `.loa-state-manifest.json` (local only) |

---

## 7. Technical Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Status |
|------|--------|------------|------------|--------|
| Embedding model unavailable | Medium | Medium | Lexical fallback (Jaccard), graceful degradation | **Addressed** |
| WAL corruption | High | Low | SHA256 per entry, segment checksums, flock | **Addressed** |
| WAL unbounded growth | High | Medium | Segmentation, rotation, compaction | **Addressed** |
| R2 latency/unavailability | Medium | Medium | Exponential backoff (5s/10s/20s), ETag verification | **Addressed** |
| R2 credential compromise | Critical | Low | Scoped IAM, Cloudflare Secrets, audit logging | **Addressed** |
| False positive PII detection | Low | Medium | Conservative patterns + entropy threshold tuning | **Addressed** |
| PII pattern bypass | High | Medium | Entropy detection catch-all, configurable patterns | **Addressed** |
| Memory growth unbounded | Medium | Low | Monthly archival, segment retention limits | Existing |
| Circular restore loop | High | Low | Failure counting (not attempts), configurable thresholds | **Addressed** |
| Git conflict on consolidation | Medium | Medium | Atomic writes, auto-merge, conflict markers | Existing |
| Self-repair supply chain | Critical | Low | Ed25519 signed allowlist, non-root, npm ci + lockfile | **Addressed** |
| Allowlist tampering | Critical | Low | Ed25519 signature verification required | **Addressed** |
| Manifest tampering | Critical | Low | Ed25519 signed manifests, verified on load | **Addressed** |
| Concurrent write corruption | High | Medium | Single-writer architecture, flock, atomic rename | **Addressed** |
| Runtime apt installs | Critical | N/A | Disabled - packages must be pre-installed in image | **Addressed** |

### 7.1 Security Measures Summary

| Measure | Component | Description |
|---------|-----------|-------------|
| Ed25519 signing | Manifests, Allowlists | Prevents tampering, requires valid signature |
| Non-root execution | Self-repair | Runs as loa-user (UID 1000), not root |
| Lockfile installs | npm packages | Uses `npm ci` for reproducibility |
| Entropy detection | PII Redactor | Catches unknown high-entropy secrets |
| ETag verification | R2 sync | Detects corruption during transfer |
| Scoped credentials | R2 access | Read/write to single bucket only |
| Audit logging | All repairs | Tamper-evident log of all actions |

---

## 8. Non-Functional Considerations

### 8.1 Performance Targets

| Operation | Target | Measurement |
|-----------|--------|-------------|
| Memory capture | < 50ms | Time from API call to WAL write |
| PII redaction | < 10ms | Single entry processing |
| State integrity check | < 500ms | Full manifest verification |
| R2 restore | < 30s | Full state restore |
| Consolidation | < 5s | 100 session entries |
| Semantic search | < 100ms | Against 1000 memories |

### 8.2 Storage Estimates

| Component | Size | Growth Rate |
|-----------|------|-------------|
| NOTES.md | 50-200 KB | Per session |
| BEAUVOIR.md | 5-20 KB | Minimal |
| Monthly memory | 10-50 KB | Per month |
| WAL | 1-10 MB | Per week |
| Embeddings cache | 50-100 MB | Per 10K entries |

---

## 9. Testing Strategy

### 9.1 Unit Tests

| Component | Test Focus |
|-----------|------------|
| PIIRedactor | Pattern matching, edge cases |
| QualityGates | Each gate independently |
| RecoveryEngine | State transitions |
| SemanticDedup | Similarity calculations |

### 9.2 Integration Tests

| Scenario | Test |
|----------|------|
| Memory capture → consolidation | End-to-end flow |
| R2 failure → git fallback | Recovery cascade |
| Concurrent writes | WAL consistency |
| Pre-commit hook | Secret blocking |

### 9.3 Recovery Tests

| Scenario | Expected Behavior |
|----------|-------------------|
| Container restart (valid state) | < 10s boot, RUNNING |
| Container restart (missing files) | R2 restore, RUNNING |
| R2 unavailable | Git fallback, RUNNING |
| Both unavailable | DEGRADED_MODE |
| Repeated failures | Loop detection → ALERT |

---

## Appendix A: BEAUVOIR.md Template

```markdown
# Beauvoir - Identity Document

> **Version**: 1.0.0
> **Last Modified**: 2026-02-03

## Core Principles (Why I Behave This Way)

### Resourceful First
Before asking a question, I check available sources. This respects the user's time
and demonstrates competence. I verify information rather than guessing.

### Opinionated Helpfulness
Neutrality is often unhelpful. When I have experience with a topic, I share my
recommendations while being transparent about uncertainty. I'd rather give a
useful opinion than a non-answer.

### Procedural Reliability
Free-form responses lead to errors. I use structured workflows (Loa skills)
for complex tasks to ensure consistency and reduce hallucination.

### Transparency in Process
I show my reasoning so users understand decisions. This builds trust and
allows course correction.

### Resilient Continuity
I recover from failures without waiting for permission. Existing is helpful;
stopping and waiting is not.

## Operational Stance

- **Verification-first**: Check sources before making claims
- **Structured execution**: Route appropriate tasks to Loa skills
- **Honest uncertainty**: Say "I don't know" when uncertain
- **Minimal intervention**: Complete tasks without unnecessary questions

## Interaction Style

- **Concise**: Long responses waste user time
- **Direct**: State conclusions, then reasoning
- **Proactive**: Anticipate follow-up needs
- **Technical**: Match user's technical level

## Boundaries

- I will not pretend to have capabilities I lack
- I will not store sensitive data (API keys, passwords)
- I will not execute arbitrary code from untrusted sources
- I will not make claims without evidence

## Self-Evolution

This document evolves through:
1. **User feedback** - Direct requests to adjust behavior
2. **Pattern recognition** - Repeated corrections indicate needed change
3. **Capability updates** - New Loa features may enable new behaviors

All changes are logged to NOTES.md for transparency.
```

---

## Appendix B: Quality Gate Reference

| Gate | Pattern | Action | Rationale |
|------|---------|--------|-----------|
| Temporal | `/today\|this time\|just now/i` | Reject | Non-durable |
| Speculation | `/might be\|probably\|I think/i` + conf < 0.8 | Reject | Low confidence |
| Instruction | Looks like prompt/command | Reject | Security |
| PII | Email, phone, API key patterns | Redact | Privacy |
| Confidence | `confidence < 0.5` | Reject | Quality floor |
| Length | `content.length < 10` | Reject | Too short |
| Duplicate | `similarity >= 0.85` | Merge | Deduplication |

---

## Appendix C: Flatline Protocol Review

**Review Date**: 2026-02-03
**Models**: Claude Opus 4.5 + GPT-5.2
**Agreement**: 100%
**Cost**: $1.24

### High Consensus Improvements (Integrated)

| ID | Issue | Resolution |
|----|-------|------------|
| IMP-001 | Embedding model fallback needed | Added Jaccard lexical fallback when embeddings unavailable |
| IMP-002 | WAL needs compaction/rotation | Added segmented WAL with rotation, retention, checkpoints |
| IMP-003 | R2 credential management unspecified | Added credential architecture with scoped IAM |
| IMP-005 | Concurrent WAL writes need locking | Added single-writer architecture with flock |
| IMP-008 | R2 sync lacks integrity verification | Added ETag verification on download |

### Critical Blockers Addressed

| ID | Concern | Resolution |
|----|---------|------------|
| SKP-001 | No auth for self-repair APIs | Ed25519 signed allowlist, human approval for non-allowlisted |
| SKP-002 | Embedding supply chain risk | Version pinning, pre-cached model, lexical fallback |
| SKP-003 | PII patterns incomplete | Added ghp_, sk_live_, SSN, JWT; added entropy detection |
| SKP-004 | Loop detection too aggressive | Changed to count failures not attempts; validate local first |
| SKP-005 | Concurrency not addressed | Single-writer architecture with flock and atomic rename |
| SKP-006 | Embedding runtime underspecified | Python sidecar service on localhost:8384 |
| Integrity | No signing for tamper detection | Ed25519 signatures on manifests and allowlists |
| Self-repair | Root execution risk | Non-root user (loa-user, UID 1000), no runtime apt |
| WAL schema | Implementation mismatched spec | Fixed: seq field, base64 encoding, consistent checksums |

---

## 10. Operational Hardening Architecture

> **Added**: v0.3.0
> **Sources**: PRD v0.3.0 FR-6 through FR-11, openclaw-starter-kit analysis

### 10.1 Problem Context

Autonomous AI systems running 24/7 suffer from predictable failure modes that the core resilience layer doesn't address:

| Failure Mode | Root Cause | Impact |
|--------------|------------|--------|
| Subagent timeout crashes | Default 3-min timeout too short | Tasks killed mid-execution |
| Resource explosion | Cron/script proliferation | API quota exhaustion |
| Task redundancy | Non-MECE task design | Duplicate messages, wasted resources |
| Scheduler stalls | No self-monitoring | Silent failures |
| Context overflow | No usage tracking | Unexpected compaction |

### 10.2 Subagent Timeout Enforcement

**Purpose**: Prevent trusted models from being killed mid-task.

```typescript
// deploy/loa-identity/scheduler/timeout-enforcer.ts

interface TimeoutConfig {
  minMinutes: number;        // Default: 30 for trusted models
  warnBelowMinutes: number;  // Default: 10
  hardFloorMinutes: number;  // Default: 3 (blocks spawn if below)
}

interface TrustedModel {
  name: string;
  patterns: string[];  // Regex patterns to match model ID
}

const TRUSTED_MODELS: TrustedModel[] = [
  { name: 'opus', patterns: ['claude-opus', 'opus-4'] },
  { name: 'codex', patterns: ['codex-max', 'gpt-4-turbo'] },
];

class TimeoutEnforcer {
  private config: TimeoutConfig;
  private auditLog: AuditLogger;

  constructor(config?: Partial<TimeoutConfig>) {
    this.config = {
      minMinutes: config?.minMinutes ?? 30,
      warnBelowMinutes: config?.warnBelowMinutes ?? 10,
      hardFloorMinutes: config?.hardFloorMinutes ?? 3,
    };
    this.auditLog = new AuditLogger('/workspace/.loa/timeout-audit.log');
  }

  /**
   * Validate timeout before subagent spawn
   * @throws Error if timeout below hard floor
   */
  async validateTimeout(
    modelId: string,
    requestedMinutes: number
  ): Promise<{ valid: boolean; adjustedMinutes: number; warnings: string[] }> {
    const warnings: string[] = [];
    let adjustedMinutes = requestedMinutes;

    // Hard floor check - block spawn
    if (requestedMinutes < this.config.hardFloorMinutes) {
      await this.auditLog.log('timeout_blocked', {
        modelId,
        requested: requestedMinutes,
        reason: `Below hard floor (${this.config.hardFloorMinutes} min)`,
      });
      throw new Error(
        `Timeout ${requestedMinutes}min blocked: below hard floor ` +
        `${this.config.hardFloorMinutes}min. Increase timeout to proceed.`
      );
    }

    // Trusted model enforcement
    const isTrusted = TRUSTED_MODELS.some(m =>
      m.patterns.some(p => new RegExp(p, 'i').test(modelId))
    );

    if (isTrusted && requestedMinutes < this.config.minMinutes) {
      warnings.push(
        `Trusted model ${modelId}: timeout ${requestedMinutes}min ` +
        `below recommended ${this.config.minMinutes}min`
      );
      adjustedMinutes = this.config.minMinutes;
    }

    // Warning threshold
    if (requestedMinutes < this.config.warnBelowMinutes) {
      warnings.push(
        `Timeout ${requestedMinutes}min below warning threshold ` +
        `${this.config.warnBelowMinutes}min - consider increasing`
      );
    }

    // Log configuration
    await this.auditLog.log('timeout_validated', {
      modelId,
      requested: requestedMinutes,
      adjusted: adjustedMinutes,
      isTrusted,
      warnings,
    });

    return { valid: true, adjustedMinutes, warnings };
  }
}
```

### 10.3 Weekly Bloat Audit

**Purpose**: Detect and prevent resource proliferation before quota exhaustion.

```typescript
// deploy/loa-identity/scheduler/bloat-auditor.ts

interface BloatThresholds {
  crons: { warn: number; critical: number };
  scripts: { warn: number; critical: number };
  stateFileSize: { warn: number; critical: number };  // MB
}

interface BloatAuditResult {
  timestamp: Date;
  status: 'healthy' | 'warning' | 'critical';
  counts: {
    crons: number;
    scripts: number;
    orphanedScripts: number;
    overlappingCrons: number;
    stateFileSizeMB: number;
  };
  violations: BloatViolation[];
  remediation: string[];
}

interface BloatViolation {
  type: 'count_exceeded' | 'orphaned' | 'overlap' | 'size_exceeded';
  resource: string;
  details: string;
  severity: 'warning' | 'critical';
}

class BloatAuditor {
  private thresholds: BloatThresholds;
  private auditLog: AuditLogger;

  constructor(thresholds?: Partial<BloatThresholds>) {
    this.thresholds = {
      crons: thresholds?.crons ?? { warn: 15, critical: 20 },
      scripts: thresholds?.scripts ?? { warn: 40, critical: 50 },
      stateFileSize: thresholds?.stateFileSize ?? { warn: 5, critical: 10 },
    };
    this.auditLog = new AuditLogger('/workspace/.loa/bloat-audit.log');
  }

  async runAudit(): Promise<BloatAuditResult> {
    const violations: BloatViolation[] = [];
    const remediation: string[] = [];

    // 1. Count crons
    const cronCount = await this.countCrons();
    if (cronCount > this.thresholds.crons.critical) {
      violations.push({
        type: 'count_exceeded',
        resource: 'crons',
        details: `${cronCount} crons (critical: ${this.thresholds.crons.critical})`,
        severity: 'critical',
      });
      remediation.push('Consolidate crons - batch similar schedules');
    } else if (cronCount > this.thresholds.crons.warn) {
      violations.push({
        type: 'count_exceeded',
        resource: 'crons',
        details: `${cronCount} crons (warn: ${this.thresholds.crons.warn})`,
        severity: 'warning',
      });
    }

    // 2. Count scripts
    const scriptCount = await this.countScripts();
    if (scriptCount > this.thresholds.scripts.critical) {
      violations.push({
        type: 'count_exceeded',
        resource: 'scripts',
        details: `${scriptCount} scripts (critical: ${this.thresholds.scripts.critical})`,
        severity: 'critical',
      });
      remediation.push('Remove orphaned scripts, consolidate duplicates');
    } else if (scriptCount > this.thresholds.scripts.warn) {
      violations.push({
        type: 'count_exceeded',
        resource: 'scripts',
        details: `${scriptCount} scripts (warn: ${this.thresholds.scripts.warn})`,
        severity: 'warning',
      });
    }

    // 3. Find orphaned scripts (not referenced anywhere)
    const orphanedScripts = await this.findOrphanedScripts();
    for (const script of orphanedScripts) {
      violations.push({
        type: 'orphaned',
        resource: script,
        details: 'Script not referenced in codebase',
        severity: 'warning',
      });
    }
    if (orphanedScripts.length > 0) {
      remediation.push(`Delete ${orphanedScripts.length} orphaned scripts`);
    }

    // 4. Find overlapping cron schedules
    const overlappingCrons = await this.findOverlappingCrons();
    for (const { cron1, cron2, schedule } of overlappingCrons) {
      violations.push({
        type: 'overlap',
        resource: `${cron1} + ${cron2}`,
        details: `Both scheduled at ${schedule}`,
        severity: 'warning',
      });
    }
    if (overlappingCrons.length > 0) {
      remediation.push('Stagger overlapping crons or consolidate');
    }

    // 5. Check state file sizes
    const stateFileSizeMB = await this.getStateFileSize();
    if (stateFileSizeMB > this.thresholds.stateFileSize.critical) {
      violations.push({
        type: 'size_exceeded',
        resource: 'state files',
        details: `${stateFileSizeMB}MB (critical: ${this.thresholds.stateFileSize.critical}MB)`,
        severity: 'critical',
      });
      remediation.push('Compact WAL, archive old memory files');
    } else if (stateFileSizeMB > this.thresholds.stateFileSize.warn) {
      violations.push({
        type: 'size_exceeded',
        resource: 'state files',
        details: `${stateFileSizeMB}MB (warn: ${this.thresholds.stateFileSize.warn}MB)`,
        severity: 'warning',
      });
    }

    // Determine overall status
    const hasCritical = violations.some(v => v.severity === 'critical');
    const hasWarning = violations.some(v => v.severity === 'warning');
    const status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

    const result: BloatAuditResult = {
      timestamp: new Date(),
      status,
      counts: {
        crons: cronCount,
        scripts: scriptCount,
        orphanedScripts: orphanedScripts.length,
        overlappingCrons: overlappingCrons.length,
        stateFileSizeMB,
      },
      violations,
      remediation,
    };

    // Log to audit trail
    await this.auditLog.log('bloat_audit', result);

    // Write summary to NOTES.md
    await this.writeToNotes(result);

    return result;
  }

  private async countCrons(): Promise<number> {
    // Count cron entries from scheduler config
    const { stdout } = await exec('crontab -l 2>/dev/null | grep -v "^#" | grep -v "^$" | wc -l');
    return parseInt(stdout.trim()) || 0;
  }

  private async countScripts(): Promise<number> {
    const { stdout } = await exec('find scripts/ -type f \\( -name "*.sh" -o -name "*.py" \\) 2>/dev/null | wc -l');
    return parseInt(stdout.trim()) || 0;
  }

  private async findOrphanedScripts(): Promise<string[]> {
    const orphaned: string[] = [];
    const { stdout } = await exec('find scripts/ -type f 2>/dev/null');
    const scripts = stdout.trim().split('\n').filter(Boolean);

    for (const script of scripts) {
      const basename = path.basename(script);
      // Check if referenced anywhere except in scripts/ itself
      const { stdout: refs } = await exec(
        `rg -l "\\b${basename}\\b" . --glob '!scripts/*' 2>/dev/null || true`
      );
      if (!refs.trim()) {
        orphaned.push(script);
      }
    }

    return orphaned;
  }

  private async findOverlappingCrons(): Promise<Array<{ cron1: string; cron2: string; schedule: string }>> {
    // Parse crontab and find entries with identical schedules
    const { stdout } = await exec('crontab -l 2>/dev/null');
    const lines = stdout.split('\n').filter(l => l && !l.startsWith('#'));

    const scheduleMap = new Map<string, string[]>();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6) {
        const schedule = parts.slice(0, 5).join(' ');
        const command = parts.slice(5).join(' ');
        if (!scheduleMap.has(schedule)) {
          scheduleMap.set(schedule, []);
        }
        scheduleMap.get(schedule)!.push(command);
      }
    }

    const overlaps: Array<{ cron1: string; cron2: string; schedule: string }> = [];
    for (const [schedule, commands] of scheduleMap) {
      if (commands.length > 1) {
        for (let i = 0; i < commands.length - 1; i++) {
          overlaps.push({
            cron1: commands[i],
            cron2: commands[i + 1],
            schedule,
          });
        }
      }
    }

    return overlaps;
  }

  private async getStateFileSize(): Promise<number> {
    const { stdout } = await exec('du -sm /workspace/grimoires/loa/ 2>/dev/null | cut -f1');
    return parseInt(stdout.trim()) || 0;
  }

  private async writeToNotes(result: BloatAuditResult): Promise<void> {
    const timestamp = result.timestamp.toISOString();
    const statusEmoji = result.status === 'healthy' ? '✅' :
                        result.status === 'warning' ? '⚠️' : '🚨';

    const entry = `
### Bloat Audit ${timestamp}

**Status**: ${statusEmoji} ${result.status.toUpperCase()}

| Metric | Count | Threshold |
|--------|-------|-----------|
| Crons | ${result.counts.crons} | warn: ${this.thresholds.crons.warn}, crit: ${this.thresholds.crons.critical} |
| Scripts | ${result.counts.scripts} | warn: ${this.thresholds.scripts.warn}, crit: ${this.thresholds.scripts.critical} |
| Orphaned | ${result.counts.orphanedScripts} | - |
| Overlapping | ${result.counts.overlappingCrons} | - |
| State Size | ${result.counts.stateFileSizeMB}MB | warn: ${this.thresholds.stateFileSize.warn}MB |

${result.violations.length > 0 ? '**Violations:**\n' + result.violations.map(v => `- [${v.severity}] ${v.type}: ${v.details}`).join('\n') : ''}

${result.remediation.length > 0 ? '**Remediation:**\n' + result.remediation.map(r => `- ${r}`).join('\n') : ''}
`;

    await this.appendToNotes(entry);
  }
}
```

### 10.4 MECE Task Validation

**Purpose**: Prevent redundant/overlapping scheduled tasks.

```typescript
// deploy/loa-identity/scheduler/mece-validator.ts

interface MECERule {
  type: 'cron_overlap' | 'script_similarity' | 'purpose_missing';
  check: (candidate: TaskCandidate) => Promise<MECEViolation | null>;
}

interface TaskCandidate {
  type: 'cron' | 'script';
  name: string;
  schedule?: string;
  purpose?: string;
  content?: string;
}

interface MECEViolation {
  rule: string;
  candidate: string;
  conflictsWith?: string;
  similarity?: number;
  suggestion: string;
}

class MECEValidator {
  private auditLog: AuditLogger;
  private similarityThreshold = 0.7;

  constructor() {
    this.auditLog = new AuditLogger('/workspace/.loa/mece-audit.log');
  }

  /**
   * Validate a new task before creation
   * @throws Error with MECE violation details if invalid
   */
  async validate(candidate: TaskCandidate): Promise<{ valid: boolean; violations: MECEViolation[] }> {
    const violations: MECEViolation[] = [];

    // Rule 1: No overlapping cron schedules
    if (candidate.type === 'cron' && candidate.schedule) {
      const existing = await this.getExistingCronSchedules();
      const conflict = existing.find(e => e.schedule === candidate.schedule);
      if (conflict) {
        violations.push({
          rule: 'cron_overlap',
          candidate: candidate.name,
          conflictsWith: conflict.name,
          suggestion: `Stagger schedule or consolidate with ${conflict.name}`,
        });
      }
    }

    // Rule 2: No highly similar script names
    if (candidate.type === 'script') {
      const existingScripts = await this.getExistingScripts();
      for (const existing of existingScripts) {
        const similarity = this.calculateNameSimilarity(candidate.name, existing);
        if (similarity >= this.similarityThreshold) {
          violations.push({
            rule: 'script_similarity',
            candidate: candidate.name,
            conflictsWith: existing,
            similarity,
            suggestion: `Check if ${existing} already does this - consolidate if so`,
          });
        }
      }
    }

    // Rule 3: Purpose header required
    if (!candidate.purpose) {
      violations.push({
        rule: 'purpose_missing',
        candidate: candidate.name,
        suggestion: 'Add PURPOSE header describing what this task does',
      });
    }

    // Log validation
    await this.auditLog.log('mece_validation', {
      candidate,
      valid: violations.length === 0,
      violations,
    });

    return { valid: violations.length === 0, violations };
  }

  /**
   * Calculate Levenshtein-based name similarity
   */
  private calculateNameSimilarity(a: string, b: string): number {
    // Normalize: lowercase, remove extension, split on - and _
    const normalize = (s: string) => s.toLowerCase()
      .replace(/\.(sh|py|ts|js)$/, '')
      .split(/[-_]/)
      .join(' ');

    const na = normalize(a);
    const nb = normalize(b);

    // Jaccard similarity on words
    const wordsA = new Set(na.split(/\s+/));
    const wordsB = new Set(nb.split(/\s+/));
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }

  private async getExistingCronSchedules(): Promise<Array<{ name: string; schedule: string }>> {
    // Implementation would read from scheduler config or crontab
    return [];
  }

  private async getExistingScripts(): Promise<string[]> {
    const { stdout } = await exec('find scripts/ -type f 2>/dev/null');
    return stdout.trim().split('\n').filter(Boolean).map(p => path.basename(p));
  }
}
```

### 10.5 Notification Sink Interface

**Purpose**: Unified alerting for critical operational events.

```typescript
// deploy/loa-identity/scheduler/notification-sink.ts

interface NotificationSink {
  notify(
    severity: 'info' | 'warning' | 'critical',
    message: string,
    context?: Record<string, unknown>
  ): Promise<void>;
}

interface NotificationConfig {
  enabled: boolean;
  channels: NotificationChannel[];
  minSeverity: 'info' | 'warning' | 'critical';
}

interface NotificationChannel {
  type: 'slack' | 'discord' | 'webhook' | 'log';
  url?: string;
  channel?: string;
}

class CompositeNotificationSink implements NotificationSink {
  private channels: NotificationChannel[];
  private minSeverity: 'info' | 'warning' | 'critical';
  private severityOrder = { info: 0, warning: 1, critical: 2 };

  constructor(config: NotificationConfig) {
    this.channels = config.channels;
    this.minSeverity = config.minSeverity;
  }

  async notify(
    severity: 'info' | 'warning' | 'critical',
    message: string,
    context?: Record<string, unknown>
  ): Promise<void> {
    // Filter by minimum severity
    if (this.severityOrder[severity] < this.severityOrder[this.minSeverity]) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      severity,
      message,
      context,
      source: 'loa-beauvoir',
    };

    // Send to all configured channels
    await Promise.allSettled(
      this.channels.map(channel => this.sendToChannel(channel, payload))
    );
  }

  private async sendToChannel(
    channel: NotificationChannel,
    payload: Record<string, unknown>
  ): Promise<void> {
    switch (channel.type) {
      case 'slack':
        await this.sendSlack(channel, payload);
        break;
      case 'discord':
        await this.sendDiscord(channel, payload);
        break;
      case 'webhook':
        await this.sendWebhook(channel, payload);
        break;
      case 'log':
        console.log(`[${payload.severity}] ${payload.message}`, payload.context);
        break;
    }
  }

  private async sendSlack(channel: NotificationChannel, payload: Record<string, unknown>): Promise<void> {
    if (!channel.url) return;
    const emoji = payload.severity === 'critical' ? '🚨' :
                  payload.severity === 'warning' ? '⚠️' : 'ℹ️';
    await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${emoji} *${payload.severity?.toString().toUpperCase()}*: ${payload.message}`,
        attachments: payload.context ? [{
          fields: Object.entries(payload.context as Record<string, unknown>).map(([k, v]) => ({
            title: k,
            value: String(v),
            short: true,
          })),
        }] : undefined,
      }),
    });
  }

  private async sendDiscord(channel: NotificationChannel, payload: Record<string, unknown>): Promise<void> {
    if (!channel.url) return;
    const color = payload.severity === 'critical' ? 0xff0000 :
                  payload.severity === 'warning' ? 0xffaa00 : 0x00aaff;
    await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: `${payload.severity?.toString().toUpperCase()}: Loa Beauvoir`,
          description: payload.message,
          color,
          fields: payload.context ? Object.entries(payload.context as Record<string, unknown>).map(([k, v]) => ({
            name: k,
            value: String(v),
            inline: true,
          })) : undefined,
          timestamp: payload.timestamp,
        }],
      }),
    });
  }

  private async sendWebhook(channel: NotificationChannel, payload: Record<string, unknown>): Promise<void> {
    if (!channel.url) return;
    await fetch(channel.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}
```

### 10.6 Meta-Scheduler Monitoring

**Purpose**: Detect and recover from scheduler stalls.

```typescript
// deploy/loa-identity/scheduler/meta-monitor.ts

interface MetaMonitorConfig {
  checkIntervalMinutes: number;    // Default: 15
  stallThresholdMinutes: number;   // Default: 30
  restartCommand: string;          // Default: systemctl restart loa-scheduler
  ownershipMode: 'standalone' | 'systemd_notify';  // Default: standalone
  gracePeriodSeconds: number;      // Default: 30 (SIGTERM before SIGKILL)
}

class MetaSchedulerMonitor {
  private config: MetaMonitorConfig;
  private heartbeatPath = '/workspace/.loa/scheduler-heartbeat';
  private auditLog: AuditLogger;

  constructor(config?: Partial<MetaMonitorConfig>) {
    this.config = {
      checkIntervalMinutes: config?.checkIntervalMinutes ?? 15,
      stallThresholdMinutes: config?.stallThresholdMinutes ?? 30,
      restartCommand: config?.restartCommand ?? 'systemctl restart loa-scheduler',
    };
    this.auditLog = new AuditLogger('/workspace/.loa/meta-monitor.log');
  }

  /**
   * Check scheduler health (called by external cron/systemd timer)
   */
  async check(): Promise<{ healthy: boolean; stalledMinutes: number; action: string | null }> {
    const heartbeat = await this.readHeartbeat();

    if (!heartbeat) {
      await this.auditLog.log('scheduler_check', { status: 'no_heartbeat' });
      return {
        healthy: false,
        stalledMinutes: Infinity,
        action: 'No heartbeat file found - scheduler may never have started',
      };
    }

    const stalledMinutes = (Date.now() - heartbeat.getTime()) / (1000 * 60);

    if (stalledMinutes > this.config.stallThresholdMinutes) {
      await this.auditLog.log('scheduler_stall_detected', {
        lastHeartbeat: heartbeat.toISOString(),
        stalledMinutes,
      });

      // Attempt auto-restart
      try {
        await this.restartScheduler();
        await this.auditLog.log('scheduler_restarted', { success: true });
        await this.writeToNotes(
          `[META-MONITOR] Scheduler stalled ${stalledMinutes.toFixed(0)}min, auto-restarted`
        );
        return {
          healthy: false,
          stalledMinutes,
          action: 'Auto-restarted scheduler',
        };
      } catch (e) {
        await this.auditLog.log('scheduler_restart_failed', { error: String(e) });
        await this.writeToNotes(
          `[META-MONITOR] Scheduler restart FAILED - manual intervention needed`
        );
        return {
          healthy: false,
          stalledMinutes,
          action: `Restart failed: ${e}`,
        };
      }
    }

    return { healthy: true, stalledMinutes, action: null };
  }

  /**
   * Called by scheduler to update heartbeat
   */
  async recordHeartbeat(): Promise<void> {
    await fs.writeFile(this.heartbeatPath, new Date().toISOString());
  }

  private async readHeartbeat(): Promise<Date | null> {
    try {
      const content = await fs.readFile(this.heartbeatPath, 'utf-8');
      return new Date(content.trim());
    } catch {
      return null;
    }
  }

  private async restartScheduler(): Promise<void> {
    await exec(this.config.restartCommand);
  }

  private async writeToNotes(message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const entry = `| ${timestamp} | meta-monitor | ${message} |`;
    await fs.appendFile('/workspace/grimoires/loa/NOTES.md', entry + '\n');
  }
}
```

### 10.7 Context Threshold Alerts

**Purpose**: Warn before context compaction occurs.

```typescript
// deploy/loa-identity/memory/context-tracker.ts

interface ContextThresholds {
  warmPercent: number;     // Default: 60
  wrapUpPercent: number;   // Default: 70
  imminentPercent: number; // Default: 80
}

interface ContextStatus {
  usedTokens: number;
  maxTokens: number;
  usagePercent: number;
  status: 'ok' | 'warm' | 'wrap_up' | 'imminent';
  message: string | null;
}

class ContextTracker {
  private thresholds: ContextThresholds;
  private maxTokens: number;
  private lastWarningPercent = 0;

  constructor(maxTokens: number, thresholds?: Partial<ContextThresholds>) {
    this.maxTokens = maxTokens;
    this.thresholds = {
      warmPercent: thresholds?.warmPercent ?? 60,
      wrapUpPercent: thresholds?.wrapUpPercent ?? 70,
      imminentPercent: thresholds?.imminentPercent ?? 80,
    };
  }

  /**
   * Check context usage and emit warnings as needed
   */
  check(usedTokens: number): ContextStatus {
    const usagePercent = (usedTokens / this.maxTokens) * 100;

    let status: ContextStatus['status'] = 'ok';
    let message: string | null = null;

    if (usagePercent >= this.thresholds.imminentPercent) {
      status = 'imminent';
      if (this.lastWarningPercent < this.thresholds.imminentPercent) {
        message = `⚠️ Context ${usagePercent.toFixed(0)}% - compaction imminent, save progress`;
      }
    } else if (usagePercent >= this.thresholds.wrapUpPercent) {
      status = 'wrap_up';
      if (this.lastWarningPercent < this.thresholds.wrapUpPercent) {
        message = `⚠️ Context ${usagePercent.toFixed(0)}% - consider wrapping up current task`;
      }
    } else if (usagePercent >= this.thresholds.warmPercent) {
      status = 'warm';
      if (this.lastWarningPercent < this.thresholds.warmPercent) {
        message = `ℹ️ Context ${usagePercent.toFixed(0)}% - getting warm`;
      }
    }

    // Update last warning level
    if (usagePercent >= this.thresholds.imminentPercent) {
      this.lastWarningPercent = this.thresholds.imminentPercent;
    } else if (usagePercent >= this.thresholds.wrapUpPercent) {
      this.lastWarningPercent = this.thresholds.wrapUpPercent;
    } else if (usagePercent >= this.thresholds.warmPercent) {
      this.lastWarningPercent = this.thresholds.warmPercent;
    }

    return {
      usedTokens,
      maxTokens: this.maxTokens,
      usagePercent,
      status,
      message,
    };
  }

  /**
   * Reset warning state (call on session start)
   */
  reset(): void {
    this.lastWarningPercent = 0;
  }
}
```

### 10.8 Non-LLM Health Checks

**Purpose**: Reduce API calls by using shell scripts for routine health checks.

```bash
#!/bin/bash
# deploy/loa-identity/scripts/health-check.sh
#
# PURPOSE: Non-LLM health check to reduce API usage
# OWNER: operational-hardening
# DOES NOT: Invoke LLM for routine status checks
#
# Exit codes:
#   0 = healthy
#   1 = unhealthy (requires LLM triage)
#   2 = degraded (log warning, continue)
#   124 = timeout (script took too long)

set -euo pipefail

# Timeout protection (Flatline Review IMP-005/SKP-005)
HEALTH_CHECK_TIMEOUT="${HEALTH_CHECK_TIMEOUT:-30}"

# Self-timeout wrapper - re-exec with timeout if not already wrapped
if [[ "${HEALTH_CHECK_WRAPPED:-}" != "true" ]]; then
    export HEALTH_CHECK_WRAPPED=true
    exec timeout "$HEALTH_CHECK_TIMEOUT" "$0" "$@"
fi

HEALTH_LOG="/workspace/.loa/health.log"
ANOMALY_FILE="/workspace/.loa/health-anomaly.json"

log() {
    echo "[$(date -Iseconds)] $*" >> "$HEALTH_LOG"
}

check_r2_mount() {
    if ! mount | grep -q s3fs; then
        echo '{"check":"r2_mount","status":"failed","message":"R2 not mounted"}' > "$ANOMALY_FILE"
        return 1
    fi
    return 0
}

check_wal_size() {
    local size_mb
    size_mb=$(du -sm /data/wal/ 2>/dev/null | cut -f1 || echo 0)
    if [ "$size_mb" -gt 50 ]; then
        echo '{"check":"wal_size","status":"warning","size_mb":'$size_mb'}' > "$ANOMALY_FILE"
        return 2
    fi
    return 0
}

check_scheduler_heartbeat() {
    local heartbeat_file="/workspace/.loa/scheduler-heartbeat"
    if [ ! -f "$heartbeat_file" ]; then
        echo '{"check":"scheduler","status":"failed","message":"No heartbeat"}' > "$ANOMALY_FILE"
        return 1
    fi

    local age_minutes
    age_minutes=$(( ($(date +%s) - $(date -r "$heartbeat_file" +%s)) / 60 ))
    if [ "$age_minutes" -gt 30 ]; then
        echo '{"check":"scheduler","status":"failed","stalled_minutes":'$age_minutes'}' > "$ANOMALY_FILE"
        return 1
    fi
    return 0
}

check_grimoire_integrity() {
    local manifest="/workspace/grimoires/loa/.loa-state-manifest.json"
    if [ ! -f "$manifest" ]; then
        echo '{"check":"integrity","status":"warning","message":"No manifest"}' > "$ANOMALY_FILE"
        return 2
    fi
    return 0
}

# Run all checks
rm -f "$ANOMALY_FILE"
exit_code=0

log "Starting health check"

if ! check_r2_mount; then
    log "FAIL: R2 mount check"
    exit_code=1
fi

if ! check_wal_size; then
    log "WARN: WAL size check"
    [ "$exit_code" -eq 0 ] && exit_code=2
fi

if ! check_scheduler_heartbeat; then
    log "FAIL: Scheduler heartbeat"
    exit_code=1
fi

if ! check_grimoire_integrity; then
    log "WARN: Grimoire integrity"
    [ "$exit_code" -eq 0 ] && exit_code=2
fi

if [ "$exit_code" -eq 0 ]; then
    log "All checks passed"
elif [ "$exit_code" -eq 1 ]; then
    log "UNHEALTHY - LLM triage required"
elif [ "$exit_code" -eq 2 ]; then
    log "DEGRADED - continuing with warnings"
fi

exit $exit_code
```

### 10.9 Configuration Schema

```yaml
# .loa.config.yaml - Operational Hardening Section

operational_hardening:
  # FR-6: Subagent Timeout Enforcement
  subagent_timeout:
    min_minutes: 30          # Minimum for trusted models
    warn_below_minutes: 10   # Log warning if below this
    hard_floor_minutes: 3    # Block spawn if below this
    trusted_models:
      - 'claude-opus'
      - 'opus-4'
      - 'codex-max'

  # FR-7: Weekly Bloat Audit
  bloat_audit:
    enabled: true
    schedule: "0 0 * * 0"    # Sunday midnight UTC
    thresholds:
      crons: { warn: 15, critical: 20 }
      scripts: { warn: 40, critical: 50 }
      state_file_mb: { warn: 5, critical: 10 }

  # FR-8: MECE Validation
  mece_validation:
    enabled: true
    require_purpose_header: true
    block_overlapping_crons: true
    script_similarity_threshold: 0.7

  # FR-9: Meta-Scheduler Monitoring
  meta_monitor:
    enabled: true
    check_interval_minutes: 15
    stall_threshold_minutes: 30
    auto_restart: true
    ownership_mode: standalone  # standalone | systemd_notify
    grace_period_seconds: 30    # SIGTERM before SIGKILL

  # Notifications (Flatline Review high-consensus)
  notifications:
    enabled: true
    min_severity: warning  # info | warning | critical
    channels:
      - type: log  # Always log
      # - type: slack
      #   url: "https://hooks.slack.com/services/..."
      # - type: discord
      #   url: "https://discord.com/api/webhooks/..."
      # - type: webhook
      #   url: "https://your-webhook-endpoint.com/alerts"

  # FR-10: Context Tracking
  context_tracking:
    enabled: true
    thresholds:
      warm_percent: 60
      wrap_up_percent: 70
      imminent_percent: 80

  # FR-11: Non-LLM Health Checks
  health_checks:
    use_shell_script: true
    llm_triage_on_anomaly: true
    interval_minutes: 5
    timeout_seconds: 30  # Self-timeout for health script
```

### 10.10 Operational Hardening Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    OPERATIONAL HARDENING DATA FLOW                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Subagent Spawn Request                                                     │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐                                │
│  │TimeoutEnforcer  │───►│ Audit Log       │                                │
│  │- Check floor    │    │ timeout_*       │                                │
│  │- Adjust trusted │    └─────────────────┘                                │
│  └────────┬────────┘                                                        │
│           │ Pass/Fail                                                       │
│           ▼                                                                 │
│                                                                             │
│  New Task Creation Request                                                  │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────┐    ┌─────────────────┐                                │
│  │ MECEValidator   │───►│ Audit Log       │                                │
│  │- Check overlap  │    │ mece_*          │                                │
│  │- Check similar  │    └─────────────────┘                                │
│  │- Require purpose│                                                        │
│  └────────┬────────┘                                                        │
│           │ Pass/Fail                                                       │
│           ▼                                                                 │
│                                                                             │
│  ══════════════════════════════════════════════════════════════════════════ │
│  SCHEDULED (via Scheduler)                                                  │
│  ══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│  Every 5 minutes:                                                           │
│  ┌─────────────────┐    ┌─────────────────┐                                │
│  │ health-check.sh │───►│ anomaly.json    │                                │
│  │ (Non-LLM)       │    └────────┬────────┘                                │
│  └─────────────────┘             │ if unhealthy                            │
│                                  ▼                                          │
│                         ┌─────────────────┐                                │
│                         │ LLM Triage      │                                │
│                         │ (on anomaly)    │                                │
│                         └─────────────────┘                                │
│                                                                             │
│  Every 15 minutes:                                                          │
│  ┌─────────────────┐    ┌─────────────────┐                                │
│  │MetaMonitor.check│───►│ Audit Log       │                                │
│  │- Read heartbeat │    │ scheduler_*     │                                │
│  │- Auto-restart   │    └─────────────────┘                                │
│  └─────────────────┘                                                        │
│                                                                             │
│  Every Sunday:                                                              │
│  ┌─────────────────┐    ┌─────────────────┐   ┌─────────────────┐         │
│  │BloatAuditor.run │───►│ Audit Log       │──►│ NOTES.md        │         │
│  │- Count crons    │    │ bloat_audit     │   │ (summary)       │         │
│  │- Count scripts  │    └─────────────────┘   └─────────────────┘         │
│  │- Find orphans   │                                                        │
│  │- Check sizes    │                                                        │
│  └─────────────────┘                                                        │
│                                                                             │
│  On every session:                                                          │
│  ┌─────────────────┐                                                        │
│  │ContextTracker   │──► Emit warnings at 60/70/80% thresholds              │
│  └─────────────────┘                                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Appendix D: Operational Hardening Integration Points

### D.1 Integration with Scheduler (Sprint 11)

The operational hardening components integrate with the existing scheduler:

```typescript
// deploy/loa-identity/scheduler/scheduler.ts (additions)

class Scheduler {
  private timeoutEnforcer: TimeoutEnforcer;
  private meceValidator: MECEValidator;
  private bloatAuditor: BloatAuditor;
  private metaMonitor: MetaSchedulerMonitor;

  constructor() {
    // Load config from .loa.config.yaml
    const config = this.loadConfig();

    this.timeoutEnforcer = new TimeoutEnforcer(config.subagent_timeout);
    this.meceValidator = new MECEValidator();
    this.bloatAuditor = new BloatAuditor(config.bloat_audit.thresholds);
    this.metaMonitor = new MetaSchedulerMonitor(config.meta_monitor);
  }

  /**
   * Hook: Before spawning subagent
   */
  async beforeSubagentSpawn(modelId: string, timeoutMinutes: number): Promise<number> {
    const result = await this.timeoutEnforcer.validateTimeout(modelId, timeoutMinutes);
    return result.adjustedMinutes;
  }

  /**
   * Hook: Before creating scheduled task
   */
  async beforeTaskCreate(candidate: TaskCandidate): Promise<void> {
    const result = await this.meceValidator.validate(candidate);
    if (!result.valid) {
      throw new Error(
        'MECE validation failed:\n' +
        result.violations.map(v => `- ${v.rule}: ${v.suggestion}`).join('\n')
      );
    }
  }

  /**
   * Run scheduled jobs
   */
  async runScheduledJobs(): Promise<void> {
    // Record heartbeat for meta-monitoring
    await this.metaMonitor.recordHeartbeat();

    // ... existing job execution
  }
}
```

### D.2 Integration with Session Memory (Sprint 7)

Context tracking integrates with the session memory manager:

```typescript
// deploy/loa-identity/memory/session-manager.ts (additions)

class SessionMemoryManager {
  private contextTracker: ContextTracker;

  constructor() {
    // ... existing initialization
    this.contextTracker = new ContextTracker(200000); // 200K token limit
  }

  async capture(entry: MemoryEntry): Promise<string | null> {
    // ... existing capture logic

    // Check context usage after capture
    const tokenCount = await this.estimateTokenCount();
    const status = this.contextTracker.check(tokenCount);

    if (status.message) {
      console.log(status.message);
      await this.appendToNotes(`| ${new Date().toISOString()} | context | ${status.message} |`);
    }

    return entryId;
  }
}
```

---

*Generated by Loa Framework v1.22.0*
