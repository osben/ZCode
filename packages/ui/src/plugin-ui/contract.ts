import type {
  McpAppsAppToolCallRequest,
  McpAppsDisplayMode,
  McpToolUiCsp,
  PluginSandboxHandle,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import { buildPluginSandboxScopeId } from "@zcode/shared/mcp-apps";
import type { AttachmentRef, ConversationInputSource } from "@zcode/shared/zcode-protocol-v4";
import type { ReactNode } from "react";
import type { PluginUiImageBlock } from "./domain/pluginUiImageBlocks.js";

/**
 * Plugin UI presentation read from ToolCallRow.display.ui; isomorphic to the agent-side `display.ui`
 * schema, parsed by `readPluginUiPresentation`, which returns null on failure and falls back to the
 * plain McpToolCallBlock.
 */
export interface PluginUiPresentation {
  /** display.serverName: namespaced server when the UI calls back as a tool; attribution is validated on the agent side. */
  serverName: string;
  pluginId: string;
  resourceUri: string;
  preferredDisplayMode?: McpAppsDisplayMode;
  prefersBorder?: boolean;
  csp?: McpToolUiCsp;
  structuredContent?: string;
  widgetMeta?: string;
  /** JSON text of the raw content array; when absent, tool-result falls back to the tool output plain text. */
  content?: string;
  truncated?: boolean;
  truncatedBytes?: number;
  /** MCP result isError (the v4 row is still success); tool-result carries isError so the pane does not overwrite a success snapshot with it. */
  isError?: true;
  /** Tool-level forced inline (display.ui.showInline). */
  showInline?: true;
  /** Surface id the tool result belongs to; when it matches a surface tab already open in the session, the result is routed into the pane. */
  surface?: string;
}

/**
 * Request to open a side pane plugin-ui tab; tool cards provide toolCallId, surface entries
 * (launcher / surface routing) provide surfaceId + serverName. Exactly one of the two is present.
 */
export type PluginUiOpenTarget =
  | { toolCallId: string; surfaceId?: never; serverName?: string }
  | { surfaceId: string; serverName: string; toolCallId?: never };

export type OpenPluginUiSideTabRequest = PluginUiOpenTarget & {
  /** 手动新建的文档窗口身份；恢复标签页时保持不变。 */
  instanceId?: string;
  parentSessionId: string;
  pluginId: string;
  resourceUri: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
};

/**
 * Side pane tab; tool card id is `plugin-ui:<ws>:<session>:<pluginId>:<toolCallId>`, surface is
 * `plugin-ui:<ws>:<session>:<pluginId>:surface:<surfaceId>`; visibility is scoped by parentSessionId.
 */
export interface PluginUiSidePaneTab {
  instanceId?: string;
  id: string;
  type: "plugin-ui";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  parentSessionId: string;
  toolCallId?: string;
  surfaceId?: string;
  serverName?: string;
  pluginId: string;
  resourceUri: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
}

export const PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX = 240;
/** DOM position belongs to the view, the page instance to the window owner; moving across containers goes only through the retained carrier layer. */
export interface SandboxPagePlacement {
  node: HTMLElement;
  kind: "flow" | "inline" | "sidebar";
  container?: HTMLElement;
  layer?: number;
}
export const PLUGIN_UI_CARD_MIN_HEIGHT_PX = 80;
export const PLUGIN_UI_CARD_MAX_HEIGHT_PX = 1200;
/**
 * Side pane title bar (AnimatedSidePanePanel's TabsList, `!h-12` = 48px). In fullscreen, hostContext.titleBar
 * tells the plugin page how much height above its viewport the host occupies; the page viewport itself does
 * not overlap it, so all insets are 0.
 */
export const PLUGIN_UI_SIDE_PANE_TITLE_BAR = {
  height: 48,
  leftInset: 0,
  viewportLeftInset: 0,
} as const;

/** Scope of a request / tab: surfaceId wins, otherwise toolCallId; missing both is an invalid request. */
export function readPluginUiScopeRef(
  input: Pick<OpenPluginUiSideTabRequest, "toolCallId" | "surfaceId" | "instanceId">,
): PluginUiScopeRef | null {
  if (input.surfaceId)
    return {
      kind: "surface",
      surfaceId: input.instanceId
        ? `${input.surfaceId}:instance:${input.instanceId}`
        : input.surfaceId,
    };
  if (input.toolCallId) return { kind: "toolCall", toolCallId: input.toolCallId };
  return null;
}

/** All host bindings use the same workspace identity; the path is only for execution and display. */
export interface PluginUiSessionScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string;
}

/**
 * Session actions SessionPane registers with plugin UI. Since 4a-0 only sending follow-up messages
 * remains: widgetState is host memory (`app/pluginUiWidgetStateStore`) and is no longer persisted
 * through session commands.
 */
