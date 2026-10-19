import { installPluginSandboxHostBridge } from "./pluginSandbox/hostBridge.js";
import {
  databaseStartupControlSchema,
  databaseStartupStateSchema,
  databaseStartupPortPayloadSchema,
} from "@zcode/shared";
/* eslint-disable max-lines -- The preload bridge centralizes desktop platform IPC; splitting it would make contextBridge permissions harder to audit. */
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import {
  installArmsRumBridgeIpcForward,
  scheduleArmsEventBridgePatch,
} from "../shared/armsRumBridgeForward.js";

// The send closure in the ARMS frame preload does not receive the later ipcRenderer.send patch, so wrap Bridge.send as well.
installArmsRumBridgeIpcForward(ipcRenderer);
scheduleArmsEventBridgePatch();

/** Parse --device-id= from the command-line arguments. */
function parseDeviceIdFromArgs(): string {
  for (const arg of process.argv) {
    if (arg.startsWith("--device-id=")) {
      return arg.slice("--device-id=".length);
    }
  }
  return "";
}

// Expose this synchronous value before creating contextBridge so the renderer can read it before React renders.
contextBridge.exposeInMainWorld("__ZCODE_DEVICE_ID__", parseDeviceIdFromArgs());

import type {
  AppSettings,
  ApplicationIconRequest,
  BrowserViewOperationPayload,
  BrowserGuestAttachResult,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewViewportChangedPayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewportSize,
  DesktopZoomState,
  DesktopWindowChromeState,
  DesktopCommandId,
  DesktopTitleBarTheme,
  EmbeddedBrowserOpenUrlRequest,
  EmbeddedBrowserPermissionPromptEvent,
  EmbeddedBrowserPermissionResolveRequest,
  EmbeddedBrowserSitePermissionUpdateRequest,
  EmbeddedBrowserSitePermissionResetRequest,
  EmbeddedBrowserSitePermissionsSnapshot,
  Locale,
  OAuthStateRegistration,
  OpenInEditorOptions,
  RemoteTarget,
  TaskNotificationPayload,
  TelemetryRendererContext,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererHeapSample,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  BotRemoteWorkspaceReconnectedEvent,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  ZCodeStdioTapDevState,
  LoadCliMcpFromUserDirectoryRequest,
  MigrateLegacyCommonMcpRequest,
  SaveCliMcpToUserDirectoryRequest,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  SSHConfigAliasOption,
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStatus,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceTarget,
  RemoteConnectionRuntimeLog,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
  CreateTempTextAttachmentRequest,
  MaterializeWorkflowArtifactFileRequest,
  OpenCuaPermissionOnboardingOptions,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
} from "@zcode/shared";
import {
  InternalChannels,
  PlatformChannels,
  formatZCodeRendererProcessName,
  shouldEnableE2ETestBridge,
} from "@zcode/shared";
import { createOAuthCallbackHandler } from "./oauthCallbackBridge.js";

if (shouldEnableE2ETestBridge(process.env)) {
  contextBridge.exposeInMainWorld("__zcodeFinalArmsCustomEventsE2E", {
    read: (): Promise<FinalArmsCustomEventE2EEntry[]> =>
      ipcRenderer.invoke(PlatformChannels.ReadFinalArmsCustomEventsE2E),
    clear: (): Promise<void> => ipcRenderer.invoke(PlatformChannels.ClearFinalArmsCustomEventsE2E),
    configure: (request: ConfigureFinalArmsCustomEventE2ERequest): Promise<void> =>
      ipcRenderer.invoke(PlatformChannels.ConfigureFinalArmsCustomEventsE2E, request),
  });
}

const updateReadyCallbacks = new Set<(version: string) => void>();
const updateStateCallbacks = new Set<(payload: UpdateStatePayload) => void>();
const postUpdateReleaseNotesCallbacks = new Set<(payload: PostUpdateReleaseNotesPayload) => void>();
const openWorkspacePathCallbacks = new Set<(path: string) => void>();
let latestReadyUpdateVersion: string | null = null;
let latestUpdateState: UpdateStatePayload | null = null;
let latestPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
const pendingOpenWorkspacePaths: string[] = [];
type OpenTaskDraftPayload = { path: string; text: string };
const openTaskDraftCallbacks = new Set<(payload: OpenTaskDraftPayload) => void>();
const pendingOpenTaskDrafts: OpenTaskDraftPayload[] = [];
const shareImportCallbacks = new Set<(payload: { shareCode: string }) => void>();
const pendingShareImports: { shareCode: string }[] = [];
const MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX = 136;
const WINDOWS_TITLE_BAR_HEIGHT_PX = 48;
const DESKTOP_ZOOM_FACTOR_STEP = 1.1;
const DESKTOP_ZOOM_MIN_LEVEL = -3;
const DESKTOP_ZOOM_MAX_LEVEL = 5;
let latestWindowControlsOverlayMetrics: WindowControlsOverlayMetrics | null = null;
let latestDesktopZoomLevel = 0;

function clampDesktopZoomLevel(level: number) {
  return Math.min(DESKTOP_ZOOM_MAX_LEVEL, Math.max(DESKTOP_ZOOM_MIN_LEVEL, level));
}

function resolveDesktopZoomLevelFromFactor(zoomFactor: number) {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    return 0;
  }

  return clampDesktopZoomLevel(
    Math.round(Math.log(zoomFactor) / Math.log(DESKTOP_ZOOM_FACTOR_STEP)),
  );
}

function resolveDesktopZoomFactorForLevel(level: number) {
  return Math.pow(DESKTOP_ZOOM_FACTOR_STEP, clampDesktopZoomLevel(level));
}

