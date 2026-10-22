// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPullRequest, SessionPullRequestStatus, ZCodeTaskMeta } from "@zcode/shared";
import { GroupedTaskRow } from "@/project-sidebar/grouped/task-row.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";
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
        })[id] ??
        // Other copy comes from the en-US catalog so assertions follow the translation ledger.
        (enUS[id] === undefined ? id : expectedCopy(id, values)),
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

// Upstream rows rely on an ambient TooltipProvider (the app shell mounts one); mirror that here.
function withTooltipProvider(child: ReturnType<typeof createElement>) {
  return createElement(TooltipProvider, null, child);
}

function rowElement(rowTask: ZCodeTaskMeta, onCloseTask: (task: ZCodeTaskMeta) => void) {
  return withTooltipProvider(
    createElement(GroupedTaskRow, {
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
    }),
  );
}

function renderRow() {
  const onCloseTask = vi.fn();
  const view = render(
    withTooltipProvider(
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
    ),
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

const PR_WORKSPACE_PATH = "/tmp/workspace-grouped-archive";

function makePullRequest(overrides: Partial<SessionPullRequest> = {}): SessionPullRequest {
  return {
    number: 7,
    url: "https://github.com/osben/ZCode/pull/7",
    title: "Example",
    repository: "osben/ZCode",
    headRefName: "feat/grouped",
    stage: "open",
    checks: "passing",
    failingCheckCount: 0,
    totalCheckCount: 1,
    hasConflict: false,
    reviewDecision: null,
    additions: 1,
    deletions: 1,
    updatedAt: "2026-10-18T10:00:00Z",
    mergedAt: null,
    ...overrides,
  };
}

function makeStatus(pullRequests: SessionPullRequest[]): SessionPullRequestStatus {
  return {
    state: "ready",
    unavailableReason: null,
    source: "branch",
    pullRequests,
    primaryNumber: pullRequests[0]?.number ?? null,
    fetchedAt: "2026-10-18T10:00:01Z",
    stale: false,
  };
}

const worktreeTask = {
  ...task,
  taskId: "grouped-pr-task",
  traceId: "trace-grouped-pr-task",
  executionWorktree: { path: "/tmp/wt-grouped", branchName: "feat/grouped" },
} as ZCodeTaskMeta;

function renderGroupedRow(rowTask: ZCodeTaskMeta) {
  const view = render(rowElement(rowTask, vi.fn()));
  const row = view.container.querySelector<HTMLElement>("[data-grouped-task-key]")!;
  return { ...view, row };
}

describe("GroupedTaskRow hover card and pull request menu", () => {
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
    usePullRequestStatusStore.getState().dropWorkspaceTasks(PR_WORKSPACE_PATH);
    vi.unstubAllGlobals();
  });

  it("shows the task hover card with title and worktree branch when the row is focused", () => {
    const { row } = renderGroupedRow(worktreeTask);
    act(() => row.focus());

    const card = document.querySelector<HTMLElement>('[data-task-hover-card="true"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("Grouped archive");
    expect(card!.textContent).toContain("feat/grouped");
  });

  it("lists the task's pull requests in the hover card", () => {
    usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses(PR_WORKSPACE_PATH, {
      [worktreeTask.taskId]: makeStatus([makePullRequest()]),
    });
    const { row } = renderGroupedRow(worktreeTask);
    act(() => row.focus());

    const card = document.querySelector<HTMLElement>('[data-task-hover-card="true"]');
    expect(card?.querySelector('[data-task-hover-pr="list"]')).not.toBeNull();
    expect(card!.textContent).toContain("#7");
  });

  it("offers pull request items in the grouped context menu for worktree tasks", () => {
    usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses(PR_WORKSPACE_PATH, {
      [worktreeTask.taskId]: makeStatus([makePullRequest()]),
    });
    const { row } = renderGroupedRow(worktreeTask);
    fireEvent.contextMenu(row);

    expect(
      screen.getByRole("menuitem", { name: expectedCopy("pullRequest.open", { number: 7 }) }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: expectedCopy("pullRequest.copyLink") }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: expectedCopy("pullRequest.refresh") }),
    ).toBeTruthy();
  });

  it("omits pull request items from the grouped context menu for ordinary tasks", () => {
    usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses(PR_WORKSPACE_PATH, {
      [task.taskId]: makeStatus([makePullRequest()]),
    });
    const { row } = renderGroupedRow(task);
    fireEvent.contextMenu(row);

    expect(
      screen.getByRole("menuitem", { name: expectedCopy("taskList.markAsUnread") }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: expectedCopy("pullRequest.copyLink") }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: expectedCopy("pullRequest.refresh") }),
    ).toBeNull();
  });
});
