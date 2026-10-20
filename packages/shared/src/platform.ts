/* eslint-disable max-lines -- Cross-platform platform contract centralizes renderer capabilities; OAuth and browser lifecycle must keep the desktop/web type contract, so this MR does not split platform boundaries. */
import type {
  DockerConnectOptions,
  RemoteTarget,
  SSHConnectOptions,
  WSLConnectOptions,
} from "./remoteTarget.js";
import type { PluginSandboxPlatformPort } from "./mcp-apps/contract.js";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type {
  WebRemoteControlAuthStateChange,
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStartOperationResult,
  WebRemoteControlStatus,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceTarget,
} from "./web-remote-control.js";
import type { AppSettings, Locale } from "./protocol.js";
import type { ArmsCustomEventPayload, RendererTelemetryEventPayload } from "./telemetry.js";
import type {
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
} from "./rendererActionTrace.js";
import type { RendererHeapSample } from "./validation.js";
import type {
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";
import type { BrowserViewportSize } from "./browser-use/command-metadata.js";
import type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";
export type {
  PostUpdateReleaseNotesPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
} from "./update.js";

export interface TaskNotificationPayload {
  taskId: string;
  status: "completed" | "failed" | "permission_request" | "elicitation_request" | "feedback_update";
  requestId?: string;
  title: string;
  body: string;
}

/** Main dispatches a browser-use operation that identifies a real tab to its origin renderer. */
export interface BrowserViewOperationPayload {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  tabId: string;
  browserId: string;
  browserGeneration: number;
  /** The current model command will open, activate, or change the Browser layout; the renderer should rebuild its resize-observation baseline. */
  resetsResizeBaseline?: boolean;
}

export type BrowserTabResidencyState =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring";

/** Used only to create a residency-restore guest that has not yet committed its first navigation entry. */
export const BROWSER_VIEW_RESTORE_BOOTSTRAP_URL = "zcode-browser-restore://pending";

/** Renderer reports tab-shell display facts; main must bind windowId to the trusted IPC sender. */
export interface BrowserViewResidencyReportPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  selected: boolean;
  visible: boolean;
  currentTask: boolean;
  loading: boolean;
  restoreUrl?: string | null;
  title?: string | null;
  faviconUrl?: string | null;
}

export interface BrowserViewResidencyTransitionPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId: string | undefined;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  generation: number;
  residency: Extract<
    BrowserTabResidencyState,
    "live-visible" | "live-background" | "suspended" | "restoring"
  >;
}

export interface BrowserViewCloseTabRequest {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
}

export const LOCAL_MEDIA_PREVIEW_SCHEME = "zcode-media";

export function buildLocalMediaPreviewUrl(path: string): string {
  const url = new URL(`${LOCAL_MEDIA_PREVIEW_SCHEME}://local/preview`);
  url.searchParams.set("path", path);
  return url.toString();
}

/**
 * Close notification from main to renderer.
 *
 * The old payload contained only tabId, so the renderer could search only the side-pane state for the "currently active workspace";
 * if the user had switched to another workspace, the notification was silently discarded and a ghost tab remained in the original workspace's persisted state.
 * Including the owner scope lets the renderer locate and remove the tab from the correct workspace's side-pane state.
 * scope may be omitted: internal paths such as recovery-orphan have only tabId, in which case the renderer falls back to "current workspace only" semantics.
 */
export interface BrowserViewCloseTabNotification {
  tabId: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  reason?: "recovery-orphan";
}

/** Across restarts, restore the logical shell first; the renderer must not mount all guests at once during initialization. */
export interface BrowserViewRestoredTabShell {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  origin: "agent" | "user";
  restoreUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  openedAt: number;
  lastSelectedAt: number | null;
}

export interface BrowserViewRestoreTabsRequest {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId?: string;
}

/** Main routes Agent viewport changes to the origin renderer of the target tab. */
export interface BrowserViewViewportChangedPayload extends BrowserViewOperationPayload {
  viewport: BrowserViewportSize | null;
}

// The old 1500ms default budget was not enough to wait for consecutive stable frames on slow machines or background windows; main and renderer
// share this default and pass the actual override in the prepare payload to keep their deadlines aligned.
export const BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS = 3_000;

/** Temporary renderer preview-ratio requirement for a screenshot/recording handshake; if absent, use the user's current preview. */
export type BrowserViewSurfaceScaleMode = "current" | "unscaled";

/** Main asks the owner renderer to prepare a background guest composition surface before a screenshot. */
export interface BrowserViewScreenshotSurfacePreparePayload extends BrowserViewOperationPayload {
  requestId: string;
  webContentsId: number;
  viewport: BrowserViewportSize;
  /** A natural viewport does not use metrics-based guest layout compensation; when absent, preserve existing simulation behavior (including recording). */
  viewportMode?: "natural" | "emulated";
  /** `unscaled` forces a true 100% surface only for the lease lifetime; do not persist it over the user's Fit/fixed ratio. */
  surfaceScaleMode?: BrowserViewSurfaceScaleMode;
  /** Prepare timeout currently used by Main; when missing from an old payload, the renderer falls back to the shared default. */
  timeoutMs?: number;
}

/** Owner renderer confirms that both the target guest's logical viewport and native preview-surface ratio are stable. */
export interface BrowserViewScreenshotSurfaceReadyPayload extends BrowserViewScreenshotSurfacePreparePayload {
  surfaceScale: number;
}

/** Main tells the owner renderer to release the temporary background screenshot-composition surface. */
export type BrowserViewScreenshotSurfaceReleasePayload = Omit<
  BrowserViewScreenshotSurfacePreparePayload,
  "viewport" | "viewportMode" | "surfaceScaleMode" | "timeoutMs"
