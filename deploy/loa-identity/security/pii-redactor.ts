/**
 * PII Redactor - Privacy-preserving content filtering
 *
 * Implements pattern-based and entropy-based detection to redact sensitive
 * data before storage. Supports 15+ patterns for API keys, PII, and secrets.
 *
 * @deprecated Superseded by `.claude/lib/safety/secret-redactor.ts` which provides
 * framework-grade redaction with deep object walking and error chain sanitization.
 * Use SecretRedactor from `.claude/lib/safety/secret-redactor` for new code.
 *
 * @module deploy/loa-identity/security/pii-redactor
 */

export interface RedactionResult {
  content: string;
  blocked: boolean;
  reason?: string;
  redactions: RedactionRecord[];
}

export interface RedactionRecord {
  type: string;
  original: string;
  replacement: string;
  position: number;
  method: "pattern" | "entropy";
}

export interface PatternSpec {
  regex: RegExp;
  replacement: string;
  block?: boolean;
}

export interface PIIRedactorConfig {
  entropyThreshold: number;
  minEntropyLength: number;
  customPatterns?: Map<string, PatternSpec>;
}

/**
 * PIIRedactor scans content for sensitive data and redacts or blocks it.
 * Uses both pattern matching and entropy-based detection.
 */
export class PIIRedactor {
  private patterns: Map<string, PatternSpec>;
  private config: PIIRedactorConfig;

