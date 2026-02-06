/**
 * Beads Sprint Ingester
 *
 * Parses sprint.md task definitions and creates beads via `br create`,
 * with priority mapping, labels, and dependency wiring.
 *
 * SECURITY: All task titles are sanitized via shellEscape(), IDs validated
 * via validateBeadId() pattern, labels validated via validateLabel().
 *
 * @module beads/sprint-ingester
 * @version 1.0.0
 */

import {
  validateLabel,
  shellEscape,
  filterValidLabels,
  LABELS,
  type IBrExecutor,
  type Bead,
} from "../../../.claude/lib/beads";

import { WORK_QUEUE_LABELS } from "./beads-work-queue.js";

// =============================================================================
// Constants
// =============================================================================

/**
 * Valid task ID pattern: TASK-N.M where N and M are integers.
 * Used internally for parsing; actual bead IDs are normalized
 * (e.g., "TASK-4.1" → "task-4-1").
 */
const TASK_ID_PATTERN = /^TASK-\d+\.\d+$/;

/** Priority mapping from P-labels to numeric values */
const PRIORITY_MAP: Record<string, number> = {
  P0: 0,
  P1: 2,
  P2: 4,
  P3: 6,
  P4: 8,
};

/** Default priority for tasks without explicit priority */
const DEFAULT_PRIORITY_STEP = 2;

/**
 * Max chars for epic description (sprint.md content).
 * Capped at 900 to stay within shellEscape's MAX_STRING_LENGTH (1024)
 * after escaping overhead.
 */
const MAX_EPIC_DESCRIPTION_LENGTH = 900;

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed task from sprint markdown
 */
export interface SprintTask {
  /** Task ID, e.g., "TASK-5.6" */
  id: string;

  /** Normalized bead ID, e.g., "task-5-6" */
  beadId: string;

  /** Task title */
  title: string;

  /** Task description */
  description: string;

  /** Numeric priority (0-8) */
  priority: number;

  /** Task type */
  type: "task" | "bug" | "feature";

  /** IDs of blocking tasks (raw TASK-N.M format) */
  dependencies: string[];

  /** Acceptance criteria items */
  acceptanceCriteria: string[];
}

/**
 * Parsed sprint plan
 */
export interface SprintPlan {
  /** Sprint identifier */
  sprintId: string;

  /** Sprint number */
  sprintNumber: number;

  /** Sprint title */
  title: string;

  /** Parsed tasks */
  tasks: SprintTask[];

  /** Raw markdown content (stored in epic bead description) */
  rawMarkdown: string;
}

/**
 * Result of an ingestion operation
 */
export interface IngestionResult {
  /** Total tasks parsed from markdown */
  parsed: number;

  /** Beads created */
  created: number;

  /** Tasks skipped (already exist) */
  skipped: number;

  /** Tasks that failed to create */
  failed: number;

  /** Warnings during ingestion */
  warnings: string[];

  /** Per-task details */
  details: Array<{
    taskId: string;
    beadId: string;
    status: "created" | "skipped" | "failed";
    error?: string;
  }>;

  /** ID of the sprint epic bead (if created) */
  epicBeadId?: string;

  /** Mapping of normalized task ID → created bead ID */
  taskMapping: Map<string, string>;
}

/**
 * Configuration for the ingester
 */
export interface IngesterConfig {
  /** Enable verbose logging */
  verbose?: boolean;

  /** Dry run mode (parse only, don't create beads) */
  dryRun?: boolean;

  /** Default task type when not specified */
  defaultType?: "task" | "bug" | "feature";
}

// =============================================================================
// BeadsSprintIngester
// =============================================================================

/**
 * Parses sprint.md markdown and creates beads for each task.
 *
 * Supports the standard sprint.md format:
 * - `### TASK-N.M: Title` headers
 * - `**Priority**: P0-P4` labels
 * - `**Blocked By**: TASK-X.Y, TASK-X.Z` dependency lines
 * - `- [ ]` checkbox items as acceptance criteria
 *
 * @example
 * ```typescript
 * const executor = new DefaultBrExecutor("br");
 * const ingester = new BeadsSprintIngester(executor);
 * const result = await ingester.ingestFromMarkdown(markdown, "sprint-1");
 * console.log(`Created ${result.created} beads`);
 * ```
 */
export class BeadsSprintIngester {
  private readonly executor: IBrExecutor;
  private readonly config: Required<IngesterConfig>;

