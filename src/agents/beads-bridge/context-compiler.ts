/**
 * Context compiler — scores beads by relevance and assembles context for sub-agents.
 *
 * Scoring algorithm (from SDD):
 *   dependencies: +10, circuit-breaker: +8, handoff: +6,
 *   classification: 0-5, confidence: +-1, recency: 0-2 (linear decay 7d)
 *
 * Token budget enforced via greedy knapsack (no partial beads).
 */

import type { BeadRecord } from "./br-executor.js";
import { hasLabel, getLabelsWithPrefix } from "./validation.js";

// -- Constants ----------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET = 4000;
const CHARS_PER_TOKEN = 4;
const RECENCY_DECAY_DAYS = 7;
const RECENCY_MAX_BONUS = 2;

const CLASSIFICATION_SCORES: Record<string, number> = {
  "class:decision": 5,
  "class:discovery": 4,
  "class:blocker": 4,
  "class:question": 3,
  "class:progress": 2,
  "class:routine": 1,
};

// -- Types --------------------------------------------------------------------

export interface CompileContextOpts {
  tokenBudget?: number;
}

interface ScoredBead {
  bead: BeadRecord;
  score: number;
}

// -- Public API ---------------------------------------------------------------

/**
 * Score and select beads relevant to a target task, within a token budget.
 * Returns formatted markdown string (empty string if no beads selected).
 */
export function compileContext(
  allBeads: BeadRecord[],
  targetTaskId: string,
  targetDeps: string[],
  opts?: CompileContextOpts,
): string {
  if (allBeads.length === 0) return "";

  const budget = opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const now = Date.now();

  // Score each bead
  const scored: ScoredBead[] = allBeads
    .filter((b) => b.id !== targetTaskId) // exclude self
    .map((bead) => ({ bead, score: scoreBead(bead, targetDeps, now) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  // Greedy knapsack — select beads until budget exhausted
  const selected: ScoredBead[] = [];
  let tokensUsed = 0;

  for (const entry of scored) {
    const formatted = formatBead(entry.bead);
    const beadTokens = Math.ceil(formatted.length / CHARS_PER_TOKEN);
    if (tokensUsed + beadTokens > budget) continue; // skip oversized, try next
    selected.push(entry);
    tokensUsed += beadTokens;
  }

  if (selected.length === 0) return "";

  return selected.map((s) => formatBead(s.bead)).join("\n\n");
}

// -- Scoring ------------------------------------------------------------------

function scoreBead(bead: BeadRecord, targetDeps: string[], now: number): number {
  let score = 0;

  // Dependency scoring (+10)
  if (targetDeps.includes(bead.id)) {
    score += 10;
  }

  // Circuit breaker scoring (+8) — active (open) beads with circuit-breaker label
  if (hasLabel(bead.labels, "circuit-breaker") && bead.status === "open") {
    score += 8;
  }

  // Session handoff scoring (+6)
  if (getLabelsWithPrefix(bead.labels, "handoff:").length > 0) {
    score += 6;
  }

  // Classification-based scoring (0-5)
  for (const label of bead.labels) {
    if (label in CLASSIFICATION_SCORES) {
      score += CLASSIFICATION_SCORES[label];
      break; // only count first classification
    }
  }

  // Confidence modifier (-1 to +1)
  if (hasLabel(bead.labels, "confidence:high")) {
    score += 1;
  } else if (hasLabel(bead.labels, "confidence:low")) {
    score -= 1;
  }

  // Recency bonus (0-2, linear decay over 7 days)
  if (bead.created_at) {
    const createdMs = new Date(bead.created_at).getTime();
    if (!Number.isNaN(createdMs)) {
      const ageInDays = (now - createdMs) / 86_400_000;
      const rawBonus = RECENCY_MAX_BONUS * (1 - ageInDays / RECENCY_DECAY_DAYS);
      score += Math.min(RECENCY_MAX_BONUS, Math.max(0, rawBonus));
    }
  }

  return score;
}

// -- Formatting ---------------------------------------------------------------

function formatBead(bead: BeadRecord): string {
  const parts: string[] = [];
  parts.push(`#### ${bead.title ?? bead.id} (${bead.status})`);
  if (bead.labels.length > 0) {
    parts.push(`Labels: ${bead.labels.join(", ")}`);
  }
  if (bead.description) {
    parts.push(bead.description);
  }
  return parts.join("\n");
}
