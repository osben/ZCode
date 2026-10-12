/**
 * MCP Apps protocol contract: constants, tool UI metadata types, sandbox handles, and registration payloads shared by
 * agent, host, renderer, and main.
 * The page ↔ host wire protocol (`ui/*` methods, handshake, version negotiation, JSON-RPC) is defined by the official
 * `@modelcontextprotocol/ext-apps`; this file keeps only ZCode's own extension keys and limits. Types and constants
 * only; normalization and schemas live in other files in this directory and are exported via index.ts.
 */

/** MCP extension identifier (spec "Extension Identifier"); identical to the official SDK's `EXTENSION_ID`. */
export const MCP_APPS_EXTENSION_ID = "io.modelcontextprotocol/ui";
/** UI resource mimeType (spec MUST); identical to the official SDK's `RESOURCE_MIME_TYPE`. */
export const MCP_APPS_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
/** Deprecated flat key `_meta["ui/resourceUri"]`; the spec requires hosts to stay MUST-compatible with it. Identical to the official SDK's `RESOURCE_URI_META_KEY`. */
export const MCP_APPS_LEGACY_RESOURCE_URI_META_KEY = "ui/resourceUri";

/**
 * UI extension capability declaration inside the MCP client `initialize` (spec "Client (Host) Capabilities").
 * A type rather than an interface: the MCP SDK's `ClientCapabilities.extensions` requires values to carry a string
 * index signature.
 */
export type McpAppsClientCapability = { mimeTypes: string[] };
/** The capability fragment the agent declares per MCP server; goes into the `Client` constructor's `capabilities.extensions`. */
export function buildMcpAppsClientCapabilities(): {
  extensions: { [extensionId: string]: McpAppsClientCapability };
} {
  return { extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_RESOURCE_MIME_TYPE] } } };
}

/** Host hostInfo.name; hostInfo.version is only for the page's feature detection and is unrelated to the app version. */
export const MCP_APPS_HOST_NAME = "zcode";
export const MCP_APPS_HOST_VERSION = "1";
/** `ui/initialize` handshake timeout (counted from port arrival) and the wait cap for `ui/resource-teardown` before unload. */
export const MCP_APPS_HANDSHAKE_TIMEOUT_MS = 15_000;
export const MCP_APPS_TEARDOWN_TIMEOUT_MS = 500;

export type McpAppsDisplayMode = "inline" | "fullscreen" | "pip";
export type McpAppsToolVisibility = "model" | "app";
export const MCP_APPS_DEFAULT_TOOL_VISIBILITY: readonly McpAppsToolVisibility[] = ["model", "app"];

/** MCP Apps resource-level CSP (`McpUiResourceCsp`): four domain classes. The resource's `_meta` is primary; tool-level `_meta.ui.csp` only fills in when the resource declares none. */
export interface McpToolUiCsp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/**
 * Resource-level `_meta["zcode/csp"]`: the host defaults to the spec block (only 'self' 'unsafe-inline') and does not
 * allow `'unsafe-eval'` / `'wasm-unsafe-eval'`; resources needing eval / WebAssembly declare it here explicitly. The
 * host announces the supported keys via `hostCapabilities.experimental["zcode/csp"].flags`.
 */
export const MCP_APPS_CSP_RELAXATION_META_KEY = "zcode/csp";
export const MCP_APPS_CSP_RELAXATION_FLAGS = ["unsafeEval", "wasmUnsafeEval"] as const;
export type McpAppCspRelaxationFlag = (typeof MCP_APPS_CSP_RELAXATION_FLAGS)[number];
export type McpAppCspRelaxations = Partial<Record<McpAppCspRelaxationFlag, boolean>>;
export function buildMcpAppsCspExperimentalCapability(): {
  [MCP_APPS_CSP_RELAXATION_META_KEY]: { flags: McpAppCspRelaxationFlag[] };
} {
  return { [MCP_APPS_CSP_RELAXATION_META_KEY]: { flags: [...MCP_APPS_CSP_RELAXATION_FLAGS] } };
}

/**
 * Browser permissions a resource can declare (the four keys of the spec draft's `UIResourceMeta.permissions`); the
 * order is the normalization order.
 * Host: undeclared ones are always denied; camera / microphone / geolocation get a native confirmation dialog on
 * first use; clipboardWrite is allowed per declaration.
 */
export const MCP_APPS_RESOURCE_PERMISSIONS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
] as const;
export type McpAppsResourcePermission = (typeof MCP_APPS_RESOURCE_PERMISSIONS)[number];
/** Spec permission key → Permissions Policy feature name for the plugin iframe's `allow`. */
export const MCP_APPS_IFRAME_ALLOW_TOKENS: Record<McpAppsResourcePermission, string> = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
};
/** Same shape as the official SDK's `buildAllowAttribute`: `"camera; clipboard-write"`; returns an empty string when nothing is declared. */
export function buildMcpAppsIframeAllow(
  permissions: readonly McpAppsResourcePermission[] | undefined,
): string {
  if (!permissions?.length) return "";
  return MCP_APPS_RESOURCE_PERMISSIONS.filter((key) => permissions.includes(key))
    .map((key) => MCP_APPS_IFRAME_ALLOW_TOKENS[key])
    .join("; ");
}

