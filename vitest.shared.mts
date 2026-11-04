import { defineConfig } from "vitest/config";

// Unit suites: pure logic, fast, no network. Each package's vitest.config.mts extends this.
export const unit = defineConfig({
  test: { include: ["src/**/*.test.ts"], exclude: ["**/*.e2e.test.ts"], testTimeout: 10_000 },
});

// E2E suites: real Postgres / GreenMail from `pnpm stack:up`. Files run in parallel: each one
// creates its own database, GreenMail accounts and ports, so files share no state.
export const e2e = defineConfig({
  test: {
    include: ["e2e/**/*.e2e.test.ts", "src/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
