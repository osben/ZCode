// Unified destination control tests (specs/composer-branch-switcher-semantics.md §4):
// flag default on + layout rollback wiring (source contract), worktree intent registration with
// the selected base override, and Task/Base row semantics through the store.
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitLocalBranchListResult, GitRepositorySummary } from "@zcode/shared";
import { ComposerDraftWorktreeIntentContext } from "@/v4/composer/composerDraftWorktreeIntent.js";
import {
  selectDraftBranchIntent,
  selectWorktreeIntentActive,
  useDraftBranchIntentStore,
} from "@/v4/composer/draftBranchIntent.js";
import {
  COMPOSER_DESTINATION_CONTROL_FLAG,
  ComposerDestinationControl,
  readComposerDestinationControlEnabled,
} from "@/v4/composer/ComposerDestinationControl.js";
import { shouldRenderComposerDestinationControl } from "@/v4/composer/destinationControlVisibility.js";

const WORKSPACE_KEY = "/dev/alpha";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feature flag", () => {
  it("reads the renderer-local flag (default on; '0' restores the legacy pair)", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    expect(readComposerDestinationControlEnabled()).toBe(true);
    window.localStorage.setItem(COMPOSER_DESTINATION_CONTROL_FLAG, "0");
    expect(readComposerDestinationControlEnabled()).toBe(false);
  });
});

describe("Git destination visibility follows the selected workspace", () => {
  const visible = (
    activeWorkspaceKey: string,
    gitState: {
      workspaceKey: string;
      loading: boolean;
      summary: { isGitAvailable: boolean; isRepository: boolean };
    },
  ) => shouldRenderComposerDestinationControl({ activeWorkspaceKey, gitState });

  it("shows the destination for a confirmed Git project, hides it while the next project's status loads, then shows it for the next Git project", () => {
    expect(
      visible("/projects/one", {
        workspaceKey: "/projects/one",
        loading: false,
        summary: { isGitAvailable: true, isRepository: true },
      }),
    ).toBe(true);

    expect(
      visible("/projects/plain", {
        workspaceKey: "/projects/plain",
        loading: true,
        summary: { isGitAvailable: false, isRepository: false },
      }),
    ).toBe(false);
    expect(
      visible("/projects/plain", {
        workspaceKey: "/projects/plain",
        loading: false,
        summary: { isGitAvailable: true, isRepository: false },
      }),
    ).toBe(false);

    expect(
      visible("/projects/three", {
        workspaceKey: "/projects/three",
        loading: false,
        summary: { isGitAvailable: true, isRepository: true },
      }),
    ).toBe(true);
  });

  it("ignores a completed Git response from the previous project", () => {
    expect(
      visible("/projects/plain", {
        workspaceKey: "/projects/one",
        loading: false,
        summary: { isGitAvailable: true, isRepository: true },
      }),
    ).toBe(false);
  });

  it("keeps the selected destination mounted while the confirmed repository refreshes", () => {
    expect(
      visible("/projects/one", {
        workspaceKey: "/projects/one",
        loading: true,
        summary: { isGitAvailable: true, isRepository: true },
      }),
    ).toBe(true);
  });
});

describe("destination semantics through the shared stores", () => {
  it("the switch and the branch intent live in one store: mode toggle keeps the branch value", () => {
    const store = useDraftBranchIntentStore.getState();
    store.setDraftBranchIntent(WORKSPACE_KEY, "feature/x");
    store.setWorktreeIntentActive(WORKSPACE_KEY, true);
    const state = useDraftBranchIntentStore.getState();
    // In worktree mode the same selection is reinterpreted as the base (Task ↔ Base relabel).
    expect(selectDraftBranchIntent(state, WORKSPACE_KEY)).toBe("feature/x");
    expect(selectWorktreeIntentActive(state, WORKSPACE_KEY)).toBe(true);
    store.setWorktreeIntentActive(WORKSPACE_KEY, false);
    store.clearDraftBranchIntent(WORKSPACE_KEY);
    expect(selectDraftBranchIntent(useDraftBranchIntentStore.getState(), WORKSPACE_KEY)).toBeNull();
  });
});

