// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_ARCHIVE, testId } from "@zcode/shared/test-ids";
import { MemoTaskItem } from "@/TaskListItem.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

vi.mock("@/useTaskListItemContextActions.js", () => ({
  useTaskListItemContextActions: () => ({
    fileManagerLabel: "Finder",
    handleCopyText: vi.fn(),
    handleOpenProviderConfig: vi.fn(),
    handleOpenTaskPathInFileManager: vi.fn(),
    providerConfigFile: { exists: false, loading: false, path: null },
    taskNativeSessionLogFile: { exists: false, loading: false, path: null },
    taskSessionFile: { exists: false, loading: false, path: null },
  }),
}));

vi.mock("@/TaskListItemContextMenu.js", () => ({
  TaskListItemContextMenu: () => null,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => null,
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (selector: (state: { openSubmit: () => void }) => unknown) =>
    selector({ openSubmit: vi.fn() }),
}));

vi.mock("@/store/modelTrajectoryStore.js", () => ({
  useModelTrajectoryStore: { getState: () => ({ requestOpen: vi.fn() }) },
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: () => {},
}));

const stableIntl = {
  formatMessage: ({ id }: { id: string }) => id,
};

const baseTask: ZCodeTaskMeta = {
  createdAt: 1,
  mode: "default",
  provider: "codex",
  taskId: "task-1",
  title: "Task 1",
  traceId: "trace-1",
  updatedAt: 2,
  workspacePath: "/workspace",
};

function renderItem(overrides: Partial<Parameters<typeof MemoTaskItem>[0]> = {}) {
  const props = {
    intl: stableIntl,
    isActive: false,
    isArchiveConfirming: false,
    isPinned: false,
    onArchiveTask: vi.fn(),
    onArchiveTaskInline: vi.fn(),
    onCancelArchiveConfirm: vi.fn(),
    onMarkTaskAsUnread: vi.fn(),
    onSelectTask: vi.fn(),
    onStartRenameTask: vi.fn(),
    onTogglePinTask: vi.fn(),
    task: baseTask,
    workspacePath: "/workspace",
    ...overrides,
  };
  // The app shell mounts an ambient TooltipProvider; the row's action tooltips need one here too.
  const view = render(createElement(TooltipProvider, null, createElement(MemoTaskItem, props)));
  const row = view.container.querySelector<HTMLElement>("[data-task-item-key]")!;
  return { ...view, row, props };
}

describe("TaskListItem Pin placement with a run state", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps Archive in the same action cluster as Pin while a run state is shown", () => {
    const { row } = renderItem({ task: { ...baseTask, unreadAt: 2 } });
    fireEvent.mouseEnter(row);

    const pin = screen.getByRole("button", { name: "taskList.pin" });
    const archive = document.querySelector<HTMLElement>(
      `[data-testid="${testId(TID_TASK_ARCHIVE, baseTask.taskId)}"]`,
    );
    expect(archive).not.toBeNull();
    const cluster = pin.closest("[data-task-row-actions]");
    expect(cluster).not.toBeNull();
    expect(archive?.closest("[data-task-row-actions]")).toBe(cluster);
  });

  it("keeps Pin in the action cluster on touch devices without hover", () => {
    // Touch devices keep the action cluster mounted, so Pin must be reachable without a hover event.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }),
    });
    try {
      renderItem({ task: { ...baseTask, unreadAt: 2 } });
      const pin = screen.getByRole("button", { name: "taskList.pin" });
      expect(pin.closest("[data-task-row-actions]")).not.toBeNull();
    } finally {
      Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it("keeps a pinned task with no run state on the left-slot Pin during hover", () => {
    const { row } = renderItem({ isPinned: true });
    fireEvent.mouseEnter(row);

    const pin = screen.getByRole("button", { name: "taskList.unpin" });
    expect(pin.closest("[data-task-row-actions]")).toBeNull();
    expect(pin.closest(".hidden")).toBeNull();
  });

  it("moves keyboard focus to the row when a focused Pin is remounted by a run-state change", () => {
    const { row, rerender, props } = renderItem({ task: { ...baseTask, unreadAt: 2 } });
    fireEvent.mouseEnter(row);

    const pin = screen.getByRole("button", { name: "taskList.pin" });
    pin.focus();
    expect(document.activeElement).toBe(pin);

    // The run state clears, so Pin moves from the action cluster to the left slot and remounts.
    rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(MemoTaskItem, { ...props, task: { ...baseTask, unreadAt: undefined } }),
      ),
    );

    expect(screen.getByRole("button", { name: "taskList.pin" })).not.toBe(pin);
    expect(document.activeElement).toBe(row);
  });
});
