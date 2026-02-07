// .claude/lib/workflow/loader.ts — YAML workflow definition loader (SDD §4.2)
// Parses YAML strings, validates structure, returns typed WorkflowDefinition objects.
// No file I/O — the caller provides YAML content as a string.

// ── Types ──

export type GateType = "auto" | "approve" | "review";

export type FailureMode = "abort" | "skip" | { retry: number };

export interface StepDefinition {
  id: string;
  skill: string;
  input?: Record<string, string>;
  gate?: GateType;
  timeout_minutes?: number;
  on_failure?: FailureMode;
}

export interface TriggerDefinition {
  type: "cron" | "webhook" | "label";
  schedule?: string;
  label?: string;
  event?: string;
}

export interface WorkflowDefinition {
  name: string;
  description: string;
  trigger: TriggerDefinition;
  steps: StepDefinition[];
}

// ── Minimal YAML subset parser ──
// Handles: key-value pairs, nested objects (2-space indent), arrays (- prefix),
// strings (quoted/unquoted), numbers, booleans. Sufficient for workflow YAML.

type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue };

function parseYamlValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  // Quoted strings
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // Numbers
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function indentLevel(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function parseYamlLines(
  lines: string[],
  start: number,
  baseIndent: number,
): { value: YamlValue; end: number } {
  const result: Record<string, YamlValue> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    // Skip blank lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const indent = indentLevel(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) break; // handled by recursion from parent

    const trimmed = line.trim();

    // Array item at this level
    if (trimmed.startsWith("- ")) {
      // This is an array — collect all items at this indent level
      const arr: YamlValue[] = [];
      while (i < lines.length) {
        const arrLine = lines[i];
        if (arrLine.trim() === "" || arrLine.trim().startsWith("#")) {
          i++;
          continue;
        }
        const arrIndent = indentLevel(arrLine);
        if (arrIndent < baseIndent) break;
        if (arrIndent !== baseIndent || !arrLine.trim().startsWith("- ")) break;

        const afterDash = arrLine.trim().slice(2);
        // Check if this dash line has a key: value (object item)
        const colonIdx = afterDash.indexOf(":");
        if (
          colonIdx !== -1 &&
          (colonIdx === afterDash.length - 1 || afterDash[colonIdx + 1] === " ")
        ) {
          // Object starting on the dash line — parse as nested object
          const objItemIndent = baseIndent + 2;
          const key = afterDash.slice(0, colonIdx).trim();
          const valPart = afterDash.slice(colonIdx + 1).trim();
          const obj: Record<string, YamlValue> = {};
          if (valPart) {
            obj[key] = parseYamlValue(valPart);
          } else {
            // Value on next lines
            i++;
            const nested = parseYamlLines(lines, i, objItemIndent + 2);
            obj[key] = nested.value;
            i = nested.end;
          }
          // Continue collecting sibling keys at objItemIndent
          if (!valPart) {
            // already advanced
          } else {
            i++;
          }
          while (i < lines.length) {
            const sibLine = lines[i];
            if (sibLine.trim() === "" || sibLine.trim().startsWith("#")) {
              i++;
              continue;
            }
            const sibIndent = indentLevel(sibLine);
            if (sibIndent < objItemIndent) break;
            if (sibIndent !== objItemIndent) break;
            const sibTrimmed = sibLine.trim();
            const sibColon = sibTrimmed.indexOf(":");
            if (sibColon === -1) break;
            const sibKey = sibTrimmed.slice(0, sibColon).trim();
            const sibVal = sibTrimmed.slice(sibColon + 1).trim();
            if (sibVal) {
              obj[sibKey] = parseYamlValue(sibVal);
              i++;
            } else {
              i++;
              const sibNested = parseYamlLines(lines, i, sibIndent + 2);
              obj[sibKey] = sibNested.value;
              i = sibNested.end;
            }
          }
          arr.push(obj);
        } else {
          // Simple scalar array item
          arr.push(parseYamlValue(afterDash));
          i++;
        }
      }
      return { value: arr, end: i };
    }

    // Key: value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const valPart = trimmed.slice(colonIdx + 1).trim();

    if (valPart) {
      result[key] = parseYamlValue(valPart);
      i++;
    } else {
      // Nested block — peek at next meaningful line to detect arrays vs objects
      i++;
      while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("#"))) i++;
      if (i < lines.length) {
        const nextIndent = indentLevel(lines[i]);
        if (nextIndent > baseIndent) {
          const nested = parseYamlLines(lines, i, nextIndent);
          result[key] = nested.value;
          i = nested.end;
        }
      }
    }
  }

  return { value: result, end: i };
}