// The component render itself is covered by the shared harness pattern in
// chatEmptyWorktreeTaskToggle.test.ts (same providers/mocks); this file pins the flag + wiring +
// store semantics that the harness would not catch. beginCreation base override is asserted in the
// pipeline-level tests via the store params.
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

// ---- Render behavior: the destination popover reloads the branch list on every open ----

const branchFetch = vi.hoisted(() => ({
  getLocalBranches: vi.fn(),
  getWorktreeStorageInfo: vi.fn(async () => ({ globalWorktreesDir: null })),
  listWorktrees: vi.fn(async () => ({ worktrees: [] })),
}));
// Stable reference: the component's effects depend on gitService identity.
const stableGitService = vi.hoisted(() => branchFetch);
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
    services: { gitService: stableGitService },
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

function gitSummaryOn(branchName: string): GitRepositorySummary {
  return {
    workspacePath: "/repo",
    repoRoot: "/repo",
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: true,
    isRepository: true,
  };
}

function renderDestination(branchName: string) {
  const element = (name: string) =>
    createElement(
      ComposerDraftWorktreeIntentContext.Provider,
      { value: undefined },
      createElement(ComposerDestinationControl, {
        workspacePath: "/repo",
        gitSummary: gitSummaryOn(name),
        dirtyFileCount: 0,
        onRefreshGit: vi.fn(),
      }),
    );
  const view = render(element(branchName));
  return {
    rerenderOn: (name: string) => view.rerender(element(name)),
  };
}

function trigger() {
  return screen.getByRole("button", { name: "destination.trigger.ariaLabel" });
}

describe("destination popover branch list reloads on every open (render)", () => {
  beforeAll(() => {
    // Radix popper and cmdk read these DOM APIs, which jsdom does not implement.
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    // Assigned directly: the file-level afterEach unstubs globals between tests.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    branchFetch.getLocalBranches.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("(a) re-opening the popover calls getLocalBranches again", async () => {
    branchFetch.getLocalBranches.mockResolvedValue(branchList(["main"], "main"));
    renderDestination("main");

    fireEvent.click(trigger());
    await waitFor(() => expect(branchFetch.getLocalBranches).toHaveBeenCalledTimes(1));
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    await waitFor(() => expect(branchFetch.getLocalBranches).toHaveBeenCalledTimes(2));
  });

  it("(b) after a create-and-switch, re-opening shows the new branch from a fresh list", async () => {
    branchFetch.getLocalBranches
      .mockResolvedValueOnce(branchList(["main"], "main"))
      .mockResolvedValueOnce(branchList(["main", "feature/new"], "feature/new"));
    const destination = renderDestination("main");

    fireEvent.click(trigger());
    fireEvent.click(await screen.findByText("destination.taskBranch"));
    // Branch rows are options; plain text would also match the trigger label.
    expect(await screen.findByRole("option", { name: "main" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "feature/new" })).toBeNull();
    fireEvent.click(trigger());

    // The create-and-switch flow moves HEAD; the git summary follows it while the popover is closed.
    destination.rerenderOn("feature/new");
    fireEvent.click(trigger());

    expect(await screen.findByRole("option", { name: "feature/new" })).toBeTruthy();
    expect(branchFetch.getLocalBranches).toHaveBeenCalledTimes(2);
  });

  it("(c) a failed branch load is retried on the next open", async () => {
    branchFetch.getLocalBranches
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(branchList(["main"], "main"));
    renderDestination("main");

    fireEvent.click(trigger());
    fireEvent.click(await screen.findByText("destination.taskBranch"));
    await waitFor(() => expect(branchFetch.getLocalBranches).toHaveBeenCalledTimes(1));
    fireEvent.click(trigger());
    fireEvent.click(trigger());

    expect(await screen.findByRole("option", { name: "main" })).toBeTruthy();
    expect(branchFetch.getLocalBranches).toHaveBeenCalledTimes(2);
  });
});
