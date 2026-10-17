// @vitest-environment jsdom
//
// Empty-state "New worktree" checkbox tests (specs/composer-worktree-setup-steps.md):
// - gating: only Desktop local, non-remote/conversation main-tree / linked-worktree projects
//   render the checkbox;
// - intent switch: checking registers the setup intent, unchecking unregisters (and withdraws an
//   in-flight pipeline);
// - beginCreation: queue-time validation failures (custom location invalid / global storage
//   unavailable) fail synchronously into the pipeline store; a still-loading branch list no longer
//   blocks (base = HEAD + note); success → ready; rejection → failed; WT-04 target-path-exists →
//   ready with the existing worktree in place (no draft transfer);
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
import { ComposerDraftWorktreeIntentContext } from "@/v4/composer/composerDraftWorktreeIntent.js";
import type { ComposerDraftWorktreeIntentSlot } from "@/v4/composer/composerDraftWorktreeIntent.js";
import {
  clearV4ComposerDraftWorkspaceTransferRequest,
  consumeV4ComposerDraftWorkspaceTransferRequest,
} from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import {
  selectComposerWorktreePipeline,
  useComposerWorktreePipelineStore,
} from "@/store/composerWorktreePipelineStore.js";

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
  verifyWorktreeUsable: vi.fn(async () => ({ ok: true })),
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

function renderToggle({ workspaceTabs = [LOCAL_TAB], isDesktop = true } = {}) {
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
      }),
    ),
  );
  return { ...utils, intentSlot };
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

