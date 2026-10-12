import type { McpToolUiDescriptor, PluginSandboxHandle } from "./contract.js";
import {
  MCP_APPS_CSP_RELAXATION_META_KEY,
  MCP_APPS_SET_WIDGET_STATE_METHOD,
  PLUGIN_SANDBOX_PORT_NAME,
  buildMcpAppsClientCapabilities,
  buildMcpAppsCspExperimentalCapability,
} from "./contract.js";

/** What a tool's `_meta` with a UI resource should yield after normalization. */
export const exampleToolUiDescriptor: McpToolUiDescriptor = {
  resourceUri: "ui://example-plugin/widget.html",
  visibility: ["model", "app"],
  preferredDisplayMode: "inline",
  csp: { connectDomains: ["https://api.example.com"], resourceDomains: [] },
  prefersBorder: true,
};

/** Handle main returns to the renderer after successful registration; the partition is derived from the server identity and shared by pages of the same server. */
export const exampleSandboxHandle: PluginSandboxHandle = {
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
  // Every resource-level field the handle can carry is set: contract.test uses it against the
  // host's strict response schema, and a missed field sync fails right here.
  resourceMeta: {
    prefersBorder: true,
    heightHint: 320,
    minFrameHeight: 120,
    showInline: false,
    permissions: ["clipboardWrite"],
  },
};

/** UI extension capabilities the agent declares to the MCP server during `initialize`. */
export const exampleClientCapabilities = buildMcpAppsClientCapabilities();
/** CSP relaxation key the host declares in hostCapabilities.experimental. */
export const exampleCspExperimental = buildMcpAppsCspExperimentalCapability();
/** How to declare relaxations in resource-level `_meta`. */
export const exampleResourceMetaWithRelaxations = {
  ui: { csp: { connectDomains: ["https://api.example.com"] } },
  [MCP_APPS_CSP_RELAXATION_META_KEY]: { unsafeEval: true },
};
export const exampleSetWidgetStateMethod = MCP_APPS_SET_WIDGET_STATE_METHOD;
export const examplePortName = PLUGIN_SANDBOX_PORT_NAME;
