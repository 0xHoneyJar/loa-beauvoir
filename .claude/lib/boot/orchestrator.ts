/**
 * BootOrchestrator - Deterministic 7-step startup sequence for the Beauvoir framework.
 *
 * Follows SDD section 3.1 + section 1.3 boot protocol:
 *  1. Config validation
 *  2. FS validation (dataDir exists)
 *  3a-g. Subsystem initialization (P0 = critical, P1 = degraded-ok)
 *  4. ToolValidator cross-check
 *  5. Reconcile pending intents
 *  6. Recover stale locks
 *  7. Compute operating mode + health report
 *
 * P0 failures abort boot (unless allowDev). P1 failures degrade gracefully.
 */

import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { CircuitBreaker } from "../persistence/circuit-breaker.js";
import { LockManager } from "../persistence/lock-manager.js";
import { RateLimiter } from "../persistence/rate-limiter.js";
import { ResilientStoreFactory } from "../persistence/resilient-store.js";
import { AuditTrail } from "../safety/audit-trail.js";
import { createLogger, type BeauvoirLogger } from "../safety/logger.js";
import { SecretRedactor } from "../safety/secret-redactor.js";
import { ToolValidator, type ActionPolicyDef } from "../safety/tool-validator.js";

// ── Types ────────────────────────────────────────────────────

export type SubsystemStatus = "ok" | "degraded" | "failed";
export type OperatingMode = "autonomous" | "degraded" | "dev";

export interface BootConfig {
  dataDir: string;
  allowDev?: boolean;
  auditTrailPath?: string;
  hmacKey?: string;
  mcpToolNames?: string[];
  actionPolicy?: ActionPolicyDef[];
  extraRedactionPatterns?: Array<{
    name: string;
    pattern: RegExp;
    replacement?: string;
  }>;
  now?: () => number;
}

export interface HealthReport {
  success: boolean;
  mode: OperatingMode;
  bootTimeMs: number;
  warnings: string[];
  subsystems: Record<string, SubsystemStatus>;
}

export interface BootResult {
  health: HealthReport;
  services: ServicesBag;
  shutdown: () => Promise<void>;
}

export interface ServicesBag {
  redactor: SecretRedactor;
  logger: BeauvoirLogger;
  /** May be undefined in dev mode if P0 audit trail init failed. */
  auditTrail?: AuditTrail;
  store?: ResilientStoreFactory;
  circuitBreaker?: CircuitBreaker;
  rateLimiter?: RateLimiter;
  dedupIndex?: unknown;
  toolValidator?: ToolValidator;
  /** May be undefined in dev mode if P0 lock manager init failed. */
  lockManager?: LockManager;
}

/**
 * Factory overrides for testing — allows injecting test doubles
 * without module-level mocking.
 */
export interface BootFactories {
  createRedactor?: (
    patterns?: Array<{ name: string; pattern: RegExp; replacement?: string }>,
  ) => SecretRedactor;
  createLogger?: (redactor: SecretRedactor) => BeauvoirLogger;
  createAuditTrail?: (opts: {
    path: string;
    hmacKey?: string;
    redactor: SecretRedactor;
    logger: BeauvoirLogger;
    now?: () => number;
  }) => AuditTrail;
  createStoreFactory?: (opts: { baseDir: string; logger: BeauvoirLogger }) => ResilientStoreFactory;
  createCircuitBreaker?: () => CircuitBreaker;
  createRateLimiter?: () => RateLimiter;
  createLockManager?: (opts: {
    dataDir: string;
    bootId: string;
    logger: BeauvoirLogger;
    now?: () => number;
  }) => LockManager;
  createDedupIndex?: () => unknown;
  createToolValidator?: (registry: never[], policy: ActionPolicyDef) => ToolValidator;
  checkDataDir?: (dataDir: string) => Promise<void>;
}

// ── Boot Implementation ──────────────────────────────────────

