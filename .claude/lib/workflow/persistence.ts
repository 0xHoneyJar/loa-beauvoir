// .claude/lib/workflow/persistence.ts — Workflow run persistence (TASK-4.5)

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "step_failed"
  | "aborted"
  | "completed";

export interface WorkflowRunRecord {
  id: string;
  workflowId: string;
  triggerId: string;
  status: WorkflowRunStatus;
  currentStep: number;
  steps: Array<{
    stepId: string;
    status: string;
    outputs: Record<string, unknown>;
    error?: string;
    durationMs?: number;
  }>;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface StepOutputRecord {
  stepId: string;
  outputs: Record<string, unknown>;
  savedAt: string;
}

/** Persistence interface — implementation provided by runtime */
export interface WorkflowPersistence {
  save(run: WorkflowRunRecord): Promise<void>;
  load(runId: string): Promise<WorkflowRunRecord | null>;
  list(filter?: { workflowId?: string; status?: WorkflowRunStatus }): Promise<WorkflowRunRecord[]>;
  saveStepOutput(runId: string, output: StepOutputRecord): Promise<void>;
  loadStepOutput(runId: string, stepId: string): Promise<StepOutputRecord | null>;
  delete(runId: string): Promise<boolean>;
}

/** In-memory implementation (for testing and lightweight use) */
export class InMemoryWorkflowPersistence implements WorkflowPersistence {
  private runs = new Map<string, WorkflowRunRecord>();
  private stepOutputs = new Map<string, StepOutputRecord>(); // key: `${runId}/${stepId}`

  async save(run: WorkflowRunRecord): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  async load(runId: string): Promise<WorkflowRunRecord | null> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  async list(filter?: {
    workflowId?: string;
    status?: WorkflowRunStatus;
  }): Promise<WorkflowRunRecord[]> {
    let results = Array.from(this.runs.values());
    if (filter?.workflowId) results = results.filter((r) => r.workflowId === filter.workflowId);
    if (filter?.status) results = results.filter((r) => r.status === filter.status);
    return results.map((r) => structuredClone(r));
  }

  async saveStepOutput(runId: string, output: StepOutputRecord): Promise<void> {
    this.stepOutputs.set(`${runId}/${output.stepId}`, structuredClone(output));
  }

  async loadStepOutput(runId: string, stepId: string): Promise<StepOutputRecord | null> {
    const out = this.stepOutputs.get(`${runId}/${stepId}`);
    return out ? structuredClone(out) : null;
  }

  async delete(runId: string): Promise<boolean> {
    const existed = this.runs.has(runId);
    this.runs.delete(runId);
    // Also delete step outputs for this run
    for (const key of this.stepOutputs.keys()) {
      if (key.startsWith(`${runId}/`)) this.stepOutputs.delete(key);
    }
    return existed;
  }
}
