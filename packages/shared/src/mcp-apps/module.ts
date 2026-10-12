/**
 * mcp-apps-protocol module manifest (architecture-governance managed module).
 * Pure domain: ZCode extension constants for MCP Apps, `_meta` normalization, the `display.ui` schema, and sandbox contract types; zero IO.
 * The page-host wire protocol is carried by the official `@modelcontextprotocol/ext-apps`; this module no longer holds a state machine.
 */
export const mcpAppsProtocolModule = {
  id: "mcp-apps-protocol",
  requires: [],
  provides: ["mcp-apps-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
