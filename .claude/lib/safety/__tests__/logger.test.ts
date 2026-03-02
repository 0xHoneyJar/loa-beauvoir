import { describe, it, expect } from "vitest";
import { createLogger, type LogLevel } from "../logger";
import { SecretRedactor } from "../secret-redactor";

// Helper: capture sink calls for assertion
function createCaptureSink() {
  const calls: { level: LogLevel; message: string; data?: unknown }[] = [];
  const sink = (level: LogLevel, message: string, data?: unknown) => {
    calls.push({ level, message, data });
  };
  return { calls, sink };
}

describe("BeauvoirLogger", () => {
  describe("Basic log methods", () => {
    it("emits debug messages when level is debug", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { level: "debug", sink });

      logger.debug("debug message");
      expect(calls).toHaveLength(1);
      expect(calls[0].level).toBe("debug");
      expect(calls[0].message).toBe("debug message");
    });

    it("emits info messages", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.info("info message");
      expect(calls).toHaveLength(1);
      expect(calls[0].level).toBe("info");
      expect(calls[0].message).toBe("info message");
    });

    it("emits warn messages", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.warn("warn message");
      expect(calls).toHaveLength(1);
      expect(calls[0].level).toBe("warn");
      expect(calls[0].message).toBe("warn message");
    });

    it("emits error messages", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.error("error message");
      expect(calls).toHaveLength(1);
      expect(calls[0].level).toBe("error");
      expect(calls[0].message).toBe("error message");
    });
  });

  describe("Message redaction", () => {
    it("redacts GitHub PAT tokens in messages", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.info("Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
      expect(calls).toHaveLength(1);
      expect(calls[0].message).toBe("Token: [REDACTED:github_pat]");
      expect(calls[0].message).not.toContain("ghp_");
    });

    it("redacts AWS keys in messages", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.warn("Key: AKIAIOSFODNN7EXAMPLE");
      expect(calls[0].message).toBe("Key: [REDACTED:aws_access_key]");
    });

    it("redacts multiple secrets in a single message", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.error("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 and AKIAIOSFODNN7EXAMPLE");
      expect(calls[0].message).toContain("[REDACTED:github_pat]");
      expect(calls[0].message).toContain("[REDACTED:aws_access_key]");
    });
  });

  describe("Data redaction", () => {
    it("redacts secrets in data objects", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.info("request", {
        url: "https://api.github.com",
        token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      });

      expect(calls).toHaveLength(1);
      const data = calls[0].data as Record<string, string>;
      expect(data.url).toBe("https://api.github.com");
      expect(data.token).toBe("[REDACTED:github_pat]");
    });

    it("redacts nested data structures", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.info("nested", {
        outer: {
          inner: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        },
      });

      const data = calls[0].data as any;
      expect(data.outer.inner).toBe("[REDACTED:github_pat]");
    });

    it("strips sensitive headers in data", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.info("headers", {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      });

      const data = calls[0].data as Record<string, string>;
      expect(data.authorization).toBe("[REDACTED:header]");
      expect(data["content-type"]).toBe("application/json");
    });

    it("does not pass data to sink when data is undefined", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.info("no data");
      expect(calls[0].data).toBeUndefined();
    });
  });

  describe("Error object redaction", () => {
    it("redacts Error objects passed as data at error level", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      const err = new Error("Failed with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
      logger.error("operation failed", err);

      expect(calls).toHaveLength(1);
      const redactedErr = calls[0].data as Error;
      expect(redactedErr).toBeInstanceOf(Error);
      expect(redactedErr.message).toBe("Failed with [REDACTED:github_pat]");
      expect(redactedErr.message).not.toContain("ghp_");
    });

    it("redacts Error objects at non-error levels via redactError", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { level: "debug", sink });

      const err = new Error("Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
      logger.warn("warning with error", err);

      const redactedErr = calls[0].data as Error;
      expect(redactedErr).toBeInstanceOf(Error);
      expect(redactedErr.message).toContain("[REDACTED:github_pat]");
    });

    it("redacts Error cause chain", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      const inner = new Error("Inner: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
      const outer = new Error("Outer failed");
      (outer as any).cause = inner;

      logger.error("chained error", outer);

      const redactedErr = calls[0].data as Error;
      expect(redactedErr.message).toBe("Outer failed");
      expect((redactedErr.cause as Error).message).toContain("[REDACTED:github_pat]");
    });
  });

  describe("Level filtering", () => {
    it("filters debug messages at info level (default)", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.debug("should not appear");
      expect(calls).toHaveLength(0);
    });

    it("allows info messages at info level", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.info("should appear");
      expect(calls).toHaveLength(1);
    });

    it("filters debug and info at warn level", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { level: "warn", sink });

      logger.debug("no");
      logger.info("no");
      logger.warn("yes");
      logger.error("yes");
      expect(calls).toHaveLength(2);
      expect(calls[0].level).toBe("warn");
      expect(calls[1].level).toBe("error");
    });

    it("only allows error at error level", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { level: "error", sink });

      logger.debug("no");
      logger.info("no");
      logger.warn("no");
      logger.error("yes");
      expect(calls).toHaveLength(1);
      expect(calls[0].level).toBe("error");
    });

    it("allows all messages at debug level", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { level: "debug", sink });

      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      expect(calls).toHaveLength(4);
    });

    it("falls back to info level for invalid level value", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      // Cast to bypass TypeScript to test runtime validation
      const logger = createLogger(redactor, { level: "invalid" as LogLevel, sink });

      logger.debug("should not appear");
      logger.info("should appear");
      expect(calls).toHaveLength(1);
      expect(calls[0].message).toBe("should appear");
    });
  });

  describe("Prefix formatting", () => {
    it("prepends prefix in brackets to messages", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { prefix: "audit-trail", sink });

      logger.info("checkpoint saved");
      expect(calls[0].message).toBe("[audit-trail] checkpoint saved");
    });

    it("does not add prefix when not configured", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { sink });

      logger.info("no prefix");
      expect(calls[0].message).toBe("no prefix");
    });

    it("redacts secrets that appear in the prefix", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      // Prefix containing a secret (should be redacted)
      const logger = createLogger(redactor, {
        prefix: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        sink,
      });

      logger.info("test");
      expect(calls[0].message).toContain("[REDACTED:github_pat]");
      expect(calls[0].message).not.toContain("ghp_");
    });

    it("redacts secrets in both prefix and message", () => {
      const redactor = new SecretRedactor();
      const { calls, sink } = createCaptureSink();
      const logger = createLogger(redactor, { prefix: "subsystem", sink });

      logger.info("Key: AKIAIOSFODNN7EXAMPLE");
      expect(calls[0].message).toBe("[subsystem] Key: [REDACTED:aws_access_key]");
    });
  });
});