/**
 * The `ui://` HTML resource's own `_meta` (`resources/read` content items take precedence). `heightHint` /
 * `minFrameHeight` are the initial and minimum heights (px); `showInline: true` forces the card to stay permanently
 * visible instead of going into the collapsed area.
 */
export interface McpAppResourceMeta {
  csp?: McpToolUiCsp;
  cspRelaxations?: McpAppCspRelaxations;
  /** Browser permissions declared by `_meta.ui.permissions` (the spec's four keys; fixed order, deduplicated). */
  permissions?: McpAppsResourcePermission[];
  prefersBorder?: boolean;
  heightHint?: number;
  minFrameHeight?: number;
  showInline?: boolean;
}
/** Resource-level presentation info carried back to the renderer with the sandbox handle; CSP and relaxations only take effect in main and are not returned. */
export type PluginSandboxResourceMeta = Omit<McpAppResourceMeta, "csp" | "cspRelaxations">;
/** UI descriptor produced by normalizing a tool's `_meta`; if `resourceUri` is invalid the whole descriptor is absent. */
export interface McpToolUiDescriptor {
  resourceUri: string;
  visibility?: McpAppsToolVisibility[];
  preferredDisplayMode?: McpAppsDisplayMode;
  csp?: McpToolUiCsp;
  prefersBorder?: boolean;
  /** The panel id the tool result belongs to (manifest `ui.surfaces[].id`). */
  surface?: string;
  /** Tool-level `openai/widgetShowCodexWidgetInline`, forcing the card to stay permanently visible. */
  showInline?: boolean;
}

/** Length and charset of `_meta.ui.surface` / manifest surface ids (same source as sandboxId: must be usable in a CSP host-source). */
export const MCP_APPS_SURFACE_ID_MAX_CHARS = 128;
export const MCP_APPS_SURFACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export const MCP_APPS_UI_RESOURCE_SCHEME = "ui://";
export const MCP_APPS_RESOURCE_URI_MAX_CHARS = 2048;
/**
 * Persistence caps for `display.ui.structuredContent` / `widgetMeta` / `content` (UTF-8 bytes of the JSON text).
 * Over-limit strings are not truncated (half a JSON is meaningless): the field is omitted entirely, `truncated: true`
 * and `truncatedBytes` record the dropped byte count; the page side sees `toolOutput` as null and
 * `toolResponseMetadata["zcode/truncated"] = { bytes }`, and can re-fetch with tools/call.
 */
export const MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES = 64 * 1024;
export const MCP_APPS_WIDGET_META_MAX_BYTES = 16 * 1024;
export const MCP_APPS_CONTENT_MAX_BYTES = 32 * 1024;
export const MCP_APPS_TRUNCATED_META_KEY = "zcode/truncated";
/** The `ui://` HTML cap accepted on the host side and the mimeType allowlist (the spec only recognizes the profiled one; plain text/html without a profile is a deliberate lenient superset). */
// The official pdf-server example's single-file page (inlined pdf.js) is already 4.3 MB; 4 MiB would reject it, so
// this is 16 MiB.
export const MCP_APPS_HTML_MAX_BYTES = 16 * 1024 * 1024;
export const MCP_APPS_HTML_MIME_TYPES = [MCP_APPS_RESOURCE_MIME_TYPE, "text/html"] as const;
/**
 * Image blocks the page sends via ui/update-model-context and ui/message: three bitmap types on the allowlist, each
 * ≤ 4 MiB after decode;
 * anything off the allowlist or over the cap rejects the whole request with -32602 `unsupported_content`.
 */
export const MCP_APPS_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MCP_APPS_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export {
  MCP_APPS_UI_READ_RESOURCE_MAX_BYTES,
  MCP_APPS_UI_READ_RESOURCE_MIME_ALLOWLIST,
  isMcpAppsUiReadResourceMimeAllowed,
} from "./resourceMime.js";

/**
 * ZCode extension keys inside `hostCapabilities.experimental`. The official SDK's zod strips unknown capability keys
 * beyond the standard ones, so extensions always go into experimental (the spec's reserved slot) and the page does
 * feature detection by key.
 */
export const MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY = "zcode/widgetState";
export const MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY = "zcode/resourceSubscribe";
export const MCP_APPS_SURFACE_EXPERIMENTAL_KEY = "zcode/surface";
/**
 * ZCode extension method `ui/set-widget-state { widgetState }` (MCP Apps has no widgetState): the page hands UI state
 * to the host renderer's memory (not persisted; recoverable on remount within the session); the initial value travels
 * to the page at handshake via the hostContext's `zcode/widgetState` key.
 */
export const MCP_APPS_SET_WIDGET_STATE_METHOD = "ui/set-widget-state";
export const MCP_APPS_WIDGET_STATE_CONTEXT_KEY = "zcode/widgetState";

