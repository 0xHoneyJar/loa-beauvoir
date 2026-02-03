/**
 * Consolidation Engine - Phase 2 memory consolidation
 *
 * Implements semantic deduplication with cosine similarity >= 0.85,
 * Jaccard lexical fallback when embeddings unavailable, and
 * monthly file management.
 *
 * @module deploy/loa-identity/memory/consolidation-engine
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { EmbeddingClient } from './embedding-client.js';
import { applyQualityGates, GateMetadata } from './quality-gates.js';
import { AuditLogger } from '../security/audit-logger.js';
import { createHash } from 'crypto';

export interface ConsolidatedMemory {
  id: string;
  content: string;
  originalIds: string[];
  mergedAt: string;
  method: 'semantic' | 'lexical';
  tags: string[];
  qualityScore: number;
}

export interface SessionMemory {
  id: string;
  timestamp: string;
  content: string;
  metadata: {
    source: string;
    confidence: number;
    tags: string[];
  };
  qualityScore: number;
}

export interface ConsolidationResult {
  promoted: number;
  merged: number;
  rejected: number;
  method: 'semantic' | 'lexical';
  fallbackUsed: boolean;
}

export interface ConsolidationEngineConfig {
  memoryDir: string;
  embeddingClient: EmbeddingClient;
  auditLogger?: AuditLogger;
  semanticThreshold?: number;
  lexicalThreshold?: number;
  qualityThreshold?: number;
}

/**
 * ConsolidationEngine handles Phase 2 memory consolidation.
 *
 * Process:
 * 1. Load session memories
 * 2. Apply quality gates
 * 3. Deduplicate (semantic or lexical fallback)
 * 4. Write to monthly files
 */
export class ConsolidationEngine {
  private config: Required<Omit<ConsolidationEngineConfig, 'auditLogger'>> & {
    auditLogger?: AuditLogger;
  };
  private embeddingCache: Map<string, number[]> = new Map();

  constructor(config: ConsolidationEngineConfig) {
    this.config = {
      memoryDir: config.memoryDir,
      embeddingClient: config.embeddingClient,
      auditLogger: config.auditLogger,
      semanticThreshold: config.semanticThreshold ?? 0.85,
      lexicalThreshold: config.lexicalThreshold ?? 0.80,
      qualityThreshold: config.qualityThreshold ?? 0.6,
    };
  }

  /**
   * Run consolidation on session memories
   */
  async consolidate(
    sessionMemories: SessionMemory[]
  ): Promise<ConsolidationResult> {
    if (sessionMemories.length === 0) {
      return {
        promoted: 0,
        merged: 0,
        rejected: 0,
        method: 'semantic',
        fallbackUsed: false,
      };
    }

    // Load existing durable memories
    const durableMemories = await this.loadDurableMemories();

    // Check embedding service availability
    const embeddingAvailable = await this.config.embeddingClient.isAvailable();

    let result: ConsolidationResult;

    if (embeddingAvailable) {
      result = await this.semanticConsolidate(sessionMemories, durableMemories);
    } else {
      console.warn('[consolidation] Embedding service unavailable, using lexical fallback');
      result = await this.lexicalConsolidate(sessionMemories, durableMemories);
      result.fallbackUsed = true;
    }

    // Log consolidation result
    await this.config.auditLogger?.log(
      'consolidation_complete',
      {
        sessionCount: sessionMemories.length,
        durableCount: durableMemories.length,
        ...result,
      },
      'system'
    );

    return result;
  }

