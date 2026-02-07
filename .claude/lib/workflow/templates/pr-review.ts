// .claude/lib/workflow/templates/pr-review.ts — PR Review template (SDD 3.2, TASK-3.1)

import { createHash } from "node:crypto";
import { BaseTemplate, templateRegistry, type ActionPolicyDef, type TemplateItem } from "./base.js";

// ── GitHub API client interface (constructor-injected) ──

export interface PullRequest {
  number: number;
  title: string;
  headSha: string;
  labels: string[];
  state: string;
  mergeable_state?: string;
  ci_status?: string;
  reaction_counts?: Record<string, number>;
  updated_at?: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ReviewThread {
  id: number;
  body: string;
  user: string;
  state: string;
  submitted_at: string;
}

export interface GitHubClient {
  listPullRequests(state: "open" | "closed"): Promise<PullRequest[]>;
  getPullRequestFiles(prNumber: number): Promise<PullRequestFile[]>;
  getPullRequestReviews(prNumber: number): Promise<ReviewThread[]>;
}

// ── Review dimensions (configurable from job config) ──

export const DEFAULT_REVIEW_DIMENSIONS = ["security", "quality", "test-coverage"] as const;

export type ReviewDimension = (typeof DEFAULT_REVIEW_DIMENSIONS)[number] | string;

export interface PrReviewConfig {
  /** Label that marks a PR as already reviewed by this agent. */
  reviewedLabel?: string;
  /** Review dimensions to evaluate. Defaults to security, quality, test-coverage. */
  dimensions?: ReviewDimension[];
}

// ── PR Review Template ──

const PR_REVIEW_POLICY: ActionPolicyDef = {
  templateId: "pr-review",
  allow: [
    "get_pull_request",
    "get_pull_request_files",
    "get_pull_request_reviews",
    "get_pull_request_comments",
    "get_file_contents",
    "list_commits",
    "search_code",
    "create_pull_request_review",
  ],
  deny: [
    "merge_pull_request",
    "close_pull_request",
    "delete_branch",
    "update_pull_request_branch",
    "enable_auto_merge",
  ],
  constraints: {
    create_pull_request_review: {
      deniedEvents: ["APPROVE"],
    },
  },
};

export class PrReviewTemplate extends BaseTemplate {
  readonly id = "pr-review";
  readonly name = "PR Review";
  readonly actionPolicy: ActionPolicyDef = PR_REVIEW_POLICY;
  readonly canonicalHashFields = ["headSha", "files", "reviewThreads"];
  readonly excludedHashFields = ["mergeable_state", "ci_status", "reaction_counts", "updated_at"];

  private readonly github: GitHubClient;
  private readonly config: PrReviewConfig;

  constructor(github: GitHubClient, config: PrReviewConfig = {}) {
    super();
    this.github = github;
    this.config = config;
  }

  /** List open PRs, filter out those already reviewed, fetch detail, compute hash. */
  async resolveItems(): Promise<TemplateItem[]> {
    const reviewedLabel = this.config.reviewedLabel ?? "agent-reviewed";
    const openPRs = await this.github.listPullRequests("open");

    // Filter out PRs that already carry the reviewed label
    const unreviewedPRs = openPRs.filter((pr) => !pr.labels.includes(reviewedLabel));

    const items: TemplateItem[] = [];
    for (const pr of unreviewedPRs) {
      const files = await this.github.getPullRequestFiles(pr.number);
      const reviewThreads = await this.github.getPullRequestReviews(pr.number);

      const data: Record<string, unknown> = {
        number: pr.number,
        title: pr.title,
        headSha: pr.headSha,
        files: files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
        reviewThreads: reviewThreads.map((r) => ({
          id: r.id,
          body: r.body,
          user: r.user,
          state: r.state,
          submitted_at: r.submitted_at,
        })),
        // Volatile fields (excluded from hash)
        mergeable_state: pr.mergeable_state,
        ci_status: pr.ci_status,
        reaction_counts: pr.reaction_counts,
        updated_at: pr.updated_at,
      };

      const item: TemplateItem = {
        key: `pr-${pr.number}`,
        hash: "",
        data,
      };
      item.hash = this.computeStateHash(item);

      items.push(item);
    }

    return items;
  }

  /** Build a structured review prompt with dimensions, prior context, and change summary. */
  buildPrompt(item: TemplateItem): string {
    const dimensions = this.config.dimensions ?? [...DEFAULT_REVIEW_DIMENSIONS];
    const prNumber = item.data.number as number;
    const prTitle = item.data.title as string;
    const files = item.data.files as PullRequestFile[];
    const reviews = item.data.reviewThreads as ReviewThread[];

    const sections: string[] = [];

    // Header
    sections.push(`## PR #${prNumber}: ${prTitle}`);

    // Review dimensions
    sections.push("\n### Review Dimensions");
    for (const dim of dimensions) {
      sections.push(`- **${dim}**: Evaluate this PR for ${dim} concerns.`);
    }

    // Change summary
    sections.push("\n### Change Summary");
    if (files.length === 0) {
      sections.push("No files changed.");
    } else {
      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);
      sections.push(`${files.length} file(s) changed (+${totalAdd} -${totalDel})`);
      for (const f of files) {
        sections.push(`- \`${f.filename}\` (${f.status}, +${f.additions} -${f.deletions})`);
      }
    }

    // Previous review context
    sections.push("\n### Previous Review Context");
    if (reviews.length === 0) {
      sections.push("No previous reviews.");
    } else {
      for (const r of reviews) {
        sections.push(`- **${r.user}** (${r.state}, ${r.submitted_at}): ${r.body}`);
      }
    }

    // Change summary since last review
    const lastReview =
      reviews.length > 0
        ? reviews.reduce((latest, r) => (r.submitted_at > latest.submitted_at ? r : latest))
        : null;

    sections.push("\n### Changes Since Last Review");
    if (!lastReview) {
      sections.push("This is the first review.");
    } else {
      sections.push(
        `Last review by **${lastReview.user}** at ${lastReview.submitted_at} (${lastReview.state}).`,
      );
      sections.push("Review all current changes against this baseline.");
    }

    return sections.join("\n");
  }
}

// ── Self-register on the global registry ──

// Note: The template requires a GitHubClient, so we register a factory-style
// default instance with a no-op client. Real usage re-registers with a live client.
// Alternatively, consumers can instantiate and register manually.
templateRegistry.register(
  new PrReviewTemplate({
    async listPullRequests() {
      return [];
    },
    async getPullRequestFiles() {
      return [];
    },
    async getPullRequestReviews() {
      return [];
    },
  }),
);
