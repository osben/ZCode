import { afterEach, describe, expect, it } from "vitest";
import { LspError } from "@zcode/contracts";
import {
  createTestPool,
  fakeServer,
  recordingLogger,
  TEST_KEY,
  waitForReady,
  waitUntil,
} from "./lsp-test-helpers.js";

const LONG_TEST_MS = 15_000;
const DOC_URI = "file:///work/sample.ts";

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

describe("LSP pool: protocol round trips with the fake server", () => {
  it(
    "moves from starting to ready and answers requests",
    async () => {
      const { pool } = setup();
      const server = fakeServer();
      expect(pool.acquire(server, TEST_KEY)).toEqual({ state: "starting" });
      const connection = await waitForReady(pool, server);
      expect(connection.server.id).toBe("fake/ts");
      expect(connection.key).toEqual(TEST_KEY);
      expect(connection.capabilities.hoverProvider).toBe(true);

      connection.notify("textDocument/didOpen", {
        textDocument: {
          uri: DOC_URI,
          languageId: "typescript",
          version: 1,
          text: "function alpha() {}\nconst b = 2;\nfunction beta() {}\n",
        },
      });
      const hover = await connection.request<{ contents: { value: string } }>(
        "textDocument/hover",
        { textDocument: { uri: DOC_URI }, position: { line: 0, character: 0 } },
      );
      expect(hover.contents.value).toBe("fake hover");

      const symbols = await connection.request<Array<{ name: string }>>(
        "textDocument/documentSymbol",
        { textDocument: { uri: DOC_URI } },
      );
      expect(symbols.map((symbol) => symbol.name)).toEqual(["alpha", "beta"]);
    },
    LONG_TEST_MS,
  );

  it(
    "resolves definitions to the first occurrence of the word",
    async () => {
      const { pool } = setup();
      const server = fakeServer();
      const connection = await waitForReady(pool, server);
      connection.notify("textDocument/didOpen", {
        textDocument: {
          uri: DOC_URI,
          languageId: "typescript",
          version: 1,
          text: "function foo() {}\nfoo();\n",
        },
      });
      const location = await connection.request<{
        range: { start: { line: number; character: number } };
      }>("textDocument/definition", {
        textDocument: { uri: DOC_URI },
        position: { line: 1, character: 1 },
      });
      expect(location.range.start).toEqual({ line: 0, character: 9 });
    },
    LONG_TEST_MS,
  );

  it(
    "publishes versioned diagnostics on open and change",
    async () => {
      const { pool } = setup();
      const server = fakeServer();
      const connection = await waitForReady(pool, server);
      const publishes: Array<{ version?: number; diagnostics: Array<{ message: string }> }> = [];
      connection.onNotification("textDocument/publishDiagnostics", (params) => {
        publishes.push(params as (typeof publishes)[number]);
      });
      connection.notify("textDocument/didOpen", {
        textDocument: {
          uri: DOC_URI,
          languageId: "typescript",
          version: 1,
          text: "ok\nFAKE_ERROR here\n",
        },
      });
      await waitUntil(() => publishes.length === 1, 5_000, "first publish");
      expect(publishes[0]?.version).toBe(1);
      expect(publishes[0]?.diagnostics.map((item) => item.message)).toEqual(["fake error"]);

      connection.notify("textDocument/didChange", {
        textDocument: { uri: DOC_URI, version: 2 },
        contentChanges: [{ text: "ok\nok\n" }],
      });
      await waitUntil(() => publishes.length === 2, 5_000, "second publish");
      expect(publishes[1]).toMatchObject({ version: 2, diagnostics: [] });
      expect(pool.status()[0]?.diagnosticsMode).toBe("unknown");
    },
    LONG_TEST_MS,
  );

  it(
    "supports versionless and two-partial-publish servers",
    async () => {
      const versionless = setup({});
      const versionlessConnection = await waitForReady(
        versionless.pool,
        fakeServer({ FAKE_LSP_DIAGNOSTICS: "versionless" }),
      );
      const versionlessPublishes: Array<{ version?: number }> = [];
      versionlessConnection.onNotification("textDocument/publishDiagnostics", (params) => {
        versionlessPublishes.push(params as { version?: number });
      });
      versionlessConnection.notify("textDocument/didOpen", {
        textDocument: { uri: DOC_URI, languageId: "typescript", version: 1, text: "FAKE_ERROR\n" },
      });
      await waitUntil(() => versionlessPublishes.length === 1, 5_000, "versionless publish");
      expect(versionlessPublishes[0]?.version).toBeUndefined();
      await versionless.dispose();
      dispose = undefined;

      const multi = setup();
      const multiConnection = await waitForReady(
        multi.pool,
        fakeServer({ FAKE_LSP_DIAGNOSTICS: "multi" }),
      );
      const multiCounts: number[] = [];
      multiConnection.onNotification("textDocument/publishDiagnostics", (params) => {
        multiCounts.push((params as { diagnostics: unknown[] }).diagnostics.length);
      });
      multiConnection.notify("textDocument/didOpen", {
        textDocument: { uri: DOC_URI, languageId: "typescript", version: 1, text: "FAKE_ERROR\n" },
      });
      await waitUntil(() => multiCounts.length === 2, 5_000, "two partial publishes");
      expect(multiCounts).toEqual([0, 1]);
    },
    LONG_TEST_MS,
  );

  it(
    "reports pull diagnostics when the server advertises them",
    async () => {
      const { pool } = setup();
      const server = fakeServer({ FAKE_LSP_DIAGNOSTICS: "pull" });
      const connection = await waitForReady(pool, server);
      expect(connection.capabilities.diagnosticProvider).toBeDefined();
      expect(pool.status()[0]?.diagnosticsMode).toBe("pull");
      connection.notify("textDocument/didOpen", {
        textDocument: { uri: DOC_URI, languageId: "typescript", version: 1, text: "FAKE_ERROR\n" },
      });
      const report = await connection.request<{ items: unknown[] }>("textDocument/diagnostic", {
        textDocument: { uri: DOC_URI },
      });
      expect(report.items).toHaveLength(1);
    },
    LONG_TEST_MS,
  );

  it(
    "answers server-to-client workspace/configuration from server.settings",
    async () => {
      const { pool, events } = setup();
      const server = fakeServer(
        { FAKE_LSP_CONFIG_REQUEST: "1" },
        { settings: { fake: { mode: "strict" } } },
      );
      const received = new Promise<unknown>((resolve) => {
        const unsubscribe = pool.onEvent((event) => {
          if (event.type !== "ready") return;
          event.connection.onNotification("fake/configuration", (params) => {
            unsubscribe();
            resolve(params);
          });
        });
      });
      await waitForReady(pool, server);
      expect(await received).toEqual({ result: ["strict"] });
      expect(events.some((event) => event.type === "ready")).toBe(true);
    },
    LONG_TEST_MS,
  );

  it(
    "rejects a request that exceeds the requestTimeout or the per-call timeout",
    async () => {
      const { pool } = setup();
      const connection = await waitForReady(pool, fakeServer({}, { requestTimeoutMs: 200 }));
      await expect(connection.request("fake/sleep", { ms: 5_000 })).rejects.toMatchObject({
        code: "lsp_request_timeout",
      });
      await expect(
        connection.request("fake/sleep", { ms: 5_000 }, { timeoutMs: 50 }),
      ).rejects.toMatchObject({
        code: "lsp_request_timeout",
      });
    },
    LONG_TEST_MS,
  );

  it(
    "cancels an aborted request by sending $/cancelRequest",
    async () => {
      const { pool } = setup();
      const connection = await waitForReady(pool, fakeServer());
      const cancelledIds: unknown[] = [];
      connection.onNotification("fake/cancelled", (params) => {
        cancelledIds.push((params as { id: unknown }).id);
      });
      const controller = new AbortController();
      const pending = connection.request(
        "fake/sleep",
        { ms: 5_000 },
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 50);
      const error = await pending.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(LspError);
      expect((error as LspError).code).toBe("lsp_cancelled");
      await waitUntil(() => cancelledIds.length === 1, 5_000, "fake/cancelled");
    },
    LONG_TEST_MS,
  );

  it(
    "maps a missing method to lsp_operation_unsupported",
    async () => {
      const { pool } = setup();
      const connection = await waitForReady(pool, fakeServer());
      await expect(connection.request("textDocument/unknownThing", {})).rejects.toMatchObject({
        code: "lsp_operation_unsupported",
      });
    },
    LONG_TEST_MS,
  );

  it(
    "logs lifecycle events without leaking env values",
    async () => {
      const { logger, logs } = recordingLogger();
      const { pool } = setup({ logger });
      const server = fakeServer({ FAKE_SECRET_MARK: "super-secret-value" });
      const trace = { traceId: "trace-under-test", sessionId: "session-under-test" };
      while (pool.acquire(server, TEST_KEY, { trace }).state !== "ready") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const ready = logs.find((entry) => entry.context?.event === "adapters.lsp.ready");
      expect(ready?.level).toBe("info");
      expect(ready?.context).toMatchObject({
        module: "adapters.lsp",
        serverId: "fake/ts",
        traceId: "trace-under-test",
        sessionId: "session-under-test",
      });
      expect(JSON.stringify(logs)).not.toContain("super-secret-value");
    },
    LONG_TEST_MS,
  );

  it(
    "logs only JSON-RPC envelopes, never document text",
    async () => {
      const { logger, logs } = recordingLogger();
      const { pool } = setup({ logger });
      const connection = await waitForReady(
        pool,
        fakeServer({ FAKE_LSP_DIAGNOSTICS: "versioned" }),
      );
      const secretText = "const apiKey = 'private-source-text';\n";
      connection.notify("textDocument/didOpen", {
        textDocument: { uri: DOC_URI, languageId: "typescript", version: 1, text: secretText },
      });
      await connection.request("textDocument/hover", {
        textDocument: { uri: DOC_URI },
        position: { line: 0, character: 6 },
      });
      const rpc = logs.filter((entry) => entry.context?.event === "adapters.lsp.jsonrpc");
      expect(rpc.some((entry) => entry.context?.method === "textDocument/didOpen")).toBe(true);
      expect(JSON.stringify(logs)).not.toContain("private-source-text");
    },
    LONG_TEST_MS,
  );
});
