// .claude/lib/workflow/templates/issue-triage.ts — Issue Triage template (SDD 3.2, TASK-5.1)

import { createHash } from "node:crypto";
import { BaseTemplate, templateRegistry, type ActionPolicyDef, type TemplateItem } from "./base.js";

// ── GitHub API client interface (constructor-injected) ──

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  commentCount: number;
  updated_at?: string;
  reactions?: Record<string, number>;
  assignee?: string | null;
  milestone?: string | null;
}

export interface IssueClient {
  listIssues(opts: { state: "open" | "closed" }): Promise<Issue[]>;
  getIssue(opts: { number: number }): Promise<Issue>;
}

// ── Issue Triage Template ──

const ISSUE_TRIAGE_POLICY: ActionPolicyDef = {
  templateId: "issue-triage",
  allow: ["list_issues", "get_issue", "search_issues", "update_issue", "add_issue_comment"],
  deny: ["close_issue", "delete_issue", "merge_pull_request", "create_pull_request"],
  constraints: {
    update_issue: {
      labelsOnly: [
        "bug",
        "enhancement",
        "question",
        "docs",
        "invalid",
        "P0",
        "P1",
        "P2",
        "P3",
        "triaged",
      ],
    },
  },
};

export class IssueTriageTemplate extends BaseTemplate {
  readonly id = "issue-triage";
  readonly name = "Issue Triage";
  readonly actionPolicy: ActionPolicyDef = ISSUE_TRIAGE_POLICY;
  readonly canonicalHashFields = ["title", "body", "labels", "commentCount"];
  readonly excludedHashFields = ["updated_at", "reactions", "assignee", "milestone"];

  readonly schedule = "*/15 * * * *"; // every 15 minutes

  private readonly client: IssueClient;

  constructor(client: IssueClient) {
    super();
    this.client = client;
  }

  /** List open issues, filter out those already triaged, compute hash. */
  async resolveItems(): Promise<TemplateItem[]> {
    const openIssues = await this.client.listIssues({ state: "open" });

    // Filter out issues that already carry the "triaged" label
    const untriagedIssues = openIssues.filter((issue) => !issue.labels.includes("triaged"));

    const items: TemplateItem[] = [];
    for (const issue of untriagedIssues) {
      const data: Record<string, unknown> = {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        commentCount: issue.commentCount,
        // Volatile fields (excluded from hash)
        updated_at: issue.updated_at,
        reactions: issue.reactions,
        assignee: issue.assignee,
        milestone: issue.milestone,
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

  /** Build a triage prompt: classify type, assess priority, suggest labels. */
  buildPrompt(item: TemplateItem): string {
    const issueNumber = item.data.number as number;
    const issueTitle = item.data.title as string;
    const issueBody = item.data.body as string;
    const labels = item.data.labels as string[];

    const sections: string[] = [];

    // Header
    sections.push(`## Issue #${issueNumber}: ${issueTitle}`);

    // Classification instructions
    sections.push("\n### Classification");
    sections.push("Classify this issue into one of the following types:");
    sections.push("- **bug**: Something is broken or not working as expected.");
    sections.push("- **enhancement**: A new feature request or improvement.");
    sections.push("- **question**: A question about usage or behavior.");
    sections.push("- **docs**: Documentation improvement or correction.");
    sections.push("- **invalid**: Not a valid issue (spam, duplicate, out of scope).");

    // Priority assessment
    sections.push("\n### Priority Assessment");
    sections.push("Assess the priority of this issue:");
    sections.push("- **P0**: Critical — system down, data loss, security vulnerability.");
    sections.push("- **P1**: High — major feature broken, significant user impact.");
    sections.push("- **P2**: Medium — minor feature issue, workaround available.");
    sections.push("- **P3**: Low — cosmetic, nice-to-have, minor improvement.");

    // Label suggestions
    sections.push("\n### Label Suggestions");
    sections.push("Suggest appropriate labels based on the classification and priority above.");
    if (labels.length > 0) {
      sections.push(`Current labels: ${labels.join(", ")}`);
    } else {
      sections.push("No labels currently assigned.");
    }

    // Issue body
    sections.push("\n### Issue Body");
    if (issueBody) {
      sections.push(issueBody);
    } else {
      sections.push("(No body provided.)");
    }

    return sections.join("\n");
  }
}

// ── Self-register on the global registry ──

templateRegistry.register(
  new IssueTriageTemplate({
    async listIssues() {
      return [];
    },
    async getIssue() {
      return { number: 0, title: "", body: "", labels: [], state: "open", commentCount: 0 };
    },
  }),
);
