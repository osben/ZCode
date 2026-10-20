import { WorkspaceContextPath } from "@/WorkspaceHeaderSections/WorkspaceContextPath.js";
import { WorkspaceLastActivity } from "@/WorkspaceHeaderSections/WorkspaceLastActivity.js";
import { WorkspaceHeaderPullRequestChip } from "@/WorkspaceHeaderPullRequestChip.js";
/* eslint-disable max-lines -- The Header title area currently handles the task menu, path context, and workspace-level status hints; keep it in one file for now to avoid regressions while moving the menu flow. */
import {
  TID_WORKSPACE_MORE_BUTTON,
  TID_WORKSPACE_PATH,
  TID_WORKSPACE_TITLE,
  type RemoteTarget,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { useMemo, useRef, useState } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Cloud, Ellipsis, Folder, GitBranch, LoaderIcon } from "lucide-react";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useBaseWorkspaceServices, useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useWorkspaceSessionsIndexItems } from "@/v4/useWorkspaceSessionsIndexItems.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatRemoteWorkspaceDisplayLabel,
  formatRemoteWorkspaceHeaderHostLabel,
} from "@/lib/remoteWorkspaceHistory.js";
import { resolveWorkspaceHeaderProvider } from "@/lib/workspaceHeaderProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { resolveGitBranchTriggerLabel } from "@/git-branch-switcher/display.js";
import type {
  WorkspaceHeaderState,
  WorkspaceHeaderTitleSectionProps,
} from "@/WorkspaceHeaderSections/shared.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import {
  RemoteSyncDialogs,
  RemoteSyncMenuItems,
  shouldShowRemoteSyncActions,
} from "@/settings/RemoteSyncActions.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "@/lib/remotePluginSyncRefresh.js";
import { useMcpStore } from "@/store/mcpStore.js";

export type { WorkspaceHeaderState, WorkspaceHeaderTitleSectionProps };
export {
  WorkspaceHeaderActionSection,
  type WorkspaceHeaderActionSectionProps,
} from "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js";

export function shouldShowRemoteSkillSyncAction(params: {
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  hasLocalSourceService?: boolean;
}): boolean {
  return shouldShowRemoteSyncActions(params);
}

