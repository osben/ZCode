/* eslint-disable max-lines -- The task item handles shared interactions for the default list and two-row timeline layout; keep the action flow together to avoid archive/pin regressions. */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Clock,
  CloudUpload,
  ListTree,
  LoaderIcon,
  Moon,
  Pin,
  Smartphone,
} from "lucide-react";
import { isCronTask, isOffPeakTask, type ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_ARCHIVE, TID_TASK_ITEM, testId } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { IncognitoTaskMarker } from "@/components/IncognitoTaskMarker.js";
import { WorktreeTaskMarker } from "@/components/WorktreeTaskMarker.js";
import { TaskPullRequestMarker } from "@/components/TaskPullRequestMarker.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskTitleWithChanges, getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { TaskListItemContextMenu } from "@/TaskListItemContextMenu.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { toast } from "@/components/ui/toast.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useV4SplitPaneEntry } from "@/v4/splitPaneEntryContext.js";
import { buildWorkbenchSessionKey, useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import {
  WORKBENCH_SESSION_DRAG_MIME,
  clearActiveWorkbenchSessionDragPayload,
  serializeWorkbenchSessionDragPayload,
  setActiveWorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { createTaskWorkbenchDragPreview } from "@/lib/taskWorkbenchDragPreview.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import {
  TaskWorkflowRunLines,
  type TaskWorkflowRunLinesIntl,
} from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip.js";
import { TaskSidebarHoverCard } from "@/components/TaskSidebarHoverCard.js";

type TaskListItemIntl = TaskWorkflowRunLinesIntl;

interface TaskListItemProps {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  isActive: boolean;
  isMobileActive?: boolean;
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (e: React.MouseEvent, taskId: string) => void;
  onCancelArchiveConfirm: () => void;
  isArchiveConfirming: boolean;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu?: (taskId: string) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  variant?: "default" | "timeline";
  showPinAction?: boolean;
  intl: TaskListItemIntl;
  actionsDisabled?: boolean;
  actionsDisabledReason?: string;
}

function areJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function getTaskAutomationIdentity(task: ZCodeTaskMeta): string | undefined {
  return task.cronAutomationId ?? (task as ZCodeTaskMeta & { automationId?: string }).automationId;
}

function areTaskListItemTaskFieldsEqual(left: ZCodeTaskMeta, right: ZCodeTaskMeta) {
  if (left === right) {
    return true;
  }

  return (
    left.taskId === right.taskId &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.provider === right.provider &&
    left.title === right.title &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.updatedAt === right.updatedAt &&
    left.unreadAt === right.unreadAt &&
    getTaskAutomationIdentity(left) === getTaskAutomationIdentity(right) &&
    left.status === right.status &&
    areJsonFieldsEqual(left.executionWorktree, right.executionWorktree) &&
    left.executionWorktreeMissing === right.executionWorktreeMissing &&
    areJsonFieldsEqual(left.pendingInteraction, right.pendingInteraction) &&
    areJsonFieldsEqual(getTaskListRowActivity(left), getTaskListRowActivity(right)) &&
    areJsonFieldsEqual(left.changeSummary, right.changeSummary)
  );
}

function areTaskListItemPropsEqual(left: TaskListItemProps, right: TaskListItemProps) {
  return (
    left.workspacePath === right.workspacePath &&
    left.remoteSessionId === right.remoteSessionId &&
    areTaskListItemTaskFieldsEqual(left.task, right.task) &&
    left.isPinned === right.isPinned &&
    left.isActive === right.isActive &&
    left.isMobileActive === right.isMobileActive &&
    left.isArchiveConfirming === right.isArchiveConfirming &&
    left.variant === right.variant &&
    left.showPinAction === right.showPinAction &&
    left.intl === right.intl &&
    left.actionsDisabled === right.actionsDisabled &&
    left.actionsDisabledReason === right.actionsDisabledReason &&
    left.onSelectTask === right.onSelectTask &&
    left.onArchiveTaskInline === right.onArchiveTaskInline &&
    left.onCancelArchiveConfirm === right.onCancelArchiveConfirm &&
    left.onTogglePinTask === right.onTogglePinTask &&
    left.onStartRenameTask === right.onStartRenameTask &&
    left.onArchiveTask === right.onArchiveTask &&
    left.onMarkTaskAsUnread === right.onMarkTaskAsUnread &&
    left.onOpenTaskContextMenu === right.onOpenTaskContextMenu &&
    left.onOpenFileTree === right.onOpenFileTree
  );
}

export const MemoTaskItem = memo(function TaskListItem({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  isActive,
  isMobileActive = false,
  onSelectTask,
  onArchiveTaskInline,
  onCancelArchiveConfirm,
  isArchiveConfirming,
  onTogglePinTask,
  onOpenTaskContextMenu,
  onOpenFileTree,
  variant = "default",
  showPinAction = true,
  intl,
  actionsDisabled = false,
  actionsDisabledReason,
}: TaskListItemProps) {
  const [hoverActionsVisible, setHoverActionsVisible] = useState(false);
  const [focusActionsVisible, setFocusActionsVisible] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const itemRef = useRef<HTMLLIElement | null>(null);
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      actionsDisabled || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (actionsDisabledReason ??
      intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });

  useEffect(() => {
    if (!isArchiveConfirming) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancelArchiveConfirm();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && itemRef.current?.contains(target)) {
        return;
      }
      onCancelArchiveConfirm();
    }

    // Confirmation keys in the global timeline and pinned list include workspacePath; on Windows,
    // backslashes are treated as escapes in CSS selectors, so the confirmation button was incorrectly detected as an outside click.
    // Use the confirmation item's own ref to determine event boundaries and avoid coupling business keys to CSS syntax.
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isArchiveConfirming, onCancelArchiveConfirm]);

  const splitPaneEntryEnabled = useV4SplitPaneEntry().enabled;
  const taskWorkspaceScope = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, task.workspaceIdentity, workspacePath],
  );
  const taskWorkbenchSessionKey = useMemo(
    () => buildWorkbenchSessionKey(taskWorkspaceScope, task.taskId),
    [task.taskId, taskWorkspaceScope],
  );
  const isSessionInWorkbenchGroup = useWorkbenchGroupStore((state) =>
    Boolean(state.sessionIndex[taskWorkbenchSessionKey]),
  );
  const canDragToWorkbench =
    !workspaceActionsDisabled && splitPaneEntryEnabled && !isSessionInWorkbenchGroup;

  // V4 runtime/interaction state is now projected by sessions-index, and the old Zustand map no longer receives
  // background-session deltas. The row consumes the activity sidecar delivered with each list entry, avoiding false idle states for spinners/attention.
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
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
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const handleSelect = useCallback(() => {
    runUserAction({
      input: { featureId: "task.lifecycle", action: "open", trigger: "button" },
      operation: () => onSelectTask(task.taskId),
      completed: { resultSource: "optimistic_projection" },
      failureStage: "task_open",
    });
  }, [onSelectTask, task.taskId]);
  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLLIElement>) => {
      if (!canDragToWorkbench) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "copy";
      const payload = {
        kind: "zcode/session" as const,
        workspacePath,
        ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId: task.taskId,
      };
      setActiveWorkbenchSessionDragPayload(payload);
      event.dataTransfer.setData(
        WORKBENCH_SESSION_DRAG_MIME,
        serializeWorkbenchSessionDragPayload(payload),
      );
      event.dataTransfer.setData("text/plain", taskTitle);
      // The browser's default drag preview has a transparent background and unclear boundaries; keep the original row content
      // and add only the background, border, and shadow used by the grouped drag overlay.
      const cleanupDragPreview = createTaskWorkbenchDragPreview({
        clientX: event.clientX,
        clientY: event.clientY,
        dataTransfer: event.dataTransfer,
        source: event.currentTarget,
      });
      const ownerWindow = event.currentTarget.ownerDocument.defaultView;
      if (ownerWindow) {
        ownerWindow.requestAnimationFrame(cleanupDragPreview);
      } else {
        cleanupDragPreview();
      }
    },
    [
      canDragToWorkbench,
      remoteSessionId,
      task.taskId,
      task.workspaceIdentity,
      taskTitle,
      workspacePath,
    ],
  );
  const handleDragEnd = useCallback(() => {
    clearActiveWorkbenchSessionDragPayload();
  }, []);
  const handleContextMenu = useCallback(() => {
    onOpenTaskContextMenu?.(task.taskId);
  }, [onOpenTaskContextMenu, task.taskId]);
  const handleOpenFileTree = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      runUserAction({
        input: { featureId: "workbench.file", action: "open_tree", trigger: "button" },
        operation: () => onOpenFileTree?.(task),
        completed: { resultSource: "local_commit" },
        failureStage: "file_tree_open",
      });
    },
    [onOpenFileTree, task, workspaceActionsDisabled],
  );

  const handleArchive = useCallback(
    (event: React.MouseEvent) => {
      if (workspaceActionsDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      runUserAction({
        input: { featureId: "task.lifecycle", action: "archive", trigger: "button" },
        operation: () => onArchiveTaskInline(event, task.taskId),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "task_archive",
      });
    },
    [onArchiveTaskInline, task.taskId, workspaceActionsDisabled],
  );
  const handleTogglePin = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      onTogglePinTask(task.taskId, !isPinned);
    },
    [isPinned, onTogglePinTask, task.taskId, workspaceActionsDisabled],
  );
  const handleMouseEnter = useCallback(() => {
    setHoverActionsVisible(true);
  }, []);
  const handleMouseLeave = useCallback(() => {
    setHoverActionsVisible(false);
    // Archive confirmation requires a second user click; clear the hover display when the pointer leaves the row.
    // If confirmation is canceled at the same time, the button disappears as soon as the pointer leaves the row, making the second click unreliable.
  }, []);

  const leadingIndicator = useMemo(
    () => deriveTaskLeadingIndicator(task, taskActivity),
    [task, taskActivity],
  );
  const isTaskCron = isCronTask(task);
  // Determine the moon identity from the persistent meta marker; looking it up in the off-peak store loses
  // session provenance after task deletion and adds a global-store subscription to every row.
  const isTaskOffPeak = isOffPeakTask(task);
  const showTimelineIdleIndicator =
    variant === "timeline" && leadingIndicator === "none" && !isPinned;
  // The mobile remote-control marker and pinned state share the leading slot on the left.
  // If a pinned task keeps showing Pin, it overlaps the absolutely positioned phone icon. When mobile is active, show the phone icon by default and reveal the Pin action on hover.
  const showPinnedState = isPinned && leadingIndicator === "none" && !isMobileActive;
  const shouldMountWorkspaceTaskActions = hoverActionsVisible || focusActionsVisible || isHoverNone;
  // Bugfix: hover:none only means touch devices need persistent actions; it does not mean time, status, and change summaries should stay hidden.
  // Metadata yields only during actual hover/focus interaction, preserving the previous touch layout semantics of “metadata + action.”
  const shouldSuppressWorkspaceTaskMetadata = hoverActionsVisible || focusActionsVisible;
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const taskChangeSummary = getTaskChangeSummary(task);
  const isRemoteTask = Boolean(task.workspaceIdentity?.trim());
  const archiveLabel = intl.formatMessage({
    id: isArchiveConfirming ? "common.confirm" : "taskList.archive",
  });
  const taskTitleWithChanges = formatTaskTitleWithChanges(taskTitle, taskChangeSummary, intl);
  const workspaceLabel = getPathLeaf(task.workspacePath);
  const taskItemKey = `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}:${task.taskId}`;
  // Workflow run row: a second channel under the title,
  // independent from the leading 16px slot (error > unread > spinner). Mount only when the session has a run summary.
  const hasWorkflowRunLines = taskActivity?.workflowActivity !== undefined;
  const workflowRunLinesNode = hasWorkflowRunLines ? (
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
  const changeSummaryNode =
    !hasPendingInteraction && taskChangeSummary ? (
      <span className="shrink-0 text-ui-base">
        {taskChangeSummary.added > 0 ? (
          <span className="text-diff-added">+{taskChangeSummary.added}</span>
        ) : null}
        {taskChangeSummary.removed > 0 ? (
          <span className="ml-1 text-diff-removed">-{taskChangeSummary.removed}</span>
        ) : null}
      </span>
    ) : null;
  const shouldRenderArchiveAction =
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isArchiveConfirming);
  const archiveActionVisibilityClassName = isArchiveConfirming ? "flex" : "flex";
  const archiveActionNode = shouldRenderArchiveAction ? (
    /* Interaction: after a task enters “awaiting archive confirmation,” hide the archive button in the right-side hover area.
       Otherwise, the pending-confirmation state and available archive action compete for visual attention. */
    <div className={cn("items-center gap-0.5", archiveActionVisibilityClassName)}>
      {isArchiveConfirming ? (
        <ControlHintTooltip title={archiveLabel} side="top" align="center">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={handleArchive}
            data-testid={testId(TID_TASK_ARCHIVE, task.taskId)}
            // Bugfix: The archive confirmation state explicitly waits for the user to decide, so the destructive button must remain visible.
            className={cn("shrink-0 border-destructive/20 px-2", archiveActionVisibilityClassName)}
            aria-label={archiveLabel}
          >
            <span>{intl.formatMessage({ id: "common.confirm" })}</span>
          </Button>
        </ControlHintTooltip>
      ) : (
        // The regular archive button in Project/Pinned previously overrode hover:bg-background/90,
        // unlike the file-tree action on the same row; reuse the shared bg-hover action in the regular state.
        <TaskRowActionButton
          label={archiveLabel}
          onClick={handleArchive}
          showTooltip
          testId={testId(TID_TASK_ARCHIVE, task.taskId)}
        >
          {isRemoteTask ? (
            // When local and remote tasks are mixed, a generic archive icon does not indicate which SQLite database receives the action.
            // Use a cloud icon for remote tasks so users do not mistake remote archiving for local archiving.
            <CloudUpload className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
        </TaskRowActionButton>
      )}
    </div>
  ) : null;
  // When a remote task's session is not ready, the resolver rejects opening it; hide the entry in the renderer at the same time
  // to avoid showing a button that gives no feedback. Local tasks do not depend on an open tab and can still open by path directly.
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const hasLeadingStatus = leadingIndicator !== "none";
  const shouldRenderPinActionOnLeft =
    showPinAction &&
    (showPinnedState || (shouldSuppressWorkspaceTaskMetadata && !hasLeadingStatus));
  const shouldRenderPinActionOnRight =
    showPinAction && shouldSuppressWorkspaceTaskMetadata && hasLeadingStatus;
  const pinActionButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={workspaceActionsDisabled}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={handleTogglePin}
      className="inline-flex size-4 min-w-0 rounded-sm p-0 text-foreground-subtle !bg-transparent hover:text-foreground"
      aria-label={intl.formatMessage({
        id: isPinned ? "taskList.unpin" : "taskList.pin",
      })}
    >
      <Pin className="size-4" />
    </Button>
  );
  const fileTreeActionNode =
    canOpenFileTree &&
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isMobileActive) ? (
      <span className="inline-flex shrink-0">
        {/* Bugfix：The Pinned file-tree button had custom hover styling and a tooltip, making it visually inconsistent with the same action in Grouped tasks.
            Reuse the shared action to align bg-hover, sizing, and pointer behavior. */}
        <TaskRowActionButton
          label={intl.formatMessage({ id: "git.action.showTree" })}
          onClick={handleOpenFileTree}
          showTooltip
        >
          <ListTree className="size-3.5" />
        </TaskRowActionButton>
      </span>
    ) : null;
  const taskActionGroupNode =
    fileTreeActionNode || archiveActionNode || shouldRenderPinActionOnRight ? (
      <span data-task-row-actions="true" className="flex shrink-0 items-center gap-0.5">
        {fileTreeActionNode}
        {archiveActionNode}
        {shouldRenderPinActionOnRight ? pinActionButton : null}
      </span>
    ) : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <li
          ref={itemRef}
          data-testid={testId(TID_TASK_ITEM, task.taskId)}
          data-task-item-key={taskItemKey}
          data-mobile-active-task={isMobileActive ? "true" : undefined}
          data-archive-confirming-task-id={isArchiveConfirming ? task.taskId : undefined}
          onClick={handleSelect}
          onContextMenu={handleContextMenu}
          draggable={canDragToWorkbench}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onFocusCapture={() => setFocusActionsVisible(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setFocusActionsVisible(false);
            }
          }}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) {
              return;
            }
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleSelect();
            }
          }}
          className={cn(
            "group/task-item flex cursor-pointer gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]",
            // For the default 32px row, center the leading slot across the row. When a workflow run row makes the body a two-row column, align the slot with the first row.
            variant === "timeline"
              ? "items-start py-1.5"
              : hasWorkflowRunLines
                ? "items-start"
                : "items-center",
            isActive ? "bg-selected" : "hover:bg-surface-hover",
          )}
        >
          {/* Bugfix: The task list used to rely on divide-y separators, leaving a visible dark line above and below every item in the dark sidebar,
              making each item look trapped between two borders. Use list spacing and rounded item states instead,
              so the card background defines hover/active hierarchy without separators. */}

          <div
            className={cn(
              "relative flex size-4 shrink-0 items-center justify-center",
              // When the body is a vertical column (title + run rows), align the leading slot with the first row rather than the full row: centering in the default 24px first row leaves 4px above.
              variant === "timeline" ? "mt-0.5" : hasWorkflowRunLines ? "mt-1" : undefined,
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-4 items-center justify-center transition-opacity",
                shouldRenderPinActionOnLeft && "hidden",
                isMobileActive && !shouldSuppressWorkspaceTaskMetadata && "invisible",
              )}
            >
              {leadingIndicator === "error" ? (
                <span
                  data-error-indicator="true"
                  className="h-1.5 w-1.5 rounded-full bg-destructive"
                />
              ) : leadingIndicator === "unread" ? (
                <span
                  data-unread-indicator="true"
                  className="h-1.5 w-1.5 rounded-full bg-icon-blue"
                />
              ) : leadingIndicator === "loading" ? (
                <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
              ) : showTimelineIdleIndicator ? (
                <span data-idle-indicator="true" className="h-1.5 w-1.5 rounded-full bg-border" />
              ) : null}
            </span>
            {shouldRenderPinActionOnLeft ? (
              <ControlHintTooltip
                title={
                  workspaceActionsDisabledReason ??
                  intl.formatMessage({
                    id: isPinned ? "taskList.unpin" : "taskList.pin",
                  })
                }
                side="top"
                align="center"
              >
                {pinActionButton}
              </ControlHintTooltip>
            ) : null}
          </div>

          {variant === "timeline" ? (
            <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({ id: "taskList.mobileActive" })}
                    side="right"
                    align="center"
                    triggerClassName="absolute -left-6 top-2 z-10 -translate-y-1/2"
                  >
                    <span
                      data-mobile-active-task="true"
                      className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                      aria-label={intl.formatMessage({
                        id: "taskList.mobileActive",
                      })}
                    >
                      <Smartphone className="size-3.5" />
                    </span>
                  </ControlHintTooltip>
                ) : null}
                <TaskTitleOverflowText
                  className="text-ui-base text-foreground"
                  title={taskTitleWithChanges}
                >
                  {/* Bugfix: Workspace/timeline task titles previously used truncate, adding an ellipsis at the end of long titles;
                      grouped tasks now fade on the right. Apply that same title-overflow behavior to the task list to avoid two truncation styles in one sidebar. */}
                  {taskTitle}
                </TaskTitleOverflowText>
                {task.pendingInteraction ? (
                  <TaskInteractionBadge
                    interaction={task.pendingInteraction}
                    formatMessage={(id) => intl.formatMessage({ id })}
                    onSnoozeCountdown={snoozeInteractionAutoResolution}
                  />
                ) : taskAttentionDisplay ? (
                  <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
                    {taskAttentionDisplay}
                  </Badge>
                ) : null}
              </div>
              <div className="flex min-w-0 items-center justify-between gap-2 text-ui-base text-foreground-subtle h-6">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{workspaceLabel}</span>
                </div>
                <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
                  {!hasPendingInteraction ? (
                    <span
                      data-task-row-metadata="true"
                      className={cn(
                        "flex items-center gap-1.5",
                        isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                          ? "hidden"
                          : undefined,
                      )}
                    >
                      {changeSummaryNode}
                      {changeSummaryNode ? (
                        <span aria-hidden="true" className="shrink-0 text-foreground-subtlest">
                          ·
                        </span>
                      ) : null}
                      {isTaskCron ? (
                        // A scheduled-task icon must not occupy the left status slot; unread, running, and pinned-hover states all use that area.
                        // Place it before the time, matching metadata on grouped task rows so it remains visible when status changes.
                        <Clock
                          data-cron-task-icon="true"
                          aria-label={intl.formatMessage({
                            id: "taskList.cronTaskLabel",
                          })}
                          className="size-3.5 shrink-0"
                        />
                      ) : isTaskOffPeak ? (
                        <Moon
                          data-off-peak-task-icon="true"
                          aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                          className="size-3.5 shrink-0"
                        />
                      ) : null}
                      {task.executionWorktree ? (
                        // Worktree-session marker, styled like the neighboring clock/moon meta
                        // icons (specs/worktree-icon-visibility.md).
                        <WorktreeTaskMarker task={task} />
                      ) : null}
                      {task.executionWorktree ? <TaskPullRequestMarker task={task} /> : null}
                      {task.incognito ? <IncognitoTaskMarker task={task} /> : null}
                      <span className="mr-1">{taskTimeLabel}</span>
                    </span>
                  ) : null}
                  {taskActionGroupNode}
                </div>
              </div>
              {workflowRunLinesNode}
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-2">
                <div className="relative min-w-0 flex h-6 flex-1 flex-wrap items-center gap-1.5">
                  {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
                    <ControlHintTooltip
                      title={intl.formatMessage({ id: "taskList.mobileActive" })}
                      side="right"
                      align="center"
                      triggerClassName="absolute -left-6 top-1/2 z-10 -translate-y-1/2"
                    >
                      <span
                        data-mobile-active-task="true"
                        className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                        aria-label={intl.formatMessage({
                          id: "taskList.mobileActive",
                        })}
                      >
                        {/* Bugfix: mobileViewState already tells the desktop which task the phone is viewing,
                        but the list did not use this state, making users think only the desktop was active. The previous version put the icon in the title’s flex flow,
                        pushing the current title right and misaligning task titles. Position it in the existing leading slot instead,
                        so title text stays in its original position; hide the phone indicator on hover to restore the pin button. */}
                        <Smartphone className="size-3.5" />
                      </span>
                    </ControlHintTooltip>
                  ) : null}
                  <TaskTitleOverflowText
                    className="text-ui-base text-foreground"
                    title={taskTitleWithChanges}
                  >
                    {/* Bugfix: Default workspace task items and timeline items share title-overflow behavior;
                        use a mask fade instead of an ellipsis, matching grouped task rows. */}
                    {taskTitle}
                  </TaskTitleOverflowText>
                  {changeSummaryNode ? (
                    <span
                      className={cn(
                        isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                          ? "hidden"
                          : undefined,
                      )}
                    >
                      {changeSummaryNode}
                    </span>
                  ) : null}
                  {task.pendingInteraction ? (
                    <TaskInteractionBadge
                      interaction={task.pendingInteraction}
                      formatMessage={(id) => intl.formatMessage({ id })}
                      onSnoozeCountdown={snoozeInteractionAutoResolution}
                    />
                  ) : taskAttentionDisplay ? (
                    <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-sm font-medium text-success dark:bg-success/18">
                      {taskAttentionDisplay}
                    </Badge>
                  ) : null}
                </div>

                {!hasPendingInteraction ? (
                  // The interaction pill already uses the right-side status slot; showing relative time too would crowd the title alongside “Awaiting confirmation.”
                  <span
                    data-task-row-metadata="true"
                    className={cn(
                      "mr-0.5 flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle",
                      isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                        ? "hidden"
                        : undefined,
                    )}
                  >
                    {isTaskCron ? (
                      // The scheduled-task icon belongs with time metadata, not the left status slot; otherwise unread/loading would displace it.
                      <Clock
                        data-cron-task-icon="true"
                        aria-label={intl.formatMessage({
                          id: "taskList.cronTaskLabel",
                        })}
                        className="size-3.5 shrink-0"
                      />
                    ) : isTaskOffPeak ? (
                      <Moon
                        data-off-peak-task-icon="true"
                        aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                        className="size-3.5 shrink-0"
                      />
                    ) : null}
                    {task.executionWorktree ? (
                      // Worktree-session marker, styled like the neighboring clock/moon meta
                      // icons (specs/worktree-icon-visibility.md).
                      <WorktreeTaskMarker task={task} />
                    ) : null}
                    {task.executionWorktree ? <TaskPullRequestMarker task={task} /> : null}
                    {task.incognito ? <IncognitoTaskMarker task={task} /> : null}
                    {taskTimeLabel}
                  </span>
                ) : null}

                {taskActionGroupNode}
              </div>
              {workflowRunLinesNode}
            </div>
          )}
        </li>
      </TooltipTrigger>
      <TaskSidebarHoverCard
        task={task}
        attentionLabel={taskAttentionDisplay}
        activity={taskActivity}
        intl={intl}
      />
    </Tooltip>
  );
}, areTaskListItemPropsEqual);

