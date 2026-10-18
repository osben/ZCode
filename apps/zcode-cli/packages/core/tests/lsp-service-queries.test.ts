import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LspError, type FileMutatedEvent } from "@zcode/contracts";
import { createLspService, LspService } from "../src/lsp/index.js";
import {
  FakeLanguageServerPort,
  LSP_KEY,
  MemoryFileSystem,
  WORKSPACE,
  fileUri,
  flushMicrotasks,
  makePreferences,
  makeServer,
  rawDiagnostic,
  type RecordedMessage,
} from "./lsp-fakes.js";
import type { LspPreferences, ResolvedLspServer } from "@zcode/contracts";

const FILE = `${WORKSPACE}/src/a.ts`;
const FILE_URI = fileUri(FILE);
const DOC = "const user = 1;\nuser;\nlet other = 2;\n";

interface Harness {
  port: FakeLanguageServerPort;
  fs: MemoryFileSystem;
  server: ResolvedLspServer;
  service: LspService;
  prefs: { current: LspPreferences };
}

function setup(
  input: { server?: Partial<ResolvedLspServer>; prefs?: Partial<LspPreferences> } = {},
): Harness {
  const port = new FakeLanguageServerPort();
  const fs = new MemoryFileSystem();
  fs.set(FILE, DOC);
  const server = makeServer(input.server);
  const prefs = { current: makePreferences(input.prefs) };
  const service = createLspService({
    port,
    servers: [server],
    key: LSP_KEY,
    fileSystem: fs.asPort(),
    getPreferences: () => prefs.current,
  });
  return { port, fs, server, service, prefs };
}

function mutation(
  partial: Partial<FileMutatedEvent> & Pick<FileMutatedEvent, "kind">,
): FileMutatedEvent {
  return { path: FILE, ...partial } as FileMutatedEvent;
}

/** Lets queued promise continuations run so that the fake-timer waits are registered before time advances. */
async function settleAsync(): Promise<void> {
  await flushMicrotasks(50);
  await vi.advanceTimersByTimeAsync(0);
}

function methodNames(messages: RecordedMessage[]): string[] {
  return messages.map((message) => message.method);
}

let harness: Harness;

beforeEach(() => {
  harness = setup();
});

afterEach(() => {
  harness.service.dispose();
  vi.useRealTimers();
});

