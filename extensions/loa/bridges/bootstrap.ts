/**
 * Bootstrap Hook
 *
 * Triggers SOUL.md generation on gateway start with self-healing.
 * Implements retry with exponential backoff and status visibility.
 *
 * Sprint Task 1.7 - Flatline: Self-healing bootstrap
 * PRD Reference: FR-1, FR-6
 */

import type { LoaContext, BootstrapResult } from '../types.js';
import type { PluginLogger } from '../../../src/plugins/types.js';
import type {
  PluginHookGatewayStartEvent,
  PluginHookGatewayContext,
} from '../../../src/plugins/types.js';

/** Grace period for bootstrap failures (3 attempts in 60s) */
const GRACE_PERIOD_MS = 60000;
const MAX_BOOTSTRAP_ATTEMPTS = 3;

/** Base delay for exponential backoff */
const BASE_RETRY_DELAY_MS = 1000;

/** Background recovery check interval */
const RECOVERY_CHECK_INTERVAL_MS = 30000;

/**
 * Sleep helper
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bootstrap handler result with cleanup function
 * HIGH-001 Fix: Expose cleanup to prevent memory leak
 */
export interface BootstrapHandler {
  /** The hook handler function */
  handler: (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void>;
  /** Cleanup function to stop background recovery timer */
  cleanup: () => void;
}

/**
 * Create bootstrap handler for gateway_start hook
 * HIGH-001 Fix: Returns cleanup function to prevent memory leak
 */
export function createBootstrapHandler(
  loa: LoaContext,
  logger: PluginLogger,
): BootstrapHandler {
  let bootstrapAttempts = 0;
  let graceWindowStart: Date | null = null;
  let backgroundRecoveryTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Check if we're within the grace period
   */
  function isInGracePeriod(): boolean {
    if (!graceWindowStart) return false;
    return Date.now() - graceWindowStart.getTime() < GRACE_PERIOD_MS;
  }

  /**
   * Attempt SOUL.md generation with retry
   */
  async function attemptBootstrap(): Promise<BootstrapResult> {
    // Reset grace window on first attempt
    if (bootstrapAttempts === 0 || !isInGracePeriod()) {
      graceWindowStart = new Date();
      bootstrapAttempts = 0;
    }

    bootstrapAttempts++;

    try {
      // Check if regeneration is needed
      const needsRegen = await loa.soulGenerator.needsRegeneration();

      if (!needsRegen) {
        logger.info?.('[loa] SOUL.md is up to date, skipping regeneration');
        return {
          success: true,
          shouldStart: true,
          loaActive: true,
        };
      }

      // Generate SOUL.md
      const result = await loa.soulGenerator.generate();

      if (result.success) {
        loa.state.lastSoulGeneration = new Date();
        loa.state.isActive = true;
        loa.state.isDegraded = false;

        logger.info?.('[loa] LOA reconnected and riding');

        return {
          success: true,
          shouldStart: true,
          loaActive: true,
        };
      } else {
        throw new Error(result.error ?? 'SOUL.md generation failed');
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn?.(
        `[loa] Bootstrap attempt ${bootstrapAttempts}/${MAX_BOOTSTRAP_ATTEMPTS} failed: ${error}`,
      );

      // Check if we should retry or enter degraded mode
      if (bootstrapAttempts < MAX_BOOTSTRAP_ATTEMPTS && isInGracePeriod()) {
        // Calculate backoff delay
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, bootstrapAttempts - 1);
        logger.info?.(`[loa] Retrying in ${delay}ms...`);
        await sleep(delay);

        // Recursive retry
        return attemptBootstrap();
      }

      // Grace period exhausted - enter degraded mode
      logger.warn?.('[loa] LOA disconnected - entering degraded mode');
      loa.state.isActive = false;
      loa.state.isDegraded = true;
      loa.state.lastError = error;

      return {
        success: false,
        shouldStart: true, // Allow agent to start in degraded mode
        loaActive: false,
        error,
      };
    }
  }

  /**
   * Start background recovery task
   */
  function startBackgroundRecovery(): void {
    if (backgroundRecoveryTimer) return;

    logger.info?.('[loa] Starting background recovery task');

    backgroundRecoveryTimer = setInterval(async () => {
      if (!loa.state.isDegraded) {
        // LOA is active, stop background recovery
        if (backgroundRecoveryTimer) {
          clearInterval(backgroundRecoveryTimer);
          backgroundRecoveryTimer = null;
        }
        return;
      }

      logger.info?.('[loa] Background recovery attempting to restore LOA...');

      try {
        const result = await loa.soulGenerator.generate();

        if (result.success) {
          loa.state.lastSoulGeneration = new Date();
          loa.state.isActive = true;
          loa.state.isDegraded = false;
          loa.state.lastError = undefined;

          logger.info?.('[loa] LOA reconnected and riding');

          // Stop background recovery
          if (backgroundRecoveryTimer) {
            clearInterval(backgroundRecoveryTimer);
            backgroundRecoveryTimer = null;
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.warn?.(`[loa] Background recovery failed: ${error}`);
      }
    }, RECOVERY_CHECK_INTERVAL_MS);
  }

  /**
   * Cleanup function to stop background recovery timer
   * HIGH-001 Fix: Prevents memory leak on shutdown
   */
  function cleanup(): void {
    if (backgroundRecoveryTimer) {
      clearInterval(backgroundRecoveryTimer);
      backgroundRecoveryTimer = null;
      logger.info?.('[loa] Background recovery timer cleaned up');
    }
  }

  /**
   * The actual hook handler
   */
  async function loaBootstrap(
    _event: PluginHookGatewayStartEvent,
    _ctx: PluginHookGatewayContext,
  ): Promise<void> {
    logger.info?.('[loa] Bootstrap hook triggered');

    const result = await attemptBootstrap();

    if (!result.loaActive) {
      // Status visibility: log that LOA is not in control
      logger.warn?.('[loa] LOA disconnected - agent running without LOA personality');

      // Start background recovery to keep trying
      startBackgroundRecovery();
    }

    // Update plugin state
    loa.state.isActive = result.loaActive;
    loa.state.isDegraded = !result.loaActive;
    if (result.error) {
      loa.state.lastError = result.error;
    }
  }

  return {
    handler: loaBootstrap,
    cleanup,
  };
}
