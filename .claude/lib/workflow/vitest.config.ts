import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [".claude/lib/workflow/__tests__/**/*.test.ts"],
    coverage: {
      include: [".claude/lib/workflow/**/*.ts"],
      exclude: ["**/__tests__/**", "**/vitest.config.ts"],
      provider: "v8",
      thresholds: { branches: 80 },
    },
  },
});