describe("LspService queries", () => {
  it("answers goToDefinition with relative paths, 1-based code point columns and a preview", async () => {
    const { port, service } = harness;
    port.acquire(harness.server, LSP_KEY);
    const conn = port.connection;
    conn.responses.set("textDocument/definition", () => [
      {
        uri: FILE_URI,
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
      },
    ]);

    const output = await service.query("goToDefinition", {
      operation: "goToDefinition",
      filePath: FILE,
      line: 2,
      symbol: "user",
    });

    expect(conn.requests[0]).toEqual({
      method: "textDocument/definition",
      params: { textDocument: { uri: FILE_URI }, position: { line: 1, character: 0 } },
    });
    expect(output).toEqual({
      operation: "goToDefinition",
      server: harness.server.id,
      status: "ok",
      locations: [
        {
          path: "src/a.ts",
          line: 1,
          character: 7,
          endLine: 1,
          endCharacter: 11,
          preview: "const user = 1;",
        },
      ],
      truncated: false,
      total: 1,
    });
  });

  it("maps the character form to the same position as the symbol form", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    harness.port.connection.responses.set("textDocument/hover", () => ({
      contents: { kind: "markdown", value: "const user: number" },
    }));
    const output = await harness.service.query("hover", {
      operation: "hover",
      filePath: FILE,
      line: 1,
      character: 7,
    });
    expect(output.hover).toEqual({ contents: "const user: number" });
    expect(harness.port.connection.requests[0]?.params).toEqual({
      textDocument: { uri: FILE_URI },
      position: { line: 0, character: 6 },
    });
  });

  it("returns the flattened document symbols", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    const range = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
    harness.port.connection.responses.set("textDocument/documentSymbol", () => [
      { name: "user", kind: 13, range, selectionRange: range },
    ]);
    const output = await harness.service.query("documentSymbol", {
      operation: "documentSymbol",
      filePath: FILE,
    });
    expect(output.symbols).toEqual([{ name: "user", kind: "variable", path: "src/a.ts", line: 1 }]);
  });

  it("answers workspaceSymbol from the server with the query", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    harness.port.connection.responses.set("workspace/symbol", () => [
      {
        name: "Service",
        kind: 5,
        location: {
          uri: FILE_URI,
          range: { start: { line: 4, character: 0 }, end: { line: 4, character: 7 } },
        },
        containerName: "pkg",
      },
    ]);
    const output = await harness.service.query("workspaceSymbol", {
      operation: "workspaceSymbol",
      filePath: FILE,
      query: "Service",
    });
    expect(harness.port.connection.requests[0]).toEqual({
      method: "workspace/symbol",
      params: { query: "Service" },
    });
    expect(output.symbols).toEqual([
      { name: "Service", kind: "class", path: "src/a.ts", line: 5, containerName: "pkg" },
    ]);
  });

  it("reports a missing symbol on the line with the dedicated code", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    await expect(
      harness.service.query("goToDefinition", {
        operation: "goToDefinition",
        filePath: FILE,
        line: 3,
        symbol: "user",
      }),
    ).rejects.toMatchObject({ code: "lsp_symbol_not_found_on_line" });
  });

  it("returns starting, not-installed, unsupported and disabled errors with stable codes", async () => {
    const { port, service, prefs } = harness;
    port.state = "starting";
    await expect(
      service.query("hover", { operation: "hover", filePath: FILE, line: 1, character: 1 }),
    ).rejects.toMatchObject({
      code: "lsp_server_starting",
      message: expect.stringContaining("retry shortly; use Grep meanwhile"),
    });

    port.state = "ready";
    port.installed = false;
    await expect(
      service.query("hover", { operation: "hover", filePath: FILE, line: 1, character: 1 }),
    ).rejects.toMatchObject({
      code: "lsp_server_not_installed",
    });

    port.installed = true;
    port.capabilities = { definitionProvider: true };
    await expect(
      service.query("documentSymbol", { operation: "documentSymbol", filePath: FILE }),
    ).rejects.toMatchObject({
      code: "lsp_operation_unsupported",
    });

    prefs.current = makePreferences({ enabled: false });
    await expect(
      service.query("hover", { operation: "hover", filePath: FILE, line: 1, character: 1 }),
    ).rejects.toMatchObject({
      code: "lsp_disabled",
    });
  });

  it("rejects a file with no configured server", async () => {
    await expect(
      harness.service.query("documentSymbol", {
        operation: "documentSymbol",
        filePath: `${WORKSPACE}/README.md`,
      }),
    ).rejects.toMatchObject({ code: "lsp_no_server_for_file" });
  });

  it("returns ok with fresh diagnostics after the server publishes for the opened version", async () => {
    harness.port.acquire(harness.server, LSP_KEY);
    const connection = harness.port.connection;
    connection.onNotify = (message) => {
      if (message.method === "textDocument/didOpen") {
        connection.publish(
          FILE_URI,
          [rawDiagnostic({ line: 0, message: "Cannot find name 'x'", code: 2304, source: "ts" })],
          1,
        );
      }
    };
    const output = await harness.service.diagnostics(FILE);
    expect(output.status).toBe("ok");
    expect(output.diagnostics).toEqual([
      {
        path: "src/a.ts",
        line: 1,
        character: 1,
        severity: "error",
        message: "Cannot find name 'x'",
        code: "2304",
        source: "ts",
      },
    ]);
  });
});

describe("pull diagnostics (spec §5 rule 1)", () => {
  it("uses textDocument/diagnostic when the server advertises it and reports mode pull", async () => {
    harness.port.capabilities = {
      diagnosticProvider: { interFileDependencies: false },
      documentSymbolProvider: true,
    };
    harness.port.acquire(harness.server, LSP_KEY);
    const connection = harness.port.connection;
    connection.responses.set("textDocument/diagnostic", () => ({
      kind: "full",
      items: [rawDiagnostic({ line: 0, message: "pulled error", source: "ts" })],
    }));
    const output = await harness.service.diagnostics(FILE);
    expect(output.status).toBe("ok");
    expect(output.diagnostics?.map((item) => item.message)).toEqual(["pulled error"]);
    expect(harness.service.observedDiagnosticsMode(harness.server.id)).toBe("pull");
    expect(connection.requests.map((request) => request.method)).toContain(
      "textDocument/diagnostic",
    );
  });
});

describe("startup and prewarm (spec §5)", () => {
  it("prewarm acquires the server without waiting or syncing documents", () => {
    harness.service.prewarm(FILE);
    expect(harness.port.acquireCalls).toBe(1);
    expect(harness.port.connections).toHaveLength(1);
    expect(harness.port.connection.notifications).toEqual([]);
  });

  it("creates the service through the factory and exposes the typed error class", () => {
    expect(harness.service).toBeInstanceOf(LspService);
    expect(new LspError("lsp_cancelled", "x").code).toBe("lsp_cancelled");
  });
});
