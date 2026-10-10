import { existsSync } from "node:fs";
import { normalize } from "node:path";
import type { ZCodeAgentMcpServer } from "@zcode/shared";

function normalizePathForCompare(value: string): string {
  const normalized = normalize(value.trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isFilesystemServer(
  server: ZCodeAgentMcpServer,
): server is Extract<ZCodeAgentMcpServer, { command: string }> {
  return (
    "command" in server &&
    server.name === "filesystem" &&
    server.args.some((arg) => arg.includes("@modelcontextprotocol/server-filesystem"))
  );
}

export function appendWorkspaceToFilesystemMcpServers(
  mcpServers: ZCodeAgentMcpServer[] | undefined,
  workspacePath: string,
): ZCodeAgentMcpServer[] | undefined {
  if (!mcpServers || mcpServers.length === 0) {
    return mcpServers;
  }

  const trimmedWorkspacePath = workspacePath.trim();
  if (!trimmedWorkspacePath || !existsSync(trimmedWorkspacePath)) {
    return mcpServers;
  }

  let changed = false;
  const workspaceKey = normalizePathForCompare(trimmedWorkspacePath);
  const nextServers = mcpServers.map((server) => {
    if (!isFilesystemServer(server)) {
      return server;
    }

    const hasWorkspace = server.args.some((arg) => normalizePathForCompare(arg) === workspaceKey);
    if (hasWorkspace) {
      return server;
    }

    changed = true;
    // A filesystem MCP configured in the user's home directory may include only fixed directories
    // and may not automatically allow the current workspace, causing the agent to receive
    // "Access denied - path outside allowed directories" when writing to project files. Add the current workspace
    // ephemerally only when its local path exists, so remote workspaces are not mistakenly injected into the local MCP.
    return {
      ...server,
      args: [...server.args, trimmedWorkspacePath],
    };
  });

  return changed ? nextServers : mcpServers;
}
