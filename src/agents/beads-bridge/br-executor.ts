/**
 * BrExecutor — shell-safe CLI wrapper for the `br` beads CLI.
 *
 * Uses execFile (argv array, no shell) for all operations.
 * Every method validates inputs before execution.
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { validateBeadId, validateLabel, MAX_COMMENT_LENGTH } from "./validation.js";

const execFile = promisify(execFileCb);

// -- Constants ----------------------------------------------------------------

const MUTATION_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 10_000;

// -- Types --------------------------------------------------------------------

export interface BeadRecord {
  id: string;
  title: string;
  status: string;
  labels: string[];
  description?: string;
  created_at?: string;
  depends_on?: string[];
  [key: string]: unknown;
}

// -- Output validation --------------------------------------------------------

/** Validate shape of a BeadRecord from br CLI output. */
function assertBeadRecord(raw: unknown): asserts raw is BeadRecord {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid br output: expected object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.status !== "string") {
    throw new Error("Invalid br output: missing id or status");
  }
  if (!Array.isArray(obj.labels)) {
    throw new Error("Invalid br output: labels must be an array");
  }
}

function assertBeadRecordArray(raw: unknown): asserts raw is BeadRecord[] {
  if (!Array.isArray(raw)) {
    throw new Error("Invalid br output: expected array");
  }
  for (const item of raw) {
    assertBeadRecord(item);
  }
}

// -- BrExecutor class ---------------------------------------------------------

export class BrExecutor {
  private brPath: string;

  constructor(brPath = "br") {
    this.brPath = brPath;
  }

  /** Execute a br command and parse JSON output. */
  async exec<T = unknown>(args: string[], timeoutMs: number): Promise<T> {
    const { stdout } = await execFile(this.brPath, args, { timeout: timeoutMs });
    try {
      return JSON.parse(stdout) as T;
    } catch (err) {
      throw new Error(`Invalid br JSON output: ${(err as Error).message}`);
    }
  }

  /** Execute a br command that returns plain text (or no output). */
  async execRaw(args: string[], timeoutMs: number): Promise<string> {
    const { stdout } = await execFile(this.brPath, args, { timeout: timeoutMs });
    return stdout.trim();
  }

  /** List beads with a specific label. */
  async listByLabel(label: string): Promise<BeadRecord[]> {
    validateLabel(label);
    const raw = await this.exec<unknown>(["list", "--label", label, "--json"], QUERY_TIMEOUT_MS);
    assertBeadRecordArray(raw);
    return raw;
  }

  /** List all beads as JSON. */
  async listAll(): Promise<BeadRecord[]> {
    const raw = await this.exec<unknown>(["list", "--json"], QUERY_TIMEOUT_MS);
    assertBeadRecordArray(raw);
    return raw;
  }

  /** Get a single bead by ID. */
  async get(beadId: string): Promise<BeadRecord> {
    validateBeadId(beadId);
    const raw = await this.exec<unknown>(["show", beadId, "--json"], QUERY_TIMEOUT_MS);
    assertBeadRecord(raw);
    return raw;
  }

  /** Add a label to a bead. */
  async labelAdd(beadId: string, label: string): Promise<void> {
    validateBeadId(beadId);
    validateLabel(label);
    await this.execRaw(["label", "add", beadId, label], MUTATION_TIMEOUT_MS);
  }

  /** Remove a label from a bead. */
  async labelRemove(beadId: string, label: string): Promise<void> {
    validateBeadId(beadId);
    validateLabel(label);
    await this.execRaw(["label", "remove", beadId, label], MUTATION_TIMEOUT_MS);
  }

  /** Close a bead. */
  async close(beadId: string): Promise<void> {
    validateBeadId(beadId);
    await this.execRaw(["close", beadId], MUTATION_TIMEOUT_MS);
  }

  /** Add a comment to a bead, sanitizing and truncating to MAX_COMMENT_LENGTH. */
  async comment(beadId: string, text: string): Promise<void> {
    validateBeadId(beadId);
    // Strip control characters except \n and \t
    const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
    const truncated =
      sanitized.length > MAX_COMMENT_LENGTH ? sanitized.slice(0, MAX_COMMENT_LENGTH) : sanitized;
    await this.execRaw(["comment", beadId, truncated], MUTATION_TIMEOUT_MS);
  }
}
