/**
 * SecretRedactor - Pattern-based secret detection and redaction for production hardening
 *
 * Provides three core operations:
 * - redact(): string sanitization with typed placeholders
 * - redactAny(): deep object/array walking with header stripping
 * - redactError(): error chain sanitization
 */

export interface RedactionPattern {
  name: string;
  pattern: RegExp;
  replacement: string | ((...args: any[]) => string);
}

// Sensitive HTTP headers that should be stripped
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "x-github-token",
  "set-cookie",
]);

// Built-in secret patterns ordered most-specific-first
const BUILTIN_PATTERNS: RedactionPattern[] = [
  {
    name: "github_fine_grained_pat",
    pattern: /github_pat_[A-Za-z0-9_]{22,}/g,
    replacement: "[REDACTED:github_fine_grained_pat]",
  },
  {
    name: "github_pat",
    pattern: /ghp_[A-Za-z0-9]{36}/g,
    replacement: "[REDACTED:github_pat]",
  },
  {
    name: "github_server_token",
    pattern: /ghs_[A-Za-z0-9]{36}/g,
    replacement: "[REDACTED:github_server_token]",
  },
  {
    name: "github_oauth",
    pattern: /gho_[A-Za-z0-9]{36}/g,
    replacement: "[REDACTED:github_oauth]",
  },
  {
    name: "github_app_installation",
    pattern: /(ghu_[A-Za-z0-9]{36}|v1\.[0-9a-f]{40})/g,
    replacement: "[REDACTED:github_app_installation]",
  },
  {
    name: "aws_access_key",
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "[REDACTED:aws_access_key]",
  },
  {
    name: "generic_api_key",
    pattern: /(?:key|token|api_key|apikey)=([A-Za-z0-9_\-]{32,})/gi,
    replacement: (match: string, captured: string) =>
      match.replace(captured, "[REDACTED:generic_api_key]"),
  },
];

const MAX_DEPTH = 10;

export class SecretRedactor {
  private patterns: RedactionPattern[];

  constructor(extraPatterns: RedactionPattern[] = []) {
    // Combine built-in and extra patterns, maintaining specificity order
    this.patterns = [...BUILTIN_PATTERNS, ...extraPatterns];
  }

  /**
   * Redact secrets from a string, replacing matches with typed placeholders
   */
  redact(text: string): string {
    let result = text;
    for (const pattern of this.patterns) {
      if (typeof pattern.replacement === "function") {
        result = result.replace(pattern.pattern, pattern.replacement as any);
      } else {
        result = result.replace(pattern.pattern, pattern.replacement);
      }
    }
    return result;
  }

  /**
   * Deep-walk objects/arrays and redact string leaves, strip sensitive headers
   */
  redactAny(value: unknown, depth = 0, seen = new WeakSet()): unknown {
    // Max depth guard
    if (depth >= MAX_DEPTH) {
      return "[DEPTH_LIMIT_EXCEEDED]";
    }

    // Handle primitives
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return this.redact(value);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (value instanceof Date) {
      return value;
    }

    if (value instanceof Error) {
      return this.redactError(value);
    }

    // Cycle detection
    if (typeof value === "object") {
      if (seen.has(value)) {
        return "[CIRCULAR]";
      }
      seen.add(value);
    }

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((item) => this.redactAny(item, depth + 1, seen));
    }

    // Handle Map instances — redact values, preserve structure
    if (value instanceof Map) {
      const result = new Map();
      for (const [key, val] of value) {
        const redactedKey = typeof key === "string" ? this.redact(key) : key;
        result.set(redactedKey, this.redactAny(val, depth + 1, seen));
      }
      return result;
    }

    // Handle Set instances — redact each element
    if (value instanceof Set) {
      const result = new Set();
      for (const item of value) {
        result.add(this.redactAny(item, depth + 1, seen));
      }
      return result;
    }

    // Handle plain objects
    if (typeof value === "object" && value.constructor === Object) {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_HEADERS.has(lowerKey)) {
          result[key] = "[REDACTED:header]";
        } else {
          result[key] = this.redactAny(val, depth + 1, seen);
        }
      }
      return result;
    }

    // Fallback for non-plain objects (class instances, URL, Headers, etc.)
    // Walk enumerable own properties to catch secrets in response objects
    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_HEADERS.has(lowerKey)) {
          result[key] = "[REDACTED:header]";
        } else {
          result[key] = this.redactAny(val, depth + 1, seen);
        }
      }
      return result;
    }

    return value;
  }

  /**
   * Create a new Error with redacted message and cause chain
   */
  redactError(err: Error): Error {
    // Create a new error of the same type if possible
    const ErrorConstructor = err.constructor as ErrorConstructor;
    const redactedMessage = this.redact(err.message);

    let newError: Error;
    try {
      newError = new ErrorConstructor(redactedMessage);
    } catch {
      // Fallback to base Error if constructor fails
      newError = new Error(redactedMessage);
    }

    // Copy properties
    newError.name = err.name;
    newError.stack = err.stack ? this.redact(err.stack) : undefined;

    // Recursively handle cause chain
    if (err.cause instanceof Error) {
      newError.cause = this.redactError(err.cause);
    } else if (err.cause !== undefined) {
      newError.cause = this.redactAny(err.cause);
    }

    return newError;
  }
}

interface ErrorConstructor {
  new (message: string): Error;
}
