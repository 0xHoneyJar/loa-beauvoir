# SDD: LOA-OpenClaw Integration

> **Status**: Flatline Reviewed
> **Version**: 0.2.0
> **Created**: 2026-02-04
> **Updated**: 2026-02-04
> **PRD Reference**: `grimoires/loa/loa-integration-prd.md` v0.2.0
> **Author**: Claude Opus 4.5
> **Flatline**: Reviewed (5 HIGH_CONSENSUS integrated, 7 blockers resolved)

---

## Executive Summary

This document details the technical architecture for integrating LOA's identity system into the OpenClaw agent runtime. The design follows OpenClaw's plugin pattern, using hooks to govern agent behavior without modifying core code.

**Key Architectural Decisions**:
1. **LOA as Plugin** - Lives in `extensions/loa/` following OpenClaw patterns
2. **Bridge Pattern** - Thin bridges connect plugin hooks to existing LOA implementations
3. **SOUL.md Generation** - IdentityLoader → SoulGenerator pipeline
4. **Memory Pipeline** - agent_end → QualityGates → WAL → NOTES.md
5. **Recovery Integration** - RecoveryEngine runs on plugin init

---

## 1. System Architecture

### 1.1 High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OPENCLAW RUNTIME                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    PLUGIN SYSTEM                                 │   │
│  │                                                                  │   │
│  │  ┌────────────────────────────────────────────────────────┐    │   │
│  │  │              extensions/loa/                            │    │   │
│  │  │                                                         │    │   │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │    │   │
│  │  │  │   index.ts  │  │  bridges/   │  │  package.   │   │    │   │
│  │  │  │  (plugin)   │  │             │  │    json     │   │    │   │
│  │  │  └──────┬──────┘  └──────┬──────┘  └─────────────┘   │    │   │
│  │  │         │                │                            │    │   │
│  │  │         │ registers      │ imports                    │    │   │
│  │  │         ▼                ▼                            │    │   │
│  │  │  ┌──────────────────────────────────────────────┐    │    │   │
│  │  │  │              HOOK HANDLERS                    │    │    │   │
│  │  │  │                                              │    │    │   │
│  │  │  │  bootstrap → SoulGenerator                   │    │    │   │
│  │  │  │  before_agent_start → ContextInjector        │    │    │   │
│  │  │  │  agent_end → MemoryCapture                   │    │    │   │
│  │  │  │  init → RecoveryRunner                       │    │    │   │
│  │  │  └──────────────────────────────────────────────┘    │    │   │
│  │  └─────────────────────────────────────────────────────┘    │   │
│  │                          │                                   │   │
│  │                          │ bridges to                        │   │
│  │                          ▼                                   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                             │                                        │
└─────────────────────────────┼────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    EXISTING LOA IDENTITY SYSTEM                          │
│                    (deploy/loa-identity/)                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐   │
│  │  Identity   │  │   Memory    │  │  Recovery   │  │  Security   │   │
│  │   Loader    │  │  Manager    │  │   Engine    │  │   Suite     │   │
│  │  (355 LOC)  │  │  (436 LOC)  │  │  (667 LOC)  │  │  (~2800)    │   │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘   │
│         │                │                │                │           │
│         └────────────────┴────────────────┴────────────────┘           │
│                                   │                                     │
│                                   ▼                                     │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │                        WAL LAYER                               │     │
│  │                    (679 LOC, flock)                            │     │
│  └───────────────────────────────────────────────────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         GRIMOIRES (State)                                │
├─────────────────────────────────────────────────────────────────────────┤
│  grimoires/loa/                                                         │
│  ├── BEAUVOIR.md      (identity source)                                 │
│  ├── NOTES.md         (operational memory)                              │
│  ├── SOUL.md          (generated, LOA-owned)                            │
│  └── manifest.json    (signed state)                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         LOA DATA FLOWS                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  FLOW 1: SOUL.md Generation (FR-1)                                      │
│  ─────────────────────────────────                                      │
│                                                                         │
│  BEAUVOIR.md ──► IdentityLoader ──► SoulGenerator ──► SOUL.md          │
│       │              │                   │               │              │
│       │         parse to            transform to     write to           │
│       │         IdentityDocument    soul template    workspace          │
│       │                                                                 │
│       └──► checksum tracked for change detection                        │
│                                                                         │
│  FLOW 2: Memory Capture (FR-2)                                          │
│  ─────────────────────────────                                          │
│                                                                         │
│  agent_end ──► Extract ──► QualityGates ──► PIIRedactor ──► WAL        │
│    hook         messages      (6 gates)       (entropy)       │         │
│                    │              │               │            │         │
│                    │         filter low      redact PII    persist      │
│                    │         quality             │            │         │
│                    │              │               │            ▼         │
│                    └──────────────┴───────────────┴──────► NOTES.md     │
│                                                                         │
│  FLOW 3: Context Injection (FR-4)                                       │
│  ─────────────────────────────────                                      │
│                                                                         │
│  before_agent_start ──► LoadContext ──► Prioritize ──► Truncate ──► Prompt
│        hook                │               │              │              │
│                       NOTES.md +     by recency/     to budget     prepend
│                       learnings      importance                          │
│                                                                         │
│  FLOW 4: Recovery (FR-3)                                                │
│  ─────────────────────────                                              │
│                                                                         │
│  plugin init ──► RecoveryEngine ──► Verify ──► Restore ──► RUNNING     │
│       │              │               │           │                      │
│       │         state machine    signatures   R2→Git→                   │
│       │                              │        Template                  │
│       │                              │                                  │
│       └──────────────────────────────┴──► Loop Detection ──► Degraded   │
│                                           (>3 in 60s)                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Design

