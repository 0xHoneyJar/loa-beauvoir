/**
 * Tool Loader Service
 *
 * Manages deferred installation of optimization tools after container startup.
 * Implements the "netinstall" pattern - core boots fast, tools load in background.
 *
 * @module deploy/loa-identity/tool-loader/tool-loader
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync, statSync } from "fs";
import { join } from "path";

export interface ToolSpec {
  name: string;
  version: string;
  installType: "cargo" | "pip" | "binary" | "script";
  installCmd: string[];
  verifyCmd: string[];
  binaryPath?: string;
  priority: number; // Lower = higher priority
  estimatedSeconds: number;
  dependencies?: string[];
  optional?: boolean;
}

export interface ToolStatus {
  name: string;
  status: "pending" | "installing" | "installed" | "failed" | "skipped";
  version?: string;
  installedAt?: string;
  error?: string;
  duration?: number; // seconds
}

export interface LoaderState {
  schemaVersion: number;
  startedAt: string;
  completedAt?: string;
  containerBoot: string;
  tools: Record<string, ToolStatus>;
}

const TOOL_DIR = process.env.LOA_TOOL_DIR ?? "/data/tools";
const STATE_FILE = join(TOOL_DIR, "loader-state.json");
const SCHEMA_VERSION = 1;

/**
 * Tool specifications - ordered by priority
 */
const TOOLS: ToolSpec[] = [
  {
    name: "rust",
    version: "stable",
    installType: "script",
    installCmd: [
      "sh",
      "-c",
      'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal',
    ],
    verifyCmd: ["/root/.cargo/bin/rustc", "--version"],
    binaryPath: "/root/.cargo/bin/rustc",
    priority: 1,
    estimatedSeconds: 60,
  },
  {
    name: "ck-search",
    version: "latest",
    installType: "cargo",
    installCmd: ["/root/.cargo/bin/cargo", "install", "ck-search", "--locked"],
    verifyCmd: ["/root/.cargo/bin/ck", "--version"],
    binaryPath: "/root/.cargo/bin/ck",
    priority: 2,
    estimatedSeconds: 300,
    dependencies: ["rust"],
  },
  {
    name: "beads_rust",
    version: "latest",
    installType: "cargo",
    installCmd: ["/root/.cargo/bin/cargo", "install", "beads_rust", "--locked"],
    verifyCmd: ["/root/.cargo/bin/br", "--version"],
    binaryPath: "/root/.cargo/bin/br",
    priority: 3,
    estimatedSeconds: 180,
    dependencies: ["rust"],
  },
  {
    name: "python3-venv",
    version: "system",
    installType: "script",
    installCmd: [
      "sh",
      "-c",
      "apt-get update && apt-get install -y --no-install-recommends python3-pip python3-venv && apt-get clean && rm -rf /var/lib/apt/lists/*",
    ],
    verifyCmd: ["python3", "-m", "venv", "--help"],
    priority: 4,
    estimatedSeconds: 30,
    optional: true,
  },
  {
    name: "sentence-transformers",
    version: "latest",
    installType: "pip",
    installCmd: [
      "pip3",
      "install",
      "--no-cache-dir",
      "--break-system-packages",
      "sentence-transformers",
    ],
    verifyCmd: [
      "python3",
      "-c",
      'from sentence_transformers import SentenceTransformer; print("OK")',
    ],
    priority: 5,
    estimatedSeconds: 300,
    dependencies: ["python3-venv"],
    optional: true, // Large dependency, may fail on low memory
  },
];

/**
 * ToolLoader manages the background installation of optimization tools.
 */
export class ToolLoader {
  private state: LoaderState;
  private installing = false;
  private currentProcess: ChildProcess | null = null;

  constructor() {
    this.state = this.loadState();
  }

  /**
   * Load state from disk or create new state
   */
  private loadState(): LoaderState {
    if (existsSync(STATE_FILE)) {
      try {
        const saved = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
        if (saved.schemaVersion === SCHEMA_VERSION) {
          return saved;
        }
        console.log("[tool-loader] Schema version mismatch, starting fresh");
      } catch {
        console.log("[tool-loader] Corrupted state file, starting fresh");
      }
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      startedAt: new Date().toISOString(),
      containerBoot: new Date().toISOString(),
      tools: Object.fromEntries(
        TOOLS.map((t) => [t.name, { name: t.name, status: "pending" as const }]),
      ),
    };
  }

