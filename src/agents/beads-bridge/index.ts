/**
 * Beads Bridge bootstrap — feature-gated initialization and tool factory.
 *
 * Pattern: follows subagent-registry.ts (module-level singleton, one-time init).
 * Feature gate: silently returns if `br` CLI is not in PATH.
 */

import { Type } from "@sinclair/typebox";
import { execFileSync } from "node:child_process";
import type { AnyAgentTool } from "../pi-tools.types.js";
import { callGateway } from "../../gateway/call.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { readLatestAssistantReply } from "../tools/agent-step.js";
import { jsonResult, readStringParam, readNumberParam } from "../tools/common.js";
import { DispatchOrchestrator, type DispatchOpts } from "./orchestrator.js";
import { hasLabel, getLabelsWithPrefix } from "./validation.js";

// -- Module state -------------------------------------------------------------

let orchestrator: DispatchOrchestrator | null = null;
let initAttempted = false;

// -- Feature gate -------------------------------------------------------------

function hasBrCli(): boolean {
  try {
    execFileSync("br", ["--version"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// -- Bootstrap ----------------------------------------------------------------

/** Initialize beads-bridge. Idempotent. Silently no-ops if `br` not in PATH. */
export function initBeadsBridge(): void {
  if (initAttempted) return;
  initAttempted = true;

  if (!hasBrCli()) return;

  orchestrator = new DispatchOrchestrator({
    callGateway,
    onAgentEvent,
    readLatestAssistantReply,
  });
  orchestrator.restoreOnce();
}

// -- Tool factory -------------------------------------------------------------

const BeadsDispatchSchema = Type.Object({
  sprintId: Type.Optional(
    Type.String({ description: "Target sprint ID (default: current in_progress sprint)" }),
  ),
  maxConcurrent: Type.Optional(
    Type.Number({ minimum: 1, maximum: 8, description: "Max parallel sub-agents (default: 3)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override for sub-agents" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level for sub-agents" })),
  dryRun: Type.Optional(Type.Boolean({ description: "Preview dispatch without spawning" })),
  taskFilter: Type.Optional(
    Type.String({ description: "Comma-separated bead IDs to limit dispatch" }),
  ),
});

/**
 * Create the beads_dispatch tool. Returns null if bridge is not initialized
 * (br CLI not available). Callers should filter nulls from the tools array.
 */
export function createBeadsDispatchTool(opts?: { agentSessionKey?: string }): AnyAgentTool | null {
  if (!orchestrator) return null;

  const orch = orchestrator;

  return {
    label: "Beads Dispatch",
    name: "beads_dispatch",
    description:
      "Dispatch ready sprint tasks as parallel sub-agents via the beads task graph. " +
      "Each sub-agent receives compiled context and runs in isolation. " +
      "Use dryRun to preview before dispatching.",
    parameters: BeadsDispatchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sprintId = readStringParam(params, "sprintId");
      const maxConcurrentRaw = readNumberParam(params, "maxConcurrent");
      const maxConcurrent = Math.min(
        8,
        Math.max(1, Number.isFinite(maxConcurrentRaw) ? Math.floor(maxConcurrentRaw!) : 3),
      );
      const model = readStringParam(params, "model");
      const thinking = readStringParam(params, "thinking");
      const dryRun = params.dryRun === true;
      const taskFilter = readStringParam(params, "taskFilter");

      // 1. Read sprint tasks
      const tasks = await orch.readSprintTasks(sprintId);

      // 2. Filter to ready + unclaimed
      const ready = tasks.filter(
        (t) =>
          hasLabel(t.labels, "ready") && getLabelsWithPrefix(t.labels, "session:").length === 0,
      );

      // 3. Apply taskFilter if provided
      const filterIds = taskFilter ? taskFilter.split(",").map((s) => s.trim()) : null;
      const filtered = filterIds ? ready.filter((t) => filterIds.includes(t.id)) : ready;

      // 4. Respect concurrency limit
      const active = orch.getActiveCount();
      const available = Math.min(filtered.length, maxConcurrent - active);
      const toDispatch = filtered.slice(0, Math.max(0, available));

      // 5. Dry run: return preview
      if (dryRun) {
        return jsonResult({
          mode: "dry_run",
          wouldDispatch: toDispatch.map((t) => ({ id: t.id, title: t.title })),
          blocked: tasks.filter((t) => hasLabel(t.labels, "blocked")).length,
          alreadyClaimed: tasks.filter((t) => getLabelsWithPrefix(t.labels, "session:").length > 0)
            .length,
          active,
        });
      }

      // 6. Dispatch
      const dispatchOpts: DispatchOpts = {
        model,
        thinking,
        sessionKey: opts?.agentSessionKey,
      };
      const results = await orch.dispatchBatch(toDispatch, dispatchOpts);

      return jsonResult(results);
    },
  };
}