/** The name of the single MessageChannel between host renderer ↔ relay shell; raw JSON-RPC runs on it (official AppBridge / App). */
export const PLUGIN_SANDBOX_PORT_NAME = "plugin-sandbox-rpc";

/** Minimal structural type of a MessagePort; the host renderer's Transport and the relay shell both depend only on these members. */
export interface PluginSandboxTransportPort {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  start?(): void;
  close(): void;
}

/** Port event from main → host renderer (transferred via preload `window.postMessage`). */
export interface PluginSandboxPortsEvent {
  sandboxId: string;
  initId: number;
  port: PluginSandboxTransportPort;
}
/**
 * The sandbox platform port available to the renderer, mounted as the optional `IPlatformService.pluginSandbox`
 * field; undefined on web, and the UI falls back accordingly.
 * Sandbox registration does not happen here: the host does it via parentPort, and the renderer only receives handles.
 */
export interface PluginSandboxPlatformPort {
  /** preload has installed the restricted sandbox atomic-move adapter. */
  supportsRetainedMove?: boolean;
  /** Host operations only; main validates owner/generation and then copies the current page content. */
  copyImage?(input: PluginSandboxCaptureRequest): Promise<void>;
  /** The host window's webContents id; prepareSandbox uses it as owner and main validates it at will-attach. */
  getOwnerWebContentsId(): Promise<number>;
  /**
   * Releases the sandbox. With initId, only the captured registration is released: a new page uses new Agent
   * credentials and a new sandboxId, the two IPC paths differ (host parentPort vs ipcMain), so a late old dispose
   * must not kill the new registration by mistake.
   */
  disposeSandbox(sandboxId: string, initId?: number): Promise<void>;
  consumeUserGesture(sandboxId: string): Promise<boolean>;
  onPorts(handler: (event: PluginSandboxPortsEvent) => void): () => void;
}

export interface PluginSandboxCaptureRequest {
  sandboxId: string;
  initId: number;
  captureRect: { x: number; y: number; width: number; height: number };
  viewportSize: { width: number; height: number };
}

/**
 * Sandbox scope. Tool cards are scoped by toolCallId, panels (manifest `ui.surfaces[]`) by surfaceId;
 * both map to a string scopeId used in the registry's idempotency key and widgetState routing, so main / host never
 * need to know about "panels".
 */
export type PluginUiScopeRef =
  | { kind: "toolCall"; toolCallId: string }
  | { kind: "surface"; surfaceId: string };
export function buildPluginSandboxScopeId(scope: PluginUiScopeRef): string {
  return scope.kind === "toolCall" ? `tool:${scope.toolCallId}` : `surface:${scope.surfaceId}`;
}

/** Message payload for host → main registering sandbox content (same pattern as LocalMediaPreviewPathAuthorize*). */
export interface PluginSandboxRegisterRequestPayload {
  instance: import("./instance.js").McpAppInstance;
  requestId: string;
  /** Workspace isolation; legacy callers may omit it, new host registrations must carry the actual workspace scope. */
  workspacePath?: string;
  workspaceIdentity?: string;
  ownerWebContentsId: number;
  sessionId: string;
  /** Gen UI has Host provenance and never impersonates an MCP plugin. */
  contentKind?: "gen-ui";
  pluginId?: string;
  /** The MCP server runtime name the resource belongs to; the sandbox partition derives from it (pages of the same server share one persistent store). */
  serverName?: string;
  /** The result of `buildPluginSandboxScopeId`: `tool:<toolCallId>` or `surface:<surfaceId>`. */
  scopeId: string;
  html: string;
  /** Effective CSP: resource-level first, tool-level fallback (already merged by the host plugin-ui-bridge). */
  csp?: McpToolUiCsp;
  /** Relaxations declared by the resource-level `_meta["zcode/csp"]`. */
  cspRelaxations?: McpAppCspRelaxations;
  /** Browser permissions the resource declares; main relaxes Permissions-Policy and iframe allow accordingly and routes permission requests to the gate. */
  permissions?: McpAppsResourcePermission[];
  prefersBorder?: boolean;
  /** Resource-level size hints, passed verbatim into the handle back to the renderer. */
  heightHint?: number;
  minFrameHeight?: number;
  /** Resource-level stay-visible flag, returned to the renderer with the handle's resourceMeta. */
  showInline?: boolean;
}
/** Registration input used inside the host: drops the transport-layer requestId. */
export type PluginSandboxRegisterInput = Omit<PluginSandboxRegisterRequestPayload, "requestId">;
export interface PluginSandboxHandle {
  instance: import("./instance.js").McpAppInstance;
  sandboxId: string;
  initId: number;
  shellUrl: string;
  partition: string;
  /** Resource-level presentation info (prefersBorder / heightHint / minFrameHeight / showInline); omitted when the resource declares none. */
  resourceMeta?: PluginSandboxResourceMeta;
}
export type PluginSandboxRegisterResultPayload =
  | ({ requestId: string; ok: true } & PluginSandboxHandle)
  | { requestId: string; ok: false; error: string };