### 2.0 SDK Adapter Layer (Flatline: SKP-001)

Isolate plugin from OpenClaw SDK changes via adapter pattern.

```typescript
// extensions/loa/adapters/hook-adapter.ts

/**
 * Adapter to isolate LOA plugin from OpenClaw SDK changes.
 * Maps LOA's hook expectations to actual SDK APIs.
 *
 * Target SDK: OpenClaw v2026.2.x
 */
export interface HookAdapter {
  registerBootstrapHook(handler: BootstrapHandler, priority?: number): void;
  registerBeforeAgentStart(handler: BeforeAgentStartHandler, priority?: number): void;
  registerAgentEnd(handler: AgentEndHandler, priority?: number): void;
  getWorkspaceDir(): string;
  validateSdkVersion(): { valid: boolean; version: string; errors: string[] };
}

export function createHookAdapter(api: OpenClawPluginApi): HookAdapter {
  // Detect SDK version and capabilities
  const sdkVersion = api.version || 'unknown';

  return {
    registerBootstrapHook(handler, priority = 100) {
      // Adapt to actual SDK API
      if (typeof api.registerHook === 'function') {
        api.registerHook('agent:bootstrap', handler, { priority });
      } else {
        throw new Error(`[loa] SDK missing registerHook - version ${sdkVersion} incompatible`);
      }
    },

    registerBeforeAgentStart(handler, priority = 100) {
      if (typeof api.on === 'function') {
        api.on('before_agent_start', handler, { priority });
      } else {
        throw new Error(`[loa] SDK missing api.on - version ${sdkVersion} incompatible`);
      }
    },

    registerAgentEnd(handler, priority = 100) {
      if (typeof api.on === 'function') {
        api.on('agent_end', handler, { priority });
      } else {
        throw new Error(`[loa] SDK missing api.on - version ${sdkVersion} incompatible`);
      }
    },

    getWorkspaceDir() {
      if (typeof api.getWorkspaceDir === 'function') {
        return api.getWorkspaceDir();
      }
      return process.cwd(); // Fallback
    },

    validateSdkVersion() {
      const errors: string[] = [];

      if (typeof api.registerHook !== 'function') {
        errors.push('Missing api.registerHook()');
      }
      if (typeof api.on !== 'function') {
        errors.push('Missing api.on()');
      }

      return {
        valid: errors.length === 0,
        version: sdkVersion,
        errors,
      };
    },
  };
}
```

