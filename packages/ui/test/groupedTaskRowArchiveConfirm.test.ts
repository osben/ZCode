// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { GroupedTaskRow } from "@/workspace-grouped-tasks/task-row.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) =>
        ({
          "common.close": "Close",
          "common.confirm": "Confirm",
          "taskList.archive": "Archive",
          "taskGroup.moveToTop": "Move to top",
          "taskList.justNow": "just now",
          "taskList.untitled": "New chat",
        })[id] ?? id,
    },
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => undefined,
}));

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
}));

const task: ZCodeTaskMeta = {
  taskId: "grouped-archive-task",
  traceId: "trace-grouped-archive-task",
  title: "Grouped archive",
  workspacePath: "/tmp/workspace-grouped-archive",
  createdAt: 1,
  updatedAt: 1,
  mode: "default",
  provider: "codex",
};

function renderRow() {
  const onCloseTask = vi.fn();
  const view = render(
    createElement(GroupedTaskRow, {
      task,
      groups: [],
      activeWorkspacePath: task.workspacePath,
      activeWorkspaceIdentity: undefined,
      activeTaskId: null,
      workspaceLabel: "workspace",
      onSelectTask: () => {},
      onCloseTask,
      onMoveTaskToGroup: () => {},
      onMoveTaskToTop: () => {},
      onStartRenameTask: () => {},
      onArchiveTask: () => {},
      onMarkTaskAsUnread: () => {},
      dragId: "grouped-archive-row",
    }),
  );
  const row = view.container.querySelector<HTMLElement>("[data-grouped-task-key]")!;
  fireEvent.mouseEnter(row);
  return { onCloseTask, row };
}

describe("GroupedTaskRow archive action", () => {
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
    vi.unstubAllGlobals();
  });

  it("labels the hover action Archive instead of Close", () => {
    renderRow();
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("archives only after the inline confirmation", () => {
    const { onCloseTask } = renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(onCloseTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onCloseTask).toHaveBeenCalledExactlyOnceWith(task);
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("keeps the confirmation visible after the pointer leaves the row", () => {
    const { row } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.mouseLeave(row);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });

  it("cancels the confirmation on Escape", () => {
    const { onCloseTask } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(onCloseTask).not.toHaveBeenCalled();
  });

  it("cancels the confirmation on a pointer-down outside the row", () => {
    const { onCloseTask } = renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(onCloseTask).not.toHaveBeenCalled();
  });
});
