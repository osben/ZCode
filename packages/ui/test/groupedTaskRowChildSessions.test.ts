// @vitest-environment jsdom
// Grouped-view side-chat navigation (spec: sidebar-child-conversation-counts.md §4, §7, §9): the
// side-chat capability reaches the sidebar onSelectTask contract, and a side-chat row's right-click
// opens its own menu instead of the parent row's.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { GroupedTaskRow } from "@/project-sidebar/grouped/task-row.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
      formatPlural: ({ id }: { id: string }) => id,
    },
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ useOptionalPlatform: () => undefined }));
vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (selector: (state: { openSubmit: () => void }) => unknown) =>
    selector({ openSubmit: vi.fn() }),
}));
vi.mock("@/useTaskListItemContextActions.js", () => ({
  useTaskListItemContextActions: () => ({
    taskSessionFile: { loading: false, path: null, exists: false },
    taskNativeSessionLogFile: { loading: false, path: null, exists: false },
    providerConfigFile: { loading: false, path: null, exists: false },
    fileManagerLabel: "Open in Finder",
    handleCopyText: async () => {},
    handleOpenTaskPathInFileManager: async () => {},
    handleOpenProviderConfig: async () => {},
  }),
  copyTextToClipboard: async () => {},
}));

const parent: ZCodeTaskMeta = {
  taskId: "grouped-parent",
  traceId: "trace-grouped-parent",
  title: "Parent",
  workspacePath: "/tmp/grouped-parent",
  workspaceIdentity: "remote:server:a:/tmp/grouped-parent",
  createdAt: 1,
  updatedAt: 1,
  mode: "default",
  sideChatCount: 1,
  childSessions: [
    {
      sessionId: "grouped-child",
      title: "Child",
      taskType: "selection_side_chat",
      lastActivityAt: 1,
      running: false,
    },
  ],
} as ZCodeTaskMeta;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("grouped child-session navigation", () => {
  function renderRow(onSelectTask = vi.fn()) {
    return render(
      createElement(
        TooltipProvider,
        null,
        createElement(GroupedTaskRow, {
          task: parent,
          groups: [],
          activeWorkspacePath: parent.workspacePath,
          activeTaskId: null,
          onSelectTask,
          onCloseTask: () => {},
          onMoveTaskToGroup: () => {},
          onMoveTaskToTop: () => {},
          onStartRenameTask: () => {},
          onArchiveTask: () => {},
          onMarkTaskAsUnread: () => {},
          dragId: "grouped-parent-row",
        }),
      ),
    );
  }

  it("passes the side-chat capability as the fourth onSelectTask argument", () => {
    const onSelectTask = vi.fn();
    const view = renderRow(onSelectTask);
    fireEvent.click(view.container.querySelector('[data-child-sessions-marker="true"]')!);
    fireEvent.click(view.container.querySelector('[data-child-session-id="grouped-child"]')!);
    expect(onSelectTask).toHaveBeenCalledTimes(1);
    expect(onSelectTask).toHaveBeenCalledWith(
      "/tmp/grouped-parent",
      "grouped-child",
      "remote:server:a:/tmp/grouped-parent",
      { selectionSideChat: true, parentTaskId: parent.taskId },
    );
  });

  it("right-click on a side-chat row opens its own menu, not the parent row's (§9.4)", async () => {
    const view = renderRow();
    fireEvent.click(view.container.querySelector('[data-child-sessions-marker="true"]')!);
    fireEvent.contextMenu(view.container.querySelector('[data-child-session-id="grouped-child"]')!);
    expect(await screen.findByText("common.open")).toBeTruthy();
    expect(screen.queryByText("taskList.archive")).toBeNull();
  });

  it("right-click on the parent row itself still opens the parent menu (control)", async () => {
    renderRow();
    fireEvent.contextMenu(screen.getByText("Parent"));
    expect(await screen.findByText("taskList.archive")).toBeTruthy();
  });

  it("phone rows (web remote control) render no child marker", () => {
    const view = render(
      createElement(
        ProjectTaskListContext.Provider,
        { value: { isWebRemoteControl: true } },
        createElement(
          TooltipProvider,
          null,
          createElement(GroupedTaskRow, {
            task: parent,
            groups: [],
            activeWorkspacePath: parent.workspacePath,
            activeTaskId: null,
            onSelectTask: vi.fn(),
            onCloseTask: () => {},
            onMoveTaskToGroup: () => {},
            onMoveTaskToTop: () => {},
            onStartRenameTask: () => {},
            onArchiveTask: () => {},
            onMarkTaskAsUnread: () => {},
            dragId: "grouped-parent-row",
          }),
        ),
      ),
    );
    expect(view.container.querySelector('[data-child-sessions-marker="true"]')).toBeNull();
  });

  it("the grouped view adapter forwards that capability to the sidebar contract", () => {
    // Source assertion (precedent: groupedOffPeakSystemGroup.test.ts): the adapter used to drop the
    // argument by re-calling onSelect with five positional arguments.
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/project-sidebar/TaskGroupedView.tsx"),
      "utf8",
    );
    expect(source).toMatch(/task\?\.unreadAt,\s*options,\s*\);/);
    // A child is not a grouped row: its remote session id comes from the owning parent.
    expect(source).toMatch(/taskId: options\?\.parentTaskId \?\? id,/);
  });
});
