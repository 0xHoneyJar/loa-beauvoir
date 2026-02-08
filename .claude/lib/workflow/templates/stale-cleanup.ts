// .claude/lib/workflow/templates/stale-cleanup.ts — Stale Cleanup template (SDD 3.2, TASK-5.4)

import { createHash } from "node:crypto";
import { BaseTemplate, templateRegistry, type ActionPolicyDef, type TemplateItem } from "./base.js";

// -- GitHub API client interface (constructor-injected) --

export interface GitHubClient {
  listIssues(
    state: "open" | "closed",
  ): Promise<Array<{ number: number; title: string; updated_at: string; pull_request?: unknown }>>;
  listPullRequests(
    state: "open" | "closed",
  ): Promise<Array<{ number: number; title: string; updated_at: string }>>;
}

// -- Action policy --

const STALE_CLEANUP_POLICY: ActionPolicyDef = {
  templateId: "stale-cleanup",
  allow: [
    "list_issues",
    "list_pull_requests",
    "get_issue",
    "get_pull_request",
    "update_issue",
    "add_issue_comment",
  ],
  deny: ["close_issue", "delete_branch", "merge_pull_request", "create_pull_request"],
  constraints: {
    update_issue: { labelsOnly: ["stale"] },
  },
};

// -- Stale Cleanup Template --

export class StaleCleanupTemplate extends BaseTemplate {
  readonly id = "stale-cleanup";
  readonly name = "Stale Cleanup";
  readonly actionPolicy: ActionPolicyDef = STALE_CLEANUP_POLICY;
  readonly canonicalHashFields = ["updated_at"];
  readonly excludedHashFields = ["reactions", "assignee"];

  readonly schedule = "0 6 * * *"; // daily at 06:00 UTC
  readonly defaultEnabled = false; // disabled by default

  private readonly staleDays: number;
  private readonly client: GitHubClient;

  constructor(opts?: { staleDays?: number; client?: GitHubClient }) {
    super();
    this.staleDays = opts?.staleDays ?? 30;
    this.client = opts?.client ?? {
      async listIssues() {
        return [];
      },
      async listPullRequests() {
        return [];
      },
    };
  }

  /** List open issues/PRs, filter by last activity > staleDays. */
  async resolveItems(): Promise<TemplateItem[]> {
    const cutoff = Date.now() - this.staleDays * 86_400_000;
    const [issues, prs] = await Promise.all([
      this.client.listIssues("open"),
      this.client.listPullRequests("open"),
    ]);

    const items: TemplateItem[] = [];

    for (const issue of issues) {
      if (issue.pull_request) continue; // skip PRs returned in issues list
      if (new Date(issue.updated_at).getTime() < cutoff) {
        const data: Record<string, unknown> = {
          number: issue.number,
          title: issue.title,
          updated_at: issue.updated_at,
          kind: "issue",
        };
        const item: TemplateItem = { key: `issue-${issue.number}`, hash: "", data };
        item.hash = this.computeStateHash(item);
        items.push(item);
      }
    }

    for (const pr of prs) {
      if (new Date(pr.updated_at).getTime() < cutoff) {
        const data: Record<string, unknown> = {
          number: pr.number,
          title: pr.title,
          updated_at: pr.updated_at,
          kind: "pr",
        };
        const item: TemplateItem = { key: `pr-${pr.number}`, hash: "", data };
        item.hash = this.computeStateHash(item);
        items.push(item);
      }
    }

    return items;
  }

  /** Build a prompt explaining inactivity and suggesting the stale label. */
  buildPrompt(item: TemplateItem): string {
    const number = item.data.number as number;
    const title = item.data.title as string;
    const updatedAt = item.data.updated_at as string;
    const kind = item.data.kind as string;
    const daysSince = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 86_400_000);

    return [
      `## ${kind === "pr" ? "PR" : "Issue"} #${number}: ${title}`,
      "",
      `This ${kind} has had no activity for ${daysSince} days (last updated: ${updatedAt}).`,
      "",
      `Add the **stale** label and post a comment notifying contributors of the inactivity.`,
    ].join("\n");
  }
}

// -- Self-register on the global registry --

templateRegistry.register(new StaleCleanupTemplate());
