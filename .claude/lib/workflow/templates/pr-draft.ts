// .claude/lib/workflow/templates/pr-draft.ts — PR Draft template (SDD 3.2, TASK-5.2)

import { createHash } from "node:crypto";
import { BaseTemplate, templateRegistry, type ActionPolicyDef, type TemplateItem } from "./base.js";

// ── GitHub API client interface (constructor-injected) ──

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  pull_request?: unknown;
  updated_at?: string;
  reactions?: Record<string, number>;
  assignee?: string | null;
}

export interface PrDraftClient {
  listIssues(opts: { state: "open" | "closed"; labels?: string }): Promise<Issue[]>;
  getIssue(opts: { number: number }): Promise<Issue>;
  searchIssues(query: string): Promise<Issue[]>;
}

// ── Config ──

export interface PrDraftConfig {
  /** Maximum diff lines allowed in the generated PR. Default: 500 */
  maxDiffLines?: number;
  /** Maximum files changed allowed in the generated PR. Default: 20 */
  maxFilesChanged?: number;
  /** Branch prefix for agent-created branches. Default: "agent" */
  branchPrefix?: string;
}

// ── Action policy ──

const PR_DRAFT_POLICY: ActionPolicyDef = {
  templateId: "pr-draft",
  allow: [
    "list_issues",
    "get_issue",
    "search_issues",
    "get_file_contents",
    "list_commits",
    "create_branch",
    "create_or_update_file",
    "push_files",
    "create_pull_request",
    "add_issue_comment",
  ],
  deny: ["merge_pull_request", "delete_branch", "update_pull_request_branch"],
  constraints: {
    create_pull_request: { draftOnly: true },
    create_or_update_file: {
      /* branch pattern enforced by tool registry */
    },
  },
};

// ── PR Draft Template ──

export class PrDraftTemplate extends BaseTemplate {
  readonly id = "pr-draft";
  readonly name = "PR Draft";
  readonly actionPolicy: ActionPolicyDef = PR_DRAFT_POLICY;
  readonly canonicalHashFields = ["title", "body", "labels"];
  readonly excludedHashFields = ["updated_at", "reactions", "assignee"];

  private readonly client: PrDraftClient;
  private readonly config: Required<PrDraftConfig>;

  constructor(client: PrDraftClient, config?: PrDraftConfig) {
    super();
    this.client = client;
    this.config = {
      maxDiffLines: config?.maxDiffLines ?? 500,
      maxFilesChanged: config?.maxFilesChanged ?? 20,
      branchPrefix: config?.branchPrefix ?? "agent",
    };
  }

  /** List open issues with "ready-for-pr" label, exclude those with linked PRs. */
  async resolveItems(): Promise<TemplateItem[]> {
    const openIssues = await this.client.listIssues({ state: "open" });

    // Only include issues that have the "ready-for-pr" label and no linked PR
    const readyIssues = openIssues.filter(
      (issue) => issue.labels.includes("ready-for-pr") && !issue.pull_request,
    );

    const items: TemplateItem[] = [];
    for (const issue of readyIssues) {
      const data: Record<string, unknown> = {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        // Volatile fields (excluded from hash)
        updated_at: issue.updated_at,
        reactions: issue.reactions,
        assignee: issue.assignee,
      };

      const item: TemplateItem = {
        key: `issue-${issue.number}`,
        hash: "",
        data,
      };
      item.hash = this.computeStateHash(item);

      items.push(item);
    }

    return items;
  }

  /** Build an implementation prompt with MVP constraints. */
  buildPrompt(item: TemplateItem): string {
    const issueNumber = item.data.number as number;
    const issueTitle = item.data.title as string;
    const issueBody = item.data.body as string;
    const labels = item.data.labels as string[];

    const sections: string[] = [];

    // Header
    sections.push(`## Issue #${issueNumber}: ${issueTitle}`);

    // Issue context
    sections.push("\n### Issue Context");
    if (labels.length > 0) {
      sections.push(`Labels: ${labels.join(", ")}`);
    }
    if (issueBody) {
      sections.push(issueBody);
    } else {
      sections.push("(No body provided.)");
    }

    // Implementation instructions
    sections.push("\n### Implementation Instructions");
    sections.push("Create a draft pull request that addresses this issue.");
    sections.push("Follow the repository's coding standards and conventions.");
    sections.push("Include tests for any new functionality.");

    // MVP constraints
    sections.push("\n### MVP Constraints");
    sections.push(`- Maximum diff lines: ${this.config.maxDiffLines}`);
    sections.push(`- Maximum files changed: ${this.config.maxFilesChanged}`);
    sections.push("- PR must be created as a **draft** (not ready for review).");
    sections.push("- Keep changes minimal and focused on the issue.");

    return sections.join("\n");
  }

  /** Build a branch name in the format: {prefix}/{jobId}/{issueNumber} */
  buildBranchName(jobId: string, issueNumber: number): string {
    return `${this.config.branchPrefix}/${jobId}/${issueNumber}`;
  }

  /** Check whether a proposed change set fits within MVP constraints. */
  checkMvpConstraints(
    diffLines: number,
    filesChanged: number,
  ): { pass: boolean; violations: string[] } {
    const violations: string[] = [];

    if (diffLines > this.config.maxDiffLines) {
      violations.push(`Diff lines ${diffLines} exceeds maximum ${this.config.maxDiffLines}`);
    }

    if (filesChanged > this.config.maxFilesChanged) {
      violations.push(
        `Files changed ${filesChanged} exceeds maximum ${this.config.maxFilesChanged}`,
      );
    }

    return { pass: violations.length === 0, violations };
  }
}

// ── Self-register on the global registry ──

templateRegistry.register(
  new PrDraftTemplate({
    async listIssues() {
      return [];
    },
    async getIssue() {
      return { number: 0, title: "", body: "", labels: [], state: "open" };
    },
    async searchIssues() {
      return [];
    },
  }),
);
