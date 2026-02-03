/**
 * TimeoutEnforcer - Subagent Timeout Enforcement (FR-6)
 *
 * Prevents trusted models from being killed mid-task by enforcing
 * minimum timeout thresholds.
 *
 * @module deploy/loa-identity/scheduler/timeout-enforcer
 */

import { appendFile } from 'fs/promises';

// =============================================================================
// Interfaces
// =============================================================================

export interface TimeoutConfig {
  /** Minimum timeout in minutes for trusted models (default: 30) */
  minMinutes: number;
  /** Warning threshold - log warning if below this (default: 10) */
  warnBelowMinutes: number;
  /** Hard floor - block spawn if below this (default: 3) */
  hardFloorMinutes: number;
  /** List of trusted model patterns */
  trustedModels: TrustedModel[];
}

export interface TrustedModel {
  name: string;
  patterns: string[];
}

export interface TimeoutValidationResult {
  valid: boolean;
  adjustedMinutes: number;
  warnings: string[];
  blocked: boolean;
  blockReason?: string;
}

export interface TimeoutAuditEntry {
  timestamp: string;
  action: 'validated' | 'blocked' | 'adjusted';
  modelId: string;
  requestedMinutes: number;
  adjustedMinutes?: number;
  isTrusted: boolean;
  warnings: string[];
  reason?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_TRUSTED_MODELS: TrustedModel[] = [
  { name: 'opus', patterns: ['claude-opus', 'opus-4', 'claude-opus-4'] },
  { name: 'codex', patterns: ['codex-max', 'gpt-4-turbo', 'gpt-5'] },
  { name: 'gemini', patterns: ['gemini-2', 'gemini-pro'] },
];

const DEFAULT_CONFIG: TimeoutConfig = {
  minMinutes: 30,
  warnBelowMinutes: 10,
  hardFloorMinutes: 3,
  trustedModels: DEFAULT_TRUSTED_MODELS,
};

// =============================================================================
// TimeoutEnforcer Class
// =============================================================================

export class TimeoutEnforcer {
  private config: TimeoutConfig;
  private auditLogPath: string;

  constructor(config?: Partial<TimeoutConfig>, auditLogPath?: string) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      trustedModels: config?.trustedModels ?? DEFAULT_TRUSTED_MODELS,
    };
    this.auditLogPath = auditLogPath ?? '/workspace/.loa/timeout-audit.log';
  }

  /**
   * Validate timeout before subagent spawn.
   *
   * @param modelId - The model identifier (e.g., 'claude-opus-4-5-20251101')
   * @param requestedMinutes - Requested timeout in minutes
   * @returns Validation result with adjusted timeout and any warnings
   * @throws Error if timeout is below hard floor
   */
  async validateTimeout(
    modelId: string,
    requestedMinutes: number
  ): Promise<TimeoutValidationResult> {
    const warnings: string[] = [];
    let adjustedMinutes = requestedMinutes;
    let blocked = false;
    let blockReason: string | undefined;

    // Check hard floor - block spawn
    if (requestedMinutes < this.config.hardFloorMinutes) {
      blocked = true;
      blockReason =
        `Timeout ${requestedMinutes}min blocked: below hard floor ` +
        `${this.config.hardFloorMinutes}min. Increase timeout to proceed.`;

      await this.logAudit({
        timestamp: new Date().toISOString(),
        action: 'blocked',
        modelId,
        requestedMinutes,
        isTrusted: this.isTrustedModel(modelId),
        warnings: [],
        reason: blockReason,
      });

      return {
        valid: false,
        adjustedMinutes: requestedMinutes,
        warnings: [],
        blocked: true,
        blockReason,
      };
    }

    // Check if trusted model
    const isTrusted = this.isTrustedModel(modelId);

    // Trusted model enforcement - adjust to minimum
    if (isTrusted && requestedMinutes < this.config.minMinutes) {
      warnings.push(
        `Trusted model ${modelId}: timeout ${requestedMinutes}min ` +
          `below recommended ${this.config.minMinutes}min - adjusted`
      );
      adjustedMinutes = this.config.minMinutes;
    }

    // Warning threshold - log but don't adjust
    if (requestedMinutes < this.config.warnBelowMinutes) {
      warnings.push(
        `Timeout ${requestedMinutes}min below warning threshold ` +
          `${this.config.warnBelowMinutes}min - consider increasing`
      );
    }

    // Determine action for audit
    const action =
      adjustedMinutes !== requestedMinutes ? 'adjusted' : 'validated';

    await this.logAudit({
      timestamp: new Date().toISOString(),
      action,
      modelId,
      requestedMinutes,
      adjustedMinutes: adjustedMinutes !== requestedMinutes ? adjustedMinutes : undefined,
      isTrusted,
      warnings,
    });

    return {
      valid: true,
      adjustedMinutes,
      warnings,
      blocked: false,
    };
  }

  /**
   * Check if a model ID matches any trusted model pattern.
   * Security: HIGH-001 remediation - uses substring matching instead of regex
   * to prevent ReDoS attacks from malicious patterns.
   */
  isTrustedModel(modelId: string): boolean {
    const lowerId = modelId.toLowerCase();
    return this.config.trustedModels.some((model) =>
      model.patterns.some((pattern) =>
        lowerId.includes(pattern.toLowerCase())
      )
    );
  }

  /**
   * Get the name of the trusted model if matched, or null.
   * Security: HIGH-001 remediation - uses substring matching instead of regex.
   */
  getTrustedModelName(modelId: string): string | null {
    const lowerId = modelId.toLowerCase();
    for (const model of this.config.trustedModels) {
      if (model.patterns.some((p) => lowerId.includes(p.toLowerCase()))) {
        return model.name;
      }
    }
    return null;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<TimeoutConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(updates: Partial<TimeoutConfig>): void {
    this.config = {
      ...this.config,
      ...updates,
    };
  }

  /**
   * Add a trusted model pattern.
   */
  addTrustedModel(name: string, patterns: string[]): void {
    const existing = this.config.trustedModels.find((m) => m.name === name);
    if (existing) {
      existing.patterns = [...new Set([...existing.patterns, ...patterns])];
    } else {
      this.config.trustedModels.push({ name, patterns });
    }
  }

  /**
   * Log audit entry to file.
   */
  private async logAudit(entry: TimeoutAuditEntry): Promise<void> {
    try {
      const line = JSON.stringify(entry) + '\n';
      await appendFile(this.auditLogPath, line);
    } catch (error) {
      // Log to console if file write fails
      console.error('[timeout-enforcer] Failed to write audit log:', error);
      console.log('[timeout-enforcer] Audit entry:', entry);
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a TimeoutEnforcer from environment variables or config file.
 */
export function createTimeoutEnforcer(
  configOverrides?: Partial<TimeoutConfig>
): TimeoutEnforcer {
  const envConfig: Partial<TimeoutConfig> = {};

  // Read from environment variables
  const minMinutes = process.env.LOA_TIMEOUT_MIN_MINUTES;
  const warnBelow = process.env.LOA_TIMEOUT_WARN_BELOW;
  const hardFloor = process.env.LOA_TIMEOUT_HARD_FLOOR;

  if (minMinutes) envConfig.minMinutes = parseInt(minMinutes, 10);
  if (warnBelow) envConfig.warnBelowMinutes = parseInt(warnBelow, 10);
  if (hardFloor) envConfig.hardFloorMinutes = parseInt(hardFloor, 10);

  return new TimeoutEnforcer({
    ...envConfig,
    ...configOverrides,
  });
}

// =============================================================================
// Default Export
// =============================================================================

export default TimeoutEnforcer;
