/**
 * plugin-ui-bridge module manifest (architecture-governance managed module).
 * Host-side service: reads and validates plugin `ui://` resources, registers sandboxes with main,
 * proxies tool calls initiated by the UI, and provides the register/claim/return channel for
 * App-Provided Tools (appToolsContract.ts).
 */
export const pluginUiBridgeModule = {
  id: "plugin-ui-bridge",
  requires: ["services", "shared", "mcp-apps-protocol"],
  provides: ["plugin-ui-bridge-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "appToolsContract.ts", "samplingContract.ts"],
} as const;
