import { installPluginSandboxHostBridge } from "./pluginSandbox/hostBridge.js";
import {
  databaseStartupControlSchema,
  databaseStartupStateSchema,
  databaseStartupPortPayloadSchema,
  hasDesktopLocalDevelopmentRuntimeArg,
} from "@zcode/shared";
/* eslint-disable max-lines -- The preload bridge centrally exposes desktop platform IPC; splitting it up would make the contextBridge permission boundary harder to audit. */
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import {
  installArmsRumBridgeIpcForward,
  scheduleArmsEventBridgePatch,
} from "../shared/armsRumBridgeForward.js";

// The send inside the ARMS frame preload closure does not pick up the later ipcRenderer.send patch, so Bridge.send must be wrapped as well.
installArmsRumBridgeIpcForward(ipcRenderer);
scheduleArmsEventBridgePatch();

/** Parse --device-id= from the command-line arguments */
function parseDeviceIdFromArgs(): string {
  for (const arg of process.argv) {
    if (arg.startsWith("--device-id=")) {
      return arg.slice("--device-id=".length);
    }
  }
  return "";
}

// Expose the synchronous value before contextBridge is set up, so the renderer can read it before React renders
contextBridge.exposeInMainWorld("__ZCODE_DEVICE_ID__", parseDeviceIdFromArgs());
// Main's `!app.isPackaged`, the authoritative dev-only gate for this renderer.
contextBridge.exposeInMainWorld(
  "__ZCODE_IS_LOCAL_DEVELOPMENT_RUNTIME__",
  hasDesktopLocalDevelopmentRuntimeArg(process.argv),
);

import type {
  AppSettings,
  ApplicationIconRequest,
  BindRemoteWorkspaceSessionContextIpcResult,
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
  WebRemoteControlAuthStateChange,
  OpenInEditorOptions,
  FileApplicationTarget,
  RemoteTarget,
  TaskNotificationPayload,
  TelemetryRendererContext,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererHeapSample,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  RemoteSessionReconnectedEvent,
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
  WebRemoteControlRendererActionRequest,
  WebRemoteControlRendererActionResult,
  WebRemoteControlStatus,
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
  scopedServicePortPayloadSchema,
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

type OpenTaskDraftPayload = {
  path: string;
  text: string;
};
const openTaskDraftCallbacks = new Set<(payload: OpenTaskDraftPayload) => void>();
const pendingOpenTaskDrafts: OpenTaskDraftPayload[] = [];

const updateReadyCallbacks = new Set<(version: string) => void>();
const updateStateCallbacks = new Set<(payload: UpdateStatePayload) => void>();
const postUpdateReleaseNotesCallbacks = new Set<(payload: PostUpdateReleaseNotesPayload) => void>();
const openWorkspacePathCallbacks = new Set<(path: string) => void>();
let latestReadyUpdateVersion: string | null = null;
let latestUpdateState: UpdateStatePayload | null = null;
let latestPostUpdateReleaseNotes: PostUpdateReleaseNotesPayload | null = null;
const pendingOpenWorkspacePaths: string[] = [];
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
// Before RootStartupLoading renders, main must already know the traffic-light position for the current zoom.
// The preload runs earlier than the React page, so notify main proactively instead of waiting until the App page is entered.
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
    // A cold-start open-workspace is delivered from main right after renderer ready,
    // but React's platform effect may not have registered onOpenWorkspacePath yet. The preload catches
    // this IPC and replays it after the UI subscribes, so the directory is opened and not just the App.
    pendingOpenWorkspacePaths.push(path);
    return;
  }

  for (const callback of openWorkspacePathCallbacks) {
    callback(path);
  }
});

ipcRenderer.on(PlatformChannels.ShareImport, (_event: unknown, payload: { shareCode: string }) => {
  if (shareImportCallbacks.size === 0) {
    pendingShareImports.push(payload);
    return;
  }
  for (const callback of shareImportCallbacks) callback(payload);
});

