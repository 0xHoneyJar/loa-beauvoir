import { describe, expect, it } from "vitest";
import type { BeadRecord } from "../br-executor.js";
import { compileContext } from "../context-compiler.js";

function makeBead(overrides: Partial<BeadRecord> & { id: string }): BeadRecord {
  return {
    title: overrides.id,
    status: "open",
    labels: [],
    ...overrides,
  };
}

describe("compileContext", () => {
  it("returns empty string for empty bead list", () => {
    expect(compileContext([], "task-1", [])).toBe("");
  });

  it("excludes target task from context", () => {
    const beads = [makeBead({ id: "task-1", labels: ["class:decision"] })];
    expect(compileContext(beads, "task-1", [])).toBe("");
  });

  it("scores dependencies highest (+10)", () => {
    const beads = [
      makeBead({ id: "dep-1", labels: ["class:routine"] }),
      makeBead({ id: "unrelated", labels: ["class:decision"] }),
    ];
    const result = compileContext(beads, "task-1", ["dep-1"]);
    // dep-1 should appear first (10+1=11 > 5 for decision)
    expect(result).toMatch(/dep-1[\s\S]*unrelated/);
  });

  it("scores circuit-breaker +8 for open beads", () => {
    const beads = [
      makeBead({ id: "cb", labels: ["circuit-breaker"], status: "open" }),
      makeBead({ id: "normal", labels: ["class:progress"] }),
    ];
    const result = compileContext(beads, "task-1", []);
    expect(result).toMatch(/cb[\s\S]*normal/);
  });

  it("does not score circuit-breaker for closed beads", () => {
    const beads = [
      makeBead({ id: "cb", labels: ["circuit-breaker"], status: "closed" }),
      makeBead({ id: "normal", labels: ["class:decision"] }),
    ];
    const result = compileContext(beads, "task-1", []);
    // closed circuit-breaker scores 0 (filtered out), decision scores 5
    expect(result).toContain("normal");
    expect(result).not.toContain("cb"); // zero-score beads excluded
  });

  it("scores handoff labels +6", () => {
    const beads = [
      makeBead({ id: "handoff-bead", labels: ["handoff:abc-123"] }),
      makeBead({ id: "routine", labels: ["class:routine"] }),
    ];
    const result = compileContext(beads, "task-1", []);
    expect(result).toMatch(/handoff-bead[\s\S]*routine/);
  });

  it("scores classifications correctly", () => {
    const beads = [
      makeBead({ id: "decision", labels: ["class:decision"] }),
      makeBead({ id: "discovery", labels: ["class:discovery"] }),
      makeBead({ id: "question", labels: ["class:question"] }),
      makeBead({ id: "routine", labels: ["class:routine"] }),
    ];
    const result = compileContext(beads, "task-1", []);
    // Order: decision(5) > discovery(4) > question(3) > routine(1)
    expect(result).toMatch(/decision[\s\S]*discovery[\s\S]*question[\s\S]*routine/);
  });

  it("applies confidence modifier (+1 high, -1 low)", () => {
    const beads = [
      makeBead({ id: "high", labels: ["class:routine", "confidence:high"] }),
      makeBead({ id: "low", labels: ["class:progress", "confidence:low"] }),
    ];
    const result = compileContext(beads, "task-1", []);
    // high: 1+1=2, low: 2-1=1 → high first
    expect(result).toMatch(/high[\s\S]*low/);
  });

  it("applies recency bonus (0-2, linear decay over 7 days)", () => {
    const now = Date.now();
    const beads = [
      makeBead({
        id: "old",
        labels: ["class:routine"],
        created_at: new Date(now - 8 * 86_400_000).toISOString(),
      }),
      makeBead({
        id: "new",
        labels: ["class:routine"],
        created_at: new Date(now - 1000).toISOString(),
      }),
    ];
    const result = compileContext(beads, "task-1", []);
    // new gets ~2 recency bonus, old gets 0 → new first
    expect(result).toMatch(/new[\s\S]*old/);
  });

  it("caps recency bonus for future timestamps", () => {
    const now = Date.now();
    const beads = [
      makeBead({
        id: "future",
        labels: ["class:routine"],
        created_at: new Date(now + 86_400_000).toISOString(),
      }),
    ];
    // Should not crash, and bonus should be capped at 2
    const result = compileContext(beads, "task-1", []);
    expect(result).toContain("future");
  });

  it("enforces token budget (greedy knapsack)", () => {
    const longDesc = "x".repeat(2000); // ~500 tokens
    const beads = [
      makeBead({ id: "a", labels: ["class:decision"], description: longDesc }),
      makeBead({ id: "b", labels: ["class:discovery"], description: longDesc }),
      makeBead({ id: "c", labels: ["class:blocker"], description: longDesc }),
    ];
    // Budget of 600 tokens should include only ~1 bead
    const result = compileContext(beads, "task-1", [], { tokenBudget: 600 });
    expect(result).toContain("a"); // highest score included
    // At least one should be excluded
    const beadCount = (result.match(/####/g) || []).length;
    expect(beadCount).toBeLessThan(3);
  });

  it("skips oversized beads and includes smaller ones after", () => {
    const hugeDesc = "x".repeat(8000); // ~2000 tokens
    const beads = [
      makeBead({ id: "huge", labels: ["class:decision"], description: hugeDesc }),
      makeBead({ id: "small", labels: ["class:discovery"] }),
    ];
    // Budget 500 tokens: huge won't fit, small will
    const result = compileContext(beads, "task-1", [], { tokenBudget: 500 });
    expect(result).toContain("small");
    expect(result).not.toContain("huge");
  });

  it("filters out beads with zero score", () => {
    const beads = [makeBead({ id: "nothing", labels: [] })];
    expect(compileContext(beads, "task-1", [])).toBe("");
  });

  it("only counts first classification label", () => {
    const beads = [makeBead({ id: "multi", labels: ["class:decision", "class:discovery"] })];
    // Should score 5 (decision), not 5+4=9
    const result = compileContext(beads, "task-1", []);
    expect(result).toContain("multi");
  });
});
