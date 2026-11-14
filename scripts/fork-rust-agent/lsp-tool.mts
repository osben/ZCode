// Generates what zcode-rs's `LSP` agent tool takes from Node (specs/fork-rust-lsp.md "Tool (D2)"):
// - packages/rust-cli/prompts/tools/LSP.json: the provider definition (Node's metadata description and
//   `LspInputJsonSchema`);
// - packages/rust-cli/crates/cli/src/lsp/fixtures/lsp_tool_goldens.json: results projected and formatted by Node's own
//   code (`projectOperationResult`, `projectDiagnostics`, `formatLspModelContent`, `resolveModelPosition`), which the
//   Rust tests replay. A Windows section runs the same Node modules with `node:path` as `path.win32` and `node:url`
//   with `{windows: true}` (module hooks, `?win32` instances); a request-flow section drives Node's `runLspQuery` with a
//   fake language-server port;
// - packages/rust-cli/crates/tools/src/fixtures/lsp_tool_inputs.json: what Node's `lspHandler` passes on (the resolved
//   `filePath`) or throws for each input.
//
//   pnpm rust-agent:lsp-tool:update   # regenerate both files
//   pnpm rust-agent:lsp-tool:check    # fail when out of date (CI, pre-push)
import { readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import type { LspDiagnostic, LspOutput } from "@zcode/contracts";
import {
  projectDiagnostics,
  projectOperationResult,
  SourceLineReader,
} from "../../apps/zcode-cli/packages/core/src/lsp/operation-output.ts";
import {
  resolveModelPosition,
  splitLines,
} from "../../apps/zcode-cli/packages/core/src/lsp/position.ts";
import { runLspQuery } from "../../apps/zcode-cli/packages/core/src/lsp/query-runner.ts";
import { LspServerRegistry } from "../../apps/zcode-cli/packages/core/src/lsp/registry.ts";
import {
  lspHandler,
  lspToolEntry,
} from "../../apps/zcode-cli/packages/core/src/tool/handlers/lsp.ts";
import { formatLspModelContent } from "../../apps/zcode-cli/packages/core/src/tool/handlers/lsp-format.ts";
import { FLOW_SOURCE, flowGoldens, HANDLER_CWD, handlerGoldens } from "./lsp-tool-flow.mts";

const definitionPath = fileURLToPath(
  new URL("../../packages/rust-cli/prompts/tools/LSP.json", import.meta.url),
);
const inputsPath = fileURLToPath(
  new URL(
    "../../packages/rust-cli/crates/tools/src/fixtures/lsp_tool_inputs.json",
    import.meta.url,
  ),
);
const goldensPath = fileURLToPath(
  new URL(
    "../../packages/rust-cli/crates/cli/src/lsp/fixtures/lsp_tool_goldens.json",
    import.meta.url,
  ),
);

const WORKSPACE = "/w";
const FILES: Record<string, string> = {
  "/w/src/a.ts":
    "import { use } from './b';\r\nconst user = use();\r\n// \u{1F600} emoji then target\nexport function target() {}\n",
  "/w/src/b.ts": "export function use() {\n  return 1;\n}\n",
  "/w/src/long.ts": `${"x".repeat(250)}\n`,
  "/other/x.ts": "  outside the workspace  \n",
  "/w/src/a b/\u00e9#[x].ts": "export const \u00e9 = 1;\n",
  "/w/src/b@c.ts": "export const at = 2;\n",
};

function range(line: number, character: number, endLine = line, endCharacter = character + 1) {
  return { start: { line, character }, end: { line: endLine, character: endCharacter } };
}

function location(path: string, line: number, character: number) {
  return { uri: `file://${path}`, range: range(line, character) };
}

// A Write-free file system: unknown paths fail like a missing file.
const fileSystem = {
  async readTextFile({ path }: { path: string }) {
    const content = FILES[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return { content };
  },
} as unknown as ConstructorParameters<typeof SourceLineReader>[0];

const LONG_HOVER = `${"\u{1F600}".repeat(5)}${"h".repeat(2_100)}`;

interface OperationCase {
  name: string;
  operation: LspOutput["operation"];
  raw: unknown;
  documentUri: string;
  status?: LspOutput["status"];
}

const operationCases: OperationCase[] = [
  {
    name: "definition_location",
    operation: "goToDefinition",
    raw: location("/w/src/b.ts", 0, 16),
    documentUri: "file:///w/src/a.ts",
  },
  {
    name: "definition_array",
    operation: "goToDefinition",
    raw: [
      { uri: "file:///w/src/a.ts", range: range(2, 17, 2, 23) },
      location("/other/x.ts", 0, 2),
      { uri: 5, range: range(0, 0) },
      { uri: "file:///w/src/b.ts" },
      "junk",
      location("/w/src/long.ts", 0, 0),
    ],
    documentUri: "file:///w/src/a.ts",
  },
  {
    name: "implementation_links",
    operation: "goToImplementation",
    raw: [
      {
        targetUri: "file:///w/src/b.ts",
        targetRange: range(0, 0, 2, 1),
        targetSelectionRange: range(0, 16, 0, 19),
      },
      { targetUri: "file:///w/src/a.ts", targetRange: range(1, 6, 1, 10) },
      { targetUri: "file:///w/src/a.ts", targetRange: "bad" },
    ],
    documentUri: "file:///w/src/a.ts",
  },
  { name: "definition_null", operation: "goToDefinition", raw: null, documentUri: "" },
  {
    name: "references_unreadable_file",
    operation: "findReferences",
    raw: [location("/w/missing.ts", 3, 4)],
    documentUri: "file:///w/src/a.ts",
  },
  {
    name: "references_truncated",
    operation: "findReferences",
    raw: Array.from({ length: 201 }, (_, index) => location("/w/src/b.ts", 0, index % 20)),
    documentUri: "file:///w/src/b.ts",
  },
  {
    name: "document_symbol_tree",
    operation: "documentSymbol",
    raw: [
      {
        name: "A",
        kind: 5,
        range: range(0, 0, 3, 1),
        selectionRange: range(0, 6, 0, 7),
        children: [
          {
            name: "m",
            kind: 6,
            range: range(1, 2, 2, 3),
            selectionRange: range(1, 2, 1, 3),
            children: [{ name: "x", kind: 13, range: range(2, 4), selectionRange: range(2, 4) }],
          },
        ],
      },
      { name: "weird", kind: 99, range: range(4, 0), selectionRange: range(4, 0) },
      { name: "noKind", range: range(5, 0), selectionRange: range(5, 0) },
      { kind: 12, range: range(6, 0), selectionRange: range(6, 0) },
    ],
    documentUri: "file:///w/src/a.ts",
  },
  {
    name: "workspace_symbol_information",
    operation: "workspaceSymbol",
    raw: [
      { name: "use", kind: 12, location: location("/w/src/b.ts", 0, 16), containerName: "mod" },
      { name: "out", kind: 14, location: location("/other/x.ts", 0, 2) },
      { name: "noLocation", kind: 12 },
    ],
    documentUri: "",
  },
  { name: "workspace_symbol_not_array", operation: "workspaceSymbol", raw: {}, documentUri: "" },
  {
    name: "hover_markup",
    operation: "hover",
    raw: { contents: { kind: "markdown", value: "```ts\nfunction use(): number\n```" } },
    documentUri: "file:///w/src/a.ts",
  },
  {
    name: "hover_marked_strings",
    operation: "hover",
    raw: { contents: ["text", { language: "ts", value: "code" }, "", 7] },
    documentUri: "file:///w/src/a.ts",
  },
  {
    name: "hover_plain_string",
    operation: "hover",
    raw: { contents: "  spaced  " },
    documentUri: "file:///w/src/a.ts",
  },
  { name: "hover_empty", operation: "hover", raw: { contents: "   " }, documentUri: "" },
  { name: "hover_null", operation: "hover", raw: null, documentUri: "" },
  {
    name: "hover_truncated",
    operation: "hover",
    raw: { contents: { kind: "plaintext", value: LONG_HOVER } },
    documentUri: "",
  },
  {
    name: "definition_special_paths",
    operation: "goToDefinition",
    raw: [
      { uri: "file:///w/src/a%20b/%C3%A9%23%5Bx%5D.ts", range: range(0, 13) },
      { uri: "file:///w/src/b%40c.ts", range: range(0, 13) },
      { uri: "file:///w/src/b@c.ts", range: range(0, 0) },
      { uri: "file://localhost/w/src/a%20b/%C3%A9%23%5Bx%5D.ts", range: range(0, 0) },
    ],
    documentUri: "file:///w/src/a.ts",
  },
  {
    name: "definition_pending",
    operation: "goToDefinition",
    raw: [],
    documentUri: "",
    status: "pending",
  },
];

const DIAGNOSTICS: LspDiagnostic[] = [
  {
    path: "/w/src/a.ts",
    line: 2,
    character: 7,
    endLine: 2,
    endCharacter: 11,
    severity: "error",
    message: "Type 'string' is not assignable to type 'number'.",
    code: "2322",
    source: "ts",
  },
  {
    path: "/w/src/a.ts",
    line: 1,
    character: 1,
    endLine: 1,
    endCharacter: 2,
    severity: "warning",
    message: "unused",
  },
  {
    path: "/w/src/a.ts",
    line: 3,
    character: 1,
    endLine: 3,
    endCharacter: 2,
    severity: "info",
    message: "dropped info",
  },
  {
    path: "/w/src/a.ts",
    line: 4,
    character: 1,
    endLine: 4,
    endCharacter: 2,
    severity: "hint",
    message: "dropped hint",
    source: "ts",
  },
  {
    path: "/w/src/a.ts",
    line: 5,
    character: 3,
    endLine: 5,
    endCharacter: 4,
    severity: "warning",
    message: "with source only",
    source: "eslint",
  },
];

const diagnosticsCases = [
  { name: "diagnostics_ok", items: DIAGNOSTICS, status: "ok" as const },
  { name: "diagnostics_none", items: [], status: "ok" as const },
  { name: "diagnostics_pending", items: [], status: "pending" as const },
  {
    name: "diagnostics_truncated",
    items: Array.from({ length: 201 }, (_, index) => ({ ...DIAGNOSTICS[0], line: index + 1 })),
    status: "ok" as const,
  },
];

const POSITION_TEXT = "const user = use();\r\n\u{1F600}a b\nx$use use_ $use éuse use\n";
const POSITION_LINES = splitLines(POSITION_TEXT);

const positionCases: { line: number; character?: number; symbol?: string }[] = [
  { line: 1, symbol: "use" },
  { line: 1, symbol: "user" },
  { line: 1, character: 1 },
  { line: 1, character: 20 },
  { line: 1, character: 21 },
  { line: 2, character: 2 },
  { line: 2, character: 3 },
  { line: 2, symbol: "a" },
  { line: 3, symbol: "use" },
  { line: 3, symbol: "$use" },
  { line: 4, character: 1 },
  { line: 4, symbol: "x" },
  { line: 0, character: 1 },
  { line: 5, character: 1 },
  { line: 1.5, character: 1 },
  { line: 1, character: 0 },
  { line: 1, character: 2.5 },
  { line: 1, symbol: "missing" },
  { line: 1, symbol: "" },
  { line: 1 },
  { line: 2, symbol: "\u{1F600}" },
  { line: 1, symbol: "u.e" },
];

interface ProjectionModules {
  projectOperationResult: typeof projectOperationResult;
  projectDiagnostics: typeof projectDiagnostics;
  SourceLineReader: typeof SourceLineReader;
  formatLspModelContent: typeof formatLspModelContent;
}

const posixModules: ProjectionModules = {
  projectOperationResult,
  projectDiagnostics,
  SourceLineReader,
  formatLspModelContent,
};

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
  } as unknown as ConstructorParameters<typeof SourceLineReader>[0];
}