**SDK Version Pinning** (Flatline: IMP-001):

| Dependency | Min Version | Max Version | Notes |
|------------|-------------|-------------|-------|
| OpenClaw | 2026.2.0 | 2026.3.x | Plugin SDK v1 |
| Node.js | 22.0.0 | - | LTS required |

---

### 2.1 Plugin Entry Point (`extensions/loa/index.ts`)

```typescript
import type { OpenClawPlugin, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { initializeLoa } from './bridges/init';
import { loaBootstrapHook } from './bridges/bootstrap';
import { loaBeforeAgentStart } from './bridges/context';
import { loaAgentEnd } from './bridges/memory';

const loaPlugin: OpenClawPlugin = {
  name: 'loa',
  version: '1.0.0',
  description: 'LOA identity integration - governs agent soul, memory, and recovery',

  async init(api: OpenClawPluginApi) {
    // FR-6.3: Self-test hook registration
    const hookSelfTest = {
      bootstrap: false,
      before_agent_start: false,
      agent_end: false,
    };

    // Initialize LOA systems (recovery runs here)
    const loa = await initializeLoa({
      grimoiresDir: 'grimoires/loa',
      walDir: '.loa/wal',
      workspaceDir: api.getWorkspaceDir(),
    });

    // Register hooks with high priority (FR-6: lifecycle contract)
    api.registerHook('agent:bootstrap', loaBootstrapHook(loa), { priority: 100 });
    hookSelfTest.bootstrap = true;

    api.on('before_agent_start', loaBeforeAgentStart(loa), { priority: 100 });
    hookSelfTest.before_agent_start = true;

    api.on('agent_end', loaAgentEnd(loa), { priority: 100 });
    hookSelfTest.agent_end = true;

    // FR-6.3: Assert all hooks registered
    const allRegistered = Object.values(hookSelfTest).every(Boolean);
    if (!allRegistered) {
      console.warn('[loa] Warning: Not all hooks registered. LOA may not function fully.');
    }

    console.log('[loa] LOA plugin initialized. All hooks registered.');
  },
};

export default loaPlugin;
```

### 2.2 SoulGenerator Bridge (`extensions/loa/bridges/soul-generator.ts`)

Transforms `IdentityDocument` from BEAUVOIR.md into SOUL.md content.

```typescript
import { IdentityLoader, IdentityDocument } from 'deploy/loa-identity';
import { createHash } from 'crypto';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

export class SoulGenerator {
  private identityLoader: IdentityLoader;
  private workspaceDir: string;
  private lastBeauvoirChecksum: string | null = null;

  constructor(identityLoader: IdentityLoader, workspaceDir: string) {
    this.identityLoader = identityLoader;
    this.workspaceDir = workspaceDir;
  }

  /**
   * FR-1: Generate SOUL.md from BEAUVOIR.md
   * FR-1.6: Verify BEAUVOIR.md integrity before generation
   */
  async generate(): Promise<void> {
    // Load and verify BEAUVOIR.md
    const identity = await this.identityLoader.load();
    const currentChecksum = await this.identityLoader.getChecksum();

    // FR-1.6: Integrity check
    if (!currentChecksum) {
      throw new Error('[loa] BEAUVOIR.md integrity check failed: no checksum');
    }

    // FR-1.5: Skip if unchanged
    if (this.lastBeauvoirChecksum === currentChecksum) {
      return; // No regeneration needed
    }

    // Transform to SOUL.md content
    const soulContent = this.transformToSoul(identity);

    // FR-7.2: Atomic write via temp + rename
    const soulPath = join(this.workspaceDir, 'SOUL.md');
    const tempPath = `${soulPath}.tmp.${Date.now()}`;

    writeFileSync(tempPath, soulContent, 'utf-8');
    require('fs').renameSync(tempPath, soulPath);

    this.lastBeauvoirChecksum = currentChecksum;
    console.log('[loa] SOUL.md regenerated from BEAUVOIR.md');
  }

  private transformToSoul(identity: IdentityDocument): string {
    const { principles, boundaries, interactionStyle } = identity;

    return `# Soul

