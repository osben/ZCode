import { memo, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder, Star } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { IntlInstance } from "@/i18n/createIntl.js";
import {
  buildSessionManagerGridTemplate,
  buildSessionManagerMinTableWidth,
  SESSION_MANAGER_SORTABLE_COLUMNS,
  sessionManagerColumnLabelId,
} from "./sessionManagerColumns.js";
import { useSessionManagerPullRequests } from "./useSessionManagerPullRequests.js";
import {
  buildSessionManagerVisibleRowSignature,
  type FlattenedSessionManagerRow,
  type SessionManagerRow,
} from "./sessionManagerModel.js";
import type {
  SessionManagerSortColumn,
  SessionManagerSortDirection,
  SessionManagerToggleableColumn,
} from "./sessionManagerTypes.js";
import { SessionManagerRowView } from "./SessionManagerRowView.js";

interface SessionManagerTableProps {
  flatRows: readonly FlattenedSessionManagerRow[];
  columns: readonly SessionManagerToggleableColumn[];
  selectedKeys: ReadonlySet<string>;
  renamingKey: string | null;
  collapsedGroups: ReadonlySet<string>;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  sortColumn: SessionManagerSortColumn;
  sortDirection: SessionManagerSortDirection;
  workspaceScoped: boolean;
  canMutateRow: (row: SessionManagerRow) => boolean;
  mutabilityReason?: string;
  onToggleSort: (column: SessionManagerSortColumn) => void;
  onToggleSelectAll: (selected: boolean) => void;
  onToggleGroupCollapsed: (workspaceKey: string) => void;
  onToggleRowSelected: (row: SessionManagerRow, selected: boolean) => void;
  onToggleRowPinned: (row: SessionManagerRow) => void;
  onArchiveToggle: (row: SessionManagerRow) => void;
  onDeleteRow: (row: SessionManagerRow) => void;
  onOpenRow: (row: SessionManagerRow) => void;
  onStartRename: (row: SessionManagerRow) => void;
  onRenameCommit: (row: SessionManagerRow, title: string) => void;
  onRenameCancel: () => void;
}

const SortHeaderCell = memo(function SortHeaderCell({
  column,
  sortColumn,
  sortDirection,
  onToggleSort,
  intl,
}: {
  column: SessionManagerToggleableColumn;
  sortColumn: SessionManagerSortColumn;
  sortDirection: SessionManagerSortDirection;
  onToggleSort: (column: SessionManagerSortColumn) => void;
  intl: IntlInstance;
}) {
  const active = sortColumn === column;
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-1 text-ui-xs",
        active ? "text-foreground" : "text-foreground-subtle hover:text-foreground",
      )}
      onClick={() => onToggleSort(column as SessionManagerSortColumn)}
    >
      {intl.formatMessage({ id: sessionManagerColumnLabelId(column) })}
      {active ? (
        <span aria-hidden="true" className="text-foreground-subtlest">
          {sortDirection === "asc" ? "↑" : "↓"}
        </span>
      ) : null}
    </button>
  );
});

