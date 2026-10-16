import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static rendering mounts no rail scroll element, so the virtualizer emits no items and DOM-level
// assertions cannot see the bar; these contracts pin the color/token wiring instead (specs/turn-navigator-pin-highlight.md).
const componentSource = readFileSync(
  fileURLToPath(new URL("../src/v4/ConversationTurnNavigator.tsx", import.meta.url)),
  "utf8",
);
const stylesSource = readFileSync(
  fileURLToPath(new URL("../src/styles.css", import.meta.url)),
  "utf8",
);

describe("turn navigator pinned highlight", () => {
  it("colors pinned bars with the pinned token after the focus/muted branches", () => {
    // tailwind-merge keeps the last bg utility, so the pinned token must come after the colorTone
    // branches in the cn chain to win over focus/muted while proximity scale/opacity still apply.
    const focusIndex = componentSource.indexOf('visualState.colorTone === "muted"');
    const pinnedIndex = componentSource.indexOf('item.isPinned && "bg-pinned-turn"');
    expect(focusIndex).toBeGreaterThan(0);
    expect(pinnedIndex).toBeGreaterThan(focusIndex);
    expect(componentSource.match(/data-pinned=\{item\.isPinned/gu)).toHaveLength(1);
  });

  it("badges the hover card and the accessible name through the pinned label key", () => {
    expect(componentSource).toContain("item.isPinned ?");
    // The icon is decorative (aria-hidden); the visible text is the single accessible label.
    expect(componentSource.match(/chat\.turnNavigator\.pinnedLabel/gu)).toHaveLength(1);
    // Pinned entries append the localized pin label to the base jump label (color is not accessible).
    expect(componentSource).toMatch(
      /aria-label=\{\s*item\.isPinned \? `\$\{jumpToQueryLabel\}, \$\{pinnedLabel\}` : jumpToQueryLabel\s*\}/,
    );
  });

  it("declares the pinned token in every theme block that declares idle-task", () => {
    expect(stylesSource.match(/--color-pinned-turn:/gu)).toHaveLength(4);
    expect(stylesSource.match(/--color-idle-task:/gu)).toHaveLength(4);
  });
});
