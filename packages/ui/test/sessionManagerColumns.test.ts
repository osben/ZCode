import { describe, expect, it } from "vitest";
import {
  buildSessionManagerGridTemplate,
  buildSessionManagerMinTableWidth,
  SESSION_MANAGER_CHECKBOX_COLUMN_WIDTH,
  SESSION_MANAGER_MENU_COLUMN_WIDTH,
} from "@/session-manager/sessionManagerColumns.js";
import { SESSION_MANAGER_TOGGLEABLE_COLUMNS } from "@/session-manager/sessionManagerTypes.js";

function templateMinimumPx(template: string): number {
  const tracks = template.match(/minmax\(\d+px,\s*[0-9.]+fr\)|\d+px/g) ?? [];
  if (tracks.length === 0) {
    throw new Error(`Could not parse grid template "${template}"`);
  }
  return tracks.reduce((sum, track) => sum + Number(/(\d+)px/.exec(track)?.[1]), 0);
}

describe("sessionManagerColumns", () => {
  it("derives the min table width from the same column minimums as the grid template", () => {
    const columnSets: ReadonlyArray<readonly string[]> = [
      [],
      ["name"],
      ["name", "model", "updated"],
      [...SESSION_MANAGER_TOGGLEABLE_COLUMNS],
    ];
    for (const columns of columnSets) {
      const template = buildSessionManagerGridTemplate(columns);
      expect(buildSessionManagerMinTableWidth(columns)).toBe(templateMinimumPx(template));
    }
  });

  it("reserves the fixed chrome columns in the template", () => {
    const template = buildSessionManagerGridTemplate([...SESSION_MANAGER_TOGGLEABLE_COLUMNS]);
    expect(template.startsWith(`${SESSION_MANAGER_CHECKBOX_COLUMN_WIDTH}px `)).toBe(true);
    expect(template.endsWith(` ${SESSION_MANAGER_MENU_COLUMN_WIDTH}px`)).toBe(true);
  });

  it("needs more than the old hardcoded floor once path/model columns are visible", () => {
    // Regression: the previous constant (1060px) was smaller than the grid minimum, so the
    // right-side columns overlapped instead of scrolling.
    expect(
      buildSessionManagerMinTableWidth([...SESSION_MANAGER_TOGGLEABLE_COLUMNS]),
    ).toBeGreaterThan(1060);
  });
});