function readCurrentWindowControlsOverlayReadyPayload(): WindowControlsOverlayReadyPayload {
  const zoomLevel = resolveDesktopZoomLevelFromFactor(webFrame.getZoomFactor());
  const zoomFactor = resolveDesktopZoomFactorForLevel(zoomLevel);
  const metrics: WindowControlsOverlayMetrics =
    process.platform === "darwin"
      ? {
          leftPaddingPx: Math.round(MACOS_WINDOW_CONTROLS_BASE_LEFT_PADDING_PX / zoomFactor),
        }
      : process.platform === "win32"
        ? {
            rightPaddingPx: Math.round(WINDOWS_WINDOW_CONTROLS_BASE_RIGHT_PADDING_PX / zoomFactor),
            titleBarHeightPx: Math.round(WINDOWS_TITLE_BAR_HEIGHT_PX * zoomFactor),
          }
        : {};
  return {
    zoomLevel,
    metrics,
  };
}

function readCurrentWindowControlsOverlayMetrics(): WindowControlsOverlayMetrics {
  return readCurrentWindowControlsOverlayReadyPayload().metrics;
}

const initialWindowControlsOverlayPayload = readCurrentWindowControlsOverlayReadyPayload();
latestDesktopZoomLevel = initialWindowControlsOverlayPayload.zoomLevel;
latestWindowControlsOverlayMetrics = initialWindowControlsOverlayPayload.metrics;
// Main needs the traffic-light position for the current zoom level before RootStartupLoading renders.
// Preload runs before the React page, so notify main now instead of waiting until the App page opens.
ipcRenderer.send(PlatformChannels.WindowControlsOverlayReady, initialWindowControlsOverlayPayload);

ipcRenderer.on(
  PlatformChannels.WindowControlsOverlayChanged,
  (_event: unknown, metrics: WindowControlsOverlayMetrics) => {
    latestWindowControlsOverlayMetrics = metrics;
  },
);

