// Task/Base row mode semantics (specs/composer-branch-switcher-semantics.md §4, 2026-10-19 fix):
// the worktree Base override is worktree-mode state and never names the project-mode task branch —
// the row, the chip, and the list checkmark render the per-mode effective selection. Split from
// composerDestinationControl.test.ts to keep each test module under the staged-file size limit.
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitLocalBranchListResult, GitRepositorySummary } from "@zcode/shared";
import { ComposerDraftWorktreeIntentContext } from "@/v4/composer/composerDraftWorktreeIntent.js";
import type { ComposerDraftWorktreeIntent } from "@/v4/composer/composerDraftWorktreeIntent.js";
import { useDraftBranchIntentStore } from "@/v4/composer/draftBranchIntent.js";
import { ComposerDestinationControl } from "@/v4/composer/ComposerDestinationControl.js";

const branchFetch = vi.hoisted(() => ({
  getLocalBranches: vi.fn(),
  getWorktreeStorageInfo: vi.fn(async () => ({ globalWorktreesDir: null })),
  listWorktrees: vi.fn(async () => ({ worktrees: [] })),
  // The popover-open probe feeding the main-branch Base default; defaults to "no default".
  getBranchMergeStatus: vi.fn(async () => ({
    state: "unknown",
    baseRef: null,
    headRef: null,
    lastCommitAt: null,
  })),
}));
const switcherStub = vi.hoisted(() => ({
  setOpen: vi.fn(),
  setCreateDialogOpen: vi.fn(),
  setCreateBranchName: vi.fn(),
  createBranchAndSwitch: vi.fn(async () => {}),
  createDialogOpen: false,
  createBranchName: "",
  mutationPending: false,
  worktreeOccupancy: new Map<string, string>(),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => ({
    services: { gitService: branchFetch },
    rpcReady: true,
    remoteSessionId: undefined,
  }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: {}, loading: false, error: null }),
}));
vi.mock("@/hooks/useGitBranchSwitcher.js", () => ({
  useGitBranchSwitcher: () => switcherStub,
}));
vi.mock("@/v4/composer/branchSwitchGuard.js", () => ({
  useBranchSwitchGuard: () => null,
}));
vi.mock("@/git-branch-switcher/GitBranchDialogs.js", () => ({
  GitBranchCreateDialog: () => null,
}));
vi.mock("@/git-graph/GitGraphDialog.js", () => ({
  GitGraphDialog: () => null,
}));

function branchList(names: string[], current: string): GitLocalBranchListResult {
  return {
    headRefType: "branch",
    currentBranchName: current,
    branches: names.map((name) => ({
      name,
      isCurrent: name === current,
      upstreamName: null,
      commitHash: null,
      commitTimestampMs: null,
    })),
  };
}

function gitSummaryOn(
  branchName: string | null,
  headRefType: GitRepositorySummary["headRefType"] = "branch",
): GitRepositorySummary {
  return {
    workspacePath: "/repo",
    repoRoot: "/repo",
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName,
    trackingBranchName: null,
    headRefType,
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: true,
    isRepository: true,
  };
}

function renderDestination(
  branchName: string | null,
  headRefType: GitRepositorySummary["headRefType"] = "branch",
) {
  const slot: { current: ComposerDraftWorktreeIntent | null } = { current: null };
  const element = (name: string | null) =>
    createElement(
      ComposerDraftWorktreeIntentContext.Provider,
      { value: slot },
      createElement(ComposerDestinationControl, {
        workspacePath: "/repo",
        gitSummary: gitSummaryOn(name, headRefType),
        dirtyFileCount: 0,
        onRefreshGit: vi.fn(),
      }),
    );
  const view = render(element(branchName));
  return {
    rerenderOn: (name: string) => view.rerender(element(name)),
    slot,
  };
}

function trigger() {
  return screen.getByRole("button", { name: "destination.trigger.ariaLabel" });
}

function mergeStatus(baseRef: string | null) {
  return { state: "unknown" as const, baseRef, headRef: null, lastCommitAt: null };
}

