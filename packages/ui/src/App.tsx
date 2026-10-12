import { PluginUiWorkspaceProvider } from "@/plugin-ui/index.js";
/* eslint-disable max-lines -- App currently orchestrates workspace-level state, navigation, derived Git data, and shell wiring; the new side-pane memory bridge has been extracted, and further splitting should follow shell boundaries. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { resolveWorkspaceKey, type GitChangeSourceId, type WorkspacePurpose } from "@zcode/shared";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { getVisibleTaskMetas, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { useAppKeyboard } from "@/hooks/useAppKeyboard.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useWorkspaceActiveTaskState } from "@/hooks/useWorkspaceActiveTaskState.js";
import { useEnsureWorkspaceMcpLoaded } from "@/hooks/useEnsureWorkspaceMcpLoaded.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useBranchMergeStatusStore } from "@/store/branchMergeStatusStore.js";
import { isWorkspaceReadOnly, isWorkspaceTab } from "@/store/tabStore.js";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { getPathLeaf } from "@/lib/path.js";
import {
  addPluginStoreOpenListener,
  type PluginStoreOpenTarget,
} from "@/lib/pluginStoreNavigation.js";
import { resolveWorkspaceSwitchDraftProvider } from "@/lib/workspaceDraftProvider.js";
import { useTestActions } from "@/test-actions.js";
import type { TestActions } from "@/test-actions.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import type { TaskFindDialogProps } from "@/quickpick/TaskFindDialog.js";
import {
  changeTaskFindSelection,
  createTaskFindNavigationState,
  navigateTaskFindSelection,
} from "@/quickpick/taskFindNavigationState.js";
import { createQuickPickCommands } from "@/quickpick/quickPickCommands.js";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import { FeedbackHost } from "@/feedback/FeedbackHost.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import {
  resolveQuickPickConversationNavigation,
  selectQuickPickConversationTaskIds,
} from "@/lib/quickPickConversationNavigation.js";
import {
  setPendingSettingsPluginIntent,
  setPendingSettingsSection,
  type SettingsSectionId,
} from "@/lib/settingsNavigation.js";
import { runWorkspaceVisibleCommand } from "@/lib/workspaceVisibleCommand.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";
import appLogoUrl from "@/assets/provider-icons/logo-zai.svg";
import { resolveTheme, type ResolvedTheme } from "@/useTheme.js";
import { WorkspaceShellLayout } from "@/app-shell/WorkspaceShellLayout.js";
import { useAppChromeState } from "@/app-shell/useAppChromeState.js";
import { useWorkspaceSessionReload } from "@/app-shell/useWorkspaceSessionReload.js";
import { useWorkspaceShellLifecycle } from "@/app-shell/useWorkspaceShellLifecycle.js";
import { useWorkspaceShellZCodeState } from "@/app-shell/useWorkspaceShellZCodeState.js";
import { useWorkspaceMainViewSettingsExit } from "@/app-shell/useWorkspaceMainViewSettingsExit.js";
import {
  useWorkspaceTaskNavigation,
  type AutomationsNavigationTarget,
} from "@/app-shell/useWorkspaceTaskNavigation.js";
import { useTaskSidePaneMemoryBridge } from "@/app-shell/useTaskSidePaneMemoryBridge.js";
import { resolveAppWorkspaceRpcTarget } from "@/app-shell/workspaceRpcTarget.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceTerminalTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { useMarketingTaskCompletionRefresh } from "@/components/marketing-touch/useMarketingTaskCompletionRefresh.js";
import { useOffPeakTaskNotifications } from "@/hooks/useOffPeakTaskNotifications.js";
import type { AppProps, WorkspaceMainView } from "@/app-shell/types.js";
import type {
  ChatSearchResultHighlightRequest,
  ChatViewSummaryPanelVariant,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import { getActiveSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { taskListE2EActions } from "@/lib/taskListE2EActions.js";
import {
  CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
  getCloseActiveContextSidePaneTab,
} from "@/lib/closeActiveContext.js";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import type { SavedWorkflowHubTarget } from "@/v4/savedWorkflowHubContext.js";
import type { SavedWorkflowsOpenTarget } from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import { startMemoryDiagnosticsLogger } from "@/lib/memoryDiagnostics.js";

const EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY: NonNullable<
  AppProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"]
> = {};
const EMPTY_REMOTE_CONNECTION_LOGS: NonNullable<AppProps["remoteConnectionLogs"]> = [];
const EMPTY_REMOTE_WORKSPACE_SESSIONS: NonNullable<AppProps["remoteWorkspaceSessions"]> = [];

export function App({
  services,
  baseFeedbackService,
  onConnectRemote,
  onSelectRemoteProject,
  onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  onLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey = EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY,
  remoteConnectionLogs = EMPTY_REMOTE_CONNECTION_LOGS,
  onCreateTask,
  onCreateConversationTask,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  onCreateScratchWorkspace,
  remoteConnectionInProgress = false,
  onReturnToWorkspace,
  allowOpenWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialWebRemoteControlMobileNavigationIntent,
  initialWebRemoteControlWorkspaceList,
  webRemoteControlTerminalTransportState,
  allowRemoteWorkspace = true,
  remoteWorkspaceSessions = EMPTY_REMOTE_WORKSPACE_SESSIONS,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity: explicitWorkspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
}: AppProps) {
  // Read display labels from the effective shortcut map so tooltips update when users rebind keys; do not hard-code key names.
  const toggleSidebarShortcutLabel = useShortcutCommandLabel("toggleSidebar");
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  const goBackShortcutLabel = useShortcutCommandLabel("navigateBack");
  const goForwardShortcutLabel = useShortcutCommandLabel("navigateForward");
  const toggleTerminalShortcutLabel = useShortcutCommandLabel("toggleTerminal");
  const toggleSidePaneShortcutLabel = useShortcutCommandLabel("toggleSidePane");
  const openWorkspaceShortcutLabel = useShortcutCommandLabel("openWorkspace");
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const { intl, locale, setLocale } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const platform = usePlatform();
  // Local process-memory diagnostics use one 60-second sampler per window.
  // After gating, data is written to the desktop main log; this is a no-op on Web without a logging bridge. The same reading also goes through the preload bridge to the main process's
  // renderer_main resource event, and is likewise a no-op when no bridge is available.
  const reportRendererHeapSample = platform.reportRendererHeapSample;
  useEffect(() => {
    const memoryDiagnosticsLogger = startMemoryDiagnosticsLogger({
      reportHeapSample: reportRendererHeapSample,
    });
    return () => memoryDiagnosticsLogger.stop();
  }, [reportRendererHeapSample]);
  const activeWorkspaceRpcTarget = useTabStore(
    useShallow((state) => {
      if (!state.activeTabId) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (
        !activeTab ||
        !isWorkspaceTab(activeTab) ||
        activeTab.workspacePath !== workspaceAbsPath
      ) {
        return {
          workspaceIdentity: undefined,
          remoteSessionId: undefined,
          remoteTarget: undefined,
        };
      }

      return {
        workspaceIdentity: activeTab.workspaceIdentity,
        remoteSessionId: activeTab.remoteSessionId,
        remoteTarget: activeTab.remoteTarget,
      };
    }),
  );
  const workspaceRpcTarget = resolveAppWorkspaceRpcTarget({
    activeTarget: activeWorkspaceRpcTarget,
    explicitWorkspaceIdentity,
    explicitRemoteSessionId: workspaceRemoteSessionId,
  });
  // When a Settings tab overlays a workspace, the active tab is not a workspace tab.
  // Use the workspaceIdentity passed by Root as a fallback; otherwise, a disconnected remote workspace could warm up /home/... as the local base workspace.
  const workspaceIdentity = workspaceRpcTarget.workspaceIdentity;
  const { rpcReady: workspaceRpcReady } = useWorkspaceServicesResolution(
    workspaceAbsPath,
    workspaceRpcTarget.remoteSessionId,
    workspaceIdentity,
    workspaceRpcTarget.remoteTarget,
  );
  const workspaceReadOnly = useTabStore((state) =>
    isWorkspaceReadOnly(state, workspaceAbsPath, workspaceIdentity),
  );
  const workspaceReadOnlyReason = workspaceReadOnly
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const { workspaceShellZCodeState, reloadSessionDisabled } = useWorkspaceShellZCodeState(
    workspaceAbsPath,
    workspaceIdentity,
  );
  const activeTaskId = workspaceShellZCodeState.activeTaskId;
  // The right sidebar's ownership ID is scoped to a conversation. During a draft, activeTaskId is null, so use draftSessionId instead
  // (draftSessionId is stable, unique to each new conversation, and becomes activeTaskId after the first message is sent),
  // preventing a new conversation from inheriting tabs left by the previous conversation or draft, while preserving ownership when the draft becomes a task.
  const draftSessionId = useZCodeSessionStore(
    (state) => state.getWorkspaceState(workspaceAbsPath, workspaceIdentity).draftSessionId,
  );
  const sidePaneOwnerId = activeTaskId ?? draftSessionId ?? null;
  const [summaryPanelVariantOverride, setSummaryPanelVariantOverride] =
    useState<ChatViewSummaryPanelVariant | null>(null);
  const draftFocusVersion = workspaceShellZCodeState.draftFocusVersion;
  const {
    isTerminalOpen,
    setIsTerminalOpen,
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    browserNavigationRequest,
    setBrowserNavigationRequest,
    handleOpenCodeViewer,
    handleOpenCodeViewers,
    handleOpenBrowserUrl,
    handleToggleBrowser,
    handleOpenBrowserTab,
    handleOpenBrowserPermissionSettings,
    handleToggleGit,
    handleOpenGit,
    handleOpenTreemapping,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenTerminalTab,
    handleOpenSubagentSession,
    handleOpenBackgroundBash,
    handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat,
    handleOpenPlanDetail,
    handleOpenPluginUi,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    handleOpenWorkflowArtifact,
    handleToggleTerminal,
    handleToggleSidebar,
    handleToggleSidePaneCollapse,
    handleCloseCodeViewer,
    handleCloseGit,
    handleActivateSidePaneTab,
    handleReorderSidePaneTab,
    handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs,
    handleCloseAllSidePaneTabs,
    handleReopenClosedSidePaneTab,
    handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange,
  } = useAppPanels({
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    isWorkspaceVisible,
    supportsEmbeddedBrowser,
    platform,
    defaultWhiteboardNamePrefix: intl.formatMessage({
      id: "whiteboard.defaultName",
    }),
  });
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const notificationEnabled = useZCodeStore((s) => s.notificationEnabled);
  useMarketingTaskCompletionRefresh({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { endpointKey: workspaceRemoteSessionId } : {}),
    rpcReady: workspaceRpcReady,
  });
  useWorkspaceTerminalTaskNotifications({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { endpointKey: workspaceRemoteSessionId } : {}),
    enabled: notificationEnabled,
    rpcReady: workspaceRpcReady,
    platform,
    formatMessage: intl.formatMessage,
  });
  // Idle-task terminal-state / awaiting-confirmation notifications use only the local desktop path; the main process deduplicates cross-window duplicates by status:taskId.
  useOffPeakTaskNotifications({
    offPeakTaskService: services.offPeakTaskService,
    platform,
    enabled: Boolean(notificationEnabled && isDesktop),
    formatMessage: intl.formatMessage,
  });
  const lastHandledDraftSidePaneCloseRef = useRef({
    workspaceKey,
    draftFocusVersion,
  });

  useEffect(() => {
    const previous = lastHandledDraftSidePaneCloseRef.current;
    if (previous.workspaceKey !== workspaceKey) {
      lastHandledDraftSidePaneCloseRef.current = {
        workspaceKey,
        draftFocusVersion,
      };
      return;
    }

    if (previous.draftFocusVersion === draftFocusVersion) {
      return;
    }

    lastHandledDraftSidePaneCloseRef.current = {
      workspaceKey,
      draftFocusVersion,
    };
    if (draftFocusVersion === 0) {
      return;
    }

    // Creating a task only changes activeTaskId to a draft; it does not trigger a workspace-level memory switch in the side pane.
    // Use the version incremented by startDraft to consistently collapse the right pane across the button, menu, shortcut, and remote-control entry points.
    const sidePaneTabCount = sidePaneState?.tabs.length ?? 0;
    if (!isSidePaneCollapsed) {
      logger.info(
        `[App] 新建任务时收起右侧面板 workspace=${workspaceAbsPath} tabs=${sidePaneTabCount}`,
      );
      setIsSidePaneCollapsed(true);
    }
  }, [
    draftFocusVersion,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    sidePaneState,
    workspaceAbsPath,
    workspaceKey,
  ]);
  const [testMessages, setTestMessages] = useState<TestChatMessage[] | null>(null);
  const [isQuickPickOpen, setIsQuickPickOpen] = useState(false);
  const [isTaskFindOpen, setIsTaskFindOpen] = useState(false);
  const [taskFindFocusRequestId, setTaskFindFocusRequestId] = useState(0);
  const [conversationFindState, setConversationFindState] = useState(createTaskFindNavigationState);
  const [conversationFindMatchCount, setConversationFindMatchCount] = useState(0);
  const searchResultHighlightRequestIdRef = useRef(0);
  const [searchResultHighlightRequest, setSearchResultHighlightRequest] =
    useState<ChatSearchResultHighlightRequest | null>(null);
  const [fileChangeFindState, setFileChangeFindState] = useState(createTaskFindNavigationState);
  const [fileChangeFindMatchCount, setFileChangeFindMatchCount] = useState(0);
  const [canOpenCommunityFromQuickPick, setCanOpenCommunityFromQuickPick] = useState(false);
  const [gitSelectedSourceId, setGitSelectedSourceId] = useState<GitChangeSourceId>("unstaged");
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const { browserRestoreUrls, handleBrowserUrlChange } = useTaskSidePaneMemoryBridge({
    activeTaskId,
    gitSelectedSourceId,
    setGitSelectedSourceId,
    workspaceAbsPath,
    workspaceIdentity,
  });
  const theme = useZCodeStore((s) => s.theme);
  const setTheme = useZCodeStore((s) => s.setTheme);
  const palette = useZCodeStore((s) => s.palette);
  const setPalette = useZCodeStore((s) => s.setPalette);
  const [systemResolvedTheme, setSystemResolvedTheme] = useState<ResolvedTheme>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : "dark",
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => {
      setSystemResolvedTheme(mediaQuery.matches ? "dark" : "light");
    };
    syncSystemTheme();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncSystemTheme);
      return () => mediaQuery.removeEventListener("change", syncSystemTheme);
    }
    mediaQuery.addListener(syncSystemTheme);
    return () => mediaQuery.removeListener(syncSystemTheme);
  }, []);
  const resolvedTheme = theme === "system" ? systemResolvedTheme : resolveTheme(theme);
  const {
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
  } = useAppChromeState({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
    workspaceAbsPath,
  });
  const tabs = useTabStore((s) => s.tabs);
  const addTab = useTabStore((s) => s.addTab);
  const activateTabByPath = useTabStore((s) => s.activateTabByPath);

  const {
    resolvedActiveTaskMeta,
    activeTraceId,
    activeSessionId,
    activeTaskProvider,
    workspaceHeaderProvider,
    activeTaskChangeSummary,
    activeTaskTitle,
    taskNativeSessionLogFile,
    taskSessionFile,
  } = useWorkspaceActiveTaskState({
    workspaceAbsPath,
    activeTaskId,
    workspaceRemoteSessionId,
    workspaceIdentity,
    selectedProvider: workspaceShellZCodeState.selectedProvider,
    intl,
  });
  const providerConfigFile = useWorkspaceProviderConfigFile(
    workspaceAbsPath,
    workspaceHeaderProvider,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const workspaceTabs = useMemo(
    () =>
      tabs.filter(isWorkspaceTab).map((tab) => ({
        workspacePath: tab.workspacePath,
        label: tab.label,
        remoteSessionId: tab.remoteSessionId,
        remoteTarget: tab.remoteTarget,
        workspaceIdentity: tab.workspaceIdentity,
        workspacePurpose: tab.workspacePurpose,
        localWorkspacePath: tab.localWorkspacePath,
        availability: tab.availability,
      })),
    [tabs],
  );
  const commandCenterWorkspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const activeSidePaneTab = useMemo(() => getActiveSidePaneTab(sidePaneState), [sidePaneState]);
  const isBrowserOpen = activeSidePaneTab?.type === "browser";
  const isGitOpen = activeSidePaneTab?.type === "git";
  const hasGitTab = sidePaneState?.tabs.some((tab) => tab.type === "git") ?? false;
  const handleRefreshGit = useCallback(() => {
    setGitRefreshVersion((value) => value + 1);
    // Сигнал успешной git-мутации (смена ветки/создание/коммит) для проб
    // merge-статуса: сервисный кэш уже инвалидирован, пробе остаётся
    // переопросить. Untouched workspace'ы упрутся в сервисный TTL — дешёво.
    useBranchMergeStatusStore.getState().requestRefresh();
  }, []);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const gitState = useGitRepository({
    workspacePath: workspaceAbsPath,
    activeTaskId,
    includeExtendedData: hasGitTab,
    // Key logic: fetch real Git data only when the workspace changes, the Git pane opens, or the user explicitly refreshes.
    // Task switches and last-turn summary changes update only local derived data; they do not rerun Git commands.
    refreshToken: gitRefreshVersion,
    remoteSessionId: workspaceRpcTarget.remoteSessionId ?? null,
    remoteTarget: workspaceRpcTarget.remoteTarget,
    workspaceIdentity,
  });
  useGitAutoRefresh({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: workspaceRpcTarget.remoteSessionId ?? null,
    gitSummary: gitState.summary,
    gitSummaryWorkspaceKey: gitState.workspaceKey,
    enabled: isWorkspaceVisible,
    onRefreshGit: handleRefreshGit,
  });
  const activeGitSourceId =
    gitState.sourceOptions.find((option) => option.id === gitSelectedSourceId)?.id ??
    gitState.sourceOptions[0]?.id ??
    "unstaged";
  const gitChangeSummaryBySourceId = useMemo(() => {
    // Key business logic: the workspace header and Git pane use the same source statistics.
    // Aggregate each source's +/- values into a stable mapping to avoid inconsistent display from duplicate calculations.
    return Object.fromEntries(
      gitState.sourceOptions.map((option) => {
        const dataset = gitState.datasets[option.id] ?? gitState.datasets.unstaged;
        const summary = dataset.sections
          .flatMap((section) => section.changes)
          .reduce(
            (result, change) => {
              result.added += change.added;
              result.removed += change.removed;
              return result;
            },
            { added: 0, removed: 0 },
          );
        return [option.id, summary];
      }),
    ) as Record<GitChangeSourceId, { added: number; removed: number }>;
  }, [gitState.datasets, gitState.sourceOptions]);
  const gitWorktreeChangeSummary = useMemo(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    return {
      added: unstaged.added + staged.added,
      removed: unstaged.removed + staged.removed,
    };
  }, [gitChangeSummaryBySourceId]);
  const gitWorktreeReviewSourceId = useMemo<GitChangeSourceId | null>(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    if (unstaged.added + unstaged.removed > 0) {
      return "unstaged";
    }
    if (staged.added + staged.removed > 0) {
      return "staged";
    }
    return null;
  }, [gitChangeSummaryBySourceId]);
  const handleOpenGitReview = useCallback(
    (sourceId?: GitChangeSourceId) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      if (sourceId) {
        setGitSelectedSourceId(sourceId);
      }
      handleOpenGit();
    },
    [handleOpenGit, workspaceReadOnlyReason],
  );
  const isSidePaneOpen = !isSidePaneCollapsed;
  useEffect(() => {
    const handleCloseActiveContextRequest = (event: Event) => {
      const activeTab = getCloseActiveContextSidePaneTab({
        isWorkspaceVisible,
        isSidePaneCollapsed,
        sidePaneState,
      });
      if (!activeTab) {
        return;
      }

      // Cmd/Ctrl+W from the desktop menu reaches the main process first.
      // Intercept it at the visible workspace layer so that when the right side pane is open, it closes the active tab
      // instead of letting the Root fallback close the entire window.
      event.preventDefault();
      handleCloseSidePaneTab(activeTab.id);
    };

    window.addEventListener(CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT, handleCloseActiveContextRequest);
    return () => {
      window.removeEventListener(
        CLOSE_ACTIVE_CONTEXT_REQUEST_EVENT,
        handleCloseActiveContextRequest,
      );
    };
  }, [handleCloseSidePaneTab, isSidePaneCollapsed, isWorkspaceVisible, sidePaneState]);
  const handleToggleSidePane = useCallback(() => {
    // Interaction detail: toggle panel changes only the visibility of the right container; it does not implicitly create or switch tabs.
    // Previously, with no tabs, it opened diff/browser content as a fallback, so users who only wanted the side pane
    // got a new Browser or Review instead. The Open tab empty state now handles empty content.
    handleToggleSidePaneCollapse();
  }, [handleToggleSidePaneCollapse]);
  const runVisibleWorkspaceCommand = useCallback(
    (run: () => void) => {
      runWorkspaceVisibleCommand({
        isWorkspaceVisible,
        onReturnToWorkspace,
        run,
      });
    },
    [isWorkspaceVisible, onReturnToWorkspace],
  );
  const handleCreateTaskIfWritable = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      if (!workspaceReadOnlyReason) {
        onCreateTask(request);
      }
    },
    [onCreateTask, workspaceReadOnlyReason],
  );
  const handleToggleTerminalIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleTerminal();
    }
  }, [handleToggleTerminal, workspaceReadOnlyReason]);
  const handleOpenTerminalTabIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenTerminalTab();
    }
  }, [handleOpenTerminalTab, workspaceReadOnlyReason]);
  const handleOpenGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleOpenGit();
    }
  }, [handleOpenGit, workspaceReadOnlyReason]);
  const handleToggleGitIfWritable = useCallback(() => {
    if (!workspaceReadOnlyReason) {
      handleToggleGit();
    }
  }, [handleToggleGit, workspaceReadOnlyReason]);
  const handleOpenCodeViewerIfWritable = useCallback(
    (...args: Parameters<typeof handleOpenCodeViewer>) => {
      if (!workspaceReadOnlyReason) {
        handleOpenCodeViewer(...args);
      }
    },
    [handleOpenCodeViewer, workspaceReadOnlyReason],
  );
  const handleAutoOpenAssistantPptx = useCallback(
    (request: AssistantPreviewCardsAutoOpenRequest) => {
      if (!isDesktop || webRemoteControlWorkspaceSwitcher || workspaceReadOnlyReason) {
        return;
      }
      handleOpenCodeViewers(request.sources);
    },
    [handleOpenCodeViewers, isDesktop, webRemoteControlWorkspaceSwitcher, workspaceReadOnlyReason],
  );
  const handleOpenTreemappingIfWritable = useCallback(
    (...args: Parameters<typeof handleOpenTreemapping>) => {
      if (!workspaceReadOnlyReason) {
        handleOpenTreemapping(...args);
      }
    },
    [handleOpenTreemapping, workspaceReadOnlyReason],
  );
  const projectName = getPathLeaf(workspaceAbsPath);
  const handleOpenTaskFind = useCallback(() => {
    // Cmd/Ctrl+F means “find in conversation.” It previously reused the Cmd/Ctrl+P file-search entry,
    // so selecting Find in quick pick or using the shortcut opened a file. Keep this as separate state to avoid affecting file search.
    runVisibleWorkspaceCommand(() => {
      setTaskFindFocusRequestId((requestId) => requestId + 1);
      setIsTaskFindOpen(true);
    });
  }, [runVisibleWorkspaceCommand]);
  const handleTaskFindOpenChange = useCallback((open: boolean) => {
    setIsTaskFindOpen(open);
    if (!open) {
      setConversationFindState((state) => changeTaskFindSelection(state, "", -1));
      setConversationFindMatchCount(0);
      setFileChangeFindState((state) => changeTaskFindSelection(state, "", -1));
      setFileChangeFindMatchCount(0);
    }
  }, []);
  const handleConversationFindChange = useCallback((query: string, activeIndex: number) => {
    setConversationFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleConversationFindNavigate = useCallback((query: string, activeIndex: number) => {
    // With one match, Up/Down/Enter all return to the same index; a separate version ensures repeated navigation still scrolls.
    setConversationFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleConversationFindMatchStateChange = useCallback(
    (state: ConversationFindMatchState) => {
      setConversationFindMatchCount(state.matchCount);
      if (state.activeIndex !== undefined) {
        setConversationFindState((current) =>
          changeTaskFindSelection(current, current.query, state.activeIndex ?? -1),
        );
      }
    },
    [],
  );
  const handleSearchResultHighlightRequest = useCallback(
    (request: Omit<ChatSearchResultHighlightRequest, "requestId">) => {
      searchResultHighlightRequestIdRef.current += 1;
      setSearchResultHighlightRequest({
        ...request,
        requestId: searchResultHighlightRequestIdRef.current,
      });
    },
    [],
  );
  const handleSearchResultHighlightDone = useCallback((requestId: number) => {
    setSearchResultHighlightRequest((current) =>
      current?.requestId === requestId ? null : current,
    );
  }, []);
  const handleFileChangeFindChange = useCallback((query: string, activeIndex: number) => {
    setFileChangeFindState((state) => changeTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleFileChangeFindNavigate = useCallback((query: string, activeIndex: number) => {
    // A file-change range may also have only one match; repeated navigation must expand and focus the same location again.
    setFileChangeFindState((state) => navigateTaskFindSelection(state, query, activeIndex));
  }, []);
  const handleOpenQuickPick = useCallback(() => {
    setIsQuickPickOpen((open) => !open);
  }, []);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeedbackTickets = useFeedbackStore((state) => state.openTickets);
  const isLoggedIn = Boolean(user);
  const handleOpenFeedback = useCallback(() => {
    void platform.openFeedback();
  }, [platform]);

  useEffect(() => {
    // The built-in feedback center combines the “Submit feedback / My feedback” tabs.
    // The old OpenTicketsPanel IPC remains supported (opens the list directly) and can be reused if a separate entry is needed later.
    const disposeFeedbackDialog = platform.onOpenFeedbackDialog?.(() => {
      openFeedbackSubmit();
    });
    const disposeTicketsPanel = platform.onOpenTicketsPanel?.(() => {
      openFeedbackTickets();
    });
    return () => {
      disposeFeedbackDialog?.();
      disposeTicketsPanel?.();
    };
  }, [openFeedbackSubmit, openFeedbackTickets, platform]);
  const handleOpenCommunity = useCallback(() => platform.openCommunity(), [platform]);
  const handleOpenProductDocs = useCallback(() => {
    platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
  }, [platform]);
  const themeTarget = resolvedTheme === "dark" ? "light" : "dark";
  const handleSwitchTheme = useCallback(() => {
    setTheme(themeTarget);
  }, [setTheme, themeTarget]);
  const handleOpenSettingsSection = useCallback(
    (section: SettingsSectionId) => {
      setPendingSettingsSection(section);
      openSettingsTab();
    },
    [openSettingsTab],
  );
  const { reloadSessionPending, handleReloadSession } = useWorkspaceSessionReload({
    intl,
    services,
    workspaceAbsPath,
    reloadSessionDisabled,
  });
  const handleStartDraftInWorkspace = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      const store = useZCodeSessionStore.getState();
      const resolvedTargetWorkspaceIdentity =
        targetWorkspaceIdentity ??
        tabs.filter(isWorkspaceTab).find((tab) => tab.workspacePath === targetWorkspacePath)
          ?.workspaceIdentity;
      if (isWorkspaceReadOnly({ tabs }, targetWorkspacePath, resolvedTargetWorkspaceIdentity)) {
        return;
      }
      const targetSelectedProvider = resolveWorkspaceSwitchDraftProvider({
        currentSelectedProvider: workspaceShellZCodeState.selectedProvider,
        targetWorkspacePath,
        targetWorkspaceIdentity: resolvedTargetWorkspaceIdentity,
        workspaces: store.workspaces,
      });
      const currentWorkspaceState = store.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
      const groupedDraftPlacement =
        currentWorkspaceState.activeTaskId === null
          ? currentWorkspaceState.groupedDraftTask?.placement
          : undefined;

      // The workspace selector in the empty state means “start working in this project.”
      // If the target workspace has remembered its Agent, keep that choice after switching;
      // inherit the Agent currently shown in the empty state only on first entry, before workspace UI state exists.
      // Otherwise, switching between projects overwrites the target project's recently used Agent and appears to “reset to the default.”
      // Fixed entries such as Home may not exist in the tab list, so activateTabByPath previously failed silently,
      // appearing to do nothing. Ensure the target workspace is open first, then pass the current empty-state provider to startDraft
      // so the current context is preserved on the first visit to a new workspace.
      const targetTabOptions =
        resolvedTargetWorkspaceIdentity || targetWorkspacePurpose
          ? {
              ...(resolvedTargetWorkspaceIdentity
                ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
                : {}),
              ...(targetWorkspacePurpose ? { workspacePurpose: targetWorkspacePurpose } : {}),
            }
          : undefined;
      if (targetWorkspacePurpose) {
        // purpose is category metadata; merge it even when the tab already exists so the first unlink from a project does not default it to project.
        addTab(targetWorkspacePath, targetTabOptions);
      } else if (
        !activateTabByPath(
          targetWorkspacePath,
          resolvedTargetWorkspaceIdentity
            ? { workspaceIdentity: resolvedTargetWorkspaceIdentity }
            : undefined,
        )
      ) {
        addTab(targetWorkspacePath, targetTabOptions);
      }
      if (!webRemoteControlWorkspaceSwitcher) {
        // Root cause: “New conversation” in the workspace row used to call activateTab + startDraft
        // directly from a leaf component, bypassing workbench group/pane restoration on exit/restart.
        // The group primary binding could therefore still override the draft. Route all explicit
        // desktop creation entries through a single primary pane first; mobile /remote does not use this local layout.
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      store.startDraft(
        targetWorkspacePath,
        targetSelectedProvider,
        resolvedTargetWorkspaceIdentity,
        {
          groupedDraftPlacement,
          createSource: createSource ?? (groupedDraftPlacement ? "group" : "project"),
        },
      );
      if (
        groupedDraftPlacement &&
        (workspaceIdentity?.trim() || workspaceAbsPath) !==
          (resolvedTargetWorkspaceIdentity?.trim() || targetWorkspacePath)
      ) {
        // The grouped left-side New task row represents the user's chosen creation location; switching workspace changes only the draft target.
        // After migrating to the target workspace, clear the source bucket so switching back does not show two temporary New task rows.
        store.clearGroupedDraftTask(workspaceAbsPath, workspaceIdentity);
      }
    },
    [
      activateTabByPath,
      addTab,
      tabs,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceShellZCodeState.selectedProvider,
      webRemoteControlWorkspaceSwitcher,
    ],
  );

  /**
   * Command Center “New task in worktree” open contract: reuse the shared
   * workspace-open + startDraft path. Worktree results are explicit project-scope
   * creations, so never inherit the current workspace's grouped-draft placement.
   */
  const handleCreateTaskInWorkspace = useCallback(
    (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => {
      handleStartDraftInWorkspace(
        targetWorkspacePath,
        targetWorkspaceIdentity,
        undefined,
        "project",
      );
    },
    [handleStartDraftInWorkspace],
  );

  useWorkspaceShellLifecycle({
    workspaceAbsPath,
    workspaceIdentity,
    services,
    setBrowserNavigationRequest,
    setTestMessages,
  });

  useEnsureWorkspaceMcpLoaded(workspaceAbsPath, workspaceIdentity, workspaceRpcReady);

  const testActions = useMemo<TestActions>(
    () => ({
      ...taskListE2EActions,
      sendBotMessage: (message) => services.botsService.handleInboundMessage(message),
      submitBotGroupInput: (params) => {
        const submit = services.zcodeTaskService.submitBotGroupInput;
        if (!submit) throw new Error("Task material admission unavailable");
        return submit.call(services.zcodeTaskService, params);
      },
      getTheme: () => theme,
      setTheme,
      getLocale: () => locale,
      setLocale,
      setChatMessages: (messages) => {
        setTestMessages([...messages]);
      },
      getChatMessageCount: () => testMessages?.length ?? 0,
      getPluginsOverview: (params) => services.zcodeAgentService.getPluginsOverview(params),
      addPluginMarketplace: (params) => services.zcodeAgentService.addPluginMarketplace(params),
      updatePluginMarketplace: (params) =>
        services.zcodeAgentService.updatePluginMarketplace(params),
      installPlugin: (params) => services.zcodeAgentService.installPlugin(params),
      listPlugins: (params) => services.zcodeAgentService.listPlugins(params),
      getPluginReferenceCatalog: (params) =>
        services.zcodeAgentService.getPluginReferenceCatalog(params),
    }),
    [
      locale,
      services.botsService,
      services.zcodeTaskService,
      services.zcodeAgentService,
      setLocale,
      theme,
      setTheme,
      testMessages,
    ],
  );
  useTestActions(testActions);
  const [workspaceMainView, setWorkspaceMainView] = useState<WorkspaceMainView>("chat");
  const [openAutomationId, setOpenAutomationId] = useState<string | null>(null);
  const [openAutomationTab, setOpenAutomationTab] = useState<NonNullable<
    AutomationsNavigationTarget["automationTab"]
  > | null>(null);
  const [pluginStoreReturnScopeKey, setPluginStoreReturnScopeKey] = useState("user");
  const [pluginStoreOpenVersion, setPluginStoreOpenVersion] = useState(0);
  const handleNavigateToTaskMain = useCallback(() => {
    setWorkspaceMainView("chat");
  }, []);
  const { preserveNextSettingsExit } = useWorkspaceMainViewSettingsExit({
    isWorkspaceVisible,
    workspaceMainView,
    onExitSettings: handleNavigateToTaskMain,
  });
  const handleNavigateToAutomationsMain = useCallback((target: AutomationsNavigationTarget) => {
    setOpenAutomationId(target.automationId ?? null);
    setOpenAutomationTab(target.automationTab ?? null);
    setWorkspaceMainView("automations");
  }, []);
  const handleNavigateToPluginStoreMain = useCallback(() => {
    // Generic entries have no scope context and default to User. Settings entries with an explicit scope override
    // this default after navigation so the previous Workspace scope is not reused.
    setPluginStoreReturnScopeKey("user");
    setPluginStoreOpenVersion((version) => version + 1);
    preserveNextSettingsExit();
    setWorkspaceMainView("plugin-store");
  }, [preserveNextSettingsExit]);
  const handleOpenAutomationConsumed = useCallback(() => {
    setOpenAutomationId(null);
    setOpenAutomationTab(null);
  }, []);
  // Hub deep link (“Saved” chip → that workflow's details page): clear it in the callback after the hub navigates.
  const [openWorkflow, setOpenWorkflow] = useState<SavedWorkflowsOpenTarget | null>(null);
  const handleOpenWorkflowConsumed = useCallback(() => setOpenWorkflow(null), []);
  const {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  } = useWorkspaceTaskNavigation({
    intl,
    workspaceAbsPath,
    workspaceIdentity,
    activateTabByPath,
    onNavigateToTask: handleNavigateToTaskMain,
    onNavigateToAutomations: handleNavigateToAutomationsMain,
    onNavigateToPluginStore: handleNavigateToPluginStoreMain,
  });
  // Destination for the completion card's “Saved” chip (docs/dynamic-workflow/transcript-and-notifications.md,
  // “Saving the run, and running it again”): use the same navigation as the Automations entry (open
  // history and switch the main view), land on the Workflows tab, then use the deep link to focus
  // that page in the hub. Find project-scoped workflows by workspaceKey and global ones by name alone.
  const handleOpenSavedWorkflowInHub = useCallback(
    (target: SavedWorkflowHubTarget) => {
      setOpenWorkflow(
        target.scope === "global"
          ? { scope: "global", name: target.name }
          : {
              scope: "project",
              name: target.name,
              workspaceKey: resolveWorkspaceKey({
                workspacePath: target.workspacePath,
                ...(target.workspaceIdentity
                  ? { workspaceIdentity: target.workspaceIdentity }
                  : {}),
              }),
            },
      );
      handleOpenAutomations(undefined, "workflow");
    },
    [handleOpenAutomations],
  );
  const handleOpenPluginStoreForScope = useCallback(
    (_target: PluginStoreOpenTarget = {}) => {
      // Workspace Marketplace is now a global entry. Accept Workspace keys from old events, but normalize
      // the destination to User so old sessionStorage/same-window events cannot return settings to an invalid scope.
      const returnScopeKey = "user";
      if (workspaceMainView === "plugin-store") {
        setPluginStoreReturnScopeKey(returnScopeKey);
        setPluginStoreOpenVersion((version) => version + 1);
        return;
      }
      handleOpenPluginStore();
      setPluginStoreReturnScopeKey(returnScopeKey);
    },
    [handleOpenPluginStore, workspaceMainView],
  );
  useEffect(
    () => addPluginStoreOpenListener(handleOpenPluginStoreForScope),
    [handleOpenPluginStoreForScope],
  );
  const handleSelectAdjacentConversation = useCallback(
    (direction: "previous" | "next") => {
      runVisibleWorkspaceCommand(() => {
        const sessionState = useZCodeSessionStore.getState();
        const workspaceState = sessionState.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
        const fallbackTaskIds = getVisibleTaskMetas(workspaceState).map((task) => task.taskId);
        const taskQueryCacheState = useTaskQueryCacheStore.getState();
        // Performance fix: task meta is frequently written to the query cache during recovery and streaming events.
        // Previous/next conversation needs a fresh snapshot only when the shortcut is pressed; App must not subscribe to the whole cache and rerender the shell.
        const quickPickConversationNavigation = resolveQuickPickConversationNavigation({
          taskIds: selectQuickPickConversationTaskIds({
            workspacePath: workspaceAbsPath,
            workspaceIdentity,
            resultsByQueryKey: taskQueryCacheState.resultsByQueryKey,
            taskMetaByEntityKey: taskQueryCacheState.taskMetaByEntityKey,
            fallbackTaskIds,
          }),
          activeTaskId,
        });
        const targetTaskId =
          direction === "previous"
            ? quickPickConversationNavigation.previousTaskId
            : quickPickConversationNavigation.nextTaskId;
        if (!targetTaskId) {
          return;
        }

        handleSelectTask(workspaceAbsPath, targetTaskId, workspaceIdentity);
      });
    },
    [
      activeTaskId,
      handleSelectTask,
      runVisibleWorkspaceCommand,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );
  const handleSelectPreviousConversation = useCallback(() => {
    handleSelectAdjacentConversation("previous");
  }, [handleSelectAdjacentConversation]);
  const handleSelectNextConversation = useCallback(() => {
    handleSelectAdjacentConversation("next");
  }, [handleSelectAdjacentConversation]);
  const handleManageInstalledPlugins = useCallback(() => {
    setPendingSettingsPluginIntent("plugins", {
      origin: "plugin-store",
      scopeKey: pluginStoreReturnScopeKey,
    });
    openSettingsTab();
  }, [openSettingsTab, pluginStoreReturnScopeKey]);
  const handlePrimaryNavigationBack =
    workspaceMainView === "plugin-store" ? handleManageInstalledPlugins : handleTaskNavBack;
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  const shellPanelIds = useMemo(() => ["sidebar", "content"], []);

  useAppKeyboard({
    openCommandCenter: handleOpenQuickPick,
    // Open settings: share tabStore.openSettingsTab with the settings button; default to ⌘,/Ctrl+, (system convention).
    openSettings: openSettingsTab,
    findInTask: handleOpenTaskFind,
    toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
    switchTheme: handleSwitchTheme,
    toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
    // ⌥⌘B and the rightmost Header button share the same toggle entry,
    // preventing shortcut and button behavior from diverging; the Open tab empty state handles an empty pane.
    toggleSidePane: () => runVisibleWorkspaceCommand(handleToggleSidePane),
    previousConversation: handleSelectPreviousConversation,
    nextConversation: handleSelectNextConversation,
    navigateBack: canPrimaryNavigationBack
      ? () => runVisibleWorkspaceCommand(handlePrimaryNavigationBack)
      : null,
    navigateForward: canTaskNavForward
      ? () => runVisibleWorkspaceCommand(handleTaskNavForward)
      : null,
  });

  useEffect(() => {
    let disposed = false;

    void platform.canOpenCommunity(locale).then(
      (visible) => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(visible);
        }
      },
      () => {
        if (!disposed) {
          setCanOpenCommunityFromQuickPick(false);
        }
      },
    );

    return () => {
      disposed = true;
    };
  }, [locale, platform]);

  const quickPickCommands = useMemo(
    () =>
      createQuickPickCommands({
        supportsTerminal: !isOfficeMode,
        supportsReview: !isOfficeMode,
        allowOpenWorkspace,
        supportsWorktreeTasks: isDesktop === true,
        canOpenCommunity: canOpenCommunityFromQuickPick,
        isSidebarVisible,
        supportsEmbeddedBrowser,
        // Quick-pick commands need only the signed-in boolean.
        // Depending on the full user object recreates all command/run closures when the auth store returns an equivalent new reference.
        isLoggedIn,
        themeTarget,
        themeMode: theme,
        themePalette: palette,
        resolvedTheme,
        shortcuts: {
          newTask: newTaskShortcutLabel,
          openWorkspace: openWorkspaceShortcutLabel,
          toggleSidebar: toggleSidebarShortcutLabel,
          toggleTerminal: toggleTerminalShortcutLabel,
        },
        handlers: {
          createTask: () => runVisibleWorkspaceCommand(() => handleCreateTaskIfWritable()),
          openWorkspace: () => runVisibleWorkspaceCommand(onOpenWorkspace),
          openSettings: openSettingsTab,
          openSkillsSettings: () => {
            setPendingSettingsPluginIntent("skills");
            openSettingsTab();
          },
          openMcpSettings: () => {
            setPendingSettingsPluginIntent("mcps");
            openSettingsTab();
          },
          switchTheme: handleSwitchTheme,
          setThemeMode: setTheme,
          setThemePalette: setPalette,
          openFeedback: handleOpenFeedback,
          openCommunity: handleOpenCommunity,
          openProductDocs: handleOpenProductDocs,
          login: onLogin,
          logout: onLogout,
          toggleSidebar: () => runVisibleWorkspaceCommand(handleToggleSidebar),
          toggleTerminal: () => runVisibleWorkspaceCommand(handleToggleTerminalIfWritable),
          togglePreview: () => runVisibleWorkspaceCommand(handleToggleBrowser),
          openTerminalTab: () => runVisibleWorkspaceCommand(handleOpenTerminalTabIfWritable),
          openBrowserTab: () => runVisibleWorkspaceCommand(handleOpenBrowserTab),
          openReviewTab: () => runVisibleWorkspaceCommand(handleOpenGitIfWritable),
        },
      }),
    [
      allowOpenWorkspace,
      isOfficeMode,
      isDesktop,
      canOpenCommunityFromQuickPick,
      handleOpenCommunity,
      handleOpenFeedback,
      handleOpenProductDocs,
      handleOpenSettingsSection,
      handleSwitchTheme,
      handleOpenBrowserTab,
      handleOpenGitIfWritable,
      handleOpenTerminalTabIfWritable,
      handleToggleBrowser,
      handleToggleSidebar,
      handleToggleTerminalIfWritable,
      isLoggedIn,
      isSidebarVisible,
      newTaskShortcutLabel,
      handleCreateTaskIfWritable,
      onLogin,
      onLogout,
      onOpenWorkspace,
      palette,
      runVisibleWorkspaceCommand,
      openSettingsTab,
      openWorkspaceShortcutLabel,
      setPalette,
      setTheme,
      supportsEmbeddedBrowser,
      theme,
      resolvedTheme,
      toggleSidebarShortcutLabel,
      toggleTerminalShortcutLabel,
      themeTarget,
    ],
  );
  const taskFindDialogProps = useMemo<TaskFindDialogProps>(
    () => ({
      open: isTaskFindOpen,
      focusRequestId: taskFindFocusRequestId,
      isMacDesktop,
      isWindowsDesktop,
      isLinuxDesktop,
      conversationMatchCount: conversationFindMatchCount,
      conversationMatchIndex: conversationFindState.activeIndex,
      fileChangeMatchCount: fileChangeFindMatchCount,
      fileChangeMatchIndex: fileChangeFindState.activeIndex,
      onOpenChange: handleTaskFindOpenChange,
      onConversationFindChange: handleConversationFindChange,
      onConversationFindNavigate: handleConversationFindNavigate,
      onFileChangeFindChange: handleFileChangeFindChange,
      onFileChangeFindNavigate: handleFileChangeFindNavigate,
      onOpenFileChanges: handleOpenGitIfWritable,
    }),
    [
      conversationFindMatchCount,
      conversationFindState.activeIndex,
      fileChangeFindMatchCount,
      fileChangeFindState.activeIndex,
      handleConversationFindChange,
      handleConversationFindNavigate,
      handleFileChangeFindChange,
      handleFileChangeFindNavigate,
      handleOpenGitIfWritable,
      handleTaskFindOpenChange,
      isLinuxDesktop,
      isMacDesktop,
      isTaskFindOpen,
      isWindowsDesktop,
      taskFindFocusRequestId,
    ],
  );

  return (
    <>
      <CommandCenterDialog
        open={isQuickPickOpen}
        commands={quickPickCommands}
        workspaceAbsPath={workspaceAbsPath}
        workspaceIdentity={workspaceIdentity}
        activeTaskId={activeTaskId}
        activeTaskChangeSummary={activeTaskChangeSummary}
        workspaceTabs={commandCenterWorkspaceTabs}
        onOpenChange={setIsQuickPickOpen}
        onSelectTask={handleSelectTask}
        onCreateTaskInWorkspace={handleCreateTaskInWorkspace}
        onSearchResultHighlightRequest={handleSearchResultHighlightRequest}
        onOpenCodeViewer={handleOpenCodeViewerIfWritable}
      />
      {/* Bugfix: Feedback is an application-level capability and must always use the local base host. While an SSH session is connecting or disconnected,
          workspace-scoped services switch to a disconnected proxy, so feedback submission must not depend on the remote session. */}
      <FeedbackHost feedbackService={baseFeedbackService} platform={platform} />
      <PluginUiWorkspaceProvider onOpenSidePane={handleOpenPluginUi}>
        <WorkspaceShellLayout
          services={services}
          workspaceReadOnlyReason={workspaceReadOnlyReason}
          workspaceMainView={workspaceMainView}
          pluginStoreOpenVersion={pluginStoreOpenVersion}
          openAutomationId={openAutomationId}
          openAutomationTab={openAutomationTab}
          openWorkflow={openWorkflow}
          onOpenWorkflowConsumed={handleOpenWorkflowConsumed}
          onOpenSavedWorkflowInHub={handleOpenSavedWorkflowInHub}
          onWorkspaceMainViewChange={setWorkspaceMainView}
          onOpenAutomationConsumed={handleOpenAutomationConsumed}
          handleOpenAutomations={handleOpenAutomations}
          handleOpenPluginStore={handleOpenPluginStoreForScope}
          handleManageInstalledPlugins={handleManageInstalledPlugins}
          onConnectRemote={onConnectRemote}
          onSelectRemoteProject={onSelectRemoteProject}
          onCancelRemoteProject={onCancelRemoteProject}
          onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
          onLogout={onLogout}
          onLogin={onLogin}
          user={user}
          reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
          remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
          reconnectingRemoteWorkspaceLogsByWorkspaceKey={
            reconnectingRemoteWorkspaceLogsByWorkspaceKey
          }
          remoteConnectionLogs={remoteConnectionLogs}
          onCreateTask={handleCreateTaskIfWritable}
          onCreateConversationTask={onCreateConversationTask}
          onResolveConversationWorkspace={onResolveConversationWorkspace}
          onOpenWorkspace={onOpenWorkspace}
          onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
          onOpenRemoteWorkspace={onOpenRemoteWorkspace}
          onCreateScratchWorkspace={onCreateScratchWorkspace}
          remoteConnectionInProgress={remoteConnectionInProgress}
          allowOpenWorkspace={allowOpenWorkspace}
          webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
          initialWebRemoteControlMobileNavigationIntent={
            initialWebRemoteControlMobileNavigationIntent
          }
          initialWebRemoteControlWorkspaceList={initialWebRemoteControlWorkspaceList}
          webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
          allowRemoteWorkspace={allowRemoteWorkspace}
          remoteWorkspaceSessions={remoteWorkspaceSessions}
          workspaceAbsPath={workspaceAbsPath}
          workspaceRemoteSessionId={workspaceRemoteSessionId}
          workspaceIdentity={workspaceIdentity}
          isWorkspaceVisible={isWorkspaceVisible}
          isDesktop={isDesktop}
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          workspaceShellZCodeState={workspaceShellZCodeState}
          theme={theme}
          isMacFullscreen={isMacFullscreen}
          desktopWindowChromeState={desktopWindowChromeState}
          macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
          windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
          updateReadyVersion={updateReadyVersion}
          updateState={updateState}
          sidebarContainerRef={sidebarContainerRef}
          toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
          newTaskShortcutLabel={newTaskShortcutLabel}
          goBackShortcutLabel={goBackShortcutLabel}
          goForwardShortcutLabel={goForwardShortcutLabel}
          toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          canTaskNavBack={canTaskNavBack}
          canTaskNavForward={canTaskNavForward}
          isTerminalOpen={isTerminalOpen}
          isSidebarVisible={isSidebarVisible}
          isBrowserOpen={isBrowserOpen}
          supportsEmbeddedBrowser={supportsEmbeddedBrowser}
          isGitOpen={isGitOpen}
          isSidePaneOpen={isSidePaneOpen}
          summaryPanelVariantOverride={summaryPanelVariantOverride}
          onSummaryPanelVariantOverrideChange={setSummaryPanelVariantOverride}
          sidePaneState={sidePaneState}
          recentClosedSidePaneTabs={recentClosedSidePaneTabs}
          shellPanelIds={shellPanelIds}
          projectName={projectName}
          workspaceTabs={workspaceTabs}
          activeTaskId={activeTaskId}
          sidePaneOwnerId={sidePaneOwnerId}
          activeTraceId={activeTraceId}
          activeSessionId={activeSessionId}
          activeTaskProvider={activeTaskProvider}
          resolvedActiveTaskMeta={resolvedActiveTaskMeta}
          activeTaskTitle={activeTaskTitle}
          activeTaskChangeSummary={activeTaskChangeSummary}
          gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
          gitWorktreeChangeSummary={gitWorktreeChangeSummary}
          activeGitSourceId={activeGitSourceId}
          gitState={gitState}
          browserNavigationRequest={browserNavigationRequest}
          browserRestoreUrls={browserRestoreUrls}
          providerConfigFile={providerConfigFile}
          taskNativeSessionLogFile={taskNativeSessionLogFile}
          taskSessionFile={taskSessionFile}
          testMessages={testMessages}
          conversationFindActiveIndex={conversationFindState.activeIndex}
          conversationFindNavigationRequestId={conversationFindState.navigationRequestId}
          conversationFindQuery={conversationFindState.query}
          onConversationFindMatchStateChange={handleConversationFindMatchStateChange}
          searchResultHighlightRequest={searchResultHighlightRequest}
          onSearchResultHighlightDone={handleSearchResultHighlightDone}
          fileChangeFindActiveIndex={fileChangeFindState.activeIndex}
          fileChangeFindNavigationRequestId={fileChangeFindState.navigationRequestId}
          fileChangeFindQuery={fileChangeFindState.query}
          onFileChangeFindMatchCountChange={setFileChangeFindMatchCount}
          appLogoUrl={appLogoUrl}
          platform={platform}
          reloadSessionDisabled={reloadSessionDisabled}
          reloadSessionPending={reloadSessionPending}
          handleReloadSession={handleReloadSession}
          handleSelectTask={handleSelectTask}
          handleTaskNavBack={handleTaskNavBack}
          handleTaskNavForward={handleTaskNavForward}
          handleStartDraftInWorkspace={handleStartDraftInWorkspace}
          handleOpenCommandCenter={handleOpenQuickPick}
          handleRefreshGit={handleRefreshGit}
          handleOpenGitReview={handleOpenGitReview}
          handleBrowserUrlChange={handleBrowserUrlChange}
          handleBrowserPageMetadataChange={handleBrowserPageMetadataChange}
          handleToggleSidebar={handleToggleSidebar}
          handleToggleTerminal={handleToggleTerminalIfWritable}
          handleToggleBrowser={handleToggleBrowser}
          handleOpenBrowserTab={handleOpenBrowserTab}
          handleOpenBrowserPermissionSettings={handleOpenBrowserPermissionSettings}
          handleOpenTreemapping={handleOpenTreemappingIfWritable}
          handleOpenWhiteboard={handleOpenWhiteboard}
          handleOpenDeveloperTools={handleOpenDeveloperTools}
          handleOpenTerminalTab={handleOpenTerminalTabIfWritable}
          handleToggleGit={handleToggleGitIfWritable}
          handleToggleSidePane={handleToggleSidePane}
          handleOpenBrowserUrl={handleOpenBrowserUrl}
          handleOpenCodeViewer={handleOpenCodeViewerIfWritable}
          handleAutoOpenAssistantPptx={handleAutoOpenAssistantPptx}
          handleOpenSubagentSession={handleOpenSubagentSession}
          handleOpenBackgroundBash={handleOpenBackgroundBash}
          handleOpenSubagentDirectory={handleOpenSubagentDirectory}
          handleSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
          handleOpenSelectionSideChat={handleOpenSelectionSideChat}
          handleOpenPlanDetail={handleOpenPlanDetail}
          handleOpenWorkflowRun={handleOpenWorkflowRun}
          handleOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
          handleOpenWorkflowActorSession={handleOpenWorkflowActorSession}
          handleOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
          handleOpenWorkflowArtifact={handleOpenWorkflowArtifact}
          handleCloseCodeViewer={handleCloseCodeViewer}
          handleCloseGit={handleCloseGit}
          handleActivateSidePaneTab={handleActivateSidePaneTab}
          handleReorderSidePaneTab={handleReorderSidePaneTab}
          handleCloseSidePaneTab={handleCloseSidePaneTab}
          handleCloseOtherSidePaneTabs={handleCloseOtherSidePaneTabs}
          handleCloseAllSidePaneTabs={handleCloseAllSidePaneTabs}
          handleReopenClosedSidePaneTab={handleReopenClosedSidePaneTab}
          handleBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
          setIsTerminalOpen={setIsTerminalOpen}
          setGitSelectedSourceId={setGitSelectedSourceId}
          // taskFindDialogProps is an object prop; creating it inline makes the shell see a new reference on every streaming refresh.
          taskFindDialogProps={taskFindDialogProps}
        />
      </PluginUiWorkspaceProvider>
    </>
  );
}