MemoTaskItem.displayName = "MemoTaskItem";

export function TaskListItemContextMenuContent({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  intl,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  disableTaskActions = false,
  disabledReason,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  intl: TaskListItemIntl;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
}) {
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      disableTaskActions || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (disabledReason ?? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  // Wrap-up: “Open in split view” is available only in the desktop shell (context is provided by WorkspaceShellLayout;
  // mobile remote control/no Provider defaults to false, so the entire menu item is omitted).
  const splitPaneEntry = useV4SplitPaneEntry();
  const splitPaneEntryEnabled = splitPaneEntry.enabled;
  const splitPaneTarget = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      sessionId: task.taskId,
    }),
    [remoteSessionId, task.taskId, task.workspaceIdentity, workspacePath],
  );
  // The shell owner decides the focused session, existing group, and pane limit; the row no longer writes to the layout store directly.
  const canOpenInSplitPane = splitPaneEntry.canOpenSession(splitPaneTarget);
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
    workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    // Row-level menus now use a single list-level instance, and this component mounts only when the menu is actually open.
    // Path and provider-configuration checks can therefore run only while open, avoiding subscriptions and calculations for each idle row.
    loadTaskPaths: true,
    loadProviderConfig: true,
  });
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });

  const handleOpenTaskFeedback = useCallback(async () => {
    // The task context menu previously offered only log/path copying, leaving no task context when reporting feedback.
    // Reuse the feedback center draft and prefill only redacted task details; users choose attachments themselves.
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
        workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  }, [
    intl,
    openFeedbackSubmit,
    task.taskId,
    taskNativeSessionLogFile.path,
    taskSessionFile.path,
    taskTitle,
    workspacePath,
  ]);

  return (
    <TaskListItemContextMenu
      intl={intl}
      isPinned={isPinned}
      fileManagerLabel={fileManagerLabel}
      taskSessionFile={taskSessionFile}
      activeSessionId={task.taskId}
      taskNativeSessionLogFile={taskNativeSessionLogFile}
      providerConfigFile={providerConfigFile}
      disableTaskActions={workspaceActionsDisabled}
      disabledReason={workspaceActionsDisabledReason}
      onTogglePinTask={() => {
        onTogglePinTask(task.taskId, !isPinned);
      }}
      onStartRenameTask={() => {
        onStartRenameTask(task.taskId, task.title);
      }}
      onArchiveTask={() => {
        onArchiveTask(task.taskId);
      }}
      onMarkTaskAsUnread={() => {
        onMarkTaskAsUnread(task.taskId);
      }}
      onOpenInSplitPane={
        splitPaneEntryEnabled
          ? () => {
              // The old entry wrote paneLayout directly, bypassing the active group and shell navigation;
              // after a draft split, the next regular click could put the session into primary. Route all requests through the shell controller.
              splitPaneEntry.openSession(splitPaneTarget);
            }
          : undefined
      }
      openInSplitPaneDisabled={workspaceActionsDisabled || !canOpenInSplitPane}
      onOpenTaskFeedback={() => {
        void handleOpenTaskFeedback();
      }}
      onOpenTaskPathInFileManager={() => {
        void handleOpenTaskPathInFileManager();
      }}
      onCopyWorkspacePath={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copyPath" }), workspacePath);
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
        void handleCopyText(intl.formatMessage({ id: "appHeader.copySessionId" }), task.taskId);
      }}
      onViewModelTrajectory={() => {
        // Send the “open trajectory” request through the singleton store to the sidebar controller for this workspace (useAppPanels).
        useModelTrajectoryStore.getState().requestOpen({
          taskId: task.taskId,
          workspaceKey: task.workspaceIdentity?.trim() || workspacePath,
          title: taskTitle,
        });
      }}
      onOpenProviderConfig={() => {
        void handleOpenProviderConfig();
      }}
    />
  );
}
