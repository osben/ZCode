import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";
import type { PluginLoadOutcome } from "@zcode/contracts";

// Official Claude marketplace language servers (fixtures for the shapes the loader must accept).
const OFFICIAL_LSP_FIXTURES = {
  clangd: {
    command: "clangd",
    args: ["--background-index"],
    extensionToLanguage: {
      ".c": "c",
      ".h": "c",
      ".cpp": "cpp",
      ".cc": "cpp",
      ".cxx": "cpp",
      ".hpp": "cpp",
      ".hxx": "cpp",
      ".C": "cpp",
      ".H": "cpp",
    },
  },
  "csharp-ls": { command: "csharp-ls", extensionToLanguage: { ".cs": "csharp" } },
  gopls: { command: "gopls", extensionToLanguage: { ".go": "go" } },
  jdtls: {
    command: "jdtls",
    extensionToLanguage: { ".java": "java" },
    startupTimeout: 120_000,
  },
  "kotlin-lsp": {
    command: "kotlin-lsp",
    args: ["--stdio"],
    extensionToLanguage: { ".kt": "kotlin", ".kts": "kotlin" },
    startupTimeout: 120_000,
  },
  lua: { command: "lua-language-server", extensionToLanguage: { ".lua": "lua" } },
  intelephense: {
    command: "intelephense",
    args: ["--stdio"],
    extensionToLanguage: { ".php": "php" },
  },
  pyright: {
    command: "pyright-langserver",
    args: ["--stdio"],
    extensionToLanguage: { ".py": "python", ".pyi": "python" },
  },
  "ruby-lsp": {
    command: "ruby-lsp",
    extensionToLanguage: {
      ".rb": "ruby",
      ".rake": "ruby",
      ".gemspec": "ruby",
      ".ru": "ruby",
      ".erb": "ruby",
    },
  },
  "rust-analyzer": { command: "rust-analyzer", extensionToLanguage: { ".rs": "rust" } },
  "sourcekit-lsp": { command: "sourcekit-lsp", extensionToLanguage: { ".swift": "swift" } },
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
  },
} as const;

const TEMP_PREFIX = "zcode-lsp-test-";
const LSP_CONFIG_INVALID = "lsp_config_invalid";
const LSP_EXTENSION_SHADOWED = "lsp_extension_shadowed";

