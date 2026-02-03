/**
 * Session Memory Manager - Phase 1 memory capture with quality gates
 *
 * Captures significant interactions during a session, applies PII redaction,
 * runs quality gates, and persists to WAL.
 *
 * @module deploy/loa-identity/memory/session-manager
 */

import { SegmentedWALManager } from '../wal/wal-manager.js';
import { PIIRedactor } from '../security/pii-redactor.js';
import { AuditLogger } from '../security/audit-logger.js';
import { createHash } from 'crypto';

export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: 'interaction' | 'decision' | 'learning' | 'error' | 'milestone';
  content: string;
  metadata: {
    source: string;
    confidence: number;
    tags: string[];
    context?: Record<string, unknown>;
  };
  qualityScore: number;
  redacted: boolean;
}

export interface QualityGate {
  name: string;
  check: (entry: MemoryEntry) => { pass: boolean; reason?: string };
}

export interface SessionManagerConfig {
  walManager: SegmentedWALManager;
  redactor: PIIRedactor;
  auditLogger?: AuditLogger;
  qualityThreshold?: number;
  maxEntriesPerSession?: number;
}

/**
 * SessionMemoryManager handles Phase 1 memory capture.
 *
 * Quality Gates:
 * 1. Temporal - Recent entries weighted higher
 * 2. Speculation - Filters uncertain content
 * 3. Instruction - Detects user preferences
 * 4. Confidence - Minimum confidence threshold
 */
export class SessionMemoryManager {
  private config: Required<Omit<SessionManagerConfig, 'auditLogger'>> & {
    auditLogger?: AuditLogger;
  };
  private entries: MemoryEntry[] = [];
  private qualityGates: QualityGate[] = [];
  private sessionId: string;
  private sessionStart: Date;

  constructor(config: SessionManagerConfig) {
    this.config = {
      walManager: config.walManager,
      redactor: config.redactor,
      auditLogger: config.auditLogger,
      qualityThreshold: config.qualityThreshold ?? 0.6,
      maxEntriesPerSession: config.maxEntriesPerSession ?? 1000,
    };

    this.sessionId = this.generateSessionId();
    this.sessionStart = new Date();
    this.initializeQualityGates();
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `session-${timestamp}-${random}`;
  }

