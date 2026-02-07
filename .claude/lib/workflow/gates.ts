// .claude/lib/workflow/gates.ts — Gate Semantics (TASK-4.4)
// Three gate types controlling workflow step advancement:
//   auto    — proceeds immediately, no human intervention
//   approve — blocks until explicit approval; rejects on timeout
//   review  — blocks until review; auto-proceeds on timeout

// ── Types ────────────────────────────────────────────────────

export type GateType = "auto" | "approve" | "review";

export type GateDecision = "auto_proceed" | "approved" | "rejected" | "timed_out";

export interface GateConfig {
  type: GateType;
  timeout_minutes?: number; // default: 60
}

export interface GateState {
  stepId: string;
  gate: GateConfig;
  decision?: GateDecision;
  notifiedAt?: string;
  decidedAt?: string;
  decidedBy?: string; // "system" for auto/timeout, user ID for approve/reject
}

export interface GateNotification {
  stepId: string;
  workflowRunId: string;
  gateType: GateType;
  message: string;
  timeout_minutes: number;
}

// ── Gate Evaluator ───────────────────────────────────────────

export class GateEvaluator {
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Evaluate a gate: returns whether to proceed, block, or reject. */
  evaluate(state: GateState): {
    action: "proceed" | "block" | "reject";
    decision: GateDecision;
  } {
    const gateType = state.gate.type;

    // Auto gates always proceed
    if (gateType === "auto") {
      return { action: "proceed", decision: "auto_proceed" };
    }

    // Check timeout before checking decision (timeout overrides pending state)
    if (this.isTimedOut(state)) {
      // approve rejects on timeout; review auto-proceeds
      return gateType === "approve"
        ? { action: "reject", decision: "timed_out" }
        : { action: "proceed", decision: "timed_out" };
    }

    // Check explicit decisions
    if (state.decision === "approved") {
      return { action: "proceed", decision: "approved" };
    }
    if (state.decision === "rejected") {
      return { action: "reject", decision: "rejected" };
    }

    // No decision yet — block
    return { action: "block", decision: "auto_proceed" }; // decision field unused when blocking
  }

  /** Apply an approval to a gate. */
  approve(state: GateState, approvedBy?: string): GateState {
    return {
      ...state,
      decision: "approved",
      decidedAt: new Date(this.now()).toISOString(),
      decidedBy: approvedBy ?? "unknown",
    };
  }

  /** Apply a rejection to a gate. */
  reject(state: GateState, rejectedBy?: string): GateState {
    return {
      ...state,
      decision: "rejected",
      decidedAt: new Date(this.now()).toISOString(),
      decidedBy: rejectedBy ?? "unknown",
    };
  }

  /** Check if a gate has timed out. */
  isTimedOut(state: GateState): boolean {
    if (!state.notifiedAt) return false;
    const timeoutMs = (state.gate.timeout_minutes ?? 60) * 60 * 1000;
    const notifiedMs = new Date(state.notifiedAt).getTime();
    return this.now() - notifiedMs >= timeoutMs;
  }

  /** Create initial gate state for a step. */
  createGateState(stepId: string, config: GateConfig): GateState {
    return {
      stepId,
      gate: {
        type: config.type,
        timeout_minutes: config.timeout_minutes ?? 60,
      },
      notifiedAt: new Date(this.now()).toISOString(),
    };
  }

  /** Build notification for a blocking gate. */
  buildNotification(state: GateState, workflowRunId: string): GateNotification {
    const timeout = state.gate.timeout_minutes ?? 60;
    const gateType = state.gate.type;
    const verb = gateType === "approve" ? "approval" : "review";
    return {
      stepId: state.stepId,
      workflowRunId,
      gateType,
      message: `Step "${state.stepId}" requires ${verb} (timeout: ${timeout}m)`,
      timeout_minutes: timeout,
    };
  }
}
