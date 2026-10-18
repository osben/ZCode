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

function rowElement(rowTask: ZCodeTaskMeta, onCloseTask: (task: ZCodeTaskMeta) => void) {
  return createElement(GroupedTaskRow, {
    task: rowTask,
    groups: [],
    activeWorkspacePath: rowTask.workspacePath,
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
  });
}

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

  it("moves focus to Confirm when Archive is activated from the keyboard", () => {
    const { onCloseTask } = renderRow();
    const archive = screen.getByRole("button", { name: "Archive" });
    act(() => archive.focus());

    // A browser turns Enter on a focused button into a click on that button.
    fireEvent.click(archive);

    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(document.activeElement!);
    expect(onCloseTask).toHaveBeenCalledExactlyOnceWith(task);
  });

  it("does not move focus when Archive is clicked with the mouse", () => {
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Confirm" }));
  });

  it("clears an armed confirmation when a pending interaction hides the actions", () => {
    const onCloseTask = vi.fn();
    const view = render(rowElement(task, onCloseTask));
    fireEvent.mouseEnter(view.container.querySelector<HTMLElement>("[data-grouped-task-key]")!);
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();

    view.rerender(
      rowElement(
        { ...task, pendingInteraction: { interactionId: "ask", kind: "permission" } },
        onCloseTask,
      ),
    );
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();

    view.rerender(rowElement(task, onCloseTask));
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
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