function parseYaml(yaml: string): YamlValue {
  const lines = yaml.split("\n");
  const { value } = parseYamlLines(lines, 0, 0);
  return value;
}

// ── Coerce on_failure from parsed YAML into typed FailureMode ──

function coerceFailureMode(raw: YamlValue | undefined): FailureMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "abort" || raw === "skip") return raw;
  if (typeof raw === "object" && !Array.isArray(raw) && typeof raw.retry === "number") {
    return { retry: raw.retry };
  }
  return undefined;
}

// ── Public API ──

/** Parse a YAML string into a typed WorkflowDefinition. */
export function parseWorkflow(yamlContent: string): WorkflowDefinition {
  const raw = parseYaml(yamlContent) as Record<string, YamlValue>;

  const trigger = raw.trigger as Record<string, YamlValue>;
  const rawSteps = raw.steps as YamlValue[];

  const steps: StepDefinition[] = (rawSteps ?? []).map((s) => {
    const step = s as Record<string, YamlValue>;
    const def: StepDefinition = {
      id: String(step.id),
      skill: String(step.skill),
    };
    if (step.input !== undefined) def.input = step.input as Record<string, string>;
    if (step.gate !== undefined) def.gate = String(step.gate) as GateType;
    if (step.timeout_minutes !== undefined) def.timeout_minutes = Number(step.timeout_minutes);
    if (step.on_failure !== undefined) def.on_failure = coerceFailureMode(step.on_failure);
    return def;
  });

  return {
    name: String(raw.name),
    description: String(raw.description),
    trigger: {
      type: String(trigger.type) as TriggerDefinition["type"],
      ...(trigger.schedule !== undefined ? { schedule: String(trigger.schedule) } : {}),
      ...(trigger.label !== undefined ? { label: String(trigger.label) } : {}),
      ...(trigger.event !== undefined ? { event: String(trigger.event) } : {}),
    },
    steps,
  };
}

/** Validate a WorkflowDefinition for structural correctness. */
export function validateWorkflow(def: WorkflowDefinition): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check duplicate step IDs
  const seen = new Set<string>();
  for (const step of def.steps) {
    if (seen.has(step.id)) {
      errors.push(`Duplicate step ID: "${step.id}"`);
    }
    seen.add(step.id);
  }

  // Check input references
  const validGates: GateType[] = ["auto", "approve", "review"];
  const seenSoFar = new Set<string>();
  for (const step of def.steps) {
    if (step.input) {
      for (const [key, ref] of Object.entries(step.input)) {
        const match = ref.match(/^steps\.([^.]+)\..+$/);
        if (match) {
          const refId = match[1];
          if (!seen.has(refId)) {
            errors.push(`Step "${step.id}" input "${key}" references unknown step "${refId}"`);
          } else if (!seenSoFar.has(refId)) {
            errors.push(
              `Step "${step.id}" input "${key}" has forward reference to step "${refId}"`,
            );
          }
        }
      }
    }

    // Validate gate type
    if (step.gate !== undefined && !validGates.includes(step.gate as GateType)) {
      errors.push(`Step "${step.id}" has invalid gate type: "${step.gate}"`);
    }

    // Validate on_failure
    if (step.on_failure !== undefined) {
      const fm = step.on_failure;
      if (
        fm !== "abort" &&
        fm !== "skip" &&
        (typeof fm !== "object" || typeof (fm as { retry: number }).retry !== "number")
      ) {
        errors.push(`Step "${step.id}" has invalid on_failure: ${JSON.stringify(fm)}`);
      }
    }

    seenSoFar.add(step.id);
  }

  return { valid: errors.length === 0, errors };
}

/** Resolve a step input reference like "steps.analyze.prd" from collected outputs. */
export function resolveInputRef(
  ref: string,
  stepOutputs: Map<string, Record<string, unknown>>,
): unknown {
  const match = ref.match(/^steps\.([^.]+)\.(.+)$/);
  if (!match) throw new Error(`Invalid input reference format: "${ref}"`);

  const [, stepId, field] = match;
  const outputs = stepOutputs.get(stepId);
  if (!outputs) throw new Error(`Step "${stepId}" not found in outputs`);
  if (!(field in outputs))
    throw new Error(`Field "${field}" not found in step "${stepId}" outputs`);
  return outputs[field];
}