  /**
   * Semantic consolidation using embeddings
   */
  private async semanticConsolidate(
    sessionMemories: SessionMemory[],
    durableMemories: ConsolidatedMemory[]
  ): Promise<ConsolidationResult> {
    let promoted = 0;
    let merged = 0;
    let rejected = 0;

    // Generate embeddings for all texts
    const allTexts = [
      ...durableMemories.map((m) => m.content),
      ...sessionMemories.map((m) => m.content),
    ];

    const embeddings = await this.config.embeddingClient.embed(allTexts);

    const durableEmbeddings = embeddings.slice(0, durableMemories.length);
    const sessionEmbeddings = embeddings.slice(durableMemories.length);

    const newMemories: ConsolidatedMemory[] = [];

    for (let i = 0; i < sessionMemories.length; i++) {
      const session = sessionMemories[i];
      const sessionEmb = sessionEmbeddings[i];

      // Check quality
      const gateResult = applyQualityGates(session.content, {
        timestamp: session.timestamp,
        source: session.metadata.source,
        confidence: session.metadata.confidence,
        tags: session.metadata.tags,
      });

      if (!gateResult.pass || gateResult.score < this.config.qualityThreshold) {
        rejected++;
        continue;
      }

      // Find similar durable memory
      let foundSimilar = false;

      for (let j = 0; j < durableMemories.length; j++) {
        const similarity = this.config.embeddingClient.cosineSimilarity(
          sessionEmb,
          durableEmbeddings[j]
        );

        if (similarity >= this.config.semanticThreshold) {
          // Merge with existing memory (recency-wins: update content)
          durableMemories[j].originalIds.push(session.id);
          durableMemories[j].mergedAt = new Date().toISOString();
          durableMemories[j].tags = [
            ...new Set([...durableMemories[j].tags, ...gateResult.tags]),
          ];

          merged++;
          foundSimilar = true;

          await this.config.auditLogger?.log(
            'memory_merged',
            {
              sessionId: session.id,
              durableId: durableMemories[j].id,
              similarity,
              method: 'semantic',
            },
            'system'
          );

          break;
        }
      }

      // Also check against new memories being added
      if (!foundSimilar) {
        for (const newMem of newMemories) {
          const newEmb = this.embeddingCache.get(newMem.id);
          if (newEmb) {
            const similarity = this.config.embeddingClient.cosineSimilarity(
              sessionEmb,
              newEmb
            );

            if (similarity >= this.config.semanticThreshold) {
              newMem.originalIds.push(session.id);
              merged++;
              foundSimilar = true;
              break;
            }
          }
        }
      }

      if (!foundSimilar) {
        // Promote to durable
        const newMemory: ConsolidatedMemory = {
          id: this.generateId(),
          content: session.content,
          originalIds: [session.id],
          mergedAt: new Date().toISOString(),
          method: 'semantic',
          tags: gateResult.tags,
          qualityScore: gateResult.score,
        };

        newMemories.push(newMemory);
        this.embeddingCache.set(newMemory.id, sessionEmb);
        promoted++;
      }
    }

    // Write updated memories to monthly files
    await this.writeDurableMemories([...durableMemories, ...newMemories]);

    return { promoted, merged, rejected, method: 'semantic', fallbackUsed: false };
  }

  /**
   * Lexical consolidation using Jaccard similarity
   */
  private async lexicalConsolidate(
    sessionMemories: SessionMemory[],
    durableMemories: ConsolidatedMemory[]
  ): Promise<ConsolidationResult> {
    let promoted = 0;
    let merged = 0;
    let rejected = 0;

    const newMemories: ConsolidatedMemory[] = [];

    for (const session of sessionMemories) {
      // Check quality
      const gateResult = applyQualityGates(session.content, {
        timestamp: session.timestamp,
        source: session.metadata.source,
        confidence: session.metadata.confidence,
        tags: session.metadata.tags,
      });

      if (!gateResult.pass || gateResult.score < this.config.qualityThreshold) {
        rejected++;
        continue;
      }

      // Find similar using Jaccard
      let foundSimilar = false;
      const sessionTokens = this.tokenize(session.content);

      for (const durable of durableMemories) {
        const durableTokens = this.tokenize(durable.content);
        const similarity = this.jaccardSimilarity(sessionTokens, durableTokens);

        if (similarity >= this.config.lexicalThreshold) {
          durable.originalIds.push(session.id);
          durable.mergedAt = new Date().toISOString();
          durable.method = 'lexical';
          durable.tags = [...new Set([...durable.tags, ...gateResult.tags])];

          merged++;
          foundSimilar = true;

          await this.config.auditLogger?.log(
            'memory_merged',
            {
              sessionId: session.id,
              durableId: durable.id,
              similarity,
              method: 'lexical',
            },
            'system'
          );

          break;
        }
      }

      // Check against new memories
      if (!foundSimilar) {
        for (const newMem of newMemories) {
          const newTokens = this.tokenize(newMem.content);
          const similarity = this.jaccardSimilarity(sessionTokens, newTokens);

          if (similarity >= this.config.lexicalThreshold) {
            newMem.originalIds.push(session.id);
            merged++;
            foundSimilar = true;
            break;
          }
        }
      }

      if (!foundSimilar) {
        const newMemory: ConsolidatedMemory = {
          id: this.generateId(),
          content: session.content,
          originalIds: [session.id],
          mergedAt: new Date().toISOString(),
          method: 'lexical',
          tags: gateResult.tags,
          qualityScore: gateResult.score,
        };

        newMemories.push(newMemory);
        promoted++;
      }
    }

    await this.writeDurableMemories([...durableMemories, ...newMemories]);

    return { promoted, merged, rejected, method: 'lexical', fallbackUsed: true };
  }