ipcRenderer.on(
  PlatformChannels.DesktopZoomLevelChanged,
  (_event: unknown, state: DesktopZoomState) => {
    if (Number.isFinite(state.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
  },
);

ipcRenderer.on(PlatformChannels.OpenWorkspacePath, (_event: unknown, path: string) => {
  if (openWorkspacePathCallbacks.size === 0) {
    // On cold start, main sends open-workspace as soon as the renderer is ready, but React's platform
    // effect may not yet have registered onOpenWorkspacePath. Hold the IPC here and replay it after the
    // UI subscribes, so the app opens the workspace as well as the window.
    pendingOpenWorkspacePaths.push(path);
    return;
  }

  for (const callback of openWorkspacePathCallbacks) {
    callback(path);
  }
});

ipcRenderer.on(PlatformChannels.OpenTaskDraft, (_event: unknown, payload: OpenTaskDraftPayload) => {
  if (openTaskDraftCallbacks.size === 0) {
    // Same cold-start race as OpenWorkspacePath: hold the draft until the UI subscribes.
    pendingOpenTaskDrafts.push(payload);
    return;
  }
  for (const callback of openTaskDraftCallbacks) {
    callback(payload);
  }
});

ipcRenderer.on(PlatformChannels.ShareImport, (_event: unknown, payload: { shareCode: string }) => {
  if (shareImportCallbacks.size === 0) {
    pendingShareImports.push(payload);
    return;
  }
  for (const callback of shareImportCallbacks) callback(payload);
});

function updateRendererProcessTitle(): void {
  process.title = formatZCodeRendererProcessName(document.title);
}

function notifyUpdateReadyCallbacks(version: string): void {
  latestReadyUpdateVersion = version;
  for (const callback of updateReadyCallbacks) {
    callback(version);
  }
}

function notifyPostUpdateReleaseNotesCallbacks(payload: PostUpdateReleaseNotesPayload): void {
  latestPostUpdateReleaseNotes = payload;
  for (const callback of postUpdateReleaseNotesCallbacks) {
    callback(payload);
  }
}

function notifyUpdateStateCallbacks(payload: UpdateStatePayload): void {
  latestUpdateState = payload;
  // UpdateReady is a one-time cache for compatibility with the old interaction, but Squirrel.Mac may
  // report a staging error after update-downloaded. Main then broadcasts idle/error, so preload must
  // clear the old ready state at the same time; otherwise React receives a stale version when it subscribes again.
  latestReadyUpdateVersion = payload.kind === "update-downloaded" ? payload.version : null;
  for (const callback of updateStateCallbacks) {
    callback(payload);
  }
}

// Improve process search: the renderer usually appears in the system as a generic helper name, so add a
// zcode-* title during preload to make filtering by window role easier.
updateRendererProcessTitle();
window.addEventListener("DOMContentLoaded", updateRendererProcessTitle, {
  once: true,
});

/**
 * Preload bridge exposing only platform operations that require main-process participation.
 *
 * Credential management has moved to the host process's ICredentialService and is accessed through
 * MessagePort RPC instead of this bridge.
 */
contextBridge.exposeInMainWorld("zcode", {
  connectRemote: (
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath: string;
      workspaceIdentity?: string;
      connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
    },
  ) =>
    ipcRenderer.invoke(PlatformChannels.ConnectRemote, {
      target: options,
      requestId,
      ...(context ? context : {}),
    }),
  cancelPendingRemoteConnection: (requestId?: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.CancelPendingRemoteConnection, {
      requestId,
    }),
  bindRemoteWorkspaceSessionContext: (context: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BindRemoteWorkspaceSessionContext, context),
  startWebRemoteControl: (context: WebRemoteControlContext) =>
    ipcRenderer.invoke(PlatformChannels.StartWebRemoteControl, context),
  refreshWebRemoteControlPairing: (context: WebRemoteControlContext) =>
    ipcRenderer.invoke(PlatformChannels.ResetWebRemoteControlPairing, context),
  stopWebRemoteControl: (): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StopWebRemoteControl),
  getWebRemoteControlStatus: () => ipcRenderer.invoke(PlatformChannels.GetWebRemoteControlStatus),
  onWebRemoteControlStatusChanged: (
    callback: (status: WebRemoteControlStatus) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: WebRemoteControlStatus) => callback(payload);
    ipcRenderer.on(PlatformChannels.WebRemoteControlStatusChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.WebRemoteControlStatusChanged, handler);
  },
  disposeRemoteSession: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.DisposeRemoteSession, sessionId),
  isDockerAvailable: (): Promise<boolean> => ipcRenderer.invoke(PlatformChannels.IsDockerAvailable),
  listWSLDistros: () => ipcRenderer.invoke(PlatformChannels.ListWSLDistros),
  listDockerContainers: () => ipcRenderer.invoke(PlatformChannels.ListDockerContainers),
  listSSHConfigAliases: (): Promise<SSHConfigAliasOption[]> =>
    ipcRenderer.invoke(PlatformChannels.ListSSHConfigAliases),
  loadMcpFromUserDirectory: (payload?: LoadCliMcpFromUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.LoadMcpFromUserDirectory, payload ?? {}),
  saveMcpToUserDirectory: (payload: SaveCliMcpToUserDirectoryRequest) =>
    ipcRenderer.invoke(PlatformChannels.SaveMcpToUserDirectory, payload),
  migrateLegacyCommonMcp: (payload?: MigrateLegacyCommonMcpRequest) =>
    ipcRenderer.invoke(PlatformChannels.MigrateLegacyCommonMcp, payload ?? {}),
  /** Send renderer logs through IPC for centralized storage in main. */
  log: (level: "info" | "warn" | "error", args: unknown[]) =>
    ipcRenderer.send(PlatformChannels.Log, { level, args }),
  /** Open the system directory picker and return the selected path or null. */
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectory),
  /** App-managed worktree storage directory for the "global" location mode. */
  getAppWorktreesDir: (): Promise<string> =>
    ipcRenderer.invoke(PlatformChannels.GetAppWorktreesDir),
  /** Apply/release the system-wide output mute used while voice dictation records (spec: docs/ui/voice-dictation-feedback-sounds.md). */
  setDictationSystemMute: (active: boolean): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.SetDictationSystemMute, { active }),
  /** Open the system file picker and return the selected file path or null. */
  selectFile: (): Promise<string | null> => ipcRenderer.invoke(PlatformChannels.SelectFile),
  /** Open the system multi-file picker and return selected paths; return an empty array when cancelled. */
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke(PlatformChannels.SelectFiles),
  /** Save to disk through the native Save As dialog in main. */
  saveFile: (payload: SaveFileRequest): Promise<SaveFileResult> =>
    ipcRenderer.invoke(PlatformChannels.SaveFile, payload),
  /** Export the current page's print layout as a PDF using Chromium's print engine and vector text. */
  printPageToPdf: (): Promise<PrintPageToPdfResult> =>
    ipcRenderer.invoke(PlatformChannels.PrintToPdf),
  /** Resolve the real local path for a Web File obtained from a system drag or file input. */
  getPathForFile: (file: File): string | null => {
    // Electron 32 removed the non-standard File.path, so the renderer cannot read a path from a dropped
    // File directly. webUtils is safe to use only in preload; return null when no path is available so
    // Web/inline attachment handling can fall back.
    const path = webUtils.getPathForFile(file).trim();
    return path.length > 0 ? path : null;
  },
  /** Persist a long-text paste as a local attachment so the message body and prompt payload stay small. */
  createTempTextAttachment: (payload: CreateTempTextAttachmentRequest) =>
    ipcRenderer.invoke(PlatformChannels.CreateTempTextAttachment, payload),
  /** "Open as file" for dwf artifacts: materialize one version's bytes as a local copy. */
  materializeWorkflowArtifactFile: (payload: MaterializeWorkflowArtifactFileRequest) =>
    ipcRenderer.invoke(PlatformChannels.MaterializeWorkflowArtifactFile, payload),
  /** Subscribe to remote connection progress logs in the current window; return a disposer. */
  onRemoteConnectionLog: (callback: (entry: RemoteConnectionRuntimeLog) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteConnectionRuntimeLog);
    ipcRenderer.on(PlatformChannels.RemoteConnectionLog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteConnectionLog, handler);
  },
  /** Subscribe to remote session close events in the current window; return a disposer. */
  onRemoteSessionClosed: (callback: (event: RemoteSessionClosedEvent) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteSessionClosedEvent);
    ipcRenderer.on(PlatformChannels.RemoteSessionClosed, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionClosed, handler);
  },
  /** Subscribe to successful remote workspace reconnects triggered by a Bot; return a disposer. */
  onBotRemoteWorkspaceReconnected: (
    callback: (event: BotRemoteWorkspaceReconnectedEvent) => void,
  ) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as BotRemoteWorkspaceReconnectedEvent);
    ipcRenderer.on(PlatformChannels.BotRemoteWorkspaceReconnected, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BotRemoteWorkspaceReconnected, handler);
  },
  /** Check whether the directory is already open in another window. */
  activateOrSetWorkspace: (path: string): Promise<{ activated: boolean }> =>
    ipcRenderer.invoke(PlatformChannels.ActivateOrSetWorkspace, path),
  /** Sync the workspace paths for all tabs in this window to main. */
  syncWindowTabs: (paths: string[]) => ipcRenderer.send(PlatformChannels.SyncWindowTabs, paths),
  /** Sync the workspaces that Web remote control may switch to in this window. */
  syncWebRemoteControlWorkspaces: (workspaces: WebRemoteControlWorkspaceTarget[]) =>
    ipcRenderer.send(PlatformChannels.SyncWebRemoteControlWorkspaces, workspaces),
  /** Sync task snapshots that Web remote control may display in this window. */
  syncWebRemoteControlTasks: (tasks: WebRemoteControlTaskTarget[]) =>
    ipcRenderer.send(PlatformChannels.SyncWebRemoteControlTasks, tasks),
  onWebRemoteControlReconnectWorkspace: (
    callback: (
      request: WebRemoteControlReconnectWorkspaceRequest,
    ) => Promise<WebRemoteControlReconnectWorkspaceResult>,
  ) => {
    const handler = async (event: Electron.IpcRendererEvent, payload: unknown) => {
      const request = payload as WebRemoteControlReconnectWorkspaceRequest;
      try {
        const result = await callback(request);
        event.sender.send(PlatformChannels.WebRemoteControlReconnectWorkspace, result);
      } catch (error) {
        event.sender.send(PlatformChannels.WebRemoteControlReconnectWorkspace, {
          requestId: request.requestId,
          workspaceKey: request.workspaceKey,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WebRemoteControlReconnectWorkspaceResult);
      }
    };
    ipcRenderer.on(PlatformChannels.WebRemoteControlReconnectWorkspace, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.WebRemoteControlReconnectWorkspace, handler);
  },
  /** Sync the unread task count for this window to main. */
  syncWindowUnreadCount: (count: number) =>
    ipcRenderer.send(PlatformChannels.SyncWindowUnreadCount, count),
  syncActiveTaskSession: (sessionId: string | null) =>
    ipcRenderer.send(PlatformChannels.SyncActiveTaskSession, sessionId),
  /** Sync application settings that main needs to observe immediately. */
  syncAppSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.send(PlatformChannels.SyncAppSettings, patch),
  /** Query the close-to-tray capability (used to gray out the action on Linux; spec: docs/desktop/linux-close-to-tray.md). */
  getCloseToTrayCapability: () => ipcRenderer.invoke(PlatformChannels.GetCloseToTrayCapability),
  /** Shortcut settings recording toggle: temporarily remove configurable menu accelerators in main so recorded keys do not trigger their commands. */
  setShortcutRecordingActive: (active: boolean) =>
    ipcRenderer.send(PlatformChannels.SetShortcutRecordingActive, active),
  /** Register a callback for main to focus a workspace tab; return a disposer. */
  onFocusTab: (callback: (path: string) => void): (() => void) => {
    const handler = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on(PlatformChannels.FocusTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.FocusTab, handler);
  },
  /** Register a callback for main to create a new tab; return a disposer. */
  onNewTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTab, handler);
  },
  /** Register a callback for main to close the current context; return a disposer. */
  onCloseActiveContextRequest: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.CloseActiveContextRequest, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.CloseActiveContextRequest, handler);
  },
  /** Register requests for controlled new pages from the built-in webview; return a disposer. */
  onOpenBrowserUrl: (callback: (request: EmbeddedBrowserOpenUrlRequest) => void): (() => void) => {
    const handler = (_event: unknown, request: EmbeddedBrowserOpenUrlRequest) => callback(request);
    ipcRenderer.on(PlatformChannels.OpenBrowserUrl, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenBrowserUrl, handler);
  },
  /** Register built-in browser permission/origin-selection/device-selection prompt requests; return a disposer. */
  onEmbeddedBrowserPermissionPrompt: (
    callback: (event: EmbeddedBrowserPermissionPromptEvent) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: EmbeddedBrowserPermissionPromptEvent) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.EmbeddedBrowserPermissionPrompt, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.EmbeddedBrowserPermissionPrompt, handler);
  },
  /** Return the user's decision for a built-in browser permission prompt. */
  resolveEmbeddedBrowserPermissionPrompt: (
    request: EmbeddedBrowserPermissionResolveRequest,
  ): void => {
    ipcRenderer.send(PlatformChannels.EmbeddedBrowserPermissionResolve, request);
  },
  /** Read built-in browser site permission records (settings page "Site permissions"). */
  getEmbeddedBrowserSitePermissions: (): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.GetEmbeddedBrowserSitePermissions),
  /** Update or delete a single site permission record. */
  setEmbeddedBrowserSitePermission: (
    request: EmbeddedBrowserSitePermissionUpdateRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.SetEmbeddedBrowserSitePermission, request),
  /** Clear all site permission records. */
  clearEmbeddedBrowserSitePermissions: (): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserSitePermissions),
  /** Reset all permission records for a single site. */
  resetEmbeddedBrowserSitePermission: (
    request: EmbeddedBrowserSitePermissionResetRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.ResetEmbeddedBrowserSitePermission, request),
  /** Register a callback when the agent's first browser command creates a controlled view (automatically open a browser-use tab); return a disposer. */
  onBrowserViewReady: (
    callback: (payload: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        workspaceKey: string;
        remoteSessionId?: string;
        sessionId: string;
        tabId: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewReady, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewReady, handler);
  },
  /** Register a callback for agent browser-use operations on a real tab; return a disposer. */
  onBrowserViewOperation: (
    callback: (payload: BrowserViewOperationPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewOperationPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewOperation, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewOperation, handler);
  },
  /** Register a callback for viewport changes in the controlled tab, used to sync free-size mode while the Agent configures it. */
  onBrowserViewViewportChanged: (
    callback: (payload: BrowserViewViewportChangedPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewViewportChangedPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewViewportChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewViewportChanged, handler);
  },
  onBrowserViewScreenshotSurfacePrepare: (
    callback: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfacePreparePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfacePrepare, handler);
  },
  onBrowserViewScreenshotSurfaceRelease: (
    callback: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewScreenshotSurfaceReleasePayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.BrowserViewScreenshotSurfaceRelease, handler);
  },
  browserViewScreenshotSurfaceReady: (payload: BrowserViewScreenshotSurfaceReadyPayload): void => {
    ipcRenderer.send(PlatformChannels.BrowserViewScreenshotSurfaceReady, payload);
  },
  onBrowserViewVisibility: (
    callback: (payload: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    }) => void,
  ): (() => void) => {
    const handler = (
      _event: unknown,
      payload: {
        visible: boolean;
        workspaceKey: string;
        remoteSessionId: string | undefined;
        sessionId: string;
        tabId?: string;
        browserId: string;
        browserGeneration: number;
      },
    ) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewVisibility, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewVisibility, handler);
  },
  /** Register a callback for the agent's close command to unload a controlled tab; return a disposer. */
  onBrowserViewCloseTab: (
    callback: (payload: BrowserViewCloseTabNotification) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewCloseTabNotification) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewCloseTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewCloseTab, handler);
  },
  onBrowserViewSuspend: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewSuspend, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewSuspend, handler);
  },
  onBrowserViewRestore: (
    callback: (payload: BrowserViewResidencyTransitionPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewResidencyTransitionPayload) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewRestore, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewRestore, handler);
  },
  /** Register a callback for main to create a new task; return a disposer. */
  onNewTask: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTask, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTask, handler);
  },
  /** Register a callback for main to open a workspace; return a disposer. */
  onOpenWorkspace: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenWorkspace, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenWorkspace, handler);
  },
  /** Register a callback to open a local workspace directory directly from a deep link; return a disposer. */
  onOpenWorkspacePath: (callback: (path: string) => void): (() => void) => {
    openWorkspacePathCallbacks.add(callback);
    while (pendingOpenWorkspacePaths.length > 0) {
      const path = pendingOpenWorkspacePaths.shift();
      if (path) {
        callback(path);
      }
    }
    return () => openWorkspacePathCallbacks.delete(callback);
  },
  /** Register a callback for `zcode://task/new` drafts; replays drafts that arrived before subscription. */
  onOpenTaskDraft: (callback: (payload: OpenTaskDraftPayload) => void): (() => void) => {
    openTaskDraftCallbacks.add(callback);
    while (pendingOpenTaskDrafts.length > 0) {
      const payload = pendingOpenTaskDrafts.shift();
      if (payload) {
        callback(payload);
      }
    }
    return () => openTaskDraftCallbacks.delete(callback);
  },
  onOpenFeedbackDialog: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenFeedbackDialog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenFeedbackDialog, handler);
  },
  onOpenTicketsPanel: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenTicketsPanel, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenTicketsPanel, handler);
  },
  /** Register a callback for window fullscreen changes; return a disposer. */
  onWindowFullscreenChanged: (callback: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_event: unknown, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on(PlatformChannels.WindowFullscreenChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowFullscreenChanged, handler);
  },
  /** Read the window's maximized state and native system corner support. */
  getDesktopWindowChromeState: (): Promise<DesktopWindowChromeState> =>
    ipcRenderer.invoke(PlatformChannels.GetDesktopWindowChromeState),
  /** Register a callback for changes to the window's maximized state and native system corner support. */
  onDesktopWindowChromeStateChanged: (
    callback: (state: DesktopWindowChromeState) => void,
  ): (() => void) => {
    const handler = (_event: unknown, state: DesktopWindowChromeState) => callback(state);
    ipcRenderer.on(PlatformChannels.DesktopWindowChromeStateChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.DesktopWindowChromeStateChanged, handler);
  },
  /** Synchronously read the current safe inset for the native window controls. */
  getWindowControlsOverlayMetrics: (): WindowControlsOverlayMetrics =>
    latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics(),
  /** Register a callback for changes to the native window-control safe inset; return a disposer. */
  onWindowControlsOverlayChanged: (
    callback: (metrics: WindowControlsOverlayMetrics) => void,
  ): (() => void) => {
    const handler = (_event: unknown, metrics: WindowControlsOverlayMetrics) => callback(metrics);
    callback(latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics());
    ipcRenderer.on(PlatformChannels.WindowControlsOverlayChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowControlsOverlayChanged, handler);
  },
  /** Synchronously read the page zoom level for the current desktop window. */
  getDesktopZoomLevel: async (): Promise<DesktopZoomState> => {
    const state = await ipcRenderer.invoke(PlatformChannels.GetDesktopZoomLevel);
    if (Number.isFinite(state?.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
    return { zoomLevel: latestDesktopZoomLevel };
  },
  /** Register a callback for page zoom changes in the current desktop window; return a disposer. */
  onDesktopZoomLevelChanged: (callback: (state: DesktopZoomState) => void): (() => void) => {
    const handler = (_event: unknown, state: DesktopZoomState) => {
      if (!Number.isFinite(state.zoomLevel)) {
        return;
      }
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
      callback({ zoomLevel: latestDesktopZoomLevel });
    };
    callback({ zoomLevel: latestDesktopZoomLevel });
    ipcRenderer.on(PlatformChannels.DesktopZoomLevelChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.DesktopZoomLevelChanged, handler);
  },
  /** Register a callback to open the relevant task when the user clicks a system notification; return a disposer. */
  onTaskNotificationClick: (callback: (taskId: string) => void): (() => void) => {
    const handler = (_event: unknown, taskId: string) => callback(taskId);
    ipcRenderer.on(PlatformChannels.TaskNotificationClick, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.TaskNotificationClick, handler);
  },
  /** Open an external URL, for example to continue OAuth in a browser. */
  openExternal: (url: string) => ipcRenderer.send(PlatformChannels.OpenExternal, url),
  /** Check whether a user community entry is available for the current language. */
  canOpenCommunity: (locale: Locale): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.CanOpenCommunity, locale),
  /** Open the specified path in the system file manager. */
  openInFileManager: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenInFileManager, path),
  /** Open a local file with the system's default application. */
  openExternalFile: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenExternalFile, path),
  /** Open the full ZCode Computer Use permission guide. */
  openCuaPermissionOnboarding: (options?: OpenCuaPermissionOnboardingOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenCuaPermissionOnboarding, options),
  /** Cancel only the onboarding participant started by this renderer with operationId. */
  cancelCuaPermissionOnboarding: (operationId: string) =>
    ipcRenderer.send(PlatformChannels.CancelCuaPermissionOnboarding, {
      operationId,
    }),
  /** Warm and cache the verified Helper path so dragstart can call startDrag synchronously without missing the gesture due to async I/O. */
  prepareCuaHelperPermissionDrag: () =>
    ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  /** Drag Helper.app from the permission panel into the macOS permission list. Use send; invoke's round trip misses the gesture. */
  startCuaHelperPermissionDrag: () =>
    ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
  /** Report OAuth state for deep-link routing. */
  registerOAuthState: (payload: OAuthStateRegistration) =>
    ipcRenderer.send(PlatformChannels.OAuthRegisterState, payload),
  /** Register an OAuth deep-link callback; return a disposer. */
  onOAuthCallback: (cb: (url: string) => void): (() => void) => {
    const handler = createOAuthCallbackHandler(cb, () => {
      ipcRenderer.send(PlatformChannels.OAuthCallbackHandled);
    });
    ipcRenderer.on(PlatformChannels.OAuthCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OAuthCallback, handler);
  },
  /** Register a payment deep-link callback; return a disposer. */
  onPaymentCallback: (callback: (url: string) => void): (() => void) => {
    const handler = (_event: unknown, url: string) => callback(url);
    ipcRenderer.on(PlatformChannels.PaymentCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.PaymentCallback, handler);
  },
  onShareImport: (callback: (payload: { shareCode: string }) => void): (() => void) => {
    shareImportCallbacks.add(callback);
    while (pendingShareImports.length > 0) {
      const payload = pendingShareImports.shift();
      if (payload) callback(payload);
    }
    return () => shareImportCallbacks.delete(callback);
  },
  /** Notify main that the renderer is ready. */
  notifyRendererReady: () => ipcRenderer.send(PlatformChannels.RendererReady),
  /** Sync renderer telemetry context to main. */
  syncTelemetryContext: (context: TelemetryRendererContext) =>
    ipcRenderer.send(PlatformChannels.SyncTelemetryContext, context),
  /** Report product telemetry events through main. */
  reportTelemetryEvent: (payload: {
    context: TelemetryRendererContext;
    elementName: string;
    eventRegion: string;
    eventType: string;
    eventText?: string;
    eventExtraDetail: Record<string, string>;
    userId?: string;
    talkId?: string;
    messageId?: string;
  }) => ipcRenderer.invoke(PlatformChannels.ReportTelemetryEvent, payload),
  /** Report custom ARMS events through main. */
  reportArmsCustomEvent: (payload: {
    name: string;
    group: string;
    value?: number;
    properties?: Record<string, string | number | boolean | undefined>;
  }) => ipcRenderer.invoke(PlatformChannels.ReportArmsCustomEvent, payload),
  /** Read the rollout configuration for Renderer user-action tracing. */
  getRendererActionTraceConfig: (): Promise<RendererActionTraceConfigV1> =>
    ipcRenderer.invoke(PlatformChannels.GetRendererActionTraceConfig),
  /** Subscribe to Renderer user-action trace configuration changes sent by Main. */
  onRendererActionTraceConfigChanged: (
    callback: (config: RendererActionTraceConfigV1) => void,
  ): (() => void) => {
    const handler = (_event: unknown, config: RendererActionTraceConfigV1) => callback(config);
    ipcRenderer.on(PlatformChannels.RendererActionTraceConfigChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.RendererActionTraceConfigChanged, handler);
  },
  /** Send a completed span; use send so a telemetry round trip does not block product behavior. */
  reportLocalTtftBatch: (batch: import("@zcode/shared").LocalTtftBatch): void =>
    ipcRenderer.send(PlatformChannels.ReportLocalTtftBatch, batch),
  reportRendererActionTraceBatch: (batch: RendererActionTraceBatchV1): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererActionTraceBatch, batch),
  /**
   * 60-second heap readings from the main-window renderer.
   * This is a one-way send: main does not acknowledge it, and the renderer cannot use it to inspect main-process state.
   */
  reportRendererHeapSample: (sample: RendererHeapSample): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererHeapSample, sample),
  /** Trigger a native task notification through main. */
  showTaskNotification: (payload: TaskNotificationPayload) =>
    ipcRenderer.send(PlatformChannels.ShowTaskNotification, payload),
  /** Export logs by zipping ~/.zcode/v2 and external agent logs, then reveal the archive in Finder. */
  exportLogs: (): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> => ipcRenderer.invoke(PlatformChannels.ExportLogs),
  /** Capture the current window so an error report can include the current screen. */
  captureWindowScreenshot: () => ipcRenderer.invoke(PlatformChannels.CaptureWindowScreenshot),
  // CDP-on-guest pivot: report the `<webview>` guest webContentsId to main for attachment after dom-ready.
  browserViewAttachGuest: (payload: {
    key: string;
    webContentsId: number;
    active?: boolean;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    residencyGeneration?: number;
  }): Promise<BrowserGuestAttachResult> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewAttachGuest, payload),
  /** Synchronously wait for main to disconnect the native CDP session before React unloads the old `<webview>`. */
  browserViewDetachGuest: (payload: { key: string; webContentsId: number }): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewDetachGuest, payload),
  browserViewCloseTab: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewCloseTabFromRenderer, payload),
  browserViewReportResidency: (payload: BrowserViewResidencyReportPayload): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewReportResidency, payload),
  browserViewSuspendReady: (payload: { tabId: string; generation: number }): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewSuspendReady, payload),
  browserViewEnsureResident: (payload: BrowserViewCloseTabRequest): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewEnsureResident, payload),
  browserViewRestoreTabs: (
    payload: BrowserViewRestoreTabsRequest,
  ): Promise<BrowserViewRestoredTabShell[]> =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewRestoreTabs, payload),
  /** Sync the UI's free-size setting to the actual viewport of the currently controlled tab. */
  browserViewUpdateViewport: (payload: { tabId: string; viewport: BrowserViewportSize | null }) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewUpdateViewport, payload),
  /** Import built-in browser data once from an automatically discovered Chrome profile. */
  importChromeBrowserData: (options?: import("@zcode/shared").ChromeBrowserDataImportOptions) =>
    ipcRenderer.invoke(PlatformChannels.ImportChromeBrowserData, options),
  /** Clear the built-in browser cache or all site data. */
  clearEmbeddedBrowserData: (mode: "cache" | "all") =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserData, mode),
  /** Read whether the stdio tap proxy is enabled in development. */
  getZCodeStdioTapDevState: (): Promise<ZCodeStdioTapDevState> =>
    ipcRenderer.invoke(PlatformChannels.GetZCodeStdioTapDevState),
  /** Register a callback for settings changes made by main; return a disposer. */
  onSettingsChanged: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.SettingsChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.SettingsChanged, handler);
  },
  /** Register a callback for application language changes; return a disposer. */
  onApplicationLocaleChanged: (callback: (locale: Locale) => void): (() => void) => {
    const handler = (_event: unknown, locale: Locale) => callback(locale);
    ipcRenderer.on(PlatformChannels.ApplicationLocaleChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.ApplicationLocaleChanged, handler);
  },
  /** Register a callback for the result of a manual update check; return a disposer. */
  onUpdateCheckResult: (callback: (payload: UpdateCheckResultPayload) => void): (() => void) => {
    const handler = (_event: unknown, payload: UpdateCheckResultPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.UpdateCheckResult, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.UpdateCheckResult, handler);
  },
  getUpdateState: (): Promise<UpdateStatePayload> =>
    ipcRenderer.invoke(PlatformChannels.GetUpdateState),
  /** Start downloading the currently available update. */
  downloadUpdate: () => ipcRenderer.invoke(PlatformChannels.DownloadUpdate),
  /** Cancel the update download in progress. */
  cancelUpdateDownload: () => ipcRenderer.invoke(PlatformChannels.CancelUpdateDownload),
  /** Open the standalone update window. */
  openUpdateStatusWindow: () => ipcRenderer.invoke(PlatformChannels.OpenUpdateStatusWindow),
  /** Read the automatic update preference. */
  getAutoUpdatePreferences: () => ipcRenderer.invoke(PlatformChannels.GetAutoUpdatePreferences),
  /** Write the "automatically download and install updates" preference. */
  setAutoDownloadAndInstallUpdates: (enabled: boolean) =>
    ipcRenderer.invoke(PlatformChannels.SetAutoDownloadAndInstallUpdates, enabled),
  getDesktopSessionActivity: () => ipcRenderer.invoke(PlatformChannels.GetDesktopSessionActivity),
  /** Register a callback for ongoing automatic update status changes; return a disposer. */
  onUpdateStateChanged: (callback: (payload: UpdateStatePayload) => void): (() => void) => {
    updateStateCallbacks.add(callback);
    if (latestUpdateState) {
      callback(latestUpdateState);
    }
    return () => {
      updateStateCallbacks.delete(callback);
    };
  },
  /** Register a callback for when a new version finishes downloading; return a disposer. */
  onUpdateReady: (callback: (version: string) => void): (() => void) => {
    // Main's update-ready is a one-time event and often arrives before React registers its effect.
    // Cache the latest version in preload and replay it immediately when a subscription is created so
    // the UI receives a stable "update downloaded" state even if it mounts later.
    updateReadyCallbacks.add(callback);
    if (latestReadyUpdateVersion) {
      callback(latestReadyUpdateVersion);
    }
    return () => {
      updateReadyCallbacks.delete(callback);
    };
  },
  /** Register a callback for release notes after an update is installed; return a disposer. */
  onPostUpdateReleaseNotes: (
    callback: (payload: PostUpdateReleaseNotesPayload) => void,
  ): (() => void) => {
    postUpdateReleaseNotesCallbacks.add(callback);
    if (latestPostUpdateReleaseNotes) {
      callback(latestPostUpdateReleaseNotes);
    }
    return () => {
      postUpdateReleaseNotesCallbacks.delete(callback);
    };
  },
  /** Mark the current release notes as read. */
  acknowledgePostUpdateReleaseNotes: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.AcknowledgePostUpdateReleaseNotes, version),
  /** Skip the currently available update version. */
  skipUpdateVersion: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.SkipUpdateVersion, version),
  /** Restart to install an update after user confirmation. */
  quitAndInstallUpdate: () => ipcRenderer.invoke(PlatformChannels.QuitAndInstallUpdate),
  /** Get installed editors/terminals, including their icons. */
  getInstalledEditors: () => ipcRenderer.invoke(PlatformChannels.GetInstalledEditors),
  getApplicationIcon: (request: string | ApplicationIconRequest) =>
    ipcRenderer.invoke(PlatformChannels.GetApplicationIcon, request),
  /** Open a path with the specified editor. */
  openInEditor: (editorId: string, path: string, options?: OpenInEditorOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenInEditor, {
      editorId,
      path,
      options,
    }),
  /** Execute a desktop window-level command. */
  executeDesktopCommand: (command: DesktopCommandId) =>
    ipcRenderer.invoke(PlatformChannels.ExecuteDesktopCommand, command),
  /** Sync the application menu language. */
  setApplicationLocale: (locale: Locale) =>
    ipcRenderer.invoke(PlatformChannels.SetApplicationLocale, locale),
  /** Read the host system language. */
  getSystemLocale: (): Promise<Locale> => ipcRenderer.invoke(PlatformChannels.GetSystemLocale),
  /** Sync the title bar's light/dark appearance. */
  setTitleBarTheme: (theme: DesktopTitleBarTheme) =>
    ipcRenderer.invoke(PlatformChannels.SetTitleBarTheme, theme),
  /** Get the desktop device identifier (deviceMid). */
  getDeviceId: () => ipcRenderer.invoke(PlatformChannels.GetDeviceId),
});

