import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Database tests create their own databases; keep parallelism modest.
    maxWorkers: 4,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/lib/**/*.ts", "src/app/api/**/*.ts", "src/server/**/*.ts"],
      // Process entry points are exercised by the smoke run in CI, and the
      // testing helpers are test code.
      exclude: ["src/**/*.test.ts", "src/server/bin/**", "src/server/testing/**"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
});
