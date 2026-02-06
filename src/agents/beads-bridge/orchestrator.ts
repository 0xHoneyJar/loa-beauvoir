/**
 * DispatchOrchestrator — central coordinator for beads-bridge dispatch lifecycle.
 *
 * Owns: sprint reading → context compilation → sub-agent spawn → lifecycle tracking → completion.
 * Dependencies injected via OrchestratorDeps for testability.
 */

import crypto from "node:crypto";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import type { BeadRecord } from "./br-executor.js";
import { BrExecutor } from "./br-executor.js";
import { CompletionHandler } from "./completion-handler.js";
import { compileContext } from "./context-compiler.js";
import { buildSubAgentPrompt } from "./prompt-builder.js";
import { BridgeState, type DispatchRecord } from "./state.js";
import { validateLabel, hasLabel, getLabelsWithPrefix } from "./validation.js";

// -- Types --------------------------------------------------------------------

export interface OrchestratorDeps {
  callGateway: <T = Record<string, unknown>>(opts: {
    method: string;
    params?: unknown;
    expectFinal?: boolean;
    timeoutMs?: number;
  }) => Promise<T>;
  onAgentEvent: (listener: (evt: AgentEventPayload) => void) => () => void;
  readLatestAssistantReply: (params: { sessionKey: string }) => Promise<string | undefined>;
}

export interface DispatchOpts {
  model?: string;
  thinking?: string;
  agentId?: string;
  sessionKey?: string;
}

export interface DispatchResult {
  beadId: string;
  runId: string;
  childSessionKey: string;
}

export interface DispatchError {
  beadId: string;
  error: string;
}

export interface DispatchSummary {
  dispatched: DispatchResult[];
  errors: DispatchError[];
  activeCount: number;
}

// -- DispatchOrchestrator class -----------------------------------------------

