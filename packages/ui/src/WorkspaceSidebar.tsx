/* eslint-disable max-lines -- The archived-view toggle follows the existing sidebar structure, so keep it in the same file for now. */
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Archive,
  Blocks,
  CalendarClock,
  Clock3,
  Cloud,
  Folder,
  FolderOpen,
  Hash,
  ListFilter,
  Maximize2,
  MessageCircleCheck,
  MessageCirclePlus,
  Minimize2,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { WORKSPACE_ICON_COLOR_CLASS } from "@/lib/workspaceDisplayColors.js";
import {
  selectWorkspaceDisplayEntry,
  useWorkspaceDisplayStore,
} from "@/store/workspaceDisplayStore.js";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { RemoteTarget, UserInfo, ZCodeTaskMeta } from "@zcode/shared";
import { BUILTIN_MODEL_PROVIDER_IDS, isLocale } from "@zcode/shared";
import {
  TID_CONVERSATION_NEW_TASK,
  TID_CONVERSATION_SECTION,
  TID_AUTOMATIONS_OPEN,
  TID_PROJECT_ADD,
  TID_PROJECT_SECTION,
  TID_SIDEBAR,
  TID_WORKSPACE_LIST,
  TID_WORKSPACE_PIN_DIVIDER,
} from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly, isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useWorkspaceTaskLists } from "@/hooks/useWorkspaceTaskLists.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import {
  persistSidebarTaskPreferences,
  readSidebarTaskPreferences,
  type SidebarTaskOrganizeBy,
  type SidebarTaskSortBy,
} from "@/lib/sidebarTaskPreferences.js";
import {
  persistSidebarPurposeSectionPreferences,
  readSidebarPurposeSectionPreferences,
  reorderSidebarPurposeSections,
} from "@/lib/sidebarPurposeSectionPreferences.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  increaseWorkspaceTaskVisibleLimit,
  resolveVisibleWorkspaceTaskKeys,
  retainWorkspaceTaskVisibleLimits,
  WORKSPACE_TASK_PAGE_SIZE,
  type WorkspaceTaskVisibleLimitByKey,
} from "@/lib/workspaceTaskPagination.js";
import { partitionWorkspaceTabsByPurpose } from "@/lib/workspacePurpose.js";
import {
  areAllGroupedTaskGroupsExpanded,
  pruneCollapsedGroupedTaskGroupIds,
} from "@/workspace-grouped-tasks/shared.js";
import {
  persistGroupedTaskCollapsedGroupIds,
  readGroupedTaskCollapsedGroupIds,
} from "@/lib/groupedTaskExpansionPreference.js";
import type { Theme } from "@/useTheme.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";
import { WorkspaceArchivedTasksFlatSection } from "@/WorkspaceArchivedTasksFlatSection.js";
import { WebRemoteControlTaskIndex } from "@/WebRemoteControlTaskIndex.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { SidebarBottomActivity } from "@/sidebar-activity/SidebarBottomActivity.js";
import { WorkspacePinnedTasksSection } from "@/WorkspacePinnedTasksSection.js";
import { WorkspaceTimelineTasksSection } from "@/WorkspaceTimelineTasksSection.js";
import { WorkspaceGroupedTasksSection } from "@/WorkspaceGroupedTasksSection.js";
import { BranchMergeStatusProbes } from "@/BranchMergeStatusProbes.js";
import { StickyGroupHeaderSlot } from "@/workspace-grouped-tasks/sticky-group-header-slot.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";
import {
  SortableWorkspaceSidebarItem,
  restrictVerticalDragWithinContainer,
} from "./SortableWorkspaceSidebar.js";
import {
  resolveSidebarTaskGroupTogglePresentation,
  type SidebarTaskGroupTogglePresentation,
} from "@/WorkspaceSidebar/taskGroupTogglePresentation.js";
import { WorkspacePurposeSection } from "@/WorkspaceSidebar/WorkspacePurposeSection.js";
import { cn } from "@/components/lib/utils.js";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import {
  resolveWorkspaceDragGlobalIndices,
  resolveWorkspaceDragExpanded,
  workspaceVerticalListSortingStrategy,
} from "@/lib/workspaceSidebarDrag.js";
import {
  isWorkspaceDragAcrossPinnedBoundary,
  orderWorkspaceTabsByPinned,
} from "@/lib/workspacePinPreference.js";
import { createPortal } from "react-dom";

function WorkspaceNewTaskTooltip({
  children,
  disabledReason,
}: {
  children: ReactNode;
  disabledReason?: string;
}) {
  // In the normal state, the button already shows “New task” and its shortcut, so a tooltip would be redundant; explain only when disabled.
  if (!disabledReason) return children;
  return (
    <ControlHintTooltip title={disabledReason}>
      <div>{children}</div>
    </ControlHintTooltip>
  );
}
export { applyWorkspaceTriggerSelection } from "@/WorkspaceSidebar/workspaceSidebarSelection.js";
export { WorkspaceSidebarCollapsedRail } from "@/WorkspaceSidebar/WorkspaceSidebarCollapsedRail.js";

type TaskOrganizeBy = SidebarTaskOrganizeBy;
type TaskSortBy = SidebarTaskSortBy;
type PrimaryTaskMode = "workspace" | "grouped";
type SidebarTaskViewMode = "grouped" | "workspace" | "timeline" | "archived";

interface SidebarFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
  executionWorktreePath?: string;
}

// Streaming task events frequently refresh the sidebar parent; when there are no task groups, passing a new []
// makes the memoized workspace row misread taskItems as changed and triggers TaskList/TaskListItem rerenders.
const EMPTY_WORKSPACE_TASK_ITEMS: ZCodeTaskMeta[] = [];
// WorkspaceSidebar is memoized, and the {} default parameter creates a new reference on every call;
// when there is no remote reconnection log, reuse the same object so the default value does not defeat shallow comparison.
const EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY: Record<
  string,
  RemoteConnectionLogEntry[]
> = {};

function WorkspaceDragOverlay({ tab, width }: { tab: WorkspaceTabState; width: number | null }) {
  const isRemote = Boolean(tab.remoteSessionId || tab.remoteTarget || tab.workspaceIdentity);
  const workspaceDisplayEntry = useWorkspaceDisplayStore((state) =>
    selectWorkspaceDisplayEntry(state, tab.workspacePath, tab.workspaceIdentity),
  );
  const displayLabel = workspaceDisplayEntry?.displayName?.trim() || tab.label;
  const overlayIconClass = workspaceDisplayEntry?.color
    ? WORKSPACE_ICON_COLOR_CLASS[workspaceDisplayEntry.color]
    : "text-foreground-subtle";
  return (
    <div
      data-testid="workspace-drag-overlay"
      className="pointer-events-none flex cursor-grabbing items-center rounded-lg border border-border bg-background text-ui-base text-foreground shadow-lg h-8 px-2.5 gap-2 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0"
      style={width ? { width } : undefined}
    >
      {/* Bugfix: The project-list icon is inside a Button, where the button SVG rule sets it to 14px at runtime;
          after moving into an overlay outside the Button it no longer inherits that rule, so set the same size explicitly to prevent the preview icon from growing. */}
      {isRemote ? (
        <Cloud className={cn("size-3.5 shrink-0", overlayIconClass)} />
      ) : (
        <Folder className={cn("size-3.5 shrink-0", overlayIconClass)} />
      )}
      <span className="min-w-0 flex-1 truncate px-1">{displayLabel}</span>
    </div>
  );
}

export interface SidebarFileTreeOpenRequest {
  id: number;
  target: SidebarFileTreeTarget;
}

function resolveSidebarTaskViewMode(params: {
  showArchivedTasks: boolean;
  taskOrganizeBy: TaskOrganizeBy;
}): SidebarTaskViewMode {
  if (params.showArchivedTasks) {
    return "archived";
  }
  if (params.taskOrganizeBy === "chronological") {
    return "timeline";
  }
  if (params.taskOrganizeBy === "grouped") {
    return "grouped";
  }
  return "workspace";
}

