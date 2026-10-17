import type { SessionManagerToggleableColumn } from "./sessionManagerTypes.js";

/** Fixed chrome columns around the toggleable set. */
export const SESSION_MANAGER_CHECKBOX_COLUMN_WIDTH = 36;
export const SESSION_MANAGER_MENU_COLUMN_WIDTH = 44;
/** Below this width the table scrolls horizontally instead of squeezing columns. */
export const SESSION_MANAGER_MIN_TABLE_WIDTH = 1060;

const COLUMN_WIDTHS: Record<SessionManagerToggleableColumn, string> = {
  pinned: "32px",
  name: "minmax(180px, 1.4fr)",
  status: "104px",
  type: "100px",
  changes: "92px",
  branch: "150px",
  environment: "102px",
  model: "112px",
  updated: "92px",
  created: "84px",
  path: "minmax(140px, 1fr)",
};

/** One shared template for the header row and every body row so cells stay aligned. */
export function buildSessionManagerGridTemplate(
  columns: readonly SessionManagerToggleableColumn[],
): string {
  return [
    `${SESSION_MANAGER_CHECKBOX_COLUMN_WIDTH}px`,
    ...columns.map((column) => COLUMN_WIDTHS[column]),
    `${SESSION_MANAGER_MENU_COLUMN_WIDTH}px`,
  ].join(" ");
}

export function sessionManagerColumnLabelId(column: SessionManagerToggleableColumn): string {
  return `sessionManager.column.${column}`;
}

/** Columns that carry a sort affordance; updated/created sort server-side, name sorts client-side. */
export const SESSION_MANAGER_SORTABLE_COLUMNS: readonly SessionManagerToggleableColumn[] = [
  "name",
  "updated",
  "created",
];
