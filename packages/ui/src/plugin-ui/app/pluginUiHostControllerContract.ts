import type { Transport } from "@modelcontextprotocol/client";
import type {
  McpUiAppCapabilities,
  McpUiDisplayMode,
  McpUiHostCapabilities,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  IPluginUiAppToolsService,
  IPluginUiBridgeService,
  IPluginUiSamplingService,
} from "@zcode/services";
import type {
  McpAppsToolInputPayload,
  McpAppsToolResultPayload,
  PluginSandboxHandle,
  PluginSandboxPlatformPort,
  PluginSandboxTransportPort,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import type { PluginUiPresentation, PluginUiResourceNotificationTarget } from "../contract.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
import { type PluginUiInteractionCallbacks } from "./pluginUiInteractionPorts.js";

/**
 * Host-side orchestration: prepareSandbox → get the handle and mount the webview → wait for the port
 * with a matching initId → `AppBridge(null)` over the Transport → after `initialized`, feed
 * tool-input / tool-result → serve the page's tools/call / resources/* / open-link / size-changed.
 * All IO is injected via deps; the page manager owns the controller, hooks only register display anchors.
 */
export type PluginUiHostPhase = "idle" | "preparing" | "mounted" | "running" | "error" | "disposed";

export interface PluginUiHostScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  /** Tool card `{ kind: "toolCall" }` or surface `{ kind: "surface" }`; mapped into the sandbox scopeId as part of the idempotency key. */
  scope: PluginUiScopeRef;
}

/** Page-side feed content; read once at `initialized` for the latest values, later changes go through notify*. */
export interface PluginUiToolFeed {
  toolInput?: McpAppsToolInputPayload;
  toolResult?: McpAppsToolResultPayload;
  toolCancelled?: boolean;
}

export interface PluginUiHostControllerDeps extends PluginUiInteractionCallbacks {
  onBusyChange?(): void;
  onInstanceClosed?(): void;
  createTransport(port: PluginSandboxTransportPort): Transport;
  bridge: Pick<
    IPluginUiBridgeService,
    | "closeInstance"
    | "recycleInstance"
    | "validateInstance"
    | "prepareSandbox"
    | "callTool"
    | "cancelToolCall"
    | "readResource"
    | "listResources"
    | "listResourceTemplates"
    | "subscribeResource"
    | "unsubscribeResource"
  >;
  /** App-Provided Tools channel; when absent (web / remote), page tools are not discovered or registered. */
  sampling?: IPluginUiSamplingService;
  appTools?: IPluginUiAppToolsService;
  platform: PluginSandboxPlatformPort;
  /**
   * Registers resource notification entries per Agent instance generation; the host routes server
   * notifications from the projection here. When absent, nothing is registered (the page can still
   * subscribe, but receives no notifications).
   */
  resourceNotifications?: {
    register(
      generation: number,
      target: PluginUiResourceNotificationTarget,
      instance: PluginSandboxHandle["instance"],
    ): () => void;
  };
  /** Id generator for UI-initiated calls; defaults to crypto.randomUUID. */
  createCallId?: () => string;
  /** Timer for handshake timeout / teardown waits; defaults to setTimeout. Returns a cancel function. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  scope: PluginUiHostScope;
  presentation: PluginUiPresentation;
  /** Read once at `initialized` to guarantee the latest tool input / result. */
  getToolFeed(): PluginUiToolFeed;
  /** widgetState initial value (host in-memory store, single owner); read once when the port arrives, undefined = none. */
  getWidgetState(): unknown;
  /** Read when creating the AppBridge on port arrival, generating the capability declaration from the interactions actually available at that moment. */
  getHostCapabilities(): McpUiHostCapabilities;
  initialHostContext: McpUiHostContext;
  hostVersion: string;
  onPhase(
    phase: PluginUiHostPhase,
    detail?: { handle?: PluginSandboxHandle; error?: string },
  ): void;
  onHeight(height: number): void;
  /** `ui/request-display-mode`: the host arbitrates and returns the actual mode (an inline instance opening the side pane and a side pane instance closing its tab both happen here). */
  onDisplayModeRequest(mode: McpUiDisplayMode): McpUiDisplayMode;
  onOpenExternal(url: string): void;
  /** Once after `initialized`: the page-declared appCapabilities (may be undefined). */
  onAppCapabilities?: (capabilities: McpUiAppCapabilities | undefined) => void;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Defaults to `new AppBridge(null, …)`; tests inject a fake bridge. */
  createAppBridge?: (
    hostInfo: { name: string; version: string },
    hostCapabilities: McpUiHostCapabilities,
    hostContext: McpUiHostContext,
  ) => PluginUiHostBridge;
  handshakeTimeoutMs?: number;
  teardownTimeoutMs?: number;
}

export interface PluginUiHostController {
  isBusy(): boolean;
  tryRecycle(): Promise<boolean>;
  start(): void;
  updateHostContext(patch: Partial<McpUiHostContext>): void;
  /** Pushes ui/notifications/tool-input when the pane switches to a new call. */
  notifyToolInput(input: McpAppsToolInputPayload): void;
  notifyToolResult(result: McpAppsToolResultPayload): void;
  /** The host tool was stopped → ui/notifications/tool-cancelled. */
  notifyToolCancelled(): void;
  dispose(): Promise<void>;
  readonly phase: PluginUiHostPhase;
}
