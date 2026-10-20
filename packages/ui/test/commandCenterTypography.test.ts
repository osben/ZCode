// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandCenterSearchHistoryEntry } from "@/command-center/commandCenterSearchHistory.js";
import {
  CommandCenterConversationTimestamp,
  CommandCenterScopeButton,
  CommandCenterSearchHistory,
} from "@/command-center/CommandCenterDialog.js";

// Codifies the font-size semantics (DESIGN.md) inside the Cmd+K command center as unit-test
// targets:
// - Scope tabs / history chip search terms: interactive/readable content → text-ui-base
// - History section titles / timestamps: secondary copy, helper text → text-ui-sm
// - Chip scope prefix: badge marker → text-ui-xs

afterEach(() => {
  cleanup();
});

describe("CommandCenterScopeButton", () => {
  it("使用 text-ui-base 而非过小的 text-ui-xs", () => {
    render(
      createElement(
        CommandCenterScopeButton,
        { active: false, label: "All", onClick: vi.fn() },
        createElement("span", { "data-testid": "icon" }),
      ),
    );

    const tab = screen.getByRole("tab", { name: "All" });
    expect(tab.className).toContain("text-ui-base");
    expect(tab.className).not.toContain("text-ui-xs");
  });

  it("点击时触发 onClick", () => {
    const onClick = vi.fn();
    render(
      createElement(CommandCenterScopeButton, { active: false, label: "Commands", onClick }, null),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Commands" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("active 状态反映在 aria-selected", () => {
    const { rerender } = render(
      createElement(
        CommandCenterScopeButton,
        { active: true, label: "Chats", onClick: vi.fn() },
        null,
      ),
    );

    const tab = screen.getByRole("tab", { name: "Chats" });
    expect(tab.getAttribute("aria-selected")).toBe("true");

    rerender(
      createElement(
        CommandCenterScopeButton,
        { active: false, label: "Chats", onClick: vi.fn() },
        null,
      ),
    );
    expect(tab.getAttribute("aria-selected")).toBe("false");
  });
});

describe("CommandCenterConversationTimestamp", () => {
  it("使用 text-ui-sm 而非 text-ui-xs", () => {
    render(createElement(CommandCenterConversationTimestamp, null, "2 hours ago"));

    const span = screen.getByText("2 hours ago");
    expect(span.className).toContain("text-ui-sm");
    expect(span.className).not.toContain("text-ui-xs");
  });
});

function getHistoryChipButton(query: string) {
  const chipContainer = screen.getByText("Search history").parentElement?.nextElementSibling;
  const buttons = chipContainer?.querySelectorAll("button");
  return Array.from(buttons ?? []).find((button) => button.textContent?.includes(query))!;
}

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
      historyLabel: "Search history",
      clearLabel: "Clear history",
      expandLabel: "Expand",
      collapseLabel: "Collapse",
      ...overrides,
    };
    render(createElement(CommandCenterSearchHistory, props));
    return props;
  }

  it("分区标题使用 text-ui-sm", () => {
    renderHistory();
    const heading = screen.getByText("Search history");
    expect(heading.className).not.toContain("text-ui");
    // The title sits on a div container; walk up to the parent element to check it.
    const container = heading.parentElement;
    expect(container?.className ?? "").toContain("text-ui-sm");
  });

  it("历史 chip 搜索词使用 text-ui-base，scope 前缀保持 text-ui-xs", () => {
    renderHistory({
      entries: [makeEntry({ query: "login", scope: "commands" })],
    });

    const chip = getHistoryChipButton("login");
    expect(chip.className).toContain("text-ui-base");
    expect(chip.className).not.toContain("text-ui-xs");

    // The commands scope prefix is ">" and keeps text-ui-xs as a badge
    const prefix = chip.querySelector("span.font-mono");
    expect(prefix?.textContent).toBe(">");
    expect(prefix?.className).toContain("text-ui-xs");
  });

  it("点击历史 chip 触发 onPickEntry", () => {
    const onPickEntry = vi.fn();
    renderHistory({ onPickEntry });

    fireEvent.click(getHistoryChipButton("login"));
    expect(onPickEntry).toHaveBeenCalledOnce();
    const entry = onPickEntry.mock.calls[0]![0] as CommandCenterSearchHistoryEntry;
    expect(entry.query).toBe("login");
  });

  it("清除按钮触发 onClear", () => {
    const onClear = vi.fn();
    renderHistory({ onClear });

    fireEvent.click(screen.getByLabelText("Clear history"));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("条目超过 6 条时显示展开按钮，并触发 onToggleExpanded", () => {
    const onToggleExpanded = vi.fn();
    const entries = Array.from({ length: 7 }, (_, i) =>
      makeEntry({ query: `query-${i}`, updatedAt: 1700000000000 + i }),
    );
    renderHistory({ entries, onToggleExpanded });

    const expandBtn = screen.getByLabelText("Expand");
    fireEvent.click(expandBtn);
    expect(onToggleExpanded).toHaveBeenCalledOnce();
  });

  it("条目不超过 6 条时不显示展开按钮", () => {
    renderHistory();
    expect(screen.queryByLabelText("Expand")).toBeNull();
    expect(screen.queryByLabelText("Collapse")).toBeNull();
  });

  // CR-01: text-ui-base scales with --ui-font-size (12-20px), but the fixed height h-5 (20px
  // border-box) does not change. At a 20px font size, the content box is only 18px after
  // subtracting the 2px border, which cannot fit the line box of a 20px font; combined with the
  // outer overflow-hidden this clips the text vertically.
  // Scalable UI text must not be bound to a fixed height, same constraint as
  // uiFontTokenMigration.
  it("历史 chip 不用固定高度 h-5 限制可缩放的 text-ui-base", () => {
    renderHistory({
      entries: [makeEntry({ query: "login" })],
    });

    const chip = getHistoryChipButton("login");
    expect(chip).not.toBeNull();
    // Scalable text should use min-h + line height instead of a fixed h-5 (min-h-5 is allowed)
    expect(chip.className).not.toMatch(/(^| )h-5( |$)/);
    // min-h-5 is required so the height grows with the font size
    expect(chip.className).toContain("min-h-5");
    expect(chip.className).toContain("leading-none");
  });
});
