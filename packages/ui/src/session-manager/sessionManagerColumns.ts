import type { SessionManagerToggleableColumn } from "./sessionManagerTypes.js";

/** Fixed chrome columns around the toggleable set. */
export const SESSION_MANAGER_CHECKBOX_COLUMN_WIDTH = 36;
export const SESSION_MANAGER_MENU_COLUMN_WIDTH = 44;

/**
 * Per-column minimum width in px. This is the single source of truth: the grid template and the
 * table's min-width are both derived from it, so the declared scroll floor can never be smaller
 * than what the grid actually needs (a smaller floor clipped the right-side columns instead of
 * scrolling).
 */
const COLUMN_MIN_WIDTHS: Record<SessionManagerToggleableColumn, number> = {
  pinned: 32,
  name: 180,
  status: 104,
  type: 100,
  changes: 92,
  branch: 150,
  environment: 102,
  model: 112,
  updated: 92,
  created: 84,
  path: 140,
};

/** Columns that flex beyond their minimum once the table is wider than the total minimum. */
const COLUMN_MAX_FLEX: Partial<Record<SessionManagerToggleableColumn, string>> = {
  name: "1.4fr",
  path: "1fr",
};

function columnTemplate(column: SessionManagerToggleableColumn): string {
  const flex = COLUMN_MAX_FLEX[column];
  return flex
    ? `minmax(${COLUMN_MIN_WIDTHS[column]}px, ${flex})`
    : `${COLUMN_MIN_WIDTHS[column]}px`;
}

/** One shared template for the header row and every body row so cells stay aligned. */
export function buildSessionManagerGridTemplate(
  columns: readonly SessionManagerToggleableColumn[],
): string {
  return [
    `${SESSION_MANAGER_CHECKBOX_COLUMN_WIDTH}px`,
    ...columns.map(columnTemplate),
    `${SESSION_MANAGER_MENU_COLUMN_WIDTH}px`,
  ].join(" ");
}

/** Horizontal scroll floor for the currently visible column set. */
export function buildSessionManagerMinTableWidth(
  columns: readonly SessionManagerToggleableColumn[],
): number {
  return (
    SESSION_MANAGER_CHECKBOX_COLUMN_WIDTH +
    columns.reduce((sum, column) => sum + COLUMN_MIN_WIDTHS[column], 0) +
    SESSION_MANAGER_MENU_COLUMN_WIDTH
  );
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
