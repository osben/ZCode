/* eslint-disable max-lines -- The side pane currently hosts tabs and browser/git/code-viewer content in one place; a full split must follow pane functional boundaries. */
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { ServiceProvider, useComposerClientNamespace } from "@/hooks/useServices.js";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { IServiceAccessor } from "@zcode/services";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import {
  isRemoteWorkspaceIdentity,
  type BrowserViewScreenshotSurfacePreparePayload,
  type GitChangeSourceId,
} from "@zcode/shared";
import { FileManagerPane } from "@/WorkspaceFileTree.js";
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { composerScopeKey, resolveComposerScope } from "@/v4/composer/composerDraftStore.js";
import { SidePaneTerminalPane } from "@/SidePaneTerminalPane.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import {
  SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE,
  SidePaneFullViewConversationTab,
  SidePaneFullViewToggleButton,
  type SidePaneFullViewSurface,
} from "@/side-pane-full-view/index.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { BrowserUseSidePaneContent } from "@/browser-use/BrowserUseSidePaneContent.js";
import { BrowserSitePermissionsPage } from "@/browser-use/BrowserSitePermissionsPage.js";
import { findScreenshotSurfaceTabForRender } from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { HumanBrowserView } from "@/browser-use/HumanBrowserView.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { GitPaneWithLastTurn } from "@/review-last-turn/index.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { TreemappingPane } from "@/TreemappingPane.js";
import { WhiteboardPane } from "@/WhiteboardPane.js";
import { ModelTrajectoryPane } from "@/ModelTrajectoryPane.js";
import { ModelTrajectoryV2Pane } from "@/model-trajectory-v2/index.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";
import { DeveloperToolsPane } from "@/DeveloperToolsPane.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";

import {
  ResizableHandle,
  ResizablePanel,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs.js";
import { SidePaneTabOverview } from "@/app-shell/SidePaneTabOverview.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import { SubagentDirectorySidePane } from "@/app-shell/SubagentDirectorySidePane.js";
import { SelectionSideChatPane } from "@/app-shell/SelectionSideChatPane.js";
import { BackgroundBashOutputSidePane } from "@/app-shell/BackgroundBashOutputSidePane.js";
import { PlanDetailSidePane } from "@/app-shell/PlanDetailSidePane.js";
import {
  PluginUiLauncherItems,
  PluginUiSidePane,
  SidePaneLauncherRow,
  useMarketPluginUi,
  useOpenPluginUi,
} from "@/plugin-ui/index.js";
import { WorkflowRunSidePane } from "@/app-shell/WorkflowRunSidePane.js";
import { WorkflowRunDirectorySidePane } from "@/app-shell/WorkflowRunDirectorySidePane.js";
import { WorkflowActorSessionSidePane } from "@/app-shell/WorkflowActorSessionSidePane.js";
import { WorkflowWorkspaceSidePane } from "@/app-shell/WorkflowWorkspaceSidePane.js";
import { WorkflowArtifactSidePane } from "@/app-shell/WorkflowArtifactSidePane.js";
import {
  getSidePaneTabTitle,
  SidePaneTabDragOverlay,
  SortableSidePaneTabTrigger,
} from "@/app-shell/SidePaneTabTrigger.js";
import {
  resolveSidePaneTabsOverflow,
  SIDE_PANE_DEFAULT_EXPANDED_RATIO,
} from "@/app-shell/sidePaneLayout.js";
import {
  resolveAnimatedSidePanePanelLayout,
  resolveOpenTabLauncherItemIds,
  SITES_PLUGIN_ID,
  shouldOfferSelectionSideConversation,
  shouldRenderPreviewPaneHeavyContent,
  type OpenTabLauncherItemId,
} from "@/app-shell/animatedSidePanePanelModel.js";
import type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import { useDeveloperToolsVisibility } from "@/hooks/useDeveloperToolsVisibility.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import { logger } from "@/logger.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  shouldMountSidePaneContent,
  shouldMountBrowserTabGuest,
  type BrowserSidePaneTab,
  type BrowserUseSidePaneTab,
  type BrowserSidePaneMetadata,
  type OpenScopedSubagentSideTabRequest,
  type OpenScopedSubagentDirectorySideTabRequest,
  type OpenScopedPlanDetailSideTabRequest,
  type SyncSubagentSessionTabsRequest,
  type OpenScopedWorkflowActorSessionSideTabRequest,
  type OpenScopedWorkflowWorkspaceSideTabRequest,
  type OpenScopedWorkflowArtifactSideTabRequest,
  type OpenScopedWorkflowRunSideTabRequest,
  type OpenBackgroundBashSideTabRequest,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import { inferMediaPreview, type CodeViewerSource } from "@/lib/codeViewer.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { getVisibleSidePaneTabs } from "@/lib/workspaceSidePane.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  BugIcon,
  ChartNoAxesGanttIcon,
  ChartLineIcon,
  ChevronRightIcon,
  FileDiffIcon,
  FolderOpenIcon,
  EarthIcon,
  GlobeIcon,
  MessageSquareTextIcon,
  PlusIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react";

const SIDE_PANE_CONTENT_WIDTH_LOCK_DURATION_MS = 200;
const PREVIEW_PANE_RESIZE_SETTLE_DELAY_MS = 220;
type TabsScrollMaskEdges = {
  left: boolean;
  right: boolean;
};
type OpenTabLauncherItem = {
  id: OpenTabLauncherItemId;
  label: string;
  description: string;
  icon: LucideIcon;
  onOpen: () => void;
};
const EMPTY_SIDE_PANE_TABS: WorkspaceSidePaneState["tabs"] = [];
const EMPTY_TABS_SCROLL_MASK_EDGES: TabsScrollMaskEdges = {
  left: false,
  right: false,
};

function SuspendedBrowserSidePaneContent({
  tab,
}: {
  tab: BrowserSidePaneTab | BrowserUseSidePaneTab;
}) {
  const platform = usePlatform();
  const tabId = tab.type === "browser-use" ? tab.tabId : tab.id;
  const generation = tab.residencyGeneration ?? 0;

  useEffect(() => {
    if (tab.residency !== "suspended") return;
    // This React effect runs after the old UnifiedBrowserView commits its unmount; acking here
    // lets main safely close the guest WebContents instead of treating the suspend as a
    // render-process-gone crash and immediately recreating it.
    // info-level marker: the suspend re-shell unloads the <webview> first; if CDP is still
    // attached at the unload instant, a main-process UAF window opens. This log aligns the
    // re-shell moment with UnifiedBrowserView's unload marker to attribute who destroyed the guest.
    logger.info("[browser-use] tab 换挂起壳，suspend ready ack", { generation, tabId });
    void platform.browserViewSuspendReady?.({ tabId, generation }).catch((error) => {
      logger.debug("[browser-use] suspend ready ack 失败", {
        error: error instanceof Error ? error.message : String(error),
        generation,
        tabId,
      });
    });
  }, [generation, platform, tab.residency, tabId]);

  return (
    <TabsContent
      value={tab.id}
      forceMount
      data-browser-tab-residency="suspended"
      className="relative z-10 h-full min-h-0 bg-background data-[state=inactive]:hidden"
    />
  );
}

function readViewportInlineIntersectionSize(element: HTMLElement | null) {
  if (!element || typeof window === "undefined") {
    return null;
  }

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  if (viewportWidth <= 0) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  const visibleLeft = Math.max(0, rect.left);
  const visibleRight = Math.min(viewportWidth, rect.right);
  return Math.max(0, Math.round(visibleRight - visibleLeft));
}

function useViewportInlineIntersectionSize<TElement extends HTMLElement>(
  elementRef: RefObject<TElement | null>,
  enabled: boolean,
) {
  const [visibleInlineSizePx, setVisibleInlineSizePx] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setVisibleInlineSizePx(null);
      return;
    }

    const element = elementRef.current;
    if (!element) {
      setVisibleInlineSizePx(null);
      return;
    }

    let frameId: number | null = null;
    const update = () => {
      frameId = null;
      const next = readViewportInlineIntersectionSize(element);
      setVisibleInlineSizePx((current) => (current === next ? current : next));
    };
    const scheduleUpdate = () => {
      if (frameId !== null) {
        return;
      }

      if (typeof window.requestAnimationFrame !== "function") {
        update();
        return;
      }

      frameId = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    window.addEventListener("scroll", scheduleUpdate, {
      capture: true,
      passive: true,
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);

    return () => {
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, { capture: true });
      resizeObserver?.disconnect();
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [elementRef, enabled]);

  return visibleInlineSizePx;
}

function useWindowResizeSettling(enabled: boolean) {
  const [isResizeSettling, setIsResizeSettling] = useState(false);
  const resizeSettleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setIsResizeSettling(false);
      return;
    }

    const finishSettling = () => {
      resizeSettleTimerRef.current = null;
      setIsResizeSettling(false);
    };

    const markSettling = () => {
      // During a window resize, a large-file PreviewPane's thousand-line Shadow DOM joins
      // React commit + Layout every frame. Treat resize as a brief unstable phase and restore
      // heavy content only after the size stops jittering.
      setIsResizeSettling((current) => (current ? current : true));
      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
      }
      resizeSettleTimerRef.current = window.setTimeout(
        finishSettling,
        PREVIEW_PANE_RESIZE_SETTLE_DELAY_MS,
      );
    };

    window.addEventListener("resize", markSettling, { passive: true });
    window.visualViewport?.addEventListener("resize", markSettling, {
      passive: true,
    });

    return () => {
      window.removeEventListener("resize", markSettling);
      window.visualViewport?.removeEventListener("resize", markSettling);
      if (resizeSettleTimerRef.current !== null) {
        window.clearTimeout(resizeSettleTimerRef.current);
        resizeSettleTimerRef.current = null;
      }
    };
  }, [enabled]);

  return isResizeSettling;
}