export async function boot(config: BootConfig, factories?: BootFactories): Promise<BootResult> {
  const startMs = config.now ? config.now() : Date.now();
  const subsystems: Record<string, SubsystemStatus> = {};
  const warnings: string[] = [];
  const p0Errors: string[] = [];

  let redactor: SecretRedactor | undefined;
  let logger: BeauvoirLogger | undefined;
  let auditTrail: AuditTrail | undefined;
  let storeFactory: ResilientStoreFactory | undefined;
  let circuitBreaker: CircuitBreaker | undefined;
  let rateLimiter: RateLimiter | undefined;
  let dedupIndex: unknown | undefined;
  let toolValidator: ToolValidator | undefined;
  let lockManager: LockManager | undefined;

  // Step 1: Config validation (P0)
  try {
    validateConfig(config);
    subsystems["config"] = "ok";
  } catch (err) {
    subsystems["config"] = "failed";
    p0Errors.push("Config validation failed: " + errorMessage(err));
  }

  // Step 2: FS validation (P0)
  try {
    if (factories?.checkDataDir) {
      await factories.checkDataDir(config.dataDir);
    } else {
      await access(config.dataDir);
    }
    subsystems["fs"] = "ok";
  } catch (err) {
    subsystems["fs"] = "failed";
    p0Errors.push("FS validation failed: dataDir is not accessible: " + errorMessage(err));
  }

  // Step 3a: SecretRedactor (P0)
  try {
    const patterns = (config.extraRedactionPatterns ?? []).map((p) => ({
      name: p.name,
      pattern: p.pattern,
      replacement: p.replacement ?? "[REDACTED:" + p.name + "]",
    }));
    redactor = factories?.createRedactor
      ? factories.createRedactor(config.extraRedactionPatterns)
      : new SecretRedactor(patterns);
    subsystems["redactor"] = "ok";
  } catch (err) {
    subsystems["redactor"] = "failed";
    p0Errors.push("SecretRedactor init failed: " + errorMessage(err));
  }

  // Step 3b: BeauvoirLogger (P0)
  try {
    if (!redactor) throw new Error("Cannot create logger: redactor unavailable");
    logger = factories?.createLogger
      ? factories.createLogger(redactor)
      : createLogger(redactor, { level: "info" });
    subsystems["logger"] = "ok";
  } catch (err) {
    subsystems["logger"] = "failed";
    p0Errors.push("Logger init failed: " + errorMessage(err));
  }

  // Step 3c: AuditTrail + torn write recovery (P0)
  try {
    if (!redactor) throw new Error("Cannot create audit trail: redactor unavailable");
    if (!logger) throw new Error("Cannot create audit trail: logger unavailable");

    const auditPath = config.auditTrailPath ?? config.dataDir + "/audit-trail.jsonl";
    auditTrail = factories?.createAuditTrail
      ? factories.createAuditTrail({
          path: auditPath,
          hmacKey: config.hmacKey,
          redactor,
          logger,
          now: config.now,
        })
      : new AuditTrail({
          path: auditPath,
          hmacKey: config.hmacKey,
          redactor,
          logger,
          now: config.now,
        });

    await auditTrail.initialize();
    subsystems["auditTrail"] = "ok";
  } catch (err) {
    subsystems["auditTrail"] = "failed";
    p0Errors.push("AuditTrail init failed: " + errorMessage(err));
  }

  // Step 3d: ResilientStore factory (P1)
  try {
    if (!logger) throw new Error("Cannot create store factory: logger unavailable");
    storeFactory = factories?.createStoreFactory
      ? factories.createStoreFactory({ baseDir: config.dataDir, logger })
      : new ResilientStoreFactory({ baseDir: config.dataDir, logger });
    subsystems["store"] = "ok";
  } catch (err) {
    subsystems["store"] = "degraded";
    const msg = "ResilientStoreFactory init failed: " + errorMessage(err);
    warnings.push(msg);
    logger?.warn(msg);
  }

  // Step 3e: CircuitBreaker (P1)
  try {
    circuitBreaker = factories?.createCircuitBreaker
      ? factories.createCircuitBreaker()
      : new CircuitBreaker();
    subsystems["circuitBreaker"] = "ok";
  } catch (err) {
    subsystems["circuitBreaker"] = "degraded";
    const msg = "CircuitBreaker init failed: " + errorMessage(err);
    warnings.push(msg);
    logger?.warn(msg);
  }

  // Step 3f: RateLimiter (P1)
  try {
    rateLimiter = factories?.createRateLimiter
      ? factories.createRateLimiter()
      : new RateLimiter({ now: config.now });
    subsystems["rateLimiter"] = "ok";
  } catch (err) {
    subsystems["rateLimiter"] = "degraded";
    const msg = "RateLimiter init failed: " + errorMessage(err);
    warnings.push(msg);
    logger?.warn(msg);
  }

  // Step 3g: IdempotencyIndex (P1) — may not exist yet
  if (factories?.createDedupIndex) {
    try {
      const dedup = factories.createDedupIndex();
      if (dedup) {
        dedupIndex = dedup;
        subsystems["dedupIndex"] = "ok";
      } else {
        subsystems["dedupIndex"] = "degraded";
        warnings.push("IdempotencyIndex not yet available — skipped");
      }
    } catch (err) {
      subsystems["dedupIndex"] = "degraded";
      warnings.push("IdempotencyIndex init failed: " + errorMessage(err));
    }
  } else {
    subsystems["dedupIndex"] = "degraded";
    warnings.push("IdempotencyIndex not yet available — skipped");
  }

  // Step 4: ToolValidator cross-check (P0)
  if (config.mcpToolNames && config.actionPolicy && config.actionPolicy.length > 0) {
    try {
      const policy = config.actionPolicy[0];
      toolValidator = factories?.createToolValidator
        ? factories.createToolValidator([] as never[], policy)
        : new ToolValidator([], policy);

      const validation = toolValidator.validateRegistry(config.mcpToolNames);
      if (!validation.valid) {
        throw new Error("Tool validation errors: " + validation.errors.join("; "));
      }
      for (const w of validation.warnings) {
        warnings.push("ToolValidator: " + w);
      }
      subsystems["toolValidator"] = "ok";
    } catch (err) {
      subsystems["toolValidator"] = "failed";
      p0Errors.push("ToolValidator failed: " + errorMessage(err));
    }
  } else {
    subsystems["toolValidator"] = "ok";
  }

  // LockManager init (needed for steps 5-6)
  try {
    if (!logger) throw new Error("Cannot create lock manager: logger unavailable");
    const bootId = randomUUID();
    lockManager = factories?.createLockManager
      ? factories.createLockManager({
          dataDir: config.dataDir,
          bootId,
          logger,
          now: config.now,
        })
      : new LockManager({
          dataDir: config.dataDir,
          bootId,
          logger,
          now: config.now,
        });
    subsystems["lockManager"] = "ok";
  } catch (err) {
    subsystems["lockManager"] = "failed";
    p0Errors.push("LockManager init failed: " + errorMessage(err));
  }

  // Determine operating mode
  const hasP0Failure = p0Errors.length > 0;
  const hasP1Failure = Object.values(subsystems).some((s) => s === "degraded");

  let mode: OperatingMode;
  if (hasP0Failure) {
    if (config.allowDev) {
      mode = "dev";
      warnings.push("DEV MODE: P0 subsystem failures present — NOT SAFE FOR PRODUCTION");
      for (const e of p0Errors) {
        warnings.push("P0 ERROR (suppressed in dev): " + e);
      }
    } else {
      const elapsed = (config.now ? config.now() : Date.now()) - startMs;
      throw new BootError(
        "Boot aborted: " + p0Errors.length + " P0 failure(s):\n  - " + p0Errors.join("\n  - "),
        { subsystems, bootTimeMs: elapsed, errors: p0Errors },
      );
    }
  } else if (hasP1Failure) {
    mode = "degraded";
  } else {
    mode = "autonomous";
  }

  // Step 5: Reconcile pending intents (non-critical)
  if (auditTrail) {
    try {
      const pending = auditTrail.getPendingIntents();
      if (pending.size > 0) {
        const pendingList = Array.from(pending);
        const msg =
          "Reconciled " + pending.size + " pending intent(s): [" + pendingList.join(", ") + "]";
        warnings.push(msg);
        logger?.warn(msg);
      }
    } catch (err) {
      const msg = "Failed to reconcile pending intents: " + errorMessage(err);
      warnings.push(msg);
      logger?.warn(msg);
    }
  }

  // Step 6: Recover stale locks (non-critical)
  if (lockManager) {
    try {
      const recovered = await lockManager.recoverStaleLocks();
      if (recovered.length > 0) {
        const msg =
          "Recovered " + recovered.length + " stale lock(s): [" + recovered.join(", ") + "]";
        warnings.push(msg);
        logger?.warn(msg);
      }
    } catch (err) {
      const msg = "Failed to recover stale locks: " + errorMessage(err);
      warnings.push(msg);
      logger?.warn(msg);
    }
  }

  // Step 7: Build health report + services bag
  const elapsed = (config.now ? config.now() : Date.now()) - startMs;

  const health: HealthReport = {
    success: !hasP0Failure,
    mode,
    bootTimeMs: elapsed,
    warnings,
    subsystems,
  };

  // In dev mode, P0 subsystems may have failed. Provide no-op fallbacks for
  // redactor/logger to avoid "Cannot read properties of undefined" errors.
  // auditTrail and lockManager are optional in ServicesBag for this reason.
  const services: ServicesBag = {
    redactor: redactor ?? new SecretRedactor([]),
    logger: logger ?? createLogger(redactor ?? new SecretRedactor([]), { level: "info" }),
    auditTrail,
    store: storeFactory,
    circuitBreaker,
    rateLimiter,
    dedupIndex,
    toolValidator,
    lockManager,
  };

  const shutdown = async (): Promise<void> => {
    if (rateLimiter) {
      rateLimiter.shutdown();
    }
    if (auditTrail) {
      await auditTrail.close();
    }
  };

  return { health, services, shutdown };
}

// ── Config Validation ────────────────────────────────────────

function validateConfig(config: BootConfig): void {
  if (!config.dataDir || typeof config.dataDir !== "string") {
    throw new Error("dataDir is required and must be a non-empty string");
  }
  if (config.auditTrailPath !== undefined && typeof config.auditTrailPath !== "string") {
    throw new Error("auditTrailPath must be a string");
  }
  if (config.hmacKey !== undefined && typeof config.hmacKey !== "string") {
    throw new Error("hmacKey must be a string");
  }
}

// ── Error Helpers ────────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class BootError extends Error {
  readonly subsystems: Record<string, SubsystemStatus>;
  readonly bootTimeMs: number;
  readonly errors: string[];

  constructor(
    message: string,
    context: {
      subsystems: Record<string, SubsystemStatus>;
      bootTimeMs: number;
      errors: string[];
    },
  ) {
    super(message);
    this.name = "BootError";
    this.subsystems = context.subsystems;
    this.bootTimeMs = context.bootTimeMs;
    this.errors = context.errors;
  }
}
