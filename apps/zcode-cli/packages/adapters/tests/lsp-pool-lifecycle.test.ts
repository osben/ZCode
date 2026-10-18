import { afterEach, describe, expect, it } from "vitest";
import type { LanguageServerEvent } from "@zcode/contracts";
import { defaultLspSpawn, type LspSpawnFn } from "../src/lsp/server-process.js";
import {
  createTestPool,
  fakeServer,
  recordingLogger,
  TEST_KEY,
  waitForReady,
  waitUntil,
} from "./lsp-test-helpers.js";

const LONG_TEST_MS = 20_000;
const MISSING_COMMAND = "zcode-definitely-missing-lsp-binary";

let dispose: (() => Promise<void>) | undefined;

afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

function setup(options: Parameters<typeof createTestPool>[0] = {}) {
  const harness = createTestPool(options);
  dispose = harness.dispose;
  return harness;
}

function countEvents(events: LanguageServerEvent[], type: LanguageServerEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

describe("LSP pool: crashes, restarts and startup failures", () => {
  it(
    "resets the restart counter after every successful start, so crashes over a session never exhaust it",
    async () => {
      const { pool, events } = setup();
      const server = fakeServer({ FAKE_LSP_CRASH_ON: "fake/sleep" }, { maxRestarts: 1 });

      for (let round = 1; round <= 3; round += 1) {
        const connection = await waitForReady(pool, server);
        expect(pool.status()[0]?.restarts).toBe(0);
        await expect(connection.request("fake/sleep", { ms: 10 })).rejects.toMatchObject({
          code: "lsp_server_crashed",
        });
        await waitUntil(
          () => countEvents(events, "crashed") === round,
          5_000,
          `crashed event ${round}`,
        );
      }
      expect(countEvents(events, "ready")).toBe(3);
      expect(pool.acquire(server, TEST_KEY)).toMatchObject({ state: "starting" });
    },
    LONG_TEST_MS,
  );

  it(
    "reports unavailable after maxRestarts consecutive failed starts",
    async () => {
      const { pool, events } = setup();
      const server = fakeServer({ FAKE_LSP_CRASH_ON: "initialize" }, { maxRestarts: 2 });

      // Initial start plus two restarts, each crashing before it is initialized.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(pool.acquire(server, TEST_KEY)).toMatchObject({ state: "starting" });
        await waitUntil(
          () => pool.status()[0]?.state !== "starting",
          5_000,
          `failed start ${attempt}`,
        );
      }
      expect(pool.acquire(server, TEST_KEY)).toMatchObject({
        state: "failed",
        code: "lsp_server_unavailable",
      });
      expect(pool.status()[0]?.restarts).toBe(2);
      expect(countEvents(events, "ready")).toBe(0);
    },
    LONG_TEST_MS,
  );

  it(
    "does not restart when restartOnCrash is false",
    async () => {
      const { pool } = setup();
      const server = fakeServer({ FAKE_LSP_CRASH_ON: "fake/sleep" }, { restartOnCrash: false });
      const connection = await waitForReady(pool, server);
      await expect(connection.request("fake/sleep", { ms: 10 })).rejects.toMatchObject({
        code: "lsp_server_crashed",
      });
      expect(pool.acquire(server, TEST_KEY)).toMatchObject({
        state: "failed",
        code: "lsp_server_unavailable",
      });
    },
    LONG_TEST_MS,
  );

  it(
    "treats a timeout during initialize as a failed start",
    async () => {
      const { pool } = setup();
      const server = fakeServer(
        { FAKE_LSP_STARTUP_DELAY_MS: "5000" },
        { startupTimeoutMs: 300, maxRestarts: 0 },
      );
      expect(pool.acquire(server, TEST_KEY)).toEqual({ state: "starting" });
      await waitUntil(
        () => pool.status()[0]?.lastErrorCode === "lsp_startup_timeout",
        5_000,
        "startup timeout",
      );
      expect(pool.status()[0]?.state).toBe("crashed");
      expect(pool.acquire(server, TEST_KEY)).toMatchObject({
        state: "failed",
        code: "lsp_server_unavailable",
      });
    },
    LONG_TEST_MS,
  );

  it(
    "treats a server that writes a malformed header as crashed and logs a warning",
    async () => {
      const { logger, logs } = recordingLogger();
      const { pool } = setup({ logger });
      const garbageServer = fakeServer(
        {},
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('X-Bad: 1\\r\\n\\r\\n'); setTimeout(() => {}, 5000)"],
          maxRestarts: 0,
        },
      );
      expect(pool.acquire(garbageServer, TEST_KEY)).toEqual({ state: "starting" });
      await waitUntil(
        () => pool.status()[0]?.lastErrorCode === "lsp_server_start_failed",
        5_000,
        "protocol failure",
      );
      expect(
        logs.some(
          (entry) =>
            entry.level === "warn" && entry.context?.event === "adapters.lsp.protocol_error",
        ),
      ).toBe(true);
    },
    LONG_TEST_MS,
  );

  it(
    "records a process that exits before initialized as a start failure",
    async () => {
      const { pool } = setup();
      const server = fakeServer({ FAKE_LSP_CRASH_ON: "initialize" }, { maxRestarts: 0 });
      expect(pool.acquire(server, TEST_KEY)).toEqual({ state: "starting" });
      await waitUntil(
        () => pool.status()[0]?.lastErrorCode === "lsp_server_start_failed",
        5_000,
        "start failure",
      );
    },
    LONG_TEST_MS,
  );
});

