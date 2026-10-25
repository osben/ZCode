import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { ResolvedLspServer } from "@zcode/contracts";
import { createTestPool, waitForReady, waitUntil } from "./lsp-test-helpers.js";

/**
 * Opt-in smoke test against the real typescript-language-server. It runs only when the binary is on PATH;
 * otherwise the suite is skipped and its title says why. It is not part of the fake-server coverage.
 */
const TS_SERVER_BINARY = "typescript-language-server";
const SMOKE_TIMEOUT_MS = 60_000;
const SMOKE_SOURCE = "export function greet(name: string): number {\n  return name;\n}\n";

function findOnPath(binary: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  return dirs.map((dir) => join(dir, binary)).find((candidate) => existsSync(candidate));
}

/**
 * typescript-language-server needs a TypeScript install with `lib/tsserver.js`. TypeScript 7 dropped that file,
 * so the repo's own devDependency (TypeScript 6, resolved from this test file) is passed explicitly.
 */
function resolveRepoTsserverPath(): string | undefined {
  try {
    const typescriptManifest = createRequire(import.meta.url).resolve("typescript/package.json");
    const tsserver = join(dirname(typescriptManifest), "lib", "tsserver.js");
    return existsSync(tsserver) ? tsserver : undefined;
  } catch {
    return undefined;
  }
}

const binaryPath = findOnPath(TS_SERVER_BINARY);
const tsserverPath = resolveRepoTsserverPath();
const available = binaryPath !== undefined && tsserverPath !== undefined;
const suiteTitle = available
  ? "typescript-language-server smoke"
  : binaryPath === undefined
    ? `typescript-language-server smoke (skipped: ${TS_SERVER_BINARY} is not on PATH)`
    : "typescript-language-server smoke (skipped: repo typescript has no lib/tsserver.js)";

const workspace = mkdtempSync(join(tmpdir(), "zcode-lsp-smoke-"));

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe.skipIf(!available)(suiteTitle, () => {
  it(
    "reports a type error and document symbols for a real TypeScript file",
    async () => {
      writeFileSync(
        join(workspace, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      const file = join(workspace, "sample.ts");
      writeFileSync(file, SMOKE_SOURCE);
      const uri = pathToFileURL(file).href;
      const server: ResolvedLspServer = {
        id: "smoke/typescript",
        pluginId: "smoke",
        serverName: "typescript",
        priority: 0,
        command: TS_SERVER_BINARY,
        args: ["--stdio"],
        env: {},
        extensionToLanguage: { ".ts": "typescript" },
        initializationOptions: { tsserver: { path: tsserverPath } },
        startupTimeoutMs: SMOKE_TIMEOUT_MS,
        shutdownTimeoutMs: 5_000,
        requestTimeoutMs: SMOKE_TIMEOUT_MS,
        restartOnCrash: false,
        maxRestarts: 0,
        diagnosticsAfterEdit: true,
      };
      const { pool, dispose } = createTestPool();
      try {
        const connection = await waitForReady(
          pool,
          server,
          { identityKey: workspace, workspacePath: workspace },
          SMOKE_TIMEOUT_MS,
        );
        const publishes: Array<{
          uri: string;
          diagnostics: Array<{ severity?: number; range: { start: { line: number } } }>;
        }> = [];
        connection.onNotification("textDocument/publishDiagnostics", (params) => {
          publishes.push(params as (typeof publishes)[number]);
        });
        connection.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: "typescript", version: 1, text: SMOKE_SOURCE },
        });
        await waitUntil(
          () => publishes.some((publish) => publish.uri === uri && publish.diagnostics.length > 0),
          SMOKE_TIMEOUT_MS,
          "a diagnostic for sample.ts",
        );
        const withErrors = publishes.find((publish) => publish.diagnostics.length > 0);
        // `return name;` is the second line (0-based line 1).
        expect(withErrors?.diagnostics[0]?.range.start.line).toBe(1);

        const symbols = await connection.request<Array<{ name: string }>>(
          "textDocument/documentSymbol",
          { textDocument: { uri } },
        );
        expect(symbols.map((symbol) => symbol.name)).toContain("greet");
      } finally {
        await dispose();
      }
    },
    SMOKE_TIMEOUT_MS,
  );
});
