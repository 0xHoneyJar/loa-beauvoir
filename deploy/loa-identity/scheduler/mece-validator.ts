/**
 * MECEValidator - MECE Task Validation (FR-8)
 *
 * Prevents redundant/overlapping scheduled tasks using MECE principles:
 * - Mutually Exclusive: No two tasks should do the same thing
 * - Collectively Exhaustive: All necessary tasks should be covered
 *
 * @module deploy/loa-identity/scheduler/mece-validator
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { appendFile } from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

// =============================================================================
// Interfaces
// =============================================================================

export interface MECEConfig {
  /** Similarity threshold for name comparison (0-1, default: 0.7) */
  similarityThreshold: number;
  /** Require PURPOSE header in scripts/crons */
  requirePurposeHeader: boolean;
  /** Block creation on overlap */
  blockOverlappingCrons: boolean;
}

export interface TaskCandidate {
  type: 'cron' | 'script';
  name: string;
  schedule?: string;
  purpose?: string;
  content?: string;
}

export interface MECEViolation {
  rule: 'cron_overlap' | 'script_similarity' | 'purpose_missing';
  candidate: string;
  conflictsWith?: string;
  similarity?: number;
  suggestion: string;
}

export interface MECEValidationResult {
  valid: boolean;
  violations: MECEViolation[];
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: MECEConfig = {
  similarityThreshold: 0.7,
  requirePurposeHeader: true,
  blockOverlappingCrons: true,
};

// =============================================================================
// MECEValidator Class
// =============================================================================

export class MECEValidator {
  private config: MECEConfig;
  private auditLogPath: string;
  private scriptsDir: string;

  constructor(
    config?: Partial<MECEConfig>,
    options?: {
      auditLogPath?: string;
      scriptsDir?: string;
    }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.auditLogPath = options?.auditLogPath ?? '/workspace/.loa/mece-audit.log';
    this.scriptsDir = options?.scriptsDir ?? '/workspace/scripts';
  }

  /**
   * Validate a new task before creation.
   *
   * @param candidate - The task to validate
   * @returns Validation result with any violations
   */
  async validate(candidate: TaskCandidate): Promise<MECEValidationResult> {
    const violations: MECEViolation[] = [];

    // Rule 1: No overlapping cron schedules
    if (candidate.type === 'cron' && candidate.schedule) {
      const overlap = await this.checkCronOverlap(candidate);
      if (overlap) {
        violations.push(overlap);
      }
    }

    // Rule 2: No highly similar script names
    if (candidate.type === 'script') {
      const similarityViolations = await this.checkScriptSimilarity(candidate);
      violations.push(...similarityViolations);
    }

    // Rule 3: Purpose header required
    if (this.config.requirePurposeHeader && !candidate.purpose) {
      violations.push({
        rule: 'purpose_missing',
        candidate: candidate.name,
        suggestion: 'Add PURPOSE header describing what this task does',
      });
    }

    // Log validation
    await this.logValidation(candidate, violations);

    return {
      valid: violations.length === 0,
      violations,
    };
  }

  /**
   * Check if a cron schedule conflicts with existing crons.
   */
  private async checkCronOverlap(candidate: TaskCandidate): Promise<MECEViolation | null> {
    if (!this.config.blockOverlappingCrons) {
      return null;
    }

    const existingSchedules = await this.getExistingCronSchedules();
    const conflict = existingSchedules.find((e) => e.schedule === candidate.schedule);

    if (conflict) {
      return {
        rule: 'cron_overlap',
        candidate: candidate.name,
        conflictsWith: conflict.name,
        suggestion: `Stagger schedule or consolidate with ${conflict.name}`,
      };
    }

    return null;
  }

  /**
   * Check if script name is too similar to existing scripts.
   */
  private async checkScriptSimilarity(
    candidate: TaskCandidate
  ): Promise<MECEViolation[]> {
    const violations: MECEViolation[] = [];
    const existingScripts = await this.getExistingScripts();

    for (const existing of existingScripts) {
      const similarity = this.calculateNameSimilarity(candidate.name, existing);
      if (similarity >= this.config.similarityThreshold) {
        violations.push({
          rule: 'script_similarity',
          candidate: candidate.name,
          conflictsWith: existing,
          similarity,
          suggestion: `Check if ${existing} already does this - consolidate if so`,
        });
      }
    }

    return violations;
  }

  /**
   * Calculate Jaccard similarity between two names.
   * Uses word-level tokenization after normalization.
   */
  calculateNameSimilarity(a: string, b: string): number {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/\.(sh|py|ts|js)$/, '')
        .split(/[-_]/)
        .join(' ');

    const wordsA = new Set(normalize(a).split(/\s+/).filter(Boolean));
    const wordsB = new Set(normalize(b).split(/\s+/).filter(Boolean));

    if (wordsA.size === 0 && wordsB.size === 0) return 1;
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    const intersection = new Set([...wordsA].filter((x) => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    return intersection.size / union.size;
  }

  /**
   * Get existing cron schedules.
   */
  private async getExistingCronSchedules(): Promise<
    Array<{ name: string; schedule: string }>
  > {
    const schedules: Array<{ name: string; schedule: string }> = [];

    try {
      const { stdout } = await execAsync('crontab -l 2>/dev/null');
      const lines = stdout.split('\n').filter((l) => l && !l.startsWith('#'));

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          const schedule = parts.slice(0, 5).join(' ');
          const command = parts.slice(5).join(' ');
          schedules.push({
            name: command.substring(0, 50),
            schedule,
          });
        }
      }
    } catch {
      // No crontab
    }

    return schedules;
  }

  /**
   * Get existing script names.
   */
  private async getExistingScripts(): Promise<string[]> {
    try {
      const { stdout } = await execAsync(
        `find "${this.scriptsDir}" -type f 2>/dev/null`
      );
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((p) => path.basename(p));
    } catch {
      return [];
    }
  }

  /**
   * Log validation to audit file.
   */
  private async logValidation(
    candidate: TaskCandidate,
    violations: MECEViolation[]
  ): Promise<void> {
    const entry = {
      timestamp: new Date().toISOString(),
      candidate: {
        type: candidate.type,
        name: candidate.name,
        schedule: candidate.schedule,
        hasPurpose: !!candidate.purpose,
      },
      valid: violations.length === 0,
      violationCount: violations.length,
      violations: violations.map((v) => ({
        rule: v.rule,
        conflictsWith: v.conflictsWith,
        similarity: v.similarity,
      })),
    };

    try {
      await appendFile(this.auditLogPath, JSON.stringify(entry) + '\n');
    } catch (error) {
      console.error('[mece-validator] Failed to write audit log:', error);
    }
  }

  /**
   * Extract PURPOSE from script content.
   */
  static extractPurpose(content: string): string | undefined {
    // Match patterns like:
    // # PURPOSE: ...
    // // PURPOSE: ...
    // """PURPOSE: ..."""
    // * PURPOSE: ...
    const patterns = [
      /^#\s*PURPOSE:\s*(.+)$/im,
      /^\/\/\s*PURPOSE:\s*(.+)$/im,
      /^\*\s*PURPOSE:\s*(.+)$/im,
      /PURPOSE:\s*(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    return undefined;
  }

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<MECEConfig> {
    return { ...this.config };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createMECEValidator(config?: Partial<MECEConfig>): MECEValidator {
  return new MECEValidator(config);
}

export default MECEValidator;
