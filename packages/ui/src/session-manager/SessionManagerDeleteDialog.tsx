import { useMemo } from "react";
import type { ZCodeTaskTreeCounts } from "@zcode/services";
import { TaskDeleteConfirmationDialog } from "@/task-deletion/TaskDeleteConfirmationDialog.js";
import type {
  TaskDeleteDialogRow,
  TaskDeleteWorktreePreview,
} from "@/task-deletion/taskDeletionTypes.js";
import type { SessionManagerRow } from "./sessionManagerModel.js";

export function SessionManagerDeleteDialog({
  selectedRows,
  loadTreeCounts,
  loadCapability,
  loadWorktreePreview,
  onCancel,
  onConfirm,
}: {
  selectedRows: readonly SessionManagerRow[];
  loadTreeCounts: (rows: readonly SessionManagerRow[]) => Promise<ZCodeTaskTreeCounts | null>;
  loadCapability: (rows: readonly SessionManagerRow[]) => Promise<boolean>;
  loadWorktreePreview: (
    rows: readonly SessionManagerRow[],
  ) => Promise<readonly TaskDeleteWorktreePreview[] | null>;
  onCancel: () => void;
  onConfirm: (rowsToDelete: readonly SessionManagerRow[]) => void;
}) {
  const dialogRows = useMemo(
    () =>
      selectedRows.map(
        (row): TaskDeleteDialogRow => ({
          id: row.taskKey,
          taskId: row.task.taskId,
          title: row.task.title,
          workspacePath: row.task.workspacePath,
          workspaceIdentity: row.task.workspaceIdentity,
          archived: row.archived,
          pinned: row.pinned,
          ...(row.task.executionWorktree ? { executionWorktree: row.task.executionWorktree } : {}),
        }),
      ),
    [selectedRows],
  );
  const rowById = useMemo(
    () => new Map(selectedRows.map((row) => [row.taskKey, row])),
    [selectedRows],
  );

  return (
    <TaskDeleteConfirmationDialog
      rows={dialogRows}
      loadTreeCounts={(rows) =>
        loadTreeCounts(
          rows.flatMap((row) => {
            const sessionRow = rowById.get(row.id);
            return sessionRow ? [sessionRow] : [];
          }),
        )
      }
      loadCapability={(rows) =>
        loadCapability(
          rows.flatMap((row) => {
            const sessionRow = rowById.get(row.id);
            return sessionRow ? [sessionRow] : [];
          }),
        )
      }
      loadWorktreePreview={(rows) =>
        loadWorktreePreview(
          rows.flatMap((row) => {
            const sessionRow = rowById.get(row.id);
            return sessionRow ? [sessionRow] : [];
          }),
        )
      }
      onCancel={onCancel}
      onConfirm={(rows) =>
        onConfirm(
          rows.flatMap((row) => {
            const sessionRow = rowById.get(row.id);
            return sessionRow ? [sessionRow] : [];
          }),
        )
      }
    />
  );
}
