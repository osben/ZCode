import { ServiceChannels, hostPluginSandboxRegisterResultMessageSchema } from "@zcode/shared";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { describe, expect, it, vi } from "vitest";
import { createPluginUiBridgeService } from "./pluginUiBridgeService.js";
import { examplePrepareAndMount, exampleReadBlob } from "./contract.example.js";
import { IPluginUiBridgeService } from "./contract.js";

describe("plugin-ui-bridge contract", () => {
  it("描述符绑定 plugin-ui-bridge 频道", () => {
    expect(IPluginUiBridgeService.channelName).toBe(ServiceChannels.PluginUiBridge);
    expect(ServiceChannels.PluginUiBridge).toBe("plugin-ui-bridge");
  });

  it("句柄能带的全部资源级字段都过 main → host 的 strict 回包 schema", () => {
    // The reply schema is strict: if a new PluginSandboxHandle.resourceMeta field is not synced to validation.ts,
    // the host rejects the whole reply, the bridge never receives the handle, and the card stays in preparing
    // (reproduced 2026-09-20 in permissions).
    const handle: PluginSandboxHandle = {
      instance: {
        runtimeId: "test-agent",
        generation: 1,
        token: "test-token",
        appIdentity: "a".repeat(64),
      },
      sandboxId: "sb-01",
      initId: 1,
      shellUrl: "zcode-sandbox://shell-sb-01/",
      partition: "persist:plugin-sandbox-v1-0123456789abcdef",
      resourceMeta: {
        prefersBorder: true,
        heightHint: 320,
        minFrameHeight: 120,
        showInline: false,
        permissions: ["clipboardWrite"],
      },
    };
    expect(
      hostPluginSandboxRegisterResultMessageSchema.safeParse({
        type: "plugin-sandbox-register-result",
        requestId: "req-1",
        ok: true,
        ...handle,
      }).success,
    ).toBe(true);
  });

  it("示例只依赖契约方法", async () => {
    const bridge: IPluginUiBridgeService = {
      recycleInstance: async () => true,
      validateInstance: async () => undefined,
      closeInstance: async () => undefined,
      prepareSandbox: async (params) => ({
        instance: {
          runtimeId: "test-agent",
          generation: 1,
          token: "test-token",
          appIdentity: "a".repeat(64),
        },
        sandboxId: `sb-${params.scopeId}`,
        initId: 1,
        shellUrl: `zcode-sandbox://shell-sb-${params.scopeId}/`,
        partition: `plugin-sandbox:sb-${params.scopeId}`,
      }),
      callTool: async () => ({ content: [] }),
      cancelToolCall: async () => ({ cancelled: false }),
      readResource: async (params) => ({
        contents: [{ uri: params.uri, mimeType: "model/gltf-binary", blob: "AAAA" }],
      }),
      // After the resource subscription interfaces grew, the contract example's stand-in must implement them fully, or the old sample blocks type checking.
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      subscribeResource: async () => undefined,
      unsubscribeResource: async () => undefined,
      listSurfaces: async () => [],
    };
    await expect(examplePrepareAndMount(bridge)).resolves.toEqual({
      src: "zcode-sandbox://shell-sb-tool:call_1/",
      partition: "plugin-sandbox:sb-tool:call_1",
      initId: 1,
    });
    await expect(exampleReadBlob(bridge)).resolves.toBe("AAAA");
  });
});

describe("plugin UI telemetry", () => {
  it.each([false, true])(
    "reports tool outcome without request or response content (failure=%s)",
    async (isError) => {
      const reportTelemetryEvent = vi.fn().mockRejectedValue(new Error("offline"));
      const result = { content: [{ type: "text" as const, text: "private output" }], isError };
      const service = createPluginUiBridgeService({
        reportTelemetryEvent,
        callMcpToolForUi: async () => result,
      });
      const params = {
        workspacePath: "/private/path",
        sessionId: "session",
        pluginId: "demo@market",
        serverName: "server",
        toolName: "tool",
        callId: "call",
        arguments: { secret: "private input" },
        instance: {
          runtimeId: "agent",
          generation: 1,
          token: "private token",
          appIdentity: "a".repeat(64),
        },
      };
      expect(await service.callTool(params)).toBe(result);
      expect(reportTelemetryEvent).toHaveBeenCalledTimes(1);
      expect(reportTelemetryEvent.mock.calls[0]![0].eventExtraDetail).toMatchObject({
        plugin_id: "demo@market",
        action: "ui_tool_call",
        result: isError ? "failure" : "success",
      });
      expect(JSON.stringify(reportTelemetryEvent.mock.calls)).not.toContain("private");
    },
  );
});