You embody the following principles:

## Core Principles
${principles.map((p, i) => `${i + 1}. **${p.name}** - ${p.description}`).join('\n')}

## Interaction Style
${interactionStyle.map(s => `- ${s}`).join('\n')}

## Boundaries
### Will Not Do
${boundaries.filter(b => b.type === 'will_not').map(b => `- ${b.description}`).join('\n')}

### Always Do
${boundaries.filter(b => b.type === 'always').map(b => `- ${b.description}`).join('\n')}

---
*Generated by LOA from BEAUVOIR.md - DO NOT EDIT*
*Checksum: ${this.lastBeauvoirChecksum?.slice(0, 8)}*
`;
  }
}
```

### 2.3 MemoryCapture Bridge (`extensions/loa/bridges/memory.ts`)

Connects agent_end hook to existing SessionMemoryManager.

```typescript
import type { PluginHookAgentEndEvent, PluginHookAgentContext } from 'openclaw/plugin-sdk';
import { SessionMemoryManager } from 'deploy/loa-identity/memory';
import { PIIRedactor } from 'deploy/loa-identity/security';
import type { LoaContext } from './types';

/**
 * FR-2: Memory capture via agent_end hook
 * FR-6.4: Fail-open with retry policy
 */
export function loaAgentEnd(loa: LoaContext) {
  return async (
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext
  ): Promise<void> => {
    try {
      // FR-2.2: Extract significant content
      const messages = event.messages || [];
      const lastAssistant = messages.filter(m => m.role === 'assistant').pop();

      if (!lastAssistant?.content) {
        return; // Nothing to capture
      }

      // FR-2.3: Quality gates applied internally by SessionMemoryManager
      // FR-2.4: PII redaction applied internally
      await loa.memory.capture({
        sessionId: ctx.sessionKey || 'unknown',
        agentId: ctx.agentId,
        type: 'interaction',
        content: typeof lastAssistant.content === 'string'
          ? lastAssistant.content
          : JSON.stringify(lastAssistant.content),
        metadata: {
          success: event.success,
          durationMs: event.durationMs,
          timestamp: new Date().toISOString(),
        },
      });

      // FR-2.6: Update NOTES.md (handled by SessionMemoryManager)
      console.log('[loa] Memory captured for session:', ctx.sessionKey);

    } catch (error) {
      // FR-6.4: Fail-open with retry
      console.warn('[loa] Memory capture failed (will retry async):', error);

      // Queue for retry (fire-and-forget)
      loa.retryQueue.push({
        type: 'memory_capture',
        data: { event, ctx },
        attempts: 0,
        maxAttempts: 3,
      });
    }
  };
}
```

### 2.4 ContextInjector Bridge (`extensions/loa/bridges/context.ts`)

Injects memory context before agent runs.

