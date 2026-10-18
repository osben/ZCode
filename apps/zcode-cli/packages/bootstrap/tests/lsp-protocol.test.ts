import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LSP_PREFERENCES, type LspPreferences } from "@zcode/contracts";
import type { LspPreferencesStore } from "../src/app/lsp-preferences.js";
import {
  getLspPreferences,
  getLspStatus,
  setLspPreferences,
  type LspProtocolHost,
} from "../src/zcode-protocol/lsp.js";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
} from "../src/zcode-protocol/server-types.js";

const workspace = { workspacePath: "/repo", workspaceKey: "/repo" };
const status = {
  enabled: true,
  servers: [
    {
      serverId: "typescript-lsp@zcode-plugins-official/typescript",
      pluginId: "typescript-lsp@zcode-plugins-official",
      serverName: "typescript",
      command: "typescript-language-server",
      extensions: [".ts"],
      installed: true,
      state: "ready" as const,
      diagnosticsMode: "attributed" as const,
      diagnosticsAfterEdit: true,
      restarts: 0,
    },
  ],
};

function createHost(initial: LspPreferences = DEFAULT_LSP_PREFERENCES) {
  let current = initial;
  const preferences = {
    load: vi.fn(async () => current),
    get: vi.fn(() => current),
    update: vi.fn(async (patch: { enabled?: boolean; diagnosticsAfterEdit?: Record<string, boolean | null> }) => {
      current = {
        version: 1,
        enabled: patch.enabled ?? current.enabled,
        diagnosticsAfterEdit: { ...current.diagnosticsAfterEdit, ...patch.diagnosticsAfterEdit },
      };
      return current;
    }),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as LspPreferencesStore & {
    update: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  };
  const host: LspProtocolHost = {
    preferences,
    getStatus: vi.fn(async () => status),
    applyPreferences: vi.fn(async () => undefined),
  };
  return { host, preferences };
}

function contextWith(host?: LspProtocolHost): ZCodeProtocolAgentServerContext {
  return { lsp: host } as unknown as ZCodeProtocolAgentServerContext;
}

describe("LSP protocol handlers", () => {
  it("returns the stored preferences without the storage version field", async () => {
    const { host } = createHost({
      version: 1,
      enabled: false,
      diagnosticsAfterEdit: { "p/ts": false },
    });

    await expect(getLspPreferences(contextWith(host), { workspace })).resolves.toEqual({
      enabled: false,
      diagnosticsAfterEdit: { "p/ts": false },
    });
  });

  it("applies a set through the store and then the running host, returning the new preferences", async () => {
    const { host, preferences } = createHost();
    const applied = vi.mocked(host.applyPreferences);

    const result = await setLspPreferences(contextWith(host), {
      workspace,
      patch: { diagnosticsAfterEdit: { "p/ts": false } },
    });

    expect(preferences.update).toHaveBeenCalledWith({
      diagnosticsAfterEdit: { "p/ts": false },
    });
    expect(applied).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, diagnosticsAfterEdit: { "p/ts": false } }),
    );
    expect(result).toEqual({ enabled: true, diagnosticsAfterEdit: { "p/ts": false } });
    expect(applied.mock.invocationCallOrder[0]!).toBeGreaterThan(
      vi.mocked(preferences.update).mock.invocationCallOrder[0]!,
    );
  });

  it("returns the status reported by the host", async () => {
    const { host } = createHost();
    await expect(getLspStatus(contextWith(host), { workspace })).resolves.toEqual(status);
  });

  it("rejects invalid params before touching the store", async () => {
    const { host, preferences } = createHost();

    await expect(
      setLspPreferences(contextWith(host), {
        workspace,
        patch: { diagnosticsAfterEdit: { "p/ts": "no" } },
      }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      setLspPreferences(contextWith(host), { workspace, patch: { version: 1 } }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(getLspStatus(contextWith(host), { workspace, extra: 1 })).rejects.toBeInstanceOf(
      ProtocolRequestError,
    );
    expect(preferences.update).not.toHaveBeenCalled();
    expect(host.getStatus).not.toHaveBeenCalled();
  });

  it("returns a protocol error instead of crashing when no LSP host is attached", async () => {
    const context = contextWith(undefined);

    for (const call of [
      () => getLspPreferences(context, { workspace }),
      () => setLspPreferences(context, { workspace, patch: { enabled: false } }),
      () => getLspStatus(context, { workspace }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        name: "ProtocolRequestError",
        code: -32000,
        message: "Language server support is not available in this runtime",
      });
    }
  });
});
