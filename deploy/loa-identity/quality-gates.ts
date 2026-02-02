/**
 * Loa Cloud Stack - Quality Gates for Compound Learning
 *
 * Implements the 4-gate quality filter to ensure only high-quality
 * learnings are activated. This prevents noise from degrading the system.
 *
 * Gates:
 *   G1: Discovery Depth - Is the solution non-trivial?
 *   G2: Reusability - Is the pattern generalizable?
 *   G3: Trigger Clarity - Can we identify when this applies?
 *   G4: Verification - Was the solution verified to work?
 */

import type { Learning, QualityGates } from './types';

// =============================================================================
// Gate Thresholds
// =============================================================================

/** Minimum score (0-10) required to pass each gate */
const GATE_THRESHOLDS = {
  discovery_depth: 5,
  reusability: 5,
  trigger_clarity: 5,
  verification: 3,
} as const;

/** Overall minimum score to activate a learning */
const MINIMUM_TOTAL_SCORE = 18; // Sum of all gates

// =============================================================================
// Gate Scorers
// =============================================================================

/**
 * G1: Discovery Depth
 * Evaluates whether the solution is non-trivial
 */
export function scoreDiscoveryDepth(learning: Partial<Learning>): number {
  let score = 0;

  // Check pattern length (non-trivial patterns are usually longer)
  const patternLength = (learning.pattern || '').length;
  if (patternLength > 500) score += 3;
  else if (patternLength > 200) score += 2;
  else if (patternLength > 50) score += 1;

  // Check solution specificity
  const solutionLength = (learning.solution || '').length;
  if (solutionLength > 500) score += 3;
  else if (solutionLength > 200) score += 2;
  else if (solutionLength > 50) score += 1;

  // Check if solution includes code or technical details
  const hasCode = /```[\s\S]*```|`[^`]+`/.test(learning.solution || '');
  if (hasCode) score += 2;

  // Check if pattern describes a specific scenario
  const hasSpecificScenario = /when|if|after|before|during/i.test(learning.trigger || '');
  if (hasSpecificScenario) score += 2;

  return Math.min(10, score);
}

/**
 * G2: Reusability
 * Evaluates whether the pattern is generalizable
 */
export function scoreReusability(learning: Partial<Learning>): number {
  let score = 0;

  // Check for generic language (not overly specific)
  const genericTerms = [
    'similar', 'pattern', 'approach', 'strategy', 'general',
    'common', 'typical', 'often', 'usually', 'any', 'all'
  ];
  const patternText = `${learning.trigger || ''} ${learning.pattern || ''}`.toLowerCase();
  const genericCount = genericTerms.filter(term => patternText.includes(term)).length;
  score += Math.min(3, genericCount);

  // Penalize overly specific patterns
  const specificIndicators = [
    'only this file', 'just for', 'exactly this', 'specific to',
    'unique case', 'one-time', 'temporary fix'
  ];
  const specificCount = specificIndicators.filter(term => patternText.includes(term)).length;
  score -= Math.min(3, specificCount * 2);

  // Check if applicable to multiple scenarios
  const multipleScenarios = /or|and|also|as well|multiple/i.test(learning.trigger || '');
  if (multipleScenarios) score += 2;

  // Check if the target is a general category
  if (learning.target === 'loa') score += 2; // Framework-level improvements are highly reusable
  else if (learning.target === 'devcontainer') score += 2;
  else if (learning.target === 'moltworker') score += 1;
  else score += 1;

  // Base score for having a clear pattern
  if (learning.pattern && learning.pattern.length > 0) score += 2;

  return Math.max(0, Math.min(10, score));
}

/**
 * G3: Trigger Clarity
 * Evaluates whether we can identify when this learning applies
 */
export function scoreTriggerClarity(learning: Partial<Learning>): number {
  let score = 0;

  const trigger = learning.trigger || '';

  // Empty trigger fails
  if (trigger.length === 0) return 0;

  // Check for clear conditional language
  const conditionalPatterns = [
    /when\s+\w+/i,
    /if\s+\w+/i,
    /after\s+\w+/i,
    /before\s+\w+/i,
    /during\s+\w+/i,
    /whenever\s+\w+/i,
  ];
  const conditionalMatches = conditionalPatterns.filter(p => p.test(trigger)).length;
  score += Math.min(4, conditionalMatches * 2);

  // Check for specific actions or events
  const actionPatterns = [
    /error|fail|crash|exception/i,
    /deploy|build|test|install/i,
    /create|update|delete|modify/i,
    /start|stop|restart|initialize/i,
    /request|response|api|endpoint/i,
  ];
  const actionMatches = actionPatterns.filter(p => p.test(trigger)).length;
  score += Math.min(3, actionMatches);

  // Check trigger length (not too short, not too long)
  if (trigger.length >= 20 && trigger.length <= 200) score += 2;
  else if (trigger.length >= 10) score += 1;

  // Check for context clues
  const hasContext = /in\s+\w+|with\s+\w+|using\s+\w+|for\s+\w+/i.test(trigger);
  if (hasContext) score += 1;

  return Math.min(10, score);
}

/**
 * G4: Verification
 * Evaluates whether the solution was verified to work
 */
export function scoreVerification(learning: Partial<Learning>): number {
  let score = 0;

  // Check source (some sources are more reliable)
  if (learning.source === 'sprint') score += 3; // Sprint completion implies testing
  else if (learning.source === 'error-cycle') score += 2; // Error-solution cycles are verified by nature
  else if (learning.source === 'retrospective') score += 1; // Manual retrospectives vary in rigor

  // Check if solution mentions testing or verification
  const solution = learning.solution || '';
  const verificationTerms = [
    'tested', 'verified', 'confirmed', 'works', 'successful',
    'passed', 'validated', 'checked'
  ];
  const verificationCount = verificationTerms.filter(term =>
    solution.toLowerCase().includes(term)
  ).length;
  score += Math.min(3, verificationCount);

  // Check if there's an effectiveness record (for existing learnings)
  if (learning.effectiveness) {
    const { successes, failures, applications } = learning.effectiveness;
    if (applications > 0) {
      const successRate = successes / applications;
      if (successRate >= 0.8) score += 3;
      else if (successRate >= 0.6) score += 2;
      else if (successRate >= 0.4) score += 1;
    }
  }

  // Base score for having a solution
  if (solution.length > 0) score += 1;

  return Math.min(10, score);
}

// =============================================================================
// Combined Scoring
// =============================================================================

/**
 * Score all quality gates for a learning
 */
export function scoreAllGates(learning: Partial<Learning>): QualityGates {
  return {
    discovery_depth: scoreDiscoveryDepth(learning),
    reusability: scoreReusability(learning),
    trigger_clarity: scoreTriggerClarity(learning),
    verification: scoreVerification(learning),
  };
}

/**
 * Check if a learning passes all quality gates
 */
export function passesQualityGates(learning: Partial<Learning>): boolean {
  const gates = learning.gates || scoreAllGates(learning);

  // Check individual gate thresholds
  if (gates.discovery_depth < GATE_THRESHOLDS.discovery_depth) return false;
  if (gates.reusability < GATE_THRESHOLDS.reusability) return false;
  if (gates.trigger_clarity < GATE_THRESHOLDS.trigger_clarity) return false;
  if (gates.verification < GATE_THRESHOLDS.verification) return false;

  // Check total score
  const totalScore =
    gates.discovery_depth +
    gates.reusability +
    gates.trigger_clarity +
    gates.verification;

  return totalScore >= MINIMUM_TOTAL_SCORE;
}

/**
 * Get detailed gate results with pass/fail status
 */
export function getGateResults(learning: Partial<Learning>): {
  gates: QualityGates;
  thresholds: typeof GATE_THRESHOLDS;
  results: {
    discovery_depth: boolean;
    reusability: boolean;
    trigger_clarity: boolean;
    verification: boolean;
  };
  totalScore: number;
  passes: boolean;
} {
  const gates = learning.gates || scoreAllGates(learning);
  const totalScore =
    gates.discovery_depth +
    gates.reusability +
    gates.trigger_clarity +
    gates.verification;

  return {
    gates,
    thresholds: GATE_THRESHOLDS,
    results: {
      discovery_depth: gates.discovery_depth >= GATE_THRESHOLDS.discovery_depth,
      reusability: gates.reusability >= GATE_THRESHOLDS.reusability,
      trigger_clarity: gates.trigger_clarity >= GATE_THRESHOLDS.trigger_clarity,
      verification: gates.verification >= GATE_THRESHOLDS.verification,
    },
    totalScore,
    passes: passesQualityGates({ ...learning, gates }),
  };
}

export default {
  scoreDiscoveryDepth,
  scoreReusability,
  scoreTriggerClarity,
  scoreVerification,
  scoreAllGates,
  passesQualityGates,
  getGateResults,
  GATE_THRESHOLDS,
  MINIMUM_TOTAL_SCORE,
};