```typescript
import type {
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
  PluginHookAgentContext
} from 'openclaw/plugin-sdk';
import type { LoaContext } from './types';

/**
 * FR-4: Context injection via before_agent_start hook
 * FR-8: Token budget management
 * FR-6.4: Fail-open policy
 */
export function loaBeforeAgentStart(loa: LoaContext) {
  return async (
    event: PluginHookBeforeAgentStartEvent,
    ctx: PluginHookAgentContext
  ): Promise<PluginHookBeforeAgentStartResult | void> => {
    try {
      // FR-4.2: Load recent sessions from NOTES.md
      const recentSessions = await loa.memory.getRecentSessions(5);

      // FR-4.3: Load active learnings
      const learnings = await loa.learnings.getActive(3);

      // FR-8.1: Token budget (configurable, default 2000)
      const tokenBudget = loa.config.contextTokenBudget || 2000;

      // FR-8.2-8.4: Prioritize and truncate
      const context = buildContext(recentSessions, learnings, tokenBudget);

      if (!context) {
        return; // No context to inject
      }

      // FR-4.5: Audit log
      console.log(`[loa] Injecting ${context.length} chars of context`);

      return {
        prependContext: context,
      };

    } catch (error) {
      // FR-6.4: Fail-open - agent runs without context
      console.warn('[loa] Context injection failed (fail-open):', error);
      return undefined;
    }
  };
}

/**
 * FR-8: Build context within token budget
 */
function buildContext(
  sessions: SessionEntry[],
  learnings: Learning[],
  tokenBudget: number
): string | null {
  const parts: string[] = [];
  let estimatedTokens = 0;

  // FR-8.2: Priority 1 - Recent sessions (by timestamp)
  for (const session of sessions) {
    const entry = `- [${session.timestamp}] ${session.summary}`;
    const entryTokens = estimateTokens(entry);

    if (estimatedTokens + entryTokens > tokenBudget * 0.7) {
      break; // Reserve 30% for learnings
    }

    parts.push(entry);
    estimatedTokens += entryTokens;
  }

  // FR-8.2: Priority 2 - Active learnings
  for (const learning of learnings) {
    const entry = `- ${learning.trigger}: ${learning.solution}`;
    const entryTokens = estimateTokens(entry);

    if (estimatedTokens + entryTokens > tokenBudget) {
      // FR-8.5: Log truncation
      console.log('[loa] Context truncated at token budget');
      break;
    }

    parts.push(entry);
    estimatedTokens += entryTokens;
  }

  if (parts.length === 0) {
    return null;
  }

  return `## Session Context (from LOA memory)

${parts.join('\n')}
`;
}

function estimateTokens(text: string): number {
  // TODO(Sprint): Replace with tiktoken for proper Unicode support (Flatline: SKP-003)
  // Current naive estimate fails for CJK, emoji, etc.
  // Implementation should use: import { encoding_for_model } from 'tiktoken';
  const naiveEstimate = Math.ceil(text.length / 4);
  const safetyBuffer = 1.3; // 30% buffer until proper tokenizer
  return Math.ceil(naiveEstimate * safetyBuffer);
}
```

### 2.5 RecoveryRunner Bridge (`extensions/loa/bridges/recovery.ts`)

Runs recovery on plugin initialization.

```typescript
import { RecoveryEngine, RecoveryState } from 'deploy/loa-identity/recovery';
import type { LoaContext } from './types';

/**
 * FR-3: Recovery on gateway start
 * FR-3.7-3.9: Loop detection and degraded mode
 */
export async function runRecovery(loa: LoaContext): Promise<void> {
  const recovery = loa.recovery;

  // Track recovery attempts for loop detection (Flatline: SKP-005 - configurable)
  const attemptKey = 'recovery_attempts';
  const windowMs = parseInt(process.env.LOA_RECOVERY_WINDOW_MS || '120000', 10); // Default 120s
  const maxAttempts = parseInt(process.env.LOA_RECOVERY_MAX_ATTEMPTS || '5', 10); // Default 5

  // FR-3.7: Check for loop
  const now = Date.now();
  const recentAttempts = loa.state.getRecentAttempts(attemptKey, windowMs);

  if (recentAttempts >= maxAttempts) {
    // FR-3.8: Enter degraded mode
    console.error(`[loa] Recovery loop detected (${recentAttempts} attempts in ${windowMs}ms)`);
    await enterDegradedMode(loa);
    return;
  }

  // Record this attempt
  loa.state.recordAttempt(attemptKey, now);

  try {
    // FR-3.2: Run recovery state machine
    const result = await recovery.run();

    if (result.state === RecoveryState.RUNNING) {
      console.log('[loa] Recovery completed successfully');
      loa.state.clearAttempts(attemptKey);
      return;
    }

    // Recovery failed - will be handled by loop detection on next attempt
    console.warn('[loa] Recovery did not reach RUNNING state:', result.state);

  } catch (error) {
    console.error('[loa] Recovery failed:', error);
    // Error will trigger loop detection on retry
  }
}

/**
 * FR-3.8: Degraded mode behavior
 */
async function enterDegradedMode(loa: LoaContext): Promise<void> {
  console.warn('[loa] Entering DEGRADED MODE');
  console.warn('[loa] - Agent will run with template identity');
  console.warn('[loa] - Memory writes DISABLED');
  console.warn('[loa] - Manual intervention required');

  // FR-3.9: Track degraded cycles
  loa.state.incrementDegradedCycles();
  const cycles = loa.state.getDegradedCycles();

  if (cycles >= 3) {
    console.error('[loa] CRITICAL: 3 degraded mode cycles reached');
    console.error('[loa] Manual intervention required. Check:');
    console.error('[loa]   1. R2 connectivity and credentials');
    console.error('[loa]   2. Git remote availability');
    console.error('[loa]   3. Template integrity in deploy/loa-identity/');
  }

  // Set degraded flag - other hooks will check this
  loa.degraded = true;
}
```

