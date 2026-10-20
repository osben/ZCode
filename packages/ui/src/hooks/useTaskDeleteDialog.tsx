import { useCallback, useMemo, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { TaskDeleteConfirmationDialog } from "@/task-deletion/TaskDeleteConfirmationDialog.js";
import {
  countTaskDeletionTrees,
  formatTaskDeletionResult,
  loadTaskDeletionWorktreePreview,
  permanentlyDeleteTasks,
  taskDeletionSupported,
  type TaskDeleteTarget,
} from "@/task-deletion/taskDeletion.js";
import type { TaskDeleteDialogRow } from "@/task-deletion/taskDeletionTypes.js";

/** Shares the deletion owner across pinned and chronological sidebar views. */
export function useTaskDeleteDialog(onRefresh?: () => Promise<void>) {
  const services = useBaseWorkspaceServices();
  const { intl } = useZCodeIntl();
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<TaskDeleteTarget | null>(null);
  const rows = useMemo(() => (target ? [target] : []), [target]);
  const resolveServices = useCallback(
    (row: TaskDeleteTarget) =>
      row.workspaceIdentity?.trim()
        ? null
        : {
            taskService: services.zcodeTaskService,
            gitService: services.gitService,
          },
    [services],
  );
  const loadCapability = useCallback(
    (items: readonly TaskDeleteDialogRow[]) =>
      taskDeletionSupported(items as readonly TaskDeleteTarget[], resolveServices),
    [resolveServices],
  );
  const loadCounts = useCallback(
    (items: readonly TaskDeleteDialogRow[]) =>
      countTaskDeletionTrees(items as readonly TaskDeleteTarget[], resolveServices),
    [resolveServices],
  );
  const loadPreview = useCallback(
    (items: readonly TaskDeleteDialogRow[]) =>
      loadTaskDeletionWorktreePreview(items as readonly TaskDeleteTarget[], resolveServices),
    [resolveServices],
  );
  const confirm = useCallback(
    async (items: readonly TaskDeleteDialogRow[]) => {
      setTarget(null);
      setBusy(true);
      try {
        const result = await permanentlyDeleteTasks(
          items as readonly TaskDeleteTarget[],
          resolveServices,
          (row) => removeTaskState(row.workspacePath, row.taskId, row.workspaceIdentity),
        );
        toast(formatTaskDeletionResult(result, (id, values) => intl.formatMessage({ id }, values)));
        await onRefresh?.();
      } catch (error) {
        logger.error("[TaskDeletion] sidebar deletion failed", { error });
        toast(intl.formatMessage({ id: "taskDelete.error" }));
      } finally {
        setBusy(false);
      }
    },
    [intl, onRefresh, removeTaskState, resolveServices],
  );
  const open = useCallback((task: ZCodeTaskMeta, pinned = false, archived = false) => {
    setTarget({
      id: `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`,
      taskId: task.taskId,
      title: task.title,
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
      archived,
      pinned,
      executionWorktree: task.executionWorktree,
    });
  }, []);
  return {
    open,
    busy,
    dialog: target ? (
      <TaskDeleteConfirmationDialog
        rows={rows}
        loadCapability={loadCapability}
        loadTreeCounts={loadCounts}
        loadWorktreePreview={loadPreview}
        onCancel={() => setTarget(null)}
        onConfirm={(items) => void confirm(items)}
      />
    ) : null,
  };
}
