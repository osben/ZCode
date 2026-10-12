import type { IPluginUiBridgeService } from "./contract.js";

/** Typical UI-side usage: prepare the sandbox to get a handle, then hand the handle to the webview for mounting; panel scopes use `surface:<id>`. */
export async function examplePrepareAndMount(bridge: IPluginUiBridgeService) {
  const handle = await bridge.prepareSandbox({
    workspacePath: "/repo",
    sessionId: "session_1",
    pluginId: "example-plugin@example-marketplace",
    serverName: "plugin:example-plugin:widget",
    scopeId: "tool:call_1",
    resourceUri: "ui://example-plugin/widget.html",
    ownerWebContentsId: 1,
  });
  return { src: handle.shellUrl, partition: handle.partition, initId: handle.initId };
}

/** The page's `resources/read` reads binary resources from the same plugin's server through the bridge; results are MCP-shaped. */
export async function exampleReadBlob(bridge: IPluginUiBridgeService) {
  const result = await bridge.readResource({
    instance: {
      runtimeId: "test-agent",
      generation: 1,
      token: "test-token",
      appIdentity: "a".repeat(64),
    },
    workspacePath: "/repo",
    sessionId: "session_1",
    pluginId: "example-plugin@example-marketplace",
    serverName: "plugin:example-plugin:widget",
    uri: "ui://example-plugin/model.glb",
  });
  return result.contents[0]?.blob ?? null;
}

/** Sampling binds to the existing page identity, history is submitted by the App, and results return only to the App. */
export function exampleSample(
  service: import("./samplingContract.js").IPluginUiSamplingService,
  scope: import("./contract.js").PluginUiPluginScope,
) {
  return service.sample({
    ...scope,
    operationId: "sample-1",
    request: {
      messages: [{ role: "user", content: { type: "text", text: "Explain 1/2" } }],
      maxTokens: 128,
    },
  });
}
