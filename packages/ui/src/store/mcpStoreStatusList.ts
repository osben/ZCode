import type { McpServerStatus, ZCodeMcpServer, ZCodeMcpServerStatusSnapshot } from "@zcode/shared";

type MappedMcpServerStatus = {
  authorization?: ZCodeMcpServerStatusSnapshot["authorization"];
  error?: string;
  failureKind?: ZCodeMcpServerStatusSnapshot["failureKind"];
  serverRequestId?: string;
  status: McpServerStatus;
};

function mapRuntimeStatusToUi(snapshot: ZCodeMcpServerStatusSnapshot): MappedMcpServerStatus {
  switch (snapshot.status) {
    case "connected":
    case "connecting":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
      };
    case "disconnected":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
      };
    case "failed":
      return {
        status: "error",
        error: snapshot.error,
        failureKind: snapshot.failureKind ?? "connection_failed",
        serverRequestId: snapshot.serverRequestId,
      };
    case "disabled":
      return { status: "unknown", error: snapshot.error };
    case "untrusted":
      // Untrusted is a definitive state; do not downgrade it to unknown or prompt the user to restart the Agent.
      return { status: "untrusted" };
  }
}

export function mergeMcpServerStatusSnapshots(
  servers: ZCodeMcpServer[],
  statuses: Record<string, ZCodeMcpServerStatusSnapshot>,
  options: { markMissingConnectingAsError?: boolean } = {},
): ZCodeMcpServer[] {
  const markMissingConnectingAsError = options.markMissingConnectingAsError ?? true;
  return servers.map((server) => {
    if (server.source !== "zcodeagentmcp") {
      return server;
    }
    const snapshot = statuses[server.name];
    if (!snapshot) {
      if (markMissingConnectingAsError && server.enabled && server.status === "connecting") {
        return {
          ...server,
          // If mcp/list returns successfully but omits the current row, keeping it in connecting state would make Settings spin forever.
          status: "error",
          failureKind: "status_unavailable",
          toolCount: undefined,
        };
      }
      return server;
    }
    const mapped = mapRuntimeStatusToUi(snapshot);
    return {
      ...server,
      status: mapped.status,
      authorization: mapped.authorization,
      error: mapped.error,
      failureKind: mapped.failureKind,
      serverRequestId: mapped.serverRequestId,
      toolCount: snapshot.toolCount,
      workspaceTrust: server.scope === "workspace" ? snapshot.workspaceTrust : undefined,
      changed: false,
      lastConnected:
        mapped.status === "connected" ? new Date(snapshot.updatedAt) : server.lastConnected,
    };
  });
}
