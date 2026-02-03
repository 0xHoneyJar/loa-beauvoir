/**
 * Quality Gates - Memory filtering rules from SDD
 *
 * Implements temporal, speculation, instruction, and confidence gates
 * for filtering memory entries before storage.
 *
 * @module deploy/loa-identity/memory/quality-gates
 */

export interface QualityCheckResult {
  pass: boolean;
  reason?: string;
  scoreAdjustment?: number;
  tags?: string[];
}

export interface QualityGate {
  name: string;
  description: string;
  priority: number; // Lower = higher priority
  check: (content: string, metadata: GateMetadata) => QualityCheckResult;
}

export interface GateMetadata {
  timestamp: string;
  source: string;
  confidence: number;
  tags: string[];
  context?: Record<string, unknown>;
}

/**
 * Temporal Gate - Weight entries based on recency
 */
export const temporalGate: QualityGate = {
  name: 'temporal',
  description: 'Weights entries based on recency, older entries get lower scores',
  priority: 1,
  check: (content, metadata) => {
    const entryTime = new Date(metadata.timestamp).getTime();
    const now = Date.now();
    const ageMs = now - entryTime;

    const hourMs = 60 * 60 * 1000;
    const dayMs = 24 * hourMs;

    // Very fresh (< 1 hour) - boost
    if (ageMs < hourMs) {
      return { pass: true, scoreAdjustment: 0.1 };
    }

    // Recent (1-6 hours) - neutral
    if (ageMs < 6 * hourMs) {
      return { pass: true };
    }

    // Same day (6-24 hours) - slight penalty
    if (ageMs < dayMs) {
      return { pass: true, scoreAdjustment: -0.05 };
    }

    // Yesterday (24-48 hours) - moderate penalty
    if (ageMs < 2 * dayMs) {
      return { pass: true, scoreAdjustment: -0.1, reason: 'aged_entry' };
    }

    // Older than 2 days - significant penalty
    return { pass: true, scoreAdjustment: -0.2, reason: 'old_entry' };
  },
};

/**
 * Speculation Gate - Filter uncertain or speculative content
 */
