// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { GroupedTaskRow } from "@/project-sidebar/grouped/task-row.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) =>
        ({
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
  taskId: "grouped-overlay-task",
  traceId: "trace-grouped-overlay-task",
  title: "Grouped overlay",
  workspacePath: "/tmp/workspace-grouped-overlay",
  createdAt: 1,
  updatedAt: 1,
  mode: "default",
  provider: "codex",
};

function rowElement(dragOverlay: boolean) {
  return createElement(
    TooltipProvider,
    null,
    createElement(GroupedTaskRow, {
      task,
      groups: [],
      activeWorkspacePath: task.workspacePath,
      activeWorkspaceIdentity: undefined,
      activeTaskId: task.taskId,
      workspaceLabel: "workspace",
      onSelectTask: () => {},
      onCloseTask: () => {},
      onMoveTaskToGroup: () => {},
      onMoveTaskToTop: () => {},
      onStartRenameTask: () => {},
      onArchiveTask: () => {},
      onMarkTaskAsUnread: () => {},
      dragId: "grouped-overlay-row",
      dragOverlay,
    }),
  );
}

function interactiveRow(container: HTMLElement) {
  return container.querySelector<HTMLElement>("[data-grouped-task-key]");
}

describe("GroupedTaskRow drag overlay", () => {
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

  it("renders the overlay as a non-interactive presentation row", () => {
    const view = render(rowElement(true));

    expect(view.container.textContent).toContain("Grouped overlay");
    expect(interactiveRow(view.container)).toBeNull();
    expect(view.container.querySelector('[role="button"]')).toBeNull();
    const overlayRow = view.container.querySelector<HTMLElement>(".group\\/task-row")!;
    expect(overlayRow.className).toContain("pointer-events-none");
    expect(overlayRow.className).toContain("bg-selected");
  });

  it("renders the normal row as an interactive drag source", () => {
    const view = render(rowElement(false));

    const row = interactiveRow(view.container)!;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.className).not.toContain("pointer-events-none");
    expect(view.container.textContent).toContain("Grouped overlay");
  });

  it("keeps a stable hook order when one instance toggles dragOverlay", () => {
    const view = render(rowElement(false));
    expect(interactiveRow(view.container)).not.toBeNull();

    // Both directions used to change the hook count of a single component and make React throw.
    expect(() => view.rerender(rowElement(true))).not.toThrow();
    expect(interactiveRow(view.container)).toBeNull();

    expect(() => view.rerender(rowElement(false))).not.toThrow();
    expect(interactiveRow(view.container)).not.toBeNull();
  });
});
