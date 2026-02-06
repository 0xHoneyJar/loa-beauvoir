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

// -- BrExecutor class ---------------------------------------------------------

export class BrExecutor {
  private brPath: string;

  constructor(brPath = "br") {
    this.brPath = brPath;
  }

  /** Execute a br command and parse JSON output. */
  async exec<T = unknown>(args: string[], timeoutMs: number): Promise<T> {
    const { stdout } = await execFile(this.brPath, args, { timeout: timeoutMs });
    return JSON.parse(stdout) as T;
  }

  /** Execute a br command that returns plain text (or no output). */
  async execRaw(args: string[], timeoutMs: number): Promise<string> {
    const { stdout } = await execFile(this.brPath, args, { timeout: timeoutMs });
    return stdout.trim();
  }

  /** List beads with a specific label. */
  async listByLabel(label: string): Promise<BeadRecord[]> {
    validateLabel(label);
    return this.exec<BeadRecord[]>(["list", "--label", label, "--json"], QUERY_TIMEOUT_MS);
  }

  /** List all beads as JSON. */
  async listAll(): Promise<BeadRecord[]> {
    return this.exec<BeadRecord[]>(["list", "--json"], QUERY_TIMEOUT_MS);
  }

  /** Get a single bead by ID. */
  async get(beadId: string): Promise<BeadRecord> {
    validateBeadId(beadId);
    return this.exec<BeadRecord>(["show", beadId, "--json"], QUERY_TIMEOUT_MS);
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

  /** Add a comment to a bead, truncating to MAX_COMMENT_LENGTH. */
  async comment(beadId: string, text: string): Promise<void> {
    validateBeadId(beadId);
    const truncated = text.length > MAX_COMMENT_LENGTH ? text.slice(0, MAX_COMMENT_LENGTH) : text;
    await this.execRaw(["comment", beadId, truncated], MUTATION_TIMEOUT_MS);
  }
}
