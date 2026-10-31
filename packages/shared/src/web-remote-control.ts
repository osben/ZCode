import { z } from "zod";
import type { MobileSessionCreateTelemetry } from "./sessionCreateTelemetry.js";
import type { MobilePluginDiscoveryTelemetry } from "./telemetry.js";
/* eslint-disable max-lines -- the web remote-control shared protocol holds the app payload and workspace bridge contracts; split by transport when it is broken up later. */
import type { WebRemoteControlRelayV2PairStatus } from "./web-remote-relay/index.js";
import type { DockerContainerInfo, SSHConfigAliasOption, WSLDistro } from "./platform.js";
import type {
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  EditorInfo,
  OpenInEditorOptions,
} from "./platform.js";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { SessionWorkflowActivity } from "./zcode-protocol-v4/sessions-index-workflow-activity.js";
import type { WebRemoteControlRpcTransportPayload } from "./web-remote-control-rpc-transport.js";
import type { WebRemoteControlMobileLogAppPayload } from "#src/web-remote-relay/index.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";
import type { WebRemoteControlActionPayload } from "#src/web-remote-relay/index.js";

export const WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS = 120_000;
export const WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS = 5_000;

export type WebRemoteControlThemeSeed = "light" | "dark" | "zai-light" | "zai-dark" | "system";

export interface WebRemoteControlContext {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlThemeSeed;
}

/** Renderer only notifies that the session changed; main must re-read local credentials. */
export const webRemoteControlAuthStateChangeSchema = z
  .object({
    state: z.enum(["signed-in", "signed-out"]),
  })
  .strict();
export type WebRemoteControlAuthStateChange = z.infer<typeof webRemoteControlAuthStateChangeSchema>;

export type WebRemoteControlStatusKind =
  | "auth-required"
  | "idle"
  | "starting"
  | "running"
  | "connecting"
  | "active"
  | "error";

export type WebRemoteControlFailureReason =
  | "device-not-owned"
  | "auth-required"
  | "session-not-found"
  | "session-expired"
  | "session-conflict"
  | "workspace-closed"
  | "desktop-disconnected"
  | "invalid-mobile-connection"
  | "desktop-bootstrap-timeout"
  | "connection-recovery-timeout"
  | "relay-unavailable"
  | "unsupported-action"
  | "unexpected-error";

export interface WebRemoteControlFailure {
  reason: WebRemoteControlFailureReason;
  message?: string;
}

export function createWebRemoteControlConnectionRecoveryTimeoutFailure(
  message: string,
): WebRemoteControlFailure {
  return {
    // Bugfix: recovery timing out after the phone was backgrounded for a long time means the
    // phone's connection was not recovered; it must not be mapped to desktop-disconnected,
    // otherwise the error page misleads the user into thinking the desktop is offline.
    reason: "connection-recovery-timeout",
    message,
  };
}

export interface WebRemoteControlRelayDeviceMeta {
  platform: string;
  version: string;
  name: string;
}

export interface WebRemoteControlMobileViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface WebRemoteControlMobileScreenInfo {
  width: number;
  height: number;
}

export interface WebRemoteControlMobileDeviceInfo extends WebRemoteControlRelayDeviceMeta {
  userAgent?: string;
  language?: string;
  languages?: string[];
  browserPlatform?: string;
  viewport?: WebRemoteControlMobileViewportInfo;
  screen?: WebRemoteControlMobileScreenInfo;
  timezone?: string;
  online?: boolean;
  updatedAt: number;
}

/** Relay V2 QR routing hints. They never carry a credential; `hash` and `t` are rejected on parse. */
export interface WebRemoteControlV2QrParams {
  deviceSid?: string;
  deviceMid?: string;
  deviceName?: string;
  appVersion?: string;
  /**
   * Fork device-key relay mode only: single-use pairing code (`pk`) the phone exchanges for a relay
   * session. Absent in zai-jwt mode, which keeps the QR byte-identical to upstream.
   */
  pairingCode?: string;
}

export type BuildWebRemoteControlExternalQrUrlOptions = WebRemoteControlV2QrParams & {
  baseUrl: string;
};

function readNonEmptySearchParam(
  params: URLSearchParams | undefined,
  name: string,
): string | undefined {
  const value = params?.get(name)?.trim();
  return value ? value : undefined;
}