export function AnimatedSidePanePanel({
  services,
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  isVisible,
  sidePaneState,
  recentClosedSidePaneTabs,
  isBrowserOpen,
  supportsEmbeddedBrowser = true,
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeTaskId,
  sidePaneOwnerId,
  gitState,
  gitRepositoryWorkspacePath,
  activeGitSourceId,
  panelRef,
  panelElementRef,
  browserNavigationRequest,
  browserRestoreUrls,
  screenshotSurfaceRequest: screenshotSurfaceRequestProp = null,
  screenshotSurfaceTabId = null,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  onCloseGit,
  onActivateTab,
  onOpenNewTab,
  onReorderTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onReopenClosedTab,
  onOpenBrowserTab,
  onOpenBrowserPermissionSettings,
  onOpenWhiteboard: _onOpenWhiteboard,
  onOpenDeveloperTools,
  onOpenFileManager,
  onNavigateFileManager,
  onOpenPluginMarket,
  onCreateTask,
  onOpenTerminalTab,
  onOpenReviewTab,
  onOpenModelTrajectory,
  onOpenModelTrajectoryV2,
  onOpenSelectionSideConversation,
  onOpenPlanDetail,
  onRevealGitFileInTree,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
  onOpenSubagentDirectory,
  onSyncSubagentSessionTabs,
  onOpenWorkflowActorSession,
  onOpenWorkflowWorkspace,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenBackgroundBash,
  onRefreshGit,
  onBrowserNavigationRequestHandled,
  onBrowserUrlChange,
  onBrowserPageMetadataChange,
  onSelectGitSource,
  frameClassName = "rounded-xl border border-border",
  captionControlsStyle,
  showWindowControls,
  onCloseSidePane,
  toggleSidePaneShortcutLabel,
  fullViewToggle,
  fullView = null,
  fullViewSlotRef,
  mobileOverlay = false,
  mobileStacked = false,
}: {
  services: IServiceAccessor;
  frameClassName?: string;
  captionControlsStyle?: CSSProperties;
  showWindowControls?: boolean;
  onCloseSidePane?: () => void;
  toggleSidePaneShortcutLabel?: string;
  /** Desktop-only "enter / exit full view" button; not rendered by default (Web, mobile remote). */
  fullViewToggle?: { active: boolean; onToggle: () => void; shortcutLabel?: string };
  /** Tab-bar state while full view is active (spec: docs/ui/side-pane-full-view.md). */
  fullView?: {
    surface: SidePaneFullViewSurface;
    conversationTitle: string;
    /** Left inset reserved for the top-left floating button group while the sidebar is collapsed (same rule as WorkspaceHeader). */
    leadingInsetClassName?: string | false;
    onSelectSurface: (surface: SidePaneFullViewSurface) => void;
  } | null;
  /** Pane content area (below the tab bar); the full-view conversation host positions against it. */
  fullViewSlotRef?: (element: HTMLDivElement | null) => void;
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  isVisible: boolean;
  sidePaneState: WorkspaceSidePaneState | null;
  recentClosedSidePaneTabs: RecentClosedSidePaneTab[];
  isBrowserOpen: boolean;
  supportsEmbeddedBrowser?: boolean;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId: string | null;
  sidePaneOwnerId: string | null;
  gitState: ReturnType<typeof import("@/hooks/useGitRepository.js").useGitRepository>;
  gitRepositoryWorkspacePath: string;
  activeGitSourceId: GitChangeSourceId;
  panelRef: RefObject<PanelImperativeHandle | null>;
  panelElementRef: RefObject<HTMLDivElement | null>;
  browserNavigationRequest: BrowserNavigationRequest | null;
  browserRestoreUrls: Record<string, string>;
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  screenshotSurfaceTabId?: string | null;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  onCloseCodeViewer: () => void;
  onCloseGit: () => void;
  onActivateTab: (tabId: string) => void;
  onOpenNewTab: () => void;
  /** Opens a pane tab from the "plugins" group; the group is not rendered by default (web / no host). */
  onReorderTab: (activeTabId: string, overTabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  onReopenClosedTab: (tabId: string) => void;
  onOpenBrowserTab: () => void;
  onOpenBrowserPermissionSettings?: (origin: string) => void;
  onOpenWhiteboard: () => void;
  onOpenDeveloperTools: () => void;
  onOpenFileManager: (target?: FileManagerTarget) => void;
  onNavigateFileManager: (tabId: string, source: CodeViewerSource) => void;
  onOpenPluginMarket?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenTerminalTab: () => void;
  onOpenReviewTab: () => void;
  /** Opens the model trajectory tab for the active task; launcher entry is hidden without one. */
  onOpenModelTrajectory: () => void;
  /** Opens the model trajectory v2 tab for the active task; launcher entry is hidden without one. */
  onOpenModelTrajectoryV2: () => void;
  onOpenSelectionSideConversation: () => void;
  onOpenPlanDetail: (request: OpenScopedPlanDetailSideTabRequest) => void;
  onRevealGitFileInTree?: (path: string) => void;
  onOpenBrowserUrl: (url: string) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  onOpenSubagentDirectory: (request: OpenScopedSubagentDirectorySideTabRequest) => void;
  onSyncSubagentSessionTabs: (request: SyncSubagentSessionTabsRequest) => void;
  /** Clicking an ask node on the run detail page → open that actor instance's transcript tab. */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** Clicking a script line on the run detail page → open that run's script transcript tab at that step. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  /** Clicking an artifact card on the run detail page → open that artifact's full-size viewer tab. */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** Clicking a row on the run directory page → open that run's detail-page tab (directory → detail is why this page exists). */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onRefreshGit: () => void;
  onBrowserNavigationRequestHandled: (requestId: string) => void;
  onBrowserUrlChange: (tabId: string, url: string) => void;
  onBrowserPageMetadataChange: (tabId: string, metadata: BrowserSidePaneMetadata) => void;
  onSelectGitSource: (value: GitChangeSourceId) => void;
  mobileOverlay?: boolean;
  mobileStacked?: boolean;
}) {
  const onOpenPluginUi = useOpenPluginUi();
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const developerToolsEnabled = useDeveloperToolsVisibility();
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const isDragCollapsible = !isVisible;
  const isResizeDisabled = !isVisible;
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const gitConversationScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: workspaceAbsPath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
    }),
    [workspaceAbsPath, workspaceIdentity, workspaceRemoteSessionId],
  );
  const composerClientNamespace = useComposerClientNamespace();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.draftProjectId,
  );
  const draftScopeKey = composerScopeKey(
    resolveComposerScope(draftProjectId, workspaceIdentity, composerClientNamespace),
  );
  const tabs = sidePaneState?.tabs ?? EMPTY_SIDE_PANE_TABS;
  const screenshotSurfaceRequest = screenshotSurfaceRequestProp;
  const isScreenshotSurfaceActive = Boolean(screenshotSurfaceRequest);
  const screenshotSurfaceTab = screenshotSurfaceTabId
    ? tabs.find((tab) => tab.id === screenshotSurfaceTabId)
    : screenshotSurfaceRequest
      ? findScreenshotSurfaceTabForRender(tabs, screenshotSurfaceRequest)
      : undefined;
  const visibleTabs = useMemo(
    () =>
      getVisibleSidePaneTabs(tabs, {
        workspaceKey,
        ownerTaskId: sidePaneOwnerId,
      }),
    [sidePaneOwnerId, tabs, workspaceKey],
  );
  const activeTabId = sidePaneState?.activeTabId ?? "";
  const visibleActiveTabId = visibleTabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : (visibleTabs.at(-1)?.id ?? "");
  // When full view switches to the conversation tab, all pane content counts as deselected: the conversation host covers the content area and webviews / terminals no longer consider themselves visible.
  const contentActiveTabId = fullView?.surface === "conversation" ? "" : visibleActiveTabId;
  // Pane tab triggers prevent default on pointerdown, so Radix never sees the mousedown and
  // onValueChange does not fire; every entry that activates a pane tab must go through here to
  // switch full view back to the pane surface.
  const activateSidePaneTab = (tabId: string) => {
    fullView?.onSelectSurface("side-pane");
    onActivateTab(tabId);
  };
  const [marketReturnTarget, setMarketReturnTarget] = useState<{
    workspaceKey: string;
    ownerId: string | null;
    tabId: string;
  } | null>(null);
  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.type === "plugin-market")) {
      setMarketReturnTarget(null);
    }
  }, [visibleTabs]);
  const hasVisibleTabs = visibleTabs.length > 0;
  const tabsScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tabsScrollContentRef = useRef<HTMLDivElement | null>(null);
  const [lockedContentWidthPx, setLockedContentWidthPx] = useState<number | null>(null);
  const shouldMountContent = shouldMountSidePaneContent(isVisible, tabs);
  const [hasRenderedSidePane, setHasRenderedSidePane] = useState(shouldMountContent);
  const [isTabsOverflowing, setIsTabsOverflowing] = useState(false);
  const [tabsScrollMaskEdges, setTabsScrollMaskEdges] = useState<TabsScrollMaskEdges>({
    left: false,
    right: false,
  });
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const sidePaneVisibleInlineSizePx = useViewportInlineIntersectionSize(
    panelElementRef,
    hasRenderedSidePane,
  );
  const isWindowResizeSettling = useWindowResizeSettling(hasRenderedSidePane);
  const widthUnlockTimerRef = useRef<number | null>(null);
  const previousIsVisibleRef = useRef(isVisible);
  const panelLayout = resolveAnimatedSidePanePanelLayout({ mobileOverlay });
  const hasReviewTab = visibleTabs.some((tab) => tab.type === "git");
  const canOpenSelectionSideConversation = shouldOfferSelectionSideConversation({
    activeTaskId,
    isMobileTextInputViewport,
    mobileOverlay,
  });
  // The Sites pane is a session-scoped UI plugin that needs a real session like the side conversation; remote workspaces do not support plugin panes.
  const canOpenSites =
    canOpenSelectionSideConversation &&
    !workspaceRemoteSessionId &&
    !isRemoteWorkspaceIdentity(workspaceIdentity ?? "");
  const sitesPluginUi = useMarketPluginUi({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: workspaceRemoteSessionId ?? null,
    sessionId: activeTaskId,
  });
  const tabDragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
  );

  const handleTabDragStart = (event: DragStartEvent) => {
    setDraggingTabId(String(event.active.id));
  };

  const handleTabDragEnd = (event: DragEndEvent) => {
    setDraggingTabId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    onReorderTab(String(active.id), String(over.id));
  };

  const handleTabDragCancel = () => {
    setDraggingTabId(null);
  };

  const readInitialExpandedContentWidthPx = () => {
    const panelElement = panelElementRef.current;
    const panelGroupElement = panelElement?.parentElement;
    const panelGroupWidthPx = Math.round(panelGroupElement?.getBoundingClientRect().width ?? 0);

    if (!Number.isFinite(panelGroupWidthPx) || panelGroupWidthPx <= 0) {
      return null;
    }

    return Math.round(panelGroupWidthPx * SIDE_PANE_DEFAULT_EXPANDED_RATIO);
  };

  useEffect(() => {
    if (shouldMountContent) {
      // The side pane collapse animation relies on the outer panel's opacity/flex-grow
      // transition, but the content used to be written as
      // `isVisible && sidePaneState ? ... : null` — collapsing unmounted the whole
      // Tabs/Git/Browser block first, so the content vanished mid-animation. Now content stays
      // mounted after first open and later collapses only hide without unmounting, preserving
      // both the animation and internal state.
      setHasRenderedSidePane(true);
    }
  }, [shouldMountContent]);

  useEffect(() => {
    const previousIsVisible = previousIsVisibleRef.current;
    previousIsVisibleRef.current = isVisible;

    if (widthUnlockTimerRef.current !== null) {
      window.clearTimeout(widthUnlockTimerRef.current);
      widthUnlockTimerRef.current = null;
    }

    if (previousIsVisible && !isVisible) {
      const currentPanelWidthPx = Math.round(
        panelElementRef.current?.getBoundingClientRect().width ?? 0,
      );
      // On collapse the content layer joins the outer panel's transition; lock the current
      // pixel width before collapsing so the inner Tabs/Git/Browser do not reflow and then fade.
      setLockedContentWidthPx(currentPanelWidthPx > 0 ? currentPanelWidthPx : null);
      return;
    }

    if (!previousIsVisible && isVisible) {
      // The first expansion has no "width before last collapse" to reuse, so content would lay
      // out at 0 width and then get stretched. Derive the default expanded width from the
      // PanelGroup's real pixel width and lock the content layer near its final size first;
      // after the 200ms transition, drop the fixed width and restore normal adaptive layout.
      setLockedContentWidthPx(
        (currentWidthPx) => currentWidthPx ?? readInitialExpandedContentWidthPx(),
      );
      widthUnlockTimerRef.current = window.setTimeout(() => {
        setLockedContentWidthPx(null);
        widthUnlockTimerRef.current = null;
      }, SIDE_PANE_CONTENT_WIDTH_LOCK_DURATION_MS);
    }
  }, [isVisible, panelElementRef]);

  useEffect(() => {
    return () => {
      if (widthUnlockTimerRef.current !== null) {
        window.clearTimeout(widthUnlockTimerRef.current);
      }
    };
  }, []);

  const lockedContentStyle: CSSProperties | undefined =
    lockedContentWidthPx !== null
      ? {
          width: `${lockedContentWidthPx}px`,
        }
      : undefined;

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    if (!viewport || !content) {
      setIsTabsOverflowing(false);
      // Refs stay null while sidePaneState is empty or content is not yet mounted.
      // Do not write a new mask object each time, or the effect re-fires updates during the empty-tabs phase.
      setTabsScrollMaskEdges((current) =>
        current.left || current.right ? EMPTY_TABS_SCROLL_MASK_EDGES : current,
      );
      return;
    }

    const updateOverflowState = () => {
      const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const addButton = viewport.parentElement?.querySelector<HTMLElement>(
        "[data-side-pane-add-tab-trigger]",
      );
      const addButtonWidth = addButton?.getBoundingClientRect().width ?? 0;
      // The old check read content.scrollWidth directly, but the overflow state itself moves
      // the add button in/out of content and changes the viewport width, forming a
      // ResizeObserver feedback loop at the boundary. Restore the hypothetical "add button at
      // the end of the tabs" layout and decide with a stable minimum-width budget only.
      const isOverflowing = resolveSidePaneTabsOverflow({
        addButtonInside: Boolean(addButton && content.contains(addButton)),
        addButtonWidth,
        tabCount: visibleTabs.length,
        viewportWidth: viewport.clientWidth,
      });
      // The add button trails the tabs while they can still shrink evenly; it pins to the right only after they hit the 60px floor and still overflow.
      setIsTabsOverflowing(isOverflowing);
      // With overflowing tabs, both gradient masks cannot stay on: at the start/end of the
      // scroll range it would still look scrollable. Bind the mask to the actual scrollLeft and
      // hint only the side that can still scroll.
      setTabsScrollMaskEdges((current) => {
        const next = {
          left: isOverflowing && viewport.scrollLeft > 1,
          right: isOverflowing && viewport.scrollLeft < maxScrollLeft - 1,
        };

        if (current.left === next.left && current.right === next.right) {
          return current;
        }

        return next;
      });
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateOverflowState;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateOverflowState();
    viewport.addEventListener("scroll", updateOverflowState, {
      passive: true,
    });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateOverflowState);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateOverflowState;
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", updateOverflowState);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [visibleTabs]);

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    if (!visibleActiveTabId || !viewport || !content) {
      return;
    }

    let frameId: number | null = requestAnimationFrame(() => {
      frameId = null;
      const activeTab = Array.from(
        content.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
      ).find((element) => element.dataset.sidePaneTabId === visibleActiveTabId);

      if (!activeTab) {
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const activeTabRect = activeTab.getBoundingClientRect();
      const leftOverflow = activeTabRect.left - viewportRect.left;
      const rightOverflow = activeTabRect.right - viewportRect.right;

      if (leftOverflow < 0) {
        // When a tab is activated externally (e.g. opening a file or switching back to an old
        // Browser), the active tab may already be hidden by the horizontal scroll area. Scroll
        // it back into view using real DOM widths; fixed-width estimates misalign long-title /
        // favicon tabs.
        viewport.scrollBy({ left: leftOverflow, behavior: "smooth" });
        return;
      }

      if (rightOverflow > 0) {
        viewport.scrollBy({ left: rightOverflow, behavior: "smooth" });
      }
    });

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [visibleActiveTabId, visibleTabs]);

  const addTabButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-md"
      className="shrink-0"
      data-side-pane-add-trigger
      data-side-pane-add-tab-trigger=""
      aria-label={intl.formatMessage({ id: "sidePane.addTab" })}
      onClick={() => {
        fullView?.onSelectSurface("side-pane");
        onOpenNewTab();
      }}
    >
      <PlusIcon className="size-4" />
    </Button>
  );
  const openTabLauncherItemById: Record<OpenTabLauncherItemId, OpenTabLauncherItem> = {
    sites: {
      id: "sites",
      label: intl.formatMessage({ id: "sidePane.sites" }),
      description: intl.formatMessage({ id: "sidePane.launcher.sites" }),
      icon: EarthIcon,
      onOpen: () => void sitesPluginUi.open(SITES_PLUGIN_ID),
    },
    "selection-side-conversation": {
      id: "selection-side-conversation",
      label: intl.formatMessage({ id: "sidePane.selectionChat" }),
      description: intl.formatMessage({ id: "sidePane.launcher.selection-side-conversation" }),
      icon: MessageSquareTextIcon,
      onOpen: onOpenSelectionSideConversation,
    },
    files: {
      id: "files",
      label: intl.formatMessage({ id: "fileManager.title" }),
      description: intl.formatMessage({ id: "fileManager.empty" }),
      icon: FolderOpenIcon,
      onOpen: () => onOpenFileManager(),
    },
    review: {
      id: "review",
      label: intl.formatMessage({ id: "sidePane.review" }),
      description: intl.formatMessage({ id: "sidePane.launcher.review" }),
      icon: FileDiffIcon,
      onOpen: onOpenReviewTab,
    },
    terminal: {
      id: "terminal",
      label: intl.formatMessage({ id: "terminal.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.terminal" }),
      icon: SquareTerminalIcon,
      onOpen: onOpenTerminalTab,
    },
    browser: {
      id: "browser",
      label: intl.formatMessage({ id: "browser.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.browser" }),
      icon: GlobeIcon,
      onOpen: onOpenBrowserTab,
    },
    "model-trajectory": {
      id: "model-trajectory",
      label: intl.formatMessage({ id: "modelTrajectory.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.model-trajectory" }),
      icon: ChartLineIcon,
      onOpen: onOpenModelTrajectory,
    },
    "model-trajectory-v2": {
      id: "model-trajectory-v2",
      label: intl.formatMessage({ id: "modelTrajectoryV2.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.model-trajectory-v2" }),
      icon: ChartNoAxesGanttIcon,
      onOpen: onOpenModelTrajectoryV2,
    },
    "developer-tools": {
      id: "developer-tools",
      label: intl.formatMessage({ id: "developerTools.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.developer-tools" }),
      icon: BugIcon,
      onOpen: onOpenDeveloperTools,
    },
  };
  const openTabLauncherItems: OpenTabLauncherItem[] = resolveOpenTabLauncherItemIds({
    canOpenSelectionSideConversation,
    canOpenSites,
    developerToolsEnabled,
    hasActiveTask: activeTaskId !== null,
    hasReviewTab,
    supportsEmbeddedBrowser,
  })
    .filter((itemId) => !isOfficeMode || (itemId !== "terminal" && itemId !== "review"))
    .map((itemId) => openTabLauncherItemById[itemId]);
  const closeSidePaneButton =
    isVisible && !mobileOverlay && onCloseSidePane ? (
      <div className="flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
        {fullViewToggle ? (
          <SidePaneFullViewToggleButton
            active={fullViewToggle.active}
            onToggle={fullViewToggle.onToggle}
            shortcutLabel={fullViewToggle.shortcutLabel}
          />
        ) : null}
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen
          onToggleSidePane={onCloseSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
        />
        {showWindowControls ? <DesktopWindowControls /> : null}
      </div>
    ) : null;
  const openTabLauncher = (
    <div className="side-pane-open-tab-shell @container/launcher flex h-full min-h-0 flex-col bg-background">
      {/* 对齐原型：顶部对齐滚动、左对齐标题；内置应用与 UI 插件同为横向行，短分割线分区。 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <h2 className="pl-2 text-ui-xl font-semibold text-foreground">
            {intl.formatMessage({ id: "sidePane.openTab" })}
          </h2>
          <div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">
            {openTabLauncherItems.map((item) => (
              <SidePaneLauncherRow
                key={item.id}
                itemId={item.id}
                icon={item.icon}
                label={item.label}
                description={item.description}
                onOpen={item.onOpen}
              />
            ))}
          </div>
          {/* 空会话暂不支持应用插件，连同分区入口一起隐藏。 */}
          {activeTaskId ? (
            <>
              <div aria-hidden="true" className="my-4 h-px w-24 self-center bg-border" />
              <section className="min-w-0" data-testid="side-pane-ui-recommendations">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                  <h2 className="pl-2 text-ui-lg font-semibold text-foreground">
                    {intl.formatMessage({ id: "settings.plugins.store.ui.title" })}
                  </h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-foreground-subtle"
                    data-testid="side-pane-plugin-market"
                    onClick={() => {
                      if (!onOpenPluginMarket) return;
                      setMarketReturnTarget({
                        workspaceKey,
                        ownerId: sidePaneOwnerId ?? null,
                        tabId: visibleActiveTabId,
                      });
                      onOpenPluginMarket();
                    }}
                  >
                    {intl.formatMessage({ id: "sidePane.launcher.viewAllPlugins" })}
                    <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                <div className="mt-2 grid min-w-0 grid-cols-1 gap-x-8 gap-y-1 @min-[36rem]/launcher:grid-cols-2">
                  {onOpenPluginUi ? (
                    <PluginUiLauncherItems
                      workspacePath={workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      remoteSessionId={workspaceRemoteSessionId}
                      sessionId={activeTaskId}
                      onOpenPluginUi={onOpenPluginUi}
                    />
                  ) : null}
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
  const sidePaneTabOverview = (
    <SidePaneTabOverview
      tabs={visibleTabs}
      activeTabId={visibleActiveTabId}
      recentClosedTabs={recentClosedSidePaneTabs}
      labels={{
        title: intl.formatMessage({ id: "sidePane.tabOverview" }),
        searchPlaceholder: intl.formatMessage({
          id: "sidePane.searchTabs",
        }),
        openTabs: intl.formatMessage({ id: "sidePane.openTabs" }),
        recentlyClosedTabs: intl.formatMessage({
          id: "sidePane.recentlyClosedTabs",
        }),
        noResults: intl.formatMessage({ id: "sidePane.noTabsFound" }),
        closeTab: (title) => intl.formatMessage({ id: "sidePane.closeTab" }, { title }),
        relativeTime: (timestamp) => formatTaskRelativeTime(timestamp, intl),
        browserTitle: intl.formatMessage({ id: "browser.title" }),
        reviewTitle: intl.formatMessage({ id: "sidePane.review" }),
        fileManagerTitle: intl.formatMessage({ id: "fileManager.title" }),
        codeViewerTitle: intl.formatMessage({ id: "codeViewer.title" }),
        treemappingTitle: intl.formatMessage({ id: "treemapping.title" }),
        whiteboardTitle: intl.formatMessage({ id: "whiteboard.title" }),
        modelTrajectoryTitle: intl.formatMessage({
          id: "modelTrajectory.title",
        }),
        modelTrajectoryV2Title: intl.formatMessage({
          id: "modelTrajectoryV2.title",
        }),
        newTabTitle: intl.formatMessage({ id: "sidePane.newTab" }),
        pluginMarketTitle: intl.formatMessage({ id: "workspace.openPluginsSettings" }),
        developerToolsTitle: intl.formatMessage({
          id: "developerTools.title",
        }),
        browserPermissionsTitle: intl.formatMessage({
          id: "browser.permission.settings",
        }),
        terminalTitle: intl.formatMessage({ id: "terminal.title" }),
        subagentTypeLabel: intl.formatMessage({ id: "sidePane.subagent" }),
        subagentDirectoryTitle: intl.formatMessage({
          id: "sidePane.subagentDirectory",
        }),
        selectionChatTitle: intl.formatMessage({
          id: "sidePane.selectionChat",
        }),
        planTitle: intl.formatMessage({ id: "planTool.panel.planTab" }),
        workflowRunTitle: intl.formatMessage({ id: "sidePane.workflowRun" }),
        workflowDirectoryTitle: intl.formatMessage({ id: "sidePane.workflowDirectory" }),
        workflowActorTitle: intl.formatMessage({ id: "sidePane.workflowActor" }),
        workflowScriptTitle: intl.formatMessage({ id: "sidePane.workflowScript" }),
        workflowArtifactTitle: intl.formatMessage({ id: "sidePane.workflowArtifact" }),
      }}
      onActivateTab={activateSidePaneTab}
      onCloseTab={onCloseTab}
      onReopenClosedTab={onReopenClosedTab}
    />
  );
  const draggingTab = draggingTabId
    ? (visibleTabs.find((tab) => tab.id === draggingTabId) ?? null)
    : null;

  const panelContent = (
    <div
      aria-hidden={!isVisible}
      data-workspace-side-frame={mobileOverlay ? undefined : "true"}
      className={cn(
        // The standalone outer frame lives in the content layer: closing still keeps the Browser Guest and tab instance, unchanged by pane persistence boundaries.
        "h-full overflow-hidden bg-background",
        !mobileOverlay && frameClassName,
        !mobileOverlay && "border-[0.5px] shadow-xs",
        mobileStacked && "max-md:rounded-none max-md:border-0",
        mobileOverlay && "min-w-0",
        mobileStacked && "max-md:!w-full",
        // Full view: spans the whole row relative to the outer PanelGroup; the library-managed panel width stays unchanged.
        // Fix reason: plugin UI pages live in a fixed dock layer at the end of body (no
        // z-index); the outer frame once used z-10 to paint an opaque background over them and
        // plugin tabs showed blank. Conversation-column content is inside the z-30 host, so the
        // frame needs only z-0 for its own stacking context and sits below the dock layer in DOM order.
        fullView && "absolute inset-0 z-0",
      )}
      style={mobileOverlay || fullView ? undefined : lockedContentStyle}
    >
      <ScopedErrorBoundary
        scope="workspace-side-pane"
        resetKeys={[workspaceKey, visibleActiveTabId]}
        variant="panel"
        className="h-full"
      >
        {hasRenderedSidePane && (sidePaneState || fullView) ? (
          <>
            {/* 收起或切换对话时保留其他对话的内容挂载，避免丢失辅助对话草稿和引用。
                展开后的空标签集合由 useAppPanels 统一补建「新标签页」。 */}
            <div
              className={cn(
                "h-full min-h-0",
                !hasVisibleTabs && !screenshotSurfaceRequest && !fullView && "hidden",
              )}
            >
              <Tabs
                value={
                  fullView?.surface === "conversation"
                    ? SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE
                    : visibleActiveTabId
                }
                onValueChange={(value) => {
                  if (fullView && value === SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE) {
                    fullView.onSelectSurface("conversation");
                    return;
                  }
                  activateSidePaneTab(value);
                }}
                className="relative h-full gap-0"
              >
                <TabsList
                  style={mobileOverlay ? undefined : captionControlsStyle}
                  className={cn(
                    "flex justify-start w-full rounded-none p-0 border-0 border-b border-border/50 bg-transparent shadow-none !h-12 overflow-hidden",
                    fullView?.leadingInsetClassName,
                    // The standalone pane moves the tab bar to the window top and needs extra window-drag area; tabs and buttons still handle their own interactions.
                    isDesktop &&
                      !mobileOverlay &&
                      "[app-region:drag] [&_button]:[app-region:no-drag] [&_[data-side-pane-tab-id]]:[app-region:no-drag]",
                  )}
                >
                  <div className="flex items-center justify-start flex-1 min-w-0">
                    {/* 与 WorkspaceHeader 的 p-2 对齐，避免切换面板后左右操作区跳动。 */}
                    <div className="flex h-full shrink-0 items-center p-2">
                      {sidePaneTabOverview}
                    </div>
                    {fullView ? (
                      <div className="flex h-full shrink-0 items-center pr-1">
                        <SidePaneFullViewConversationTab
                          title={fullView.conversationTitle}
                          isActive={fullView.surface === "conversation"}
                        />
                      </div>
                    ) : null}
                    <DndContext
                      sensors={tabDragSensors}
                      collisionDetection={closestCenter}
                      onDragStart={handleTabDragStart}
                      onDragEnd={handleTabDragEnd}
                      onDragCancel={handleTabDragCancel}
                    >
                      <div
                        ref={tabsScrollViewportRef}
                        data-side-pane-tabs-viewport=""
                        className={cn(
                          "min-w-0 flex-1 overflow-x-auto !scrollbar-hide h-12 items-center",
                          tabsScrollMaskEdges.left &&
                            tabsScrollMaskEdges.right &&
                            "[mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)]",
                          tabsScrollMaskEdges.left &&
                            !tabsScrollMaskEdges.right &&
                            "[mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)]",
                          !tabsScrollMaskEdges.left &&
                            tabsScrollMaskEdges.right &&
                            "[mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)]",
                        )}
                      >
                        {/* tab strip 固定占满滚动 viewport：每个 tab 先从 156px 等宽收缩到
                            60px，只有最小宽度之和仍超出 viewport 时才产生横向滚动。 */}
                        <div
                          ref={tabsScrollContentRef}
                          data-side-pane-tabs-content=""
                          className="flex w-full gap-1 py-2.5"
                        >
                          <SortableContext
                            items={visibleTabs.map((tab) => tab.id)}
                            strategy={horizontalListSortingStrategy}
                          >
                            {visibleTabs.map((tab) => {
                              const title = getSidePaneTabTitle(tab, intl.formatMessage);
                              return (
                                <SortableSidePaneTabTrigger
                                  key={tab.id}
                                  tab={tab}
                                  title={title}
                                  closeTabLabel={intl.formatMessage(
                                    { id: "sidePane.closeTab" },
                                    { title },
                                  )}
                                  closeTabMenuLabel={intl.formatMessage({
                                    id: "sidePane.closeCurrentTab",
                                  })}
                                  closeOtherTabsLabel={intl.formatMessage({
                                    id: "sidePane.closeOtherTabs",
                                  })}
                                  closeAllTabsLabel={intl.formatMessage({
                                    id: "sidePane.closeAllTabs",
                                  })}
                                  diffBadgeLabel={intl.formatMessage({
                                    id: "diff.title",
                                  })}
                                  isActive={tab.id === contentActiveTabId}
                                  onActivateTab={activateSidePaneTab}
                                  onCloseTab={onCloseTab}
                                  onCloseOtherTabs={onCloseOtherTabs}
                                  onCloseAllTabs={onCloseAllTabs}
                                  canCloseOtherTabs={visibleTabs.length > 1}
                                />
                              );
                            })}
                          </SortableContext>
                          {!isTabsOverflowing ? addTabButton : null}
                        </div>
                      </div>
                      <DragOverlay dropAnimation={null}>
                        {draggingTab ? (
                          <SidePaneTabDragOverlay
                            tab={draggingTab}
                            title={getSidePaneTabTitle(draggingTab, intl.formatMessage)}
                            diffBadgeLabel={intl.formatMessage({
                              id: "diff.title",
                            })}
                          />
                        ) : null}
                      </DragOverlay>
                    </DndContext>

                    <div className="ml-auto flex h-full shrink-0 items-center gap-1 px-2">
                      {isTabsOverflowing ? addTabButton : null}
                      {closeSidePaneButton}
                    </div>
                  </div>
                  {/* Expand Panel 按钮按要求先注释保留，相关逻辑已删除。
                <div className="flex h-full shrink-0 items-center pl-1.5 pr-2">
                  <ControlHintTooltip title="" side="bottom" align="end">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="">
                      Expand Panel
                    </Button>
                  </ControlHintTooltip>
                </div>
                */}
                </TabsList>

                <div
                  ref={mobileOverlay ? undefined : fullViewSlotRef}
                  data-side-pane-content-slot=""
                  className={cn("relative min-h-0 flex-1 isolate", mobileOverlay && "min-w-0")}
                >
                  {fullView && !hasVisibleTabs ? (
                    <div className="absolute inset-0 z-10">{openTabLauncher}</div>
                  ) : null}
                  {tabs.map((tab) => {
                    if (
                      (tab.type === "browser" || tab.type === "browser-use") &&
                      !shouldMountBrowserTabGuest(tab)
                    ) {
                      return <SuspendedBrowserSidePaneContent key={tab.id} tab={tab} />;
                    }
                    if (tab.type === "browser-use") {
                      return (
                        <BrowserUseSidePaneContent
                          key={tab.id}
                          tab={tab}
                          onOpenPermissionSettings={onOpenBrowserPermissionSettings}
                          isPanelVisible={isVisible}
                          isSelected={tab.id === contentActiveTabId}
                          isCurrentTask={tab.sessionId === sidePaneOwnerId}
                          screenshotSurfaceRequest={
                            screenshotSurfaceTab?.id === tab.id ? screenshotSurfaceRequest : null
                          }
                          // A restoring guest's full history is written by main after did-attach;
                          // a renderer also consuming initialUrl would commit navigation first and make Chromium refuse the restore.
                          initialUrl={
                            tab.residency === "restoring" ? undefined : browserRestoreUrls[tab.id]
                          }
                          workspacePath={workspaceAbsPath}
                          workspaceIdentity={workspaceIdentity}
                          residencyGeneration={tab.residencyGeneration}
                          onUrlChange={(url) => onBrowserUrlChange(tab.id, url)}
                          onPageMetadataChange={(metadata) =>
                            onBrowserPageMetadataChange(tab.id, metadata)
                          }
                        />
                      );
                    }
                    return (
                      <TabsContent
                        key={tab.id}
                        value={tab.id}
                        forceMount
                        className={cn(
                          "relative z-10 h-full min-h-0 bg-background data-[state=inactive]:hidden",
                          mobileOverlay && "min-w-0",
                        )}
                      >
                        {tab.type === "bash-output" ? (
                          <BackgroundBashOutputSidePane
                            tab={tab}
                            visible={isVisible && tab.id === contentActiveTabId}
                            onOpenCodeViewer={onOpenCodeViewer}
                          />
                        ) : tab.type === "subagent-session" ? (
                          <SubagentSessionSidePane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            compactForRemoteControl={mobileOverlay}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                            onOpenSubagentSession={onOpenSubagentSession}
                            onOpenBackgroundBash={onOpenBackgroundBash}
                          />
                        ) : tab.type === "subagent-directory" ? (
                          <SubagentDirectorySidePane
                            tab={tab}
                            onOpenSubagentSession={onOpenSubagentSession}
                          />
                        ) : tab.type === "selection-side-chat" ? (
                          <SelectionSideChatPane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                            onOpenPlanDetail={onOpenPlanDetail}
                            onOpenSubagentSession={onOpenSubagentSession}
                            onOpenSubagentDirectory={onOpenSubagentDirectory}
                            onSyncSubagentSessionTabs={onSyncSubagentSessionTabs}
                            onOpenBackgroundBash={onOpenBackgroundBash}
                            onUnavailable={onCloseTab}
                          />
                        ) : tab.type === "plugin-ui" ? (
                          <PluginUiSidePane
                            tab={tab}
                            visible={isVisible && tab.id === contentActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onCloseTab={onCloseTab}
                          />
                        ) : tab.type === "plan-detail" ? (
                          <PlanDetailSidePane
                            tab={tab}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                          />
                        ) : tab.type === "workflow-run" ? (
                          <WorkflowRunSidePane
                            tab={tab}
                            {...(onOpenWorkflowActorSession === undefined
                              ? {}
                              : { onOpenWorkflowActorSession })}
                            {...(onOpenWorkflowArtifact === undefined
                              ? {}
                              : { onOpenWorkflowArtifact })}
                            {...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun })}
                            {...(onOpenWorkflowWorkspace === undefined
                              ? {}
                              : { onOpenWorkflowWorkspace })}
                          />
                        ) : tab.type === "workflow-directory" ? (
                          // Narrow the type in its own branch and handle a missing callback
                          // **inside the branch**: folding `&& onOpenWorkflowRun` into the
                          // condition keeps this tab type in the union of later branches (the
                          // browser branch then reads residency off it).
                          onOpenWorkflowRun ? (
                            <WorkflowRunDirectorySidePane
                              tab={tab}
                              onOpenWorkflowRun={onOpenWorkflowRun}
                            />
                          ) : null
                        ) : tab.type === "workflow-actor-session" ? (
                          <WorkflowActorSessionSidePane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                          />
                        ) : tab.type === "workflow-workspace" ? (
                          <WorkflowWorkspaceSidePane
                            tab={tab}
                            focused={isVisible && tab.id === contentActiveTabId}
                            onOpenCodeViewer={onOpenCodeViewer}
                          />
                        ) : tab.type === "workflow-artifact" ? (
                          // "Show in workspace" reuses the Git pane's file-tree reveal (same host
                          // callback); no second locating path is created.
                          <WorkflowArtifactSidePane
                            tab={tab}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            {...(onRevealGitFileInTree === undefined
                              ? {}
                              : { onRevealFileInTree: onRevealGitFileInTree })}
                          />
                        ) : tab.type === "code-viewer" || tab.type === "file-manager" ? (
                          <FileManagerPane
                            markdownSelectionTarget={{
                              sessionId: activeTaskId,
                              workspaceKey,
                              draftScopeKey,
                            }}
                            source={tab.source}
                            target={
                              tab.type === "file-manager"
                                ? tab.target
                                : {
                                    workspacePath: tab.source.workspacePath ?? workspaceAbsPath,
                                    workspaceIdentity: tab.source.workspacePath
                                      ? tab.source.workspaceIdentity
                                      : workspaceIdentity,
                                    workspaceRemoteSessionId: tab.source.workspacePath
                                      ? tab.source.workspaceRemoteSessionId
                                      : workspaceRemoteSessionId,
                                  }
                            }
                            mobileOverlay={mobileOverlay}
                            canOpenLocalFileManager={Boolean(isDesktop)}
                            onNavigate={(source) => onNavigateFileManager(tab.id, source)}
                            onClose={() => onCloseTab(tab.id)}
                            workspacePath={workspaceAbsPath}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            // An inactive/narrow/resizing code preview should not keep
                            // @pierre/diffs's thousand-line Shadow DOM in layout; clip the body only, keeping tab/source/file state.
                            renderHeavyContent={shouldRenderPreviewPaneHeavyContent({
                              isActiveTab: tab.id === contentActiveTabId,
                              // Native video/audio fullscreen triggers a resize; the current
                              // media node must stay mounted during resize settling or the
                              // browser exits fullscreen immediately.
                              isMediaPreview:
                                tab.source?.type === "media" ||
                                (tab.source?.type === "file" &&
                                  inferMediaPreview(tab.source.path) !== null),
                              isMobileOverlay: mobileOverlay,
                              isResizeSettling: isWindowResizeSettling,
                              isSidePaneVisible: isVisible,
                              visibleInlineSizePx: sidePaneVisibleInlineSizePx,
                            })}
                          />
                        ) : tab.type === "git" ? (
                          <GitPaneWithLastTurn
                            sessionId={activeTaskId}
                            conversationScope={gitConversationScope}
                            workspacePath={gitRepositoryWorkspacePath}
                            workspaceIdentity={workspaceIdentity}
                            workspaceRemoteSessionId={workspaceRemoteSessionId}
                            gitState={gitState}
                            isDesktop={isDesktop}
                            selectedSourceId={activeGitSourceId}
                            fileChangeFindActiveIndex={fileChangeFindActiveIndex}
                            fileChangeFindNavigationRequestId={fileChangeFindNavigationRequestId}
                            fileChangeFindQuery={fileChangeFindQuery}
                            onFileChangeFindMatchCountChange={onFileChangeFindMatchCountChange}
                            onSelectSource={onSelectGitSource}
                            onClose={onCloseGit}
                            onRefresh={onRefreshGit}
                            onRevealFileInTree={onRevealGitFileInTree}
                          />
                        ) : tab.type === "treemapping" ? (
                          <TreemappingPane
                            activeTaskId={activeTaskId}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            source={tab.source ?? { kind: "current" }}
                          />
                        ) : tab.type === "whiteboard" ? (
                          <WhiteboardPane
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            boardId={tab.boardId}
                          />
                        ) : tab.type === "model-trajectory" ? (
                          <ModelTrajectoryPane
                            taskId={tab.taskId}
                            title={tab.title}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            onClose={() => onCloseTab(tab.id)}
                          />
                        ) : tab.type === "model-trajectory-v2" ? (
                          <ModelTrajectoryV2Pane
                            taskId={tab.taskId}
                            title={tab.title}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            onClose={() => onCloseTab(tab.id)}
                          />
                        ) : tab.type === "new-tab" ? (
                          openTabLauncher
                        ) : tab.type === "plugin-market" ? (
                          <ServiceProvider services={services}>
                            <div className="h-full min-w-0 overflow-y-auto p-4">
                              <PluginStorePage
                                onBack={
                                  marketReturnTarget?.workspaceKey === workspaceKey &&
                                  marketReturnTarget.ownerId === (sidePaneOwnerId ?? null)
                                    ? () => {
                                        const targetId = marketReturnTarget.tabId;
                                        setMarketReturnTarget(null);
                                        onCloseTab(tab.id);
                                        if (visibleTabs.some((item) => item.id === targetId)) {
                                          onActivateTab(targetId);
                                        } else {
                                          onOpenNewTab();
                                        }
                                      }
                                    : undefined
                                }
                                embedded
                                onCreateTask={onCreateTask}
                                workspacePath={workspaceAbsPath}
                                workspaceIdentity={workspaceIdentity}
                                remoteSessionId={workspaceRemoteSessionId}
                                sessionId={activeTaskId}
                                isDesktop={isDesktop}
                                isWindowsDesktop={isWindowsDesktop}
                                isMacDesktop={isMacDesktop}
                                isWebRemoteControl={mobileOverlay}
                              />
                            </div>
                          </ServiceProvider>
                        ) : tab.type === "developer-tools" ? (
                          <ServiceProvider services={services}>
                            <DeveloperToolsPane
                              workspacePath={workspaceAbsPath}
                              workspaceIdentity={workspaceIdentity}
                              taskId={activeTaskId}
                              enabled={isVisible && tab.id === contentActiveTabId}
                            />
                          </ServiceProvider>
                        ) : tab.type === "terminal" ? (
                          <SidePaneTerminalPane
                            services={services}
                            sessionId={tab.id}
                            workspaceKey={workspaceKey}
                            cwd={tab.cwd ?? workspaceAbsPath}
                            isVisible={isVisible && tab.id === contentActiveTabId}
                            isWindowsDesktop={isWindowsDesktop}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                          />
                        ) : tab.type === "browser-permissions" ? (
                          <BrowserSitePermissionsPage
                            origin={tab.origin}
                            isVisible={isVisible && tab.id === contentActiveTabId}
                          />
                        ) : (
                          <HumanBrowserView
                            browserKey={tab.id}
                            onOpenPermissionSettings={onOpenBrowserPermissionSettings}
                            agentOpened={tab.agentOpened}
                            deferEmptyGuest
                            isResidencyRestore={tab.residency === "restoring"}
                            isVisible={isVisible && isBrowserOpen && tab.id === contentActiveTabId}
                            isSelected={tab.id === contentActiveTabId}
                            isCurrentTask={tab.ownerTaskId === sidePaneOwnerId}
                            // restoring only mounts the bootstrap URL without committing a document;
                            // main owns the pageState/URL restore transaction exclusively.
                            initialUrl={
                              tab.residency === "restoring"
                                ? undefined
                                : (browserRestoreUrls[tab.id] ?? tab.initialUrl)
                            }
                            faviconUrl={tab.faviconUrl}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
                            // In the commit that switches workspaces, props are already the new
                            // workspace while tabs are still old; reading the current workspace
                            // attaches with the wrong scope and triggers workspace-mismatch.
                            workspaceKey={tab.workspaceKey ?? workspaceKey}
                            remoteSessionId={tab.remoteSessionId ?? workspaceRemoteSessionId}
                            residencyGeneration={tab.residencyGeneration}
                            sessionId={tab.ownerTaskId ?? "unscoped"}
                            onUrlChange={(url) => onBrowserUrlChange(tab.id, url)}
                            onPageMetadataChange={(metadata) =>
                              onBrowserPageMetadataChange(tab.id, metadata)
                            }
                            navigationRequest={
                              browserNavigationRequest?.targetTabId === tab.id
                                ? {
                                    id: browserNavigationRequest.id,
                                    url: browserNavigationRequest.url,
                                  }
                                : null
                            }
                            onNavigationRequestHandled={onBrowserNavigationRequestHandled}
                          />
                        )}
                      </TabsContent>
                    );
                  })}
                </div>
              </Tabs>
            </div>
          </>
        ) : null}
      </ScopedErrorBoundary>
    </div>
  );

  if (!panelLayout.useResizablePanel) {
    return (
      <>
        {/* Bugfix: 手机远控侧栏是覆盖聊天区的抽屉，不在 ResizablePanelGroup 的布局上下文里。
            如果继续渲染 ResizablePanel，外层 auto 宽度会把子级 100% 宽度链路解析成 0px，
            diff / preview 内容就会挂载但不可见；这里改用普通满宽容器承接内容。 */}
        <div
          ref={panelElementRef}
          aria-hidden={!isVisible}
          className={cn(
            "h-full w-full min-w-0 border-l border-border bg-background transition-opacity duration-200 ease-out",
            isVisible || isScreenshotSurfaceActive
              ? "opacity-100"
              : "pointer-events-none opacity-0",
          )}
        >
          {panelContent}
        </div>
      </>
    );
  }

  return (
    <>
      {isVisible && !fullView ? (
        <ResizableHandle
          data-workspace-side-pane-resize-handle="true"
          className={cn(
            WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
            "aria-[orientation=vertical]:w-[3px] after:left-px",
            mobileStacked && "max-md:hidden",
          )}
        />
      ) : null}
      <ResizablePanel
        id="browser"
        panelRef={panelRef}
        elementRef={panelElementRef}
        defaultSize={panelLayout.defaultSize}
        minSize={panelLayout.minSize}
        maxSize={panelLayout.maxSize}
        collapsedSize={panelLayout.collapsedSize}
        // With the right pane permanently declared collapsible, dragging to minimum width is
        // judged a collapse by the library. Allow collapsing only on explicit close so the pane
        // does not auto-collapse when the user merely drags it to minimum width.
        collapsible={isDragCollapsible}
        // With the preview/side pane collapsed there is no ResizableHandle, yet the library
        // still exposes the collapsed panel's edge drag zone. Disable the resize target after
        // collapse so the user cannot drag the pane out from the right edge, bypassing the
        // explicit toggle.
        disabled={isResizeDisabled}
        className={cn(
          "!overflow-hidden transition-opacity duration-200 ease-out",
          mobileOverlay &&
            "max-md:!h-full max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-1 max-md:!basis-auto max-md:border-l",
          mobileStacked &&
            !mobileOverlay &&
            "max-md:!h-[min(45dvh,24rem)] max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-l-0 max-md:border-t",
          // During screenshots the panel keeps opacity=1: opacity=0 would make Chromium drop
          // the guest compositor surface; the real browser surface is already fixed to a
          // low-opacity compositing layer inside the window and cannot reveal the tab bar.
          isVisible || isScreenshotSurfaceActive ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {panelContent}
      </ResizablePanel>
    </>
  );
}