export interface PluginUiSessionActions {
  /** images first become AttachmentRef via the session's attachment upload entry, then are sent with sendText. */
  sendFollowUp(input: {
    prompt: string;
    source: ConversationInputSource;
    images?: readonly PluginUiImageBlock[];
  }): Promise<void>;
}

/** Adapts the existing SessionPane send entry; admission / owner / ACK are not reimplemented. */
export interface PluginUiSessionCommandPort {
  sendText(
    prompt: string,
    options: { source: ConversationInputSource; attachments?: AttachmentRef[] },
  ): Promise<"sent" | "blocked" | "confirmationRequired" | undefined>;
  /** Inline image → session attachment reference (goes through v4 attachmentPut, same path as composer paste-screenshot). */
  uploadAttachment(input: {
    fileName: string;
    mime: string;
    dataBase64: string;
  }): Promise<AttachmentRef>;
}

export type PluginUiOpenSurfaceRequest = PluginUiOpenTarget & {
  pluginId: string;
  resourceUri: string;
  title: string;
};

export interface PluginUiToolBinding {
  scope: PluginUiSessionScope & { toolCallId: string };
  onOpenSidePane?: (request: PluginUiOpenSurfaceRequest) => void;
}

export function buildPluginUiSessionKey(target: PluginUiSessionScope): string {
  return JSON.stringify([
    target.workspaceIdentity?.trim() || target.workspacePath,
    target.sessionId,
  ]);
}

export function buildPluginUiSurfaceKey(
  target: PluginUiSessionScope & { pluginId: string; serverName?: string; resourceUri?: string },
  scope: PluginUiScopeRef,
): string {
  // Fix: surfaceId is named by the plugin itself, so workspace, session, and plugin must all be isolated.
  return JSON.stringify([
    buildPluginUiSessionKey(target),
    target.pluginId,
    target.serverName ?? "",
    target.resourceUri ?? "",
    buildPluginSandboxScopeId(scope),
  ]);
}

export function buildPluginUiSidePaneTabId(request: OpenPluginUiSideTabRequest): string {
  const scope = readPluginUiScopeRef(request);
  if (!scope) throw new Error("plugin-ui side tab needs toolCallId or surfaceId");
  return [
    "plugin-ui",
    request.workspaceIdentity?.trim() || request.workspacePath,
    request.parentSessionId,
    request.pluginId,
    request.serverName ?? "",
    request.resourceUri,
    ...(scope.kind === "toolCall" ? [scope.toolCallId] : ["surface", scope.surfaceId]),
  ]
    .map(encodeURIComponent)
    .join(":");
}

export interface PluginUiSidePaneViewProps {
  /** 由宿主页面、侧栏展开状态与当前标签派生，不以保活 DOM 的几何相交替代。 */
  visible: boolean;
  scopeRef: PluginUiScopeRef;
  host: {
    pageKey: string;
    handle: PluginSandboxHandle | null;
    phase: "idle" | "preparing" | "mounted" | "running" | "error" | "disposed";
    height: number;
    error: string | null;
    /** Error-state "reload". */
    reload(): void;
  };
  loadingLabel: string;
  errorLabel: string;
  retryLabel: string;
  onWidthChange(width: number): void;
}

export interface PluginUiToolCallViewProps {
  supported: boolean;
  fallback: ReactNode;
  surface?: string;
  preferredDisplayMode: McpAppsDisplayMode;
  sidePaneActive: boolean;
  host: PluginUiSidePaneViewProps["host"];
  prefersBorder: boolean;
  /** Superseded by a newer successful result of the same logical UI; stays a plain tool result, no sandbox or auto side pane open. */
  superseded: boolean;
  /** Manual pin / collapse (undefined follows the default rule); when there is no toggle entry, no button is shown. */
  pinned?: boolean;
  pinLabel: string;
  unpinLabel: string;
  onTogglePin?: () => void;
  loadingLabel: string;
  errorLabel: string;
  retryLabel: string;
  openedLabel: string;
  openLabel: string;
  onWidthChange(width: number): void;
  onOpenSidePane?: () => void;
}

/**
 * Entry through which a sandbox instance receives server resource notifications. The host registers by
 * (session, plugin, scopeId, generation=initId), and `pluginUi.resourceUpdated / resourceListChanged`
 * deltas in the projection route to the matching instance via subscribers.
 */
export interface PluginUiResourceNotificationTarget {
  notifyInstanceClosed?(): void;
  notifyResourceUpdated(uri: string): void;
  notifyResourceListChanged(): void;
  /** Instance mailbox of App-Provided Tools: a model-initiated page tool call has arrived at this instance. */
  notifyAppToolCall(call: McpAppsAppToolCallRequest): void;
}

/** 文档查看器手动入口创建独立窗口；工具调用继续使用原有的显式 surface 路由。 */
export function documentViewerInstance(resourceUri: string): { instanceId?: string } {
  return /^ui:\/\/(documents|pdf|presentations|spreadsheets)\/panel\.html$/.test(resourceUri)
    ? { instanceId: crypto.randomUUID() }
    : {};
}
