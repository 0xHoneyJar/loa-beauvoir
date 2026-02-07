/**
 * ToolValidator - MCP tool registry validation and runtime param checking
 *
 * Provides two core operations:
 * - validateRegistry(): boot-time cross-check of policy against available MCP tools
 * - validateParams(): runtime constraint enforcement per tool invocation
 */

export interface ToolConstraint {
  type: "must_be" | "pattern" | "allowlist";
  param: string;
  value: unknown; // literal for must_be, regex string for pattern, string[] for allowlist
}

export interface ToolRegistryEntry {
  name: string;
  capability: "read" | "write" | "admin";
  constraints?: ToolConstraint[];
}

export interface ActionPolicyDef {
  allow: string[];
  deny?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export class ToolValidator {
  private registry: Map<string, ToolRegistryEntry>;
  private policy: ActionPolicyDef;

  constructor(registry: ToolRegistryEntry[], policy: ActionPolicyDef) {
    this.registry = new Map(registry.map((entry) => [entry.name, entry]));
    this.policy = policy;
  }

  /**
   * Validate policy against available MCP tools at boot time.
   *
   * Rules:
   * 1. Every tool in policy.allow must exist in mcpToolNames (unknown = error)
   * 2. Every MCP tool should be in policy.allow or policy.deny (unregistered = warning)
   * 3. Denied tools present in MCP list are expected (no error)
   */
  validateRegistry(mcpToolNames: string[]): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const mcpSet = new Set(mcpToolNames);
    const policyDeny = new Set(this.policy.deny ?? []);

    // Rule 1: every allowed tool must exist in MCP
    for (const toolName of this.policy.allow) {
      if (!mcpSet.has(toolName)) {
        errors.push(`Unknown tool in policy.allow: ${toolName}`);
      }
    }

    // Rule 2: every MCP tool should be accounted for in allow or deny
    const allowSet = new Set(this.policy.allow);
    for (const mcpTool of mcpToolNames) {
      if (!allowSet.has(mcpTool) && !policyDeny.has(mcpTool)) {
        warnings.push(`Unregistered MCP tool: ${mcpTool}`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Validate params for a tool invocation at runtime.
   * Returns an array of violation messages (empty = all constraints pass).
   */
  validateParams(toolName: string, params: Record<string, unknown>): string[] {
    const entry = this.registry.get(toolName);
    if (!entry?.constraints) return [];

    const violations: string[] = [];
    for (const constraint of entry.constraints) {
      const actual = params[constraint.param];

      switch (constraint.type) {
        case "must_be":
          if (actual !== constraint.value) {
            violations.push(
              `${constraint.param} must be ${JSON.stringify(constraint.value)}, got ${JSON.stringify(actual)}`,
            );
          }
          break;

        case "pattern": {
          const regex = new RegExp(constraint.value as string);
          if (typeof actual !== "string" || !regex.test(actual)) {
            violations.push(
              `${constraint.param} must match pattern ${constraint.value}, got ${JSON.stringify(actual)}`,
            );
          }
          break;
        }

        case "allowlist": {
          const allowed = constraint.value as string[];
          if (!allowed.includes(actual as string)) {
            violations.push(
              `${constraint.param} must be one of [${allowed.join(", ")}], got ${JSON.stringify(actual)}`,
            );
          }
          break;
        }
      }
    }

    return violations;
  }
}
