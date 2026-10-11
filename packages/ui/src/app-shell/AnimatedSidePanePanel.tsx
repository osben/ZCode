/* eslint-disable max-lines -- The side pane currently hosts tabs plus browser/Git/code-viewer content; a full extraction should follow the pane feature boundaries. */
import { ServiceProvider } from "@/hooks/useServices.js";
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
import type { BrowserViewScreenshotSurfacePreparePayload, GitChangeSourceId } from "@zcode/shared";
import { PreviewPane } from "@/PreviewPane.js";
import { SidePaneTerminalPane } from "@/SidePaneTerminalPane.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { BrowserUseSidePaneContent } from "@/browser-use/BrowserUseSidePaneContent.js";
import { BrowserSitePermissionsPage } from "@/browser-use/BrowserSitePermissionsPage.js";
import { findScreenshotSurfaceTabForRender } from "@/browser-use/useBrowserScreenshotSurfaceRequest.js";
import { HumanBrowserView } from "@/browser-use/HumanBrowserView.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { GitPane } from "@/GitPane.js";
import { TreemappingPane } from "@/TreemappingPane.js";
import { WhiteboardPane } from "@/WhiteboardPane.js";
import { ModelTrajectoryPane } from "@/ModelTrajectoryPane.js";
import { DeveloperToolsPane } from "@/DeveloperToolsPane.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable.js";
import { Tabs, TabsContent, TabsList } from "@/components/ui/tabs.js";
import { SidePaneTabOverview } from "@/app-shell/SidePaneTabOverview.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import { SubagentDirectorySidePane } from "@/app-shell/SubagentDirectorySidePane.js";
import { SelectionSideChatPane } from "@/app-shell/SelectionSideChatPane.js";
import { BackgroundBashOutputSidePane } from "@/app-shell/BackgroundBashOutputSidePane.js";
import { PlanDetailSidePane } from "@/app-shell/PlanDetailSidePane.js";
import { PluginUiLauncherItems, PluginUiSidePane, useOpenPluginUi } from "@/plugin-ui/index.js";
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
  FileDiffIcon,
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
const OPEN_TAB_LAUNCHER_BUTTON_CLASS =
  "side-pane-open-tab-button flex h-12 min-w-0 items-center gap-3 rounded-xl bg-surface px-3 text-ui-base font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type OpenTabLauncherItem = {
  id: OpenTabLauncherItemId;
  label: string;
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
    // React effects run after the old UnifiedBrowserView has committed its unmount; acknowledge here so main can safely
    // close the corresponding guest WebContents and avoid treating suspend as a crash via render-process-gone, which would immediately recreate it.
    // Info-level instrumentation: swapping the shell first unmounts <webview>; if CDP remains attached at that moment,
    // it opens a main-process use-after-free window. This log aligns the swap time with UnifiedBrowserView’s
    // unmount instrumentation to identify what destroyed the guest.
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
      // During window resize, the thousands of lines of Shadow DOM in a large-file PreviewPane participate in
      // React commit and layout every frame. Treat resize as a temporary unstable phase and restore the heavyweight content after dimensions stop changing.
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
  onCloseCodeViewer,
  onCloseGit,
  onActivateTab,
  onReorderTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onReopenClosedTab,
  onOpenBrowserTab,
  onOpenBrowserPermissionSettings,
  onOpenWhiteboard: _onOpenWhiteboard,
  onOpenDeveloperTools,
  onOpenTerminalTab,
  onOpenReviewTab,
  onOpenSelectionSideConversation,
  onRevealGitFileInTree,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenSubagentSession,
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
  mobileOverlay = false,
  mobileStacked = false,
}: {
  services: IServiceAccessor;
  frameClassName?: string;
  captionControlsStyle?: CSSProperties;
  showWindowControls?: boolean;
  onCloseSidePane?: () => void;
  toggleSidePaneShortcutLabel?: string;
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
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
  /** Opens a panel tab from the "Plugin" group; the group is not rendered by default (web/no host). */
  onReorderTab: (activeTabId: string, overTabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  onReopenClosedTab: (tabId: string) => void;
  onOpenBrowserTab: () => void;
  onOpenBrowserPermissionSettings?: (origin: string) => void;
  onOpenWhiteboard: () => void;
  onOpenDeveloperTools: () => void;
  onOpenTerminalTab: () => void;
  onOpenReviewTab: () => void;
  onOpenSelectionSideConversation: () => void;
  onRevealGitFileInTree?: (path: string) => void;
  onOpenBrowserUrl: (url: string) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  /** In the run details page, clicking an ask node opens the transcript tab for that actor instance. */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** In the run details page, clicking a script row opens that run’s script transcript tab at the corresponding station. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  /** In the run details page, clicking an artifact card opens its full-size viewer tab. */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** In the run directory page, clicking a row opens that run’s detail tab (directory → details is the purpose of this page). */
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
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);
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
      // The side pane’s collapsed animation previously depended on opacity/flex-grow transitions on the outer panel,
      // but this code used `isVisible && sidePaneState ? ... : null`,
      // which immediately unmounted the entire Tabs/Git/Browser content when closing, before the animation finished.
      // Keep it mounted after the first open; later collapses only hide it, preserving both the animation and internal state.
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
      // When collapsing the side pane, the content layer also participates in the outer panel transition.
      // Lock its current pixel width before collapse so Tabs/Git/Browser do not reflow before fading out.
      setLockedContentWidthPx(currentPanelWidthPx > 0 ? currentPanelWidthPx : null);
      return;
    }

    if (!previousIsVisible && isVisible) {
      // On the first expansion there is no previous collapsed width to reuse, so the content first participates at 0 width before expanding.
      // Convert the actual PanelGroup pixel width into a default expanded width and lock the content near its final size first;
      // remove the fixed width after the 200ms transition to restore regular responsive layout.
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
      // Refs remain empty when sidePaneState has no tabs or content is not mounted yet.
      // Do not write a new mask object each time or the effect will repeatedly trigger updates while tabs are empty.
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
      // The old check read content.scrollWidth directly, but the overflow state itself moves the add button
      // in/out of content and changes the viewport width, creating a ResizeObserver feedback loop near the threshold.
      // Reconstruct the hypothetical layout with the add button at the end of the tabs and use only a stable minimum-width budget.
      const isOverflowing = resolveSidePaneTabsOverflow({
        addButtonInside: Boolean(addButton && content.contains(addButton)),
        addButtonWidth,
        tabCount: visibleTabs.length,
        viewportWidth: viewport.clientWidth,
      });
      // Keep the add button at the end while tabs can still shrink evenly; pin it to the right only after overflow remains at the 60px minimum.
      setIsTabsOverflowing(isOverflowing);
      // When tabs overflow, do not always show gradient masks on both sides; at the start/end they suggest more scrolling is possible.
      // Tie masks to actual scrollLeft and indicate only the side that can still scroll.
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
        // When a tab is activated externally (for example, opening a file or returning to an old Browser),
        // it may be hidden in the horizontal scroll region. Use its real DOM width to scroll it into view,
        // avoiding misalignment of long titles/favicon tabs caused by fixed-width estimates.
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

  const addTabMenu = (
    <DropdownMenu open={isAddMenuOpen} onOpenChange={setIsAddMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          className="shrink-0"
          data-side-pane-add-trigger
          data-side-pane-add-tab-trigger=""
          aria-label={intl.formatMessage({
            id: "sidePane.addTab",
          })}
        >
          <PlusIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {canOpenSelectionSideConversation ? (
          <DropdownMenuItem
            data-side-pane-add-item="selection-side-conversation"
            onSelect={onOpenSelectionSideConversation}
          >
            <MessageSquareTextIcon className="size-4" />
            <span>{intl.formatMessage({ id: "sidePane.selectionChat" })}</span>
          </DropdownMenuItem>
        ) : null}
        {!isOfficeMode && !hasReviewTab ? (
          <DropdownMenuItem
            onSelect={() => {
              onOpenReviewTab();
            }}
          >
            <FileDiffIcon className="size-4" />
            <span>{intl.formatMessage({ id: "sidePane.review" })}</span>
          </DropdownMenuItem>
        ) : null}
        {/* Temporarily hide the canvas entry; it may be reopened later. */}
        {/* <DropdownMenuItem
          onSelect={() => {
            onOpenWhiteboard();
          }}
        >
          <PaletteIcon className="size-4" />
          <span>{intl.formatMessage({ id: "whiteboard.title" })}</span>
        </DropdownMenuItem> */}
        {!isOfficeMode ? (
          <DropdownMenuItem
            data-side-pane-add-item="terminal"
            onSelect={() => {
              onOpenTerminalTab();
            }}
          >
            <SquareTerminalIcon className="size-4" />
            <span>{intl.formatMessage({ id: "terminal.title" })}</span>
          </DropdownMenuItem>
        ) : null}
        {supportsEmbeddedBrowser ? (
          <DropdownMenuItem
            data-side-pane-add-item="browser"
            onSelect={() => {
              onOpenBrowserTab();
            }}
          >
            <GlobeIcon className="size-4" />
            <span>{intl.formatMessage({ id: "browser.title" })}</span>
          </DropdownMenuItem>
        ) : null}
        {developerToolsEnabled ? (
          <DropdownMenuItem
            data-side-pane-add-item="developer-tools"
            onSelect={() => {
              onOpenDeveloperTools();
            }}
          >
            <BugIcon className="size-4" />
            <span>{intl.formatMessage({ id: "developerTools.title" })}</span>
          </DropdownMenuItem>
        ) : null}
        {/* Plugins previously supported only blank pages; once tabs exist, the plus menu must reuse the same candidates and open action. */}
        {onOpenPluginUi ? (
          <PluginUiLauncherItems
            variant="menu"
            workspacePath={workspaceAbsPath}
            workspaceIdentity={workspaceIdentity}
            remoteSessionId={workspaceRemoteSessionId}
            sessionId={activeTaskId}
            onOpenPluginUi={onOpenPluginUi}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const openTabLauncherItemById: Record<OpenTabLauncherItemId, OpenTabLauncherItem> = {
    "selection-side-conversation": {
      id: "selection-side-conversation",
      label: intl.formatMessage({ id: "sidePane.selectionChat" }),
      icon: MessageSquareTextIcon,
      onOpen: onOpenSelectionSideConversation,
    },
    review: {
      id: "review",
      label: intl.formatMessage({ id: "sidePane.review" }),
      icon: FileDiffIcon,
      onOpen: onOpenReviewTab,
    },
    terminal: {
      id: "terminal",
      label: intl.formatMessage({ id: "terminal.title" }),
      icon: SquareTerminalIcon,
      onOpen: onOpenTerminalTab,
    },
    browser: {
      id: "browser",
      label: intl.formatMessage({ id: "browser.title" }),
      icon: GlobeIcon,
      onOpen: onOpenBrowserTab,
    },
    "developer-tools": {
      id: "developer-tools",
      label: intl.formatMessage({ id: "developerTools.title" }),
      icon: BugIcon,
      onOpen: onOpenDeveloperTools,
    },
  };
  const openTabLauncherItems: OpenTabLauncherItem[] = resolveOpenTabLauncherItemIds({
    canOpenSelectionSideConversation,
    developerToolsEnabled,
    hasReviewTab,
    supportsEmbeddedBrowser,
  })
    .filter((itemId) => !isOfficeMode || (itemId !== "terminal" && itemId !== "review"))
    .map((itemId) => openTabLauncherItemById[itemId]);
  const closeSidePaneButton =
    isVisible && !mobileOverlay && onCloseSidePane ? (
      <div className="flex shrink-0 items-center gap-0.5 [app-region:no-drag]">
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen
          onToggleSidePane={onCloseSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
        />
        {showWindowControls ? <DesktopWindowControls /> : null}
      </div>
    ) : null;
  const openTabLauncher = (
    <div className="side-pane-open-tab-shell flex h-full min-h-0 flex-col bg-background">
      {!mobileOverlay ? (
        <div
          className={cn(
            "flex h-12 shrink-0 items-center justify-end px-2",
            isDesktop && "[app-region:drag]",
          )}
          style={captionControlsStyle}
        >
          {closeSidePaneButton}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-10">
        <div className="side-pane-open-tab-content flex w-full max-w-[20rem] flex-col gap-5">
          <div className="flex flex-col gap-2 text-center">
            <h2 className="text-xl font-semibold leading-7 text-foreground">
              {intl.formatMessage({ id: "sidePane.openTab" })}
            </h2>
            <p className="text-ui-base leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "sidePane.openTabDescription" })}
            </p>
          </div>
          <div className="side-pane-open-tab-list flex w-full flex-col gap-2">
            {openTabLauncherItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-side-pane-open-tab-item={item.id}
                  className={OPEN_TAB_LAUNCHER_BUTTON_CLASS}
                  onClick={item.onOpen}
                >
                  <Icon className="size-4 text-foreground-subtle" />
                  <span className="side-pane-open-tab-button-label min-w-0 flex-1 truncate text-left">
                    {item.label}
                  </span>
                </button>
              );
            })}
            {onOpenPluginUi ? (
              <PluginUiLauncherItems
                workspacePath={workspaceAbsPath}
                workspaceIdentity={workspaceIdentity}
                remoteSessionId={workspaceRemoteSessionId}
                sessionId={activeTaskId}
                onOpenPluginUi={onOpenPluginUi}
                itemClassName={OPEN_TAB_LAUNCHER_BUTTON_CLASS}
              />
            ) : null}
          </div>
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
        codeViewerTitle: intl.formatMessage({ id: "codeViewer.title" }),
        treemappingTitle: intl.formatMessage({ id: "treemapping.title" }),
        whiteboardTitle: intl.formatMessage({ id: "whiteboard.title" }),
        modelTrajectoryTitle: intl.formatMessage({
          id: "modelTrajectory.title",
        }),
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
      onActivateTab={onActivateTab}
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
        // Place the standalone frame in the content layer; closing it keeps the Browser Guest and tab instance without changing the panel persistence boundary.
        "h-full overflow-hidden bg-background",
        !mobileOverlay && frameClassName,
        mobileStacked && "max-md:rounded-none max-md:border-0",
        mobileOverlay && "min-w-0",
        mobileStacked && "max-md:!w-full",
      )}
      style={mobileOverlay ? undefined : lockedContentStyle}
    >
      <ScopedErrorBoundary
        scope="workspace-side-pane"
        resetKeys={[workspaceKey, visibleActiveTabId]}
        variant="panel"
        className="h-full"
      >
        {hasRenderedSidePane && sidePaneState ? (
          <>
            {visibleTabs.length === 0 ? openTabLauncher : null}
            {/* Bugfix: sidePaneState is a workspace-level registry. After forking or switching tasks, it may contain only session-scoped tabs from another task. The registry is then nonempty while visibleTabs is empty; the old logic rendered empty Tabs with value="" and showed a blank screen. Hide the tabs while keeping TabsContent mounted so auxiliary-chat drafts and references survive when returning to the parent task. */}
            <div
              className={cn(
                "h-full min-h-0",
                visibleTabs.length === 0 && !screenshotSurfaceRequest && "hidden",
              )}
            >
              <Tabs
                value={visibleActiveTabId}
                onValueChange={onActivateTab}
                className="relative h-full gap-0"
              >
                <TabsList
                  style={mobileOverlay ? undefined : captionControlsStyle}
                  className={cn(
                    "flex justify-start w-full rounded-none p-0 border-0 border-b border-border/50 bg-transparent shadow-none !h-12 overflow-hidden",
                    // The standalone panel moves the tab bar to the top of the window, so add a window drag region; tabs and buttons keep handling their own interactions.
                    isDesktop &&
                      !mobileOverlay &&
                      "[app-region:drag] [&_button]:[app-region:no-drag] [&_[data-side-pane-tab-id]]:[app-region:no-drag]",
                  )}
                >
                  <div className="flex items-center justify-start flex-1 min-w-0">
                    {/* Align with WorkspaceHeader's p-2 so the left and right action areas do not jump when switching panels. */}
                    <div className="flex h-full shrink-0 items-center p-2">
                      {sidePaneTabOverview}
                    </div>
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
                        {/* Keep the tab strip at the full scroll viewport width: each tab first shrinks evenly from 156 px
                            to 60 px, and horizontal scrolling begins only when their combined minimum width still exceeds the viewport. */}
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
                                  isActive={tab.id === visibleActiveTabId}
                                  onActivateTab={onActivateTab}
                                  onCloseTab={onCloseTab}
                                  onCloseOtherTabs={onCloseOtherTabs}
                                  onCloseAllTabs={onCloseAllTabs}
                                  canCloseOtherTabs={visibleTabs.length > 1}
                                />
                              );
                            })}
                          </SortableContext>
                          {!isTabsOverflowing ? addTabMenu : null}
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
                      {isTabsOverflowing ? addTabMenu : null}
                      {closeSidePaneButton}
                    </div>
                  </div>
                  {/* The Expand Panel button is retained as a comment per request; its related logic has been removed.
                <div className="flex h-full shrink-0 items-center pl-1.5 pr-2">
                  <ControlHintTooltip title="" side="bottom" align="end">
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="">
                      Expand Panel
                    </Button>
                  </ControlHintTooltip>
                </div>
                */}
                </TabsList>

                <div className={cn("relative min-h-0 flex-1 isolate", mobileOverlay && "min-w-0")}>
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
                          isSelected={tab.id === visibleActiveTabId}
                          isCurrentTask={tab.sessionId === sidePaneOwnerId}
                          screenshotSurfaceRequest={
                            screenshotSurfaceTab?.id === tab.id ? screenshotSurfaceRequest : null
                          }
                          // Main writes the full history for a restoring guest after did-attach;
                          // if the renderer also consumes initialUrl, it submits navigation first and Chromium rejects the restore.
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
                            visible={isVisible && tab.id === visibleActiveTabId}
                            onOpenCodeViewer={onOpenCodeViewer}
                          />
                        ) : tab.type === "subagent-session" ? (
                          <SubagentSessionSidePane
                            tab={tab}
                            focused={isVisible && tab.id === visibleActiveTabId}
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
                            focused={isVisible && tab.id === visibleActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                            onUnavailable={onCloseTab}
                          />
                        ) : tab.type === "plugin-ui" ? (
                          <PluginUiSidePane
                            tab={tab}
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
                          // Narrow the type branch first and handle a missing callback **inside the branch**: adding
                          // `&& onOpenWorkflowRun` to the condition leaves this tab type in the union for later
                          // branches (so the browser branch would try to read residency from it).
                          onOpenWorkflowRun ? (
                            <WorkflowRunDirectorySidePane
                              tab={tab}
                              onOpenWorkflowRun={onOpenWorkflowRun}
                            />
                          ) : null
                        ) : tab.type === "workflow-actor-session" ? (
                          <WorkflowActorSessionSidePane
                            tab={tab}
                            focused={isVisible && tab.id === visibleActiveTabId}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            onOpenFileLink={onOpenFileLink}
                          />
                        ) : tab.type === "workflow-workspace" ? (
                          <WorkflowWorkspaceSidePane
                            tab={tab}
                            focused={isVisible && tab.id === visibleActiveTabId}
                            onOpenCodeViewer={onOpenCodeViewer}
                          />
                        ) : tab.type === "workflow-artifact" ? (
                          // “Show in workspace” reuses the Git panel's file-tree reveal (the same host callback)
                          // rather than creating a second navigation path.
                          <WorkflowArtifactSidePane
                            tab={tab}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            {...(onRevealGitFileInTree === undefined
                              ? {}
                              : { onRevealFileInTree: onRevealGitFileInTree })}
                          />
                        ) : tab.type === "code-viewer" ? (
                          <PreviewPane
                            markdownSelectionTarget={{ sessionId: activeTaskId, workspaceKey }}
                            source={tab.source}
                            onClose={onCloseCodeViewer}
                            workspacePath={workspaceAbsPath}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                            onOpenCodeViewer={onOpenCodeViewer}
                            // A code preview in an inactive/narrow tab or during resize should not keep
                            // @pierre/diffs' thousand-line Shadow DOM in layout. Clip only the body and preserve tab/source/file state.
                            renderHeavyContent={shouldRenderPreviewPaneHeavyContent({
                              isActiveTab: tab.id === visibleActiveTabId,
                              // Native video/audio fullscreen triggers resize; keep the current media node mounted
                              // while resize settles or the browser exits fullscreen immediately.
                              isMediaPreview:
                                tab.source.type === "media" ||
                                (tab.source.type === "file" &&
                                  inferMediaPreview(tab.source.path) !== null),
                              isMobileOverlay: mobileOverlay,
                              isResizeSettling: isWindowResizeSettling,
                              isSidePaneVisible: isVisible,
                              visibleInlineSizePx: sidePaneVisibleInlineSizePx,
                            })}
                          />
                        ) : tab.type === "git" ? (
                          <GitPane
                            workspacePath={workspaceAbsPath}
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
                        ) : tab.type === "developer-tools" ? (
                          <ServiceProvider services={services}>
                            <DeveloperToolsPane
                              workspacePath={workspaceAbsPath}
                              workspaceIdentity={workspaceIdentity}
                              taskId={activeTaskId}
                              enabled={isVisible && tab.id === visibleActiveTabId}
                            />
                          </ServiceProvider>
                        ) : tab.type === "terminal" ? (
                          <SidePaneTerminalPane
                            services={services}
                            sessionId={tab.id}
                            workspaceKey={workspaceKey}
                            cwd={tab.cwd ?? workspaceAbsPath}
                            isVisible={isVisible && tab.id === visibleActiveTabId}
                            isWindowsDesktop={isWindowsDesktop}
                            onOpenBrowserUrl={onOpenBrowserUrl}
                          />
                        ) : tab.type === "browser-permissions" ? (
                          <BrowserSitePermissionsPage
                            origin={tab.origin}
                            isVisible={isVisible && tab.id === visibleActiveTabId}
                          />
                        ) : (
                          <HumanBrowserView
                            browserKey={tab.id}
                            onOpenPermissionSettings={onOpenBrowserPermissionSettings}
                            agentOpened={tab.agentOpened}
                            deferEmptyGuest
                            isResidencyRestore={tab.residency === "restoring"}
                            isVisible={isVisible && isBrowserOpen && tab.id === visibleActiveTabId}
                            isSelected={tab.id === visibleActiveTabId}
                            isCurrentTask={tab.ownerTaskId === sidePaneOwnerId}
                            // restoring mounts only the bootstrap URL and does not commit the document;
                            // Main exclusively owns the pageState/URL restoration transaction.
                            initialUrl={
                              tab.residency === "restoring"
                                ? undefined
                                : (browserRestoreUrls[tab.id] ?? tab.initialUrl)
                            }
                            faviconUrl={tab.faviconUrl}
                            workspacePath={workspaceAbsPath}
                            workspaceIdentity={workspaceIdentity}
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
        ) : hasRenderedSidePane ? (
          openTabLauncher
        ) : null}
      </ScopedErrorBoundary>
    </div>
  );

  if (!panelLayout.useResizablePanel) {
    return (
      <>
        {/* Bugfix: the mobile remote-control sidebar is a drawer overlaying the chat area and sits outside a ResizablePanelGroup layout context;
            rendering ResizablePanel makes the outer auto width resolve the child 100% width chain to 0 px,
            so diff/preview content mounts but is invisible. Use a regular full-width container here instead. */}
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
      {isVisible ? (
        <ResizableHandle
          data-workspace-side-pane-resize-handle="true"
          className={cn(
            // The resize handle occupies a real 4px gap and is removed with the handle when closed, leaving no gap for a hidden pane.
            "aria-[orientation=vertical]:w-1 aria-[orientation=vertical]:translate-x-0 aria-[orientation=vertical]:my-0 aria-[orientation=vertical]:h-full",
            "hover:bg-transparent data-[separator=hover]:bg-transparent data-[separator=active]:bg-transparent focus-visible:bg-transparent",
            "aria-[orientation=vertical]:[mask-image:none] aria-[orientation=vertical]:[-webkit-mask-image:none]",
            "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-[var(--workspace-panel-radius,var(--radius-xl))] after:w-0.5",
            "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100",
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
        // When the right pane is always declared collapsible, the library treats dragging it to minimum width as a collapse.
        // Allow collapse only on explicit close so the pane does not disappear when users only intend to resize it to minimum width.
        collapsible={isDragCollapsible}
        // When the preview/side pane is collapsed, there is no ResizableHandle, but the library still exposes a collapsed-panel edge drag area.
        // Disable the pane resize target after collapse so users cannot drag it open from the right edge and bypass the explicit toggle.
        disabled={isResizeDisabled}
        className={cn(
          "!overflow-hidden transition-opacity duration-200 ease-out",
          mobileOverlay &&
            "max-md:!h-full max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-1 max-md:!basis-auto max-md:border-l",
          mobileStacked &&
            !mobileOverlay &&
            "max-md:!h-[min(45dvh,24rem)] max-md:!w-full max-md:!min-w-0 max-md:!max-w-none max-md:!flex-none max-md:!basis-auto max-md:border-l-0 max-md:border-t",
          // Keep the panel at opacity=1 during screenshots so opacity=0 does not make Chromium discard the guest
          // compositor surface. The actual browser surface is fixed in a low-opacity compositing layer inside the window and does not reveal the tab bar.
          isVisible || isScreenshotSurfaceActive ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {panelContent}
      </ResizablePanel>
    </>
  );
}