>;

export type BrowserGuestAttachRejectReason =
  | "not-found"
  | "destroyed"
  | "not-webview"
  | "closed"
  | "window-mismatch"
  | "workspace-mismatch"
  | "session-mismatch"
  | "remote-session-mismatch"
  | "residency-suspended"
  | "residency-generation-mismatch";

/** Binding result returned by main after the renderer reports a guest; a rejection must not be disguised as a no-response readiness timeout. */
export type BrowserGuestAttachResult =
  | { ok: true; guestGeneration: number }
  | { ok: false; reason: BrowserGuestAttachRejectReason; recoveryRequested: boolean };

/** Installed editor/terminal information. */
export interface EditorInfo {
  /** Editor identifier (e.g. "vscode", "zed", "terminal"). */
  id: string;
  /** Display name. */
  name: string;
  /** Icon as a base64 data URL. */
  iconDataUrl: string;
}

export interface ApplicationIconInfo {
  iconDataUrl: string;
}

export type ApplicationIconLocator =
  | { kind: "darwin-bundle-id"; value: string }
  | { kind: "windows-executable-path"; value: string }
  | { kind: "windows-aumid"; value: string };

export interface ApplicationIconRequest {
  locators: ApplicationIconLocator[];
}

export type OpenInEditorRemoteTarget =
  | Pick<SSHConnectOptions, "kind" | "host" | "port" | "username" | "sshConfigAlias">
  | Pick<WSLConnectOptions, "kind" | "distro" | "user">
  | Pick<DockerConnectOptions, "kind" | "container">;

export interface OpenInEditorOptions {
  remoteTarget?: OpenInEditorRemoteTarget;
  workspaceIdentity?: string;
  pathKind?: "file" | "directory";
}

export interface CreateTempTextAttachmentRequest {
  text: string;
  filename?: string;
}

export interface CreateTempTextAttachmentResult {
  filename: string;
  localPath: string;
  mimeType: "text/plain";
  sizeBytes: number;
}

/**
 * Open a dwf artifact as a file: write the bytes of a particular artifact version to a local copy on the host machine.
 * （docs/dynamic-workflow/authoring.md「How the user sees them」）。
 *
 * ⚠ Terminology: artifact means output published to the user by a script via `artifact.*`, not the engine's `RunSettlement.artifact`.
 */
export interface MaterializeWorkflowArtifactFileRequest {
  runId: string;
  artifactId: string;
  /** Which version these bytes belong to; copies are stored in per-version directories, one per version. */
  version: number;
  /** Desired filename (including extension, which determines the app the system uses to open it); the host sanitizes it again. */
  fileName: string;
  bytes: Uint8Array;
}

export interface MaterializeWorkflowArtifactFileResult {
  /** Absolute path to the copy on the host machine. */
  localPath: string;
}

export type SaveFileRequest =
  | {
      data: ArrayBuffer;
      sourceUrl?: never;
      suggestedName: string;
    }
  | {
      data?: never;
      sourceUrl: string;
      suggestedName: string;
    };

export interface SaveFileResult {
  canceled?: boolean;
  error?: string;
  path?: string;
  success: boolean;
}

export interface PrintPageToPdfResult {
  success: boolean;
  /** PDF bytes; present on success. */
  data?: ArrayBuffer;
  /** "print_in_progress" | "print_failed" */
  error?: string;
}

export function createOpenInEditorRemoteTarget(
  target: RemoteTarget,
): OpenInEditorRemoteTarget | undefined {
  switch (target.kind) {
    case "ssh":
      // openInEditor needs only the connection identifier for a VS Code Remote-SSH URI;
      // password/privateKeyPassphrase and other credential fields must not continue through renderer/preload/main IPC.
      return {
        kind: "ssh",
        host: target.host,
        port: target.port,
        username: target.username,
        ...(target.sshConfigAlias?.trim() ? { sshConfigAlias: target.sshConfigAlias.trim() } : {}),
      };
    case "wsl": {
      const user = target.user?.trim();
      return {
        kind: "wsl",
        distro: target.distro,
        ...(user ? { user } : {}),
      };
    }
    case "docker":
      return {
        kind: "docker",
        container: target.container,
      };
    case "server":
      return undefined;
  }
}

export interface WSLDistro {
  name: string;
  isDefault: boolean;
  state: string;
  version: 1 | 2 | null;
}

export interface DockerContainerInfo {
  id: string;
  image: string;
  name: string;
  state: string;
  status: string;
}

export interface SSHConfigAliasOption {
  alias: string;
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  source?: string;
}

export interface ZCodeStdioTapDevState {
  enabled: boolean;
  visible: boolean;
  logDir: string;
  statePath: string;
}

export type DesktopTitleBarTheme = "light" | "dark" | "system";

export interface WindowScreenshotResult {
  dataBase64: string;
  filename: string;
  contentType: string;
  size: number;
}

export type ChromeBrowserDataImportError =
  | "chrome_profile_not_found"
  | "chrome_profile_ambiguous"
  | "chrome_executable_not_found"
  | "chrome_cookie_access_denied"
  | "chrome_cookie_elevation_required"
  | "chrome_cookie_elevation_cancelled"
  | "chrome_cookie_helper_verification_failed"
  | "chrome_cookie_app_bound_decryption_failed"
  | "chrome_cookie_protection_unsupported"
  | "chrome_profile_locked"
  | "chrome_local_storage_import_failed"
  | "chrome_import_not_supported"
  | "chrome_browser_data_import_unavailable"
  | "chrome_data_import_failed"
  | "chrome_default_profile_not_found";

export interface ChromeBrowserDataImportOptions {
  /** Windows App-Bound Cookie may trigger UAC only after explicit confirmation for this operation; do not persist as global authorization. */
  allowElevatedChromeDecryption?: boolean;
}

