// .claude/lib/workflow/engine.ts — Workflow state machine (TASK-4.1)
// Chains workflow steps sequentially, handles failure modes (abort/retry/skip),
// persists after each step for crash recovery.

import type { WorkflowRunStatus } from "./types.js";

// ── Types ────────────────────────────────────────────────────

export type GateType = "auto" | "approve" | "review";
export type FailureMode = "abort" | "skip" | { retry: number };

export interface EngineStepDef {
  id: string;
  skill: string;
  input?: Record<string, string>;
  gate?: GateType; // default: "auto"
  timeout_minutes?: number; // default: 30
  on_failure?: FailureMode; // default: "abort"
}

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StepState {
  stepId: string;
  status: StepStatus;
  outputs: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  retries?: number;
  gateDecision?: "auto" | "approved" | "rejected" | "timed_out";
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  triggerId: string;
  status: WorkflowRunStatus;
  currentStep: number;
  steps: StepState[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

// ── Persistence interface (duck-typed) ───────────────────────

export interface EnginePersistence {
  save(run: WorkflowRun): Promise<void>;
  load(runId: string): Promise<WorkflowRun | null>;
}

// ── Callback types ───────────────────────────────────────────

/** Step executor — the engine delegates actual skill execution to this. */
export type StepExecutor = (
  stepDef: EngineStepDef,
  resolvedInputs: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Gate checker — returns approval decision for non-auto gates. */
export type GateChecker = (
  stepDef: EngineStepDef,
  run: WorkflowRun,
) => Promise<"approved" | "rejected" | "timed_out">;

// ── Input resolution ─────────────────────────────────────────

/** Resolve step input references like "steps.step1.result" from prior step outputs. */
function resolveInputs(
  inputDefs: Record<string, string> | undefined,
  steps: StepState[],
): Record<string, unknown> {
  if (!inputDefs) return {};

  const resolved: Record<string, unknown> = {};
  // Build a lookup of step outputs by stepId
  const outputsByStep = new Map<string, Record<string, unknown>>();
  for (const s of steps) {
    outputsByStep.set(s.stepId, s.outputs);
  }

  for (const [key, ref] of Object.entries(inputDefs)) {
    const match = ref.match(/^steps\.([^.]+)\.(.+)$/);
    if (!match) {
      // Literal value, pass through
      resolved[key] = ref;
      continue;
    }
    const [, stepId, field] = match;
    const outputs = outputsByStep.get(stepId);
    if (!outputs) throw new Error(`Input ref "${ref}": step "${stepId}" not found`);
    if (!(field in outputs))
      throw new Error(`Input ref "${ref}": field "${field}" not in step "${stepId}" outputs`);
    resolved[key] = outputs[field];
  }

  return resolved;
}

// ── WorkflowEngine ──────────────────────────────────────────

export class WorkflowEngine {
  private persistence: EnginePersistence;
  private executor: StepExecutor;
  private gateChecker: GateChecker;
  private now: () => number;
  private stepDefs = new Map<string, EngineStepDef[]>();

  constructor(deps: {
    persistence: EnginePersistence;
    executor: StepExecutor;
    gateChecker: GateChecker;
    now?: () => number;
  }) {
    this.persistence = deps.persistence;
    this.executor = deps.executor;
    this.gateChecker = deps.gateChecker;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Start a new workflow run. */
  async start(opts: {
    id: string;
    workflowId: string;
    triggerId: string;
    steps: EngineStepDef[];
  }): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: opts.id,
      workflowId: opts.workflowId,
      triggerId: opts.triggerId,
      status: "running",
      currentStep: 0,
      steps: opts.steps.map((s) => ({
        stepId: s.id,
        status: "pending" as StepStatus,
        outputs: {},
      })),
      startedAt: new Date(this.now()).toISOString(),
    };

    // Store step definitions for advance() to use
    this.stepDefs.set(opts.id, opts.steps);
    await this.persistence.save(run);
    return this.advance(opts.id);
  }

  /** Advance the workflow: execute next pending step(s). */
  async advance(runId: string): Promise<WorkflowRun> {
    const run = await this.persistence.load(runId);
    if (!run) throw new Error(`Run "${runId}" not found`);

    const defs = this.stepDefs.get(runId);
    if (!defs) throw new Error(`Step definitions for run "${runId}" not found`);

    while (run.currentStep < run.steps.length) {
      const idx = run.currentStep;
      const stepState = run.steps[idx];
      const stepDef = defs[idx];

      // Already completed — skip forward
      if (stepState.status === "completed") {
        run.currentStep++;
        continue;
      }

      // Mark running
      stepState.status = "running";
      await this.persistence.save(run);

      // Resolve inputs from prior step outputs
      const resolvedInputs = resolveInputs(stepDef.input, run.steps);

      // Gate check — skip if already approved (resume path)
      const gate = stepDef.gate ?? "auto";
      if (gate === "auto") {
        stepState.gateDecision = "auto";
      } else if (stepState.gateDecision !== "approved") {
        // "approve" or "review" — block until resume()
        run.status = "waiting_approval";
        await this.persistence.save(run);
        return run;
      }

      // Execute step
      const startTime = this.now();
      const maxRetries = typeof stepDef.on_failure === "object" ? stepDef.on_failure.retry : 0;
      let attempt = 0;
      let succeeded = false;

      while (attempt <= maxRetries) {
        try {
          const outputs = await this.executor(stepDef, resolvedInputs);
          stepState.status = "completed";
          stepState.outputs = outputs;
          stepState.durationMs = this.now() - startTime;
          stepState.retries = attempt > 0 ? attempt : undefined;
          succeeded = true;
          break;
        } catch (err) {
          attempt++;
          stepState.retries = attempt;

          if (attempt > maxRetries) {
            // Retries exhausted or no retry configured
            const failureMode = stepDef.on_failure ?? "abort";

            if (failureMode === "skip") {
              stepState.status = "skipped";
              stepState.error = err instanceof Error ? err.message : String(err);
              stepState.durationMs = this.now() - startTime;
              succeeded = true; // continue to next step
              break;
            } else {
              // "abort" or exhausted retry
              stepState.status = "failed";
              stepState.error = err instanceof Error ? err.message : String(err);
              stepState.durationMs = this.now() - startTime;
              run.status = "aborted";
              run.error = `Step "${stepDef.id}" failed: ${stepState.error}`;
              await this.persistence.save(run);
              return run;
            }
          }
        }
      }

      // Persist after step completion
      await this.persistence.save(run);

      if (succeeded) {
        run.currentStep++;
      }
    }

    // All steps done
    run.status = "completed";
    run.completedAt = new Date(this.now()).toISOString();
    await this.persistence.save(run);
    return run;
  }

  /** Resume after approval: mark step as approved and continue advancing. */
  async resume(runId: string): Promise<WorkflowRun> {
    const run = await this.persistence.load(runId);
    if (!run) throw new Error(`Run "${runId}" not found`);
    if (run.status !== "waiting_approval") {
      throw new Error(`Run "${runId}" is not waiting for approval (status: ${run.status})`);
    }

    const stepState = run.steps[run.currentStep];
    stepState.gateDecision = "approved";
    run.status = "running";
    await this.persistence.save(run);

    // Re-execute the current step now that it's approved
    return this.advance(runId);
  }
}