describe("plugin lspServers loading", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  async function createFixtureRoot(): Promise<{ dir: string; workspace: string; storage: string }> {
    const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    dirs.push(dir);
    const workspace = join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    return { dir, storage: join(dir, "plugins"), workspace };
  }

  async function writePlugin(
    dir: string,
    name: string,
    input: {
      lspServers?: unknown;
      userConfig?: Record<string, unknown>;
      files?: Record<string, unknown>;
    },
  ): Promise<string> {
    const root = join(dir, "plugins-src", name);
    await mkdir(join(root, ".zcode-plugin"), { recursive: true });
    const manifest: Record<string, unknown> = { name, version: "1.0.0" };
    if (input.lspServers !== undefined) manifest.lspServers = input.lspServers;
    if (input.userConfig !== undefined) manifest.userConfig = input.userConfig;
    await writeFile(join(root, ".zcode-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
    for (const [relativePath, content] of Object.entries(input.files ?? {})) {
      await mkdir(join(root, relativePath, ".."), { recursive: true });
      await writeFile(join(root, relativePath), JSON.stringify(content), "utf8");
    }
    return root;
  }

  function discover(
    fixture: { storage: string; workspace: string },
    roots: string[],
    enabledPlugins: Record<string, boolean> = {},
  ): PluginLoadOutcome {
    return createNodePluginAdapter({ storageRoot: fixture.storage }).discoverPluginsSync({
      config: { dirs: roots, enabled: true, enabledPlugins, options: {}, suppressedBuiltins: [] },
      env: {},
      storageRoot: fixture.storage,
      workingDirectory: fixture.workspace,
    } as never);
  }

  it("merges the default .lsp.json with manifest declarations, later same-name servers winning", async () => {
    const fixture = await createFixtureRoot();
    const root = await writePlugin(fixture.dir, "merge-lsp", {
      files: {
        ".lsp.json": {
          shared: { command: "from-file", extensionToLanguage: { ".a": "a" } },
          onlyFile: { command: "file-only", extensionToLanguage: { ".f": "f" } },
        },
      },
      lspServers: {
        shared: { command: "from-manifest", extensionToLanguage: { ".b": "b" } },
      },
    });

    const outcome = discover(fixture, [root]);

    // A replaced server keeps the position of the declaration it replaces, so compare as a set.
    expect(outcome.lspServers.map((server) => server.id).sort()).toEqual([
      "merge-lsp@inline/onlyFile",
      "merge-lsp@inline/shared",
    ]);
    expect(outcome.lspServers.find((server) => server.serverName === "shared")).toMatchObject({
      command: "from-manifest",
      extensionToLanguage: { ".b": "b" },
    });
    expect(outcome.plugins[0]?.lspServerNames.sort()).toEqual(["onlyFile", "shared"]);
    expect(outcome.diagnostics.filter((d) => d.code === LSP_CONFIG_INVALID)).toEqual([]);
  });

  it("accepts a path, an array of paths and inline maps, and the lspServers wrapper in files", async () => {
    const fixture = await createFixtureRoot();
    const root = await writePlugin(fixture.dir, "forms-lsp", {
      files: {
        "lsp/wrapped.json": {
          lspServers: { wrapped: { command: "wrapped", extensionToLanguage: { ".w": "w" } } },
        },
        "lsp/array-entry.json": {
          fromArray: { command: "array", extensionToLanguage: { ".x": "x" } },
        },
      },
      lspServers: [
        "./lsp/wrapped.json",
        "./lsp/array-entry.json",
        { inline: { command: "inline", extensionToLanguage: { ".i": "i" } } },
      ],
    });

    const outcome = discover(fixture, [root]);

    expect(outcome.lspServers.map((server) => server.serverName).sort()).toEqual([
      "fromArray",
      "inline",
      "wrapped",
    ]);
  });

  it("drops only the invalid server (unknown key) and reports lsp_config_invalid", async () => {
    const fixture = await createFixtureRoot();
    const root = await writePlugin(fixture.dir, "strict-lsp", {
      lspServers: {
        good: { command: "good", extensionToLanguage: { ".g": "g" } },
        bad: {
          command: "bad",
          extensionToLanguage: { ".b": "b" },
          unknownKey: true,
        },
      },
    });

    const outcome = discover(fixture, [root], { "strict-lsp@inline": true });

    expect(outcome.lspServers.map((server) => server.serverName)).toEqual(["good"]);
    expect(outcome.plugins[0]?.enabled).toBe(true);
    const invalid = outcome.diagnostics.filter((d) => d.code === LSP_CONFIG_INVALID);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({
      pluginId: "strict-lsp@inline",
      severity: "warning",
    });
    expect(invalid[0]?.message).toContain('"bad"');
    expect(invalid[0]?.message).toContain("strict-lsp@inline");
  });

  it("expands templates like MCP stdio servers and exports the plugin identity environment", async () => {
    const fixture = await createFixtureRoot();
    const root = await writePlugin(fixture.dir, "tmpl-lsp", {
      lspServers: {
        tmpl: {
          command: "${CLAUDE_PLUGIN_ROOT}/bin/server",
          args: ["--data", "${ZCODE_PLUGIN_DATA}", "${CLAUDE_PROJECT_DIR}"],
          env: { CUSTOM_DIR: "${CLAUDE_PLUGIN_DATA}/cache" },
          workspaceFolder: "packages/app",
          startupTimeout: 45_000,
          extensionToLanguage: { ".t": "t" },
        },
      },
    });

    const outcome = discover(fixture, [root]);
    const dataPath = outcome.plugins[0]?.dataPath ?? "";
    const server = outcome.lspServers[0];

    expect(server).toMatchObject({
      args: ["--data", dataPath, fixture.workspace],
      command: join(root, "bin/server"),
      id: "tmpl-lsp@inline/tmpl",
      pluginId: "tmpl-lsp@inline",
      serverName: "tmpl",
      workspaceFolder: join("packages", "app"),
      startupTimeoutMs: 45_000,
      shutdownTimeoutMs: 5_000,
      requestTimeoutMs: 60_000,
      restartOnCrash: true,
      maxRestarts: 3,
      diagnosticsAfterEdit: true,
    });
    expect(server?.env).toMatchObject({
      CLAUDE_PLUGIN_ROOT: root,
      ZCODE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: dataPath,
      ZCODE_PLUGIN_DATA: dataPath,
      CLAUDE_PROJECT_DIR: fixture.workspace,
      ZCODE_PROJECT_DIR: fixture.workspace,
      CUSTOM_DIR: `${dataPath}/cache`,
    });
  });

  it("skips only a server whose template cannot be resolved", async () => {
    const fixture = await createFixtureRoot();
    const root = await writePlugin(fixture.dir, "secret-lsp", {
      lspServers: {
        leaky: {
          command: "${user_config.token}",
          extensionToLanguage: { ".l": "l" },
        },
        fine: { command: "fine", extensionToLanguage: { ".f": "f" } },
      },
      userConfig: { token: { sensitive: true, default: "secret" } },
    });

    const outcome = discover(fixture, [root]);

    expect(outcome.lspServers.map((server) => server.serverName)).toEqual(["fine"]);
    expect(outcome.diagnostics).toContainEqual(
      expect.objectContaining({ code: LSP_CONFIG_INVALID, pluginId: "secret-lsp@inline" }),
    );
  });

  it("gives disabled plugins declared names but no runnable servers", async () => {
    const fixture = await createFixtureRoot();
    const root = await writePlugin(fixture.dir, "off-lsp", {
      lspServers: { off: { command: "off", extensionToLanguage: { ".o": "o" } } },
    });

    const outcome = discover(fixture, [root], { "off-lsp@inline": false });

    expect(outcome.lspServers).toEqual([]);
    expect(outcome.plugins[0]).toMatchObject({ enabled: false, lspServerNames: ["off"] });
    expect(outcome.plugins[0]?.components).toContainEqual(
      expect.objectContaining({
        kind: "lsp",
        items: [{ name: "off", description: ".o" }],
      }),
    );
  });

  it("gives an extension to the earlier-loaded plugin and drops the server when nothing else remains", async () => {
    const fixture = await createFixtureRoot();
    const first = await writePlugin(fixture.dir, "first-lsp", {
      lspServers: {
        ts: { command: "first-ts", extensionToLanguage: { ".ts": "typescript" } },
      },
    });
    const second = await writePlugin(fixture.dir, "second-lsp", {
      lspServers: {
        mixed: {
          command: "second",
          extensionToLanguage: { ".ts": "typescript", ".py": "python" },
        },
        onlyTs: { command: "second-ts", extensionToLanguage: { ".ts": "typescript" } },
      },
    });

    const outcome = discover(fixture, [first, second]);

    const byId = Object.fromEntries(outcome.lspServers.map((server) => [server.id, server]));
    expect(Object.keys(byId).sort()).toEqual(["first-lsp@inline/ts", "second-lsp@inline/mixed"]);
    expect(byId["first-lsp@inline/ts"]?.extensionToLanguage).toEqual({ ".ts": "typescript" });
    expect(byId["second-lsp@inline/mixed"]?.extensionToLanguage).toEqual({ ".py": "python" });
    const shadowed = outcome.diagnostics.filter((d) => d.code === LSP_EXTENSION_SHADOWED);
    expect(shadowed).toHaveLength(2);
    expect(shadowed.map((d) => d.pluginId).sort()).toEqual([
      "second-lsp@inline",
      "second-lsp@inline",
    ]);
    expect(shadowed.every((d) => d.severity === "warning")).toBe(true);
  });

  it("loads every official Claude marketplace language server shape without diagnostics", async () => {
    const fixture = await createFixtureRoot();
    const declared = OFFICIAL_LSP_FIXTURES;
    const root = await writePlugin(fixture.dir, "official-lsp", { lspServers: declared });

    const outcome = discover(fixture, [root], { "official-lsp@inline": true });

    expect(outcome.diagnostics.filter((d) => d.code === LSP_CONFIG_INVALID)).toEqual([]);
    expect(outcome.lspServers.map((server) => server.serverName).sort()).toEqual(
      Object.keys(declared).sort(),
    );
    const clangd = outcome.lspServers.find((server) => server.serverName === "clangd");
    expect(clangd?.extensionToLanguage[".C"]).toBe("cpp");
    const jdtls = outcome.lspServers.find((server) => server.serverName === "jdtls");
    expect(jdtls?.startupTimeoutMs).toBe(120_000);
  });
});
