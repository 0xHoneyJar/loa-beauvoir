/**
 * LOA Plugin for OpenClaw
 *
 * Integrates LOA's identity system (BEAUVOIR.md), memory capture,
 * and recovery into the OpenClaw agent runtime.
 *
 * LOA governs agent behavior through:
 * - SOUL.md generation from BEAUVOIR.md (bootstrap)
 * - Memory capture via agent_end hook
 * - Context injection via before_agent_start hook
 * - Recovery on gateway_start hook
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import type { LoaConfig, LoaContext, LoaPluginState } from './types.js';
import { createHookAdapter, type HookAdapter } from './adapters/hook-adapter.js';
import { initializeLoa } from './bridges/init.js';
import { createSoulGenerator } from './bridges/soul-generator.js';
import { createBootstrapHandler } from './bridges/bootstrap.js';
import { createMemoryCaptureHandler } from './bridges/memory.js';
import { createContextInjectorHandler } from './bridges/context.js';
import { runRecovery } from './bridges/recovery.js';

// Default configuration for this fork (always enabled)
const DEFAULT_CONFIG: LoaConfig = {
  grimoiresDir: 'grimoires/loa',
  walDir: '.loa/wal',
  enabled: true,
};

// Plugin state singleton
let loaContext: LoaContext | null = null;
let hookAdapter: HookAdapter | null = null;

/**
 * Get the current LOA context (for external access)
 */
export function getLoaContext(): LoaContext | null {
  return loaContext;
}

/**
 * Check if LOA is currently active
 */
export function isLoaActive(): boolean {
  return loaContext?.state.isActive ?? false;
}

/**
 * Check if LOA is in degraded mode
 */
export function isLoaDegraded(): boolean {
  return loaContext?.state.isDegraded ?? false;
}

/**
 * LOA Plugin Definition
 */
const plugin = {
  id: 'loa',
  name: 'LOA Identity',
  description: 'LOA identity, memory, and recovery system',

  async register(api: OpenClawPluginApi) {
    const logger = api.logger;
    logger.info('[loa] Registering LOA plugin...');

    // Create hook adapter to isolate from SDK changes
    hookAdapter = createHookAdapter(api);

    // Validate SDK version
    const validation = hookAdapter.validateSdkVersion();
    if (!validation.valid) {
      logger.error(`[loa] SDK validation failed: ${validation.errors.join(', ')}`);
      logger.error('[loa] LOA plugin will not be active');
      return;
    }
    logger.info(`[loa] SDK version ${validation.version} validated`);

    // Get configuration (merge with defaults)
    const pluginConfig = api.pluginConfig as Partial<LoaConfig> | undefined;
    const config: LoaConfig = {
      ...DEFAULT_CONFIG,
      ...pluginConfig,
    };

    // Skip if disabled (though always enabled in this fork)
    if (!config.enabled) {
      logger.info('[loa] LOA is disabled in configuration');
      return;
    }

    // Initialize plugin state
    const state: LoaPluginState = {
      isActive: false,
      isDegraded: false,
      recoveryAttempts: 0,
    };

    try {
      // Initialize LOA systems
      logger.info('[loa] Initializing LOA identity system...');
      const workspaceDir = hookAdapter.getWorkspaceDir();
      const loa = await initializeLoa(config, workspaceDir, logger);

      // Create soul generator
      const soulGenerator = createSoulGenerator(loa.identity, config, workspaceDir, logger);

      // Build context
      loaContext = {
        config,
        state,
        identity: loa.identity,
        memory: loa.memory,
        recovery: loa.recovery,
        redactor: loa.redactor,
        auditLogger: loa.auditLogger,
        soulGenerator,
        retryQueue: loa.retryQueue,
        loopDetector: loa.loopDetector,
      };

      // Run recovery before registering hooks
      logger.info('[loa] Running recovery check...');
      const recoveryResult = await runRecovery(loaContext, logger);
      if (!recoveryResult.success) {
        if (recoveryResult.degraded) {
          logger.warn('[loa] Recovery incomplete, entering degraded mode');
          state.isDegraded = true;
          state.lastError = recoveryResult.error;
        } else {
          logger.error(`[loa] Recovery failed: ${recoveryResult.error}`);
        }
      }

      // Register hooks
      logger.info('[loa] Registering hooks...');

      // Bootstrap hook - generates SOUL.md with self-healing
      const bootstrapHandler = createBootstrapHandler(loaContext, logger);
      hookAdapter.registerBootstrapHook(bootstrapHandler, 100); // High priority

      // Before agent start - inject memory context
      const contextHandler = createContextInjectorHandler(loaContext, logger);
      hookAdapter.registerBeforeAgentStart(contextHandler, 50);

      // Agent end - capture memory
      const memoryHandler = createMemoryCaptureHandler(loaContext, logger);
      hookAdapter.registerAgentEnd(memoryHandler, 50);

      // Mark as active
      state.isActive = true;
      logger.info('[loa] LOA plugin initialized and active');
      logger.info('[loa] LOA is now riding');

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`[loa] Initialization failed: ${error}`);
      state.isActive = false;
      state.isDegraded = true;
      state.lastError = error;
      logger.warn('[loa] LOA disconnected - agent will run without LOA personality');
    }
  },
};

export default plugin;

// Re-export types
export type { LoaConfig, LoaContext, LoaPluginState } from './types.js';
