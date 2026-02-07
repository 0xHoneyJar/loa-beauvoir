// .claude/lib/workflow/context-store.ts — Per-job context store (SDD §5.5)
// Tracks processed items, learnings, and stats with bounded FIFO eviction.

// ── Types ──────────────────────────────────────────────────

export interface ProcessedItem {
  key: string;
  lastProcessedAt: string;
  lastStateHash: string;
  actionsTaken: string[];
  result: "success" | "failure" | "skipped";
}

export interface JobLearning {
  id: string;
  pattern: string;
  source: string;
  confidence: number; // 0.0 to 1.0
  createdAt: string;
}

export interface JobStats {
  totalRuns: number;
  totalItemsProcessed: number;
  totalActionsTaken: number;
  lastRunAt?: string;
  errorRate: number; // 0.0 to 1.0
  consecutiveErrors: number;
}

export interface JobContextData {
  jobId: string;
  processedItems: ProcessedItem[];
  learnings: JobLearning[];
  stats: JobStats;
}

// ── Persistence Interface ──────────────────────────────────

export interface ContextStorePersistence {
  load(jobId: string): Promise<JobContextData | null>;
  save(data: JobContextData): Promise<void>;
}

// ── In-Memory Persistence (testing) ────────────────────────

export class InMemoryContextPersistence implements ContextStorePersistence {
  private store = new Map<string, JobContextData>();

  async load(jobId: string): Promise<JobContextData | null> {
    const data = this.store.get(jobId);
    return data ? structuredClone(data) : null;
  }

  async save(data: JobContextData): Promise<void> {
    this.store.set(data.jobId, structuredClone(data));
  }
}

// ── Bounds Constants ───────────────────────────────────────

const MAX_PROCESSED_ITEMS = 1000;
const MAX_LEARNINGS = 100;

// ── JobContext ─────────────────────────────────────────────

export class JobContext {
  private data: JobContextData;

  constructor(data: JobContextData) {
    this.data = data;
  }

  /**
   * Check if an item has changed since last processing.
   * Returns true if the item is new, hash differs, or re-review timer expired.
   */
  hasChanged(key: string, currentHash: string, reReviewAfterHours?: number): boolean {
    const existing = this.data.processedItems.find((item) => item.key === key);
    if (!existing) return true;
    if (existing.lastStateHash !== currentHash) return true;

    if (reReviewAfterHours !== undefined) {
      const processedAt = new Date(existing.lastProcessedAt).getTime();
      const cutoff = processedAt + reReviewAfterHours * 60 * 60 * 1000;
      if (Date.now() >= cutoff) return true;
    }

    return false;
  }

  /**
   * Record processed items with results, updating existing or adding new.
   */
  recordProcessed(
    items: Array<{
      key: string;
      hash: string;
      actions: string[];
      result: "success" | "failure" | "skipped";
    }>,
  ): void {
    const now = new Date().toISOString();
    for (const item of items) {
      const idx = this.data.processedItems.findIndex((p) => p.key === item.key);
      const record: ProcessedItem = {
        key: item.key,
        lastProcessedAt: now,
        lastStateHash: item.hash,
        actionsTaken: item.actions,
        result: item.result,
      };
      if (idx >= 0) {
        this.data.processedItems[idx] = record;
      } else {
        this.data.processedItems.push(record);
      }
    }
    this.enforceItemBounds();
  }

  /**
   * Add a learning entry with auto-generated ID and timestamp.
   */
  addLearning(learning: Omit<JobLearning, "id" | "createdAt">): void {
    this.data.learnings.push({
      ...learning,
      id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    });
    this.enforceLearningBounds();
  }

  /**
   * Update stats after a run completes.
   */
  recordRun(success: boolean, itemCount: number, actionCount: number): void {
    const stats = this.data.stats;
    stats.totalRuns++;
    stats.totalItemsProcessed += itemCount;
    stats.totalActionsTaken += actionCount;
    stats.lastRunAt = new Date().toISOString();

    if (success) {
      stats.consecutiveErrors = 0;
    } else {
      stats.consecutiveErrors++;
    }

    // Rolling error rate: weighted average (recent runs matter more)
    const errorWeight = success ? 0 : 1;
    const alpha = Math.min(1, 2 / (stats.totalRuns + 1)); // smoothing factor
    stats.errorRate = stats.errorRate * (1 - alpha) + errorWeight * alpha;
  }

  /** Return the underlying data for persistence. */
  getData(): JobContextData {
    return this.data;
  }

  // ── Bounds Enforcement ─────────────────────────────────

  /** FIFO eviction: remove oldest items when over MAX_PROCESSED_ITEMS. */
  private enforceItemBounds(): void {
    if (this.data.processedItems.length > MAX_PROCESSED_ITEMS) {
      // Sort by lastProcessedAt ascending so oldest are first
      this.data.processedItems.sort(
        (a, b) => new Date(a.lastProcessedAt).getTime() - new Date(b.lastProcessedAt).getTime(),
      );
      this.data.processedItems = this.data.processedItems.slice(
        this.data.processedItems.length - MAX_PROCESSED_ITEMS,
      );
    }
  }

  /** Evict lowest-confidence learnings when over MAX_LEARNINGS. */
  private enforceLearningBounds(): void {
    if (this.data.learnings.length > MAX_LEARNINGS) {
      // Sort by confidence descending — keep highest confidence
      this.data.learnings.sort((a, b) => b.confidence - a.confidence);
      this.data.learnings = this.data.learnings.slice(0, MAX_LEARNINGS);
    }
  }
}
