// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import type { SessionPullRequest, SessionPullRequestStatus } from "@zcode/shared";
import { PullRequestCell } from "@/session-manager/SessionManagerRowView.js";
import {
  buildSessionManagerGridTemplate,
  sessionManagerColumnLabelId,
} from "@/session-manager/sessionManagerColumns.js";
import { SESSION_MANAGER_DEFAULT_COLUMNS } from "@/session-manager/sessionManagerTypes.js";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        [id, ...Object.values(values ?? {})].join(" · "),
    },
  }),
}));

const INTL = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
    [id, ...Object.values(values ?? {})].join(" · "),
} as never;

function makePullRequest(overrides: Partial<SessionPullRequest> = {}): SessionPullRequest {
  return {
    number: 7,
    url: "https://github.com/osben/ZCode/pull/7",
    title: "Example",
    repository: "osben/ZCode",
    headRefName: "feat/x",
    stage: "open",
    checks: "optional_failing",
    failingCheckCount: 1,
    totalCheckCount: 3,
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

function makeRow(taskOverrides: Record<string, unknown> = {}) {
  return {
    task: {
      taskId: "row-task",
      workspacePath: "/w",
      executionWorktree: { path: "/wt", branchName: "feat/x" },
      ...taskOverrides,
    },
  } as never;
}

function renderCell(row: never) {
  return render(createElement(PullRequestCell, { row, intl: INTL })).container.innerHTML;
}

afterEach(() => {
  cleanup();
  usePullRequestStatusStore.getState().dropWorkspaceTasks("/w");
});

test("shows the primary number, stage glyph, and health dot", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "row-task": makeStatus([makePullRequest()]),
  });
  const html = renderCell(makeRow());
  expect(html).toContain("#7");
  expect(html).toContain("text-pr-open");
  expect(html).toContain("bg-warning", "optional-only failing is a warning dot");
  expect(html).toContain('data-session-manager-pr="open"');
  expect(html).toContain("pullRequest.checksOptionalFailing · 1");
});

test("shows a dash when unknown: never requested, no worktree, or no pull requests", () => {
  usePullRequestStatusStore.getState().setWorkspacePullRequestStatuses("/w", {
    "row-task": makeStatus([]),
  });
  expect(renderCell(makeRow())).toContain("—", "checked, no PR");
  expect(renderCell(makeRow({ executionWorktree: undefined }))).toContain(
    "—",
    "ordinary session (scenario 6)",
  );
  expect(renderCell(makeRow({ taskId: "never-requested" }))).toContain(
    "—",
    "scrolled out or unreachable workspace",
  );
});

test("the pullRequests column participates in the grid and reuses the PR label", () => {
  expect(SESSION_MANAGER_DEFAULT_COLUMNS).toContain("pullRequests");
  expect(sessionManagerColumnLabelId("pullRequests")).toBe("pullRequest.columnTitle");
  expect(buildSessionManagerGridTemplate(["pullRequests"])).toContain("84px");
});
