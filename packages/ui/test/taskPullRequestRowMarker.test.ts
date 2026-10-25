// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import type { SessionPullRequest, SessionPullRequestStatus, ZCodeTaskMeta } from "@zcode/shared";
import { TaskPullRequestMarker } from "@/components/TaskPullRequestMarker.js";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        [id, ...Object.values(values ?? {})].join(" · "),
    },
  }),
}));

// Client rendering: zustand's server snapshot reads the initial state, so a
// static render would never observe seeded entries.
function renderMarkerHtml(task: ZCodeTaskMeta): string {
  const { container } = render(createElement(TaskPullRequestMarker, { task }));
  return container.innerHTML;
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
  taskId: "t1",
  workspacePath: "/w",
  executionWorktree: { path: "/wt/t1", branchName: "feat/x" },
} as ZCodeTaskMeta;

const ORDINARY_TASK = { taskId: "t2", workspacePath: "/w" } as ZCodeTaskMeta;

afterEach(() => {
  cleanup();
  usePullRequestStatusStore.getState().dropWorkspaceTasks("/w");
});

it("renders the primary stage glyph without a dot for a passing open pull request", () => {
  usePullRequestStatusStore
    .getState()
    .setWorkspacePullRequestStatuses("/w", { t1: makeStatus([makePullRequest()]) });
  const html = renderMarkerHtml(WORKTREE_TASK);
  expect(html).toContain("text-pr-open");
  expect(html).toContain("lucide-git-pull-request");
  expect(html).not.toContain("rounded-full", "passing keeps the row dot-free");
  expect(html).toContain("pullRequest.prLabel · 7");
  expect(html).toContain("pullRequest.stageOpen");
  expect(html).toContain('data-task-pr-stage="open"');
});

it("renders a destructive dot when required checks fail and a merged glyph for merged PRs", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    t1: makeStatus([makePullRequest({ stage: "merged", mergedAt: "2026-10-17T00:00:00Z" })]),
  });
  const mergedHtml = renderMarkerHtml(WORKTREE_TASK);
  expect(mergedHtml).toContain("text-pr-merged");
  expect(mergedHtml).toContain("lucide-git-merge");

  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    t1: makeStatus([makePullRequest({ checks: "failing", failingCheckCount: 2 })]),
  });
  const failingHtml = renderMarkerHtml(WORKTREE_TASK);
  expect(failingHtml).toContain("bg-destructive");
  expect(failingHtml).toContain("pullRequest.checksFailing · 2");
});

it("renders a warning dot for optional-only failing checks and appends the stale note", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    t1: makeStatus([makePullRequest({ checks: "optional_failing", failingCheckCount: 1 })], {
      stale: true,
    }),
  });
  const html = renderMarkerHtml(WORKTREE_TASK);
  expect(html).toContain("bg-warning");
  expect(html).toContain("pullRequest.checksOptionalFailing · 1");
  expect(html).toContain("pullRequest.stale");
});

it("renders nothing for ordinary sessions, missing entries, and unavailable status", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    t1: makeStatus([makePullRequest()]),
    t3: makeStatus([], { state: "unavailable", unavailableReason: "auth" }),
  });
  // Scenario 6: an ordinary session shows no PR anywhere even when a sibling
  // worktree task of the same workspace has one.
  expect(renderMarkerHtml(ORDINARY_TASK)).toBe("");
  // Never requested.
  expect(renderMarkerHtml({ ...WORKTREE_TASK, taskId: "unknown" } as ZCodeTaskMeta)).toBe("");
  // Scenario 7: gh missing/unauthenticated keeps the row icon-free.
  expect(renderMarkerHtml({ ...WORKTREE_TASK, taskId: "t3" } as ZCodeTaskMeta)).toBe("");
});