ipcRenderer.on(PlatformChannels.OpenTaskDraft, (_event: unknown, payload: OpenTaskDraftPayload) => {
  if (openTaskDraftCallbacks.size === 0) {
    pendingOpenTaskDrafts.push(payload);
    return;
  }
  for (const callback of openTaskDraftCallbacks) {
    callback(payload);
  }
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
  // UpdateReady is a one-shot cache kept for backward-compatible interaction, but after update-downloaded
  // Squirrel.Mac may later report a staging error. Main then broadcasts idle/error,
  // the preload must clear the old ready state synchronously; otherwise React would replay an invalidated version on resubscribe.
  latestReadyUpdateVersion = payload.kind === "update-downloaded" ? payload.version : null;
  for (const callback of updateStateCallbacks) {
    callback(payload);
  }
}

// Process-listing UX: the renderer usually shows as a generic helper name in the system,
// so the zcode-* title is set here during the preload stage to make it easy to filter by window role.
updateRendererProcessTitle();
window.addEventListener("DOMContentLoaded", updateRendererProcessTitle, {
  once: true,
});

/**
 * Preload bridge: exposes only platform operations that need main-process participation
 *
 * Credential management has moved to the host process's ICredentialService
 * and is accessed through MessagePort RPC, no longer through this bridge.
 */
contextBridge.exposeInMainWorld("zcode", {
  connectRemote: (
    options: RemoteTarget,
    requestId?: string,
    context?: {
      workspacePath?: string;
      workspaceIdentity?: string;
      connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
      confirmSourceServerInstall?: boolean;
    },
  ) =>
    ipcRenderer.invoke(PlatformChannels.ConnectRemote, {
      target: options,
      requestId,
      ...(context ? context : {}),
    }),
  requestSourceSettingsAttachment: (sourceServerId: string) =>
    ipcRenderer.invoke(PlatformChannels.RequestSourceSettingsAttachment, {
      sourceServerId,
    }),
  cancelPendingRemoteConnection: (requestId?: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.CancelPendingRemoteConnection, {
      requestId,
    }),
  bindRemoteWorkspaceSessionContext: (context: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  }): Promise<BindRemoteWorkspaceSessionContextIpcResult> =>
    // Return the structured result as-is: an Error thrown in the preload loses its code across contextBridge,
    // so the renderer restores it.
    ipcRenderer.invoke(PlatformChannels.BindRemoteWorkspaceSessionContext, context),
  getAppWorktreesDir: (): Promise<string> =>
    ipcRenderer.invoke(PlatformChannels.GetAppWorktreesDir),
  setDictationSystemMute: (active: boolean): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.SetDictationSystemMute, { active }),
  startWebRemoteControl: (context: WebRemoteControlContext) =>
    ipcRenderer.invoke(PlatformChannels.StartWebRemoteControl, context),
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
  /** Forward renderer logs to the main process over IPC for unified storage */
  log: (level: "info" | "warn" | "error", args: unknown[]) =>
    ipcRenderer.send(PlatformChannels.Log, { level, args }),
  /** Open the system directory picker; returns the selected path or null */
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectory),
  /** Open the system multi-directory picker; returns an empty array when cancelled */
  selectDirectories: (): Promise<string[]> =>
    ipcRenderer.invoke(PlatformChannels.SelectDirectories),
  /** Open the system file picker; returns the selected file path or null */
  selectFile: (): Promise<string | null> => ipcRenderer.invoke(PlatformChannels.SelectFile),
  /** Open the system multi-file picker; returns selected file paths, or an empty array when cancelled */
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke(PlatformChannels.SelectFiles),
  /** Explicitly write to disk through the main process's native save-as dialog */
  saveFile: (payload: SaveFileRequest): Promise<SaveFileResult> =>
    ipcRenderer.invoke(PlatformChannels.SaveFile, payload),
  /** Export the current page's print media layout to PDF (Chromium print engine, vector text) */
  printPageToPdf: (): Promise<PrintPageToPdfResult> =>
    ipcRenderer.invoke(PlatformChannels.PrintToPdf),
  /** Resolve the real local path of a Web File from system drag-and-drop or file input */
  getPathForFile: (file: File): string | null => {
    // Since Electron 32 the non-standard File.path was removed; the renderer can no longer read a path directly from a dragged File.
    // webUtils may only be used safely in the preload; when no path is available, return null so Web/inline attachment logic can fall back.
    const path = webUtils.getPathForFile(file).trim();
    return path.length > 0 ? path : null;
  },
  /** Persist long pasted text to disk as a real local attachment, to avoid inflating the body and prompt payload */
  createTempTextAttachment: (payload: CreateTempTextAttachmentRequest) =>
    ipcRenderer.invoke(PlatformChannels.CreateTempTextAttachment, payload),
  /** dwf artifact "open as file": write one version's bytes out as a local copy */
  materializeWorkflowArtifactFile: (payload: MaterializeWorkflowArtifactFileRequest) =>
    ipcRenderer.invoke(PlatformChannels.MaterializeWorkflowArtifactFile, payload),
  /** Subscribe to the remote-connection process logs of the current window; returns a disposer */
  onRemoteConnectionLog: (callback: (entry: RemoteConnectionRuntimeLog) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteConnectionRuntimeLog);
    ipcRenderer.on(PlatformChannels.RemoteConnectionLog, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteConnectionLog, handler);
  },
  /** Subscribe to remote session close events of the current window; returns a disposer */
  onRemoteSessionClosed: (callback: (event: RemoteSessionClosedEvent) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteSessionClosedEvent);
    ipcRenderer.on(PlatformChannels.RemoteSessionClosed, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionClosed, handler);
  },
  /** Subscribe to the logical-session generation change after Source auto-reconnect. */
  onRemoteSessionReconnected: (callback: (event: RemoteSessionReconnectedEvent) => void) => {
    const handler = (_event: unknown, payload: unknown) =>
      callback(payload as RemoteSessionReconnectedEvent);
    ipcRenderer.on(PlatformChannels.RemoteSessionReconnected, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.RemoteSessionReconnected, handler);
  },
  /** Check whether a directory is already open in another window */
  activateOrSetWorkspace: (path: string): Promise<{ activated: boolean }> =>
    ipcRenderer.invoke(PlatformChannels.ActivateOrSetWorkspace, path),
  /** Sync the workspace paths of all tabs in the current window to the main process */
  syncWindowTabs: (paths: string[]) => ipcRenderer.send(PlatformChannels.SyncWindowTabs, paths),
  /** Sync the workspaces that the current window allows Web remote control to switch to */
  syncWebRemoteControlWorkspaces: (workspaces: WebRemoteControlWorkspaceTarget[]) =>
    ipcRenderer.send(PlatformChannels.SyncWebRemoteControlWorkspaces, workspaces),
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
  onWebRemoteControlRendererAction: (
    callback: (
      request: WebRemoteControlRendererActionRequest,
    ) => Promise<WebRemoteControlRendererActionResult>,
  ) => {
    const handler = async (event: Electron.IpcRendererEvent, payload: unknown) => {
      const request = payload as WebRemoteControlRendererActionRequest;
      try {
        event.sender.send(PlatformChannels.WebRemoteControlRendererAction, await callback(request));
      } catch (error) {
        event.sender.send(PlatformChannels.WebRemoteControlRendererAction, {
          requestId: request.requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies WebRemoteControlRendererActionResult);
      }
    };
    ipcRenderer.on(PlatformChannels.WebRemoteControlRendererAction, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.WebRemoteControlRendererAction, handler);
  },
  /** Sync the current window's unread task count to the main process */
  syncWindowUnreadCount: (count: number) =>
    ipcRenderer.send(PlatformChannels.SyncWindowUnreadCount, count),
  syncActiveTaskSession: (sessionId: string | null) =>
    ipcRenderer.send(PlatformChannels.SyncActiveTaskSession, sessionId),
  /** Sync app settings that the main process must perceive immediately */
  syncAppSettings: (patch: Partial<AppSettings>) =>
    ipcRenderer.send(PlatformChannels.SyncAppSettings, patch),
  /** Query the close-to-tray capability (grayed out on Linux; spec: docs/desktop/linux-close-to-tray.md) */
  getCloseToTrayCapability: () => ipcRenderer.invoke(PlatformChannels.GetCloseToTrayCapability),
  /** Shortcut settings page recording-state toggle: main temporarily removes configurable menu accelerators so recorded keys do not trigger the original commands */
  setShortcutRecordingActive: (active: boolean) =>
    ipcRenderer.send(PlatformChannels.SetShortcutRecordingActive, active),
  /** Register a callback for main-process requests to focus a given workspace tab; returns a disposer */
  onFocusTab: (callback: (path: string) => void): (() => void) => {
    const handler = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on(PlatformChannels.FocusTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.FocusTab, handler);
  },
  /** Register a callback for main-process requests to create a new tab; returns a disposer */
  onNewTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTab, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTab, handler);
  },
  /** Register a callback for main-process requests to close the current context; returns a disposer */
  onCloseActiveContextRequest: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.CloseActiveContextRequest, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.CloseActiveContextRequest, handler);
  },
  /** Register handling of controlled new-page requests from the built-in webview; returns a disposer */
  onOpenBrowserUrl: (callback: (request: EmbeddedBrowserOpenUrlRequest) => void): (() => void) => {
    const handler = (_event: unknown, request: EmbeddedBrowserOpenUrlRequest) => callback(request);
    ipcRenderer.on(PlatformChannels.OpenBrowserUrl, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenBrowserUrl, handler);
  },
  /** Register requests for the built-in browser's web permission, origin selection, and device selection popups; returns a disposer */
  onEmbeddedBrowserPermissionPrompt: (
    callback: (event: EmbeddedBrowserPermissionPromptEvent) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: EmbeddedBrowserPermissionPromptEvent) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.EmbeddedBrowserPermissionPrompt, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.EmbeddedBrowserPermissionPrompt, handler);
  },
  /** Send back the user's decision on the built-in browser permission popup */
  resolveEmbeddedBrowserPermissionPrompt: (
    request: EmbeddedBrowserPermissionResolveRequest,
  ): void => {
    ipcRenderer.send(PlatformChannels.EmbeddedBrowserPermissionResolve, request);
  },
  /** Read the built-in browser's site-permission records (the Settings "Website permissions" page) */
  getEmbeddedBrowserSitePermissions: (): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.GetEmbeddedBrowserSitePermissions),
  /** Modify or delete a single site-permission record */
  setEmbeddedBrowserSitePermission: (
    request: EmbeddedBrowserSitePermissionUpdateRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.SetEmbeddedBrowserSitePermission, request),
  /** Clear all site-permission records */
  clearEmbeddedBrowserSitePermissions: (): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserSitePermissions),
  /** Reset all permission records for a single site */
  resetEmbeddedBrowserSitePermission: (
    request: EmbeddedBrowserSitePermissionResetRequest,
  ): Promise<EmbeddedBrowserSitePermissionsSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.ResetEmbeddedBrowserSitePermission, request),
  /** Register a callback for downloads started in a controlled browser view; returns a disposer */
  onBrowserViewDownloadStarted: (
    callback: (payload: { webContentsId: number; urls: string[] }) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: { webContentsId: number; urls: string[] }) =>
      callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewDownloadStarted, handler);
    return () => {
      ipcRenderer.removeListener(PlatformChannels.BrowserViewDownloadStarted, handler);
    };
  },
  /** Register a callback for when an agent's first browser command creates a controlled view (automatically opens a browser-use tab); returns a disposer */
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
  /** Register a callback for the operation status when an agent browser-use command hits a real tab; returns a disposer. */
  onBrowserViewOperation: (
    callback: (payload: BrowserViewOperationPayload) => void,
  ): (() => void) => {
    const handler = (_event: unknown, payload: BrowserViewOperationPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.BrowserViewOperation, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.BrowserViewOperation, handler);
  },
  /** Register a callback for changes to the controlled tab viewport; the Agent setting uses it to sync free-size mode. */
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
  /** Register a callback that asks for the controlled tab to be unmounted on an agent close command; returns a disposer */
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
  /** Register a callback for main-process requests to create a new task; returns a disposer */
  onNewTask: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.NewTask, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.NewTask, handler);
  },
  /** Register a callback for main-process requests to open a workspace; returns a disposer */
  onOpenWorkspace: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.OpenWorkspace, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OpenWorkspace, handler);
  },
  /** Register a callback for deep links that open a local workspace directory directly; returns a disposer */
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
  /** Register a callback for window fullscreen state changes; returns a disposer */
  onWindowFullscreenChanged: (callback: (isFullscreen: boolean) => void): (() => void) => {
    const handler = (_event: unknown, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on(PlatformChannels.WindowFullscreenChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowFullscreenChanged, handler);
  },
  /** Read the window maximized state and the system's native corner-rounding capability */
  getDesktopWindowChromeState: (): Promise<DesktopWindowChromeState> =>
    ipcRenderer.invoke(PlatformChannels.GetDesktopWindowChromeState),
  /** Register a callback for changes to the window maximized state and native corner-rounding capability */
  onDesktopWindowChromeStateChanged: (
    callback: (state: DesktopWindowChromeState) => void,
  ): (() => void) => {
    const handler = (_event: unknown, state: DesktopWindowChromeState) => callback(state);
    ipcRenderer.on(PlatformChannels.DesktopWindowChromeStateChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.DesktopWindowChromeStateChanged, handler);
  },
  /** Synchronously read the current native window-control safe-area insets */
  getWindowControlsOverlayMetrics: (): WindowControlsOverlayMetrics =>
    latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics(),
  /** Register a callback for changes to the native window-control safe-area insets; returns a disposer */
  onWindowControlsOverlayChanged: (
    callback: (metrics: WindowControlsOverlayMetrics) => void,
  ): (() => void) => {
    const handler = (_event: unknown, metrics: WindowControlsOverlayMetrics) => callback(metrics);
    callback(latestWindowControlsOverlayMetrics ?? readCurrentWindowControlsOverlayMetrics());
    ipcRenderer.on(PlatformChannels.WindowControlsOverlayChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.WindowControlsOverlayChanged, handler);
  },
  /** Synchronously read the current desktop window page zoom level */
  getDesktopZoomLevel: async (): Promise<DesktopZoomState> => {
    const state = await ipcRenderer.invoke(PlatformChannels.GetDesktopZoomLevel);
    if (Number.isFinite(state?.zoomLevel)) {
      latestDesktopZoomLevel = clampDesktopZoomLevel(state.zoomLevel);
    }
    return { zoomLevel: latestDesktopZoomLevel };
  },
  /** Register a callback for changes to the current desktop window page zoom level; returns a disposer */
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
  /** Register a callback that navigates to the corresponding task when the user clicks a system notification; returns a disposer */
  onTaskNotificationClick: (callback: (taskId: string) => void): (() => void) => {
    const handler = (_event: unknown, taskId: string) => callback(taskId);
    ipcRenderer.on(PlatformChannels.TaskNotificationClick, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.TaskNotificationClick, handler);
  },
  /** Open an external URL (used for OAuth redirects to the browser) */
  openExternal: (url: string) => ipcRenderer.send(PlatformChannels.OpenExternal, url),
  /** Query whether a usable user community entry exists for the current language */
  canOpenCommunity: (locale: Locale): Promise<boolean> =>
    ipcRenderer.invoke(PlatformChannels.CanOpenCommunity, locale),
  /** Open the given path in the system file manager */
  openInFileManager: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenInFileManager, path),
  /** Open a local file with the system default application */
  openExternalFile: (path: string) => ipcRenderer.invoke(PlatformChannels.OpenExternalFile, path),
  /** Open the ZCode Computer Use full-permission guide */
  openCuaPermissionOnboarding: (options?: OpenCuaPermissionOnboardingOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenCuaPermissionOnboarding, options),
  /** Cancel only the onboarding participant that the current renderer started with operationId. */
  cancelCuaPermissionOnboarding: (operationId: string) =>
    ipcRenderer.send(PlatformChannels.CancelCuaPermissionOnboarding, {
      operationId,
    }),
  /** Warm up and cache a verified Helper path so dragstart can call startDrag synchronously (avoids an async I/O miss of the gesture) */
  prepareCuaHelperPermissionDrag: () =>
    ipcRenderer.invoke(PlatformChannels.PrepareCuaHelperPermissionDrag),
  /** Drag Helper.app from the permission floating window to the macOS permission list. Must be send; an invoke round trip would miss the gesture. */
  startCuaHelperPermissionDrag: () =>
    ipcRenderer.send(PlatformChannels.StartCuaHelperPermissionDrag),
  notifyWebRemoteControlAuthStateChanged: (change: WebRemoteControlAuthStateChange) =>
    ipcRenderer.send(PlatformChannels.WebRemoteControlAuthStateChanged, change),
  /** Report OAuth state for deep link routing */
  registerOAuthState: (payload: OAuthStateRegistration) =>
    ipcRenderer.send(PlatformChannels.OAuthRegisterState, payload),
  /** Register a callback for OAuth deep links; returns a disposer */
  onOAuthCallback: (cb: (url: string) => void): (() => void) => {
    const handler = createOAuthCallbackHandler(cb, () => {
      ipcRenderer.send(PlatformChannels.OAuthCallbackHandled);
    });
    ipcRenderer.on(PlatformChannels.OAuthCallback, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.OAuthCallback, handler);
  },
  /** Register a callback for payment deep links; returns a disposer */
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
  /** Notify the main process that the renderer is ready */
  notifyRendererReady: () => ipcRenderer.send(PlatformChannels.RendererReady),
  /** Sync renderer telemetry context to the main process */
  syncTelemetryContext: (context: TelemetryRendererContext) =>
    ipcRenderer.send(PlatformChannels.SyncTelemetryContext, context),
  /** Report business telemetry events through the main process */
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
  /** Report ARMS custom events through the main process */
  reportArmsCustomEvent: (payload: {
    name: string;
    group: string;
    value?: number;
    properties?: Record<string, string | number | boolean | undefined>;
  }) => ipcRenderer.invoke(PlatformChannels.ReportArmsCustomEvent, payload),
  /** Read the renderer user-action Trace gray-release config. */
  getRendererActionTraceConfig: (): Promise<RendererActionTraceConfigV1> =>
    ipcRenderer.invoke(PlatformChannels.GetRendererActionTraceConfig),
  /** Subscribe to changes of the renderer user-action Trace config pushed by main. */
  onRendererActionTraceConfigChanged: (
    callback: (config: RendererActionTraceConfigV1) => void,
  ): (() => void) => {
    const handler = (_event: unknown, config: RendererActionTraceConfigV1) => callback(config);
    ipcRenderer.on(PlatformChannels.RendererActionTraceConfigChanged, handler);
    return () =>
      ipcRenderer.removeListener(PlatformChannels.RendererActionTraceConfigChanged, handler);
  },
  /** Send ended Spans; uses send so telemetry does not round-trip and block business work. */
  reportLocalTtftBatch: (batch: import("@zcode/shared").LocalTtftBatch): void =>
    ipcRenderer.send(PlatformChannels.ReportLocalTtftBatch, batch),
  reportRendererActionTraceBatch: (batch: RendererActionTraceBatchV1): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererActionTraceBatch, batch),
  /**
   * The 60-second heap reading of the main window renderer.
   * Only a one-way send is provided: main does not acknowledge, and the renderer cannot use it to look up main's process facts.
   */
  reportRendererHeapSample: (sample: RendererHeapSample): void =>
    ipcRenderer.send(PlatformChannels.ReportRendererHeapSample, sample),
  /** Trigger a native task notification through the main process */
  showTaskNotification: (payload: TaskNotificationPayload) =>
    ipcRenderer.send(PlatformChannels.ShowTaskNotification, payload),
  /** Export logs: zip ~/.zcode/v2 and external agent logs and reveal them in Finder */
  exportLogs: (): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> => ipcRenderer.invoke(PlatformChannels.ExportLogs),
  /** Capture the current window, so error feedback can carry the on-screen view */
  captureWindowScreenshot: () => ipcRenderer.invoke(PlatformChannels.CaptureWindowScreenshot),
  // CDP-on-guest pivot: after the `<webview>` guest dom-ready, report webContentsId to main to attach.
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
  /** Before React unmounts an old `<webview>`, synchronously wait for main to detach the native CDP session. */
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
  /** Sync the UI free size to the real viewport of the current controlled tab. */
  browserViewUpdateViewport: (payload: { tabId: string; viewport: BrowserViewportSize | null }) =>
    ipcRenderer.invoke(PlatformChannels.BrowserViewUpdateViewport, payload),
  /** Import built-in browser data once from an automatically discovered Chrome profile. */
  importChromeBrowserData: (options?: import("@zcode/shared").ChromeBrowserDataImportOptions) =>
    ipcRenderer.invoke(PlatformChannels.ImportChromeBrowserData, options),
  /** Clear the built-in browser cache or all site data. */
  clearEmbeddedBrowserData: (mode: "cache" | "all") =>
    ipcRenderer.invoke(PlatformChannels.ClearEmbeddedBrowserData, mode),
  /** Read the state of the development-mode stdio tap proxy switch */
  getZCodeStdioTapDevState: (): Promise<ZCodeStdioTapDevState> =>
    ipcRenderer.invoke(PlatformChannels.GetZCodeStdioTapDevState),
  /** Register a callback for main-process notifications after settings change; returns a disposer */
  onSettingsChanged: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on(PlatformChannels.SettingsChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.SettingsChanged, handler);
  },
  /** Register a callback for application language changes; returns a disposer */
  onApplicationLocaleChanged: (callback: (locale: Locale) => void): (() => void) => {
    const handler = (_event: unknown, locale: Locale) => callback(locale);
    ipcRenderer.on(PlatformChannels.ApplicationLocaleChanged, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.ApplicationLocaleChanged, handler);
  },
  /** Register a callback for the result of a manual check for updates; returns a disposer */
  onUpdateCheckResult: (callback: (payload: UpdateCheckResultPayload) => void): (() => void) => {
    const handler = (_event: unknown, payload: UpdateCheckResultPayload) => callback(payload);
    ipcRenderer.on(PlatformChannels.UpdateCheckResult, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.UpdateCheckResult, handler);
  },
  getUpdateState: (): Promise<UpdateStatePayload> =>
    ipcRenderer.invoke(PlatformChannels.GetUpdateState),
  /** Start downloading the update that has been discovered */
  downloadUpdate: () => ipcRenderer.invoke(PlatformChannels.DownloadUpdate),
  /** Cancel the update currently downloading */
  cancelUpdateDownload: () => ipcRenderer.invoke(PlatformChannels.CancelUpdateDownload),
  /** Open the standalone update window */
  openUpdateStatusWindow: () => ipcRenderer.invoke(PlatformChannels.OpenUpdateStatusWindow),
  /** Read the auto-update preference */
  getAutoUpdatePreferences: () => ipcRenderer.invoke(PlatformChannels.GetAutoUpdatePreferences),
  /** Write the "automatically download and install updates" preference */
  setAutoDownloadAndInstallUpdates: (enabled: boolean) =>
    ipcRenderer.invoke(PlatformChannels.SetAutoDownloadAndInstallUpdates, enabled),
  getDesktopSessionActivity: () => ipcRenderer.invoke(PlatformChannels.GetDesktopSessionActivity),
  /** Register a callback for continuous auto-update state changes; returns a disposer */
  onUpdateStateChanged: (callback: (payload: UpdateStatePayload) => void): (() => void) => {
    updateStateCallbacks.add(callback);
    if (latestUpdateState) {
      callback(latestUpdateState);
    }
    return () => {
      updateStateCallbacks.delete(callback);
    };
  },
  /** Register a callback for when a new version has finished downloading; returns a disposer */
  onUpdateReady: (callback: (version: string) => void): (() => void) => {
    // The main process's update-ready is a one-shot event that often fires before the React effect registers.
    // So the preload caches the latest version here and replays it immediately on subscribe,
    // so the UI gets a stable "update downloaded" state even if it mounts late.
    updateReadyCallbacks.add(callback);
    if (latestReadyUpdateVersion) {
      callback(latestReadyUpdateVersion);
    }
    return () => {
      updateReadyCallbacks.delete(callback);
    };
  },
  /** Register a callback for release notes of the installed update; returns a disposer */
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
  /** Mark the current release notes as read */
  acknowledgePostUpdateReleaseNotes: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.AcknowledgePostUpdateReleaseNotes, version),
  /** Skip the update version that has been discovered */
  skipUpdateVersion: (version: string) =>
    ipcRenderer.invoke(PlatformChannels.SkipUpdateVersion, version),
  /** The user confirms restarting to install the update */
  quitAndInstallUpdate: () => ipcRenderer.invoke(PlatformChannels.QuitAndInstallUpdate),
  /** Get the list of installed editors and terminals (with icons) */
  getInstalledEditors: (filePath?: string) =>
    ipcRenderer.invoke(PlatformChannels.GetInstalledEditors, filePath),
  getFileApplications: (target: FileApplicationTarget) =>
    ipcRenderer.invoke(PlatformChannels.GetFileApplications, target),
  openFileWithApplication: (applicationId: string, target: FileApplicationTarget) =>
    ipcRenderer.invoke(PlatformChannels.OpenFileWithApplication, { applicationId, target }),
  getApplicationIcon: (request: string | ApplicationIconRequest) =>
    ipcRenderer.invoke(PlatformChannels.GetApplicationIcon, request),
  /** Open a path with the given editor */
  openInEditor: (editorId: string, path: string, options?: OpenInEditorOptions) =>
    ipcRenderer.invoke(PlatformChannels.OpenInEditor, {
      editorId,
      path,
      options,
    }),
  /** Execute a desktop window-level command */
  executeDesktopCommand: (command: DesktopCommandId) =>
    ipcRenderer.invoke(PlatformChannels.ExecuteDesktopCommand, command),
  /** Sync the application menu language */
  setApplicationLocale: (locale: Locale) =>
    ipcRenderer.invoke(PlatformChannels.SetApplicationLocale, locale),
  /** Read the host system language */
  getSystemLocale: (): Promise<Locale> => ipcRenderer.invoke(PlatformChannels.GetSystemLocale),
  /** Sync the title bar light/dark color */
  setTitleBarTheme: (theme: DesktopTitleBarTheme) =>
    ipcRenderer.invoke(PlatformChannels.SetTitleBarTheme, theme),
  /** Get the desktop device identifier (deviceMid) */
  getDeviceId: () => ipcRenderer.invoke(PlatformChannels.GetDeviceId),
});

