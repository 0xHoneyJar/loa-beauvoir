import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: [
      ".claude/lib/workflow/__tests__/**/*.test.ts",
      ".claude/lib/workflow/templates/__tests__/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    coverage: {
      include: [".claude/lib/workflow/**/*.ts"],
      exclude: ["**/__tests__/**", "**/vitest.config.ts"],
      provider: "v8",
      thresholds: { branches: 80 },
    },
  },
});