  constructor(config?: Partial<PIIRedactorConfig>) {
    this.config = {
      entropyThreshold: config?.entropyThreshold ?? 4.5,
      minEntropyLength: config?.minEntropyLength ?? 20,
    };

    this.patterns = new Map([
      // === API Keys ===
      [
        "api_key_openai",
        {
          regex: /sk-proj-[A-Za-z0-9_-]{48,}/g,
          replacement: "[REDACTED_API_KEY]",
        },
      ],
      [
        "api_key_anthropic",
        {
          regex: /sk-ant-api[A-Za-z0-9_-]{40,}/g,
          replacement: "[REDACTED_API_KEY]",
        },
      ],
      [
        "api_key_github",
        {
          regex: /ghp_[A-Za-z0-9]{36,}/g,
          replacement: "[REDACTED_GITHUB_TOKEN]",
        },
      ],
      [
        "api_key_github_oauth",
        {
          regex: /gho_[A-Za-z0-9]{36,}/g,
          replacement: "[REDACTED_GITHUB_TOKEN]",
        },
      ],
      [
        "api_key_github_pat",
        {
          regex: /github_pat_[A-Za-z0-9_]{22,}/g,
          replacement: "[REDACTED_GITHUB_TOKEN]",
        },
      ],
      [
        "api_key_stripe_live",
        {
          regex: /sk_live_[A-Za-z0-9]{24,}/g,
          replacement: "[REDACTED_STRIPE_KEY]",
        },
      ],
      [
        "api_key_stripe_test",
        {
          regex: /sk_test_[A-Za-z0-9]{24,}/g,
          replacement: "[REDACTED_STRIPE_KEY]",
        },
      ],
      [
        "api_key_slack",
        {
          regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
          replacement: "[REDACTED_SLACK_TOKEN]",
        },
      ],
      [
        "api_key_discord",
        {
          regex: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/g,
          replacement: "[REDACTED_DISCORD_TOKEN]",
        },
      ],

      // === Cloud Provider Keys ===
      // AWS Access Key ID - MUST start with AKIA (active key) or ASIA (STS token)
      [
        "aws_access_key",
        {
          regex: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
          replacement: "[REDACTED_AWS_KEY]",
        },
      ],
      // AWS Secret - 40 chars, typically base64-ish, requires context
      // Only match if preceded by common assignment patterns
      [
        "aws_secret",
        {
          regex:
            /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secret_key|secretAccessKey)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
          replacement: "[REDACTED_AWS_SECRET]",
        },
      ],
      // GCP API key - starts with AIza
      [
        "gcp_key",
        {
          regex: /\bAIza[A-Za-z0-9_-]{35}\b/g,
          replacement: "[REDACTED_GCP_KEY]",
        },
      ],
      // Cloudflare API Token - specific format with prefix
      // Global API Key is 37 chars hex, API Token is different format
      [
        "cloudflare_api_token",
        {
          regex: /\b[A-Za-z0-9_-]{40,45}(?=\s*$|\s*['"]|\s*[,}\]])/gm,
          replacement: "[REDACTED_CF_TOKEN]",
        },
      ],
      // Cloudflare Global API Key - 37 hex chars with context
      [
        "cloudflare_global_key",
        {
          regex:
            /(?:CF_API_KEY|CLOUDFLARE_API_KEY|cloudflare_api_key|X-Auth-Key)\s*[=:]\s*['"]?([a-f0-9]{37})['"]?/gi,
          replacement: "[REDACTED_CF_KEY]",
        },
      ],

      // === Personal Information ===
      [
        "email",
        {
          regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
          replacement: "[REDACTED_EMAIL]",
        },
      ],
      [
        "phone_us",
        {
          regex: /\+?1?[-.\s]?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
          replacement: "[REDACTED_PHONE]",
        },
      ],
      [
        "phone_intl",
        {
          regex: /\+[1-9]\d{1,14}/g,
          replacement: "[REDACTED_PHONE]",
        },
      ],
      [
        "ssn",
        {
          regex: /\b\d{3}-\d{2}-\d{4}\b/g,
          replacement: "[REDACTED_SSN]",
        },
      ],
      [
        "credit_card",
        {
          regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
          replacement: "[REDACTED_CC]",
        },
      ],

      // === Credentials in URLs ===
      [
        "password_in_url",
        {
          regex: /:\/\/([^:]+):([^@]+)@/g,
          replacement: "://$1:[REDACTED_PASSWORD]@",
        },
      ],

      // === Private Keys (BLOCK) ===
      [
        "private_key_pem",
        {
          regex:
            /-----BEGIN\s+(RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+|EC\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----/g,
          replacement: "",
          block: true,
        },
      ],

      // === JWT Tokens ===
      [
        "jwt_token",
        {
          regex: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
          replacement: "[REDACTED_JWT]",
        },
      ],

      // === Database Connection Strings ===
      [
        "db_connection",
        {
          regex: /(mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@[^\s'"]+/gi,
          replacement: "[REDACTED_DB_CONNECTION]",
        },
      ],
    ]);

    // Merge custom patterns
    if (config?.customPatterns) {
      for (const [key, spec] of config.customPatterns) {
        this.patterns.set(key, spec);
      }
    }
  }

  /**
   * Calculate Shannon entropy of a string
   * Higher entropy = more random = more likely a secret
   */
  private calculateEntropy(str: string): number {
    const freq = new Map<string, number>();
    for (const char of str) {
      freq.set(char, (freq.get(char) || 0) + 1);
    }
    let entropy = 0;
    for (const count of freq.values()) {
      const p = count / str.length;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  /**
   * Check if a string looks like a high-entropy secret
   */
  private isHighEntropySecret(str: string): boolean {
    if (str.length < this.config.minEntropyLength) return false;

    // Skip common high-entropy but non-secret patterns
    if (/^[0-9a-f-]{32,}$/i.test(str)) return false; // UUIDs
    if (/^\d+$/.test(str)) return false; // Pure numbers
    if (/^[A-Z_]+$/.test(str)) return false; // CONSTANT_NAMES
    if (str.includes("REDACTED")) return false; // Already redacted

    const entropy = this.calculateEntropy(str);
    return entropy >= this.config.entropyThreshold;
  }

  /**
   * Process content and redact sensitive data
   */
  process(content: string): RedactionResult {
    const redactions: RedactionRecord[] = [];
    let result = content;

    // Phase 1: Pattern-based detection
    for (const [type, { regex, replacement, block }] of this.patterns) {
      // Clone regex to reset lastIndex
      const clonedRegex = new RegExp(regex.source, regex.flags);
      const matches = [...content.matchAll(clonedRegex)];

      for (const match of matches) {
        if (block) {
          return {
            content: "",
            blocked: true,
            reason: `Contains ${type} - blocked entirely`,
            redactions: [],
          };
        }

        redactions.push({
          type,
          original: match[0].substring(0, 10) + "...",
          replacement,
          position: match.index!,
          method: "pattern",
        });
      }

      result = result.replace(clonedRegex, replacement);
    }

    // Phase 2: Entropy-based detection for unknown secrets
    const entropyPattern = /[A-Za-z0-9_\-+/=]{20,}/g;
    const entropyMatches = [...result.matchAll(entropyPattern)];

    for (const match of entropyMatches) {
      const str = match[0];

      // Skip if already redacted
      if (str.includes("REDACTED")) continue;

      if (this.isHighEntropySecret(str)) {
        redactions.push({
          type: "high_entropy_secret",
          original: str.substring(0, 10) + "...",
          replacement: "[REDACTED_HIGH_ENTROPY]",
          position: match.index!,
          method: "entropy",
        });

        result = result.replace(str, "[REDACTED_HIGH_ENTROPY]");
      }
    }

    return {
      content: result,
      blocked: false,
      redactions,
    };
  }

  /**
   * Add custom patterns at runtime
   */
  addPattern(name: string, spec: PatternSpec): void {
    this.patterns.set(name, spec);
  }

  /**
   * Remove a pattern
   */
  removePattern(name: string): boolean {
    return this.patterns.delete(name);
  }

  /**
   * Get list of pattern names
   */
  getPatternNames(): string[] {
    return Array.from(this.patterns.keys());
  }

  /**
   * Check if content contains any sensitive data (without modifying)
   */
  containsSensitiveData(content: string): boolean {
    const result = this.process(content);
    return result.blocked || result.redactions.length > 0;
  }

  /**
   * Get entropy threshold
   */
  getEntropyThreshold(): number {
    return this.config.entropyThreshold;
  }

  /**
   * Set entropy threshold
   */
  setEntropyThreshold(threshold: number): void {
    this.config.entropyThreshold = threshold;
  }
}
