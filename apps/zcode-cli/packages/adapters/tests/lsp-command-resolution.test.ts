import { describe, expect, it } from "vitest";
import type { ResolvedLspServer } from "@zcode/contracts";
import {
  buildLspProcessEnv,
  isLspCommandInstalled,
  resolveLspSpawnCommand,
} from "../src/lsp/command-resolution.js";
import { buildInitializeParams } from "../src/lsp/client-capabilities.js";
import { filePathToFileUri, isPathInside } from "../src/lsp/paths.js";
import { LspError } from "@zcode/contracts";

function makeServer(overrides: Partial<ResolvedLspServer> = {}): ResolvedLspServer {
  return {
    id: "demo/ts",
    pluginId: "demo",
    serverName: "ts",
    priority: 0,
    command: "ts-ls",
    args: ["--stdio"],
    env: {},
    extensionToLanguage: { ".ts": "typescript" },
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
    requestTimeoutMs: 60_000,
    restartOnCrash: true,
    maxRestarts: 3,
    diagnosticsAfterEdit: true,
    ...overrides,
  };
}

const WINDOWS_WORKSPACE = "C:\\work\\repo";
const WINDOWS_PATH = "C:\\tools;C:\\Program Files\\nodejs";
const WINDOWS_ENV = {
  PATH: WINDOWS_PATH,
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
};

describe("LSP command resolution on Windows", () => {
  it("routes a .cmd shim through ComSpec with the shared quoting", () => {
    const exists = (path: string) => path === "C:\\tools\\ts-ls.cmd";
    const resolved = resolveLspSpawnCommand(makeServer(), {
      env: WINDOWS_ENV,
      platform: "win32",
      cwd: WINDOWS_WORKSPACE,
      exists,
    });
    expect(resolved.file).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(resolved.args).toEqual(["/d", "/s", "/c", "C:\\tools\\ts-ls.cmd --stdio"]);
    expect(resolved.shell).toBe(false);
  });

  it("spawns a .exe directly without a shell", () => {
    const exists = (path: string) => path === "C:\\Program Files\\nodejs\\ts-ls.exe";
    const resolved = resolveLspSpawnCommand(makeServer(), {
      env: WINDOWS_ENV,
      platform: "win32",
      cwd: WINDOWS_WORKSPACE,
      exists,
    });
    expect(resolved.file.toLowerCase()).toBe("c:\\program files\\nodejs\\ts-ls.exe");
    expect(resolved.args).toEqual(["--stdio"]);
  });

  it("quotes shim arguments that contain shell metacharacters", () => {
    const exists = (path: string) => path === "C:\\tools\\ts-ls.cmd";
    const resolved = resolveLspSpawnCommand(makeServer({ args: ["a&b", "x y"] }), {
      env: WINDOWS_ENV,
      platform: "win32",
      cwd: WINDOWS_WORKSPACE,
      exists,
    });
    expect(resolved.args.at(-1)).toBe('C:\\tools\\ts-ls.cmd "a^&b" "x y"');
  });

  it("reports installed when a PATHEXT candidate exists and missing otherwise", async () => {
    const server = makeServer();
    const probe = (existing: string) => async (path: string) => path === existing;
    await expect(
      isLspCommandInstalled(server, {
        env: WINDOWS_ENV,
        platform: "win32",
        cwd: WINDOWS_WORKSPACE,
        isExecutableFile: probe("C:\\tools\\ts-ls.cmd"),
      }),
    ).resolves.toBe(true);
    await expect(
      isLspCommandInstalled(server, {
        env: WINDOWS_ENV,
        platform: "win32",
        cwd: WINDOWS_WORKSPACE,
        isExecutableFile: probe("D:\\nowhere\\ts-ls.cmd"),
      }),
    ).resolves.toBe(false);
  });

  it("overlays server env case-insensitively so Path and PATH do not both survive", () => {
    const env = buildLspProcessEnv(
      makeServer({ env: { PATH: "C:\\override" } }),
      { Path: "C:\\base", HOME: "C:\\Users\\me" },
      "win32",
    );
    const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
    expect(pathKeys).toEqual(["PATH"]);
    expect(env.PATH).toBe("C:\\override");
  });
});

describe("LSP command resolution on POSIX", () => {
  it("passes argv through unchanged", () => {
    const resolved = resolveLspSpawnCommand(makeServer(), {
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      cwd: "/work/repo",
    });
    expect(resolved).toEqual({
      args: ["--stdio"],
      cwdDialect: "posix",
      file: "ts-ls",
      shell: false,
    });
  });

  it("finds a PATH entry that is executable and reports missing commands", async () => {
    const server = makeServer();
    const found = await isLspCommandInstalled(server, {
      env: { PATH: "/a:/b" },
      platform: "linux",
      cwd: "/work",
      isExecutableFile: async (path) => path === "/b/ts-ls",
    });
    const missing = await isLspCommandInstalled(server, {
      env: { PATH: "/a:/b" },
      platform: "linux",
      cwd: "/work",
      isExecutableFile: async () => false,
    });
    expect(found).toBe(true);
    expect(missing).toBe(false);
  });
});

describe("LSP initialize params and paths", () => {
  it("roots at the workspace and sends the advertised client capabilities", () => {
    const params = buildInitializeParams({
      server: makeServer({ initializationOptions: { preferences: { a: 1 } } }),
      workspacePath: "/work/repo",
      platform: "linux",
      processId: 42,
    });
    expect(params.rootUri).toBe("file:///work/repo");
    expect(params.rootPath).toBe("/work/repo");
    expect(params.workspaceFolders).toEqual([{ uri: "file:///work/repo", name: "repo" }]);
    expect(params.clientInfo).toEqual({ name: "zcode" });
    expect(params.initializationOptions).toEqual({ preferences: { a: 1 } });
    expect(params.capabilities.general.positionEncodings).toEqual(["utf-16"]);
    expect(params.capabilities.textDocument.diagnostic).toEqual({ dynamicRegistration: true });
    expect(params.capabilities.textDocument.synchronization.didSave).toBe(false);
  });

  it("adds a workspaceFolder inside the workspace as a second folder", () => {
    const params = buildInitializeParams({
      server: makeServer({ workspaceFolder: "packages/app" }),
      workspacePath: "/work/repo",
      platform: "linux",
      processId: null,
    });
    expect(params.workspaceFolders.map((folder) => folder.uri)).toEqual([
      "file:///work/repo",
      "file:///work/repo/packages/app",
    ]);
  });

  it("fails start when workspaceFolder escapes the workspace", () => {
    let caught: unknown;
    try {
      buildInitializeParams({
        server: makeServer({ workspaceFolder: "../elsewhere" }),
        workspacePath: "/work/repo",
        platform: "linux",
        processId: null,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LspError);
    expect((caught as LspError).code).toBe("lsp_server_start_failed");
  });

  it("builds Windows file URIs with a lowercase drive letter and encoded segments", () => {
    expect(filePathToFileUri("C:\\work\\my repo", "win32")).toBe("file:///c:/work/my%20repo");
    expect(filePathToFileUri("/work/a#b", "linux")).toBe("file:///work/a%23b");
  });

  it("checks containment with the platform's rules", () => {
    expect(isPathInside("/work/repo", "/work/repo/src", "linux")).toBe(true);
    expect(isPathInside("/work/repo", "/work/repo", "linux")).toBe(true);
    expect(isPathInside("/work/repo", "/work/repo2", "linux")).toBe(false);
    expect(isPathInside("C:\\work\\repo", "C:\\work\\..\\x", "win32")).toBe(false);
  });
});
