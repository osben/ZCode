import type {
  DesktopCommandId,
  DesktopZoomState,
  DesktopWindowChromeState,
  DesktopTitleBarTheme,
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
  AppSettings,
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
  ChromeBrowserDataImportResult,
  DockerContainerInfo,
  EmbeddedBrowserOpenUrlRequest,
  EmbeddedBrowserPermissionPromptEvent,
  EmbeddedBrowserPermissionResolveRequest,
  EmbeddedBrowserSitePermissionUpdateRequest,
  EmbeddedBrowserSitePermissionResetRequest,
  EmbeddedBrowserSitePermissionsSnapshot,
  EditorInfo,
  ApplicationIconInfo,
  ApplicationIconRequest,
  Locale,
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStartOperationResult,
  WebRemoteControlStatus,
  WebRemoteControlTaskTarget,
  WebRemoteControlWorkspaceTarget,
  OAuthStateRegistration,
  PostUpdateReleaseNotesPayload,
  RemoteConnectionRuntimeLog,
  RemoteSessionClosedEvent,
  BotRemoteWorkspaceReconnectedEvent,
  RemoteTarget,
  SSHConfigAliasOption,
  RendererTelemetryEventPayload,
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
  RendererHeapSample,
  TelemetryRendererContext,
  TaskNotificationPayload,
  WindowScreenshotResult,
  EmbeddedBrowserDataClearResult,
  WSLDistro,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  OpenInEditorOptions,
} from "@zcode/shared";

/**
 * Type definitions for window.zcode — includes only platform operations that require the main process.
 *
 * Credential management has moved to ICredentialService (through RPC) and no longer uses this interface.
 */
