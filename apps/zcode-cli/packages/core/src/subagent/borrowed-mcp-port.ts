import { toMcpToolName } from "../mcp/name.js";
import type { McpConnectionSnapshot, McpPort, McpWaitForServerOptions } from "@zcode/contracts";
import { SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE } from "./computer-use-policy.js";

export interface BorrowedSubagentMcpAccess {
  port: McpPort;
  snapshot: McpConnectionSnapshot;
}

const BORROWED_MCP_PORT = Symbol("zcode.borrowedMcpPort");

/**
 * child 的 MCP 所有权由端口本身决定：借用端口只读父连接，不订阅配置、不收敛或关闭连接。
 * 修复前所有权是可选参数、默认 owned，漏传的 child 入口会把继承的配置重新提交给父连接。
 */
export function isBorrowedMcpPort(port: McpPort | undefined): boolean {
  return port !== undefined && BORROWED_MCP_PORT in port;
}

export function createBorrowedSubagentMcpAccess(
  parentPort: McpPort,
  parentStartupSnapshot: McpConnectionSnapshot,
  scopedServerNames?: readonly string[],
  deniedServerNames?: ReadonlySet<string>,
): BorrowedSubagentMcpAccess {
  const scope = scopedServerNames === undefined ? undefined : new Set(scopedServerNames);
  const isDenied = (serverName: string): boolean => deniedServerNames?.has(serverName) === true;
  const isInScope = (serverName: string): boolean =>
    (scope === undefined || scope.has(serverName)) && !isDenied(serverName);
  const statuses = Object.fromEntries(
    Object.entries(parentStartupSnapshot.statuses).filter(([serverName]) => isInScope(serverName)),
  );
  const connectedServerNames = new Set(
    Object.entries(statuses)
      .filter(([, status]) => status.status === "connected")
      .map(([serverName]) => serverName),
  );
  const snapshot: McpConnectionSnapshot = {
    statuses,
    tools: parentStartupSnapshot.tools.filter(
      (descriptor) =>
        isInScope(descriptor.serverName) && connectedServerNames.has(descriptor.serverName),
    ),
  };
  const toolNames = new Set(snapshot.tools.map(toMcpToolName));
  const sources = new Map(
    [...connectedServerNames].map((name) => [
      name,
      parentPort.appConnectionSnapshot?.(name)?.identity,
    ]),
  );
  const currentConnection = (name: string) => parentPort.appConnectionSnapshot?.(name) ?? null;
  const sourceIsCurrent = (name: string) => {
    const identity = sources.get(name);
    const current = currentConnection(name);
    // pending 恢复阶段可能暂时没有 live client；只有已确认换源才移出借用目录。
    return identity === undefined || current === null || current.identity === identity;
  };
  const rejectLifecycleMutation = (): never => {
    // The child borrows the parent's adapter and does not own the MCP connection lifecycle.
    throw new Error("Subagent MCP port cannot mutate parent connection lifecycle");
  };

  const port: McpPort = {
    // 借用范围固定，但执行元数据必须走父连接的 live 快照，不能用启动定义冒充当前定义。
    getToolSnapshot: () =>
      Object.fromEntries(
        Object.entries(parentPort.getToolSnapshot())
          .filter(([name]) => connectedServerNames.has(name) && sourceIsCurrent(name))
          .map(([name, row]) => [
            name,
            {
              ...row,
              ...(row.tools
                ? { tools: row.tools.filter((tool) => toolNames.has(toMcpToolName(tool))) }
                : {}),
            },
          ]),
      ),
    ...(parentPort.onSnapshotChanged
      ? { onSnapshotChanged: parentPort.onSnapshotChanged.bind(parentPort) }
      : {}),
    ...(parentPort.appConnectionSnapshot
      ? {
          appConnectionSnapshot: (name: string) =>
            connectedServerNames.has(name) && sourceIsCurrent(name)
              ? currentConnection(name)
              : null,
        }
      : {}),
    ...(parentPort.waitForServer
      ? {
          waitForServer: async (name: string, options: McpWaitForServerOptions) => {
            if (!connectedServerNames.has(name) || !sourceIsCurrent(name))
              return { timedOut: false };
            return parentPort.waitForServer!(name, options);
          },
        }
      : {}),
    async callTool(request, options) {
      if (isDenied(request.serverName)) {
        throw new Error(SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE);
      }
      if (!connectedServerNames.has(request.serverName)) {
        throw new Error(`Subagent MCP server is outside visible scope: ${request.serverName}`);
      }
      // After the source changes the old scope is no longer usable; a same-config reconnect is late-bound by the parent connection, and execution admission already rechecked the target.
      if (!sourceIsCurrent(request.serverName)) throw new Error("Subagent MCP connection changed");
      return parentPort.callTool(request, options);
    },
    async close() {
      // Do not propagate close to the parent adapter when the child ends.
    },
    async connectConfiguredServers() {
      return rejectLifecycleMutation();
    },
    async connectServer() {
      return rejectLifecycleMutation();
    },
    async disconnectServer() {
      return rejectLifecycleMutation();
    },
    async listTools() {
      return [...snapshot.tools];
    },
    async status() {
      return { ...snapshot.statuses };
    },
  };
  return { snapshot, port: Object.assign(port, { [BORROWED_MCP_PORT]: true }) };
}
