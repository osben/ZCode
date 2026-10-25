// @vitest-environment jsdom
// ISSUE-032: the grouped "Move to group" submenu must show localized titles for system groups.
import type { ReactNode } from "react";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRON_DEFAULT_GROUP_ID, OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";
import enUS from "@/i18n/locales/en-US.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { GroupedTaskContextMenuContent } from "@/project-sidebar/grouped/task-context-menu-content.js";

vi.mock("@/components/ui/context-menu.js", () => {
  const box =
    (tag: string) =>
    ({ children, onSelect: _onSelect, ...rest }: { children?: ReactNode; onSelect?: unknown }) =>
      createElement(tag, rest, children);
  return {
    ContextMenuContent: box("div"),
    ContextMenuItem: box("div"),
    ContextMenuSeparator: box("hr"),
    ContextMenuSub: box("div"),
    ContextMenuSubContent: box("div"),
    ContextMenuSubTrigger: box("div"),
  };
});
vi.mock("@/ControlHintTooltip.js", () => ({
  SidebarNativeTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/TaskPullRequestMenuItems.js", () => ({
  TaskPullRequestMenuItems: () => createElement("div", { "data-pr-section": "" }),
}));

afterEach(cleanup);

describe("grouped task context menu: Move to group titles", () => {
  it("localizes system group titles and keeps custom titles", () => {
    const noop = () => {};
    const { container } = render(
      createElement(GroupedTaskContextMenuContent, {
        task: { taskId: "t1", workspacePath: "/w" } as unknown as ProjectTask,
        groups: [
          { id: CRON_DEFAULT_GROUP_ID, title: "cron", color: "blue" },
          { id: OFF_PEAK_DEFAULT_GROUP_ID, title: "off-peak", color: "purple" },
          { id: "custom", title: "My Group", color: "gray" },
        ],
        intl: { formatMessage: ({ id }: { id: string }) => enUS[id] ?? id },
        fileManagerLabel: "Finder",
        taskSessionFile: { loading: false, path: null, exists: false },
        taskNativeSessionLogFile: { loading: false, path: null },
        providerConfigFile: { loading: false, path: null },
        onMoveTaskToGroup: noop,
        onMoveTaskToTop: noop,
        onStartRenameTask: noop,
        onArchiveTask: noop,
        onMarkTaskAsUnread: noop,
        onOpenTaskPathInFileManager: noop,
        onCopyText: noop,
        onOpenProviderConfig: noop,
        onOpenTaskFeedback: noop,
      }),
    );
    const label = (id: string) =>
      container.querySelector(`[data-task-group-target="${id}"]`)?.textContent;
    expect(label(CRON_DEFAULT_GROUP_ID)).toBe("Scheduled tasks");
    expect(label(OFF_PEAK_DEFAULT_GROUP_ID)).toBe("Idle-time tasks");
    expect(label("custom")).toBe("My Group");
  });
});

describe("grouped task context menu: structure", () => {
  it("renders the pull request section once, after the Copy submenu", () => {
    const noop = () => {};
    const { container } = render(
      createElement(GroupedTaskContextMenuContent, {
        task: { taskId: "t1", workspacePath: "/w" } as unknown as ProjectTask,
        groups: [],
        intl: { formatMessage: ({ id }: { id: string }) => enUS[id] ?? id },
        fileManagerLabel: "Finder",
        canOpenInFileManager: true,
        taskSessionFile: { loading: false, path: null, exists: false },
        taskNativeSessionLogFile: { loading: false, path: null },
        providerConfigFile: { loading: false, path: null },
        onMoveTaskToGroup: noop,
        onMoveTaskToTop: noop,
        onStartRenameTask: noop,
        onArchiveTask: noop,
        onMarkTaskAsUnread: noop,
        onOpenTaskPathInFileManager: noop,
        onCopyText: noop,
        onOpenProviderConfig: noop,
        onOpenTaskFeedback: noop,
      }),
    );
    const sections = container.querySelectorAll("[data-pr-section]");
    expect(sections).toHaveLength(1);
    const text = container.textContent ?? "";
    expect(text.indexOf("Copy")).toBeGreaterThan(-1);
    expect(text.indexOf("Report issue")).toBeGreaterThan(text.indexOf("Copy session ID"));
    expect(text.lastIndexOf("Archive")).toBeGreaterThan(text.indexOf("Report issue"));
    const copyTrigger = [...container.querySelectorAll("div")].find(
      (el) => el.children.length === 0 && el.textContent === "Copy",
    );
    expect(
      copyTrigger &&
        (copyTrigger.compareDocumentPosition(sections[0]!) & Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    ).toBe(true);
  });
});
