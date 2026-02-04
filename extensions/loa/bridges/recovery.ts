/**
 * Recovery Runner
 *
 * Runs recovery on plugin initialization.
 * Integrates loop detection and degraded mode.
 *
 * Sprint Task 2.6 - SDD Section 2.5
 * PRD Reference: FR-3 (Recovery)
 */

import type { LoaContext } from '../types.js';
import type { PluginLogger } from '../../../src/plugins/types.js';
import { getLoopDetectorConfig } from '../state/loop-detector.js';

/**
 * Recovery result
 */
export interface RecoveryResult {
  success: boolean;
  degraded: boolean;
  error?: string;
  actions: string[];
}

/**
 * Run recovery on plugin initialization
 */
export async function runRecovery(
  loa: LoaContext,
  logger: PluginLogger,
): Promise<RecoveryResult> {
  const actions: string[] = [];

  try {
    // Record this recovery attempt
    loa.loopDetector.recordAttempt();

    // Check if we're in a recovery loop
    if (loa.loopDetector.isInLoop()) {
      const config = getLoopDetectorConfig();
      const message = `Recovery loop detected: ${loa.loopDetector.getAttemptCount()} attempts in ${config.windowMs}ms window`;
      logger.error?.(`[loa] ${message}`);
      actions.push('loop_detected');

      // Enter degraded mode (FR-3.8)
      return {
        success: false,
        degraded: true,
        error: message,
        actions,
      };
    }

    // Run the recovery engine
    logger.info?.('[loa] Running recovery engine...');
    actions.push('recovery_started');

    await loa.recovery.run();
    actions.push('recovery_completed');

    // Log successful recovery
    await loa.auditLogger.log({
      action: 'recovery_success',
      timestamp: new Date().toISOString(),
      attempts: loa.loopDetector.getAttemptCount(),
    });

    // Reset loop detector on success
    loa.loopDetector.reset();

    logger.info?.('[loa] Recovery completed successfully');

    return {
      success: true,
      degraded: false,
      actions,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error?.(`[loa] Recovery failed: ${error}`);
    actions.push('recovery_failed');

    // Log failed recovery
    await loa.auditLogger.log({
      action: 'recovery_failure',
      timestamp: new Date().toISOString(),
      error,
      attempts: loa.loopDetector.getAttemptCount(),
    });

    // Check if we should enter degraded mode
    const shouldDegrade = loa.loopDetector.isInLoop();

    if (shouldDegrade) {
      logger.warn?.('[loa] Entering degraded mode after repeated recovery failures');
      actions.push('degraded_mode_entered');
    }

    return {
      success: false,
      degraded: shouldDegrade,
      error,
      actions,
    };
  }
}
