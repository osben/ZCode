import { ChildSessionCountsMarker } from "@/components/ChildSessionCountsMarker.js";
import {
  isChildSessionsExpanded,
  persistChildSessionsExpanded,
} from "@/lib/childSessionExpansionPreference.js";
import { TaskChildSessionRows } from "@/workspace-grouped-tasks/task-child-sessions.js";
/* eslint-disable max-lines -- Grouped rows support both drag overlays and regular interactions, so state badges must share the same rendering semantics. */
import { memo, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import {
  isCronTask,
  isOffPeakTask,
  TID_TASK_ARCHIVE,
  testId,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import {
  Archive,
  ArrowUpToLine,
  Clock,
  CloudUpload,
  ListTree,
  LoaderIcon,
  Moon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
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
  onSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
    targetRemoteSessionId?: string,
    expectedUnreadAt?: number,
    options?: { readOnly?: boolean; selectionSideChat?: boolean },
  ) => void;
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
          "bg-icon-blue"
        : null;
  const hasLeadingStatus = leadingIndicator === "loading" || statusDotClassName !== null;
  const canShowHoverActions = !dragOverlay;
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
          ) : null}
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
                <span
                  data-unread-indicator={leadingIndicator === "unread" ? "true" : undefined}
                  className={cn("size-1.5 rounded-full", statusDotClassName)}
                />
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
            {!hasPendingInteraction ? (
              <ChildSessionCountsMarker task={task} expanded={false} />
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
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const taskRowElementRef = useRef<HTMLDivElement | null>(null);
  const archiveConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  // Set only when Archive held focus (keyboard activation); mouse clicks never focus it.
  const focusArchiveConfirmRef = useRef(false);
  const hasPendingInteractionForArchive = Boolean(task.pendingInteraction);
  useEffect(() => {
    // A pending interaction unmounts the action cluster; drop the armed state so the row never
    // returns with a ready-to-fire Confirm button.
    if (hasPendingInteractionForArchive) {
      focusArchiveConfirmRef.current = false;
      setArchiveConfirming(false);
    }
  }, [hasPendingInteractionForArchive]);
  useEffect(() => {
    if (archiveConfirming && focusArchiveConfirmRef.current) {
      focusArchiveConfirmRef.current = false;
      // Archive unmounts when it turns into Confirm; hand focus over so a second Enter confirms.
      archiveConfirmButtonRef.current?.focus();
    }
  }, [archiveConfirming]);
  useEffect(() => {
    if (!archiveConfirming) {
      return;
    }
    const cancel = () => setArchiveConfirming(false);
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && taskRowElementRef.current?.contains(event.target)) {
        return;
      }
      cancel();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [archiveConfirming]);
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
  // Child-conversation list expansion is per-parent and per-device (localStorage); the marker
  // doubles as the expander, so no row-level chrome is added (spec: sidebar-child-conversation-counts.md).
  const [childSessionsExpanded, setChildSessionsExpanded] = useState(() =>
    isChildSessionsExpanded(task.taskId),
  );
  const handleToggleChildSessions = () => {
    const next = !childSessionsExpanded;
    persistChildSessionsExpanded(task.taskId, next);
    setChildSessionsExpanded(next);
  };
  // The hover action archives the task, so it takes the same two-step inline confirmation as
  // Project/Pinned rows; a single stray click must not archive (spec: ui-accidental-action-guards.md).
  const handleArchiveAction = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (workspaceActionsDisabled) {
      return;
    }
    if (!archiveConfirming) {
      focusArchiveConfirmRef.current = event.currentTarget === document.activeElement;
      setArchiveConfirming(true);
      return;
    }
    setArchiveConfirming(false);
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
    taskRowElementRef.current = element;
    draggable.setNodeRef(element);
    droppable.setNodeRef(element);
  };
  const groupedTaskDomKey = typeof dragId === "string" ? encodeURIComponent(dragId) : undefined;
  // Bug cause: Changing CSS from hidden to flex gives the action trigger its layout size only when the pointer arrives,
  // so the Tooltip Portal may first render at an unpositioned coordinate. Mount actions based on interaction state,
  // preserving keyboard, touch-device, and mobile-remote-control entry points for the active task.
  const shouldMountHoverActions =
    !task.pendingInteraction &&
    (taskRowHovered || taskRowFocusWithin || isHoverNone || isMobileActive || archiveConfirming);
  // On touch devices, isHoverNone keeps actions visible; retain time, status dots, and cron/off-peak metadata,
  // yielding only during actual hover/focus interaction so mobile does not permanently lose task state.
  const shouldSuppressTaskMetadata = taskRowHovered || taskRowFocusWithin || archiveConfirming;
  const archiveLabel = intl.formatMessage({
    id: archiveConfirming ? "common.confirm" : "taskList.archive",
  });

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
          ) : null}
          {!shouldSuppressTaskMetadata || hasLeadingStatus ? (
            <span className="flex shrink-0 items-center gap-1">
              {hasLeadingStatus && leadingIndicator === "loading" ? (
                <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" />
              ) : hasLeadingStatus && statusDotClassName ? (
                <span
                  aria-hidden="true"
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  <span
                    data-unread-indicator={leadingIndicator === "unread" ? "true" : undefined}
                    className={cn("size-1.5 rounded-full", statusDotClassName)}
                  />
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
          {!hasPendingInteraction ? (
            // Deliberately OUTSIDE the hover-suppressed metadata span above: the marker doubles as
            // the child-list expander, so it must stay mounted and clickable while hover/focus swap
            // the neighboring metadata for the hover-action cluster (mouseenter would otherwise
            // unmount it before the click lands).
            <ChildSessionCountsMarker
              task={task}
              expanded={childSessionsExpanded}
              onToggle={handleToggleChildSessions}
            />
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
              {archiveConfirming ? (
                <ControlHintTooltip title={archiveLabel} side="top" align="center">
                  <Button
                    ref={archiveConfirmButtonRef}
                    type="button"
                    variant="destructive"
                    size="sm"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    // Same as TaskRowActionButton: keep the row's dnd-kit pointer listener from starting a drag.
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={handleArchiveAction}
                    data-testid={testId(TID_TASK_ARCHIVE, task.taskId)}
                    className="shrink-0 border-destructive/20 px-2"
                    aria-label={archiveLabel}
                  >
                    <span>{archiveLabel}</span>
                  </Button>
                </ControlHintTooltip>
              ) : (
                <TaskRowActionButton
                  label={archiveLabel}
                  onClick={handleArchiveAction}
                  showTooltip
                  disabledReason={workspaceActionsDisabledReason}
                  testId={testId(TID_TASK_ARCHIVE, task.taskId)}
                >
                  {task.workspaceIdentity?.trim() ? (
                    // Remote archive writes to the remote host's index; match TaskListItem's cloud glyph.
                    <CloudUpload className="size-3.5" />
                  ) : (
                    <Archive className="size-3.5" />
                  )}
                </TaskRowActionButton>
              )}
            </span>
          ) : null}
        </span>
      </span>
      {workflowRunLinesNode}
      {childSessionsExpanded ? (
        <TaskChildSessionRows task={task} onSelectTask={onSelectTask} />
      ) : null}
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