/** Chrome browser-data import returns only counts and status; Cookie/LocalStorage values and decryption material must not cross processes. */
export interface ChromeBrowserDataImportResult {
  success: boolean;
  cookies: {
    imported: number;
    skipped: number;
    failed: number;
  };
  localStorage: {
    originsImported: number;
    entriesImported: number;
    originsSkipped: number;
    originsFailed: number;
    error?: ChromeBrowserDataImportError;
  };
  /** Preserve actionable issues on partial success; do not include absolute Profile paths or site data. */
  issues?: ChromeBrowserDataImportError[];
  error?: ChromeBrowserDataImportError;
}

export interface EmbeddedBrowserDataClearResult {
  success: boolean;
  error?: string;
}

export interface WindowControlsOverlayMetrics {
  leftPaddingPx?: number;
  rightPaddingPx?: number;
  titleBarHeightPx?: number;
}

export interface WindowControlsOverlayReadyPayload {
  zoomLevel: number;
  metrics: WindowControlsOverlayMetrics;
}

export interface DesktopZoomState {
  zoomLevel: number;
}

/**
 * Desktop capability for "close to tray" (spec: docs/desktop/linux-close-to-tray.md).
 * On Linux, it depends on whether the session DBus has a StatusNotifierWatcher (built in on KDE/XFCE;
 * GNOME requires the AppIndicator extension). Windows always reports supported=true; macOS/Web do not query it.
 */
export interface DesktopCloseToTrayCapability {
  /** Whether close-to-tray is available. */
  supported: boolean;
  /** Whether this is a GNOME-like desktop without a tray; the settings page uses this to add an "Install the AppIndicator extension" hint. */
  gnomeLikeWithoutTray: boolean;
}

export interface DesktopWindowChromeState {
  isMaximized: boolean;
  /** Local macOS major version; null on non-macOS or when it cannot be parsed. */
  macOSMajorVersion?: number | null;
  supportsNativeRoundedCorners: boolean;
}

export interface RemoteServiceSession {
  sessionId: string;
}

export interface RemoteConnectionRuntimeLog {
  label: string;
  requestId?: string;
  sessionId?: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  timestamp: string;
}

export interface RemoteSessionClosedEvent {
  sessionId: string;
  reason: "host-exit";
  exitCode: number | null;
  signal: string | null;
  error?: string;
  /** true = Source transport 仍在自动恢复预算内，UI 不得做终态失败收口。 */
  recoverable?: boolean;
  recoveryAttempt?: number;
  recoveryLimit?: number;
  recoveryBudgetExhausted?: boolean;
  reasonCode?: string;
  retryable?: boolean;
}

export interface RemoteSessionReconnectedEvent {
  previousSessionId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
}

export interface EmbeddedBrowserOpenUrlRequest {
  url: string;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
  /** Browser-use tab ownership that triggered the popup; for older events where this is missing, the renderer handles it using the current scope. */
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  browserId?: string;
  browserGeneration?: number;
  sourceTabId?: string;
}

export interface EmbeddedBrowserPermissionDeviceOption {
  deviceId: string;
  name?: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}

export interface EmbeddedBrowserPermissionScreenOption {
  sourceId: string;
  name: string;
  /** Source type: entire screen / window, determined by main from the desktopCapturer source ID prefix. */
  kind: "screen" | "window";
  thumbnailDataUrl?: string;
}

/** Embedded-browser permission prompt request from Main → Renderer; kind determines which prompt the renderer displays. */
export type EmbeddedBrowserPermissionPromptEvent =
  | {
      requestId: string;
      kind: "permission";
      origin: string;
      permission: string;
      mediaTypes?: string[];
      /** webContents ID of the requesting guest; the renderer uses it to show the prompt only in its owning tab,
       *  preventing a background tab's request from appearing in the current tab and being approved by mistake. */
      guestWebContentsId?: number;
    }
  | {
      requestId: string;
      kind: "screen-share";
      origin: string;
      screens: EmbeddedBrowserPermissionScreenOption[];
      /** Screen sharing has no tab-anchoring semantics; always omitted (use fallback rendering). */
      guestWebContentsId?: number;
    }
  | {
      requestId: string;
      kind: "device";
      origin: string;
      /** select-hid-device / select-usb-device / select-serial-port / select-bluetooth-device */
      permission: string;
      devices: EmbeddedBrowserPermissionDeviceOption[];
      /** webContents ID of the requesting guest (available for serial/Bluetooth; omitted for hid/usb due to frame limitations,
       *  so the renderer uses fallback rendering). */
      guestWebContentsId?: number;
    };

export type EmbeddedBrowserPermissionResolution =
  | { action: "allow-always" }
  | { action: "allow-session" }
  | { action: "block-always" }
  | { action: "dismiss" }
  | { action: "share-screen"; sourceId: string }
  | { action: "select-device"; deviceId: string }
  | { action: "cancel" };

export interface EmbeddedBrowserPermissionResolveRequest {
  requestId: string;
  resolution: EmbeddedBrowserPermissionResolution;
}

export type EmbeddedBrowserSitePermissionsSnapshot = Record<
  string,
  Record<string, "allow" | "deny">
>;

export interface EmbeddedBrowserSitePermissionUpdateRequest {
  origin: string;
  permission: string;
  /** "ask" means delete this record and ask each time again. */
  state: "allow" | "deny" | "ask";
}

export interface EmbeddedBrowserSitePermissionResetRequest {
  origin: string;
}

export interface BotRemoteWorkspaceReconnectedEvent {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
  target: RemoteTarget;
}

