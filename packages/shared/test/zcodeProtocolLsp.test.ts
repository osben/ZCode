import { describe, expect, it } from "vitest";
import {
  zcodeLspPreferencesGetParamsSchema,
  zcodeLspPreferencesSetParamsSchema,
  zcodeLspStatusResultSchema,
  zcodePluginComponentKindSchema,
  zcodeProtocolMethods,
} from "../src/zcode-protocol/index.js";

const workspace = {
  workspacePath: "/repo",
  workspaceKey: "/repo",
};

describe("LSP workspace protocol", () => {
  it("declares the preference and status methods", () => {
    expect(zcodeProtocolMethods.lspPreferencesGet).toBe("lsp/preferences/get");
    expect(zcodeProtocolMethods.lspPreferencesSet).toBe("lsp/preferences/set");
    expect(zcodeProtocolMethods.lspStatus).toBe("lsp/status");
  });

  it("accepts a patch with explicit null removal and rejects unknown patch keys", () => {
    expect(
      zcodeLspPreferencesSetParamsSchema.parse({
        workspace,
        patch: {
          enabled: false,
          diagnosticsAfterEdit: { "typescript-lsp@zcode-plugins-official/typescript": null },
        },
      }).patch.diagnosticsAfterEdit,
    ).toEqual({ "typescript-lsp@zcode-plugins-official/typescript": null });
    expect(() =>
      zcodeLspPreferencesSetParamsSchema.parse({ workspace, patch: { version: 1 } }),
    ).toThrow();
  });

  it("rejects non-boolean diagnostic overrides and unknown get params", () => {
    expect(() =>
      zcodeLspPreferencesSetParamsSchema.parse({
        workspace,
        patch: { diagnosticsAfterEdit: { "a/b": "yes" } },
      }),
    ).toThrow();
    expect(() => zcodeLspPreferencesGetParamsSchema.parse({ workspace, extra: true })).toThrow();
  });

  it("parses a status result and rejects unknown states", () => {
    const sample = {
      enabled: true,
      servers: [
        {
          serverId: "typescript-lsp@zcode-plugins-official/typescript",
          pluginId: "typescript-lsp@zcode-plugins-official",
          serverName: "typescript",
          command: "typescript-language-server",
          extensions: [".ts", ".tsx"],
          installed: false,
          state: "not_installed",
          diagnosticsMode: "unknown",
          diagnosticsAfterEdit: true,
          restarts: 0,
        },
      ],
    };
    expect(zcodeLspStatusResultSchema.parse(sample)).toEqual(sample);
    expect(() =>
      zcodeLspStatusResultSchema.parse({
        ...sample,
        servers: [{ ...sample.servers[0], state: "running" }],
      }),
    ).toThrow();
  });

  it("includes lsp as a plugin component kind", () => {
    expect(zcodePluginComponentKindSchema.parse("lsp")).toBe("lsp");
  });
});