function worktreeSwitch() {
  return screen.getByRole("switch", { name: "destination.worktreeLabel" });
}

/** The branch row's shown value: the text of the row button carrying the row label. */
function branchRowValue(labelId: string): string {
  return screen.getByText(labelId).closest("button")?.textContent ?? "";
}

async function openPopoverAndWaitForLoads() {
  fireEvent.click(trigger());
  await waitFor(() => expect(branchFetch.getLocalBranches).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(branchFetch.getBranchMergeStatus).toHaveBeenCalledTimes(1));
}

describe("toggling worktree OFF shows the task branch, never the Base override (render)", () => {
  beforeAll(() => {
    // Radix popper and cmdk read these DOM APIs, which jsdom does not implement.
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    branchFetch.getLocalBranches.mockReset();
    branchFetch.getBranchMergeStatus.mockReset();
    branchFetch.getBranchMergeStatus.mockResolvedValue(mergeStatus(null));
  });

  afterEach(() => {
    cleanup();
    useDraftBranchIntentStore.getState().setWorktreeIntentActive("/repo", false);
    useDraftBranchIntentStore.getState().clearDraftBranchIntent("/repo");
    useDraftBranchIntentStore.getState().clearFrozenWorktreeIntent("/repo");
  });

  it("(a) the main-branch Base default does not masquerade as the Task branch after toggle-off", async () => {
    branchFetch.getLocalBranches.mockResolvedValue(branchList(["feature/x", "main"], "feature/x"));
    branchFetch.getBranchMergeStatus.mockResolvedValue(mergeStatus("origin/main"));
    renderDestination("feature/x");

    await openPopoverAndWaitForLoads();
    fireEvent.click(worktreeSwitch());
    await screen.findByText("destination.baseBranch");
    expect(branchRowValue("destination.baseBranch")).toContain("main");

    // Toggle OFF: the row re-labels to the task branch and shows intent ?? current — the
    // worktree-only Base selection (the 2026-10-18 auto-default here) must not name it.
    fireEvent.click(worktreeSwitch());
    await screen.findByText("destination.taskBranch");
    expect(branchRowValue("destination.taskBranch")).toContain("feature/x");
    expect(trigger().textContent).toContain("feature/x");

    // ON again re-defaults the Base to the main branch (the override is worktree-mode state).
    fireEvent.click(worktreeSwitch());
    await screen.findByText("destination.baseBranch");
    expect(branchRowValue("destination.baseBranch")).toContain("main");
  });

  it("(b) the project-mode list checkmark marks the displayed task branch, not the stale Base", async () => {
    branchFetch.getLocalBranches.mockResolvedValue(
      branchList(["dev", "feature/x", "main"], "feature/x"),
    );
    branchFetch.getBranchMergeStatus.mockResolvedValue(mergeStatus("origin/main"));
    renderDestination("feature/x");

    await openPopoverAndWaitForLoads();
    fireEvent.click(worktreeSwitch());
    await screen.findByText("destination.baseBranch");
    // Manual Base pick while ON.
    fireEvent.click(screen.getByText("destination.baseBranch").closest("button")!);
    fireEvent.click(await screen.findByRole("option", { name: "dev" }));
    await screen.findByText("destination.baseBranch");

    fireEvent.click(worktreeSwitch());
    await screen.findByText("destination.taskBranch");
    fireEvent.click(screen.getByText("destination.taskBranch").closest("button")!);
    const currentOption = await screen.findByRole("option", { name: "feature/x" });
    expect(currentOption.getAttribute("data-checked")).toBe("true");
    expect(screen.getByRole("option", { name: "dev" }).getAttribute("data-checked")).toBeNull();
  });

  it("(c) an explicit task-branch intent wins over the detached-HEAD label", () => {
    useDraftBranchIntentStore.getState().setDraftBranchIntent("/repo", "feature/intent");
    renderDestination(null, "detached");
    expect(trigger().textContent).toContain("feature/intent");
    expect(trigger().textContent).not.toContain("git.head.detached");
  });
});