  constructor(executor: IBrExecutor, config?: IngesterConfig) {
    this.executor = executor;
    this.config = {
      verbose: config?.verbose ?? false,
      dryRun: config?.dryRun ?? false,
      defaultType: config?.defaultType ?? "task",
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ingest a parsed sprint plan, creating beads for each task.
   *
   * Idempotent: checks existing beads before creating. If a bead
   * with matching title and sprint label already exists, it's skipped.
   */
  async ingest(sprintPlan: SprintPlan): Promise<IngestionResult> {
    const result: IngestionResult = {
      parsed: sprintPlan.tasks.length,
      created: 0,
      skipped: 0,
      failed: 0,
      warnings: [],
      details: [],
      taskMapping: new Map(),
    };

    if (sprintPlan.tasks.length === 0) {
      return result;
    }

    // Phase 0: Create sprint epic bead (if not exists)
    const sprintSourceLabel = `sprint-source:${sprintPlan.sprintId}`;
    let epicBeadId: string | undefined;
    if (!this.config.dryRun) {
      epicBeadId = await this.createEpicBead(sprintPlan, sprintSourceLabel);
      result.epicBeadId = epicBeadId;
    }

    // Get existing beads for this sprint (idempotency check)
    const existingBeads = await this.getExistingSprintBeads(sprintSourceLabel);

    // Phase 1: Create task beads
    for (const task of sprintPlan.tasks) {
      // Skip tasks with invalid IDs
      if (!TASK_ID_PATTERN.test(task.id)) {
        result.warnings.push(`Skipping task with invalid ID: ${task.id}`);
        result.failed++;
        result.details.push({
          taskId: task.id,
          beadId: task.beadId,
          status: "failed",
          error: `Invalid task ID format: ${task.id}`,
        });
        continue;
      }

      // Idempotency: skip if bead already exists with source-task label
      const existingBead = this.findExistingBead(existingBeads, task.beadId);
      if (existingBead) {
        this.logDebug(`Skipping existing task: ${task.id} (${task.title})`);
        result.skipped++;
        result.taskMapping.set(task.beadId, existingBead.id);
        result.details.push({
          taskId: task.id,
          beadId: task.beadId,
          status: "skipped",
        });
        continue;
      }

      try {
        const createdId = await this.createTaskBead(task, sprintPlan, epicBeadId);
        result.created++;
        result.taskMapping.set(task.beadId, createdId);
        result.details.push({
          taskId: task.id,
          beadId: task.beadId,
          status: "created",
        });
      } catch (e) {
        result.failed++;
        result.warnings.push(`Failed to create bead for ${task.id}: ${e}`);
        result.details.push({
          taskId: task.id,
          beadId: task.beadId,
          status: "failed",
          error: String(e),
        });
      }
    }

    // Phase 2: Wire dependencies after all beads are created
    if (!this.config.dryRun) {
      await this.wireDependencies(sprintPlan.tasks, result);
    }

    this.log(
      `Ingested sprint ${sprintPlan.sprintId}: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed`,
    );

    return result;
  }

  /**
   * Parse sprint markdown and ingest tasks.
   *
   * @param markdown - Sprint plan markdown content
   * @param sprintId - Sprint identifier (e.g., "persistent-memory-001")
   * @returns Ingestion result
   */
  async ingestFromMarkdown(markdown: string, sprintId: string): Promise<IngestionResult> {
    const sprintPlan = this.parseMarkdown(markdown, sprintId);
    return this.ingest(sprintPlan);
  }

  /**
   * Parse sprint markdown into a SprintPlan (pure parsing, no side effects).
   *
   * Exported for testing.
   */
  parseMarkdown(markdown: string, sprintId: string): SprintPlan {
    // Validate sprint ID against LABEL_PATTERN before use in labels
    validateLabel(`sprint-source:${sprintId}`);

    const tasks: SprintTask[] = [];
    const lines = markdown.split("\n");
    let sprintNumber = 1;
    let sprintTitle = sprintId;

    // Extract sprint number from Sprint N: pattern
    const sprintNumMatch = markdown.match(/## Sprint (\d+):/);
    if (sprintNumMatch) {
      sprintNumber = parseInt(sprintNumMatch[1], 10);
    }

    // Also try "# Sprint Plan:" title for sprint title
    const planTitleMatch = markdown.match(/^#\s+Sprint Plan:\s*(.+)/m);
    const sprintTitleMatch = markdown.match(/## Sprint \d+:\s*(.+)/);
    if (planTitleMatch) {
      sprintTitle = planTitleMatch[1].trim();
    } else if (sprintTitleMatch) {
      sprintTitle = sprintTitleMatch[1].trim();
    }

    // Parse tasks: look for ### TASK-N.M: Title headers
    let currentTask: Partial<SprintTask> | null = null;
    let inDescription = false;
    let inAcceptanceCriteria = false;
    let descriptionLines: string[] = [];
    let taskPosition = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match task headers: ### TASK-N.M: Title
      const taskMatch = line.match(/^###\s+TASK-(\d+\.\d+):\s*(.+)/);
      if (taskMatch) {
        // Save previous task
        if (currentTask?.id) {
          currentTask.description = descriptionLines.join("\n").trim();
          tasks.push(currentTask as SprintTask);
        }

        taskPosition++;
        const taskId = `TASK-${taskMatch[1]}`;
        const title = taskMatch[2].trim();

        // Validate title
        validateTaskTitle(title);

        currentTask = {
          id: taskId,
          beadId: normalizeTaskId(taskId),
          title,
          description: "",
          priority: taskPosition * DEFAULT_PRIORITY_STEP, // Default from position
          type: this.inferType(title),
          dependencies: [],
          acceptanceCriteria: [],
        };

        descriptionLines = [];
        inDescription = false;
        inAcceptanceCriteria = false;
        continue;
      }

      if (!currentTask) continue;

      // Parse priority: **Priority**: P0-P4
      const priorityMatch = line.match(/\*\*Priority\*\*:\s*P([0-4])/);
      if (priorityMatch) {
        const pLabel = `P${priorityMatch[1]}`;
        currentTask.priority = PRIORITY_MAP[pLabel] ?? currentTask.priority;
        continue;
      }

      // Parse dependencies: **Blocked By**: TASK-X.Y, TASK-X.Z
      const depsMatch = line.match(/\*\*(?:Blocked\s*By|Dependencies)\*\*:\s*(.+)/i);
      if (depsMatch) {
        const depIds = depsMatch[1].match(/TASK-\d+\.\d+/g) ?? [];
        currentTask.dependencies = depIds;
        continue;
      }

      // Detect acceptance criteria section
      if (line.match(/^####?\s*Acceptance\s+Criteria/i)) {
        inAcceptanceCriteria = true;
        inDescription = false;
        continue;
      }

      // Detect description section
      if (line.match(/^####?\s*Description/i)) {
        inDescription = true;
        inAcceptanceCriteria = false;
        continue;
      }

      // End sections on next heading
      if (line.match(/^####?\s/) && !line.match(/^####?\s*(Description|Acceptance)/i)) {
        inDescription = false;
        inAcceptanceCriteria = false;
        continue;
      }

      // Parse acceptance criteria checkboxes
      if (inAcceptanceCriteria) {
        const checkboxMatch = line.match(/^\s*-\s*\[[ x]]\s+(.+)/i);
        if (checkboxMatch) {
          currentTask.acceptanceCriteria!.push(checkboxMatch[1].trim());
        }
        continue;
      }

      // Accumulate description lines
      if (inDescription) {
        descriptionLines.push(line);
      }
    }

    // Don't forget the last task
    if (currentTask?.id) {
      currentTask.description = descriptionLines.join("\n").trim();
      tasks.push(currentTask as SprintTask);
    }

    // Detect circular dependencies via Kahn's algorithm
    const cycleNodes = detectCycles(tasks);
    if (cycleNodes) {
      throw new Error(
        `Circular dependency detected among tasks: ${cycleNodes.join(" → ")}`,
      );
    }

    return {
      sprintId,
      sprintNumber,
      title: sprintTitle,
      tasks,
      rawMarkdown: markdown,
    };
  }

  /**
   * Infer task type from title keywords.
   */
  private inferType(title: string): "task" | "bug" | "feature" {
    const lower = title.toLowerCase();
    if (lower.includes("bug") || lower.includes("fix")) return "bug";
    if (lower.includes("feature") || lower.includes("add") || lower.includes("create") || lower.includes("implement")) return "feature";
    return this.config.defaultType;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a sprint epic bead (idempotent — skips if already exists).
   * Returns the epic bead ID.
   */
  private async createEpicBead(
    plan: SprintPlan,
    sprintSourceLabel: string,
  ): Promise<string> {
    // Check if epic already exists
    try {
      validateLabel(sprintSourceLabel);
      const existing = await this.executor.execJson<Bead[]>(
        `list --label ${shellEscape(sprintSourceLabel)} --type epic --json`,
      );
      if (existing && existing.length > 0) {
        this.logDebug(`Epic already exists for sprint ${plan.sprintId}: ${existing[0].id}`);
        return existing[0].id;
      }
    } catch {
      // If query fails, proceed with creation
    }

    // Truncate description if too large
    const description = plan.rawMarkdown.length > MAX_EPIC_DESCRIPTION_LENGTH
      ? plan.rawMarkdown.slice(0, MAX_EPIC_DESCRIPTION_LENGTH) + "\n\n[truncated]"
      : plan.rawMarkdown;

    const escapedTitle = shellEscape(plan.title);
    const escapedDesc = shellEscape(description);
    const result = await this.executor.exec(
      `create ${escapedTitle} --type epic --description ${escapedDesc}`,
    );

    if (!result.success) {
      throw new Error(`Failed to create sprint epic: ${result.stderr}`);
    }

    const epicId = result.stdout.trim();

    // Add sprint-source and sprint:pending labels
    await this.executor.exec(`label add ${shellEscape(epicId)} ${shellEscape(sprintSourceLabel)}`);
    await this.executor.exec(`label add ${shellEscape(epicId)} 'sprint:pending'`);

    this.logDebug(`Created epic bead ${epicId} for sprint ${plan.sprintId}`);
    return epicId;
  }

  /**
   * Get existing beads for a sprint (for idempotency).
   */
  private async getExistingSprintBeads(sprintSourceLabel: string): Promise<Bead[]> {
    try {
      validateLabel(sprintSourceLabel);
      const beads = await this.executor.execJson<Bead[]>(
        `list --label ${shellEscape(sprintSourceLabel)} --json`,
      );
      return beads ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Find an existing bead by source-task label.
   */
  private findExistingBead(existingBeads: Bead[], normalizedId: string): Bead | undefined {
    const sourceLabel = `source-task:${normalizedId}`;
    return existingBeads.find(
      (b) => (b.labels || []).includes(sourceLabel),
    );
  }

  /**
   * Create a single task bead with labels.
   * Returns the created bead ID.
   */
  private async createTaskBead(
    task: SprintTask,
    plan: SprintPlan,
    epicBeadId?: string,
  ): Promise<string> {
    if (this.config.dryRun) {
      this.log(`[DRY RUN] Would create: ${task.beadId} "${task.title}"`);
      return task.beadId;
    }

    // Build labels
    const hasUnresolvedDeps = task.dependencies.length > 0;
    const labels: string[] = [
      hasUnresolvedDeps ? WORK_QUEUE_LABELS.TASK_BLOCKED : WORK_QUEUE_LABELS.TASK_READY,
      `source-task:${task.beadId}`,
      `sprint-source:${plan.sprintId}`,
      `sprint:${plan.sprintNumber}`,
    ];

    // Link to epic if available
    if (epicBeadId) {
      labels.push(`epic:${epicBeadId}`);
    }

    // Add classification label if task has explicit type
    if (task.type !== "task") {
      labels.push(`class:${task.type}`);
    }

    // Validate all labels before use
    const validLabels = filterValidLabels(labels);

    // Build br create command
    const escapedTitle = shellEscape(task.title);
    const escapedDesc = task.description
      ? ` --description ${shellEscape(task.description)}`
      : "";

    const cmd = `create ${escapedTitle} --type ${task.type} --priority ${task.priority}${escapedDesc}`;

    const result = await this.executor.exec(cmd);
    if (!result.success) {
      throw new Error(`br create failed: ${result.stderr}`);
    }

    // Extract bead ID from create output (br create outputs the new ID)
    const createdId = result.stdout.trim() || task.beadId;

    // Add labels
    for (const label of validLabels) {
      await this.executor.exec(`label add ${shellEscape(createdId)} ${shellEscape(label)}`);
    }

    this.logDebug(`Created bead ${createdId} for ${task.id}: "${task.title}" (P${task.priority})`);
    return createdId;
  }

  /**
   * Wire dependencies between tasks using `br dep add`.
   * If a blocker is not found, adds a `missing-dep:` label.
   */
  private async wireDependencies(tasks: SprintTask[], result: IngestionResult): Promise<void> {
    for (const task of tasks) {
      if (task.dependencies.length === 0) continue;

      // Only wire deps for tasks that were created or skipped (already exists)
      const detail = result.details.find((d) => d.taskId === task.id);
      if (!detail || detail.status === "failed") continue;

      // Resolve task's own bead ID from mapping
      const taskCreatedId = result.taskMapping.get(task.beadId) ?? task.beadId;

      for (const depId of task.dependencies) {
        const normalizedDep = normalizeTaskId(depId);
        const depCreatedId = result.taskMapping.get(normalizedDep);

        if (!depCreatedId) {
          // Try cross-sprint lookup
          const foundId = await this.lookupBeadBySourceTask(normalizedDep);
          if (foundId) {
            try {
              await this.executor.exec(
                `dep add ${shellEscape(taskCreatedId)} ${shellEscape(foundId)}`,
              );
              this.logDebug(`Wired cross-sprint dependency: ${task.id} depends on ${depId}`);
            } catch (e) {
              result.warnings.push(
                `Failed to wire dependency ${task.id} → ${depId}: ${e}`,
              );
            }
          } else {
            // Add missing-dep label
            const missingLabel = `missing-dep:${normalizedDep}`;
            try {
              validateLabel(missingLabel);
              await this.executor.exec(
                `label add ${shellEscape(taskCreatedId)} ${shellEscape(missingLabel)}`,
              );
            } catch {
              // Label validation failed — skip silently
            }
            result.warnings.push(
              `Task ${task.id}: dependency ${depId} not found, added missing-dep label`,
            );
          }
          continue;
        }

        try {
          await this.executor.exec(
            `dep add ${shellEscape(taskCreatedId)} ${shellEscape(depCreatedId)}`,
          );
          this.logDebug(`Wired dependency: ${task.id} depends on ${depId}`);
        } catch (e) {
          result.warnings.push(
            `Failed to wire dependency ${task.id} → ${depId}: ${e}`,
          );
        }
      }
    }
  }

  /**
   * Look up a bead by source-task label (cross-sprint lookup).
   */
  private async lookupBeadBySourceTask(normalizedId: string): Promise<string | null> {
    try {
      const sourceLabel = `source-task:${normalizedId}`;
      validateLabel(sourceLabel);
      const beads = await this.executor.execJson<Bead[]>(
        `list --label ${shellEscape(sourceLabel)} --json`,
      );
      if (beads && beads.length > 0) {
        return beads[0].id;
      }
    } catch {
      // Query failed
    }
    return null;
  }

  private log(message: string): void {
    console.log(`[beads-sprint-ingester] ${message}`);
  }

  private logDebug(message: string): void {
    if (this.config.verbose) {
      console.log(`[beads-sprint-ingester] DEBUG: ${message}`);
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Normalize a task ID (e.g., "TASK-4.1") to a valid bead ID ("task-4-1").
 * Bead IDs must match /^[a-zA-Z0-9_-]+$/ (no dots allowed).
 */
export function normalizeTaskId(taskId: string): string {
  return taskId.toLowerCase().replace(/\./g, "-");
}

/**
 * Detect circular dependencies using Kahn's algorithm (topological sort).
 *
 * @returns Array of task IDs in the cycle, or null if no cycle exists
 */
export function detectCycles(tasks: SprintTask[]): string[] | null {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  // Initialize all tasks
  for (const task of tasks) {
    if (!inDegree.has(task.id)) inDegree.set(task.id, 0);
    if (!adj.has(task.id)) adj.set(task.id, []);
  }

  // Build adjacency list (dep → task means "dep must finish before task")
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (adj.has(dep)) {
        adj.get(dep)!.push(task.id);
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      }
    }
  }

  // Kahn's: start with nodes having in-degree 0
  const queue = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id);
  let processed = 0;

  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (processed < tasks.length) {
    // Return nodes that are part of the cycle (in-degree > 0)
    return [...inDegree.entries()]
      .filter(([, d]) => d > 0)
      .map(([id]) => id);
  }
  return null;
}

/**
 * Validate a task title for safety.
 */
function validateTaskTitle(title: string): void {
  if (title.includes("\n")) {
    throw new Error(`Task title contains newlines: "${title.slice(0, 50)}"`);
  }
  if (title.length > 200) {
    throw new Error(`Task title exceeds 200 chars: "${title.slice(0, 50)}..."`);
  }
  if (title.trim() !== title) {
    throw new Error(`Task title has leading/trailing whitespace: "${title}"`);
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new BeadsSprintIngester instance.
 */
export function createBeadsSprintIngester(
  executor: IBrExecutor,
  config?: IngesterConfig,
): BeadsSprintIngester {
  return new BeadsSprintIngester(executor, config);
}
