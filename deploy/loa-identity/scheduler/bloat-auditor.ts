/**
 * BloatAuditor - Weekly Bloat Audit (FR-7)
 *
 * Detects and prevents resource proliferation before quota exhaustion.
 * Runs weekly to count crons, scripts, state files, and detect orphans.
 *
 * @module deploy/loa-identity/scheduler/bloat-auditor
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { appendFile, readFile, stat, readdir } from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

// =============================================================================
// Security Utilities
// =============================================================================

/**
 * Shell-safe string escaping to prevent command injection.
 * Uses single quotes and escapes embedded single quotes.
 */
function shellEscape(str: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Validate a path is safe (no shell metacharacters, stays within bounds).
 */
function isPathSafe(p: string): boolean {
  // Check for common shell metacharacters
  const unsafeChars = /[`$(){};&|<>\\*?[\]!#~]/;
  return !unsafeChars.test(p);
}

// =============================================================================
// Interfaces
// =============================================================================

export interface BloatThresholds {
  crons: { warn: number; critical: number };
  scripts: { warn: number; critical: number };
  stateFileSizeMB: { warn: number; critical: number };
}

export interface BloatAuditResult {
  timestamp: Date;
  status: 'healthy' | 'warning' | 'critical';
  counts: {
    crons: number;
    scripts: number;
    orphanedScripts: number;
    overlappingCrons: number;
    stateFileSizeMB: number;
  };
  violations: BloatViolation[];
  remediation: string[];
}

export interface BloatViolation {
  type: 'count_exceeded' | 'orphaned' | 'overlap' | 'size_exceeded';
  resource: string;
  details: string;
  severity: 'warning' | 'critical';
}

export interface CronOverlap {
  cron1: string;
  cron2: string;
  schedule: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_THRESHOLDS: BloatThresholds = {
  crons: { warn: 15, critical: 20 },
  scripts: { warn: 40, critical: 50 },
  stateFileSizeMB: { warn: 5, critical: 10 },
};

// =============================================================================
// BloatAuditor Class
// =============================================================================

export class BloatAuditor {
  private thresholds: BloatThresholds;
  private auditLogPath: string;
  private notesPath: string;
  private scriptsDir: string;
  private grimoireDir: string;

  constructor(
    thresholds?: Partial<BloatThresholds>,
    options?: {
      auditLogPath?: string;
      notesPath?: string;
      scriptsDir?: string;
      grimoireDir?: string;
    }
  ) {
    this.thresholds = {
      crons: thresholds?.crons ?? DEFAULT_THRESHOLDS.crons,
      scripts: thresholds?.scripts ?? DEFAULT_THRESHOLDS.scripts,
      stateFileSizeMB: thresholds?.stateFileSizeMB ?? DEFAULT_THRESHOLDS.stateFileSizeMB,
    };
    this.auditLogPath = options?.auditLogPath ?? '/workspace/.loa/bloat-audit.log';
    this.notesPath = options?.notesPath ?? '/workspace/grimoires/loa/NOTES.md';
    this.scriptsDir = options?.scriptsDir ?? '/workspace/scripts';
    this.grimoireDir = options?.grimoireDir ?? '/workspace/grimoires/loa';
  }

  /**
   * Run the full bloat audit.
   */
  async runAudit(): Promise<BloatAuditResult> {
    const violations: BloatViolation[] = [];
    const remediation: string[] = [];

    // 1. Count crons
    const cronCount = await this.countCrons();
    if (cronCount > this.thresholds.crons.critical) {
      violations.push({
        type: 'count_exceeded',
        resource: 'crons',
        details: `${cronCount} crons (critical: ${this.thresholds.crons.critical})`,
        severity: 'critical',
      });
      remediation.push('Consolidate crons - batch similar schedules');
    } else if (cronCount > this.thresholds.crons.warn) {
      violations.push({
        type: 'count_exceeded',
        resource: 'crons',
        details: `${cronCount} crons (warn: ${this.thresholds.crons.warn})`,
        severity: 'warning',
      });
    }

    // 2. Count scripts
    const scriptCount = await this.countScripts();
    if (scriptCount > this.thresholds.scripts.critical) {
      violations.push({
        type: 'count_exceeded',
        resource: 'scripts',
        details: `${scriptCount} scripts (critical: ${this.thresholds.scripts.critical})`,
        severity: 'critical',
      });
      remediation.push('Remove orphaned scripts, consolidate duplicates');
    } else if (scriptCount > this.thresholds.scripts.warn) {
      violations.push({
        type: 'count_exceeded',
        resource: 'scripts',
        details: `${scriptCount} scripts (warn: ${this.thresholds.scripts.warn})`,
        severity: 'warning',
      });
    }

    // 3. Find orphaned scripts
    const orphanedScripts = await this.findOrphanedScripts();
    for (const script of orphanedScripts) {
      violations.push({
        type: 'orphaned',
        resource: script,
        details: 'Script not referenced in codebase',
        severity: 'warning',
      });
    }
    if (orphanedScripts.length > 0) {
      remediation.push(`Delete ${orphanedScripts.length} orphaned scripts`);
    }

    // 4. Find overlapping cron schedules
    const overlappingCrons = await this.findOverlappingCrons();
    for (const { cron1, cron2, schedule } of overlappingCrons) {
      violations.push({
        type: 'overlap',
        resource: `${cron1} + ${cron2}`,
        details: `Both scheduled at ${schedule}`,
        severity: 'warning',
      });
    }
    if (overlappingCrons.length > 0) {
      remediation.push('Stagger overlapping crons or consolidate');
    }

    // 5. Check state file sizes
    const stateFileSizeMB = await this.getStateFileSize();
    if (stateFileSizeMB > this.thresholds.stateFileSizeMB.critical) {
      violations.push({
        type: 'size_exceeded',
        resource: 'state files',
        details: `${stateFileSizeMB}MB (critical: ${this.thresholds.stateFileSizeMB.critical}MB)`,
        severity: 'critical',
      });
      remediation.push('Compact WAL, archive old memory files');
    } else if (stateFileSizeMB > this.thresholds.stateFileSizeMB.warn) {
      violations.push({
        type: 'size_exceeded',
        resource: 'state files',
        details: `${stateFileSizeMB}MB (warn: ${this.thresholds.stateFileSizeMB.warn}MB)`,
        severity: 'warning',
      });
    }

    // Determine overall status
    const hasCritical = violations.some((v) => v.severity === 'critical');
    const hasWarning = violations.some((v) => v.severity === 'warning');
    const status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

    const result: BloatAuditResult = {
      timestamp: new Date(),
      status,
      counts: {
        crons: cronCount,
        scripts: scriptCount,
        orphanedScripts: orphanedScripts.length,
        overlappingCrons: overlappingCrons.length,
        stateFileSizeMB,
      },
      violations,
      remediation,
    };

    // Log to audit trail
    await this.logAudit(result);

    // Write summary to NOTES.md
    await this.writeToNotes(result);

    return result;
  }

  /**
   * Count active cron entries.
   */
  async countCrons(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        "crontab -l 2>/dev/null | grep -v '^#' | grep -v '^$' | wc -l"
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Count script files.
   * Uses Node.js fs instead of shell find to prevent injection (MED-006 remediation).
   */
  async countScripts(): Promise<number> {
    const scriptExtensions = ['.sh', '.py', '.ts', '.js'];

    try {
      const files = await this.listScriptsRecursive(this.scriptsDir);
      return files.filter((f) =>
        scriptExtensions.some((ext) => f.endsWith(ext))
      ).length;
    } catch {
      return 0;
    }
  }

  /**
   * Find scripts that are not referenced anywhere in the codebase.
   * Uses Node.js fs for directory listing and spawn() with args array for ripgrep
   * to prevent command injection (Security: CRIT-001 remediation).
   */
  async findOrphanedScripts(): Promise<string[]> {
    const orphaned: string[] = [];

    try {
      // Use Node.js fs instead of shell find to avoid injection
      const scripts = await this.listScriptsRecursive(this.scriptsDir);

      for (const script of scripts) {
        const basename = path.basename(script);

        // Validate basename is safe for pattern matching
        if (!isPathSafe(basename)) {
          console.warn(`[bloat-auditor] Skipping unsafe filename: ${script}`);
          continue;
        }

        // Check if referenced anywhere using spawn with args array (no shell injection)
        const isReferenced = await this.checkFileReferenced(basename);
        if (!isReferenced) {
          orphaned.push(script);
        }
      }
    } catch {
      // No scripts directory or listing failed
    }

    return orphaned;
  }

  /**
   * Recursively list files in a directory using Node.js fs.
   */
  private async listScriptsRecursive(dir: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const subFiles = await this.listScriptsRecursive(fullPath);
          results.push(...subFiles);
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return results;
  }

  /**
   * Check if a file is referenced in the codebase using spawn (no shell).
   * Uses ripgrep with proper argument separation to prevent injection.
   */
  private checkFileReferenced(basename: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Use spawn with args array - no shell interpolation
      const rg = spawn('rg', [
        '-l',
        '--',                // End of options marker
        `\\b${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, // Escape regex metacharacters
        '.',
        '--glob', '!scripts/*',
        '--glob', '!node_modules/*',
      ], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30000,
      });

      let hasOutput = false;

      rg.stdout.on('data', () => {
        hasOutput = true;
      });

      rg.on('close', () => {
        resolve(hasOutput);
      });

      rg.on('error', () => {
        // rg not available, assume not referenced
        resolve(false);
      });
    });
  }

  /**
   * Find cron entries with identical schedules.
   */
  async findOverlappingCrons(): Promise<CronOverlap[]> {
    const overlaps: CronOverlap[] = [];

    try {
      const { stdout } = await execAsync('crontab -l 2>/dev/null');
      const lines = stdout.split('\n').filter((l) => l && !l.startsWith('#'));

      const scheduleMap = new Map<string, string[]>();

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          const schedule = parts.slice(0, 5).join(' ');
          const command = parts.slice(5).join(' ');
          if (!scheduleMap.has(schedule)) {
            scheduleMap.set(schedule, []);
          }
          scheduleMap.get(schedule)!.push(command);
        }
      }

      for (const [schedule, commands] of scheduleMap) {
        if (commands.length > 1) {
          for (let i = 0; i < commands.length - 1; i++) {
            overlaps.push({
              cron1: commands[i].substring(0, 50),
              cron2: commands[i + 1].substring(0, 50),
              schedule,
            });
          }
        }
      }
    } catch {
      // No crontab or parsing failed
    }

    return overlaps;
  }

  /**
   * Get total size of grimoire state files in MB.
   */
  async getStateFileSize(): Promise<number> {
    try {
      const { stdout } = await execAsync(
        `du -sm "${this.grimoireDir}" 2>/dev/null | cut -f1`
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Log audit result to JSONL file.
   */
  private async logAudit(result: BloatAuditResult): Promise<void> {
    try {
      const entry = {
        ...result,
        timestamp: result.timestamp.toISOString(),
      };
      const line = JSON.stringify(entry) + '\n';
      await appendFile(this.auditLogPath, line);
    } catch (error) {
      console.error('[bloat-auditor] Failed to write audit log:', error);
    }
  }

  /**
   * Write summary to NOTES.md.
   */
  private async writeToNotes(result: BloatAuditResult): Promise<void> {
    const timestamp = result.timestamp.toISOString();
    const statusEmoji =
      result.status === 'healthy'
        ? '✅'
        : result.status === 'warning'
        ? '⚠️'
        : '🚨';

    const entry = `
### Bloat Audit ${timestamp}

**Status**: ${statusEmoji} ${result.status.toUpperCase()}

| Metric | Count | Threshold |
|--------|-------|-----------|
| Crons | ${result.counts.crons} | warn: ${this.thresholds.crons.warn}, crit: ${this.thresholds.crons.critical} |
| Scripts | ${result.counts.scripts} | warn: ${this.thresholds.scripts.warn}, crit: ${this.thresholds.scripts.critical} |
| Orphaned | ${result.counts.orphanedScripts} | - |
| Overlapping | ${result.counts.overlappingCrons} | - |
| State Size | ${result.counts.stateFileSizeMB}MB | warn: ${this.thresholds.stateFileSizeMB.warn}MB |

${
  result.violations.length > 0
    ? '**Violations:**\n' +
      result.violations.map((v) => `- [${v.severity}] ${v.type}: ${v.details}`).join('\n')
    : ''
}

${
  result.remediation.length > 0
    ? '**Remediation:**\n' + result.remediation.map((r) => `- ${r}`).join('\n')
    : ''
}
`;

    try {
      await appendFile(this.notesPath, entry);
    } catch (error) {
      console.error('[bloat-auditor] Failed to write to NOTES.md:', error);
    }
  }

  /**
   * Get current thresholds.
   */
  getThresholds(): Readonly<BloatThresholds> {
    return { ...this.thresholds };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createBloatAuditor(
  thresholds?: Partial<BloatThresholds>
): BloatAuditor {
  return new BloatAuditor(thresholds);
}

export default BloatAuditor;
