/* eslint-disable max-lines -- The workspace shell currently coordinates sidebar, chat, terminal, and browser-pane layout in one place. Keep it together for now to avoid scattering critical layout state just to meet the line limit. */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { GripHorizontal, LoaderIcon } from "lucide-react";
import { TID_APP_HEADER } from "@zcode/shared";
// Keepalive: when a workspace tab actually closes, reclaim its persistent side-pane terminal PTY/xterm by workspaceKey.
// This mirrors the openWorkspaceKeys cleanup logic in Terminal.tsx:145-177.
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import {
  V4SplitPaneEntryProvider,
  type V4SplitPaneSessionTarget,
} from "@/v4/splitPaneEntryContext.js";
import {
  SavedWorkflowHubProvider,
  type SavedWorkflowHubTarget,
} from "@/v4/savedWorkflowHubContext.js";
import {
  WorkflowRunOpenProvider,
  type WorkflowRunOpenTarget,
} from "@/v4/workflowRunOpenContext.js";
import type { ConversationDropTargetController } from "@/v4/composer/conversationDropTarget.js";
import type { WorkbenchSessionBinding } from "@/v4/workbenchGroupStore.js";
import {
  canPlaceWorkbenchSessionInSplit,
  placeWorkbenchSessionInSplit,
  selectWorkbenchSession,
} from "@/v4/workbenchSessionPlacement.js";
import { usePaneSessionPersistence } from "@/v4/usePaneSessionPersistence.js";
import { requestV4ComposerDraftWorkspaceTransfer } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import {
  ComposerDraftWorktreeIntentContext,
  createComposerDraftWorktreeIntentSlot,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import { ChatEmptyWorkspacePreviewMenu, ChatEmptyWorktreeTaskToggle } from "@/ChatEmptyState.js";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { WorkspacePluginPreview } from "@/WorkspacePluginPreview.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

import { AUTOMATIONS_TOAST_ANCHOR_ID, AutomationsSection } from "@/settings/AutomationsSection.js";
import type {
  SavedWorkflowLaunchTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/SavedWorkflowsSection.js";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { TaskFindDialog } from "@/quickpick/TaskFindDialog.js";
import { WebRemoteControlMobileShell } from "@/WebRemoteControlMobileShell.js";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import { WorkspaceSidebar, type SidebarFileTreeOpenRequest } from "@/WorkspaceSidebar.js";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import {
  findScreenshotSurfaceTabForRender,
  useBrowserScreenshotSurfaceRequest,
} from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { AnimatedTerminalPanel } from "@/app-shell/AnimatedTerminalPanel.js";
import { SIDE_PANE_DEFAULT_EXPANDED_SIZE } from "@/app-shell/sidePaneLayout.js";
import { useAnimatedResizablePanel } from "@/app-shell/useAnimatedResizablePanel.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";

import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellResizeHandleInsetPx,
  resolveWorkspaceShellWindowChromeClass,
} from "@/app-shell/workspaceShellWindowChrome.js";
import {
  getDefaultWebRemoteNavigationHeightPx,
  resolveWebRemoteNavigationDragState,
  resolveWebRemoteNavigationToggleState,
  shouldRenderWebRemoteNavigationPanel,
} from "@/app-shell/webRemoteNavigationLayout.js";
import type { WebRemoteNavigationState } from "@/app-shell/webRemoteNavigationLayout.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { toast } from "@/components/ui/toast.js";
import { getGitDirtyFileCount } from "@/git-branch-switcher/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getPathLeaf, toFileUrl } from "@/lib/path.js";
import { shouldOpenAssistantHtmlInBrowser } from "@/lib/assistantPreviewCards.js";
import { setWorkspaceSidebarResizeActive } from "@/lib/workspaceSidebarResizeState.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  addWorkspacePathOpenRequestListener,
  selectWorkspacePathFileService,
  shouldFallbackWorkspacePathToCodeViewer,
  type WorkspacePathOpenRequest,
} from "@/lib/workspacePathNavigation.js";
import {
  buildSelectionSideChatKey,
  requestSelectionSideChatOpen,
} from "@/lib/selectionSideChatRuntime.js";
import { getActiveSelectionSideChatTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  areWorkspaceFilePathsEqual,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import type { WorkspaceShellLayoutProps } from "@/app-shell/types.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

const WEB_REMOTE_CONTROL_MOBILE_QUERY = "(max-width: 767px)";
const WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY =
  "zcode:web-remote-control:collapse-navigation-once";
const WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX = 800;
const WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX = 4;
const WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MIN_WIDTH_PX = 264;
const WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO = 0.5;
const WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY = "zcode:workspace-shell:sidebar-width-px";
const LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY =
  "react-resizable-panels:workspace-shell-layout:sidebar:content";
const WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX = 16;
const WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR = "--workspace-sidebar-panel-width";
const WORKSPACE_SIDEBAR_WIDTH_CSS_VAR = "--workspace-sidebar-width";
const CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX = 480;
// WorkspaceShellLayout is memoized, and default []/{} values create new references on every call when omitted;
// reuse constants when these collections are omitted at the entry point to avoid shallow comparison treating props as changed.
const EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY: NonNullable<
  WorkspaceShellLayoutProps["reconnectingRemoteWorkspaceLogsByWorkspaceKey"]
> = {};
const EMPTY_REMOTE_WORKSPACE_SESSIONS: NonNullable<
  WorkspaceShellLayoutProps["remoteWorkspaceSessions"]
> = [];
const CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX = 360;
const CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS = 300;
// Performance fix: when ResizablePanelGroup receives a new but deeply equal panelIds array,
// its layout context is recomputed on every chat streaming render; the fixed array does not change with messages.
const WORKSPACE_BODY_PANEL_IDS = ["conversation-column", "browser"];
const WORKSPACE_CONVERSATION_PANEL_IDS = ["conversation", "terminal"];

type WebRemoteNavigationDragSession = {
  pointerId: number;
  startHeightPx: number;
  startY: number;
  didDrag: boolean;
};

type WorkspaceSidebarResizeSession = {
  containerWidthPx: number;
  pointerId: number;
  startWidthPx: number;
  startX: number;
};

function clampWorkspaceSidebarWidth(widthPx: number, containerWidthPx?: number) {
  const maxWidthPx =
    containerWidthPx && containerWidthPx > 0
      ? Math.max(
          WORKSPACE_SIDEBAR_MIN_WIDTH_PX,
          containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO,
        )
      : Number.POSITIVE_INFINITY;

  return Math.round(Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH_PX, Math.min(widthPx, maxWidthPx)));
}

function readStoredWorkspaceSidebarWidthPx(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampWorkspaceSidebarWidth(parsed) : null;
  } catch {
    return null;
  }
}

function readLegacyWorkspaceSidebarWidthRatio(): number | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LEGACY_WORKSPACE_SHELL_LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { sidebar?: unknown };
    const ratio = Number(parsed.sidebar);
    return Number.isFinite(ratio) && ratio > 0 ? ratio / 100 : null;
  } catch {
    return null;
  }
}

function persistWorkspaceSidebarWidthPx(widthPx: number) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(widthPx)));
  } catch {
    // ignore
  }
}

function getWebRemoteControlViewportHeight() {
  if (typeof window === "undefined") {
    return WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
  }

  return window.innerHeight || WEB_REMOTE_CONTROL_VIEWPORT_HEIGHT_FALLBACK_PX;
}

function getIsWebRemoteControlMobileViewport() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY).matches
  );
}

function consumeWebRemoteControlCollapseIntent(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.sessionStorage.getItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY) === "1") {
      window.sessionStorage.removeItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY);
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function markWebRemoteControlCollapseIntent() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(WEB_REMOTE_CONTROL_COLLAPSE_ONCE_SESSION_KEY, "1");
  } catch {
    // ignore
  }
}

