import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import { TaskActionMenuContent } from "@/TaskActionMenuContent.js";
import { TaskPullRequestMenuItems } from "@/components/TaskPullRequestMenuItems.js";

export function TaskListItemContextMenu({
  organizationActions,
  intl,
  task,
  isPinned,
  isArchived = false,
  fileManagerLabel,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  providerConfigFile,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onDeleteTask,
  deleteDisabledReason,
  onMarkTaskAsUnread,
  onOpenInSplitPane,
  openInSplitPaneDisabled,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onCopyText,
  onViewModelTrajectory,
  onOpenProviderConfig,
  disableTaskActions = false,
  disabledReason,
}: {
  organizationActions?: React.ReactNode;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  task: ZCodeTaskMeta;
  isPinned: boolean;
  isArchived?: boolean;
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  providerConfigFile: { loading: boolean; path: string | null; exists: boolean };
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onDeleteTask?: () => void;
  deleteDisabledReason?: string;
  onMarkTaskAsUnread: () => void;
  /** “Open in split pane” (provided only by the desktop shell). */
  onOpenInSplitPane?: () => void;
  /** Disabled when the leaf limit is reached and the session is not already in any pane. */
  openInSplitPaneDisabled?: boolean;
  onOpenTaskFeedback: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onCopyText: (label: string, value: string | null) => void;
  onViewModelTrajectory?: () => void;
  onOpenProviderConfig: () => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
}) {
  return (
    <ContextMenuContent className="w-52">
      {organizationActions}
      <TaskActionMenuContent
        intl={intl}
        isPinned={isPinned}
        isArchived={isArchived}
        fileManagerLabel={fileManagerLabel}
        taskSessionFile={taskSessionFile}
        activeSessionId={activeSessionId}
        taskNativeSessionLogFile={taskNativeSessionLogFile}
        providerConfigFile={providerConfigFile}
        Item={ContextMenuItem}
        Separator={ContextMenuSeparator}
        onTogglePinTask={onTogglePinTask}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onDeleteTask={onDeleteTask}
        deleteDisabledReason={deleteDisabledReason}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        onOpenInSplitPane={onOpenInSplitPane}
        openInSplitPaneDisabled={openInSplitPaneDisabled}
        onOpenTaskFeedback={onOpenTaskFeedback}
        onOpenTaskPathInFileManager={onOpenTaskPathInFileManager}
        onCopyWorkspacePath={onCopyWorkspacePath}
        onCopyTaskPath={onCopyTaskPath}
        onCopyTaskLogPath={onCopyTaskLogPath}
        onCopySessionId={onCopySessionId}
        onViewModelTrajectory={onViewModelTrajectory}
        onOpenProviderConfig={onOpenProviderConfig}
        disableTaskActions={disableTaskActions}
        disabledReason={disabledReason}
      />
      <TaskPullRequestMenuItems
        task={task}
        intl={intl}
        Item={ContextMenuItem}
        Separator={ContextMenuSeparator}
        onCopyText={onCopyText}
      />
    </ContextMenuContent>
  );
}
