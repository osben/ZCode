// Unified destination control tests (specs/composer-branch-switcher-semantics.md §4):
// flag default on + layout rollback wiring (source contract), worktree intent registration with
// the selected base override, and Task/Base row semantics through the store.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("WorkspaceShellLayout rollback wiring (source contract)", () => {
  const source = readFileSync(
    resolve(process.cwd(), "packages/ui/src/app-shell/WorkspaceShellLayout.tsx"),
    "utf8",
  ).replace(/\s+/gu, " ");

  it("renders the unified control only when the flag is on; the old pair remains for rollback", () => {
    expect(source).toContain("canRenderGitDestinationControl && destinationControlEnabled ? (");
    expect(source).toContain("<ComposerDestinationControl");
    // Flag off must keep the legacy controls fully intact.
    expect(source).toContain("<GitBranchSwitcher");
    expect(source).toContain("<ChatEmptyWorktreeTaskToggle");
    expect(source).toContain("canRenderGitDestinationControl ? (");
    expect(source).toContain("!destinationControlEnabled ? (");
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

  it("withdraws a queued worktree when project mode is selected", async () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/v4/composer/ComposerDestinationControl.tsx"),
      "utf8",
    );
    const toggle = source.slice(source.indexOf("aria-checked={worktreeActive}"));
    expect(toggle).toContain("setWorktreeIntentActive(workspaceKey, !worktreeActive)");
    expect(toggle).toContain('pipeline?.status === "creating" || pipeline?.status === "ready"');
    expect(toggle).toContain("getState().withdraw(workspaceKey)");
    expect(source).toContain("!pipeline.orphaned");
  });
});

describe("workspace isolation (source contract)", () => {
  const source = readFileSync(
    resolve(process.cwd(), "packages/ui/src/v4/composer/ComposerDestinationControl.tsx"),
    "utf8",
  );

  it("resets cached branch state when the workspace changes (live bug: previous project's branch became the next project's worktree base)", () => {
    // The shell header stays mounted across workspace tabs; the reset keyed by workspaceKey is
    // what drops the previous project's cached branch list, base pick, and open views. The
    // dependency array also covers the remote target and its git service, which are part of the
    // same workspace identity.
    expect(source).toContain("setBaseBranch(null);");
    expect(source).toContain("setBranchesResult(null);");
    expect(source).toContain("setBranchListFailed(false);");
    expect(source).toContain(
      "}, [workspaceKey, workspacePath, resolution.remoteSessionId, baseServices.gitService]);",
    );

    // Branch list reloads on every open: the fetch effect is keyed to the open transition and the
    // Git target only. Depending on branchesResult or branchListFailed would refetch after every
    // response (loop), and a failure flag must reset on open so a failed open retries.
    expect(source).toContain(
      "}, [baseServices.gitService, open, workspacePath, resolution.rpcReady]);",
    );
    expect(source).toContain("if (nextOpen) setBranchListFailed(false);");
    expect(source).not.toContain("branchesResult !== null || branchListFailed");
  });

  it("derives the automatic base from the live git summary, never the cached branch list", () => {
    // The cached list can outlive a branch switch or a project switch; only the live summary
    // may name the base. HEAD is the fallback solely when no branch can be named (detached).
    expect(source).not.toContain("branchesResult?.currentBranchName");
    expect(source).toContain(
      "baseBranch ?? branchIntent ?? (headDefault ? undefined : currentBranchName)",
    );
    expect(source).toContain("baseFromHeadDefault: headDefault");
    expect(source).toContain("switcher.setOpen(nextOpen)");
  });
});

describe("draft branch creation guard (source contract)", () => {
  it("confirms affected checkout tasks before creating and switching a branch", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/v4/composer/ComposerDestinationControl.tsx"),
      "utf8",
    );
    const dialog = source.slice(
      source.indexOf("<GitBranchCreateDialog"),
      source.indexOf("<GitGraphDialog", source.indexOf("<GitBranchCreateDialog")),
    );
    const handler = source.slice(
      source.indexOf("const handleCreateBranchAndSwitch"),
      source.indexOf("const currentBranchName"),
    );

    expect(source).toContain("useBranchSwitchGuard");
    expect(handler).toContain("await branchSwitchGuard({");
    expect(handler).toContain('scope: "checkout"');
    expect(handler).toContain("if (!allowed) return;");
    expect(handler).toContain("await switcher.createBranchAndSwitch();");
    expect(dialog).toContain("onSubmit={() => void handleCreateBranchAndSwitch()}");
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
