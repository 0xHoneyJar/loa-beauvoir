// .claude/lib/workflow/types.ts — Step I/O Schema validation (SDD 4.3)

// ── Step Field Types ────────────────────────────────────────

/** Supported field types for step inputs and outputs. */
export type StepFieldType = "string" | "path" | "json" | "branch" | "number" | "boolean";

/** Schema definition for a single field. */
export interface StepFieldDef {
  type: StepFieldType;
  required?: boolean;
  description?: string;
}

/** I/O schema declaring what a step expects and produces. */
export interface StepIOSchema {
  inputs: Record<string, StepFieldDef>;
  outputs: Record<string, StepFieldDef>;
}

// ── Step Result Envelope ────────────────────────────────────

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface StepResult {
  stepId: string;
  status: StepStatus;
  outputs: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  artifacts?: string[];
}

// ── Workflow Run ────────────────────────────────────────────

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "step_failed"
  | "aborted"
  | "completed";

export interface WorkflowRun {
  id: string;
  workflowId: string;
  triggerId: string;
  status: WorkflowRunStatus;
  currentStep: number;
  steps: StepResult[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

// ── Validation Helpers ──────────────────────────────────────

/** Branch names: alphanumeric, hyphens, underscores, slashes, dots. */
const BRANCH_RE = /^[a-zA-Z0-9_\-/.]+$/;

/** Check a single value against its declared field type. */
function checkType(value: unknown, fieldType: StepFieldType): string | null {
  switch (fieldType) {
    case "string":
      return typeof value === "string" ? null : `expected string, got ${typeof value}`;
    case "number":
      return typeof value === "number" ? null : `expected number, got ${typeof value}`;
    case "boolean":
      return typeof value === "boolean" ? null : `expected boolean, got ${typeof value}`;
    case "path":
      return typeof value === "string" ? null : `expected path (string), got ${typeof value}`;
    case "branch":
      if (typeof value !== "string") return `expected branch (string), got ${typeof value}`;
      return BRANCH_RE.test(value) ? null : `invalid branch name: ${value}`;
    case "json":
      // Any value is valid JSON (already deserialized)
      return null;
    default:
      return `unknown field type: ${fieldType}`;
  }
}

/** Validate a record of values against a field schema (inputs or outputs). */
function validateFields(
  values: Record<string, unknown>,
  schema: Record<string, StepFieldDef>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const [name, def] of Object.entries(schema)) {
    const value = values[name];
    const isPresent = value !== undefined && value !== null;

    if (def.required !== false && !isPresent) {
      errors.push(`missing required field: ${name}`);
      continue;
    }

    if (isPresent) {
      const typeErr = checkType(value, def.type);
      if (typeErr) {
        errors.push(`field '${name}': ${typeErr}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Public API ──────────────────────────────────────────────

export function validateOutputs(
  outputs: Record<string, unknown>,
  schema: StepIOSchema["outputs"],
): { valid: boolean; errors: string[] } {
  return validateFields(outputs, schema);
}

export function validateInputs(
  inputs: Record<string, unknown>,
  schema: StepIOSchema["inputs"],
): { valid: boolean; errors: string[] } {
  return validateFields(inputs, schema);
}

/** Serialize a StepResult to a JSON string. */
export function serializeStepResult(result: StepResult): string {
  return JSON.stringify(result);
}

/** Deserialize a JSON string back to a StepResult. Throws on invalid input. */
export function deserializeStepResult(json: string): StepResult {
  const parsed = JSON.parse(json);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("invalid StepResult: expected object");
  }
  if (typeof parsed.stepId !== "string") {
    throw new Error("invalid StepResult: missing stepId");
  }
  if (typeof parsed.status !== "string") {
    throw new Error("invalid StepResult: missing status");
  }
  if (!parsed.outputs || typeof parsed.outputs !== "object") {
    throw new Error("invalid StepResult: missing outputs");
  }
  return parsed as StepResult;
}