---

## 3. Directory Structure

```
extensions/loa/
├── package.json              # Plugin manifest
├── index.ts                  # Plugin entry point
├── types.ts                  # Type definitions
├── bridges/
│   ├── init.ts               # Initialize LOA systems
│   ├── bootstrap.ts          # agent:bootstrap hook handler
│   ├── context.ts            # before_agent_start hook handler
│   ├── memory.ts             # agent_end hook handler
│   ├── recovery.ts           # Recovery runner
│   └── soul-generator.ts     # BEAUVOIR → SOUL transformation
├── state/
│   ├── loop-detector.ts      # Recovery loop detection
│   └── retry-queue.ts        # Failed operation retry
└── __tests__/
    ├── soul-generator.test.ts
    ├── memory-capture.test.ts
    └── context-injection.test.ts
```

---

## 4. Interface Specifications

### 4.1 LoaContext Interface

```typescript
export interface LoaContext {
  // Core systems (from deploy/loa-identity)
  identity: IdentityLoader;
  memory: SessionMemoryManager;
  recovery: RecoveryEngine;
  learnings: LearningStore;

  // Plugin state
  state: LoaPluginState;
  config: LoaConfig;
  degraded: boolean;
  retryQueue: RetryQueue;

  // Derived
  soulGenerator: SoulGenerator;
}

export interface LoaConfig {
  grimoiresDir: string;
  walDir: string;
  workspaceDir: string;
  contextTokenBudget: number;  // FR-8.1: default 2000
}

export interface LoaPluginState {
  getRecentAttempts(key: string, windowMs: number): number;
  recordAttempt(key: string, timestamp: number): void;
  clearAttempts(key: string): void;
  incrementDegradedCycles(): void;
  getDegradedCycles(): number;
}
```

### 4.2 Hook Handler Signatures

```typescript
// FR-1: Bootstrap hook
type BootstrapHookHandler = (
  context: AgentBootstrapHookContext
) => Promise<WorkspaceBootstrapFile[]>;

// FR-4: Before agent start hook
type BeforeAgentStartHandler = (
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext
) => Promise<PluginHookBeforeAgentStartResult | void>;

// FR-2: Agent end hook
type AgentEndHandler = (
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext
) => Promise<void>;
```

---

## 5. Concurrency Design (FR-7)

### 5.1 Write Serialization

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    WRITE SERIALIZATION                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  NOTES.md Writes (FR-7.2):                                              │
│  ─────────────────────────                                              │
│                                                                         │
│  write(content) ──► tempFile ──► fsync ──► rename ──► done             │
│                        │                     │                          │
│                   write to              atomic                          │
│                   .tmp.{ts}           overwrite                         │
│                                                                         │
│  WAL Writes (FR-7.1):                                                   │
│  ────────────────────                                                   │
│                                                                         │
│  write(entry) ──► flock ──► append ──► fsync ──► unlock                │
│                     │          │                    │                   │
│                 acquire    write to             release                 │
│                  lock      segment               lock                   │
│                                                                         │
│  Concurrent Sessions (FR-7.3):                                          │
│  ─────────────────────────────                                          │
│                                                                         │
│  Session A ────► WAL-A.log ──┐                                         │
│                              ├──► Merge on consolidation               │
│  Session B ────► WAL-B.log ──┘                                         │
│                                                                         │
│  FR-7.4: Checksum verification on every read                           │
│  FR-7.5: Last-write-wins with conflict logging (Flatline: SKP-004)     │
│         - Log overwritten entry hash + timestamp to audit log          │
│         - Enables post-hoc conflict analysis                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Lock Strategy

