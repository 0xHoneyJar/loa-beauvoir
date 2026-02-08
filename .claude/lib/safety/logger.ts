/**
 * BeauvoirLogger - Centralized logging with automatic secret redaction
 *
 * All framework subsystems MUST use this logger to ensure secrets
 * are never leaked to console output, log files, or external sinks.
 */

import type { SecretRedactor } from "./secret-redactor";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface BeauvoirLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  prefix?: string;
  sink?: (level: LogLevel, message: string, data?: unknown) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const DEFAULT_SINK = (level: LogLevel, message: string, data?: unknown): void => {
  if (data !== undefined) {
    console[level](message, data);
  } else {
    console[level](message);
  }
};

/**
 * Create a logger that redacts all output through the given SecretRedactor.
 * Messages below the configured level are silently dropped.
 */
export function createLogger(
  redactor: SecretRedactor,
  options: LoggerOptions = {},
): BeauvoirLogger {
  // Validate level against known values; fall back to 'info' if invalid
  const requestedLevel = options.level;
  const minLevel: LogLevel =
    requestedLevel && Object.prototype.hasOwnProperty.call(LEVEL_ORDER, requestedLevel)
      ? requestedLevel
      : "info";
  const prefix = options.prefix;
  const sink = options.sink ?? DEFAULT_SINK;

  function emit(level: LogLevel, message: string, data?: unknown): void {
    // Level gate: only emit if message level >= configured minimum
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

    // Build raw message with prefix first, then redact once
    // (ensures any secrets in the prefix are also sanitized)
    const rawMessage = prefix ? `[${prefix}] ${message}` : message;
    const safeMessage = redactor.redact(rawMessage);

    // Redact data: always use redactError for Error instances (any level),
    // redactAny for everything else
    if (data !== undefined) {
      const safeData =
        data instanceof Error ? redactor.redactError(data) : redactor.redactAny(data);
      sink(level, safeMessage, safeData);
    } else {
      sink(level, safeMessage);
    }
  }

  return {
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
  };
}