async function operationGolden(
  entry: OperationCase,
  modules = posixModules,
  workspace = WORKSPACE,
  files = FILES,
) {
  const reader = new modules.SourceLineReader(files === FILES ? fileSystem : readerOver(files), {});
  try {
    const output = await modules.projectOperationResult({
      operation: entry.operation,
      serverId: "p/ts",
      raw: entry.raw,
      documentUri: entry.documentUri,
      workspacePath: workspace,
      reader,
      ...(entry.status ? { status: entry.status } : {}),
    });
    return { ...entry, output, text: modules.formatLspModelContent(output) };
  } catch (error) {
    return { ...entry, ...failure(error) };
  }
}

// `fileURLToPath` rejections end the projection with Node's own error. A host is left out: its message names the
// generating machine's platform (the Rust URI tests cover it).
const uriFailures = [
  ["definition_non_file_uri", "untitled:Untitled-1"],
  ["definition_encoded_slash_uri", "file:///w/src%2Fa.ts"],
  ["definition_malformed_uri", "file:///w/src/a%E0%A4%A.ts"],
  ["definition_invalid_url", "notaurl"],
].map(([name, uri]) =>
  operationGolden({
    name: name!,
    operation: "goToDefinition",
    raw: [{ uri, range: range(0, 0) }],
    documentUri: "",
  }),
);

