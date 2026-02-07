import { describe, it, expect } from "vitest";
import { ToolValidator, type ToolRegistryEntry, type ActionPolicyDef } from "../tool-validator";

describe("ToolValidator", () => {
  describe("validateRegistry", () => {
    it("returns valid when all policy tools exist in MCP", () => {
      const registry: ToolRegistryEntry[] = [
        { name: "read_file", capability: "read" },
        { name: "write_file", capability: "write" },
      ];
      const policy: ActionPolicyDef = {
        allow: ["read_file", "write_file"],
      };
      const validator = new ToolValidator(registry, policy);

      const result = validator.validateRegistry(["read_file", "write_file"]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("returns error for unknown tool in policy.allow", () => {
      const registry: ToolRegistryEntry[] = [{ name: "read_file", capability: "read" }];
      const policy: ActionPolicyDef = {
        allow: ["read_file", "nonexistent_tool"],
      };
      const validator = new ToolValidator(registry, policy);

      const result = validator.validateRegistry(["read_file"]);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("nonexistent_tool");
    });

    it("returns warning for unregistered MCP tool", () => {
      const registry: ToolRegistryEntry[] = [{ name: "read_file", capability: "read" }];
      const policy: ActionPolicyDef = {
        allow: ["read_file"],
      };
      const validator = new ToolValidator(registry, policy);

      const result = validator.validateRegistry(["read_file", "unknown_mcp_tool"]);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("unknown_mcp_tool");
    });

    it("does not error for denied tools present in MCP list", () => {
      const registry: ToolRegistryEntry[] = [{ name: "read_file", capability: "read" }];
      const policy: ActionPolicyDef = {
        allow: ["read_file"],
        deny: ["dangerous_tool"],
      };
      const validator = new ToolValidator(registry, policy);

      const result = validator.validateRegistry(["read_file", "dangerous_tool"]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      // Denied tool is accounted for, so no warning either
      expect(result.warnings).toHaveLength(0);
    });

    it("handles empty MCP tool list", () => {
      const registry: ToolRegistryEntry[] = [];
      const policy: ActionPolicyDef = {
        allow: ["some_tool"],
      };
      const validator = new ToolValidator(registry, policy);

      const result = validator.validateRegistry([]);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("some_tool");
    });

    it("handles empty policy allow list", () => {
      const registry: ToolRegistryEntry[] = [];
      const policy: ActionPolicyDef = { allow: [] };
      const validator = new ToolValidator(registry, policy);

      const result = validator.validateRegistry(["tool_a"]);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("tool_a");
    });
  });

  describe("validateParams — must_be", () => {
    it("passes when param value matches exactly", () => {
      const registry: ToolRegistryEntry[] = [
        {
          name: "create_pr",
          capability: "write",
          constraints: [{ type: "must_be", param: "draft", value: true }],
        },
      ];
      const policy: ActionPolicyDef = { allow: ["create_pr"] };
      const validator = new ToolValidator(registry, policy);

      const violations = validator.validateParams("create_pr", { draft: true });
      expect(violations).toHaveLength(0);
    });

    it("fails when param value does not match", () => {
      const registry: ToolRegistryEntry[] = [
        {
          name: "create_pr",
          capability: "write",
          constraints: [{ type: "must_be", param: "draft", value: true }],
        },
      ];
      const policy: ActionPolicyDef = { allow: ["create_pr"] };
      const validator = new ToolValidator(registry, policy);

      const violations = validator.validateParams("create_pr", { draft: false });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("draft");
      expect(violations[0]).toContain("true");
    });
  });

  describe("validateParams — pattern", () => {
    it("passes when param matches regex pattern", () => {
      const registry: ToolRegistryEntry[] = [
        {
          name: "get_file",
          capability: "read",
          constraints: [{ type: "pattern", param: "path", value: "^src/.*\\.ts$" }],
        },
      ];
      const policy: ActionPolicyDef = { allow: ["get_file"] };
      const validator = new ToolValidator(registry, policy);

      const violations = validator.validateParams("get_file", { path: "src/index.ts" });
      expect(violations).toHaveLength(0);
    });

    it("fails when param does not match regex pattern", () => {
      const registry: ToolRegistryEntry[] = [
        {
          name: "get_file",
          capability: "read",
          constraints: [{ type: "pattern", param: "path", value: "^src/.*\\.ts$" }],
        },
      ];
      const policy: ActionPolicyDef = { allow: ["get_file"] };
      const validator = new ToolValidator(registry, policy);

      const violations = validator.validateParams("get_file", { path: "/etc/passwd" });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("path");
      expect(violations[0]).toContain("pattern");
    });

    it("fails when param is not a string", () => {
      const registry: ToolRegistryEntry[] = [
        {
          name: "get_file",
          capability: "read",
          constraints: [{ type: "pattern", param: "path", value: "^src/" }],
        },
      ];
      const policy: ActionPolicyDef = { allow: ["get_file"] };
      const validator = new ToolValidator(registry, policy);

      const violations = validator.validateParams("get_file", { path: 123 });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("path");
    });
  });

  describe("validateParams — allowlist", () => {
    it("passes when param is in the allowlist", () => {
      const registry: ToolRegistryEntry[] = [
        {
          name: "deploy",
          capability: "admin",
          constraints: [{ type: "allowlist", param: "env", value: ["staging", "production"] }],
        },
      ];
      const policy: ActionPolicyDef = { allow: ["deploy"] };
      const validator = new ToolValidator(registry, policy);

      const violations = validator.validateParams("deploy", { env: "staging" });
      expect(violations).toHaveLength(0);
    });

    it("fails when param is not in the allowlist", () => {
      const registry: ToolRegistryEntry[] = [
        {
          name: "deploy",
          capability: "admin",
          constraints: [{ type: "allowlist", param: "env", value: ["staging", "production"] }],
        },
      ];
      const policy: ActionPolicyDef = { allow: ["deploy"] };
      const validator = new ToolValidator(registry, policy);

      const violations = validator.validateParams("deploy", { env: "development" });
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("env");
      expect(violations[0]).toContain("staging");
      expect(violations[0]).toContain("production");
    });
  });

  describe("validateParams — edge cases", () => {
    it("returns no violations for tool with no constraints", () => {
      const registry: ToolRegistryEntry[] = [{ name: "simple_tool", capability: "read" }];
      const policy: ActionPolicyDef = { allow: ["simple_tool"] };
      const validator = new ToolValidator(registry, policy);

      const violations = validator.validateParams("simple_tool", { any: "value" });
      expect(violations).toHaveLength(0);
    });

    it("returns no violations for unknown tool name", () => {
      const registry: ToolRegistryEntry[] = [];
      const policy: ActionPolicyDef = { allow: [] };
      const validator = new ToolValidator(registry, policy);

      const violations = validator.validateParams("unknown", { any: "value" });
      expect(violations).toHaveLength(0);
    });

    it("handles multiple constraint types on one tool", () => {
      const registry: ToolRegistryEntry[] = [
        {
          name: "complex_tool",
          capability: "write",
          constraints: [
            { type: "must_be", param: "draft", value: true },
            { type: "pattern", param: "repo", value: "^openclaw/" },
            { type: "allowlist", param: "action", value: ["merge", "rebase"] },
          ],
        },
      ];
      const policy: ActionPolicyDef = { allow: ["complex_tool"] };
      const validator = new ToolValidator(registry, policy);

      // All pass
      const noViolations = validator.validateParams("complex_tool", {
        draft: true,
        repo: "openclaw/main",
        action: "merge",
      });
      expect(noViolations).toHaveLength(0);

      // All fail
      const allViolations = validator.validateParams("complex_tool", {
        draft: false,
        repo: "evil/repo",
        action: "force-push",
      });
      expect(allViolations).toHaveLength(3);
      expect(allViolations[0]).toContain("draft");
      expect(allViolations[1]).toContain("repo");
      expect(allViolations[2]).toContain("action");
    });
  });
});