installPluginSandboxHostBridge();

/**
 * MessagePort cannot be passed through contextBridge (contextBridge wraps it in a Proxy,
 * losing native methods such as addEventListener). Instead, window.postMessage's transfer
 * mechanism passes the MessagePort unchanged into the renderer's window context.
 */
ipcRenderer.on(InternalChannels.ServicePort, (event, payload: unknown) => {
  const [port] = event.ports;
  const parsed = databaseStartupPortPayloadSchema.safeParse(payload);
  if (port && parsed.success)
    window.postMessage({ type: InternalChannels.ServicePort, ...parsed.data }, "*", [port]);
  else port?.close();
});

ipcRenderer.on(InternalChannels.ScopedServicePort, (event, payload: unknown) => {
  const [port] = event.ports;
  const parsed = scopedServicePortPayloadSchema.safeParse(payload);
  if (!port || !parsed.success) return;
  // Bug root cause: this used to rebuild the payload from a hand-written field allowlist; after Main added a workspace scope,
  // the Preload allowlist was not updated, so the Renderer bound a project logical session in place as a conversation.
  window.postMessage(
    {
      type: InternalChannels.ScopedServicePort,
      ...parsed.data,
    },
    "*",
    [port],
  );
});

ipcRenderer.on(
  InternalChannels.SourceSettingsServicePort,
  (
    event,
    payload: {
      attachmentId?: string;
      sourceServerId?: string;
    },
  ) => {
    const [port] = event.ports;
    if (!port) return;
    window.postMessage(
      {
        type: InternalChannels.SourceSettingsServicePort,
        attachmentId: payload.attachmentId,
        sourceServerId: payload.sourceServerId,
      },
      "*",
      [port],
    );
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
  // MessagePort registration happens in the isolated renderer world, so Main must not treat "delivered" as "usable".
  // The preload only thinly forwards the renderer's ready ACK to Main; business attachment state is still managed by the window session manager.
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

// After dom-ready autoInject, if the Bridge is reset, try wrapping once more
scheduleArmsEventBridgePatch();

// The startup control plane precedes ordinary RPC; reload fills in from Main's notification mirror without triggering a new migration.
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
