import { useEffect, useId, useMemo, useState } from "react";
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
import { TID_TASK_DELETE_CONFIRM, TID_TASK_DELETE_DIALOG } from "@zcode/shared";
import type { TaskDeleteDialogRow, TaskDeleteWorktreePreview } from "./taskDeletionTypes.js";

const PREVIEW_ROW_LIMIT = 5;

function rowIcon(row: TaskDeleteDialogRow) {
  if (row.pinned) return <Star className="size-3.5 shrink-0 text-warning" />;
  if (row.executionWorktree)
    return <GitBranch className="size-3.5 shrink-0 text-foreground-subtlest" />;
  return <MessageSquare className="size-3.5 shrink-0 text-foreground-subtlest" />;
}

function worktreeRows(preview: readonly TaskDeleteWorktreePreview[]) {
  return preview.flatMap((worktree) =>
    worktree.files.map((file) => ({
      path: file.path,
      status: file.status,
      worktreePath: worktree.path,
      branchName: worktree.branchName,
    })),
  );
}

export function TaskDeleteConfirmationDialog({
  rows,
  supported,
  loadCapability,
  notice,
  requirePinnedOptIn = false,
  loadTreeCounts,
  loadWorktreePreview,
  onCancel,
  onConfirm,
}: {
  rows: readonly TaskDeleteDialogRow[];
  supported?: boolean;
  loadCapability?: (rows: readonly TaskDeleteDialogRow[]) => Promise<boolean>;
  notice?: string;
  /**
   * Batch surfaces that must never erase pinned rows implicitly: pinned rows stay excluded until the
   * user checks the opt-in, including when only one row is offered. Default keeps the single-row
   * behavior of the other Delete surfaces.
   */
  requirePinnedOptIn?: boolean;
  loadTreeCounts: (rows: readonly TaskDeleteDialogRow[]) => Promise<ZCodeTaskTreeCounts | null>;
  loadWorktreePreview: (
    rows: readonly TaskDeleteDialogRow[],
  ) => Promise<readonly TaskDeleteWorktreePreview[] | null>;
  onCancel: () => void;
  onConfirm: (rows: readonly TaskDeleteDialogRow[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const unknownWarningId = useId();
  const [includePinned, setIncludePinned] = useState(!requirePinnedOptIn && rows.length === 1);
  const [capability, setCapability] = useState<boolean | undefined>(supported);
  const [counts, setCounts] = useState<ZCodeTaskTreeCounts | null | undefined>(undefined);
  const [worktreePreview, setWorktreePreview] = useState<
    readonly TaskDeleteWorktreePreview[] | null | undefined
  >(undefined);
  const [unknownWorktreeAcknowledged, setUnknownWorktreeAcknowledged] = useState(false);
  const candidates = useMemo(
    () => rows.filter((row) => includePinned || !row.pinned),
    [includePinned, rows],
  );
  const deletableCount = candidates.length;
  const pinnedCount = rows.filter((row) => row.pinned).length;
  const previewRows = candidates.slice(0, PREVIEW_ROW_LIMIT);
  const overflowCount = Math.max(deletableCount - previewRows.length, 0);

  useEffect(() => {
    let cancelled = false;
    setCounts(undefined);
    setWorktreePreview(undefined);
    // An acknowledgement covers only the candidate set whose preview failed; any reload asks again.
    setUnknownWorktreeAcknowledged(false);
    if (candidates.length === 0) {
      setCounts(null);
      setWorktreePreview([]);
      return undefined;
    }
    void Promise.all([
      loadTreeCounts(candidates).catch(() => null),
      loadWorktreePreview(candidates).catch(() => null),
    ]).then(([nextCounts, nextWorktreePreview]) => {
      if (!cancelled) {
        setCounts(nextCounts);
        setWorktreePreview(nextWorktreePreview);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [candidates, loadTreeCounts, loadWorktreePreview]);

  useEffect(() => {
    let cancelled = false;
    if (supported !== undefined) {
      setCapability(supported);
      return () => {
        cancelled = true;
      };
    }
    setCapability(undefined);
    if (candidates.length === 0) return undefined;
    if (!loadCapability) {
      setCapability(false);
      return undefined;
    }
    void loadCapability(candidates)
      .catch(() => false)
      .then((result) => {
        if (!cancelled) setCapability(result);
      });
    return () => {
      cancelled = true;
    };
  }, [candidates, loadCapability, supported]);

  const children = counts ? describeTreeChildren(intl, counts) : null;
  const files = worktreePreview ? worktreeRows(worktreePreview) : [];
  const dirtyWorktrees = worktreePreview?.filter((worktree) => worktree.files.length > 0) ?? [];
  const hasDirtyWorktree = dirtyWorktrees.length > 0;
  const runningCount = counts?.running ?? 0;
  const worktreeConfirmMode =
    worktreePreview === undefined
      ? "loading"
      : worktreePreview === null
        ? "unknown"
        : hasDirtyWorktree
          ? "dirty"
          : "clean";
  // Forced removal also deletes gitignored files, which no status preview can list.
  const involvesWorktree = worktreePreview === null || (worktreePreview?.length ?? 0) > 0;
  const confirmLabel =
    worktreeConfirmMode === "clean" ? "taskDelete.confirm" : "taskDelete.deleteAnyway";
  const confirmDisabled =
    capability !== true ||
    (worktreeConfirmMode === "unknown" && !unknownWorktreeAcknowledged) ||
    runningCount > 0 ||
    deletableCount === 0 ||
    counts === undefined ||
    worktreePreview === undefined;

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="max-h-[min(90dvh,42rem)] max-w-lg overflow-y-auto"
        data-testid={TID_TASK_DELETE_DIALOG}
      >
        <DialogHeader>
          <DialogTitle>{intl.formatPlural({ id: "taskDelete.title" }, deletableCount)}</DialogTitle>
          <DialogDescription>{intl.formatMessage({ id: "taskDelete.body" })}</DialogDescription>
        </DialogHeader>
        {previewRows.length > 0 ? (
          <ul className="max-h-44 overflow-y-auto rounded-lg border border-border">
            {previewRows.map((row) => (
              <li
                key={row.id}
                className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-ui-sm last:border-b-0"
              >
                {rowIcon(row)}
                <span className="min-w-0 flex-1 truncate" title={row.title}>
                  {row.title || intl.formatMessage({ id: "taskList.untitled" })}
                </span>
                <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage({
                    id: row.archived ? "taskDelete.tagArchived" : "taskDelete.tagActive",
                  })}
                </span>
              </li>
            ))}
            {overflowCount > 0 ? (
              <li className="px-2.5 py-1.5 text-ui-xs text-foreground-subtlest">
                {intl.formatPlural({ id: "taskDelete.more" }, overflowCount)}
              </li>
            ) : null}
          </ul>
        ) : null}
        {children ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "taskDelete.includes" }, { items: children })}
          </p>
        ) : counts === null ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "taskDelete.includesGeneric" })}
          </p>
        ) : null}
        {runningCount > 0 ? (
          <p className="text-ui-sm text-warning">
            {intl.formatPlural({ id: "taskDelete.running" }, runningCount)}
          </p>
        ) : null}
        {pinnedCount > 0 && (requirePinnedOptIn || rows.length > 1) ? (
          <label className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
            <Checkbox
              checked={includePinned}
              onCheckedChange={(checked) => setIncludePinned(checked === true)}
            />
            {intl.formatPlural({ id: "taskDelete.includePinned" }, pinnedCount)}
          </label>
        ) : null}
        {worktreeConfirmMode === "unknown" ? (
          <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-2.5">
            <p id={unknownWarningId} className="text-ui-sm text-warning">
              {intl.formatMessage({ id: "taskDelete.worktreeUnknown" })}
            </p>
            <label className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
              <Checkbox
                aria-describedby={unknownWarningId}
                checked={unknownWorktreeAcknowledged}
                onCheckedChange={(checked) => setUnknownWorktreeAcknowledged(checked === true)}
              />
              {intl.formatMessage({ id: "taskDelete.worktreeUnknownAcknowledge" })}
            </label>
          </div>
        ) : null}
        {hasDirtyWorktree ? (
          <div className="space-y-1 rounded-md border border-warning/40 bg-warning/5 p-2.5">
            <p className="text-ui-sm text-warning">
              {intl.formatPlural({ id: "taskDelete.dirtyWarning" }, dirtyWorktrees.length)}
            </p>
            <ul className="space-y-0.5 font-mono text-ui-xs text-foreground-subtle">
              {files.slice(0, PREVIEW_ROW_LIMIT).map((file) => (
                <li key={`${file.worktreePath}:${file.status}:${file.path}`} className="truncate">
                  <span className="mr-2 inline-block w-5">{file.status}</span>
                  <span title={file.worktreePath}>{file.path}</span>
                </li>
              ))}
              {files.length > PREVIEW_ROW_LIMIT ? (
                <li>
                  {intl.formatPlural(
                    { id: "taskDelete.worktreeMore" },
                    files.length - PREVIEW_ROW_LIMIT,
                  )}
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}
        {involvesWorktree ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "taskDelete.worktreeIgnoredNotice" })}
          </p>
        ) : null}
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "taskDelete.retainedNotice" })}
        </p>
        {capability === false ? (
          <p className="text-ui-sm text-warning">
            {intl.formatMessage({ id: "taskDelete.unsupported" })}
          </p>
        ) : null}
        {notice ? <p className="text-ui-sm text-warning">{notice}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={confirmDisabled}
            aria-describedby={worktreeConfirmMode === "unknown" ? unknownWarningId : undefined}
            data-testid={TID_TASK_DELETE_CONFIRM}
            onClick={() => onConfirm(candidates)}
          >
            {intl.formatPlural({ id: confirmLabel }, deletableCount)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