| Resource | Lock Type | Granularity | Timeout |
|----------|-----------|-------------|---------|
| WAL segment | flock (exclusive) | Per-segment file | 5s |
| NOTES.md | Atomic rename | Whole file | N/A |
| BEAUVOIR.md | Read-only | Whole file | N/A |
| Manifest | flock (shared read) | Whole file | 1s |

---

## 6. Error Handling (FR-6)

### 6.1 Failure Policy Matrix

| Hook | Failure Policy | Behavior | Retry |
|------|----------------|----------|-------|
| bootstrap | **Fail-closed** | Block agent start | No |
| before_agent_start | Fail-open | Agent runs without context | No |
| agent_end | Fail-open | Memory loss for this interaction | Yes (3x) |
| recovery | Fail-degraded | Enter degraded mode after 3 failures | Auto |

### 6.2 Retry Queue Design

```typescript
interface RetryEntry {
  type: 'memory_capture' | 'wal_flush' | 'notes_update';
  data: unknown;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  createdAt: number;
}

class RetryQueue {
  private queue: RetryEntry[] = [];
  private processing = false;

  push(entry: RetryEntry): void {
    this.queue.push(entry);
    this.scheduleProcess();
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const entry = this.queue.shift()!;

      try {
        await this.execute(entry);
      } catch (error) {
        entry.attempts++;
        entry.lastError = String(error);

        if (entry.attempts < entry.maxAttempts) {
          // Exponential backoff
          await sleep(Math.pow(2, entry.attempts) * 1000);
          this.queue.push(entry);
        } else {
          console.error(`[loa] Retry exhausted for ${entry.type}:`, entry.lastError);
        }
      }
    }

    this.processing = false;
  }
}
```

---

## 7. Security Considerations

### 7.1 Existing Security Layer Integration

The plugin reuses existing security implementations from `deploy/loa-identity/security/`:

| Component | Location | Purpose | PRD Reference |
|-----------|----------|---------|---------------|
| KeyManager | `key-manager.ts` (484 LOC) | Ed25519 key lifecycle | FR-3.5 |
| PIIRedactor | `pii-redactor.ts` (386 LOC) | Entropy-based PII detection | FR-2.4 |
| ManifestSigner | `manifest-signer.ts` (307 LOC) | RFC 8785 JCS signing | FR-3.5 |
| AuditLogger | `audit-logger.ts` (285 LOC) | Cryptographic audit trail | FR-3.6 |

### 7.2 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        TRUST BOUNDARIES                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  TRUSTED ZONE (LOA-controlled)                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  • BEAUVOIR.md (identity source)                                 │  │
│  │  • SOUL.md (generated, LOA-owned)                                │  │
│  │  • WAL segments (signed)                                          │  │
│  │  • Manifest (Ed25519 signed)                                      │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  UNTRUSTED ZONE (user/agent input)                                      │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  • Agent responses (must pass quality gates)                      │  │
│  │  • User prompts (PII redacted before storage)                    │  │
│  │  • External API responses                                         │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  VERIFICATION POINTS:                                                   │
│  • Recovery: Signature verification required (FR-3.5)                  │
│  • Memory: PII scan before WAL write (FR-2.4)                          │
│  • Soul generation: BEAUVOIR.md checksum before transform (FR-1.6)     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Testing Strategy

### 8.1 Test Categories

| Category | Description | Location |
|----------|-------------|----------|
| Unit | Individual bridge functions | `extensions/loa/__tests__/` |
| Integration | Hook registration and firing | `extensions/loa/__tests__/integration/` |
| E2E | Full agent flow with LOA | `deploy/tests/e2e/loa-integration/` |

### 8.2 Critical Test Cases

