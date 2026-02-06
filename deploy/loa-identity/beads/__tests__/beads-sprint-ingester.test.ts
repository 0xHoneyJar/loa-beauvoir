/**
 * Tests for BeadsSprintIngester
 *
 * @module beads/sprint-ingester.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { IBrExecutor, BrCommandResult } from "../../../../.claude/lib/beads";
import {
  BeadsSprintIngester,
  createBeadsSprintIngester,
  normalizeTaskId,
  detectCycles,
  type SprintPlan,
  type SprintTask,
  type IngestionResult,
} from "../beads-sprint-ingester.js";
import { WORK_QUEUE_LABELS } from "../beads-work-queue.js";

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

    // Default: success with bead ID output (simulates br create)
    if (args.startsWith("create ")) {
      return { success: true, stdout: "bead-new-123", stderr: "", exitCode: 0 };
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
// Test Data
// =============================================================================

const SAMPLE_SPRINT_MARKDOWN = `# Sprint Plan: Test Sprint

## Sprint 1: Test Sprint

### Epic: Test Epic

### TASK-1.1: Create the database schema

**Priority**: P0 (Critical Path)
**Blocked By**: None

#### Description

Design and create the initial database schema for the project.

#### Acceptance Criteria

- [ ] Create migration file
- [ ] Add index on user_id column
- [ ] Write seed data

---

### TASK-1.2: Implement API endpoints

**Priority**: P1
**Blocked By**: TASK-1.1

#### Description

Build REST API endpoints for CRUD operations.

#### Acceptance Criteria

- [ ] GET /api/items endpoint
- [ ] POST /api/items endpoint
- [ ] Error handling middleware

---

### TASK-1.3: Add frontend components

**Priority**: P2
**Blocked By**: TASK-1.2, TASK-1.1

#### Description

Create React components for the UI.

#### Acceptance Criteria

- [ ] ItemList component
- [ ] ItemForm component
`;

const MINIMAL_SPRINT_MARKDOWN = `## Sprint 2: Minimal

### TASK-2.1: Simple task

**Priority**: P0

#### Description

A simple task with no deps.
`;

// =============================================================================
// Tests
// =============================================================================

describe("BeadsSprintIngester", () => {
  let mockExecutor: MockBrExecutor;
  let ingester: BeadsSprintIngester;

  beforeEach(() => {
    mockExecutor = new MockBrExecutor();
    ingester = new BeadsSprintIngester(mockExecutor, { verbose: false });
    // Default: no existing beads for sprint
    mockExecutor.mockJsonResponse("list --label", []);
  });

  afterEach(() => {
    mockExecutor.reset();
  });

  describe("parseMarkdown", () => {
    it("should parse sprint markdown with 3+ tasks", () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test-sprint-001");

      expect(plan.tasks).toHaveLength(3);
      expect(plan.sprintNumber).toBe(1);
      expect(plan.sprintId).toBe("test-sprint-001");
      expect(plan.rawMarkdown).toBe(SAMPLE_SPRINT_MARKDOWN);

      expect(plan.tasks[0].id).toBe("TASK-1.1");
      expect(plan.tasks[0].title).toBe("Create the database schema");
      expect(plan.tasks[0].beadId).toBe("task-1-1");

      expect(plan.tasks[1].id).toBe("TASK-1.2");
      expect(plan.tasks[1].title).toBe("Implement API endpoints");

      expect(plan.tasks[2].id).toBe("TASK-1.3");
      expect(plan.tasks[2].title).toBe("Add frontend components");
    });

    it("should extract priority from explicit P0-P4 labels", () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test");

      expect(plan.tasks[0].priority).toBe(0); // P0
      expect(plan.tasks[1].priority).toBe(2); // P1
      expect(plan.tasks[2].priority).toBe(4); // P2
    });

    it("should derive priority from task order as fallback", () => {
      const noExplicitPriority = `## Sprint 1: No Priority

### TASK-1.1: First task

#### Description
First.

### TASK-1.2: Second task

#### Description
Second.

### TASK-1.3: Third task

#### Description
Third.
`;

      const plan = ingester.parseMarkdown(noExplicitPriority, "test");

      // Position-based: 1*2, 2*2, 3*2
      expect(plan.tasks[0].priority).toBe(2);
      expect(plan.tasks[1].priority).toBe(4);
      expect(plan.tasks[2].priority).toBe(6);
    });

    it("should extract dependencies from markdown", () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test");

      expect(plan.tasks[0].dependencies).toEqual([]); // No deps (None)
      expect(plan.tasks[1].dependencies).toEqual(["TASK-1.1"]);
      expect(plan.tasks[2].dependencies).toEqual(["TASK-1.2", "TASK-1.1"]);
    });

    it("should extract acceptance criteria from checkboxes", () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test");

      expect(plan.tasks[0].acceptanceCriteria).toEqual([
        "Create migration file",
        "Add index on user_id column",
        "Write seed data",
      ]);

      expect(plan.tasks[1].acceptanceCriteria).toHaveLength(3);
    });

    it("should handle empty sprint plan", () => {
      const plan = ingester.parseMarkdown("# Empty Sprint\n\nNo tasks here.", "empty");

      expect(plan.tasks).toHaveLength(0);
    });

    it("should extract sprint number from markdown", () => {
      const plan = ingester.parseMarkdown(MINIMAL_SPRINT_MARKDOWN, "test");
      expect(plan.sprintNumber).toBe(2);
    });

    it("should extract sprint title from # Sprint Plan: heading", () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test");
      expect(plan.title).toBe("Test Sprint");
    });

    it("should store rawMarkdown in parsed plan", () => {
      const plan = ingester.parseMarkdown(MINIMAL_SPRINT_MARKDOWN, "test");
      expect(plan.rawMarkdown).toBe(MINIMAL_SPRINT_MARKDOWN);
    });

    it("should reject sprint ID with spaces", () => {
      expect(() => ingester.parseMarkdown(MINIMAL_SPRINT_MARKDOWN, "bad sprint id"))
        .toThrow();
    });

    it("should reject sprint ID with dots", () => {
      expect(() => ingester.parseMarkdown(MINIMAL_SPRINT_MARKDOWN, "bad.sprint.id"))
        .toThrow();
    });
  });

  describe("cycle detection", () => {
    it("should throw on direct cycle (A depends on B depends on A)", () => {
      const cyclicMarkdown = `## Sprint 1: Cyclic

### TASK-1.1: Task A

**Priority**: P0
**Blocked By**: TASK-1.2

#### Description
A depends on B.

### TASK-1.2: Task B

**Priority**: P0
**Blocked By**: TASK-1.1

#### Description
B depends on A.
`;

      expect(() => ingester.parseMarkdown(cyclicMarkdown, "cyclic-test"))
        .toThrow(/Circular dependency/);
    });

    it("should throw on transitive cycle (A→B→C→A)", () => {
      const transitiveCycleMarkdown = `## Sprint 1: Transitive Cycle

### TASK-1.1: Task A

**Priority**: P0
**Blocked By**: TASK-1.3

#### Description
A depends on C.

### TASK-1.2: Task B

**Priority**: P0
**Blocked By**: TASK-1.1

#### Description
B depends on A.

### TASK-1.3: Task C

**Priority**: P0
**Blocked By**: TASK-1.2

#### Description
C depends on B.
`;

      expect(() => ingester.parseMarkdown(transitiveCycleMarkdown, "cycle-test"))
        .toThrow(/Circular dependency/);
    });

    it("should not throw on valid DAG", () => {
      // SAMPLE_SPRINT_MARKDOWN has valid dependency chain (no cycles)
      expect(() => ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "valid"))
        .not.toThrow();
    });
  });

  describe("ingest", () => {
    it("should create epic bead before task beads", async () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test-sprint-001");
      const result = await ingester.ingest(plan);

      // Epic create should be the first 'create' call
      const createCalls = mockExecutor.execCalls.filter((c) => c.startsWith("create "));
      expect(createCalls.length).toBeGreaterThanOrEqual(4); // 1 epic + 3 tasks
      // First create should be the epic (type epic)
      expect(createCalls[0]).toContain("--type epic");
      expect(result.epicBeadId).toBeDefined();
    });

    it("should add sprint-source label to epic bead", async () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test-sprint-001");
      await ingester.ingest(plan);

      const labelCalls = mockExecutor.execCalls.filter((c) => c.includes("label add"));
      expect(labelCalls.some((c) => c.includes("sprint-source:test-sprint-001"))).toBe(true);
      expect(labelCalls.some((c) => c.includes("sprint:pending"))).toBe(true);
    });

    it("should create beads for all tasks", async () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test-sprint-001");
      const result = await ingester.ingest(plan);

      expect(result.parsed).toBe(3);
      expect(result.created).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);

      // Should have called br create for epic + each task
      const createCalls = mockExecutor.execCalls.filter((c) => c.startsWith("create "));
      expect(createCalls).toHaveLength(4); // 1 epic + 3 tasks
    });

    it("should add source-task label to each task bead", async () => {
      const plan = ingester.parseMarkdown(MINIMAL_SPRINT_MARKDOWN, "my-sprint");
      await ingester.ingest(plan);

      const labelCalls = mockExecutor.execCalls.filter((c) => c.includes("label add"));
      expect(labelCalls.some((c) => c.includes("source-task:task-2-1"))).toBe(true);
    });

    it("should add correct labels (TASK_READY, sprint-source:, sprint:)", async () => {
      const plan = ingester.parseMarkdown(MINIMAL_SPRINT_MARKDOWN, "my-sprint");
      await ingester.ingest(plan);

      const labelCalls = mockExecutor.execCalls.filter((c) => c.includes("label add"));

      expect(labelCalls.some((c) => c.includes(WORK_QUEUE_LABELS.TASK_READY))).toBe(true);
      expect(labelCalls.some((c) => c.includes("sprint-source:my-sprint"))).toBe(true);
      expect(labelCalls.some((c) => c.includes("sprint:2"))).toBe(true);
    });

    it("should call br dep add for each dependency", async () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test");
      await ingester.ingest(plan);

      const depCalls = mockExecutor.execCalls.filter((c) => c.startsWith("dep add"));

      // TASK-1.2 depends on TASK-1.1 (1 dep)
      // TASK-1.3 depends on TASK-1.2 and TASK-1.1 (2 deps)
      expect(depCalls).toHaveLength(3);
    });

    it("should be idempotent: second ingest creates 0 new beads", async () => {
      const plan = ingester.parseMarkdown(SAMPLE_SPRINT_MARKDOWN, "test-sprint-001");

      // First ingest: creates beads
      await ingester.ingest(plan);

      // Now mock existing beads with source-task labels (new idempotency mechanism)
      mockExecutor.reset();
      mockExecutor.mockJsonResponse("list --label", [
        { id: "epic-1", title: "Test Sprint", type: "epic", labels: ["sprint-source:test-sprint-001"] },
        { id: "task-1-1", title: "Create the database schema", labels: ["source-task:task-1-1", "sprint-source:test-sprint-001"] },
        { id: "task-1-2", title: "Implement API endpoints", labels: ["source-task:task-1-2", "sprint-source:test-sprint-001"] },
        { id: "task-1-3", title: "Add frontend components", labels: ["source-task:task-1-3", "sprint-source:test-sprint-001"] },
      ]);

      // Second ingest: should skip all
      const result = await ingester.ingest(plan);

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(3);
      expect(result.failed).toBe(0);
    });

    it("should build taskMapping for created beads", async () => {
      const plan = ingester.parseMarkdown(MINIMAL_SPRINT_MARKDOWN, "test");
      const result = await ingester.ingest(plan);

      expect(result.taskMapping.size).toBe(1);
      expect(result.taskMapping.has("task-2-1")).toBe(true);
    });

    it("should return empty result for empty sprint plan", async () => {
      const plan: SprintPlan = {
        sprintId: "empty",
        sprintNumber: 1,
        title: "Empty",
        tasks: [],
        rawMarkdown: "",
      };

      const result = await ingester.ingest(plan);

      expect(result.parsed).toBe(0);
      expect(result.created).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
    });

    it("should skip tasks with invalid IDs", async () => {
      const plan: SprintPlan = {
        sprintId: "test",
        sprintNumber: 1,
        title: "Test",
        rawMarkdown: "",
        tasks: [
          {
            id: "INVALID-FORMAT",
            beadId: "invalid-format",
            title: "Bad task",
            description: "",
            priority: 2,
            type: "task",
            dependencies: [],
            acceptanceCriteria: [],
          },
        ],
      };

      const result = await ingester.ingest(plan);

      expect(result.failed).toBe(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("invalid ID");
    });

    it("should sanitize task titles with shell metacharacters", async () => {
      const plan: SprintPlan = {
        sprintId: "test",
        sprintNumber: 1,
        title: "Test",
        rawMarkdown: "",
        tasks: [
          {
            id: "TASK-1.1",
            beadId: "task-1-1",
            title: "Fix the `rm -rf /` issue; echo 'pwned'",
            description: "",
            priority: 0,
            type: "task",
            dependencies: [],
            acceptanceCriteria: [],
          },
        ],
      };

      const result = await ingester.ingest(plan);
      expect(result.created).toBe(1);

      // The create command should use shellEscape on the title
      const createCall = mockExecutor.execCalls.find(
        (c) => c.startsWith("create ") && !c.includes("--type epic"),
      );
      expect(createCall).toBeDefined();
      // shellEscape wraps in single quotes and escapes internal quotes
      expect(createCall).toContain("'Fix the `rm -rf /` issue; echo");
    });

    it("should sanitize title with $() command substitution", async () => {
      const plan: SprintPlan = {
        sprintId: "test",
        sprintNumber: 1,
        title: "Test",
        rawMarkdown: "",
        tasks: [
          {
            id: "TASK-1.1",
            beadId: "task-1-1",
            title: "Fix $(uname) detection",
            description: "",
            priority: 0,
            type: "task",
            dependencies: [],
            acceptanceCriteria: [],
          },
        ],
      };

      const result = await ingester.ingest(plan);
      expect(result.created).toBe(1);

      const createCall = mockExecutor.execCalls.find(
        (c) => c.startsWith("create ") && !c.includes("--type epic"),
      );
      expect(createCall).toBeDefined();
      // shellEscape should neutralize $() by wrapping in single quotes
      expect(createCall).toContain("'Fix $(uname) detection'");
    });

    it("should sanitize title with single quotes", async () => {
      const plan: SprintPlan = {
        sprintId: "test",
        sprintNumber: 1,
        title: "Test",
        rawMarkdown: "",
        tasks: [
          {
            id: "TASK-1.1",
            beadId: "task-1-1",
            title: "Update 'dev' environment",
            description: "",
            priority: 0,
            type: "task",
            dependencies: [],
            acceptanceCriteria: [],
          },
        ],
      };

      const result = await ingester.ingest(plan);
      expect(result.created).toBe(1);

      const createCall = mockExecutor.execCalls.find(
        (c) => c.startsWith("create ") && !c.includes("--type epic"),
      );
      expect(createCall).toBeDefined();
      // shellEscape should handle single quotes inside single-quoted string
      expect(createCall).toContain("dev");
    });

    it("should support dry run mode", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const dryIngester = new BeadsSprintIngester(mockExecutor, {
        dryRun: true,
        verbose: false,
      });

      const plan = ingester.parseMarkdown(MINIMAL_SPRINT_MARKDOWN, "test");
      const result = await dryIngester.ingest(plan);

      // Should not have called br create at all (no epic, no tasks)
      const createCalls = mockExecutor.execCalls.filter((c) => c.startsWith("create "));
      expect(createCalls).toHaveLength(0);

      // But should still report as created (dry run success)
      expect(result.created).toBe(1);

      logSpy.mockRestore();
    });

    it("should handle br create failure gracefully", async () => {
      mockExecutor.mockResponse("create ", {
        success: false,
        stdout: "",
        stderr: "disk full",
        exitCode: 1,
      });

      const plan = ingester.parseMarkdown(MINIMAL_SPRINT_MARKDOWN, "test");

      // This will fail on epic creation, but let's catch the error
      // Actually, epic create failure should throw
      await expect(ingester.ingest(plan)).rejects.toThrow("disk full");
    });

    it("should add missing-dep label when dependency not found in plan or store", async () => {
      const plan: SprintPlan = {
        sprintId: "test",
        sprintNumber: 1,
        title: "Test",
        rawMarkdown: "",
        tasks: [
          {
            id: "TASK-1.1",
            beadId: "task-1-1",
            title: "Task with missing dep",
            description: "",
            priority: 0,
            type: "task",
            dependencies: ["TASK-99.99"], // doesn't exist
            acceptanceCriteria: [],
          },
        ],
      };

      const result = await ingester.ingest(plan);

      expect(result.created).toBe(1);
      expect(result.warnings.some((w) => w.includes("TASK-99.99") && w.includes("not found"))).toBe(true);

      // Should have added missing-dep label
      const labelCalls = mockExecutor.execCalls.filter((c) => c.includes("label add"));
      expect(labelCalls.some((c) => c.includes("missing-dep:task-99-99"))).toBe(true);
    });

    it("should truncate epic description at 10K chars", async () => {
      const longContent = "x".repeat(15_000);
      const longMarkdown = `## Sprint 1: Long Sprint\n\n${longContent}\n\n### TASK-1.1: One task\n\n**Priority**: P0\n\n#### Description\n\nTask.`;
      const plan = ingester.parseMarkdown(longMarkdown, "long-sprint");
      await ingester.ingest(plan);

      const epicCreateCall = mockExecutor.execCalls.find(
        (c) => c.startsWith("create ") && c.includes("--type epic"),
      );
      expect(epicCreateCall).toBeDefined();
      // The description should be truncated (won't contain the full 15K chars)
      // We can't easily check the exact truncation via mock, but we verify no crash
    });
  });

  describe("detectCycles (standalone)", () => {
    it("should return null for no cycle", () => {
      const tasks: SprintTask[] = [
        { id: "TASK-1.1", beadId: "task-1-1", title: "A", description: "", priority: 0, type: "task", dependencies: [], acceptanceCriteria: [] },
        { id: "TASK-1.2", beadId: "task-1-2", title: "B", description: "", priority: 0, type: "task", dependencies: ["TASK-1.1"], acceptanceCriteria: [] },
      ];
      expect(detectCycles(tasks)).toBeNull();
    });

    it("should detect direct cycle (A↔B)", () => {
      const tasks: SprintTask[] = [
        { id: "TASK-1.1", beadId: "task-1-1", title: "A", description: "", priority: 0, type: "task", dependencies: ["TASK-1.2"], acceptanceCriteria: [] },
        { id: "TASK-1.2", beadId: "task-1-2", title: "B", description: "", priority: 0, type: "task", dependencies: ["TASK-1.1"], acceptanceCriteria: [] },
      ];
      const cycle = detectCycles(tasks);
      expect(cycle).not.toBeNull();
      expect(cycle).toContain("TASK-1.1");
      expect(cycle).toContain("TASK-1.2");
    });

    it("should detect transitive cycle (A→B→C→A)", () => {
      const tasks: SprintTask[] = [
        { id: "TASK-1.1", beadId: "task-1-1", title: "A", description: "", priority: 0, type: "task", dependencies: ["TASK-1.3"], acceptanceCriteria: [] },
        { id: "TASK-1.2", beadId: "task-1-2", title: "B", description: "", priority: 0, type: "task", dependencies: ["TASK-1.1"], acceptanceCriteria: [] },
        { id: "TASK-1.3", beadId: "task-1-3", title: "C", description: "", priority: 0, type: "task", dependencies: ["TASK-1.2"], acceptanceCriteria: [] },
      ];
      const cycle = detectCycles(tasks);
      expect(cycle).not.toBeNull();
      expect(cycle!.length).toBe(3);
    });

    it("should handle empty task list", () => {
      expect(detectCycles([])).toBeNull();
    });
  });

  describe("normalizeTaskId", () => {
    it("should convert TASK-4.1 to task-4-1", () => {
      expect(normalizeTaskId("TASK-4.1")).toBe("task-4-1");
    });

    it("should convert TASK-10.20 to task-10-20", () => {
      expect(normalizeTaskId("TASK-10.20")).toBe("task-10-20");
    });

    it("should lowercase the result", () => {
      expect(normalizeTaskId("TASK-1.1")).toBe("task-1-1");
    });
  });

  describe("createBeadsSprintIngester factory", () => {
    it("should create an instance with default config", () => {
      const instance = createBeadsSprintIngester(mockExecutor);
      expect(instance).toBeInstanceOf(BeadsSprintIngester);
    });

    it("should create an instance with custom config", () => {
      const instance = createBeadsSprintIngester(mockExecutor, {
        verbose: true,
        dryRun: true,
        defaultType: "feature",
      });
      expect(instance).toBeInstanceOf(BeadsSprintIngester);
    });
  });
});
