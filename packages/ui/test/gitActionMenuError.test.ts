// @vitest-environment jsdom
// Reproduces BUG-GWT-006 (see docs/testing/git-worktree-qa/bugs/BUG-GWT-006.md):
// "Commit and push" in a detached HEAD performs the commit, then the push fails, but the
// failure is only written into the commit dialog via setCommitError. When the dialog has
// already been dismissed (production observation: it closes at action selection time),
// the error lands in a closed dialog and no toast is shown, so the push fails silently.
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitIdentity, GitRepositorySummary } from "@zcode/shared";
import { GitActionMenu } from "@/GitActionMenu.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  pushDeferred: null as null | {
    promise: Promise<unknown>;
    reject: (reason?: unknown) => void;
  },
  gitService: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en",
    // Return the message id (plus the interpolated error) so assertions do not depend on translations.
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        values && values.error !== undefined ? `${id} {${values.error}}` : id,
    },
  }),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));

vi.mock("@/GitBranchSwitcher.js", () => ({ GitBranchSwitcher: () => null }));

vi.mock("@/components/ui/tooltip.js", async () => {
  const { createElement } = await import("react");
  const passthrough = ({ children }: { children?: unknown }) =>
    createElement("span", null, children);
  return {
    Tooltip: passthrough,
    TooltipTrigger: passthrough,
    TooltipContent: () => null,
    TooltipProvider: passthrough,
  };
});

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    lifecycle: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    trace: vi.fn(),
  },
}));

vi.mock("@/lib/userActionTelemetry.js", () => ({
  runUserAction: (options: { operation: () => unknown }) => options.operation(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ gitService: mocks.gitService }),
  useOptionalServices: () => null,
}));

const detachedSummary: GitRepositorySummary = {
  workspacePath: "/qa/detached",
  repoRoot: "/qa/detached",
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: null,
  trackingBranchName: null,
  headRefType: "detached",
  ahead: 0,
  behind: 0,
  isDirty: true,
  isGitAvailable: true,
  isRepository: true,
};

const identity: GitIdentity = {
  userName: "QA",
  userEmail: "qa@example.invalid",
  nameSource: "global",
  emailSource: "global",
};

const unstagedChange: GitFileChange = {
  path: "src/app.txt",
  repoRelativePath: "src/app.txt",
  workspaceRelativePath: "src/app.txt",
  x: "M",
  y: "M",
  kind: "modified",
  section: "unstaged",
  added: 1,
  removed: 0,
  isStaged: false,
  isUntracked: false,
  isConflicted: false,
};

function armPendingPush(errorMessage: string): () => void {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<never>((_, rejectPush) => {
    reject = rejectPush;
  });
  mocks.pushDeferred = { promise, reject };
  return () => reject(new Error(errorMessage));
}

// Detached HEAD asks before committing (specs/git-commit-detached-head-warning.md); these cases
// cover the push failure after a confirmed commit.
async function confirmDetachedCommit(): Promise<void> {
  await waitFor(() => {
    expect(useConfirmDialogStore.getState().pendingRequest).toBeDefined();
  });
  useConfirmDialogStore.getState().settleConfirmation(true);
}

async function flushMicrotasks(): Promise<void> {
  // Deterministic flush of the rejection -> catch -> setState chain; no timers involved.
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  // cmdk observes its list element; jsdom does not ship ResizeObserver.
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  // cmdk scrolls the selected item into view; jsdom does not implement it.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pushDeferred = null;
});