export interface ConnectRemoteRequest {
  target: RemoteTarget;
  requestId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  connectTrigger?: import("./remoteUsageTelemetry.js").RemoteWorkspaceConnectTrigger;
  confirmSourceServerInstall?: boolean;
}

export interface CancelPendingRemoteConnectionRequest {
  requestId?: string;
}

export interface BindRemoteWorkspaceSessionContextRequest {
  remoteSessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
}

export interface BindRemoteWorkspaceSessionContextResult {
  sourceServerId?: string;
  remoteSessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
  /** Desktop 专用的 tab 原地换代提示；不是任务路由身份，手机 replayable 客户端忽略。 */
  previousWorkspaceIdentity?: string;
}

export type BindRemoteWorkspaceSessionContextIpcResult =
  | { success: true; result: BindRemoteWorkspaceSessionContextResult }
  | {
      success: false;
      error: string;
      reasonCode?: string;
      retryable?: boolean;
    };

export const DesktopCommandIds = {
  NewTask: "newTask",
  OpenWorkspace: "openWorkspace",
  CloseActiveContext: "closeActiveContext",
  CloseWindow: "closeWindow",
  MinimizeWindow: "minimizeWindow",
  ToggleMaximizeWindow: "toggleMaximizeWindow",
  ToggleFullScreen: "toggleFullScreen",
  ResetWindowSize: "resetWindowSize",
  ResetZoom: "resetZoom",
  ZoomIn: "zoomIn",
  ZoomOut: "zoomOut",
  ShowAbout: "showAbout",
  OpenChangelog: "openChangelog",
  CheckForUpdates: "checkForUpdates",
  RelaunchApp: "relaunchApp",
  OpenFeedback: "openFeedback",
  OpenCommunity: "openCommunity",
  ExportLogs: "exportLogs",
  ToggleDevTools: "toggleDevTools",
  OpenResourceManager: "openResourceManager",
  ToggleZCodeStdioTapDevProxy: "toggleZCodeStdioTapDevProxy",
  SetZCodeEndpointProduction: "setZCodeEndpointProduction",
  SetZCodeEndpointTest: "setZCodeEndpointTest",
  SetZCodeEndpointCustom: "setZCodeEndpointCustom",
  ResetZCodeEndpoint: "resetZCodeEndpoint",
  ClearAllData: "clearAllData",
  ClearCodingPlanWebviewStorage: "clearCodingPlanWebviewStorage",
  GetCuaOsSupport: "getCuaOsSupport",
} as const;

export type DesktopCommandId = (typeof DesktopCommandIds)[keyof typeof DesktopCommandIds];

/**
 * Operating-system support status for the CUA Helper (macOS version-gate result sent to the renderer
 * by the main process through GetCuaOsSupport).
 * - supported: meets the requirement (including non-version factors; parsing failures are handled permissively).
 * - macos-below-minimum: macOS is below the supported floor (Helper LSMinimumSystemVersion 12.0);
 *   LaunchServices refuses to start the Helper with -10825 on older versions, which appears as repeated unresponsive permission prompts.
 * - not-applicable: non-darwin platform, where the macOS version floor does not apply.
 */
export type CuaOsSupport =
  | { kind: "supported" }
  | { kind: "macos-below-minimum"; minimumMacOs: string; currentMacOs: string }
  | { kind: "not-applicable" };

/**
 * Platform operations interface — replaces direct access to window.zcode
 *
 * Defines operations that require participation from the host environment (Electron main / Web server).
 * Desktop and Web provide different implementations; the UI consumes them through this shared interface.
 *
 * Design principle: include only operations that "must cross a process boundary and are not suitable as RPC services,"
 * such as native dialogs and window-lifecycle control.
 * Business services (files, terminal, credentials, etc.) use the IServiceAccessor RPC channel.
 */
export interface IPlatformService {
  /** 是否支持当前客户端本机文件的默认应用与目录操作；Web 不具备此能力。 */
  canOpenLocalFiles?: boolean;

  /** 当前平台的文件选择框是否能返回 agent 可访问的本地绝对路径 */
  canSelectFilePath?: boolean;

  /**
   * Plugin UI sandbox platform ports. Implemented only on desktop;
   * undefined on web / mobile remote control, which plugin-ui uses to fall back to ordinary MCP tool cards.
   */
  pluginSandbox?: PluginSandboxPlatformPort;

  /** Open the system directory picker and return the selected path or null. */
  selectDirectory(): Promise<string | null>;

  /**
   * App-managed directory for the worktree location mode "global" (`~/.zcode/worktrees`).
   * Implemented on Desktop only; web/mobile leave it undefined so the option stays hidden there.
   */
  getAppWorktreesDir?(): Promise<string>;

  /**
   * Apply (active=true) or release (active=false) a system-wide audio output mute used while voice
   * dictation records. Implemented on Desktop only; the main process snapshots the previous mute
   * state and restores it on release, quit, or renderer loss. Web/mobile leave it undefined.
   */
  setDictationSystemMute?(active: boolean): Promise<void>;

  /**
   * Open the system multi-directory picker and return local paths accessible to the Host.
   * Cancel returns an empty array. Not provided on Web.
   */
  selectDirectories?(): Promise<string[]>;

  /** Open the system file picker and return the selected file path or null. */
  selectFile(): Promise<string | null>;

  /** Open the system multi-file picker and return selected file paths; return an empty array when cancelled. */
  selectFiles?(): Promise<string[]>;

  /** Write a file using the host's native Save As dialog; not implemented by regular Web. */
  saveFile?(payload: SaveFileRequest): Promise<SaveFileResult>;

  /**
   * Print the current webContents print-media layout to PDF (vector text) using Chromium's print engine.
   * Page size is determined by @page CSS injected by the renderer (preferCSSPageSize); implemented on Desktop only.
   */
  printPageToPdf?(): Promise<PrintPageToPdfResult>;

