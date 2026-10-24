// @vitest-environment jsdom
// Grouped-view child navigation (spec: sidebar-child-conversation-counts.md §4, §7): the child
// capability reaches the sidebar onSelectTask contract, so a subagent opens read-only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
  subagentCount: 1,
  childSessions: [
    {
      sessionId: "grouped-child",
      title: "Child",
      taskType: "subagent_child",
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
  it("passes the subagent read-only capability as the fourth onSelectTask argument", () => {
    const onSelectTask = vi.fn();
    const view = render(
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
    fireEvent.click(view.container.querySelector('[data-child-sessions-marker="true"]')!);
    fireEvent.click(view.container.querySelector('[data-child-session-id="grouped-child"]')!);
    expect(onSelectTask).toHaveBeenCalledTimes(1);
    expect(onSelectTask).toHaveBeenCalledWith(
      "/tmp/grouped-parent",
      "grouped-child",
      "remote:server:a:/tmp/grouped-parent",
      { readOnly: true, selectionSideChat: false, parentTaskId: parent.taskId },
    );
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
