import type { CallToolResult } from "@modelcontextprotocol/client";
import { INVALID_PARAMS, ProtocolError } from "@modelcontextprotocol/client";
import type { McpUiDisplayMode, McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { IPluginUiBridgeService, PluginUiPluginScope } from "@zcode/services";
import { resolveRequestedDisplayMode } from "../domain/buildPluginUiHostContext.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";

/**
 * Spec requests / notifications initiated by the page are wired to the official AppBridge:
 * `ui/request-display-mode`, `tools/call`, `ui/open-link`, `ui/notifications/size-changed`,
 * `ui/notifications/request-teardown`, `notifications/message`.
 * Session interactions (ui/message etc.) live in pluginUiInteractionPorts; resource requests in
 * pluginUiResourceSubscriptions.
 */
export interface PluginUiHostAppHandlerDeps {
  currentContext(): McpUiHostContext;
  /** The mode after the host's arbitration is written back to hostContext and (once the handshake is done) pushed as host-context-changed. */
  applyDisplayMode(mode: McpUiDisplayMode): void;
  onDisplayModeRequest(mode: McpUiDisplayMode): McpUiDisplayMode;
  pluginScope(): PluginUiPluginScope;
  bridge: Pick<IPluginUiBridgeService, "callTool" | "cancelToolCall">;
  createCallId(): string;
  /** In-flight page tool call ids; each is cancelled to the agent when the controller disposes. */
  activeCalls: Set<string>;
  onBusyChange?(): void;
  onOpenExternal(url: string): void;
}

const OPEN_LINK_PROTOCOLS = new Set(["http:", "https:"]);

export function installPluginUiHostAppHandlers(
  bridge: PluginUiHostBridge,
  deps: PluginUiHostAppHandlerDeps,
): void {
  bridge.onrequestdisplaymode = async (params) => {
    const context = deps.currentContext();
    const current = context.displayMode ?? "inline";
    const available = context.availableDisplayModes ?? [current];
    const mode = deps.onDisplayModeRequest(
      resolveRequestedDisplayMode(params.mode, current, available),
    );
    if (mode !== context.displayMode) deps.applyDisplayMode(mode);
    return { mode };
  };
  bridge.oncalltool = async (params, ctx) => {
    const signal = ctx.mcpReq?.signal;
    signal?.throwIfAborted();
    const scope = deps.pluginScope();
    const callId = deps.createCallId();
    deps.activeCalls.add(callId);
    deps.onBusyChange?.();
    // The page aborted the request (the SDK's cancelled notification lands on ctx.mcpReq.signal) → cancel at the agent's MCP client.
    const onAbort = () => {
      void deps.bridge.cancelToolCall({ ...scope, callId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await deps.bridge.callTool({
        ...scope,
        toolName: params.name,
        ...(params.arguments ? { arguments: params.arguments } : {}),
        callId,
      });
      return result as CallToolResult;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      deps.activeCalls.delete(callId);
      deps.onBusyChange?.();
    }
  };
  bridge.onopenlink = async (params) => {
    let url: URL;
    try {
      url = new URL(params.url);
    } catch {
      throw new ProtocolError(INVALID_PARAMS, `invalid link ${params.url}`);
    }
    // Only allow http(s): file: / custom schemes handed to the OS would open local programs.
    if (!OPEN_LINK_PROTOCOLS.has(url.protocol)) {
      throw new ProtocolError(INVALID_PARAMS, `only http(s) links can be opened (${url.protocol})`);
    }
    deps.onOpenExternal(url.toString());
    return {};
  };
}

export function installPluginUiHostNotificationHandlers(
  bridge: PluginUiHostBridge,
  deps: {
    pluginId: string;
    onHeight(height: number): void;
    log?: (message: string, detail?: Record<string, unknown>) => void;
  },
): void {
  // The page asks the host to tear itself down: this host's instance lifecycle follows the card / pane, so only log, do not destroy proactively.
  bridge.onrequestteardown = () => {
    deps.log?.("[plugin-ui] app requested teardown", { pluginId: deps.pluginId });
  };
  bridge.onsizechange = (params) => {
    if (typeof params.height === "number") deps.onHeight(params.height);
  };
  bridge.onloggingmessage = (params) => {
    deps.log?.(`[plugin-ui] app log (${params.level})`, {
      pluginId: deps.pluginId,
      data: params.data,
    });
  };
}
