// .claude/lib/workflow/compound-learning.ts — Compound learning extractor (SDD TASK-5.8)
// Extracts patterns from successful reviews, quality-gates, and persists learnings.

// ── Types ──────────────────────────────────────────────────

export interface LearningCandidate {
  pattern: string;
  source: string;
  confidence: number; // 0.0 to 1.0
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface QualityGateResult {
  pass: boolean;
  reason?: string;
}

export interface CompoundLearningConfig {
  minOccurrences?: number; // default: 3 — pattern must appear N times
  minConfidence?: number; // default: 0.7 — minimum confidence threshold
  maxLearnings?: number; // default: 50 — max learnings to persist
}

// ── Extractor ──────────────────────────────────────────────

export class CompoundLearningExtractor {
  private config: Required<CompoundLearningConfig>;

  constructor(config?: CompoundLearningConfig) {
    this.config = {
      minOccurrences: config?.minOccurrences ?? 3,
      minConfidence: config?.minConfidence ?? 0.7,
      maxLearnings: config?.maxLearnings ?? 50,
    };
  }

  /**
   * Extract learning candidates from review results.
   * Groups by pattern, counts occurrences, and computes confidence from success rate.
   */
  extractCandidates(
    results: Array<{ actionsTaken: string[]; patterns?: string[]; success: boolean }>,
  ): LearningCandidate[] {
    const now = new Date().toISOString();
    const map = new Map<string, { total: number; successes: number; firstSeen: string }>();

    for (const result of results) {
      if (!result.success) continue;
      for (const pattern of result.patterns ?? []) {
        const existing = map.get(pattern);
        if (existing) {
          existing.total++;
          existing.successes++;
        } else {
          map.set(pattern, { total: 1, successes: 1, firstSeen: now });
        }
      }
    }

    // Also count failed results for confidence calculation (they saw the pattern but failed)
    for (const result of results) {
      if (result.success) continue;
      for (const pattern of result.patterns ?? []) {
        const existing = map.get(pattern);
        if (existing) {
          existing.total++;
        }
      }
    }

    return Array.from(map.entries()).map(([pattern, data]) => ({
      pattern,
      source: "review",
      confidence: data.successes / data.total,
      occurrences: data.successes,
      firstSeenAt: data.firstSeen,
      lastSeenAt: now,
    }));
  }

  /**
   * Quality gate: filter candidates by confidence and occurrence thresholds.
   */
  qualityGate(candidates: LearningCandidate[]): {
    accepted: LearningCandidate[];
    rejected: Array<LearningCandidate & { reason: string }>;
  } {
    const accepted: LearningCandidate[] = [];
    const rejected: Array<LearningCandidate & { reason: string }> = [];

    for (const c of candidates) {
      if (c.confidence < this.config.minConfidence) {
        rejected.push({
          ...c,
          reason: `confidence ${c.confidence} < ${this.config.minConfidence}`,
        });
      } else if (c.occurrences < this.config.minOccurrences) {
        rejected.push({
          ...c,
          reason: `occurrences ${c.occurrences} < ${this.config.minOccurrences}`,
        });
      } else {
        accepted.push(c);
      }
    }

    return { accepted, rejected };
  }

  /**
   * Convert accepted candidates to a persistable format, respecting maxLearnings.
   */
  toPersistable(
    accepted: LearningCandidate[],
  ): Array<{ id: string; pattern: string; source: string; confidence: number; createdAt: string }> {
    const now = new Date().toISOString();
    const bounded = accepted.slice(0, this.config.maxLearnings);

    return bounded.map((c) => ({
      id: `cl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      pattern: c.pattern,
      source: c.source,
      confidence: c.confidence,
      createdAt: now,
    }));
  }
}
