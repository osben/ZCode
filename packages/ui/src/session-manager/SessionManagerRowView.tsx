/* eslint-disable max-lines -- Every row cell renders here so the shared grid template, cell set, and row menu stay in one file. */
import { memo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Clock,
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Star,
  Trash2,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { IncognitoTaskMarker } from "@/components/IncognitoTaskMarker.js";
import { getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { IntlInstance } from "@/i18n/createIntl.js";
import { buildSessionManagerGridTemplate } from "./sessionManagerColumns.js";
import { sessionManagerTaskType, type SessionManagerRow } from "./sessionManagerModel.js";
import type { SessionManagerToggleableColumn } from "./sessionManagerTypes.js";

type SessionManagerLiveStatus = "idle" | "running" | "waiting" | "completed" | "error";

const STATUS_PILL_CLASS: Record<SessionManagerLiveStatus, string> = {
  running: "bg-success/14 text-success",
  waiting: "bg-warning/14 text-warning",
  idle: "bg-surface text-foreground-subtle",
  completed: "bg-surface text-foreground-subtlest",
  error: "bg-destructive/12 text-destructive",
};
const STATUS_LABEL_ID: Record<SessionManagerLiveStatus, string> = {
  running: "sessionManager.status.running",
  waiting: "sessionManager.status.waiting",
  idle: "sessionManager.status.idle",
  completed: "sessionManager.status.completed",
  error: "sessionManager.status.error",
};

function StatusPill({ row, intl }: { row: SessionManagerRow; intl: IntlInstance }) {
  const liveStatus = row.task.liveStatus;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-ui-xs font-medium",
        STATUS_PILL_CLASS[liveStatus],
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-current",
          liveStatus === "running" && "animate-pulse",
        )}
      />
      {intl.formatMessage({ id: STATUS_LABEL_ID[liveStatus] })}
    </span>
  );
}

function TypeCell({ row, intl }: { row: SessionManagerRow; intl: IntlInstance }) {
  const type = sessionManagerTaskType(row.task);
  const icon =
    type === "cron" ? (
      <Clock className="size-3.5 shrink-0" />
    ) : type === "offpeak" ? (
      <Moon className="size-3.5 shrink-0" />
    ) : (
      <MessageSquare className="size-3.5 shrink-0" />
    );
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
      {icon}
      {intl.formatMessage({ id: `sessionManager.type.${type}` })}
    </span>
  );
}

function ChangesCell({ row }: { row: SessionManagerRow }) {
  const summary = getTaskChangeSummary(row.task);
  if (!summary || (summary.added === 0 && summary.removed === 0)) {
    return <span className="text-ui-sm text-foreground-subtlest">—</span>;
  }
  return (
    <span className="font-mono text-ui-xs tabular-nums">
      <span className="text-success">+{summary.added}</span>{" "}
      <span className="text-destructive">−{summary.removed}</span>
    </span>
  );
}

function BranchCell({ row }: { row: SessionManagerRow }) {
  const worktree = row.task.executionWorktree;
  if (!worktree) {
    return <span className="text-ui-sm text-foreground-subtlest">—</span>;
  }
  if (row.task.executionWorktreeMissing) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-ui-xs text-destructive">
        <GitBranch className="size-3 shrink-0" />
        {worktree.branchName ?? "missing"}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-ui-xs text-foreground-subtle">
      <GitBranch className="size-3 shrink-0" />
      <span className="truncate">{worktree.branchName ?? worktree.path}</span>
    </span>
  );
}

function NameCell({
  row,
  intl,
  renaming,
  onRenameCommit,
  onRenameCancel,
}: {
  row: SessionManagerRow;
  intl: IntlInstance;
  renaming: boolean;
  onRenameCommit: (row: SessionManagerRow, title: string) => void;
  onRenameCancel: () => void;
}) {
  const title = row.task.title || intl.formatMessage({ id: "taskList.untitled" });
  if (renaming) {
    return (
      <input
        autoFocus
        defaultValue={row.task.titleOverridden ? row.task.title : title}
        className="h-6 w-full min-w-0 rounded-sm border border-input-border-focused bg-input px-1 text-ui-base text-foreground outline-none"
        aria-label={intl.formatMessage({ id: "sessionManager.rename.ariaLabel" })}
        onBlur={(event) => onRenameCommit(row, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onRenameCommit(row, event.currentTarget.value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onRenameCancel();
          }
        }}
      />
    );
  }
  return (
    <span className="block truncate text-ui-base text-foreground" title={title}>
      {title}
    </span>
  );
}

interface SessionManagerRowViewProps {
  row: SessionManagerRow;
  columns: readonly SessionManagerToggleableColumn[];
  selected: boolean;
  renaming: boolean;
  canMutate: boolean;
  mutabilityReason?: string;
  onStartRename: (row: SessionManagerRow) => void;
  onRenameCommit: (row: SessionManagerRow, title: string) => void;
  onRenameCancel: () => void;
  onToggleSelected: (row: SessionManagerRow, selected: boolean) => void;
  onTogglePinned: (row: SessionManagerRow) => void;
  onArchiveToggle: (row: SessionManagerRow) => void;
  onDelete: (row: SessionManagerRow) => void;
  onOpen: (row: SessionManagerRow) => void;
}

