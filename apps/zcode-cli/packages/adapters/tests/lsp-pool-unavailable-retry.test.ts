import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultLspSpawn, type LspSpawnFn } from "../src/lsp/server-process.js";
import {
  createTestPool,
  fakeServer,
  recordingLogger,
  TEST_KEY,
  waitForReady,
  waitUntil,
  type RecordedLog,
} from "./lsp-test-helpers.js";

// Regression for spec 19-lsp.md §12: a fresh worktree rejects `initialize` until its dependencies
// are installed; the pool must not stay unavailable once that has happened.

const LONG_TEST_MS = 20_000;
const RETRY_MS = 30_000;
const JSON_RPC_INTERNAL_ERROR = -32603;

let cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function setup(serverEnv: (marker: string) => Record<string, string>, maxRestarts = 1) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-lsp-retry-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const marker = join(dir, "dependencies-installed");
  let spawns = 0;
  const spawnImpl: LspSpawnFn = (file, args, options) => {
    spawns += 1;
    return defaultLspSpawn(file, args, options);
  };
  const clock = { now: 1_000 };
  const { logger, logs } = recordingLogger();
  const harness = createTestPool({
    spawnImpl,
    logger,
    now: () => clock.now,
    unavailableRetryMs: RETRY_MS,
  });
  cleanups.push(harness.dispose);
  const server = fakeServer(serverEnv(marker), { maxRestarts });
  return {
    ...harness,
    server,
    marker,
    clock,
    logs,
    spawns: () => spawns,
  };
}

async function exhaustRestarts(
  harness: Awaited<ReturnType<typeof setup>>,
  attempts: number,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    expect(harness.pool.acquire(harness.server, TEST_KEY)).toEqual({ state: "starting" });
    await waitUntil(
      () => harness.pool.status()[0]?.state === "crashed",
      5_000,
      `failed start ${attempt}`,
    );
  }
}

function logsWithEvent(logs: RecordedLog[], event: string): RecordedLog[] {
  return logs.filter((entry) => entry.context?.event === event);
}

describe("LSP pool: unavailable after failed starts", () => {
  it(
    "recovers from unavailable after the retry window once the workspace is fixed",
    async () => {
      const harness = await setup((marker) => ({ FAKE_LSP_REQUIRE_FILE: marker }));
      const { pool, server, logs } = harness;

      // Initial start plus one restart, both rejected by the server.
      await exhaustRestarts(harness, 2);
      const unavailable = pool.acquire(server, TEST_KEY);
      expect(unavailable).toMatchObject({ state: "failed", code: "lsp_server_unavailable" });
      expect(unavailable.state === "failed" && unavailable.message).toContain(
        "required workspace dependency is missing",
      );
      expect(pool.acquire(server, TEST_KEY)).toMatchObject({ state: "failed" });
      expect(harness.spawns()).toBe(2);

      const failures = logsWithEvent(logs, "adapters.lsp.start_failed");
      expect(failures).toHaveLength(2);
      for (const entry of failures) {
        expect(entry.context).toMatchObject({
          code: "lsp_request_failed",
          rpcCode: JSON_RPC_INTERNAL_ERROR,
        });
        expect(JSON.stringify(entry.context)).not.toContain("dependency is missing");
      }
      expect(logsWithEvent(logs, "adapters.lsp.unavailable")).toHaveLength(1);

      // Dependencies get installed while the entry is unavailable.
      await writeFile(harness.marker, "");
      expect(pool.acquire(server, TEST_KEY)).toMatchObject({ state: "failed" });
      expect(harness.spawns()).toBe(2);

      harness.clock.now += RETRY_MS;
      const connection = await waitForReady(pool, server);
      expect(harness.spawns()).toBe(3);
      expect(pool.status()[0]).toMatchObject({ state: "ready", restarts: 0 });
      expect(logsWithEvent(logs, "adapters.lsp.retry")).toHaveLength(1);
      await expect(connection.request("fake/sleep", { ms: 1 })).resolves.toBeNull();
    },
    LONG_TEST_MS,
  );

  it(
    "makes one start attempt per retry window while the cause persists",
    async () => {
      const harness = await setup((marker) => ({ FAKE_LSP_REQUIRE_FILE: marker }));
      const { pool, server, logs } = harness;

      await exhaustRestarts(harness, 2);
      expect(pool.acquire(server, TEST_KEY)).toMatchObject({ code: "lsp_server_unavailable" });

      for (let window = 1; window <= 2; window += 1) {
        harness.clock.now += RETRY_MS;
        expect(pool.acquire(server, TEST_KEY)).toEqual({ state: "starting" });
        await waitUntil(() => pool.status()[0]?.state === "crashed", 5_000, `retry ${window}`);
        expect(pool.acquire(server, TEST_KEY)).toMatchObject({ code: "lsp_server_unavailable" });
        expect(pool.acquire(server, TEST_KEY)).toMatchObject({ code: "lsp_server_unavailable" });
        expect(harness.spawns()).toBe(2 + window);
      }
      expect(logsWithEvent(logs, "adapters.lsp.unavailable")).toHaveLength(3);
    },
    LONG_TEST_MS,
  );

  it(
    "keeps restartOnCrash: false terminal after the retry window",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-lsp-retry-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      let spawns = 0;
      const clock = { now: 1_000 };
      const harness = createTestPool({
        spawnImpl: (file, args, options) => {
          spawns += 1;
          return defaultLspSpawn(file, args, options);
        },
        now: () => clock.now,
        unavailableRetryMs: RETRY_MS,
      });
      cleanups.push(harness.dispose);
      const server = fakeServer(
        { FAKE_LSP_REQUIRE_FILE: join(dir, "missing") },
        { restartOnCrash: false },
      );

      expect(harness.pool.acquire(server, TEST_KEY)).toEqual({ state: "starting" });
      await waitUntil(() => harness.pool.status()[0]?.state === "crashed", 5_000, "failed start");
      expect(harness.pool.acquire(server, TEST_KEY)).toMatchObject({
        code: "lsp_server_unavailable",
      });
      clock.now += RETRY_MS * 2;
      expect(harness.pool.acquire(server, TEST_KEY)).toMatchObject({
        code: "lsp_server_unavailable",
      });
      expect(spawns).toBe(1);
    },
    LONG_TEST_MS,
  );
});