export class DispatchOrchestrator {
  private state: BridgeState;
  private br: BrExecutor;
  private deps: OrchestratorDeps;
  private listenerStop: (() => void) | null = null;
  private restored = false;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.state = new BridgeState();
    this.br = new BrExecutor();
  }

  // -- Bootstrap --------------------------------------------------------------

  /** Restore persisted state and start lifecycle listener. Idempotent. */
  restoreOnce(): void {
    if (this.restored) return;
    this.restored = true;
    this.state.loadFromDisk();
    this.ensureLifecycleListener();
    this.state.startSweeper();
  }

  // -- Sprint Reading ---------------------------------------------------------

  /** Read sprint tasks from beads. Defaults to current in_progress sprint. */
  async readSprintTasks(sprintId?: string): Promise<BeadRecord[]> {
    if (sprintId) {
      validateLabel(sprintId);
      return this.br.listByLabel(`sprint-source:${sprintId}`);
    }
    return this.br.listByLabel("sprint:in_progress");
  }

  // -- Dispatch ---------------------------------------------------------------

  /** Dispatch a batch of tasks sequentially, collecting errors per-task. */
  async dispatchBatch(tasks: BeadRecord[], opts: DispatchOpts): Promise<DispatchSummary> {
    const dispatched: DispatchResult[] = [];
    const errors: DispatchError[] = [];

    for (const task of tasks) {
      try {
        const result = await this.dispatchOne(task, opts);
        dispatched.push(result);
      } catch (err) {
        errors.push({ beadId: task.id, error: String(err) });
      }
    }

    return { dispatched, errors, activeCount: this.getActiveCount() };
  }

  /** Dispatch a single task: compile context → claim → spawn → record. */
  private async dispatchOne(task: BeadRecord, opts: DispatchOpts): Promise<DispatchResult> {
    const bridgeUuid = crypto.randomUUID();

    // 1. Compile context
    const allBeads = await this.br.listAll();
    const compiled = compileContext(allBeads, task.id, task.depends_on ?? []);

    // 2. Claim task — add session label
    const sessionLabel = `session:bridge-${bridgeUuid}`;
    await this.br.labelAdd(task.id, sessionLabel);

    // 3. TOCTOU check: verify no other session claimed concurrently
    const refreshed = await this.br.get(task.id);
    const sessionLabels = getLabelsWithPrefix(refreshed.labels, "session:");
    if (sessionLabels.length > 1) {
      // Concurrent claim — back off and release
      await this.br.labelRemove(task.id, sessionLabel);
      // Safety: verify task still has at least one session label
      const recheck = await this.br.get(task.id);
      const remaining = getLabelsWithPrefix(recheck.labels, "session:");
      if (remaining.length === 0) {
        // Both claimants backed off — restore ready label
        await this.br.labelAdd(task.id, "ready");
      }
      throw new Error(`TOCTOU: task ${task.id} claimed concurrently`);
    }

    // Remove ready label (now claimed)
    await this.br.labelRemove(task.id, "ready");

    // 4. Build sub-agent prompt
    const prompt = buildSubAgentPrompt(task, compiled);

    // 5. Spawn sub-agent via gateway RPC
    const childSessionKey = `agent:${opts.agentId ?? "default"}:subagent:${bridgeUuid}`;
    let response: { runId: string };
    try {
      response = await this.deps.callGateway<{ runId: string }>({
        method: "agent",
        params: {
          message: prompt,
          sessionKey: childSessionKey,
          idempotencyKey: crypto.randomUUID(),
          deliver: false,
          lane: "subagent",
          thinking: opts.thinking,
          timeout: 300,
          label: `beads:${task.id}`,
          spawnedBy: opts.sessionKey,
        },
        timeoutMs: 10_000,
      });
    } catch (err) {
      // Spawn failed — release claim and restore ready
      await this.br.labelRemove(task.id, sessionLabel).catch(() => {});
      await this.br.labelAdd(task.id, "ready").catch(() => {});
      throw err;
    }

    // 6. Apply model if specified (best-effort, non-fatal)
    if (opts.model) {
      await this.deps
        .callGateway({
          method: "sessions.patch",
          params: { key: childSessionKey, model: opts.model },
          timeoutMs: 10_000,
        })
        .catch(() => {});
    }

    // 7. Record in BridgeState
    const record: DispatchRecord = {
      beadId: task.id,
      runId: response.runId,
      childSessionKey,
      sprintId: this.getSprintId(task),
      dispatchedAt: Date.now(),
    };
    this.state.set(record);

    return { beadId: task.id, runId: response.runId, childSessionKey };
  }

  // -- Lifecycle Listener -----------------------------------------------------

  /** Start listening for lifecycle events. Mirrors subagent-registry.ts pattern. */
  private ensureLifecycleListener(): void {
    if (this.listenerStop) return;

    this.listenerStop = this.deps.onAgentEvent((evt: AgentEventPayload) => {
      if (evt.stream !== "lifecycle") return;

      const record = this.state.getByRunId(evt.runId);
      if (!record) return; // Not our dispatch

      const phase = evt.data?.phase;
      if (phase === "end" || phase === "error") {
        void this.handleCompletion(record, phase as "end" | "error", evt.data);
      }
    });
  }

  /** Handle sub-agent completion: update labels + cascade unblocks. */
  private async handleCompletion(
    record: DispatchRecord,
    phase: "end" | "error",
    data: Record<string, unknown>,
  ): Promise<void> {
    const handler = new CompletionHandler(this.br, {
      readLatestAssistantReply: this.deps.readLatestAssistantReply,
    });

    if (phase === "end") {
      await handler.onSuccess(record);
    } else {
      await handler.onFailure(record, String(data.error ?? "unknown"));
    }

    // Cascade unblocks (non-fatal errors handled inside)
    await handler.cascadeUnblocks(record.sprintId);

    // Update state
    record.completedAt = Date.now();
    record.outcome = phase === "end" ? "success" : "error";
    this.state.set(record);
  }

  // -- Queries ----------------------------------------------------------------

  getActiveCount(): number {
    return this.state.getActive().length;
  }

  getStatus(): { active: number; completed: number; total: number } {
    return {
      active: this.state.getActive().length,
      completed: this.state.getCompleted().length,
      total: this.state.size,
    };
  }

  // -- Helpers ----------------------------------------------------------------

  /** Extract sprint ID from task labels. Falls back to "unknown". */
  private getSprintId(task: BeadRecord): string {
    const sprintLabels = getLabelsWithPrefix(task.labels, "sprint-source:");
    if (sprintLabels.length > 0) {
      return sprintLabels[0].slice("sprint-source:".length);
    }
    return "unknown";
  }
}
