import {
  TID_TASK_DELETE,
  TID_TASK_INSPECT_MENU,
  TID_TASK_VIEW_MODEL_TRAJECTORY,
  TID_TASK_VIEW_MODEL_TRAJECTORY_V2,
} from "@zcode/shared/test-ids";

interface TaskActionMenuItemProps {
  children: React.ReactNode;
  "data-testid"?: string;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
  variant?: "default" | "destructive";
}

interface TaskActionMenuSeparatorProps {
  key?: string;
}

interface TaskActionMenuSubProps {
  children: React.ReactNode;
}

interface TaskActionMenuSubTriggerProps {
  children: React.ReactNode;
  "data-testid"?: string;
  disabled?: boolean;
  title?: string;
}

export function TaskActionMenuContent({
  intl,
  isPinned,
  isArchived = false,
  fileManagerLabel,
  canOpenInFileManager,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  providerConfigFile,
  disableTaskActions = false,
  disableTaskTargetActions = false,
  disablePinTaskAction = false,
  disabledReason,
  hideMobileUnsupportedActions = false,
  Item,
  Separator,
  Sub,
  SubTrigger,
  SubContent,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onRestartTask,
  restartPending = false,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onViewModelTrajectory,
  onViewModelTrajectoryV2,
  onOpenProviderConfig,
  onDeleteTask,
  deleteDisabledReason,
}: {
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  isPinned: boolean;
  isArchived?: boolean;
  fileManagerLabel: string;
  canOpenInFileManager: boolean;
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  providerConfigFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  disableTaskActions?: boolean;
  disableTaskTargetActions?: boolean;
  disablePinTaskAction?: boolean;
  disabledReason?: string;
  hideMobileUnsupportedActions?: boolean;
  Item: React.ComponentType<TaskActionMenuItemProps>;
  Separator: React.ComponentType<TaskActionMenuSeparatorProps>;
  /** Submenu primitives (specs/session-context-menu-structure.md); without them groups render flat. */
  Sub?: React.ComponentType<TaskActionMenuSubProps>;
  SubTrigger?: React.ComponentType<TaskActionMenuSubTriggerProps>;
  SubContent?: React.ComponentType<TaskActionMenuSubProps>;
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onMarkTaskAsUnread: () => void;
  onRestartTask?: () => void;
  restartPending?: boolean;
  onOpenTaskFeedback?: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
  onViewModelTrajectoryV2?: () => void;
  onOpenProviderConfig: () => void;
  /** Sidebar Delete (session-deletion-cascade): confirmation is owned by the caller. */
  onDeleteTask?: () => void;
  deleteDisabledReason?: string;
}) {
  const taskTargetActionsDisabled = disableTaskActions || disableTaskTargetActions;
  const submenusAvailable = Boolean(Sub && SubTrigger && SubContent);

  /** One entry renders flat, several nest under a trigger, none render nothing. */
  const renderGroup = (
    labelId: string,
    entries: Array<{ node: React.ReactNode; disabled: boolean }>,
    triggerTestId?: string,
  ): React.ReactNode => {
    if (entries.length === 0) {
      return null;
    }
    const nodes = entries.map((entry) => entry.node);
    if (!submenusAvailable || entries.length === 1 || !Sub || !SubTrigger || !SubContent) {
      return nodes;
    }
    const allDisabled = entries.every((entry) => entry.disabled);
    return (
      <Sub>
        <SubTrigger
          data-testid={triggerTestId}
          disabled={allDisabled}
          title={allDisabled ? disabledReason : undefined}
        >
          {intl.formatMessage({ id: labelId })}
        </SubTrigger>
        <SubContent>{nodes}</SubContent>
      </Sub>
    );
  };

  const openEntries: Array<{ node: React.ReactNode; disabled: boolean }> = [];
  if (canOpenInFileManager && !hideMobileUnsupportedActions) {
    openEntries.push({
      disabled: disableTaskActions,
      node: (
        <Item
          key="open-file-manager"
          disabled={disableTaskActions}
          title={disableTaskActions ? disabledReason : undefined}
          onSelect={() => {
            if (!disableTaskActions) {
              onOpenTaskPathInFileManager();
            }
          }}
        >
          {fileManagerLabel}
        </Item>
      ),
    });
    /* Bugfix: 手机远控运行在浏览器里，无法可靠打开桌面端 provider 配置文件。
       这里只在远控移动端隐藏入口，桌面端仍沿用“路径已知即可前往配置”的能力。 */
    const configDisabled =
      disableTaskActions || providerConfigFile.loading || !providerConfigFile.path;
    openEntries.push({
      disabled: configDisabled,
      node: (
        <Item
          key="open-provider-config"
          disabled={configDisabled}
          title={disableTaskActions ? disabledReason : undefined}
          onSelect={() => {
            if (!disableTaskActions) {
              onOpenProviderConfig();
            }
          }}
        >
          <span className="truncate">
            {intl.formatMessage({ id: "appHeader.goToProviderConfig" })}
          </span>
        </Item>
      ),
    });
  }

  const copyEntries: Array<{ node: React.ReactNode; disabled: boolean }> = [
    {
      disabled: disableTaskActions,
      node: (
        <Item
          key="copy-path"
          disabled={disableTaskActions}
          title={disableTaskActions ? disabledReason : undefined}
          onSelect={onCopyWorkspacePath}
        >
          {intl.formatMessage({ id: "appHeader.copyPath" })}
        </Item>
      ),
    },
  ];
  // Host computes the snapshot path even when no file exists (exists:false); copying it would
  // give a path that does not exist, so the item is hidden until the file is confirmed. This
  // diverges from upstream 0a1fc56d, which always shows it.
  if (taskSessionFile.exists) {
    const disabled = taskTargetActionsDisabled || !taskSessionFile.path;
    copyEntries.push({
      disabled,
      node: (
        <Item
          key="copy-task-path"
          disabled={disabled}
          title={taskTargetActionsDisabled ? disabledReason : undefined}
          onSelect={onCopyTaskPath}
        >
          {intl.formatMessage({ id: "appHeader.copyTaskPath" })}
        </Item>
      ),
    });
  }
  {
    // Bugfix: ZCode Agent 的日志路径可能先按运行时约定得出，当前日期文件尚未落盘。
    // 复制动作只依赖路径字符串，不能把 exists=false 当成不可复制，否则菜单会表现成“不能点”。
    const disabled =
      taskTargetActionsDisabled ||
      taskNativeSessionLogFile.loading ||
      !taskNativeSessionLogFile.path;
    copyEntries.push({
      disabled,
      node: (
        <Item
          key="copy-log-path"
          disabled={disabled}
          title={taskTargetActionsDisabled ? disabledReason : undefined}
          onSelect={onCopyTaskLogPath}
        >
          {intl.formatMessage({ id: "appHeader.copyLogPath" })}
        </Item>
      ),
    });
  }
  if (onCopySessionId) {
    const disabled = taskTargetActionsDisabled || !activeSessionId;
    copyEntries.push({
      disabled,
      node: (
        <Item
          key="copy-session-id"
          disabled={disabled}
          title={taskTargetActionsDisabled ? disabledReason : undefined}
          onSelect={onCopySessionId}
        >
          {intl.formatMessage({ id: "appHeader.copySessionId" })}
        </Item>
      ),
    });
  }

  // 调用轨迹查看：从 ~/.zcode/cli 的 model-io 还原该 task 的模型请求/响应/工具调用，
  // 在右侧边栏可视化。只依赖 taskId（即 sessionId），不依赖快照文件是否落盘。
  const inspectEntries: Array<{ node: React.ReactNode; disabled: boolean }> = [];
  const trajectoryDisabled = taskTargetActionsDisabled || !activeSessionId;
  if (onViewModelTrajectory) {
    inspectEntries.push({
      disabled: trajectoryDisabled,
      node: (
        <Item
          key="trajectory-v1"
          data-testid={TID_TASK_VIEW_MODEL_TRAJECTORY}
          disabled={trajectoryDisabled}
          title={taskTargetActionsDisabled ? disabledReason : undefined}
          onSelect={onViewModelTrajectory}
        >
          {intl.formatMessage({ id: "taskList.viewModelTrajectory" })}
        </Item>
      ),
    });
  }
  if (onViewModelTrajectoryV2) {
    // Trajectory v2: event ledger, timing and request details; coexists with the v1 tab.
    inspectEntries.push({
      disabled: trajectoryDisabled,
      node: (
        <Item
          key="trajectory-v2"
          data-testid={TID_TASK_VIEW_MODEL_TRAJECTORY_V2}
          disabled={trajectoryDisabled}
          title={taskTargetActionsDisabled ? disabledReason : undefined}
          onSelect={onViewModelTrajectoryV2}
        >
          {intl.formatMessage({ id: "taskList.viewModelTrajectoryV2" })}
        </Item>
      ),
    });
  }

  return (
    <>
      <Item
        disabled={taskTargetActionsDisabled || disablePinTaskAction}
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={() => {
          if (!taskTargetActionsDisabled && !disablePinTaskAction) {
            onTogglePinTask();
          }
        }}
      >
        {intl.formatMessage({
          id: isPinned ? "taskList.unpin" : "taskList.pin",
        })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onStartRenameTask();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.rename" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onMarkTaskAsUnread();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.markAsUnread" })}
      </Item>
      {onRestartTask ? (
        <Item
          data-testid="task-restart"
          disabled={taskTargetActionsDisabled || restartPending}
          onSelect={onRestartTask}
        >
          {intl.formatMessage({ id: restartPending ? "taskList.restarting" : "taskList.restart" })}
        </Item>
      ) : null}
      <Separator />
      {renderGroup("taskList.menu.open", openEntries)}
      {renderGroup("taskList.menu.copy", copyEntries)}
      {renderGroup("taskList.menu.inspect", inspectEntries, TID_TASK_INSPECT_MENU)}
      {onOpenTaskFeedback ? (
        <>
          <Separator />
          <Item disabled={taskTargetActionsDisabled} onSelect={onOpenTaskFeedback}>
            {/* Bugfix: 任务菜单之前只有复制日志/路径，用户遇到任务问题时还要手动回到反馈中心。
                “反馈问题”不是任务管理动作，单独放在菜单底部更符合兜底求助入口的层级。 */}
            {intl.formatMessage({ id: "taskList.feedback" })}
          </Item>
        </>
      ) : null}
      <Separator />
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onArchiveTask();
          }
        }}
      >
        {intl.formatMessage({
          id: isArchived ? "taskList.unarchive" : "taskList.archive",
        })}
      </Item>
      {onDeleteTask ? (
        <Item
          data-testid={TID_TASK_DELETE}
          variant="destructive"
          disabled={taskTargetActionsDisabled || Boolean(deleteDisabledReason)}
          title={deleteDisabledReason ?? disabledReason}
          onSelect={() => {
            if (!taskTargetActionsDisabled && !deleteDisabledReason) onDeleteTask();
          }}
        >
          {intl.formatMessage({ id: "taskList.delete" })}
        </Item>
      ) : null}
    </>
  );
}
