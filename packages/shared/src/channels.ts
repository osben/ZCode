import type { WebRemoteControlAuthStateChange } from "./web-remote-control.js";
/* eslint-disable max-lines -- 通信频道和请求响应映射必须集中定义，避免跨进程 channel 字符串散落。 */
import type {
  ResourceUsageSnapshot,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./index.js";
import type { OAuthStateRegistration } from "./oauth.js";
import type { ServiceLocale } from "./locale.js";
import type {
  WebRemoteControlContext,
  WebRemoteControlReconnectWorkspaceRequest,
  WebRemoteControlReconnectWorkspaceResult,
  WebRemoteControlStartOperationResult,
  WebRemoteControlStatus,
  WebRemoteControlWorkspaceTarget,
} from "./web-remote-control.js";
import type { AppSettings, Locale } from "./protocol.js";
import type { StorageCleanRequest, StorageCleanResult, StorageUsageSnapshot } from "./storage.js";
import type {
  ArmsCustomEventPayload,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
  RendererTelemetryEventPayload,
  TelemetryRendererContext,
} from "./telemetry.js";
import type {
  RendererActionTraceBatchV1,
  RendererActionTraceConfigV1,
} from "./rendererActionTrace.js";
import type { RendererHeapSample } from "./validation.js";
import type {
  CancelPendingRemoteConnectionRequest,
  BindRemoteWorkspaceSessionContextRequest,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewViewportChangedPayload,
  ConnectRemoteRequest,
  DesktopCommandId,
  DesktopTitleBarTheme,
  DockerContainerInfo,
  EmbeddedBrowserOpenUrlRequest,
  EmbeddedBrowserPermissionPromptEvent,
  EmbeddedBrowserPermissionResolveRequest,
  EmbeddedBrowserSitePermissionUpdateRequest,
  EmbeddedBrowserSitePermissionResetRequest,
  EmbeddedBrowserSitePermissionsSnapshot,
  EditorInfo,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  MaterializeWorkflowArtifactFileRequest,
  MaterializeWorkflowArtifactFileResult,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  OpenInEditorOptions,
  PostUpdateReleaseNotesPayload,
  RemoteSessionClosedEvent,
  RemoteSessionReconnectedEvent,
  SSHConfigAliasOption,
  TaskNotificationPayload,
  WSLDistro,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  DesktopZoomState,
  DesktopWindowChromeState,
  WindowControlsOverlayMetrics,
  WindowControlsOverlayReadyPayload,
} from "./platform.js";
import type { BrowserViewportSize } from "./browser-use/command-metadata.js";
import type {
  CuaAccessibilitySettingsResult,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";

// ============================================================================
// RPC service channels — transported through ChannelServer/ChannelClient
// ============================================================================

/** RPC service channel names, corresponding to ServiceDescriptor.channelName. */
export const ServiceChannels = {
  File: "file",
  MediaPreview: "media-preview",
  System: "system",
  Terminal: "terminal",
  /** Git service */
  Git: "git",
  /** Git checkpoint service */
  GitCheckpoint: "git-checkpoint",
  Setting: "setting",
  /** Credential management (migrated from main IPC to host RPC) */
  Credential: "credential",
  /** Computer Use Helper macOS permission service */
  CuaPermission: "cua-permission",
  /** Voice dictation: on-device model catalog, downloads, and transcription */
  VoiceDictation: "voice-dictation",
  /** producer-owned PiP session presentation client */
  CuaPipSession: "cua-pip-session",
  /** Cross-window broadcast */
  Broadcast: "broadcast",
  /** ZCode task wrapper service */
  ZCodeTask: "zcode-task",
  /** Window Host that aggregates workspace/task projections and routes list writes */
  WindowController: "window-controller",
  /** ZCode Protocol agent service */
  ZCodeAgent: "zcode-agent",
  /** ZCode session application service */
  ZCodeSession: "zcode-session",
  Project: "project",
  TaskGroups: "task-groups",
  RemoteProjects: "remote-projects",
  /** 手机远端 attachment 的窗口目录；原 project 继续属于工作区。 */
  WindowProject: "window-project",
  WindowRemoteProjects: "window-remote-projects",
  WindowProjectChanges: "window-project-changes",
  /** 会话分享发布、预览与 continuation API 编排 */
  ConversationShare: "conversation-share",
  /** File-system watcher service */
  FileWatcher: "file-watcher",
  /** OAuth authentication service */
  OAuth: "oauth",
  /** Settings read/write facade for the new Provider Config */
  ProviderSettings: "provider-settings",
  /** Model selection facade for the new Provider Registry */
  ModelSelection: "model-selection",
  /** Internal Provider Provisioning target for remote Environments */
  ProviderProvisioningTarget: "provider-provisioning-target",
  /** Source Server 端 workspace 身份解析服务 */
  SourceServerWorkspace: "source-server-workspace",
  /** 桌面 Host 的 Source Server 目录与连接管理服务 */
  SourceServerManagement: "source-server-management",
  /** 本地 usage 统计服务 */
  UsageStats: "usage-stats",
  /** Coding Plan subscription purchase service */
  CodingPlanSubscription: "coding-plan-subscription",
  ClientConfig: "client-config",
  /** ZCode client-scene configuration service */
  ClientScenes: "client-scenes",
  CloudContent: "cloud-content",
  MarketingTouch: "marketing-touch",
  /** Skills management service */
  Skills: "skills",
  /** SSH remote skills synchronization service */
  SkillSync: "skill-sync",
  /** SSH remote MCP synchronization service */
  McpSync: "mcp-sync",
  /** SSH remote plugin synchronization service */
  PluginSync: "plugin-sync",
  /** Plugin management service */
  Plugins: "plugins",
  /** Settings-page plugin management service (consolidates UI platform capabilities and no longer calls zcodeAgentService directly) */
  PluginManagement: "plugin-management",
  /** Plugin UI sandbox bridge: host reads ui:// resources, registers them with main, and proxies tool calls initiated by the UI */
  PluginUiBridge: "plugin-ui-bridge",
  PluginUiSampling: "plugin-ui-sampling",
  PluginUiAppTools: "plugin-ui-app-tools",
  /** Subagents management service */
  Subagents: "subagents",
  /** Commands management service */
  Commands: "commands",
  /** Hooks management service */
  Hooks: "hooks",
  /** Memory management service */
  Memory: "memory",
  /** Read/write service for global user instructions (~/.zcode/AGENTS.md) */
  UserInstructions: "user-instructions",
  /** OutputStyle management service */
  OutputStyle: "output-style",
  /** System-prompt section override service (~/.zcode/system-prompt/) */
  SystemPrompt: "system-prompt",
  /** First-launch settings synchronization service */
  SettingsSync: "settings-sync",
  /** Remote chat-control service for Bots */
  Bots: "bots",
  /** User feedback ticket service */
  Feedback: "feedback",
  /** Pre-transfer service for Composer attachments between the host-local and remote runtimes */
  PromptAttachmentTransfer: "prompt-attachment-transfer",
  /** Off-peak task management service (separate from the automation service surface) */
  OffPeakTask: "off-peak-task",
  /** Highspeed acceleration-card extraction and sharing service */
  HighspeedCard: "highspeed-card",
  /** Onboarding completion record service (persisted locally and uploaded to the server later) */
  OnboardingRecord: "onboarding-record",
} as const;

export type ServiceChannelName = (typeof ServiceChannels)[keyof typeof ServiceChannels];

// ============================================================================
// Platform channels — operations handled only by the Desktop main process (Electron IPC)
// ============================================================================

/** Electron IPC channel names. Used only between preload and main. */
export const PlatformChannels = {
  /** renderer → main: release the plugin UI sandbox (close ports, remove the protocol handler, clear the partition) */
  PluginSandboxDispose: "zcode:plugin-sandbox-dispose",
  PluginSandboxCopyImage: "zcode:plugin-sandbox-copy-image",
  PluginSandboxExecutionActive: "zcode:plugin-sandbox-execution-active",
  /** renderer → main：一次性消费插件 UI 沙箱 guest 的用户手势 token */
  PluginSandboxConsumeUserGesture: "zcode:plugin-sandbox-consume-user-gesture",
  /** renderer → main: query its own webContents id to use as the sandbox registration owner */
  PluginSandboxOwnerWebContentsId: "zcode:plugin-sandbox-owner-web-contents-id",
  /** Open the system directory picker */
  SelectDirectory: "zcode:select-directory",
  /** App-managed worktree storage directory for the "global" location mode */
  GetAppWorktreesDir: "zcode:get-app-worktrees-dir",
  /** Renderer → Main: apply/release the system-wide output mute used while voice dictation records */
  SetDictationSystemMute: "zcode:set-dictation-system-mute",
  /** Open the system multi-directory picker */
  SelectDirectories: "zcode:select-directories",
  /** Open the system file picker */
  SelectFile: "zcode:select-file",
  /** Open the system multi-file picker */
  SelectFiles: "zcode:select-files",
  /** Renderer → Main: write a temporary text attachment to the host's ~/.zcode */
  CreateTempTextAttachment: "zcode:create-temp-text-attachment",
  /** Renderer → Main: save a version of a DWF artifact as a local copy (“open as file”) */
  MaterializeWorkflowArtifactFile: "zcode:materialize-workflow-artifact-file",
  /** Renderer → Main: save a file through the native Save As dialog */
  SaveFile: "zcode:save-file",
  /** Renderer → Main: export the current page's print media layout to PDF using Chromium's print engine */
  PrintToPdf: "zcode:print-to-pdf",
  /** Main → Renderer: forward remote connection progress logs */
  RemoteConnectionLog: "zcode:remote-connection-log",
  /** Main → Renderer: the remote workspace session has closed */
  RemoteSessionClosed: "zcode:remote-session-closed",
  /** Main → Renderer：Source 自动重连后的 logical session 已换代并完成 port ready */
  RemoteSessionReconnected: "zcode:remote-session-reconnected",
  /** 检查目录是否已在其他窗口打开，如果是则激活该窗口 */
  ActivateOrSetWorkspace: "zcode:activate-or-set-workspace",
  /** Establish an SSH remote connection */
  ConnectRemote: "zcode:connect-remote",
  /** Desktop Renderer → Main：为在线 Source 创建配置专用 attachment */
  RequestSourceSettingsAttachment: "zcode:request-source-settings-attachment",
  /** 取消当前窗口正在进行中的远程连接 */
  CancelPendingRemoteConnection: "zcode:cancel-pending-remote-connection",
  /** Renderer → Main: bind the canonical workspace context to a remote logical session */
  BindRemoteWorkspaceSessionContext: "zcode:bind-remote-workspace-session-context",
  /** Enable Web remote control for the current workspace */
  StartWebRemoteControl: "zcode:start-web-remote-control",
  /** 关闭当前窗口的 Web 远程控制 */
  StopWebRemoteControl: "zcode:stop-web-remote-control",
  /** Query the current window’s Web remote-control status */
  GetWebRemoteControlStatus: "zcode:get-web-remote-control-status",
  /** Renderer → Main：OAuth 会话变化通知，不携带凭据 */
  WebRemoteControlAuthStateChanged: "zcode:web-remote-control-auth-state-changed",
  /** Main → Renderer：当前窗口 Web 远程控制状态变化 */
  WebRemoteControlStatusChanged: "zcode:web-remote-control-status-changed",
  /** Release the remote session in the current window */
  DisposeRemoteSession: "zcode:dispose-remote-session",
  /** Renderer → Main: check whether the local Docker daemon is available */
  IsDockerAvailable: "zcode:is-docker-available",
  /** Renderer → Main: list available local WSL distributions */
  ListWSLDistros: "zcode:list-wsl-distros",
  /** Renderer → Main: list Docker containers currently available to connect to */
  ListDockerContainers: "zcode:list-docker-containers",
  /** Renderer → Main: list SSH config aliases available for quick form filling */
  ListSSHConfigAliases: "zcode:list-ssh-config-aliases",
  /** Renderer → Main: load CLI MCP configuration from the user directory */
  LoadMcpFromUserDirectory: "zcode:load-mcp-from-user-directory",
  /** Renderer → Main: save CLI MCP configuration to the user directory */
  SaveMcpToUserDirectory: "zcode:save-mcp-to-user-directory",
  /** Renderer → Main: query whether “close to tray” is supported (used to disable the option on Linux; spec: docs/desktop/linux-close-to-tray.md) */
  GetCloseToTrayCapability: "zcode:get-close-to-tray-capability",
  /** Forward Renderer logs to centralized storage in the main process */
  Log: "zcode:log",
  /** Renderer → Main: sync workspace paths for all tabs in the current window */
  SyncWindowTabs: "zcode:sync-window-tabs",
  /** Renderer → Main: sync the workspaces available for Web remote-control switching in the current window */
  SyncWebRemoteControlWorkspaces: "zcode:sync-web-remote-control-workspaces",
  /** Main → Renderer：手机端请求重连当前窗口里的远程 workspace */
  WebRemoteControlReconnectWorkspace: "zcode:web-remote-control-reconnect-workspace",
  /** Renderer → Main: sync the unread task count for the current window */
  SyncWindowUnreadCount: "zcode:sync-window-unread-count",
  /** Renderer → Main: report the active task for the current window; update only Main's temporary focus mapping. */
  SyncActiveTaskSession: "zcode:sync-active-task-session",
  /** Renderer → Main: sync application settings that the main process needs to observe immediately */
  SyncAppSettings: "zcode:sync-app-settings",
  /** Renderer → Main: shortcut-settings recording toggle; true temporarily removes configurable menu accelerators in main */
  SetShortcutRecordingActive: "zcode:set-shortcut-recording-active",
  /** Main → Renderer: focus the tab for the specified workspace path */
  FocusTab: "zcode:focus-tab",
  /** Main → Renderer: menu-triggered request to create a tab */
  NewTab: "zcode:new-tab",
  /** Main → Renderer: menu or shortcut request to close the current context */
  CloseActiveContextRequest: "zcode:close-active-context-request",
  /** Main → Renderer: the embedded webview requests opening a new browser tab */
  OpenBrowserUrl: "zcode:open-browser-url",
  /** Main → Renderer: request a built-in browser site-permission, screen-sharing source, or device-selection dialog */
  EmbeddedBrowserPermissionPrompt: "zcode:embedded-browser-permission-prompt",
  /** Renderer → Main: return the user’s decision for a built-in browser permission dialog */
  EmbeddedBrowserPermissionResolve: "zcode:embedded-browser-permission-resolve",
  /** Main → Renderer: after the agent's first browser command creates a controlled view, notify the renderer to open a browser-use tab automatically */
  BrowserViewReady: "zcode:browser-view-ready",
  /** Main → Renderer: the agent is operating a browser-use tab; the renderer temporarily displays a status icon */
  BrowserViewOperation: "zcode:browser-view-operation",
  /** Main → Renderer: the browser visibility capability shows or hides the IAB side panel */
  BrowserViewVisibility: "zcode:browser-view-visibility",
  /** Main → Renderer: the Agent sets or resets the target tab viewport */
  BrowserViewViewportChanged: "zcode:browser-view-viewport-changed",
  /** Main → Renderer: before a screenshot, ask the owner renderer to prepare a compositing surface for the background guest. */
  BrowserViewScreenshotSurfacePrepare: "zcode:browser-view-screenshot-surface-prepare",
  /** Renderer → Main: the target guest viewport has remained stable for two consecutive animation frames. */
  BrowserViewScreenshotSurfaceReady: "zcode:browser-view-screenshot-surface-ready",
  /** Main → Renderer: release the temporary background compositing layer after the screenshot or if preparation fails. */
  BrowserViewScreenshotSurfaceRelease: "zcode:browser-view-screenshot-surface-release",
  /** Main → Renderer: after an agent close command detaches the controlled guest, notify the renderer to unload the corresponding tab */
  BrowserViewCloseTab: "zcode:browser-view-close-tab",
  /** Main → Renderer: unload the guest on budget eviction while preserving the logical tab shell. */
  BrowserViewSuspend: "zcode:browser-view-suspend",
  /** Main → Renderer: remount the guest for a suspended shell. */
  BrowserViewRestore: "zcode:browser-view-restore",
  /** Main → Renderer: menu-triggered request to create a task */
  NewTask: "zcode:new-task",
  /** Main → Renderer: menu-triggered request to open a workspace */
  OpenWorkspace: "zcode:open-workspace",
  /** Main → Renderer: a deep link directly opens the specified local workspace directory */
  OpenWorkspacePath: "zcode:open-workspace-path",
  /** Main → Renderer: a `zcode://task/new` deep link starts a fresh draft in a local workspace with the given text. */
  OpenTaskDraft: "zcode:open-task-draft",
  /** Main → Renderer: open the built-in feedback dialog */
  OpenFeedbackDialog: "zcode:open-feedback-dialog",
  /** Main → Renderer: open the My Tickets panel */
  OpenTicketsPanel: "zcode:open-tickets-panel",
  /** Main → Renderer: the window's fullscreen state changed */
  WindowFullscreenChanged: "zcode:window-fullscreen-changed",
  /** Renderer → Main: read the window's maximized state and native system corner support */
  GetDesktopWindowChromeState: "zcode:get-desktop-window-chrome-state",
  /** Main → Renderer: the window's maximized state or native system corner support changed */
  DesktopWindowChromeStateChanged: "zcode:desktop-window-chrome-state-changed",
  /** Main → Renderer: the safe insets for the native window controls changed */
  WindowControlsOverlayChanged: "zcode:window-controls-overlay-changed",
  /** Preload → Main: preload synchronously read the current window-control insets */
  WindowControlsOverlayReady: "zcode:window-controls-overlay-ready",
  /** Get a resource-manager snapshot (CPU/memory grouped by core services, built-in plugins, and community plugins) */
  GetResourceUsageSnapshot: "zcode:get-resource-usage-snapshot",
  SetResourceUsageSamplingActive: "zcode:set-resource-usage-sampling-active",
  GetNetworkCaptureSnapshot: "zcode:get-network-capture-snapshot",
  ClearNetworkCapture: "zcode:clear-network-capture",
  /** Open the resource-manager window (triggered from another window) */
  OpenResourceManager: "zcode:open-resource-manager",
  /** Resource Manager Storage tab: start scanning local .zcode usage (main owns StorageService; a Worker thread traverses files) */
  StorageStartScan: "zcode:storage-start-scan",
  /** Resource Manager Storage tab: cancel the scan */
  StorageCancelScan: "zcode:storage-cancel-scan",
  /** Resource Manager Storage tab: read the latest snapshot */
  StorageGetSnapshot: "zcode:storage-get-snapshot",
  /** Resource Manager Storage tab: clean up by category */
  StorageClean: "zcode:storage-clean",
  /** Resource Manager Storage tab: reveal a path under the data root in the system file manager */
  StorageRevealPath: "zcode:storage-reveal-path",
  /** Main → Resource Manager renderer: push scan-progress snapshots */
  StorageScanProgress: "zcode:storage-scan-progress",
  /** Renderer → Main: open an external URL (used to send OAuth flows to the browser) */
  OpenExternal: "zcode:open-external",
  /** Renderer → Main: check whether a community link is available for the current language */
  CanOpenCommunity: "zcode:can-open-community",
  /** Renderer → Main: open a path in the system file manager */
  OpenInFileManager: "zcode:open-in-file-manager",
  /** Renderer → Main: open a local file with the system's default application */
  OpenExternalFile: "zcode:open-external-file",
  /** Renderer → Main: open the ZCode Computer Use permission onboarding */
  OpenCuaPermissionOnboarding: "zcode:open-cua-permission-onboarding",
  /** Renderer → Main: cancel a permission-onboarding participant started by the current renderer */
  CancelCuaPermissionOnboarding: "zcode:cancel-cua-permission-onboarding",
  /**
   * Renderer → Main: warm and cache the verified Helper path and bundle fingerprint.
   * Must be called when the drag overlay mounts; the dragstart path cannot perform asynchronous I/O.
   */
  PrepareCuaHelperPermissionDrag: "zcode:prepare-cua-helper-permission-drag",
  /** Renderer → Main: synchronously drag the verified Helper.app to the macOS permissions list */
  StartCuaHelperPermissionDrag: "zcode:start-cua-helper-permission-drag",
  /**
   * Renderer → Main: the drag gesture has ended.
   * Authorization is complete after the drop, so the overlay should yield (the user needs to see the settings page and system restart prompt).
   * Wait for dragend instead of closing during dragstart: startDrag hands the drag session to the OS and returns without blocking, so removing the drag source
   * immediately may interrupt the active drag.
   */
  NotifyCuaHelperPermissionDragEnded: "zcode:notify-cua-helper-permission-drag-ended",
  /** Renderer → Main: register OAuth state for deep-link routing */
  OAuthRegisterState: "zcode:oauth-register-state",
  /** Main → Renderer: forward a deep-link URL */
  OAuthCallback: "zcode:oauth-callback",
  /** Main → Renderer: forward a payment deep-link URL */
  PaymentCallback: "zcode:payment-callback",
  /** Main → Renderer: an external share page requests importing a share code. */
  ShareImport: "zcode:share-import",
  /** Renderer → Main: OAuth callback processing is complete; continue the post-callback startup flow */
  OAuthCallbackHandled: "zcode:oauth-callback-handled",
  /** Renderer → Main: the renderer is ready to receive a cached deep link */
  RendererReady: "zcode:renderer-ready",
  /** Renderer → Main: sync the current renderer's telemetry context */
  SyncTelemetryContext: "zcode:sync-telemetry-context",
  /** Renderer → Main: report business events through the unified telemetry layer */
  ReportTelemetryEvent: "zcode:report-telemetry-event",
  /** Renderer → Main: report an ARMS custom event */
  ReportArmsCustomEvent: "zcode:report-arms-custom-event",
  /** Renderer → Main: read the Renderer user-action Trace rollout configuration. */
  GetRendererActionTraceConfig: "zcode:get-renderer-action-trace-config",
  /** Main → Renderer: the Renderer user-action Trace rollout configuration changed. */
  RendererActionTraceConfigChanged: "zcode:renderer-action-trace-config-changed",
  /** Renderer → Main: send a completed ui_action batch. */
  ReportRendererActionTraceBatch: "zcode:report-renderer-action-trace-batch",
  /** Renderer → Main: heap reading from the main-window renderer every 60 seconds; one-way send, no acknowledgment needed. */
  ReportRendererHeapSample: "zcode:report-renderer-heap-sample",
  ReportLocalTtftBatch: "zcode:report-local-ttft-batch",
  /** E2E preload → Main: read the in-memory ring of final sendCustom arguments. */
  ReadFinalArmsCustomEventsE2E: "zcode:e2e:read-final-arms-custom-events",
  /** E2E preload → Main: clear the in-memory ring of final sendCustom arguments. */
  ClearFinalArmsCustomEventsE2E: "zcode:e2e:clear-final-arms-custom-events",
  /** E2E preload → Main: configure actual network suppression for only the target event name. */
  ConfigureFinalArmsCustomEventsE2E: "zcode:e2e:configure-final-arms-custom-events",
  /** Renderer → Main: show a system notification when a task completes or fails */
  ShowTaskNotification: "zcode:show-task-notification",
  /** Main → Preload: tell the renderer to play the task-notification sound */
  TaskNotificationSound: "zcode:task-notification-sound",
  /** Main → Preload: the user clicked a system notification; include taskId so the renderer can navigate to that task */
  TaskNotificationClick: "zcode:task-notification-click",
  /** Renderer → Main: export logs (zip ~/.zcode/v2 and external Agent logs, then reveal the archive in Finder) */
  ExportLogs: "zcode:export-logs",
  /** Renderer → Main: capture the current window as a feedback attachment */
  CaptureWindowScreenshot: "zcode:capture-window-screenshot",
  /**
   * Renderer → Main: report webContentsId when the `<webview>` guest emits dom-ready;
   * main attaches the guest with BrowserGuestManager (fire-and-forget). CDP-on-guest pivot.
   */
  BrowserViewAttachGuest: "zcode:browser-view-attach-guest",
  /** Renderer → Main: proactively disconnect the old guest's CDP before rebuilding the `<webview>`. */
  BrowserViewDetachGuest: "zcode:browser-view-detach-guest",
  /** Renderer → Main: the user explicitly closed a Browser tab. */
  BrowserViewCloseTabFromRenderer: "zcode:browser-view-close-tab-from-renderer",
  /** Renderer → Main: report Browser tab residency/display facts. */
  BrowserViewReportResidency: "zcode:browser-view-report-residency",
  /** Renderer → Main: the guest for the specified generation has been unloaded. */
  BrowserViewSuspendReady: "zcode:browser-view-suspend-ready",
  /** Renderer → Main: the user visited a suspended tab and requested its restoration. */
  BrowserViewEnsureResident: "zcode:browser-view-ensure-resident",
  /** Renderer → Main: read persisted logical shells for the workspace/task. */
  BrowserViewRestoreTabs: "zcode:browser-view-restore-tabs",
  /** Renderer → Main: update the target guest viewport from resize dragging/toggle changes */
  BrowserViewUpdateViewport: "zcode:browser-view-update-viewport",
  /** Embedded Browser preload → Main: synchronously request a trusted system dialog before the page's native dialog is created. */
  EmbeddedBrowserJavaScriptDialog: "zcode:embedded-browser-javascript-dialog",
  /** Renderer → Main: import automatically discovered local Chrome Profile data into the embedded-browser partition once. */
  ImportChromeBrowserData: "zcode:import-chrome-browser-data",
  /** Renderer → Main: clear the embedded-browser cache or all site data. */
  ClearEmbeddedBrowserData: "zcode:clear-embedded-browser-data",
  /** Renderer → Main: read built-in browser site-permission records (Settings > “Site Permissions”) */
  GetEmbeddedBrowserSitePermissions: "zcode:get-embedded-browser-site-permissions",
  /** Renderer → Main: update/delete one site permission (state="ask" means delete) */
  SetEmbeddedBrowserSitePermission: "zcode:set-embedded-browser-site-permission",
  /** Renderer → Main: clear all site-permission records */
  ClearEmbeddedBrowserSitePermissions: "zcode:clear-embedded-browser-site-permissions",
  /** Renderer → Main: reset all permission records for one site (the “Reset” action in the Site Permissions settings tab) */
  ResetEmbeddedBrowserSitePermission: "zcode:reset-embedded-browser-site-permission",
  /** Main → Renderer: notify that a new version has downloaded and can be installed by restarting */
  UpdateReady: "zcode:update-ready",
  /** Main → Renderer: result of the user's manual "Check for updates" request (for a toast) */
  UpdateCheckResult: "zcode:update-check-result",
  /** Main → Renderer: ongoing auto-update status changes (for menu UI) */
  UpdateStateChanged: "zcode:update-state-changed",
  /** Renderer → Main: explicitly get the current auto-update state (compensates for missed events when the menu opens) */
  GetUpdateState: "zcode:get-update-state",
  /** Renderer → Main: start downloading the currently available update */
  DownloadUpdate: "zcode:download-update",
  /** Renderer → Main: cancel the update currently downloading */
  CancelUpdateDownload: "zcode:cancel-update-download",
  /** Renderer → Main: open the standalone auto-update window */
  OpenUpdateStatusWindow: "zcode:open-update-status-window",
  /** Renderer → Main: read auto-update preferences */
  GetAutoUpdatePreferences: "zcode:get-auto-update-preferences",
  /** Renderer → Main: write the "automatically download and install updates" preference */
  SetAutoDownloadAndInstallUpdates: "zcode:set-auto-download-and-install-updates",
  /** Renderer → Main: get the number of sessions currently running on desktop */
  GetDesktopSessionActivity: "zcode:get-desktop-session-activity",
  /** Renderer → Main: read the page zoom level for the current window */
  GetDesktopZoomLevel: "zcode:get-desktop-zoom-level",
  /** Main → Renderer: the current window's page zoom level changed */
  DesktopZoomLevelChanged: "zcode:desktop-zoom-level-changed",
  /** Renderer → Main: read the development stdio tap proxy toggle state */
  GetZCodeStdioTapDevState: "zcode:get-zcode-stdio-tap-dev-state",
  /** Main → Renderer: the main process updated the local setting.json */
  SettingsChanged: "zcode:settings-changed",
  /** Main → Renderer: the application language changed */
  ApplicationLocaleChanged: "zcode:application-locale-changed",
  /** Renderer → Main: read the host system language */
  GetSystemLocale: "zcode:get-system-locale",
  /** Main → Renderer: show the release notes after an update */
  PostUpdateReleaseNotes: "zcode:post-update-release-notes",
  /** Renderer → Main: acknowledge that the release notes have been read */
  AcknowledgePostUpdateReleaseNotes: "zcode:ack-post-update-release-notes",
  /** Renderer → Main: skip the currently available update version */
  SkipUpdateVersion: "zcode:skip-update-version",
  /** Renderer → Main: the user confirmed restarting to install the update */
  QuitAndInstallUpdate: "zcode:quit-and-install-update",
  /** Renderer → Main: list installed system editors/terminals (including icons) */
  GetInstalledEditors: "zcode:get-installed-editors",
  /** Renderer → Main: get a system application icon by bundle ID */
  GetApplicationIcon: "zcode:get-application-icon",
  /** Renderer → Main: open a path with the specified editor */
  OpenInEditor: "zcode:open-in-editor",
  /** Renderer → Main: execute a desktop window-level command */
  ExecuteDesktopCommand: "zcode:execute-desktop-command",
  /** Renderer → Main: sync the application menu language so the native menu can be rebuilt */
  SetApplicationLocale: "zcode:set-application-locale",
  /** Renderer → Main: sync the title-bar light/dark theme for native window-control button colors */
  SetTitleBarTheme: "zcode:set-title-bar-theme",
  /** Renderer → Main: migrate the legacy Common MCP configuration */
  MigrateLegacyCommonMcp: "zcode:migrate-legacy-common-mcp",
  /** Renderer → Main: get the current device's stable identifier (deviceMid) */
  GetDeviceId: "zcode:get-device-id",
} as const;

export type PlatformChannelName = (typeof PlatformChannels)[keyof typeof PlatformChannels];

// ============================================================================
// Embedded WebView channels — fixed guest preload ↔ embedder renderer
// ============================================================================

/** Electron `<webview>` `sendToHost` / `ipc-message` channels; these do not pass through the main process. */
export const EmbeddedBrowserWebviewChannels = {
  /** When the guest cannot consume scrolling in a direction, forward the two-dimensional delta to the resizable canvas. */
  WheelBoundary: "zcode:embedded-browser-wheel-boundary",
} as const;

export interface EmbeddedBrowserWheelBoundaryPayload {
  deltaX: number;
  deltaY: number;
}

// ============================================================================
// Coding Plan WebView channels — official website preload ↔ App renderer
// ============================================================================

/**
 * Electron `<webview>` (`partition=persist:zcode-coding-plan`) `sendToHost` / `ipc-message` channels.
 * The official website calls these through the preload-injected window.zcodeBridge; they do not pass through the main process.
 */
export const CodingPlanWebviewChannels = {
  /** After a successful purchase, the official website tells the App to refresh entitlements and close the webview. */
  PurchaseComplete: "zcode:coding-plan-purchase-complete",
} as const;

/**
 * Main → guest preload channels for the plugin UI sandbox guest (partition=plugin-sandbox:<id>).
 * The preload forwards the MessagePort group to the trusted shell via window.postMessage and exposes no contextBridge API.
 */
export const PluginSandboxChannels = {
  /** main → guest: { sandboxId, initId, names } + port1[]; the shell uses this to establish host ports */
  Init: "zcode:plugin-sandbox-init",
} as const;

/** Purchase completion payload. provider matches the website's CodingPlanProvider / auth-ready event detail.provider. */
export interface CodingPlanPurchaseCompletePayload {
  provider: "zai" | "bigmodel";
  /** Client timestamp for App-side deduplication/logging; not used for equality checks. */
  timestamp: number;
}

/**
 * Values for the official website's window.__zcodeLang__, matching the App IntlProvider Locale.
 * When the App locale changes, executeJavaScript rewrites this variable and dispatches a lang-change event.
 */
export type CodingPlanWebviewLocale = ServiceLocale;

/**
 * Detail for the official website's lang-change event. The App dispatches the
 * `zcode-coding-plan-lang-change` CustomEvent in the main world through executeJavaScript. The website subscribes via
 * zcodeBridge.onLangChange or window.addEventListener and updates its copy.
 */
export interface CodingPlanWebviewLangChangeDetail {
  locale: CodingPlanWebviewLocale;
}

// ============================================================================
// Internal transport channels — framework-level communication
// ============================================================================
/** Internal transport channels for framework-level communication such as MessagePort forwarding. */
export const InternalChannels = {
  DatabaseStartupState: "zcode:database-startup-state",
  DatabaseStartupControl: "zcode:database-startup-control",
  /** main → renderer: forward a MessagePort (through webContents.postMessage) */
  ServicePort: "zcode:service-port",
  /** main → renderer: forward a scoped MessagePort for the window Host */
  ScopedServicePort: "zcode:scoped-service-port",
  /** renderer → main: the scoped MessagePort is registered and its attachment can be switched safely */
  ScopedServicePortReady: "zcode:scoped-service-port-ready",
  /** main → renderer：在线 Source 的配置专用 MessagePort */
  SourceSettingsServicePort: "zcode:source-settings-service-port",
  /** preload → renderer：主进程已确认系统通知展示，renderer 可播放提示音 */
  TaskNotificationSound: "zcode:task-notification-sound",
  /** main → host renderer: the plugin UI sandbox MessagePort group (port2[]), payload { sandboxId, initId, names } */
  PluginSandboxPorts: "zcode:plugin-sandbox-ports",
} as const;

/** @deprecated `/ws` ignores this header; the constant remains only for compatibility with older clients. */
export const ZCODE_RPC_CLIENT_MODE_HEADER = "x-zcode-rpc-client-mode";
/** Desktop first requests this through a protected HTTP endpoint, then consumes it once during the `/ws/host` handshake. */
export const ZCODE_RPC_HOST_CAPABILITY_HEADER = "x-zcode-rpc-host-capability";

// ============================================================================
// Inter-process message types — postMessage between main and host processes
// ============================================================================

/** Initialization message types from main to the host process */
export const HostMessageTypes = {
  /** main → Host：准备手机项目目录，只复用已在线物理 Source。 */
  PrepareProjectWorkspace: "prepare-project-workspace",
  DatabaseStartupControl: "database-startup-control",
  /** Initialize local services */
  InitLocal: "init-local",
  /** main → window Host: establish a remote logical session in the current window */
  ConnectRemoteWorkspace: "connect-remote-workspace",
  /** main → window Host: cancel an unfinished remote connection */
  CancelRemoteWorkspaceConnect: "cancel-remote-workspace-connect",
  /** main → window Host: bind the canonical workspace identity to a logical session */
  BindRemoteWorkspaceContext: "bind-remote-workspace-context",
  /** main → window Host：取消已超时的 workspace bind */
  CancelRemoteWorkspaceBind: "cancel-remote-workspace-bind",
  /** main → window Host：释放一个远程 logical session */
  DisposeRemoteWorkspaceSession: "dispose-remote-workspace-session",
  /** main → host: expose an existing service through a new RPC MessagePort */
  AttachServicePort: "attach-service-port",
  /** main → host: release a specific RPC MessagePort attachment */
  DetachServicePort: "detach-service-port",
  /** Window closed; clean up resources */
  Dispose: "dispose",
  /** Relay broadcast messages */
  Broadcast: "broadcast",
  /** main → host: result of an atomic cross-window claim */
  BroadcastClaimResult: "broadcast-claim-result",
  /** main → host：task realtime invalidation delivery */
  TaskRealtimeDeliver: "task-realtime-deliver",
  /** main → host：task run lease acquire result */
  TaskRunLeaseResult: "task-run-lease-result",
  /** main → host：deliver owner-only task command */
  TaskOwnerCommandDeliver: "task-owner-command-deliver",
  /** main → host：deliver owner command result to requester */
  TaskOwnerCommandResult: "task-owner-command-result",
  /** main → host: result of a Bot remote-workspace reconnection */
  BotRemoteWorkspaceReconnectResult: "bot-remote-workspace-reconnect-result",
  /** main → host: result of a Bot remote-workspace connection-status query */
  BotRemoteWorkspaceConnectionStatusResult: "bot-remote-workspace-connection-status-result",
  /** main → host: Bot remote-workspace runtime RPC port */
  BotRemoteWorkspaceRuntimePort: "bot-remote-workspace-runtime-port",
  /** main → host: result of a Bot web-remote control link request */
  BotRemoteWorkspaceWebRemoteLinkResult: "bot-remote-workspace-web-remote-link-result",
  /** main → host: deliver a session message to a target session managed by this host */
  SessionMessageDeliver: "session-message-deliver",
  /** main → host: write the session-message delivery result back to the source session */
  SessionMessageDeliveryResult: "session-message-delivery-result",
  /** main → host: result of creating a feedback log archive */
  FeedbackLogArchiveResult: "feedback-log-archive-result",
  /** main → host: dispatch a scheduled task when due; session cron reuses targetTaskId, while only historical unbound tasks create a session */
  CronRun: "cron-run",
  /** main → host: dispatch an off-peak task; the first createTask run starts a session, later runs resume with conversationId/sessionId */
  OffPeakRun: "off-peak-run",
  /** main → host: browser-use command result (returned after CDP execution and correlated by requestId) */
  BrowserExecuteResult: "browser-execute-result",
  /** main → host: authorization result for a local video's canonical path */
  LocalMediaPreviewPathAuthorizeResult: "local-media-preview-path-authorize-result",
  /** main → host: plugin UI sandbox registration result (PluginSandboxRegisterResultPayload) */
  PluginSandboxRegisterResult: "plugin-sandbox-register-result",
  /** Main → Host: producer focus fact derived from the globally foreground ZCode window. */
  CuaPipFocusChanged: "cua-pip-focus-changed",
  /** main → host: ask the Host to read the local Source now and sync the specified Remote Environment. */
  ProviderProvisioningExecute: "provider-provisioning-execute",
  /** main → host: the Resource Manager requests CPU and memory sampling for the Host's descendant processes (Agent/MCP/terminal) */
  ResourceUsageSnapshotRequest: "resource-usage-snapshot-request",
  ResourceUsageSnapshotCancel: "resource-usage-snapshot-cancel",
  NetworkCapture: "network-capture",
  /** main → host：Main 的实时界面语言变化（Host 用于 ZCode endpoint 的 X-Client-Language） */
  ApplicationLocaleChanged: "application-locale-changed",
} as const;

/** Response message types from the host process to the main process */
export const HostResponseTypes = {
  /** Host → main：已准入的目录与 scope，main 不解释项目业务。 */
  ProjectWorkspacePrepared: "project-workspace-prepared",
  DatabaseStartupState: "database-startup-state",
  /** window Host → main: report remote connection progress logs by requestId */
  RemoteWorkspaceConnectionLog: "remote-workspace-connection-log",
  /** window Host → main: remote logical session established */
  RemoteWorkspaceConnected: "remote-workspace-connected",
  /** window Host → main：workspace canonical 准备完成，可安全建立新 attachment */
  RemoteWorkspaceContextBound: "remote-workspace-context-bound",
  /** window Host → main：workspace canonical 准备失败 */
  RemoteWorkspaceContextBindFailed: "remote-workspace-context-bind-failed",
  /** window Host → main：Source transport 重连后 logical session 已换代 */
  RemoteWorkspaceReconnected: "remote-workspace-reconnected",
  /** window Host → main：远程 logical session 建立失败 */
  RemoteWorkspaceConnectFailed: "remote-workspace-connect-failed",
  /** window Host → main: connected remote logical session closed */
  RemoteWorkspaceClosed: "remote-workspace-closed",
  /** Report host-process logs */
  Log: "log",
  /** Spawn a new Agent child process inside the host */
  AgentProcessSpawned: "agent-process-spawned",
  /** The Agent runtime inside the host passed its model-execution gate for the first time */
  AgentProcessReady: "agent-process-ready",
  /** An Agent child process inside the host exited */
  AgentProcessExited: "agent-process-exited",
  /** An Agent child process inside the host failed to start */
  AgentProcessError: "agent-process-error",
  AgentProcessException: "agent-process-exception",
  /** host → main: CPU/RSS sampled within the CLI process */
  AgentResourceSample: "agent-resource-sample",
  /** host → main: CPU/RSS/heap sampled by the Host process itself every 60 seconds (heap source for the resource-telemetry Host role) */
  HostResourceSample: "host-resource-sample",
  /** host → main: lifecycle and memory telemetry for MCP processes in the CLI */
  McpTelemetry: "mcp-telemetry",
  McpResourceSamples: "mcp-resource-samples",
  ToolExecResource: "tool-exec-resource",
  /** The automation Host reports a newly created Session after its first input is accepted. */
  SessionCreateTelemetry: "session-create-telemetry",
  PluginTelemetry: "plugin-telemetry",
  /** host → main：资源管理器采样结果（按 requestId 关联） */
  ResourceUsageSnapshotResult: "resource-usage-snapshot-result",
  NetworkCaptureBatch: "network-capture-batch",
  /** Number of Agent sessions currently executing prompts inside the host changed */
  AgentRunningTaskCountChanged: "agent-running-task-count-changed",
  /** Number of tasks in the specified workspace that have not yet reached a terminal state changed */
  WorkspaceRunningTaskCountChanged: "workspace-running-task-count-changed",
  /** host → main: operation-prompt state for a Windows desktop-local CUA turn */
  CuaOperationState: "cua-operation-state",
  /** Broadcast message */
  Broadcast: "broadcast",
  /** host → main: request an atomic cross-window claim */
  BroadcastClaimRequest: "broadcast-claim-request",
  /** host → main: commit a temporary claim reservation as a permanent claim */
  BroadcastClaimCommit: "broadcast-claim-commit",
  /** host → main: release an uncommitted claim reservation by token */
  BroadcastClaimRelease: "broadcast-claim-release",
  /** host → main: publish a task real-time invalidation */
  TaskRealtimePublish: "task-realtime-publish",
  /** host → main: publish a task stream mirror operation */
  TaskStreamOpPublish: "task-stream-op-publish",
  /** host → main: acquire a task-run lease */
  TaskRunLeaseAcquire: "task-run-lease-acquire",
  /** host → main: release a task-run lease */
  TaskRunLeaseRelease: "task-run-lease-release",
  /** host → main: an observer asks the owner to execute a task command */
  TaskOwnerCommandRequest: "task-owner-command-request",
  /** host → main: the owner returns a task-command result */
  TaskOwnerCommandResult: "task-owner-command-result",
  /** host → main: a Bot requests creating a remote-workspace session */
  BotRemoteWorkspaceReconnectRequest: "bot-remote-workspace-reconnect-request",
  /** host → main: a Bot queries whether the current window already has a remote-workspace session */
  BotRemoteWorkspaceConnectionStatusRequest: "bot-remote-workspace-connection-status-request",
  /** host → main: a Bot requests the remote-workspace runtime RPC port */
  BotRemoteWorkspaceRuntimePortRequest: "bot-remote-workspace-runtime-port-request",
  /** host → main: a Bot requests a web-remote control link for the bound workspace */
  BotRemoteWorkspaceWebRemoteLinkRequest: "bot-remote-workspace-web-remote-link-request",
  /** host → main: an Agent requests sending a message to another session */
  SessionMessageSendRequested: "session-message-send-requested",
  /** host → main: declare that a ZCode Agent session currently belongs to this host */
  SessionRouteAnnounce: "session-route-announce",
  /** host → main: the target host completed local session-message delivery */
  SessionMessageDeliverResult: "session-message-deliver-result",
  /** host → main: ask main to reuse its log-export logic to create a feedback log archive */
  FeedbackLogArchiveRequest: "feedback-log-archive-request",
  /** host → main: scheduled-task dispatch result (success returns taskId/sessionId; failure includes transient/permanent status) */
  CronRunResult: "cron-run-result",
  /** host → main: off-peak-task dispatch result (success returns conversationId/sessionId; failure includes transient/permanent status) */
  OffPeakRunResult: "off-peak-run-result",
  /** host → main: the manual run is persisted; wake the scheduler immediately to claim and dispatch it */
  CronSchedulerWakeRequest: "cron-scheduler-wake-request",
  /** host → main: an off-peak task became schedulable; wake the scheduler immediately to claim and dispatch it (independent of cron messages) */
  OffPeakSchedulerWakeRequest: "off-peak-scheduler-wake-request",
  /** host → main: execute a browser-use command (main executes it with WebContentsView+CDP, correlated by requestId) */
  BrowserExecuteRequest: "browser-execute-request",
  /** host → main: request authorization for a local video path precisely validated by the Agent */
  LocalMediaPreviewPathAuthorizeRequest: "local-media-preview-path-authorize-request",
  /** host → main: register validated plugin UI HTML and CSP in exchange for a sandbox handle (PluginSandboxRegisterRequestPayload) */
  PluginSandboxRegisterRequest: "plugin-sandbox-register-request",
  /** host → main: RPC network telemetry batch (channel.command success rate/latency) */
  NetworkTelemetryBatch: "network-telemetry-batch",
  /** host → main: local Provisioning Source was persisted successfully. */
  ProviderProvisioningSourceChanged: "provider-provisioning-source-changed",
  /** host → main: a Remote Environment sync execution completed. */
  ProviderProvisioningExecutionResult: "provider-provisioning-execution-result",
} as const;

// ============================================================================
// Platform channel type mappings — request/response type safety
// ============================================================================

/** Request/response type mappings for platform channels */
export interface PlatformChannelMap {
  [PlatformChannels.SelectDirectory]: {
    request: void;
    response: string | null;
  };
  [PlatformChannels.GetAppWorktreesDir]: {
    request: void;
    response: string;
  };
  [PlatformChannels.SetDictationSystemMute]: {
    request: { active: boolean };
    response: void;
  };
  [PlatformChannels.SelectDirectories]: {
    request: void;
    response: string[];
  };
  [PlatformChannels.SelectFile]: {
    request: void;
    response: string | null;
  };
  [PlatformChannels.SelectFiles]: {
    request: void;
    response: string[];
  };
  [PlatformChannels.CreateTempTextAttachment]: {
    request: CreateTempTextAttachmentRequest;
    response: CreateTempTextAttachmentResult;
  };
  [PlatformChannels.MaterializeWorkflowArtifactFile]: {
    request: MaterializeWorkflowArtifactFileRequest;
    response: MaterializeWorkflowArtifactFileResult;
  };
  [PlatformChannels.SaveFile]: {
    request: SaveFileRequest;
    response: SaveFileResult;
  };
  [PlatformChannels.PrintToPdf]: {
    request: void;
    response: PrintPageToPdfResult;
  };
  [PlatformChannels.RemoteConnectionLog]: {
    request: {
      label: string;
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      source: string;
      message: string;
      timestamp: string;
    };
    response: void;
  };
  [PlatformChannels.RemoteSessionClosed]: {
    request: RemoteSessionClosedEvent;
    response: void;
  };
  [PlatformChannels.RemoteSessionReconnected]: {
    request: RemoteSessionReconnectedEvent;
    response: void;
  };
  [PlatformChannels.ActivateOrSetWorkspace]: {
    request: string;
    response: { activated: boolean };
  };
  [PlatformChannels.OpenWorkspacePath]: {
    request: string;
    response: void;
  };
  [PlatformChannels.OpenTaskDraft]: {
    request: { path: string; text: string };
    response: void;
  };
  [PlatformChannels.ConnectRemote]: {
    request: ConnectRemoteRequest;
    response: {
      success: boolean;
      error?: string;
      reasonCode?: string;
      retryable?: boolean;
      sessionId?: string;
    };
  };
  [PlatformChannels.RequestSourceSettingsAttachment]: {
    request: { sourceServerId: string };
    response: { attachmentId: string };
  };
  [PlatformChannels.CancelPendingRemoteConnection]: {
    request: CancelPendingRemoteConnectionRequest;
    response: void;
  };
  [PlatformChannels.BindRemoteWorkspaceSessionContext]: {
    request: BindRemoteWorkspaceSessionContextRequest;
    response: import("./platform.js").BindRemoteWorkspaceSessionContextIpcResult;
  };
  [PlatformChannels.StartWebRemoteControl]: {
    request: WebRemoteControlContext;
    response: WebRemoteControlStartOperationResult;
  };
  [PlatformChannels.StopWebRemoteControl]: {
    request: void;
    response: void;
  };
  [PlatformChannels.WebRemoteControlAuthStateChanged]: {
    request: WebRemoteControlAuthStateChange;
    response: void;
  };
  [PlatformChannels.GetWebRemoteControlStatus]: {
    request: void;
    response: WebRemoteControlStatus;
  };
  [PlatformChannels.WebRemoteControlStatusChanged]: {
    request: WebRemoteControlStatus;
    response: void;
  };
  [PlatformChannels.DisposeRemoteSession]: {
    request: string;
    response: void;
  };
  [PlatformChannels.IsDockerAvailable]: {
    request: void;
    response: boolean;
  };
  [PlatformChannels.ListWSLDistros]: {
    request: void;
    response: WSLDistro[];
  };
  [PlatformChannels.ListDockerContainers]: {
    request: void;
    response: DockerContainerInfo[];
  };
  [PlatformChannels.ListSSHConfigAliases]: {
    request: void;
    response: SSHConfigAliasOption[];
  };
  [PlatformChannels.LoadMcpFromUserDirectory]: {
    request: LoadCliMcpFromUserDirectoryRequest;
    response: LoadCliMcpFromUserDirectoryResult;
  };
  [PlatformChannels.SaveMcpToUserDirectory]: {
    request: SaveCliMcpToUserDirectoryRequest;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.MigrateLegacyCommonMcp]: {
    request: MigrateLegacyCommonMcpRequest;
    response: MigrateLegacyCommonMcpResult;
  };
  [PlatformChannels.Log]: {
    request: { level: "info" | "warn" | "error"; args: unknown[] };
    response: void;
  };
  [PlatformChannels.SyncWebRemoteControlWorkspaces]: {
    request: WebRemoteControlWorkspaceTarget[];
    response: void;
  };
  [PlatformChannels.WebRemoteControlReconnectWorkspace]: {
    request: WebRemoteControlReconnectWorkspaceRequest;
    response: WebRemoteControlReconnectWorkspaceResult;
  };
  [PlatformChannels.SyncWindowUnreadCount]: {
    request: number;
    response: void;
  };
  [PlatformChannels.SyncAppSettings]: {
    request: Partial<AppSettings>;
    response: void;
  };
  [PlatformChannels.GetResourceUsageSnapshot]: {
    request: void;
    response: ResourceUsageSnapshot;
  };
  [PlatformChannels.SetResourceUsageSamplingActive]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.StorageStartScan]: {
    request: void;
    response: { jobId: string };
  };
  [PlatformChannels.StorageCancelScan]: {
    request: string;
    response: void;
  };
  [PlatformChannels.StorageGetSnapshot]: {
    request: void;
    response: StorageUsageSnapshot | null;
  };
  [PlatformChannels.StorageClean]: {
    request: StorageCleanRequest;
    response: StorageCleanResult;
  };
  [PlatformChannels.StorageRevealPath]: {
    request: string;
    response: void;
  };
  [PlatformChannels.OpenExternal]: {
    request: string;
    response: void;
  };
  [PlatformChannels.OpenBrowserUrl]: {
    request: EmbeddedBrowserOpenUrlRequest;
    response: void;
  };
  [PlatformChannels.EmbeddedBrowserPermissionPrompt]: {
    request: EmbeddedBrowserPermissionPromptEvent;
    response: void;
  };
  [PlatformChannels.EmbeddedBrowserPermissionResolve]: {
    request: EmbeddedBrowserPermissionResolveRequest;
    response: void;
  };
  [PlatformChannels.GetEmbeddedBrowserSitePermissions]: {
    request: void;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.SetEmbeddedBrowserSitePermission]: {
    request: EmbeddedBrowserSitePermissionUpdateRequest;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.ClearEmbeddedBrowserSitePermissions]: {
    request: void;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.ResetEmbeddedBrowserSitePermission]: {
    request: EmbeddedBrowserSitePermissionResetRequest;
    response: EmbeddedBrowserSitePermissionsSnapshot;
  };
  [PlatformChannels.BrowserViewReady]: {
    request: {
      workspaceKey: string;
      remoteSessionId?: string;
      sessionId: string;
      tabId: string;
      browserId: string;
      browserGeneration: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewVisibility]: {
    request: {
      visible: boolean;
      workspaceKey: string;
      remoteSessionId: string | undefined;
      sessionId: string;
      tabId?: string;
      browserId: string;
      browserGeneration: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewViewportChanged]: {
    request: BrowserViewViewportChangedPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfacePrepare]: {
    request: BrowserViewScreenshotSurfacePreparePayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfaceReady]: {
    request: BrowserViewScreenshotSurfaceReadyPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewScreenshotSurfaceRelease]: {
    request: BrowserViewScreenshotSurfaceReleasePayload;
    response: void;
  };
  [PlatformChannels.BrowserViewCloseTab]: {
    request: BrowserViewCloseTabNotification;
    response: void;
  };
  [PlatformChannels.BrowserViewSuspend]: {
    request: BrowserViewResidencyTransitionPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewRestore]: {
    request: BrowserViewResidencyTransitionPayload;
    response: void;
  };
  [PlatformChannels.CanOpenCommunity]: {
    request: Locale;
    response: boolean;
  };
  [PlatformChannels.OpenInFileManager]: {
    request: string;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.OpenExternalFile]: {
    request: string;
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.OpenCuaPermissionOnboarding]: {
    request: OpenCuaPermissionOnboardingOptions | undefined;
    response: CuaAccessibilitySettingsResult;
  };
  [PlatformChannels.PrepareCuaHelperPermissionDrag]: {
    request: undefined;
    response: PrepareCuaHelperPermissionDragResult;
  };
  // One-way send (not invoke): dragstart must be initiated synchronously and cannot wait for an invoke round trip.
  [PlatformChannels.StartCuaHelperPermissionDrag]: {
    request: undefined;
    response: void;
  };
  [PlatformChannels.NotifyCuaHelperPermissionDragEnded]: {
    request: undefined;
    response: void;
  };
  [PlatformChannels.CancelCuaPermissionOnboarding]: {
    request: { operationId: string };
    response: void;
  };
  [PlatformChannels.OAuthRegisterState]: {
    request: OAuthStateRegistration;
    response: void;
  };
  [PlatformChannels.OAuthCallback]: {
    request: string;
    response: void;
  };
  [PlatformChannels.PaymentCallback]: {
    request: string;
    response: void;
  };
  [PlatformChannels.ShareImport]: {
    request: { shareCode: string };
    response: void;
  };
  [PlatformChannels.OAuthCallbackHandled]: {
    request: void;
    response: void;
  };
  [PlatformChannels.RendererReady]: {
    request: void;
    response: void;
  };
  [PlatformChannels.SyncTelemetryContext]: {
    request: TelemetryRendererContext;
    response: void;
  };
  [PlatformChannels.ReportTelemetryEvent]: {
    request: RendererTelemetryEventPayload;
    response: void;
  };
  [PlatformChannels.ReportArmsCustomEvent]: {
    request: ArmsCustomEventPayload;
    response: void;
  };
  [PlatformChannels.GetRendererActionTraceConfig]: {
    request: void;
    response: RendererActionTraceConfigV1;
  };
  [PlatformChannels.RendererActionTraceConfigChanged]: {
    request: RendererActionTraceConfigV1;
    response: void;
  };
  [PlatformChannels.ReportRendererActionTraceBatch]: {
    request: RendererActionTraceBatchV1;
    response: void;
  };
  // One-way send (not invoke): side-channel telemetry sample every 60 seconds; the renderer does not wait for a main acknowledgment.
  [PlatformChannels.ReportRendererHeapSample]: {
    request: RendererHeapSample;
    response: void;
  };
  [PlatformChannels.ReadFinalArmsCustomEventsE2E]: {
    request: void;
    response: FinalArmsCustomEventE2EEntry[];
  };
  [PlatformChannels.ClearFinalArmsCustomEventsE2E]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ConfigureFinalArmsCustomEventsE2E]: {
    request: ConfigureFinalArmsCustomEventE2ERequest;
    response: void;
  };
  [PlatformChannels.ShowTaskNotification]: {
    request: TaskNotificationPayload;
    response: void;
  };
  [PlatformChannels.TaskNotificationSound]: {
    request: void;
    response: void;
  };
  [PlatformChannels.TaskNotificationClick]: {
    request: string;
    response: void;
  };
  [PlatformChannels.WindowFullscreenChanged]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.GetDesktopWindowChromeState]: {
    request: void;
    response: DesktopWindowChromeState;
  };
  [PlatformChannels.DesktopWindowChromeStateChanged]: {
    request: DesktopWindowChromeState;
    response: void;
  };
  [PlatformChannels.WindowControlsOverlayChanged]: {
    request: WindowControlsOverlayMetrics;
    response: void;
  };
  [PlatformChannels.WindowControlsOverlayReady]: {
    request: WindowControlsOverlayReadyPayload;
    response: void;
  };
  [PlatformChannels.ExportLogs]: {
    request: void;
    response: { success: boolean; path?: string; error?: string };
  };
  [PlatformChannels.CaptureWindowScreenshot]: {
    request: void;
    response: {
      dataBase64: string;
      filename: string;
      contentType: string;
      size: number;
    } | null;
  };
  // CDP-on-guest pivot: the renderer `<webview>` reports the guest webContentsId, then main attaches it.
  [PlatformChannels.BrowserViewAttachGuest]: {
    request: {
      key: string;
      webContentsId: number;
      active?: boolean;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    };
    response: void;
  };
  [PlatformChannels.BrowserViewDetachGuest]: {
    request: { key: string; webContentsId: number };
    response: boolean;
  };
  [PlatformChannels.BrowserViewCloseTabFromRenderer]: {
    request: BrowserViewCloseTabRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewReportResidency]: {
    request: BrowserViewResidencyReportPayload;
    response: void;
  };
  [PlatformChannels.BrowserViewSuspendReady]: {
    request: { tabId: string; generation: number };
    response: void;
  };
  [PlatformChannels.BrowserViewEnsureResident]: {
    request: BrowserViewCloseTabRequest;
    response: void;
  };
  [PlatformChannels.BrowserViewRestoreTabs]: {
    request: BrowserViewRestoreTabsRequest;
    response: BrowserViewRestoredTabShell[];
  };
  [PlatformChannels.BrowserViewUpdateViewport]: {
    request: { tabId: string; viewport: BrowserViewportSize | null };
    response: void;
  };
  [PlatformChannels.EmbeddedBrowserJavaScriptDialog]: {
    request: {
      type: "alert" | "confirm";
      message: string;
    };
    response: {
      handled: boolean;
      value?: boolean;
    };
  };
  [PlatformChannels.UpdateReady]: {
    request: string;
    response: void;
  };
  [PlatformChannels.UpdateCheckResult]: {
    request: UpdateCheckResultPayload;
    response: void;
  };
  [PlatformChannels.UpdateStateChanged]: {
    request: UpdateStatePayload;
    response: void;
  };
  [PlatformChannels.GetUpdateState]: {
    request: void;
    response: UpdateStatePayload;
  };
  [PlatformChannels.DownloadUpdate]: {
    request: void;
    response: void;
  };
  [PlatformChannels.CancelUpdateDownload]: {
    request: void;
    response: void;
  };
  [PlatformChannels.OpenUpdateStatusWindow]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetAutoUpdatePreferences]: {
    request: void;
    response: {
      autoDownloadAndInstallUpdates: boolean;
    };
  };
  [PlatformChannels.SetAutoDownloadAndInstallUpdates]: {
    request: boolean;
    response: void;
  };
  [PlatformChannels.SettingsChanged]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ApplicationLocaleChanged]: {
    request: Locale;
    response: void;
  };
  [PlatformChannels.GetSystemLocale]: {
    request: void;
    response: Locale;
  };
  [PlatformChannels.GetDesktopSessionActivity]: {
    request: void;
    response: {
      runningAgentSessionCount: number;
    };
  };
  [PlatformChannels.GetDesktopZoomLevel]: {
    request: void;
    response: DesktopZoomState;
  };
  [PlatformChannels.DesktopZoomLevelChanged]: {
    request: DesktopZoomState;
    response: void;
  };
  [PlatformChannels.PostUpdateReleaseNotes]: {
    request: PostUpdateReleaseNotesPayload;
    response: void;
  };
  [PlatformChannels.AcknowledgePostUpdateReleaseNotes]: {
    request: string;
    response: void;
  };
  [PlatformChannels.SkipUpdateVersion]: {
    request: string;
    response: void;
  };
  [PlatformChannels.QuitAndInstallUpdate]: {
    request: void;
    response: void;
  };
  [PlatformChannels.GetInstalledEditors]: {
    request: string | undefined;
    response: EditorInfo[];
  };
  [PlatformChannels.GetApplicationIcon]: {
    request: string | import("./platform.js").ApplicationIconRequest;
    response: import("./platform.js").ApplicationIconInfo | null;
  };
  [PlatformChannels.OpenInEditor]: {
    request: { editorId: string; path: string; options?: OpenInEditorOptions };
    response: { success: boolean; error?: string };
  };
  [PlatformChannels.CloseActiveContextRequest]: {
    request: void;
    response: void;
  };
  [PlatformChannels.ExecuteDesktopCommand]: {
    request: DesktopCommandId;
    // The return value passes through from the main-process handler (GetCuaOsSupport returns CuaOsSupport),
    // matching the renderer-side IPlatformService.executeDesktopCommand Promise<unknown>.
    response: unknown;
  };
  [PlatformChannels.SetApplicationLocale]: {
    request: Locale;
    response: void;
  };
  [PlatformChannels.SetTitleBarTheme]: {
    request: DesktopTitleBarTheme;
    response: void;
  };
}
