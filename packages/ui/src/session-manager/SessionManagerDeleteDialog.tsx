import { useEffect, useMemo, useState } from "react";
import type { ZCodeTaskTreeCounts } from "@zcode/services";
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
import { describeTreeChildren } from "@/lib/taskTreeCounts.js";
import {
  computeSessionManagerDeleteCandidates,
  type SessionManagerRow,
} from "./sessionManagerModel.js";

const PREVIEW_ROW_LIMIT = 5;

function rowIcon(row: SessionManagerRow) {
  if (row.pinned) {
    return <Star className="size-3.5 shrink-0 text-warning" />;
  }
  if (row.task.executionWorktree) {
    return <GitBranch className="size-3.5 shrink-0 text-foreground-subtlest" />;
  }
  return <MessageSquare className="size-3.5 shrink-0 text-foreground-subtlest" />;
}

/**
 * Delete confirmation with Copilot-parity pinned exclusion: pinned rows are kept out of the
 * deletable set until the user opts in with the checkbox. Delete only hides sessions (their files stay
 * on disk); the opt-in erase checkbox follows Hide with a permanent removal
 * (specs/session-deletion-cascade.md §2-§3).
 */
export function SessionManagerDeleteDialog({
  selectedRows,
  loadTreeCounts,
  canEraseRow,
  onCancel,
  onConfirm,
}: {
  selectedRows: readonly SessionManagerRow[];
  /** Exact tree totals; resolves null when unavailable (remote workspace, older CLI, failure). */
  loadTreeCounts: (rows: readonly SessionManagerRow[]) => Promise<ZCodeTaskTreeCounts | null>;
  canEraseRow: (row: SessionManagerRow) => boolean;
  onCancel: () => void;
  onConfirm: (rowsToDelete: readonly SessionManagerRow[], options: { erase: boolean }) => void;
}) {
  const { intl } = useZCodeIntl();
  const [includePinned, setIncludePinned] = useState(false);
  const [erase, setErase] = useState(false);
  // undefined = loading, null = unavailable, otherwise the resolved totals.
  const [counts, setCounts] = useState<ZCodeTaskTreeCounts | null | undefined>(undefined);
  const candidates = useMemo(
    () => computeSessionManagerDeleteCandidates(selectedRows, includePinned),
    [includePinned, selectedRows],
  );
  const deletableCount = candidates.deletable.length;
  const pinnedCount = candidates.pinned.length;
  const previewRows = candidates.deletable.slice(0, PREVIEW_ROW_LIMIT);
  const overflowCount = Math.max(candidates.deletable.length - previewRows.length, 0);

  useEffect(() => {
    let cancelled = false;
    setCounts(undefined);
    if (candidates.deletable.length === 0) {
      setCounts(null);
      return undefined;
    }
    void loadTreeCounts(candidates.deletable)
      .catch(() => null)
      .then((result) => {
        if (!cancelled) setCounts(result);
      });
    return () => {
      cancelled = true;
    };
  }, [candidates.deletable, loadTreeCounts]);

  const childrenText = counts ? describeTreeChildren(intl, counts) : null;
  const runningCount = counts?.running ?? 0;
  const eraseAvailable =
    deletableCount > 0 && Boolean(counts) && candidates.deletable.every(canEraseRow);
  const eraseSelected = erase && eraseAvailable && runningCount === 0;

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
        {childrenText ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "sessionManager.delete.includes" }, { items: childrenText })}
          </p>
        ) : counts === null ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "sessionManager.delete.includesGeneric" })}
          </p>
        ) : null}
        {runningCount > 0 ? (
          <p className="text-ui-sm text-warning">
            {intl.formatPlural({ id: "sessionManager.delete.running" }, runningCount)}
          </p>
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
        {eraseAvailable && counts ? (
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
              <Checkbox
                checked={eraseSelected}
                disabled={runningCount > 0}
                onCheckedChange={(checked) => setErase(checked === true)}
              />
              {intl.formatMessage({ id: "sessionManager.erase.checkbox" })}
            </label>
            {runningCount > 0 ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatPlural({ id: "sessionManager.erase.blocked" }, runningCount)}
              </p>
            ) : null}
            {eraseSelected ? (
              <p className="text-ui-sm text-destructive">
                {intl.formatPlural({ id: "sessionManager.erase.warning" }, counts.total)}
              </p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={deletableCount === 0}
            onClick={() => onConfirm(candidates.deletable, { erase: eraseSelected })}
          >
            {intl.formatMessage(
              {
                id: eraseSelected
                  ? "sessionManager.erase.confirm"
                  : "sessionManager.delete.confirm",
              },
              { count: String(deletableCount) },
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
