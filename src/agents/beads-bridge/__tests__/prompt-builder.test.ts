import { describe, expect, it } from "vitest";
import { buildSubAgentPrompt, extractAcceptanceCriteria } from "../prompt-builder.js";

describe("buildSubAgentPrompt", () => {
  it("includes task title", () => {
    const result = buildSubAgentPrompt({ id: "t1", title: "Fix login" }, "");
    expect(result).toContain("## Task: Fix login");
  });

  it("includes description when present", () => {
    const result = buildSubAgentPrompt(
      { id: "t1", title: "Fix login", description: "The login form is broken" },
      "",
    );
    expect(result).toContain("### Description");
    expect(result).toContain("The login form is broken");
  });

  it("includes compiled context when non-empty", () => {
    const result = buildSubAgentPrompt(
      { id: "t1", title: "Fix login" },
      "#### Context bead\nSome relevant info",
    );
    expect(result).toContain("### Relevant Context");
    expect(result).toContain("Some relevant info");
  });

  it("excludes context section when empty", () => {
    const result = buildSubAgentPrompt({ id: "t1", title: "Fix login" }, "");
    expect(result).not.toContain("### Relevant Context");
  });

  it("excludes context section when whitespace only", () => {
    const result = buildSubAgentPrompt({ id: "t1", title: "Fix login" }, "   \n  ");
    expect(result).not.toContain("### Relevant Context");
  });

  it("always includes completion protocol", () => {
    const result = buildSubAgentPrompt({ id: "t1", title: "Fix login" }, "");
    expect(result).toContain("### Completion Protocol");
    expect(result).toContain("Do NOT run br commands directly");
  });

  it("extracts acceptance criteria from description checkboxes", () => {
    const desc = `Some intro text
- [ ] First criterion
- [x] Second criterion (done)
- [ ] Third criterion`;
    const result = buildSubAgentPrompt({ id: "t1", title: "Task", description: desc }, "");
    expect(result).toContain("### Acceptance Criteria");
    expect(result).toContain("First criterion");
    expect(result).toContain("Second criterion (done)");
    expect(result).toContain("Third criterion");
  });

  it("handles task with no description gracefully", () => {
    const result = buildSubAgentPrompt({ id: "t1", title: "Bare task" }, "");
    expect(result).toContain("## Task: Bare task");
    expect(result).not.toContain("### Description");
    expect(result).not.toContain("### Acceptance Criteria");
  });
});

describe("extractAcceptanceCriteria", () => {
  it("extracts checkbox items", () => {
    const text = "- [ ] A\n- [x] B\n- [ ] C";
    expect(extractAcceptanceCriteria(text)).toEqual(["A", "B", "C"]);
  });

  it("returns empty array for no checkboxes", () => {
    expect(extractAcceptanceCriteria("Just some text")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractAcceptanceCriteria("")).toEqual([]);
  });
});
