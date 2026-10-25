import { FolderTreeIcon } from "lucide-react";
import type { GitPaneDirectoryRow } from "@/GitPane/directoryRowModel.js";

export function GitPaneDirectoryHeader({ row }: { row: GitPaneDirectoryRow }) {
  return (
    <div
      className="flex h-7 items-center gap-2 border-b border-border bg-surface px-3"
      title={row.directory}
    >
      <FolderTreeIcon className="size-3.5 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground-subtle">
        {row.directory || "."}
      </span>
      <span className="shrink-0 rounded-full bg-surface-hover px-1.5 text-ui-xs text-foreground-subtle">
        {row.fileCount}
      </span>
      <span className="shrink-0 whitespace-nowrap text-ui-xs">
        <span className="text-diff-added">+{row.additions}</span>
        <span className="ml-1.5 text-diff-removed">−{row.deletions}</span>
      </span>
    </div>
  );
}
