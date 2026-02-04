/**
 * Loop Detector
 *
 * Tracks recovery attempts to detect recovery loops.
 * Configurable via environment variables.
 *
 * Sprint Task 2.5 - PRD FR-3.7-3.9
 * Flatline: Make configurable
 */

import type { LoopDetector } from '../types.js';

/**
 * Environment variable for recovery window in milliseconds
 * Default: 120000 (2 minutes)
 */
const WINDOW_MS_ENV = 'LOA_RECOVERY_WINDOW_MS';

/**
 * Environment variable for max recovery attempts
 * Default: 5
 */
const MAX_ATTEMPTS_ENV = 'LOA_RECOVERY_MAX_ATTEMPTS';

/**
 * Get the recovery window in milliseconds
 */
function getWindowMs(): number {
  const env = process.env[WINDOW_MS_ENV];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 120000; // Default: 2 minutes
}

/**
 * Get the max recovery attempts
 */
function getMaxAttempts(): number {
  const env = process.env[MAX_ATTEMPTS_ENV];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 5; // Default: 5 attempts
}

/**
 * Create a loop detector for tracking recovery attempts
 */
export function createLoopDetector(): LoopDetector {
  let windowStart: Date | null = null;
  let attemptCount = 0;

  // Cache config values (can change on restart)
  const windowMs = getWindowMs();
  const maxAttempts = getMaxAttempts();

  /**
   * Check if the current window has expired
   */
  function isWindowExpired(): boolean {
    if (!windowStart) {
      return true;
    }
    const elapsed = Date.now() - windowStart.getTime();
    return elapsed > windowMs;
  }

  return {
    recordAttempt(): void {
      // Reset window if expired
      if (isWindowExpired()) {
        windowStart = new Date();
        attemptCount = 0;
      }

      attemptCount++;
    },

    isInLoop(): boolean {
      // If window expired, we're not in a loop
      if (isWindowExpired()) {
        return false;
      }

      // Check if we've exceeded max attempts in the window
      return attemptCount >= maxAttempts;
    },

    getAttemptCount(): number {
      // Reset if window expired
      if (isWindowExpired()) {
        return 0;
      }
      return attemptCount;
    },

    reset(): void {
      windowStart = null;
      attemptCount = 0;
    },
  };
}

/**
 * Get current loop detector configuration (for debugging/logging)
 */
export function getLoopDetectorConfig(): { windowMs: number; maxAttempts: number } {
  return {
    windowMs: getWindowMs(),
    maxAttempts: getMaxAttempts(),
  };
}
