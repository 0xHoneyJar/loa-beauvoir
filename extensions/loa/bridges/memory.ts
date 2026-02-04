/**
 * Memory Capture Hook
 *
 * Captures interactions via agent_end hook using existing 6 quality gates.
 * Implements fail-open with retry queue.
 *
 * Sprint Task 2.1 - SDD Section 2.3
 * PRD Reference: FR-2 (Memory Capture)
 * Flatline: Use existing 6 quality gates from SessionMemoryManager
 */

import type { LoaContext, MemoryCaptureEvent, QualityGateResult } from '../types.js';
import type { PluginLogger } from '../../../src/plugins/types.js';
import type {
  PluginHookAgentEndEvent,
  PluginHookAgentContext,
} from '../../../src/plugins/types.js';

/**
 * Quality gate names from SessionMemoryManager
 */
const QUALITY_GATES = [
  'length',      // Min character threshold
  'entropy',     // Information density
  'uniqueness',  // Not duplicate of recent
  'recency',     // Time-based filtering
  'relevance',   // Topic alignment
  'pii',         // PII redaction check
] as const;

/**
 * Extract significant content from agent messages
 * Uses the 6 quality gates from SessionMemoryManager
 */
function extractSignificantContent(
  messages: unknown[],
  memory: LoaContext['memory'],
): QualityGateResult {
  const failedGates: string[] = [];

  // Filter to assistant messages (agent responses)
  const assistantMessages = messages.filter((msg): msg is { role: string; content: string } => {
    return (
      typeof msg === 'object' &&
      msg !== null &&
      'role' in msg &&
      (msg as { role: string }).role === 'assistant' &&
      'content' in msg
    );
  });

  if (assistantMessages.length === 0) {
    return { passed: false, failedGates: ['no_content'], content: undefined };
  }

  // Combine assistant message contents
  let content = assistantMessages
    .map((msg) => msg.content)
    .filter((c) => typeof c === 'string')
    .join('\n\n');

  // Gate 1: Length check (min chars)
  const MIN_LENGTH = 50;
  if (content.length < MIN_LENGTH) {
    failedGates.push('length');
  }

  // Gate 2: Entropy check (information density)
  // Simple heuristic: unique words / total words
  const words = content.toLowerCase().split(/\s+/).filter(Boolean);
  const uniqueWords = new Set(words);
  const entropy = words.length > 0 ? uniqueWords.size / words.length : 0;
  const MIN_ENTROPY = 0.3;
  if (entropy < MIN_ENTROPY) {
    failedGates.push('entropy');
  }

  // Gate 3: Uniqueness check (not duplicate of recent)
  // This would be checked by SessionMemoryManager.capture()
  // We mark as passed here, let the manager handle it

  // Gate 4: Recency check (time-based filtering)
  // Agent just ended, so it's recent by definition
  // Passed

  // Gate 5: Relevance check (topic alignment)
  // Check for substantive content (not just boilerplate)
  const BOILERPLATE_PATTERNS = [
    /^(hi|hello|hey|thanks|thank you|okay|ok|sure)[\s.,!]*$/i,
    /^I('m| am) (happy|glad) to help/i,
  ];
  const isBoilerplate = BOILERPLATE_PATTERNS.some((pattern) => pattern.test(content.trim()));
  if (isBoilerplate) {
    failedGates.push('relevance');
  }

  // Gate 6: PII check (handled by redactor in capture)
  // Passed here, redactor will sanitize

  // If any critical gate failed, don't capture
  const CRITICAL_GATES = ['length', 'entropy'];
  const criticalFailed = failedGates.some((g) => CRITICAL_GATES.includes(g));

  return {
    passed: !criticalFailed,
    failedGates,
    content: criticalFailed ? undefined : content,
  };
}

/**
 * Create memory capture handler for agent_end hook
 */
export function createMemoryCaptureHandler(
  loa: LoaContext,
  logger: PluginLogger,
): (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void> {
  return async function loaAgentEnd(
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
  ): Promise<void> {
    // Skip if LOA is in degraded mode (fail-open, but log)
    if (loa.state.isDegraded) {
      logger.warn?.('[loa] Memory capture skipped - LOA in degraded mode');
      return;
    }

    // Skip if conversation wasn't successful
    if (!event.success) {
      logger.info?.('[loa] Memory capture skipped - conversation had errors');
      return;
    }

    try {
      // Extract significant content using quality gates
      const gateResult = extractSignificantContent(event.messages, loa.memory);

      if (!gateResult.passed) {
        logger.info?.(
          `[loa] Memory capture skipped - quality gates failed: ${gateResult.failedGates.join(', ')}`,
        );
        return;
      }

      // Capture memory through SessionMemoryManager
      // The manager applies PII redaction and additional filtering
      const captureEvent: MemoryCaptureEvent = {
        messages: event.messages,
        success: event.success,
        durationMs: event.durationMs,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      };

      await loa.memory.capture({
        content: gateResult.content!,
        metadata: {
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          timestamp: new Date().toISOString(),
          durationMs: event.durationMs,
        },
      });

      logger.info?.('[loa] Memory captured successfully');

      // Process retry queue if there are pending items
      if (loa.retryQueue.getPendingCount() > 0) {
        // Process async, don't block
        loa.retryQueue.process().catch((err) => {
          logger.warn?.(`[loa] Retry queue processing failed: ${err}`);
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn?.(`[loa] Memory capture failed: ${error}`);

      // Fail-open: queue for retry, don't throw
      loa.retryQueue.enqueue({
        type: 'memory_capture',
        payload: {
          messages: event.messages,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        },
        attempts: 0,
        maxAttempts: 3,
        lastError: error,
      });
    }
  };
}
