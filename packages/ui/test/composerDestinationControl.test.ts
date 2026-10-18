// Unified destination control tests (specs/composer-branch-switcher-semantics.md §4):
// flag default on + layout rollback wiring (source contract), worktree intent registration with
// the selected base override, and Task/Base row semantics through the store.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useState } from "react";
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
import {
  ComposerDraftWorktreeIntentContext,
  createComposerDraftWorktreeIntentSlot,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
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

// ---------------------------------------------------------------------------
// BUG-GWT-009 render harness: docs/testing/git-worktree-qa/bugs/BUG-GWT-009.md
// The popover caches its branch list in component state and never invalidates it after the
// footer "Create and switch…" mutates HEAD, so a reopened list misses the new current branch.
// RPC surface (gitService) is mocked; interaction goes through the real popover + dialog.
const destinationControlHarness = vi.hoisted(() => {
  const branch = (name: string, isCurrent: boolean) => ({
    name,
    isCurrent,
    upstreamName: null,
    commitHash: "e17a7fd",
    commitTimestampMs: 1,
  });
  const repositoryState = {
    currentBranchName: "main" as string,
    branches: [branch("feature/a", false), branch("main", true), branch("release", false)],
  };
  // Full GitRepositorySummary shape (the component reads branchName/headRefType live).
  const summary = (branchName: string) => ({
    workspacePath: "/dev/bug009",
    repoRoot: "/dev/bug009",
    workspaceInRepoPath: "",
    autoRefreshWatchPaths: [],
    branchName,
    trackingBranchName: null,
    headRefType: "branch" as const,
    ahead: 0,
    behind: 0,
    isDirty: true,
    isGitAvailable: true,
    isRepository: true,
  });
  const getLocalBranches = vi.fn(async () => ({
    headRefType: "branch" as const,
    currentBranchName: repositoryState.currentBranchName,
    branches: repositoryState.branches.map((entry) => ({ ...entry })),
  }));
  const createBranchAndSwitch = vi.fn(async (request: { branchName: string }) => {
    repositoryState.branches = [
      ...repositoryState.branches.map((entry) => ({
        ...entry,
        isCurrent: entry.name === request.branchName,
      })),
      branch(request.branchName, true),
    ];
    repositoryState.currentBranchName = request.branchName;
    return {
      ok: true,
      action: "create-and-switch" as const,
      branchName: request.branchName,
      didChange: true,
      created: true,
      summary: summary(request.branchName),
      issues: [],
    };
  });
  const gitService = {
    getLocalBranches,
    createBranchAndSwitch,
    switchBranch: vi.fn(),
    listWorktrees: vi.fn(async () => ({ isGitAvailable: true, isRepository: true, worktrees: [] })),
    getWorktreeStorageInfo: vi.fn(async () => ({ globalWorktreesDir: null })),
  };
  // References must stay stable: the component resets its cached state when the resolved
  // gitService identity changes, so a fresh object per render would hide the bug.
  const services = { gitService };
  const resolution = {
    services,
    remoteSessionId: null,
    isRemoteTarget: false,
    connectionKind: "local-ready" as const,
    rpcReady: true,
  };
  const reset = () => {
    repositoryState.currentBranchName = "main";
    repositoryState.branches = [
      branch("feature/a", false),
      branch("main", true),
      branch("release", false),
    ];
    getLocalBranches.mockClear();
    createBranchAndSwitch.mockClear();
  };
  return {
    repositoryState,
    getLocalBranches,
    createBranchAndSwitch,
    services,
    resolution,
    summary,
    reset,
  };
});

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => destinationControlHarness.services,
  useWorkspaceServicesResolution: () => destinationControlHarness.resolution,
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => destinationControlHarness.services,
  useOptionalServices: () => destinationControlHarness.services,
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: null, loading: false, error: null }),
}));

describe("BUG-GWT-009: branch list refresh after create-and-switch", () => {
  const CURRENT_DIRTY_HINT = "git.branchSwitcher.currentDirty";

  function DestinationControlHarness() {
    // gitSummary is live state owned by the parent; onRefreshGit stands in for the parent's
    // post-mutation summary refresh (same contract as the status-panel switcher path).
    const [branchName, setBranchName] = useState("main");
    return createElement(ComposerDestinationControl, {
      workspacePath: "/dev/bug009",
      gitSummary: destinationControlHarness.summary(branchName),
      dirtyFileCount: 1,
      onRefreshGit: () => setBranchName("qa/b4-valid"),
    });
  }

  function renderControl() {
    return render(
      createElement(
        ComposerDraftWorktreeIntentContext.Provider,
        { value: createComposerDraftWorktreeIntentSlot() },
        createElement(DestinationControlHarness),
      ),
    );
  }

  async function openBranchList() {
    // The radix Popover trigger toggles on click (onOpenToggle), not on pointerDown.
    fireEvent.click(screen.getByRole("button", { name: "destination.trigger.ariaLabel" }));
    fireEvent.click(await screen.findByRole("button", { name: /destination\.taskBranch/ }));
    return screen.findAllByRole("option");
  }

  beforeAll(() => {
    // Radix Popper measures content with ResizeObserver; cmdk scrolls the selected item into
    // view — jsdom implements neither.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    destinationControlHarness.reset();
  });

  afterEach(() => {
    cleanup();
  });

  it.fails("BUG-GWT-009: reopening the branch list after create-and-switch shows the new current branch", async () => {
    renderControl();

    // Pre-switch sanity: the inline list renders the mock RPC branches, main marked current.
    const initialOptions = await openBranchList();
    const initialTexts = initialOptions.map((option) => option.textContent ?? "");
    expect(initialTexts.some((text) => text.includes("feature/a"))).toBe(true);
    expect(initialTexts.some((text) => text.includes("release"))).toBe(true);
    expect(
      initialTexts.some((text) => text.includes("main") && text.includes(CURRENT_DIRTY_HINT)),
    ).toBe(true);
    expect(initialTexts.some((text) => text.includes("qa/b4-valid"))).toBe(false);

    // Footer action → create dialog → create-and-switch (mock RPC mutates the branch state).
    fireEvent.click(screen.getByRole("button", { name: "git.branchSwitcher.createAction" }));
    const nameInput = await screen.findByLabelText("git.branchSwitcher.createDialog.nameLabel");
    fireEvent.change(nameInput, { target: { value: "qa/b4-valid" } });
    fireEvent.submit(nameInput.closest("form") as HTMLFormElement);

    await waitFor(() => {
      expect(destinationControlHarness.createBranchAndSwitch).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("git.branchSwitcher.createDialog.nameLabel")).toBeNull();
    });

    // Reopen the popover (listOpen survived): the list must show the branch just created,
    // carrying the current-branch hint (live gitSummary says HEAD is now qa/b4-valid).
    fireEvent.click(screen.getByRole("button", { name: "destination.trigger.ariaLabel" }));
    await screen.findAllByRole("option");
    await waitFor(() => {
      const reopenedTexts = screen.getAllByRole("option").map((option) => option.textContent ?? "");
      const created = reopenedTexts.find((text) => text.includes("qa/b4-valid"));
      expect(created).toBeTruthy();
      expect(created).toContain(CURRENT_DIRTY_HINT);
    });
  });
});