  /**
   * Persist state to disk
   */
  private saveState(): void {
    try {
      mkdirSync(TOOL_DIR, { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error("[tool-loader] Failed to save state:", err);
    }
  }

  /**
   * Run a command and capture output
   */
  private async runCommand(
    cmd: string[],
    timeoutSeconds = 600,
  ): Promise<{ ok: boolean; output: string; duration: number }> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        env: {
          ...process.env,
          PATH: `/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
          RUSTUP_HOME: "/root/.rustup",
          CARGO_HOME: "/root/.cargo",
          HOME: "/root",
        },
        stdio: ["ignore", "pipe", "pipe"],
        shell: cmd[0] === "sh",
      });

      this.currentProcess = proc;

      let output = "";
      const maxOutput = 10000; // Limit output capture

      proc.stdout?.on("data", (d) => {
        const chunk = d.toString();
        if (output.length < maxOutput) {
          output += chunk;
        }
      });

      proc.stderr?.on("data", (d) => {
        const chunk = d.toString();
        if (output.length < maxOutput) {
          output += chunk;
        }
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({
          ok: false,
          output: `Timeout after ${timeoutSeconds}s`,
          duration: timeoutSeconds,
        });
      }, timeoutSeconds * 1000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        const duration = Math.round((Date.now() - startTime) / 1000);
        resolve({
          ok: code === 0,
          output: output.trim().slice(-2000), // Keep last 2000 chars
          duration,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        this.currentProcess = null;
        const duration = Math.round((Date.now() - startTime) / 1000);
        resolve({
          ok: false,
          output: err.message,
          duration,
        });
      });
    });
  }

  /**
   * Check if a tool is already installed
   */
  private async isInstalled(tool: ToolSpec): Promise<boolean> {
    // Check binary path if specified
    if (tool.binaryPath && !existsSync(tool.binaryPath)) {
      return false;
    }

    // Try verify command
    const result = await this.runCommand(tool.verifyCmd, 10);
    return result.ok;
  }

  /**
   * Install a single tool
   */
  private async installTool(tool: ToolSpec): Promise<boolean> {
    console.log(`[tool-loader] Installing ${tool.name}...`);

    this.state.tools[tool.name] = {
      name: tool.name,
      status: "installing",
    };
    this.saveState();

    const timeout = Math.max(tool.estimatedSeconds * 2, 300);
    const result = await this.runCommand(tool.installCmd, timeout);

    if (result.ok) {
      // Verify installation
      const verified = await this.isInstalled(tool);
      if (verified) {
        this.state.tools[tool.name] = {
          name: tool.name,
          status: "installed",
          installedAt: new Date().toISOString(),
          duration: result.duration,
        };
        console.log(`[tool-loader] ✓ ${tool.name} installed (${result.duration}s)`);
      } else {
        this.state.tools[tool.name] = {
          name: tool.name,
          status: "failed",
          error: "Verification failed after install",
          duration: result.duration,
        };
        console.error(`[tool-loader] ✗ ${tool.name} verification failed`);
      }
    } else {
      this.state.tools[tool.name] = {
        name: tool.name,
        status: "failed",
        error: result.output.slice(0, 500),
        duration: result.duration,
      };
      console.error(
        `[tool-loader] ✗ ${tool.name} failed (${result.duration}s): ${result.output.slice(0, 200)}`,
      );
    }

    this.saveState();
    return this.state.tools[tool.name].status === "installed";
  }

  /**
   * Run the tool loader
   */
  async run(): Promise<void> {
    if (this.installing) {
      console.log("[tool-loader] Already running");
      return;
    }

    if (process.env.LOA_DEFERRED_TOOLS === "false") {
      console.log("[tool-loader] Deferred tools disabled via LOA_DEFERRED_TOOLS=false");
      return;
    }

    // Check if tool directory is writable (R2 volume mounted)
    try {
      mkdirSync(TOOL_DIR, { recursive: true });
      writeFileSync(join(TOOL_DIR, ".write-test"), "test");
    } catch {
      console.warn("[tool-loader] Tool directory not writable, tools will not persist");
    }

    this.installing = true;
    this.state.startedAt = new Date().toISOString();
    console.log("[tool-loader] Starting deferred tool installation...");
    console.log(`[tool-loader] Tool directory: ${TOOL_DIR}`);

    // Sort by priority
    const sortedTools = [...TOOLS].sort((a, b) => a.priority - b.priority);

    // First pass: install tools without dependencies or with satisfied deps
    for (const tool of sortedTools) {
      // Skip if already installed
      if (await this.isInstalled(tool)) {
        this.state.tools[tool.name] = {
          name: tool.name,
          status: "installed",
          installedAt: "pre-existing",
        };
        this.saveState();
        console.log(`[tool-loader] ${tool.name} already installed`);
        continue;
      }

      // Check dependencies
      if (tool.dependencies && tool.dependencies.length > 0) {
        const unmetDeps = tool.dependencies.filter(
          (dep) => this.state.tools[dep]?.status !== "installed",
        );
        if (unmetDeps.length > 0) {
          console.log(`[tool-loader] ${tool.name} deferred (waiting for: ${unmetDeps.join(", ")})`);
          continue;
        }
      }

      const success = await this.installTool(tool);

      // Skip optional tool failures
      if (!success && tool.optional) {
        console.log(`[tool-loader] ${tool.name} is optional, continuing`);
        this.state.tools[tool.name].status = "skipped";
        this.saveState();
      }
    }

    // Second pass: install deferred tools (those that were waiting for deps)
    for (const tool of sortedTools) {
      if (this.state.tools[tool.name].status !== "pending") {
        continue;
      }

      if (tool.dependencies) {
        const allDepsInstalled = tool.dependencies.every(
          (dep) =>
            this.state.tools[dep]?.status === "installed" ||
            this.state.tools[dep]?.status === "skipped",
        );

        if (!allDepsInstalled) {
          console.log(`[tool-loader] ${tool.name} skipped (missing dependencies)`);
          this.state.tools[tool.name].status = "skipped";
          this.saveState();
          continue;
        }
      }

      const success = await this.installTool(tool);
      if (!success && tool.optional) {
        this.state.tools[tool.name].status = "skipped";
        this.saveState();
      }
    }

    this.state.completedAt = new Date().toISOString();
    this.saveState();

    const stats = this.getStats();
    console.log(
      `[tool-loader] Complete: ${stats.installed} installed, ${stats.failed} failed, ${stats.skipped} skipped`,
    );

    this.installing = false;
  }

  /**
   * Get installation statistics
   */
  private getStats(): { installed: number; failed: number; skipped: number; pending: number } {
    const tools = Object.values(this.state.tools);
    return {
      installed: tools.filter((t) => t.status === "installed").length,
      failed: tools.filter((t) => t.status === "failed").length,
      skipped: tools.filter((t) => t.status === "skipped").length,
      pending: tools.filter((t) => t.status === "pending" || t.status === "installing").length,
    };
  }

  /**
   * Get current loader state
   */
  getStatus(): LoaderState {
    return this.state;
  }

  /**
   * Check if all tools have been processed
   */
  isComplete(): boolean {
    return Object.values(this.state.tools).every(
      (t) => t.status === "installed" || t.status === "failed" || t.status === "skipped",
    );
  }

  /**
   * Check if a specific tool is available
   */
  isToolAvailable(toolName: string): boolean {
    return this.state.tools[toolName]?.status === "installed";
  }

  /**
   * Stop any running installation
   */
  stop(): void {
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
      this.currentProcess = null;
    }
    this.installing = false;
  }
}

// Singleton instance
let loaderInstance: ToolLoader | null = null;

/**
 * Get singleton ToolLoader instance
 */
export function getToolLoader(): ToolLoader {
  if (!loaderInstance) {
    loaderInstance = new ToolLoader();
  }
  return loaderInstance;
}

/**
 * Start background tool loading (non-blocking)
 */
export function startBackgroundLoading(): void {
  const loader = getToolLoader();

  // Run after a short delay to let gateway fully start
  const delayMs = parseInt(process.env.LOA_TOOL_DELAY_MS ?? "5000", 10);

  console.log(`[tool-loader] Will start in ${delayMs}ms...`);

  setTimeout(() => {
    loader.run().catch((err) => {
      console.error("[tool-loader] Background loading failed:", err);
    });
  }, delayMs);
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const loader = getToolLoader();
  loader
    .run()
    .then(() => {
      console.log("[tool-loader] CLI run complete");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[tool-loader] CLI run failed:", err);
      process.exit(1);
    });
}
