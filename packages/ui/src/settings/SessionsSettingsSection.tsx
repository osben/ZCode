import { formatPluralMessage } from "../i18n/formatPlural.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenExistingSessionTarget } from "@/hooks/useOpenExistingSession.js";
import { toast } from "@/components/ui/toast.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { TaskListLoadingHint } from "@/TaskListLoadingHint.js";
import {
  applySessionManagerClientFilters,
  flattenSessionManagerGroups,
  groupSessionManagerRows,
  sortSessionManagerRows,
  type SessionManagerRow,
} from "@/session-manager/sessionManagerModel.js";
import { HiddenSessionsMaintenance } from "@/session-manager/HiddenSessionsMaintenance.js";
import { SessionManagerDeleteDialog } from "@/session-manager/SessionManagerDeleteDialog.js";
import { SessionManagerTable } from "@/session-manager/SessionManagerTable.js";
import { SessionManagerToolbar } from "@/session-manager/SessionManagerToolbar.js";
import type { SessionManagerViewState } from "@/session-manager/sessionManagerTypes.js";
import {
  hasActiveSessionManagerFilters,
  persistSessionManagerViewState,
  readSessionManagerViewState,
  SESSION_MANAGER_DEFAULT_VIEW_STATE,
} from "@/session-manager/sessionManagerViewState.js";
import { useHiddenSessionsMaintenance } from "@/session-manager/useHiddenSessionsMaintenance.js";
import {
  useSessionManagerRowActions,
  useSessionManagerTaskLists,
  useSessionManagerUniverse,
} from "@/session-manager/useSessionManagerTasks.js";
import type { SettingsSessionsScope } from "@/lib/settingsNavigation.js";

const SEARCH_DEBOUNCE_MS = 250;

interface SessionsSettingsSectionProps {
  onOpenSession?: (target: OpenExistingSessionTarget) => Promise<void>;
  /** False on web remote control: historical hidden-content maintenance is unavailable there. */
  allowErase?: boolean;
  /** Workspace scope carried by the settings navigation intent (project-menu entry). */
  scope?: SettingsSessionsScope;
  onClearScope: () => void;
}

