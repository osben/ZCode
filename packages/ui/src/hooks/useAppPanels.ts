import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { clearBrowserRecentVisitsForTask } from "@/store/browserRecentVisitsStore.js";

import { forgetWorkspaceConversation } from "@/v4/workspaceConnectionRegistry.js";
import type { IDisposable } from "@zcode/rpc";
import type {
  IWindowControllerService,
  IZCodeTaskService,
  WindowHostTasksRemovedSignal,
} from "@zcode/services";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  openFileManagerSidePane,
  navigateFileManagerSidePane,
  type FileManagerTarget,
} from "@/lib/workspaceSidePane.js";
/* eslint-disable max-lines */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BROWSER_VIEW_DRAFT_SESSION_ID, createUuid } from "@zcode/shared";
import type { EmbeddedBrowserOpenUrlRequest, IPlatformService } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
// Keep-alive: side pane terminals are lifted to a module-level registry across workspace sessions.
// Closing a terminal tab must explicitly release and kill the PTY so the resident registry leaves no orphan processes.
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import {
  buildTaskSidePaneMemoryKey,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import {
  ensureSidePaneTab,
  closeSidePaneTab,
  closeSidePaneTabForScope,
  closeSidePaneTabs,
  isSidePaneTabOwnedByTask,
  isSidePaneTabVisibleInScope,
  closeGitSidePane,
  closeCodeViewerSidePane,
  openWhiteboardSidePane,
  openModelTrajectorySidePane,
  openModelTrajectoryV2SidePane,
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
  activateExtensionViewSidePane,
  moveAppScopedExtensionViewTabs,
  activateExtensionLogsSidePane,
  activatePluginMarketSidePane,
  activateNewTabSidePane,
  openBrowserSidePane,
  openBrowserPermissionsSidePane,
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
  adoptDraftSidePaneTabs,
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
import {
  buildPluginUiSidePaneTabId,
  openPluginUiSidePane,
  usePluginUiPaneTarget,
} from "@/plugin-ui/index.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import type { ExtensionViewSidePaneTab } from "@/extension-slots/contract.js";
import { buildFileViewerTab, useFileViewerRouter } from "@/extension-slots/index.js";
import {
  matchOfficeViewerSurfaceRoute,
  queueOfficeViewerPendingOpen,
  resolveOfficeViewerDocumentPath,
} from "@/plugin-ui/officeViewerOpen.js";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { areWorkspaceFilePathsEqual } from "@/workspace-file-tree/model.js";
import { logger } from "@/logger.js";
import { getPathLeaf, joinFilePath, toFileUrl } from "@/lib/path.js";
import { shouldOpenWorkflowArtifactInBrowser } from "@/lib/workflowArtifactOpen.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { useModelTrajectoryOpenBridge } from "@/hooks/useModelTrajectoryOpenBridge.js";
import { useServices } from "@/hooks/useServices.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { clearSelectionSideChat } from "@/lib/selectionSideChatRuntime.js";
import { clearConversationSelectionReferenceScope } from "@/lib/conversationSelectionReference.js";
import {
  resolveWorkspaceServicesForTarget,
  useBaseWorkspaceServices,
} from "@/hooks/useWorkspaceServices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

/**
 * 任务归档或删除后的实时信号。桌面由 Window Host Controller 给出覆盖所有工作区的准确 taskIds；
 * Web 没有 Controller，退回当前工作区的 `task_archived` / `task_deleted` 事件。
 * 永久删除凭据会在监听注册后补发，不能依赖它与列表快照的先后顺序。
 */
function subscribeTasksRemoved(
  params: {
    windowControllerService?: IWindowControllerService;
    zcodeTaskService?: IZCodeTaskService;
    workspacePath: string;
    workspaceIdentity?: string;
  },
  listener: (signal: WindowHostTasksRemovedSignal) => void,
): IDisposable | undefined {
  if (params.windowControllerService) {
    return params.windowControllerService.onDynamicTasksRemovedSignal()(listener);
  }
  return params.zcodeTaskService?.onDynamicWorkspaceEvent({
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  })((event) => {
    if (
      event.type !== "workspace_task_list_changed" ||
      (event.reason !== "task_archived" && event.reason !== "task_deleted") ||
      !event.taskId
    ) {
      return;
    }
    listener({
      workspacePath: event.workspacePath,
      ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
      taskIds: [event.taskId],
    });
  });
}

export interface BrowserNavigationRequest {
  id: string;
  targetTabId: string;
  url: string;
}

function isAgentOpenedBrowserPopup(payload: EmbeddedBrowserOpenUrlRequest): boolean {
  // Human webviews use owner unclaimed-iab; legacy-iab and iab:<uuid> are both Agent-controlled
  // contexts. sourceTabId also prevents plain external/terminal links from being misjudged as model popups.
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
  /** Working directory for new terminal tabs; defaults to the workspace path (a worktree task passes its execution path). */
  terminalCwd?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
  activeTaskId: string | null;
  /** Stable id shared by draft and formal tasks; the isolation boundary for sidebar conversations. */
  sidePaneOwnerId: string | null;
  isDesktop?: boolean;
  /**
   * Display semantics: whether the view is currently presented to the user (false while the settings page covers it).
   * This hook deliberately does not consume it — Browser View events are authoritative forwards
   * from main, and the subscription must not depend on visibility; see the timing-constraint
   * comment on the subscription effect below.
   * The parameter is kept only as a regression guard: four useAppPanelsBrowserViewLifecycle cases
   * pass false to mean "settings page covering"; if someone writes visibility back into the
   * subscription condition, they fail immediately. Removing the parameter removes that protection too.
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
    | "browserViewPromoteDraftTabs"
  >;
}) {
  const {
    workspaceAbsPath,
    terminalCwd = workspaceAbsPath,
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
  const pluginUiTarget = usePluginUiPaneTarget({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: workspaceRemoteSessionId ?? undefined,
    sessionId: activeTaskId,
  });
  const pluginUiWorkspaceKey =
    pluginUiTarget.workspaceIdentity?.trim() || pluginUiTarget.workspacePath;
  const pluginUiScopeRef = useRef({
    pluginUiSessionId: pluginUiTarget.sessionId,
    pluginUiWorkspaceKey,
  });
  pluginUiScopeRef.current = { pluginUiSessionId: pluginUiTarget.sessionId, pluginUiWorkspaceKey };
  const services = useServices();
  const { zcodeAgentService, zcodeSessionService } = services;
  // 插件声明的文件查看器（file.viewer）：只在调用时读静态表，不随贡献表增量重渲染。
  const routeFileViewer = useFileViewerRouter({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
  const optionalPlatform = useOptionalPlatform();
  const { windowControllerService, zcodeTaskService } = useBaseWorkspaceServices();
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

  // Fix note: the terminal area was previously hard-coded at the bottom of <main>, mounting
  // Terminal as soon as the page loaded — taking height by default and creating a terminal
  // session immediately. Now an explicit switch, off by default; Terminal renders only after
  // the user clicks, so "terminal should not open by default" holds.
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  // Fix note: the right shared pane (browser / code-viewer) must be closed by default.
  // Otherwise entering a workspace pre-occupies the main conversation space, opposite to the
  // "expand only when the user actively views" expectation.
  const [sidePaneState, setSidePaneState] = useState<WorkspaceSidePaneState | null>(
    initialSidePaneMemoryState.sidePaneState,
  );
  const [isSidePaneCollapsed, setIsSidePaneCollapsedState] = useState(
    getSidePaneCollapsedPreference(initialSidePaneMemoryState, sidePaneOwnerId) ??
      initialSidePaneMemoryState.isSidePaneCollapsed,
  );
  // Interaction note: the sidebar show/hide button lives outside App, not inside Sidebar.
  // That way the entry stays in the top-left even when the sidebar is hidden — no "collapsed
  // with no way to expand again"; it also centrally handles the macOS traffic-light safe area
  // so the button never overlaps system window controls.
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
  const pendingDraftPromotionRef = useRef<string | null>(null);
  const draftPromotionTransportRef = useRef({ platform, workspaceRemoteSessionId });
  draftPromotionTransportRef.current = { platform, workspaceRemoteSessionId };
  const hasSyncedSidePaneScopeRef = useRef(false);
  const previousSidePaneScopeRef = useRef({
    workspaceKey: activeWorkspaceKey,
    ownerTaskId: sidePaneOwnerId,
  });
  const activeSidePaneMemoryKeyRef = useRef<string | null>(sidePaneMemoryKey);
  const latestSidePaneMemoryRef = useRef({
    sidePaneState,
    isSidePaneCollapsed,
  });
  latestSidePaneMemoryRef.current = {
    sidePaneState,
    isSidePaneCollapsed,
  };

  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    // Async operations like close may outlive an App remount; synchronously revoke the old instance so an old snapshot cannot overwrite the new one's tabs and collapse state.
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Collapse state feeds later decisions in the same event batch; keep a synced ref so pre-commit reads never see a stale value.
  const setIsSidePaneCollapsed = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    if (!mountedRef.current) return;
    const next =
      typeof value === "function"
        ? value(latestSidePaneMemoryRef.current.isSidePaneCollapsed)
        : value;
    latestSidePaneMemoryRef.current.isSidePaneCollapsed = next;
    saveTaskSidePaneMemoryState(activeSidePaneMemoryKeyRef.current, {
      isSidePaneCollapsed: next,
    });
    setIsSidePaneCollapsedState(next);
  }, []);

  const currentSidePaneScope = useCallback(
    () => ({
      workspaceKey: activeWorkspaceKeyRef.current,
      ownerTaskId: sidePaneOwnerIdRef.current,
      ...pluginUiScopeRef.current,
    }),
    [],
  );

  const revealSidePaneForCurrentOwner = useCallback(() => {
    setIsSidePaneCollapsed(false);
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      false,
    );
  }, []);

  const commitSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      if (!mountedRef.current) return latestSidePaneMemoryRef.current.sidePaneState;
      const next = updater(latestSidePaneMemoryRef.current.sidePaneState);
      // Closing the last tab must converge to the collapsed state; recreating an entry here
      // would make Cmd/Ctrl+W never finish closing. Create new-tab only on explicit expansion
      // of an empty pane; a background close must not re-expand the pane either.
      if (getVisibleSidePaneTabs(next?.tabs ?? [], currentSidePaneScope()).length === 0) {
        setIsSidePaneCollapsed(true);
      }
      // Ordinary sidebar interactions and BrowserView IPC can arrive adjacent within one React
      // batch. If only BrowserView updates synced the ref, a later concrete value would overwrite
      // a not-yet-committed open/activate/reorder update. All sidebar write entries commit the
      // canonical ref first, so interactions and lifecycle merge strictly in arrival order.
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        sidePaneState: next,
      };
      // On bridge replacement the new component renders before the old one cleans up; saving
      // only at unmount would let the new instance read old tabs, leaving live PTYs with no
      // entry. Writing to the existing memory at commit time makes a remount read the same
      // committed state.
      saveTaskSidePaneMemoryState(
        activeSidePaneMemoryKeyRef.current,
        latestSidePaneMemoryRef.current,
      );
      setSidePaneState(next);
      return next;
    },
    [currentSidePaneScope],
  );

  const commitOpenedSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      commitSidePaneState((current) => {
        const next = stampSidePaneTabsOwnership(updater(current), {
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
          remoteSessionId: workspaceRemoteSessionId ?? null,
        });
        const launcher = getActiveSidePaneTab(current);
        const opened = getActiveSidePaneTab(next);
        const scope = currentSidePaneScope();
        // A new-tab page replaced by content keeps its position; open events from the background
        // or another conversation must not consume the current entry. The plugin market keeps
        // its return entry and does not count as a tool launched inside a new-tab page.
        if (
          !next ||
          launcher?.type !== "new-tab" ||
          !opened ||
          opened.type === "new-tab" ||
          opened.type === "plugin-market" ||
          !isSidePaneTabVisibleInScope(launcher, scope) ||
          !isSidePaneTabVisibleInScope(opened, scope)
        )
          return next;
        const alreadyOpen = current?.tabs.some((tab) => tab.id === opened.id);
        return {
          ...next,
          tabs: alreadyOpen
            ? next.tabs.filter((tab) => tab.id !== launcher.id)
            : next.tabs.flatMap((tab) =>
                tab.id === launcher.id ? [opened] : tab.id === opened.id ? [] : [tab],
              ),
        };
      });
    },
    [commitSidePaneState, currentSidePaneScope, workspaceRemoteSessionId],
  );

  useEffect(() => {
    const previousKey = activeSidePaneMemoryKeyRef.current;
    if (previousKey === sidePaneMemoryKey) {
      return;
    }

    // Tabs/collapse state were saved at commit; switching only restores the target workspace and
    // never overwrites memory with the old component's snapshot. Switching tasks within one
    // workspace should not affect the side pane, so the key is no longer split by task.
    const restored = readTaskSidePaneMemoryState(sidePaneMemoryKey);
    // app 作用域的扩展视图标签（docs/plugins/extension-host.md §18.1 H5）跟着当前工作区走：
    // 从旧工作区的记录移走、接到新工作区，标签 id 不变，内容不卸载，实例不重建。
    const moved = moveAppScopedExtensionViewTabs(
      latestSidePaneMemoryRef.current.sidePaneState,
      restored.sidePaneState,
      activeWorkspaceKeyRef.current,
    );
    if (moved) {
      saveTaskSidePaneMemoryState(previousKey, { sidePaneState: moved.previous });
      logger.info(
        `[App] 右侧面板 app 视图标签随工作区移动 count=${(moved.next?.tabs.length ?? 0) - (restored.sidePaneState?.tabs.length ?? 0)}`,
      );
    }
    activeSidePaneMemoryKeyRef.current = sidePaneMemoryKey;
    const collapsed =
      getSidePaneCollapsedPreference(restored, sidePaneOwnerIdRef.current) ??
      restored.isSidePaneCollapsed;
    setIsSidePaneCollapsed(collapsed);
    commitSidePaneState(() => (moved ? moved.next : restored.sidePaneState));
  }, [commitSidePaneState, sidePaneMemoryKey]);

  const markSidePaneDraftPromotion = useCallback((sessionId: string) => {
    pendingDraftPromotionRef.current = sessionId;
  }, []);

  useEffect(() => {
    const previousScope = previousSidePaneScopeRef.current;
    previousSidePaneScopeRef.current = {
      workspaceKey: activeWorkspaceKey,
      ownerTaskId: sidePaneOwnerId,
    };
    // Bug 根因（MPS01）：草稿 runtime 的插件 session id 在草稿创建后约 1s 才到达，
    // 本 effect 因 pluginUiTarget 变化重跑时把它当成“重新进入草稿”，按默认规则收起了用户
    // 刚在草稿里打开的文件树。只有首次同步或 workspace/owner 变化才算进入 scope；
    // 草稿内仅插件 scope 变化时只重选活动 tab，展开/收起保持当前值。
    const enteredScope =
      !hasSyncedSidePaneScopeRef.current ||
      previousScope.ownerTaskId !== sidePaneOwnerId ||
      previousScope.workspaceKey !== activeWorkspaceKey;
    hasSyncedSidePaneScopeRef.current = true;
    const promotedSessionId = pendingDraftPromotionRef.current;
    if (previousScope.ownerTaskId !== sidePaneOwnerId) {
      pendingDraftPromotionRef.current = null;
    }
    // Bug 根因：草稿里打开的 tab 归属冻结为草稿，首发后 owner 切到新任务，这些 tab 不可见、
    // 侧栏随之收起，用户看到“发送就关掉浏览器”。只在草稿首发提交标记的那次 owner 变化里迁移。
    const adoptionSessionId =
      promotedSessionId !== null &&
      sidePaneOwnerId === promotedSessionId &&
      previousScope.ownerTaskId === null &&
      previousScope.workspaceKey === activeWorkspaceKey
        ? promotedSessionId
        : null;
    let adoptedTabs: WorkspaceSidePaneTab[] = [];
    const draftCollapsed = latestSidePaneMemoryRef.current.isSidePaneCollapsed;
    commitSidePaneState((current) => {
      let next = current;
      let draftPreferredTabId: string | undefined;
      if (adoptionSessionId) {
        const adopted = adoptDraftSidePaneTabs(current, {
          workspaceKey: activeWorkspaceKey,
          ownerTaskId: adoptionSessionId,
        });
        next = adopted.sidePaneState;
        adoptedTabs = adopted.adoptedTabs;
        draftPreferredTabId = activeTabByOwnerRef.current.get(`${activeWorkspaceKey}::__draft__`);
      }
      const scopeKey = `${activeWorkspaceKey}::${sidePaneOwnerId ?? "__draft__"}`;
      const preferredTabId =
        draftPreferredTabId ??
        activeTabByOwnerRef.current.get(scopeKey) ??
        (activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : undefined);
      // Bug 根因：首发迁移后固定写入“展开”偏好，新任务又没有自己的偏好，草稿里收起的 tab
      // 一发送就弹开。首发时新任务改为继承草稿当时的折叠态，有可见 tab 才写成新任务的偏好。
      const collapsedPreference = adoptionSessionId
        ? draftCollapsed
        : getSidePaneCollapsedPreference(
            readTaskSidePaneMemoryState(activeSidePaneMemoryKeyRef.current),
            sidePaneOwnerId,
          );
      const resolved = resolveSidePaneScopeState(
        next,
        {
          workspaceKey: activeWorkspaceKey,
          ownerTaskId: sidePaneOwnerId,
          ...pluginUiScopeRef.current,
        },
        preferredTabId,
        collapsedPreference,
      );
      if (adoptionSessionId && resolved.sidePaneState?.activeTabId) {
        saveTaskSidePaneCollapsedPreference(
          activeSidePaneMemoryKeyRef.current,
          sidePaneOwnerId,
          draftCollapsed,
        );
      }
      // 只豁免“草稿默认收起”这一条：其余情况（无可见 tab、插件面板、已有任务）仍按 resolved。
      const activeTab = getActiveSidePaneTab(resolved.sidePaneState);
      const keepDraftCollapsed =
        !enteredScope &&
        sidePaneOwnerId === null &&
        Boolean(resolved.sidePaneState?.activeTabId) &&
        activeTab?.type !== "plugin-ui";
      const isSidePaneCollapsed = keepDraftCollapsed
        ? latestSidePaneMemoryRef.current.isSidePaneCollapsed
        : resolved.isSidePaneCollapsed;
      setIsSidePaneCollapsed(isSidePaneCollapsed);
      logger.debug("[App] 同步对话右侧面板 scope", {
        activeTabId: resolved.sidePaneState?.activeTabId ?? null,
        activeTaskId,
        adoptedDraftTabIds: adoptedTabs.map((tab) => tab.id),
        enteredScope,
        isSidePaneCollapsed,
        ownerTaskId: sidePaneOwnerId,
        preferredTabId: preferredTabId ?? null,
        workspaceKey: activeWorkspaceKey,
      });
      return resolved.sidePaneState;
    });
    const transport = draftPromotionTransportRef.current;
    const promoteDraftTabs = transport.platform?.browserViewPromoteDraftTabs;
    if (!adoptionSessionId || !promoteDraftTabs) return;
    // main 的 human tab owner 在 attach 时冻结为 unscoped；必须在新 sessionId 的 attach/residency
    // 发出前升级，否则 session-mismatch 会让 tab 关不掉。同一 frame 的 IPC 按序处理。
    for (const tab of adoptedTabs) {
      if (tab.type !== "browser") continue;
      const remoteSessionId =
        tab.remoteSessionId ?? transport.workspaceRemoteSessionId ?? undefined;
      void promoteDraftTabs({
        tabIds: [tab.id],
        workspaceKey: tab.workspaceKey ?? activeWorkspaceKey,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId: adoptionSessionId,
      }).catch((error: unknown) => {
        logger.warn("[App] 草稿浏览器标签升级 owner 失败", {
          error: error instanceof Error ? error.message : String(error),
          from: BROWSER_VIEW_DRAFT_SESSION_ID,
          sessionId: adoptionSessionId,
          tabId: tab.id,
        });
      });
    }
  }, [
    activeTaskId,
    activeWorkspaceKey,
    commitSidePaneState,
    sidePaneOwnerId,
    pluginUiTarget.sessionId,
    pluginUiWorkspaceKey,
  ]);

  const pendingFileManagerTarget = useOptionalTabStore((state) => state.pendingFileManagerTarget);
  const requestFileManager = useOptionalTabStore((state) => state.requestFileManager);
  const consumeFileManager = useOptionalTabStore((state) => state.consumeFileManager);
  const handleOpenFileManager = useCallback(
    (target?: FileManagerTarget) => {
      if (
        target &&
        !target.temporaryExternalDirectory &&
        (target.workspaceIdentity?.trim() || target.workspacePath) !== activeWorkspaceKeyRef.current
      ) {
        requestFileManager(target);
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openFileManagerSidePane(
          current,
          target ?? {
            workspacePath: workspaceAbsPath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
          },
        ),
      );
    },
    [
      requestFileManager,
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    ],
  );

  useEffect(() => {
    if (!pendingFileManagerTarget) return;
    const targetKey =
      pendingFileManagerTarget.workspaceIdentity?.trim() || pendingFileManagerTarget.workspacePath;
    if (targetKey !== activeWorkspaceKey) return;
    // Must be consumed after this hook restores the target workspace's pane memory and owner; a child Shell effect must not write into the old bucket first.
    if (!consumeFileManager(pendingFileManagerTarget)) return;
    logger.debug("[FileManager] 在目标工作区打开目录", {
      workspaceKey: targetKey,
      ownerTaskId: sidePaneOwnerIdRef.current,
    });
    handleOpenFileManager(pendingFileManagerTarget);
  }, [pendingFileManagerTarget, activeWorkspaceKey, consumeFileManager, handleOpenFileManager]);

  // 扩展视图标签（docs/plugins/extension-host.md §8、§16.5）：启动页条目、能力 views.open 与
  // file.viewer 的 view 查看器共用这一个入口。
  const handleOpenExtensionView = useCallback(
    (tab: ExtensionViewSidePaneTab) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => activateExtensionViewSidePane(current, tab));
      logger.info(`[App] 打开右侧面板 mode=extension-view view=${tab.viewId}`);
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  // 扩展日志标签（docs/plugins/extension-host.md §16.8）：启动页「扩展日志」一行与命令中心共用。
  const handleOpenExtensionLogs = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState(activateExtensionLogsSidePane);
    logger.info("[App] 打开右侧面板 mode=extension-logs");
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner]);

  /**
   * `.xlsx` 分流：内置查看面板可用时改开 spreadsheets 面板 tab 并注入待开文档，
   * 能力门不过或后续失败时经 fallback 回到 Preview Pane 旧链路（docs/ui/office-file-preview.md 入口路由）。
   * 插件查看器（file.viewer，docs/plugins/extension-host.md §16.5）排在 `.xlsx` 常量之后、内置预览之前：
   * view 打开每个文件一个扩展视图标签；surface 沿用下面同一个面板流程（open_document）。
   * 返回 true 表示本次打开已被接管；同步门通过即接管，异步失败才调 fallback。
   */
  const routeOfficeViewerFile = useCallback(
    (source: CodeViewerSource, fallback: () => void): boolean => {
      if (source.type !== "file" || !source.path) return false;
      // 1. 内置 `.xlsx` 常量先查，行为不变；2. 再查插件声明。
      const officeRoute = matchOfficeViewerSurfaceRoute(source.path);
      const pluginRoute = officeRoute ? null : routeFileViewer(source.path);
      if (!officeRoute && !pluginRoute) return false;
      const sessionId = pluginUiTarget.sessionId;
      const bridge = services.pluginUiBridgeService;
      // source 自带归属优先：文件链接可指向其他 workspace，旧链路按 source 归属读取文件；
      // 面板与其 MCP server、pane session 都绑定当前工作区，source 属于其他 workspace
      // （哪怕本地）时无法正确寻址，必须回退旧链路，不能把外部路径映射进当前工作区。
      // 身份继承语义对齐旧链路（AnimatedSidePanePanel 的 code-viewer services 解析）：
      // source 显式带工作区根时身份不继承当前工作区——身份可选，缺失时以根路径为身份；
      // 否则身份缺失的跨工作区 source 会通过归属检查，把别的根下的同名文件映射进当前工作区。
      const sourceHasOwnWorkspace = source.workspacePath !== undefined;
      const sourceWorkspaceIdentity = sourceHasOwnWorkspace
        ? source.workspaceIdentity
        : (source.workspaceIdentity ?? workspaceIdentity);
      const sourceRemoteSessionId = source.workspaceRemoteSessionId ?? workspaceRemoteSessionId;
      const sourceWorkspaceKey =
        sourceWorkspaceIdentity?.trim() || (source.workspacePath ?? workspaceAbsPath);
      const shellWorkspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
      const sourceInLocalShellWorkspace =
        (!source.workspacePath ||
          areWorkspaceFilePathsEqual(source.workspacePath, workspaceAbsPath)) &&
        sourceWorkspaceKey === shellWorkspaceKey &&
        !sourceRemoteSessionId &&
        !workspaceRemoteSessionId &&
        !isRemoteWorkspaceIdentity(sourceWorkspaceIdentity ?? "");
      // 插件查看器只对本机工作区的文件生效（§16.5）；view 查看器不需要会话。
      if (!sourceInLocalShellWorkspace || !optionalPlatform?.pluginSandbox) return false;
      // 严格相对化：工作区外 / 越界路径返回 null 并回退，绝不退化成文件名
      //（open_document 以当前工作区为根解析，文件名会静默打开同名的另一份文件）。
      const relativePath = resolveOfficeViewerDocumentPath({
        workspacePath: source.workspacePath ?? workspaceAbsPath,
        filePath: source.path,
      });
      if (!relativePath) return false;
      if (pluginRoute?.target.kind === "view") {
        if (!pluginRoute.view) return false;
        logger.lifecycle.info("[extension-slots] file viewer routed", {
          itemId: pluginRoute.itemId,
          target: "view",
          path: relativePath,
        });
        handleOpenExtensionView(
          buildFileViewerTab(pluginRoute.view, {
            path: relativePath,
            workspace: {
              workspacePath: workspaceAbsPath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
            },
          }),
        );
        return true;
      }
      const route = officeRoute ?? {
        pluginId: pluginRoute!.pluginId,
        surfaceId: pluginRoute!.target.id,
      };
      if (!sessionId || !bridge) return false;
      if (pluginRoute) {
        logger.lifecycle.info("[extension-slots] file viewer routed", {
          itemId: pluginRoute.itemId,
          target: "surface",
          path: relativePath,
        });
      }
      void (async () => {
        try {
          const surfaces = await bridge.listSurfaces({
            workspacePath: workspaceAbsPath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          });
          const surface =
            surfaces.find(
              (item) => item.pluginId === route.pluginId && item.id === route.surfaceId,
            ) ?? null;
          if (!surface) throw new Error(`office viewer surface not found: ${route.surfaceId}`);
          const request: OpenPluginUiSideTabRequest = {
            parentSessionId: sessionId,
            surfaceId: surface.id,
            serverName: surface.server,
            pluginId: surface.pluginId,
            resourceUri: surface.resourceUri,
            instanceId: `file:${relativePath}`,
            title: source.title || getPathLeaf(source.path),
            workspacePath: workspaceAbsPath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            remoteSessionId: workspaceRemoteSessionId ?? null,
          };
          // 每个文件一个实例 tab：不同文件并存互不覆盖，同一文件按确定的 tab id 去重聚焦。
          revealSidePaneForCurrentOwner();
          commitOpenedSidePaneState((current) =>
            openPluginUiSidePane(current, {
              ...request,
              workspaceKey: workspaceIdentity?.trim() || workspaceAbsPath,
            }),
          );
          logger.debug("[App] 打开 office 查看面板并加载文件", {
            surfaceId: surface.id,
            path: source.path,
            workspaceKey: workspaceIdentity?.trim() || workspaceAbsPath,
          });
          queueOfficeViewerPendingOpen({
            tabId: buildPluginUiSidePaneTabId(request),
            relativePath,
            source,
            onFallback: fallback,
          });
        } catch (error) {
          logger.warn("[office-viewer] 分流到查看面板失败，回退 Preview Pane 预览", {
            path: source.path,
            message: error instanceof Error ? error.message : String(error),
          });
          fallback();
        }
      })();
      return true;
    },
    [
      commitOpenedSidePaneState,
      handleOpenExtensionView,
      optionalPlatform,
      pluginUiTarget.sessionId,
      revealSidePaneForCurrentOwner,
      routeFileViewer,
      services,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    ],
  );

  const handleNavigateFileManager = useCallback(
    (tabId: string, source: CodeViewerSource) => {
      // 文件树在 file-manager tab 内点击 .xlsx 时改开查看面板 tab，本 tab 的预览区不动。
      const fallback = () =>
        commitSidePaneState((current) => navigateFileManagerSidePane(current, tabId, source));
      if (routeOfficeViewerFile(source, fallback)) return;
      fallback();
    },
    [commitSidePaneState, routeOfficeViewerFile],
  );

  const handleOpenCodeViewer = useCallback(
    (source: CodeViewerSource) => {
      const fallback = () => {
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
      };
      if (routeOfficeViewerFile(source, fallback)) return;
      fallback();
    },
    [
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      routeOfficeViewerFile,
      workspaceAbsPath,
    ],
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
        // Web has no embedded browser pane; fall back to a new browser tab so the link is at least reachable.
        window.open(payload.url, "_blank", "noopener,noreferrer");
        return;
      }

      // Interaction note: the message area only throws the "open this URL" intent; the actual
      // webview navigation, URL validation, and pane visibility stay centrally owned by the browser pane.
      const isShareUrl = /^https?:\/\/[^/]+\/(?:cn\/)?share\/[^/]+$/u.test(payload.url);
      const targetTabId = `browser:${createUuid()}`;
      // When an Agent-controlled guest triggers a popup, the new page still belongs to the
      // model's operation chain; it must not be treated as a human-opened Browser tab
      // inheriting the free-size/zoom preference saved in setting.json.
      const agentOpened = isAgentOpenedBrowserPopup(payload);
      // webview popup events used to carry only the URL, so a late event from conversation 1
      // got taken over by conversation 2's owner. Keep the source scope, and steal focus only
      // when the source is still the current owner.
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
              // Both paths already have an owner; remoteSessionId is not borrowed from the current UI and must be frozen at creation.
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
      // Capability boundary: Web/mobile do not support Electron webview today; no Browser side pane is created.
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
      if (!closingActiveBrowser) {
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
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenBrowserTab = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // Capability boundary: Web/mobile do not support Electron webview today; no Browser side pane is created.
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

  const handleOpenBrowserPermissionSettings = useCallback(
    (origin: string) => {
      if (!supportsEmbeddedBrowser) return;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openBrowserPermissionsSidePane(current, {
          origin,
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
        }),
      );
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, supportsEmbeddedBrowser],
  );

  // The Browser View events below are all authoritative forwards from main;
  // isWorkspaceVisible (= !isSettingsTabActive) must not gate the subscription. The settings
  // page is an overlay — App does not unmount, but the flag flips false, and after effect
  // cleanup unsubscribes, main's events fall into a black hole: losing ready makes
  // waitForGuest time out after 10s and delete the tab via closeTabDurably, so leaving the
  // settings page shows an empty side pane. Visibility only says "show it to the user now";
  // it must not decide "receive authoritative events or not" — focus stealing is still
  // decided by shouldReveal's scope matching, hence no isWorkspaceVisible dependency here.
  useEffect(() => {
    if (!supportsEmbeddedBrowser || !isDesktop || !platform?.onOpenBrowserUrl) {
      return;
    }

    return platform.onOpenBrowserUrl((request) => {
      // target=_blank/window.open inside a webview used to be either swallowed by the popup
      // policy or handed to Electron's default BrowserWindow creation. Main now intercepts and
      // validates the URL; the renderer only lands the approved request into a right-side
      // Browser tab of the currently visible workspace.
      logger.info(
        `[App] webview 请求打开右侧浏览器 tab workspace=${workspaceAbsPath} url=${request.url} disposition=${request.disposition}`,
      );
      handleOpenBrowserUrl(request);
    });
  }, [handleOpenBrowserUrl, isDesktop, platform, supportsEmbeddedBrowser, workspaceAbsPath]);

  // Browser Use events carry the workspace/session frozen at creation; late events only mount in the background and must not steal the current conversation's focus.
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
      // Browser commands scale with message flow; no info logs in production.
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
          // Visibility scales like browser commands; ignoring late events logs at debug only to avoid churning production disk.
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

      // Side pane state is stored per workspace; searching only the "currently active
      // workspace" misses targets. When the Agent closes a tab the user may have already
      // switched workspaces, the notification would be silently dropped, and the original
      // workspace's persisted state keeps the tab — switching back, its main-side logical tab
      // no longer exists, × cannot close it, a ghost tab. With the owner scope on the
      // notification, route by workspaceKey to delete from the right workspace's memory
      // directly. Route by workspaceKey only, no session filter: main has already ruled the
      // tab closed, so the renderer shell should converge whichever task it belongs to; tabId
      // is globally unique, so no cross-workspace misdeletion.
      const targetWorkspaceKey = payload.workspaceKey;
      if (targetWorkspaceKey && targetWorkspaceKey !== activeSidePaneMemoryKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(targetWorkspaceKey);
        const targetId = findTargetId(stored.sidePaneState);
        if (!targetId) return;
        const nextState = closeSidePaneTab(stored.sidePaneState, targetId);
        saveTaskSidePaneMemoryState(targetWorkspaceKey, {
          sidePaneState: nextState,
          isSidePaneCollapsed: stored.isSidePaneCollapsed,
        });
        return;
      }

      commitSidePaneState((current) => {
        const targetId = findTargetId(current);
        if (!targetId) return current;
        return closeSidePaneTabForScope(current, targetId, currentSidePaneScope());
      });
    });
  }, [commitSidePaneState, currentSidePaneScope, isDesktop, platform]);

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
      if (!closingActiveGit) {
        revealSidePaneForCurrentOwner();
      }
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 切换右侧面板 mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const next = activateGitSidePane(current);
      // The file-change lookup only needs "make sure the Git pane is open"; it cannot reuse
      // toggle. If already on the Git tab, toggle would close it, so switching to a
      // file-change scope would show nothing.
      revealSidePaneForCurrentOwner();
      logger.info(
        `[App] 打开右侧面板 mode=git workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenTreemapping = useCallback(
    (source?: TreemappingSidePaneTab["source"]) => {
      // Treemapping currently needs to stay hidden from the sidebar. Keep the callback shape
      // for message-chain compatibility, but create no side pane tab so the header or old
      // entries cannot bypass the menu hiding.
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

  const handleOpenNewSidePaneTab = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState(activateNewTabSidePane);
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner]);

  const handleOpenPluginMarket = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState(activatePluginMarketSidePane);
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner]);

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
        cwd: terminalCwd,
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
    terminalCwd,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenModelTrajectory = useCallback(
    (params: { taskId: string; title?: string | null; kind?: "v1" | "v2" }) => {
      if (!params.taskId) {
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        // An absent kind means v1; v1 and v2 dedupe by their own tab ids, so both can be open for one task.
        const next =
          params.kind === "v2"
            ? openModelTrajectoryV2SidePane(current, params)
            : openModelTrajectorySidePane(current, params);
        logger.info(
          `[App] 打开右侧面板 mode=model-trajectory${params.kind === "v2" ? "-v2" : ""} workspace=${workspaceAbsPath} taskId=${params.taskId} tabs=${next.tabs.length}`,
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
      // Invalidated tabs from branch edit/retry are projection cleanup, not "recently closed".
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

  const handleOpenPluginUi = useCallback(
    (request: OpenPluginUiSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openPluginUiSidePane(current, { ...request, workspaceKey }),
      );
      logger.debug("[App] 打开插件 UI 右侧 tab", {
        parentSessionId: request.parentSessionId,
        toolCallId: request.toolCallId,
        pluginId: request.pluginId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenWorkflowRun = useCallback(
    (request: OpenScopedWorkflowRunSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      // The in-place replacement after "Configure" is not an open: a collapsed pane stays collapsed.
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
   * A browser tab reused by URL (the landing spot for direct html-artifact opens).
   *
   * Three differences from `handleOpenBrowserUrl`:
   * 1. The target is claimed by URL instead of opening fresh each time; 2. on an existing-tab
   * hit a navigation request is **still** sent — the webview sits on old bytes and
   * `initialUrl` did not change, so the mount-time navigation will not run again
   * (UnifiedBrowserView's `lastAppliedInitialUrlRef` dedupes by URL) and v2 would never show;
   * 3. ownership is given by the caller and **always activates** — this path is only triggered
   * by user artifact clicks, with no `isCurrentOwner`-style background mounting (see the
   * comment at ownerTaskId below).
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
      // Like the artifact tab, only set the current collapse state without persisting a
      // preference: ownership writes params.ownerTaskId, while revealSidePaneForCurrentOwner
      // records false under the **current** owner — on that hub path the two are not the same
      // party yet.
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openOrActivateBrowserSidePaneByUrl(current, {
          initialUrl: params.url,
          tabId: targetTabId,
          // Ownership is frozen explicitly, not stamped with the current owner by
          // stampSidePaneTabsOwnership: the hub's artifact chip calls handleSelectTaskInChat
          // then handleOpenWorkflowArtifact, and within that same synchronous block
          // sidePaneOwnerIdRef still points at the previous conversation. Browser tab
          // visibility narrows by ownerTaskId (isSidePaneTabVisibleInScope's default branch);
          // stamped wrong, the tab stays invisible once the switch settles. The artifact tab
          // is immune because it narrows by parentSessionId.
          ownerTaskId: params.ownerTaskId,
          workspaceKey: params.workspaceKey,
        }),
      );
      return targetTabId;
    },
    [commitOpenedSidePaneState],
  );

  /**
   * The **single** landing-spot arbiter for artifact clicks: html with a working embedded
   * browser opens the page directly; everything else opens an artifact tab.
   *
   * What direct open lacks is `sourcePath`: the run side panel has it (it already joined the
   * journal), the pill summary deliberately omits it (state-frame size, see
   * `workflowRunArtifactSummarySchema`). When absent, look up the journal once here. Query
   * failure, an old CLI without this query, or an artifact with no provenance at all — every
   * path falls back to the artifact tab; a click never lands nowhere.
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
        // A workspace-relative sourcePath joined with workspacePath is the real local location;
        // same path as the artifact card's "open in browser" (WorkflowArtifactSidePane's localSourcePath).
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
          // The guard already ensured a local workspace (no workspaceIdentity / remoteSessionId);
          // pass only workspacePath here.
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
    (
      tab: Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }>,
      sessionService = zcodeSessionService,
    ) => {
      clearSelectionSideChat(tab.childSessionId);
      clearConversationSelectionReferenceScope(tab.childSessionId, tab.workspaceKey);
      void sessionService
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
    const subscription = subscribeTasksRemoved(
      {
        windowControllerService,
        zcodeTaskService,
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
      },
      (signal) => {
        if (signal.permanentlyDeleted) {
          logger.debug("[archive-management] 同步永久删除清理", {
            count: signal.taskIds.length,
            workspaceIdentity: signal.workspaceIdentity,
          });
          for (const taskId of signal.taskIds) {
            if (signal.permanentlyDeleted) {
              clearBrowserRecentVisitsForTask(
                signal.workspaceIdentity?.trim() || signal.workspacePath,
                taskId,
              );
            }
            useZCodeSessionStore
              .getState()
              .removeTaskState(signal.workspacePath, taskId, signal.workspaceIdentity);
            forgetWorkspaceConversation(signal, taskId);
          }
        }
        // 归档 / 删除后任务离开列表，它名下的 tab 再没有 scope 能显示，残留后无法从 UI 关闭。
        // Browser / browser-use 由 main 关闭 guest 并经 BrowserViewCloseTab 移除壳，这里只关其余 tab。
        const workspaceKey = signal.workspaceIdentity?.trim() || signal.workspacePath;
        const isClosing = (tab: WorkspaceSidePaneTab) =>
          tab.type !== "browser" &&
          tab.type !== "browser-use" &&
          signal.taskIds.some((taskId) => isSidePaneTabOwnedByTask(tab, workspaceKey, taskId));
        // Bug 根因：信号覆盖窗口内所有工作区，当前 Provider 的 session service 属于正在显示的工作区；
        // 用它关闭其他工作区（可能在远端 Host）的侧边聊天子 session 会发错 Host，runtime 泄漏。按信号的工作区解析。
        const { baseServices, sessionsById } = useRemoteWorkspaceSessionStore.getState();
        const signalSessionService = resolveWorkspaceServicesForTarget({
          currentContextServices: services,
          resolvedRemoteSessionId: signal.remoteSessionId ?? null,
          baseServices,
          sessionsById,
          isRemoteTarget: Boolean(signal.remoteSessionId),
        }).zcodeSessionService;
        const releaseRuntimes = (tabs: WorkspaceSidePaneTab[]) => {
          for (const tab of tabs) {
            if (tab.type === "selection-side-chat") {
              closeSelectionSideChatRuntime(tab, signalSessionService);
            }
            if (tab.type === "terminal") sidePaneTerminalSessionRegistry.release(tab.id);
          }
        };
        for (const taskId of signal.taskIds) {
          clearConversationSelectionReferenceScope(taskId, workspaceKey);
        }

        if (workspaceKey !== activeSidePaneMemoryKeyRef.current) {
          const stored = readTaskSidePaneMemoryState(workspaceKey);
          const closingTabs = stored.sidePaneState?.tabs.filter(isClosing) ?? [];
          if (closingTabs.length === 0) return;
          releaseRuntimes(closingTabs);
          saveTaskSidePaneMemoryState(workspaceKey, {
            sidePaneState: closingTabs.reduce<WorkspaceSidePaneState | null>(
              (state, tab) => closeSidePaneTab(state, tab.id),
              stored.sidePaneState,
            ),
            isSidePaneCollapsed: stored.isSidePaneCollapsed,
          });
        } else {
          const closingTabs =
            latestSidePaneMemoryRef.current.sidePaneState?.tabs.filter(isClosing) ?? [];
          if (closingTabs.length === 0) return;
          releaseRuntimes(closingTabs);
          const closingIds = closingTabs.map((tab) => tab.id);
          commitSidePaneState((current) =>
            closeSidePaneTabs(current, closingIds, currentSidePaneScope()),
          );
        }
        logger.info("[App] 任务归档或删除，关闭其右侧面板标签", {
          taskIds: signal.taskIds,
          workspaceKey,
        });
      },
    );
    return () => subscription?.dispose();
  }, [
    closeSelectionSideChatRuntime,
    commitSidePaneState,
    currentSidePaneScope,
    services,
    windowControllerService,
    workspaceAbsPath,
    workspaceIdentity,
    zcodeTaskService,
  ]);

  // Subscribe to "open model call trajectory" requests: deep-menu entries fire through the singleton store; consume here after matching workspaceKey.
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
    const nextCollapsed = !latestSidePaneMemoryRef.current.isSidePaneCollapsed;
    setIsSidePaneCollapsed(nextCollapsed);
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      nextCollapsed,
    );
    // Commit together with show/hide in the same interaction, avoiding showing a special empty state before an effect recreates a tab.
    if (!nextCollapsed)
      commitSidePaneState((current) => ensureSidePaneTab(current, currentSidePaneScope()));
    logger.info(
      `[App] ${nextCollapsed ? "收起" : "展开"}右侧面板 workspace=${workspaceAbsPath} tabs=${latestSidePaneMemoryRef.current.sidePaneState?.tabs.length ?? 0}`,
    );
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  const handleCloseCodeViewer = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=code-viewer workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeCodeViewerSidePane(current);
      return next;
    });
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  const handleCloseGit = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=git workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeGitSidePane(current);
      return next;
    });
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

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
        // The human tab's attach side freezes the owner with
        // `tab.remoteSessionId ?? workspaceRemoteSessionId` fallback; this must use the same
        // source, or existing tabs that did not freeze the field at creation mismatch scope and
        // never restore when clicked. The browser-use attach side has no such fallback; adding
        // one there would cause a reverse mismatch — hence the per-type distinction.
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
      (tab) =>
        tab.type !== "selection-side-chat" && tab.type !== "browser-use" && tab.type !== "new-tab",
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
        // On Desktop, main must delete the logical tab/recovery snapshot first; when the bridge
        // is missing, removing only the UI shell would resurrect closed tabs after restart. Web
        // has no guest authority and keeps its original local close semantics.
        if (isDesktop) {
          logger.warn("[App] 关闭 Browser tab 时缺少 main authority");
          return false;
        }
        return true;
      }
      try {
        await Promise.all(
          browserTabs.map((tab) => {
            // Same source as the attach side: human tabs fall back to workspaceRemoteSessionId, browser-use does not.
            // Mismatched sources → scope mismatch → main refuses authorization → UI shell never removed → tab unclosable.
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

  const closeSelectedSidePaneTabs = useCallback(
    async (closingTabs: WorkspaceSidePaneTab[], preferredTabId?: string) => {
      if (closingTabs.length === 0) return;
      const scope = currentSidePaneScope();
      if (!(await closeBrowserTabsWithAuthority(closingTabs))) return;
      for (const tab of closingTabs) {
        if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
        if (tab.type === "terminal") sidePaneTerminalSessionRegistry.release(tab.id);
      }
      rememberClosedSidePaneTabs(closingTabs);
      const closingIds = closingTabs.map((tab) => tab.id);
      // Bug cause: while main confirms the close, the conversation/workspace may switch or a new
      // tab may appear. Ownership and the close target are frozen at click time and written back
      // to the original registry when done; the current visible scope and active tab resolve at
      // completion. After the original instance unmounts, the ref no longer represents the
      // current tab; the close still completes, but the originally selected tab is deleted only
      // from the latest memory.
      if (!mountedRef.current || scope.workspaceKey !== activeWorkspaceKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(scope.workspaceKey);
        const next = closeSidePaneTabs(stored.sidePaneState, closingIds, scope, preferredTabId);
        saveTaskSidePaneMemoryState(scope.workspaceKey, {
          sidePaneState: next,
          isSidePaneCollapsed: stored.isSidePaneCollapsed,
        });
      } else {
        const liveScope = currentSidePaneScope();
        commitSidePaneState((current) =>
          closeSidePaneTabs(
            current,
            closingIds,
            liveScope,
            liveScope.ownerTaskId === scope.ownerTaskId
              ? (preferredTabId ??
                  (liveScope.ownerTaskId
                    ? lastActiveSubagentTabByRootRef.current.get(liveScope.ownerTaskId)
                    : null))
              : undefined,
          ),
        );
      }
      logger.info("[App] 关闭右侧面板标签", { tabIds: closingIds, ...scope });
    },
    [
      closeBrowserTabsWithAuthority,
      closeSelectionSideChatRuntime,
      commitSidePaneState,
      currentSidePaneScope,
      rememberClosedSidePaneTabs,
    ],
  );

  const visibleSidePaneTabs = useCallback(
    () =>
      getVisibleSidePaneTabs(
        latestSidePaneMemoryRef.current.sidePaneState?.tabs ?? [],
        currentSidePaneScope(),
      ),
    [currentSidePaneScope],
  );

  const handleCloseSidePaneTab = useCallback(
    (tabId: string) => {
      void closeSelectedSidePaneTabs(visibleSidePaneTabs().filter((tab) => tab.id === tabId));
    },
    [closeSelectedSidePaneTabs, visibleSidePaneTabs],
  );

  const handleCloseOtherSidePaneTabs = useCallback(
    (tabId: string) => {
      const tabs = visibleSidePaneTabs();
      if (!tabs.some((tab) => tab.id === tabId)) return;
      void closeSelectedSidePaneTabs(
        tabs.filter((tab) => tab.id !== tabId),
        tabId,
      );
    },
    [closeSelectedSidePaneTabs, visibleSidePaneTabs],
  );

  const handleCloseAllSidePaneTabs = useCallback(() => {
    void closeSelectedSidePaneTabs(visibleSidePaneTabs());
  }, [closeSelectedSidePaneTabs, visibleSidePaneTabs]);

  const handleReopenClosedSidePaneTab = useCallback(
    (tabId: string) => {
      const item = allRecentClosedSidePaneTabs.find((entry) => entry.tab.id === tabId);
      if (
        !item ||
        !isSidePaneTabVisibleInScope(item.tab, currentSidePaneScope()) ||
        (isOfficeMode && (item.tab.type === "terminal" || item.tab.type === "git"))
      )
        return;

      // Interaction note: reopening a tab from the recently-closed list must also expand the right pane.
      // Otherwise the tab state is restored but the user still sees a collapsed pane and thinks the click did nothing.
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
      currentSidePaneScope,
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
      // Interaction note: a Browser tab's title/favicon come from webview events and must be written back per tab id.
      // With multiple Browser tabs, a single global metadata entry would let later-loaded pages overwrite other tabs' titles.
      commitSidePaneState((current) => updateBrowserSidePaneTab(current, tabId, metadata));
    },
    [commitSidePaneState],
  );

  const recentClosedSidePaneTabs = useMemo(
    () =>
      allRecentClosedSidePaneTabs.filter(
        (item) =>
          isSidePaneTabVisibleInScope(item.tab, {
            workspaceKey: activeWorkspaceKey,
            ownerTaskId: sidePaneOwnerId,
          }) &&
          (!isOfficeMode || (item.tab.type !== "terminal" && item.tab.type !== "git")),
      ),
    [activeWorkspaceKey, sidePaneOwnerId, allRecentClosedSidePaneTabs, isOfficeMode],
  );

  return {
    // Office mode hides only the new-entry points; filtering pane state would make open terminals and reviews vanish on mode switch.
    isTerminalOpen,
    markSidePaneDraftPromotion,
    setIsTerminalOpen,
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    browserNavigationRequest,
    setBrowserNavigationRequest,
    handleOpenFileManager,
    handleNavigateFileManager,
    // Callbacks
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
    handleOpenExtensionView,
    handleOpenExtensionLogs,
    handleOpenPluginMarket,
    handleOpenNewSidePaneTab,
    handleOpenTerminalTab,
    handleOpenModelTrajectory,
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
  };
}