export function isWebRemoteControlThemeSeed(value: unknown): value is WebRemoteControlThemeSeed {
  return (
    value === "light" ||
    value === "dark" ||
    value === "zai-light" ||
    value === "zai-dark" ||
    value === "system"
  );
}

export function resolveWebRemoteControlRoutePathFromBaseUrl(baseUrl: string): string {
  const rawBaseUrl = baseUrl.trim() || "/";
  let pathname = "/";

  try {
    pathname = new URL(rawBaseUrl, "https://zcode.invalid").pathname;
  } catch {
    pathname = rawBaseUrl.startsWith("/") ? rawBaseUrl : `/${rawBaseUrl}`;
  }

  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPathname === "/") {
    return "/remote";
  }
  return normalizedPathname;
}

export function matchesWebRemoteControlRoutePath(pathname: string, routePath: string): boolean {
  // Bugfix: dev / production entry paths may carry a trailing /remote/ slash;
  // route matching must accept both /remote and /remote/, but must not treat /remote/favicon.ico
  // as the app entry.
  const normalizeRoutePath = (value: string) => value.replace(/\/+$/, "") || "/";
  return normalizeRoutePath(pathname) === normalizeRoutePath(routePath);
}

export function buildWebRemoteControlExternalQrUrl({
  baseUrl,
  deviceSid,
  deviceMid,
  deviceName,
  appVersion,
  pairingCode,
}: BuildWebRemoteControlExternalQrUrlOptions): string {
  const url = new URL(baseUrl);
  if (deviceSid !== undefined) url.searchParams.set("sid", deviceSid);
  // Legacy credentials may only be removed; they must never be carried into a new QR code from the base URL.
  url.searchParams.delete("hash");
  url.searchParams.delete("t");

  if (deviceMid?.trim()) {
    url.searchParams.set("mid", deviceMid);
  }
  if (deviceName?.trim()) {
    url.searchParams.set("name", deviceName);
  }
  if (appVersion?.trim()) {
    url.searchParams.set("app_version", appVersion);
  }
  // The pairing code is a credential: it travels in the fragment, which browsers never send to the web host,
  // so it cannot reach access logs. A `pk` already in the base URL's query is dropped for the same reason.
  url.searchParams.delete("pk");
  if (pairingCode?.trim()) {
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    fragment.set("pk", pairingCode.trim());
    url.hash = fragment.toString();
  }
  return url.toString();
}

/** Parses V2 routing hints only. Links carrying the V1 `hash` or `t` credential are rejected. */
export function parseWebRemoteControlExternalQrParams(
  params: URLSearchParams,
  /** Parsed URL fragment. `pk` is read from here first and from the query second (QRs from older Desktops). */
  fragmentParams?: URLSearchParams,
): WebRemoteControlV2QrParams | null {
  if (params.has("hash") || params.has("t")) return null;
  const result: WebRemoteControlV2QrParams = {};
  for (const [key, param] of [
    ["deviceSid", "sid"],
    ["deviceMid", "mid"],
    ["deviceName", "name"],
    ["appVersion", "app_version"],
    ["pairingCode", "pk"],
  ] as const) {
    const value =
      (key === "pairingCode" ? readNonEmptySearchParam(fragmentParams, param) : undefined) ??
      readNonEmptySearchParam(params, param);
    if (value) result[key] = value;
  }
  return result;
}

export type WebRemoteControlTokenKind = "window-pairing";

export type WebRemoteControlWindowFailureReason = WebRemoteControlFailureReason;

export const WebRemoteControlCloseCodes = {
  SessionNotFound: 4004,
  SessionConflict: 4009,
  DesktopDisconnected: 4010,
  SessionExpired: 4011,
  WorkspaceClosed: 4012,
  InvalidMobileConnection: 4013,
} as const;

export function resolveWebRemoteControlFailureReasonFromCloseCode(
  code: number,
): WebRemoteControlFailureReason | null {
  switch (code) {
    case WebRemoteControlCloseCodes.SessionNotFound:
      return "session-not-found";
    case WebRemoteControlCloseCodes.SessionConflict:
      return "session-conflict";
    case WebRemoteControlCloseCodes.DesktopDisconnected:
      return "desktop-disconnected";
    case WebRemoteControlCloseCodes.SessionExpired:
      return "session-expired";
    case WebRemoteControlCloseCodes.WorkspaceClosed:
      return "workspace-closed";
    case WebRemoteControlCloseCodes.InvalidMobileConnection:
      return "invalid-mobile-connection";
    default:
      return null;
  }
}

