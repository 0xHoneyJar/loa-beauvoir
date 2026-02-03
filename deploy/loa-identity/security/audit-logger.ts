/**
 * Audit Logger - Tamper-evident logging for security operations
 *
 * Implements JSONL append-only logging with SHA-256 checksums for each entry.
 * Used for repair actions, recovery events, and security-sensitive operations.
 *
 * @module deploy/loa-identity/security/audit-logger
 */

import { appendFile, readFile, stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { dirname } from 'path';

export interface AuditEntry {
  timestamp: string;
  action: string;
  actor: 'system' | 'user' | 'automated';
  details: Record<string, unknown>;
  checksum: string;
  previous_checksum: string | null;
}

export interface AuditLoggerConfig {
  logPath: string;
  maxSizeBytes?: number;
  rotateOnSize?: boolean;
}

/**
 * AuditLogger provides tamper-evident logging with cryptographic chaining.
 * Each entry includes a checksum of its content and the previous entry's checksum,
 * creating a hash chain that detects tampering.
 */
export class AuditLogger {
  private config: Required<AuditLoggerConfig>;
  private lastChecksum: string | null = null;
  private initialized = false;

  constructor(logPathOrConfig: string | AuditLoggerConfig) {
    if (typeof logPathOrConfig === 'string') {
      this.config = {
        logPath: logPathOrConfig,
        maxSizeBytes: 10 * 1024 * 1024, // 10MB default
        rotateOnSize: true,
      };
    } else {
      this.config = {
        logPath: logPathOrConfig.logPath,
        maxSizeBytes: logPathOrConfig.maxSizeBytes ?? 10 * 1024 * 1024,
        rotateOnSize: logPathOrConfig.rotateOnSize ?? true,
      };
    }
  }

  /**
   * Initialize the logger and load last checksum
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure directory exists
    const dir = dirname(this.config.logPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Load last checksum from existing log
    if (existsSync(this.config.logPath)) {
      await this.loadLastChecksum();
    }

    this.initialized = true;
  }

  /**
   * Load the last entry's checksum from the log file
   */
  private async loadLastChecksum(): Promise<void> {
    try {
      const content = await readFile(this.config.logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        const entry = JSON.parse(lastLine) as AuditEntry;
        this.lastChecksum = entry.checksum;
      }
    } catch (e) {
      console.warn('[audit-logger] Error loading last checksum:', e);
    }
  }

  /**
   * Log an action with automatic checksum chaining
   */
  async log(
    action: string,
    details: Record<string, unknown>,
    actor: 'system' | 'user' | 'automated' = 'system'
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check for rotation
    if (this.config.rotateOnSize) {
      await this.maybeRotate();
    }

    const timestamp = new Date().toISOString();

    // Create entry without checksum first
    const partialEntry = {
      timestamp,
      action,
      actor,
      details,
      previous_checksum: this.lastChecksum,
    };

    // Compute checksum of the entry content
    const checksum = this.computeChecksum(partialEntry);

    const entry: AuditEntry = {
      ...partialEntry,
      checksum,
    };

    // Append to log file
    await appendFile(this.config.logPath, JSON.stringify(entry) + '\n', 'utf-8');

    // Update last checksum
    this.lastChecksum = checksum;
  }

  /**
   * Compute SHA-256 checksum of entry
   */
  private computeChecksum(entry: Omit<AuditEntry, 'checksum'>): string {
    const content = JSON.stringify(entry, Object.keys(entry).sort());
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Verify the integrity of the log file
   */
  async verify(): Promise<{
    valid: boolean;
    entries: number;
    errors: VerificationError[];
  }> {
    const errors: VerificationError[] = [];

    if (!existsSync(this.config.logPath)) {
      return { valid: true, entries: 0, errors: [] };
    }

    const content = await readFile(this.config.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    let previousChecksum: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as AuditEntry;

        // Verify previous checksum chain
        if (entry.previous_checksum !== previousChecksum) {
          errors.push({
            line: i + 1,
            type: 'chain_broken',
            message: `Chain broken: expected ${previousChecksum}, got ${entry.previous_checksum}`,
          });
        }

        // Verify entry checksum
        const { checksum, ...rest } = entry;
        const computed = this.computeChecksum(rest);

        if (computed !== checksum) {
          errors.push({
            line: i + 1,
            type: 'checksum_mismatch',
            message: `Checksum mismatch: expected ${checksum}, computed ${computed}`,
          });
        }

        previousChecksum = checksum;
      } catch (e) {
        errors.push({
          line: i + 1,
          type: 'parse_error',
          message: `Failed to parse entry: ${e}`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      entries: lines.length,
      errors,
    };
  }

  /**
   * Rotate log file if size exceeds limit
   */
  private async maybeRotate(): Promise<void> {
    if (!existsSync(this.config.logPath)) return;

    try {
      const stats = await stat(this.config.logPath);

      if (stats.size >= this.config.maxSizeBytes) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = this.config.logPath.replace(
          '.log',
          `-${timestamp}.log`
        );

        // Rename current log to archive
        const { rename } = await import('fs/promises');
        await rename(this.config.logPath, archivePath);

        // Reset checksum chain for new log
        this.lastChecksum = null;

        console.log(`[audit-logger] Rotated log to ${archivePath}`);
      }
    } catch (e) {
      console.warn('[audit-logger] Error checking log size:', e);
    }
  }

  /**
   * Get recent entries
   */
  async getRecentEntries(count = 100): Promise<AuditEntry[]> {
    if (!existsSync(this.config.logPath)) {
      return [];
    }

    const content = await readFile(this.config.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const recent = lines.slice(-count);
    return recent.map((line) => JSON.parse(line) as AuditEntry);
  }

  /**
   * Search entries by action
   */
  async searchByAction(action: string): Promise<AuditEntry[]> {
    if (!existsSync(this.config.logPath)) {
      return [];
    }

    const content = await readFile(this.config.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const results: AuditEntry[] = [];
    for (const line of lines) {
      const entry = JSON.parse(line) as AuditEntry;
      if (entry.action === action) {
        results.push(entry);
      }
    }

    return results;
  }

  /**
   * Get the log file path
   */
  getLogPath(): string {
    return this.config.logPath;
  }
}

export interface VerificationError {
  line: number;
  type: 'chain_broken' | 'checksum_mismatch' | 'parse_error';
  message: string;
}