export function SessionsSettingsSection({
  allowErase = true,
  scope,
  onClearScope,
  onOpenSession,
}: SessionsSettingsSectionProps) {
  const { intl } = useZCodeIntl();

  const [viewState, setViewState] = useState<SessionManagerViewState>(readSessionManagerViewState);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [deleteDialogRows, setDeleteDialogRows] = useState<readonly SessionManagerRow[] | null>(
    null,
  );
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    persistSessionManagerViewState(viewState);
  }, [viewState]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const patchViewState = useCallback((patch: Partial<SessionManagerViewState>) => {
    setViewState((current) => ({ ...current, ...patch }));
  }, []);

  const universe = useSessionManagerUniverse(scope);
  const { rows, loading } = useSessionManagerTaskLists({
    universe,
    status: viewState.status,
    sortBy: viewState.sortColumn === "created" ? "created" : "updated",
    search: debouncedSearch,
  });
  const formatMessage = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  const actions = useSessionManagerRowActions(universe, formatMessage);
  const hiddenSessions = useHiddenSessionsMaintenance(formatMessage, allowErase);

  const rowsByKey = useMemo(() => new Map(rows.map((row) => [row.taskKey, row])), [rows]);
  // Projection deltas prune the selection: keys whose rows vanished externally cannot stay selected.
  const liveSelectedKeys = useMemo(
    () => new Set(Array.from(selectedKeys).filter((key) => rowsByKey.has(key))),
    [rowsByKey, selectedKeys],
  );

  const visibleRows = useMemo(
    () =>
      applySessionManagerClientFilters(rows, {
        environment: viewState.environment,
        type: viewState.type,
        pinnedOnly: viewState.status === "archived" ? false : viewState.pinnedOnly,
      }),
    [rows, viewState.environment, viewState.pinnedOnly, viewState.type, viewState.status],
  );
  const sortedRows = useMemo(
    () =>
      sortSessionManagerRows(visibleRows, {
        column: viewState.sortColumn,
        direction: viewState.sortDirection,
      }),
    [visibleRows, viewState.sortColumn, viewState.sortDirection],
  );
  const collapsedGroups = useMemo(
    () => new Set(viewState.collapsedGroups),
    [viewState.collapsedGroups],
  );
  const groups = useMemo(() => groupSessionManagerRows(sortedRows), [sortedRows]);
  const flatRows = useMemo(
    () => flattenSessionManagerGroups(groups, collapsedGroups),
    [collapsedGroups, groups],
  );
  const visibleRowKeys = useMemo(
    () => flatRows.flatMap((item) => (item.kind === "row" ? [item.row.taskKey] : [])),
    [flatRows],
  );

  const runningCount = useMemo(
    () => visibleRows.filter((row) => row.running).length,
    [visibleRows],
  );
  const selectedRows = useMemo(
    () =>
      Array.from(liveSelectedKeys)
        .map((key) => rowsByKey.get(key))
        .filter((row): row is SessionManagerRow => Boolean(row)),
    [liveSelectedKeys, rowsByKey],
  );

  const openRow = useCallback(
    (row: SessionManagerRow) => {
      if (!onOpenSession) {
        toast(intl.formatMessage({ id: "sessionManager.openUnavailable" }));
        return;
      }
      void onOpenSession(row.task).catch((error: unknown) => toast(getErrorMessage(error)));
    },
    [intl, onOpenSession],
  );

  const toggleRowSelected = useCallback((row: SessionManagerRow, selected: boolean) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(row.taskKey);
      } else {
        next.delete(row.taskKey);
      }
      return next;
    });
  }, []);

  const allVisibleSelected =
    visibleRowKeys.length > 0 && visibleRowKeys.every((key) => liveSelectedKeys.has(key));
  const someVisibleSelected =
    visibleRowKeys.some((key) => liveSelectedKeys.has(key)) && !allVisibleSelected;

  const toggleSelectAll = useCallback(
    (selected: boolean) => {
      setSelectedKeys((current) => {
        const next = new Set(current);
        for (const key of visibleRowKeys) {
          if (selected) {
            next.add(key);
          } else {
            next.delete(key);
          }
        }
        return next;
      });
    },
    [visibleRowKeys],
  );

  const toggleGroupCollapsed = useCallback((workspaceKey: string) => {
    setViewState((current) => {
      const next = new Set(current.collapsedGroups);
      if (next.has(workspaceKey)) {
        next.delete(workspaceKey);
      } else {
        next.add(workspaceKey);
      }
      return { ...current, collapsedGroups: Array.from(next) };
    });
  }, []);

  const toggleSort = useCallback((column: SessionManagerViewState["sortColumn"]) => {
    setViewState((current) => {
      if (current.sortColumn === column) {
        return { ...current, sortDirection: current.sortDirection === "asc" ? "desc" : "asc" };
      }
      return { ...current, sortColumn: column, sortDirection: column === "name" ? "asc" : "desc" };
    });
  }, []);

  const renameCommit = useCallback(
    async (row: SessionManagerRow, title: string) => {
      setRenamingKey(null);
      const trimmed = title.trim();
      if (!trimmed || trimmed === row.task.title) {
        return;
      }
      await actions.rename(row, trimmed);
    },
    [actions],
  );

  const handleToggleRowPinned = useCallback(
    (row: SessionManagerRow) => void actions.setPinned(row, !row.pinned),
    [actions],
  );
  const handleArchiveToggleRow = useCallback(
    (row: SessionManagerRow) => void actions.setArchived(row, !row.archived),
    [actions],
  );
  const handleDeleteRow = useCallback((row: SessionManagerRow) => {
    setDeleteDialogRows([row]);
  }, []);
  const handleStartRenameRow = useCallback((row: SessionManagerRow) => {
    setRenamingKey(row.taskKey);
  }, []);

  const confirmDelete = useCallback(
    async (rowsToDelete: readonly SessionManagerRow[]) => {
      setDeleteDialogRows(null);
      setSelectedKeys((current) => {
        const next = new Set(current);
        for (const row of rowsToDelete) {
          next.delete(row.taskKey);
        }
        return next;
      });
      await actions.deleteRows(rowsToDelete);
      await hiddenSessions.refresh();
    },
    [actions, hiddenSessions],
  );

  const hasFilters = hasActiveSessionManagerFilters(viewState);
  const mutabilityReason = intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" });
  const scopeChipActive = Boolean(scope);
  // Stable identity keeps the memoized row renderers from re-rendering on every parent pass.
  const effectiveColumns = useMemo(
    () =>
      scopeChipActive ? viewState.columns.filter((column) => column !== "path") : viewState.columns,
    [scopeChipActive, viewState.columns],
  );

  return (
    <div
      className="relative flex h-[calc(100dvh-11rem)] min-h-0 flex-col"
      data-testid="session-manager"
      onKeyDown={(event) => {
        if (
          event.key === "/" &&
          event.target === event.currentTarget &&
          document.activeElement?.tagName !== "INPUT"
        ) {
          event.preventDefault();
          searchInputRef.current?.focus();
        }
      }}
      tabIndex={-1}
    >
      <SessionManagerToolbar
        scope={scope}
        onClearScope={onClearScope}
        search={search}
        onSearchChange={setSearch}
        searchInputRef={searchInputRef}
        viewState={viewState}
        onViewStateChange={patchViewState}
        onResetFilters={() =>
          patchViewState({
            status: SESSION_MANAGER_DEFAULT_VIEW_STATE.status,
            environment: SESSION_MANAGER_DEFAULT_VIEW_STATE.environment,
            type: SESSION_MANAGER_DEFAULT_VIEW_STATE.type,
            pinnedOnly: SESSION_MANAGER_DEFAULT_VIEW_STATE.pinnedOnly,
          })
        }
        hasActiveFilters={hasFilters}
        visibleCount={visibleRows.length}
        runningCount={runningCount}
      />
      {universe.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "sessionManager.empty.noWorkspaces" })}
        </div>
      ) : loading && rows.length === 0 ? (
        <TaskListLoadingHint />
      ) : rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id:
              viewState.status === "archived"
                ? "sessionManager.empty.noArchived"
                : "sessionManager.empty.noSessions",
          })}
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "sessionManager.empty.noMatch" })}
        </div>
      ) : (
        <SessionManagerTable
          flatRows={flatRows}
          columns={effectiveColumns}
          selectedKeys={liveSelectedKeys}
          renamingKey={renamingKey}
          collapsedGroups={collapsedGroups}
          allVisibleSelected={allVisibleSelected}
          someVisibleSelected={someVisibleSelected}
          sortColumn={viewState.sortColumn}
          sortDirection={viewState.sortDirection}
          workspaceScoped={scopeChipActive}
          canMutateRow={actions.canMutate}
          mutabilityReason={mutabilityReason}
          onToggleSort={toggleSort}
          onToggleSelectAll={toggleSelectAll}
          onToggleGroupCollapsed={toggleGroupCollapsed}
          onToggleRowSelected={toggleRowSelected}
          onToggleRowPinned={handleToggleRowPinned}
          onArchiveToggle={handleArchiveToggleRow}
          onDeleteRow={handleDeleteRow}
          onOpenRow={openRow}
          onStartRename={handleStartRenameRow}
          onRenameCommit={(row, title) => void renameCommit(row, title)}
          onRenameCancel={() => setRenamingKey(null)}
        />
      )}
      <HiddenSessionsMaintenance
        sessions={allowErase ? hiddenSessions.sessions : null}
        worktrees={allowErase ? hiddenSessions.worktrees : 0}
        busy={hiddenSessions.busy}
        onErase={hiddenSessions.erase}
      />
      {liveSelectedKeys.size > 0 ? (
        <div
          role="toolbar"
          aria-label={intl.formatMessage({ id: "sessionManager.bulk.ariaLabel" })}
          aria-live="polite"
          className="absolute bottom-4 left-1/2 flex h-10.5 -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-card pl-3.5 pr-1.5 shadow-lg"
        >
          <span className="text-ui-base font-medium">
            {formatPluralMessage(intl, "sessionManager.bulk.selected", liveSelectedKeys.size)}
          </span>
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1"
            onClick={() => {
              void Promise.allSettled(selectedRows.map((row) => actions.setArchived(row, true)));
              setSelectedKeys(new Set());
            }}
          >
            <Archive className="size-3.5" />
            {intl.formatMessage({ id: "sessionManager.archive" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1 text-destructive hover:text-destructive"
            onClick={() => setDeleteDialogRows(selectedRows)}
          >
            <Trash2 className="size-3.5" />
            {intl.formatMessage({ id: "sessionManager.delete" })}
          </Button>
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "sessionManager.bulk.clear" })}
            onClick={() => setSelectedKeys(new Set())}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {deleteDialogRows ? (
        <SessionManagerDeleteDialog
          selectedRows={deleteDialogRows}
          loadTreeCounts={actions.countTrees}
          loadCapability={actions.deletionSupported}
          loadWorktreePreview={actions.worktreePreview}
          onCancel={() => setDeleteDialogRows(null)}
          onConfirm={(rowsToDelete) => void confirmDelete(rowsToDelete)}
        />
      ) : null}
    </div>
  );
}