export const SessionManagerRowView = memo(function SessionManagerRowView({
  row,
  columns,
  selected,
  renaming,
  canMutate,
  mutabilityReason,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onToggleSelected,
  onTogglePinned,
  onArchiveToggle,
  onDelete,
  onOpen,
}: SessionManagerRowViewProps) {
  const { intl, locale } = useZCodeIntl();
  const [menuOpen, setMenuOpen] = useState(false);
  const { fileManagerLabel, handleOpenTaskPathInFileManager, handleCopyText } =
    useTaskListItemContextActions({
      workspacePath: row.task.workspacePath,
      remoteSessionId: row.task.remoteSessionId,
      workspaceIdentity: row.task.workspaceIdentity,
      taskId: row.task.taskId,
      provider: row.task.provider,
      intl,
      loadTaskPaths: menuOpen,
      loadProviderConfig: false,
    });

  const cell = (column: SessionManagerToggleableColumn) => {
    switch (column) {
      case "pinned":
        return (
          <button
            type="button"
            className={cn(
              "inline-flex size-6 items-center justify-center rounded-sm hover:bg-surface-hover",
              row.pinned ? "text-warning" : "text-foreground-subtlest hover:text-foreground-subtle",
            )}
            disabled={!canMutate}
            title={
              mutabilityReason ??
              intl.formatMessage({ id: row.pinned ? "sessionManager.unpin" : "sessionManager.pin" })
            }
            aria-label={intl.formatMessage({
              id: row.pinned ? "sessionManager.unpin" : "sessionManager.pin",
            })}
            aria-pressed={row.pinned}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePinned(row);
            }}
          >
            <Star className="size-3.5" fill={row.pinned ? "currentColor" : "none"} />
          </button>
        );
      case "name":
        return (
          <NameCell
            row={row}
            intl={intl}
            renaming={renaming}
            onRenameCommit={onRenameCommit}
            onRenameCancel={onRenameCancel}
          />
        );
      case "status":
        return <StatusPill row={row} intl={intl} />;
      case "type":
        return <TypeCell row={row} intl={intl} />;
      case "changes":
        return <ChangesCell row={row} />;
      case "branch":
        return <BranchCell row={row} />;
      case "environment":
        return (
          <span className="inline-flex items-center gap-1.5">
            {row.task.executionWorktree ? (
              <span className="inline-flex h-5 items-center gap-1 rounded-sm border border-border bg-surface px-1.5 text-ui-xs text-foreground-subtle">
                <GitBranch className="size-3" />
                {intl.formatMessage({ id: "sessionManager.environment.worktree" })}
              </span>
            ) : (
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "sessionManager.environment.local" })}
              </span>
            )}
            {row.task.incognito ? (
              <span className="text-foreground-subtle">
                <IncognitoTaskMarker task={row.task} />
              </span>
            ) : null}
          </span>
        );
      case "model":
        return (
          <span className="block truncate text-ui-sm text-foreground-subtle" title={row.task.model}>
            {row.task.model}
          </span>
        );
      case "updated":
        return (
          <span className="text-ui-sm text-foreground-subtle">
            {formatTaskRelativeTime(row.task.updatedAt, intl)}
          </span>
        );
      case "created":
        return (
          <span className="text-ui-sm text-foreground-subtlest">
            {new Date(row.task.createdAt).toLocaleDateString(locale, {
              month: "short",
              day: "numeric",
            })}
          </span>
        );
      case "path":
        return (
          <span
            className="block truncate font-mono text-ui-xs text-foreground-subtlest"
            title={row.task.workspacePath}
          >
            {row.task.workspacePath}
          </span>
        );
    }
  };

  return (
    <div
      role="row"
      tabIndex={0}
      aria-selected={selected}
      style={{ gridTemplateColumns: buildSessionManagerGridTemplate(columns) }}
      className={cn(
        "group/smrow grid h-9 items-center border-b border-border text-ui-base",
        selected ? "bg-selected" : "hover:bg-surface-hover",
        row.offline && "opacity-55",
      )}
      onClick={(event) => {
        // The cells fill the whole row, so a plain background-click guard would make every cell
        // click dead. Open on any row click except the interactive controls inside it.
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, input, textarea, a, select, label")) {
          return;
        }
        onOpen(row);
      }}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
          event.preventDefault();
          onOpen(row);
        }
      }}
    >
      <div role="gridcell" className="flex items-center px-2">
        <Checkbox
          checked={selected}
          aria-label={intl.formatMessage({ id: "sessionManager.selectRow.ariaLabel" })}
          onCheckedChange={(checked) => onToggleSelected(row, checked === true)}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
      {columns.map((column) => (
        <div key={column} role="gridcell" className="min-w-0 px-2">
          {cell(column)}
        </div>
      ))}
      <div role="gridcell" className="flex items-center justify-center">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "sessionManager.rowMenu.ariaLabel" })}
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem onSelect={() => onOpen(row)}>
              <ExternalLink className="h-3.5 w-3.5" />
              {intl.formatMessage({ id: "sessionManager.open" })}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canMutate} onSelect={() => onStartRename(row)}>
              <Pencil className="h-3.5 w-3.5" />
              {intl.formatMessage({ id: "sessionManager.rename" })}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canMutate} onSelect={() => onTogglePinned(row)}>
              {row.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              {intl.formatMessage({
                id: row.pinned ? "sessionManager.unpin" : "sessionManager.pin",
              })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleOpenTaskPathInFileManager()}>
              <FolderOpen className="h-3.5 w-3.5" />
              {fileManagerLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void handleCopyText(
                  intl.formatMessage({ id: "sessionManager.copyPath" }),
                  row.task.workspacePath,
                )
              }
            >
              <Copy className="h-3.5 w-3.5" />
              {intl.formatMessage({ id: "sessionManager.copyPath" })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!canMutate} onSelect={() => onArchiveToggle(row)}>
              {row.archived ? (
                <ArchiveRestore className="h-3.5 w-3.5" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
              {intl.formatMessage({
                id: row.archived ? "sessionManager.restore" : "sessionManager.archive",
              })}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canMutate}
              className="text-destructive focus:text-destructive"
              onSelect={() => onDelete(row)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {intl.formatMessage({ id: "sessionManager.delete" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});
