/**
 * ContextTracker - Context Usage Monitoring (FR-10)
 *
 * Tracks token usage and emits warnings at configurable thresholds
 * to help manage context window before compaction occurs.
 *
 * Thresholds:
 * - 60%: "warm" - getting warm
 * - 70%: "wrap_up" - consider wrapping up current task
 * - 80%: "imminent" - compaction imminent, save progress
 *
 * @module deploy/loa-identity/memory/context-tracker
 */

import { appendFile, mkdir } from 'fs/promises';
import * as path from 'path';
import {
  NotificationSink,
  NullNotificationSink,
  Severity,
} from '../scheduler/notification-sink';

// =============================================================================
// Interfaces
// =============================================================================

export interface ContextThresholds {
  /** Percentage at which context is "warm" (default: 60) */
  warmPercent: number;
  /** Percentage at which to suggest wrapping up (default: 70) */
  wrapUpPercent: number;
  /** Percentage at which compaction is imminent (default: 80) */
  imminentPercent: number;
}

export type ContextStatusLevel = 'ok' | 'warm' | 'wrap_up' | 'imminent';

export interface ContextStatus {
  usedTokens: number;
  maxTokens: number;
  usagePercent: number;
  status: ContextStatusLevel;
  message: string | null;
  threshold: number | null;
}

export interface ContextCheckResult {
  status: ContextStatus;
  warningEmitted: boolean;
}

export interface ContextHistoryEntry {
  timestamp: string;
  usedTokens: number;
  usagePercent: number;
  status: ContextStatusLevel;
  sessionId?: string;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_THRESHOLDS: ContextThresholds = {
  warmPercent: 60,
  wrapUpPercent: 70,
  imminentPercent: 80,
};

// Default max tokens for Claude models
const DEFAULT_MAX_TOKENS = 200000;

// =============================================================================
// ContextTracker Class
// =============================================================================

export class ContextTracker {
  private thresholds: ContextThresholds;
  private maxTokens: number;
  private lastWarningPercent = 0;
  private sessionId?: string;
  private historyPath?: string;
  private notificationSink: NotificationSink;

  constructor(
    maxTokens?: number,
    options?: {
      thresholds?: Partial<ContextThresholds>;
      sessionId?: string;
      historyPath?: string;
      notificationSink?: NotificationSink;
    }
  ) {
    this.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
    this.thresholds = {
      warmPercent: options?.thresholds?.warmPercent ?? DEFAULT_THRESHOLDS.warmPercent,
      wrapUpPercent: options?.thresholds?.wrapUpPercent ?? DEFAULT_THRESHOLDS.wrapUpPercent,
      imminentPercent:
        options?.thresholds?.imminentPercent ?? DEFAULT_THRESHOLDS.imminentPercent,
    };
    this.sessionId = options?.sessionId;
    this.historyPath = options?.historyPath;
    this.notificationSink = options?.notificationSink ?? new NullNotificationSink();
  }

  /**
   * Check context usage and emit warnings as needed.
   *
   * @param usedTokens - Number of tokens currently used
   * @returns Context status with optional warning message
   */
  check(usedTokens: number): ContextStatus {
    const usagePercent = (usedTokens / this.maxTokens) * 100;

    let status: ContextStatusLevel = 'ok';
    let message: string | null = null;
    let threshold: number | null = null;

    if (usagePercent >= this.thresholds.imminentPercent) {
      status = 'imminent';
      threshold = this.thresholds.imminentPercent;
      if (this.lastWarningPercent < this.thresholds.imminentPercent) {
        message = `Context ${usagePercent.toFixed(0)}% - compaction imminent, save progress`;
      }
    } else if (usagePercent >= this.thresholds.wrapUpPercent) {
      status = 'wrap_up';
      threshold = this.thresholds.wrapUpPercent;
      if (this.lastWarningPercent < this.thresholds.wrapUpPercent) {
        message = `Context ${usagePercent.toFixed(0)}% - consider wrapping up current task`;
      }
    } else if (usagePercent >= this.thresholds.warmPercent) {
      status = 'warm';
      threshold = this.thresholds.warmPercent;
      if (this.lastWarningPercent < this.thresholds.warmPercent) {
        message = `Context ${usagePercent.toFixed(0)}% - getting warm`;
      }
    }

    // Update last warning level
    if (usagePercent >= this.thresholds.imminentPercent) {
      this.lastWarningPercent = this.thresholds.imminentPercent;
    } else if (usagePercent >= this.thresholds.wrapUpPercent) {
      this.lastWarningPercent = this.thresholds.wrapUpPercent;
    } else if (usagePercent >= this.thresholds.warmPercent) {
      this.lastWarningPercent = this.thresholds.warmPercent;
    }

    return {
      usedTokens,
      maxTokens: this.maxTokens,
      usagePercent,
      status,
      message,
      threshold,
    };
  }

  /**
   * Check context usage and emit notifications.
   *
   * @param usedTokens - Number of tokens currently used
   * @returns Check result with status and whether warning was emitted
   */
  async checkAndNotify(usedTokens: number): Promise<ContextCheckResult> {
    const status = this.check(usedTokens);
    let warningEmitted = false;

    if (status.message) {
      warningEmitted = true;

      // Determine severity based on status
      let severity: Severity = 'info';
      if (status.status === 'imminent') {
        severity = 'critical';
      } else if (status.status === 'wrap_up') {
        severity = 'warning';
      }

      await this.notificationSink.notify(severity, status.message, {
        usedTokens: status.usedTokens,
        maxTokens: status.maxTokens,
        usagePercent: Math.round(status.usagePercent),
        status: status.status,
        sessionId: this.sessionId,
      });

      // Log to history if configured
      if (this.historyPath) {
        await this.logHistory(status);
      }
    }

    return { status, warningEmitted };
  }