  /**
   * Resolve a host-local path from a browser File object; only Desktop preload can implement this safely.
   * Web/mobile return null so the UI does not depend on Electron's non-standard File.path.
   */
  getPathForFile?(file: unknown): string | null;

  /** Convert an Agent-authorized local Desktop video path to a host URL readable by media elements. */
  createLocalMediaPreviewUrl?(path: string): string;

  /**
   * Create a text attachment file in the host's temporary ~/.zcode directory.
   * Mobile remote control must write through the shared-host/platform proxy to the desktop host so large text does not enter the prompt payload.
   */
  createTempTextAttachment?(
    payload: CreateTempTextAttachmentRequest,
  ): Promise<CreateTempTextAttachmentResult>;

  /**
   * Write the bytes of a dwf artifact version to a local copy on the host machine (only when the path is empty) and return its path.
   * Implemented only on Desktop: mobile remote control and ordinary Web cannot open a file in a local app, so omit this capability to hide the entry point.
   */
  materializeWorkflowArtifactFile?(
    payload: MaterializeWorkflowArtifactFileRequest,
  ): Promise<MaterializeWorkflowArtifactFileResult>;

  /** Subscribe to remote-connection progress logs for the current window; returns a disposer. */
  onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;

  /** Subscribe to remote workspace session close events; returns a disposer. */
  onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;

  /** 订阅 Source transport 自动重连后的 logical session 换代事件。 */
  onRemoteSessionReconnected?(handler: (event: RemoteSessionReconnectedEvent) => void): () => void;

  /** Subscribe to successful remote workspace reconnections triggered by a Bot; returns a disposer. */
  onBotRemoteWorkspaceReconnected(
    handler: (event: BotRemoteWorkspaceReconnectedEvent) => void,
  ): () => void;

  /** Check whether a directory is already open in another window; if so, activate that window and switch to its tab. */
  activateOrSetWorkspace(path: string): Promise<{ activated: boolean }>;