export const WorkspaceShellLayout = memo(function WorkspaceShellLayoutComponent({
  services,
  workspaceReadOnlyReason,
  workspaceMainView,
  pluginStoreOpenVersion,
  openAutomationId,
  openAutomationTab,
  openWorkflow,
  onOpenWorkflowConsumed,
  onOpenSavedWorkflowInHub,
  onWorkspaceMainViewChange,
  onOpenAutomationConsumed,
  handleOpenAutomations,
  handleOpenPluginStore,
  handleManageInstalledPlugins,
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
  onCreateTask,
  onCreateConversationTask,
  onResolveConversationWorkspace,
  onOpenWorkspace,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  onCreateScratchWorkspace,
  allowOpenWorkspace = true,
  webRemoteControlWorkspaceSwitcher,
  initialWebRemoteControlMobileNavigationIntent,
  initialWebRemoteControlWorkspaceList,
  webRemoteControlTerminalTransportState,
  allowRemoteWorkspace = true,
  remoteWorkspaceSessions = EMPTY_REMOTE_WORKSPACE_SESSIONS,
  workspaceAbsPath,
  workspaceRemoteSessionId,
  workspaceIdentity,
  isWorkspaceVisible = true,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  workspaceShellZCodeState,
  theme,
  isMacFullscreen,
  desktopWindowChromeState,
  macWindowControlsLeftPaddingPx,
  windowsWindowControlsRightPaddingPx = 136,
  updateReadyVersion,
  updateState,
  sidebarContainerRef,
  toggleSidebarShortcutLabel,
  newTaskShortcutLabel,
  goBackShortcutLabel,
  goForwardShortcutLabel,
  toggleSidePaneShortcutLabel,
  canGoBack,
  canGoForward,
  canTaskNavBack,
  canTaskNavForward,
  isTerminalOpen,
  isSidebarVisible,
  isSidePaneOpen,
  isBrowserOpen,
  supportsEmbeddedBrowser,
  summaryPanelVariantOverride,
  onSummaryPanelVariantOverrideChange,
  sidePaneState,
  recentClosedSidePaneTabs,
  projectName,
  workspaceTabs,
  activeTaskId,
  sidePaneOwnerId,
  activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  activeTaskTitle,
  activeTaskChangeSummary,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeGitSourceId,
  gitState,
  browserNavigationRequest,
  browserRestoreUrls,
  providerConfigFile,
  taskNativeSessionLogFile,
  taskSessionFile,
  testMessages,
  conversationFindActiveIndex,
  conversationFindNavigationRequestId,
  conversationFindQuery,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  appLogoUrl,
  platform,
  reloadSessionDisabled,
  reloadSessionPending,
  handleReloadSession,
  handleSelectTask,
  handleTaskNavBack,
  handleTaskNavForward,
  handleStartDraftInWorkspace,
  handleOpenCommandCenter,
  handleRefreshGit,
  handleBrowserUrlChange,
  handleBrowserPageMetadataChange,
  handleToggleSidebar,
  handleToggleTerminal,
  handleToggleBrowser,
  handleOpenBrowserTab,
  handleOpenBrowserPermissionSettings,
  handleOpenTreemapping,
  handleOpenWhiteboard,
  handleOpenDeveloperTools,
  handleOpenTerminalTab,
  handleToggleGit,
  handleOpenGitReview,
  handleToggleSidePane,
  handleOpenBrowserUrl,
  handleOpenCodeViewer,
  handleAutoOpenAssistantPptx,
  handleOpenSubagentSession,
  handleOpenBackgroundBash,
  handleOpenSubagentDirectory,
  handleSyncSubagentSessionTabs,
  handleOpenSelectionSideChat,
  handleOpenPlanDetail,
  handleOpenWorkflowRun,
  handleOpenWorkflowRunDirectory,
  handleOpenWorkflowActorSession,
  handleOpenWorkflowWorkspace,
  handleOpenWorkflowArtifact,
  handleCloseCodeViewer,
  handleCloseGit,
  handleActivateSidePaneTab,
  handleReorderSidePaneTab,
  handleCloseSidePaneTab,
  handleCloseOtherSidePaneTabs,
  handleCloseAllSidePaneTabs,
  handleReopenClosedSidePaneTab,
  handleBrowserNavigationRequestHandled,
  setIsTerminalOpen,
  setGitSelectedSourceId,
  taskFindDialogProps,
}: WorkspaceShellLayoutProps) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const isWebRemoteControlShell = Boolean(webRemoteControlWorkspaceSwitcher);
  // Windows/Linux previously missed the outer spacing, leaving standalone panels flush against the window edge; use a 4px gap on desktop.
  const hasDesktopPanelInset = isMacDesktop || isWindowsDesktop || isLinuxDesktop;
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const workspaceShellRadiusOptions = {
    isMacDesktop,
    isWindowsDesktop,
    isLinuxDesktop,
    macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
  };
  const workspacePanelRadiusPx = resolveWorkspaceShellPanelRadiusPx(workspaceShellRadiusOptions);
  const workspaceResizeHandleInsetPx = resolveWorkspaceShellResizeHandleInsetPx(
    workspaceShellRadiusOptions,
  );
  const collapsedSidebarWidthPx = hasDesktopPanelInset ? 4 : 0;
  const [isWebRemoteControlNavigationCollapsed, setIsWebRemoteControlNavigationCollapsed] =
    useState(() => (isWebRemoteControlShell ? consumeWebRemoteControlCollapseIntent() : false));
  const [webRemoteControlNavigationHeightPx, setWebRemoteControlNavigationHeightPx] = useState(
    () => {
      const viewportHeight = getWebRemoteControlViewportHeight();
      return resolveWebRemoteNavigationDragState({
        heightPx: getDefaultWebRemoteNavigationHeightPx(viewportHeight),
        viewportHeight,
      }).heightPx;
    },
  );
  const [isWebRemoteControlTaskSwitching, setIsWebRemoteControlTaskSwitching] = useState(false);
  const [draftHeaderDropTargetController, setDraftHeaderDropTargetController] =
    useState<ConversationDropTargetController | null>(null);
  const fileTreeOpenRequestIdRef = useRef(0);
  const [fileTreeOpenRequest, setFileTreeOpenRequest] = useState<SidebarFileTreeOpenRequest | null>(
    null,
  );
  const [isSidebarFileTreeOpen, setIsSidebarFileTreeOpen] = useState(false);
  const [isWebRemoteControlMobileViewport, setIsWebRemoteControlMobileViewport] = useState(
    getIsWebRemoteControlMobileViewport,
  );
  const [isWebRemoteControlNavigationDragging, setIsWebRemoteControlNavigationDragging] =
    useState(false);
  const webRemoteControlNavigationHeightRef = useRef(webRemoteControlNavigationHeightPx);
  const webRemoteControlNavigationCollapsedRef = useRef(isWebRemoteControlNavigationCollapsed);
  const webRemoteControlNavigationDragRef = useRef<WebRemoteNavigationDragSession | null>(null);
  const suppressWebRemoteControlNavigationClickRef = useRef(false);
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const screenshotSurfaceRequest = useBrowserScreenshotSurfaceRequest(sidePaneState?.tabs ?? []);
  const screenshotSurfaceTab = screenshotSurfaceRequest
    ? findScreenshotSurfaceTabForRender(sidePaneState?.tabs ?? [], screenshotSurfaceRequest)
    : undefined;
  // Persist the v4 pane binding (M3 gate, “restore after refresh while output is streaming”):
  // restore the previously selected session after a renderer refresh; the CLI/host process stays
  // alive, and resubscribing the pane retrieves the snapshot and resumes the stream.
  usePaneSessionPersistence({
    workspaceKey,
    activeSessionId: activeTaskId,
    draftFocusVersion: workspaceShellZCodeState.draftFocusVersion,
    enabled: !isWebRemoteControlShell,
    selectSession: (sessionId) => handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity),
  });
  const workspaceShellRef = useRef<HTMLDivElement | null>(null);
  const workspaceSidebarPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationPanelElementRef = useRef<HTMLDivElement | null>(null);
  const conversationAutoCollapseStateRef = useRef({
    handleToggleSidebar,
    handleToggleSidePane,
    isSidebarVisible,
    isSidePaneOpen,
    workspaceKey,
  });
  const conversationAutoCollapseResizeTimerRef = useRef<number | null>(null);
  const workspaceSidebarResizeSessionRef = useRef<WorkspaceSidebarResizeSession | null>(null);
  const [workspaceSidebarPanelWidthPx, setWorkspaceSidebarPanelWidthPx] = useState(
    () => readStoredWorkspaceSidebarWidthPx() ?? WORKSPACE_SIDEBAR_DEFAULT_WIDTH_PX,
  );
  const workspaceSidebarPanelWidthPxRef = useRef(workspaceSidebarPanelWidthPx);
  const openWorkspaceKeys = useMemo(
    () => workspaceTabs.map((tab) => tab.workspaceIdentity?.trim() || tab.workspacePath),
    [workspaceTabs],
  );
  // Keep-alive cleanup: when a workspace tab is actually closed (removed from openWorkspaceKeys),
  // dispose persistent side-pane terminal sessions for that workspace (kill the PTY and destroy
  // xterm) to prevent orphaned processes. Switching workspaces does not remove the workspaceKey
  // from this set, so kept-alive sessions are unaffected. This mirrors the openWorkspaceKeys
  // cleanup in Terminal.tsx:145-177.
  useEffect(() => {
    const retained = new Set(openWorkspaceKeys);
    sidePaneTerminalSessionRegistry.releaseByPredicate(
      (entry) => Boolean(entry.workspaceKey) && !retained.has(entry.workspaceKey),
    );
  }, [openWorkspaceKeys]);
  const isSidebarPanelVisible = isSidebarVisible;
  const {
    panelRef: terminalPanelRef,
    panelElementRef: terminalPanelElementRef,
    isVisible: isTerminalVisible,
  } = useAnimatedResizablePanel({
    open: isTerminalOpen,
    expandedSize: "30%",
    rememberExpandedSize: true,
  });
  const {
    panelRef: sidePanePanelRef,
    panelElementRef: sidePanePanelElementRef,
    isVisible: isSidePaneVisible,
  } = useAnimatedResizablePanel({
    // The browser-use tab's own fixed host provides dimensions for the screenshot surface. Do
    // not expand the entire right ResizablePanel, or the automation page will flash a blank tab
    // bar and Chromium may still consider the guest surface non-compositable during the panel transition.
    open: workspaceMainView === "chat" && isSidePaneOpen,
    expandedSize: SIDE_PANE_DEFAULT_EXPANDED_SIZE,
    rememberExpandedSize: true,
    resizeOnInitialVisibleMount: false,
  });
  const mobileSidePanePanelRef = useRef<PanelImperativeHandle | null>(null);
  const mobileSidePanePanelElementRef = useRef<HTMLDivElement | null>(null);
  const workspaceSessionActionDisabled =
    Boolean(workspaceReadOnlyReason) || reloadSessionDisabled || reloadSessionPending;
  const simplifyHeaderForNarrowRemote = isWebRemoteControlShell && isWebRemoteControlMobileViewport;
  // Root cause: opening the file tree pushed the task list off-screen, hiding the sidebar's New
  // Task entry as well. Temporarily expose New Task in the top overlay, then resume the collapsed
  // sidebar behavior when the file tree closes.
  const showTopOverlayNewTaskButton = !isSidebarVisible || isSidebarFileTreeOpen;
  const workspaceSidebarResizeLabel = intl.formatMessage({
    id: "workspaceSidebar.resizeSidebar",
  });

  useEffect(() => {
    conversationAutoCollapseStateRef.current = {
      handleToggleSidebar,
      handleToggleSidePane,
      isSidebarVisible,
      isSidePaneOpen,
      workspaceKey,
    };
  }, [handleToggleSidebar, handleToggleSidePane, isSidebarVisible, isSidePaneOpen, workspaceKey]);

  useEffect(() => {
    if (workspaceMainView !== "chat") {
      return;
    }

    if (typeof window === "undefined") {
      return;
    }

    const readConversationWidthPx = () =>
      conversationPanelElementRef.current?.getBoundingClientRect().width ?? null;

    const collapseSidebarIfStillNarrow = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidebar: collapseSidebar,
        isSidebarVisible: latestIsSidebarVisible,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      if (latestIsSidebarVisible && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起左侧栏", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidebar();
      }
    };

    const runAutoCollapseForWindowResize = () => {
      const widthPx = readConversationWidthPx();
      if (widthPx === null) {
        return;
      }

      const {
        handleToggleSidePane: collapseSidePane,
        isSidePaneOpen: latestIsSidePaneOpen,
        workspaceKey: latestWorkspaceKey,
      } = conversationAutoCollapseStateRef.current;

      // Behavior: auto-collapse responds only to the conversation's actual width after the user
      // resizes the window. Do not observe the conversation with ResizeObserver, or the policy
      // may close a panel the user opened manually.
      if (latestIsSidePaneOpen && widthPx < CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX) {
        logger.info("[WorkspaceShellLayout] conversation 过窄，自动收起右侧面板", {
          widthPx: Math.round(widthPx),
          thresholdPx: CONVERSATION_AUTO_COLLAPSE_SIDE_PANE_WIDTH_PX,
          workspaceKey: latestWorkspaceKey,
        });
        collapseSidePane();
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(collapseSidebarIfStillNarrow);
        });
        return;
      }

      collapseSidebarIfStillNarrow();
    };

    const handleWindowResize = () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
      }

      // Bugfix: resize traces for large conversations showed that auto-collapsing the sidebar
      // rerendered WorkspaceSidebar and many tooltip/menu subtrees. Wait for resize to become idle
      // while the window is being dragged, then preserve the original collapse behavior.
      conversationAutoCollapseResizeTimerRef.current = window.setTimeout(() => {
        conversationAutoCollapseResizeTimerRef.current = null;
        runAutoCollapseForWindowResize();
      }, CONVERSATION_AUTO_COLLAPSE_RESIZE_IDLE_MS);
    };

    window.addEventListener("resize", handleWindowResize);

    return () => {
      if (conversationAutoCollapseResizeTimerRef.current !== null) {
        window.clearTimeout(conversationAutoCollapseResizeTimerRef.current);
        conversationAutoCollapseResizeTimerRef.current = null;
      }
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [workspaceMainView]);

  useEffect(() => {
    workspaceSidebarPanelWidthPxRef.current = workspaceSidebarPanelWidthPx;
  }, [workspaceSidebarPanelWidthPx]);

  const applyWorkspaceSidebarWidthDuringDrag = useCallback(
    (nextWidthPx: number) => {
      workspaceSidebarPanelWidthPxRef.current = nextWidthPx;
      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      // Bugfix: traces for large conversations showed that setState on every sidebar pointermove
      // repeatedly rendered the WorkspaceShellLayout, WorkspaceSidebar, and ChatView trees.
      // Drag width is only a transient layout value, so write it directly to a CSS variable and
      // commit React state on release.
      shellElement.style.setProperty(
        WORKSPACE_SIDEBAR_PANEL_WIDTH_CSS_VAR,
        `${isSidebarPanelVisible ? nextWidthPx : collapsedSidebarWidthPx}px`,
      );
      shellElement.style.setProperty(WORKSPACE_SIDEBAR_WIDTH_CSS_VAR, `${nextWidthPx}px`);
    },
    [collapsedSidebarWidthPx, isSidebarPanelVisible],
  );

  useEffect(() => {
    if (readStoredWorkspaceSidebarWidthPx() !== null) {
      return;
    }

    const legacyRatio = readLegacyWorkspaceSidebarWidthRatio();
    const shellElement = workspaceShellRef.current;
    if (legacyRatio === null || !shellElement) {
      return;
    }

    const containerWidthPx = shellElement.getBoundingClientRect().width;
    if (!Number.isFinite(containerWidthPx) || containerWidthPx <= 0) {
      return;
    }

    // Root cause: the outer workspace shell no longer uses react-resizable-panels, but older
    // versions persisted sidebar/content percentages. Migrate them to pixel widths so ordinary
    // window resizes no longer update the RRP layout store while preserving the user's sidebar width.
    const migratedWidthPx = clampWorkspaceSidebarWidth(
      containerWidthPx * legacyRatio,
      containerWidthPx,
    );
    workspaceSidebarPanelWidthPxRef.current = migratedWidthPx;
    setWorkspaceSidebarPanelWidthPx(migratedWidthPx);
    persistWorkspaceSidebarWidthPx(migratedWidthPx);
  }, []);

  const applyWorkspaceSidebarWidth = useCallback(
    (nextWidthPx: number, options: { persist: boolean }) => {
      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const resolvedWidthPx = clampWorkspaceSidebarWidth(nextWidthPx, containerWidthPx);
      workspaceSidebarPanelWidthPxRef.current = resolvedWidthPx;
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) =>
        currentWidthPx === resolvedWidthPx ? currentWidthPx : resolvedWidthPx,
      );
      if (options.persist) {
        persistWorkspaceSidebarWidthPx(resolvedWidthPx);
      }
      return resolvedWidthPx;
    },
    [],
  );

  const handleWorkspaceSidebarResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      const shellElement = workspaceShellRef.current;
      if (!shellElement) {
        return;
      }

      const containerWidthPx = shellElement.getBoundingClientRect().width;
      workspaceSidebarResizeSessionRef.current = {
        containerWidthPx,
        pointerId: event.pointerId,
        startWidthPx: workspaceSidebarPanelWidthPxRef.current,
        startX: event.clientX,
      };
      setWorkspaceSidebarResizeActive({
        active: true,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement,
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [isSidebarPanelVisible],
  );

  const handleWorkspaceSidebarResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const nextWidthPx = clampWorkspaceSidebarWidth(
        resizeSession.startWidthPx + event.clientX - resizeSession.startX,
        resizeSession.containerWidthPx,
      );
      applyWorkspaceSidebarWidthDuringDrag(nextWidthPx);
      event.currentTarget.setAttribute("aria-valuenow", String(Math.round(nextWidthPx)));
    },
    [applyWorkspaceSidebarWidthDuringDrag],
  );

  const finishWorkspaceSidebarResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
      const resizeSession = workspaceSidebarResizeSessionRef.current;
      if (!resizeSession || resizeSession.pointerId !== event.pointerId) {
        return;
      }

      workspaceSidebarResizeSessionRef.current = null;
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
      setWorkspaceSidebarPanelWidthPx((currentWidthPx) => {
        const finalWidthPx = workspaceSidebarPanelWidthPxRef.current;
        return currentWidthPx === finalWidthPx ? currentWidthPx : finalWidthPx;
      });
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!cancelled) {
        persistWorkspaceSidebarWidthPx(workspaceSidebarPanelWidthPxRef.current);
      }
    },
    [],
  );

  const handleWorkspaceSidebarResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isSidebarPanelVisible) {
        return;
      }

      const containerWidthPx = workspaceShellRef.current?.getBoundingClientRect().width;
      const maxWidthPx =
        containerWidthPx && containerWidthPx > 0
          ? containerWidthPx * WORKSPACE_SIDEBAR_MAX_WIDTH_RATIO
          : workspaceSidebarPanelWidthPxRef.current;
      let nextWidthPx: number | null = null;

      if (event.key === "ArrowLeft") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current - WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "ArrowRight") {
        nextWidthPx =
          workspaceSidebarPanelWidthPxRef.current + WORKSPACE_SIDEBAR_RESIZE_KEYBOARD_STEP_PX;
      } else if (event.key === "Home") {
        nextWidthPx = WORKSPACE_SIDEBAR_MIN_WIDTH_PX;
      } else if (event.key === "End") {
        nextWidthPx = maxWidthPx;
      }

      if (nextWidthPx === null) {
        return;
      }

      event.preventDefault();
      applyWorkspaceSidebarWidth(nextWidthPx, { persist: true });
    },
    [applyWorkspaceSidebarWidth, isSidebarPanelVisible],
  );

  useEffect(() => {
    return () => {
      setWorkspaceSidebarResizeActive({
        active: false,
        panelElement: workspaceSidebarPanelElementRef.current,
        shellElement: workspaceShellRef.current,
      });
    };
  }, []);

  useEffect(() => {
    webRemoteControlNavigationHeightRef.current = webRemoteControlNavigationHeightPx;
    webRemoteControlNavigationCollapsedRef.current = isWebRemoteControlNavigationCollapsed;
  }, [isWebRemoteControlNavigationCollapsed, webRemoteControlNavigationHeightPx]);
  useEffect(() => {
    if (
      !isWebRemoteControlShell ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }

    const mediaQueryList = window.matchMedia(WEB_REMOTE_CONTROL_MOBILE_QUERY);
    const syncMobileViewport = () => {
      setIsWebRemoteControlMobileViewport(mediaQueryList.matches);
    };

    syncMobileViewport();
    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", syncMobileViewport);
      return () => {
        mediaQueryList.removeEventListener("change", syncMobileViewport);
      };
    }

    mediaQueryList.addListener(syncMobileViewport);
    return () => {
      mediaQueryList.removeListener(syncMobileViewport);
    };
  }, [isWebRemoteControlShell]);

  useEffect(() => {
    if (!isWebRemoteControlShell || typeof window === "undefined") {
      return;
    }

    const clampNavigationHeightToViewport = () => {
      if (webRemoteControlNavigationCollapsedRef.current) {
        return;
      }

      const viewportHeight = getWebRemoteControlViewportHeight();
      setWebRemoteControlNavigationHeightPx(
        (currentHeightPx) =>
          resolveWebRemoteNavigationDragState({
            heightPx: currentHeightPx,
            viewportHeight,
          }).heightPx,
      );
    };

    window.addEventListener("resize", clampNavigationHeightToViewport);
    return () => {
      window.removeEventListener("resize", clampNavigationHeightToViewport);
    };
  }, [isWebRemoteControlShell]);
  const applyWebRemoteNavigationState = useCallback((nextState: WebRemoteNavigationState) => {
    setWebRemoteControlNavigationHeightPx(nextState.heightPx);
    setIsWebRemoteControlNavigationCollapsed(nextState.isCollapsed);
  }, []);
  const toggleWebRemoteNavigation = useCallback(() => {
    const nextState = resolveWebRemoteNavigationToggleState({
      currentHeightPx: webRemoteControlNavigationHeightRef.current,
      isCollapsed: webRemoteControlNavigationCollapsedRef.current,
      viewportHeight: getWebRemoteControlViewportHeight(),
    });

    logger.debug("[WorkspaceShellLayout] Web 远控导航快速切换", nextState);
    applyWebRemoteNavigationState(nextState);
  }, [applyWebRemoteNavigationState]);
  const handleWebRemoteNavigationResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      const startHeightPx = webRemoteControlNavigationCollapsedRef.current
        ? 0
        : webRemoteControlNavigationHeightRef.current;
      webRemoteControlNavigationDragRef.current = {
        pointerId: event.pointerId,
        startHeightPx,
        startY: event.clientY,
        didDrag: false,
      };
      suppressWebRemoteControlNavigationClickRef.current = true;
      setIsWebRemoteControlNavigationDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽开始", {
        startHeightPx,
      });
    },
    [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
  );
  const handleWebRemoteNavigationResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const dragSession = webRemoteControlNavigationDragRef.current;
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }

      const deltaY = event.clientY - dragSession.startY;
      if (!dragSession.didDrag && Math.abs(deltaY) < WEB_REMOTE_CONTROL_DRAG_CLICK_THRESHOLD_PX) {
        return;
      }

      event.preventDefault();
      dragSession.didDrag = true;
      applyWebRemoteNavigationState(
        resolveWebRemoteNavigationDragState({
          heightPx: dragSession.startHeightPx + deltaY,
          viewportHeight: getWebRemoteControlViewportHeight(),
        }),
      );
    },
    [applyWebRemoteNavigationState],
  );
  const finishWebRemoteNavigationResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) => {
      const dragSession = webRemoteControlNavigationDragRef.current;
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }

      webRemoteControlNavigationDragRef.current = null;
      setIsWebRemoteControlNavigationDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (cancelled) {
        suppressWebRemoteControlNavigationClickRef.current = false;
        return;
      }

      if (!dragSession.didDrag) {
        toggleWebRemoteNavigation();
        return;
      }

      const nextState = resolveWebRemoteNavigationDragState({
        heightPx: dragSession.startHeightPx + event.clientY - dragSession.startY,
        viewportHeight: getWebRemoteControlViewportHeight(),
      });
      logger.debug("[WorkspaceShellLayout] Web 远控导航拖拽结束", nextState);
      applyWebRemoteNavigationState(nextState);
    },
    [applyWebRemoteNavigationState, toggleWebRemoteNavigation],
  );
  const handleWebRemoteNavigationHandleClick = useCallback(() => {
    if (suppressWebRemoteControlNavigationClickRef.current) {
      suppressWebRemoteControlNavigationClickRef.current = false;
      return;
    }

    toggleWebRemoteNavigation();
  }, [toggleWebRemoteNavigation]);
  const handleWebRemoteTaskOpen = useCallback(
    ({ crossWorkspace }: { crossWorkspace: boolean }) => {
      if (!isWebRemoteControlShell || !isWebRemoteControlMobileViewport) {
        return;
      }

      // Bugfix: remote-control mobile kept the top navigation expanded after selecting a task,
      // squeezing the conversation area and requiring another manual collapse before reading or
      // writing messages. Collapse it after the task click; on cross-workspace navigation, also
      // write the session intent so the new page starts collapsed on its first frame.
      setIsWebRemoteControlNavigationCollapsed(true);
      if (crossWorkspace) {
        markWebRemoteControlCollapseIntent();
      }
    },
    [isWebRemoteControlMobileViewport, isWebRemoteControlShell],
  );
  const handleWebRemoteTaskSwitchingChange = useCallback((switching: boolean) => {
    setIsWebRemoteControlTaskSwitching(switching);
  }, []);
  const renderWebRemoteNavigationPanel = shouldRenderWebRemoteNavigationPanel({
    isCollapsed: isWebRemoteControlNavigationCollapsed,
    isMobileViewport: isWebRemoteControlMobileViewport,
    isWebRemoteControlShell,
  });
  const activeSearchResultHighlightRequest = useMemo(() => {
    if (!searchResultHighlightRequest || searchResultHighlightRequest.taskId !== activeTaskId) {
      return null;
    }

    const activeWorkspaceKey = buildTaskWorkspaceKey(workspaceAbsPath, workspaceIdentity);
    const requestWorkspaceKey = buildTaskWorkspaceKey(
      searchResultHighlightRequest.workspacePath,
      searchResultHighlightRequest.workspaceIdentity,
    );
    return activeWorkspaceKey === requestWorkspaceKey ? searchResultHighlightRequest : null;
  }, [activeTaskId, searchResultHighlightRequest, workspaceAbsPath, workspaceIdentity]);
  const renderChatFindDialog = () => <TaskFindDialog {...taskFindDialogProps} placement="chat" />;
  const gitDirtyFileCount = useMemo(() => {
    // Business rule: the same file can appear in both staged and unstaged changes. Deduplicate by
    // path before counting so the entry point does not count a file with uncommitted changes twice.
    return getGitDirtyFileCount(gitState.datasets);
  }, [gitState.datasets.staged, gitState.datasets.unstaged]);
  const workspaceRemoteTarget = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.remoteTarget,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  const workspaceLocalPathForRemoteMcpSync = useMemo(
    () =>
      workspaceTabs.find(
        (tab) =>
          tab.workspacePath === workspaceAbsPath &&
          (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
      )?.localWorkspacePath,
    [workspaceAbsPath, workspaceIdentity, workspaceTabs],
  );
  const webRemoteNavigationPanelStyle = useMemo<CSSProperties | undefined>(
    () =>
      isWebRemoteControlShell
        ? ({
            "--web-remote-navigation-height": `${webRemoteControlNavigationHeightPx}px`,
          } as CSSProperties)
        : undefined,
    [isWebRemoteControlShell, webRemoteControlNavigationHeightPx],
  );
  const workspaceShellSplitStyle = useMemo(
    () =>
      ({
        ...webRemoteNavigationPanelStyle,
        "--workspace-sidebar-panel-width": `${
          isSidebarPanelVisible ? workspaceSidebarPanelWidthPx : collapsedSidebarWidthPx
        }px`,
        "--workspace-sidebar-width": `${workspaceSidebarPanelWidthPx}px`,
        "--workspace-panel-radius": `${workspacePanelRadiusPx}px`,
        "--workspace-resize-handle-inset": `${workspaceResizeHandleInsetPx}px`,
      }) as CSSProperties,
    [
      collapsedSidebarWidthPx,
      isSidebarPanelVisible,
      workspacePanelRadiusPx,
      workspaceResizeHandleInsetPx,
      workspaceSidebarPanelWidthPx,
      webRemoteNavigationPanelStyle,
    ],
  );
  const activePreviewPath = useMemo(() => {
    const activeSidePaneTab =
      sidePaneState?.tabs.find((tab) => tab.id === sidePaneState.activeTabId) ?? null;
    return activeSidePaneTab?.type === "code-viewer"
      ? (activeSidePaneTab.source.path ?? null)
      : null;
  }, [sidePaneState]);
  const findFileLinkOwnerWorkspace = useCallback(
    (
      targetPath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspaceRemoteSessionId?: string,
    ) => {
      const matches = workspaceTabs.filter(
        (tab) =>
          isWorkspaceFilePathInside(tab.workspacePath, targetPath) &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity) &&
          (!targetWorkspaceRemoteSessionId ||
            tab.remoteSessionId === targetWorkspaceRemoteSessionId),
      );
      if (matches.length === 0) {
        return null;
      }
      return (
        matches.sort((left, right) => {
          const leftActive = left.workspaceIdentity === workspaceIdentity ? 1 : 0;
          const rightActive = right.workspaceIdentity === workspaceIdentity ? 1 : 0;
          if (leftActive !== rightActive) {
            return rightActive - leftActive;
          }
          return right.workspacePath.length - left.workspacePath.length;
        })[0] ?? null
      );
    },
    [workspaceIdentity, workspaceTabs],
  );
  const openFileTreeRequest = useCallback((request: Omit<SidebarFileTreeOpenRequest, "id">) => {
    fileTreeOpenRequestIdRef.current += 1;
    setFileTreeOpenRequest({
      id: fileTreeOpenRequestIdRef.current,
      ...request,
    });
  }, []);
  const showChatMainView = useCallback(() => {
    onWorkspaceMainViewChange("chat");
  }, [onWorkspaceMainViewChange]);
  const primaryNavigationBack =
    workspaceMainView === "plugin-store" ? handleManageInstalledPlugins : handleTaskNavBack;
  const canPrimaryNavigationBack = workspaceMainView === "plugin-store" || canTaskNavBack;
  useEffect(() => {
    if (
      isWebRemoteControlShell &&
      (workspaceMainView === "automations" || workspaceMainView === "plugin-store")
    ) {
      // Root cause: mobile remote control reuses the desktop shell and may retain the previous
      // main-view state. Remote control does not support Automations, so immediately return to
      // the chat page outside the continuous/replayable boundary.
      onWorkspaceMainViewChange("chat");
    }
  }, [isWebRemoteControlShell, onWorkspaceMainViewChange, workspaceMainView]);
  const handleCreateTaskInChat = useCallback(
    (request?: Parameters<typeof onCreateTask>[0]) => {
      // workspaceReadOnlyReason checks the active workspace. When a request explicitly includes
      // targetWorkspace from another project (launching a saved workflow across projects;
      // docs/dynamic-workflow/launch.md, “The detail page”), the active workspace's read-only
      // state does not apply. The root action's isWorkspaceReadOnly check on the target is the guard.
      const hasTargetWorkspace =
        typeof request === "object" && request !== null && Boolean(request.targetWorkspace);
      if (!hasTargetWorkspace && workspaceReadOnlyReason) {
        return;
      }
      showChatMainView();
      onCreateTask(request);
    },
    [onCreateTask, showChatMainView, workspaceReadOnlyReason],
  );
  const shellWorkbenchBinding = useMemo<WorkbenchSessionBinding | null>(
    () =>
      activeTaskId
        ? {
            workspaceScope: {
              workspacePath: workspaceAbsPath,
              ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
              ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
            },
            sessionId: activeTaskId,
          }
        : null,
    [activeTaskId, workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId],
  );
  const handleCreateAutomationInChat = useCallback(
    (prompt: string, targetWorkspace?: { workspacePath: string; workspaceIdentity?: string }) => {
      // When target is present, skip the active-workspace read-only check and let
      // handleCreateTaskInChat/the root action validate the target (docs/dynamic-workflow/launch.md,
      // “The detail page”); behavior is unchanged when target is absent.
      if (!targetWorkspace && workspaceReadOnlyReason) return;
      handleCreateTaskInChat({
        initialPrompt: prompt,
        ...(targetWorkspace ? { targetWorkspace } : {}),
      });
    },
    [handleCreateTaskInChat, workspaceReadOnlyReason],
  );
  // Workflow “Run” now launches directly from the hub (docs/dynamic-workflow/launch.md): the GUI
  // creates an empty session and sends a startSavedWorkflow command instead of synthesizing chat
  // text. This layer brings the session to the foreground only after acceptance.
  const handleSelectTaskInChat = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
      targetRemoteSessionId?: string,
      expectedUnreadAt?: number,
    ) => {
      if (!isWebRemoteControlShell) {
        const workspaceResult = ensureTaskNavigationWorkspace({
          workspacePath: targetWorkspacePath,
          workspaceIdentity: targetWorkspaceIdentity,
          activateTabByPath: tabStoreApi.getState().activateTabByPath,
          addLocalWorkspaceTab: (workspacePath) => {
            tabStoreApi.getState().addTab(workspacePath);
          },
        });
        if (!workspaceResult.accepted) {
          logger.warn("[automations] 运行历史目标远程 workspace 未连接，保留当前页面", {
            sessionId: taskId,
            workspaceIdentity: targetWorkspaceIdentity,
            workspacePath: targetWorkspacePath,
          });
          toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
          return;
        }
        if (workspaceResult.openedLocalTab) {
          logger.info("[automations] 为运行历史会话补开本地 workspace tab", {
            sessionId: taskId,
            workspacePath: targetWorkspacePath,
          });
        }
        const resolvedRemoteSessionId =
          targetRemoteSessionId ??
          workspaceTabs.find(
            (tab) =>
              (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
              (targetWorkspaceIdentity?.trim() || targetWorkspacePath),
          )?.remoteSessionId;
        const target: V4SplitPaneSessionTarget = {
          workspacePath: targetWorkspacePath,
          ...(targetWorkspaceIdentity?.trim()
            ? { workspaceIdentity: targetWorkspaceIdentity }
            : {}),
          ...(resolvedRemoteSessionId ? { remoteSessionId: resolvedRemoteSessionId } : {}),
          sessionId: taskId,
        };
        selectWorkbenchSession(shellWorkbenchBinding, target);
      }
      // Close Automations only after the target workspace is already active or has been opened successfully, so failure does not look like successful navigation.
      showChatMainView();
      if (typeof expectedUnreadAt === "number") {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity, expectedUnreadAt);
      } else {
        handleSelectTask(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      }
    },
    [
      handleSelectTask,
      intl,
      isWebRemoteControlShell,
      shellWorkbenchBinding,
      showChatMainView,
      tabStoreApi,
      workspaceTabs,
    ],
  );
  // After a direct hub launch is accepted, switch to the new session (the run card is already at
  // the top) by reusing run-history navigation. target always includes the workflow's project
  // coordinates (invariant 7); remoteSessionId determines the connection endpoint.
  // The “Saved” chip delegates to App to switch the main view and set the deep link, sharing the
  // same navigation history as the “Automations” entry.
  const handleOpenSavedWorkflowInHub = useCallback(
    (target: SavedWorkflowHubTarget) => {
      onOpenSavedWorkflowInHub(target);
    },
    [onOpenSavedWorkflowInHub],
  );
  const handleNavigateToLaunchedRun = useCallback(
    (target: SavedWorkflowLaunchTarget, sessionId: string) => {
      handleSelectTaskInChat(
        target.workspacePath,
        sessionId,
        target.workspaceIdentity,
        target.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );
  // Workflow run history “View instance”: return to the conversation that started it (the sidebar page is visible only in chat view), then open instance details.
  const handleOpenSavedWorkflowRun = useCallback(
    (params: SavedWorkflowsOpenRunParams) => {
      // The hub spans projects: open the instance in the project that launched it, not the active
      // project (invariant 8). params always includes workspacePath/identity; fall back to the
      // active workspace only if those are unexpectedly missing.
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      // remoteSessionId is not in the contract: look it up from the open tab for the target workspace, using the active value when it matches the active project.
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowRun({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        toolCallId: params.toolCallId,
        runId: params.runId,
        workflowName: params.workflowName,
      });
    },
    [
      handleOpenWorkflowRun,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  // Sidebar run row (docs/dynamic-workflow/presentation.md, “The sidebar run line”): use the
  // same navigation as the composer badge—select the session, then open the run pane. A run
  // without a toolCallId (which should not occur) only selects the session.
  const handleOpenSidebarWorkflowRun = useCallback(
    (target: WorkflowRunOpenTarget) => {
      if (target.run.toolCallId === undefined) {
        const targetRemoteSessionId = workspaceTabs.find(
          (tab) =>
            tab.workspacePath === target.workspacePath &&
            (!target.workspaceIdentity || tab.workspaceIdentity === target.workspaceIdentity),
        )?.remoteSessionId;
        handleSelectTaskInChat(
          target.workspacePath,
          target.sessionId,
          target.workspaceIdentity,
          targetRemoteSessionId,
        );
        return;
      }
      handleOpenSavedWorkflowRun({
        sessionId: target.sessionId,
        runId: target.run.runId,
        toolCallId: target.run.toolCallId,
        workflowName: target.run.name ?? "",
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [handleOpenSavedWorkflowRun, handleSelectTaskInChat, workspaceTabs],
  );
  // Artifact chip in the hub: identical to “View instance” and follows the same path back to the
  // session that launched it; only the destination differs, opening the `workflow-artifact` tab
  // instead of the run details page.
  const handleOpenSavedWorkflowArtifact = useCallback(
    (params: SavedWorkflowsOpenArtifactParams) => {
      const targetWorkspacePath = params.workspacePath || workspaceAbsPath;
      const targetWorkspaceIdentity =
        params.workspaceIdentity ?? (workspaceIdentity?.trim() ? workspaceIdentity : undefined);
      const targetRemoteSessionId = workspaceTabs.find(
        (tab) =>
          tab.workspacePath === targetWorkspacePath &&
          (!targetWorkspaceIdentity || tab.workspaceIdentity === targetWorkspaceIdentity),
      )?.remoteSessionId;
      handleSelectTaskInChat(
        targetWorkspacePath,
        params.sessionId,
        targetWorkspaceIdentity,
        targetRemoteSessionId,
      );
      handleOpenWorkflowArtifact({
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
        ...(targetRemoteSessionId ? { remoteSessionId: targetRemoteSessionId } : {}),
        parentSessionId: params.sessionId,
        runId: params.runId,
        artifactId: params.artifactId,
        ...(params.title === undefined ? {} : { title: params.title }),
        // The hub chip payload includes contentType (used to open HTML artifacts directly in a
        // browser tab). It does not include `sourcePath`; `handleOpenWorkflowArtifact` looks it
        // up in the journal.
        ...(params.contentType === undefined ? {} : { contentType: params.contentType }),
      });
    },
    [
      handleOpenWorkflowArtifact,
      handleSelectTaskInChat,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  const handlePaneActiveSessionChange = useCallback(
    (
      scope: {
        workspacePath: string;
        workspaceIdentity?: string;
        remoteSessionId?: string;
      },
      sessionId: string,
    ) => {
      handleSelectTaskInChat(
        scope.workspacePath,
        sessionId,
        scope.workspaceIdentity,
        scope.remoteSessionId,
      );
    },
    [handleSelectTaskInChat],
  );

  const canOpenSessionInSplitPane = useCallback(
    (target: V4SplitPaneSessionTarget) => {
      return canPlaceWorkbenchSessionInSplit(shellWorkbenchBinding, target, {
        mode: "context-menu",
        side: "right",
      });
    },
    [shellWorkbenchBinding],
  );
  const handleOpenSessionInSplitPane = useCallback(
    (target: V4SplitPaneSessionTarget) => {
      showChatMainView();
      const shouldSelectTarget = placeWorkbenchSessionInSplit(shellWorkbenchBinding, target, {
        mode: "context-menu",
        side: "right",
      });
      if (shouldSelectTarget) {
        handleSelectTask(target.workspacePath, target.sessionId, target.workspaceIdentity);
      }
    },
    [handleSelectTask, shellWorkbenchBinding, showChatMainView],
  );
  const handleStartDraftInWorkspaceInChat = useCallback(
    (
      targetWorkspacePath: string,
      targetWorkspaceIdentity?: string,
      targetWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose,
      createSource?: import("@zcode/shared").SessionCreateSource,
    ) => {
      showChatMainView();
      handleStartDraftInWorkspace(
        targetWorkspacePath,
        targetWorkspaceIdentity,
        targetWorkspacePurpose,
        createSource,
      );
    },
    [handleStartDraftInWorkspace, showChatMainView],
  );
  const handleCreateProjectDraft = useCallback(
    (path: string, identity?: string) =>
      handleStartDraftInWorkspaceInChat(path, identity, undefined, "project"),
    [handleStartDraftInWorkspaceInChat],
  );
  // Empty-state “New worktree”checkbox 的重定向入口：与 palette Start 相同的 App 打开 + startDraft 契约。
  const handleOpenWorktreeDraft = useCallback(
    (targetWorkspacePath: string) => {
      handleStartDraftInWorkspaceInChat(targetWorkspacePath, undefined, undefined, "project");
    },
    [handleStartDraftInWorkspaceInChat],
  );
  // 首发拦截槽位（稳定对象）：checkbox 写入、ConversationComposer 读取；见 composerDraftWorktreeIntent。
  const draftWorktreeIntentSlot = useMemo(() => createComposerDraftWorktreeIntentSlot(), []);
  const activeWorkspacePurpose =
    workspaceTabs.find(
      (tab) =>
        tab.workspacePath === workspaceAbsPath &&
        (!workspaceIdentity || tab.workspaceIdentity === workspaceIdentity),
    )?.workspacePurpose ?? "project";
  const handleSelectConversationWorkspace = useCallback(async () => {
    if (!onResolveConversationWorkspace) {
      return;
    }
    let targetWorkspacePath: string;
    try {
      targetWorkspacePath = await onResolveConversationWorkspace();
    } catch (error) {
      logger.error("[WorkspaceShellLayout] 切换对话 workspace 失败", {
        error,
      });
      return;
    }
    if ((workspaceIdentity?.trim() || workspaceAbsPath) !== targetWorkspacePath) {
      requestV4ComposerDraftWorkspaceTransfer({
        sourceWorkspacePath: workspaceAbsPath,
        sourceWorkspaceIdentity: workspaceIdentity,
        targetWorkspacePath,
      });
    }
    handleStartDraftInWorkspaceInChat(targetWorkspacePath, undefined, "conversation");
  }, [
    handleStartDraftInWorkspaceInChat,
    onResolveConversationWorkspace,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleSelectComposerPlugin = useCallback(
    (mention: ComposerMentionPrefill) => {
      useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspaceAbsPath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceAbsPath, workspaceIdentity],
  );
  // v4 pane lifecycle callbacks (stable references for the memo-friendly pane host): after
  // createSession/fork, follow the existing selection path; after deleting a session, return to the draft.
  const handleV4SessionCreated = useCallback(
    (sessionId: string) => {
      handleSelectTask(workspaceAbsPath, sessionId, workspaceIdentity);
    },
    [handleSelectTask, workspaceAbsPath, workspaceIdentity],
  );
  // Draft composer contextHeader (m5-composer-parity §5.2): workspace switch menu and Git
  // branch switcher, matching the old ChatView empty-state contextHeaderContent. Shell-level
  // capabilities (workspaceTabs/remote connection callbacks) are closed over here; the pane only
  // receives a ReactNode. onSelectWorkspace keeps the old behavior: switch to a new draft in the
  // target workspace.
  const draftComposerHeader = useMemo(
    () => (
      <>
        <ChatEmptyWorkspacePreviewMenu
          workspacePath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          isWindowsDesktop={isWindowsDesktop}
          compactForRemoteControl={isWebRemoteControlShell}
          workspaceTabs={workspaceTabs}
          onSelectWorkspace={(workspaceTab) =>
            handleStartDraftInWorkspaceInChat(
              workspaceTab.workspacePath,
              workspaceTab.workspaceIdentity,
              workspaceTab.workspacePurpose,
            )
          }
          onSelectConversationWorkspace={handleSelectConversationWorkspace}
          onOpenFolder={onOpenFolderFromWorkspaceMenu}
          allowOpenWorkspace={allowOpenWorkspace}
          allowRemoteWorkspace={allowRemoteWorkspace}
          remoteWorkspaceSessions={remoteWorkspaceSessions}
          onConnectRemote={onConnectRemote}
          onSelectRemoteProject={onSelectRemoteProject}
          onCancelRemoteProject={onCancelRemoteProject}
        />
        {isOfficeMode && !isWebRemoteControlShell ? (
          <WorkspacePluginPreview
            onOpen={handleOpenPluginStore}
            onSelectPlugin={handleSelectComposerPlugin}
            workspacePath={workspaceAbsPath}
            workspaceIdentity={workspaceIdentity}
            remoteSessionId={workspaceRemoteSessionId ?? undefined}
          />
        ) : !isOfficeMode && activeWorkspacePurpose === "project" ? (
          <GitBranchSwitcher
            workspacePath={workspaceAbsPath}
            gitSummary={gitState.summary}
            dirtyFileCount={gitDirtyFileCount}
            onRefreshGit={handleRefreshGit}
            compactForRemoteControl={isWebRemoteControlShell}
            className="px-0 pt-0"
            popoverClassName="w-72"
            branchListClassName="max-h-48"
            // Bugfix (preserving the old comment): the input is at the bottom, so Radix collision
            // avoidance flips the branch menu downward. Lock it to open upward to keep it from
            // covering the input and to preserve a stable interaction direction.
            avoidPopoverCollisions={false}
          />
        ) : null}
        {/* 评审建议 6c：本地 git 项目的 draft empty state 提供“新建 worktree”勾选 + 迷你表单。 */}
        {isDesktop === true && !isWebRemoteControlShell ? (
          <ChatEmptyWorktreeTaskToggle
            workspacePath={workspaceAbsPath}
            workspaceIdentity={workspaceIdentity}
            workspaceTabs={workspaceTabs}
            isDesktop={isDesktop === true}
            isWebRemoteControlShell={isWebRemoteControlShell}
            onOpenWorktreeDraft={handleOpenWorktreeDraft}
          />
        ) : null}
      </>
    ),
    [
      isOfficeMode,
      workspaceRemoteSessionId,
      handleOpenWorktreeDraft,
      handleOpenPluginStore,
      handleSelectComposerPlugin,
      allowOpenWorkspace,
      allowRemoteWorkspace,
      activeWorkspacePurpose,
      gitDirtyFileCount,
      gitState.summary,
      handleRefreshGit,
      handleSelectConversationWorkspace,
      handleStartDraftInWorkspaceInChat,
      isWebRemoteControlShell,
      isWindowsDesktop,
      isDesktop,
      onCancelRemoteProject,
      onConnectRemote,
      onOpenFolderFromWorkspaceMenu,
      onSelectRemoteProject,
      remoteWorkspaceSessions,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceTabs,
    ],
  );
  const handleV4SessionDeleted = useCallback(() => {
    if (activeTaskId) {
      for (const tab of sidePaneState?.tabs ?? []) {
        if (tab.type === "selection-side-chat" && tab.parentSessionId === activeTaskId) {
          handleCloseSidePaneTab(tab.id);
        }
      }
    }
    handleStartDraftInWorkspaceInChat(workspaceAbsPath, workspaceIdentity);
  }, [
    activeTaskId,
    handleCloseSidePaneTab,
    handleStartDraftInWorkspaceInChat,
    sidePaneState?.tabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);
  const handleOpenMarkdownFileLink = useCallback(
    async (target: WorkspacePathOpenRequest) => {
      if (workspaceReadOnlyReason && target.serviceScope !== "base-local") {
        return;
      }
      try {
        const fileService = selectWorkspacePathFileService(
          target,
          services.fileService,
          baseServices.fileService,
        );
        const fileStat = await fileService.stat({
          path: target.path,
        });
        if (fileStat.type === "file") {
          if (
            shouldOpenAssistantHtmlInBrowser({
              path: target.path,
              workspaceIdentity: target.workspaceIdentity,
              workspaceRemoteSessionId: target.workspaceRemoteSessionId,
              compactForRemoteControl: isWebRemoteControlShell,
            })
          ) {
            handleOpenBrowserUrl(toFileUrl(target.path));
            return;
          }
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
          return;
        }

        if (target.serviceScope === "base-local") {
          openFileTreeRequest({
            target: {
              workspacePath: target.path,
              workspaceName: target.label || getPathLeaf(target.path),
              revealPath: target.path,
              temporaryExternalDirectory: true,
            },
          });
          return;
        }

        const ownerWorkspace = findFileLinkOwnerWorkspace(
          target.path,
          target.workspaceIdentity,
          target.workspaceRemoteSessionId,
        );
        if (ownerWorkspace) {
          openFileTreeRequest({
            target: {
              workspacePath: ownerWorkspace.workspacePath,
              workspaceName: ownerWorkspace.label,
              workspaceIdentity: ownerWorkspace.workspaceIdentity,
              workspaceRemoteSessionId: ownerWorkspace.remoteSessionId,
              revealPath: areWorkspaceFilePathsEqual(ownerWorkspace.workspacePath, target.path)
                ? undefined
                : target.path,
            },
          });
          return;
        }

        openFileTreeRequest({
          target: {
            workspacePath: target.path,
            workspaceName: target.label || getPathLeaf(target.path),
            revealPath: target.path,
            temporaryExternalDirectory: true,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[WorkspaceShell] 打开 markdown 文件链接失败", {
          path: target.path,
          error: message,
        });
        if (shouldFallbackWorkspacePathToCodeViewer(target)) {
          // Bugfix: a Markdown file link may point to a path that no longer exists. If stat fails,
          // preserve the old behavior and let CodeViewer show the specific read error so clicking
          // the link still produces feedback.
          handleOpenCodeViewer({
            type: "file",
            title: getPathLeaf(target.path),
            path: target.path,
            workspacePath: target.workspacePath,
            workspaceIdentity: target.workspaceIdentity,
            workspaceRemoteSessionId: target.workspaceRemoteSessionId,
          });
        }
        toast(intl.formatMessage({ id: "workspaceFileTree.openFailed" }));
      }
    },
    [
      findFileLinkOwnerWorkspace,
      baseServices.fileService,
      handleOpenBrowserUrl,
      handleOpenCodeViewer,
      intl,
      isWebRemoteControlShell,
      openFileTreeRequest,
      services.fileService,
      workspaceReadOnlyReason,
    ],
  );
  useEffect(
    () =>
      addWorkspacePathOpenRequestListener((target) => {
        void handleOpenMarkdownFileLink(target);
      }),
    [handleOpenMarkdownFileLink],
  );
  const handleRevealGitFileInTree = useCallback(
    (path: string) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      openFileTreeRequest({
        target: {
          workspacePath: workspaceAbsPath,
          workspaceName: projectName,
          workspaceIdentity,
          workspaceRemoteSessionId,
          revealPath: path,
        },
      });
    },
    [
      openFileTreeRequest,
      projectName,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
      workspaceReadOnlyReason,
    ],
  );
  const activeSelectionSideChatSessionId = activeTaskId
    ? (getActiveSelectionSideChatTab(sidePaneState, {
        workspaceKey,
        parentSessionId: activeTaskId,
      })?.childSessionId ?? null)
    : null;
  const handleOpenSelectionSideConversationLauncher = useCallback(() => {
    if (!activeTaskId) return;
    const requested = requestSelectionSideChatOpen(
      buildSelectionSideChatKey(workspaceKey, activeTaskId),
    );
    if (!requested) {
      // The fixed entry point delegates commands to the current main SessionPane; if the pane is not mounted, the shell must not assemble remote identity or protocol itself.
      logger.warn("[WorkspaceShell] 辅助对话入口没有可用的主会话控制器", {
        parentSessionId: activeTaskId,
        workspaceKey,
      });
    }
  }, [activeTaskId, workspaceKey]);
  const renderSidePanePanel = (options: { mobileOverlay?: boolean } = {}) => (
    <AnimatedSidePanePanel
      services={services}
      isDesktop={isDesktop}
      isWindowsDesktop={isWindowsDesktop}
      frameClassName={resolveWorkspaceShellWindowChromeClass({
        isMacDesktop,
        isWindowsDesktop,
        isLinuxDesktop,
        macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
        isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
        supportsNativeRoundedCorners:
          desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
      })}
      showWindowControls={!options.mobileOverlay && usesInlineWindowControls}
      isVisible={options.mobileOverlay ? isSidePaneOpen : isSidePaneVisible}
      onCloseSidePane={handleToggleSidePane}
      toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
      sidePaneState={sidePaneState}
      recentClosedSidePaneTabs={recentClosedSidePaneTabs}
      isBrowserOpen={isBrowserOpen}
      supportsEmbeddedBrowser={supportsEmbeddedBrowser}
      workspaceAbsPath={workspaceAbsPath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={workspaceRemoteSessionId}
      activeTaskId={activeTaskId}
      sidePaneOwnerId={sidePaneOwnerId}
      gitState={gitState}
      activeGitSourceId={activeGitSourceId}
      panelRef={options.mobileOverlay ? mobileSidePanePanelRef : sidePanePanelRef}
      panelElementRef={
        options.mobileOverlay ? mobileSidePanePanelElementRef : sidePanePanelElementRef
      }
      browserNavigationRequest={browserNavigationRequest}
      browserRestoreUrls={browserRestoreUrls}
      screenshotSurfaceRequest={options.mobileOverlay ? null : screenshotSurfaceRequest}
      screenshotSurfaceTabId={options.mobileOverlay ? null : (screenshotSurfaceTab?.id ?? null)}
      fileChangeFindActiveIndex={fileChangeFindActiveIndex}
      fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
      fileChangeFindQuery={fileChangeFindQuery}
      onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
      onCloseCodeViewer={handleCloseCodeViewer}
      onCloseGit={handleCloseGit}
      onActivateTab={handleActivateSidePaneTab}
      onReorderTab={handleReorderSidePaneTab}
      onCloseTab={handleCloseSidePaneTab}
      onCloseOtherTabs={handleCloseOtherSidePaneTabs}
      onCloseAllTabs={handleCloseAllSidePaneTabs}
      onReopenClosedTab={handleReopenClosedSidePaneTab}
      onOpenBrowserTab={handleOpenBrowserTab}
      onOpenBrowserPermissionSettings={handleOpenBrowserPermissionSettings}
      onOpenWhiteboard={handleOpenWhiteboard}
      onOpenDeveloperTools={handleOpenDeveloperTools}
      onOpenTerminalTab={handleOpenTerminalTab}
      onOpenReviewTab={handleToggleGit}
      onOpenSelectionSideConversation={handleOpenSelectionSideConversationLauncher}
      onRevealGitFileInTree={handleRevealGitFileInTree}
      onOpenBrowserUrl={handleOpenBrowserUrl}
      onOpenCodeViewer={handleOpenCodeViewer}
      onOpenFileLink={handleOpenMarkdownFileLink}
      onOpenBackgroundBash={handleOpenBackgroundBash}
      onOpenSubagentSession={handleOpenSubagentSession}
      onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
      onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
      onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
      onOpenWorkflowRun={handleOpenWorkflowRun}
      onRefreshGit={handleRefreshGit}
      onBrowserNavigationRequestHandled={handleBrowserNavigationRequestHandled}
      onBrowserUrlChange={handleBrowserUrlChange}
      onBrowserPageMetadataChange={handleBrowserPageMetadataChange}
      onSelectGitSource={setGitSelectedSourceId}
      mobileOverlay={options.mobileOverlay}
      mobileStacked={isWebRemoteControlShell}
    />
  );
  const sidePanePanel = renderSidePanePanel();
  const hasUpdateStatusButton =
    updateReadyVersion !== null ||
    updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded";
  // Root cause: Draft previously had a separate lightweight header, which caused its side pane,
  // caption safe area, and drag handle to diverge from the Task Header. Desktop now reuses
  // WorkspaceHeader and uses the variant only to remove task-specific content. Mobile remote
  // control still renders no desktop chrome when there is no active task, preserving the replayable overlay boundary.
  const shouldRenderMainViewHeader =
    workspaceMainView !== "automations" && workspaceMainView !== "plugin-store";
  const shouldRenderWorkspaceHeader =
    shouldRenderMainViewHeader && (activeTaskId !== null || isDesktop);
  // Root cause: if the ErrorBoundary resetKeys array is recreated on every render, React DevTools
  // continuously reports subtree prop changes even when workspace/task has not changed.
  const workspaceOnlyResetKeys = useMemo(() => [workspaceKey], [workspaceKey]);
  const workspaceDraftResetKeys = useMemo(
    () => [workspaceKey, activeTaskId ?? "draft"],
    [workspaceKey, activeTaskId],
  );
  const workspaceSidebarVisibilityResetKeys = useMemo(
    () => [workspaceKey, isSidebarVisible],
    [workspaceKey, isSidebarVisible],
  );

  if (
    isWebRemoteControlShell &&
    isWebRemoteControlMobileViewport &&
    webRemoteControlWorkspaceSwitcher
  ) {
    return (
      <DesktopWindowFrame
        title={`ZCode / ${getPathLeaf(workspaceAbsPath)}`}
        showHeader
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
        headerTestId={TID_APP_HEADER}
      >
        <WebRemoteControlMobileShell
          activeTaskId={activeTaskId}
          activeWorkspaceIdentity={workspaceIdentity}
          activeWorkspacePath={workspaceAbsPath}
          initialNavigationIntent={initialWebRemoteControlMobileNavigationIntent}
          initialWorkspaceList={initialWebRemoteControlWorkspaceList}
          webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
          isSidePaneOpen={isSidePaneOpen}
          onCloseSidePane={isSidePaneOpen ? handleToggleSidePane : undefined}
          onSelectTask={handleSelectTaskInChat}
          onStartDraftInWorkspace={handleCreateProjectDraft}
          switcher={webRemoteControlWorkspaceSwitcher}
          renderChatHeader={() =>
            shouldRenderWorkspaceHeader ? (
              <ScopedErrorBoundary
                scope="workspace-header"
                resetKeys={workspaceOnlyResetKeys}
                variant="compact"
                className="border-b"
              >
                <WorkspaceHeader
                  variant={activeTaskId === null ? "draft" : "task"}
                  draftDropTargetController={
                    activeTaskId === null ? draftHeaderDropTargetController : undefined
                  }
                  readOnlyReason={workspaceReadOnlyReason}
                  workspaceAbsPath={workspaceAbsPath}
                  remoteSessionId={workspaceRemoteSessionId}
                  workspaceIdentity={workspaceIdentity}
                  remoteTarget={workspaceRemoteTarget}
                  localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                  projectName={projectName}
                  activeTaskTitle={activeTaskTitle}
                  activeTaskChangeSummary={activeTaskChangeSummary}
                  hasUpdateReady={hasUpdateStatusButton}
                  activeTaskId={activeTaskId}
                  user={user}
                  activeTraceId={activeTraceId}
                  activeSessionId={activeSessionId}
                  activeTaskProvider={activeTaskProvider}
                  resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                  sessionLogPath={taskSessionFile.path}
                  nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                  nativeSessionLogPath={taskNativeSessionLogFile.path}
                  nativeSessionLogExists={taskNativeSessionLogFile.exists}
                  nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                  providerWorkspaceConfigPath={providerConfigFile.path}
                  providerWorkspaceConfigExists={providerConfigFile.exists}
                  providerWorkspaceConfigLoading={providerConfigFile.loading}
                  workspaceHeaderState={workspaceShellZCodeState}
                  gitSummary={gitState.summary}
                  gitDirtyFileCount={gitDirtyFileCount}
                  isMacDesktop={isMacDesktop}
                  isMacFullscreen={isMacFullscreen}
                  isWindowsDesktop={isWindowsDesktop}
                  isWebRemoteControl={isWebRemoteControlShell}
                  windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
                  isDesktop={isDesktop}
                  simplifyForNarrowRemote
                  isSidebarVisible={isSidebarVisible}
                  isTerminalOpen={isTerminalOpen}
                  isSidePaneOpen={isSidePaneOpen}
                  onRefreshGit={handleRefreshGit}
                  onToggleTerminal={handleToggleTerminal}
                  onToggleBrowser={handleToggleBrowser}
                  onToggleSidePane={handleToggleSidePane}
                  toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                  onReloadSession={handleReloadSession}
                  reloadSessionDisabled={workspaceSessionActionDisabled}
                  reloadSessionPending={reloadSessionPending}
                  onCreateTask={handleCreateTaskInChat}
                  onOpenWorkspace={onOpenWorkspace}
                  allowOpenWorkspace={allowOpenWorkspace}
                />
              </ScopedErrorBoundary>
            ) : null
          }
          chatOverlay={workspaceMainView === "chat" ? renderChatFindDialog() : undefined}
          chatContent={
            workspaceMainView === "automations" && !isWebRemoteControlShell ? (
              <main
                id={AUTOMATIONS_TOAST_ANCHOR_ID}
                className="flex h-full min-h-0 flex-1 flex-col bg-background"
              >
                <AutomationsMainBreadcrumbFrame
                  isDesktop={Boolean(isDesktop)}
                  sectionLabel={intl.formatMessage({
                    id: "settings.automations.title",
                  })}
                  ariaLabel={intl.formatMessage({
                    id: "automations.breadcrumbLabel",
                  })}
                >
                  <div
                    // Root cause: Automations tabs have different content heights, so the
                    // scrollbar appearing/disappearing changes the available width of the mx-auto
                    // content column and shifts the whole page horizontally. Reserve a stable
                    // gutter to keep the centering reference unchanged.
                    className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                  >
                    <ScopedErrorBoundary
                      scope="automations-main"
                      resetKeys={workspaceOnlyResetKeys}
                      variant="panel"
                      className="min-h-full"
                    >
                      <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                        <AutomationsSection
                          workspacePath={workspaceAbsPath}
                          workspaceIdentity={workspaceIdentity}
                          onCreateViaChat={handleCreateAutomationInChat}
                          onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                          onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                          onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                          openAutomationId={openAutomationId}
                          openAutomationTab={openAutomationTab}
                          onOpenAutomationConsumed={onOpenAutomationConsumed}
                          openWorkflow={openWorkflow}
                          onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                          onOpenSession={({ sessionId, workspacePath, workspaceIdentity }) =>
                            handleSelectTaskInChat(workspacePath, sessionId, workspaceIdentity)
                          }
                        />
                      </div>
                    </ScopedErrorBoundary>
                  </div>
                </AutomationsMainBreadcrumbFrame>
              </main>
            ) : workspaceMainView === "plugin-store" && !isWebRemoteControlShell ? (
              <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
                <AutomationsMainBreadcrumbFrame
                  isDesktop={Boolean(isDesktop)}
                  sectionLabel={intl.formatMessage({
                    id: "workspace.openPluginsSettings",
                  })}
                  ariaLabel={intl.formatMessage({
                    id: "settings.breadcrumbLabel",
                  })}
                >
                  <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                    <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                      <PluginStorePage
                        isWebRemoteControl={isWebRemoteControlShell}
                        key={`plugin-store:${pluginStoreOpenVersion}`}
                        workspacePath={workspaceAbsPath}
                        workspaceIdentity={workspaceIdentity}
                        // Root cause: the standalone plugin page once bypassed the wrapper callback
                        // that returns to chat. The task was created, but the view stayed on plugin
                        // details, making “Try now” and the sample Prompt appear unresponsive.
                        onCreateTask={handleCreateTaskInChat}
                        onManageInstalled={handleManageInstalledPlugins}
                      />
                    </div>
                  </div>
                </AutomationsMainBreadcrumbFrame>
              </main>
            ) : (
              <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
                {/* Bugfix: the mobile remote-control chat page's middle layer must keep providing the flex height chain.
                    A plain block with only h-full breaks ChatView's flex-1: the draft empty state sticks to the top and internal scrolling is clipped by the outer layer. */}
                <ScopedErrorBoundary
                  scope="workspace-chat"
                  resetKeys={workspaceDraftResetKeys}
                  variant="panel"
                  className="h-full"
                >
                  {/* Bugfix (2026-07-05, M3 acceptance): Match the desktop layout by binding activeTaskId instead of meta-derived activeSessionId, so a new v4 session does not remain a draft while the metadata cache is stale. */}
                  {/* Bug cause: Plan details were wired only to the desktop V4WorkspaceChatArea callback, so the mobile card showed a button that could not open the drawer. Both platforms must use the same renderer Side Pane entry. */}
                  <V4ChatPane
                    readOnly={Boolean(workspaceReadOnlyReason)}
                    workspacePath={workspaceAbsPath}
                    workspaceIdentity={workspaceIdentity}
                    isDesktop={isDesktop === true}
                    compactForRemoteControl={isWebRemoteControlShell}
                    sessionId={activeTaskId}
                    provider={activeTaskProvider ?? undefined}
                    onSessionCreated={handleV4SessionCreated}
                    onSessionDeleted={handleV4SessionDeleted}
                    draftComposerHeader={draftComposerHeader}
                    gitSummary={gitState.summary}
                    gitDirtyFileCount={gitDirtyFileCount}
                    gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                    gitWorktreeChangeSummary={gitWorktreeChangeSummary}
                    activeTaskChangeSummary={activeTaskChangeSummary}
                    summaryPanelVariantOverride={summaryPanelVariantOverride}
                    onSummaryPanelVariantOverrideChange={onSummaryPanelVariantOverrideChange}
                    onRefreshGit={handleRefreshGit}
                    onOpenGitReview={handleOpenGitReview}
                    onOpenBrowserUrl={handleOpenBrowserUrl}
                    onOpenAutomationsMain={handleOpenAutomations}
                    onOpenCodeViewer={handleOpenCodeViewer}
                    onAutoOpenAssistantPptx={
                      isDesktop && !isWebRemoteControlShell
                        ? handleAutoOpenAssistantPptx
                        : undefined
                    }
                    onOpenFileLink={handleOpenMarkdownFileLink}
                    onOpenBackgroundBash={handleOpenBackgroundBash}
                    onOpenSubagentSession={handleOpenSubagentSession}
                    onOpenSubagentDirectory={handleOpenSubagentDirectory}
                    onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                    onOpenPlanDetail={handleOpenPlanDetail}
                    onOpenWorkflowRun={handleOpenWorkflowRun}
                    onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                    onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                    onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                    onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                    conversationFindQuery={conversationFindQuery}
                    conversationFindActiveIndex={conversationFindActiveIndex}
                    conversationFindNavigationRequestId={conversationFindNavigationRequestId}
                    onConversationFindMatchStateChange={onConversationFindMatchStateChange}
                    searchResultHighlightRequest={activeSearchResultHighlightRequest}
                    onSearchResultHighlightDone={onSearchResultHighlightDone}
                  />
                </ScopedErrorBoundary>
              </div>
            )
          }
          sidePaneContent={renderSidePanePanel({ mobileOverlay: true })}
        />
      </DesktopWindowFrame>
    );
  }

  return (
    // The two shell-level destinations on the completion card (docs/dynamic-workflow/transcript-and-notifications.md,
    // “Saving the run, and running it again”): the chip opens the hub page, and “Run again” switches
    // to the new session after launch. Wrap only the desktop branch; the mobile remote shell does
    // not provide the hub, so its chip is plain text.
    <SavedWorkflowHubProvider
      openWorkflow={handleOpenSavedWorkflowInHub}
      navigateToRun={handleNavigateToLaunchedRun}
    >
      {/* Empty-state “New worktree”首发拦截槽位：须包住 ConversationComposer 所在子树。 */}
      <ComposerDraftWorktreeIntentContext.Provider value={draftWorktreeIntentSlot}>
        <DesktopWindowFrame
          title={`ZCode / ${getPathLeaf(workspaceAbsPath)}`}
          showHeader
          isDesktop={isDesktop}
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
          headerTestId={TID_APP_HEADER}
        >
          <div
            ref={workspaceShellRef}
            data-workspace-shell="true"
            style={workspaceShellSplitStyle}
            className={cn(
              "relative flex h-full min-h-0 w-full overflow-hidden",
              // Root cause: during native window resize, the outer react-resizable-panels wrote every
              // frame to the layout store, repeatedly committing sidebar tooltip/menu subtrees. Use
              // a dedicated CSS-variable-driven split so ordinary window resizes use browser layout
              // without triggering React state updates.
              isWebRemoteControlShell && "max-md:flex-col",
            )}
          >
            <div
              ref={workspaceSidebarPanelElementRef}
              data-panel=""
              data-workspace-sidebar-panel="true"
              id="sidebar"
              className={cn(
                "w-[var(--workspace-sidebar-panel-width)] max-w-[50%] flex-none overflow-hidden duration-200 ease-out transition-[width,opacity] data-[workspace-sidebar-resizing=true]:transition-opacity",
                // Root cause: continuing to transition width while dragging the sidebar makes its
                // actual width lag behind the pointer. Use a DOM marker to toggle the transition while
                // dragging, avoiding a full workspace rerender to change a class on pointerdown/up.
                isWebRemoteControlShell &&
                  cn(
                    // Bugfix: Web remote control still reused the desktop horizontal shell in mobile
                    // browsers; the 264px sidebar plus 320px content exceeded the viewport and forced
                    // horizontal scrolling. Stack the main layout vertically only at the small-screen
                    // breakpoint in remote-control mode; desktop keeps its existing columns.
                    // Interaction fix: on mobile remote control, a button on the WorkspaceHeader's
                    // bottom edge now adjusts the top height. Sync it through a CSS variable so
                    // dragging does not unmount navigation content or interrupt task-list state.
                    renderWebRemoteNavigationPanel
                      ? "max-md:!h-[var(--web-remote-navigation-height)] max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-b max-md:border-border max-md:bg-sidebar"
                      : "max-md:!h-0 max-md:!min-h-0 max-md:!w-full max-md:!max-w-none max-md:!flex-none max-md:!basis-0 max-md:!border-b-0",
                  ),
                isSidebarPanelVisible ? "opacity-100" : "pointer-events-none opacity-0",
              )}
            >
              {/* Bugfix: Keep the remote-control top navigation mounted while collapsed to prevent the entire sidebar from reloading when expanded. */}
              <aside
                id={isWebRemoteControlShell ? "web-remote-control-navigation-panel" : undefined}
                ref={sidebarContainerRef}
                className={cn(
                  "h-full overflow-hidden select-none",
                  isWebRemoteControlShell && "max-md:min-h-0 max-md:flex-1",
                  !renderWebRemoteNavigationPanel && "max-md:hidden",
                )}
                aria-hidden={!isSidebarPanelVisible || !renderWebRemoteNavigationPanel}
              >
                <ScopedErrorBoundary
                  scope="workspace-sidebar"
                  resetKeys={workspaceOnlyResetKeys}
                  variant="panel"
                  className="h-full"
                >
                  {/* Session workbench groups: split panes are enabled on desktop and regular web apps, but not on mobile or /remote control. */}
                  <V4SplitPaneEntryProvider
                    enabled={!isWebRemoteControlShell && !isWebRemoteControlMobileViewport}
                    canOpenSession={canOpenSessionInSplitPane}
                    onOpenSession={handleOpenSessionInSplitPane}
                  >
                    <WorkflowRunOpenProvider onOpenRun={handleOpenSidebarWorkflowRun}>
                      <WorkspaceSidebar
                        workspacePath={workspaceAbsPath}
                        workspaceRemoteSessionId={workspaceRemoteSessionId}
                        activePreviewPath={activePreviewPath}
                        onSelectTask={handleSelectTaskInChat}
                        onStartDraftInWorkspace={handleCreateProjectDraft}
                        onOpenCodeViewer={handleOpenCodeViewer}
                        onOpenBrowserUrl={handleOpenBrowserUrl}
                        fileTreeOpenRequest={fileTreeOpenRequest}
                        onCreateTask={handleCreateTaskInChat}
                        onCreateConversationTask={
                          onCreateConversationTask ?? handleCreateTaskInChat
                        }
                        onOpenFolderFromWorkspaceMenu={onOpenFolderFromWorkspaceMenu}
                        onOpenRemoteWorkspace={onOpenRemoteWorkspace}
                        webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
                        theme={theme}
                        onConnectRemote={onConnectRemote}
                        onSelectRemoteProject={onSelectRemoteProject}
                        onCancelRemoteProject={onCancelRemoteProject}
                        onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
                        reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                        remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                        reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                          reconnectingRemoteWorkspaceLogsByWorkspaceKey
                        }
                        onLogout={onLogout}
                        onLogin={onLogin}
                        user={user}
                        isDesktop={isDesktop}
                        isWebRemoteControl={isWebRemoteControlShell}
                        isMacDesktop={isMacDesktop}
                        isWindowsDesktop={isWindowsDesktop}
                        isSidebarVisible={isSidebarVisible}
                        onToggleSidebar={handleToggleSidebar}
                        toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
                        canGoBack={canPrimaryNavigationBack}
                        canGoForward={canTaskNavForward}
                        onGoBack={primaryNavigationBack}
                        onGoForward={handleTaskNavForward}
                        goBackShortcutLabel={goBackShortcutLabel}
                        goForwardShortcutLabel={goForwardShortcutLabel}
                        onOpenCommandCenter={handleOpenCommandCenter}
                        onOpenAutomations={handleOpenAutomations}
                        automationsActive={workspaceMainView === "automations"}
                        onOpenPluginStore={handleOpenPluginStore}
                        pluginStoreActive={workspaceMainView === "plugin-store"}
                        onFileTreeOpenChange={setIsSidebarFileTreeOpen}
                        onWebRemoteTaskOpen={handleWebRemoteTaskOpen}
                        onWebRemoteTaskSwitchingChange={handleWebRemoteTaskSwitchingChange}
                      />
                    </WorkflowRunOpenProvider>
                  </V4SplitPaneEntryProvider>
                </ScopedErrorBoundary>
              </aside>
            </div>

            {isSidebarVisible && renderWebRemoteNavigationPanel ? (
              <div
                role="separator"
                tabIndex={0}
                aria-controls="sidebar"
                aria-label={workspaceSidebarResizeLabel}
                aria-orientation="vertical"
                aria-valuemin={WORKSPACE_SIDEBAR_MIN_WIDTH_PX}
                aria-valuenow={Math.round(workspaceSidebarPanelWidthPx)}
                data-testid="resizable-handle"
                onKeyDown={handleWorkspaceSidebarResizeKeyDown}
                onPointerCancel={(event) => finishWorkspaceSidebarResize(event, true)}
                onPointerDown={handleWorkspaceSidebarResizeStart}
                onPointerMove={handleWorkspaceSidebarResizeMove}
                onPointerUp={(event) => finishWorkspaceSidebarResize(event)}
                className={cn(
                  "group/handle relative z-10 flex h-full w-1 shrink-0 touch-none cursor-ew-resize items-center justify-center bg-transparent outline-none [app-region:no-drag] focus:outline-none focus-visible:ring-0",
                  "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius)] after:w-0.5",
                  "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100 [[data-workspace-sidebar-resizing=true]_&]:after:opacity-100",
                  hasDesktopPanelInset && "after:inset-y-[var(--workspace-resize-handle-inset)]",
                  isWebRemoteControlShell && "max-md:hidden",
                )}
              />
            ) : null}
            {/* Right-side main workspace: header on top; session and terminal on the lower left; shared browser/code-viewer slot on the right. */}
            <div
              data-panel=""
              id="content"
              className={cn(
                "flex min-w-[320px] flex-1 flex-col",
                hasDesktopPanelInset ? "p-1 pl-0 pt-0" : "p-0",
                isWebRemoteControlShell &&
                  "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0",
              )}
            >
              {
                hasDesktopPanelInset && (
                  <div className="h-1 w-full [app-region:drag]" />
                ) /* Fix the issue where the header covered the top macOS window controls and made them unclickable. */
              }
              <ResizablePanelGroup
                layoutId="workspace-body-layout"
                panelIds={WORKSPACE_BODY_PANEL_IDS}
                className={cn("min-h-0 flex-1", isWebRemoteControlShell && "max-md:!flex-col")}
              >
                <ResizablePanel
                  id="conversation-column"
                  minSize={isWebRemoteControlShell ? "0px" : "35%"}
                  defaultSize={isSidePaneVisible ? "52%" : undefined}
                  className={
                    isWebRemoteControlShell
                      ? "max-md:!w-full max-md:!min-w-0 max-md:!flex-1 max-md:!basis-0"
                      : undefined
                  }
                >
                  <ResizablePanelGroup
                    orientation="vertical"
                    layoutId="workspace-conversation-column-layout"
                    panelIds={WORKSPACE_CONVERSATION_PANEL_IDS}
                    className="h-full min-h-0"
                  >
                    <ResizablePanel
                      id="conversation"
                      elementRef={conversationPanelElementRef}
                      minSize="35%"
                    >
                      <section
                        data-workspace-conversation-frame="true"
                        className={cn(
                          "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background",
                          isSidePaneVisible
                            ? "rounded-[var(--workspace-panel-radius)] border border-border"
                            : resolveWorkspaceShellWindowChromeClass({
                                isMacDesktop,
                                isWindowsDesktop,
                                isLinuxDesktop,
                                macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                                isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                                supportsNativeRoundedCorners:
                                  desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                              }),
                          isTerminalVisible && "rounded-b-[var(--workspace-panel-radius)] border-b",
                          isWebRemoteControlShell &&
                            "max-md:rounded-none max-md:border-x-0 max-md:border-b-0",
                        )}
                      >
                        {shouldRenderWorkspaceHeader ? (
                          <ScopedErrorBoundary
                            scope="workspace-header"
                            resetKeys={workspaceOnlyResetKeys}
                            variant="compact"
                            className="border-b"
                          >
                            <WorkspaceHeader
                              reserveWindowControls={!isSidePaneVisible}
                              variant={activeTaskId === null ? "draft" : "task"}
                              draftDropTargetController={
                                activeTaskId === null ? draftHeaderDropTargetController : undefined
                              }
                              readOnlyReason={workspaceReadOnlyReason}
                              workspaceAbsPath={workspaceAbsPath}
                              remoteSessionId={workspaceRemoteSessionId}
                              workspaceIdentity={workspaceIdentity}
                              remoteTarget={workspaceRemoteTarget}
                              localWorkspacePath={workspaceLocalPathForRemoteMcpSync}
                              projectName={projectName}
                              activeTaskTitle={activeTaskTitle}
                              activeTaskChangeSummary={activeTaskChangeSummary}
                              hasUpdateReady={hasUpdateStatusButton}
                              activeTaskId={activeTaskId}
                              user={user}
                              activeTraceId={activeTraceId}
                              activeSessionId={activeSessionId}
                              activeTaskProvider={activeTaskProvider}
                              resolvedActiveTaskMeta={resolvedActiveTaskMeta}
                              sessionLogPath={taskSessionFile.path}
                              nativeSessionLogProvider={taskNativeSessionLogFile.provider}
                              nativeSessionLogPath={taskNativeSessionLogFile.path}
                              nativeSessionLogExists={taskNativeSessionLogFile.exists}
                              nativeSessionLogLoading={taskNativeSessionLogFile.loading}
                              providerWorkspaceConfigPath={providerConfigFile.path}
                              providerWorkspaceConfigExists={providerConfigFile.exists}
                              providerWorkspaceConfigLoading={providerConfigFile.loading}
                              workspaceHeaderState={workspaceShellZCodeState}
                              gitSummary={gitState.summary}
                              gitDirtyFileCount={gitDirtyFileCount}
                              isMacDesktop={isMacDesktop}
                              isMacFullscreen={isMacFullscreen}
                              isWindowsDesktop={isWindowsDesktop}
                              isWebRemoteControl={isWebRemoteControlShell}
                              windowsWindowControlsRightPaddingPx={
                                windowsWindowControlsRightPaddingPx
                              }
                              isDesktop={isDesktop}
                              simplifyForNarrowRemote={simplifyHeaderForNarrowRemote}
                              isSidebarVisible={isSidebarVisible}
                              isTerminalOpen={isTerminalOpen}
                              isSidePaneOpen={isSidePaneOpen}
                              onRefreshGit={handleRefreshGit}
                              onToggleTerminal={handleToggleTerminal}
                              onToggleBrowser={handleToggleBrowser}
                              onToggleSidePane={handleToggleSidePane}
                              toggleSidePaneShortcutLabel={toggleSidePaneShortcutLabel}
                              onReloadSession={handleReloadSession}
                              reloadSessionDisabled={workspaceSessionActionDisabled}
                              reloadSessionPending={reloadSessionPending}
                              onCreateTask={handleCreateTaskInChat}
                              onOpenWorkspace={onOpenWorkspace}
                              allowOpenWorkspace={allowOpenWorkspace}
                            />
                          </ScopedErrorBoundary>
                        ) : null}
                        {isWebRemoteControlShell ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="icon-md"
                            data-web-remote-navigation-resize-handle="true"
                            className={cn(
                              "absolute left-1/2 z-30 hidden -translate-x-1/2 -translate-y-1/2 touch-none cursor-ns-resize border-border bg-surface text-foreground-subtle shadow-sm hover:bg-surface-hover hover:text-foreground max-md:inline-flex [app-region:no-drag]",
                              shouldRenderWorkspaceHeader ? "top-12" : "top-0",
                              isWebRemoteControlNavigationDragging &&
                                "border-border-hover bg-surface-hover text-foreground",
                            )}
                            aria-expanded={!isWebRemoteControlNavigationCollapsed}
                            aria-controls="web-remote-control-navigation-panel"
                            aria-label={intl.formatMessage({
                              id: isWebRemoteControlNavigationCollapsed
                                ? "webRemoteControl.expandNavigation"
                                : "webRemoteControl.collapseNavigation",
                            })}
                            onPointerDown={handleWebRemoteNavigationResizeStart}
                            onPointerMove={handleWebRemoteNavigationResizeMove}
                            onPointerUp={(event) => {
                              finishWebRemoteNavigationResize(event);
                            }}
                            onPointerCancel={(event) => {
                              finishWebRemoteNavigationResize(event, true);
                            }}
                            onClick={handleWebRemoteNavigationHandleClick}
                          >
                            <GripHorizontal className="size-4" />
                          </Button>
                        ) : null}
                        <div className="min-h-0 flex-1 overflow-hidden">
                          {workspaceMainView === "automations" && !isWebRemoteControlShell ? (
                            <main
                              id={AUTOMATIONS_TOAST_ANCHOR_ID}
                              className="flex h-full min-h-0 flex-1 flex-col bg-background"
                            >
                              <AutomationsMainBreadcrumbFrame
                                isDesktop={Boolean(isDesktop)}
                                sectionLabel={intl.formatMessage({
                                  id: "settings.automations.title",
                                })}
                                ariaLabel={intl.formatMessage({
                                  id: "automations.breadcrumbLabel",
                                })}
                              >
                                <div
                                  // Root cause: Automations tabs have different content heights, so the
                                  // scrollbar appearing/disappearing changes the available width of the mx-auto
                                  // content column and shifts the whole page horizontally. Reserve a stable
                                  // gutter to keep the centering reference unchanged.
                                  className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
                                >
                                  <ScopedErrorBoundary
                                    scope="automations-main"
                                    resetKeys={workspaceOnlyResetKeys}
                                    variant="panel"
                                    className="min-h-full"
                                  >
                                    <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-4 md:px-6 md:py-6">
                                      <AutomationsSection
                                        workspacePath={workspaceAbsPath}
                                        workspaceIdentity={workspaceIdentity}
                                        onCreateViaChat={handleCreateAutomationInChat}
                                        onNavigateToLaunchedRun={handleNavigateToLaunchedRun}
                                        onOpenWorkflowRun={handleOpenSavedWorkflowRun}
                                        onOpenWorkflowArtifact={handleOpenSavedWorkflowArtifact}
                                        openAutomationId={openAutomationId}
                                        openAutomationTab={openAutomationTab}
                                        onOpenAutomationConsumed={onOpenAutomationConsumed}
                                        openWorkflow={openWorkflow}
                                        onOpenWorkflowConsumed={onOpenWorkflowConsumed}
                                        onOpenSession={({
                                          sessionId,
                                          workspacePath,
                                          workspaceIdentity,
                                        }) =>
                                          handleSelectTaskInChat(
                                            workspacePath,
                                            sessionId,
                                            workspaceIdentity,
                                          )
                                        }
                                      />
                                    </div>
                                  </ScopedErrorBoundary>
                                </div>
                              </AutomationsMainBreadcrumbFrame>
                            </main>
                          ) : workspaceMainView === "plugin-store" && !isWebRemoteControlShell ? (
                            <main className="flex h-full min-h-0 flex-1 flex-col bg-background">
                              <AutomationsMainBreadcrumbFrame
                                isDesktop={Boolean(isDesktop)}
                                sectionLabel={intl.formatMessage({
                                  id: "workspace.openPluginsSettings",
                                })}
                                ariaLabel={intl.formatMessage({
                                  id: "settings.breadcrumbLabel",
                                })}
                              >
                                <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                                  <div className="mx-auto flex w-full max-w-4xl flex-col px-4 py-4 md:px-6 md:py-6">
                                    <PluginStorePage
                                      isWebRemoteControl={isWebRemoteControlShell}
                                      key={`plugin-store:${pluginStoreOpenVersion}`}
                                      workspacePath={workspaceAbsPath}
                                      workspaceIdentity={workspaceIdentity}
                                      onCreateTask={handleCreateTaskInChat}
                                      onManageInstalled={handleManageInstalledPlugins}
                                    />
                                  </div>
                                </div>
                              </AutomationsMainBreadcrumbFrame>
                            </main>
                          ) : (
                            <main className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                              {renderChatFindDialog()}
                              <ScopedErrorBoundary
                                scope="workspace-chat"
                                resetKeys={workspaceDraftResetKeys}
                                variant="panel"
                                className="h-full"
                              >
                                {/* Bugfix(2026-07-05, M3 acceptance): Pane binding must use the original activeTaskId selection,
                                  not activeSessionId derived from metadata. A session just created by v4 createSession
                                  is not in taskListCache/optimistic cache, so metadata resolves to null and leaves the pane
                                  stuck in draft. In v4, sessionId ≡ taskId; metadata is only for Header display.
                                  M5⑤: The Desktop main area now hosts two split-pane layers (Layout/Focus); primary-pane
                                  binding semantics and the testid contract (paneId=workspace-main) remain unchanged. */}
                                <V4WorkspaceChatArea
                                  readOnly={Boolean(workspaceReadOnlyReason)}
                                  foregroundEnabled={isWorkspaceVisible}
                                  workspacePath={workspaceAbsPath}
                                  workspaceIdentity={workspaceIdentity}
                                  isDesktop={isDesktop === true}
                                  remoteSessionId={workspaceRemoteSessionId}
                                  compactForRemoteControl={isWebRemoteControlShell}
                                  sessionId={activeTaskId}
                                  activeSelectionSideChatSessionId={
                                    activeSelectionSideChatSessionId
                                  }
                                  provider={activeTaskProvider ?? undefined}
                                  onSessionCreated={handleV4SessionCreated}
                                  onSessionDeleted={handleV4SessionDeleted}
                                  draftComposerHeader={draftComposerHeader}
                                  onPrimaryDraftDropTargetControllerChange={
                                    setDraftHeaderDropTargetController
                                  }
                                  gitSummary={gitState.summary}
                                  gitDirtyFileCount={gitDirtyFileCount}
                                  activeTaskChangeSummary={activeTaskChangeSummary}
                                  gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                                  gitWorktreeChangeSummary={gitWorktreeChangeSummary}
                                  summaryPanelVariantOverride={summaryPanelVariantOverride}
                                  onSummaryPanelVariantOverrideChange={
                                    onSummaryPanelVariantOverrideChange
                                  }
                                  onRefreshGit={handleRefreshGit}
                                  onOpenGitReview={handleOpenGitReview}
                                  onPaneActiveSessionChange={handlePaneActiveSessionChange}
                                  onOpenBrowserUrl={handleOpenBrowserUrl}
                                  onOpenAutomationsMain={handleOpenAutomations}
                                  onOpenCodeViewer={handleOpenCodeViewer}
                                  onAutoOpenAssistantPptx={
                                    isDesktop && !isWebRemoteControlShell
                                      ? handleAutoOpenAssistantPptx
                                      : undefined
                                  }
                                  onOpenBackgroundBash={handleOpenBackgroundBash}
                                  onOpenSubagentSession={handleOpenSubagentSession}
                                  onOpenSubagentDirectory={handleOpenSubagentDirectory}
                                  onSyncSubagentSessionTabs={handleSyncSubagentSessionTabs}
                                  onOpenSelectionSideChat={handleOpenSelectionSideChat}
                                  onOpenPlanDetail={handleOpenPlanDetail}
                                  onOpenWorkflowRun={handleOpenWorkflowRun}
                                  onOpenWorkflowArtifact={handleOpenWorkflowArtifact}
                                  onOpenWorkflowRunDirectory={handleOpenWorkflowRunDirectory}
                                  onOpenWorkflowActorSession={handleOpenWorkflowActorSession}
                                  onOpenWorkflowWorkspace={handleOpenWorkflowWorkspace}
                                  onOpenFileLink={handleOpenMarkdownFileLink}
                                  conversationFindQuery={conversationFindQuery}
                                  conversationFindActiveIndex={conversationFindActiveIndex}
                                  conversationFindNavigationRequestId={
                                    conversationFindNavigationRequestId
                                  }
                                  onConversationFindMatchStateChange={
                                    onConversationFindMatchStateChange
                                  }
                                  searchResultHighlightRequest={activeSearchResultHighlightRequest}
                                  onSearchResultHighlightDone={onSearchResultHighlightDone}
                                />
                              </ScopedErrorBoundary>
                            </main>
                          )}
                        </div>
                      </section>
                    </ResizablePanel>
                    {isWebRemoteControlShell ||
                    (workspaceMainView !== "automations" &&
                      workspaceMainView !== "plugin-store") ? (
                      <AnimatedTerminalPanel
                        frameClassName={cn(
                          isSidePaneVisible
                            ? "rounded-[var(--workspace-panel-radius)] border border-border"
                            : resolveWorkspaceShellWindowChromeClass({
                                isMacDesktop,
                                isWindowsDesktop,
                                isLinuxDesktop,
                                macOSMajorVersion: desktopWindowChromeState?.macOSMajorVersion,
                                isWindowsMaximized: desktopWindowChromeState?.isMaximized ?? false,
                                supportsNativeRoundedCorners:
                                  desktopWindowChromeState?.supportsNativeRoundedCorners ?? null,
                              }),
                          "rounded-t-[var(--workspace-panel-radius)] border-t",
                        )}
                        services={services}
                        workspaceAbsPath={workspaceAbsPath}
                        workspaceIdentity={workspaceIdentity}
                        openWorkspaceKeys={openWorkspaceKeys}
                        isVisible={isTerminalVisible}
                        isWindowsDesktop={isWindowsDesktop}
                        panelRef={terminalPanelRef}
                        panelElementRef={terminalPanelElementRef}
                        onClose={() => setIsTerminalOpen(false)}
                        onOpenBrowserUrl={handleOpenBrowserUrl}
                      />
                    ) : null}
                  </ResizablePanelGroup>
                </ResizablePanel>
                {/* Bugfix: Decouple Browser Guest Host from the main-view route so switching automations/plugins does not unmount the Guest. During screenshot requests, the parent temporarily expands the real panel to host compositable WebContents. */}
                {sidePanePanel}
              </ResizablePanelGroup>
            </div>
            <ScopedErrorBoundary
              scope="desktop-top-overlay"
              resetKeys={workspaceSidebarVisibilityResetKeys}
              variant="silent"
            >
              <DesktopTopOverlay
                newTaskDisabledReason={workspaceReadOnlyReason}
                workspaceAbsPath={workspaceAbsPath}
                isMacDesktop={isMacDesktop}
                isMacFullscreen={isMacFullscreen}
                macWindowControlsLeftPaddingPx={macWindowControlsLeftPaddingPx}
                windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
                isWindowsDesktop={isWindowsDesktop}
                isDesktop={isDesktop}
                isSidebarVisible={isSidebarVisible}
                updateReadyVersion={updateReadyVersion}
                updateState={updateState}
                toggleSidebarShortcutLabel={toggleSidebarShortcutLabel}
                newTaskShortcutLabel={newTaskShortcutLabel}
                goBackShortcutLabel={goBackShortcutLabel}
                goForwardShortcutLabel={goForwardShortcutLabel}
                canTaskNavBack={canPrimaryNavigationBack}
                canTaskNavForward={canTaskNavForward}
                canGoBack={canGoBack}
                canGoForward={canGoForward}
                showNewTaskButton={showTopOverlayNewTaskButton}
                appLogoUrl={appLogoUrl}
                platform={platform}
                onToggleSidebar={handleToggleSidebar}
                onCreateTask={handleCreateTaskInChat}
                onGoBack={primaryNavigationBack}
                onGoForward={handleTaskNavForward}
                hideTaskNavigationButtons={simplifyHeaderForNarrowRemote}
              />
            </ScopedErrorBoundary>

            {isWebRemoteControlShell && isWebRemoteControlTaskSwitching ? (
              <div
                className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
                aria-live="polite"
                aria-busy="true"
              >
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
                  <LoaderIcon className="size-4 animate-spin" />
                  {/* Bugfix: when clicking a task from another workspace, the old page unmounts quickly and previously had no unified placeholder before unmount,
                  visually appearing as “blank first, then render”. Add a global loading overlay here to give stable feedback during the switch. */}
                  {intl.formatMessage({ id: "common.loading" })}
                </div>
              </div>
            ) : null}
          </div>
        </DesktopWindowFrame>
      </ComposerDraftWorktreeIntentContext.Provider>
    </SavedWorkflowHubProvider>
  );
});
