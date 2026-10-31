import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";
import type { ComposerDraftHandoff } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import type { RefObject } from "react";
import type {
  ZCodeProvider,
  SessionCreateSource,
  ZCodeTaskRuntimeStatus,
  ZCodeTaskMeta,
  GitChangeSourceId,
  DesktopWindowChromeState,
  IPlatformService,
  RemoteTarget,
  SourceServerUpdateTarget,
  RemoteWorkspaceSessionEntry,
  UpdateStatePayload,
  UserInfo,
} from "@zcode/shared";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import type { SavedWorkflowsOpenTarget } from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import type { SavedWorkflowHubTarget } from "@/v4/savedWorkflowHubContext.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";
import type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type {
  BrowserSidePaneMetadata,
  OpenScopedSubagentSideTabRequest,
  OpenBackgroundBashSideTabRequest,
  OpenSelectionSideChatRequest,
  OpenScopedPlanDetailSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { Theme } from "@/useTheme.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import type { TaskFindDialogProps } from "@/quickpick/TaskFindDialog.js";
import type { AutomationsNavigationTab, OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { SidePaneFullViewController } from "@/side-pane-full-view/contract.js";

export interface WorkspaceShellZCodeState {
  activeTaskId: WorkspaceZCodeUIState["activeTaskId"];
  draftFocusVersion: WorkspaceZCodeUIState["draftFocusVersion"];
  modelSwitchPending: WorkspaceZCodeUIState["modelSwitchPending"];
  modelSwitchStage: WorkspaceZCodeUIState["modelSwitchStage"];
  selectedProvider: WorkspaceZCodeUIState["selectedProvider"];
  optimisticTaskListByTaskId: WorkspaceZCodeUIState["optimisticTaskListByTaskId"];
  workspaceInit: WorkspaceZCodeUIState["workspaceInit"];
  taskStatus: ZCodeTaskRuntimeStatus;
  taskError: string | null;
}

export interface CreateTaskOptions {
  /** Renderer-originator lease; must not navigate if cancelled or the draft changed during async preparation. */
  isCurrent?: () => boolean;
  remoteProjectMembershipId?: string;
  /** Notifies the originating view only after the target is prepared and the new draft is navigated to; does not auto-send. */
  onComplete?: () => void;
  onError?: (error: unknown) => void;
  /** An async prefill may only be committed to the same new-task target that existed when the Skill was resolved. */
  expectedWorkspaceKey?: string;
  provider?: ZCodeProvider;
  projectId?: string | null;
  /** Idempotent identity for unclassified-task catalog preparation; not a session identity. */
  draftId?: string;
  /** Grouping/organization intent only; does not decide the executing project or cwd. */
  taskGroupId?: string | null;
  hostId?: string;
  createSource?: SessionCreateSource;
  /** Prefill text for the new draft's input box; writes the draft only, does not auto-send. */
  initialPrompt?: string;
  /** Current-draft handoff after project creation; passed in renderer memory only. */
  initialComposerDraft?: ComposerDraftHandoff;
  /** Structured mention matching the initialPrompt canonical prefix; for editor display only. */
  initialPromptMention?: ComposerMentionPrefill;
  /** Which workspace the new task lands in; defaults to the active workspace. */
  targetWorkspace?: {
    projectId?: string | null;
    hostId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  };
}

export type CreateTaskRequest = ZCodeProvider | CreateTaskOptions;

export interface RemoteWorkspaceRecoveryStatus {
  mode: "automatic" | "manual";
  attempt?: number;
  limit?: number;
}

/** Renderer connection feedback only; not passed into the Host recovery/telemetry protocol. */
export interface RemoteConnectionFeedbackOptions {
  announceReusedConnection?: boolean;
}

export type DeviceAdditionResult =
  | { kind: "connected"; sourceServerId: string | undefined }
  | { kind: "cancelled"; background?: boolean };

/** Original-owner reference held in the current renderer's memory only; drafts and credentials are not serialized. */
export interface DeviceAdditionReturnTarget {
  /**
   * Existing device connections stay on their original project page; only adding a device round-trips through settings.
   * data-sync: launched from "Settings → Data Sync" (connecting an existing device or adding one),
   * stays on the data-sync page when done and does not jump to the "Remote Devices" page.
   */
  kind: "connect-device" | "add-device" | "data-sync";
  isCurrent(): boolean;
  /** Delivers connection-layer visibility only; the original owner decides its own submit gating. */
  onVisibilityChange?(visible: boolean): void;
  /** The original owner validates async membership before return navigation; Root then re-validates the original intent. */
  canFinish?(result: DeviceAdditionResult): Promise<boolean>;
  finish(result: DeviceAdditionResult): void | Promise<void>;
}

export interface RemoteConnectionOpenPreference {
  returnTarget?: DeviceAdditionReturnTarget;
  /** The completion intent is fixed by the originating entry point; credentials, install, and retry must not replace it. */
  completion?: "device-management";
  /** Failure/waiting facts handed over for in-place reconnect; shown only when opened, never auto-resent. */
  initialFailure?: {
    code?: string;
    message: string;
    logs?: RemoteConnectionLogEntry[];
    profileId?: string;
    /** Non-sensitive failure identity fixed before the handoff; not rebuilt from the latest Profile. */
    failedTarget?: SourceServerUpdateTarget;
    resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
  };
  /** Connection intent for an existing project; after install/upgrade/credential flows finish, still opens that directory. */
  preferredDirectoryPath?: string;
  preferredWorkspaceTabId?: string;
  /** A saved project not loaded in a tab; restores that entry when done instead of entering new-project selection. */
  preferredProjectEntryId?: string;
  preferredTarget?: RemoteTarget;
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
  preferredSourceServerId?: string;
  /** The Profile the user precisely selected when clicking "Connect" from device/connection records; after the dialog consumes it, jumps straight to step 4. */
  preferredProfileId?: string;
}

export interface AppProps {
  services: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  onConnectRemote: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
    preparedWorkspaceIdentity?: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onLogout?: () => void;
  onLogin?: () => void;
  user?: UserInfo | null;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceRecoveryByWorkspaceKey?: Record<string, RemoteWorkspaceRecoveryStatus>;
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;

  remoteConnectionLogs?: RemoteConnectionLogEntry[];
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask?: () => void;
  onCreateConversationTaskOnSource?: (sourceServerId: string) => void;
  /** Resolves the "work outside a project" target; identity is provided by Root per Source ownership — the Shell must not reverse-lookup by path. */
  onResolveConversationWorkspace?: () => Promise<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
  onOpenWorkspace: () => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void | boolean;
  remoteConnectionInProgress?: boolean;
  onReturnToWorkspace?: () => void;
  allowOpenWorkspace?: boolean;
  webRemoteControlWorkspaceSwitcher?: WebRemoteControlWorkspaceSwitcherApi;
  initialSidebarFileTreeOpen?: boolean;
  initialWebRemoteControlMobileNavigationIntent?: import("@zcode/shared").WebRemoteControlMobileNavigationIntent;
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
  allowRemoteWorkspace?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  workspaceAbsPath: string;
  workspaceRemoteSessionId?: string;
  workspaceIdentity?: string;
  isWorkspaceVisible?: boolean;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  supportsEmbeddedBrowser?: boolean;
}

export interface GitChangeSummary {
  added: number;
  removed: number;
}

export type WorkspaceMainView = "chat" | "automations" | "plugin-store";

export interface WorkspaceShellLayoutProps extends Omit<AppProps, "baseFeedbackService"> {
  onCreateTaskInWorkspace?: (
    workspacePath: string,
    workspaceIdentity?: string,
  ) => void | Promise<void>;
  workspaceReadOnlyReason?: string;
  workspaceMainView: WorkspaceMainView;
  pluginStoreOpenVersion: number;
  openAutomationId: string | null;
  openAutomationTab: AutomationsNavigationTab | null;
  /** Hub deep link: lands on a saved workflow's detail page; cleared by `onOpenWorkflowConsumed` once located. */
  openWorkflow: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed: () => void;
  /**
   * Completion card's "Saved" chip → that hub page (docs/dynamic-workflow/transcript-and-notifications.md,
   * "Saving the run, and running it again"): switches to the automations main view's "Workflows" tab and sets the deep link.
   */
  onOpenSavedWorkflowInHub: (target: SavedWorkflowHubTarget) => void;
  onWorkspaceMainViewChange: (view: WorkspaceMainView) => void;
  onOpenAutomationConsumed: () => void;
  handleOpenAutomations: OpenAutomationsMain;
  handleOpenPluginStore: () => void;
  workspaceShellZCodeState: WorkspaceShellZCodeState;
  theme: Theme;
  isMacFullscreen: boolean;
  desktopWindowChromeState: DesktopWindowChromeState | null;
  macWindowControlsLeftPaddingPx: number;
  windowsWindowControlsRightPaddingPx: number;
  updateReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
  sidebarContainerRef: RefObject<HTMLElement | null>;
  toggleSidebarShortcutLabel: string;
  newTaskShortcutLabel: string;
  goBackShortcutLabel: string;
  goForwardShortcutLabel: string;
  toggleSidePaneShortcutLabel: string;
  /** "Enter / exit full view" shortcut label (desktop only). */
  toggleSidePaneFullViewShortcutLabel?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  canTaskNavBack: boolean;
  canTaskNavForward: boolean;
  isTerminalOpen: boolean;
  isSidebarVisible: boolean;
  isBrowserOpen: boolean;
  supportsEmbeddedBrowser: boolean;
  isGitOpen: boolean;
  isSidePaneOpen: boolean;
  /** Side Pane full-view controller (desktop only; spec: docs/ui/side-pane-full-view.md). */
  sidePaneFullView?: SidePaneFullViewController;
  summaryPanelVariantOverride: ChatViewSummaryPanelVariant | null;
  onSummaryPanelVariantOverrideChange: (variant: ChatViewSummaryPanelVariant | null) => void;
  sidePaneState: WorkspaceSidePaneState | null;
  recentClosedSidePaneTabs: RecentClosedSidePaneTab[];
  shellPanelIds: string[];
  projectName: string;
  workspaceTabs: Array<{
    workspacePath: string;
    label: string;
    remoteSessionId?: string;
    remoteTarget?: import("@zcode/shared").RemoteTarget;
    workspaceIdentity?: string;
    workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    localWorkspacePath?: string;
    availability?: import("@/store/tabStore.js").WorkspaceAvailability;
  }>;
  activeTaskId: string | null;
  /** Formal session-owner id of the right pane; empty for drafts — the pane's internal warm-up session is not copied. */
  sidePaneOwnerId: string | null;
  activeTraceId: string | null;
  activeSessionId: string | null;
  activeTaskProvider: ZCodeProvider | null;
  resolvedActiveTaskMeta?: ZCodeTaskMeta | null;
  activeTaskTitle: string;
  activeTaskChangeSummary: ReturnType<
    typeof import("@/lib/taskChangeSummary.js").getTaskChangeSummary
  >;
  gitWorktreeReviewSourceId: GitChangeSourceId | null;
  gitWorktreeChangeSummary: GitChangeSummary;
  activeGitSourceId: GitChangeSourceId;
  gitState: ReturnType<typeof import("@/hooks/useGitRepository.js").useGitRepository>;
  gitReviewState: ReturnType<typeof import("@/hooks/useGitRepository.js").useGitRepository>;
  handleRefreshGitReview: () => void;
  gitRepositoryWorkspacePath: string;
  browserNavigationRequest: BrowserNavigationRequest | null;
  browserRestoreUrls: Record<string, string>;
  providerConfigFile: ReturnType<
    typeof import("@/hooks/useWorkspaceProviderConfigFile.js").useWorkspaceProviderConfigFile
  >;
  taskNativeSessionLogFile: ReturnType<
    typeof import("@/hooks/useTaskNativeSessionLogFile.js").useTaskNativeSessionLogFile
  >;
  taskSessionFile: ReturnType<
    typeof import("@/hooks/useTaskSessionFilePath.js").useTaskSessionFilePath
  >;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  conversationFindQuery: string;
  onConversationFindMatchStateChange: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  appLogoUrl: string;
  platform: IPlatformService;
  reloadSessionDisabled: boolean;
  reloadSessionPending: boolean;
  handleReloadSession: (options?: {
    resumeTaskId?: string | null;
    provider?: ZCodeProvider | null;
  }) => Promise<void>;
  handleSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  handleTaskNavBack: () => void;
  handleTaskNavForward: () => void;
  handleStartDraftInWorkspace: (
    targetWorkspacePath: string,
    targetWorkspaceIdentity?: string,
    targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
    createSource?: SessionCreateSource,
  ) => void;
  handleOpenCommandCenter: () => void;
  handleRefreshGit: () => void;
  handleBrowserUrlChange: (tabId: string, url: string) => void;
  handleBrowserPageMetadataChange: (tabId: string, metadata: BrowserSidePaneMetadata) => void;
  handleToggleSidebar: () => void;
  handleToggleTerminal: () => void;
  handleToggleBrowser: () => void;
  handleOpenBrowserTab: () => void;
  handleOpenBrowserPermissionSettings: (origin: string) => void;
  handleOpenWhiteboard: () => void;
  handleOpenDeveloperTools: () => void;
  handleOpenFileManager: (target?: FileManagerTarget) => void;
  handleNavigateFileManager: (tabId: string, source: CodeViewerSource) => void;
  handleOpenPluginMarket: () => void;
  handleOpenTerminalTab: () => void;
  handleOpenModelTrajectory: (params: {
    taskId: string;
    title?: string | null;
    kind?: "v1" | "v2";
  }) => void;
  handleToggleGit: () => void;
  handleOpenGitReview: (sourceId?: GitChangeSourceId) => void;
  handleToggleSidePane: () => void;
  handleOpenBrowserUrl: (url: string) => void;
  handleOpenCodeViewer: (source: CodeViewerSource) => void;
  handleAutoOpenAssistantPptx: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  handleOpenBackgroundBash: (request: OpenBackgroundBashSideTabRequest) => void;
  handleOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  handleOpenSubagentDirectory: (
    request: import("@/lib/workspaceSidePane.js").OpenScopedSubagentDirectorySideTabRequest,
  ) => void;
  handleSyncSubagentSessionTabs: (
    request: import("@/lib/workspaceSidePane.js").SyncSubagentSessionTabsRequest,
  ) => void;
  handleOpenSelectionSideChat: (request: OpenSelectionSideChatRequest) => void;
  handleOpenPlanDetail: (request: OpenScopedPlanDetailSideTabRequest) => void;
  handleOpenWorkflowRun: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  handleOpenWorkflowRunDirectory: (
    request: import("@/lib/workspaceSidePane.js").OpenScopedWorkflowRunDirectorySideTabRequest,
  ) => void;
  handleOpenWorkflowActorSession: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  handleOpenWorkflowWorkspace: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  handleOpenWorkflowArtifact: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  handleCloseCodeViewer: () => void;
  handleCloseGit: () => void;
  handleOpenNewSidePaneTab: () => void;
  handleActivateSidePaneTab: (tabId: string) => void;
  handleReorderSidePaneTab: (activeTabId: string, overTabId: string) => void;
  handleCloseSidePaneTab: (tabId: string) => void;
  handleCloseOtherSidePaneTabs: (tabId: string) => void;
  handleCloseAllSidePaneTabs: () => void;
  handleReopenClosedSidePaneTab: (tabId: string) => void;
  handleBrowserNavigationRequestHandled: (requestId: string) => void;
  setIsTerminalOpen: (open: boolean) => void;
  setGitSelectedSourceId: (value: GitChangeSourceId) => void;
  taskFindDialogProps: TaskFindDialogProps;
}