export const speculationGate: QualityGate = {
  name: 'speculation',
  description: 'Filters uncertain or speculative content',
  priority: 2,
  check: (content, metadata) => {
    const speculativePatterns = [
      // Uncertainty markers
      /\b(might|maybe|perhaps|possibly|probably)\b/gi,
      /\b(could be|may be|seems like|appears to)\b/gi,
      /\b(not sure|uncertain|unclear|don't know)\b/gi,

      // Personal belief markers (without evidence)
      /\b(I think|I believe|I assume|I guess|I suppose)\b/gi,

      // Question patterns
      /\?{2,}/, // Multiple question marks indicate uncertainty

      // Hedging language
      /\b(sort of|kind of|somewhat|rather|fairly)\b/gi,
    ];

    let speculativeCount = 0;
    for (const pattern of speculativePatterns) {
      const matches = content.match(pattern);
      if (matches) {
        speculativeCount += matches.length;
      }
    }

    // Allow some speculation if confidence is high
    if (speculativeCount > 0 && metadata.confidence < 0.7) {
      if (speculativeCount >= 3) {
        return {
          pass: false,
          reason: 'highly_speculative',
        };
      }
      return {
        pass: true,
        scoreAdjustment: -0.15,
        reason: 'speculative_content',
      };
    }

    return { pass: true };
  },
};

/**
 * Instruction Gate - Detect and prioritize user preferences
 */
export const instructionGate: QualityGate = {
  name: 'instruction',
  description: 'Detects user preferences and instructions for prioritization',
  priority: 3,
  check: (content, metadata) => {
    const instructionPatterns = [
      // Explicit preferences
      /\b(always|never|prefer|don't|do not|should not)\b/gi,
      /\b(I want|I need|I require|I expect)\b/gi,

      // Memory requests
      /\b(remember that|note that|keep in mind|don't forget)\b/gi,
      /\b(my preference|my style|the way I like)\b/gi,

      // Rules and constraints
      /\b(rule:|constraint:|requirement:|must:?)\b/gi,
      /\b(important:|note:|warning:)\b/gi,

      // Configuration patterns
      /\b(set|configure|enable|disable|turn on|turn off)\b/gi,
    ];

    const tags: string[] = [];
    let isInstruction = false;

    for (const pattern of instructionPatterns) {
      if (pattern.test(content)) {
        isInstruction = true;
        break;
      }
    }

    if (isInstruction) {
      tags.push('user_instruction');

      // Check if it's a strong instruction
      const strongPatterns = [
        /\b(always|never|must|required)\b/gi,
        /\b(critical|important|essential)\b/gi,
      ];

      for (const pattern of strongPatterns) {
        if (pattern.test(content)) {
          tags.push('strong_instruction');
          return {
            pass: true,
            scoreAdjustment: 0.25,
            tags,
            reason: 'strong_user_instruction',
          };
        }
      }

      return {
        pass: true,
        scoreAdjustment: 0.15,
        tags,
        reason: 'user_instruction',
      };
    }

    return { pass: true };
  },
};

/**
 * Confidence Gate - Minimum confidence threshold
 */
export const confidenceGate: QualityGate = {
  name: 'confidence',
  description: 'Filters entries below minimum confidence threshold',
  priority: 4,
  check: (content, metadata) => {
    if (metadata.confidence < 0.3) {
      return {
        pass: false,
        reason: 'very_low_confidence',
      };
    }

    if (metadata.confidence < 0.5) {
      return {
        pass: true,
        scoreAdjustment: -0.2,
        reason: 'low_confidence',
      };
    }

    if (metadata.confidence >= 0.9) {
      return {
        pass: true,
        scoreAdjustment: 0.1,
        reason: 'high_confidence',
      };
    }

    return { pass: true };
  },
};

/**
 * Content Quality Gate - Basic content quality checks
 */
export const contentQualityGate: QualityGate = {
  name: 'content_quality',
  description: 'Basic content quality checks (length, noise, etc.)',
  priority: 5,
  check: (content, metadata) => {
    const trimmed = content.trim();

    // Too short
    if (trimmed.length < 10) {
      return { pass: false, reason: 'too_short' };
    }

    // Too long (likely a dump, not a memory)
    if (trimmed.length > 5000) {
      return {
        pass: true,
        scoreAdjustment: -0.1,
        reason: 'very_long_content',
      };
    }

    // Check for noise patterns
    const noisePatterns = [
      /^(ok|okay|sure|yes|no|got it|thanks|thank you)\.?$/i,
      /^(hmm|um|uh|ah|well)\b/i,
      /^[\s\W]+$/, // Only whitespace/punctuation
    ];

    for (const pattern of noisePatterns) {
      if (pattern.test(trimmed)) {
        return { pass: false, reason: 'noise_content' };
      }
    }

    // Check for repetitive content
    const words = trimmed.toLowerCase().split(/\s+/);
    const uniqueWords = new Set(words);
    const uniqueRatio = uniqueWords.size / words.length;

    if (words.length > 10 && uniqueRatio < 0.3) {
      return {
        pass: false,
        reason: 'repetitive_content',
      };
    }

    return { pass: true };
  },
};

/**
 * Technical Content Gate - Identify and tag technical content
 */
export const technicalContentGate: QualityGate = {
  name: 'technical_content',
  description: 'Identifies and tags technical content for special handling',
  priority: 6,
  check: (content, metadata) => {
    const tags: string[] = [];

    const technicalPatterns = [
      { pattern: /```[\s\S]*?```/g, tag: 'code_block' },
      { pattern: /`[^`]+`/g, tag: 'inline_code' },
      { pattern: /\b(function|class|const|let|var|import|export)\b/g, tag: 'code_keywords' },
      { pattern: /\b(error|exception|bug|fix|debug)\b/gi, tag: 'debugging' },
      { pattern: /\b(api|endpoint|request|response|http)\b/gi, tag: 'api_related' },
      { pattern: /\b(database|query|sql|schema)\b/gi, tag: 'database_related' },
    ];

    for (const { pattern, tag } of technicalPatterns) {
      if (pattern.test(content)) {
        tags.push(tag);
      }
    }

    if (tags.length > 0) {
      return {
        pass: true,
        tags,
        scoreAdjustment: tags.includes('debugging') ? 0.1 : 0,
      };
    }

    return { pass: true };
  },
};

/**
 * Create the default set of quality gates
 */
export function createDefaultQualityGates(): QualityGate[] {
  return [
    temporalGate,
    speculationGate,
    instructionGate,
    confidenceGate,
    contentQualityGate,
    technicalContentGate,
  ].sort((a, b) => a.priority - b.priority);
}

/**
 * Apply all gates to content
 */
export function applyQualityGates(
  content: string,
  metadata: GateMetadata,
  gates: QualityGate[] = createDefaultQualityGates()
): {
  pass: boolean;
  score: number;
  tags: string[];
  reasons: string[];
} {
  let score = 0.7; // Base score
  const tags: string[] = [...metadata.tags];
  const reasons: string[] = [];

  for (const gate of gates) {
    const result = gate.check(content, metadata);

    if (!result.pass) {
      return {
        pass: false,
        score: 0,
        tags,
        reasons: [result.reason || gate.name],
      };
    }

    if (result.scoreAdjustment) {
      score += result.scoreAdjustment;
    }

    if (result.tags) {
      tags.push(...result.tags);
    }

    if (result.reason) {
      reasons.push(result.reason);
    }
  }

  // Clamp score to [0, 1]
  score = Math.max(0, Math.min(1, score));

  return {
    pass: true,
    score,
    tags: [...new Set(tags)], // Dedupe
    reasons,
  };
}

/**
 * Quality threshold presets
 */
export const QualityThresholds = {
  strict: 0.8,
  standard: 0.6,
  relaxed: 0.4,
  minimal: 0.2,
} as const;

export type QualityThresholdLevel = keyof typeof QualityThresholds;
