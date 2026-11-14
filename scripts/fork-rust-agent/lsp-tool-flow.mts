// The request-flow and handler cases of `lsp-tool.mts` (specs/fork-rust-lsp.md "Acceptance (D2)" 3 and 4): Node's
// `runLspQuery` over a fake language-server port, and what `lspHandler` passes on or throws for each input.
import { pathToFileURL } from "node:url";

import type { LspOutput } from "@zcode/contracts";
import { runLspQuery } from "../../apps/zcode-cli/packages/core/src/lsp/query-runner.ts";
import { LspServerRegistry } from "../../apps/zcode-cli/packages/core/src/lsp/registry.ts";
import { splitLines } from "../../apps/zcode-cli/packages/core/src/lsp/position.ts";
import { lspHandler } from "../../apps/zcode-cli/packages/core/src/tool/handlers/lsp.ts";
import { formatLspModelContent } from "../../apps/zcode-cli/packages/core/src/tool/handlers/lsp-format.ts";

function range(line: number, character: number, endLine = line, endCharacter = character + 1) {
  return { start: { line, character }, end: { line: endLine, character: endCharacter } };
}

function location(path: string, line: number, character: number) {
  return { uri: `file://${path}`, range: range(line, character) };
}

function failure(error: unknown) {
  const thrown = error as Error & { code?: string };
  return { error: thrown.message, errorCode: thrown.code ?? thrown.name };
}

function readerOver(files: Record<string, string>) {
  return {
    async readTextFile({ path }: { path: string }) {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { content };
    },
  };
}

// Node's request flow (`runLspQuery`) over a fake port: one `.ts` server `p/ts` for `/w`, and `/w/a.ts`.
export const FLOW_SOURCE = "import { use } from './b';\nconst user = use();\n";
const FLOW_SERVER = {
  id: "p/ts",
  pluginId: "p",
  serverName: "ts",
  priority: 0,
  command: "ts-ls",
  args: [],
  env: {},
  extensionToLanguage: { ".ts": "typescript" },
  startupTimeoutMs: 1,
  shutdownTimeoutMs: 1,
  requestTimeoutMs: 1,
  restartOnCrash: false,
  maxRestarts: 0,
} as unknown as ConstructorParameters<typeof LspServerRegistry>[0][number];

interface FlowCase {
  name: string;
  operation: LspOutput["operation"];
  input: Record<string, unknown>;
  installed?: boolean;
  state?: "ready" | "starting";
  capabilities?: Record<string, unknown>;
  raw?: unknown;
}

const flowCases: FlowCase[] = [
  { name: "relative_path", operation: "hover", input: { filePath: "a.ts", line: 1, character: 1 } },
  { name: "no_server", operation: "documentSymbol", input: { filePath: "/w/README.md" } },
  {
    name: "not_installed",
    operation: "diagnostics",
    input: { filePath: "/w/a.ts" },
    installed: false,
  },
  {
    name: "starting",
    operation: "goToDefinition",
    input: { filePath: "/w/a.ts", line: 2, symbol: "use" },
    state: "starting",
  },
  {
    name: "missing_capability",
    operation: "hover",
    input: { filePath: "/w/a.ts", line: 2, symbol: "use" },
    capabilities: { hoverProvider: false },
  },
  {
    name: "workspace_symbol_without_open",
    operation: "workspaceSymbol",
    input: { filePath: "/w/a.ts", query: "use" },
    capabilities: { workspaceSymbolProvider: true },
    raw: [{ name: "use", kind: 12, location: location("/w/b.ts", 0, 16) }],
  },
  {
    name: "missing_line_after_open",
    operation: "goToDefinition",
    input: { filePath: "/w/a.ts", character: 1 },
    capabilities: { definitionProvider: true },
  },
  {
    name: "definition_by_symbol",
    operation: "goToDefinition",
    input: { filePath: "/w/a.ts", line: 2, symbol: "use" },
    capabilities: { definitionProvider: {} },
    raw: { uri: "file:///w/a.ts", range: range(0, 9, 0, 12) },
  },
  {
    name: "references_with_declaration",
    operation: "findReferences",
    input: { filePath: "/w/a.ts", line: 2, character: 14, includeDeclaration: true },
    capabilities: { referencesProvider: true },
    raw: [location("/w/a.ts", 1, 13)],
  },
];

