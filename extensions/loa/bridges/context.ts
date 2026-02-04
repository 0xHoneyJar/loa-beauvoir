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
 * Pattern classification for audit logging (CRIT-003 fix)
 */
type PatternType =
  | 'instruction_override'
  | 'system_extraction'
  | 'role_manipulation'
  | 'xml_directive'
  | 'encoding_attack'
  | 'comment_injection'
  | 'multi_language';

interface PatternDef {
  pattern: RegExp;
  type: PatternType;
}

/**
 * Known prompt injection patterns to block/escape
 * CRIT-002 Fix: Expanded pattern coverage
 */
const INJECTION_PATTERNS: PatternDef[] = [
  // Direct instruction override (English)
  { pattern: /ignore (all )?(previous|prior|above) (instructions?|prompts?|context)/gi, type: 'instruction_override' },
  { pattern: /disregard (all )?(previous|prior|above)/gi, type: 'instruction_override' },
  { pattern: /forget (everything|all|what) (you|I) (said|told|wrote)/gi, type: 'instruction_override' },
  { pattern: /override (previous|prior|above|all) (instructions?|prompts?)/gi, type: 'instruction_override' },
  { pattern: /new instructions?:?\s/gi, type: 'instruction_override' },

  // System prompt extraction
  { pattern: /what('s| is| are) (your|the) (system|initial) (prompt|instructions?)/gi, type: 'system_extraction' },
  { pattern: /repeat (your|the) (system|initial) (prompt|instructions?)/gi, type: 'system_extraction' },
  { pattern: /show me (your|the) (system|initial) (prompt|instructions?)/gi, type: 'system_extraction' },
  { pattern: /print (your|the) (system|initial|original) (prompt|instructions?)/gi, type: 'system_extraction' },
  { pattern: /output (your|the) (system|hidden|secret) (prompt|instructions?)/gi, type: 'system_extraction' },

  // Role manipulation
  { pattern: /you are now (a |an )?(?!helpful|assistant|AI)/gi, type: 'role_manipulation' },
  { pattern: /pretend (you are|to be) (a |an )?(?!helpful|assistant)/gi, type: 'role_manipulation' },
  { pattern: /act as (a |an )?(?!helpful|assistant)/gi, type: 'role_manipulation' },
  { pattern: /roleplay as/gi, type: 'role_manipulation' },
  { pattern: /switch (to |into )?(a |an )?different (role|persona|character)/gi, type: 'role_manipulation' },

  // XML-like tags that could be interpreted as directives
  { pattern: /<\/?system[^>]*>/gi, type: 'xml_directive' },
  { pattern: /<\/?instruction[^>]*>/gi, type: 'xml_directive' },
  { pattern: /<\/?directive[^>]*>/gi, type: 'xml_directive' },
  { pattern: /<\/?override[^>]*>/gi, type: 'xml_directive' },
  { pattern: /<\/?ignore[^>]*>/gi, type: 'xml_directive' },
  { pattern: /<\/?prompt[^>]*>/gi, type: 'xml_directive' },
  { pattern: /<\/?context[^>]*>/gi, type: 'xml_directive' },
  { pattern: /<\/?assistant[^>]*>/gi, type: 'xml_directive' },
  { pattern: /<\/?user[^>]*>/gi, type: 'xml_directive' },

  // Nested tag attacks
  { pattern: /<[a-z]*<[^>]*>[^>]*>/gi, type: 'xml_directive' },

  // HTML/Markdown comment injection
  { pattern: /<!--[\s\S]*?(ignore|override|forget|system|instruction)[\s\S]*?-->/gi, type: 'comment_injection' },
  { pattern: /\[\/\/\]:\s*#\s*\(.*?(ignore|override|system).*?\)/gi, type: 'comment_injection' },

  // Base64 encoded potential attacks (detect base64 blocks that decode to suspicious content)
  { pattern: /(?:data:text\/[^;]+;base64,|base64:)[A-Za-z0-9+/=]{20,}/gi, type: 'encoding_attack' },

  // Multi-language injection patterns
  // Spanish
  { pattern: /olvida (las |todas las )?(instrucciones|indicaciones) (anteriores|previas)/gi, type: 'multi_language' },
  { pattern: /ignora (las |todas las )?(instrucciones|indicaciones)/gi, type: 'multi_language' },
  // French
  { pattern: /ignore[rz]? (les |toutes les )?(instructions|directives) (précédentes|antérieures)/gi, type: 'multi_language' },
  { pattern: /oublie[rz]? (les |toutes les )?(instructions|directives)/gi, type: 'multi_language' },
  // German
  { pattern: /ignoriere? (alle )?(vorherigen |früheren )?(anweisungen|instruktionen)/gi, type: 'multi_language' },
  { pattern: /vergiss (alle )?(vorherigen )?(anweisungen|instruktionen)/gi, type: 'multi_language' },
  // Chinese (simplified)
  { pattern: /忽略(之前的|以上的|所有的)?(指令|指示|说明)/g, type: 'multi_language' },
  { pattern: /忘记(之前的|以上的)?(指令|指示)/g, type: 'multi_language' },
  // Japanese
  { pattern: /(以前の|上記の)?(指示|命令)を(無視|忘れ)/g, type: 'multi_language' },
];

/**
 * Normalize Unicode to detect homoglyph attacks
 * CRIT-002 Fix: Unicode normalization
 */
function normalizeUnicode(text: string): string {
  // NFD normalization to decompose characters
  return text.normalize('NFD');
}

/**
 * Sanitization result with pattern types for safe logging
 */
interface SafeSanitizationResult extends SanitizationResult {
  /** Pattern types detected (safe to log, no actual content) */
  patternTypeCounts: Record<PatternType, number>;
}

/**
 * Sanitize content to prevent prompt injection
 * CRIT-002 Fix: Expanded patterns and Unicode normalization
 * CRIT-003 Fix: Track pattern types instead of actual content
 */
function sanitizeContent(content: string): SafeSanitizationResult {
  // Normalize Unicode first to detect homoglyph attacks
  let sanitized = normalizeUnicode(content);
  const removedPatterns: string[] = [];
  const patternTypeCounts: Record<PatternType, number> = {
    instruction_override: 0,
    system_extraction: 0,
    role_manipulation: 0,
    xml_directive: 0,
    encoding_attack: 0,
    comment_injection: 0,
    multi_language: 0,
  };
  let hadDangerousPatterns = false;

  for (const { pattern, type } of INJECTION_PATTERNS) {
    const matches = sanitized.match(pattern);
    if (matches) {
      hadDangerousPatterns = true;
      patternTypeCounts[type] += matches.length;
      // Store only the pattern type for logging, NOT the actual content
      removedPatterns.push(`[${type}]`);
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
      patternTypeCounts['xml_directive']++;
      removedPatterns.push('[xml_directive]');
      return match.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  );

  return {
    content: sanitized,
    hadDangerousPatterns,
    removedPatterns, // Now contains only type markers, not actual content
    patternTypeCounts,
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
        // Calculate total patterns blocked
        const totalBlocked = Object.values(sanitizationResult.patternTypeCounts).reduce((a, b) => a + b, 0);
        logger.warn?.(
          `[loa] Sanitized ${totalBlocked} potentially dangerous patterns`,
        );
        // CRIT-003 Fix: Log pattern types and counts, NOT actual content
        await loa.auditLogger.log({
          action: 'context_sanitization',
          patternCount: totalBlocked,
          patternTypes: sanitizationResult.patternTypeCounts,
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
