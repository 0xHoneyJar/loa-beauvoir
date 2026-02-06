/**
 * Beads ContextCompiler Adapter
 *
 * Bridges the upstream `ContextCompiler` (from `.claude/lib/beads/context-compiler.ts`)
 * to the work queue's `IContextCompiler` interface.
 *
 * The upstream returns `{ included: ScoredBead[], excluded, stats }`.
 * The work queue expects `{ beads: CompiledBead[], tokenEstimate, tokenBudget, trace }`.
 * This adapter transforms between these shapes.
 *
 * No modifications needed to either upstream ContextCompiler or work queue.
 *
 * @module beads/context-compiler-adapter
 * @version 1.0.0
 */

import type {
  IContextCompiler,
  ContextCompilationResult,
  CompiledBead,
} from "./beads-work-queue.js";
import {
  ContextCompiler,
  type ContextCompilerConfig,
  type ContextCompilationResult as UpstreamResult,
  type IBrExecutor,
} from "../../../.claude/lib/beads";

// =============================================================================
// Adapter
// =============================================================================

/**
 * Adapter bridging upstream ContextCompiler to work queue's IContextCompiler.
 *
 * Transforms upstream's ScoredBead[] with included/excluded arrays into
 * the work queue's CompiledBead[] with beads/trace arrays.
 *
 * @example
 * ```typescript
 * const adapter = createBeadsContextCompilerAdapter(executor, { tokenBudget: 4000 });
 * const workQueue = createBeadsWorkQueue(config, runState, {
 *   executor,
 *   contextCompiler: adapter,
 * });
 * ```
 */
export class BeadsContextCompilerAdapter implements IContextCompiler {
  private readonly upstream: ContextCompiler;

  constructor(upstream: ContextCompiler) {
    this.upstream = upstream;
  }

  /**
   * Compile context for a task.
   *
   * Note: `options.tokenBudget` is advisory/display-only. The actual compilation
   * uses the upstream ContextCompiler's configured budget. The returned
   * `tokenBudget` reflects the caller's requested budget (if provided) or
   * the upstream's actual budget, for informational purposes.
   */
  async compile(
    taskId: string,
    options?: { tokenBudget?: number },
  ): Promise<ContextCompilationResult | null> {
    let upstreamResult: UpstreamResult;
    try {
      upstreamResult = await this.upstream.compile(taskId);
    } catch {
      return null;
    }

    // Transform upstream ScoredBead[] → work queue CompiledBead[]
    const beads: CompiledBead[] = upstreamResult.included.map((scored) => ({
      bead: scored.bead,
      score: scored.score,
      reason: scored.reason,
    }));

    // Compute total excluded count
    const totalExcluded = Object.values(upstreamResult.stats.excludedByReason).reduce(
      (a, b) => a + b,
      0,
    );

    // Build trace from stats
    const trace: string[] = [
      `compiled: ${upstreamResult.stats.included} included, ${totalExcluded} excluded`,
      `tokens: ${upstreamResult.stats.estimatedTokens}/${upstreamResult.stats.tokenBudget} (${Math.round(upstreamResult.stats.utilization * 100)}% utilization)`,
    ];
    for (const [reason, count] of Object.entries(upstreamResult.stats.excludedByReason)) {
      trace.push(`excluded: ${count} beads (${reason})`);
    }

    return {
      taskId,
      beads,
      tokenEstimate: upstreamResult.stats.estimatedTokens,
      tokenBudget: options?.tokenBudget ?? upstreamResult.stats.tokenBudget,
      trace,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a BeadsContextCompilerAdapter instance.
 *
 * Convenience factory that instantiates the upstream ContextCompiler
 * and wraps it in the adapter.
 *
 * @param executor - BR command executor
 * @param config - Optional upstream ContextCompiler config
 */
export function createBeadsContextCompilerAdapter(
  executor: IBrExecutor,
  config?: ContextCompilerConfig,
): BeadsContextCompilerAdapter {
  const upstream = new ContextCompiler(executor, config);
  return new BeadsContextCompilerAdapter(upstream);
}