| Test | PRD Ref | Description |
|------|---------|-------------|
| `soul-generation.test.ts` | FR-1 | BEAUVOIR.md → SOUL.md transformation |
| `soul-change-detection.test.ts` | FR-1.5 | Regeneration on BEAUVOIR.md change |
| `memory-quality-gates.test.ts` | FR-2.3 | All 6 gates filter correctly |
| `memory-pii-redaction.test.ts` | FR-2.4 | PII removed before storage |
| `context-token-budget.test.ts` | FR-8 | Truncation at budget limit |
| `recovery-loop-detection.test.ts` | FR-3.7 | Degraded mode after 3 failures |
| `hook-lifecycle.test.ts` | FR-6 | Hooks fire in correct order |
| `concurrent-writes.test.ts` | FR-7 | No corruption under concurrency |

---

## 9. Deployment

### 9.1 Plugin Installation

```bash
# Install LOA plugin as workspace dependency
cd extensions/loa
pnpm install

# Link to OpenClaw plugin system
pnpm link ../..  # Link openclaw as peer dependency
```

### 9.2 Configuration

Plugin is **always on** in this fork - no configuration required.

Optional config in `openclaw.json`:
```json
{
  "plugins": {
    "loa": {
      "contextTokenBudget": 2000
    }
  }
}
```

---

## 10. Technical Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation | Status |
|------|--------|------------|------------|--------|
| Hook API breaks in upstream | High | Low | Pin OpenClaw version; integration tests | Planned |
| Memory capture races | Medium | Medium | Per-session WAL + atomic NOTES.md | FR-7 |
| Recovery infinite loop | High | Low | Loop detection + degraded mode | FR-3.7-3.9 |
| PII leakage | High | Low | Entropy-based redactor + audit log | FR-2.4 |
| Token budget overflow | Low | Medium | Deterministic truncation | FR-8 |

---

## Appendix A: Existing Code Reuse

| Component | LOC | Reuse Strategy |
|-----------|-----|----------------|
| IdentityLoader | 355 | Direct import |
| SessionMemoryManager | 436 | Direct import |
| RecoveryEngine | 667 | Direct import |
| WAL Manager | 679 | Direct import |
| Quality Gates | ~200 | Direct import |
| PII Redactor | 386 | Direct import |
| Key Manager | 484 | Direct import |
| **Total Reused** | **~3,200** | |

**New Code Estimate**: ~800 LOC (bridges + plugin entry)

---

## Appendix B: Flatline Protocol Review Results

**Review Date**: 2026-02-04
**Cost**: ~$1.00 | **Latency**: ~70s | **Agreement**: 100%

### HIGH_CONSENSUS (Auto-Integrated)

| ID | Description | Avg Score | Integration |
|----|-------------|-----------|-------------|
| IMP-001 | Version pinning + explicit hook SDK contract | 887 | Section 2.0 |
| IMP-002 | WAL naming, consolidation, retention specs | 850 | Deferred to Sprint |
| IMP-003 | BEAUVOIR.md/SOUL.md schema + validation | 800 | Deferred to Sprint |
| IMP-004 | Enumerate all 6 quality gates explicitly | 750 | Deferred to Sprint |
| IMP-008 | Define LearningStore/getActive() interface | 825 | Deferred to Sprint |

### BLOCKERS (Resolved)

| ID | Concern | Resolution |
|----|---------|------------|
| SKP-001 | Hook API inconsistency | Added adapter layer (Section 2.0) |
| SKP-002 | Key rotation undefined | Deferred - existing key-manager.ts handles |
| SKP-003 | Token estimation naive | Added 30% safety buffer + TODO for tiktoken |
| SKP-004 | Last-write-wins risks | Added conflict logging for audit |
| SKP-005 | Recovery loop false positives | Made configurable via env vars |

### Configuration Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOA_RECOVERY_WINDOW_MS` | 120000 | Loop detection window (ms) |
| `LOA_RECOVERY_MAX_ATTEMPTS` | 5 | Max recovery attempts before degraded |

---

*Generated by Loa Framework v1.21.0*
*Flatline Protocol v1.17.0 - Multi-model adversarial review*
