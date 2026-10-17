import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  buildSessionManagerGridTemplate,
  buildSessionManagerMinTableWidth,
  SESSION_MANAGER_CHECKBOX_COLUMN_WIDTH,
  SESSION_MANAGER_MENU_COLUMN_WIDTH,
  SESSION_MANAGER_SORTABLE_COLUMNS,
  sessionManagerColumnLabelId,
} from "@/session-manager/sessionManagerColumns.js";
import {
  SESSION_MANAGER_TOGGLEABLE_COLUMNS,
  type SessionManagerToggleableColumn,
} from "@/session-manager/sessionManagerTypes.js";

function templateMinimumPx(template: string): number {
  const tracks = template.match(/minmax\(\d+px,\s*[0-9.]+fr\)|\d+px/g) ?? [];
  if (tracks.length === 0) {
    throw new Error(`Could not parse grid template "${template}"`);
  }
  return tracks.reduce((sum, track) => sum + Number(/(\d+)px/.exec(track)?.[1]), 0);
}

describe("sessionManagerColumns", () => {
  it("derives the min table width from the same column minimums as the grid template", () => {
    const columnSets: ReadonlyArray<readonly SessionManagerToggleableColumn[]> = [
      [],
      ["name"],
      ["name", "model", "updated"],
      [...SESSION_MANAGER_TOGGLEABLE_COLUMNS],
    ];
    for (const columns of columnSets) {
      const template = buildSessionManagerGridTemplate(columns);
      expect(buildSessionManagerMinTableWidth(columns)).toBe(templateMinimumPx(template));
      // The fixed chrome columns bracket the toggleable set in both derivations.
      expect(template.startsWith(`${SESSION_MANAGER_CHECKBOX_COLUMN_WIDTH}px `)).toBe(true);
      expect(template.endsWith(` ${SESSION_MANAGER_MENU_COLUMN_WIDTH}px`)).toBe(true);
    }
  });

  it("needs more than the old hardcoded floor once path/model columns are visible", () => {
    // Regression: the previous constant (1060px) was smaller than the grid minimum, so the
    // right-side columns overlapped instead of scrolling.
    expect(
      buildSessionManagerMinTableWidth([...SESSION_MANAGER_TOGGLEABLE_COLUMNS]),
    ).toBeGreaterThan(1060);
  });

  it("provides a localized header label for every toggleable column in every shipped locale", () => {
    // A missing key would render the raw `sessionManager.column.*` id in the table header and
    // the column-toggle toolbar.
    const enMessages = enUS as Record<string, string>;
    const zhMessages = zhCN as Record<string, string>;
    for (const column of SESSION_MANAGER_TOGGLEABLE_COLUMNS) {
      const id = sessionManagerColumnLabelId(column);
      expect(enMessages[id], `en-US missing ${id}`).toBeTruthy();
      expect(zhMessages[id], `zh-CN missing ${id}`).toBeTruthy();
    }
  });

  it("sorts exactly the columns the table header renders with a sort affordance", () => {
    // The sort affordance decision lives in SessionManagerTable; a column added to the
    // constant must actually reach the header, and the constant must stay inside the
    // toggleable universe so hidden columns cannot keep a stale sort affordance.
    expect(SESSION_MANAGER_SORTABLE_COLUMNS.length).toBeGreaterThan(0);
    for (const column of SESSION_MANAGER_SORTABLE_COLUMNS) {
      expect(SESSION_MANAGER_TOGGLEABLE_COLUMNS).toContain(column);
    }
    const tableSource = readFileSync(
      join(import.meta.dirname, "../src/session-manager/SessionManagerTable.tsx"),
      "utf8",
    );
    expect(tableSource).toContain("SESSION_MANAGER_SORTABLE_COLUMNS.includes(column)");
  });
});
