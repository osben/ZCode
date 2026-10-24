import { TID_TASK_ARCHIVE, TID_TASK_ITEM, testId } from "@zcode/shared/test-ids";
import type { ProjectTask as ZCodeTaskMeta } from "@/project-sidebar/contract.js";
import { memo, useContext, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { UniqueIdentifier } from "@dnd-kit/core";
import { isCronTask, isOffPeakTask } from "@zcode/shared";
import {
  Archive,
  ArrowUpToLine,
  Clock,
  CloudUpload,
  ListTree,
  LoaderIcon,
  Moon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ChildSessionCountsMarker } from "@/components/ChildSessionCountsMarker.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { routeChildSessionSelection } from "@/project-sidebar/child-session-navigation.js";
import { IncognitoTaskMarker } from "@/components/IncognitoTaskMarker.js";
import { WorktreeTaskMarker } from "@/components/WorktreeTaskMarker.js";
import { TaskPullRequestMarker } from "@/components/TaskPullRequestMarker.js";
import { TaskSidebarHoverCard } from "@/components/TaskSidebarHoverCard.js";
import {
  TaskChildSessionRows,
  useChildSessionsExpansion,
  type ChildSessionSelectOptions,
} from "@/components/TaskChildSessionRows.js";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";
import { TaskRelativeTimeLabel } from "@/TaskListItem.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { GroupedTaskContextMenuContent } from "@/project-sidebar/grouped/task-context-menu-content.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import {
  TASK_GROUP_ROW_CLASS,
  TASK_GROUP_ROW_LINE_CLASS,
  type TaskGroupMenuItem,
} from "@/project-sidebar/grouped/types.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import { useStopChildBackgroundWork } from "@/hooks/useStopChildBackgroundWork.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";

type GroupedTaskRowProps = {
  task: ZCodeTaskMeta;
  currentGroupId?: string;
  groups: TaskGroupMenuItem[];
  remoteSessionId?: string;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  mobileActiveTaskKey?: string | null;
  onSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
    options?: ChildSessionSelectOptions,
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
};

type GroupedTaskRowIntl = ReturnType<typeof useZCodeIntl>["intl"];

// Plain function, not a hook: the overlay and the interactive row share the row presentation without
// sharing any hook calls.
function deriveGroupedTaskRowPresentation({
  task,
  intl,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
}: {
  task: ZCodeTaskMeta;
  intl: GroupedTaskRowIntl;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
}) {
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  // 交互胶囊是当前最高优先级的右侧状态；无论来自 sessions-index 摘要还是
  // activity attention，都不应再并排显示相对时间并挤压任务标题。
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
  const leadingIndicator = deriveTaskLeadingIndicator(task, taskActivity);
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const isActive =
    buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity) === workspaceKey &&
    activeTaskId === task.taskId;
  const statusDotClassName =
    leadingIndicator === "error"
      ? "bg-destructive"
      : leadingIndicator === "unread"
        ? // Bugfix: grouped task 未读点需要和普通 task list 共用 sky 色，避免 brand 色在不同主题下表达漂移。
          "bg-icon-blue"
        : null;
  return {
    workspaceKey,
    taskActivity,
    hasPendingInteraction,
    taskAttentionDisplay,
    leadingIndicator,
    taskTitle,
    isTaskCron: isCronTask(task),
    // 月亮身份改为持久 meta 标记判断；off-peak store 反查在任务被删除后会丢失
    // 会话溯源，且让每一行多背一个全局 store 订阅。
    isTaskOffPeak: isOffPeakTask(task),
    isActive,
    statusDotClassName,
  };
}

