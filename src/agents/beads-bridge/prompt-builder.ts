/**
 * PromptBuilder — constructs sub-agent prompts from task data + compiled context.
 */

// -- Types --------------------------------------------------------------------

export interface TaskInfo {
  id: string;
  title: string;
  description?: string;
}

// -- Public API ---------------------------------------------------------------

export function buildSubAgentPrompt(task: TaskInfo, compiledContext: string): string {
  const sections: string[] = [];

  // Task header
  sections.push(`## Task: ${task.title}`);

  // Description
  if (task.description) {
    sections.push("### Description");
    sections.push(task.description);
  }

  // Acceptance criteria extracted from description
  const criteria = task.description ? extractAcceptanceCriteria(task.description) : [];
  if (criteria.length > 0) {
    sections.push("### Acceptance Criteria");
    sections.push(criteria.map((c) => `- [ ] ${c}`).join("\n"));
  }

  // Compiled context
  if (compiledContext.trim()) {
    sections.push("### Relevant Context");
    sections.push(compiledContext);
  }

  // Completion protocol — always present
  sections.push(COMPLETION_PROTOCOL);

  return sections.join("\n\n");
}

// -- Internals ----------------------------------------------------------------

const COMPLETION_PROTOCOL = `### Completion Protocol
When you complete this task:
1. Summarize what you did and any files changed
2. Note any discoveries or decisions made
3. If blocked, explain what's blocking you

The bridge will automatically update the bead state based on your outcome.
Do NOT run br commands directly — the bridge handles bead lifecycle.`;

/**
 * Extract acceptance criteria from markdown text.
 * Recognizes:
 *   - [ ] criterion text
 *   - criterion text   (plain list items)
 */
export function extractAcceptanceCriteria(text: string): string[] {
  const criteria: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // Checkbox pattern: - [ ] text or - [x] text
    const checkboxMatch = trimmed.match(/^-\s*\[[ x]\]\s+(.+)$/i);
    if (checkboxMatch) {
      criteria.push(checkboxMatch[1]);
      continue;
    }
    // Plain list under "acceptance criteria" heading already parsed above;
    // we intentionally only capture checkbox-style items to avoid false positives.
  }
  return criteria;
}
