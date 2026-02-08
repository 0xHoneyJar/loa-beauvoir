// .claude/lib/contracts/action-policy-spec.ts — Cross-repo ActionPolicy contract (TASK-3.3b)
//
// Serializable JSON contract between Beauvoir (policy definitions) and
// Finn (runtime enforcement via GitHubFirewall).

import type { ActionPolicyDef, ConstraintDef } from "../workflow/templates/base.js";
import { ActionPolicy } from "../safety/action-policy.js";

/** Current schema version. Bump on breaking changes to ActionPolicySpec. */
export const ACTION_POLICY_SPEC_VERSION = 1;

/** Serializable constraint spec — mirrors ConstraintDef but is JSON-safe. */
export interface ConstraintSpec {
  draftOnly?: boolean;
  labelsOnly?: string[];
  maxCommentLength?: number;
  deniedEvents?: string[];
}

/** Serializable cross-repo policy contract (JSON-safe, no class instances). */
export interface ActionPolicySpec {
  schemaVersion: number;
  templateId: string;
  allow: string[];
  deny: string[];
  constraints: Record<string, ConstraintSpec>;
}

/** Serialize an ActionPolicyDef to a portable JSON spec. */
export function toSpec(def: ActionPolicyDef): ActionPolicySpec {
  const constraints: Record<string, ConstraintSpec> = {};
  if (def.constraints) {
    for (const [tool, c] of Object.entries(def.constraints)) {
      const spec: ConstraintSpec = {};
      if (c.draftOnly !== undefined) spec.draftOnly = c.draftOnly;
      if (c.labelsOnly !== undefined) spec.labelsOnly = [...c.labelsOnly];
      if (c.maxCommentLength !== undefined) spec.maxCommentLength = c.maxCommentLength;
      if (c.deniedEvents !== undefined) spec.deniedEvents = [...c.deniedEvents];
      constraints[tool] = spec;
    }
  }
  return {
    schemaVersion: ACTION_POLICY_SPEC_VERSION,
    templateId: def.templateId,
    allow: [...def.allow],
    deny: [...def.deny],
    constraints,
  };
}

/** Deserialize an ActionPolicySpec into a live ActionPolicy. Throws on version mismatch. */
export function fromSpec(spec: ActionPolicySpec): ActionPolicy {
  if (spec.schemaVersion !== ACTION_POLICY_SPEC_VERSION) {
    throw new Error(
      `ActionPolicySpec version mismatch: expected ${ACTION_POLICY_SPEC_VERSION}, got ${spec.schemaVersion}`,
    );
  }
  return new ActionPolicy({
    templateId: spec.templateId,
    allow: spec.allow,
    deny: spec.deny,
    constraints: spec.constraints,
  });
}