async function flowGolden(entry: FlowCase) {
  let request: { method: string; params: unknown } | undefined;
  let opened = false;
  const connection = {
    capabilities: entry.capabilities ?? {},
    async request(method: string, params: unknown) {
      request = { method, params };
      return entry.raw ?? null;
    },
  };
  const env = {
    registry: new LspServerRegistry([FLOW_SERVER]),
    key: { workspaceIdentity: "/w", workspacePath: "/w" },
    port: {
      async isInstalled() {
        return entry.installed ?? true;
      },
      acquire() {
        return entry.state === "starting" ? { state: "starting" } : { state: "ready", connection };
      },
    },
    fileSystem: readerOver({ "/w/a.ts": FLOW_SOURCE, "/w/b.ts": "export function use() {}\n" }),
    sync: {
      async ensureOpen(_context: unknown, path: string) {
        opened = true;
        return { uri: pathToFileURL(path).href, lines: splitLines(FLOW_SOURCE) };
      },
    },
    waiters: {},
    assertEnabled() {},
  } as unknown as Parameters<typeof runLspQuery>[0];
  const input = { operation: entry.operation, ...entry.input } as Parameters<typeof runLspQuery>[2];
  try {
    const output = await runLspQuery(env, entry.operation, input, {});
    return { ...entry, opened, request, output, text: formatLspModelContent(output) };
  } catch (error) {
    return { ...entry, opened, request, ...failure(error) };
  }
}

// What Node's `lspHandler` hands the service (`filePath` resolved against the working directory) or throws first.
export const HANDLER_CWD = "/Users/dev/work";
const handlerInputs: Record<string, unknown>[] = [
  { operation: "hover", filePath: "src/a.ts", line: 1, character: 1 },
  { operation: "hover", filePath: "/Users/dev/work/src/../lib//a.ts", line: 1, symbol: "x" },
  { operation: "hover", filePath: "./a b/\u00e9 #[x]@c.ts", line: 1, symbol: "x" },
  { operation: "hover", filePath: "../other/x.ts", line: 1, symbol: "x" },
  { operation: "hover", filePath: "~/x.ts", line: 1, symbol: "x" },
  { operation: "hover", filePath: "/etc/hosts.ts", line: 1, symbol: "x" },
  { operation: "documentSymbol", filePath: "src/a.ts" },
  { operation: "diagnostics", filePath: "src/a.ts", line: 1 },
  { operation: "workspaceSymbol", filePath: "src/a.ts", query: "use" },
  { operation: "workspaceSymbol", filePath: "src/a.ts" },
  { operation: "workspaceSymbol", filePath: "src/a.ts", query: "" },
  { operation: "goToDefinition", filePath: "src/a.ts", character: 1 },
  { operation: "goToDefinition", filePath: "src/a.ts", line: 1 },
  { operation: "goToDefinition", filePath: "src/a.ts", line: 1, character: 1, symbol: "x" },
  { operation: "findReferences", filePath: "src/a.ts", line: 1, symbol: "" },
  { operation: "goToImplementation", filePath: "", line: 1, character: 1 },
  { operation: "hover", filePath: "", line: 1 },
];

async function handlerGolden(input: Record<string, unknown>) {
  let filePath: string | undefined;
  const context = {
    toolCallId: "call_1",
    workingDirectory: HANDLER_CWD,
    workspaceRoot: HANDLER_CWD,
    lsp: {
      async query(_operation: string, query: { filePath: string }) {
        filePath = query.filePath;
        return { operation: "hover", server: "p/ts", status: "ok", truncated: false };
      },
    },
  } as unknown as Parameters<typeof lspHandler>[1];
  try {
    await lspHandler(input, context);
    return { input, filePath };
  } catch (error) {
    return { input, error: (error as Error).message };
  }
}

export const flowGoldens = () => Promise.all(flowCases.map(flowGolden));
export const handlerGoldens = () => Promise.all(handlerInputs.map(handlerGolden));
