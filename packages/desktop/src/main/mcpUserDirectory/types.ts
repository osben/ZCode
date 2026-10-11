/**
 * MCP user-directory module - type and constant definitions
 */

import type { CliMcpSource, McpFileFormat } from "@zcode/shared";

/**
 * MCP configuration key types
 * - mcpServers: generic JSON directory format (`.agents/mcp.json`)
 * - mcp.servers: zcode CLI `config.json` format
 */
export type McpConfigKeyName = "mcpServers" | "mcp" | "mcp_servers" | "mcp.servers";

/**
 * OpenCode MCP configuration format.
 * OpenCode uses a special configuration format:
 * - the key is "mcp" instead of "mcpServers"
 * - command is an array such as ["npx", "-y", "server"] instead of separate command + args
 * - a type field ("local" or "remote") is required
 */
export interface OpenCodeMcpServerConfig {
  type: "local" | "remote";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpSourceDescriptor {
  source: CliMcpSource;
  configDirSegments: string[];
  fileName: string;
  format: McpFileFormat;
  configKeyName: McpConfigKeyName;
}

export const MCP_SOURCE_DESCRIPTORS: McpSourceDescriptor[] = [
  {
    source: "zcodeagentmcp",
    configDirSegments: [".zcode", "cli"],
    fileName: "config.json",
    format: "json",
    configKeyName: "mcp.servers",
  },
];

export function getSourceDescriptor(source: CliMcpSource): McpSourceDescriptor {
  const descriptor = MCP_SOURCE_DESCRIPTORS.find((item) => item.source === source);
  if (!descriptor) {
    throw new Error(`Unsupported MCP source: ${source}`);
  }
  return descriptor;
}
