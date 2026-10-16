import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Lifecycle tests spawn real child processes (node fixtures); give them room on slow CI.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