  /** Establish a remote connection (Desktop: create a remote session in the current window; Web: use the HTTP API). */
  connectRemote(
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath?: string;
      workspaceIdentity?: string;
      connectTrigger?: import("./remoteUsageTelemetry.js").RemoteWorkspaceConnectTrigger;
      confirmSourceServerInstall?: boolean;
    },
  ): Promise<{
    success: boolean;
    error?: string;
    reasonCode?: string;
    retryable?: boolean;
    sessionId?: string;
    /** 本次直接复用的在线连接目标，凭据不参与认证也不得持久化。 */
    reusedConnectionTarget?: RemoteTarget;
    /** 安装/升级等待时由 Host 确认的实际连接线路。 */
    profileId?: string;
    /** WSL 安装/升级等待使用本次已解析身份；预览失败也不能重新选择系统默认值。 */
    resolvedWslTarget?: Required<WSLConnectOptions>;
  }>;

  /** Desktop-only：请求在线 Source 的无 workspace 配置 attachment。 */
  requestSourceSettingsAttachment?(sourceServerId: string): Promise<{ attachmentId: string }>;

  /** Cancel a remote connection that has not yet completed in the current window (optional; Web may ignore). */
  cancelPendingRemoteConnection?(requestId?: string): Promise<void>;

  /** Bind the canonical workspace identity to an existing remote logical session. */
  bindRemoteWorkspaceSessionContext?(
    context: BindRemoteWorkspaceSessionContextRequest,
  ): Promise<BindRemoteWorkspaceSessionContextResult>;

  /** Enable Web remote control for the current workspace. */
  startWebRemoteControl(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStartOperationResult>;

  /** Clear old pairing data and generate a new Web remote-control QR code. */
  refreshWebRemoteControlPairing(
    context: WebRemoteControlContext,
  ): Promise<WebRemoteControlStartOperationResult>;

  /** 关闭当前窗口已开启的 Web 远程控制能力 */
  stopWebRemoteControl(): Promise<void>;

  /** Get Web remote-control status for the current window. */
  getWebRemoteControlStatus(): Promise<WebRemoteControlStatus>;

  /** 桌面 OAuth 会话通知；main 独立重读凭据后决定是否恢复远控。 */
  notifyWebRemoteControlAuthStateChanged?(change: WebRemoteControlAuthStateChange): void;

  /** 订阅当前窗口 Web 远程控制状态变化；旧平台可不实现，UI 会保留轮询兜底 */
  onWebRemoteControlStatusChanged?(handler: (status: WebRemoteControlStatus) => void): () => void;

  /** Release remote sessions created in the current window. */
  disposeRemoteSession(sessionId: string): Promise<void>;

  /** Check whether the local Docker daemon is available. */
  isDockerAvailable(): Promise<boolean>;

  /** List WSL distributions available on this machine. */
  listWSLDistros(): Promise<WSLDistro[]>;

  /** List Docker containers that can currently be connected to. */
  listDockerContainers(): Promise<DockerContainerInfo[]>;

  /** List aliases from this machine's SSH config for quick form entry. */
  listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;

  /** Read native MCP user-directory config from the host; mobile remote control forwards through the connected desktop host. */
  loadMcpFromUserDirectory?(
    payload?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;

  /** Write native MCP user-directory config on the host; regular Web returns unsupported when no host exists. */
  saveMcpToUserDirectory?(
    payload: SaveCliMcpToUserDirectoryRequest,
  ): Promise<{ success: boolean; error?: string }>;

  /** Migrate legacy Common MCP config; only the host can execute this, and mobile remote control forwards through the desktop attachment. */
  migrateLegacyCommonMcp?(
    payload?: MigrateLegacyCommonMcpRequest,
  ): Promise<MigrateLegacyCommonMcpResult>;

  /** Open an external URL (used to redirect OAuth to a browser). */
  openExternal(url: string): void;

  /** Read the actual app icon by system application ID; non-Desktop platforms may omit this. */
  getApplicationIcon?(
    request: string | ApplicationIconRequest,
  ): Promise<ApplicationIconInfo | null>;

  /** Open the feedback entry point; the platform resolves the final URL. */
  openFeedback(): Promise<void>;

  /** Subscribe to the main-process event that opens the built-in feedback dialog (Desktop). */
  onOpenFeedbackDialog?(handler: () => void): () => void;

  /** Subscribe to the main-process event that opens the My Tickets panel (Desktop). */
  onOpenTicketsPanel?(handler: () => void): () => void;

  /** Open the user-community entry point; the platform resolves the channel for the current language. */
  openCommunity(): Promise<void>;

  /** Check whether a user-community entry point is available for the current language. */
  canOpenCommunity(locale: Locale): Promise<boolean>;

  /** Open a path in the system file manager. */
  openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;

  /** Open a local file with the system default application; regular Web returns unsupported. */
  openExternalFile?(path: string): Promise<{ success: boolean; error?: string }>;

  /** Open the full permission flow for ZCode Computer Use. Desktop only. */
  openCuaPermissionOnboarding?(
    options?: OpenCuaPermissionOnboardingOptions,
  ): Promise<CuaAccessibilitySettingsResult>;
  /** Cancel the onboarding participant started by this renderer with operationId. Desktop only. */
  cancelCuaPermissionOnboarding?(operationId: string): void;
  /**
   * Warm up and cache the verified Helper path + fingerprint so the subsequent dragstart can call startDrag synchronously.
   * Must be called when the drag dialog mounts: Electron native drag requires startDrag to run synchronously in the dragstart event chain;
   * it cannot wait for asynchronous I/O such as install/verify (or the OS drag gesture window is missed). Desktop only.
   */
  prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
  /** Drag Helper.app from the permission dialog into the macOS permission list. Desktop only. */
  startCuaHelperPermissionDrag?(): void;

  /** Report OAuth state to the main process for deep-link routing. */
  registerOAuthState(payload: OAuthStateRegistration): void;

  /**
   * Register an OAuth deep-link callback listener.
   * @returns A disposer that removes only this callback when called.
   */
  onOAuthCallback(callback: (url: string) => void): () => void;

  /**
   * Register a payment deep-link callback listener.
   * @returns A disposer that removes only this callback when called.
   */
  onPaymentCallback(callback: (url: string) => void): () => void;

  /** Register the `zcode://share/import?code=...` import intent. */
  onShareImport?(callback: (payload: { shareCode: string }) => void): () => void;

  /** Notify the main process that the renderer is ready and trigger forwarding of cached cold-start deep links. */
  notifyRendererReady(): void;

  /** Trigger a system notification for the task state; the host decides whether to display it. */
  showTaskNotification(payload: TaskNotificationPayload): void;

  /** Report UI telemetry events through the host environment. */
  reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;

  /** Report custom ARMS events through the host environment; currently a no-op on Web. */
  reportArmsCustomEvent(payload: ArmsCustomEventPayload): Promise<void>;

  /** Read the current rollout config for Desktop Renderer user-action Trace; not implemented on Web/mobile. */
  getRendererActionTraceConfig?(): Promise<RendererActionTraceConfigV1>;
  /** Subscribe to Renderer user-action Trace config pushed by Main; not implemented on Web/mobile. */
  onRendererActionTraceConfigChanged?(
    callback: (config: RendererActionTraceConfigV1) => void,
  ): () => void;
  /** Renderer → Main: send a completed ui_action batch; strictly out-of-band and fire-and-forget. */
  reportRendererActionTraceBatch?(batch: RendererActionTraceBatchV1): void;
  reportLocalTtftBatch?(batch: import("./localTtft.js").LocalTtftBatch): void;

  /**
   * Renderer → Main: heap reading from the main-window renderer every 60 seconds, recorded as a `renderer_main` role event. One-way send, fire-and-forget;
   * Web and mobile remote control have no bridge, so omitting this is a no-op.
   */
  reportRendererHeapSample?(sample: RendererHeapSample): void;

  /** Sync workspace paths for all tabs in the current window to the main process (for cross-window deduplication). */
  syncWindowTabs(paths: string[]): void;

  /** Sync workspaces that Web remote control may switch to in the current window; the Web fallback may ignore this. */
  syncWebRemoteControlWorkspaces?(workspaces: WebRemoteControlWorkspaceTarget[]): void;

  /** Sync task snapshots that Web remote control may display in the current window; the Web fallback may ignore this. */
  syncWebRemoteControlTasks?(tasks: WebRemoteControlTaskTarget[]): void;

  /** 注册 Web 远程控制手机端请求重连 workspace 的回调，返回 disposer */
  onWebRemoteControlReconnectWorkspace?(
    handler: (
      request: WebRemoteControlReconnectWorkspaceRequest,
    ) => Promise<WebRemoteControlReconnectWorkspaceResult>,
  ): () => void;

  /** Sync the unread task count for the current window to the host for Dock/taskbar badge aggregation. */
  syncWindowUnreadCount(count: number): void;
  /** Active task changed in the current window; Main publishes global PiP focus only while this window is foregrounded. */
  syncActiveTaskSession(sessionId: string | null): void;

  /** Sync app settings that the main process must observe immediately; Web fallback may ignore. */
  syncAppSettings?(patch: Partial<AppSettings>): void;

  /**
   * Query the "close to tray" capability; the desktop main process probes and returns it, while Web/mobile remote control without a bridge omits it.
   * The settings page uses this to determine whether the Linux toggle should be disabled.
   */
  getCloseToTrayCapability?(): Promise<DesktopCloseToTrayCapability>;

  /** Shortcut-recording state from Settings; Desktop main temporarily removes configurable menu accelerators, while Web may ignore. */
  setShortcutRecordingActive?(active: boolean): void;

  /** Register a callback for the main process to focus a workspace tab; returns a disposer. */
  onFocusTab(handler: (path: string) => void): () => void;

  /** Register a callback for the main process to create a tab; returns a disposer. */
  onNewTab(handler: () => void): () => void;

  /** Register a callback for the main process to close the current context; returns a disposer. */
  onCloseActiveContextRequest?(handler: () => void): () => void;

  /** Register a callback for a built-in browser webview requesting a new page; returns a disposer. */
  onOpenBrowserUrl?(handler: (request: EmbeddedBrowserOpenUrlRequest) => void): () => void;
  /** Register embedded-browser permission prompt requests (main → renderer); return a disposer. */
  onEmbeddedBrowserPermissionPrompt?(
    handler: (event: EmbeddedBrowserPermissionPromptEvent) => void,
  ): () => void;
  /** Send the user's embedded-browser permission decision back (renderer → main). */
  resolveEmbeddedBrowserPermissionPrompt?(request: EmbeddedBrowserPermissionResolveRequest): void;
  /** Read embedded-browser site permission records (settings page: "Website permissions"). */
  getEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** Update/delete one site permission; return the updated snapshot. */
  setEmbeddedBrowserSitePermission?(
    request: EmbeddedBrowserSitePermissionUpdateRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** Clear all site permission records. */
  clearEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** Reset all permission records for one site (delete all persisted decisions for that origin); return the updated snapshot. */
  resetEmbeddedBrowserSitePermission?(
    request: EmbeddedBrowserSitePermissionResetRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
  /** Register a callback for when an Agent's first browser command creates a controlled view (automatically opens a browser-use tab); returns a disposer. */
  onBrowserViewReady?(
    handler: (payload: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): () => void;

  /** Refresh tab-operation state when browser-use targets a real tab; returns a disposer. */
  onBrowserViewOperation?(handler: (payload: BrowserViewOperationPayload) => void): () => void;

  /** Browser visibility capability: explicitly show/hide the current IAB browser-use pane. */
  onBrowserViewVisibility?(
    handler: (payload: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): () => void;

  /** Single-tab synchronization event between Agent setViewportSize and renderer free sizing. */
  onBrowserViewViewportChanged?(
    handler: (payload: BrowserViewViewportChangedPayload) => void,
  ): () => void;

  /** Register a callback for main to prepare a background guest composition surface before a screenshot; returns a disposer. */
  onBrowserViewScreenshotSurfacePrepare?(
    handler: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): () => void;

  /** Register a callback for main to release a background guest composition surface after a screenshot; returns a disposer. */
  onBrowserViewScreenshotSurfaceRelease?(
    handler: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): () => void;

  /** Report that the target guest's screenshot-composition surface is stable across consecutive animation frames. */
  browserViewScreenshotSurfaceReady?(payload: BrowserViewScreenshotSurfaceReadyPayload): void;

  onBrowserViewCloseTab?(handler: (payload: BrowserViewCloseTabNotification) => void): () => void;

  /** Main asks the renderer to unload a guest while preserving its logical shell. */
  onBrowserViewSuspend?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** Main asks the renderer to remount a guest for a suspended shell. */
  onBrowserViewRestore?(
    handler: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): () => void;

  /** Register a callback for the main process to create a task; returns a disposer. */
  onNewTask(handler: () => void): () => void;

  /** Register a callback for the main process to open a workspace; returns a disposer. */
  onOpenWorkspace(handler: () => void): () => void;

  /** Register a callback for the main process to open a local workspace directory directly from a deep link; returns a disposer. */
  onOpenWorkspacePath?(handler: (path: string) => void): () => void;

  /** Register a callback for `zcode://task/new`: open the local workspace and fill a fresh, unsent draft. Desktop only; returns a disposer. */
  onOpenTaskDraft?(handler: (payload: { path: string; text: string }) => void): () => void;

  /** Register a callback for window fullscreen-state changes; returns a disposer. */
  onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;

  /** Read the current desktop window's maximized state and native system-corner support. */
  getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;

  /** Register a callback for desktop window maximized-state and native system-corner changes. */
  onDesktopWindowChromeStateChanged?(
    handler: (state: DesktopWindowChromeState) => void,
  ): () => void;

  /** Synchronously read the current native window-control safe insets for first-screen initialization. */
  getWindowControlsOverlayMetrics?(): WindowControlsOverlayMetrics | null;

  /** Register a callback for native window-control safe-inset changes; returns a disposer. */
  onWindowControlsOverlayChanged?(
    handler: (metrics: WindowControlsOverlayMetrics) => void,
  ): () => void;

  /** Synchronously read the current desktop window page-zoom level; Web fallback may return the default 0. */
  getDesktopZoomLevel?(): Promise<DesktopZoomState>;

  /** Register a callback for page-zoom changes in the current desktop window; returns a disposer. */
  onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;

  /** Register a callback to navigate to the relevant task after the user clicks a system notification; returns a disposer. */
  onTaskNotificationClick(handler: (taskId: string) => void): () => void;

  /** Export logs: zip ~/.zcode/v2 and external Agent logs, then reveal the archive in the system file manager. */
  exportLogs(): Promise<{ success: boolean; path?: string; error?: string }>;

  /** Capture the current window for an error report; Web fallback may return null. */
  captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>;

  /** `<webview>` guest report; active=true means Agent commands without tabId should prefer the currently visible page. */
  browserViewAttachGuest?(payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    /** Conversation owner for a human browser tab; if absent, main must keep it unclaimable to prevent cross-conversation leaks. */
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult>;

  /** Have main precisely disconnect the old guest's CDP before rebuilding `<webview>`; do not destroy the old node when false. */
  browserViewDetachGuest?(payload: { key: string; webContentsId: number }): Promise<boolean>;

  /** User explicitly closed the Browser tab; uses different IPC authority from budget suspension. */
  browserViewCloseTab?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /** Report selected/visible/loading state and recovery metadata. */
  browserViewReportResidency?(payload: BrowserViewResidencyReportPayload): Promise<void>;

  /** Renderer unloaded the guest for the specified generation. */
  browserViewSuspendReady?(payload: { tabId: string; generation: number }): Promise<void>;

  /** Ask main to restore a suspended tab single-flight when the user selects it. */
  browserViewEnsureResident?(payload: BrowserViewCloseTabRequest): Promise<void>;

  /** Read persisted logical shells when a workspace/task starts. */
  browserViewRestoreTabs?(
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]>;

  /** Renderer writes free sizing back to main; null means restore the host's natural viewport. */
  browserViewUpdateViewport?(payload: {
    tabId: string;
    viewport: BrowserViewportSize | null;
  }): Promise<void>;

  /** One-time import of Cookies and LocalStorage from an automatically discovered local Chrome Profile. */
  importChromeBrowserData?(
    options?: ChromeBrowserDataImportOptions,
  ): Promise<ChromeBrowserDataImportResult>;

  /** Clear built-in browser persistent partitions; cache mode retains authentication data, while all mode clears all site data. */
  clearEmbeddedBrowserData?(mode: "cache" | "all"): Promise<EmbeddedBrowserDataClearResult>;

  /** Register a callback for when a new version has finished downloading; receives the new version number and returns a disposer. */
  onUpdateReady(callback: (version: string) => void): () => void;

  /** Register a callback for the result of "Check for updates" (used for toast feedback); returns a disposer. */
  onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;

  /** Register a callback for ongoing auto-update state changes; returns a disposer. */
  onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;

  /** Read current auto-update state on demand to compensate for missed async events when a menu opens. */
  getUpdateState?(): Promise<UpdateStatePayload>;

  /** User confirmed in the update dialog to download the currently discovered version. */
  downloadUpdate(): Promise<void>;

  /** User cancelled the update currently downloading in the update dialog. */
  cancelUpdateDownload(): Promise<void>;

  /** Open the standalone desktop update window; non-desktop platforms may omit this and fall back to the embedded dialog. */
  openUpdateStatusWindow?(): Promise<void>;

  /** Read desktop auto-update preferences; non-desktop platforms may return defaults. */
  getAutoUpdatePreferences?(): Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;

  /** Write the "automatically download and install updates" preference; non-desktop platforms may no-op. */
  setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;

  /** User skipped the currently discovered version; the main process persists it for the current channel. */
  skipUpdateVersion(version: string): Promise<void>;

  /** Query the number of currently running desktop sessions; non-desktop platforms may return 0. */
  getDesktopSessionActivity?(): Promise<{
    runningAgentSessionCount: number;
  }>;

  /** stdio tap proxy switch state in development; non-desktop platforms may omit this. */
  getZCodeStdioTapDevState?(): Promise<ZCodeStdioTapDevState>;

  /** Whether running locally in development; Desktop injects !app.isPackaged, while Web may omit this. */
  isLocalDevelopmentRuntime?: boolean;

  /** Notification that the Settings file was updated by a desktop menu command; the renderer refreshes its settings snapshot. */
  onSettingsChanged?(callback: () => void): () => void;

  /** App language resolved by the desktop main process; used by standalone lightweight windows without settingService. */
  onApplicationLocaleChanged?(callback: (locale: Locale) => void): () => void;

  /** Host system language; read by the main process on Desktop, with Web falling back to navigator.language. */
  getSystemLocale?(): Promise<Locale>;

  /** Register release notes after an update completes; returns a disposer. */
  onPostUpdateReleaseNotes(callback: (payload: PostUpdateReleaseNotesPayload) => void): () => void;

  /** Mark the current release notes as read so the main process can clear persisted state. */
  acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;

  /** User confirmed restarting to install the update. */
  quitAndInstallUpdate(): Promise<void>;

  /** 获取已安装编辑器/终端；传文件路径时追加匹配类型的本机应用（含图标）。 */
  getInstalledEditors(filePath?: string): Promise<EditorInfo[]>;

  /** Open a path with the specified editor. */
  openInEditor(
    editorId: string,
    path: string,
    options?: OpenInEditorOptions,
  ): Promise<{ success: boolean; error?: string }>;

  /** Execute a desktop-window command (title-bar menu, zoom, window controls, etc.).
   *  The return value comes directly from the main-process handler (most commands return nothing;
   *  GetCuaOsSupport returns CuaOsSupport), so the type is widened to unknown. */
  executeDesktopCommand(command: DesktopCommandId): Promise<unknown>;

  /** Sync the app menu language so the main process rebuilds the native menu. */
  setApplicationLocale(locale: Locale): Promise<void>;

  /** Sync the desktop title-bar light/dark theme to update native window-control button colors. */
  setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;

  /** Get a stable identifier for the current device.
   *
   * - Desktop: SHA-256 based on the userData path, stable and unique.
   * - Mobile (Web remote control): hardware-property fingerprint (browserPlatform | screen.width | screen.height | colorDepth),
   *   resistant to browser/network/language/time-zone changes and changes only when the phone changes.
   */
  getDeviceId(): string;
}
