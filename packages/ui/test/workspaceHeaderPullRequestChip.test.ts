// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { SessionPullRequest, SessionPullRequestStatus, ZCodeTaskMeta } from "@zcode/shared";
import { WorkspaceHeaderPullRequestChip } from "@/WorkspaceHeaderPullRequestChip.js";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";

const openExternal = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ openExternal }),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: React.ReactNode }) =>
    createElement("span", null, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        [id, ...Object.values(values ?? {})].join(" · "),
    },
  }),
}));

function makePullRequest(overrides: Partial<SessionPullRequest> = {}): SessionPullRequest {
  return {
    number: 7,
    url: "https://github.com/osben/ZCode/pull/7",
    title: "Example",
    repository: "osben/ZCode",
    headRefName: "feat/x",
    stage: "open",
    checks: "failing",
    failingCheckCount: 1,
    totalCheckCount: 2,
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

const WORKTREE_TASK = {
  taskId: "header-task",
  workspacePath: "/w",
  executionWorktree: { path: "/wt", branchName: "feat/x" },
} as ZCodeTaskMeta;

afterEach(() => {
  cleanup();
  openExternal.mockClear();
  usePullRequestStatusStore.getState().dropWorkspaceTasks("/w");
});

test("shows the primary number with the health dot and opens the pull request", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "header-task": makeStatus([makePullRequest()]),
  });
  const { container } = render(
    createElement(WorkspaceHeaderPullRequestChip, { task: WORKTREE_TASK }),
  );
  const html = container.innerHTML;
  expect(html).toContain('data-workspace-header-pull-request="7"');
  expect(html).toContain("#7");
  expect(html).toContain("bg-destructive");
  expect(html).toContain("pullRequest.checksFailing · 1");

  fireEvent.click(container.querySelector("button")!);
  expect(openExternal).toHaveBeenCalledWith("https://github.com/osben/ZCode/pull/7");
});

test("renders nothing without a worktree, without pull requests, or for unavailable status", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "header-task": makeStatus([makePullRequest()]),
    unavailable: {
      state: "unavailable",
      unavailableReason: "auth",
      source: "branch",
      pullRequests: [],
      primaryNumber: null,
      fetchedAt: null,
      stale: false,
    },
  });
  expect(
    render(createElement(WorkspaceHeaderPullRequestChip, { task: null })).container.innerHTML,
  ).toBe("");
  expect(
    render(
      createElement(WorkspaceHeaderPullRequestChip, {
        task: { ...WORKTREE_TASK, executionWorktree: undefined },
      }),
    ).container.innerHTML,
  ).toBe("");
  expect(
    render(
      createElement(WorkspaceHeaderPullRequestChip, {
        task: { ...WORKTREE_TASK, taskId: "unavailable" },
      }),
    ).container.innerHTML,
  ).toBe("");
});
