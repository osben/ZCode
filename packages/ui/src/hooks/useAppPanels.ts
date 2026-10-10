/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createUuid } from "@zcode/shared";
import type { EmbeddedBrowserOpenUrlRequest, IPlatformService } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
// Keep-alive: move side-pane terminals into a module-level registry so they survive workspace sessions.
// Explicitly release and kill the PTY when closing a terminal tab to avoid orphan processes in the persistent registry.
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import {
  buildTaskSidePaneMemoryKey,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import {
  closeSidePaneTab,
  closeSidePaneTabForParent,
  closeVisibleOtherSidePaneTabs,
  closeVisibleSidePaneTabs,
  closeGitSidePane,
  closeCodeViewerSidePane,
  openWhiteboardSidePane,
  openModelTrajectorySidePane,
  openTerminalSidePane,
  openSubagentSessionSidePane,
  openSubagentDirectorySidePane,
  openSelectionSideChatPane,
  openPlanDetailSidePane,
  openWorkflowRunSidePane,
  replaceWorkflowRunSidePane,
  openWorkflowRunDirectorySidePane,
  openWorkflowActorSessionSidePane,
  openWorkflowWorkspaceSidePane,
  openWorkflowArtifactSidePane,
  activateDeveloperToolsSidePane,
  openBrowserSidePane,
  openOrActivateBrowserSidePaneByUrl,
  findBrowserSidePaneTabByUrl,
  applyBrowserUseSidePaneEvent,
  applyBrowserUseSidePaneVisibilityEvent,
  applyBrowserTabResidencyEvent,
  BROWSER_USE_OPERATION_INDICATOR_DURATION_MS,
  openCodeViewerSidePane,
  openCodeViewerSidePanes,
  activateGitSidePane,
  getActiveSidePaneTab,
  getVisibleSidePaneTabs,
  sidePaneOwnerKey,
  markBrowserUseSidePaneTabOperation,
  reorderSidePaneTab,
  resolveSidePaneScopeState,
  restoreSidePaneTab,
  setActiveSidePaneTab,
  syncSubagentSessionSidePaneTabs,
  toggleBrowserSidePane,
  toggleGitSidePane,
  updateBrowserSidePaneTab,
  stampSidePaneTabsOwnership,
  type BrowserSidePaneMetadata,
  type TreemappingSidePaneTab,
  type OpenScopedSubagentSideTabRequest,
  type OpenBackgroundBashSideTabRequest,
  openBackgroundBashSidePane,
  type OpenScopedSubagentDirectorySideTabRequest,
  type OpenSelectionSideChatRequest,
  type OpenScopedPlanDetailSideTabRequest,
  type OpenScopedWorkflowRunSideTabRequest,
  type OpenScopedWorkflowRunDirectorySideTabRequest,
  type OpenScopedWorkflowActorSessionSideTabRequest,
  type OpenScopedWorkflowArtifactSideTabRequest,
  type OpenScopedWorkflowWorkspaceSideTabRequest,
  type WorkspaceSidePaneState,
  type WorkspaceSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { isSidePaneTabVisibleForParent } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { getPathLeaf, joinFilePath, toFileUrl } from "@/lib/path.js";
import { shouldOpenWorkflowArtifactInBrowser } from "@/lib/workflowArtifactOpen.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { useModelTrajectoryOpenBridge } from "@/hooks/useModelTrajectoryOpenBridge.js";
import { useServices } from "@/hooks/useServices.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { clearSelectionSideChat } from "@/lib/selectionSideChatRuntime.js";
import { clearConversationSelectionReferenceScope } from "@/lib/conversationSelectionReference.js";
import { subscribeTaskLifecycle } from "@/lib/taskLifecycleEvents.js";

export interface BrowserNavigationRequest {
  id: string;
  targetTabId: string;
  url: string;
}

function isAgentOpenedBrowserPopup(payload: EmbeddedBrowserOpenUrlRequest): boolean {
  // Human webviews use unclaimed-iab as their owner; legacy-iab and iab:<uuid> are Agent-controlled contexts.
  // sourceTabId also prevents ordinary external/terminal links from being mistaken for model popups.
  return Boolean(payload.sourceTabId && payload.browserId && payload.browserId !== "unclaimed-iab");
}

export interface RecentClosedSidePaneTab {
  tab: WorkspaceSidePaneTab;
  closedAt: number;
}

const RECENT_CLOSED_SIDE_PANE_TAB_LIMIT = 8;

function createTerminalSidePaneTitle(
  current: WorkspaceSidePaneState | null,
  workspaceAbsPath: string,
): string {
  const baseTitle = getPathLeaf(workspaceAbsPath) || "Terminal";
  const usedTitles = new Set(
    current?.tabs
      .filter((tab) => tab.type === "terminal")
      .map((tab) => tab.title.trim())
      .filter(Boolean) ?? [],
  );

  if (!usedTitles.has(baseTitle)) {
    return baseTitle;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseTitle} ${index}`;
    if (!usedTitles.has(candidate)) {
      return candidate;
    }
  }
}

export function useAppPanels(options: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
  activeTaskId: string | null;
  /** Stable ID shared by draft state and real tasks, used as the side-pane conversation isolation boundary. */
  sidePaneOwnerId: string | null;
  isDesktop?: boolean;
  /**
   * Presentation semantics: whether the view is currently shown to the user (false when covered by Settings).
   * This hook deliberately does not consume it: Browser View events are authoritatively forwarded by main, so subscriptions must not depend on visibility.
   * See the timing-constraint comment on the subscription effect below.
   * The only reason to retain this parameter is as a regression guard: four useAppPanelsBrowserViewLifecycle tests pass false to represent
   * "covered by Settings". If visibility is added back to the subscription condition, those tests fail. Removing the parameter would remove that guard too.
   */
  isWorkspaceVisible?: boolean;
  supportsEmbeddedBrowser?: boolean;
  defaultWhiteboardNamePrefix: string;
  platform?: Pick<
    IPlatformService,
    | "onOpenBrowserUrl"
    | "onBrowserViewReady"
    | "onBrowserViewOperation"
    | "onBrowserViewVisibility"
    | "onBrowserViewCloseTab"
    | "onBrowserViewSuspend"
    | "onBrowserViewRestore"
    | "browserViewCloseTab"
    | "browserViewEnsureResident"
  >;
}) {
  const {
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
    defaultWhiteboardNamePrefix,
    platform,
  } = options;
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const activeWorkspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const { zcodeAgentService, zcodeSessionService } = useServices();
  const isOfficeMode = useIsOfficeMode();
  const sidePaneMemoryKey = useMemo(
    () =>
      buildTaskSidePaneMemoryKey({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        taskId: activeTaskId,
      }),
    [activeTaskId, workspaceAbsPath, workspaceIdentity],
  );
  const initialSidePaneMemoryState = readTaskSidePaneMemoryState(sidePaneMemoryKey);

  // Fix: the terminal area used to be fixed at the bottom of <main>, mounting Terminal as soon as the page opened.
  // It consumed space by default and immediately created a terminal session. Use an explicit toggle that defaults to closed,
  // and render Terminal only after the user clicks, so the terminal is not opened by default.
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  // Fix: the shared right panel (browser/code-viewer) should be closed by default.
  // Otherwise, it takes space from the main conversation as soon as a workspace opens, contrary to the expectation that it expands only when requested.
  const [sidePaneState, setSidePaneState] = useState<WorkspaceSidePaneState | null>(
    initialSidePaneMemoryState.sidePaneState,
  );
  const [isSidePaneCollapsed, setIsSidePaneCollapsed] = useState(
    getSidePaneCollapsedPreference(initialSidePaneMemoryState, sidePaneOwnerId) ??
      initialSidePaneMemoryState.isSidePaneCollapsed,
  );
  // Interaction: place the sidebar visibility button outside Sidebar, at the App level.
  // The entry remains in the upper-left when the sidebar is hidden, so users can reopen it;
  // this also handles the macOS traffic-light safe area to keep the button clear of system window controls.
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  const [browserNavigationRequest, setBrowserNavigationRequest] =
    useState<BrowserNavigationRequest | null>(null);
  const [allRecentClosedSidePaneTabs, setAllRecentClosedSidePaneTabs] = useState<
    RecentClosedSidePaneTab[]
  >([]);
  const lastActiveSubagentTabByRootRef = useRef<Map<string, string>>(new Map());
  const sidePaneOwnerIdRef = useRef(sidePaneOwnerId);
  sidePaneOwnerIdRef.current = sidePaneOwnerId;
  const activeWorkspaceKeyRef = useRef(activeWorkspaceKey);
  activeWorkspaceKeyRef.current = activeWorkspaceKey;
  const activeTabByOwnerRef = useRef<Map<string, string>>(new Map());
  const activeSidePaneMemoryKeyRef = useRef<string | null>(sidePaneMemoryKey);
  const latestSidePaneMemoryRef = useRef({
    sidePaneState,
    isSidePaneCollapsed,
  });
  latestSidePaneMemoryRef.current = {
    sidePaneState,
    isSidePaneCollapsed,
  };

  const revealSidePaneForCurrentOwner = useCallback(() => {
    setIsSidePaneCollapsed(false);
    latestSidePaneMemoryRef.current = {
      ...latestSidePaneMemoryRef.current,
      isSidePaneCollapsed: false,
    };
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      false,
    );
  }, []);

  const commitSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      const next = updater(latestSidePaneMemoryRef.current.sidePaneState);
      // Normal sidebar interactions and BrowserView IPC may arrive next to each other in the same React batch.
      // If only BrowserView updates synchronize the ref, a later concrete value may overwrite an uncommitted open/activate/reorder update.
      // All sidebar write paths first update the canonical ref so interactions and lifecycle events merge strictly in receive order.
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        sidePaneState: next,
      };
      setSidePaneState(next);
      return next;
    },
    [],
  );

  const commitOpenedSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      commitSidePaneState((current) =>
        stampSidePaneTabsOwnership(updater(current), {
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
          remoteSessionId: workspaceRemoteSessionId ?? null,
        }),
      );
    },
    [commitSidePaneState, workspaceRemoteSessionId],
  );

  useEffect(() => {
    const previousKey = activeSidePaneMemoryKeyRef.current;
    if (previousKey === sidePaneMemoryKey) {
      return;
    }

    // Side-pane state used to be transient state inside the workspace component and was overwritten when switching workspaces.
    // Save the old workspace's tabs/collapsed state to memory before changing the key, then restore the new workspace to prevent state leaking between workspaces.
    // Switching tasks within the same workspace should not affect the side pane, so the key is no longer split by task.
    saveTaskSidePaneMemoryState(previousKey, latestSidePaneMemoryRef.current);
    const restored = readTaskSidePaneMemoryState(sidePaneMemoryKey);
    activeSidePaneMemoryKeyRef.current = sidePaneMemoryKey;
    commitSidePaneState(() => restored.sidePaneState);
    setIsSidePaneCollapsed(
      getSidePaneCollapsedPreference(restored, sidePaneOwnerIdRef.current) ??
        restored.isSidePaneCollapsed,
    );
  }, [commitSidePaneState, sidePaneMemoryKey]);

  useEffect(() => {
    return () => {
      saveTaskSidePaneMemoryState(
        activeSidePaneMemoryKeyRef.current,
        latestSidePaneMemoryRef.current,
      );
    };
  }, []);

  const hasVisibleSidePaneTabs = useCallback(
    (next: WorkspaceSidePaneState | null) =>
      Boolean(
        next &&
        getVisibleSidePaneTabs(next.tabs, {
          workspaceKey: activeWorkspaceKey,
          ownerTaskId: sidePaneOwnerId,
        }).length,
      ),
    [activeWorkspaceKey, sidePaneOwnerId],
  );

  const syncSidePaneCollapsedWithTabs = useCallback(
    (next: WorkspaceSidePaneState | null) => {
      if (!hasVisibleSidePaneTabs(next)) {
        // Lifecycle cleanup must not expand the panel just because other visible tabs remain; that would overwrite
        // the current owner's explicit preference to collapse it. Force-close only when no visible content remains.
        setIsSidePaneCollapsed(true);
      }
    },
    [hasVisibleSidePaneTabs],
  );

  useEffect(() => {
    commitSidePaneState((current) => {
      const scopeKey = `${activeWorkspaceKey}::${sidePaneOwnerId ?? "__draft__"}`;
      const preferredTabId =
        activeTabByOwnerRef.current.get(scopeKey) ??
        (activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : undefined);
      const collapsedPreference = getSidePaneCollapsedPreference(
        readTaskSidePaneMemoryState(activeSidePaneMemoryKeyRef.current),
        sidePaneOwnerId,
      );
      const resolved = resolveSidePaneScopeState(
        current,
        { workspaceKey: activeWorkspaceKey, ownerTaskId: sidePaneOwnerId },
        preferredTabId,
        collapsedPreference,
      );
      setIsSidePaneCollapsed(resolved.isSidePaneCollapsed);
      logger.debug("[App] 同步对话右侧面板 scope", {
        activeTabId: resolved.sidePaneState?.activeTabId ?? null,
        activeTaskId,
        isSidePaneCollapsed: resolved.isSidePaneCollapsed,
        ownerTaskId: sidePaneOwnerId,
        preferredTabId: preferredTabId ?? null,
        workspaceKey: activeWorkspaceKey,
      });
      return resolved.sidePaneState;
    });
  }, [activeTaskId, activeWorkspaceKey, commitSidePaneState, sidePaneOwnerId]);

  const handleOpenCodeViewer = useCallback(
    (source: CodeViewerSource) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePane(current, source, sidePaneOwnerIdRef.current);
        const activeTab = getActiveSidePaneTab(next);
        const activePath =
          activeTab?.type === "code-viewer" ? (activeTab.source.path ?? "none") : "none";
        logger.info(
          `[App] 切换右侧面板 mode=code-viewer workspace=${workspaceAbsPath} title=${source.title} path=${activePath} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenCodeViewers = useCallback(
    (sources: readonly CodeViewerSource[]) => {
      if (sources.length === 0) return;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePanes(current, sources, sidePaneOwnerIdRef.current, 0);
        logger.info(
          `[App] 批量打开右侧预览 workspace=${workspaceAbsPath} sources=${sources.length} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBrowserUrl = useCallback(
    (request: string | EmbeddedBrowserOpenUrlRequest) => {
      const payload: EmbeddedBrowserOpenUrlRequest =
        typeof request === "string" ? { url: request, disposition: "foreground-tab" } : request;
      const sourceWorkspaceKey = payload.workspaceKey ?? activeWorkspaceKeyRef.current;
      const sourceSessionId = payload.sessionId ?? sidePaneOwnerIdRef.current;
      const sourceRemoteSessionId =
        payload.remoteSessionId ?? workspaceRemoteSessionId ?? undefined;
      const isCurrentOwner =
        sourceWorkspaceKey === activeWorkspaceKeyRef.current &&
        (sourceRemoteSessionId ?? "") === (workspaceRemoteSessionId ?? "") &&
        sourceSessionId === sidePaneOwnerIdRef.current;
      if (!supportsEmbeddedBrowser) {
        // Web has no built-in browser panel; fall back to a new browser tab so the external link remains accessible.
        window.open(payload.url, "_blank", "noopener,noreferrer");
        return;
      }

      // The message area only emits the intent to "open this URL".
      // Webview navigation, URL validation, and panel visibility are handled together by the browser panel.
      const isShareUrl = /^https?:\/\/[^/]+\/(?:cn\/)?share\/[^/]+$/u.test(payload.url);
      const targetTabId = `browser:${createUuid()}`;
      // When an Agent-controlled guest triggers a popup, the new page is still part of the model operation.
      // Do not treat it as a human-opened Browser tab or inherit the free-size/zoom preferences stored in setting.json.
      const agentOpened = isAgentOpenedBrowserPopup(payload);
      // Webview popup events used to carry only the URL, so a late event from conversation 1 could be claimed by conversation 2's owner.
      // Preserve the source scope and steal focus only if the source is still the current owner.
      if (!isShareUrl && isCurrentOwner) {
        setBrowserNavigationRequest({
          id: createUuid(),
          targetTabId,
          url: payload.url,
        });
      }
      if (isCurrentOwner) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${isCurrentOwner ? "切换" : "后台挂载"}右侧面板 mode=browser workspace=${sourceWorkspaceKey} sessionId=${sourceSessionId} url=${payload.url}`,
      );
      commitOpenedSidePaneState((current) =>
        isShareUrl
          ? openOrActivateBrowserSidePaneByUrl(current, {
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
            })
          : openBrowserSidePane(current, {
              tabId: targetTabId,
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              // Both paths include ownerTaskId, so stampSidePaneTabsOwnership will not add scope later.
              // Freeze remoteSessionId at creation, or the tab cannot be closed in a remote session.
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
              activate: isCurrentOwner,
              agentOpened,
            }),
      );
    },
    [
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      supportsEmbeddedBrowser,
      workspaceAbsPath,
      workspaceRemoteSessionId,
    ],
  );

  const handleToggleBrowser = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // Capability boundary: Web/mobile do not currently support Electron webviews, so do not create a Browser side pane.
      logger.info(`[App] 当前壳层不支持内嵌浏览器，忽略切换请求 workspace=${workspaceAbsPath}`);
      return;
    }

    commitOpenedSidePaneState((current) => {
      const activeTab = getActiveSidePaneTab(current);
      const closingActiveBrowser =
        activeTab?.type === "browser" &&
        sidePaneOwnerKey(activeTab.ownerTaskId) === sidePaneOwnerKey(sidePaneOwnerIdRef.current);
      const next = toggleBrowserSidePane(
        current,
        sidePaneOwnerIdRef.current,
        workspaceRemoteSessionId,
      );
      if (closingActiveBrowser) {
        syncSidePaneCollapsedWithTabs(next);
      } else {
        revealSidePaneForCurrentOwner();
      }
      const nextActiveTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 切换右侧面板 mode=${nextActiveTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenBrowserTab = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // Capability boundary: Web/mobile do not currently support Electron webviews, so do not create a Browser side pane.
      logger.info(`[App] 当前壳层不支持内嵌浏览器，忽略新建请求 workspace=${workspaceAbsPath}`);
      return;
    }

    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openBrowserSidePane(current);
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 新建右侧浏览器 tab=${activeTab?.id ?? "none"} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    workspaceAbsPath,
  ]);

  // The Browser View events below are authoritatively forwarded by main.
  // Do not use isWorkspaceVisible (= !isSettingsTabActive) as a subscription gate. Settings is an overlay, so App stays mounted
  // while this flag becomes false. If effect cleanup unsubscribes, main events disappear: a lost ready event makes
  // waitForGuest time out after 10 seconds and delete the tab through closeTabDurably, leaving the sidebar empty when Settings closes.
  // Visibility means only whether the user sees the view, not whether authoritative events should be received. shouldReveal's scope match
  // still decides whether to take focus, so this code no longer depends on isWorkspaceVisible.
  useEffect(() => {
    if (!supportsEmbeddedBrowser || !isDesktop || !platform?.onOpenBrowserUrl) {
      return;
    }

    return platform.onOpenBrowserUrl((request) => {
      // target=_blank/window.open inside a webview used to be swallowed by popup policy or passed to Electron's default BrowserWindow creation.
      // The main process now intercepts and validates the URL; the renderer places the controlled request in the current visible workspace's right-side Browser tab.
      logger.info(
        `[App] webview 请求打开右侧浏览器 tab workspace=${workspaceAbsPath} url=${request.url} disposition=${request.disposition}`,
      );
      handleOpenBrowserUrl(request);
    });
  }, [handleOpenBrowserUrl, isDesktop, platform, supportsEmbeddedBrowser, workspaceAbsPath]);

  // Browser Use events carry the workspace/session frozen at creation; late events mount in the background and cannot steal the current conversation's focus.
  const handleBrowserViewReady = useCallback(
    (
      payload: Parameters<NonNullable<IPlatformService["onBrowserViewReady"]>>[0] extends (
        value: infer Payload,
      ) => void
        ? Payload
        : never,
    ) => {
      if (!isDesktop) return;
      const activeScope = {
        workspaceKey: activeWorkspaceKeyRef.current,
        remoteSessionId: workspaceRemoteSessionId ?? undefined,
        ownerTaskId: sidePaneOwnerIdRef.current,
      };
      const result = applyBrowserUseSidePaneEvent(
        latestSidePaneMemoryRef.current.sidePaneState,
        payload,
        activeScope,
      );
      commitSidePaneState(() => result.state);
      if (result.shouldReveal) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${result.shouldReveal ? "展开并激活" : "后台挂载"} browser-use tab workspace=${payload.workspaceKey} sessionId=${payload.sessionId} tabId=${payload.tabId}`,
      );
    },
    [commitSidePaneState, isDesktop, revealSidePaneForCurrentOwner, workspaceRemoteSessionId],
  );

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewReady) return;
    return platform.onBrowserViewReady(handleBrowserViewReady);
  }, [handleBrowserViewReady, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewOperation) return;
    return platform.onBrowserViewOperation((payload) => {
      const operationUntil = Date.now() + BROWSER_USE_OPERATION_INDICATOR_DURATION_MS;
      commitSidePaneState((current) =>
        markBrowserUseSidePaneTabOperation(current, {
          ...payload,
          operationUntil,
        }),
      );
      // Browser commands are as frequent as message events; do not write them to info logs in production.
      logger.debug("[App] browser-use operation", {
        operationUntil,
        sessionId: payload.sessionId,
        tabId: payload.tabId,
        workspaceKey: payload.workspaceKey,
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewVisibility) return;
    return platform.onBrowserViewVisibility((payload) => {
      if (payload.visible && payload.tabId) {
        const result = applyBrowserUseSidePaneVisibilityEvent(
          latestSidePaneMemoryRef.current.sidePaneState,
          { ...payload, tabId: payload.tabId },
          {
            workspaceKey: activeWorkspaceKeyRef.current,
            remoteSessionId: workspaceRemoteSessionId ?? undefined,
            ownerTaskId: sidePaneOwnerIdRef.current,
          },
        );
        if (result.didMatch) {
          activeTabByOwnerRef.current.set(
            `${payload.workspaceKey}::${payload.sessionId}`,
            `browser-use:${payload.tabId}`,
          );
        } else {
          // Visibility events are as frequent as browser commands; log ignored late events only in development to avoid production disk churn.
          logger.debug("[App] 忽略无现存 shell 的 browser-use visibility", {
            sessionId: payload.sessionId,
            tabId: payload.tabId,
            workspaceKey: payload.workspaceKey,
          });
        }
        commitSidePaneState(() => result.state);
        if (result.shouldReveal) revealSidePaneForCurrentOwner();
        return;
      }

      const active = getActiveSidePaneTab(latestSidePaneMemoryRef.current.sidePaneState);
      if (
        active?.type === "browser-use" &&
        active.workspaceKey === payload.workspaceKey &&
        (active.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
        active.sessionId === payload.sessionId &&
        active.browserId === payload.browserId &&
        active.browserGeneration === payload.browserGeneration &&
        (payload.tabId === undefined || active.tabId === payload.tabId)
      ) {
        setIsSidePaneCollapsed(true);
      }
    });
  }, [
    commitSidePaneState,
    isDesktop,
    platform,
    revealSidePaneForCurrentOwner,
    workspaceRemoteSessionId,
  ]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewCloseTab) return;
    return platform.onBrowserViewCloseTab((payload) => {
      const findTargetId = (state: WorkspaceSidePaneState | null) =>
        state?.tabs.find(
          (tab) =>
            (tab.type === "browser-use" && tab.tabId === payload.tabId) ||
            (tab.type === "browser" && tab.id === payload.tabId),
        )?.id ?? null;

      // Side-pane state is stored per workspace, so searching only the current active workspace can miss the target tab.
      // The user may switch workspaces before the Agent closes a tab, silently dropping the notification and leaving the tab in persisted state.
      // When they return, its main-side logical tab is gone but the × button cannot close the stale entry, leaving a ghost tab.
      // With owner scope on the notification, route by workspaceKey and delete directly from that workspace's memory.
      // Route only by workspaceKey, not session: main has already decided the tab is closed, so the renderer shell must converge regardless of task.
      // tabId is globally unique, so this cannot delete a tab from another workspace by mistake.
      const targetWorkspaceKey = payload.workspaceKey;
      if (targetWorkspaceKey && targetWorkspaceKey !== activeSidePaneMemoryKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(targetWorkspaceKey);
        const targetId = findTargetId(stored.sidePaneState);
        if (!targetId) return;
        const nextState = closeSidePaneTab(stored.sidePaneState, targetId);
        saveTaskSidePaneMemoryState(targetWorkspaceKey, {
          sidePaneState: nextState,
          isSidePaneCollapsed: nextState ? stored.isSidePaneCollapsed : true,
        });
        return;
      }

      let didClose = false;
      const next = commitSidePaneState((current) => {
        const targetId = findTargetId(current);
        if (!targetId) return current;
        didClose = true;
        return closeSidePaneTabForParent(current, targetId, sidePaneOwnerIdRef.current);
      });
      if (didClose) syncSidePaneCollapsedWithTabs(next);
    });
  }, [commitSidePaneState, isDesktop, platform, syncSidePaneCollapsedWithTabs]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewSuspend) return;
    return platform.onBrowserViewSuspend((payload) => {
      commitSidePaneState((current) => {
        const target = current?.tabs.find(
          (tab) =>
            ((tab.type === "browser-use" && tab.tabId === payload.tabId) ||
              (tab.type === "browser" && tab.id === payload.tabId)) &&
            tab.workspaceKey === payload.workspaceKey &&
            (tab.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
            (tab.type === "browser-use"
              ? tab.sessionId === payload.sessionId
              : (tab.ownerTaskId ?? "unscoped") === payload.sessionId),
        );
        if (!target) return current;
        return applyBrowserTabResidencyEvent(current, payload);
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewRestore) return;
    return platform.onBrowserViewRestore((payload) => {
      commitSidePaneState((current) => applyBrowserTabResidencyEvent(current, payload));
    });
  }, [commitSidePaneState, isDesktop, platform]);

  const handleToggleGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const closingActiveGit = getActiveSidePaneTab(current)?.type === "git";
      const next = toggleGitSidePane(current);
      if (closingActiveGit) {
        syncSidePaneCollapsedWithTabs(next);
      } else {
        revealSidePaneForCurrentOwner();
      }
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 切换右侧面板 mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [
    isOfficeMode,
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
  ]);

  const handleOpenGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const next = activateGitSidePane(current);
      // File-change lookup only needs to ensure the Git panel is open; do not reuse toggle.
      // If the Git tab is already active, toggle would close it and hide the file-change content.
      revealSidePaneForCurrentOwner();
      logger.info(
        `[App] 打开右侧面板 mode=git workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenTreemapping = useCallback(
    (source?: TreemappingSidePaneTab["source"]) => {
      // Treemapping must currently be hidden from the sidebar. Keep the callback shape for message-flow compatibility,
      // but do not create a side-pane tab, preventing the header or old entry point from bypassing the menu hiding.
      logger.debug(
        `[App] 已隐藏 treemapping 侧边栏入口 workspace=${workspaceAbsPath} source=${source?.kind ?? "current"}`,
      );
    },
    [workspaceAbsPath],
  );

  const handleOpenWhiteboard = useCallback(() => {
    const board = useWhiteboardStore.getState().createBoard({
      defaultNamePrefix: defaultWhiteboardNamePrefix,
      workspaceIdentity,
      workspacePath: workspaceAbsPath,
    });
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openWhiteboardSidePane(current, {
        boardId: board.id,
        title: board.name,
      });
      logger.info(
        `[App] 打开右侧面板 mode=whiteboard workspace=${workspaceAbsPath} board=${board.id} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    defaultWhiteboardNamePrefix,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  const handleOpenDeveloperTools = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = activateDeveloperToolsSidePane(current);
      logger.info(
        `[App] 打开右侧面板 mode=developer-tools workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenTerminalTab = useCallback(() => {
    if (isOfficeMode) return;
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const title = createTerminalSidePaneTitle(current, workspaceAbsPath);
      const next = openTerminalSidePane(current, {
        title,
        cwd: workspaceAbsPath,
        remoteSessionId: workspaceRemoteSessionId,
      });
      logger.info(
        `[App] 新建右侧终端 tab=${title} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    isOfficeMode,
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenModelTrajectory = useCallback(
    (params: { taskId: string; title?: string | null }) => {
      if (!params.taskId) {
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openModelTrajectorySidePane(current, params);
        logger.info(
          `[App] 打开右侧面板 mode=model-trajectory workspace=${workspaceAbsPath} taskId=${params.taskId} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBackgroundBash = useCallback(
    (request: OpenBackgroundBashSideTabRequest) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => openBackgroundBashSidePane(current, request));
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenScopedSubagentSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentSessionSidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
          childSessionId: request.childSessionId,
          subagentType: request.subagentType,
          title: request.title,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        logger.debug(
          `[App] 打开子智能体右侧 tab parent=${request.parentSessionId} child=${request.childSessionId} workspace=${workspaceKey}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentDirectory = useCallback(
    (request: OpenScopedSubagentDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentDirectorySidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleSyncSubagentSessionTabs = useCallback(
    (request: import("@/lib/workspaceSidePane.js").SyncSubagentSessionTabsRequest) => {
      // Stale tabs from branch edit/retry are projection cleanup and do not belong in "Recently closed".
      commitSidePaneState((current) => syncSubagentSessionSidePaneTabs(current, request));
    },
    [commitSidePaneState],
  );

  const handleOpenSelectionSideChat = useCallback(
    (request: OpenSelectionSideChatRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const staleTab = request.replacesChildSessionId
          ? current?.tabs.find(
              (tab) =>
                tab.type === "selection-side-chat" &&
                tab.workspaceKey === workspaceKey &&
                tab.parentSessionId === request.parentSessionId &&
                tab.childSessionId === request.replacesChildSessionId,
            )
          : undefined;
        const withoutStale = staleTab ? closeSidePaneTab(current, staleTab.id) : current;
        return openSelectionSideChatPane(withoutStale, {
          ...request,
          workspaceKey,
        });
      });
      logger.debug("[App] 打开框选副屏会话", {
        childSessionId: request.childSessionId,
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenPlanDetail = useCallback(
    (request: OpenScopedPlanDetailSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openPlanDetailSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开计划详情右侧 tab", {
        parentSessionId: request.parentSessionId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenWorkflowRun = useCallback(
    (request: OpenScopedWorkflowRunSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      // In-place replacement after Configure is not a new open; keep a collapsed sidebar collapsed.
      const replaceRunId = request.replaceRunId;
      if (replaceRunId === undefined) setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        replaceRunId === undefined
          ? openWorkflowRunSidePane(current, { ...request, workspaceKey })
          : replaceWorkflowRunSidePane(current, { ...request, workspaceKey, replaceRunId }),
      );
      logger.debug("[App] 打开工作流运行详情右侧 tab", {
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowRunDirectory = useCallback(
    (request: OpenScopedWorkflowRunDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowRunDirectorySidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流运行目录右侧 tab", {
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenScopedWorkflowActorSessionSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowActorSessionSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流 actor 会话右侧 tab", {
        actorSessionId: request.actorSessionId,
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenScopedWorkflowWorkspaceSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowWorkspaceSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流工作区右侧 tab", {
        parentSessionId: request.parentSessionId,
        phaseId: request.phaseId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  /**
   * Reuse a browser tab by URL (destination for opening HTML artifacts directly).
   *
   * It differs from `handleOpenBrowserUrl` in three ways:
   * 1. Claim a destination by URL instead of opening a new tab each time.
   * 2. **Still** send a navigation request when an existing tab matches. The webview may still show old bytes and `initialUrl` has not changed,
   *    so mount-time navigation will not run again (`UnifiedBrowserView` deduplicates by URL via `lastAppliedInitialUrlRef`) and v2 would never appear.
   * 3. The caller specifies ownership and it is **always activated**. This path is triggered only by a user clicking an artifact,
   *    with no background-mount case like `isCurrentOwner` (see the ownerTaskId comment below).
   */
  const openFileUrlInBrowserSidePane = useCallback(
    (params: { url: string; ownerTaskId: string; workspaceKey: string }) => {
      const state = latestSidePaneMemoryRef.current.sidePaneState;
      const existing = findBrowserSidePaneTabByUrl(state, {
        initialUrl: params.url,
        ownerTaskId: params.ownerTaskId,
        workspaceKey: params.workspaceKey,
      });
      const targetTabId = existing?.id ?? `browser:${createUuid()}`;
      setBrowserNavigationRequest({ id: createUuid(), targetTabId, url: params.url });
      // As with artifact tabs, update only the current collapsed state without persisting a preference: ownership comes from params.ownerTaskId,
      // while revealSidePaneForCurrentOwner records false under the **current** owner, and the central path may have different owners.
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openOrActivateBrowserSidePaneByUrl(current, {
          initialUrl: params.url,
          tabId: targetTabId,
          // Freeze ownership explicitly instead of letting stampSidePaneTabsOwnership apply the current owner: the central artifact-chip path
          // calls handleSelectTaskInChat before handleOpenWorkflowArtifact, and sidePaneOwnerIdRef still points to the previous session within that synchronous block.
          // Browser-tab visibility is narrowed by ownerTaskId (the default branch in getVisibleSidePaneTabsByScope), so a wrong owner would make this tab disappear after the switch settles.
          // Artifact tabs are unaffected because they are narrowed by parentSessionId.
          ownerTaskId: params.ownerTaskId,
          workspaceKey: params.workspaceKey,
        }),
      );
      return targetTabId;
    },
    [commitOpenedSidePaneState],
  );

  /**
   * The **only** destination decision for artifact clicks: open HTML directly when an embedded browser is available; otherwise open an artifact tab.
   *
   * The direct-open path may lack `sourcePath`: the run side pane has it (it already merged the journal), but the pill summary deliberately omits it
   * to keep state frames small (see `workflowRunArtifactSummarySchema`). Query the journal once when it is missing.
   * If the query fails, an older CLI lacks it, or the artifact has no source, fall back to the artifact tab so the click always works.
   */
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenScopedWorkflowArtifactSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const openArtifactTab = () => {
        setIsSidePaneCollapsed(false);
        commitOpenedSidePaneState((current) =>
          openWorkflowArtifactSidePane(current, {
            ...request,
            workspaceKey,
          }),
        );
        logger.debug("[App] 打开工作流产物右侧 tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          workspaceKey,
        });
      };

      if (
        !shouldOpenWorkflowArtifactInBrowser({
          contentType: request.contentType,
          supportsEmbeddedBrowser,
          workspaceIdentity: request.workspaceIdentity,
          remoteSessionId: request.remoteSessionId,
        })
      ) {
        openArtifactTab();
        return;
      }

      const openInBrowser = (sourcePath: string) => {
        // A workspace-relative sourcePath becomes a real local path when joined with workspacePath; use the same path as
        // "Open in browser" on the artifact card (WorkflowArtifactSidePane's localSourcePath).
        const url = toFileUrl(joinFilePath(request.workspacePath, sourcePath));
        const tabId = openFileUrlInBrowserSidePane({
          url,
          ownerTaskId: request.parentSessionId,
          workspaceKey,
        });
        logger.debug("[App] html 产物直接打开浏览器 tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          tabId,
          workspaceKey,
        });
      };

      const knownSourcePath = request.sourcePath?.trim();
      if (knownSourcePath) {
        openInBrowser(knownSourcePath);
        return;
      }

      void (async () => {
        try {
          // The condition already guarantees a local workspace (no workspaceIdentity/remoteSessionId), so pass only workspacePath.
          const result = await zcodeAgentService.conversationWorkflowRunArtifactsV4({
            workspacePath: request.workspacePath,
            sessionId: request.parentSessionId,
            runId: request.runId,
          });
          const sourcePath = result.artifacts
            .find((artifact) => artifact.id === request.artifactId)
            ?.sourcePath?.trim();
          if (!sourcePath) {
            logger.debug("[App] html 产物没有工作区出处，退回产物 tab", {
              artifactId: request.artifactId,
              runId: request.runId,
            });
            openArtifactTab();
            return;
          }
          openInBrowser(sourcePath);
        } catch (error) {
          logger.warn("[App] 查产物出处失败，退回产物 tab", {
            artifactId: request.artifactId,
            error: error instanceof Error ? error.message : String(error),
            runId: request.runId,
          });
          openArtifactTab();
        }
      })();
    },
    [
      commitOpenedSidePaneState,
      openFileUrlInBrowserSidePane,
      supportsEmbeddedBrowser,
      zcodeAgentService,
    ],
  );

  const closeSelectionSideChatRuntime = useCallback(
    (tab: Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }>) => {
      clearSelectionSideChat(tab.childSessionId);
      clearConversationSelectionReferenceScope(tab.childSessionId, tab.workspaceKey);
      void zcodeSessionService
        .closeSession({
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          sessionId: tab.childSessionId,
        })
        .catch((error) => {
          if (String(error).includes("sessionNotFound")) return;
          logger.warn("[App] 关闭框选副屏 runtime 失败", {
            childSessionId: tab.childSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [zcodeSessionService],
  );

  useEffect(() => {
    const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
    return subscribeTaskLifecycle((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      clearConversationSelectionReferenceScope(event.taskId, event.workspaceKey);
      const closingTabs =
        latestSidePaneMemoryRef.current.sidePaneState?.tabs.filter(
          (tab): tab is Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }> =>
            tab.type === "selection-side-chat" && tab.parentSessionId === event.taskId,
        ) ?? [];
      if (closingTabs.length === 0) return;

      for (const tab of closingTabs) closeSelectionSideChatRuntime(tab);
      const closingIds = new Set(closingTabs.map((tab) => tab.id));
      commitSidePaneState((current) => {
        if (!current) return current;
        let next: WorkspaceSidePaneState | null = current;
        for (const tabId of closingIds) {
          next = closeSidePaneTabForParent(next, tabId, activeTaskId);
        }
        syncSidePaneCollapsedWithTabs(next);
        return next;
      });
      logger.info("[App] 父任务结束，清理框选副屏会话", {
        event: event.type,
        parentSessionId: event.taskId,
        workspaceKey,
      });
    });
  }, [
    activeTaskId,
    closeSelectionSideChatRuntime,
    commitSidePaneState,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  // Subscribe to "open model call trace" requests: the menu deep in the tree uses a singleton store to dispatch them; match by workspaceKey and consume here.
  useModelTrajectoryOpenBridge(
    workspaceIdentity?.trim() || workspaceAbsPath,
    handleOpenModelTrajectory,
  );

  const handleToggleTerminal = useCallback(() => {
    setIsTerminalOpen((open) => {
      if (isOfficeMode && !open) return open;
      const nextOpen = !open;
      logger.info("[App] 切换底部终端面板", {
        open: nextOpen,
        workspace: workspaceAbsPath,
      });
      return nextOpen;
    });
  }, [isOfficeMode, workspaceAbsPath]);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarVisible((visible) => !visible);
  }, []);

  const handleToggleSidePaneCollapse = useCallback(() => {
    setIsSidePaneCollapsed((collapsed) => {
      const nextCollapsed = !collapsed;
      // Tabs are reused by workspace, but collapsing the top-level panel is an explicit choice for the current conversation.
      // Record the owner's preference so scope resolution after a conversation switch does not override it by auto-expanding visible tabs.
      saveTaskSidePaneCollapsedPreference(
        activeSidePaneMemoryKeyRef.current,
        sidePaneOwnerIdRef.current,
        nextCollapsed,
      );
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        isSidePaneCollapsed: nextCollapsed,
      };
      logger.info(
        `[App] ${nextCollapsed ? "收起" : "展开"}右侧面板 workspace=${workspaceAbsPath} tabs=${sidePaneState?.tabs.length ?? 0}`,
      );
      return nextCollapsed;
    });
  }, [sidePaneState, workspaceAbsPath]);

  const handleCloseCodeViewer = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=code-viewer workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeCodeViewerSidePane(current);
      syncSidePaneCollapsedWithTabs(next);
      return next;
    });
  }, [commitSidePaneState, syncSidePaneCollapsedWithTabs, workspaceAbsPath]);

  const handleCloseGit = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=git workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeGitSidePane(current);
      syncSidePaneCollapsedWithTabs(next);
      return next;
    });
  }, [commitSidePaneState, syncSidePaneCollapsedWithTabs, workspaceAbsPath]);

  const handleActivateSidePaneTab = useCallback(
    (tabId: string) => {
      const tab = latestSidePaneMemoryRef.current.sidePaneState?.tabs.find(
        (candidate) => candidate.id === tabId,
      );
      if (
        (tab?.type === "browser" || tab?.type === "browser-use") &&
        tab.residency === "suspended"
      ) {
        const logicalTabId = tab.type === "browser-use" ? tab.tabId : tab.id;
        // Human-tab attachment uses `tab.remoteSessionId ?? workspaceRemoteSessionId` to freeze the owner as a fallback.
        // Keep this consistent; existing tabs created without a frozen field would otherwise mismatch scope and never reopen.
        // browser-use attachment has no such fallback, and adding it there would cause the opposite mismatch, so branch by type.
        const scopedRemoteSessionId =
          tab.type === "browser-use"
            ? tab.remoteSessionId
            : (tab.remoteSessionId ?? workspaceRemoteSessionId);
        void platform
          ?.browserViewEnsureResident?.({
            tabId: logicalTabId,
            workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
            ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
            sessionId: tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
          })
          .catch((error) => {
            logger.warn("[App] 激活 suspended Browser tab 失败", {
              error: error instanceof Error ? error.message : String(error),
              tabId: logicalTabId,
            });
          });
      }
      commitSidePaneState((current) => {
        const target = current?.tabs.find((candidate) => candidate.id === tabId);
        if (target?.type === "subagent-session" || target?.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(target.rootSessionId, target.id);
        }
        return setActiveSidePaneTab(current, tabId);
      });
    },
    [commitSidePaneState, platform, workspaceRemoteSessionId],
  );

  const handleReorderSidePaneTab = useCallback(
    (activeTabId: string, overTabId: string) => {
      commitSidePaneState((current) => reorderSidePaneTab(current, activeTabId, overTabId));
    },
    [commitSidePaneState],
  );

  const rememberClosedSidePaneTabs = useCallback((tabs: WorkspaceSidePaneTab[]) => {
    const restorableTabs = tabs.filter(
      (tab) => tab.type !== "selection-side-chat" && tab.type !== "browser-use",
    );
    if (restorableTabs.length === 0) {
      return;
    }

    const closedAt = Date.now();
    setAllRecentClosedSidePaneTabs((current) => {
      const closingIds = new Set(restorableTabs.map((tab) => tab.id));
      return [
        ...restorableTabs.map((tab) => ({ tab, closedAt })),
        ...current.filter((item) => !closingIds.has(item.tab.id)),
      ].slice(0, RECENT_CLOSED_SIDE_PANE_TAB_LIMIT);
    });
  }, []);

  const closeBrowserTabsWithAuthority = useCallback(
    async (tabs: readonly WorkspaceSidePaneTab[]): Promise<boolean> => {
      const browserTabs = tabs.filter(
        (tab) => tab.type === "browser" || tab.type === "browser-use",
      );
      if (browserTabs.length === 0) return true;
      if (!platform?.browserViewCloseTab) {
        // Desktop must have main delete the logical tab/recovery snapshot first; if the bridge is missing, do not remove only the UI shell,
        // or the closed tab will reappear after restart. Web has no guest authority and keeps its original local-close behavior.
        if (isDesktop) {
          logger.warn("[App] 关闭 Browser tab 时缺少 main authority");
          return false;
        }
        return true;
      }
      try {
        await Promise.all(
          browserTabs.map((tab) => {
            // Match the attachment path: human tabs fall back to workspaceRemoteSessionId; browser-use does not.
            // A mismatch causes scope failure → main rejects authorization → UI shell never removes the tab → tab cannot close.
            const scopedRemoteSessionId =
              tab.type === "browser-use"
                ? tab.remoteSessionId
                : (tab.remoteSessionId ?? workspaceRemoteSessionId);
            return platform.browserViewCloseTab!({
              tabId: tab.type === "browser-use" ? tab.tabId : tab.id,
              workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
              ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
              sessionId:
                tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
            });
          }),
        );
        return true;
      } catch (error) {
        logger.warn("[App] 关闭 Browser tab 的 main authority 失败", {
          error: error instanceof Error ? error.message : String(error),
          tabIds: browserTabs.map((tab) => (tab.type === "browser-use" ? tab.tabId : tab.id)),
        });
        return false;
      }
    },
    [isDesktop, platform, workspaceRemoteSessionId],
  );

  const handleCloseSidePaneTab = useCallback(
    (tabId: string) => {
      const closingTab = sidePaneState?.tabs.find((tab) => tab.id === tabId);
      if (closingTab?.type === "selection-side-chat") {
        closeSelectionSideChatRuntime(closingTab);
      }
      void closeBrowserTabsWithAuthority(closingTab ? [closingTab] : []).then((authorized) => {
        if (!authorized) return;
        if (closingTab) rememberClosedSidePaneTabs([closingTab]);
        // Keep-alive: explicitly closing a terminal tab must really release PTY/xterm (the registry persists and does not clean up on unmount).
        if (closingTab?.type === "terminal") {
          sidePaneTerminalSessionRegistry.release(tabId);
        }
        const next = commitSidePaneState((current) =>
          closeSidePaneTabForParent(
            current,
            tabId,
            activeTaskId,
            activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : null,
          ),
        );
        syncSidePaneCollapsedWithTabs(next);
        const activeTab = getActiveSidePaneTab(next);
        logger.info(
          `[App] 关闭右侧面板 tab=${tabId} mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
        );
      });
    },
    [
      activeTaskId,
      closeSelectionSideChatRuntime,
      closeBrowserTabsWithAuthority,
      commitSidePaneState,
      rememberClosedSidePaneTabs,
      sidePaneState?.tabs,
      syncSidePaneCollapsedWithTabs,
      workspaceAbsPath,
    ],
  );

  const handleCloseOtherSidePaneTabs = useCallback(
    (tabId: string) => {
      const visibleTabs =
        sidePaneState?.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, activeTaskId)) ?? [];
      const targetExists = visibleTabs.some((tab) => tab.id === tabId);
      const closingTabs = targetExists ? visibleTabs.filter((tab) => tab.id !== tabId) : [];
      void closeBrowserTabsWithAuthority(closingTabs).then((authorized) => {
        if (!authorized) return;
        for (const tab of closingTabs) {
          if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
        }
        // Keep-alive: when bulk-closing other tabs, release persistent PTY/xterm for any terminal tabs in the set.
        for (const tab of closingTabs) {
          if (tab.type === "terminal") {
            sidePaneTerminalSessionRegistry.release(tab.id);
          }
        }
        rememberClosedSidePaneTabs(closingTabs);
        commitSidePaneState((current) => {
          const next = closeVisibleOtherSidePaneTabs(current, tabId, activeTaskId);
          logger.info(
            `[App] 关闭其他右侧面板 tab=${tabId} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
          );
          return next;
        });
      });
    },
    [
      activeTaskId,
      closeSelectionSideChatRuntime,
      closeBrowserTabsWithAuthority,
      commitSidePaneState,
      rememberClosedSidePaneTabs,
      sidePaneState?.tabs,
      workspaceAbsPath,
    ],
  );

  const handleCloseAllSidePaneTabs = useCallback(() => {
    const visibleTabs =
      sidePaneState?.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, activeTaskId)) ?? [];
    void closeBrowserTabsWithAuthority(visibleTabs).then((authorized) => {
      if (!authorized) return;
      for (const tab of visibleTabs) {
        if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
      }
      // Keep-alive: when closing all tabs, release persistent PTY/xterm for any terminal tabs in the set.
      for (const tab of visibleTabs) {
        if (tab.type === "terminal") {
          sidePaneTerminalSessionRegistry.release(tab.id);
        }
      }
      rememberClosedSidePaneTabs(visibleTabs);
      commitSidePaneState((current) => {
        logger.info(`[App] 关闭全部右侧面板 tabs workspace=${workspaceAbsPath}`);
        const next = closeVisibleSidePaneTabs(current, activeTaskId);
        syncSidePaneCollapsedWithTabs(next);
        return next;
      });
    });
  }, [
    activeTaskId,
    closeSelectionSideChatRuntime,
    closeBrowserTabsWithAuthority,
    commitSidePaneState,
    rememberClosedSidePaneTabs,
    sidePaneState?.tabs,
    syncSidePaneCollapsedWithTabs,
    workspaceAbsPath,
  ]);

  const handleReopenClosedSidePaneTab = useCallback(
    (tabId: string) => {
      const item = allRecentClosedSidePaneTabs.find((entry) => entry.tab.id === tabId);
      if (!item || (isOfficeMode && (item.tab.type === "terminal" || item.tab.type === "git")))
        return;

      // When a tab from Recently Closed is reopened, also expand the right panel.
      // Otherwise the tab is restored while the user still sees a collapsed panel and may think the click did nothing.
      revealSidePaneForCurrentOwner();
      commitSidePaneState((sidePaneCurrent) => {
        let restoredTab = item.tab;
        if (item.tab.type === "browser") {
          const {
            residency: _residency,
            residencyGeneration: _residencyGeneration,
            ...browserTab
          } = item.tab;
          restoredTab = { ...browserTab, id: `browser:${createUuid()}` };
        }
        const next = restoreSidePaneTab(sidePaneCurrent, restoredTab);
        if (restoredTab.type === "subagent-session" || restoredTab.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(restoredTab.rootSessionId, restoredTab.id);
        }
        return next;
      });
      setAllRecentClosedSidePaneTabs((current) =>
        current.filter((entry) => entry.tab.id !== tabId),
      );
      logger.info(`[App] 重新打开最近关闭右侧面板 tab=${tabId} workspace=${workspaceAbsPath}`);
    },
    [
      isOfficeMode,
      allRecentClosedSidePaneTabs,
      commitSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
    ],
  );

  const handleBrowserNavigationRequestHandled = useCallback((requestId: string) => {
    setBrowserNavigationRequest((current) => (current?.id === requestId ? null : current));
  }, []);

  const handleBrowserPageMetadataChange = useCallback(
    (tabId: string, metadata: BrowserSidePaneMetadata) => {
      // Browser title/favicon come from webview events and must be written back by tab ID.
      // With multiple Browser tabs, storing one global metadata object would let a later page overwrite other tab titles.
      commitSidePaneState((current) => updateBrowserSidePaneTab(current, tabId, metadata));
    },
    [commitSidePaneState],
  );

  const recentClosedSidePaneTabs = useMemo(
    () =>
      allRecentClosedSidePaneTabs.filter(
        (item) =>
          isSidePaneTabVisibleForParent(item.tab, activeTaskId) &&
          (!isOfficeMode || (item.tab.type !== "terminal" && item.tab.type !== "git")),
      ),
    [activeTaskId, allRecentClosedSidePaneTabs, isOfficeMode],
  );

  return {
    // Office mode hides only the creation entry; filtering panel state would make open terminals/reviews disappear during a switch.
    isTerminalOpen,
    setIsTerminalOpen,
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    browserNavigationRequest,
    setBrowserNavigationRequest,
    // Callbacks
    handleOpenCodeViewer,
    handleOpenCodeViewers,
    handleOpenBrowserUrl,
    handleToggleBrowser,
    handleOpenBrowserTab,
    handleToggleGit,
    handleOpenGit,
    handleOpenTreemapping,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenTerminalTab,
    handleOpenModelTrajectory,
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
  };
}