describe("ChatEmptyWorktreeTaskToggle intent + setup pipeline", () => {
  // Host-reserved session identity stub: the real prepareSession lives in SessionPane.
  const prepareSession = async () => "session-1";

  beforeEach(() => {
    stubRepository();
    stubBranches();
    // Deterministic generated name: adjective[0] ("sleepy") + first animal ("capybara").
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useComposerWorktreePipelineStore.setState({ pipelineByWorkspaceKey: {} });
  });

  it("registers the setup intent on check and unregisters it on uncheck (no mini-form)", async () => {
    const utils = renderToggle();
    await openWorktreeForm(utils);
    expect(screen.queryByLabelText("commandCenter.worktree.branchName")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(utils.intentSlot.current).toBeNull();
  });

  it("beginCreation queues a creating pipeline entry and starts the runner (no blocking await)", async () => {
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
      branchName: "zcode/sleepy-capybara",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const utils = renderToggle();
    await openWorktreeForm(utils);
    await waitFor(() => expect(getLocalBranches).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const intent = utils.intentSlot.current!;

    let result: { ok: boolean; sessionId?: string } | undefined;
    await act(async () => {
      result = await intent.beginCreation("first prompt", prepareSession);
    });
    expect(result).toEqual({ ok: true, sessionId: "session-1" });
    // Generated <adjective>-<noun> + default prefix, current branch as base, sibling target.
    expect(createWorktree).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      branchName: "zcode/sleepy-capybara",
      baseBranch: "main",
      targetPath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
    });
    const pipeline = selectComposerWorktreePipeline(
      useComposerWorktreePipelineStore.getState(),
      WORKSPACE_PATH,
    );
    expect(pipeline).toMatchObject({
      status: "ready",
      worktreePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
      queuedPromptPreview: "first prompt",
    });
    // No workspace switch, no draft transfer: the session lives in the current project.
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: WORKSPACE_PATH,
        targetWorkspacePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
      }),
    ).toBe(false);
  });

  it("a still-loading branch list no longer blocks: base defaults to HEAD with a note", async () => {
    getLocalBranches.mockReturnValue(new Promise(() => {}));
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
      branchName: "zcode/sleepy-capybara",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const utils = renderToggle();
    await openWorktreeForm(utils);
    const intent = utils.intentSlot.current!;

    let result: { ok: boolean; sessionId?: string } | undefined;
    await act(async () => {
      result = await intent.beginCreation("prompt", prepareSession);
    });
    expect(result).toEqual({ ok: true, sessionId: "session-1" });
    // No baseBranch in the request: the server defaults to HEAD.
    expect(createWorktree).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      branchName: "zcode/sleepy-capybara",
      targetPath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
    });
    const pipeline = selectComposerWorktreePipeline(
      useComposerWorktreePipelineStore.getState(),
      WORKSPACE_PATH,
    );
    expect(pipeline?.params).toMatchObject({ baseFromHeadDefault: true });
    // Settle the in-flight runner so the module-level promise map does not leak into the next test.
    await act(async () => {});
  });

  it("creation rejection lands in the store as failed; the intent stays registered", async () => {
    createWorktree.mockResolvedValue({
      ok: false,
      worktreePath: null,
      branchName: null,
      issues: [{ code: "git-unavailable", message: "git not found" }],
    } satisfies GitWorktreeCreateResult);
    const utils = renderToggle();
    await openWorktreeForm(utils);
    const intent = utils.intentSlot.current!;

    await act(async () => {
      await intent.beginCreation("prompt", prepareSession);
    });
    const pipeline = selectComposerWorktreePipeline(
      useComposerWorktreePipelineStore.getState(),
      WORKSPACE_PATH,
    );
    expect(pipeline?.status).toBe("failed");
    expect(pipeline?.failureMessage).toBeTruthy();
    expect(utils.intentSlot.current).not.toBeNull();
  });

  it("target-path-exists consumes the existing worktree in place (WT-04, no draft transfer)", async () => {
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
    const intent = utils.intentSlot.current!;

    await act(async () => {
      await intent.beginCreation("prompt", prepareSession);
    });
    const pipeline = selectComposerWorktreePipeline(
      useComposerWorktreePipelineStore.getState(),
      WORKSPACE_PATH,
    );
    expect(pipeline).toMatchObject({
      status: "ready",
      existing: true,
      worktreePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
    });
    expect(createWorktree).toHaveBeenCalledTimes(1);
    // Unified recovery: no draft transfer request for the existing directory.
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: WORKSPACE_PATH,
        targetWorkspacePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
      }),
    ).toBe(false);
  });

  it("beginCreation fails synchronously when the custom worktree location is invalid (WTS-01)", async () => {
    mocks.settings = { worktreeLocationMode: "custom" };
    const utils = renderToggle();
    await openWorktreeForm(utils);
    const intent = utils.intentSlot.current!;

    let result: { ok: boolean; sessionId?: string } | undefined;
    await act(async () => {
      result = await intent.beginCreation("prompt", prepareSession);
    });
    expect(result).toEqual({ ok: false });
    expect(createWorktree).not.toHaveBeenCalled();
    const pipeline = selectComposerWorktreePipeline(
      useComposerWorktreePipelineStore.getState(),
      WORKSPACE_PATH,
    );
    expect(pipeline?.status).toBe("failed");
    expect(pipeline?.failureMessage).toBe("commandCenter.worktree.error.custom-location-invalid");
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

    await act(async () => {
      await intent.beginCreation("prompt", prepareSession);
    });
    // The create request always uses the absolute path (global dir + repo + composed segment).
    expect(createWorktree).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      branchName: "zcode/sleepy-capybara",
      baseBranch: "main",
      targetPath: "/Users/dev/.zcode/worktrees/alpha/zcode-sleepy-capybara",
    });
  });

  it("beginCreation fails synchronously when global storage is unavailable (Stage F)", async () => {
    mocks.settings = { worktreeLocationMode: "global" };
    const utils = renderToggle();
    await openWorktreeForm(utils);
    const intent = utils.intentSlot.current!;

    let result: { ok: boolean; sessionId?: string } | undefined;
    await act(async () => {
      result = await intent.beginCreation("prompt", prepareSession);
    });
    expect(result).toEqual({ ok: false });
    expect(mocks.getAppWorktreesDir).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    const pipeline = selectComposerWorktreePipeline(
      useComposerWorktreePipelineStore.getState(),
      WORKSPACE_PATH,
    );
    expect(pipeline?.failureMessage).toBe(
      "commandCenter.worktree.error.global-location-unavailable",
    );
  });

  it("unchecking mid-creation withdraws: the result lands orphaned and reusable", async () => {
    let resolveCreate: (value: GitWorktreeCreateResult) => void = () => {};
    createWorktree.mockReturnValue(
      new Promise<GitWorktreeCreateResult>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const utils = renderToggle();
    await openWorktreeForm(utils);
    const intent = utils.intentSlot.current!;
    await act(async () => {
      await intent.beginCreation("prompt", prepareSession);
    });
    expect(
      selectComposerWorktreePipeline(useComposerWorktreePipelineStore.getState(), WORKSPACE_PATH)
        ?.status,
    ).toBe("creating");

    // Uncheck while the git call is in flight: the queued send is withdrawn…
    fireEvent.click(screen.getByRole("checkbox"));
    expect(utils.intentSlot.current).toBeNull();
    expect(
      selectComposerWorktreePipeline(useComposerWorktreePipelineStore.getState(), WORKSPACE_PATH)
        ?.orphaned,
    ).toBe(true);
    // …but the call finishes and the worktree is left on disk, marked ready+orphaned (reusable).
    await act(async () => {
      resolveCreate({
        ok: true,
        worktreePath: "/dev/alpha-worktrees/zcode-sleepy-capybara",
        branchName: "zcode/sleepy-capybara",
        issues: [],
      });
    });
    expect(
      selectComposerWorktreePipeline(useComposerWorktreePipelineStore.getState(), WORKSPACE_PATH),
    ).toMatchObject({ status: "ready", orphaned: true });
  });
});
