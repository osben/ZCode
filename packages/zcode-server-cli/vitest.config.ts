import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Bug fix: root `tsc -b` writes composite build output into dist, and Vitest's default include
    // rules once collected and re-ran the compiled copies under dist/test (stale artifacts could
    // even cause false failures). Collect source tests only.
    include: ["test/**/*.test.ts"],
    // Integration cases legitimately wait for real Supervisor/Core startup; the standalone package
    // script shares the root config's limit so heavy machine load is not cut off first by Vitest's
    // default 5-second timeout.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // This package's integration cases actually start tsx/Supervisor/Core; run serially even when
    // executing the package script directly, so concurrent thread startup pressure does not make
    // the ready barrier intermittently time out, while preserving same-process mock semantics
    // (a forks worker changes the timing of some node module mocks).
    pool: "threads",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