export function SessionManagerTable(props: SessionManagerTableProps) {
  const { intl } = useZCodeIntl();
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (props.flatRows[index]?.kind === "group" ? 34 : 36),
    overscan: 12,
  });
  const gridTemplate = buildSessionManagerGridTemplate(props.columns);
  const visibleColumns = props.columns;

  // PR status is requested only for the virtualizer's visible rows; keyed by
  // the visible composite row keys so scroll frames without membership changes
  // do not re-fire probes (the service TTL absorbs the rest).
  const visibleRowSignature = buildSessionManagerVisibleRowSignature(
    props.flatRows,
    virtualizer.getVirtualItems().map((virtualItem) => virtualItem.index),
  );
  const visibleRows = useMemo(
    () =>
      virtualizer.getVirtualItems().flatMap((virtualItem) => {
        const item = props.flatRows[virtualItem.index];
        return item?.kind === "row" ? [item.row] : [];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content-addressed by the visible row-key set; the virtualizer re-reads during render
    [visibleRowSignature, props.flatRows],
  );
  useSessionManagerPullRequests(visibleRows, {
    active: props.columns.includes("pullRequests"),
  });

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={intl.formatMessage({ id: "sessionManager.table.ariaLabel" })}
      aria-rowcount={props.flatRows.length + 1}
      className="relative min-h-0 flex-1 overflow-auto bg-background"
    >
      <div style={{ minWidth: buildSessionManagerMinTableWidth(props.columns) }}>
        <div
          role="row"
          className="sticky top-0 z-10 grid h-8 items-center border-b border-border bg-header text-ui-xs"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          <div role="columnheader" className="flex items-center px-2">
            <Checkbox
              checked={
                props.someVisibleSelected
                  ? props.allVisibleSelected
                    ? true
                    : "indeterminate"
                  : false
              }
              aria-label={intl.formatMessage({ id: "sessionManager.selectAll.ariaLabel" })}
              onCheckedChange={(checked) => props.onToggleSelectAll(checked === true)}
            />
          </div>
          {visibleColumns.map((column) => (
            <div key={column} role="columnheader" className="min-w-0 px-2">
              {column === "pinned" ? (
                // The pinned column is 32px wide; a star header fits where the localized word cannot.
                <Star
                  className="size-3 text-foreground-subtlest"
                  aria-label={intl.formatMessage({ id: sessionManagerColumnLabelId(column) })}
                />
              ) : SESSION_MANAGER_SORTABLE_COLUMNS.includes(column) ? (
                <SortHeaderCell
                  column={column}
                  sortColumn={props.sortColumn}
                  sortDirection={props.sortDirection}
                  onToggleSort={props.onToggleSort}
                  intl={intl}
                />
              ) : (
                <span className="text-foreground-subtle">
                  {intl.formatMessage({ id: sessionManagerColumnLabelId(column) })}
                </span>
              )}
            </div>
          ))}
          <div role="columnheader" />
        </div>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = props.flatRows[virtualItem.index];
            if (!item) {
              return null;
            }
            if (item.kind === "group") {
              return (
                <div
                  key={virtualItem.key}
                  role="row"
                  className="absolute left-0 right-0 flex h-8.5 items-center gap-2 border-b border-border bg-background-alt px-2"
                  style={{ top: virtualItem.start, height: virtualItem.size }}
                >
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded-sm text-foreground-subtle hover:bg-surface-hover"
                    disabled={props.workspaceScoped}
                    aria-expanded={
                      !props.workspaceScoped && !props.collapsedGroups.has(item.group.workspaceKey)
                    }
                    aria-label={intl.formatMessage(
                      { id: "sessionManager.group.toggle.ariaLabel" },
                      { name: item.group.label },
                    )}
                    onClick={() => props.onToggleGroupCollapsed(item.group.workspaceKey)}
                  >
                    {props.workspaceScoped ? (
                      <ChevronDown className="size-3.5" />
                    ) : props.collapsedGroups.has(item.group.workspaceKey) ? (
                      <ChevronRight className="size-3.5" />
                    ) : (
                      <ChevronDown className="size-3.5" />
                    )}
                  </button>
                  <Folder className="size-3.5 shrink-0 text-foreground-subtle" />
                  <span className="shrink-0 text-ui-base font-medium text-foreground">
                    {item.group.label}
                  </span>
                  <span
                    className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
                    title={item.group.workspacePath}
                  >
                    {item.group.workspacePath}
                  </span>
                  <span className="ml-auto shrink-0 text-ui-xs text-foreground-subtle">
                    {intl.formatPlural(
                      { id: "sessionManager.count.sessions" },
                      item.group.rows.length,
                    )}
                    {" · "}
                    {intl.formatPlural(
                      { id: "sessionManager.count.active" },
                      item.group.activeCount,
                    )}
                  </span>
                </div>
              );
            }
            const row = item.row;
            return (
              <div
                key={virtualItem.key}
                className="absolute left-0 right-0"
                style={{ top: virtualItem.start, height: virtualItem.size }}
              >
                <SessionManagerRowView
                  row={row}
                  columns={visibleColumns}
                  selected={props.selectedKeys.has(row.taskKey)}
                  renaming={props.renamingKey === row.taskKey}
                  canMutate={props.canMutateRow(row)}
                  mutabilityReason={props.mutabilityReason}
                  onStartRename={props.onStartRename}
                  onRenameCommit={props.onRenameCommit}
                  onRenameCancel={props.onRenameCancel}
                  onToggleSelected={props.onToggleRowSelected}
                  onTogglePinned={props.onToggleRowPinned}
                  onArchiveToggle={props.onArchiveToggle}
                  onDelete={props.onDeleteRow}
                  onOpen={props.onOpenRow}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