export const WorkspaceSidebar = memo(function WorkspaceSidebarComponent({
  workspacePath,
  workspaceRemoteSessionId,
  activePreviewPath,
  onSelectTask,
  onStartDraftInWorkspace,
  onOpenCodeViewer,
  onOpenBrowserUrl,
  fileTreeOpenRequest,
  onCreateTask,
  onCreateConversationTask,
  onOpenFolderFromWorkspaceMenu,
  onOpenRemoteWorkspace,
  webRemoteControlWorkspaceSwitcher,
  theme,
  onConnectRemote: _onConnectRemote,
  onSelectRemoteProject: _onSelectRemoteProject,
  onCancelRemoteProject: _onCancelRemoteProject,
  onReconnectRemoteWorkspace,
  onLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey = EMPTY_RECONNECTING_REMOTE_WORKSPACE_LOGS_BY_WORKSPACE_KEY,
  isDesktop = false,
  isWebRemoteControl = false,
  isMacDesktop: _isMacDesktop = false,
  isWindowsDesktop = false,
  isSidebarVisible = true,
  onToggleSidebar: _onToggleSidebar,
  toggleSidebarShortcutLabel: _toggleSidebarShortcutLabel,
  canGoBack: _canGoBack = false,
  canGoForward: _canGoForward = false,
  onGoBack: _onGoBack,
  onGoForward: _onGoForward,
  goBackShortcutLabel: _goBackShortcutLabel,
  goForwardShortcutLabel: _goForwardShortcutLabel,
  onOpenCommandCenter,
  onOpenAutomations,
  onOpenPluginStore,
  automationsActive = false,
  pluginStoreActive = false,
  onFileTreeOpenChange,
  onWebRemoteTaskOpen,
  onWebRemoteTaskSwitchingChange,
}: {
  workspacePath: string;
  workspaceRemoteSessionId?: string;
  activePreviewPath?: string | null;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    targetRemoteSessionId?: string,
    expectedUnreadAt?: number,
    options?: { readOnly?: boolean; selectionSideChat?: boolean },
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenBrowserUrl?: (url: string) => void;
  fileTreeOpenRequest?: SidebarFileTreeOpenRequest | null;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask: () => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: () => void;
  webRemoteControlWorkspaceSwitcher?: import("@/root/types.js").WebRemoteControlWorkspaceSwitcherApi;
  theme: Theme;
  onConnectRemote: (options: RemoteTarget, requestId?: string) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onLogout?: () => void;
  onLogin?: () => void;
  user?: UserInfo | null;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey?: Record<string, RemoteConnectionLogEntry[]>;
  isDesktop?: boolean;
  isWebRemoteControl?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isSidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  toggleSidebarShortcutLabel?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  goBackShortcutLabel?: string;
  goForwardShortcutLabel?: string;
  onOpenCommandCenter: () => void;
  onOpenAutomations?: () => void;
  onOpenPluginStore?: () => void;
  automationsActive?: boolean;
  pluginStoreActive?: boolean;
  onFileTreeOpenChange?: (open: boolean) => void;
  onWebRemoteTaskOpen?: (options: { crossWorkspace: boolean }) => void;
  onWebRemoteTaskSwitchingChange?: (switching: boolean) => void;
}) {
  const { intl, localePreference, setLocalePreference } = useZCodeIntl();
  const handleTaskRowSelect = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentity?: string,
      expectedUnreadAt?: number,
      options?: { readOnly?: boolean; selectionSideChat?: boolean },
    ) => {
      // The Shell’s fourth argument is the remote-session route, so a task row’s unreadAt must not reuse that position.
      // Leave remoteSessionId explicitly empty for sidebar row selection, then pass the unread version shown to the user to the mark-read transaction.
      onSelectTask(
        targetWorkspacePath,
        taskId,
        targetWorkspaceIdentity,
        undefined,
        expectedUnreadAt,
        options,
      );
    },
    [onSelectTask],
  );
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const webRemoteControlFeatureEnabled = useWebRemoteControlFeatureEnabled();
  const bumpTaskListVersion = useZCodeSessionStore((state) => state.bumpTaskListVersion);
  const workspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspacePath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const workspaceReadOnly = useTabStore((state) =>
    isWorkspaceReadOnly(state, workspacePath, workspaceIdentity),
  );
  const workspaceReadOnlyReason = workspaceReadOnly
    ? intl.formatMessage({
        id: "workspaceSidebar.unavailableLocalDirectory",
      })
    : undefined;
  const setTheme = useZCodeStore((state) => state.setTheme);
  const commandCenterShortcutLabel = useShortcutCommandLabel("openCommandCenter");
  const tabs = useTabStore((state) => state.tabs);
  const activateTab = useTabStore((state) => state.activateTab);
  const closeTab = useTabStore((state) => state.closeTab);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const expandedWorkspacePaths = useTabStore((state) => state.expandedWorkspacePaths);
  const toggleWorkspaceExpanded = useTabStore((state) => state.toggleWorkspaceExpanded);
  const reorderWorkspaceTabs = useTabStore((state) => state.reorderWorkspaceTabs);
  const expandAllWorkspaceTabs = useTabStore((state) => state.expandAllWorkspaceTabs);
  const collapseAllWorkspaceTabs = useTabStore((state) => state.collapseAllWorkspaceTabs);

  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const { conversationWorkspaceTabs, projectWorkspaceTabs } = useMemo(
    () => partitionWorkspaceTabsByPurpose(workspaceTabs),
    [workspaceTabs],
  );
  const workspacePaths = useMemo(
    () => projectWorkspaceTabs.map((tab) => tab.workspacePath),
    [projectWorkspaceTabs],
  );
  const areAllWorkspaceGroupsExpanded = useMemo(
    () =>
      workspacePaths.length > 0 && workspacePaths.every((path) => expandedWorkspacePaths.has(path)),
    [expandedWorkspacePaths, workspacePaths],
  );
  const [showArchivedTasks, setShowArchivedTasks] = useState(false);
  const [archivedActionsContainer, setArchivedActionsContainer] = useState<HTMLDivElement | null>(
    null,
  );
  const [isFileTreeOpen, setIsFileTreeOpen] = useState(false);
  const [fileTreeTarget, setFileTreeTarget] = useState<SidebarFileTreeTarget | null>(null);
  const [groupedStickyHeader, setGroupedStickyHeader] = useState<ReactNode | null>(null);
  const [taskOrganizeBy, setTaskOrganizeBy] = useState<TaskOrganizeBy>(
    () => readSidebarTaskPreferences().organizeBy,
  );
  const [taskSortBy, setTaskSortBy] = useState<TaskSortBy>(
    () => readSidebarTaskPreferences().sortBy,
  );
  const [purposeSectionPreferences, setPurposeSectionPreferences] = useState(
    readSidebarPurposeSectionPreferences,
  );
  const [workspaceTaskOrganizeBy, setWorkspaceTaskOrganizeBy] = useState<
    Extract<TaskOrganizeBy, "project" | "chronological">
  >(() => {
    const initialOrganizeBy = readSidebarTaskPreferences().organizeBy;
    return initialOrganizeBy === "chronological" ? "chronological" : "project";
  });
  const [workspaceTaskVisibleLimitByKey, setWorkspaceTaskVisibleLimitByKey] =
    useState<WorkspaceTaskVisibleLimitByKey>({});
  const [activeWorkspaceDragId, setActiveWorkspaceDragId] = useState<string | null>(null);
  const [activeWorkspaceDragWidth, setActiveWorkspaceDragWidth] = useState<number | null>(null);
  const baseServices = useBaseWorkspaceServices();
  const [pinnedWorkspaceKeys, setPinnedWorkspaceKeys] = useState<Set<string>>(() => new Set());
  const [pinnedWorkspaceKeysLoaded, setPinnedWorkspaceKeysLoaded] = useState(false);
  const pinMutationStateByWorkspaceKey = useRef(
    new Map<string, { confirmedPinned: boolean; requestVersion: number; pending: Promise<void> }>(),
  );
  useEffect(() => {
    let cancelled = false;
    setPinnedWorkspaceKeysLoaded(false);
    setPinnedWorkspaceKeys(new Set());
    pinMutationStateByWorkspaceKey.current.clear();
    baseServices.zcodeTaskService
      .listPinnedWorkspaceKeys()
      .then((keys) => {
        if (!cancelled) {
          pinMutationStateByWorkspaceKey.current = new Map(
            keys.map((key) => [
              key,
              { confirmedPinned: true, requestVersion: 0, pending: Promise.resolve() },
            ]),
          );
          setPinnedWorkspaceKeys(new Set(keys));
          setPinnedWorkspaceKeysLoaded(true);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          pinMutationStateByWorkspaceKey.current.clear();
          setPinnedWorkspaceKeysLoaded(true);
          logger.warn("[WorkspaceSidebar] failed to load pinned workspaces", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [baseServices]);
  const pinnedProjectTabIds = useMemo(
    () =>
      new Set(
        projectWorkspaceTabs
          .filter((tab) =>
            pinnedWorkspaceKeys.has(
              buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
            ),
          )
          .map((tab) => tab.id),
      ),
    [pinnedWorkspaceKeys, projectWorkspaceTabs],
  );
  const orderedProjectWorkspaceTabs = useMemo(
    () => orderWorkspaceTabsByPinned(projectWorkspaceTabs, pinnedProjectTabIds),
    [pinnedProjectTabIds, projectWorkspaceTabs],
  );
  const handleOpenSessionManagerFromSidebar = useCallback(
    (scope: { workspacePath: string; workspaceIdentity?: string }) => {
      // Sessions management is a Settings section now; the project menu deep-links it scoped.
      setPendingSettingsSectionIntent("sessions", { sessionsScope: scope });
      openSettingsTab();
    },
    [openSettingsTab],
  );

  const handleToggleWorkspacePinned = useCallback(
    (workspaceKey: string, pinned: boolean) => {
      if (!pinnedWorkspaceKeysLoaded) return;
      const mutations = pinMutationStateByWorkspaceKey.current;
      const mutation = mutations.get(workspaceKey) ?? {
        confirmedPinned: false,
        requestVersion: 0,
        pending: Promise.resolve(),
      };
      const requestVersion = ++mutation.requestVersion;
      mutations.set(workspaceKey, mutation);
      setPinnedWorkspaceKeys((current) => {
        const next = new Set(current);
        if (pinned) next.add(workspaceKey);
        else next.delete(workspaceKey);
        return next;
      });
      mutation.pending = mutation.pending
        .then(() => baseServices.zcodeTaskService.setWorkspacePinned({ workspaceKey, pinned }))
        .then(
          () => {
            mutation.confirmedPinned = pinned;
          },
          () => {
            if (mutation.requestVersion === requestVersion) {
              setPinnedWorkspaceKeys((current) => {
                const next = new Set(current);
                if (mutation.confirmedPinned) next.add(workspaceKey);
                else next.delete(workspaceKey);
                return next;
              });
            }
            toast(intl.formatMessage({ id: "workspaceSidebar.pinFailed" }));
          },
        );
    },
    [baseServices, intl, pinnedWorkspaceKeysLoaded],
  );
  const [webRemoteCollapsedWorkspaceKeys, setWebRemoteCollapsedWorkspaceKeys] = useState<
    Set<string>
  >(() => new Set());
  const [webRemoteWorkspaceGroupKeys, setWebRemoteWorkspaceGroupKeys] = useState<string[]>([]);
  const [webRemoteWorkspaceGroupKeysHydrated, setWebRemoteWorkspaceGroupKeysHydrated] =
    useState(false);
  const [lastNonEmptyWebRemoteWorkspaceGroupKeys, setLastNonEmptyWebRemoteWorkspaceGroupKeys] =
    useState<string[]>([]);
  const [webRemoteWorkspaceGroupSnapshotHasGroups, setWebRemoteWorkspaceGroupSnapshotHasGroups] =
    useState<boolean | null>(null);
  const [groupedTaskGroupIds, setGroupedTaskGroupIds] = useState<string[]>([]);
  const [groupedTaskGroupIdsHydrated, setGroupedTaskGroupIdsHydrated] = useState(false);
  const [lastNonEmptyGroupedTaskGroupIds, setLastNonEmptyGroupedTaskGroupIds] = useState<string[]>(
    [],
  );
  const [groupedTaskGroupSnapshotHasGroups, setGroupedTaskGroupSnapshotHasGroups] = useState<
    boolean | null
  >(null);
  const [collapsedGroupedTaskGroupIds, setCollapsedGroupedTaskGroupIds] = useState<Set<string>>(
    () => readGroupedTaskCollapsedGroupIds(),
  );
  const handleProjectSectionOpenChange = useCallback((projectsExpanded: boolean) => {
    setPurposeSectionPreferences((current) => {
      if (current.projectsExpanded === projectsExpanded) {
        return current;
      }
      const next = { ...current, projectsExpanded };
      persistSidebarPurposeSectionPreferences(next);
      return next;
    });
  }, []);
  const handleConversationSectionOpenChange = useCallback((conversationsExpanded: boolean) => {
    setPurposeSectionPreferences((current) => {
      if (current.conversationsExpanded === conversationsExpanded) {
        return current;
      }
      const next = { ...current, conversationsExpanded };
      persistSidebarPurposeSectionPreferences(next);
      return next;
    });
  }, []);
  const handlePurposeSectionDragEnd = useCallback((event: DragEndEvent) => {
    if (!event.over) {
      return;
    }

    setPurposeSectionPreferences((current) => {
      const sectionOrder = reorderSidebarPurposeSections(
        current.sectionOrder,
        String(event.active.id),
        String(event.over?.id),
      );
      if (sectionOrder.every((sectionId, index) => sectionId === current.sectionOrder[index])) {
        return current;
      }

      const next = { ...current, sectionOrder };
      persistSidebarPurposeSectionPreferences(next);
      return next;
    });
  }, []);
  const primaryTaskTabsListRef = useRef<HTMLDivElement | null>(null);
  const primaryTaskTabTriggerRefs = useRef<Record<PrimaryTaskMode, HTMLButtonElement | null>>({
    workspace: null,
    grouped: null,
  });
  const [primaryTaskIndicatorStyle, setPrimaryTaskIndicatorStyle] = useState<CSSProperties>({
    opacity: 0,
    transform: "translateX(0px)",
    width: 0,
  });
  const lastStableTaskGroupTogglePresentationRef =
    useRef<SidebarTaskGroupTogglePresentation | null>(null);
  const handleCollapsedGroupedTaskGroupIdsChange = useCallback(
    (updater: SetStateAction<Set<string>>) => {
      setCollapsedGroupedTaskGroupIds((currentGroupIds) => {
        const nextGroupIds = typeof updater === "function" ? updater(currentGroupIds) : updater;
        if (nextGroupIds === currentGroupIds) {
          return currentGroupIds;
        }
        // Grouped expansion state is a local user preference and cannot live only in React memory.
        // Single-group clicks, bulk buttons, and restoration after temporary collapse for dragging must all sync to localStorage.
        persistGroupedTaskCollapsedGroupIds(nextGroupIds);
        return nextGroupIds;
      });
    },
    [],
  );
  const handleGroupedTaskGroupIdsChange = useCallback(
    (nextGroupIds: string[]) => {
      if (
        nextGroupIds.length === 0 &&
        !groupedTaskGroupIdsHydrated &&
        groupedTaskGroupSnapshotHasGroups !== false &&
        (lastNonEmptyGroupedTaskGroupIds.length > 0 || collapsedGroupedTaskGroupIds.size > 0)
      ) {
        // When switching from Project back to Group or entering Group for the first time after restart,
        // the sublist’s first frame may arrive before the sqlite view loads and return empty groupIds.
        // Do not treat this transient empty snapshot as “all groups deleted,” or the user’s collapsed-state preferences
        // will be pruned to empty and written back to localStorage.
        return;
      }

      setGroupedTaskGroupIdsHydrated(true);
      setGroupedTaskGroupSnapshotHasGroups(nextGroupIds.length > 0);
      if (nextGroupIds.length > 0) {
        setLastNonEmptyGroupedTaskGroupIds(nextGroupIds);
      }
      setGroupedTaskGroupIds((currentGroupIds) =>
        currentGroupIds.length === nextGroupIds.length &&
        currentGroupIds.every((groupId, index) => groupId === nextGroupIds[index])
          ? currentGroupIds
          : nextGroupIds,
      );
      setCollapsedGroupedTaskGroupIds((currentGroupIds) => {
        const nextCollapsedGroupIds = pruneCollapsedGroupedTaskGroupIds(
          currentGroupIds,
          nextGroupIds,
        );
        if (
          nextCollapsedGroupIds.size === currentGroupIds.size &&
          [...nextCollapsedGroupIds].every((groupId) => currentGroupIds.has(groupId))
        ) {
          return currentGroupIds;
        }
        // Restore grouped expansion state from localStorage after refresh or restart;
        // when the view refreshes, also clear stale collapsed-state records for deleted groups so a new group does not match an old state.
        persistGroupedTaskCollapsedGroupIds(nextCollapsedGroupIds);
        return nextCollapsedGroupIds;
      });
    },
    [
      groupedTaskGroupIdsHydrated,
      groupedTaskGroupSnapshotHasGroups,
      collapsedGroupedTaskGroupIds.size,
      lastNonEmptyGroupedTaskGroupIds.length,
    ],
  );
  const handleWebRemoteWorkspaceGroupKeysChange = useCallback((nextGroupKeys: string[]) => {
    setWebRemoteWorkspaceGroupKeysHydrated(true);
    setWebRemoteWorkspaceGroupSnapshotHasGroups(nextGroupKeys.length > 0);
    if (nextGroupKeys.length > 0) {
      setLastNonEmptyWebRemoteWorkspaceGroupKeys(nextGroupKeys);
    }
    setWebRemoteWorkspaceGroupKeys((currentGroupKeys) =>
      currentGroupKeys.length === nextGroupKeys.length &&
      currentGroupKeys.every((groupKey, index) => groupKey === nextGroupKeys[index])
        ? currentGroupKeys
        : nextGroupKeys,
    );
    setWebRemoteCollapsedWorkspaceKeys((currentGroupKeys) => {
      const nextGroupKeySet = new Set(nextGroupKeys);
      const nextCollapsedGroupKeys = new Set(
        [...currentGroupKeys].filter((groupKey) => nextGroupKeySet.has(groupKey)),
      );
      if (
        nextCollapsedGroupKeys.size === currentGroupKeys.size &&
        [...nextCollapsedGroupKeys].every((groupKey) => currentGroupKeys.has(groupKey))
      ) {
        return currentGroupKeys;
      }
      return nextCollapsedGroupKeys;
    });
  }, []);

  useEffect(() => {
    if (!fileTreeOpenRequest) {
      return;
    }
    setFileTreeTarget(fileTreeOpenRequest.target);
    setIsFileTreeOpen(true);
  }, [fileTreeOpenRequest]);
  useEffect(() => {
    onFileTreeOpenChange?.(isFileTreeOpen);
  }, [isFileTreeOpen, onFileTreeOpenChange]);
  useEffect(() => {
    return () => onFileTreeOpenChange?.(false);
  }, [onFileTreeOpenChange]);
  useEffect(() => {
    persistSidebarTaskPreferences({
      organizeBy: taskOrganizeBy,
      sortBy: taskSortBy,
    });
  }, [taskOrganizeBy, taskSortBy]);
  useEffect(() => {
    if (taskOrganizeBy === "project" || taskOrganizeBy === "chronological") {
      setWorkspaceTaskOrganizeBy(taskOrganizeBy);
    }
  }, [taskOrganizeBy]);
  const isWebRemoteControlSidebar = Boolean(
    webRemoteControlWorkspaceSwitcher || isWebRemoteControl,
  );
  const taskViewMode = resolveSidebarTaskViewMode({
    showArchivedTasks,
    taskOrganizeBy,
  });
  const effectiveTaskViewMode =
    isWebRemoteControlSidebar && taskViewMode === "grouped" ? "workspace" : taskViewMode;
  const visibleWorkspaceTaskKeys = useMemo(
    () =>
      resolveVisibleWorkspaceTaskKeys({
        enabled:
          !isWebRemoteControlSidebar &&
          effectiveTaskViewMode === "workspace" &&
          purposeSectionPreferences.projectsExpanded,
        expandedWorkspacePaths,
        workspaces: projectWorkspaceTabs,
      }),
    [
      effectiveTaskViewMode,
      expandedWorkspacePaths,
      isWebRemoteControlSidebar,
      projectWorkspaceTabs,
      purposeSectionPreferences.projectsExpanded,
    ],
  );
  useEffect(() => {
    // Interaction rule: Pagination progress belongs only to the currently visible, expanded workspace.
    // Collapse one group, the project section, or all groups; switch views; or remove a workspace — all clear through the same visible set,
    // avoiding omissions from separate reset logic in each collapse entry point.
    setWorkspaceTaskVisibleLimitByKey((current) =>
      retainWorkspaceTaskVisibleLimits(current, visibleWorkspaceTaskKeys),
    );
  }, [visibleWorkspaceTaskKeys]);
  useEffect(() => {
    if (taskViewMode !== "grouped") {
      setGroupedStickyHeader(null);
    }
  }, [taskViewMode]);
  useEffect(() => {
    if (!isWebRemoteControlSidebar || effectiveTaskViewMode !== "workspace") {
      return;
    }
    setWebRemoteWorkspaceGroupKeysHydrated(false);
  }, [effectiveTaskViewMode, isWebRemoteControlSidebar]);
  const [createGroupedTaskGroupAction, setCreateGroupedTaskGroupAction] = useState<
    (() => void) | null
  >(null);
  const [createGroupedTaskDraftAction, setCreateGroupedTaskDraftAction] = useState<
    (() => void) | null
  >(null);
  const handleCreateGroupActionChange = useCallback((action: (() => void) | null) => {
    setCreateGroupedTaskGroupAction(() => action);
  }, []);
  const handleCreateDraftTaskActionChange = useCallback((action: (() => void) | null) => {
    setCreateGroupedTaskDraftAction(() => action);
  }, []);
  const shouldShowPinnedTasks =
    !isWebRemoteControlSidebar &&
    (taskViewMode === "workspace" ||
      taskViewMode === "timeline" ||
      taskViewMode === "archived" ||
      // Bugfix: the grouped body filters pinned tasks. If the global pinned section is not shown on
      // the same page, pinning the current task from the Header leaves its row nowhere to render,
      // making the session look deleted.
      taskViewMode === "grouped");
  const workspaceScrollRef = useRef<HTMLDivElement | null>(null);
  const [showWorkspaceTopMask, setShowWorkspaceTopMask] = useState(false);
  const [showWorkspaceBottomMask, setShowWorkspaceBottomMask] = useState(false);
  const workspaceSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const purposeSectionSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const localeMenuValue = localePreference === "system" ? "system" : localePreference;
  const workspaceTaskLists = useWorkspaceTaskLists({
    workspaceTabs: projectWorkspaceTabs,
    activeWorkspacePath: workspacePath,
    activeWorkspaceIdentity: workspaceIdentity,
    sortBy: taskSortBy,
    visibleLimitByWorkspaceKey: workspaceTaskVisibleLimitByKey,
    defaultVisibleLimit: WORKSPACE_TASK_PAGE_SIZE,
  });
  const webRemoteControlStatus = useWebRemoteControlStatus({
    enabled: isDesktop && webRemoteControlFeatureEnabled,
  });
  const mobileActiveTaskKey = useMemo(() => {
    const mobileViewState = webRemoteControlStatus.mobileViewState;
    if (
      !webRemoteControlStatus.mobileConnected ||
      !mobileViewState?.activeWorkspaceKey ||
      !mobileViewState.activeTaskId
    ) {
      return null;
    }

    // Bugfix: main has saved the current task from mobile, but the desktop task list was not
    // subscribed to that state. Combine taskId with workspaceKey, which follows workspaceIdentity
    // semantics, so remote workspaces are not incorrectly matched by path.
    return `${mobileViewState.activeWorkspaceKey}:${mobileViewState.activeTaskId}`;
  }, [webRemoteControlStatus.mobileConnected, webRemoteControlStatus.mobileViewState]);
  const workspaceTaskGroupByKey = useMemo(
    () =>
      new Map(
        workspaceTaskLists.groups.map((group) => [
          buildTaskWorkspaceKey(group.workspacePath, group.workspaceIdentity),
          group,
        ]),
      ),
    [workspaceTaskLists.groups],
  );
  const handleShowMoreWorkspaceTasks = useCallback((workspaceKey: string) => {
    setWorkspaceTaskVisibleLimitByKey((current) =>
      increaseWorkspaceTaskVisibleLimit(current, workspaceKey),
    );
  }, []);
  const handleOpenWorkspaceFileTree = useCallback((target: SidebarFileTreeTarget) => {
    setFileTreeTarget(target);
    setIsFileTreeOpen(true);
  }, []);
  const mobileMissingTaskRefreshRef = useRef<string | null>(null);
  useEffect(() => {
    const mobileViewState = webRemoteControlStatus.mobileViewState;
    const mobileWorkspaceKey = mobileViewState?.activeWorkspaceKey?.trim() ?? "";
    const mobileTaskId = mobileViewState?.activeTaskId?.trim() ?? "";
    if (!webRemoteControlStatus.mobileConnected || !mobileWorkspaceKey || !mobileTaskId) {
      mobileMissingTaskRefreshRef.current = null;
      return;
    }

    const taskGroup = workspaceTaskGroupByKey.get(mobileWorkspaceKey);
    const hasTask = taskGroup?.items.some((task) => task.taskId === mobileTaskId) ?? false;
    if (hasTask) {
      mobileMissingTaskRefreshRef.current = null;
      return;
    }

    const dedupeKey = `${mobileWorkspaceKey}:${mobileTaskId}`;
    if (mobileMissingTaskRefreshRef.current === dedupeKey) {
      return;
    }
    mobileMissingTaskRefreshRef.current = dedupeKey;
    // Bugfix: if mobile has switched to a new task but the desktop list occasionally fails to catch
    // up (for example, because cross-device events arrive out of order), trigger a workspace-list
    // refetch from mobileViewState so the task does not remain visible on mobile but missing on desktop.
    bumpTaskListVersion(workspacePath, workspaceIdentity);
  }, [
    bumpTaskListVersion,
    webRemoteControlStatus.mobileConnected,
    webRemoteControlStatus.mobileViewState,
    workspaceIdentity,
    workspacePath,
    workspaceTaskGroupByKey,
  ]);
  const workspaceScrollMaskStyle = useMemo<CSSProperties>(() => {
    const baseStyle: CSSProperties = { overflowAnchor: "none" };
    if (!showWorkspaceTopMask && !showWorkspaceBottomMask) {
      return baseStyle;
    }
    const topStop = showWorkspaceTopMask ? "transparent 0px, black 32px" : "black 0px, black 32px";
    const bottomStop = showWorkspaceBottomMask
      ? "black calc(100% - 32px), transparent 100%"
      : "black calc(100% - 32px), black 100%";

    return {
      ...baseStyle,
      // Apply the CSS mask directly to the scroll container instead of adding an overlay.
      // This applies the top and bottom fades to the actual content and makes them disappear immediately at the scroll boundaries.
      WebkitMaskImage: `linear-gradient(to bottom, ${topStop}, ${bottomStop})`,
      maskImage: `linear-gradient(to bottom, ${topStop}, ${bottomStop})`,
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
      WebkitMaskSize: "100% 100%",
      maskSize: "100% 100%",
    };
  }, [showWorkspaceBottomMask, showWorkspaceTopMask]);

  const resetWorkspaceDrag = useCallback(() => {
    setActiveWorkspaceDragId(null);
    setActiveWorkspaceDragWidth(null);
  }, []);
  const handleWorkspaceDragStart = useCallback((event: DragStartEvent) => {
    setActiveWorkspaceDragId(String(event.active.id));
    setActiveWorkspaceDragWidth(event.active.rect.current.initial?.width ?? null);
  }, []);
  const handleWorkspaceDragCancel = useCallback(
    (_event: DragCancelEvent) => {
      resetWorkspaceDrag();
    },
    [resetWorkspaceDrag],
  );
  const handleWorkspaceDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      resetWorkspaceDrag();
      if (!over || active.id === over.id) {
        return;
      }
      if (
        isWorkspaceDragAcrossPinnedBoundary(pinnedProjectTabIds, String(active.id), String(over.id))
      ) {
        return;
      }

      // Project drag displays only the project subsequence, but tabStore stores the full workspace order.
      // Mixing their indices directly places projects incorrectly when conversation workspaces are present.
      const indices = resolveWorkspaceDragGlobalIndices({
        activeId: String(active.id),
        overId: String(over.id),
        projectTabs: projectWorkspaceTabs,
        workspaceTabs,
      });
      if (indices) {
        reorderWorkspaceTabs(indices.fromIndex, indices.toIndex);
      }
    },
    [
      pinnedProjectTabIds,
      projectWorkspaceTabs,
      reorderWorkspaceTabs,
      resetWorkspaceDrag,
      workspaceTabs,
    ],
  );
  const activeWorkspaceDragTab = useMemo(
    () =>
      activeWorkspaceDragId
        ? (projectWorkspaceTabs.find((tab) => tab.id === activeWorkspaceDragId) ?? null)
        : null,
    [activeWorkspaceDragId, projectWorkspaceTabs],
  );

  const handleThemeChange = useCallback(
    (value: string) => {
      if (value === "light" || value === "dark" || value === "system") {
        setTheme(value);
      }
    },
    [setTheme],
  );

  const handleLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        setLocalePreference("system");
        return;
      }
      if (isLocale(value)) {
        setLocalePreference(value);
      }
    },
    [setLocalePreference],
  );

  const handleOpenPluginStoreMain = useCallback(() => {
    onOpenPluginStore?.();
  }, [onOpenPluginStore]);
  const handleOpenAutomationsMain = useCallback(() => {
    onOpenAutomations?.();
  }, [onOpenAutomations]);
  const handleOpenCodingPlanUpgrade = useCallback(
    (
      providerId: string,
      funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext,
    ) => {
      openCodingPlanUpgrade({
        providerId,
        funnelContext,
      });
    },
    [openCodingPlanUpgrade],
  );
  const activeTaskId = useZCodeSessionStore(
    (state) =>
      // When Web remote control enters a remote workspace through the global task entry, it first writes activeTaskId
      // by workspaceIdentity. If the sidebar still reads only the path-only bucket,
      // the current task highlight is lost and later selections may be misclassified as inactive.
      selectWorkspaceZCodeState(state, workspacePath, workspaceIdentity).activeTaskId,
  );

  useEffect(() => {
    if (!webRemoteControlWorkspaceSwitcher?.updateMobileViewState) {
      return;
    }
    if (!activeTaskId) {
      return;
    }

    const workspaceKey = resolveWebRemoteControlWorkspaceKey({
      workspacePath,
      workspaceIdentity,
    });
    // Bugfix: fork/new task inside the chat switches the local activeTaskId directly, but mobileViewState
    // used to be reported only when clicking a task-list row, leaving the remote-control sidebar
    // highlighting the old task. Sync again when activeTaskId changes so mobile selection matches the actual session.
    void webRemoteControlWorkspaceSwitcher
      .updateMobileViewState(workspaceKey, activeTaskId)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[WorkspaceSidebar] 同步远控 mobileViewState 失败", {
          error: message,
          workspaceKey,
          taskId: activeTaskId,
        });
      });
  }, [activeTaskId, webRemoteControlWorkspaceSwitcher, workspaceIdentity, workspacePath]);

  useEffect(() => {
    const scrollNode = workspaceScrollRef.current;
    if (!scrollNode) {
      return;
    }

    const contentNode = scrollNode.firstElementChild;

    const updateWorkspaceScrollMask = () => {
      const hasOverflow = scrollNode.scrollHeight > scrollNode.clientHeight + 1;
      const isAtTop = scrollNode.scrollTop <= 1;
      const isAtBottom =
        scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 1;

      setShowWorkspaceTopMask(hasOverflow && !isAtTop);
      setShowWorkspaceBottomMask(hasOverflow && !isAtBottom);
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateWorkspaceScrollMask;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    // The workspace list's scrollbar appears only after content overflows.
    // Listening only to scroll would not immediately show the top/bottom fade when a scrollbar first appears after expanding a workspace.
    // Observe both container and content size changes so the mask follows content changes and scroll position.
    updateWorkspaceScrollMask();

    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateWorkspaceScrollMask;
      debouncedUpdate();
    });
    resizeObserver.observe(scrollNode);
    if (contentNode instanceof HTMLElement) {
      resizeObserver.observe(contentNode);
    }

    scrollNode.addEventListener("scroll", updateWorkspaceScrollMask, {
      passive: true,
    });
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      resizeObserver.disconnect();
      scrollNode.removeEventListener("scroll", updateWorkspaceScrollMask);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [expandedWorkspacePaths, workspaceTabs.length]);

  const isWebRemoteWorkspaceTaskGroupView =
    isWebRemoteControlSidebar && !showArchivedTasks && effectiveTaskViewMode === "workspace";
  const toggleableWebRemoteWorkspaceGroupKeys =
    webRemoteWorkspaceGroupKeys.length > 0
      ? webRemoteWorkspaceGroupKeys
      : webRemoteWorkspaceGroupSnapshotHasGroups === false
        ? []
        : lastNonEmptyWebRemoteWorkspaceGroupKeys;
  const showOptimisticWebRemoteTaskGroupToggle =
    isWebRemoteWorkspaceTaskGroupView &&
    !webRemoteWorkspaceGroupKeysHydrated &&
    webRemoteWorkspaceGroupSnapshotHasGroups !== false;
  const showToggleAllWebRemoteTaskGroups =
    isWebRemoteWorkspaceTaskGroupView &&
    (webRemoteWorkspaceGroupKeys.length > 0 || showOptimisticWebRemoteTaskGroupToggle);
  const canToggleAllWebRemoteTaskGroups =
    isWebRemoteWorkspaceTaskGroupView && toggleableWebRemoteWorkspaceGroupKeys.length > 0;
  const areAllWebRemoteTaskGroupsExpanded =
    toggleableWebRemoteWorkspaceGroupKeys.length > 0 &&
    toggleableWebRemoteWorkspaceGroupKeys.every(
      (groupKey) => !webRemoteCollapsedWorkspaceKeys.has(groupKey),
    );
  const isGroupedTaskGroupView =
    !isWebRemoteControlSidebar && !showArchivedTasks && taskOrganizeBy === "grouped";
  const toggleableGroupedTaskGroupIds =
    groupedTaskGroupIds.length > 0
      ? groupedTaskGroupIds
      : groupedTaskGroupSnapshotHasGroups === false
        ? []
        : lastNonEmptyGroupedTaskGroupIds;
  const showOptimisticGroupedTaskGroupToggle =
    isGroupedTaskGroupView &&
    !groupedTaskGroupIdsHydrated &&
    groupedTaskGroupSnapshotHasGroups !== false;
  const showToggleAllGroupedTaskGroups =
    isGroupedTaskGroupView &&
    (groupedTaskGroupIds.length > 0 || showOptimisticGroupedTaskGroupToggle);
  const canToggleAllGroupedTaskGroups =
    isGroupedTaskGroupView && toggleableGroupedTaskGroupIds.length > 0;
  const areAllToggleableGroupedTaskGroupsOpen = areAllGroupedTaskGroupsExpanded(
    toggleableGroupedTaskGroupIds,
    collapsedGroupedTaskGroupIds,
  );
  const canToggleAllProjectTaskGroups =
    !isWebRemoteControlSidebar &&
    !showArchivedTasks &&
    taskOrganizeBy === "project" &&
    projectWorkspaceTabs.length > 0;
  const showToggleAllTaskGroups =
    showToggleAllWebRemoteTaskGroups ||
    canToggleAllProjectTaskGroups ||
    showToggleAllGroupedTaskGroups;
  const canToggleAllTaskGroups =
    canToggleAllWebRemoteTaskGroups ||
    canToggleAllProjectTaskGroups ||
    canToggleAllGroupedTaskGroups;
  const areAllTaskGroupsExpanded = showToggleAllWebRemoteTaskGroups
    ? areAllWebRemoteTaskGroupsExpanded
    : taskOrganizeBy === "grouped"
      ? areAllToggleableGroupedTaskGroupsOpen
      : purposeSectionPreferences.projectsExpanded && areAllWorkspaceGroupsExpanded;
  const toggleAllTaskGroupsTransitionPending =
    showOptimisticWebRemoteTaskGroupToggle || showOptimisticGroupedTaskGroupToggle;
  const toggleAllTaskGroupsPresentation = resolveSidebarTaskGroupTogglePresentation({
    current: {
      visible: showToggleAllTaskGroups,
      canToggle: canToggleAllTaskGroups,
      areAllExpanded: areAllTaskGroupsExpanded,
      transitionPending: toggleAllTaskGroupsTransitionPending,
    },
    previous: lastStableTaskGroupTogglePresentationRef.current,
  });
  const activePrimaryTaskMode: PrimaryTaskMode =
    !isWebRemoteControlSidebar && taskOrganizeBy === "grouped" ? "grouped" : "workspace";
  const workspaceTaskViewValue = taskOrganizeBy === "chronological" ? "chronological" : "project";
  const showTaskViewFilter = activePrimaryTaskMode === "workspace" || showArchivedTasks;
  const showWorkspaceViewOptions = activePrimaryTaskMode === "workspace" && !showArchivedTasks;
  const showTaskSortOptions = activePrimaryTaskMode === "workspace" || showArchivedTasks;
  const handlePrimaryTaskModeChange = useCallback(
    (value: string) => {
      logger.debug("[WorkspaceSidebar] 切换任务一级视图", {
        from: taskOrganizeBy,
        to: value,
        groupedHydrated: groupedTaskGroupIdsHydrated,
        groupedCount: groupedTaskGroupIds.length,
        lastGroupedCount: lastNonEmptyGroupedTaskGroupIds.length,
      });
      if (value === "grouped") {
        setGroupedTaskGroupIdsHydrated(false);
        setTaskOrganizeBy("grouped");
        return;
      }
      if (value === "workspace") {
        setTaskOrganizeBy(workspaceTaskOrganizeBy);
      }
    },
    [
      groupedTaskGroupIds.length,
      groupedTaskGroupIdsHydrated,
      lastNonEmptyGroupedTaskGroupIds.length,
      taskOrganizeBy,
      workspaceTaskOrganizeBy,
    ],
  );
  const handleWorkspaceTaskViewChange = useCallback((value: string) => {
    if (value !== "project" && value !== "chronological") {
      return;
    }
    setWorkspaceTaskOrganizeBy(value);
    setTaskOrganizeBy(value);
  }, []);
  const handleToggleAllTaskGroups = useCallback(() => {
    if (!canToggleAllTaskGroups) {
      return;
    }
    if (canToggleAllWebRemoteTaskGroups) {
      setWebRemoteCollapsedWorkspaceKeys(
        areAllWebRemoteTaskGroupsExpanded
          ? new Set(toggleableWebRemoteWorkspaceGroupKeys)
          : new Set(),
      );
      return;
    }
    if (taskOrganizeBy === "grouped") {
      if (toggleableGroupedTaskGroupIds.length === 0) {
        return;
      }
      handleCollapsedGroupedTaskGroupIdsChange(
        areAllToggleableGroupedTaskGroupsOpen ? new Set(toggleableGroupedTaskGroupIds) : new Set(),
      );
      return;
    }
    if (purposeSectionPreferences.projectsExpanded && areAllWorkspaceGroupsExpanded) {
      handleProjectSectionOpenChange(false);
      collapseAllWorkspaceTabs(workspacePaths);
      return;
    }

    handleProjectSectionOpenChange(true);
    expandAllWorkspaceTabs(workspacePaths);
  }, [
    areAllWebRemoteTaskGroupsExpanded,
    areAllWorkspaceGroupsExpanded,
    areAllToggleableGroupedTaskGroupsOpen,
    canToggleAllWebRemoteTaskGroups,
    canToggleAllTaskGroups,
    collapseAllWorkspaceTabs,
    expandAllWorkspaceTabs,
    handleCollapsedGroupedTaskGroupIdsChange,
    handleProjectSectionOpenChange,
    purposeSectionPreferences.projectsExpanded,
    taskOrganizeBy,
    toggleableGroupedTaskGroupIds,
    toggleableWebRemoteWorkspaceGroupKeys,
    workspacePaths,
  ]);
  useEffect(() => {
    // Group view returns group IDs in the next child-render cycle after switching.
    // Using a model that has not hydrated in the transition frame briefly changes the button to disabled/an expand icon, causing flicker.
    // Reuse the previous display model while hydration is pending; handleToggleAllTaskGroups still guards clicks against current state.
    if (!toggleAllTaskGroupsTransitionPending) {
      lastStableTaskGroupTogglePresentationRef.current = toggleAllTaskGroupsPresentation;
    }
  }, [toggleAllTaskGroupsPresentation, toggleAllTaskGroupsTransitionPending]);

  useLayoutEffect(() => {
    if (isWebRemoteControlSidebar) {
      return;
    }

    const listNode = primaryTaskTabsListRef.current;
    if (!listNode) {
      return;
    }

    const updateIndicator = () => {
      const activeTrigger = primaryTaskTabTriggerRefs.current[activePrimaryTaskMode];
      if (!activeTrigger) {
        return;
      }

      const nextTransform = `translateX(${activeTrigger.offsetLeft}px)`;
      const nextWidth = activeTrigger.offsetWidth;
      setPrimaryTaskIndicatorStyle((current) =>
        current.opacity === 1 && current.transform === nextTransform && current.width === nextWidth
          ? current
          : {
              opacity: 1,
              transform: nextTransform,
              width: nextWidth,
            },
      );
    };

    let animationFrameId: number | null = null;
    const scheduleUpdate = () => {
      if (animationFrameId !== null) {
        return;
      }
      animationFrameId = requestAnimationFrame(() => {
        animationFrameId = null;
        updateIndicator();
      });
    };

    updateIndicator();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(listNode);
    for (const triggerNode of Object.values(primaryTaskTabTriggerRefs.current)) {
      if (triggerNode) {
        resizeObserver?.observe(triggerNode);
      }
    }
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [activePrimaryTaskMode, isWebRemoteControlSidebar]);

  const archivedTasksActionLabel = intl.formatMessage({
    // After opening the archive view, the button icon changes to X while the tooltip still said “Archive,”
    // creating a mismatch. Use “Close” in the open state and update aria-label too.
    id: showArchivedTasks ? "common.close" : "workspaceSidebar.toggleArchivedTasks",
  });
  // Performance fix: workspaceTaskToolbar was recreated during chat streaming and passed to the remote-control task index.
  // Stabilize the render prop on the state that actually affects the toolbar so message updates do not churn the sidebar task area.
  const workspaceTaskToolbar = useCallback(
    () => (
      <div className={cn("pl-2.5 pr-3", isWebRemoteControlSidebar && "-mx-4")}>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 shrink-0 items-center gap-1">
            {isWebRemoteControlSidebar ? (
              <div className="inline-flex h-7 min-w-0 items-center rounded-full border border-border bg-surface px-2 text-ui-xs font-medium text-foreground">
                {intl.formatMessage({
                  id: "workspaceSidebar.organizeByProject",
                })}
              </div>
            ) : (
              <Tabs
                value={activePrimaryTaskMode}
                onValueChange={handlePrimaryTaskModeChange}
                className="w-fit shrink-0"
                aria-label={intl.formatMessage({
                  id: "workspaceSidebar.organize",
                })}
              >
                {/* TabsList defaults to h-8 in horizontal mode; override the variant here as well so Radix’s actual horizontal state does not enlarge the shell. */}
                <TabsList
                  ref={primaryTaskTabsListRef}
                  className="relative h-7 w-fit overflow-hidden rounded-full bg-surface p-0.5 group-data-horizontal/tabs:h-7"
                >
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0.5 left-0 rounded-full bg-background transition-[opacity,transform,width] duration-200 ease-out"
                    style={primaryTaskIndicatorStyle}
                  />
                  <TabsTrigger
                    ref={(node) => {
                      primaryTaskTabTriggerRefs.current.grouped = node;
                    }}
                    value="grouped"
                    className="relative z-10 h-6 flex-none gap-1 rounded-full border-transparent bg-transparent py-0 pl-1.5 pr-2 text-ui-sm font-medium text-foreground-subtle transition-colors data-active:border-transparent data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
                  >
                    <Hash aria-hidden="true" className="size-3 shrink-0" />
                    <span>
                      {intl.formatMessage({
                        id: "workspaceSidebar.organizeGrouped",
                      })}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger
                    ref={(node) => {
                      primaryTaskTabTriggerRefs.current.workspace = node;
                    }}
                    value="workspace"
                    className="relative z-10 h-6 flex-none gap-1 rounded-full border-transparent bg-transparent py-0 pl-1.5 pr-2 text-ui-sm font-medium text-foreground-subtle transition-colors data-active:border-transparent data-active:bg-transparent data-active:text-foreground data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
                  >
                    <Folder aria-hidden="true" className="size-3 shrink-0" />
                    <span>
                      {intl.formatMessage({
                        id: "workspaceSidebar.organizeByProject",
                      })}
                    </span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
            {toggleAllTaskGroupsPresentation ? (
              <ControlHintTooltip
                title={intl.formatMessage({
                  id: toggleAllTaskGroupsPresentation.messageId,
                })}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-foreground-subtle hover:text-foreground"
                  aria-label={intl.formatMessage({
                    id: toggleAllTaskGroupsPresentation.messageId,
                  })}
                  disabled={!toggleAllTaskGroupsPresentation.canToggle}
                  onClick={handleToggleAllTaskGroups}
                >
                  {toggleAllTaskGroupsPresentation.areAllExpanded ? (
                    <Minimize2 className="size-3.5" />
                  ) : (
                    <Maximize2 className="size-3.5" />
                  )}
                </Button>
              </ControlHintTooltip>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!isWebRemoteControlSidebar && taskViewMode === "grouped" ? (
              <ControlHintTooltip
                title={workspaceReadOnlyReason ?? intl.formatMessage({ id: "taskGroup.newGroup" })}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-foreground-subtle hover:text-foreground"
                  aria-label={intl.formatMessage({
                    id: "taskGroup.newGroup",
                  })}
                  disabled={workspaceReadOnly || !createGroupedTaskGroupAction}
                  onClick={() => {
                    if (!workspaceReadOnly) {
                      createGroupedTaskGroupAction?.();
                    }
                  }}
                >
                  <Hash className="size-3.5" />
                </Button>
              </ControlHintTooltip>
            ) : null}
            {showTaskViewFilter ? (
              <DropdownMenu>
                <ControlHintTooltip
                  title={intl.formatMessage({
                    id: "workspaceSidebar.taskViewOptions",
                  })}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-foreground-subtle hover:text-foreground"
                      aria-label={intl.formatMessage({
                        id: "workspaceSidebar.taskViewOptions",
                      })}
                    >
                      <ListFilter className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                </ControlHintTooltip>
                <DropdownMenuContent align="end" className="w-48 min-w-48">
                  {showWorkspaceViewOptions ? (
                    <>
                      <DropdownMenuLabel>
                        {intl.formatMessage({
                          id: "workspaceSidebar.organize",
                        })}
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={workspaceTaskViewValue}
                        onValueChange={handleWorkspaceTaskViewChange}
                      >
                        <DropdownMenuRadioItem value="project">
                          <Folder className="size-4" />
                          {intl.formatMessage({
                            id: "workspaceSidebar.viewByWorkspace",
                          })}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="chronological">
                          <Clock3 className="size-4" />
                          {intl.formatMessage({
                            id: "workspaceSidebar.organizeChronologicalList",
                          })}
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </>
                  ) : null}
                  {showWorkspaceViewOptions && showTaskSortOptions ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  {showTaskSortOptions ? (
                    <>
                      <DropdownMenuLabel>
                        {intl.formatMessage({
                          id: "workspaceSidebar.sortBy",
                        })}
                      </DropdownMenuLabel>
                      <DropdownMenuRadioGroup
                        value={taskSortBy}
                        onValueChange={(value) => {
                          if (value === "created" || value === "updated") {
                            setTaskSortBy(value);
                          }
                        }}
                      >
                        <DropdownMenuRadioItem value="updated">
                          <MessageCircleCheck className="size-4" />
                          {intl.formatMessage({
                            id: "workspaceSidebar.sortByUpdated",
                          })}
                        </DropdownMenuRadioItem>
                        <DropdownMenuRadioItem value="created">
                          <MessageCirclePlus className="size-4" />
                          {intl.formatMessage({
                            id: "workspaceSidebar.sortByCreated",
                          })}
                        </DropdownMenuRadioItem>
                      </DropdownMenuRadioGroup>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {showArchivedTasks ? (
              <div
                ref={setArchivedActionsContainer}
                data-testid="archived-tasks-toolbar-actions"
                className="flex shrink-0 items-center"
              />
            ) : null}
            <ControlHintTooltip title={archivedTasksActionLabel}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-foreground-subtle hover:text-foreground data-[state=on]:bg-hover data-[state=on]:text-foreground"
                data-state={showArchivedTasks ? "on" : "off"}
                aria-label={archivedTasksActionLabel}
                onClick={() => {
                  setShowArchivedTasks((current) => !current);
                }}
              >
                {showArchivedTasks ? <X className="size-3.5" /> : <Archive className="size-3.5" />}
              </Button>
            </ControlHintTooltip>
          </div>
        </div>
      </div>
    ),
    [
      activePrimaryTaskMode,
      archivedTasksActionLabel,
      createGroupedTaskGroupAction,
      handlePrimaryTaskModeChange,
      handleToggleAllTaskGroups,
      handleWorkspaceTaskViewChange,
      intl,
      isWebRemoteControlSidebar,
      primaryTaskIndicatorStyle,
      showArchivedTasks,
      showTaskSortOptions,
      showTaskViewFilter,
      showWorkspaceViewOptions,
      taskSortBy,
      taskViewMode,
      toggleAllTaskGroupsPresentation,
      workspaceTaskViewValue,
    ],
  );

  // Bugfix: Footer uses memo; inline JSX lets unrelated sidebar updates cross its stable-reference boundary.
  const sidebarBottomActivity = useMemo(() => <SidebarBottomActivity />, []);

  return (
    <aside
      data-testid={TID_SIDEBAR}
      // Use the design system's structural surface token to define the sidebar layer, preventing different compositors from blending the left container into an odd gray block.
      className="flex h-full flex-col overflow-hidden"
    >
      <div
        className={cn("h-12 [app-region:drag]", isWebRemoteControlSidebar && "max-md:hidden")}
      ></div>
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          data-web-remote-navigation-scroll={isWebRemoteControlSidebar ? "true" : undefined}
          className={cn(
            "absolute inset-0 flex min-h-0 flex-col transition-transform duration-200 ease-out",
            isFileTreeOpen && "-translate-x-full pointer-events-none",
            // Bugfix: the top area on mobile Web remote control contains quick actions, remote tasks,
            // and workspace navigation. Previously only the workspace-list child scrolled, while
            // task entries above consumed space and made lower tasks look covered by the chat area.
            // Make the entire top navigation flow one scroll container only on small remote-control
            // screens; desktop keeps its existing sidebar-internal scrolling structure.
            isWebRemoteControlSidebar && "max-md:overflow-y-auto",
          )}
          aria-hidden={isFileTreeOpen}
        >
          <div
            className={cn(
              "flex flex-col gap-1 px-2",
              isWindowsDesktop ? "py-2" : "py-3",
              isWebRemoteControlSidebar && "max-md:pt-11",
            )}
          >
            <WorkspaceNewTaskTooltip disabledReason={workspaceReadOnlyReason}>
              <NewTaskButtonGroup
                disabled={workspaceReadOnly}
                onCreateTask={() => {
                  if (workspaceReadOnly) {
                    return;
                  }
                  if (taskViewMode === "grouped") {
                    if (createGroupedTaskDraftAction) {
                      createGroupedTaskDraftAction();
                      return;
                    }
                    onCreateTask({ groupedDraftPlacement: { type: "top" } });
                    return;
                  }
                  onCreateTask({ createSource: "project" });
                }}
              />
            </WorkspaceNewTaskTooltip>
            <Button
              variant="ghost"
              onClick={onOpenCommandCenter}
              data-icon="inline-start"
              size="lg"
              className="w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground"
            >
              <Search className="size-4" />
              <span className="min-w-0 flex-1 truncate text-left">
                {intl.formatMessage({ id: "commandCenter.open" })}
              </span>
              {/* Bugfix: The full-width search entry at the top of the sidebar was accidentally removed while organizing mobile remote-control entries.
                  Restore the entry but keep it opening the unified Command Center, without re-enabling the retired TaskSearchDialog query flow. */}
              <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
                {commandCenterShortcutLabel}
              </span>
            </Button>
            {/* Bugfix: Use useRemoteConnectionEntryVisibility consistently for remote-entry visibility to prevent behavior from diverging across entry points. */}
            {/* {showRemoteConnectionEntry ? (
              <SSHDialog
                onConnect={onConnectRemote}
                onSelectProject={onSelectRemoteProject}
                onCancelSession={onCancelRemoteProject}
                isWindowsDesktop={isWindowsDesktop}
                triggerVariant="ghost"
                triggerSize="lg"
                triggerClassName="w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground"
                trigger={
                  <>
                    <Cloud className="size-4" />
                    <span>{intl.formatMessage({ id: "remote.trigger" })}</span>
                  </>
                }
              />
            ) : null} */}
            {/* Bugfix: The top of the Web remote-control sidebar previously added a separate “global task index,”
              creating two task lists when combined with the workspace task area below, unlike the desktop layout and confusing to users.
              Remove the top index entry and use the workspace task area as the single task list. */}
            {!isWebRemoteControlSidebar ? (
              <Button
                variant="ghost"
                onClick={handleOpenAutomationsMain}
                data-icon="inline-start"
                data-testid={TID_AUTOMATIONS_OPEN}
                size="lg"
                aria-pressed={automationsActive}
                className={cn(
                  "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
                  automationsActive && "bg-selected text-foreground",
                )}
              >
                <CalendarClock className="size-4" />
                {intl.formatMessage({ id: "workspace.openScheduledSettings" })}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              onClick={handleOpenPluginStoreMain}
              data-icon="inline-start"
              data-testid="plugin-store-sidebar-open"
              size="lg"
              aria-pressed={pluginStoreActive}
              className={cn(
                "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
                pluginStoreActive && "bg-selected text-foreground",
              )}
            >
              <Blocks className="size-4" />
              {intl.formatMessage({ id: "workspace.openPluginsSettings" })}
            </Button>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
            <StickyGroupHeaderSlot header={groupedStickyHeader} />
            <div
              ref={workspaceScrollRef}
              className={cn(
                // Bugfix: grouped-task drag previews change list height. Disable scroll anchoring so
                // browser auto-anchoring does not amplify dnd-kit measurements into jitter.
                "flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto",
                isWebRemoteControlSidebar && "max-md:flex-none max-md:overflow-visible",
              )}
              style={workspaceScrollMaskStyle}
            >
              {!isWebRemoteControlSidebar ? workspaceTaskToolbar() : null}
              {/* Merge observation lives at sidebar level so the grouped, flat,
                  and archived views share one store keyed by workspaceKey.
                  Панель прячется через CSS и не размонтируется, поэтому
                  видимость передаётся пропом: каждое открытие — новая проба. */}
              <BranchMergeStatusProbes workspaceTabs={workspaceTabs} active={isSidebarVisible} />
              {shouldShowPinnedTasks ? (
                // Switching the main task area to archive must not hide pinned.
                // Pinned is a global section and remains visible in archive mode.
                <WorkspacePinnedTasksSection
                  workspaceTabs={workspaceTabs}
                  activeWorkspacePath={workspacePath}
                  activeWorkspaceIdentity={workspaceIdentity}
                  activeTaskId={activeTaskId}
                  taskSortBy={taskSortBy}
                  mobileActiveTaskKey={mobileActiveTaskKey}
                  onSelectTask={handleTaskRowSelect}
                  onOpenFileTree={(target) => {
                    setFileTreeTarget(target);
                    setIsFileTreeOpen(true);
                  }}
                />
              ) : null}
              <div className="flex min-h-0 flex-col gap-3 px-2">
                {webRemoteControlWorkspaceSwitcher &&
                (effectiveTaskViewMode === "workspace" ||
                  effectiveTaskViewMode === "timeline" ||
                  effectiveTaskViewMode === "archived") ? (
                  // Bugfix: remote-control mode previously showed the “global task index” in a
                  // separate top block and rendered workspace tasks in the main area, while timeline
                  // and archive later fell back to desktop workspaceTabs. Use listWorkspaces() for
                  // all three wide-screen remote-control views.
                  <WebRemoteControlTaskIndex
                    switcher={webRemoteControlWorkspaceSwitcher}
                    activeWorkspacePath={workspacePath}
                    activeWorkspaceIdentity={workspaceIdentity}
                    activeTaskId={activeTaskId}
                    taskSortBy={taskSortBy}
                    taskViewMode={effectiveTaskViewMode}
                    collapsedWorkspaceKeys={webRemoteCollapsedWorkspaceKeys}
                    renderBeforePinnedTasks={workspaceTaskToolbar}
                    archivedActionsContainer={archivedActionsContainer}
                    onToggleWorkspaceCollapsed={(workspaceKey) => {
                      setWebRemoteCollapsedWorkspaceKeys((current) => {
                        const next = new Set(current);
                        if (next.has(workspaceKey)) {
                          next.delete(workspaceKey);
                        } else {
                          next.add(workspaceKey);
                        }
                        return next;
                      });
                    }}
                    onWorkspaceGroupKeysChange={handleWebRemoteWorkspaceGroupKeysChange}
                    onSelectTask={onSelectTask}
                    onTaskOpen={onWebRemoteTaskOpen}
                    onCrossWorkspaceSwitchingChange={onWebRemoteTaskSwitchingChange}
                  />
                ) : taskViewMode === "archived" ? (
                  <WorkspaceArchivedTasksFlatSection
                    actionsContainer={archivedActionsContainer}
                    workspaceTabs={workspaceTabs}
                    activeWorkspacePath={workspacePath}
                    activeWorkspaceIdentity={workspaceIdentity}
                    activeTaskId={activeTaskId}
                    sortBy={taskSortBy}
                    mobileActiveTaskKey={mobileActiveTaskKey}
                    onSelectTask={onSelectTask}
                  />
                ) : taskViewMode === "grouped" ? (
                  <WorkspaceGroupedTasksSection
                    workspaceTabs={workspaceTabs}
                    activeWorkspacePath={workspacePath}
                    activeWorkspaceIdentity={workspaceIdentity}
                    activeTaskId={activeTaskId}
                    mobileActiveTaskKey={mobileActiveTaskKey}
                    onSelectTask={onSelectTask}
                    onCreateTask={onCreateTask}
                    onOpenFileTree={(target) => {
                      setFileTreeTarget(target);
                      setIsFileTreeOpen(true);
                    }}
                    onCreateGroupActionChange={handleCreateGroupActionChange}
                    onCreateDraftTaskActionChange={handleCreateDraftTaskActionChange}
                    collapsedGroupIds={collapsedGroupedTaskGroupIds}
                    onGroupedTaskGroupIdsChange={handleGroupedTaskGroupIdsChange}
                    onCollapsedGroupIdsChange={handleCollapsedGroupedTaskGroupIdsChange}
                    onStickyGroupHeaderChange={setGroupedStickyHeader}
                    onOpenAutomations={handleOpenAutomationsMain}
                  />
                ) : taskViewMode === "timeline" ? (
                  <WorkspaceTimelineTasksSection
                    workspaceTabs={workspaceTabs}
                    activeWorkspacePath={workspacePath}
                    activeWorkspaceIdentity={workspaceIdentity}
                    activeTaskId={activeTaskId}
                    taskSortBy={taskSortBy}
                    mobileActiveTaskKey={mobileActiveTaskKey}
                    onSelectTask={handleTaskRowSelect}
                  />
                ) : (
                  <DndContext
                    sensors={purposeSectionSensors}
                    collisionDetection={closestCenter}
                    modifiers={[restrictVerticalDragWithinContainer]}
                    onDragEnd={handlePurposeSectionDragEnd}
                  >
                    <SortableContext
                      items={purposeSectionPreferences.sectionOrder}
                      strategy={verticalListSortingStrategy}
                    >
                      <div data-purpose-section-list="true">
                        {purposeSectionPreferences.sectionOrder.map((sectionId) =>
                          sectionId === "projects" ? (
                            <WorkspacePurposeSection
                              key={sectionId}
                              sortableId={sectionId}
                              dragHandleLabel={intl.formatMessage(
                                { id: "workspaceSidebar.reorderSection" },
                                {
                                  section: intl.formatMessage({
                                    id: "workspaceSidebar.projectsSection",
                                  }),
                                },
                              )}
                              title={intl.formatMessage({
                                id: "workspaceSidebar.projectsSection",
                              })}
                              open={purposeSectionPreferences.projectsExpanded}
                              onOpenChange={handleProjectSectionOpenChange}
                              testId={TID_PROJECT_SECTION}
                              action={
                                <DropdownMenu>
                                  <ControlHintTooltip
                                    title={intl.formatMessage({
                                      id: "workspaceSidebar.addProject",
                                    })}
                                  >
                                    <DropdownMenuTrigger asChild>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        className="text-foreground-subtle hover:text-foreground data-[state=open]:text-foreground"
                                        aria-label={intl.formatMessage({
                                          id: "workspaceSidebar.addProject",
                                        })}
                                        data-testid={TID_PROJECT_ADD}
                                      >
                                        <Plus className="size-3.5" />
                                      </Button>
                                    </DropdownMenuTrigger>
                                  </ControlHintTooltip>
                                  <DropdownMenuContent align="end" className="min-w-44">
                                    <DropdownMenuItem onSelect={onOpenFolderFromWorkspaceMenu}>
                                      <FolderOpen className="size-4" />
                                      {intl.formatMessage({
                                        id: "workspace.openFolder",
                                      })}
                                    </DropdownMenuItem>
                                    {onOpenRemoteWorkspace ? (
                                      <DropdownMenuItem onSelect={onOpenRemoteWorkspace}>
                                        <Cloud className="size-4" />
                                        {intl.formatMessage({
                                          id: "remote.trigger",
                                        })}
                                      </DropdownMenuItem>
                                    ) : null}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              }
                            >
                              {projectWorkspaceTabs.length === 0 ? (
                                <div className="px-3 py-2 text-ui-base text-foreground-subtle">
                                  {intl.formatMessage({
                                    id: "workspaceSidebar.noProjects",
                                  })}
                                </div>
                              ) : (
                                <DndContext
                                  sensors={workspaceSensors}
                                  collisionDetection={closestCenter}
                                  modifiers={[restrictVerticalDragWithinContainer]}
                                  onDragStart={handleWorkspaceDragStart}
                                  onDragEnd={handleWorkspaceDragEnd}
                                  onDragCancel={handleWorkspaceDragCancel}
                                >
                                  <SortableContext
                                    items={orderedProjectWorkspaceTabs.map((tab) => tab.id)}
                                    strategy={workspaceVerticalListSortingStrategy}
                                  >
                                    <ul data-testid={TID_WORKSPACE_LIST} className="space-y-2 pb-4">
                                      {orderedProjectWorkspaceTabs.map((tab, orderedIndex) => {
                                        const workspaceKey = buildTaskWorkspaceKey(
                                          tab.workspacePath,
                                          tab.workspaceIdentity,
                                        );
                                        const taskGroup = workspaceTaskGroupByKey.get(workspaceKey);
                                        const taskLoading =
                                          workspaceTaskLists.loadingByWorkspaceKey[workspaceKey] ??
                                          false;
                                        const isWorkspacePinned =
                                          pinnedWorkspaceKeys.has(workspaceKey);

                                        return (
                                          <Fragment key={tab.id}>
                                            {orderedIndex === pinnedProjectTabIds.size &&
                                            pinnedProjectTabIds.size > 0 ? (
                                              <li
                                                aria-hidden="true"
                                                data-testid={TID_WORKSPACE_PIN_DIVIDER}
                                                className="mx-2.5 h-px bg-border"
                                              />
                                            ) : null}
                                            <SortableWorkspaceSidebarItem
                                              tab={tab}
                                              isActiveWorkspace={
                                                tab.workspacePath === workspacePath
                                              }
                                              isExpanded={resolveWorkspaceDragExpanded({
                                                activeDragId: activeWorkspaceDragId,
                                                expanded: expandedWorkspacePaths.has(
                                                  tab.workspacePath,
                                                ),
                                                tabId: tab.id,
                                              })}
                                              isPinned={isWorkspacePinned}
                                              activateTab={activateTab}
                                              closeTab={closeTab}
                                              toggleWorkspaceExpanded={toggleWorkspaceExpanded}
                                              onSelectTask={onSelectTask}
                                              onStartDraftInWorkspace={onStartDraftInWorkspace}
                                              taskItems={
                                                taskGroup?.items ?? EMPTY_WORKSPACE_TASK_ITEMS
                                              }
                                              taskListLoading={taskLoading}
                                              taskListHasMore={taskGroup?.hasMore ?? false}
                                              taskListHasUnread={taskGroup?.hasUnread ?? false}
                                              taskListLiveWorkflowCount={
                                                taskGroup?.liveWorkflowCount ?? 0
                                              }
                                              mobileActiveTaskKey={mobileActiveTaskKey}
                                              isWebRemoteControl={isWebRemoteControlSidebar}
                                              workspaceKey={workspaceKey}
                                              onToggleWorkspacePinned={
                                                pinnedWorkspaceKeysLoaded
                                                  ? handleToggleWorkspacePinned
                                                  : undefined
                                              }
                                              onOpenSessionManager={
                                                handleOpenSessionManagerFromSidebar
                                              }
                                              onShowMoreWorkspaceTasks={
                                                handleShowMoreWorkspaceTasks
                                              }
                                              reconnectingRemoteWorkspaceKeys={
                                                reconnectingRemoteWorkspaceKeys
                                              }
                                              remoteWorkspaceErrorByWorkspaceKey={
                                                remoteWorkspaceErrorByWorkspaceKey
                                              }
                                              reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                                                reconnectingRemoteWorkspaceLogsByWorkspaceKey
                                              }
                                              onReconnectRemoteWorkspace={
                                                onReconnectRemoteWorkspace
                                              }
                                              onOpenFileTree={handleOpenWorkspaceFileTree}
                                            />
                                          </Fragment>
                                        );
                                      })}
                                    </ul>
                                  </SortableContext>
                                  {typeof document === "undefined"
                                    ? null
                                    : createPortal(
                                        <DragOverlay>
                                          {activeWorkspaceDragTab ? (
                                            <WorkspaceDragOverlay
                                              tab={activeWorkspaceDragTab}
                                              width={activeWorkspaceDragWidth}
                                            />
                                          ) : null}
                                        </DragOverlay>,
                                        document.body,
                                      )}
                                </DndContext>
                              )}
                            </WorkspacePurposeSection>
                          ) : (
                            <WorkspacePurposeSection
                              key={sectionId}
                              sortableId={sectionId}
                              dragHandleLabel={intl.formatMessage(
                                { id: "workspaceSidebar.reorderSection" },
                                {
                                  section: intl.formatMessage({
                                    id: "workspaceSidebar.conversationsSection",
                                  }),
                                },
                              )}
                              title={intl.formatMessage({
                                id: "workspaceSidebar.conversationsSection",
                              })}
                              open={purposeSectionPreferences.conversationsExpanded}
                              onOpenChange={handleConversationSectionOpenChange}
                              testId={TID_CONVERSATION_SECTION}
                              action={
                                <ControlHintTooltip
                                  title={intl.formatMessage({
                                    id: "workspaceSidebar.newConversation",
                                  })}
                                >
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="text-foreground-subtle hover:text-foreground"
                                    aria-label={intl.formatMessage({
                                      id: "workspaceSidebar.newConversation",
                                    })}
                                    data-testid={TID_CONVERSATION_NEW_TASK}
                                    onClick={onCreateConversationTask}
                                  >
                                    <MessageCirclePlus className="size-3.5" />
                                  </Button>
                                </ControlHintTooltip>
                              }
                            >
                              <WorkspaceTimelineTasksSection
                                workspaceTabs={conversationWorkspaceTabs}
                                activeWorkspacePath={workspacePath}
                                activeWorkspaceIdentity={workspaceIdentity}
                                activeTaskId={activeTaskId}
                                taskSortBy={taskSortBy}
                                groupByDate={false}
                                // The conversation backing workspace is only an internal execution path; changing user-facing copy to “task” does not change purpose semantics.
                                taskRowVariant="default"
                                emptyMessage={intl.formatMessage({
                                  id: "workspaceSidebar.noConversations",
                                })}
                                mobileActiveTaskKey={mobileActiveTaskKey}
                                onSelectTask={handleTaskRowSelect}
                              />
                            </WorkspacePurposeSection>
                          ),
                        )}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}
              </div>
            </div>
          </div>

          <WorkspaceSidebarFooter
            className="pr-3"
            banner={sidebarBottomActivity}
            theme={theme}
            localeMenuValue={localeMenuValue}
            onLocaleChange={handleLocaleChange}
            onThemeChange={handleThemeChange}
            onSettingsButtonClick={openSettingsTab}
            onUsageClick={openSettingsTab}
            onUpgradeClick={handleOpenCodingPlanUpgrade}
            onLogin={onLogin}
            onLogout={onLogout}
            user={user}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            workspaceRemoteSessionId={workspaceRemoteSessionId}
            activeTaskId={activeTaskId}
            isDesktop={isDesktop}
          />
        </div>
        <div
          className={cn(
            "absolute inset-0 transition-transform duration-200 ease-out",
            isFileTreeOpen ? "translate-x-0" : "translate-x-full pointer-events-none",
          )}
          aria-hidden={!isFileTreeOpen}
        >
          {fileTreeTarget ? (
            <WorkspaceFileTree
              workspacePath={fileTreeTarget.workspacePath}
              workspaceName={fileTreeTarget.workspaceName}
              workspaceIdentity={fileTreeTarget.workspaceIdentity}
              workspaceRemoteSessionId={fileTreeTarget.workspaceRemoteSessionId}
              revealPath={fileTreeTarget.revealPath}
              temporaryExternalDirectory={fileTreeTarget.temporaryExternalDirectory}
              executionWorktreePath={fileTreeTarget.executionWorktreePath}
              canOpenLocalFileManager={isDesktop}
              activePreviewPath={activePreviewPath}
              onClose={() => setIsFileTreeOpen(false)}
              onOpenBrowserUrl={isDesktop ? onOpenBrowserUrl : undefined}
              onOpenPreview={(source) => {
                // The file tree can show files from a workspace that is not current.
                // The preview source carries workspace scope so PreviewPane reads remote files through the correct host;
                // keep the current workspace unchanged to avoid sending “Add to chat” to the wrong Composer.
                onOpenCodeViewer?.({
                  ...source,
                  workspacePath: fileTreeTarget.workspacePath,
                  workspaceIdentity: fileTreeTarget.workspaceIdentity,
                  workspaceRemoteSessionId: fileTreeTarget.workspaceRemoteSessionId,
                });
              }}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
});
