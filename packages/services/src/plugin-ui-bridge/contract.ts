import type { ZCodePluginUiSurface } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { McpToolUiCsp, PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";

/** Same workspace targeting as the other zcodeAgentService methods: identity via workspaceIdentity, path via workspacePath. */
export interface PluginUiWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** Shared attribution scope for UI-initiated plugin MCP requests: same session, same plugin, same namespaced server. */
export interface PluginUiPluginScope extends PluginUiWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  /** Namespaced server (plugin:<name>:<server>) that owns display.ui / the manifest surface; attribution is validated by the agent-side catalog. */
  serverName: string;
}

export interface PluginUiPrepareSandboxParams extends Omit<PluginUiPluginScope, "instance"> {
  /** Sandbox scope id (`buildPluginSandboxScopeId`): tool cards use `tool:<toolCallId>`, panels use `surface:<surfaceId>`. */
  scopeId: string;
  resourceUri: string;
  /** webContents id of the host window that initiated the request; main uses it to verify webview attach ownership. */
  ownerWebContentsId: number;
  /**
   * Tool-level declaration from display.ui. Serves only as a fallback: the `ui://` resource entry's own
   * `_meta` (csp / prefersBorder / size hints) is authoritative; the bridge parses and prefers it when
   * reading the resource. Product decision: fully trust plugin declarations.
   */
  csp?: McpToolUiCsp;
  prefersBorder?: boolean;
}

export interface PluginUiCallToolParams extends PluginUiPluginScope {
  toolName: string;
  arguments?: Record<string, unknown>;
  /** Host-generated call id; when unmounting a card, cancelToolCall cancels the in-flight call at the agent's MCP client. */
  callId: string;
}
export interface PluginUiCancelToolCallParams extends PluginUiPluginScope {
  callId: string;
}

export interface PluginUiCallToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** Page-initiated `resources/read`; the result shape matches MCP `resources/read` so pages can consume it directly. */
export interface PluginUiReadResourceParams extends PluginUiPluginScope {
  uri: string;
}
export interface PluginUiResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  /** base64. */
  blob?: string;
}
export interface PluginUiReadResourceResult {
  contents: PluginUiResourceContent[];
}

/** Page-initiated resources/list and resources/templates/list; results are MCP-shaped, cursors pass through. */
export interface PluginUiListResourcesParams extends PluginUiPluginScope {
  cursor?: string;
}
export interface PluginUiResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
export interface PluginUiListResourcesResult {
  resources: PluginUiResourceDescriptor[];
  nextCursor?: string;
}
export interface PluginUiListResourceTemplatesResult {
  resourceTemplates: Array<Omit<PluginUiResourceDescriptor, "uri"> & { uriTemplate: string }>;
  nextCursor?: string;
}
/**
 * Subscribe / unsubscribe. Subscriber identity = session + sandbox scope + instance generation (initId);
 * the agent reference-counts by (server, uri); dispose unsubscribes only this generation. When the server
 * does not support subscriptions the agent returns -32001.
 */
export interface PluginUiResourceSubscriptionParams extends PluginUiPluginScope {
  scopeId: string;
  generation: number;
  uri: string;
}

/** Workspace-level panel entry (manifest `ui.surfaces[]`), from the agent's `plugins/listUiSurfaces`. */
export type PluginUiSurfaceEntry = ZCodePluginUiSurface;

/**
 * Plugin UI bridge. The UI depends only on this descriptor and never calls zcodeAgentService directly
 * (M5 ③-3 platform capability surface consolidation).
 * `prepareSandbox` is idempotent on (ownerWebContentsId, workspaceKey, sessionId, pluginId, scopeId): repeated calls
 * return the same sandboxId with an increasing initId; concurrent calls with the same key only merge resource reads,
 * while each registration proceeds independently (H15-a, each caller gets its own initId);
 * sequential calls still re-read to fetch the latest HTML.
 * The handle's `resourceMeta` carries resource-level prefersBorder / heightHint / minFrameHeight (H02).
 */
export interface IPluginUiBridgeService {
  validateInstance(params: PluginUiPluginScope): Promise<void>;
  recycleInstance(params: PluginUiPluginScope): Promise<boolean>;
  closeInstance(params: PluginUiPluginScope): Promise<void>;
  prepareSandbox(params: PluginUiPrepareSandboxParams): Promise<PluginSandboxHandle>;
  callTool(
    params: PluginUiCallToolParams,
    options?: { signal?: AbortSignal },
  ): Promise<PluginUiCallToolResult>;
  /**
   * Cancels the in-flight call with the given callId. The renderer → host RPC cannot carry an AbortSignal,
   * so cancellation is an explicit request; the agent aborts down to the MCP client. Returns false when the
   * call already finished or was never registered.
   */
  cancelToolCall(params: PluginUiCancelToolCallParams): Promise<{ cancelled: boolean }>;
  readResource(params: PluginUiReadResourceParams): Promise<PluginUiReadResourceResult>;
  /** Resource list / templates / subscriptions, scoped to the same plugin server as readResource; attribution is validated by the agent. */
  listResources(params: PluginUiListResourcesParams): Promise<PluginUiListResourcesResult>;
  listResourceTemplates(
    params: PluginUiListResourcesParams,
  ): Promise<PluginUiListResourceTemplatesResult>;
  subscribeResource(params: PluginUiResourceSubscriptionParams): Promise<void>;
  unsubscribeResource(params: PluginUiResourceSubscriptionParams): Promise<void>;
  /** Panel entries for enabled plugins; the UI re-fetches after plugins start or stop (no caching). */
  listSurfaces(params: PluginUiWorkspaceTarget): Promise<PluginUiSurfaceEntry[]>;
}

export const IPluginUiBridgeService = createServiceDescriptor<IPluginUiBridgeService>(
  ServiceChannels.PluginUiBridge,
);
