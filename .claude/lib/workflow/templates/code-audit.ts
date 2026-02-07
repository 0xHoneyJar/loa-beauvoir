// .claude/lib/workflow/templates/code-audit.ts — Code Audit template (SDD 3.2, TASK-5.3)

import { createHash } from "node:crypto";
import { BaseTemplate, templateRegistry, type ActionPolicyDef, type TemplateItem } from "./base.js";

// ── GitHub API client interface (constructor-injected) ──

export interface CodeAuditClient {
  getHeadSha(opts: { ref?: string }): Promise<string>;
}

// ── Action policy ──

const CODE_AUDIT_POLICY: ActionPolicyDef = {
  templateId: "code-audit",
  allow: ["get_file_contents", "search_code", "list_commits", "create_issue"],
  deny: [
    "merge_pull_request",
    "delete_branch",
    "update_issue",
    "create_pull_request",
    "add_issue_comment",
  ],
  constraints: {},
};

// ── Code Audit Template ──

export class CodeAuditTemplate extends BaseTemplate {
  readonly id = "code-audit";
  readonly name = "Code Audit";
  readonly actionPolicy: ActionPolicyDef = CODE_AUDIT_POLICY;
  readonly canonicalHashFields = ["headSha"];
  readonly excludedHashFields = ["updated_at", "ci_status"];

  /** Daily at 03:00 UTC */
  readonly schedule = "0 3 * * *";

  private readonly client: CodeAuditClient;

  constructor(client: CodeAuditClient) {
    super();
    this.client = client;
  }

  /** Always returns a single item representing the repo HEAD. */
  async resolveItems(): Promise<TemplateItem[]> {
    const headSha = await this.client.getHeadSha({ ref: "HEAD" });

    const data: Record<string, unknown> = { headSha };
    const item: TemplateItem = { key: "repo-head", hash: "", data };
    item.hash = this.computeStateHash(item);

    return [item];
  }

  /** Build audit prompt: OWASP Top 10, security review, code quality. */
  buildPrompt(item: TemplateItem): string {
    const headSha = item.data.headSha as string;

    const sections: string[] = [];

    sections.push(`## Code Audit — HEAD ${headSha}`);

    sections.push("\n### Security Review");
    sections.push(
      "Perform a security audit of the codebase against the OWASP Top 10 vulnerability categories:",
    );
    sections.push("- Injection flaws (SQL, NoSQL, OS command, LDAP)");
    sections.push("- Broken authentication and session management");
    sections.push("- Sensitive data exposure");
    sections.push("- Security misconfiguration");
    sections.push("- Cross-site scripting (XSS)");

    sections.push("\n### Code Quality");
    sections.push("Evaluate the codebase for:");
    sections.push("- Dead code and unused imports");
    sections.push("- Error handling gaps");
    sections.push("- Dependency vulnerabilities");
    sections.push("- Type safety concerns");

    sections.push("\n### Output");
    sections.push(
      "Create a GitHub issue summarising all findings, categorised by severity (critical, high, medium, low).",
    );

    return sections.join("\n");
  }
}

// ── Self-register on the global registry ──

templateRegistry.register(
  new CodeAuditTemplate({
    async getHeadSha() {
      return "0000000000000000000000000000000000000000";
    },
  }),
);