describe("GitActionMenu commit dialog error visibility", () => {
  it("BUG-GWT-006: keeps a push-after-commit failure visible after the commit dialog closes", async () => {
    const failPush = armPendingPush("Cannot push while HEAD is detached.");
    mocks.gitService = {
      refresh: vi.fn(async () => ({
        summary: detachedSummary,
        identity,
        unstagedChanges: [unstagedChange],
        stagedChanges: [],
      })),
      stagePaths: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      push: vi.fn(() => mocks.pushDeferred?.promise),
      generateCommitMessage: vi.fn(async () => "chore: qa"),
    } as unknown as Record<string, ReturnType<typeof vi.fn>>;

    render(
      createElement(GitActionMenu, {
        workspacePath: "/qa/detached",
        gitSummary: detachedSummary,
        onRefreshGit: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByTestId("git-action-trigger"));
    const messageInput = await screen.findByTestId("git-commit-message-input");
    fireEvent.change(messageInput, {
      target: { value: "qa: commit in detached HEAD" },
    });

    fireEvent.click(screen.getByTestId("git-commit-action-item-commitAndPush"));
    await confirmDetachedCommit();
    // The commit resolved and the push request is now in flight.
    await waitFor(() => {
      expect(mocks.gitService.push).toHaveBeenCalledTimes(1);
    });

    // Dismiss the dialog while the push is still pending. This is the production close
    // path from the bug report: onOpenChange(false) -> closeCommitDialog()
    // (packages/ui/src/GitActionMenu.tsx), which is not guarded against a pending mutation.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() => {
      expect(screen.queryByTestId("git-commit-dialog")).toBeNull();
    });

    await act(async () => {
      failPush();
      await flushMicrotasks();
    });

    // The commit succeeded and the push failed after the dialog was dismissed: the failure must
    // surface on exactly one surface — a toast carrying the rejection text, with no inline error.
    expect(mocks.gitService.commit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("git-commit-dialog")).toBeNull();
    const failureToasts = mocks.toast.mock.calls.filter(
      ([message]) =>
        typeof message === "string" &&
        message.includes("pushAfterCommitFailed") &&
        message.includes("Cannot push while HEAD is detached."),
    );
    expect(
      failureToasts,
      "push-after-commit failure must surface as one toast after the commit dialog closes",
    ).toHaveLength(1);
  });

  it("BUG-GWT-006 (RT2-H5 live path): shows a failure toast when GitActionMenu unmounts while the push is pending", async () => {
    // RT2-H5 wave-2 live evidence: 7 attempts, each with the commit created and git.push FAIL
    // in the host log, yet 0 toasts and no inline error. The toast host never mounted, so the
    // toast branch never ran: the failure handler read a stale-true commitDialogOpenRef after
    // the menu (status section) unmounted mid-mutation — the dialog disappeared without
    // closeCommitDialog, and setCommitError on the dead component showed nothing. The unmount
    // is the real live path this regression covers.
    const failPush = armPendingPush("Cannot push while HEAD is detached.");
    mocks.gitService = {
      refresh: vi.fn(async () => ({
        summary: detachedSummary,
        identity,
        unstagedChanges: [unstagedChange],
        stagedChanges: [],
      })),
      stagePaths: vi.fn(async () => undefined),
      commit: vi.fn(async () => undefined),
      push: vi.fn(() => mocks.pushDeferred?.promise),
      generateCommitMessage: vi.fn(async () => "chore: qa"),
    } as unknown as Record<string, ReturnType<typeof vi.fn>>;

    const view = render(
      createElement(GitActionMenu, {
        workspacePath: "/qa/detached",
        gitSummary: detachedSummary,
        onRefreshGit: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByTestId("git-action-trigger"));
    const messageInput = await screen.findByTestId("git-commit-message-input");
    fireEvent.change(messageInput, {
      target: { value: "qa: commit in detached HEAD" },
    });

    fireEvent.click(screen.getByTestId("git-commit-action-item-commitAndPush"));
    await confirmDetachedCommit();
    await waitFor(() => {
      expect(mocks.gitService.push).toHaveBeenCalledTimes(1);
    });

    // The whole menu unmounts while the push is still in flight (live observation: the open
    // dialog vanished around the failure moment). The async handler keeps running.
    view.unmount();
    expect(screen.queryByTestId("git-commit-dialog")).toBeNull();

    await act(async () => {
      failPush();
      await flushMicrotasks();
    });

    expect(mocks.gitService.commit).toHaveBeenCalledTimes(1);
    expect(
      mocks.toast.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.includes("pushAfterCommitFailed") &&
          message.includes("Cannot push while HEAD is detached."),
      ),
      "a push-after-commit failure after unmount must surface as a toast",
    ).toBe(true);
  });
});
