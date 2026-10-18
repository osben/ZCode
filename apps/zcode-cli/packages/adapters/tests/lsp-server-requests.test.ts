import { describe, expect, it } from "vitest";
import {
  handleServerRequest,
  LspDynamicRegistry,
  lookupSettingsSection,
  type ServerRequestContext,
} from "../src/lsp/server-requests.js";
import { JsonRpcResponseError } from "../src/lsp/json-rpc.js";

function context(overrides: Partial<ServerRequestContext> = {}): ServerRequestContext {
  return {
    settings: { typescript: { format: { enable: true } }, fake: { mode: "strict" } },
    workspaceFolders: [{ uri: "file:///work/repo", name: "repo" }],
    registry: new LspDynamicRegistry(),
    ...overrides,
  };
}

describe("LSP server-to-client requests", () => {
  it("answers workspace/configuration with dot-path lookups and null for missing sections", () => {
    const result = handleServerRequest(context(), "workspace/configuration", {
      items: [
        { section: "typescript.format.enable" },
        { section: "typescript.missing" },
        { section: "fake" },
      ],
    });
    expect(result).toEqual([true, null, { mode: "strict" }]);
  });

  it("answers the whole settings object when an item has no section", () => {
    const ctx = context();
    expect(handleServerRequest(ctx, "workspace/configuration", { items: [{}] })).toEqual([
      ctx.settings,
    ]);
  });

  it("answers workspace/workspaceFolders with the folders in the initialize params", () => {
    expect(handleServerRequest(context(), "workspace/workspaceFolders", undefined)).toEqual([
      { uri: "file:///work/repo", name: "repo" },
    ]);
  });

  it("records dynamic registrations and drops them on unregister", () => {
    const ctx = context();
    expect(
      handleServerRequest(ctx, "client/registerCapability", {
        registrations: [
          {
            id: "d1",
            method: "textDocument/diagnostic",
            registerOptions: { workspaceDiagnostics: false },
          },
        ],
      }),
    ).toBeNull();
    expect(ctx.registry.hasMethod("textDocument/diagnostic")).toBe(true);
    expect(ctx.registry.optionsFor("textDocument/diagnostic")).toEqual({
      options: { workspaceDiagnostics: false },
    });

    handleServerRequest(ctx, "client/unregisterCapability", {
      unregisterations: [{ id: "d1", method: "textDocument/diagnostic" }],
    });
    expect(ctx.registry.hasMethod("textDocument/diagnostic")).toBe(false);
  });

  it("accepts the corrected spelling unregistrations too", () => {
    const registry = new LspDynamicRegistry();
    registry.register([{ id: "d2", method: "textDocument/diagnostic" }]);
    handleServerRequest(context({ registry }), "client/unregisterCapability", {
      unregistrations: [{ id: "d2" }],
    });
    expect(registry.hasMethod("textDocument/diagnostic")).toBe(false);
  });

  it("acknowledges work-done progress creation with null", () => {
    expect(
      handleServerRequest(context(), "window/workDoneProgress/create", { token: "t" }),
    ).toBeNull();
  });

  it("answers unknown methods with JSON-RPC method-not-found", () => {
    let caught: unknown;
    try {
      handleServerRequest(context(), "workspace/applyEdit", {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JsonRpcResponseError);
    expect((caught as JsonRpcResponseError).code).toBe(-32601);
  });
});

describe("LSP settings lookup", () => {
  it("returns null for non-string sections and for paths through non-objects", () => {
    expect(lookupSettingsSection({ a: 1 }, 42)).toBeNull();
    expect(lookupSettingsSection({ a: 1 }, "a.b")).toBeNull();
    expect(lookupSettingsSection(undefined, "a")).toBeNull();
  });

  it("does not follow inherited properties", () => {
    expect(lookupSettingsSection({}, "toString")).toBeNull();
  });
});
