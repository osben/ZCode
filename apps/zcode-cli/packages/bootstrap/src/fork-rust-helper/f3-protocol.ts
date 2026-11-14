import type { McpToolCallResult, SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { ProtocolRequestError } from "../zcode-protocol/server-types.js";

/** Rust ↔ helper messages of F3 (specs/fork-rust-node-helper.md, "F3 Office tools and panels"). */
export const FORK_RUST_HELPER_F3 = {
  mcpConnect: "helper/mcp/connect",
  mcpSend: "helper/mcp/send",
  mcpMessage: "helper/mcp/message",
  mcpClosed: "helper/mcp/closed",
  mcpClose: "helper/mcp/close",
  sessionOpen: "helper/session/open",
  sessionClose: "helper/session/close",
  sessionDelta: "helper/session/delta",
  authorizeAppTool: "helper/authorizeAppTool",
  sampleModel: "helper/sampleModel",
  appToolsReplace: "helper/appTools/replace",
  appToolsCall: "helper/appTools/call",
  appToolsCancel: "helper/appTools/cancel",
  /** Liveness check after a timed-out forwarded call; answers `{}`. */
  ping: "helper/ping",
} as const;

export interface HelperWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}

export const workspaceKeyOf = (workspace: HelperWorkspace) =>
  workspace.workspaceIdentity?.trim() || workspace.workspacePath;

export function parseWorkspace(raw: unknown): HelperWorkspace {
  const value = raw as Partial<HelperWorkspace> | undefined;
  if (!value || typeof value.workspacePath !== "string" || !value.workspacePath)
    throw new ProtocolRequestError(-32602, "workspace.workspacePath is required");
  return {
    workspacePath: value.workspacePath,
    ...(typeof value.workspaceIdentity === "string" && value.workspaceIdentity.trim()
      ? { workspaceIdentity: value.workspaceIdentity }
      : {}),
  };
}

export function requireString(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  if (typeof value !== "string" || !value)
    throw new ProtocolRequestError(-32602, `${key} is required`);
  return value;
}

export function toWireResult(result: McpToolCallResult): Record<string, unknown> {
  return {
    content: result.content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result._meta !== undefined ? { _meta: result._meta } : {}),
  };
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Node's projection of the four plugin UI events (product-projection.ts). */
export function toPluginUiDelta(event: SessionEvent): Record<string, unknown> | undefined {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case SessionEventType.PluginUiResourceUpdated:
      return {
        op: "pluginUi.resourceUpdated",
        pluginId: payload.pluginId,
        serverName: payload.serverName,
        uri: payload.uri,
        subscribers: payload.subscribers,
      };
    case SessionEventType.PluginUiResourceListChanged:
      return {
        op: "pluginUi.resourceListChanged",
        pluginId: payload.pluginId,
        serverName: payload.serverName,
        subscribers: payload.subscribers,
      };
    case SessionEventType.PluginUiInstanceClosed:
      return { op: "pluginUi.instanceClosed", ...payload };
    case SessionEventType.PluginUiAppToolCallRequested:
      return {
        op: "pluginUi.appToolCall",
        ...(payload.activity !== undefined ? { activity: payload.activity } : {}),
        ...(payload.cancelled ? { cancelled: true } : {}),
        pluginId: payload.pluginId,
        serverName: payload.serverName,
        subscribers: payload.subscribers,
        callId: payload.callId,
        toolName: payload.toolName,
        arguments: payload.arguments,
      };
    default:
      return undefined;
  }
}