  /**
   * Tokenize text for Jaccard similarity
   */
  private tokenize(text: string): Set<string> {
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
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);

    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  /**
   * Load durable memories from monthly files
   */
  private async loadDurableMemories(): Promise<ConsolidatedMemory[]> {
    const memoriesDir = join(this.config.memoryDir, 'durable');

    if (!existsSync(memoriesDir)) {
      return [];
    }

    const files = await readdir(memoriesDir);
    const memories: ConsolidatedMemory[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await readFile(join(memoriesDir, file), 'utf-8');
        const fileMemories = JSON.parse(content) as ConsolidatedMemory[];
        memories.push(...fileMemories);
      } catch (e) {
        console.warn(`[consolidation] Error loading ${file}:`, e);
      }
    }

    return memories;
  }

  /**
   * Write durable memories to monthly files
   */
  private async writeDurableMemories(
    memories: ConsolidatedMemory[]
  ): Promise<void> {
    const memoriesDir = join(this.config.memoryDir, 'durable');

    if (!existsSync(memoriesDir)) {
      await mkdir(memoriesDir, { recursive: true });
    }

    // Group by month
    const byMonth = new Map<string, ConsolidatedMemory[]>();

    for (const memory of memories) {
      const date = new Date(memory.mergedAt);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      if (!byMonth.has(monthKey)) {
        byMonth.set(monthKey, []);
      }
      byMonth.get(monthKey)!.push(memory);
    }

    // Write each month file atomically
    for (const [month, monthMemories] of byMonth) {
      const filePath = join(memoriesDir, `${month}.json`);
      const tempPath = `${filePath}.tmp`;

      await writeFile(
        tempPath,
        JSON.stringify(monthMemories, null, 2),
        'utf-8'
      );

      // Atomic rename
      const { rename } = await import('fs/promises');
      await rename(tempPath, filePath);
    }
  }

  /**
   * Archive memories older than N months
   */
  async archiveOldMemories(monthsToKeep = 6): Promise<number> {
    const memoriesDir = join(this.config.memoryDir, 'durable');
    const archiveDir = join(this.config.memoryDir, 'archive');

    if (!existsSync(memoriesDir)) {
      return 0;
    }

    if (!existsSync(archiveDir)) {
      await mkdir(archiveDir, { recursive: true });
    }

    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsToKeep);
    const cutoffMonth = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}`;

    const files = await readdir(memoriesDir);
    let archived = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const month = file.replace('.json', '');
      if (month < cutoffMonth) {
        const { rename } = await import('fs/promises');
        await rename(
          join(memoriesDir, file),
          join(archiveDir, file)
        );
        archived++;

        await this.config.auditLogger?.log(
          'memory_archived',
          { file, month },
          'system'
        );
      }
    }

    return archived;
  }

  /**
   * Generate unique memory ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `mem-${timestamp}-${random}`;
  }

  /**
   * Get consolidation statistics
   */
  async getStats(): Promise<{
    durableCount: number;
    monthlyFiles: string[];
    archivedFiles: string[];
    embeddingServiceStatus: string;
  }> {
    const memoriesDir = join(this.config.memoryDir, 'durable');
    const archiveDir = join(this.config.memoryDir, 'archive');

    let monthlyFiles: string[] = [];
    let archivedFiles: string[] = [];

    if (existsSync(memoriesDir)) {
      monthlyFiles = (await readdir(memoriesDir)).filter((f) => f.endsWith('.json'));
    }

    if (existsSync(archiveDir)) {
      archivedFiles = (await readdir(archiveDir)).filter((f) => f.endsWith('.json'));
    }

    const durableMemories = await this.loadDurableMemories();

    return {
      durableCount: durableMemories.length,
      monthlyFiles,
      archivedFiles,
      embeddingServiceStatus: this.config.embeddingClient.getStatus().status,
    };
  }
}

/**
 * Create a ConsolidationEngine with dependencies
 */
export function createConsolidationEngine(
  memoryDir: string,
  embeddingClient: EmbeddingClient,
  auditLogger?: AuditLogger
): ConsolidationEngine {
  return new ConsolidationEngine({
    memoryDir,
    embeddingClient,
    auditLogger,
    semanticThreshold: 0.85,
    lexicalThreshold: 0.80,
    qualityThreshold: 0.6,
  });
}