  /**
   * Initialize default quality gates
   */
  private initializeQualityGates(): void {
    // Temporal gate - weight based on recency
    this.qualityGates.push({
      name: 'temporal',
      check: (entry) => {
        const age = Date.now() - new Date(entry.timestamp).getTime();
        const hourInMs = 60 * 60 * 1000;

        // Entries older than 24 hours get lower scores
        if (age > 24 * hourInMs) {
          return { pass: true, reason: 'aged_entry' };
        }
        return { pass: true };
      },
    });

    // Speculation gate - filter uncertain content
    this.qualityGates.push({
      name: 'speculation',
      check: (entry) => {
        const speculativePatterns = [
          /\b(might|maybe|perhaps|possibly|could be|not sure)\b/i,
          /\b(I think|I believe|I assume|I guess)\b/i,
          /\?{2,}/, // Multiple question marks
        ];

        for (const pattern of speculativePatterns) {
          if (pattern.test(entry.content)) {
            return {
              pass: entry.metadata.confidence >= 0.7,
              reason: 'speculative_content',
            };
          }
        }
        return { pass: true };
      },
    });

    // Instruction gate - detect user preferences
    this.qualityGates.push({
      name: 'instruction',
      check: (entry) => {
        const instructionPatterns = [
          /\b(always|never|prefer|don't|do not|should)\b/i,
          /\b(remember that|note that|keep in mind)\b/i,
          /\b(my preference|I want|I need)\b/i,
        ];

        for (const pattern of instructionPatterns) {
          if (pattern.test(entry.content)) {
            // Boost quality score for instructions
            entry.qualityScore = Math.min(1.0, entry.qualityScore + 0.2);
            entry.metadata.tags.push('user_instruction');
            return { pass: true, reason: 'user_instruction' };
          }
        }
        return { pass: true };
      },
    });

    // Confidence gate - minimum confidence threshold
    this.qualityGates.push({
      name: 'confidence',
      check: (entry) => {
        if (entry.metadata.confidence < 0.5) {
          return { pass: false, reason: 'low_confidence' };
        }
        return { pass: true };
      },
    });

    // Content length gate - filter very short entries
    this.qualityGates.push({
      name: 'content_length',
      check: (entry) => {
        if (entry.content.length < 10) {
          return { pass: false, reason: 'too_short' };
        }
        return { pass: true };
      },
    });

    // Duplicate detection gate
    this.qualityGates.push({
      name: 'duplicate',
      check: (entry) => {
        const contentHash = this.hashContent(entry.content);
        const isDuplicate = this.entries.some(
          (e) => this.hashContent(e.content) === contentHash
        );
        if (isDuplicate) {
          return { pass: false, reason: 'duplicate_content' };
        }
        return { pass: true };
      },
    });
  }

  /**
   * Capture a new memory entry
   */
  async capture(
    content: string,
    type: MemoryEntry['type'],
    metadata: Partial<MemoryEntry['metadata']> = {}
  ): Promise<MemoryEntry | null> {
    // Check session limit
    if (this.entries.length >= this.config.maxEntriesPerSession) {
      console.warn('[session-memory] Max entries reached, skipping capture');
      return null;
    }

    // Apply PII redaction
    const redactionResult = this.config.redactor.process(content);

    if (redactionResult.blocked) {
      await this.config.auditLogger?.log(
        'memory_blocked',
        {
          sessionId: this.sessionId,
          reason: redactionResult.reason,
          type,
        },
        'system'
      );
      return null;
    }

    const redactedContent = redactionResult.content;
    const wasRedacted = redactionResult.redactions.length > 0;

    // Create entry
    const entry: MemoryEntry = {
      id: this.generateEntryId(),
      timestamp: new Date().toISOString(),
      type,
      content: redactedContent,
      metadata: {
        source: metadata.source ?? 'session',
        confidence: metadata.confidence ?? 0.8,
        tags: metadata.tags ?? [],
        context: metadata.context,
      },
      qualityScore: 0.7, // Default score
      redacted: wasRedacted,
    };

    // Apply quality gates
    const gateResults = this.applyQualityGates(entry);

    if (!gateResults.passed) {
      await this.config.auditLogger?.log(
        'memory_filtered',
        {
          sessionId: this.sessionId,
          entryId: entry.id,
          failedGates: gateResults.failedGates,
        },
        'system'
      );
      return null;
    }

    // Check quality threshold
    if (entry.qualityScore < this.config.qualityThreshold) {
      await this.config.auditLogger?.log(
        'memory_low_quality',
        {
          sessionId: this.sessionId,
          entryId: entry.id,
          score: entry.qualityScore,
          threshold: this.config.qualityThreshold,
        },
        'system'
      );
      return null;
    }

    // Store in memory
    this.entries.push(entry);

    // Persist to WAL
    await this.persistEntry(entry);

    // Log capture
    await this.config.auditLogger?.log(
      'memory_captured',
      {
        sessionId: this.sessionId,
        entryId: entry.id,
        type,
        qualityScore: entry.qualityScore,
        redacted: wasRedacted,
      },
      'system'
    );

    return entry;
  }

  /**
   * Apply all quality gates to an entry
   */
  private applyQualityGates(entry: MemoryEntry): {
    passed: boolean;
    failedGates: string[];
  } {
    const failedGates: string[] = [];

    for (const gate of this.qualityGates) {
      const result = gate.check(entry);
      if (!result.pass) {
        failedGates.push(`${gate.name}: ${result.reason}`);
      }
    }

    return {
      passed: failedGates.length === 0,
      failedGates,
    };
  }

  /**
   * Persist entry to WAL
   */
  private async persistEntry(entry: MemoryEntry): Promise<void> {
    const path = `memory/session/${this.sessionId}/${entry.id}.json`;
    const data = Buffer.from(JSON.stringify(entry, null, 2));

    await this.config.walManager.append('write', path, data);
  }

  /**
   * Generate unique entry ID
   */
  private generateEntryId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 6);
    return `mem-${timestamp}-${random}`;
  }

  /**
   * Hash content for duplicate detection
   */
  private hashContent(content: string): string {
    return createHash('sha256')
      .update(content.toLowerCase().trim())
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Add a custom quality gate
   */
  addQualityGate(gate: QualityGate): void {
    this.qualityGates.push(gate);
  }

  /**
   * Get all entries for this session
   */
  getEntries(): MemoryEntry[] {
    return [...this.entries];
  }

  /**
   * Get entries by type
   */
  getEntriesByType(type: MemoryEntry['type']): MemoryEntry[] {
    return this.entries.filter((e) => e.type === type);
  }

  /**
   * Get entries by tag
   */
  getEntriesByTag(tag: string): MemoryEntry[] {
    return this.entries.filter((e) => e.metadata.tags.includes(tag));
  }

  /**
   * Get high-quality entries (above threshold)
   */
  getHighQualityEntries(threshold?: number): MemoryEntry[] {
    const t = threshold ?? this.config.qualityThreshold;
    return this.entries.filter((e) => e.qualityScore >= t);
  }

  /**
   * Get session statistics
   */
  getStats(): {
    sessionId: string;
    started: string;
    entryCount: number;
    byType: Record<string, number>;
    averageQuality: number;
    redactedCount: number;
  } {
    const byType: Record<string, number> = {};
    let totalQuality = 0;
    let redactedCount = 0;

    for (const entry of this.entries) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      totalQuality += entry.qualityScore;
      if (entry.redacted) redactedCount++;
    }

    return {
      sessionId: this.sessionId,
      started: this.sessionStart.toISOString(),
      entryCount: this.entries.length,
      byType,
      averageQuality: this.entries.length > 0 ? totalQuality / this.entries.length : 0,
      redactedCount,
    };
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * End session and prepare for consolidation
   */
  async endSession(): Promise<{
    entries: MemoryEntry[];
    stats: ReturnType<SessionMemoryManager['getStats']>;
  }> {
    const stats = this.getStats();
    const entries = this.getEntries();

    await this.config.auditLogger?.log(
      'session_ended',
      {
        sessionId: this.sessionId,
        duration: Date.now() - this.sessionStart.getTime(),
        entryCount: entries.length,
        averageQuality: stats.averageQuality,
      },
      'system'
    );

    return { entries, stats };
  }
}

/**
 * Create a SessionMemoryManager with dependencies
 */
export function createSessionMemoryManager(
  walManager: SegmentedWALManager,
  redactor: PIIRedactor,
  auditLogger?: AuditLogger
): SessionMemoryManager {
  return new SessionMemoryManager({
    walManager,
    redactor,
    auditLogger,
    qualityThreshold: 0.6,
    maxEntriesPerSession: 1000,
  });
}
