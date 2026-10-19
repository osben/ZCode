import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderIcon, MoreHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  collectArchivedTaskDeletion,
  countArchivedTaskDeletionTrees,
  deleteArchivedTaskSelection,
  loadArchivedTaskDeletionWorktreePreview,
  type ArchivedTaskDeletionWorkspace,
  type ArchivedTaskDeletionTarget,
  type ArchivedTaskDeletionSelection,
} from "@/lib/archivedTaskDeletion.js";
import { formatTaskDeletionResult } from "@/task-deletion/taskDeletion.js";
import { TaskDeleteConfirmationDialog } from "@/task-deletion/TaskDeleteConfirmationDialog.js";
import type { TaskDeleteTarget } from "@/task-deletion/taskDeletion.js";
import { logger } from "@/logger.js";

export function DeleteAllArchivedTasksButton({
  workspaces,
  count,
  disabled,
  disabledReason,
  actionsContainer,
  onDeleted,
  onRefresh,
}: {
  workspaces: ArchivedTaskDeletionWorkspace[];
  count: number;
  disabled: boolean;
  disabledReason?: string;
  actionsContainer?: HTMLElement | null;
  onDeleted: (target: ArchivedTaskDeletionTarget) => void;
  onRefresh?: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<ArchivedTaskDeletionSelection | null>(
    null,
  );

  async function handleDeleteAll() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setResultMessage(null);
    try {
      const selection = await collectArchivedTaskDeletion(workspaces);
      const unavailable =
        selection.unavailableWorkspaces.length > 0
          ? intl.formatMessage(
              { id: "taskList.deleteAllArchivedUnavailable" },
              { projects: selection.unavailableWorkspaces.join("、") },
            )
          : "";
      if (selection.count === 0) {
        setResultMessage(unavailable || intl.formatMessage({ id: "taskList.noArchivedTasks" }));
        return;
      }
      setPendingSelection(selection);
    } catch (error) {
      logger.error("[ArchivedTaskDeletion] 批量删除或刷新失败", error);
      setResultMessage((current) =>
        [current, intl.formatMessage({ id: "taskList.deleteAllArchivedError" })]
          .filter(Boolean)
          .join("\n"),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function handleConfirmDelete(rows: readonly TaskDeleteTarget[]) {
    const selection = pendingSelection;
    if (!selection || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPendingSelection(null);
    try {
      const result = await deleteArchivedTaskSelection(selection, onDeleted, rows);
      const unavailable =
        result.unavailableWorkspaces.length > 0
          ? intl.formatMessage(
              { id: "taskList.deleteAllArchivedUnavailable" },
              { projects: result.unavailableWorkspaces.join("、") },
            )
          : "";
      setResultMessage(
        [
          formatTaskDeletionResult(result, (id, values) => intl.formatMessage({ id }, values)),
          unavailable,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      await onRefresh?.();
    } catch (error) {
      logger.error("[ArchivedTaskDeletion] permanent delete or refresh failed", error);
      setResultMessage(intl.formatMessage({ id: "taskDelete.error" }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const actionLabel = intl.formatMessage({
    id: busy ? "taskList.deleteAllArchivedBusy" : "taskList.archivedActions",
  });
  const menu = (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ControlHintTooltip title={disabledReason || actionLabel}>
        <DropdownMenuTrigger asChild disabled={disabled || busy}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled || busy}
            data-testid="archived-tasks-actions"
            aria-label={actionLabel}
            aria-busy={busy}
            className="shrink-0 text-foreground-subtle hover:text-foreground max-md:size-8"
          >
            {busy ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <MoreHorizontal className="size-3.5" />
            )}
          </Button>
        </DropdownMenuTrigger>
      </ControlHintTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-ui-sm font-normal text-foreground-subtle">
          {intl.formatMessage({ id: "taskList.archivedTaskCount" }, { count })}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={disabled || busy}
          data-testid="delete-all-archived-tasks"
          className="max-md:min-h-9"
          onSelect={() => {
            setMenuOpen(false);
            void handleDeleteAll();
          }}
        >
          <Trash2 className="size-3.5" />
          {intl.formatMessage({ id: "taskList.deleteAllArchivedMenu" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {/* Only the control’s render position moves; querying, confirmation, and deletion remain alive with the archived-task list, so closing the menu does not unmount this state. */}
      {actionsContainer === undefined
        ? menu
        : actionsContainer
          ? createPortal(menu, actionsContainer)
          : null}
      {resultMessage ? (
        <p
          role="status"
          className="min-w-0 whitespace-pre-line break-words px-2 py-1 text-ui-sm text-foreground-subtle"
        >
          {resultMessage}
        </p>
      ) : null}
      {pendingSelection ? (
        <TaskDeleteConfirmationDialog
          rows={pendingSelection.targets}
          supported
          notice={
            pendingSelection.unavailableWorkspaces.length > 0
              ? intl.formatMessage(
                  { id: "taskList.deleteAllArchivedUnavailable" },
                  { projects: pendingSelection.unavailableWorkspaces.join("、") },
                )
              : undefined
          }
          loadTreeCounts={(rows) =>
            countArchivedTaskDeletionTrees(pendingSelection, rows as readonly TaskDeleteTarget[])
          }
          loadWorktreePreview={(rows) =>
            loadArchivedTaskDeletionWorktreePreview(
              pendingSelection,
              rows as readonly TaskDeleteTarget[],
            )
          }
          onCancel={() => setPendingSelection(null)}
          onConfirm={(rows) => void handleConfirmDelete(rows as readonly TaskDeleteTarget[])}
        />
      ) : null}
    </>
  );
}
