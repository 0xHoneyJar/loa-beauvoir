/**
 * Consolidation Queue - Queue-based degradation for embedding service unavailability
 *
 * When the embedding service is unavailable, consolidation jobs are queued
 * instead of immediately falling back to lexical. Jobs are processed when
 * the service recovers. Max queue age: 4 hours, then use fallback.
 *
 * @module deploy/loa-identity/memory/consolidation-queue
 */

import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { EmbeddingClient } from './embedding-client.js';
import {
  ConsolidationEngine,
  SessionMemory,
  ConsolidationResult,
} from './consolidation-engine.js';
import { AuditLogger } from '../security/audit-logger.js';

export interface QueuedConsolidation {
  id: string;
  queuedAt: string;
  memories: SessionMemory[];
  retryCount: number;
}

export interface ConsolidationQueueConfig {
  queueDir: string;
  maxQueueAgeMs: number; // Default: 4 hours
  maxRetries: number;
  retryIntervalMs: number;
  embeddingClient: EmbeddingClient;
  consolidationEngine: ConsolidationEngine;
  auditLogger?: AuditLogger;
}

/**
 * ConsolidationQueue handles deferred consolidation when embeddings unavailable.
 */
export class ConsolidationQueue {
  private config: Required<Omit<ConsolidationQueueConfig, 'auditLogger'>> & {
    auditLogger?: AuditLogger;
  };
  private processing = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(config: ConsolidationQueueConfig) {
    this.config = {
      queueDir: config.queueDir,
      maxQueueAgeMs: config.maxQueueAgeMs ?? 4 * 60 * 60 * 1000, // 4 hours
      maxRetries: config.maxRetries ?? 6,
      retryIntervalMs: config.retryIntervalMs ?? 10 * 60 * 1000, // 10 minutes
      embeddingClient: config.embeddingClient,
      consolidationEngine: config.consolidationEngine,
      auditLogger: config.auditLogger,
    };
  }

