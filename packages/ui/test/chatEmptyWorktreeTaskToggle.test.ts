// @vitest-environment jsdom
//
// Empty-state "New worktree" checkbox tests (2026-10-13: checkbox-only, no mini-form):
// - gating: only Desktop local, non-remote/conversation main-tree / linked-worktree projects
//   render the checkbox;
// - intent switch: checking registers the first-send interception, unchecking unregisters it;
// - send interception: gates (branches loading / custom location invalid / global storage
//   unavailable) block the send with an inline error; createWorktree success → draft transfer
//   request + App open contract; failure → no switch, inline error;
//   target-path-exists → offers opening the existing worktree instead of a second directory
//   (WT-04);
// - the branch name is fully automatic (generated adjective-noun + effective prefix), asserted
//   with a deterministic Math.random stub ("sleepy-capybara").
// Test doubles stay isomorphic with commandCenterWorktreeDialog.test.ts (stable gitService ref).

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitWorktreeCreateResult } from "@zcode/shared";
import {
  ChatEmptyWorktreeTaskToggle,
  canOfferChatEmptyWorktreeTask,
  isWorktreeCapableRepository,
} from "@/ChatEmptyState.js";
import {
  type ComposerDraftWorktreeInterceptResult,
  ComposerDraftWorktreeIntentContext,
} from "@/v4/composer/composerDraftWorktreeIntent.js";
import type { ComposerDraftWorktreeIntentSlot } from "@/v4/composer/composerDraftWorktreeIntent.js";
import {
  clearV4ComposerDraftWorkspaceTransferRequest,
  consumeV4ComposerDraftWorkspaceTransferRequest,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

const createWorktree = vi.fn();
const listWorktrees = vi.fn();
const getLocalBranches = vi.fn();
const getWorkspaceRepositoryInfo = vi.fn();
// References must stay stable: several effects depend on gitService; a fresh object per render would cause an infinite refetch loop.
const stableGitService = {
  createWorktree,
  listWorktrees,
  getLocalBranches,
  getWorkspaceRepositoryInfo,
};

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ gitService: stableGitService }),
}));

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  platformAvailable: false,
  getAppWorktreesDir: vi.fn(async () => "/Users/dev/.zcode/worktrees"),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: mocks.settings,
    loading: false,
    error: null,
  }),
}));

// Stage F: platform.getAppWorktreesDir (global storage directory) toggled per test case; no platform by default (non-desktop).
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () =>
    mocks.platformAvailable ? { getAppWorktreesDir: mocks.getAppWorktreesDir } : null,
}));

const LOCAL_TAB = {
  id: "tab-alpha",
  kind: "workspace",
  label: "alpha",
  workspacePath: "/dev/alpha",
} as const;

const WORKSPACE_PATH = "/dev/alpha";

function stubRepository(kind: "main-tree" | "linked-worktree" | "not-repository" = "main-tree") {
  getWorkspaceRepositoryInfo.mockResolvedValue({
    workspacePath: WORKSPACE_PATH,
    kind,
    isGitAvailable: true,
  });
}

function stubBranches() {
  getLocalBranches.mockResolvedValue({
    headRefType: "branch",
    currentBranchName: "main",
    branches: [
      { name: "main", isCurrent: true, upstreamName: null, commitHash: "a", commitTimestampMs: 1 },
      { name: "dev", isCurrent: false, upstreamName: null, commitHash: "b", commitTimestampMs: 1 },
      // Composed default-prefix name used by the existing-branch tests (2026-10-13).
      {
        name: "zcode/main",
        isCurrent: false,
        upstreamName: null,
        commitHash: "d",
        commitTimestampMs: 1,
      },
    ],
  });
}

function renderToggle(
  { workspaceTabs = [LOCAL_TAB], isDesktop = true } = {},
  onOpenWorktreeDraft = vi.fn(),
) {
  const intentSlot: ComposerDraftWorktreeIntentSlot = { current: null };
  const utils = render(
    createElement(
      ComposerDraftWorktreeIntentContext.Provider,
      { value: intentSlot },
      createElement(ChatEmptyWorktreeTaskToggle, {
        workspacePath: WORKSPACE_PATH,
        workspaceTabs,
        isDesktop,
        isWebRemoteControlShell: false,
        onOpenWorktreeDraft,
      }),
    ),
  );
  return { ...utils, intentSlot, onOpenWorktreeDraft };
}

