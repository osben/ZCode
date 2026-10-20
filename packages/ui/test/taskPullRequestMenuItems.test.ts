// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { SessionPullRequest, SessionPullRequestStatus, ZCodeTaskMeta } from "@zcode/shared";
import { TaskPullRequestMenuItems } from "@/components/TaskPullRequestMenuItems.js";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";

const openExternal = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ openExternal }),
}));

const INTL = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
    [id, ...Object.values(values ?? {})].join(" · "),
};

function MenuItemStub({
  children,
  onSelect,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
}) {
  return createElement(
    "button",
    { type: "button", disabled, onClick: onSelect, "data-menu-item": "true" },
    children,
  );
}

function SeparatorStub() {
  return createElement("div", { "data-menu-separator": "true" });
}

function makePullRequest(overrides: Partial<SessionPullRequest> = {}): SessionPullRequest {
  return {
    number: 7,
    url: "https://github.com/osben/ZCode/pull/7",
    title: "Example",
    repository: "osben/ZCode",
    headRefName: "feat/x",
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

function makeStatus(
  pullRequests: SessionPullRequest[],
  overrides: Partial<SessionPullRequestStatus> = {},
): SessionPullRequestStatus {
  return {
    state: "ready",
    unavailableReason: null,
    source: "branch",
    pullRequests,
    primaryNumber: pullRequests[0]?.number ?? null,
    fetchedAt: "2026-10-18T10:00:01Z",
    stale: false,
    ...overrides,
  };
}

const WORKTREE_TASK = {
  taskId: "menu-task",
  workspacePath: "/w",
  executionWorktree: { path: "/wt", branchName: "feat/x" },
} as ZCodeTaskMeta;

function renderMenu(task: ZCodeTaskMeta = WORKTREE_TASK) {
  const onCopyText = vi.fn();
  const utils = render(
    createElement(TaskPullRequestMenuItems, {
      task,
      intl: INTL,
      Item: MenuItemStub,
      Separator: SeparatorStub,
      onCopyText,
    }),
  );
  return { ...utils, onCopyText };
}

function itemLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-menu-item]")].map((node) => node.textContent ?? "");
}

afterEach(() => {
  cleanup();
  openExternal.mockClear();
  usePullRequestStatusStore.getState().dropWorkspaceTasks("/w");
});

test("offers one Open item per pull request (max 3), copy link, and refresh", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "menu-task": makeStatus([
      makePullRequest(),
      makePullRequest({ number: 8 }),
      makePullRequest({ number: 9 }),
      makePullRequest({ number: 10 }),
    ]),
  });
  const { container } = renderMenu();
  const labels = itemLabels(container);
  expect(labels).toEqual([
    "pullRequest.open · 7",
    "pullRequest.open · 8",
    "pullRequest.open · 9",
    "pullRequest.copyLink",
    "pullRequest.refresh",
  ]);
});

test("open uses the platform external opener; copy uses the primary link; refresh forces the task", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "menu-task": makeStatus([makePullRequest()]),
  });
  const { container, onCopyText } = renderMenu();
  const [openItem, copyItem, refreshItem] = [
    ...container.querySelectorAll("[data-menu-item]"),
  ] as HTMLElement[];

  fireEvent.click(openItem!);
  expect(openExternal).toHaveBeenCalledWith("https://github.com/osben/ZCode/pull/7");

  fireEvent.click(copyItem!);
  expect(onCopyText).toHaveBeenCalledWith(
    "pullRequest.copyLink",
    "https://github.com/osben/ZCode/pull/7",
  );

  const before = usePullRequestStatusStore.getState().forceRefresh.version;
  fireEvent.click(refreshItem!);
  const forceRefresh = usePullRequestStatusStore.getState().forceRefresh;
  expect(forceRefresh.version).toBe(before + 1);
  expect(forceRefresh.taskKeys).toEqual(["/w::menu-task"]);
});

test("renders refresh only when there are no pull requests yet", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "menu-task": makeStatus([]),
  });
  const { container } = renderMenu();
  expect(itemLabels(container)).toEqual(["pullRequest.refresh"]);
});

test("renders nothing for ordinary sessions", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "menu-task": makeStatus([makePullRequest()]),
  });
  const { container } = renderMenu({ ...WORKTREE_TASK, executionWorktree: undefined });
  expect(container.innerHTML).toBe("");
});
