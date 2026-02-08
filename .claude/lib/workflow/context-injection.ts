// .claude/lib/workflow/context-injection.ts — Context injection for agent prompts (SDD §5.7)
// Provides previous context and structured change summaries before each item review.

// ── Types ──────────────────────────────────────────────────

export interface PreviousResult {
  processedAt: string;
  actionsTaken: string[];
  result: "success" | "failure" | "skipped";
  summary?: string;
}

export interface ChangeSummary {
  reason: "new" | "hash_changed" | "timer_expired";
  changedFields?: string[];
  previousHash?: string;
  currentHash: string;
  timeSinceLastReview?: string; // e.g., "3 hours", "2 days"
}

export interface ContextBlock {
  previousResult?: PreviousResult;
  changeSummary?: ChangeSummary;
  guidance: string;
}

// ── Build ──────────────────────────────────────────────────

export function buildContextBlock(opts: {
  previousResult?: PreviousResult;
  changeSummary?: ChangeSummary;
  itemKey: string;
}): ContextBlock {
  const { previousResult, changeSummary } = opts;

  let guidance: string;
  if (!previousResult) {
    guidance = "This is a new item. Perform a thorough initial review.";
  } else if (changeSummary?.reason === "hash_changed") {
    guidance = "This item has changed since your last review. Focus on what's different.";
  } else if (changeSummary?.reason === "timer_expired") {
    guidance = "This item hasn't been reviewed recently. Perform a fresh review.";
  } else {
    guidance = "This is a new item. Perform a thorough initial review.";
  }

  return { previousResult, changeSummary, guidance };
}

// ── Format ─────────────────────────────────────────────────

export function formatContextForPrompt(block: ContextBlock): string {
  const sections: string[] = ["## Previous Context"];

  if (block.previousResult) {
    const pr = block.previousResult;
    sections.push("");
    sections.push("### Last Review");
    sections.push(`- Processed: ${pr.processedAt}`);
    sections.push(`- Result: ${pr.result}`);
    sections.push(`- Actions: ${pr.actionsTaken.join(", ")}`);
    if (pr.summary) {
      sections.push(`- Summary: ${pr.summary}`);
    }
  }

  if (block.changeSummary) {
    const cs = block.changeSummary;
    sections.push("");
    sections.push("### Changes Since Last Review");
    sections.push(`- Reason: ${cs.reason}`);
    if (cs.previousHash) {
      sections.push(`- Previous hash: ${cs.previousHash}`);
    }
    sections.push(`- Current hash: ${cs.currentHash}`);
    if (cs.timeSinceLastReview) {
      sections.push(`- Time since last review: ${cs.timeSinceLastReview}`);
    }
    if (cs.changedFields && cs.changedFields.length > 0) {
      sections.push(`- Changed fields: ${cs.changedFields.join(", ")}`);
    }
  }

  sections.push("");
  sections.push("### Guidance");
  sections.push(block.guidance);

  return sections.join("\n");
}