// The same projection as on Windows: fresh `?win32` instances of the core modules see `path.win32` and a `node:url`
// that passes `{windows: true}`.
const WIN32_MARK = "?win32";
const win32Url = new URL("./lsp-win32/url.mjs", import.meta.url).href;
const coreUrl = new URL("../../apps/zcode-cli/packages/core/src/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.includes(WIN32_MARK)) return nextResolve(specifier, context);
    if (specifier === "node:path" || specifier === "path") {
      return { url: "node:path/win32", shortCircuit: true };
    }
    if (specifier === "node:url" || specifier === "url") {
      return { url: win32Url, shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    return resolved.url.startsWith(coreUrl)
      ? { ...resolved, url: `${resolved.url}${WIN32_MARK}` }
      : resolved;
  },
});
const win32Import = (path: string) => import(`${new URL(path, coreUrl).href}${WIN32_MARK}`);
const win32Modules: ProjectionModules = {
  ...(await win32Import("lsp/operation-output.ts")),
  ...(await win32Import("tool/handlers/lsp-format.ts")),
};

const WIN32_WORKSPACE = "C:\\w";
const WIN32_FILES: Record<string, string> = {
  "c:\\w\\src\\a.ts": "import { use } from './b';\nconst user = use();\n",
  "C:\\w\\src\\a b\\\u00e9#[x].ts": "export const \u00e9 = 1;\n",
  "D:\\other\\x.ts": "  outside  \n",
  "\\\\srv\\share\\x.ts": "unc line\n",
};
const win32Cases: OperationCase[] = [
  {
    name: "win32_definition_paths",
    operation: "goToDefinition",
    raw: [
      { uri: "file:///c%3A/w/src/a.ts", range: range(1, 6, 1, 10) },
      { uri: "file:///C:/w/src/a%20b/%C3%A9%23%5Bx%5D.ts", range: range(0, 13) },
      { uri: "file:///D:/other/x.ts", range: range(0, 2) },
      { uri: "file://srv/share/x.ts", range: range(0, 0) },
    ],
    documentUri: "file:///c:/w/src/a.ts",
  },
  {
    name: "win32_workspace_symbols",
    operation: "workspaceSymbol",
    raw: [{ name: "use", kind: 12, location: location("/C:/w/src/a.ts", 0, 9) }],
    documentUri: "",
  },
  {
    name: "win32_encoded_separator_uri",
    operation: "goToDefinition",
    raw: [{ uri: "file:///C:/w/a%5Cb.ts", range: range(0, 0) }],
    documentUri: "",
  },
  {
    name: "win32_relative_uri",
    operation: "goToDefinition",
    raw: [{ uri: "file:///w/a.ts", range: range(0, 0) }],
    documentUri: "",
  },
];
// One file, as a diagnostics answer is per document.
const WIN32_DIAGNOSTICS_PATH = "C:\\w\\src\\a b\\\u00e9#[x].ts";
const win32DiagnosticItems: LspDiagnostic[] = DIAGNOSTICS.map((item) => ({
  ...item,
  path: WIN32_DIAGNOSTICS_PATH,
}));

