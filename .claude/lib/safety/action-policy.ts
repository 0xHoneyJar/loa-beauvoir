// .claude/lib/safety/action-policy.ts — Per-template action policy enforcement (SDD 5.1)

import type { ActionPolicyDef, ConstraintDef } from "../workflow/templates/base.js";

/** Result of an isAllowed() check. */
export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

/** Params bag passed to isAllowed / applyConstraints. */
export interface ToolParams {
  draft?: boolean;
  labels?: string[];
  commentBody?: string;
  event?: string;
  [key: string]: unknown;
}

/**
 * ActionPolicy enforces per-template tool access rules.
 *
 * Precedence: deny list always wins over allow list.
 * Constraints mutate params to enforce safety invariants (e.g., force draft mode).
 */
export class ActionPolicy {
  private readonly allow: Set<string>;
  private readonly deny: Set<string>;
  private readonly constraints: Record<string, ConstraintDef>;

  constructor(def: ActionPolicyDef) {
    this.allow = new Set(def.allow);
    this.deny = new Set(def.deny);
    this.constraints = def.constraints ?? {};
  }

  /**
   * Check whether a tool invocation is permitted.
   * Deny takes precedence: if a tool appears in both allow and deny, it is denied.
   */
  isAllowed(toolName: string, params?: ToolParams): PolicyResult {
    if (this.deny.has(toolName)) {
      return { allowed: false, reason: `tool "${toolName}" is explicitly denied` };
    }

    if (!this.allow.has(toolName)) {
      return { allowed: false, reason: `tool "${toolName}" is not in the allow list` };
    }

    // Check deniedEvents constraint
    if (params?.event) {
      const constraint = this.constraints[toolName];
      if (constraint?.deniedEvents?.includes(params.event)) {
        return {
          allowed: false,
          reason: `event "${params.event}" is denied for tool "${toolName}"`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Mutate params in-place to enforce tool constraints.
   * Call after isAllowed() returns true.
   *
   * - draftOnly: forces draft=true
   * - labelsOnly: filters labels to only those in the allowed set
   * - maxCommentLength: truncates commentBody
   */
  applyConstraints(toolName: string, params: ToolParams): ToolParams {
    const constraint = this.constraints[toolName];
    if (!constraint) return params;

    if (constraint.draftOnly) {
      params.draft = true;
    }

    if (constraint.labelsOnly && params.labels) {
      params.labels = params.labels.filter((l) => constraint.labelsOnly!.includes(l));
    }

    if (
      constraint.maxCommentLength != null &&
      params.commentBody != null &&
      params.commentBody.length > constraint.maxCommentLength
    ) {
      params.commentBody = params.commentBody.slice(0, constraint.maxCommentLength);
    }

    return params;
  }
}
