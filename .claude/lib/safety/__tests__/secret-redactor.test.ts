import { describe, it, expect } from "vitest";
import { SecretRedactor, type RedactionPattern } from "../secret-redactor";

describe("SecretRedactor", () => {
  describe("Built-in patterns", () => {
    it("redacts GitHub PAT (ghp_)", () => {
      const redactor = new SecretRedactor();
      const input = "Token: ghp_1234567890123456789012345678901234AB";
      const output = redactor.redact(input);
      expect(output).toBe("Token: [REDACTED:github_pat]");
      expect(output).not.toContain("ghp_");
    });

    it("redacts GitHub Server token (ghs_)", () => {
      const redactor = new SecretRedactor();
      const input = "Server token: ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const output = redactor.redact(input);
      expect(output).toBe("Server token: [REDACTED:github_server_token]");
      expect(output).not.toContain("ghs_");
    });

    it("redacts GitHub OAuth token (gho_)", () => {
      const redactor = new SecretRedactor();
      const input = "OAuth: gho_abcdefghijklmnopqrstuvwxyz0123456789";
      const output = redactor.redact(input);
      expect(output).toBe("OAuth: [REDACTED:github_oauth]");
      expect(output).not.toContain("gho_");
    });

    it("redacts GitHub App installation token (ghu_)", () => {
      const redactor = new SecretRedactor();
      const input = "App token: ghu_XYZ123abc456def789GHI012jkl345mno678";
      const output = redactor.redact(input);
      expect(output).toBe("App token: [REDACTED:github_app_installation]");
      expect(output).not.toContain("ghu_");
    });

    it("redacts GitHub App installation token (v1. format)", () => {
      const redactor = new SecretRedactor();
      const input = "App: v1." + "a".repeat(40);
      const output = redactor.redact(input);
      expect(output).toBe("App: [REDACTED:github_app_installation]");
      expect(output).not.toContain("v1.");
    });

    it("redacts AWS Access Key", () => {
      const redactor = new SecretRedactor();
      const input = "AWS: AKIAIOSFODNN7EXAMPLE";
      const output = redactor.redact(input);
      expect(output).toBe("AWS: [REDACTED:aws_access_key]");
      expect(output).not.toContain("AKIA");
    });

    it("redacts generic API key in URL", () => {
      const redactor = new SecretRedactor();
      const input = "URL: https://api.example.com?key=abcdef1234567890abcdef1234567890abcdef12";
      const output = redactor.redact(input);
      expect(output).toContain("[REDACTED:generic_api_key]");
      expect(output).not.toContain("abcdef1234567890abcdef1234567890abcdef12");
    });

    it("redacts generic token parameter", () => {
      const redactor = new SecretRedactor();
      const input = "Auth: token=xyz9876543210xyz9876543210xyz9876543210";
      const output = redactor.redact(input);
      expect(output).toContain("[REDACTED:generic_api_key]");
      expect(output).not.toContain("xyz9876543210xyz9876543210xyz9876543210");
    });
  });

  describe("Pattern specificity ordering", () => {
    it("applies most specific pattern first (github pat before generic)", () => {
      const redactor = new SecretRedactor();
      const input = "key=ghp_1234567890123456789012345678901234AB";
      const output = redactor.redact(input);
      // Should match github_pat pattern, not generic
      expect(output).toContain("[REDACTED:github_pat]");
      expect(output).not.toContain("[REDACTED:generic_api_key]");
    });

    it("handles multiple different secrets in one string", () => {
      const redactor = new SecretRedactor();
      const input = "ghp_1234567890123456789012345678901234AB and AKIAIOSFODNN7EXAMPLE";
      const output = redactor.redact(input);
      expect(output).toContain("[REDACTED:github_pat]");
      expect(output).toContain("[REDACTED:aws_access_key]");
    });
  });

  describe("redactAny - deep object traversal", () => {
    it("redacts string leaves in nested objects", () => {
      const redactor = new SecretRedactor();
      const input = {
        user: "alice",
        auth: {
          token: "ghp_1234567890123456789012345678901234AB",
          type: "bearer",
        },
      };
      const output = redactor.redactAny(input) as typeof input;
      expect(output.user).toBe("alice");
      expect(output.auth.token).toBe("[REDACTED:github_pat]");
      expect(output.auth.type).toBe("bearer");
    });

    it("redacts strings in arrays", () => {
      const redactor = new SecretRedactor();
      const input = ["public", "ghp_1234567890123456789012345678901234AB", "data"];
      const output = redactor.redactAny(input) as string[];
      expect(output[0]).toBe("public");
      expect(output[1]).toBe("[REDACTED:github_pat]");
      expect(output[2]).toBe("data");
    });

    it("handles null and undefined", () => {
      const redactor = new SecretRedactor();
      expect(redactor.redactAny(null)).toBeNull();
      expect(redactor.redactAny(undefined)).toBeUndefined();
    });

    it("preserves numbers, booleans, and Dates", () => {
      const redactor = new SecretRedactor();
      expect(redactor.redactAny(42)).toBe(42);
      expect(redactor.redactAny(true)).toBe(true);
      const date = new Date("2024-01-01");
      expect(redactor.redactAny(date)).toBe(date);
    });

    it("handles deeply nested structures", () => {
      const redactor = new SecretRedactor();
      const input = {
        level1: {
          level2: {
            level3: {
              level4: {
                secret: "ghp_1234567890123456789012345678901234AB",
              },
            },
          },
        },
      };
      const output = redactor.redactAny(input) as typeof input;
      expect(output.level1.level2.level3.level4.secret).toBe("[REDACTED:github_pat]");
    });

    it("stops at max depth (10)", () => {
      const redactor = new SecretRedactor();
      // Build structure with depth 11
      let nested: any = { secret: "ghp_1234567890123456789012345678901234AB" };
      for (let i = 0; i < 10; i++) {
        nested = { next: nested };
      }
      const output = redactor.redactAny(nested) as any;
      // Navigate to depth 9 (should work)
      let current = output;
      for (let i = 0; i < 9; i++) {
        current = current.next;
      }
      // At depth 10, should hit limit
      expect(current.next).toBe("[DEPTH_LIMIT_EXCEEDED]");
    });

    it("detects circular references", () => {
      const redactor = new SecretRedactor();
      const circular: any = { name: "root" };
      circular.self = circular;
      const output = redactor.redactAny(circular) as any;
      expect(output.name).toBe("root");
      expect(output.self).toBe("[CIRCULAR]");
    });

    it("handles Error instances embedded in objects", () => {
      const redactor = new SecretRedactor();
      const error = new Error("Failed with token ghp_1234567890123456789012345678901234AB");
      const input = {
        status: "error",
        error,
      };
      const output = redactor.redactAny(input) as any;
      expect(output.status).toBe("error");
      expect(output.error).toBeInstanceOf(Error);
      expect(output.error.message).toContain("[REDACTED:github_pat]");
    });
  });

  describe("Header stripping", () => {
    it("strips authorization header (lowercase)", () => {
      const redactor = new SecretRedactor();
      const input = {
        authorization: "Bearer ghp_1234567890123456789012345678901234AB",
        "content-type": "application/json",
      };
      const output = redactor.redactAny(input) as typeof input;
      expect(output.authorization).toBe("[REDACTED:header]");
      expect(output["content-type"]).toBe("application/json");
    });

    it("strips authorization header (mixed case)", () => {
      const redactor = new SecretRedactor();
      const input = {
        Authorization: "Bearer token123",
      };
      const output = redactor.redactAny(input) as any;
      expect(output.Authorization).toBe("[REDACTED:header]");
    });

    it("strips x-api-key header", () => {
      const redactor = new SecretRedactor();
      const input = { "x-api-key": "secret123" };
      const output = redactor.redactAny(input) as any;
      expect(output["x-api-key"]).toBe("[REDACTED:header]");
    });

    it("strips cookie header", () => {
      const redactor = new SecretRedactor();
      const input = { cookie: "session=abc123; token=xyz789" };
      const output = redactor.redactAny(input) as any;
      expect(output.cookie).toBe("[REDACTED:header]");
    });

    it("strips x-github-token header", () => {
      const redactor = new SecretRedactor();
      const input = { "x-github-token": "ghp_1234567890123456789012345678901234AB" };
      const output = redactor.redactAny(input) as any;
      expect(output["x-github-token"]).toBe("[REDACTED:header]");
    });

    it("strips set-cookie header", () => {
      const redactor = new SecretRedactor();
      const input = { "set-cookie": "session=xyz; HttpOnly" };
      const output = redactor.redactAny(input) as any;
      expect(output["set-cookie"]).toBe("[REDACTED:header]");
    });

    it("case-insensitive header detection", () => {
      const redactor = new SecretRedactor();
      const input = {
        AUTHORIZATION: "Bearer token",
        "X-API-KEY": "secret",
        Cookie: "session=abc",
      };
      const output = redactor.redactAny(input) as any;
      expect(output.AUTHORIZATION).toBe("[REDACTED:header]");
      expect(output["X-API-KEY"]).toBe("[REDACTED:header]");
      expect(output.Cookie).toBe("[REDACTED:header]");
    });
  });

  describe("Error chain redaction", () => {
    it("redacts error message", () => {
      const redactor = new SecretRedactor();
      const error = new Error("Auth failed: ghp_1234567890123456789012345678901234AB");
      const redacted = redactor.redactError(error);
      expect(redacted.message).toBe("Auth failed: [REDACTED:github_pat]");
      expect(redacted.message).not.toContain("ghp_");
    });

    it("redacts error stack", () => {
      const redactor = new SecretRedactor();
      const error = new Error("Failed");
      error.stack = "Error: Failed with ghp_1234567890123456789012345678901234AB\n  at test.ts:10";
      const redacted = redactor.redactError(error);
      expect(redacted.stack).toContain("[REDACTED:github_pat]");
      expect(redacted.stack).not.toContain("ghp_");
    });

    it("preserves error name", () => {
      const redactor = new SecretRedactor();
      const error = new Error("test");
      error.name = "CustomError";
      const redacted = redactor.redactError(error);
      expect(redacted.name).toBe("CustomError");
    });

    it("recursively redacts error cause chain", () => {
      const redactor = new SecretRedactor();
      const innerError = new Error("Inner: ghp_1234567890123456789012345678901234AB");
      const outerError = new Error("Outer: AKIAIOSFODNN7EXAMPLE");
      (outerError as any).cause = innerError;
      const redacted = redactor.redactError(outerError);
      expect(redacted.message).toContain("[REDACTED:aws_access_key]");
      expect((redacted.cause as Error).message).toContain("[REDACTED:github_pat]");
    });

    it("handles non-Error cause via redactAny", () => {
      const redactor = new SecretRedactor();
      const error = new Error("Failed");
      (error as any).cause = { token: "ghp_1234567890123456789012345678901234AB" };
      const redacted = redactor.redactError(error);
      expect((redacted.cause as any).token).toBe("[REDACTED:github_pat]");
    });

    it("preserves Error subclass types", () => {
      const redactor = new SecretRedactor();
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "CustomError";
        }
      }
      const error = new CustomError("Secret: ghp_1234567890123456789012345678901234AB");
      const redacted = redactor.redactError(error);
      expect(redacted).toBeInstanceOf(Error);
      expect(redacted.name).toBe("CustomError");
      expect(redacted.message).toContain("[REDACTED:github_pat]");
    });
  });

  describe("Edge cases", () => {
    it("handles empty string", () => {
      const redactor = new SecretRedactor();
      expect(redactor.redact("")).toBe("");
    });

    it("handles string with no secrets", () => {
      const redactor = new SecretRedactor();
      const input = "Just a normal string";
      expect(redactor.redact(input)).toBe(input);
    });

    it("handles empty object", () => {
      const redactor = new SecretRedactor();
      const input = {};
      const output = redactor.redactAny(input);
      expect(output).toEqual({});
    });

    it("handles empty array", () => {
      const redactor = new SecretRedactor();
      const input: any[] = [];
      const output = redactor.redactAny(input);
      expect(output).toEqual([]);
    });

    it("handles object with only non-string values", () => {
      const redactor = new SecretRedactor();
      const input = { count: 42, active: true, created: new Date() };
      const output = redactor.redactAny(input);
      expect(output).toEqual(input);
    });
  });

  describe("Custom extra patterns", () => {
    it("applies extra patterns", () => {
      const customPattern: RedactionPattern = {
        name: "custom_token",
        pattern: /CUSTOM_[A-Z0-9]{16}/g,
        replacement: "[REDACTED:custom_token]",
      };
      const redactor = new SecretRedactor([customPattern]);
      const input = "Token: CUSTOM_ABCD1234EFGH5678";
      const output = redactor.redact(input);
      expect(output).toBe("Token: [REDACTED:custom_token]");
    });

    it("extra patterns applied after built-in patterns", () => {
      const customPattern: RedactionPattern = {
        name: "custom",
        pattern: /SECRET_[A-Z]+/g,
        replacement: "[REDACTED:custom]",
      };
      const redactor = new SecretRedactor([customPattern]);
      const input = "ghp_1234567890123456789012345678901234AB and SECRET_XYZ";
      const output = redactor.redact(input);
      expect(output).toContain("[REDACTED:github_pat]");
      expect(output).toContain("[REDACTED:custom]");
    });

    it("supports functional replacement in extra patterns", () => {
      const customPattern: RedactionPattern = {
        name: "email",
        pattern: /([a-z]+)@example\.com/g,
        replacement: (match: string, username: string) => `${username}@[REDACTED:email]`,
      };
      const redactor = new SecretRedactor([customPattern]);
      const input = "Contact: alice@example.com";
      const output = redactor.redact(input);
      expect(output).toBe("Contact: alice@[REDACTED:email]");
    });
  });

  describe("Pattern ordering determinism", () => {
    it("applies patterns in consistent order across multiple calls", () => {
      const redactor = new SecretRedactor();
      const input = "key=ghp_1234567890123456789012345678901234AB";
      const output1 = redactor.redact(input);
      const output2 = redactor.redact(input);
      expect(output1).toBe(output2);
      expect(output1).toContain("[REDACTED:github_pat]");
    });
  });

  describe("Performance - typical audit record", () => {
    it("redacts typical nested object in reasonable time", () => {
      const redactor = new SecretRedactor();
      const input = {
        seq: 42,
        ts: Date.now(),
        jobId: "job-123",
        action: "create_pull_request_review",
        params: {
          owner: "test",
          repo: "repo",
          pull_number: 15,
          body: "Review comment",
          headers: {
            authorization: "Bearer ghp_1234567890123456789012345678901234AB",
            "content-type": "application/json",
          },
        },
        result: "success",
      };
      const start = performance.now();
      const output = redactor.redactAny(input);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(5); // <5ms target from SDD
      expect((output as any).params.headers.authorization).toBe("[REDACTED:header]");
    });
  });
});
