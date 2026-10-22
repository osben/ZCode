import { useCallback, useRef, useState } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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

interface TaskDeleteResult {
  text: string;
  failed: boolean;
}

/**
 * Single owner of the permanent-delete dialog and of the executor call, for the Settings → Archives
 * page only. Callers decide which rows are offered (and must exclude rows that cannot be deleted
 * here); this hook never widens a batch. Pinned rows always require an explicit opt-in.
 */
export function useTaskDeleteDialog(onRefresh?: () => Promise<void>) {
  const services = useBaseWorkspaceServices();
  const { intl } = useZCodeIntl();
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<readonly TaskDeleteTarget[]>([]);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<TaskDeleteResult | null>(null);
  const inFlight = useRef(false);
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
  const openRows = useCallback(
    (items: readonly TaskDeleteTarget[], options?: { notice?: string }) => {
      if (inFlight.current || items.length === 0) return;
      setResult(null);
      setNotice(options?.notice);
      setRows(items);
    },
    [],
  );
  const cancel = useCallback(() => {
    setRows([]);
    setNotice(undefined);
  }, []);
  const confirm = useCallback(
    async (items: readonly TaskDeleteDialogRow[]) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setRows([]);
      setNotice(undefined);
      setBusy(true);
      try {
        try {
          const outcome = await permanentlyDeleteTasks(
            items as readonly TaskDeleteTarget[],
            resolveServices,
            (row) => removeTaskState(row.workspacePath, row.taskId, row.workspaceIdentity),
          );
          setResult({
            text: formatTaskDeletionResult(outcome, (id, values) =>
              intl.formatMessage({ id }, values),
            ),
            failed:
              outcome.failed > 0 ||
              outcome.sessionFileFailures > 0 ||
              outcome.worktreeCleanup.failed.length > 0,
          });
        } catch (error) {
          logger.error("[TaskDeletion] permanent delete failed", { error });
          setResult({ text: intl.formatMessage({ id: "taskDelete.error" }), failed: true });
        }
        // A refresh failure must not replace the erase outcome above; it is only logged.
        try {
          await onRefresh?.();
        } catch (error) {
          logger.error("[TaskDeletion] refresh after permanent delete failed", { error });
        }
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [intl, onRefresh, removeTaskState, resolveServices],
  );
  return {
    openRows,
    cancel,
    busy,
    pending: rows.length > 0,
    result: result?.text ?? null,
    resultFailed: result?.failed ?? false,
    reportResult: (text: string | null) =>
      setResult(text === null ? null : { text, failed: false }),
    dialog:
      rows.length > 0 ? (
        <TaskDeleteConfirmationDialog
          rows={rows}
          notice={notice}
          requirePinnedOptIn
          loadCapability={loadCapability}
          loadTreeCounts={loadCounts}
          loadWorktreePreview={loadPreview}
          onCancel={cancel}
          onConfirm={(items) => void confirm(items)}
        />
      ) : null,
  };
}