  /**
   * Log context check to history file.
   */
  private async logHistory(status: ContextStatus): Promise<void> {
    if (!this.historyPath) return;

    const entry: ContextHistoryEntry = {
      timestamp: new Date().toISOString(),
      usedTokens: status.usedTokens,
      usagePercent: Math.round(status.usagePercent * 10) / 10,
      status: status.status,
      sessionId: this.sessionId,
    };

    try {
      await mkdir(path.dirname(this.historyPath), { recursive: true });
      await appendFile(this.historyPath, JSON.stringify(entry) + '\n');
    } catch (error) {
      console.error('[context-tracker] Failed to write history:', error);
    }
  }

  /**
   * Get remaining tokens.
   */
  getRemainingTokens(usedTokens: number): number {
    return Math.max(0, this.maxTokens - usedTokens);
  }

  /**
   * Get usage percentage.
   */
  getUsagePercent(usedTokens: number): number {
    return (usedTokens / this.maxTokens) * 100;
  }

  /**
   * Check if context is above a given threshold.
   */
  isAboveThreshold(usedTokens: number, threshold: keyof ContextThresholds): boolean {
    const usagePercent = this.getUsagePercent(usedTokens);
    return usagePercent >= this.thresholds[threshold];
  }

  /**
   * Get the next threshold that will be crossed.
   */
  getNextThreshold(usedTokens: number): { name: keyof ContextThresholds; percent: number } | null {
    const usagePercent = this.getUsagePercent(usedTokens);

    if (usagePercent < this.thresholds.warmPercent) {
      return { name: 'warmPercent', percent: this.thresholds.warmPercent };
    }
    if (usagePercent < this.thresholds.wrapUpPercent) {
      return { name: 'wrapUpPercent', percent: this.thresholds.wrapUpPercent };
    }
    if (usagePercent < this.thresholds.imminentPercent) {
      return { name: 'imminentPercent', percent: this.thresholds.imminentPercent };
    }
    return null;
  }

  /**
   * Reset warning state (call on session start).
   */
  reset(): void {
    this.lastWarningPercent = 0;
  }

  /**
   * Start a new session.
   */
  startSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.reset();
  }

  /**
   * Get current thresholds.
   */
  getThresholds(): Readonly<ContextThresholds> {
    return { ...this.thresholds };
  }

  /**
   * Update thresholds at runtime.
   */
  updateThresholds(updates: Partial<ContextThresholds>): void {
    this.thresholds = { ...this.thresholds, ...updates };
  }

  /**
   * Get max tokens.
   */
  getMaxTokens(): number {
    return this.maxTokens;
  }

  /**
   * Set max tokens (e.g., when model changes).
   */
  setMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }

  /**
   * Get the current warning level percent.
   */
  getLastWarningPercent(): number {
    return this.lastWarningPercent;
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a ContextTracker with common model defaults.
 */
export function createContextTracker(
  model?: 'claude-opus' | 'claude-sonnet' | 'claude-haiku' | 'gpt-4',
  options?: {
    thresholds?: Partial<ContextThresholds>;
    sessionId?: string;
    historyPath?: string;
    notificationSink?: NotificationSink;
  }
): ContextTracker {
  const maxTokens: Record<string, number> = {
    'claude-opus': 200000,
    'claude-sonnet': 200000,
    'claude-haiku': 200000,
    'gpt-4': 128000,
  };

  return new ContextTracker(maxTokens[model ?? 'claude-opus'] ?? DEFAULT_MAX_TOKENS, options);
}

/**
 * Create a ContextTracker from environment variables.
 *
 * Environment variables:
 * - LOA_CONTEXT_MAX_TOKENS: Maximum tokens
 * - LOA_CONTEXT_WARM_PERCENT: Warm threshold
 * - LOA_CONTEXT_WRAP_UP_PERCENT: Wrap-up threshold
 * - LOA_CONTEXT_IMMINENT_PERCENT: Imminent threshold
 */
export function createContextTrackerFromEnv(
  notificationSink?: NotificationSink
): ContextTracker {
  const maxTokens = process.env.LOA_CONTEXT_MAX_TOKENS
    ? parseInt(process.env.LOA_CONTEXT_MAX_TOKENS, 10)
    : undefined;

  const thresholds: Partial<ContextThresholds> = {};

  if (process.env.LOA_CONTEXT_WARM_PERCENT) {
    thresholds.warmPercent = parseInt(process.env.LOA_CONTEXT_WARM_PERCENT, 10);
  }
  if (process.env.LOA_CONTEXT_WRAP_UP_PERCENT) {
    thresholds.wrapUpPercent = parseInt(process.env.LOA_CONTEXT_WRAP_UP_PERCENT, 10);
  }
  if (process.env.LOA_CONTEXT_IMMINENT_PERCENT) {
    thresholds.imminentPercent = parseInt(process.env.LOA_CONTEXT_IMMINENT_PERCENT, 10);
  }

  return new ContextTracker(maxTokens, {
    thresholds,
    historyPath: '/workspace/.loa/context-history.log',
    notificationSink,
  });
}

// =============================================================================
// Default Export
// =============================================================================

export default ContextTracker;