declare global {
  interface Window {
    /** Plugin UI sandbox preload namespace; undefined under the legacy preload. */
    zcodePluginSandbox?: {
      supportsRetainedMove?: boolean;
      copyImage?(
        input: import("@zcode/shared/mcp-apps").PluginSandboxCaptureRequest,
      ): Promise<void>;
      getOwnerWebContentsId(): Promise<number>;
      disposeSandbox(sandboxId: string, initId?: number): Promise<void>;
      consumeUserGesture(sandboxId: string): Promise<boolean>;
    };
    zcode: {
      connectRemote(
        options: RemoteTarget,
        requestId?: string,
        context?: {
          workspacePath: string;
          workspaceIdentity?: string;
          connectTrigger?: import("@zcode/shared").RemoteWorkspaceConnectTrigger;
        },
      ): Promise<{ success: boolean; error?: string; sessionId?: string }>;
      /** Cancel a remote connection that has not yet been established in the current window. */
      cancelPendingRemoteConnection?(requestId?: string): Promise<void>;
      /** Bind the canonical workspace context for a remote logical session. */
      bindRemoteWorkspaceSessionContext?(context: {
        remoteSessionId: string;
        workspacePath: string;
        workspaceIdentity?: string;
      }): Promise<BrowserGuestAttachResult>;
      /** Enable Web remote control for the current workspace. */
      startWebRemoteControl(
        context: WebRemoteControlContext,
      ): Promise<WebRemoteControlStartOperationResult>;
      /** Clear old pairing material and regenerate the Web remote control QR code. */
      refreshWebRemoteControlPairing(
        context: WebRemoteControlContext,
      ): Promise<WebRemoteControlStartOperationResult>;
      /** Stop Web remote control for the current window. */
      stopWebRemoteControl(): Promise<void>;
      /** Get the Web remote control status of the current window. */
      getWebRemoteControlStatus(): Promise<WebRemoteControlStatus>;
      /** Subscribe to Web remote control status changes for the current window. */
      onWebRemoteControlStatusChanged?(
        handler: (status: WebRemoteControlStatus) => void,
      ): () => void;
      /** Release a remote session in the current window. */
      disposeRemoteSession(sessionId: string): Promise<void>;
      /** Check whether the local Docker daemon is available. */
      isDockerAvailable(): Promise<boolean>;
      /** List available local WSL distributions. */
      listWSLDistros(): Promise<WSLDistro[]>;
      /** List Docker containers that can be connected to. */
      listDockerContainers(): Promise<DockerContainerInfo[]>;
      /** List aliases from this machine's SSH config for quick form entry. */
      listSSHConfigAliases(): Promise<SSHConfigAliasOption[]>;
      /** Send renderer logs to the main process over IPC for centralized storage. */
      log(level: "info" | "warn" | "error", args: unknown[]): void;
      /** Open the system directory picker and return the selected path, or null. */
      selectDirectory(): Promise<string | null>;
      /** App-managed worktree storage directory for the "global" location mode. */
      getAppWorktreesDir(): Promise<string>;
      /** Open the system file picker and return the selected file path, or null. */
      selectFile(): Promise<string | null>;
      /** Open the system multi-file picker and return the selected paths, or an empty array if canceled. */
      selectFiles?(): Promise<string[]>;
      /** Save a file through the native system Save As dialog. */
      saveFile?(
        payload: import("@zcode/shared").SaveFileRequest,
      ): Promise<import("@zcode/shared").SaveFileResult>;
      /** Export the current page's print layout as a PDF using Chromium's print engine and vector text. */
      printPageToPdf?(): Promise<import("@zcode/shared").PrintPageToPdfResult>;
      /** Resolve the real local path for a Web File received through system drag-and-drop or file input. */
      getPathForFile?(file: File): string | null;
      /** dwf artifact "open as file": materialize one version's bytes into a local copy and return its path. */
      materializeWorkflowArtifactFile(
        payload: import("@zcode/shared").MaterializeWorkflowArtifactFileRequest,
      ): Promise<import("@zcode/shared").MaterializeWorkflowArtifactFileResult>;
      /** Subscribe to remote connection logs for the current window and return a disposer. */
      onRemoteConnectionLog(handler: (entry: RemoteConnectionRuntimeLog) => void): () => void;
      /** Subscribe to remote workspace session closure events and return a disposer. */
      onRemoteSessionClosed(handler: (event: RemoteSessionClosedEvent) => void): () => void;
      /** Subscribe to successful remote workspace reconnections triggered by a Bot and return a disposer. */
      onBotRemoteWorkspaceReconnected(
        handler: (event: BotRemoteWorkspaceReconnectedEvent) => void,
      ): () => void;
      /** Check whether the directory is already open in another window. */
      activateOrSetWorkspace?(path: string): Promise<{ activated: boolean }>;
      /** Sync the workspace paths of all tabs in the current window with the main process. */
      syncWindowTabs(paths: string[]): void;
      /** Sync the workspaces Web remote control may switch between for the current window. */
      syncWebRemoteControlWorkspaces?(workspaces: WebRemoteControlWorkspaceTarget[]): void;
      /** Sync the task snapshots Web remote control can display for the current window. */
      syncWebRemoteControlTasks?(tasks: WebRemoteControlTaskTarget[]): void;
      /** Register a callback for a mobile Web remote control request to reconnect a workspace. */
      onWebRemoteControlReconnectWorkspace?(
        handler: (
          request: WebRemoteControlReconnectWorkspaceRequest,
        ) => Promise<WebRemoteControlReconnectWorkspaceResult>,
      ): () => void;
      /** Sync the unread task count for the current window with the main process. */
      syncWindowUnreadCount(count: number): void;
      syncActiveTaskSession(sessionId: string | null): void;
      /** Sync application settings that the main process needs to observe immediately. */
      syncAppSettings?(patch: Partial<AppSettings>): void;
      /** Query the close-to-tray capability (for graying out on Linux; spec: docs/desktop/linux-close-to-tray.md). */
      getCloseToTrayCapability?(): Promise<import("@zcode/shared").DesktopCloseToTrayCapability>;
      /** Register a callback for focusing a workspace tab at the main process's request; return a disposer. */
      onFocusTab(handler: (path: string) => void): () => void;
      /** Register a callback for creating a tab at the main process's request; return a disposer. */
      onNewTab(handler: () => void): () => void;
      /** Register a callback for opening a page requested by the embedded browser webview; return a disposer. */
      onOpenBrowserUrl?(handler: (request: EmbeddedBrowserOpenUrlRequest) => void): () => void;
      /** Register a callback for embedded browser permission / origin-selection / device-selection prompt requests; return a disposer. */
      onEmbeddedBrowserPermissionPrompt?(
        handler: (event: EmbeddedBrowserPermissionPromptEvent) => void,
      ): () => void;
      /** Return the user's decision for an embedded browser permission prompt. */
      resolveEmbeddedBrowserPermissionPrompt?(
        request: EmbeddedBrowserPermissionResolveRequest,
      ): void;
      /** Read embedded browser site permission records (the "Site Permissions" settings page). */
      getEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
      /** Update or delete a single site permission entry. */
      setEmbeddedBrowserSitePermission?(
        request: EmbeddedBrowserSitePermissionUpdateRequest,
      ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
      /** Clear all site permission records. */
      clearEmbeddedBrowserSitePermissions?(): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
      /** Reset all permission records for a single site. */
      resetEmbeddedBrowserSitePermission?(
        request: EmbeddedBrowserSitePermissionResetRequest,
      ): Promise<EmbeddedBrowserSitePermissionsSnapshot>;
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
      onBrowserViewOperation?(handler: (payload: BrowserViewOperationPayload) => void): () => void;
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
      onBrowserViewViewportChanged?(
        handler: (payload: BrowserViewViewportChangedPayload) => void,
      ): () => void;
      onBrowserViewScreenshotSurfacePrepare?(
        handler: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
      ): () => void;
      onBrowserViewScreenshotSurfaceRelease?(
        handler: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
      ): () => void;
      browserViewScreenshotSurfaceReady?(payload: BrowserViewScreenshotSurfaceReadyPayload): void;
      onBrowserViewCloseTab?(
        handler: (payload: BrowserViewCloseTabNotification) => void,
      ): () => void;
      onBrowserViewSuspend?(
        handler: (payload: BrowserViewResidencyTransitionPayload) => void,
      ): () => void;
      onBrowserViewRestore?(
        handler: (payload: BrowserViewResidencyTransitionPayload) => void,
      ): () => void;
      /** Register a callback for creating a task at the main process's request; return a disposer. */
      onNewTask(handler: () => void): () => void;
      /** Register a callback for opening a workspace at the main process's request; return a disposer. */
      onOpenWorkspace?(handler: () => void): () => void;
      /** Register a callback for opening a local workspace directory directly through a deep link; return a disposer. */
      onOpenWorkspacePath?(handler: (path: string) => void): () => void;
      /** Register a callback for window fullscreen state changes; return a disposer. */
      onWindowFullscreenChanged(handler: (isFullscreen: boolean) => void): () => void;
      /** Read the window's maximized state and native system corner support. */
      getDesktopWindowChromeState?(): Promise<DesktopWindowChromeState>;
      /** Subscribe to changes in the window's maximized state and native system corner support. */
      onDesktopWindowChromeStateChanged?(
        handler: (state: DesktopWindowChromeState) => void,
      ): () => void;
      /** Read the page zoom level for the current desktop window. */
      getDesktopZoomLevel?(): Promise<DesktopZoomState>;
      /** Subscribe to page zoom level changes for the current desktop window. */
      onDesktopZoomLevelChanged?(handler: (state: DesktopZoomState) => void): () => void;
      /** Register a callback to open the related task when the user clicks a system notification; return a disposer. */
      onTaskNotificationClick(handler: (taskId: string) => void): () => void;
      /** Open an external URL. */
      openExternal(url: string): void;
      /** Check whether a user community entry is available in the current locale. */
      canOpenCommunity(locale: Locale): Promise<boolean>;
      /** Open the specified path in the system file manager. */
      openInFileManager(path: string): Promise<{ success: boolean; error?: string }>;
      /** Open a local file with the system's default application. */
      openExternalFile(path: string): Promise<{ success: boolean; error?: string }>;
      /** Open the full ZCode Computer Use permission onboarding flow. */
      openCuaPermissionOnboarding?(
        options?: OpenCuaPermissionOnboardingOptions,
      ): Promise<CuaAccessibilitySettingsResult>;
      /** Cancel only the onboarding participant started by the current renderer with this operationId. */
      cancelCuaPermissionOnboarding?(operationId: string): void;
      /** Prewarm and cache the verified Helper path so dragstart can call startDrag synchronously. */
      prepareCuaHelperPermissionDrag?(): Promise<PrepareCuaHelperPermissionDragResult>;
      /** Drag Helper.app from the permission popover to the macOS permission list. */
      startCuaHelperPermissionDrag?(): void;
      /** Report OAuth state for deep-link routing. */
      registerOAuthState(payload: OAuthStateRegistration): void;
      /** Register an OAuth deep-link callback and return a disposer. */
      onOAuthCallback(cb: (url: string) => void): () => void;
      /** Register a payment deep-link callback and return a disposer. */
      onPaymentCallback(cb: (url: string) => void): () => void;
      /** Notify the main process that the renderer is ready. */
      notifyRendererReady(): void;
      /** Sync the current renderer's telemetry context with the main process. */
      syncTelemetryContext(context: TelemetryRendererContext): void;
      /** Report business telemetry events through the main process. */
      reportTelemetryEvent(payload: RendererTelemetryEventPayload): Promise<void>;
      /** Read the Desktop Renderer rollout configuration for user-action tracing. */
      getRendererActionTraceConfig?(): Promise<RendererActionTraceConfigV1>;
      /** Subscribe to changes in the Renderer user-action tracing rollout configuration. */
      onRendererActionTraceConfigChanged?(
        callback: (config: RendererActionTraceConfigV1) => void,
      ): () => void;
      /** Send a completed ui_action batch; Main does not return a business result. */
      reportRendererActionTraceBatch?(batch: RendererActionTraceBatchV1): void;
      /** Send a 60-second heap sample from the main-window renderer; this is one-way and Main does not acknowledge it. */
      reportRendererHeapSample?(sample: RendererHeapSample): void;
      /** Show a system notification for the task's state. */
      showTaskNotification(payload: TaskNotificationPayload): void;
      /** Export logs by zipping ~/.zcode/v2 and external agent logs, then reveal the archive in Finder. */
      exportLogs(): Promise<{
        success: boolean;
        path?: string;
        error?: string;
      }>;
      /** Capture the current window so error feedback can include a screenshot of the issue. */
      captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>;
      browserViewAttachGuest?(payload: {
        key: string;
        webContentsId: number;
        active?: boolean;
        workspaceKey?: string;
        remoteSessionId?: string;
        sessionId?: string;
        residencyGeneration?: number;
      }): Promise<void>;
      /** Have the main process disconnect the old guest's CDP connection before rebuilding `<webview>`. */
      browserViewDetachGuest?(payload: { key: string; webContentsId: number }): Promise<boolean>;
      browserViewCloseTab?(payload: BrowserViewCloseTabRequest): Promise<void>;
      browserViewReportResidency?(payload: BrowserViewResidencyReportPayload): Promise<void>;
      browserViewSuspendReady?(payload: { tabId: string; generation: number }): Promise<void>;
      browserViewEnsureResident?(payload: BrowserViewCloseTabRequest): Promise<void>;
      browserViewRestoreTabs?(
        payload: BrowserViewRestoreTabsRequest,
      ): Promise<BrowserViewRestoredTabShell[]>;
      /** Send the renderer's free-form viewport size back to the main process. */
      browserViewUpdateViewport?(payload: {
        tabId: string;
        viewport: BrowserViewportSize | null;
      }): Promise<void>;
      /** Import embedded browser data once from an automatically discovered Chrome profile. */
      importChromeBrowserData?(
        options?: import("@zcode/shared").ChromeBrowserDataImportOptions,
      ): Promise<ChromeBrowserDataImportResult>;
      /** Clear the embedded browser cache or all site data. */
      clearEmbeddedBrowserData?(mode: "cache" | "all"): Promise<EmbeddedBrowserDataClearResult>;
      /** Register a callback for when a new version has finished downloading; return a disposer. */
      onUpdateReady(callback: (version: string) => void): () => void;
      /** Register a callback for the result of a manual update check; return a disposer. */
      onUpdateCheckResult(callback: (payload: UpdateCheckResultPayload) => void): () => void;
      /** Register a callback for automatic update state changes; return a disposer. */
      onUpdateStateChanged?(callback: (payload: UpdateStatePayload) => void): () => void;
      /** Read the current automatic update state. */
      getUpdateState?(): Promise<UpdateStatePayload>;
      /** Start downloading the update that has been found. */
      downloadUpdate?(): Promise<void>;
      /** Cancel the update download currently in progress. */
      cancelUpdateDownload?(): Promise<void>;
      /** Open or focus the separate update window. */
      openUpdateStatusWindow?(): Promise<void>;
      /** Read automatic update preferences. */
      getAutoUpdatePreferences?(): Promise<{
        autoDownloadAndInstallUpdates: boolean;
      }>;
      /** Set the "automatically download and install updates" preference. */
      setAutoDownloadAndInstallUpdates?(enabled: boolean): Promise<void>;
      /** Skip the update version that has been found. */
      skipUpdateVersion?(version: string): Promise<void>;
      /** Register a callback for application locale changes; return a disposer. */
      onApplicationLocaleChanged?(callback: (locale: Locale) => void): () => void;
      /** Subscribe to notifications when the main process changes settings. */
      onSettingsChanged?(callback: () => void): () => void;
      /** Get the number of sessions currently running on Desktop. */
      getDesktopSessionActivity?(): Promise<{
        runningAgentSessionCount: number;
      }>;
      /** Register a callback for release notes after an update is installed; return a disposer. */
      onPostUpdateReleaseNotes(
        callback: (payload: PostUpdateReleaseNotesPayload) => void,
      ): () => void;
      /** Mark the current release notes as read. */
      acknowledgePostUpdateReleaseNotes(version: string): Promise<void>;
      /** Restart the application and install the update after user confirmation. */
      quitAndInstallUpdate(): Promise<void>;
      /** Get the list of installed editors and terminals, including their icons. */
      getInstalledEditors(): Promise<EditorInfo[]>;
      /** Get a system application icon by a compatible bundle ID or structured locator. */
      getApplicationIcon?(
        request: string | ApplicationIconRequest,
      ): Promise<ApplicationIconInfo | null>;
      /** Open a path with the specified editor. */
      openInEditor(
        editorId: string,
        path: string,
        options?: OpenInEditorOptions,
      ): Promise<{ success: boolean; error?: string }>;
      /** Execute a desktop window-level command. */
      executeDesktopCommand(command: DesktopCommandId): Promise<void>;
      /** Sync the application menu locale. */
      setApplicationLocale(locale: Locale): Promise<void>;
      /** Read the host system locale. */
      getSystemLocale?(): Promise<Locale>;
      /** Sync the title bar's light or dark theme. */
      setTitleBarTheme(theme: DesktopTitleBarTheme): Promise<void>;
    };
  }
}
