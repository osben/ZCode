// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { GroupedTaskRow } from "@/project-sidebar/grouped/task-row.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { TASK_LIST_ROW_ACTIVITY_FIELD } from "@/v4/taskListRowActivity.js";
import enUS from "@/i18n/locales/en-US.js";
import { expectedCopy } from "./helpers/uiCopy.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        ({
          "common.close": "Close",
          "common.confirm": "Confirm",
          "taskList.archive": "Archive",
          "taskGroup.moveToTop": "Move to top",
          "taskList.justNow": "just now",
          "taskList.untitled": "New chat",
        })[id] ?? (enUS[id] === undefined ? id : expectedCopy(id, values)),
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

const baseTask: ZCodeTaskMeta = {
  taskId: "grouped-status-task",
  traceId: "trace-grouped-status-task",
  title: "Grouped status",
  workspacePath: "/tmp/workspace-grouped-status",
  createdAt: 1,
  updatedAt: 1,
  mode: "default",
  provider: "codex",
};

function renderGroupedRow(task: ZCodeTaskMeta) {
  const view = render(
    createElement(
      TooltipProvider,
      null,
      createElement(GroupedTaskRow, {
        task,
        groups: [],
        activeWorkspacePath: task.workspacePath,
        activeWorkspaceIdentity: undefined,
        activeTaskId: null,
        onSelectTask: () => {},
        onCloseTask: () => {},
        onMoveTaskToGroup: () => {},
        onMoveTaskToTop: () => {},
        onStartRenameTask: () => {},
        onArchiveTask: () => {},
        onMarkTaskAsUnread: () => {},
        dragId: "grouped-status-row",
      }),
    ),
  );
  const row = view.container.querySelector<HTMLElement>("[data-grouped-task-key]")!;
  return { row, container: view.container };
}

// Returns the closest status wrapper: a hidden ancestor (class "hidden") means the indicator is not visible.
function hasHiddenAncestor(node: Element): boolean {
  return node.closest(".hidden") !== null;
}

describe("GroupedTaskRow run-state indicator on hover and focus", () => {
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

  it("keeps the unread dot visible beside the actions on hover", () => {
    const { row, container } = renderGroupedRow({ ...baseTask, unreadAt: 2 });
    fireEvent.mouseEnter(row);

    const dot = container.querySelector<HTMLElement>("[data-unread-indicator]");
    expect(dot).not.toBeNull();
    expect(hasHiddenAncestor(dot!)).toBe(false);
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  });

  it("keeps the error dot visible beside the actions on hover", () => {
    const { row, container } = renderGroupedRow({ ...baseTask, status: "error" });
    fireEvent.mouseEnter(row);

    const dot = container.querySelector<HTMLElement>("[data-error-indicator]");
    expect(dot).not.toBeNull();
    expect(hasHiddenAncestor(dot!)).toBe(false);
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  });

  it("keeps the running spinner visible beside the actions on focus", () => {
    const { row, container } = renderGroupedRow({
      ...baseTask,
      [TASK_LIST_ROW_ACTIVITY_FIELD]: {
        phase: "running",
        lastActivityAt: 1,
        hasBackgroundWork: false,
      },
    });
    fireEvent.focus(row);

    const spinner = container.querySelector<HTMLElement>(".animate-spin");
    expect(spinner).not.toBeNull();
    expect(hasHiddenAncestor(spinner!)).toBe(false);
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  });
});
