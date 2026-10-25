import {
  SESSION_MANAGER_DEFAULT_COLUMNS,
  SESSION_MANAGER_TOGGLEABLE_COLUMNS,
  type SessionManagerEnvironmentFilter,
  type SessionManagerSortColumn,
  type SessionManagerSortDirection,
  type SessionManagerStatusFilter,
  type SessionManagerToggleableColumn,
  type SessionManagerTypeFilter,
  type SessionManagerViewState,
} from "./sessionManagerTypes.js";

/** Per-device view state; never broadcast, never setting.json (fork-unsafe storage rule). */
export const SESSION_MANAGER_VIEW_STORAGE_KEY = "zcode.sessionManager.view.v1";

export const SESSION_MANAGER_DEFAULT_VIEW_STATE: SessionManagerViewState = {
  status: "active",
  environment: "all",
  type: "all",
  pinnedOnly: false,
  sortColumn: "updated",
  sortDirection: "desc",
  columns: SESSION_MANAGER_DEFAULT_COLUMNS,
  collapsedGroups: [],
};

const STATUS_VALUES: readonly SessionManagerStatusFilter[] = ["active", "archived", "all"];
const ENVIRONMENT_VALUES: readonly SessionManagerEnvironmentFilter[] = ["all", "local", "worktree"];
const TYPE_VALUES: readonly SessionManagerTypeFilter[] = ["all", "session", "cron", "offpeak"];
const SORT_COLUMNS: readonly SessionManagerSortColumn[] = ["updated", "created", "name"];
const SORT_DIRECTIONS: readonly SessionManagerSortDirection[] = ["asc", "desc"];

function oneOf<T extends string>(values: readonly T[], candidate: unknown, fallback: T): T {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate)
    ? (candidate as T)
    : fallback;
}

/**
 * Defensive parse: unknown fields are dropped and invalid values fall back to defaults,
 * so an older or hand-edited payload can never break the surface.
 */
export function parseSessionManagerViewState(raw: string | null): SessionManagerViewState {
  if (!raw) {
    return SESSION_MANAGER_DEFAULT_VIEW_STATE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return SESSION_MANAGER_DEFAULT_VIEW_STATE;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return SESSION_MANAGER_DEFAULT_VIEW_STATE;
  }
  const input = parsed as Record<string, unknown>;

  const columns: SessionManagerToggleableColumn[] = Array.isArray(input.columns)
    ? SESSION_MANAGER_TOGGLEABLE_COLUMNS.filter(
        (column) => typeof column === "string" && (input.columns as unknown[]).includes(column),
      )
    : [];

  const collapsedGroups = Array.isArray(input.collapsedGroups)
    ? input.collapsedGroups.filter((value): value is string => typeof value === "string")
    : [];

  return {
    status: oneOf(STATUS_VALUES, input.status, SESSION_MANAGER_DEFAULT_VIEW_STATE.status),
    environment: oneOf(
      ENVIRONMENT_VALUES,
      input.environment,
      SESSION_MANAGER_DEFAULT_VIEW_STATE.environment,
    ),
    type: oneOf(TYPE_VALUES, input.type, SESSION_MANAGER_DEFAULT_VIEW_STATE.type),
    pinnedOnly:
      typeof input.pinnedOnly === "boolean"
        ? input.pinnedOnly
        : SESSION_MANAGER_DEFAULT_VIEW_STATE.pinnedOnly,
    sortColumn: oneOf(
      SORT_COLUMNS,
      input.sortColumn,
      SESSION_MANAGER_DEFAULT_VIEW_STATE.sortColumn,
    ),
    sortDirection: oneOf(
      SORT_DIRECTIONS,
      input.sortDirection,
      SESSION_MANAGER_DEFAULT_VIEW_STATE.sortDirection,
    ),
    columns: columns.length > 0 ? columns : SESSION_MANAGER_DEFAULT_VIEW_STATE.columns,
    collapsedGroups,
  };
}

export function readSessionManagerViewState(): SessionManagerViewState {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return SESSION_MANAGER_DEFAULT_VIEW_STATE;
  }
  try {
    return parseSessionManagerViewState(
      window.localStorage.getItem(SESSION_MANAGER_VIEW_STORAGE_KEY),
    );
  } catch {
    return SESSION_MANAGER_DEFAULT_VIEW_STATE;
  }
}

export function persistSessionManagerViewState(state: SessionManagerViewState): void {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      SESSION_MANAGER_VIEW_STORAGE_KEY,
      JSON.stringify({
        status: state.status,
        environment: state.environment,
        type: state.type,
        pinnedOnly: state.pinnedOnly,
        sortColumn: state.sortColumn,
        sortDirection: state.sortDirection,
        columns: state.columns,
        collapsedGroups: state.collapsedGroups,
      }),
    );
  } catch {
    // Storage can be unavailable (private modes, quota); view preferences are non-critical by design.
  }
}

/** Whether any control deviates from its default — drives the "Reset filters" affordance. */
export function hasActiveSessionManagerFilters(state: SessionManagerViewState): boolean {
  return (
    state.status !== SESSION_MANAGER_DEFAULT_VIEW_STATE.status ||
    state.environment !== SESSION_MANAGER_DEFAULT_VIEW_STATE.environment ||
    state.type !== SESSION_MANAGER_DEFAULT_VIEW_STATE.type ||
    state.pinnedOnly !== SESSION_MANAGER_DEFAULT_VIEW_STATE.pinnedOnly
  );
}