const goldens = {
  workspace: WORKSPACE,
  files: FILES,
  operations: [
    ...(await Promise.all(operationCases.map((entry) => operationGolden(entry)))),
    ...(await Promise.all(uriFailures)),
  ],
  diagnostics: diagnosticsCases.map((entry) => {
    const output = projectDiagnostics("p/ts", entry.items, WORKSPACE, entry.status);
    return { ...entry, output, text: formatLspModelContent(output) };
  }),
  win32: {
    workspace: WIN32_WORKSPACE,
    files: WIN32_FILES,
    operations: await Promise.all(
      win32Cases.map((entry) => operationGolden(entry, win32Modules, WIN32_WORKSPACE, WIN32_FILES)),
    ),
    diagnostics: (() => {
      const output = win32Modules.projectDiagnostics(
        "p/ts",
        win32DiagnosticItems,
        WIN32_WORKSPACE,
        "ok",
      );
      return {
        path: WIN32_DIAGNOSTICS_PATH,
        items: win32DiagnosticItems,
        output,
        text: win32Modules.formatLspModelContent(output),
      };
    })(),
  },
  flow: { source: FLOW_SOURCE, cases: await flowGoldens() },
  positions: {
    text: POSITION_TEXT,
    lines: POSITION_LINES,
    cases: positionCases.map((input) => {
      try {
        return { input, output: resolveModelPosition(POSITION_LINES, input) };
      } catch (error) {
        const failure = error as Error & { code?: string };
        return { input, error: { code: failure.code, message: failure.message } };
      }
    }),
  },
};

const definition = {
  name: lspToolEntry.metadata.name,
  description: lspToolEntry.metadata.description,
  input_schema: lspToolEntry.inputSchema,
};

const outputs: [string, string][] = [
  [definitionPath, `${JSON.stringify(definition, null, 2)}\n`],
  [goldensPath, `${JSON.stringify(goldens, null, 2)}\n`],
  [inputsPath, `${JSON.stringify({ cwd: HANDLER_CWD, cases: await handlerGoldens() }, null, 2)}\n`],
];

const check = process.argv.includes("--check");
let stale = false;
for (const [path, next] of outputs) {
  const current = await readFile(path, "utf8").catch(() => "");
  if (current === next) continue;
  if (check) {
    console.error(`${path} is out of date; run pnpm rust-agent:lsp-tool:update`);
    stale = true;
  } else {
    await writeFile(path, next);
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exit(1);
