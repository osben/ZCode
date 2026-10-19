// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import type { SessionPullRequest, SessionPullRequestStatus } from "@zcode/shared";
import {
  ConversationStatusPanelPullRequests,
  PrimaryPullRequestTrailingIcon,
} from "@/v4/ConversationStatusPanelPullRequests.js";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";

const openExternal = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => ({ openExternal }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        [id, ...Object.values(values ?? {})].join(" · "),
    },
  }),
}));

vi.mock("@/lib/taskListItemPresentation.js", () => ({
  formatTaskRelativeTime: (timestampMs: number) => `rel:${Math.floor(timestampMs / 1000)}`,
}));

function makePullRequest(overrides: Partial<SessionPullRequest> = {}): SessionPullRequest {
  return {
    number: 7,
    url: "https://github.com/osben/ZCode/pull/7",
    title: "Add feature",
    repository: "osben/ZCode",
    headRefName: "feat/x",
    stage: "open",
    checks: "failing",
    failingCheckCount: 2,
    totalCheckCount: 4,
    hasConflict: false,
    reviewDecision: null,
    additions: 12,
    deletions: 3,
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

function renderGroup(hasWorktree = true, taskId = "task-1") {
  return render(
    createElement(ConversationStatusPanelPullRequests, {
      activeTaskId: taskId,
      hasWorktree: hasWorktree,
      workspacePath: "/w",
    }),
  ).container.innerHTML;
}

afterEach(() => {
  cleanup();
  openExternal.mockClear();
  usePullRequestStatusStore.getState().dropWorkspaceTasks("/w");
});

test("renders two-line pull request buttons with health on the right", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "task-1": makeStatus([makePullRequest()]),
  });
  const html = renderGroup();
  expect(html).toContain('data-status-panel-pull-requests="list"');
  expect(html).toContain("pullRequest.sectionTitle · 1");
  expect(html).toContain("Add feature");
  expect(html).toContain("osben/ZCode #7");
  expect(html).toContain("+12");
  expect(html).toContain("-3");
  expect(html).toContain("pullRequest.checksFailing · 2");
});

test("merged pull requests show the merged-relative line instead of diff stats", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "task-1": makeStatus([
      makePullRequest({
        stage: "merged",
        mergedAt: "2026-10-17T00:00:00Z",
        checks: "none",
        failingCheckCount: 0,
      }),
    ]),
  });
  const html = renderGroup();
  expect(html).toContain("pullRequest.mergedAgo · rel:");
  expect(html).not.toContain("+12");
});

test("worktree sessions show the muted unavailable line; ordinary sessions render nothing", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "task-1": makeStatus([], { state: "unavailable", unavailableReason: "no_gh" }),
  });
  expect(renderGroup()).toContain("pullRequest.unavailableNoGh");
  expect(renderGroup(false)).toBe("");
});

test("trailing icon renders the primary stage and nothing without pull requests", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "task-1": makeStatus([makePullRequest({ stage: "draft" })]),
  });
  const withPrimary = render(
    createElement(PrimaryPullRequestTrailingIcon, { activeTaskId: "task-1", workspacePath: "/w" }),
  ).container.innerHTML;
  expect(withPrimary).toContain("text-pr-draft");
  expect(withPrimary).toContain('data-status-panel-pull-request-trailing="draft"');

  expect(
    render(
      createElement(PrimaryPullRequestTrailingIcon, {
        activeTaskId: "missing",
        workspacePath: "/w",
      }),
    ).container.innerHTML,
  ).toBe("");
});
