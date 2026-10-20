import { describe, expect, it, vi } from "vitest";
import { withPluginTelemetry } from "../src/plugins/pluginManagement.js";
import { createPluginManagementService } from "../src/plugins/pluginManagementService.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

// Fork adaptation (specs/upstream-sync-final-ledger.md, "## decisions"): the fork's thin plugin
// management service intentionally emits no plugin lifecycle telemetry (see the note on
// reportPluginTelemetryEvent in packages/services/src/node.ts). The upstream reporter was not
// ported because it would also drop the fork's LSP methods. The tests below keep every business
// result, forwarding, cancellation and error-propagation assertion; only the telemetry-event
// expectations were removed.

describe("plugin management results without telemetry", () => {
  const plugin = {
    id: "demo@market",
    name: "demo",
    marketplace: "market",
    version: "1.0",
    enabled: true,
    scope: "user" as const,
  };
  function setup(result: unknown, reject = false) {
    const installPlugin = reject
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
    const service = createPluginManagementService({
      zcodeAgentService: { installPlugin } as unknown as IZCodeAgentService,
    });
    return { service, installPlugin };
  }
  const params = {
    workspacePath: "/private/work",
    pluginName: "demo",
    marketplace: "market",
    telemetry: { entry: "store_detail" as const, client_kind: "desktop" as const },
  };
  it("returns the final result and strips telemetry before forwarding", async () => {
    const result = { installedPlugins: [plugin], dependencyClosure: [plugin.id], diagnostics: [] };
    const { service, installPlugin } = setup(result);
    expect(await service.installPlugin(params)).toBe(result);
    expect(installPlugin).toHaveBeenCalledWith({
      workspacePath: params.workspacePath,
      pluginName: "demo",
      marketplace: "market",
    });
  });
  it("passes diagnostics through without deciding success from them", async () => {
    const diagnostics = [{ severity: "error", message: "secret" }];
    const { service, installPlugin } = setup({
      installedPlugins: [],
      dependencyClosure: [],
      diagnostics,
    });
    await expect(service.installPlugin(params)).resolves.toMatchObject({ diagnostics });
    expect(installPlugin).toHaveBeenCalledTimes(1);
  });
  it("forwards dry runs with the dryRun flag and without telemetry", async () => {
    const { service, installPlugin } = setup({
      installedPlugins: [plugin],
      dependencyClosure: [],
      diagnostics: [],
    });
    await service.installPlugin({ ...params, dryRun: true });
    expect(installPlugin).toHaveBeenCalledWith({
      workspacePath: params.workspacePath,
      pluginName: "demo",
      marketplace: "market",
      dryRun: true,
    });
  });
  it("returns the business result unchanged", async () => {
    const result = { installedPlugins: [plugin], dependencyClosure: [], diagnostics: [] };
    const { service } = setup(result);
    await expect(service.installPlugin(params)).resolves.toBe(result);
  });
  it("preserves the original rejection", async () => {
    const error = new Error("token=secret");
    const { service } = setup(error, true);
    await expect(service.installPlugin(params)).rejects.toBe(error);
  });
});

describe("plugin operation boundaries without telemetry", () => {
  it("preserves the no-op uninstall result and the cancellation protocol", async () => {
    const cancelPluginOperation = vi.fn(async () => ({ cancelled: true, operationId: "cancel-1" }));
    const service = createPluginManagementService({
      zcodeAgentService: {
        uninstallPlugin: vi.fn(async () => ({ diagnostics: [] })),
        cancelPluginOperation,
      } as unknown as IZCodeAgentService,
    });
    await expect(
      service.uninstallPlugin({ workspacePath: "/work", pluginId: "demo@market" }),
    ).resolves.toMatchObject({ diagnostics: [] });
    await expect(service.cancelPluginOperation({ operationId: "cancel-1" })).resolves.toEqual({
      cancelled: true,
      operationId: "cancel-1",
    });
    expect(cancelPluginOperation).toHaveBeenCalledWith({ operationId: "cancel-1" });
  });
  it("keeps explicit cancellation as a rejection and batch partial as a resolved result", async () => {
    const service = createPluginManagementService({
      zcodeAgentService: {
        installPlugin: vi.fn(async () => {
          throw Object.assign(new Error("private"), { name: "AbortError" });
        }),
        updatePlugin: vi.fn(async () => ({
          installedPlugins: [{ id: "a@market", marketplace: "market", scope: "user" }],
          diagnostics: [{ severity: "error", code: "failed", message: "secret" }],
          dependencyClosure: [],
        })),
      } as unknown as IZCodeAgentService,
    });
    await expect(
      service.installPlugin({ workspacePath: "/work", pluginName: "a", marketplace: "market" }),
    ).rejects.toThrow();
    await expect(service.updatePlugin({ workspacePath: "/work" })).resolves.toMatchObject({
      installedPlugins: [{ id: "a@market" }],
    });
  });
  it("isolates concurrent operations so each resolves with its own result", async () => {
    const finishes: Array<(value: unknown) => void> = [];
    const service = createPluginManagementService({
      zcodeAgentService: {
        installPlugin: vi.fn(() => new Promise((resolve) => finishes.push(resolve))),
      } as unknown as IZCodeAgentService,
    });
    const a = service.installPlugin({
      workspacePath: "/a",
      pluginName: "a",
      marketplace: "market",
    });
    const b = service.installPlugin({
      workspacePath: "/b",
      pluginName: "b",
      marketplace: "market",
    });
    finishes[1]({
      installedPlugins: [{ id: "b@market", marketplace: "market", scope: "user" }],
      diagnostics: [],
      dependencyClosure: [],
    });
    await expect(b).resolves.toMatchObject({ installedPlugins: [{ id: "b@market" }] });
    finishes[0]({
      installedPlugins: [{ id: "a@market", marketplace: "market", scope: "user" }],
      diagnostics: [],
      dependencyClosure: [],
    });
    await expect(a).resolves.toMatchObject({ installedPlugins: [{ id: "a@market" }] });
  });
});

describe("serialized cancellation without telemetry", () => {
  it("propagates a JSON-RPC serialized AbortError unchanged", async () => {
    const error = Object.assign(new Error("opaque transport error"), {
      data: { name: "AbortError", stack: "private" },
    });
    const service = createPluginManagementService({
      zcodeAgentService: {
        installPlugin: vi.fn().mockRejectedValue(error),
      } as unknown as IZCodeAgentService,
    });
    await expect(
      service.installPlugin({
        workspacePath: "/private",
        pluginName: "demo",
        marketplace: "market",
      }),
    ).rejects.toBe(error);
  });
});

it("preserves non-enumerable RPC methods when tagging plugin operations", async () => {
  const listPlugins = vi.fn(async () => ({ plugins: [], diagnostics: [] }));
  const installPlugin = vi.fn(async () => ({ installedPlugins: [], diagnostics: [] }));
  const remote = new Proxy(
    {},
    { get: (_target, key) => ({ listPlugins, installPlugin })[key as "listPlugins"] },
  );
  const tagged = withPluginTelemetry(remote as never, {
    entry: "store_detail",
    client_kind: "desktop",
  });
  const params = { workspacePath: "/workspace", pluginName: "demo", marketplace: "market" };
  await tagged.listPlugins(params);
  await tagged.installPlugin(params);
  expect(listPlugins).toHaveBeenCalledWith(params);
  expect(installPlugin).toHaveBeenCalledWith({
    ...params,
    telemetry: { entry: "store_detail", client_kind: "desktop" },
  });
});
