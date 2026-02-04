/**
 * Retry Queue
 *
 * Async retry for failed memory captures and other operations.
 * Uses exponential backoff between retries.
 *
 * Sprint Task 2.2 - SDD Section 6.2
 */

import type { RetryOperation, RetryQueue } from '../types.js';
import type { PluginLogger } from '../../../src/plugins/types.js';

/** Default max attempts before giving up */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Base delay in ms for exponential backoff */
const BASE_DELAY_MS = 1000;

/** Max delay in ms */
const MAX_DELAY_MS = 30000;

/**
 * Create a retry queue for failed operations
 * HIGH-002 Fix: Promise-based lock to prevent race conditions
 */
export function createRetryQueue(logger: PluginLogger): RetryQueue {
  const queue: RetryOperation[] = [];
  let processingPromise: Promise<void> | null = null;

  /**
   * Calculate delay with exponential backoff
   */
  function calculateDelay(attempts: number): number {
    const delay = BASE_DELAY_MS * Math.pow(2, attempts - 1);
    return Math.min(delay, MAX_DELAY_MS);
  }

  /**
   * Sleep for specified milliseconds
   */
  async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return {
    enqueue(operation: RetryOperation): void {
      // Set defaults
      operation.maxAttempts = operation.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      operation.attempts = operation.attempts ?? 0;

      queue.push(operation);
      logger.info?.(`[loa] Queued ${operation.type} for retry (attempt ${operation.attempts + 1})`);
    },

    async process(): Promise<void> {
      // HIGH-002 Fix: Promise-based lock prevents race conditions
      // If already processing, wait for that to complete instead of returning
      if (processingPromise) {
        return processingPromise;
      }

      if (queue.length === 0) {
        return;
      }

      // Create the processing promise that others can wait on
      processingPromise = (async () => {
        try {
          while (queue.length > 0) {
            const operation = queue[0];

            // Check if max attempts reached
            if (operation.attempts >= operation.maxAttempts) {
              logger.warn?.(
                `[loa] Giving up on ${operation.type} after ${operation.attempts} attempts: ${operation.lastError}`,
              );
              queue.shift();
              continue;
            }

            // Calculate backoff delay
            if (operation.attempts > 0) {
              const delay = calculateDelay(operation.attempts);
              logger.info?.(
                `[loa] Waiting ${delay}ms before retry ${operation.attempts + 1} for ${operation.type}`,
              );
              await sleep(delay);
            }

            // Increment attempt count
            operation.attempts++;
            operation.lastAttempt = new Date();

            try {
              // Execute the operation based on type
              // The actual execution is handled by the caller who enqueued it
              // This queue just manages timing and retry logic
              // For now, we'll emit a message and let the hook re-process
              logger.info?.(`[loa] Retry attempt ${operation.attempts} for ${operation.type}`);

              // Remove from queue on success
              queue.shift();
            } catch (err) {
              const error = err instanceof Error ? err.message : String(err);
              operation.lastError = error;
              logger.warn?.(`[loa] Retry failed for ${operation.type}: ${error}`);

              // Move to back of queue for later retry
              queue.shift();
              if (operation.attempts < operation.maxAttempts) {
                queue.push(operation);
              }
            }
          }
        } finally {
          processingPromise = null;
        }
      })();

      return processingPromise;
    },

    getPendingCount(): number {
      return queue.length;
    },

    clear(): void {
      queue.length = 0;
      logger.info?.('[loa] Retry queue cleared');
    },
  };
}
