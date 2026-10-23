// @vitest-environment jsdom
// Commit dialog detached-HEAD warning (specs/git-commit-detached-head-warning.md; QA MINOR-4 in
// docs/testing/git-worktree-qa/actual-issues-2026-10-18.md): Commit / Commit and push on a
// detached HEAD ask first; cancelling changes nothing, confirming commits as before, and a branch
// HEAD never asks.
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GitFileChange, GitIdentity, GitRepositorySummary } from "@zcode/shared";
import { GitActionMenu } from "@/GitActionMenu.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  gitService: null as unknown as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en",
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
        values && values.error !== undefined ? `${id} {${values.error}}` : id,
      formatPlural: ({ id }: { id: string }) => id,
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

function summary(headRefType: "detached" | "branch"): GitRepositorySummary {
  return {
    workspacePath: "/qa/repo",
    repoRoot: "/qa/repo",
    workspaceInRepoPath: "",
    autoRefreshWatchPaths: [],
    branchName: headRefType === "branch" ? "main" : null,
    trackingBranchName: null,
    headRefType,
    ahead: 0,
    behind: 0,
    isDirty: true,
    isGitAvailable: true,
    isRepository: true,
  };
}

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

class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  useConfirmDialogStore.getState().settleChoice("dismiss");
  cleanup();
  vi.clearAllMocks();
});

async function openDialogAndType(headRefType: "detached" | "branch") {
  mocks.gitService = {
    refresh: vi.fn(async () => ({
      summary: summary(headRefType),
      identity,
      unstagedChanges: [unstagedChange],
      stagedChanges: [],
    })),
    stagePaths: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    push: vi.fn(async () => {
      throw new Error("Cannot push while HEAD is detached.");
    }),
    generateCommitMessage: vi.fn(async () => "chore: qa"),
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  render(
    createElement(GitActionMenu, {
      workspacePath: "/qa/repo",
      // The menu prop says "branch" on purpose: the dialog's refreshed summary is authoritative.
      gitSummary: summary("branch"),
      onRefreshGit: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByTestId("git-action-trigger"));
  const messageInput = await screen.findByTestId("git-commit-message-input");
  fireEvent.change(messageInput, { target: { value: "qa: detached commit" } });
  return messageInput as HTMLTextAreaElement;
}

async function pendingConfirmation() {
  await waitFor(() => {
    expect(useConfirmDialogStore.getState().pendingRequest).toBeDefined();
  });
  return useConfirmDialogStore.getState().pendingRequest!;
}

describe("GitActionMenu detached-HEAD commit warning", () => {
  it("asks before committing on a detached HEAD and changes nothing when cancelled", async () => {
    const messageInput = await openDialogAndType("detached");

    fireEvent.click(screen.getByTestId("git-commit-action-item-commit"));
    const request = await pendingConfirmation();
    expect(request).toMatchObject({
      title: "git.actionMenu.commitDialog.detachedWarning.title",
      description: "git.actionMenu.commitDialog.detachedWarning.description",
      confirmLabel: "git.actionMenu.commitDialog.detachedWarning.confirm",
    });
    useConfirmDialogStore.getState().settleConfirmation(false);

    await waitFor(() => {
      expect(useConfirmDialogStore.getState().pendingRequest).toBeUndefined();
    });
    expect(mocks.gitService.stagePaths).not.toHaveBeenCalled();
    expect(mocks.gitService.commit).not.toHaveBeenCalled();
    expect(mocks.gitService.generateCommitMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId("git-commit-dialog")).toBeTruthy();
    expect(messageInput.value).toBe("qa: detached commit");
  });

  it("commits once after the user confirms on a detached HEAD", async () => {
    await openDialogAndType("detached");

    fireEvent.click(screen.getByTestId("git-commit-action-item-commit"));
    await pendingConfirmation();
    useConfirmDialogStore.getState().settleConfirmation(true);

    await waitFor(() => {
      expect(mocks.gitService.commit).toHaveBeenCalledTimes(1);
    });
    expect(mocks.gitService.commit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "qa: detached commit" }),
    );
    await waitFor(() => {
      expect(mocks.toast).toHaveBeenCalledWith("git.actionMenu.commitDialog.toast.success");
    });
  });

  it("keeps the push-failure toast for Commit and push after confirming", async () => {
    await openDialogAndType("detached");

    fireEvent.click(screen.getByTestId("git-commit-action-item-commitAndPush"));
    await pendingConfirmation();
    useConfirmDialogStore.getState().settleConfirmation(true);

    await waitFor(() => {
      expect(mocks.gitService.push).toHaveBeenCalledTimes(1);
    });
    expect(mocks.gitService.commit).toHaveBeenCalledTimes(1);
  });

  it("never asks on a branch HEAD", async () => {
    await openDialogAndType("branch");

    fireEvent.click(screen.getByTestId("git-commit-action-item-commit"));

    await waitFor(() => {
      expect(mocks.gitService.commit).toHaveBeenCalledTimes(1);
    });
    expect(useConfirmDialogStore.getState().pendingRequest).toBeUndefined();
  });
});
