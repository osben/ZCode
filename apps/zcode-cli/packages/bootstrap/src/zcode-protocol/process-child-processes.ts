import type { McpTrackedProcess } from "@zcode/adapters";
import type { ZCodeProcessChildProcessesResult } from "@zcode/shared";
import { resolveOfficialPluginNameByHostMcpServerName } from "../app/official-plugin-definitions.js";

/**
 * `process/childProcesses`: map child processes in the in-memory MCP process registry into protocol
 * results. Only enrich ownership (builtin host MCP → official plugin name); perform no I/O. The
 * desktop Host handles CPU/memory sampling.
 */
export function listChildProcesses(
  tracked: readonly McpTrackedProcess[],
): ZCodeProcessChildProcessesResult {
  return {
    processes: tracked.map((process) => {
      const pluginName =
        process.pluginName ??
        (process.mcpSource === "builtin"
          ? resolveOfficialPluginNameByHostMcpServerName(process.serverName)
          : undefined);
      return {
        pid: process.pid,
        serverName: process.serverName,
        mcpSource: process.mcpSource,
        ...(pluginName ? { pluginName } : {}),
      };
    }),
  };
}
