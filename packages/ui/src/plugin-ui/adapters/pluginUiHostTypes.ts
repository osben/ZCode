import type { McpUiAppCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import type {
  McpAppsDisplayMode,
  McpAppsHostTitleBar,
  McpAppsToolResultPayload,
  PluginSandboxHandle,
} from "@zcode/shared/mcp-apps";
import type {
  PluginUiHostControllerDeps,
  PluginUiHostPhase,
  PluginUiHostScope,
} from "../app/pluginUiHostController.js";
import type { PluginUiPresentation } from "../contract.js";
export interface UsePluginUiHostInput {
  presentation: PluginUiPresentation;
  scope: PluginUiHostScope;
  theme: "light" | "dark";
  locale: string;
  displayMode: McpAppsDisplayMode;
  toolInput: Record<string, unknown> | undefined;
  toolResult: McpAppsToolResultPayload | undefined;
  /** Which tool call feeds this host; when it changes (the pane switches to a new call), toolInput is pushed to the page as a tool-input notification. */
  toolCallId?: string;
  /** The host tool was stopped; when this becomes true, a single tool-cancelled notification is sent to the page. */
  toolCancelled?: boolean;
  hostVersion: string;
  /** Display modes this instance can actually switch to; both by default. Changes are notified to the page via host-context-changed. */
  availableDisplayModes?: readonly McpAppsDisplayMode[];
  onDisplayModeRequest?: (mode: McpAppsDisplayMode) => McpAppsDisplayMode;
  onOpenExternal?: (url: string) => void;
  /** Container width, used for hostContext.containerDimensions; 0 when unknown. */
  width: number;
  /** Header for the fullscreen container; omitted for inline. */
  titleBar?: McpAppsHostTitleBar;
  /** When false, no sandbox is created (e.g. the side pane already owns the same scope); defaults to true. */
  enabled?: boolean;
  /** Session interaction callbacks: when absent, the corresponding requests return -32601 and the capability is not declared. */
  interactions?: Pick<PluginUiHostControllerDeps, "onSendFollowUpMessage" | "onUpdateModelContext">;
}

export interface UsePluginUiHostResult {
  /** False when the platform or service does not support plugin UI; the caller falls back to a plain MCP card. */
  pageKey: string;
  supported: boolean;
  phase: PluginUiHostPhase;
  handle: PluginSandboxHandle | null;
  height: number;
  error: string | null;
  /** Capabilities declared by the page's `ui/initialize`; undefined before the handshake, at least {} after. Both display placement and mode requests are bound by it. */
  appCapabilities: McpUiAppCapabilities | undefined;
  /** Destroys the current instance and re-prepares (Agent run credentials rotated); triggered by the error-state button after a guest crash / load failure. */
  reload(): void;
}

export interface Page {
  readonly kind: "mcp";
  key: string;
  task: string;
  visible: boolean;
  snapshot(): UsePluginUiHostResult;
  subscribe(listener: () => void): () => void;
  start(): void;
  update(input: UsePluginUiHostInput): void;
  updateToolFeed(
    input: Pick<UsePluginUiHostInput, "toolCallId" | "toolInput" | "toolResult" | "toolCancelled">,
  ): void;
  bind(node: HTMLElement, sidebar: boolean): () => void;
  busy(): boolean;
  running(): boolean;
  suspend(force?: boolean): Promise<boolean>;
  destroy(): void;
}
