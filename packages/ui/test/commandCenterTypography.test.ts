// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandCenterSearchHistoryEntry } from "@/command-center/commandCenterSearchHistory.js";
import {
  CommandCenterScopeButton,
  CommandCenterSearchHistory,
} from "@/command-center/CommandCenterDialog.js";
import { expectedCopy } from "./helpers/uiCopy.js";

// Typography semantics inside the Cmd+K command center (DESIGN.md) pinned as unit tests:
// - scope tabs / history chip queries: interactive/readable content -> text-ui-base
// - history section titles / timestamps: secondary copy, helper text -> text-ui-sm
// - chip scope prefix: badge marker -> text-ui-xs

afterEach(() => {
  cleanup();
});

describe("CommandCenterScopeButton", () => {
  it("triggers onClick when clicked", () => {
    const onClick = vi.fn();
    render(
      createElement(CommandCenterScopeButton, { active: false, label: "Commands", onClick }, null),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("reflects the active state in aria-selected", () => {
    const { rerender } = render(
      createElement(
        CommandCenterScopeButton,
        { active: true, label: "Tasks", onClick: vi.fn() },
        null,
      ),
    );

    const tab = screen.getByRole("tab", { name: "Tasks" });
    expect(tab.getAttribute("aria-selected")).toBe("true");

    rerender(
      createElement(
        CommandCenterScopeButton,
        { active: false, label: "Tasks", onClick: vi.fn() },
        null,
      ),
    );
    expect(tab.getAttribute("aria-selected")).toBe("false");
  });
});

function makeEntry(
  overrides: Partial<CommandCenterSearchHistoryEntry> = {},
): CommandCenterSearchHistoryEntry {
  return {
    query: "login",
    scope: "all",
    updatedAt: 1700000000000,
    ...overrides,
  };
}

describe("CommandCenterSearchHistory", () => {
  function renderHistory(overrides: Record<string, unknown> = {}) {
    const props = {
      entries: [makeEntry()],
      expanded: false,
      onToggleExpanded: vi.fn(),
      onPickEntry: vi.fn(),
      onClear: vi.fn(),
      historyLabel: expectedCopy("commandCenter.history"),
      clearLabel: expectedCopy("commandCenter.clearHistory"),
      expandLabel: expectedCopy("commandCenter.expandHistory"),
      collapseLabel: expectedCopy("commandCenter.collapseHistory"),
      ...overrides,
    };
    render(createElement(CommandCenterSearchHistory, props));
    return props;
  }

  it("triggers onPickEntry when a history chip is clicked", () => {
    const onPickEntry = vi.fn();
    renderHistory({ onPickEntry });

    fireEvent.click(screen.getByText("login"));
    expect(onPickEntry).toHaveBeenCalledOnce();
    const entry = onPickEntry.mock.calls[0]![0] as CommandCenterSearchHistoryEntry;
    expect(entry.query).toBe("login");
  });

  it("triggers onClear from the clear button", () => {
    const onClear = vi.fn();
    renderHistory({ onClear });

    fireEvent.click(screen.getByLabelText(expectedCopy("commandCenter.clearHistory")));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("shows the expand button once there are more than 6 entries and triggers onToggleExpanded", () => {
    const onToggleExpanded = vi.fn();
    const entries = Array.from({ length: 7 }, (_, i) =>
      makeEntry({ query: `query ${i}`, updatedAt: 1700000000000 + i }),
    );
    renderHistory({ entries, onToggleExpanded });

    const expandBtn = screen.getByLabelText(expectedCopy("commandCenter.expandHistory"));
    fireEvent.click(expandBtn);
    expect(onToggleExpanded).toHaveBeenCalledOnce();
  });

  it("does not show the expand button with 6 entries or fewer", () => {
    renderHistory();
    expect(screen.queryByLabelText(expectedCopy("commandCenter.expandHistory"))).toBeNull();
    expect(screen.queryByLabelText(expectedCopy("commandCenter.collapseHistory"))).toBeNull();
  });
});