export interface WebRemoteControlStartResult {
  status: Extract<WebRemoteControlStatusKind, "running" | "connecting" | "active">;
  sessionId: string;
  windowControlSessionId?: string;
  deviceToken?: string;
  tokenKind?: WebRemoteControlTokenKind;
  expiresAt?: number;
  qrUrl: string;
  connectUrl: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlStartCancelledResult {
  status: "cancelled";
}

/** Compat with platform implementations that can still return the cancelled terminal state; the current Desktop start and refresh paths never produce it. */
export type WebRemoteControlStartOperationResult =
  | WebRemoteControlStartResult
  | WebRemoteControlStartCancelledResult;

export interface WebRemoteControlStatus {
  status: WebRemoteControlStatusKind;
  sessionId?: string;
  windowControlSessionId?: string;
  deviceToken?: string;
  tokenKind?: WebRemoteControlTokenKind;
  expiresAt?: number;
  mobileConnected?: boolean;
  mobileViewState?: WebRemoteControlMobileViewState;
  /** Transient visible task validated by Main; remoteSessionId is injected only by the owning bridge, never self-reported by the Web client. */
  mobileTaskView?: WebRemoteControlMobileTaskView | null;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  qrUrl?: string;
  connectUrl?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  error?: string;
  failure?: WebRemoteControlFailure;
  /** Pre-V2 pairing was discarded for this run; every phone must scan the new QR code to pair again. */
  repairRequired?: boolean;
}

export interface WebRemoteControlSessionCreateRequest {
  tunnelId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlSessionCreateResponse extends WebRemoteControlStartResult {
  token: string;
}

export interface WebRemoteControlWindowSession {
  windowControlSessionId: string;
  deviceToken: string;
  tokenKind: WebRemoteControlTokenKind;
  connectUrl: string;
  qrUrl: string;
  expiresAt: number;
  status: "idle" | "starting" | "running" | "active" | "error";
}

export interface WebRemoteControlBootstrapResult {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  wsUrl: string;
}

export interface WebRemoteControlBootstrapErrorResponse {
  error: string;
  reason: WebRemoteControlFailureReason;
}

/** Arguments for the proxied openInEditor call; mirrors IPlatformService.openInEditor(editorId, path, options?). */
export interface WebRemoteControlOpenInEditorArgs {
  editorId: string;
  path: string;
  options?: OpenInEditorOptions;
}

export interface WebRemoteControlPlatformMethodArgsMap {
  isDockerAvailable: undefined;
  listWSLDistros: undefined;
  listDockerContainers: undefined;
  listSSHConfigAliases: undefined;
  createTempTextAttachment: CreateTempTextAttachmentRequest;
  loadMcpFromUserDirectory: LoadCliMcpFromUserDirectoryRequest | undefined;
  saveMcpToUserDirectory: SaveCliMcpToUserDirectoryRequest;
  migrateLegacyCommonMcp: MigrateLegacyCommonMcpRequest | undefined;
  getInstalledEditors: undefined;
  openInEditor: WebRemoteControlOpenInEditorArgs;
  openInFileManager: string;
  openExternalFile: string;
}

export interface WebRemoteControlPlatformMethodResultMap {
  isDockerAvailable: boolean;
  listWSLDistros: WSLDistro[];
  listDockerContainers: DockerContainerInfo[];
  listSSHConfigAliases: SSHConfigAliasOption[];
  createTempTextAttachment: CreateTempTextAttachmentResult;
  loadMcpFromUserDirectory: LoadCliMcpFromUserDirectoryResult;
  saveMcpToUserDirectory: { success: boolean; error?: string };
  migrateLegacyCommonMcp: MigrateLegacyCommonMcpResult;
  getInstalledEditors: EditorInfo[];
  openInEditor: { success: boolean; error?: string };
  openInFileManager: { success: boolean; error?: string };
  openExternalFile: { success: boolean; error?: string };
}

export type WebRemoteControlPlatformMethod = keyof WebRemoteControlPlatformMethodResultMap;

export type WebRemoteControlPlatformRequest = {
  [K in WebRemoteControlPlatformMethod]: {
    type: "platform-request";
    requestId: string;
    method: K;
    args?: WebRemoteControlPlatformMethodArgsMap[K];
  };
}[WebRemoteControlPlatformMethod];

export type WebRemoteControlPlatformSuccessResponse = {
  [K in WebRemoteControlPlatformMethod]: {
    type: "platform-response";
    requestId: string;
    method: K;
    success: true;
    result: WebRemoteControlPlatformMethodResultMap[K];
  };
}[WebRemoteControlPlatformMethod];

export interface WebRemoteControlPlatformErrorResponse {
  type: "platform-response";
  requestId: string;
  method: WebRemoteControlPlatformMethod;
  success: false;
  error: string;
}

export type WebRemoteControlPlatformResponse =
  | WebRemoteControlPlatformSuccessResponse
  | WebRemoteControlPlatformErrorResponse;

export interface WebRemoteControlExternalLocalWorkspaceBridge {
  terminalOwnerId?: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  kind: "local";
  workspaceKey: string;
  workspacePath: string;
  initialTaskId?: string;
}

export interface WebRemoteControlExternalRemoteWorkspaceBridge {
  terminalOwnerId?: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  kind: "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  initialTaskId?: string;
  /** Older desktops do not declare this; the client must not infer capabilities from a lazy RPC proxy. */
  capabilities?: { windowProjectDirectory?: true };
}

export type WebRemoteControlExternalWorkspaceBridge =
  | WebRemoteControlExternalLocalWorkspaceBridge
  | WebRemoteControlExternalRemoteWorkspaceBridge;

export interface WebRemoteControlBootstrapRequestPayload {
  terminalClientSessionId?: string;
  zcode_type: "bootstrap-request";
  requestId: string;
}

export interface WebRemoteControlBootstrapResponsePayload {
  zcode_type: "bootstrap-response";
  requestId: string;
  success: true;
  result: WebRemoteControlWindowBootstrapResult;
}

export interface WebRemoteControlWorkspaceListRequestPayload {
  zcode_type: "workspace-list-request";
  requestId: string;
}

export interface WebRemoteControlWorkspaceListResponsePayload {
  zcode_type: "workspace-list-response";
  requestId: string;
  success: true;
  result: WebRemoteControlWorkspaceListResult;
}

export interface WebRemoteControlWorkspaceListUpdatedPayload {
  zcode_type: "workspace-list-updated";
  result: WebRemoteControlWorkspaceListResult;
}

export interface WebRemoteControlWorkspaceBridgeOpenPayload {
  terminalClientSessionId?: string;
  zcode_type: "workspace-bridge-open";
  requestId: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  workspaceKey: string;
  taskId?: string;
  project?: { projectId: string | null; hostId?: string; draftId?: string; reuseDraft?: boolean };
  taskHostId?: string;
  /** Resolves the task directory for the file tree only; it neither selects a task nor marks it read. */
  fileTreeTaskId?: string;
}

export interface WebRemoteControlWorkspaceBridgeReadyPayload {
  zcode_type: "workspace-bridge-ready";
  requestId: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  bridge: WebRemoteControlExternalWorkspaceBridge;
}

export interface WebRemoteControlWorkspaceBridgeErrorPayload {
  zcode_type: "workspace-bridge-error";
  requestId: string;
  bridgeSessionId?: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  reason: WebRemoteControlFailureReason;
  error: string;
}

export interface WebRemoteControlWorkspaceReconnectRequestPayload {
  zcode_type: "workspace-reconnect-request";
  requestId: string;
  workspaceKey: string;
}

export type WebRemoteControlWorkspaceReconnectResponsePayload =
  | {
      zcode_type: "workspace-reconnect-response";
      requestId: string;
      workspaceKey: string;
      success: true;
    }
  | {
      zcode_type: "workspace-reconnect-response";
      requestId: string;
      workspaceKey: string;
      success: false;
      error: string;
    };

/** Mobile/Web asks the desktop to open (or reuse) a local workspace; success only means Main dispatched the open to the window renderer. */
export interface WebRemoteControlWorkspaceOpenRequestPayload {
  zcode_type: "workspace-open-request";
  requestId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export type WebRemoteControlWorkspaceOpenResponsePayload =
  | {
      zcode_type: "workspace-open-response";
      requestId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      success: true;
    }
  | {
      zcode_type: "workspace-open-response";
      requestId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      success: false;
      error: string;
    };

export interface WebRemoteControlMobileViewStatePayload {
  zcode_type: "mobile-view-state-update";
  viewState: WebRemoteControlMobileViewState;
  deviceInfo?: WebRemoteControlMobileDeviceInfo;
}

/** Desktop-to-phone task view snapshot; `epoch` scopes it to one phone view, `seq` orders updates within it. */
export interface WebRemoteControlMobileTaskViewUpdatePayload {
  zcode_type: "mobile-task-view-update";
  epoch: string;
  seq: number;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  view: WebRemoteControlMobileTaskView | null;
}

/** Phone-to-desktop request for the current task view of one epoch. */
export interface WebRemoteControlMobileTaskViewRequestPayload {
  zcode_type: "mobile-task-view-request";
  epoch: string;
}

export type WebRemoteControlPlatformRequestPayload = {
  [K in WebRemoteControlPlatformMethod]: {
    zcode_type: "platform-request";
    requestId: string;
    method: K;
    args?: WebRemoteControlPlatformMethodArgsMap[K];
  };
}[WebRemoteControlPlatformMethod];

export type WebRemoteControlPlatformResponsePayload =
  | {
      [K in WebRemoteControlPlatformMethod]: {
        zcode_type: "platform-response";
        requestId: string;
        method: K;
        success: true;
        result: WebRemoteControlPlatformMethodResultMap[K];
      };
    }[WebRemoteControlPlatformMethod]
  | {
      zcode_type: "platform-response";
      requestId: string;
      method: WebRemoteControlPlatformMethod;
      success: false;
      error: string;
    };

/** @deprecated Only for legacy adapter unit tests/migration; the production parser has rejected it since 04D-3. */
export interface WebRemoteControlRpcFramePayload {
  zcode_type: "rpc-frame";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  seq: number;
  dataBase64: string;
}

export interface WebRemoteControlBridgeDegradedPayload {
  zcode_type: "bridge-degraded";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  reason:
    | "rpc-transport-fault"
    | "rpc-frame-gap"
    | "buffer-overflow"
    | "buffer-timeout"
    | "source-session-replaced"
    | "terminal-owner-ended";
  seq?: number;
  expectedSeq?: number;
  droppedCount?: number;
}

export interface WebRemoteControlAppErrorPayload {
  zcode_type: "app-error";
  requestId?: string;
  bridgeSessionId?: string;
  reason: WebRemoteControlFailureReason;
  error: string;
}

export type WebRemoteControlMobileDiagnosticEvent =
  | "state-transition"
  | "socket-close"
  | "socket-error"
  | "recover-start"
  | "recover-scheduled"
  | "pair-status"
  | "failure";

export interface WebRemoteControlMobileDiagnosticPayload {
  zcode_type: "mobile-diagnostic";
  event: WebRemoteControlMobileDiagnosticEvent;
  timestamp: number;
  state?: string;
  previousState?: string;
  pairStatus?: WebRemoteControlRelayV2PairStatus;
  closeCode?: number;
  closeReason?: string;
  wasClean?: boolean;
  wasPaired?: boolean;
  failureReason?: WebRemoteControlFailureReason;
  failureMessage?: string;
  visibilityState?: string;
  online?: boolean;
  hiddenDurationMs?: number;
}

export type WebRemoteControlAppPayload =
  | {
      zcode_type: "telemetry-report";
      event: MobileSessionCreateTelemetry | MobilePluginDiscoveryTelemetry;
    }
  | WebRemoteControlBootstrapRequestPayload
  | WebRemoteControlBootstrapResponsePayload
  | WebRemoteControlWorkspaceListRequestPayload
  | WebRemoteControlWorkspaceListResponsePayload
  | WebRemoteControlWorkspaceListUpdatedPayload
  | WebRemoteControlWorkspaceBridgeOpenPayload
  | WebRemoteControlWorkspaceBridgeReadyPayload
  | WebRemoteControlWorkspaceBridgeErrorPayload
  | WebRemoteControlWorkspaceReconnectRequestPayload
  | WebRemoteControlWorkspaceReconnectResponsePayload
  | WebRemoteControlWorkspaceOpenRequestPayload
  | WebRemoteControlWorkspaceOpenResponsePayload
  | WebRemoteControlMobileViewStatePayload
  | WebRemoteControlMobileTaskViewUpdatePayload
  | WebRemoteControlMobileTaskViewRequestPayload
  | WebRemoteControlPlatformRequestPayload
  | WebRemoteControlPlatformResponsePayload
  | WebRemoteControlRpcTransportPayload
  | WebRemoteControlBridgeDegradedPayload
  | WebRemoteControlAppErrorPayload
  | WebRemoteControlMobileDiagnosticPayload
  | WebRemoteControlActionPayload
  | WebRemoteControlMobileLogAppPayload;

/** Task the mobile client is viewing. Plain shape only; the relay payloads that carry it are not part of this module's transport. */
export interface WebRemoteControlMobileTaskView {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** Set only by the owning bridge; the Web client never supplies it. */
  remoteSessionId?: string;
}

export interface WebRemoteControlWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  label: string;
  workspacePurpose?: WorkspacePurpose;
  kind: "local" | "remote";
  connectionState?: "connected" | "disconnected" | "reconnecting";
  lastConnectionError?: string;
}

export interface WebRemoteControlReconnectWorkspaceRequest {
  requestId: string;
  workspaceKey: string;
}

export type WebRemoteControlReconnectWorkspaceResult =
  | {
      requestId: string;
      workspaceKey: string;
      success: true;
    }
  | {
      requestId: string;
      workspaceKey: string;
      success: false;
      error: string;
    };

export type WebRemoteControlTaskDisplayStatus = "idle" | "running" | "completed" | "error";

export interface WebRemoteControlTaskTarget {
  taskId: string;
  hostId?: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workspaceLabel: string;
  workspaceKind: "local" | "remote";
  createdAt: number;
  updatedAt: number;
  provider?: ZCodeProvider;
  unreadAt?: number;
  displayStatus?: WebRemoteControlTaskDisplayStatus;
  // The session has background work attached (dynamic workflow run / background bash / detached
  // subagent). Participates only in list run-level ordering,
  // not the displayStatus icon; absent is treated as false, and older desktop snapshots parse as
  // usual.
  hasBackgroundWork?: boolean;
  // Workflow run summary (docs/dynamic-workflow/presentation.md, "The sidebar run line"): the
  // phone row draws the same run line as the desktop under the title.
  // Draw-only; it does not participate in sorting or the status pill; absent when there is no run,
  // and older desktop snapshots parse as usual.
  workflowActivity?: SessionWorkflowActivity;
  pinned?: boolean;
  archived?: boolean;
}

export interface WebRemoteControlWorkspaceListResult {
  workspaces: WebRemoteControlWorkspaceTarget[];
  tasks?: WebRemoteControlTaskTarget[];
  activeWorkspaceKey?: string;
  activeTaskId?: string;
}

export type WebRemoteControlMobileNavigationIntent = "chat";

export interface WebRemoteControlWorkspaceSwitchOptions {
  /** Web page navigation only; not sent to the Host. Opens the file panel on the target root. */
  openFileManager?: boolean;
  taskId?: string;
  taskHostId?: string;
  /** Resolves the task directory for the file tree only; it neither selects a task nor marks it read. */
  fileTreeTaskId?: string;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  /** Used only by the phone's task home; after the target bridge is established, only the unread matching this snapshot is cleared. */
  markTaskReadExpectedUnreadAt?: number;
}

export interface WebRemoteControlWorkspaceSwitchResult extends WebRemoteControlSessionCreateResponse {}

export interface WebRemoteControlMobileViewState {
  activeWorkspaceKey?: string;
  activeTaskId?: string;
  updatedAt: number;
}

export interface WebRemoteControlLocalWorkspaceBridge {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "local";
  workspaceKey: string;
  workspacePath: string;
  initialTaskId?: string;
  wsUrl: string;
}

export interface WebRemoteControlRemoteWorkspaceBridge {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  initialTaskId?: string;
  wsUrl: string;
}

export type WebRemoteControlWorkspaceBridge =
  | WebRemoteControlLocalWorkspaceBridge
  | WebRemoteControlRemoteWorkspaceBridge;

export interface WebRemoteControlWindowBootstrapResult {
  windowControlSessionId: string;
  /** The desktop's actual current version; when an older desktop omits it, the phone keeps the original URL. */
  desktopAppVersion?: string;
  workspaces: WebRemoteControlWorkspaceTarget[];
  /** V1 desktops only; V2 bootstrap responses omit it. */
  tasks?: WebRemoteControlTaskTarget[];
  initialViewState?: WebRemoteControlMobileViewState;
  mobileViewState?: WebRemoteControlMobileViewState;
  /** Only newer desktops provide it; the bootstrap uses it to re-request the task view after pairing. */
  mobileTaskViewEpoch?: string;
}

export interface WebRemoteControlWindowControlReadyEvent {
  type: "window-control-ready";
  windowControlSessionId: string;
  mobileConnectionId: string;
  expiresAt: number;
}

export function resolveWebRemoteControlWorkspaceKey(
  target: Pick<WebRemoteControlWorkspaceTarget, "workspacePath" | "workspaceIdentity">,
): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export function isWebRemoteControlBridgeableWorkspaceTarget(
  workspace: WebRemoteControlWorkspaceTarget,
): boolean {
  return (
    workspace.kind !== "remote" || Boolean(workspace.workspaceIdentity && workspace.remoteSessionId)
  );
}

export function resolveWebRemoteControlInitialWorkspaceSelection({
  workspaces,
  mobileViewState,
  initialViewState,
}: {
  workspaces: WebRemoteControlWorkspaceTarget[];
  mobileViewState?: WebRemoteControlMobileViewState;
  initialViewState?: WebRemoteControlMobileViewState;
}): { workspaceKey: string; taskId?: string; canBridge: boolean } | null {
  const bridgeableWorkspaces = workspaces.filter(isWebRemoteControlBridgeableWorkspaceTarget);
  const workspaceKeys = new Set(
    bridgeableWorkspaces.map((workspace) => resolveWebRemoteControlWorkspaceKey(workspace)),
  );
  const allWorkspaceKeys = new Set(
    workspaces.map((workspace) => resolveWebRemoteControlWorkspaceKey(workspace)),
  );
  const selectedViewState = mobileViewState ?? initialViewState;
  const selectedWorkspaceKey = selectedViewState?.activeWorkspaceKey;

  if (selectedWorkspaceKey && workspaceKeys.has(selectedWorkspaceKey)) {
    return {
      workspaceKey: selectedWorkspaceKey,
      ...(selectedViewState.activeTaskId ? { taskId: selectedViewState.activeTaskId } : {}),
      canBridge: true,
    };
  }

  // Bugfix: the phone's list may show a disconnected SSH workspace, but such entries have no
  // remoteSessionId and
  // must not become the initial bridge target. Otherwise, before reconnect state has synced, the
  // user repeatedly lands on the "not yet connected" error page.
  const firstWorkspace = bridgeableWorkspaces[0];
  if (!firstWorkspace) {
    if (selectedWorkspaceKey && allWorkspaceKeys.has(selectedWorkspaceKey)) {
      return {
        workspaceKey: selectedWorkspaceKey,
        ...(selectedViewState?.activeTaskId ? { taskId: selectedViewState.activeTaskId } : {}),
        canBridge: false,
      };
    }

    const firstDisconnectedWorkspace = workspaces[0];
    if (!firstDisconnectedWorkspace) {
      return null;
    }

    return {
      workspaceKey: resolveWebRemoteControlWorkspaceKey(firstDisconnectedWorkspace),
      canBridge: false,
    };
  }

  return {
    workspaceKey: resolveWebRemoteControlWorkspaceKey(firstWorkspace),
    canBridge: true,
  };
}

export interface WebRemoteControlWorkspaceListRequest {
  type: "workspace-list-request";
  requestId: string;
  sessionId: string;
}

export interface WebRemoteControlWorkspaceSwitchRequest {
  type: "workspace-switch-request";
  requestId: string;
  sessionId: string;
  workspaceKey: string;
  taskId?: string;
}

export interface WebRemoteControlWorkspaceListSuccessResponse {
  type: "workspace-list-response";
  requestId: string;
  sessionId: string;
  success: true;
  result: WebRemoteControlWorkspaceListResult;
}

export interface WebRemoteControlWorkspaceSwitchSuccessResponse {
  type: "workspace-switch-response";
  requestId: string;
  sessionId: string;
  success: true;
  result: WebRemoteControlWorkspaceSwitchResult;
}

export interface WebRemoteControlWorkspaceListErrorResponse {
  type: "workspace-list-response";
  requestId: string;
  sessionId: string;
  success: false;
  error: string;
}

export interface WebRemoteControlWorkspaceSwitchErrorResponse {
  type: "workspace-switch-response";
  requestId: string;
  sessionId: string;
  success: false;
  error: string;
}

export type WebRemoteControlWorkspaceControlRequest =
  | WebRemoteControlWorkspaceListRequest
  | WebRemoteControlWorkspaceSwitchRequest;

export type WebRemoteControlWorkspaceControlResponse =
  | WebRemoteControlWorkspaceListSuccessResponse
  | WebRemoteControlWorkspaceSwitchSuccessResponse
  | WebRemoteControlWorkspaceListErrorResponse
  | WebRemoteControlWorkspaceSwitchErrorResponse;

export interface WebRemoteControlWindowBootstrapRequest {
  type: "window-bootstrap-request";
  requestId: string;
  windowControlSessionId: string;
}

export interface WebRemoteControlWindowBootstrapSuccessResponse {
  type: "window-bootstrap-response";
  requestId: string;
  windowControlSessionId: string;
  success: true;
  result: WebRemoteControlWindowBootstrapResult;
}

export interface WebRemoteControlWindowBootstrapErrorResponse {
  type: "window-bootstrap-response";
  requestId: string;
  windowControlSessionId: string;
  success: false;
  error: string;
}

export interface WebRemoteControlWorkspaceBridgeRequest {
  type: "workspace-bridge-request";
  requestId: string;
  windowControlSessionId: string;
  bridgeSessionId: string;
  bridgeToken: string;
  workspaceKey: string;
  taskId?: string;
}

export interface WebRemoteControlWorkspaceBridgeSuccessResponse {
  type: "workspace-bridge-response";
  requestId: string;
  windowControlSessionId: string;
  success: true;
  bridge: WebRemoteControlWorkspaceBridge;
}

export interface WebRemoteControlWorkspaceBridgeErrorResponse {
  type: "workspace-bridge-response";
  requestId: string;
  windowControlSessionId: string;
  success: false;
  error: string;
}

export interface WebRemoteControlMobileViewStateUpdate {
  type: "mobile-view-state-update";
  windowControlSessionId: string;
  viewState: WebRemoteControlMobileViewState;
  deviceInfo?: WebRemoteControlMobileDeviceInfo;
}

/** Window-control variant of the workspace-open request (relay → desktop); correlation fields match the sibling window-control messages. */
export interface WebRemoteControlWorkspaceOpenRequest {
  type: "workspace-open-request";
  requestId: string;
  windowControlSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface WebRemoteControlWorkspaceOpenSuccessResponse {
  type: "workspace-open-response";
  requestId: string;
  windowControlSessionId: string;
  success: true;
}

export interface WebRemoteControlWorkspaceOpenErrorResponse {
  type: "workspace-open-response";
  requestId: string;
  windowControlSessionId: string;
  success: false;
  error: string;
}

export type WebRemoteControlWindowControlRequest =
  | WebRemoteControlWindowBootstrapRequest
  | WebRemoteControlWorkspaceBridgeRequest
  | WebRemoteControlMobileViewStateUpdate
  | WebRemoteControlWorkspaceOpenRequest;

export type WebRemoteControlWindowControlResponse =
  | WebRemoteControlWindowBootstrapSuccessResponse
  | WebRemoteControlWindowBootstrapErrorResponse
  | WebRemoteControlWorkspaceBridgeSuccessResponse
  | WebRemoteControlWorkspaceBridgeErrorResponse
  | WebRemoteControlWorkspaceOpenSuccessResponse
  | WebRemoteControlWorkspaceOpenErrorResponse;

export type RelayDesktopControlEvent =
  | { type: "tunnel-registered"; tunnelId: string }
  | { type: "window-control-registered"; tunnelId: string }
  | { type: "web-remote-control-session-request"; sessionId: string }
  | { type: "mobile-connected"; windowControlSessionId: string }
  | { type: "mobile-disconnected"; windowControlSessionId: string }
  | WebRemoteControlPlatformRequest
  | WebRemoteControlPlatformResponse
  | WebRemoteControlWorkspaceControlRequest
  | WebRemoteControlWorkspaceControlResponse
  | WebRemoteControlWindowControlRequest
  | WebRemoteControlWindowControlResponse;
