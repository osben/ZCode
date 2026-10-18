import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import type { ResolvedLspServer } from "@zcode/contracts";
import { createSessionLsp } from "../src/app/lsp-session.js";

// End-to-end path of spec 19-lsp.md against the real typescript-language-server: session wiring →
// adapter pool → core LspService → navigation and post-edit diagnostics. Skipped when the binary is
// not on PATH, so it never fails on machines without it.
const BINARY = "typescript-language-server";
const E2E_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 45_000;
const RETRY_INTERVAL_MS = 250;

const onPath = (process.env.PATH ?? "")
  .split(delimiter)
  .some((dir) => dir.length > 0 && existsSync(join(dir, BINARY)));
const typescriptRoot = (() => {
  try {
    return dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  } catch {
    return undefined;
  }
})();
const available =
  onPath && typescriptRoot !== undefined && existsSync(join(typescriptRoot, "lib", "tsserver.js"));

const server: ResolvedLspServer = {
  id: "typescript-lsp@zcode-plugins-official/typescript",
  pluginId: "typescript-lsp@zcode-plugins-official",
  serverName: "typescript",
  priority: 1_000,
  command: BINARY,
  args: ["--stdio"],
  env: {},
  extensionToLanguage: { ".ts": "typescript" },
  // Same as the bundled typescript-lsp plugin: without it early requests hit the syntax-only server.
  initializationOptions: { tsserver: { useSyntaxServer: "never" } },
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 5_000,
  requestTimeoutMs: 60_000,
  restartOnCrash: true,
  maxRestarts: 3,
  diagnosticsAfterEdit: true,
};

const errorCode = (error: unknown): string | undefined => {
  const candidate = error as { code?: unknown; context?: { code?: unknown } } | undefined;
  const code = candidate?.context?.code ?? candidate?.code;
  return typeof code === "string" ? code : undefined;
};

async function untilReady<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (errorCode(error) !== "lsp_server_starting" || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
    }
  }
}

const workspace = mkdtempSync(join(tmpdir(), "zcode-lsp-e2e-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

describe.skipIf(!available)(`LSP end-to-end with ${BINARY}`, () => {
  it(
    "navigates to a definition and reports a type error introduced by an edit",
    async () => {
      mkdirSync(join(workspace, "node_modules"), { recursive: true });
      symlinkSync(typescriptRoot!, join(workspace, "node_modules", "typescript"), "dir");
      writeFileSync(
        join(workspace, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      const lib = join(workspace, "lib.ts");
      const main = join(workspace, "main.ts");
      writeFileSync(lib, "export function greet(name: string): string {\n  return name;\n}\n");
      writeFileSync(
        main,
        'import { greet } from "./lib";\nexport const message = greet("zcode");\n',
      );

      const session = createSessionLsp({
        servers: [server],
        cliStorageRoot: join(workspace, ".cli"),
        fileSystemPort: createNodeFileSystemAdapter(),
        workingDirectory: workspace,
        env: process.env,
      });
      try {
        const service = session.service!;
        service.prewarm(main);
        const definition = await untilReady(() =>
          service.query(
            "goToDefinition",
            { operation: "goToDefinition", filePath: main, line: 1, symbol: "greet" },
            {},
          ),
        );
        expect(definition.status).toBe("ok");
        expect(definition.locations?.[0]).toMatchObject({ path: "lib.ts", line: 1 });

        // Seed a fresh baseline for main.ts, then introduce a type error and expect it as new.
        await untilReady(() => service.diagnostics(main, {}));
        const broken =
          'import { greet } from "./lib";\nexport const message: number = greet("zcode");\n';
        writeFileSync(main, broken);
        service.onFileMutated({
          path: main,
          kind: "changed",
          content: broken,
          changedRange: { startLine: 2, endLine: 2 },
        });
        const result = await service.collectEditDiagnostics({ waitMs: 20_000 });
        expect(result.attachmentBody).toMatch(/Found 1 new diagnostic issue/u);
        expect(result.attachmentBody).toMatch(/main\.ts:2:\d+ error .*not assignable/u);
      } finally {
        await session.close();
      }
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "reports only the error near the edit when the file had no baseline (Read → Edit flow)",
    async () => {
      const legacy = join(workspace, "legacy.ts");
      const preExisting = [
        "export function total(values: number[]): number {",
        "  return values.reduce((sum, value) => sum + value, 0);",
        "}",
        "",
        "",
        "",
        "",
        "",
        "// Long-standing error far from the edit; must not be reported as new.",
        'export const stale: number = "not a number";',
        "",
      ].join("\n");
      writeFileSync(legacy, preExisting);

      const session = createSessionLsp({
        servers: [server],
        cliStorageRoot: join(workspace, ".cli-no-baseline"),
        fileSystemPort: createNodeFileSystemAdapter(),
        workingDirectory: workspace,
        env: process.env,
      });
      try {
        const service = session.service!;
        // Read only prewarms; wait until the server answers so the edit is not dropped while starting.
        service.prewarm(legacy);
        await untilReady(() =>
          service.query(
            "documentSymbol",
            { operation: "documentSymbol", filePath: join(workspace, "main.ts") },
            {},
          ),
        );
        const edited = preExisting.replace(
          "  return values.reduce((sum, value) => sum + value, 0);",
          '  const label: number = "sum";\n  return values.reduce((sum, value) => sum + value, label);',
        );
        writeFileSync(legacy, edited);
        service.onFileMutated({
          path: legacy,
          kind: "changed",
          content: edited,
          changedRange: { startLine: 2, endLine: 3 },
        });
        const result = await service.collectEditDiagnostics({ waitMs: 20_000 });
        expect(result.attachmentBody).toMatch(/Found 1 new diagnostic issue/u);
        expect(result.attachmentBody).toMatch(/legacy\.ts:2:\d+ error/u);
        expect(result.attachmentBody).not.toMatch(/legacy\.ts:11:/u);
      } finally {
        await session.close();
      }
    },
    E2E_TIMEOUT_MS,
  );
});
