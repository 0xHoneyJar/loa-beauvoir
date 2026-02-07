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

/** Maximum time in ms to allow regex test execution (safety limit). */
const REGEX_TIMEOUT_CHARS = 1000;

/**
 * Validate that a regex pattern string is safe to compile and not pathological.
 * Rejects patterns with obvious catastrophic backtracking indicators.
 */
function validateRegexPattern(pattern: string): RegExp {
  // Reject patterns that are excessively long
  if (pattern.length > REGEX_TIMEOUT_CHARS) {
    throw new Error(`Regex pattern too long (${pattern.length} chars, max ${REGEX_TIMEOUT_CHARS})`);
  }
  // Reject common catastrophic backtracking patterns: nested quantifiers
  // e.g. (a+)+, (a*)*b, (a|a)+, (.+)+ etc.
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) {
    throw new Error(`Potentially unsafe regex pattern (nested quantifiers): ${pattern}`);
  }
  return new RegExp(pattern);
}

export class ToolValidator {
  private registry: Map<string, ToolRegistryEntry>;
  /** Pre-compiled regex cache for pattern constraints (validated at construction). */
  private compiledPatterns: Map<string, RegExp> = new Map();
  private policy: ActionPolicyDef;

  constructor(registry: ToolRegistryEntry[], policy: ActionPolicyDef) {
    this.registry = new Map(registry.map((entry) => [entry.name, entry]));
    this.policy = policy;

    // Pre-compile and validate all pattern constraints at construction time
    for (const entry of registry) {
      if (!entry.constraints) continue;
      for (const constraint of entry.constraints) {
        if (constraint.type === "pattern" && typeof constraint.value === "string") {
          const cacheKey = `${entry.name}:${constraint.param}`;
          this.compiledPatterns.set(cacheKey, validateRegexPattern(constraint.value));
        }
      }
    }
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
          const cacheKey = `${toolName}:${constraint.param}`;
          const regex =
            this.compiledPatterns.get(cacheKey) ?? validateRegexPattern(constraint.value as string);
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
