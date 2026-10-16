/**
 * Shared worktree-session marker for task rows (specs/worktree-icon-visibility.md): lucide Split
 * rotated 90° (stem left, fork right — "a separate checkout forking off the project"), styled like
 * the neighboring clock/off-peak meta icons: the row's muted meta color, no highlight; only the
 * missing state adds destructive (an error disclosure, not decoration). The tooltip names the
 * branch and the worktree directory. Renders nothing when the task has no execution worktree.
 */
import type { ZCodeTaskMeta } from "@zcode/shared";
import { Split } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Last segment of a worktree directory path (both separators, trailing slashes tolerated). The
 * fork names worktrees zcode-<slug>, so the segment identifies the worktree in marker tooltips
 * without the absolute path's length.
 */
export function worktreeDirectoryNameOf(path: string): string {
  const segment = path
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop();
  return segment ?? path;
}

export function WorktreeTaskMarker({ task }: { task: ZCodeTaskMeta }) {
  const { intl } = useZCodeIntl();
  if (!task.executionWorktree) return null;
  // The directory can vanish out-of-band (rm / git worktree prune): keep the marker, flip the
  // tooltip and color to the missing state instead of hiding the fact.
  const isMissing = Boolean(task.executionWorktreeMissing);
  const directory = worktreeDirectoryNameOf(task.executionWorktree.path);
  const noBranchLabel = intl.formatMessage(
    { id: "taskList.worktreeTaskLabelNoBranch" },
    { directory },
  );
  const worktreeLabel = task.executionWorktree.branchName
    ? intl.formatMessage(
        { id: "taskList.worktreeTaskLabel" },
        { branch: task.executionWorktree.branchName, directory },
      )
    : noBranchLabel;
  const title = isMissing
    ? `${worktreeLabel} · ${intl.formatMessage({ id: "taskList.worktreeTaskLabelMissing" })}`
    : worktreeLabel;
  // Healthy rows keep the no-branch label as their accessible name (pre-existing behavior).
  const ariaLabel = isMissing ? title : noBranchLabel;

  return (
    <span data-worktree-task-icon="true" title={title}>
      <Split
        aria-label={ariaLabel}
        className={cn("size-3.5 shrink-0 rotate-90", isMissing && "text-destructive")}
      />
    </span>
  );
}
