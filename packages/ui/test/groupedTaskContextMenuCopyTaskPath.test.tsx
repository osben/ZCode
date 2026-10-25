// @vitest-environment jsdom
// Copy task path is shown only when the session snapshot file exists (diverges from upstream 0a1fc56d).
import type { ReactNode } from "react";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  TaskPullRequestMenuItems: () => null,
}));

afterEach(cleanup);

function renderMenu(
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean },
  canOpenInFileManager = true,
) {
  const noop = () => {};
  return render(
    createElement(GroupedTaskContextMenuContent, {
      task: { taskId: "t1", workspacePath: "/w" } as unknown as ProjectTask,
      groups: [],
      intl: { formatMessage: ({ id }: { id: string }) => enUS[id] ?? id },
      fileManagerLabel: "Finder",
      canOpenInFileManager,
      taskSessionFile,
      taskNativeSessionLogFile: { loading: false, path: null, exists: false },
      providerConfigFile: { loading: false, path: null, exists: false },
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
}

const copyTaskPathLabel = enUS["appHeader.copyTaskPath"];

describe("grouped task context menu: Copy task path", () => {
  it("hides Copy task path when the session snapshot file does not exist", () => {
    const { container } = renderMenu({
      loading: false,
      path: "/w/t1.zcode-session",
      exists: false,
    });

    expect(container.textContent).not.toContain(copyTaskPathLabel);
  });

  it("hides Copy task path while the snapshot path is still resolving", () => {
    const { container } = renderMenu({ loading: true, path: null, exists: false });

    expect(container.textContent).not.toContain(copyTaskPathLabel);
  });

  it("shows Copy task path when the session snapshot file exists", () => {
    const { container } = renderMenu({
      loading: false,
      path: "/w/t1.zcode-session",
      exists: true,
    });

    expect(container.textContent).toContain(copyTaskPathLabel);
  });

  // ISSUE-066: on web the item was shown and silently failed ("Not supported in web mode").
  it("hides the file manager and provider config items when the platform cannot open local files", () => {
    const file = { loading: false, path: "/w/t1.zcode-session", exists: true };
    const shown = renderMenu(file).container.textContent;
    cleanup();
    const hidden = renderMenu(file, false).container.textContent;

    expect(shown).toContain("Finder");
    expect(shown).toContain(enUS["appHeader.goToProviderConfig"]);
    expect(hidden).not.toContain("Finder");
    expect(hidden).not.toContain(enUS["appHeader.goToProviderConfig"]);
    expect(hidden).toContain(enUS["appHeader.copyPath"]);
  });
});