  /**
   * Initialize queue directory
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.config.queueDir)) {
      await mkdir(this.config.queueDir, { recursive: true });
    }
  }

  /**
   * Queue a consolidation job
   */
  async enqueue(memories: SessionMemory[]): Promise<string> {
    await this.initialize();

    const job: QueuedConsolidation = {
      id: `job-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      queuedAt: new Date().toISOString(),
      memories,
      retryCount: 0,
    };

    const jobPath = join(this.config.queueDir, `${job.id}.json`);
    await writeFile(jobPath, JSON.stringify(job, null, 2), 'utf-8');

    await this.config.auditLogger?.log(
      'consolidation_queued',
      {
        jobId: job.id,
        memoryCount: memories.length,
      },
      'system'
    );

    console.log(`[consolidation-queue] Queued job ${job.id} with ${memories.length} memories`);

    return job.id;
  }

  /**
   * Process all queued jobs
   */
  async processQueue(): Promise<{
    processed: number;
    succeeded: number;
    fallback: number;
    expired: number;
  }> {
    if (this.processing) {
      console.log('[consolidation-queue] Already processing, skipping');
      return { processed: 0, succeeded: 0, fallback: 0, expired: 0 };
    }

    this.processing = true;

    try {
      const jobs = await this.loadQueuedJobs();

      if (jobs.length === 0) {
        return { processed: 0, succeeded: 0, fallback: 0, expired: 0 };
      }

      console.log(`[consolidation-queue] Processing ${jobs.length} queued jobs`);

      let succeeded = 0;
      let fallback = 0;
      let expired = 0;

      for (const job of jobs) {
        const result = await this.processJob(job);

        if (result === 'succeeded') {
          succeeded++;
        } else if (result === 'fallback') {
          fallback++;
        } else if (result === 'expired') {
          expired++;
        }
      }

      return {
        processed: jobs.length,
        succeeded,
        fallback,
        expired,
      };
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single job
   */
  private async processJob(
    job: QueuedConsolidation
  ): Promise<'succeeded' | 'fallback' | 'expired' | 'retry'> {
    const jobPath = join(this.config.queueDir, `${job.id}.json`);
    const age = Date.now() - new Date(job.queuedAt).getTime();

    // Check if expired (exceeded max age)
    if (age >= this.config.maxQueueAgeMs) {
      console.log(`[consolidation-queue] Job ${job.id} expired, using fallback`);

      // Force lexical consolidation
      const result = await this.consolidateWithFallback(job);

      await unlink(jobPath);

      await this.config.auditLogger?.log(
        'consolidation_expired',
        {
          jobId: job.id,
          ageMs: age,
          result,
        },
        'system'
      );

      return 'expired';
    }

    // Check if embedding service is available
    const available = await this.config.embeddingClient.isAvailable();

    if (available) {
      try {
        // Try semantic consolidation
        await this.config.consolidationEngine.consolidate(job.memories);

        await unlink(jobPath);

        await this.config.auditLogger?.log(
          'consolidation_succeeded',
          {
            jobId: job.id,
            method: 'semantic',
          },
          'system'
        );

        console.log(`[consolidation-queue] Job ${job.id} succeeded with semantic`);
        return 'succeeded';
      } catch (e) {
        console.error(`[consolidation-queue] Job ${job.id} failed:`, e);
        return await this.handleFailure(job, jobPath);
      }
    } else {
      // Check if we should use fallback (max retries exceeded)
      if (job.retryCount >= this.config.maxRetries) {
        console.log(`[consolidation-queue] Job ${job.id} max retries, using fallback`);

        const result = await this.consolidateWithFallback(job);

        await unlink(jobPath);

        await this.config.auditLogger?.log(
          'consolidation_fallback',
          {
            jobId: job.id,
            retries: job.retryCount,
            result,
          },
          'system'
        );

        return 'fallback';
      }

      // Increment retry count and save
      job.retryCount++;
      await writeFile(jobPath, JSON.stringify(job, null, 2), 'utf-8');

      console.log(
        `[consolidation-queue] Job ${job.id} retry ${job.retryCount}/${this.config.maxRetries}`
      );

      return 'retry';
    }
  }

  /**
   * Handle job failure
   */
  private async handleFailure(
    job: QueuedConsolidation,
    jobPath: string
  ): Promise<'retry' | 'fallback'> {
    job.retryCount++;

    if (job.retryCount >= this.config.maxRetries) {
      // Use fallback
      await this.consolidateWithFallback(job);
      await unlink(jobPath);
      return 'fallback';
    }

    // Save for retry
    await writeFile(jobPath, JSON.stringify(job, null, 2), 'utf-8');
    return 'retry';
  }

  /**
   * Consolidate using lexical fallback
   */
  private async consolidateWithFallback(
    job: QueuedConsolidation
  ): Promise<ConsolidationResult> {
    // The consolidation engine will automatically use lexical
    // when embedding service is unavailable
    return this.config.consolidationEngine.consolidate(job.memories);
  }

  /**
   * Load all queued jobs
   */
  private async loadQueuedJobs(): Promise<QueuedConsolidation[]> {
    await this.initialize();

    const files = await import('fs/promises').then((m) =>
      m.readdir(this.config.queueDir)
    );

    const jobs: QueuedConsolidation[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await readFile(
          join(this.config.queueDir, file),
          'utf-8'
        );
        const job = JSON.parse(content) as QueuedConsolidation;
        jobs.push(job);
      } catch (e) {
        console.warn(`[consolidation-queue] Error loading ${file}:`, e);
      }
    }

    // Sort by queued time (oldest first)
    return jobs.sort(
      (a, b) =>
        new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime()
    );
  }

  /**
   * Start periodic queue processing
   */
  startProcessing(): void {
    if (this.checkInterval) return;

    this.checkInterval = setInterval(async () => {
      try {
        await this.processQueue();
      } catch (e) {
        console.error('[consolidation-queue] Processing error:', e);
      }
    }, this.config.retryIntervalMs);

    console.log(
      `[consolidation-queue] Started processing (interval: ${this.config.retryIntervalMs / 1000}s)`
    );
  }

  /**
   * Stop periodic queue processing
   */
  stopProcessing(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    queuedJobs: number;
    oldestJobAge: number | null;
    totalMemories: number;
  }> {
    const jobs = await this.loadQueuedJobs();

    let oldestJobAge: number | null = null;
    let totalMemories = 0;

    for (const job of jobs) {
      const age = Date.now() - new Date(job.queuedAt).getTime();
      if (oldestJobAge === null || age > oldestJobAge) {
        oldestJobAge = age;
      }
      totalMemories += job.memories.length;
    }

    return {
      queuedJobs: jobs.length,
      oldestJobAge,
      totalMemories,
    };
  }

  /**
   * Clear all queued jobs (use with caution)
   */
  async clearQueue(): Promise<number> {
    const jobs = await this.loadQueuedJobs();
    let cleared = 0;

    for (const job of jobs) {
      const jobPath = join(this.config.queueDir, `${job.id}.json`);
      try {
        await unlink(jobPath);
        cleared++;
      } catch {
        // Ignore
      }
    }

    await this.config.auditLogger?.log(
      'consolidation_queue_cleared',
      { clearedCount: cleared },
      'user'
    );

    return cleared;
  }
}

/**
 * Create a ConsolidationQueue with default configuration
 */
export function createConsolidationQueue(
  queueDir: string,
  embeddingClient: EmbeddingClient,
  consolidationEngine: ConsolidationEngine,
  auditLogger?: AuditLogger
): ConsolidationQueue {
  return new ConsolidationQueue({
    queueDir,
    maxQueueAgeMs: 4 * 60 * 60 * 1000, // 4 hours
    maxRetries: 6,
    retryIntervalMs: 10 * 60 * 1000, // 10 minutes
    embeddingClient,
    consolidationEngine,
    auditLogger,
  });
}
