import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { isSessionManagerTab } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { TaskListLoadingHint } from "@/TaskListLoadingHint.js";
import {
  applySessionManagerClientFilters,
  flattenSessionManagerGroups,
  groupSessionManagerRows,
  sortSessionManagerRows,
  type SessionManagerRow,
} from "./sessionManagerModel.js";
import { SessionManagerDeleteDialog } from "./SessionManagerDeleteDialog.js";
import { SessionManagerTable } from "./SessionManagerTable.js";
import { SessionManagerToolbar } from "./SessionManagerToolbar.js";
import type { SessionManagerViewState } from "./sessionManagerTypes.js";
import {
  hasActiveSessionManagerFilters,
  persistSessionManagerViewState,
  readSessionManagerViewState,
  SESSION_MANAGER_DEFAULT_VIEW_STATE,
} from "./sessionManagerViewState.js";
import {
  useSessionManagerRowActions,
  useSessionManagerTaskLists,
  useSessionManagerUniverse,
} from "./useSessionManagerTasks.js";

const SEARCH_DEBOUNCE_MS = 250;

export function SessionManagerLayer() {
  const { intl } = useZCodeIntl();
  const scope = useTabStore((state) => state.tabs.find(isSessionManagerTab)?.scope);
  const openSessionManagerTab = useTabStore((state) => state.openSessionManagerTab);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activeWorkspaceIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activateTabByPath = useTabStore((state) => state.activateTabByPath);
  const setActiveTaskId = useZCodeSessionStore((state) => state.setActiveTaskId);

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
        pinnedOnly: viewState.pinnedOnly,
      }),
    [rows, viewState.environment, viewState.pinnedOnly, viewState.type],
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

  const handleBack = useCallback(() => {
    activateTabByPath(
      activeWorkspacePath ?? "",
      activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : undefined,
    );
  }, [activateTabByPath, activeWorkspaceIdentity, activeWorkspacePath]);

  const openRow = useCallback(
    (row: SessionManagerRow) => {
      activateTabByPath(
        row.task.workspacePath,
        row.task.workspaceIdentity ? { workspaceIdentity: row.task.workspaceIdentity } : undefined,
      );
      setActiveTaskId(row.task.workspacePath, row.task.taskId, row.task.workspaceIdentity);
    },
    [activateTabByPath, setActiveTaskId],
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
    },
    [actions],
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
      className="absolute inset-0 z-10 flex h-full flex-col bg-background"
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
        onClearScope={() => openSessionManagerTab()}
        onBack={handleBack}
        canBack={Boolean(activeWorkspacePath)}
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
          onToggleRowPinned={(row) => void actions.setPinned(row, !row.pinned)}
          onArchiveToggle={(row) => void actions.setArchived(row, !row.archived)}
          onDeleteRow={(row) => setDeleteDialogRows([row])}
          onOpenRow={openRow}
          onStartRename={(row) => setRenamingKey(row.taskKey)}
          onRenameCommit={(row, title) => void renameCommit(row, title)}
          onRenameCancel={() => setRenamingKey(null)}
        />
      )}
      {liveSelectedKeys.size > 0 ? (
        <div
          role="toolbar"
          aria-label={intl.formatMessage({ id: "sessionManager.bulk.ariaLabel" })}
          aria-live="polite"
          className="absolute bottom-4 left-1/2 flex h-10.5 -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-card pl-3.5 pr-1.5 shadow-lg"
        >
          <span className="text-ui-base font-medium">
            {intl.formatPlural({ id: "sessionManager.bulk.selected" }, liveSelectedKeys.size)}
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
          onCancel={() => setDeleteDialogRows(null)}
          onConfirm={(rowsToDelete) => void confirmDelete(rowsToDelete)}
        />
      ) : null}
    </div>
  );
}