installPluginSandboxHostBridge();

/**
 * A MessagePort cannot pass through contextBridge because contextBridge wraps it in a Proxy and removes
 * native methods such as addEventListener. Use window.postMessage's transfer mechanism to pass the
 * MessagePort unchanged to the renderer's window context.
 */
ipcRenderer.on(InternalChannels.ServicePort, (event, payload: unknown) => {
  const [port] = event.ports;
  const parsed = databaseStartupPortPayloadSchema.safeParse(payload);
  if (port && parsed.success)
    window.postMessage({ type: InternalChannels.ServicePort, ...parsed.data }, "*", [port]);
  else port?.close();
});

ipcRenderer.on(
  InternalChannels.ScopedServicePort,
  (
    event,
    payload: {
      attachmentId?: string;
      sessionId?: string;
      target?: RemoteTarget;
    },
  ) => {
    const [port] = event.ports;
    if (port) {
      window.postMessage(
        {
          type: InternalChannels.ScopedServicePort,
          attachmentId: payload.attachmentId,
          sessionId: payload.sessionId,
          target: payload.target,
        },
        "*",
        [port],
      );
    }
  },
);

window.addEventListener("message", (event) => {
  if (event.source !== window || typeof event.data !== "object" || event.data === null) {
    return;
  }
  const payload = event.data as {
    type?: unknown;
    attachmentId?: unknown;
    sessionId?: unknown;
  };
  if (
    payload.type !== InternalChannels.ScopedServicePortReady ||
    typeof payload.attachmentId !== "string" ||
    !payload.attachmentId ||
    typeof payload.sessionId !== "string" ||
    !payload.sessionId
  ) {
    return;
  }
  // MessagePort registration happens in the isolated renderer world, so Main must not treat "delivered"
  // as "available." Preload only forwards the renderer's ready ACK to Main; the window session manager
  // continues to own business attachment state.
  ipcRenderer.send(InternalChannels.ScopedServicePortReady, {
    attachmentId: payload.attachmentId,
    sessionId: payload.sessionId,
  });
});

