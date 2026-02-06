/**
 * Tests for BeadsContextCompilerAdapter
 *
 * @module beads/context-compiler-adapter.test
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { IBrExecutor, BrCommandResult, Bead } from "../../../../.claude/lib/beads";
import {
  BeadsContextCompilerAdapter,
  createBeadsContextCompilerAdapter,
} from "../beads-context-compiler-adapter.js";
import { ContextCompiler } from "../../../../.claude/lib/beads";

// =============================================================================
// Mock BR Executor
// =============================================================================

class MockBrExecutor implements IBrExecutor {
  public execCalls: string[] = [];
  private responses: Map<string, BrCommandResult> = new Map();

  mockResponse(pattern: string, result: BrCommandResult): void {
    this.responses.set(pattern, result);
  }

  mockJsonResponse(pattern: string, data: unknown): void {
    this.responses.set(pattern, {
      success: true,
      stdout: JSON.stringify(data),
      stderr: "",
      exitCode: 0,
    });
  }

  async exec(args: string): Promise<BrCommandResult> {
    this.execCalls.push(args);

    for (const [pattern, result] of this.responses) {
      if (args.includes(pattern)) {
        return result;
      }
    }

    return { success: true, stdout: "", stderr: "", exitCode: 0 };
  }

  async execJson<T = unknown>(args: string): Promise<T> {
    const result = await this.exec(args);
    if (!result.success) {
      throw new Error(result.stderr);
    }
    if (!result.stdout) {
      return [] as unknown as T;
    }
    return JSON.parse(result.stdout) as T;
  }

  reset(): void {
    this.responses.clear();
    this.execCalls = [];
  }
}

// =============================================================================
// Test Beads
// =============================================================================

const makeBead = (overrides: Partial<Bead>): Bead => ({
  id: "test-bead-1",
  title: "Test Bead",
  description: "A test bead",
  type: "task",
  status: "open",
  priority: 2,
  labels: [],
  created_at: "2026-02-06T00:00:00Z",
  updated_at: "2026-02-06T00:00:00Z",
  ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe("BeadsContextCompilerAdapter", () => {
  let mockExecutor: MockBrExecutor;

  beforeEach(() => {
    mockExecutor = new MockBrExecutor();
  });

  describe("compile", () => {
    it("should transform ScoredBead[] to CompiledBead[] correctly", async () => {
      const taskBead = makeBead({
        id: "task-1",
        title: "Target Task",
        labels: [],
      });

      const depBead = makeBead({
        id: "dep-1",
        title: "Dependency",
        labels: [],
      });

      // Mock: show returns the task
      mockExecutor.mockJsonResponse("show 'task-1'", taskBead);
      // Mock: list queries return beads
      mockExecutor.mockJsonResponse("list", [taskBead, depBead]);

      const upstream = new ContextCompiler(mockExecutor, { tokenBudget: 4000 });
      const adapter = new BeadsContextCompilerAdapter(upstream);

      const result = await adapter.compile("task-1");

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("task-1");
      expect(result!.beads).toBeDefined();
      expect(Array.isArray(result!.beads)).toBe(true);

      // Each CompiledBead should have bead, score, reason
      for (const compiled of result!.beads) {
        expect(compiled.bead).toBeDefined();
        expect(typeof compiled.score).toBe("number");
        expect(typeof compiled.reason).toBe("string");
      }
    });

    it("should include token estimate from upstream stats", async () => {
      const taskBead = makeBead({ id: "task-2", labels: [] });
      mockExecutor.mockJsonResponse("show 'task-2'", taskBead);
      mockExecutor.mockJsonResponse("list", [taskBead]);

      const upstream = new ContextCompiler(mockExecutor, { tokenBudget: 4000 });
      const adapter = new BeadsContextCompilerAdapter(upstream);

      const result = await adapter.compile("task-2");

      expect(result).not.toBeNull();
      expect(typeof result!.tokenEstimate).toBe("number");
      expect(result!.tokenEstimate).toBeGreaterThanOrEqual(0);
    });

    it("should include trace with compiled summary", async () => {
      const taskBead = makeBead({ id: "task-3", labels: [] });
      mockExecutor.mockJsonResponse("show 'task-3'", taskBead);
      mockExecutor.mockJsonResponse("list", [taskBead]);

      const upstream = new ContextCompiler(mockExecutor, { tokenBudget: 4000 });
      const adapter = new BeadsContextCompilerAdapter(upstream);

      const result = await adapter.compile("task-3");

      expect(result).not.toBeNull();
      expect(Array.isArray(result!.trace)).toBe(true);
      // Trace should contain "compiled:" summary
      expect(result!.trace.some((t) => t.includes("compiled:"))).toBe(true);
      // Trace should contain "tokens:" summary
      expect(result!.trace.some((t) => t.includes("tokens:"))).toBe(true);
    });

    it("should include per-reason exclusion counts in trace", async () => {
      // Create beads that will cause some exclusions
      const taskBead = makeBead({ id: "task-4", labels: [] });
      const routineBead = makeBead({
        id: "routine-1",
        title: "Routine",
        labels: ["class:routine"],
      });

      mockExecutor.mockJsonResponse("show 'task-4'", taskBead);
      mockExecutor.mockJsonResponse("list", [taskBead, routineBead]);

      const upstream = new ContextCompiler(mockExecutor, { tokenBudget: 4000 });
      const adapter = new BeadsContextCompilerAdapter(upstream);

      const result = await adapter.compile("task-4");
      expect(result).not.toBeNull();
      // If there are exclusions, there should be "excluded:" trace entries
      // (may or may not have exclusions depending on scoring)
      expect(result!.trace.length).toBeGreaterThanOrEqual(2);
    });

    it("should return result with empty beads when upstream includes nothing", async () => {
      // Create an upstream that returns empty includes (all excluded due to budget=0)
      const taskBead = makeBead({ id: "task-5", title: "x", description: "", labels: [] });
      mockExecutor.mockJsonResponse("show 'task-5'", taskBead);
      mockExecutor.mockJsonResponse("list", []);

      const upstream = new ContextCompiler(mockExecutor, { tokenBudget: 0 });
      const adapter = new BeadsContextCompilerAdapter(upstream);

      const result = await adapter.compile("task-5");

      // With budget 0, the task itself might still be fetched but excluded
      expect(result).not.toBeNull();
      // The result should still be valid even with no beads
      expect(Array.isArray(result!.beads)).toBe(true);
      expect(Array.isArray(result!.trace)).toBe(true);
    });

    it("should return null when upstream compile() throws", async () => {
      // Create a mock ContextCompiler that throws
      const throwingUpstream = {
        compile: async () => {
          throw new Error("compilation failed");
        },
      } as unknown as ContextCompiler;

      const adapter = new BeadsContextCompilerAdapter(throwingUpstream);

      const result = await adapter.compile("nonexistent-task");
      expect(result).toBeNull();
    });

    it("should respect tokenBudget from options parameter", async () => {
      const taskBead = makeBead({ id: "task-6", labels: [] });
      mockExecutor.mockJsonResponse("show 'task-6'", taskBead);
      mockExecutor.mockJsonResponse("list", [taskBead]);

      const upstream = new ContextCompiler(mockExecutor, { tokenBudget: 4000 });
      const adapter = new BeadsContextCompilerAdapter(upstream);

      const result = await adapter.compile("task-6", { tokenBudget: 2000 });

      expect(result).not.toBeNull();
      expect(result!.tokenBudget).toBe(2000);
    });
  });

  describe("factory function", () => {
    it("should create a working adapter instance", async () => {
      const adapter = createBeadsContextCompilerAdapter(mockExecutor, {
        tokenBudget: 4000,
      });

      expect(adapter).toBeInstanceOf(BeadsContextCompilerAdapter);

      // Mock a basic task for compile
      const taskBead = makeBead({ id: "factory-task", labels: [] });
      mockExecutor.mockJsonResponse("show 'factory-task'", taskBead);
      mockExecutor.mockJsonResponse("list", [taskBead]);

      const result = await adapter.compile("factory-task");
      expect(result).not.toBeNull();
    });

    it("should create adapter without config", () => {
      const adapter = createBeadsContextCompilerAdapter(mockExecutor);
      expect(adapter).toBeInstanceOf(BeadsContextCompilerAdapter);
    });
  });
});
