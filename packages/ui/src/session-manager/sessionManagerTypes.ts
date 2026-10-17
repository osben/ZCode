import type { SessionManagerScope } from "@/store/tabStore.js";

export type { SessionManagerScope };

export type SessionManagerStatusFilter = "active" | "archived" | "all";
export type SessionManagerEnvironmentFilter = "all" | "local" | "worktree";
export type SessionManagerTypeFilter = "all" | "session" | "cron" | "offpeak";
export type SessionManagerSortColumn = "updated" | "created" | "name";
export type SessionManagerSortDirection = "asc" | "desc";

/** Toggleable columns in canonical display order; the selection checkbox and row menu are always present. */
export const SESSION_MANAGER_TOGGLEABLE_COLUMNS = [
  "pinned",
  "name",
  "status",
  "type",
  "changes",
  "branch",
  "environment",
  "model",
  "updated",
  "created",
  "path",
] as const;

export type SessionManagerToggleableColumn = (typeof SESSION_MANAGER_TOGGLEABLE_COLUMNS)[number];

/** Columns shown by default; "path" is hidden while the view is workspace-scoped (single group) regardless of this list. */
export const SESSION_MANAGER_DEFAULT_COLUMNS: SessionManagerToggleableColumn[] = [
  "pinned",
  "name",
  "status",
  "type",
  "changes",
  "branch",
  "environment",
  "model",
  "updated",
  "created",
];

export interface SessionManagerViewState {
  status: SessionManagerStatusFilter;
  environment: SessionManagerEnvironmentFilter;
  type: SessionManagerTypeFilter;
  pinnedOnly: boolean;
  sortColumn: SessionManagerSortColumn;
  sortDirection: SessionManagerSortDirection;
  /** Visible toggleable columns in canonical order. */
  columns: SessionManagerToggleableColumn[];
  collapsedGroups: string[];
}
