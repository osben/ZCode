import { useMemo, useState } from "react";
import { GitBranch, MessageSquare, Star } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  computeSessionManagerDeleteCandidates,
  type SessionManagerRow,
} from "./sessionManagerModel.js";

const PREVIEW_ROW_LIMIT = 5;

function rowIcon(row: SessionManagerRow) {
  if (row.pinned) {
    return <Star className="size-3.5 shrink-0 text-amber-500" />;
  }
  if (row.task.executionWorktree) {
    return <GitBranch className="size-3.5 shrink-0 text-foreground-subtlest" />;
  }
  return <MessageSquare className="size-3.5 shrink-0 text-foreground-subtlest" />;
}

/**
 * Delete confirmation with Copilot-parity pinned exclusion: pinned rows are kept out of the
 * deletable set until the user opts in with the checkbox. Neither delete path removes session
 * files in v1 — the body copy says so explicitly (spec §8).
 */
export function SessionManagerDeleteDialog({
  selectedRows,
  onCancel,
  onConfirm,
}: {
  selectedRows: readonly SessionManagerRow[];
  onCancel: () => void;
  onConfirm: (rowsToDelete: readonly SessionManagerRow[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const [includePinned, setIncludePinned] = useState(false);
  const candidates = useMemo(
    () => computeSessionManagerDeleteCandidates(selectedRows, includePinned),
    [includePinned, selectedRows],
  );
  const deletableCount = candidates.deletable.length;
  const pinnedCount = candidates.pinned.length;
  const previewRows = candidates.deletable.slice(0, PREVIEW_ROW_LIMIT);
  const overflowCount = Math.max(candidates.deletable.length - previewRows.length, 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatPlural({ id: "sessionManager.delete.title" }, deletableCount)}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "sessionManager.delete.body" })}
          </DialogDescription>
        </DialogHeader>
        {selectedRows.length > 0 ? (
          <ul className="max-h-44 overflow-y-auto rounded-lg border border-border">
            {previewRows.map((row) => (
              <li
                key={row.taskKey}
                className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-ui-sm last:border-b-0"
              >
                {rowIcon(row)}
                <span className="min-w-0 flex-1 truncate" title={row.task.title}>
                  {row.task.title || intl.formatMessage({ id: "taskList.untitled" })}
                </span>
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage({
                    id: row.archived
                      ? "sessionManager.delete.tagArchived"
                      : "sessionManager.delete.tagActive",
                  })}
                </span>
              </li>
            ))}
            {overflowCount > 0 ? (
              <li className="px-2.5 py-1.5 text-ui-xs text-foreground-subtlest">
                {intl.formatPlural({ id: "sessionManager.delete.more" }, overflowCount)}
              </li>
            ) : null}
          </ul>
        ) : null}
        {pinnedCount > 0 ? (
          <label className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
            <Checkbox
              checked={includePinned}
              onCheckedChange={(checked) => setIncludePinned(checked === true)}
            />
            {intl.formatPlural({ id: "sessionManager.delete.includePinned" }, pinnedCount)}
          </label>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deletableCount === 0}
            onClick={() => onConfirm(candidates.deletable)}
          >
            {intl.formatMessage(
              { id: "sessionManager.delete.confirm" },
              { count: String(deletableCount) },
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
