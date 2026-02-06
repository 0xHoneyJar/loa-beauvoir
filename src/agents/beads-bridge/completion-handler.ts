/**
 * CompletionHandler — processes lifecycle events for dispatched sub-agents.
 *
 * Updates bead labels on success/failure and cascades dependency unblocks.
 */

import type { BrExecutor, BeadRecord } from "./br-executor.js";
import type { DispatchRecord } from "./state.js";
import { validateLabel, hasLabel } from "./validation.js";

// -- Types --------------------------------------------------------------------

interface CompletionDeps {
  readLatestAssistantReply: (params: { sessionKey: string }) => Promise<string | undefined>;
}

// -- CompletionHandler class --------------------------------------------------

export class CompletionHandler {
  constructor(
    private br: BrExecutor,
    private deps: CompletionDeps,
  ) {}

  /**
   * On success: read child reply, remove session label, add `done`, close bead.
   */
  async onSuccess(record: DispatchRecord): Promise<void> {
    const { beadId } = record;
    const sessionLabel = sessionLabelFor(record);

    // Read child's last reply (best-effort)
    const reply = await this.deps
      .readLatestAssistantReply({
        sessionKey: record.childSessionKey,
      })
      .catch(() => undefined);
    if (reply) {
      record.resultSummary = reply.slice(0, 500);
    }

    await this.br.labelRemove(beadId, sessionLabel);
    await this.br.labelAdd(beadId, "done");
    await this.br.close(beadId);
  }

  /**
   * On failure: remove session label, add `ready` + `circuit-breaker`, add comment.
   */
  async onFailure(record: DispatchRecord, reason: string): Promise<void> {
    const { beadId } = record;
    const sessionLabel = sessionLabelFor(record);

    await this.br.labelRemove(beadId, sessionLabel);
    await this.br.labelAdd(beadId, "ready");
    await this.br.labelAdd(beadId, "circuit-breaker");

    const truncated = reason.length > 900 ? reason.slice(0, 900) : reason;
    await this.br.comment(beadId, `Circuit breaker: ${truncated}`);
  }

  /**
   * Cascade unblocks: find blocked tasks with all deps closed, move to `ready`.
   * Errors are non-fatal — logged but don't fail the completion.
   */
  async cascadeUnblocks(sprintId: string): Promise<string[]> {
    let tasks: BeadRecord[];
    try {
      validateLabel(sprintId);
      tasks = await this.br.listByLabel(`sprint-source:${sprintId}`);
    } catch (err) {
      console.error("cascadeUnblocks: failed to list tasks", err);
      return [];
    }

    const unblocked: string[] = [];

    for (const task of tasks) {
      if (task.status !== "open") continue;
      if (!hasLabel(task.labels, "blocked")) continue;

      const deps = task.depends_on ?? [];

      const allDepsClosed = deps.every((depId) => {
        const dep = tasks.find((t) => t.id === depId);
        if (!dep) {
          // Missing dep (different sprint, deleted) — treat as not closed
          console.warn(`cascadeUnblocks: dep ${depId} not found in sprint for task ${task.id}`);
          return false;
        }
        return dep.status === "closed";
      });

      if (allDepsClosed) {
        try {
          await this.br.labelRemove(task.id, "blocked");
          await this.br.labelAdd(task.id, "ready");
          unblocked.push(task.id);
        } catch (err) {
          console.error(`cascadeUnblocks: failed to unblock task ${task.id}`, err);
          // Non-fatal: continue (per Flatline finding #4)
        }
      }
    }

    return unblocked;
  }
}

// -- Helpers ------------------------------------------------------------------

function sessionLabelFor(record: DispatchRecord): string {
  // Extract bridgeUuid from childSessionKey format: agent:{agentId}:subagent:{uuid}
  const key = record.childSessionKey;
  if (!key || typeof key !== "string") {
    throw new Error("Missing childSessionKey");
  }
  const parts = key.split(":");
  const uuid = parts[parts.length - 1];
  if (!uuid) {
    throw new Error("Invalid childSessionKey format");
  }
  const label = `session:bridge-${uuid}`;
  validateLabel(label);
  return label;
}
