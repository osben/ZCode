import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LSP_PREFERENCES,
  type LanguageServerPort,
  type LspPreferences,
  type ResolvedLspServer,
} from "@zcode/contracts";
import type { LspPreferencesStore } from "../src/app/lsp-preferences.js";
import { createLspRuntimeHub } from "../src/app/lsp-runtime-hub.js";
import type { LspDocumentSync } from "@zcode/core";

const documents = { dispose: vi.fn() } as unknown as LspDocumentSync;

const WORKSPACE = "/work/app";

function server(id: string, command: string): ResolvedLspServer {
  return {
    id,
    pluginId: id.split("/")[0]!,
    serverName: id.split("/")[1]!,
    priority: 1_000,
    command,
    args: [],
    env: {},
    extensionToLanguage: { ".ts": "typescript" },
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
    requestTimeoutMs: 60_000,
    restartOnCrash: true,
    maxRestarts: 3,
    diagnosticsAfterEdit: true,
  };
}

function fakeStore(prefs: LspPreferences): LspPreferencesStore {
  return {
    load: vi.fn(async () => prefs),
    get: () => prefs,
    update: vi.fn(async () => prefs),
    subscribe: () => () => undefined,
  } as unknown as LspPreferencesStore;
}

function fakePort(): LanguageServerPort {
  return {
    acquire: vi.fn(),
    isInstalled: vi.fn(async (entry: ResolvedLspServer) => entry.command === "installed-ls"),
    onEvent: () => () => undefined,
    status: () => [
      {
        serverId: "ts@zcode/typescript",
        workspacePath: WORKSPACE,
        state: "ready",
        restarts: 1,
        diagnosticsMode: "unknown",
      },
      {
        serverId: "ts@zcode/typescript",
        workspacePath: "/other",
        state: "crashed",
        restarts: 2,
        diagnosticsMode: "unknown",
      },
    ],
    stopAll: vi.fn(async () => undefined),
  };
}

describe("LspRuntimeHub", () => {
  it("reports declared servers with live state for the requested workspace only", async () => {
    const port = fakePort();
    const hub = createLspRuntimeHub({
      port,
      documents,
      preferences: fakeStore({
        ...DEFAULT_LSP_PREFERENCES,
        diagnosticsAfterEdit: { "py@x/pyright": false },
      }),
      resolveServers: () => [
        server("ts@zcode/typescript", "installed-ls"),
        server("py@x/pyright", "missing-ls"),
      ],
    });

    const status = await hub.protocolHost.getStatus({ workspacePath: WORKSPACE });

    expect(status.enabled).toBe(true);
    expect(status.servers).toEqual([
      expect.objectContaining({
        serverId: "ts@zcode/typescript",
        state: "ready",
        installed: true,
        restarts: 1,
        diagnosticsAfterEdit: true,
        command: "installed-ls",
      }),
      expect.objectContaining({
        serverId: "py@x/pyright",
        state: "not_installed",
        installed: false,
        restarts: 0,
        diagnosticsAfterEdit: false,
      }),
    ]);
    expect(port.acquire).not.toHaveBeenCalled();
  });

  it("stops every server when disabled and re-applies preferences to registered runtimes", async () => {
    const port = fakePort();
    const hub = createLspRuntimeHub({
      port,
      documents,
      preferences: fakeStore(DEFAULT_LSP_PREFERENCES),
      resolveServers: () => [],
    });
    const runtime = { applyLspPreferences: vi.fn(async () => undefined) };
    const failing = { applyLspPreferences: vi.fn(async () => Promise.reject(new Error("boom"))) };
    const unregister = hub.register(runtime);
    hub.register(failing);

    await hub.protocolHost.applyPreferences({ ...DEFAULT_LSP_PREFERENCES, enabled: false });
    expect(port.stopAll).toHaveBeenCalledTimes(1);
    expect(runtime.applyLspPreferences).toHaveBeenCalledTimes(1);

    unregister();
    await hub.protocolHost.applyPreferences(DEFAULT_LSP_PREFERENCES);
    expect(port.stopAll).toHaveBeenCalledTimes(1);
    expect(runtime.applyLspPreferences).toHaveBeenCalledTimes(1);
    expect(failing.applyLspPreferences).toHaveBeenCalledTimes(2);
  });
});
