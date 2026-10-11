import type { McpServerConfig } from "@zcode/contracts";
import type { ZCodeProtocolMcpServer } from "@zcode/shared";

export function protocolMcpServersToRuntimeMcpConfig(
  servers: ZCodeProtocolMcpServer[] | undefined,
): { enabled: true; servers: Record<string, McpServerConfig> } | undefined {
  if (!servers || servers.length === 0) {
    return undefined;
  }

  const runtimeServers: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    if ("command" in server) {
      runtimeServers[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map(({ name, value }) => [name, value])),
        // ZCode Protocol's mcpServers is the complete override configuration for session/runtime and
        // status queries. If timeoutMs is not restored here, the timeout saved by the UI is lost
        // before real tool initialization or mcp/list probing.
        ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
        ...(server.isolation !== undefined ? { isolation: server.isolation } : {}),
        ...(server.protocolVersion !== undefined
          ? { protocolVersion: server.protocolVersion }
          : {}),
      };
      continue;
    }
    runtimeServers[server.name] = {
      type: server.type,
      url: server.url,
      headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
      ...(server.oauth !== undefined ? { oauth: server.oauth } : {}),
      // HTTP/SSE MCP uses the same protocol override path, so preserve its timeout just as for stdio.
      ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
      ...(server.isolation !== undefined ? { isolation: server.isolation } : {}),
      ...(server.protocolVersion !== undefined ? { protocolVersion: server.protocolVersion } : {}),
    };
  }

  return { enabled: true, servers: runtimeServers };
}
