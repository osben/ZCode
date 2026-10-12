import type {
  CallToolRequest,
  CreateMessageRequest,
  CreateMessageResult,
  CallToolResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListToolsRequest,
  ListToolsResult,
  LoggingMessageNotification,
  ReadResourceRequest,
  ReadResourceResult,
  Transport,
} from "@modelcontextprotocol/client";
import type {
  McpUiAppCapabilities,
  McpUiDisplayMode,
  McpUiDownloadFileRequest,
  McpUiDownloadFileResult,
  McpUiHostContext,
  McpUiOpenLinkRequest,
  McpUiRequestDisplayModeRequest,
  McpUiSizeChangedNotification,
  McpUiToolCancelledNotification,
  McpUiToolInputNotification,
  McpUiToolResultNotification,
  McpUiUpdateModelContextRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";

/** Context subset of the official SDK request handlers: the abort signal lives at `ctx.mcpReq.signal`. */
export interface PluginUiRequestContext {
  mcpReq?: { signal?: AbortSignal };
}

/**
 * Subset of the official `AppBridge` members used by the controller. Production uses `new AppBridge(null, …)`;
 * tests can inject fakes. Custom methods (ZCode extensions and ui/message with a relaxed schema) go through
 * the base class's three-arg `setRequestHandler`; spec methods (resources/subscribe) use the two-arg form,
 * where the handler receives the full request.
 */
export interface PluginUiHostBridge {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
  setHostContext(hostContext: McpUiHostContext): void;
  sendToolInput(params: McpUiToolInputNotification["params"]): Promise<void>;
  sendToolResult(params: McpUiToolResultNotification["params"]): Promise<void>;
  sendToolCancelled(params: McpUiToolCancelledNotification["params"]): Promise<void>;
  teardownResource(
    params: Record<string, never>,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  /** Readable after `initialized`; the page-declared availableDisplayModes decides whether the host can switch it to fullscreen. */
  getAppCapabilities(): McpUiAppCapabilities | undefined;
  notification(notification: { method: string; params?: Record<string, unknown> }): Promise<void>;
  /** App-Provided Tools: the host discovers page tools and hands model calls to the page for execution. */
  listTools(
    params: ListToolsRequest["params"],
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<ListToolsResult>;
  callTool(
    params: CallToolRequest["params"],
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<CallToolResult>;
  setNotificationHandler(
    method: "notifications/tools/list_changed",
    handler: (notification: unknown) => void,
  ): void;
  setRequestHandler(
    method: "resources/subscribe" | "resources/unsubscribe",
    handler: (
      request: { params: { uri: string } },
      ctx: PluginUiRequestContext,
    ) => Promise<Record<string, never>>,
  ): void;
  setRequestHandler(
    method: string,
    schemas: { params: unknown; result?: unknown },
    handler: (params: unknown, ctx: PluginUiRequestContext) => Promise<unknown>,
  ): void;
  oninitialized: (() => void) | undefined;
  oncreatesamplingmessage:
    | ((
        params: CreateMessageRequest["params"],
        ctx: PluginUiRequestContext,
      ) => Promise<CreateMessageResult>)
    | undefined;
  oncalltool:
    | ((params: CallToolRequest["params"], ctx: PluginUiRequestContext) => Promise<CallToolResult>)
    | undefined;
  onreadresource:
    | ((params: ReadResourceRequest["params"], ctx: unknown) => Promise<ReadResourceResult>)
    | undefined;
  onlistresources:
    | ((params: ListResourcesRequest["params"], ctx: unknown) => Promise<ListResourcesResult>)
    | undefined;
  onlistresourcetemplates:
    | ((
        params: ListResourceTemplatesRequest["params"],
        ctx: unknown,
      ) => Promise<ListResourceTemplatesResult>)
    | undefined;
  onopenlink: ((params: McpUiOpenLinkRequest["params"], ctx: unknown) => Promise<{}>) | undefined;
  onrequestdisplaymode:
    | ((
        params: McpUiRequestDisplayModeRequest["params"],
        ctx: unknown,
      ) => Promise<{ mode: McpUiDisplayMode }>)
    | undefined;
  onupdatemodelcontext:
    | ((params: McpUiUpdateModelContextRequest["params"], ctx: unknown) => Promise<{}>)
    | undefined;
  ondownloadfile:
    | ((
        params: McpUiDownloadFileRequest["params"],
        ctx: unknown,
      ) => Promise<McpUiDownloadFileResult>)
    | undefined;
  onrequestteardown: (() => void) | undefined;
  onsizechange: ((params: McpUiSizeChangedNotification["params"]) => void) | undefined;
  onloggingmessage: ((params: LoggingMessageNotification["params"]) => void) | undefined;
}
