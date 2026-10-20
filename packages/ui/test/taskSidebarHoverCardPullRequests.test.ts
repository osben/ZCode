// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import type { SessionPullRequest, SessionPullRequestStatus, ZCodeTaskMeta } from "@zcode/shared";
import { TaskSidebarHoverCard } from "@/components/TaskSidebarHoverCard.js";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";

vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/components/WorktreeTaskMarker.js", () => ({
  WorktreeTaskMarker: () => createElement("span", null, "worktree-marker"),
}));

vi.mock("@/components/IncognitoTaskMarker.js", () => ({
  IncognitoTaskMarker: () => null,
}));

const INTL = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
    [id, ...Object.values(values ?? {})].join(" · "),
};

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
    totalCheckCount: 2,
    hasConflict: false,
    reviewDecision: null,
    additions: 3,
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
  taskId: "hover-task",
  traceId: "trace",
  title: "Hover",
  workspacePath: "/w",
  createdAt: 1,
  updatedAt: Date.now(),
  mode: "default",
  executionWorktree: { path: "/wt", branchName: "feat/x" },
} as ZCodeTaskMeta;

function renderCardHtml(task: ZCodeTaskMeta = WORKTREE_TASK): string {
  const { container } = render(
    createElement(TaskSidebarHoverCard, {
      task,
      attentionLabel: null,
      activity: { phase: "completedSuccess", lastActivityAt: Date.now(), hasBackgroundWork: false },
      intl: INTL,
    }),
  );
  return container.innerHTML;
}

afterEach(() => {
  cleanup();
  usePullRequestStatusStore.getState().dropWorkspaceTasks("/w");
});

test("lists pull requests with the open one first and health text right-aligned", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "hover-task": makeStatus([
      makePullRequest({ checks: "failing", failingCheckCount: 1 }),
      makePullRequest({
        number: 3,
        stage: "merged",
        mergedAt: "2026-10-17T00:00:00Z",
        updatedAt: "2026-10-17T00:00:00Z",
      }),
    ]),
  });
  const html = renderCardHtml();
  expect(html).toContain('data-task-hover-pr="list"');
  expect(html).toContain("pullRequest.stageOpen");
  expect(html).toContain("pullRequest.stageMerged");
  expect(html).toContain("pullRequest.checksFailing · 1");
  expect(html.indexOf("#7")).toBeLessThan(html.indexOf("#3"), "open PR line precedes merged");
});

test("caps at three lines with a more-count and shows the primary review decision", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "hover-task": makeStatus(
      Array.from({ length: 5 }, (_, index) => makePullRequest({ number: index + 1 })),
      { primaryNumber: 1 },
    ),
  });
  const html = renderCardHtml();
  expect(html.match(/#(\d+)/g)?.length).toBe(3);
  expect(html).toContain("pullRequest.moreCount · 2");
});

test("the review line follows the primary pull request in a multi-PR list", () => {
  // The primary is the first item (sorted by the service). A second PR with the same number from
  // another repository must not be picked, because PR numbers are unique only per repository.
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "hover-task": makeStatus(
      [
        makePullRequest({ number: 7, repository: "osben/ZCode", reviewDecision: "approved" }),
        makePullRequest({
          number: 7,
          repository: "upstream/ZCode",
          stage: "open",
          reviewDecision: "changes_requested",
          updatedAt: "2026-10-17T00:00:00Z",
        }),
        makePullRequest({
          number: 3,
          stage: "merged",
          mergedAt: "2026-10-16T00:00:00Z",
          updatedAt: "2026-10-16T00:00:00Z",
          reviewDecision: "changes_requested",
        }),
      ],
      { primaryNumber: 7 },
    ),
  });
  const html = renderCardHtml();
  expect(html).toContain("pullRequest.approved");
  expect(html).not.toContain("pullRequest.changesRequested");
});

test("shows the review line for the primary and the stale note during backoff", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "hover-task": makeStatus([makePullRequest({ reviewDecision: "changes_requested" })], {
      stale: true,
    }),
  });
  const html = renderCardHtml();
  expect(html).toContain("pullRequest.changesRequested");
  expect(html).toContain("pullRequest.stale");
});

test("worktree sessions show the muted unavailable line; ordinary sessions show nothing", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "hover-task": makeStatus([], { state: "unavailable", unavailableReason: "auth" }),
    ordinary: makeStatus([makePullRequest()]),
  });
  const worktreeHtml = renderCardHtml();
  expect(worktreeHtml).toContain('data-task-hover-pr="unavailable"');
  expect(worktreeHtml).toContain("pullRequest.unavailableAuth");

  const ordinary = { ...WORKTREE_TASK, taskId: "ordinary", executionWorktree: undefined };
  const ordinaryHtml = renderCardHtml(ordinary);
  expect(ordinaryHtml).not.toContain("data-task-hover-pr");
  expect(ordinaryHtml).not.toContain("#7");
});
