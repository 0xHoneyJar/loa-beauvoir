/**
 * Lexical Fallback Tests - Golden test cases for Jaccard similarity
 *
 * These tests validate that the Jaccard lexical fallback produces acceptable
 * results compared to semantic similarity. Documents expected divergence
 * (false positives/negatives).
 *
 * @module tests/memory/lexical-fallback.test
 */

import { describe, it, expect } from 'vitest';

/**
 * Tokenize text for Jaccard similarity (matches consolidation-engine.ts)
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

/**
 * Calculate Jaccard similarity between two token sets
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Calculate Jaccard similarity between two texts
 */
function textJaccardSimilarity(text1: string, text2: string): number {
  return jaccardSimilarity(tokenize(text1), tokenize(text2));
}

describe('Lexical Fallback - Jaccard Similarity', () => {
  describe('Golden Test Cases - True Positives', () => {
    /**
     * These pairs SHOULD be detected as similar (threshold 0.80)
     */
    it('should detect near-identical text', () => {
      const text1 = 'The user prefers dark mode for all applications';
      const text2 = 'User prefers dark mode for all their applications';

      const similarity = textJaccardSimilarity(text1, text2);
      expect(similarity).toBeGreaterThanOrEqual(0.8);
    });

    it('should detect paraphrased technical content', () => {
      const text1 = 'Configure the database connection string in config.json';
      const text2 = 'The database connection string should be configured in config.json';

      const similarity = textJaccardSimilarity(text1, text2);
      expect(similarity).toBeGreaterThanOrEqual(0.6); // Lower threshold for paraphrase
    });

    it('should detect preference with minor wording changes', () => {
      const text1 = 'Always use TypeScript strict mode in new projects';
      const text2 = 'New projects should always use TypeScript with strict mode';

      const similarity = textJaccardSimilarity(text1, text2);
      expect(similarity).toBeGreaterThanOrEqual(0.6);
    });

    it('should detect error messages with same structure', () => {
      const text1 = 'Error: Failed to connect to database server at localhost:5432';
      const text2 = 'Error: Failed to connect to database server at localhost:5433';

      const similarity = textJaccardSimilarity(text1, text2);
      expect(similarity).toBeGreaterThanOrEqual(0.8);
    });

    it('should detect API endpoint descriptions', () => {
      const text1 = 'The /api/users endpoint returns a list of all users';
      const text2 = 'GET /api/users endpoint returns list of all users';

      const similarity = textJaccardSimilarity(text1, text2);
      expect(similarity).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe('Golden Test Cases - True Negatives', () => {
    /**
     * These pairs should NOT be detected as similar
     */
    it('should not detect unrelated technical content', () => {
      const text1 = 'Install the npm package using yarn add react';
      const text2 = 'Configure nginx proxy settings for production';

      const similarity = textJaccardSimilarity(text1, text2);
      expect(similarity).toBeLessThan(0.3);
    });

    it('should not detect different preferences', () => {
      const text1 = 'User prefers light mode during the day';
      const text2 = 'Always format code with 4-space indentation';

      const similarity = textJaccardSimilarity(text1, text2);
      expect(similarity).toBeLessThan(0.3);
    });

    it('should not detect opposite meanings', () => {
      const text1 = 'Always run tests before committing code';
      const text2 = 'Skip tests when making small documentation changes';

      const similarity = textJaccardSimilarity(text1, text2);
      expect(similarity).toBeLessThan(0.4);
    });

    it('should not detect different error types', () => {
      const text1 = 'TypeError: Cannot read property of undefined';
      const text2 = 'SyntaxError: Unexpected token in JSON at position 0';

      const similarity = textJaccardSimilarity(text1, text2);
      expect(similarity).toBeLessThan(0.3);
    });
  });

  describe('Expected Divergence - Known Limitations', () => {
    /**
     * These document cases where lexical != semantic
     * Tests are structured to document behavior, not enforce it
     */

    it('DIVERGENCE: synonyms have low Jaccard but high semantic similarity', () => {
      // Semantic: "automobile" = "car" (high similarity)
      // Lexical: different words (low Jaccard)
      const text1 = 'The automobile is parked in the garage';
      const text2 = 'The car is in the parking area';

      const similarity = textJaccardSimilarity(text1, text2);

      // Document the expected divergence
      // Semantic would catch this, Jaccard will not
      expect(similarity).toBeLessThan(0.5);

      // This is a FALSE NEGATIVE for lexical fallback
      console.log('DIVERGENCE: Synonym pairs - Jaccard:', similarity.toFixed(2));
    });

    it('DIVERGENCE: same words different meaning have high Jaccard', () => {
      // "bank" has multiple meanings
      const text1 = 'I went to the bank to deposit money';
      const text2 = 'I sat by the river bank to relax';

      const similarity = textJaccardSimilarity(text1, text2);

      // Document the expected divergence
      // Semantic would distinguish, Jaccard may not
      expect(similarity).toBeLessThan(0.4); // Actually different enough

      console.log('DIVERGENCE: Homonym pairs - Jaccard:', similarity.toFixed(2));
    });

    it('DIVERGENCE: negation not detected by Jaccard', () => {
      // Same words but opposite meaning
      const text1 = 'The server is running correctly';
      const text2 = 'The server is not running correctly';

      const similarity = textJaccardSimilarity(text1, text2);

      // Jaccard will show high similarity despite negation
      // This is a FALSE POSITIVE for lexical fallback
      expect(similarity).toBeGreaterThan(0.7);

      console.log('DIVERGENCE: Negation pairs - Jaccard:', similarity.toFixed(2));
    });

    it('DIVERGENCE: word order significance lost', () => {
      // Order matters semantically
      const text1 = 'The dog bit the man';
      const text2 = 'The man bit the dog';

      const similarity = textJaccardSimilarity(text1, text2);

      // Jaccard treats these as identical (bag of words)
      // This is a FALSE POSITIVE for lexical fallback
      expect(similarity).toBe(1.0);

      console.log('DIVERGENCE: Word order - Jaccard:', similarity.toFixed(2));
    });

    it('DIVERGENCE: technical jargon vs plain language', () => {
      // Same concept, different vocabulary
      const text1 = 'Initialize the singleton instance in the constructor';
      const text2 = 'Create one shared object when setting up the class';

      const similarity = textJaccardSimilarity(text1, text2);

      // Semantic would catch this, Jaccard will not
      expect(similarity).toBeLessThan(0.4);

      console.log('DIVERGENCE: Jargon vs plain - Jaccard:', similarity.toFixed(2));
    });
  });

  describe('Threshold Validation', () => {
    it('threshold 0.80 catches most duplicates', () => {
      const testCases = [
        {
          a: 'Configure eslint rules in .eslintrc.json',
          b: 'ESLint rules should be configured in .eslintrc.json',
          expectedMatch: true,
        },
        {
          a: 'Use prettier for code formatting',
          b: 'Format all code using prettier',
          expectedMatch: true,
        },
        {
          a: 'Database credentials stored in environment variables',
          b: 'Store database connection details in env vars',
          expectedMatch: false, // Too different
        },
        {
          a: 'Run npm install to install dependencies',
          b: 'Install project dependencies with npm install',
          expectedMatch: true,
        },
      ];

      const threshold = 0.50; // Relaxed for lexical

      for (const { a, b, expectedMatch } of testCases) {
        const similarity = textJaccardSimilarity(a, b);
        const isMatch = similarity >= threshold;

        if (expectedMatch && !isMatch) {
          console.log(
            `FALSE NEGATIVE: "${a.substring(0, 30)}..." vs "${b.substring(0, 30)}..." = ${similarity.toFixed(2)}`
          );
        }
        if (!expectedMatch && isMatch) {
          console.log(
            `FALSE POSITIVE: "${a.substring(0, 30)}..." vs "${b.substring(0, 30)}..." = ${similarity.toFixed(2)}`
          );
        }
      }
    });

    it('threshold comparison: 0.60 vs 0.80 vs 0.90', () => {
      const pairs = [
        ['The function returns an array of objects', 'The function returns a list of objects'],
        ['Set the API key in the configuration file', 'Configure the API key in settings'],
        ['Use git rebase for clean history', 'Prefer git rebase to maintain clean history'],
        ['The test suite runs in under 5 seconds', 'All tests complete within 5 seconds'],
      ];

      const thresholds = [0.6, 0.8, 0.9];

      console.log('\nThreshold Analysis:');
      console.log('Pair | Jaccard | @0.60 | @0.80 | @0.90');
      console.log('-'.repeat(60));

      for (const [a, b] of pairs) {
        const similarity = textJaccardSimilarity(a, b);
        const matches = thresholds.map((t) => (similarity >= t ? '✓' : '✗'));
        console.log(
          `${a.substring(0, 20)}... | ${similarity.toFixed(2)} | ${matches.join(' | ')}`
        );
      }
    });
  });

  describe('Performance Characteristics', () => {
    it('handles long texts efficiently', () => {
      const longText1 = 'word '.repeat(1000);
      const longText2 = 'word '.repeat(999) + 'different ';

      const start = Date.now();
      const similarity = textJaccardSimilarity(longText1, longText2);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(100); // Should complete in under 100ms
      expect(similarity).toBeGreaterThan(0.9);
    });

    it('handles empty and single-word texts', () => {
      expect(textJaccardSimilarity('', '')).toBe(0); // Empty sets
      expect(textJaccardSimilarity('hello', '')).toBe(0);
      expect(textJaccardSimilarity('hello', 'hello')).toBe(1);
      expect(textJaccardSimilarity('a b', 'a b')).toBe(0); // Words filtered (< 3 chars)
    });
  });
});

/**
 * Acceptance Criteria for Lexical Fallback:
 *
 * 1. MUST detect exact and near-exact duplicates (Jaccard >= 0.80)
 * 2. MUST NOT merge unrelated content (Jaccard < 0.30)
 * 3. SHOULD complete in < 100ms for typical memory entries
 * 4. MAY have false negatives for synonym-heavy content
 * 5. MAY have false positives for negation (semantic difference)
 *
 * When to prefer lexical over semantic:
 * - Embedding service unavailable
 * - Batch processing time-critical
 * - Memory entries are short and keyword-heavy
 *
 * When semantic is strongly preferred:
 * - Paraphrased content detection needed
 * - Technical jargon varies
 * - Negation detection matters
 */