export function WorkspaceHeaderTitleSection({
  variant,
  readOnlyReason,
  workspaceAbsPath,
  remoteSessionId,
  workspaceIdentity,
  remoteTarget,
  localWorkspacePath,
  projectName,
  activeTaskTitle,
  activeTaskChangeSummary: _activeTaskChangeSummary,
  activeTaskId,
  activeTraceId: _activeTraceId,
  activeSessionId,
  activeTaskProvider,
  resolvedActiveTaskMeta,
  gitSummary,
  gitDirtyFileCount: _gitDirtyFileCount,
  sessionLogPath: _sessionLogPath,
  nativeSessionLogProvider: _nativeSessionLogProvider,
  nativeSessionLogPath: _nativeSessionLogPath,
  nativeSessionLogExists: _nativeSessionLogExists,
  nativeSessionLogLoading: _nativeSessionLogLoading,
  providerWorkspaceConfigPath: _providerWorkspaceConfigPath,
  providerWorkspaceConfigExists: _providerWorkspaceConfigExists,
  providerWorkspaceConfigLoading: _providerWorkspaceConfigLoading,
  reloadSessionPending,
  workspaceHeaderState,
  onRefreshGit: _onRefreshGit,
  isMacDesktop: _isMacDesktop,
  isMacFullscreen: _isMacFullscreen,
  isWindowsDesktop: _isWindowsDesktop,
  isWebRemoteControl = false,
  selectedEditor: _selectedEditor,
  simplifyForNarrowRemote = false,
  compact = false,
}: WorkspaceHeaderTitleSectionProps) {
  const { intl } = useZCodeIntl();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const confirmDialog = useConfirmDialog();
  const services = useWorkspaceServices(workspaceAbsPath, remoteSessionId, workspaceIdentity);
  const baseServices = useBaseWorkspaceServices();
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [workspaceContextOpen, setWorkspaceContextOpen] = useState(false);
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  const [remotePluginSyncOpen, setRemotePluginSyncOpen] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const headerWorkspaceTabs = useMemo(
    () => [
      {
        id: `header-${workspaceIdentity?.trim() || workspaceAbsPath}`,
        kind: "workspace" as const,
        workspacePath: workspaceAbsPath,
        label: projectName,
        remoteSessionId,
        workspaceIdentity,
      },
    ],
    [projectName, remoteSessionId, workspaceAbsPath, workspaceIdentity],
  );
  const headerPinnedTaskList = useGlobalTaskList({
    kind: "pinned",
    // Header renders persistently. Previously, it fetched the pinned task list at startup just for pin/unpin copy in the menu.
    // Membership is needed only when the more menu opens, so delay the query to reduce first-screen listTaskList calls
    // and reuse the workspace event source through useGlobalTaskList's shared subscription.
    workspaceTabs: taskMenuOpen && activeTaskId ? headerWorkspaceTabs : [],
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
  const pinnedTasks = headerPinnedTaskList.items;
  const activeTaskMeta = resolvedActiveTaskMeta ?? null;
  const isPinned = Boolean(
    activeTaskId && pinnedTasks.some((task) => task.taskId === activeTaskId),
  );
  const resolvedTaskActionTaskId = activeTaskMeta?.taskId ?? activeTaskId;
  // A new task has no stable taskId before its first database write.
  // The Header more-menu callback previously blocked the click with an empty-ID guard while the UI still looked enabled,
  // making the menu appear unresponsive. Disable only actions that require a persisted task and keep workspace-level entries.
  const disableTaskTargetActions = !resolvedTaskActionTaskId;
  const taskMenuMembershipLoading =
    taskMenuOpen && Boolean(resolvedTaskActionTaskId) && headerPinnedTaskList.loading;
  const workspaceHeaderProvider = resolveWorkspaceHeaderProvider(
    activeTaskProvider,
    workspaceHeaderState.selectedProvider,
  );
  const menuTaskProvider = activeTaskProvider ?? workspaceHeaderProvider;
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  } = useTaskListItemContextActions({
    workspacePath: workspaceAbsPath,
    remoteSessionId,
    workspaceIdentity,
    taskId: activeTaskId ?? "",
    // Task log queries use the same provider as the current Header display state.
    provider: menuTaskProvider,
    intl,
  });
  const remoteWorkspaceHostLabel = remoteTarget
    ? formatRemoteWorkspaceHeaderHostLabel(remoteTarget)
    : null;
  const workspaceDisplayLabel = formatRemoteWorkspaceDisplayLabel(projectName, remoteTarget);
  const showRemoteWorkspaceHostLabel = Boolean(
    remoteWorkspaceHostLabel && workspaceDisplayLabel === projectName,
  );
  const workspaceContextLabel = showRemoteWorkspaceHostLabel
    ? `${workspaceDisplayLabel} @ ${remoteWorkspaceHostLabel}`
    : workspaceDisplayLabel;
  // Worktree-session context (specs/composer-branch-switcher-semantics.md §3): the path button
  // describes the active chat's execution location. A session bound to an execution worktree
  // shows that directory and its branch; the sessions-index summary is the authoritative fact
  // source (same as the sidebar badge and SessionPane Git Tools), never the task-list cache.
  const agentService = useOptionalServices()?.zcodeAgentService ?? undefined;
  const sessionIndexScopes = useMemo(
    () =>
      remoteSessionId && !agentService
        ? []
        : [
            {
              workspacePath: workspaceAbsPath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
              ...(agentService ? { agentService } : {}),
            },
          ],
    [agentService, remoteSessionId, workspaceAbsPath, workspaceIdentity],
  );
  const { items: sessionIndexItems } = useWorkspaceSessionsIndexItems(sessionIndexScopes);
  const sessionExecutionWorktree = activeSessionId
    ? sessionIndexItems.find((task) => task.taskId === activeSessionId)?.executionWorktree
    : undefined;
  const workspaceBranchLabel = sessionExecutionWorktree?.branchName
    ? sessionExecutionWorktree.branchName
    : gitSummary.isRepository
      ? resolveGitBranchTriggerLabel({
          headRefType: gitSummary.headRefType,
          currentBranchName: gitSummary.branchName,
          detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
          fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
        })
      : null;
  const isRemoteWorkspace = Boolean(
    remoteWorkspaceHostLabel || workspaceIdentity?.trim() || remoteSessionId,
  );
  const showRemoteSkillSyncAction = shouldShowRemoteSkillSyncAction({
    remoteSessionId,
    remoteTarget,
    clientMode: isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
    hasLocalSourceService: Boolean(
      baseServices.skillSyncService &&
      baseServices.mcpSyncService &&
      baseServices.pluginSyncService,
    ),
  });
  const workspaceActionLoading = reloadSessionPending;
  const workspaceActionLoadingTitle = intl.formatMessage({
    id: "appHeader.workspaceSessionActionLoading",
  });
  // A new-task draft has no stable task scope; showing workspace/branch in the Header would compete with the empty-state primary copy.
  // Keep context entries hidden in draft state; for existing tasks, show workspace and branch as icons before the name.
  const isDraftNewTask = variant ? variant === "draft" : activeTaskId === null;

  const handleOpenTaskFeedback = async () => {
    const taskTitle =
      activeTaskTitle ||
      intl.formatMessage({
        id: activeTaskMeta?.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
      });
    // The Header more menu lacked a feedback entry for the current task, leaving users to copy logs and create feedback manually.
    // Prefill the feedback form with the task title, path, and log context; users choose screenshots and diagnostic logs themselves.
    openFeedbackSubmit({
      title: intl
        .formatMessage(
          { id: "feedback.submit.template.section.taskFeedbackTitle" },
          { title: taskTitle },
        )
        .slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: true,
      description: buildTaskFeedbackDescription({
        taskTitle,
        taskId: resolvedTaskActionTaskId ?? undefined,
        workspacePath: workspaceAbsPath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  };

  const handleStartRenameTask = () => {
    if (!resolvedTaskActionTaskId) {
      return;
    }
    setRenamingTaskId(resolvedTaskActionTaskId);
    setRenameDraft(activeTaskMeta?.title ?? activeTaskTitle ?? "");
  };

  const handleCancelRenameTask = () => {
    setRenamingTaskId(null);
    setRenameDraft("");
  };

  const buildHeaderTaskSnapshot = (
    fallbackTask: ZCodeTaskMeta,
    overrides?: Partial<ZCodeTaskMeta>,
  ): ZCodeTaskMeta => {
    if (activeTaskMeta) {
      return {
        ...activeTaskMeta,
        ...overrides,
      };
    }

    return {
      ...fallbackTask,
      title: activeTaskTitle ?? fallbackTask.title,
      ...overrides,
    };
  };

  const handleSubmitRenameTask = async () => {
    if (!renamingTaskId) {
      return;
    }

    const normalizedTitle = renameDraft.trim();
    const currentTitle = activeTaskMeta?.title ?? activeTaskTitle ?? "";
    if (normalizedTitle === currentTitle.trim()) {
      handleCancelRenameTask();
      return;
    }

    try {
      const renamedTask = await services.zcodeTaskService.renameTask({
        taskId: renamingTaskId,
        workspacePath: workspaceAbsPath,
        title: normalizedTitle,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      upsertOptimisticTaskListItem(workspaceAbsPath, renamedTask, workspaceIdentity);
      if (workspaceIdentity) {
        if (isPinned) {
          useRemotePinnedTaskStore.getState().upsertTask(renamedTask);
        } else {
          useRemoteTimelineTaskStore.getState().upsertTask(renamedTask);
        }
      }
      applyTaskQueryCacheMutation({
        previousTask: buildHeaderTaskSnapshot(renamedTask, {
          title: currentTitle,
        }),
        nextTask: renamedTask,
        previousState: { pinned: isPinned, archived: false },
        nextState: { pinned: isPinned, archived: false },
      });
      handleCancelRenameTask();
    } catch {
      toast(intl.formatMessage({ id: "taskList.renameFailed" }));
    }
  };

  const handleArchiveTask = async () => {
    if (!resolvedTaskActionTaskId) {
      return;
    }

    // “Archive task” in the Header more menu previously executed immediately,
    // unlike the confirmation in Sidebar, making it easy to archive accidentally while exploring the menu.
    // Show the existing ConfirmDialog first, then reuse the current archive flow.
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "confirmDialog.taskArchiveTitle" }),
      description: intl.formatMessage(
        { id: "confirmDialog.taskArchiveDescription" },
        {
          taskTitle:
            activeTaskMeta?.title?.trim() ||
            activeTaskTitle?.trim() ||
            intl.formatMessage({ id: "taskList.untitled" }),
        },
      ),
      confirmLabel: intl.formatMessage({ id: "taskList.archive" }),
    });
    if (!confirmed) {
      return;
    }

    handleCancelRenameTask();
    void services.zcodeTaskService
      .archiveTask({
        taskId: resolvedTaskActionTaskId,
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((meta) => {
        // The Header more menu cannot rely only on zcodeTaskMetaMerge, which updates only old list state after archiving.
        // Clear runtime state and SQLite cache as Sidebar does so the list refreshes after a Header action.
        removeTaskState(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
        if (workspaceIdentity) {
          useRemotePinnedTaskStore
            .getState()
            .removeTask(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
          useRemoteTimelineTaskStore
            .getState()
            .removeTask(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
        }
        applyTaskQueryCacheMutation({
          previousTask: buildHeaderTaskSnapshot(meta),
          nextTask: meta,
          previousState: { pinned: isPinned, archived: false },
          nextState: { pinned: false, archived: true },
        });
      });
  };

  return (
    <div
      className={cn(
        // The title area must size to its content, not stretch across the full Header with flex-1.
        // The parent Header is a drag region; if the no-drag title area fills the remaining space, blank macOS/Windows title-bar areas cannot drag the window.
        "flex min-w-0 items-center gap-2 overflow-hidden [app-region:no-drag]",
        simplifyForNarrowRemote && "max-md:gap-1",
      )}
    >
      <TaskRenameDialog
        open={!isDraftNewTask && renamingTaskId !== null}
        value={renameDraft}
        inputRef={renameInputRef}
        intl={intl}
        onOpenChange={(open) => {
          if (!open) {
            handleCancelRenameTask();
          }
        }}
        onChange={setRenameDraft}
        onCancel={handleCancelRenameTask}
        onConfirm={() => {
          void handleSubmitRenameTask();
        }}
      />
      {!isDraftNewTask ? (
        <ControlHintTooltip
          open={workspaceContextOpen}
          onOpenChange={setWorkspaceContextOpen}
          side="bottom"
          align="start"
          className="w-72 items-start border-popover-border bg-popover p-3 text-popover-foreground shadow-md [&>span:first-child]:min-w-0 [&>span:first-child]:flex-1 [&>span:first-child]:text-ui-base [&>span:first-child]:text-popover-foreground"
          title={
            <span
              data-workspace-header-context-info=""
              className="flex w-full min-w-0 flex-col gap-3 text-left"
            >
              <span className="flex min-w-0 items-start gap-2">
                {isRemoteWorkspace ? (
                  <Cloud className="size-4 shrink-0" />
                ) : (
                  <Folder className="size-4 shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {workspaceContextLabel}
                  </span>
                  {workspaceContextOpen ? (
                    <WorkspaceContextPath
                      workspacePath={sessionExecutionWorktree?.path ?? workspaceAbsPath}
                      workspaceIdentity={workspaceIdentity}
                      remoteSessionId={remoteSessionId}
                    />
                  ) : null}
                </span>
              </span>
              {workspaceContextOpen ? (
                <WorkspaceLastActivity
                  task={activeTaskMeta?.taskId === activeTaskId ? activeTaskMeta : null}
                />
              ) : null}
              {workspaceBranchLabel ? (
                <span className="flex min-w-0 items-center gap-2 border-t border-border/50 pt-3 font-normal">
                  <GitBranch className="size-4 shrink-0" />
                  <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {workspaceBranchLabel}
                  </span>
                </span>
              ) : null}
            </span>
          }
        >
          <Button
            type="button"
            variant="ghost"
            size={compact ? "icon-sm" : "icon-md"}
            data-testid={TID_WORKSPACE_PATH}
            aria-label={[workspaceContextLabel, workspaceBranchLabel].filter(Boolean).join(" · ")}
            onClick={() => setWorkspaceContextOpen(true)}
          >
            {isRemoteWorkspace ? (
              <Cloud className="size-4 text-foreground-subtle" />
            ) : (
              <Folder className="size-4 text-foreground-subtle" />
            )}
          </Button>
        </ControlHintTooltip>
      ) : null}
      <h1
        data-testid={TID_WORKSPACE_TITLE}
        className={cn(
          "flex min-w-12 max-w-100 shrink items-center gap-2 truncate font-semibold text-foreground @max-[560px]/workspace-header:max-w-[30vw] @max-[420px]/workspace-header:max-w-[22vw]",
          simplifyForNarrowRemote && "max-md:max-w-[42vw]",
          compact ? "text-[0.92rem]" : "text-ui-base",
        )}
        title={activeTaskTitle}
      >
        <span className="min-w-0 truncate">{activeTaskTitle}</span>
        {/* {activeTaskChangeSummary ? (
          <>
            {activeTaskChangeSummary.added > 0 ? (
              <span className="text-diff-added">
                +{activeTaskChangeSummary.added}
              </span>
            ) : null}
            {activeTaskChangeSummary.removed > 0 ? (
              <span className="text-diff-removed">
                -{activeTaskChangeSummary.removed}
              </span>
            ) : null}
          </>
        ) : null} */}
      </h1>
      <WorkspaceHeaderPullRequestChip
        task={activeTaskMeta?.taskId === activeTaskId ? activeTaskMeta : null}
      />
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        {!isDraftNewTask ? (
          <DropdownMenu open={taskMenuOpen} onOpenChange={setTaskMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size={compact ? "icon-sm" : "icon-md"}
                data-testid={TID_WORKSPACE_MORE_BUTTON}
                aria-label={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {showRemoteSkillSyncAction && remoteTarget ? (
                <>
                  <RemoteSyncMenuItems
                    canSyncSkills
                    canSyncMcp
                    canSyncPlugins
                    onOpenSkillSync={() => setRemoteSkillSyncOpen(true)}
                    onOpenMcpSync={() => setRemoteMcpSyncOpen(true)}
                    onOpenPluginSync={() => setRemotePluginSyncOpen(true)}
                  />
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <TaskActionMenuContent
                intl={intl}
                isPinned={isPinned}
                fileManagerLabel={fileManagerLabel}
                taskSessionFile={taskSessionFile}
                activeSessionId={activeSessionId}
                taskNativeSessionLogFile={taskNativeSessionLogFile}
                providerConfigFile={providerConfigFile}
                disableTaskTargetActions={disableTaskTargetActions || taskMenuMembershipLoading}
                disableTaskActions={Boolean(readOnlyReason)}
                disabledReason={readOnlyReason}
                disablePinTaskAction={taskMenuMembershipLoading}
                hideMobileUnsupportedActions={simplifyForNarrowRemote}
                Item={DropdownMenuItem}
                Separator={DropdownMenuSeparator}
                onTogglePinTask={() => {
                  if (!resolvedTaskActionTaskId) {
                    return;
                  }
                  const optimisticTask = activeTaskMeta ?? null;
                  if (optimisticTask) {
                    // Bugfix: Toggling a pin in the header used to update the list cache only after the RPC succeeded,
                    // so the pinned section could be overwritten by stale query results while the request was pending. Toggle optimistically and roll back on failure.
                    if (workspaceIdentity && !isPinned) {
                      useRemotePinnedTaskStore.getState().upsertTask(optimisticTask);
                      useRemoteTimelineTaskStore
                        .getState()
                        .removeTask(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
                    }
                    if (workspaceIdentity && isPinned) {
                      useRemotePinnedTaskStore
                        .getState()
                        .removeTask(workspaceAbsPath, resolvedTaskActionTaskId, workspaceIdentity);
                      useRemoteTimelineTaskStore.getState().upsertTask(optimisticTask);
                    }
                    applyTaskQueryCacheMutation({
                      previousTask: optimisticTask,
                      nextTask: optimisticTask,
                      previousState: { pinned: isPinned, archived: false },
                      nextState: { pinned: !isPinned, archived: false },
                    });
                  }
                  void services.zcodeTaskService
                    .setTaskPinned({
                      taskId: resolvedTaskActionTaskId,
                      workspacePath: workspaceAbsPath,
                      pinned: !isPinned,
                      ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    })
                    .then((meta) => {
                      removeOptimisticTaskListItem(
                        workspaceAbsPath,
                        resolvedTaskActionTaskId,
                        workspaceIdentity,
                      );
                      if (workspaceIdentity && !isPinned) {
                        useRemotePinnedTaskStore.getState().upsertTask(meta);
                        useRemoteTimelineTaskStore
                          .getState()
                          .removeTask(
                            workspaceAbsPath,
                            resolvedTaskActionTaskId,
                            workspaceIdentity,
                          );
                      }
                      if (workspaceIdentity && isPinned) {
                        useRemotePinnedTaskStore
                          .getState()
                          .removeTask(
                            workspaceAbsPath,
                            resolvedTaskActionTaskId,
                            workspaceIdentity,
                          );
                        useRemoteTimelineTaskStore.getState().upsertTask(meta);
                      }
                      applyTaskQueryCacheMutation({
                        previousTask: buildHeaderTaskSnapshot(meta),
                        nextTask: meta,
                        previousState: { pinned: !isPinned, archived: false },
                        nextState: { pinned: !isPinned, archived: false },
                      });
                    })
                    .catch(() => {
                      if (optimisticTask) {
                        if (workspaceIdentity && !isPinned) {
                          useRemotePinnedTaskStore
                            .getState()
                            .removeTask(
                              workspaceAbsPath,
                              resolvedTaskActionTaskId,
                              workspaceIdentity,
                            );
                          useRemoteTimelineTaskStore.getState().upsertTask(optimisticTask);
                        }
                        if (workspaceIdentity && isPinned) {
                          useRemotePinnedTaskStore.getState().upsertTask(optimisticTask);
                          useRemoteTimelineTaskStore
                            .getState()
                            .removeTask(
                              workspaceAbsPath,
                              resolvedTaskActionTaskId,
                              workspaceIdentity,
                            );
                        }
                        applyTaskQueryCacheMutation({
                          previousTask: optimisticTask,
                          nextTask: optimisticTask,
                          previousState: { pinned: !isPinned, archived: false },
                          nextState: { pinned: isPinned, archived: false },
                        });
                      }
                      toast(intl.formatMessage({ id: "taskList.pinFailed" }));
                    });
                }}
                onStartRenameTask={handleStartRenameTask}
                onArchiveTask={() => {
                  void handleArchiveTask();
                }}
                onMarkTaskAsUnread={() => {
                  if (!resolvedTaskActionTaskId) {
                    return;
                  }
                  void services.zcodeTaskService
                    .setTaskUnread({
                      taskId: resolvedTaskActionTaskId,
                      workspacePath: workspaceAbsPath,
                      unread: true,
                      ...(workspaceIdentity ? { workspaceIdentity } : {}),
                    })
                    .then((meta) => {
                      setTaskUnreadIndicator(
                        workspaceAbsPath,
                        resolvedTaskActionTaskId,
                        true,
                        workspaceIdentity,
                      );
                      upsertOptimisticTaskListItem(workspaceAbsPath, meta, workspaceIdentity);
                      if (workspaceIdentity) {
                        if (isPinned) {
                          useRemotePinnedTaskStore.getState().upsertTask(meta);
                        } else {
                          useRemoteTimelineTaskStore.getState().upsertTask(meta);
                        }
                      }
                      applyTaskQueryCacheMutation({
                        previousTask: buildHeaderTaskSnapshot(meta),
                        nextTask: meta,
                        previousState: { pinned: isPinned, archived: false },
                        nextState: { pinned: isPinned, archived: false },
                      });
                    });
                }}
                onOpenTaskFeedback={() => {
                  void handleOpenTaskFeedback();
                }}
                onOpenTaskPathInFileManager={() => {
                  void handleOpenTaskPathInFileManager();
                }}
                onCopyWorkspacePath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyPath" }),
                    workspaceAbsPath,
                  );
                }}
                onCopyTaskPath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyTaskPath" }),
                    taskSessionFile.path,
                  );
                }}
                onCopyTaskLogPath={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copyLogPath" }),
                    taskNativeSessionLogFile.path,
                  );
                }}
                onCopySessionId={() => {
                  void handleCopyText(
                    intl.formatMessage({ id: "appHeader.copySessionId" }),
                    activeSessionId,
                  );
                }}
                onViewModelTrajectory={
                  resolvedTaskActionTaskId
                    ? () => {
                        useModelTrajectoryStore.getState().requestOpen({
                          taskId: resolvedTaskActionTaskId,
                          workspaceKey: workspaceIdentity?.trim() || workspaceAbsPath,
                          title: activeTaskMeta?.title ?? null,
                        });
                      }
                    : undefined
                }
                onOpenProviderConfig={() => {
                  void handleOpenProviderConfig();
                }}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <RemoteSyncDialogs
          canSyncSkills={showRemoteSkillSyncAction}
          canSyncMcp={showRemoteSkillSyncAction}
          canSyncPlugins={showRemoteSkillSyncAction}
          skillOpen={remoteSkillSyncOpen}
          mcpOpen={remoteMcpSyncOpen}
          pluginOpen={remotePluginSyncOpen}
          onSkillOpenChange={setRemoteSkillSyncOpen}
          onMcpOpenChange={setRemoteMcpSyncOpen}
          onPluginOpenChange={setRemotePluginSyncOpen}
          localSkillSyncService={baseServices.skillSyncService}
          remoteSkillSyncService={services.skillSyncService}
          localMcpSyncService={baseServices.mcpSyncService}
          remoteMcpSyncService={services.mcpSyncService}
          localPluginSyncService={baseServices.pluginSyncService}
          remotePluginSyncService={services.pluginSyncService}
          localZCodeAgentService={baseServices.zcodeAgentService}
          remoteZCodeAgentService={services.zcodeAgentService}
          remoteTarget={remoteTarget}
          skillWorkspacePath={workspaceAbsPath}
          mcpWorkspacePath={workspaceAbsPath}
          pluginWorkspacePath={workspaceAbsPath}
          pluginLocalWorkspacePath={localWorkspacePath}
          mcpLocalWorkspacePath={localWorkspacePath}
          workspaceIdentity={workspaceIdentity}
          onSkillsSynced={async () => {
            await invalidateDeferredDraftSessionForSkillChange({
              zcodeSessionService: services.zcodeSessionService,
              workspacePath: workspaceAbsPath,
              workspaceIdentity,
              reason: "header-remote-skill-sync",
            });
            await refreshSharedSkillStoreForWorkspace({
              workspacePath: workspaceAbsPath,
              workspaceIdentity,
              skillsService: services.skillsService,
            });
          }}
          onMcpSynced={async () => {
            await useMcpStore
              .getState()
              .ensureLoadedForWorkspace(
                workspaceAbsPath,
                services.mcpSyncService,
                workspaceIdentity,
              );
          }}
          onPluginsSynced={async () => {
            await refreshWorkspacePluginCapabilitiesAfterRemoteSync({
              commandsService: services.commandsService,
              mcpSyncService: services.mcpSyncService,
              reason: "header-remote-plugin-sync",
              skillsService: services.skillsService,
              workspaceIdentity,
              workspacePath: workspaceAbsPath,
              zcodeAgentService: services.zcodeAgentService,
              zcodeSessionService: services.zcodeSessionService,
            });
          }}
        />
        {!isDraftNewTask && workspaceActionLoading ? (
          <ControlHintTooltip
            title={workspaceActionLoadingTitle}
            side="bottom"
            align="start"
            className="max-w-84 items-start px-2 py-1.5"
          >
            <span
              role="img"
              aria-label={workspaceActionLoadingTitle}
              className={cn(
                "inline-flex items-center justify-center rounded-full text-foreground-subtle",
                compact ? "size-6" : "size-7",
              )}
            >
              <LoaderIcon className={cn("animate-spin", compact ? "size-3.5" : "size-4")} />
            </span>
          </ControlHintTooltip>
        ) : null}
      </div>
    </div>
  );
}
