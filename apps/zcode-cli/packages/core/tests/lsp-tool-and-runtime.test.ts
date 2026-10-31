import { describe, expect, it, vi } from "vitest";
import { createSessionId, CoreErrorType } from "@zcode/contracts";
import { expectV2CommonContract } from "./tool-contract-assertions.js";
import { lspHandler, lspToolEntry } from "../src/tool/handlers/lsp.js";
import { writeHandler } from "../src/tool/handlers/write.js";
import { editHandler } from "../src/tool/handlers/edit.js";
import { readHandler } from "../src/tool/handlers/read.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import type { ReadFileStateMap, ToolExecutionContext } from "../src/tool/types.js";
import { AgentRuntime } from "../src/runtime.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createLspService } from "../src/lsp/index.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
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
} from "./lsp-fakes.js";
import type { FileMutatedEvent, LspPreferences } from "@zcode/contracts";

const FILE = `${WORKSPACE}/src/a.ts`;
const FILE_URI = fileUri(FILE);

interface Stack {
  port: FakeLanguageServerPort;
  fs: MemoryFileSystem;
  prefs: { current: LspPreferences };
  service: ReturnType<typeof createLspService>;
}

function stack(prefs: Partial<LspPreferences> = {}): Stack {
  const port = new FakeLanguageServerPort();
  const fs = new MemoryFileSystem();
  const current = { current: makePreferences(prefs) };
  const service = createLspService({
    port,
    servers: [makeServer()],
    key: LSP_KEY,
    fileSystem: fs.asPort(),
    getPreferences: () => current.current,
  });
  return { port, fs, prefs: current, service };
}

function toolContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCallId: "tool_lsp",
    traceId: "trace_lsp",
    spanId: "span_lsp",
    abortSignal: new AbortController().signal,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    sessionId: "sess_lsp",
    turnId: "turn_lsp",
    ...overrides,
  } as unknown as ToolExecutionContext;
}

describe("LSP tool contract", () => {
  it("declares the common v2 contract and the read-only, no-side-effect metadata", () => {
    expectV2CommonContract(lspToolEntry);
    expect(lspToolEntry.metadata).toMatchObject({
      name: "LSP",
      readOnly: true,
      concurrentSafe: true,
      needsApproval: false,
      sideEffectScope: "none",
      riskLevel: "low",
      timeoutMs: 65_000,
    });
    expect(lspToolEntry.timeout).toEqual({
      defaultMs: 65_000,
      maxMs: 65_000,
      allowCallOverride: false,
    });
    expect(lspToolEntry.permission.patternSources).toEqual(["path", "input"]);
  });

  it("is projected with its input schema into the registry contracts", () => {
    const registry = createToolRegistry();
    registry.register(lspToolEntry);
    const contract = registry.toContracts().find((tool) => tool.name === "LSP");
    expect(contract).toBeDefined();
    expect(JSON.stringify(contract?.inputSchema)).toContain("goToDefinition");
  });

  it("is registered only when includeLsp is true", () => {
    const withoutLsp = createToolRegistry();
    registerBuiltInTools(withoutLsp, {});
    expect(withoutLsp.has("LSP")).toBe(false);

    const withLsp = createToolRegistry();
    registerBuiltInTools(withLsp, { includeLsp: true });
    expect(withLsp.has("LSP")).toBe(true);
  });
});

