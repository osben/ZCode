import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

import engineeringTestFiles from "./scripts/engineering-test-files.json";
// Fork-owned unit tests keep running after upstream retired App unit tests (specs/fork-test-pipeline.md).
import forkTestFiles from "./scripts/fork-test-files.json";

// Fork tests that spawn real build/tool subprocesses; serial forks keep them inside their own deadlines.
const forkIsolatedTests = ["packages/provider-node/test/builtin-provider-build.test.ts"];

export default defineConfig({
  // Tests inject a fixed event-report endpoint so the telemetry reporting path is verifiable in unit tests;
  // real builds decide it in scripts/build-time-config.mjs.
  define: {
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://zcode.z.ai/api/v1/event/report"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      "@web": resolve(__dirname, "packages/web/src"),
      // Unit tests that indirectly import desktopNetworkTelemetry and friends do not need real ARMS;
      // cases that need vi.fn override it with vi.mock in the file.
      // Bugfix: the specific /browser subpath must come before the package-root alias, otherwise the
      // root alias rewrites it into a non-existent stub.ts/browser.
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // The official dependency graph does not track setupFiles; a shared config change must explicitly
    // select the whole suite and report the skip.
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      "**/{vitest,vite}.config.*",
      "**/vitest.setup.ts",
      // Managed worktree paths contain hidden directories that globstar does not match by default;
      // key entry points use exact absolute paths.
      ...[
        "package.json",
        "vitest.config.ts",
        "vitest.setup.ts",
        "scripts/engineering-test-files.json",
        "scripts/fork-test-files.json",
      ].map((file) => resolve(__dirname, file)),
    ],
    // Fix: a full run forwards console output of *passing* tests to stdout. Services cases that use
    // createServiceLogger print thousands of multi-line log lines even when green, inflating full
    // output to ~3.3MB, past the 256KB per-command stdout cap of CI/workflow gates, so the gate judged
    // the command "not executable" instead of failing tests. passed-only hides console output of
    // passing tests only; failing cases keep their logs and assertion diffs. A green run stays ~140KB.
    silent: "passed-only",
    // Fix: running Git, zip and Electron module imports concurrently in a full run let the default 5s
    // timeout fire early on slow or loaded machines (slow git spawns and imports -> flaky timeouts), and
    // interrupted handle cleanup triggered EPERM/ENOTEMPTY on Windows. Memory pressure (swap thrashing)
    // slows spawns on low-end macOS/Linux too, so concurrency is reduced and timeouts relaxed everywhere.
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
    // Engineering tests use an explicit list; App business unit tests are no longer discovered.
    // Real-subprocess tests run serially.
    projects: [
      {
        extends: true,
        test: {
          name: "engineering",
          include: engineeringTestFiles,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          name: "fork-unit",
          include: forkTestFiles,
          exclude: forkIsolatedTests,
          // Full-run threads on macOS can trigger a V8 SIGSEGV; switch to process isolation when
          // diagnosing, the test scope stays the same.
          pool: process.env.ZCODE_TEST_POOL === "forks" ? "forks" : "threads",
          maxWorkers: process.env.CI || process.env.ZCODE_TEST_POOL === "forks" ? 2 : 4,
        },
      },
      {
        extends: true,
        test: {
          name: "fork-isolated",
          include: forkIsolatedTests,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        test: {
          // Fork self-hosted relay suites, run only by `pnpm test:relay` (specs/fork-test-pipeline.md).
          name: "relay",
          include: [
            "packages/remote-relay/**/*.test.ts",
            "packages/shared/src/web-remote-relay/**/*.test.ts",
          ],
          pool: "threads",
        },
      },
      "packages/zcode-cua/vitest.config.ts",
    ],
  },
});