async function openWorktreeForm(utils: ReturnType<typeof renderToggle>) {
  await waitFor(() => {
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => {
    expect(utils.intentSlot.current?.workspaceKey).toBe(WORKSPACE_PATH);
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.settings = {};
  mocks.platformAvailable = false;
  clearV4ComposerDraftWorkspaceTransferRequest();
});

describe("canOfferChatEmptyWorktreeTask (pure gating)", () => {
  const base = {
    isDesktop: true,
    isWebRemoteControlShell: false,
    workspacePath: "/dev/alpha",
    workspaceIdentity: undefined,
    currentTab: null,
  };

  it("allows a local desktop project workspace", () => {
    expect(canOfferChatEmptyWorktreeTask(base)).toBe(true);
    expect(
      canOfferChatEmptyWorktreeTask({
        ...base,
        currentTab: { workspacePath: "/dev/alpha", workspacePurpose: "project" },
      }),
    ).toBe(true);
  });

  it.each([
    ["web shell", { isWebRemoteControlShell: true }],
    ["non-desktop", { isDesktop: false }],
    ["remote identity", { workspaceIdentity: "remote-id" }],
    [
      "remote tab",
      {
        currentTab: { workspacePath: "/dev/alpha", remoteSessionId: "session-1" },
      },
    ],
    [
      "conversation tab",
      { currentTab: { workspacePath: "/dev/alpha", workspacePurpose: "conversation" } },
    ],
  ])("rejects %s", (_name, patch) => {
    expect(canOfferChatEmptyWorktreeTask({ ...base, ...patch })).toBe(false);
  });
});

describe("isWorktreeCapableRepository", () => {
  it("accepts only main-tree and linked-worktree with git available", () => {
    expect(
      isWorktreeCapableRepository({ workspacePath: "/p", kind: "main-tree", isGitAvailable: true }),
    ).toBe(true);
    expect(
      isWorktreeCapableRepository({
        workspacePath: "/p",
        kind: "linked-worktree",
        isGitAvailable: true,
      }),
    ).toBe(true);
    expect(
      isWorktreeCapableRepository({
        workspacePath: "/p",
        kind: "not-repository",
        isGitAvailable: true,
      }),
    ).toBe(false);
    expect(
      isWorktreeCapableRepository({
        workspacePath: "/p",
        kind: "main-tree",
        isGitAvailable: false,
      }),
    ).toBe(false);
  });
});

describe("ChatEmptyWorktreeTaskToggle gating", () => {
  it("hides the checkbox for non-git projects and probe failures (WT-03, silent)", async () => {
    stubRepository("not-repository");
    const { container, intentSlot } = renderToggle();
    await waitFor(() => {
      expect(getWorkspaceRepositoryInfo).toHaveBeenCalledWith({ workspacePath: WORKSPACE_PATH });
    });
    // After the probe the checkbox does not render; no error UI.
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    expect(intentSlot.current).toBeNull();
  });

  it("probes silently failing repos without rendering anything", async () => {
    getWorkspaceRepositoryInfo.mockRejectedValue(new Error("git missing"));
    const { container } = renderToggle();
    await waitFor(() => {
      expect(getWorkspaceRepositoryInfo).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
  });

  it("does not probe when the workspace is remote or non-desktop", () => {
    stubRepository();
    renderToggle({
      workspaceTabs: [{ ...LOCAL_TAB, remoteSessionId: "session-1" }],
    });
    expect(getWorkspaceRepositoryInfo).not.toHaveBeenCalled();
  });
});

describe("ChatEmptyWorktreeTaskToggle intent + interception", () => {
  beforeEach(() => {
    stubRepository();
    stubBranches();
    // Deterministic generated name: adjective[0] ("sleepy") + first animal ("capybara").
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the send intent on check and unregisters it on uncheck (no mini-form)", async () => {
    const utils = renderToggle();
    await openWorktreeForm(utils);
    // The mini-form is hidden (2026-10-13 review): only the checkbox row exists.
    expect(screen.queryByLabelText("commandCenter.worktree.branchName")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(utils.intentSlot.current).toBeNull();
  });

  it("blocks the first send while the branch list is still loading", async () => {
    getLocalBranches.mockReturnValue(new Promise(() => {}));
    const utils = renderToggle();
    await openWorktreeForm(utils);
    const intent = utils.intentSlot.current!;

    let result: ComposerDraftWorktreeInterceptResult | undefined;
    await act(async () => {
      result = await intent.interceptFirstSend();
    });
    expect(result?.action).toBe("cancel");
    expect(createWorktree).not.toHaveBeenCalled();
    expect(utils.onOpenWorktreeDraft).not.toHaveBeenCalled();
    expect(screen.getByText("commandCenter.worktree.baseBranch.loading")).toBeTruthy();
  });

  it("retains the created worktree for retries until the first send is accepted", async () => {
    mocks.settings = { worktreeBranchPrefix: "osben-" };
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/dev/alpha-worktrees/osben-sleepy-capybara",
      branchName: "osben-sleepy-capybara",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const utils = renderToggle();
    await openWorktreeForm(utils);
    await waitFor(() => expect(getLocalBranches).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const intent = utils.intentSlot.current!;

    let result: ComposerDraftWorktreeInterceptResult | undefined;
    await act(async () => {
      result = await intent.interceptFirstSend();
    });
    // Proceed result: the composer continues the normal first send in THIS workspace and
    // attaches executionWorktree, so the session runs in the worktree but stays listed here.
    expect(result).toEqual({
      action: "proceed",
      executionWorktree: {
        path: "/dev/alpha-worktrees/osben-sleepy-capybara",
        branchName: "osben-sleepy-capybara",
      },
    });
    // Generated <adjective>-<noun> + effective prefix, current branch as base, sibling target.
    expect(createWorktree).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      branchName: "osben-sleepy-capybara",
      baseBranch: "main",
      targetPath: "/dev/alpha-worktrees/osben-sleepy-capybara",
    });
    // No workspace switch, no draft transfer: the session lives in the current project.
    expect(utils.onOpenWorktreeDraft).not.toHaveBeenCalled();
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: WORKSPACE_PATH,
        targetWorkspacePath: "/dev/alpha-worktrees/osben-sleepy-capybara",
      }),
    ).toBe(false);
    const retainedIntent = utils.intentSlot.current!;
    let retryResult: ComposerDraftWorktreeInterceptResult | undefined;
    await act(async () => {
      retryResult = await retainedIntent.interceptFirstSend();
    });
    expect(retryResult).toEqual(result);
    expect(createWorktree).toHaveBeenCalledTimes(1);

    await act(async () => {
      retainedIntent.onSendAccepted();
    });
    expect(utils.intentSlot.current).toBeNull();
  });

  it("shows the inline issue and keeps the intent registered when creation is rejected", async () => {
    createWorktree.mockResolvedValue({
      ok: false,
      worktreePath: null,
      branchName: null,
      issues: [{ code: "git-unavailable", message: "git not found" }],
    } satisfies GitWorktreeCreateResult);
    const utils = renderToggle();
    await openWorktreeForm(utils);
    await waitFor(() => expect(getLocalBranches).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const intent = utils.intentSlot.current!;

    let result: ComposerDraftWorktreeInterceptResult | undefined;
    await act(async () => {
      result = await intent.interceptFirstSend();
    });
    expect(result?.action).toBe("cancel");
    expect(screen.getByText("commandCenter.worktree.error.git-unavailable")).toBeTruthy();
    expect(utils.onOpenWorktreeDraft).not.toHaveBeenCalled();
    // No workspace switch: the intent stays registered; the composer keeps the text because the send was intercepted.
    expect(utils.intentSlot.current).not.toBeNull();
  });

  it("target-path-exists offers the existing worktree instead of a second directory (WT-04)", async () => {
    createWorktree.mockResolvedValue({
      ok: false,
      worktreePath: null,
      branchName: null,
      issues: [{ code: "target-path-exists", message: "Target path already exists." }],
    } satisfies GitWorktreeCreateResult);
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [
        {
          path: "/dev/alpha-worktrees/zcode-sleepy-capybara",
          headCommitHash: "c",
          // Recovery matches by the COMPOSED branch name (deterministic generated name).
          branchName: "zcode/sleepy-capybara",
          isMain: false,
          isBare: false,
          isDetached: false,
          isCurrent: false,
        },
      ],
    });
    const utils = renderToggle();
    await openWorktreeForm(utils);
    await waitFor(() => expect(getLocalBranches).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const intent = utils.intentSlot.current!;

    let result: ComposerDraftWorktreeInterceptResult | undefined;
    await act(async () => {
      result = await intent.interceptFirstSend();
    });
    expect(result?.action).toBe("cancel");
    expect(
      screen.getByText("commandCenter.worktree.error.target-path-exists.existing"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.openExisting" }));
    expect(utils.onOpenWorktreeDraft).toHaveBeenCalledWith(
      "/dev/alpha-worktrees/zcode-sleepy-capybara",
    );
    expect(createWorktree).toHaveBeenCalledTimes(1);
    // The recovery entry also issues the transfer request: the user's draft text follows to the existing worktree.
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: WORKSPACE_PATH,
        targetWorkspacePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
      }),
    ).toBe(true);
  });

  it("blocks the first send when the custom worktree location is invalid (WTS-01)", async () => {
    mocks.settings = { worktreeLocationMode: "custom" };
    const utils = renderToggle();
    await openWorktreeForm(utils);
    await waitFor(() => expect(getLocalBranches).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const intent = utils.intentSlot.current!;

    let result: ComposerDraftWorktreeInterceptResult | undefined;
    await act(async () => {
      result = await intent.interceptFirstSend();
    });
    expect(result?.action).toBe("cancel");
    expect(createWorktree).not.toHaveBeenCalled();
    expect(screen.getByText("commandCenter.worktree.error.custom-location-invalid")).toBeTruthy();
  });

  it("creates under the app worktrees dir in global mode", async () => {
    mocks.settings = { worktreeLocationMode: "global" };
    mocks.platformAvailable = true;
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/Users/dev/.zcode/worktrees/alpha/zcode-sleepy-capybara",
      branchName: "zcode/sleepy-capybara",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const utils = renderToggle();
    await openWorktreeForm(utils);
    await waitFor(() => {
      expect(mocks.getAppWorktreesDir).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => expect(getLocalBranches).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const intent = utils.intentSlot.current!;

    let result: ComposerDraftWorktreeInterceptResult | undefined;
    await act(async () => {
      result = await intent.interceptFirstSend();
    });
    expect(result).toEqual({
      action: "proceed",
      executionWorktree: {
        path: "/Users/dev/.zcode/worktrees/alpha/zcode-sleepy-capybara",
        branchName: "zcode/sleepy-capybara",
      },
    });
    // The create request always uses the absolute path (global dir + repo + composed segment).
    expect(createWorktree).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      branchName: "zcode/sleepy-capybara",
      baseBranch: "main",
      targetPath: "/Users/dev/.zcode/worktrees/alpha/zcode-sleepy-capybara",
    });
    expect(utils.onOpenWorktreeDraft).not.toHaveBeenCalled();
  });

  it("blocks the first send when global storage is unavailable (non-desktop, Stage F)", async () => {
    mocks.settings = { worktreeLocationMode: "global" };
    const utils = renderToggle();
    await openWorktreeForm(utils);
    await waitFor(() => expect(getLocalBranches).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const intent = utils.intentSlot.current!;

    let result: ComposerDraftWorktreeInterceptResult | undefined;
    await act(async () => {
      result = await intent.interceptFirstSend();
    });
    expect(result?.action).toBe("cancel");
    expect(mocks.getAppWorktreesDir).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(utils.onOpenWorktreeDraft).not.toHaveBeenCalled();
    expect(
      screen.getByText("commandCenter.worktree.error.global-location-unavailable"),
    ).toBeTruthy();
  });
});
