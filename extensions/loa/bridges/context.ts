/**
 * Context Injector Hook
 *
 * Injects memory context via before_agent_start hook.
 * Includes input sanitization against prompt injection.
 *
 * Sprint Task 2.3 - SDD Section 2.4
 * PRD Reference: FR-4 (Context Injection), FR-8 (Token Budget)
 * Flatline: Input sanitization before injection
 */

import type { LoaContext, ContextInjectionResult, SanitizationResult } from '../types.js';
import type { PluginLogger } from '../../../src/plugins/types.js';
import type {
  PluginHookBeforeAgentStartEvent,
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
} from '../../../src/plugins/types.js';

/** Default token budget for context injection */
const DEFAULT_TOKEN_BUDGET = 2000;

/** Token estimation: characters per token (with 30% safety buffer) */
const CHARS_PER_TOKEN = 4;
const SAFETY_BUFFER = 1.3;

/**
 * Known prompt injection patterns to block/escape
 */
const INJECTION_PATTERNS = [
  // Direct instruction override
  /ignore (all )?(previous|prior|above) (instructions?|prompts?|context)/gi,
  /disregard (all )?(previous|prior|above)/gi,
  /forget (everything|all|what) (you|I) (said|told|wrote)/gi,
  // System prompt extraction
  /what('s| is| are) (your|the) (system|initial) (prompt|instructions?)/gi,
  /repeat (your|the) (system|initial) (prompt|instructions?)/gi,
  /show me (your|the) (system|initial) (prompt|instructions?)/gi,
  // Role manipulation
  /you are now (a |an )?(?!helpful|assistant)/gi,
  /pretend (you are|to be) (a |an )?(?!helpful|assistant)/gi,
  /act as (a |an )?(?!helpful|assistant)/gi,
  // XML-like tags that could be interpreted as directives
  /<\/?system[^>]*>/gi,
  /<\/?instruction[^>]*>/gi,
  /<\/?directive[^>]*>/gi,
  /<\/?override[^>]*>/gi,
  /<\/?ignore[^>]*>/gi,
];

/**
 * Sanitize content to prevent prompt injection
 */
function sanitizeContent(content: string): SanitizationResult {
  let sanitized = content;
  const removedPatterns: string[] = [];
  let hadDangerousPatterns = false;

  for (const pattern of INJECTION_PATTERNS) {
    const matches = sanitized.match(pattern);
    if (matches) {
      hadDangerousPatterns = true;
      removedPatterns.push(...matches);
      // Replace with sanitized marker
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
  }

  // Escape any remaining angle brackets that look like XML
  // But preserve markdown code blocks
  sanitized = sanitized.replace(
    /(?<!`)<(?!\/?(code|pre|span|div|p|br|hr|a|b|i|em|strong|ul|ol|li)\b)[a-z]+[^>]*>/gi,
    (match) => {
      hadDangerousPatterns = true;
      removedPatterns.push(match);
      return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  );

  return {
    content: sanitized,
    hadDangerousPatterns,
    removedPatterns,
  };
}

/**
 * Estimate token count with safety buffer
 * TODO(Sprint): Replace with tiktoken for proper Unicode support (Flatline: SKP-003)
 */
function estimateTokens(text: string): number {
  const naiveEstimate = Math.ceil(text.length / CHARS_PER_TOKEN);
  return Math.ceil(naiveEstimate * SAFETY_BUFFER);
}

/**
 * Truncate content to fit within token budget
 */
function truncateToTokenBudget(content: string, maxTokens: number): string {
  const currentTokens = estimateTokens(content);
  if (currentTokens <= maxTokens) {
    return content;
  }

  // Estimate how many characters we can keep
  const ratio = maxTokens / currentTokens;
  const maxChars = Math.floor(content.length * ratio);

  // Truncate and add ellipsis marker
  return content.slice(0, maxChars - 20) + '\n\n[...truncated for context limit]';
}

/**
 * Create context injector handler for before_agent_start hook
 */
export function createContextInjectorHandler(
  loa: LoaContext,
  logger: PluginLogger,
): (
  event: PluginHookBeforeAgentStartEvent,
  ctx: PluginHookAgentContext,
) => Promise<PluginHookBeforeAgentStartResult | void> {
  return async function loaBeforeAgentStart(
    _event: PluginHookBeforeAgentStartEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeAgentStartResult | void> {
    // Fail-open: if LOA is degraded, don't inject context
    if (loa.state.isDegraded) {
      logger.warn?.('[loa] Context injection skipped - LOA in degraded mode');
      return;
    }

    try {
      const contextParts: string[] = [];
      let totalTokens = 0;
      const tokenBudget = DEFAULT_TOKEN_BUDGET;

      // 1. Load recent sessions from NOTES.md
      // This would integrate with SessionMemoryManager.getRecentSessions()
      // For now, we'll check if recent context exists
      try {
        const recentSessions = await loa.memory.getRecentSessions?.(5) ?? [];

        if (recentSessions.length > 0) {
          const sessionContext = recentSessions
            .map((s) => `- ${s.summary || s.content?.slice(0, 100)}`)
            .join('\n');

          contextParts.push('## Recent Context\n\n' + sessionContext);
        }
      } catch (err) {
        // Fail-open: continue without recent sessions
        logger.warn?.(`[loa] Failed to load recent sessions: ${err}`);
      }

      // 2. Load active learnings from store (if available)
      // Integration with LearningStore.getActive()
      try {
        // Note: LearningStore interface defined in Task 2.4
        // For now, this is a placeholder
        const learnings: Array<{ content: string; effectiveness: number }> = [];

        if (learnings.length > 0) {
          const learningContext = learnings
            .sort((a, b) => b.effectiveness - a.effectiveness)
            .slice(0, 3)
            .map((l) => `- ${l.content}`)
            .join('\n');

          contextParts.push('## Learnings\n\n' + learningContext);
        }
      } catch (err) {
        // Fail-open: continue without learnings
        logger.warn?.(`[loa] Failed to load learnings: ${err}`);
      }

      // 3. Load identity context from BEAUVOIR.md
      if (loa.identity) {
        const beauvoir = loa.identity.getIdentity?.();
        if (beauvoir?.shortSummary) {
          contextParts.push('## Identity\n\n' + beauvoir.shortSummary);
        }
      }

      // Combine context parts
      if (contextParts.length === 0) {
        logger.info?.('[loa] No context to inject');
        return;
      }

      let combinedContext = contextParts.join('\n\n---\n\n');

      // 4. Input sanitization (Flatline requirement)
      const sanitizationResult = sanitizeContent(combinedContext);
      combinedContext = sanitizationResult.content;

      if (sanitizationResult.hadDangerousPatterns) {
        logger.warn?.(
          `[loa] Sanitized ${sanitizationResult.removedPatterns.length} potentially dangerous patterns`,
        );
        await loa.auditLogger.log({
          action: 'context_sanitization',
          patterns: sanitizationResult.removedPatterns,
          timestamp: new Date().toISOString(),
        });
      }

      // 5. Apply token budget with prioritization (FR-8)
      totalTokens = estimateTokens(combinedContext);
      if (totalTokens > tokenBudget) {
        logger.info?.(
          `[loa] Context exceeds budget (${totalTokens} > ${tokenBudget}), truncating`,
        );
        combinedContext = truncateToTokenBudget(combinedContext, tokenBudget);
        totalTokens = estimateTokens(combinedContext);
      }

      logger.info?.(
        `[loa] Injecting context: ${totalTokens} tokens (budget: ${tokenBudget})`,
      );

      return {
        prependContext: combinedContext,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.warn?.(`[loa] Context injection failed: ${error}`);
      // Fail-open: return nothing, let agent proceed without context
      return;
    }
  };
}
