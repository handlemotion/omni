import { defineConfig } from "vitest/config";

export const unit = defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["**/*.e2e.test.ts"], testTimeout: 10_000 },
});

export const e2e = defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts", "src/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
