/**
 * WAL Compaction — delta-based reduction.
 *
 * Keeps only the latest write per path, reducing segment size
 * while preserving the final state. O(n) single pass.
 */

import type { WALEntry } from "./wal-entry.js";

/**
 * Compact a list of WAL entries by keeping only the latest write per path.
 * Delete operations remove all previous writes for that path.
 *
 * @returns Compacted entries in original order (stable sort by seq)
 */
export function compactEntries(entries: WALEntry[]): WALEntry[] {
  // Track the latest entry per path
  const latestByPath = new Map<string, WALEntry>();

  for (const entry of entries) {
    if (entry.operation === "delete") {
      // Delete removes any prior write for this path
      latestByPath.delete(entry.path);
      // Keep the delete itself so replay knows to remove the path
      latestByPath.set(`__delete__${entry.path}`, entry);
    } else {
      // write/mkdir: keep latest only
      latestByPath.set(entry.path, entry);
    }
  }

  // Return entries sorted by seq (preserves causality)
  return Array.from(latestByPath.values()).sort((a, b) => a.seq - b.seq);
}

/**
 * Calculate compaction ratio.
 * @returns Ratio between 0 (no reduction) and 1 (all entries removed)
 */
export function compactionRatio(original: number, compacted: number): number {
  if (original === 0) return 0;
  return 1 - compacted / original;
}