describe("LSP pool: missing binaries", () => {
  it(
    "reports not_installed without spawning again until the retry window passes",
    async () => {
      let spawns = 0;
      const countingSpawn: LspSpawnFn = (file, args, options) => {
        spawns += 1;
        return defaultLspSpawn(file, args, options);
      };
      const { pool, events } = setup({ spawnImpl: countingSpawn, notInstalledRetryMs: 60_000 });
      const server = fakeServer({}, { command: MISSING_COMMAND, args: [] });

      expect(pool.acquire(server, TEST_KEY)).toEqual({ state: "starting" });
      await waitUntil(() => pool.status()[0]?.state === "not_installed", 5_000, "not_installed");
      expect(pool.acquire(server, TEST_KEY)).toMatchObject({
        state: "failed",
        code: "lsp_server_not_installed",
      });
      expect(pool.acquire(server, TEST_KEY)).toMatchObject({ state: "failed" });
      expect(spawns).toBe(1);
      expect(countEvents(events, "ready")).toBe(0);
    },
    LONG_TEST_MS,
  );

  it(
    "retries the spawn after notInstalledRetryMs",
    async () => {
      let spawns = 0;
      const countingSpawn: LspSpawnFn = (file, args, options) => {
        spawns += 1;
        return defaultLspSpawn(file, args, options);
      };
      const { pool } = setup({ spawnImpl: countingSpawn, notInstalledRetryMs: 50 });
      const server = fakeServer({}, { command: MISSING_COMMAND, args: [] });

      pool.acquire(server, TEST_KEY);
      await waitUntil(() => pool.status()[0]?.state === "not_installed", 5_000, "not_installed");
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(pool.acquire(server, TEST_KEY)).toEqual({ state: "starting" });
      await waitUntil(() => spawns === 2, 5_000, "second spawn");
      await waitUntil(
        () => pool.status()[0]?.state === "not_installed",
        5_000,
        "not_installed again",
      );
    },
    LONG_TEST_MS,
  );

  it("isInstalled resolves an absolute command and rejects a missing one", async () => {
    const { pool } = setup();
    await expect(pool.isInstalled(fakeServer())).resolves.toBe(true);
    await expect(
      pool.isInstalled(fakeServer({}, { command: MISSING_COMMAND, args: [] })),
    ).resolves.toBe(false);
  });
});

describe("LSP pool: shutdown", () => {
  it(
    "stops a server after the idle window and emits stopped",
    async () => {
      const { pool, events } = setup({ idleShutdownMs: 150 });
      await waitForReady(pool, fakeServer());
      await waitUntil(() => pool.status()[0]?.state === "stopped", 5_000, "idle stop");
      expect(countEvents(events, "stopped")).toBe(1);
    },
    LONG_TEST_MS,
  );

  it(
    "stops every server on stopAll and reports stopped",
    async () => {
      const { pool, events } = setup();
      await waitForReady(pool, fakeServer({}, { id: "fake/a" }));
      await waitForReady(pool, fakeServer({}, { id: "fake/b" }));
      await pool.stopAll();
      expect(pool.status().map((status) => status.state)).toEqual(["stopped", "stopped"]);
      expect(countEvents(events, "stopped")).toBe(2);
    },
    LONG_TEST_MS,
  );

  it(
    "kills a server that ignores shutdown and exit",
    async () => {
      const { pool } = setup();
      await waitForReady(
        pool,
        fakeServer({ FAKE_LSP_IGNORE_SHUTDOWN: "1" }, { shutdownTimeoutMs: 200 }),
      );
      const startedAt = Date.now();
      await pool.stopAll();
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(pool.status()[0]?.state).toBe("stopped");
    },
    LONG_TEST_MS,
  );
});

describe("LSP pool: running-server cap", () => {
  it(
    "stops the least recently used idle server before starting another",
    async () => {
      const { pool, events } = setup({ maxRunningServers: 2 });
      const first = fakeServer({}, { id: "fake/first" });
      const second = fakeServer({}, { id: "fake/second" });
      const third = fakeServer({}, { id: "fake/third" });
      await waitForReady(pool, first);
      await waitForReady(pool, second);
      await waitForReady(pool, third);

      const stateOf = (id: string) => pool.status().find((status) => status.serverId === id)?.state;
      await waitUntil(() => stateOf("fake/first") === "stopped", 5_000, "LRU eviction");
      expect(stateOf("fake/second")).toBe("ready");
      expect(stateOf("fake/third")).toBe("ready");
      expect(countEvents(events, "stopped")).toBe(1);
    },
    LONG_TEST_MS,
  );
});