// Single render owner of the grouped run-state dot/spinner. Both the interactive row and the drag
// overlay use it; the interactive row keeps it mounted on hover/focus (task-hover-card-layout #8).
function GroupedRunStateIndicator({
  leadingIndicator,
  statusDotClassName,
}: {
  leadingIndicator: "error" | "unread" | "loading" | "none";
  statusDotClassName: string | null;
}) {
  if (leadingIndicator === "loading") {
    // Rotate the HTML wrapper, not the SVG, matching TaskListItem: SVG rotation is assumed to cost a style
    // recalc per frame (hypothesis from the TaskListItem precedent, not profiled here).
    return (
      <span
        aria-hidden="true"
        className="flex size-3.5 shrink-0 items-center justify-center animate-spin"
      >
        <LoaderIcon className="size-3.5 text-foreground-subtle" />
      </span>
    );
  }
  if (!statusDotClassName) {
    return null;
  }
  return (
    <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
      <span
        data-error-indicator={leadingIndicator === "error" ? "true" : undefined}
        data-unread-indicator={leadingIndicator === "unread" ? "true" : undefined}
        className={cn("size-1.5 rounded-full", statusDotClassName)}
      />
    </span>
  );
}

// DragOverlay 高频渲染时只返回纯展示节点，避免隐藏 action tooltip 的 Radix ref 循环和 task 路径 RPC。
function GroupedTaskDragOverlayRow({
  task,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  dragging,
}: Pick<
  GroupedTaskRowProps,
  "task" | "activeWorkspacePath" | "activeWorkspaceIdentity" | "activeTaskId" | "dragging"
>) {
  const { intl } = useZCodeIntl();
  const {
    hasPendingInteraction,
    taskAttentionDisplay,
    leadingIndicator,
    taskTitle,
    isTaskCron,
    isTaskOffPeak,
    isActive,
    statusDotClassName,
  } = deriveGroupedTaskRowPresentation({
    task,
    intl,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    activeTaskId,
  });

  // The overlay is presentation only: no workflow run lines or hover actions, so it mounts no
  // confirmation side effects or click targets.
  return (
    <div
      className={cn(
        "group/task-row",
        TASK_GROUP_ROW_CLASS,
        "pointer-events-none cursor-grabbing border border-border bg-background shadow-lg opacity-100",
        isActive && "bg-selected",
        dragging && "opacity-0",
      )}
    >
      <span className={TASK_GROUP_ROW_LINE_CLASS}>
        <TaskTitleOverflowText as="span" className="text-foreground">
          {/* Bugfix: grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。 */}
          {taskTitle}
        </TaskTitleOverflowText>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
          {task.pendingInteraction ? (
            <TaskInteractionBadge
              interaction={task.pendingInteraction}
              formatMessage={(id) => intl.formatMessage({ id })}
            />
          ) : taskAttentionDisplay ? (
            <Badge className="h-5 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
              {taskAttentionDisplay}
            </Badge>
          ) : null}
          <span className="flex shrink-0 items-center gap-1">
            <GroupedRunStateIndicator
              leadingIndicator={leadingIndicator}
              statusDotClassName={statusDotClassName}
            />
            {!hasPendingInteraction && isTaskCron ? (
              // drag overlay 也复用 grouped row 元信息；clock 放时间前面，不能跟未读点互斥。
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
            {!hasPendingInteraction ? (
              <span className="mr-1">
                <TaskRelativeTimeLabel timestamp={task.updatedAt} intl={intl} />
              </span>
            ) : null}
          </span>
        </span>
      </span>
    </div>
  );
}

function GroupedTaskInteractiveRow({
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
  tooltipsDisabled,
}: Omit<GroupedTaskRowProps, "dragOverlay">) {
  const { intl } = useZCodeIntl();
  const workspaceActionsDisabled = useOptionalTabStore((state) =>
    isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" })
    : undefined;
  const stopChildBackgroundWork = useStopChildBackgroundWork(
    {
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      sessionId: task.taskId,
    },
    intl.formatMessage({ id: "taskList.childStopFailed" }),
  );
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });
  const {
    workspaceKey,
    taskActivity,
    hasPendingInteraction,
    taskAttentionDisplay,
    leadingIndicator,
    taskTitle,
    isTaskCron,
    isTaskOffPeak,
    isActive,
    statusDotClassName,
  } = deriveGroupedTaskRowPresentation({
    task,
    intl,
    activeWorkspacePath,
    activeWorkspaceIdentity,
    activeTaskId,
  });
  // Bugfix：远端 session 未就绪时打开文件树必然会被 resolver 拒绝，因此不要暴露
  // 无效 action；本地 task 不需要 remoteSessionId，仍保持入口可用。
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const isMobileActive = mobileActiveTaskKey === `${workspaceKey}:${task.taskId}`;
  // Workflow run lines sit under the title, as in the flat task list.
  const workflowRunLinesNode = taskActivity?.workflowActivity ? (
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

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [taskRowHovered, setTaskRowHovered] = useState(false);
  const [taskRowFocusWithin, setTaskRowFocusWithin] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const taskRowElementRef = useRef<HTMLDivElement | null>(null);
  const archiveConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  // Set only when Archive held focus (keyboard activation); mouse clicks never focus Confirm.
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
  // Child-conversation list expansion is per parent and per device; the marker doubles as the expander.
  const [childSessionsExpanded, handleToggleChildSessions] = useChildSessionsExpansion(task.taskId);
  // Phone rows stay unchanged (spec §7): the web remote switcher cannot open child sessions.
  const presentation = useContext(ProjectTaskListContext);
  const childSessionsEnabled = !presentation.isWebRemoteControl;
  const handleSelectChildSession = (
    sessionId: string,
    options: ChildSessionSelectOptions,
    title?: string,
  ) =>
    routeChildSessionSelection({
      parent: task,
      sessionId,
      options,
      title,
      openSubagentSession: presentation.onOpenSubagentSession,
      selectInMainPane: () =>
        onSelectTask(task.workspacePath, sessionId, task.workspaceIdentity, options),
    });
  const archiveLabel = intl.formatMessage({
    id: archiveConfirming ? "common.confirm" : "taskList.archive",
  });
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel,
    canOpenInFileManager,
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
  // The hover action archives the task, so it takes a two-step inline confirmation: one stray click
  // must not archive. Spec: specs/ui-sidebar-fork-reapplication.md, ui-accidental-action-guards.md #4.
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
  const dragDisabled = workspaceActionsDisabled || !dragId || contextMenuOpen;
  const draggable = useDraggable({
    id: dragId ?? `disabled:${workspaceKey}:${task.taskId}`,
    disabled: dragDisabled,
    data: { type: "grouped-task", taskKey: dragId },
  });
  const droppable = useDroppable({
    id: dragId ?? `disabled-drop:${workspaceKey}:${task.taskId}`,
    disabled: workspaceActionsDisabled || !dragId,
    data: { type: "grouped-task", taskKey: dragId },
  });

  const setTaskRowRef = (element: HTMLDivElement | null) => {
    taskRowElementRef.current = element;
    draggable.setNodeRef(element);
    droppable.setNodeRef(element);
  };
  const groupedTaskDomKey = typeof dragId === "string" ? encodeURIComponent(dragId) : undefined;
  // Bug 原因：CSS hidden → flex 会让 action trigger 在 pointer 到达时才获得布局尺寸，
  // Tooltip Portal 可能先以未定位坐标绘制。改为交互状态决定 action 是否挂载，
  // 同时保留键盘、触摸设备和手机远控 active task 的入口。
  const shouldMountHoverActions =
    !task.pendingInteraction &&
    (taskRowHovered || taskRowFocusWithin || isHoverNone || isMobileActive || archiveConfirming);
  // 触屏端 isHoverNone 只负责常驻 action；时间、状态点和 cron/off-peak 元信息
  // 仍应保留，仅在真实 hover / focus 交互时让位，避免手机端永久丢失任务状态。
  const shouldSuppressTaskMetadata = taskRowHovered || taskRowFocusWithin || archiveConfirming;

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
      data-testid={testId(TID_TASK_ITEM, task.taskId)}
      data-task-item-key={groupedTaskDomKey}
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
          {/* Bugfix: grouped task 标题超出时不要显示省略号，右侧渐隐能保留标题连续性，避免和右侧状态元信息挤在一起。 */}
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
          {/* Bugfix (task-hover-card-layout #8): the run-state dot stays visible beside the hover/focus
              action cluster; only the time and marker metadata yield to it. */}
          {shouldSuppressTaskMetadata ? (
            statusDotClassName || leadingIndicator === "loading" ? (
              <span className="flex shrink-0 items-center gap-1">
                <GroupedRunStateIndicator
                  leadingIndicator={leadingIndicator}
                  statusDotClassName={statusDotClassName}
                />
              </span>
            ) : null
          ) : (
            <span className="flex shrink-0 items-center gap-1">
              <GroupedRunStateIndicator
                leadingIndicator={leadingIndicator}
                statusDotClassName={statusDotClassName}
              />
              {!hasPendingInteraction && isTaskCron ? (
                // 可交互 grouped row 之前漏渲染 clock，导致 Projects 分组里的定时任务没有 icon。
                // 这里和普通 task list 一样放在时间前面，同时不再被未读/运行状态顶掉。
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
                // Worktree-session marker; the shared component owns glyph, colors and the tooltip.
                <WorktreeTaskMarker task={task} />
              ) : null}
              {!hasPendingInteraction && task.executionWorktree ? (
                <TaskPullRequestMarker task={task} />
              ) : null}
              {!hasPendingInteraction && task.incognito ? (
                <IncognitoTaskMarker task={task} />
              ) : null}
              {!hasPendingInteraction ? (
                <span className="mr-1">
                  <TaskRelativeTimeLabel timestamp={task.updatedAt} intl={intl} />
                </span>
              ) : null}
            </span>
          )}
          {!hasPendingInteraction && childSessionsEnabled ? (
            // Outside the hover-suppressed span: the marker is also the child-list expander and must
            // stay clickable while hover/focus swap the metadata for the action cluster.
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
      {childSessionsEnabled ? (
        <TaskChildSessionRows
          task={task}
          expanded={childSessionsExpanded}
          onToggle={handleToggleChildSessions}
          onSelectSession={handleSelectChildSession}
          onStopBackgroundWork={(workId) => void stopChildBackgroundWork(workId)}
        />
      ) : null}
    </div>
  );

  // grouped row 不能用原生 button 承载整行；行内还有菜单、关闭、文件树等 button，外层继续用 role=button，避免嵌套 button 破坏键盘和右键菜单语义。
  return (
    <ContextMenu onOpenChange={setContextMenuOpen}>
      {tooltipsDisabled ? (
        // overlay 拖拽时指针下方的真实 row 仍可能被 Radix 识别为 hover，跳过 TooltipTrigger 避免底层 row 或 action 弹出悬浮提示。
        <ContextMenuTrigger asChild>{interactiveTaskRow}</ContextMenuTrigger>
      ) : (
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
      )}
      {contextMenuOpen ? (
        // 右键菜单内容带 Radix Presence/Portal，拖拽重排时常驻挂载会触发嵌套更新循环；仅在菜单打开时挂载内容，配合路径懒加载避免拖拽过程刷 task path RPC。
        <GroupedTaskContextMenuContent
          task={task}
          currentGroupId={currentGroupId}
          groups={groups}
          intl={intl}
          fileManagerLabel={fileManagerLabel}
          canOpenInFileManager={canOpenInFileManager}
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

function GroupedTaskRowComponent({ dragOverlay, ...props }: GroupedTaskRowProps) {
  // Two components instead of an early return: the overlay must skip the drag/drop, context-menu and
  // task-path hooks, and one component returning before them would change its hook count whenever
  // dragOverlay flips, which React rejects ("Rendered fewer hooks than expected").
  if (dragOverlay) {
    return (
      <GroupedTaskDragOverlayRow
        task={props.task}
        activeWorkspacePath={props.activeWorkspacePath}
        activeWorkspaceIdentity={props.activeWorkspaceIdentity}
        activeTaskId={props.activeTaskId}
        dragging={props.dragging}
      />
    );
  }
  return <GroupedTaskInteractiveRow {...props} />;
}
export const GroupedTaskRow = memo(GroupedTaskRowComponent);