describe("LSP tool handler", () => {
  it("resolves the file path against the workspace and returns the service output", async () => {
    const { port, fs, service } = stack();
    fs.set(FILE, "const user = 1;\nuser;\n");
    port.acquire(makeServer(), LSP_KEY);
    port.connection.responses.set("textDocument/hover", () => ({ contents: "const user: number" }));

    const output = await lspHandler(
      { operation: "hover", filePath: "src/a.ts", line: 2, symbol: "user" },
      toolContext({ lsp: service }),
    );

    expect(output).toMatchObject({
      operation: "hover",
      status: "ok",
      hover: { contents: "const user: number" },
    });
    expect(port.connection.requests[0]?.params).toEqual({
      textDocument: { uri: FILE_URI },
      position: { line: 1, character: 0 },
    });
  });

  it("validates positional input: exactly one of character or symbol, and query for workspaceSymbol", async () => {
    const { service } = stack();
    const context = toolContext({ lsp: service });
    await expect(
      lspHandler({ operation: "hover", filePath: FILE, line: 1 }, context),
    ).rejects.toThrow("requires exactly one of character or symbol");
    await expect(
      lspHandler(
        { operation: "hover", filePath: FILE, line: 1, character: 1, symbol: "x" },
        context,
      ),
    ).rejects.toThrow("requires exactly one of character or symbol");
    await expect(
      lspHandler({ operation: "workspaceSymbol", filePath: FILE }, context),
    ).rejects.toMatchObject({
      message: expect.stringContaining("workspaceSymbol requires query"),
      context: expect.objectContaining({ code: "lsp_invalid_input" }),
    });
  });

  it("maps a starting server to a recoverable structured error with the stable code", async () => {
    const { port, service } = stack();
    port.state = "starting";
    const error = await lspHandler(
      { operation: "hover", filePath: FILE, line: 1, character: 1 },
      toolContext({ lsp: service }),
    ).catch(
      (caught: unknown) =>
        caught as Error & {
          context?: Record<string, unknown>;
          recoverable?: boolean;
          type?: string;
        },
    );
    expect(error.type).toBe(CoreErrorType.ToolExecutionFailed);
    expect(error.context).toMatchObject({ code: "lsp_server_starting", toolName: "LSP" });
    expect(error.recoverable).toBe(true);
    expect(error.message).toContain("retry shortly; use Grep meanwhile");
  });

  it("maps a non-retryable service error with its code and recoverable=false", async () => {
    const { service, fs } = stack();
    fs.set(FILE, "const user = 1;\n");
    const error = await lspHandler(
      { operation: "goToDefinition", filePath: FILE, line: 1, symbol: "missing" },
      toolContext({ lsp: service }),
    ).catch(
      (caught: unknown) =>
        caught as Error & { context?: Record<string, unknown>; recoverable?: boolean },
    );
    expect(error.context).toMatchObject({ code: "lsp_symbol_not_found_on_line" });
    expect(error.recoverable).toBe(false);
  });

  it("fails with a configuration error when no service is wired", async () => {
    const error = await lspHandler(
      { operation: "documentSymbol", filePath: FILE },
      toolContext(),
    ).catch((caught: unknown) => caught as Error & { type?: string });
    expect(error.type).toBe(CoreErrorType.ConfigurationError);
  });
});

describe("LSP registration gate and runtime preferences", () => {
  function runtimeWith(stackUnderTest: Stack) {
    return new AgentRuntime(createSessionId("lsp-gate"), {} as never, {
      eventStore: createTestSessionEventStore(),
      toolRegistry: createToolRegistry(),
      lsp: stackUnderTest.service,
    });
  }

  it("registers the LSP tool after availability resolves and removes it when disabled", async () => {
    const current = stack();
    const runtime = runtimeWith(current);
    expect(runtime.getToolRegistry().has("LSP")).toBe(false);

    await runtime.applyLspPreferences();
    expect(runtime.getToolRegistry().has("LSP")).toBe(true);

    current.prefs.current = makePreferences({ enabled: false });
    await runtime.applyLspPreferences();
    expect(runtime.getToolRegistry().has("LSP")).toBe(false);
    expect(current.port.stopAllCalls).toBe(1);
  });

  it("keeps the LSP tool out of the registry when no server binary is installed", async () => {
    const current = stack();
    current.port.installed = false;
    const runtime = runtimeWith(current);
    await runtime.applyLspPreferences();
    expect(runtime.getToolRegistry().has("LSP")).toBe(false);
  });

  it("does not register the LSP tool in a runtime without a service", async () => {
    const runtime = new AgentRuntime(createSessionId("lsp-none"), {} as never, {
      eventStore: createTestSessionEventStore(),
      toolRegistry: createToolRegistry(),
    });
    await runtime.applyLspPreferences();
    expect(runtime.getToolRegistry().has("LSP")).toBe(false);
  });
});