ipcRenderer.on(PlatformChannels.TaskNotificationSound, () => {
  window.postMessage(InternalChannels.TaskNotificationSound, "*");
});

ipcRenderer.on(PlatformChannels.UpdateReady, (_event, version: string) => {
  notifyUpdateReadyCallbacks(version);
});

ipcRenderer.on(PlatformChannels.UpdateStateChanged, (_event, payload: UpdateStatePayload) => {
  notifyUpdateStateCallbacks(payload);
});

ipcRenderer.on(
  PlatformChannels.PostUpdateReleaseNotes,
  (_event, payload: PostUpdateReleaseNotesPayload) => {
    notifyPostUpdateReleaseNotesCallbacks(payload);
  },
);

// If Bridge is reset after dom-ready autoInject, try wrapping it once more.
scheduleArmsEventBridgePatch();

// The startup control plane precedes regular RPC. On reload, restore it from Main's notification mirror
// without triggering another migration.
ipcRenderer.on(InternalChannels.DatabaseStartupState, (_event, raw: unknown) => {
  const parsed = databaseStartupStateSchema.safeParse(raw);
  if (parsed.success)
    window.postMessage({ type: InternalChannels.DatabaseStartupState, state: parsed.data }, "*");
});
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.type !== InternalChannels.DatabaseStartupControl)
    return;
  const parsed = databaseStartupControlSchema.safeParse(event.data.control);
  if (parsed.success) ipcRenderer.send(InternalChannels.DatabaseStartupControl, parsed.data);
});
