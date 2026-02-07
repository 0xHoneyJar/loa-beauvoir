// .claude/lib/workflow/change-detection.ts — Change Detection (TASK-5.6)
// Canonical hash comparison to avoid reprocessing unchanged items.
// Items re-processed only if hash differs or re_review_after_hours elapsed.

// ── Types ────────────────────────────────────────────────────

export interface ChangeDetectionConfig {
  reReviewAfterHours?: number; // default: 24
}

export interface ProcessedItemRecord {
  key: string;
  lastHash: string;
  lastProcessedAt: string; // ISO 8601
  result: string;
}

export interface ChangeCheckResult {
  changed: boolean;
  reason: "new" | "hash_changed" | "timer_expired" | "unchanged";
  previousHash?: string;
  currentHash: string;
}

// ── Change Detector ──────────────────────────────────────────

export class ChangeDetector {
  private reReviewAfterHours: number;
  private now: () => number;

  constructor(config?: ChangeDetectionConfig & { now?: () => number }) {
    this.reReviewAfterHours = config?.reReviewAfterHours ?? 24;
    this.now = config?.now ?? (() => Date.now());
  }

  /** Check if an item needs reprocessing based on hash and time. */
  check(
    key: string,
    currentHash: string,
    processedItems: ProcessedItemRecord[],
  ): ChangeCheckResult {
    const prev = processedItems.find((item) => item.key === key);

    // Never seen before — new item
    if (!prev) {
      return { changed: true, reason: "new", currentHash };
    }

    // Hash differs — content changed
    if (prev.lastHash !== currentHash) {
      return {
        changed: true,
        reason: "hash_changed",
        previousHash: prev.lastHash,
        currentHash,
      };
    }

    // Same hash — check if review timer expired
    const elapsedMs = this.now() - new Date(prev.lastProcessedAt).getTime();
    const thresholdMs = this.reReviewAfterHours * 60 * 60 * 1000;

    if (elapsedMs >= thresholdMs) {
      return {
        changed: true,
        reason: "timer_expired",
        previousHash: prev.lastHash,
        currentHash,
      };
    }

    // Unchanged
    return {
      changed: false,
      reason: "unchanged",
      previousHash: prev.lastHash,
      currentHash,
    };
  }

  /** Batch check: filter items to only those that need processing. */
  filterChanged(
    items: Array<{ key: string; hash: string }>,
    processedItems: ProcessedItemRecord[],
  ): Array<{ key: string; hash: string; reason: string }> {
    const results: Array<{ key: string; hash: string; reason: string }> = [];

    for (const item of items) {
      const result = this.check(item.key, item.hash, processedItems);
      if (result.changed) {
        results.push({ key: item.key, hash: item.hash, reason: result.reason });
      }
    }

    return results;
  }
}