describe("Write, Edit and Read hooks", () => {
  it("Write publishes a created FileMutated event after a successful create", async () => {
    const fs = new MemoryFileSystem();
    const events: FileMutatedEvent[] = [];
    await writeHandler(
      { file_path: "src/new.ts", content: "const a = 1;\nconst b = 2;\n" },
      toolContext({
        fileSystemPort: fs.asPort(),
        readFileState: new Map(),
        fileMutationSink: (event) => events.push(event),
      } as Partial<ToolExecutionContext>),
    );
    expect(events).toEqual([
      expect.objectContaining({
        path: `${WORKSPACE}/src/new.ts`,
        kind: "created",
        content: "const a = 1;\nconst b = 2;\n",
        changedRange: { startLine: 1, endLine: 3 },
      }),
    ]);
  });

  it("Edit publishes a changed FileMutated event with the patch range", async () => {
    const fs = new MemoryFileSystem();
    fs.set(FILE, "one\ntwo\nthree\n");
    const stat = await fs.stat({ path: FILE });
    const readFileState: ReadFileStateMap = new Map([
      [
        createReadFileStatePathKey(FILE),
        {
          path: FILE,
          content: "one\ntwo\nthree\n",
          isPartialView: false,
          readAt: new Date(),
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.sizeBytes,
        },
      ],
    ]);
    const events: FileMutatedEvent[] = [];
    await editHandler(
      { file_path: FILE, old_string: "two", new_string: "TWO" },
      toolContext({
        fileSystemPort: fs.asPort(),
        readFileState,
        fileMutationSink: (event) => events.push(event),
      } as Partial<ToolExecutionContext>),
    );
    // structuredPatch hunks include three context lines, so the new-side range spans the whole three-line file.
    expect(events).toEqual([
      expect.objectContaining({
        path: FILE,
        kind: "changed",
        changedRange: { startLine: 1, endLine: 3 },
      }),
    ]);
  });

  it("Read prewarms the language server before reading a text file", async () => {
    const prewarm = vi.fn();
    const fs = new MemoryFileSystem();
    fs.set(FILE, "const a = 1;\n");
    await readHandler(
      { file_path: FILE },
      toolContext({
        fileSystemPort: fs.asPort(),
        readFileState: new Map(),
        lspPrewarm: prewarm,
      } as Partial<ToolExecutionContext>),
    ).catch(() => undefined);
    expect(prewarm).toHaveBeenCalledWith(FILE);
  });
});

describe("turn-loop diagnostics attachment (spec §6)", () => {
  function requestTexts(request: { messages?: unknown[] }): string[] {
    return (request.messages ?? []).map((message) => JSON.stringify(message));
  }

  function countDiagnosticsAttachments(texts: string[]): number {
    return texts.filter((text) => text.includes("Found 1 new diagnostic issues")).length;
  }

  it("commits the diagnostics attachment once for the request after a mutation, and never repeats it", async () => {
    const current = stack();
    current.fs.set(FILE, "const a = 1;\nconst b: number = 'x';\n");
    current.port.acquire(makeServer(), LSP_KEY);
    const connection = current.port.connection;
    connection.onNotify = (message) => {
      if (
        message.method === "textDocument/didOpen" ||
        message.method === "textDocument/didChange"
      ) {
        const version = (message.params as { textDocument: { version: number } }).textDocument
          .version;
        connection.publish(
          FILE_URI,
          [rawDiagnostic({ line: 1, message: "Type error", code: 2322, source: "ts" })],
          version,
        );
      }
    };

    const requests: string[][] = [];
    const runtime = createTestAgentRuntime(
      createSessionId("lsp-turn-loop"),
      {},
      {
        eventStore: createTestSessionEventStore(),
        toolRegistry: createToolRegistry(),
        lsp: current.service,
        modelFactory: createTestModelFactory({
          async generateText(request: { messages?: unknown[] }) {
            requests.push(requestTexts(request));
            return {
              finishReason: "stop",
              text: "done",
              toolCalls: [],
              providerMetadata: undefined,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    await runtime.applyLspPreferences();

    // A mutation before the turn: the first model request must carry the attachment exactly once.
    current.service.onFileMutated({
      path: FILE,
      kind: "changed",
      content: "const a = 1;\nconst b: number = 'x';\n",
      changedRange: { startLine: 1, endLine: 2 },
    });
    await flushMicrotasks();
    await runtime.executeTurn("first");
    expect(countDiagnosticsAttachments(requests[0] ?? [])).toBe(1);

    // No mutation since: the next request does not add a second attachment.
    await runtime.executeTurn("second");
    const lastRequest = requests.at(-1) ?? [];
    expect(countDiagnosticsAttachments(lastRequest)).toBe(1);
    expect(current.service.observedDiagnosticsMode(makeServer().id)).toBe("versioned");
  });
});
