/* eslint-disable max-lines -- Grouped rows support both drag overlays and regular interactions, so state badges must share the same rendering semantics. */
import { memo, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import { isCronTask, isOffPeakTask, type ZCodeTaskMeta } from "@zcode/shared";
import { ArrowUpToLine, Clock, ListTree, LoaderIcon, Moon, X } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { BranchMergedBadge } from "@/components/BranchMergedBadge.js";
import { WorktreeTaskMarker } from "@/components/WorktreeTaskMarker.js";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { Tooltip, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { GroupedTaskContextMenuContent } from "@/workspace-grouped-tasks/task-context-menu-content.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import {
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
  type TaskGroupMenuItem,
} from "@/workspace-grouped-tasks/types.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import {
  useBranchMergeStatusStore,
  selectBranchMergeStatus,
} from "@/store/branchMergeStatusStore.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { TaskSidebarHoverCard } from "@/components/TaskSidebarHoverCard.js";

function GroupedTaskRowComponent({
  task,
  currentGroupId,
  groups,
  remoteSessionId,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  mobileActiveTaskKey,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  dragId,
  dragging,
  dragOverlay,
  tooltipsDisabled,
}: {
  task: ZCodeTaskMeta;
  currentGroupId?: string;
  groups: TaskGroupMenuItem[];
  remoteSessionId?: string;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  mobileActiveTaskKey?: string | null;
  workspaceLabel: string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  dragId?: UniqueIdentifier;
  dragging?: boolean;
  dragOverlay?: boolean;
  tooltipsDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const workspaceActionsDisabled = useOptionalTabStore((state) =>
    isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  const branchMergeStatus = useBranchMergeStatusStore((state) =>
    selectBranchMergeStatus(state, workspaceKey),
  );
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  // The interaction pill is currently the highest-priority right-side state; whether it comes from a sessions-index summary or
  // activity attention, do not display relative time beside it and squeeze the task title.
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
  // Bugfix: When the remote session is not ready, the resolver will reject opening the file tree, so do not expose
  // an invalid action; local tasks do not need remoteSessionId, so keep the entry available for them.
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const taskAttentionLabel = taskAttention
    ? intl.formatMessage({
        id: taskAttention.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
      })
    : null;
  const taskAttentionDisplay =
    taskAttention && taskAttentionLabel && taskAttention.count > 1
      ? intl.formatMessage(
          { id: "taskList.attentionCount" },
          { label: taskAttentionLabel, count: String(taskAttention.count) },
        )
      : taskAttentionLabel;
  const leadingIndicator = deriveTaskLeadingIndicator(task, taskActivity);
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const isTaskCron = isCronTask(task);
  // Determine the moon identity from the persistent meta marker; looking it up in the off-peak store loses
  // session provenance after task deletion and adds a global-store subscription to every row.
  const isTaskOffPeak = isOffPeakTask(task);
  const isActive =
    buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity) === workspaceKey &&
    activeTaskId === task.taskId;
  const isMobileActive = mobileActiveTaskKey === `${workspaceKey}:${task.taskId}`;
  const statusDotClassName =
    leadingIndicator === "error"
      ? "bg-destructive"
      : leadingIndicator === "unread"
        ? // Bugfix: the grouped task unread dot must share the sky color with the plain task
          // list so the brand color's meaning does not drift across themes.
          "bg-sky-500 dark:bg-sky-400"
        : null;
  const canShowHoverActions = !dragOverlay;
  // Merged ranks below attention/interaction: the row keeps a single right-side
  // status badge, and the merged details always stay available in the popup.
  const branchMergedBadge =
    branchMergeStatus?.state === "merged" ? (
      <BranchMergedBadge
        className={canShowHoverActions ? "group-hover/task-row:hidden" : undefined}
      />
    ) : null;
  // Workflow-run row: grouped rows also place it below the title;
  // the drag overlay is display-only and does not attach confirmation side effects or click actions.
  const workflowRunLinesNode =
    taskActivity?.workflowActivity && !dragOverlay ? (
      <TaskWorkflowRunLines
        activity={taskActivity.workflowActivity}
        isActive={isActive}
        intl={intl}
        session={{
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          sessionId: task.taskId,
        }}
      />
    ) : null;

  const taskRow = (
    <div
      role={dragOverlay ? undefined : "button"}
      tabIndex={dragOverlay ? undefined : 0}
      data-mobile-active-task={!dragOverlay && isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        dragOverlay
          ? "pointer-events-none cursor-grabbing border border-border bg-background shadow-lg opacity-100"
          : "cursor-pointer",
        isActive ? "bg-selected" : canShowHoverActions && "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText
          as="span"
          className="text-foreground"
          title={dragOverlay ? undefined : taskTitle}
        >
          {/* Bugfix: do not show an ellipsis when the grouped task title overflows; the right fade keeps the title continuous instead of crowding the status metadata on the right. */}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={dragOverlay ? undefined : snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay ? (
            <Badge
              className={cn(
                "h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18",
                canShowHoverActions && "group-hover/task-row:hidden",
              )}
            >
              {taskAttentionDisplay}
            </Badge>
          ) : (
            branchMergedBadge
          )}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1",
              canShowHoverActions && "group-hover/task-row:hidden",
            )}
          >
            {leadingIndicator === "loading" ? (
              <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
            ) : statusDotClassName ? (
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
              </span>
            ) : null}
            {!hasPendingInteraction && isTaskCron ? (
              // The drag overlay also reuses grouped-row metadata; place the clock before the time and do not make it mutually exclusive with the unread dot.
              <Clock
                data-cron-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : !hasPendingInteraction && isTaskOffPeak ? (
              <Moon
                data-off-peak-task-icon="true"
                aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                className="size-3.5 shrink-0"
              />
            ) : null}
            {!hasPendingInteraction && task.executionWorktree ? (
              // Worktree-session marker, styled like the neighboring clock/moon meta icons (the
              // shared component owns glyph, colors, and the branch+directory tooltip).
              <WorktreeTaskMarker task={task} />
            ) : null}
            {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
          </span>
        </span>
      </span>
    </div>
  );

  // During frequent DragOverlay renders, return display-only nodes to avoid Radix ref loops in hidden action tooltips and task-path RPCs.
  if (dragOverlay) return taskRow;

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [taskRowHovered, setTaskRowHovered] = useState(false);
  const [taskRowFocusWithin, setTaskRowFocusWithin] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  } = useTaskListItemContextActions({
    workspacePath: task.workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    loadTaskPaths: contextMenuOpen,
    loadProviderConfig: contextMenuOpen,
  });
  const handleSelect = () => {
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
  };
  const handleCloseTask = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onCloseTask(task);
  };
  const handleOpenFileTree = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onOpenFileTree?.(task);
  };
  const handleMoveTaskToTop = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    onMoveTaskToTop(task);
  };
  const handleOpenTaskFeedback = async () => {
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
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleSelect();
  };
  const dragDisabled = workspaceActionsDisabled || !dragId || contextMenuOpen || dragOverlay;
  const draggable = useDraggable({
    id: dragId ?? `disabled:${workspaceKey}:${task.taskId}`,
    disabled: dragDisabled,
    data: { type: "grouped-task", taskKey: dragId },
  });
  const droppable = useDroppable({
    id: dragId ?? `disabled-drop:${workspaceKey}:${task.taskId}`,
    disabled: workspaceActionsDisabled || !dragId || dragOverlay,
    data: { type: "grouped-task", taskKey: dragId },
  });

  const setTaskRowRef = (element: HTMLDivElement | null) => {
    draggable.setNodeRef(element);
    droppable.setNodeRef(element);
  };
  const groupedTaskDomKey = typeof dragId === "string" ? encodeURIComponent(dragId) : undefined;
  // Bug cause: Changing CSS from hidden to flex gives the action trigger its layout size only when the pointer arrives,
  // so the Tooltip Portal may first render at an unpositioned coordinate. Mount actions based on interaction state,
  // preserving keyboard, touch-device, and mobile-remote-control entry points for the active task.
  const shouldMountHoverActions =
    !task.pendingInteraction &&
    (taskRowHovered || taskRowFocusWithin || isHoverNone || isMobileActive);
  // On touch devices, isHoverNone keeps actions visible; retain time, status dots, and cron/off-peak metadata,
  // yielding only during actual hover/focus interaction so mobile does not permanently lose task state.
  const shouldSuppressTaskMetadata = taskRowHovered || taskRowFocusWithin;

  const interactiveTaskRow = (
    <div
      ref={setTaskRowRef}
      {...draggable.attributes}
      {...draggable.listeners}
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setTaskRowHovered(true)}
      onMouseLeave={() => setTaskRowHovered(false)}
      onFocusCapture={() => setTaskRowFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setTaskRowFocusWithin(false);
        }
      }}
      data-grouped-task-key={groupedTaskDomKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        "cursor-pointer",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText as="span" className="text-foreground" title={taskTitle}>
          {/* Bugfix: do not show an ellipsis when the grouped task title overflows; the right fade keeps the title continuous instead of crowding the status metadata on the right. */}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
              onSnoozeCountdown={snoozeInteractionAutoResolution}
            />
          ) : taskAttentionDisplay && !shouldSuppressTaskMetadata ? (
            <Badge className="h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
              {taskAttentionDisplay}
            </Badge>
          ) : !shouldSuppressTaskMetadata ? (
            branchMergedBadge
          ) : null}
          {!shouldSuppressTaskMetadata ? (
            <span className="flex shrink-0 items-center gap-1">
              {leadingIndicator === "loading" ? (
                <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
              ) : statusDotClassName ? (
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  <span className={cn("size-1.5 rounded-full", statusDotClassName)} />
                </span>
              ) : null}
              {!hasPendingInteraction && isTaskCron ? (
                // Interactive grouped rows previously omitted the clock, leaving scheduled tasks in the Projects group without an icon.
                // Place it before the time as in regular task lists, where unread/running state can no longer displace it.
                <Clock
                  data-cron-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.cronTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : !hasPendingInteraction && isTaskOffPeak ? (
                <Moon
                  data-off-peak-task-icon="true"
                  aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                  className="size-3.5 shrink-0"
                />
              ) : null}
              {!hasPendingInteraction && task.executionWorktree ? (
                // Worktree-session marker, styled like the neighboring clock/moon meta icons (the
                // shared component owns glyph, colors, and the branch+directory tooltip).
                <WorktreeTaskMarker task={task} />
              ) : null}
              {!hasPendingInteraction ? <span className="mr-1">{taskTimeLabel}</span> : null}
            </span>
          ) : null}
          {shouldMountHoverActions ? (
            <span className="flex shrink-0 items-center gap-0.5">
              {canOpenFileTree ? (
                <TaskRowActionButton
                  label={intl.formatMessage({ id: "git.action.showTree" })}
                  onClick={handleOpenFileTree}
                  showTooltip
                  disabledReason={workspaceActionsDisabledReason}
                >
                  <ListTree className="size-3.5" />
                </TaskRowActionButton>
              ) : null}
              <TaskRowActionButton
                label={intl.formatMessage({ id: "taskGroup.moveToTop" })}
                onClick={handleMoveTaskToTop}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <ArrowUpToLine className="size-3.5" />
              </TaskRowActionButton>
              <TaskRowActionButton
                label={intl.formatMessage({ id: "common.close" })}
                onClick={handleCloseTask}
                showTooltip
                disabledReason={workspaceActionsDisabledReason}
              >
                <X className="size-3.5" />
              </TaskRowActionButton>
            </span>
          ) : null}
        </span>
      </span>
      {workflowRunLinesNode}
    </div>
  );

  // A grouped row cannot be wrapped in a native button because it contains menu, close, and file-tree buttons. Keep role=button on the outer element to avoid nested buttons breaking keyboard/context-menu semantics.
  return (
    <ContextMenu onOpenChange={setContextMenuOpen}>
      {tooltipsDisabled ? (
        // During overlay dragging, Radix may still treat the real row under the pointer as hovered; skip TooltipTrigger so the underlying row/action does not show a tooltip.
        <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
      ) : (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
            </TooltipTrigger>
            <TaskSidebarHoverCard
              task={task}
              attentionLabel={taskAttentionDisplay}
              activity={taskActivity}
              branchMergeStatus={branchMergeStatus}
              intl={intl}
            />
          </Tooltip>
        </TooltipProvider>
      )}
      {contextMenuOpen ? (
        // Context-menu content uses Radix Presence/Portal; keeping it mounted during drag reordering triggers a nested update loop. Mount it only when the menu opens and lazily load paths to avoid task-path RPCs during dragging.
        <GroupedTaskContextMenuContent
          task={task}
          currentGroupId={currentGroupId}
          groups={groups}
          intl={intl}
          fileManagerLabel={fileManagerLabel}
          taskSessionFile={taskSessionFile}
          taskNativeSessionLogFile={taskNativeSessionLogFile}
          providerConfigFile={providerConfigFile}
          onMoveTaskToGroup={onMoveTaskToGroup}
          onMoveTaskToTop={onMoveTaskToTop}
          onStartRenameTask={onStartRenameTask}
          onArchiveTask={onArchiveTask}
          onMarkTaskAsUnread={onMarkTaskAsUnread}
          onOpenTaskPathInFileManager={() => void handleOpenTaskPathInFileManager()}
          onCopyText={(label, text) => void handleCopyText(label, text)}
          onOpenProviderConfig={() => void handleOpenProviderConfig()}
          onOpenTaskFeedback={() => void handleOpenTaskFeedback()}
          disabledReason={workspaceActionsDisabledReason}
        />
      ) : null}
    </ContextMenu>
  );
}
export const GroupedTaskRow = memo(GroupedTaskRowComponent);
