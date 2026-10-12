// @vitest-environment jsdom
//
// Empty-state “New worktree” checkbox（评审建议 6c）测试：
// - gating：仅 Desktop 本地、非 remote/conversation 的 main-tree / linked-worktree 项目显示 checkbox；
// - 意图开关：勾选展开迷你表单并注册首发拦截，取消勾选注销；
// - 发送拦截：校验（空名/非法名/已存在/Custom 位置无效/global 存储不可用）阻止发送并内联报错；
//   createWorktree 成功 → 草稿迁移请求 + App 打开契约；失败 → 不切换、错误内联；
//   target-path-exists → 提供打开现有 worktree，而不是再建目录（WT-04）；
// - global 存储（Stage F）：目标路径在 ~/.zcode/worktrees 下、预览用 ~ 前缀。
// 测试替身与 commandCenterWorktreeDialog.test.ts 保持同构（gitService 引用必须稳定）。

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
// 引用必须稳定：多个 effect 依赖 gitService，每次渲染返回新对象会造成无限重取循环。
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

// Stage F：platform.getAppWorktreesDir（global 存储目录）按用例切换；默认无平台（非 desktop）。
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
    expect(screen.getByLabelText("commandCenter.worktree.branchName")).toBeTruthy();
  });
  expect(utils.intentSlot.current?.workspaceKey).toBe(WORKSPACE_PATH);
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
    // 探测完成后 checkbox 不出现；无报错 UI。
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
  });

  it("toggles the form and the registered send intent", async () => {
    const utils = renderToggle();
    await openWorktreeForm(utils);

    // 取消勾选：表单隐藏、意图注销。
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByLabelText("commandCenter.worktree.branchName")).toBeNull();
    expect(utils.intentSlot.current).toBeNull();
  });

  it("blocks the first send with an inline error when the branch name is empty", async () => {
    const utils = renderToggle();
    await openWorktreeForm(utils);
    const intent = utils.intentSlot.current!;
    expect(intent.workspaceKey).toBe(WORKSPACE_PATH);

    let handled: boolean | undefined;
    await act(async () => {
      handled = await intent.interceptFirstSend();
    });
    expect(handled).toBe(true);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(utils.onOpenWorktreeDraft).not.toHaveBeenCalled();
    expect(screen.getByText("chat.empty.worktree.branchNameRequired")).toBeTruthy();
  });

  it.each([
    ["bad name", "commandCenter.worktree.branchName.invalid"],
    ["main", "commandCenter.worktree.branchName.exists"],
  ])("blocks the first send for invalid branch name %s", async (name, expectedErrorId) => {
    const utils = renderToggle();
    await openWorktreeForm(utils);
    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: name },
    });
    // 分支列表异步加载：等待其进入组件状态后再拦截（与真实用户的输入节奏一致）。
    await waitFor(() => expect(getLocalBranches).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const intent = utils.intentSlot.current!;

    let handled: boolean | undefined;
    await act(async () => {
      handled = await intent.interceptFirstSend();
    });
    expect(handled).toBe(true);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(screen.getByText(expectedErrorId)).toBeTruthy();
  });

  it("blocks the first send when the custom worktree location is invalid (WTS-01)", async () => {
    mocks.settings = { worktreeLocationMode: "custom" };
    const utils = renderToggle();
    await openWorktreeForm(utils);
    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    const intent = utils.intentSlot.current!;

    let handled: boolean | undefined;
    await act(async () => {
      handled = await intent.interceptFirstSend();
    });
    expect(handled).toBe(true);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(screen.getByText("commandCenter.worktree.error.custom-location-invalid")).toBeTruthy();
  });

  it("creates the worktree, redirects the draft with the transfer request, and unregisters the intent", async () => {
    mocks.settings = { worktreeBranchPrefix: "osben-" };
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/dev/alpha-worktrees/osben-task-9",
      branchName: "osben-task-9",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const utils = renderToggle();
    await openWorktreeForm(utils);
    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    // 分支列表异步加载：等待其进入组件状态后再拦截（与真实用户的输入节奏一致）。
    await waitFor(() => expect(getLocalBranches).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const intent = utils.intentSlot.current!;

    let handled: boolean | undefined;
    await act(async () => {
      handled = await intent.interceptFirstSend();
    });
    expect(handled).toBe(true);
    // 请求形状与 palette 相同：合成 prefix 后的分支名、默认 base、sibling 目标目录。
    expect(createWorktree).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      branchName: "osben-task-9",
      baseBranch: "main",
      targetPath: "/dev/alpha-worktrees/osben-task-9",
    });
    expect(utils.onOpenWorktreeDraft).toHaveBeenCalledWith("/dev/alpha-worktrees/osben-task-9");
    // 文本保留契约：迁移请求按 source/target 精确匹配（composer continuity 消费）。
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: WORKSPACE_PATH,
        targetWorkspacePath: "/dev/alpha-worktrees/osben-task-9",
      }),
    ).toBe(true);
    // 重定向后意图注销，恢复普通发送。
    expect(utils.intentSlot.current).toBeNull();
  });

  it("shows the inline issue and keeps the draft when creation is rejected", async () => {
    createWorktree.mockResolvedValue({
      ok: false,
      worktreePath: null,
      branchName: null,
      issues: [{ code: "git-unavailable", message: "git not found" }],
    } satisfies GitWorktreeCreateResult);
    const utils = renderToggle();
    await openWorktreeForm(utils);
    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    const intent = utils.intentSlot.current!;

    let handled: boolean | undefined;
    await act(async () => {
      handled = await intent.interceptFirstSend();
    });
    expect(handled).toBe(true);
    expect(screen.getByText("commandCenter.worktree.error.git-unavailable")).toBeTruthy();
    expect(utils.onOpenWorktreeDraft).not.toHaveBeenCalled();
    // 不切换 workspace：意图保持注册，composer 保留文本由发送被拦截保证。
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
          path: "/dev/alpha-worktrees/task-9",
          headCommitHash: "c",
          branchName: "task-9",
          isMain: false,
          isBare: false,
          isDetached: false,
          isCurrent: false,
        },
      ],
    });
    const utils = renderToggle();
    await openWorktreeForm(utils);
    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    const intent = utils.intentSlot.current!;

    let handled: boolean | undefined;
    await act(async () => {
      handled = await intent.interceptFirstSend();
    });
    expect(handled).toBe(true);
    expect(
      screen.getByText("commandCenter.worktree.error.target-path-exists.existing"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.openExisting" }));
    expect(utils.onOpenWorktreeDraft).toHaveBeenCalledWith("/dev/alpha-worktrees/task-9");
    expect(createWorktree).toHaveBeenCalledTimes(1);
    // 恢复入口同样带迁移请求：用户的草稿文本跟到现有 worktree。
    expect(
      consumeV4ComposerDraftWorkspaceTransferRequest({
        sourceWorkspacePath: WORKSPACE_PATH,
        targetWorkspacePath: "/dev/alpha-worktrees/task-9",
      }),
    ).toBe(true);
  });

  it("creates under the app worktrees dir (global mode) and previews it with the ~ prefix", async () => {
    mocks.settings = { worktreeLocationMode: "global" };
    mocks.platformAvailable = true;
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/Users/dev/.zcode/worktrees/alpha/task-9",
      branchName: "task-9",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const utils = renderToggle();
    await openWorktreeForm(utils);
    await waitFor(() => {
      expect(mocks.getAppWorktreesDir).toHaveBeenCalledTimes(1);
    });
    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    // 预览用 ~ 前缀显示。
    await waitFor(() => {
      expect(screen.getByText("~/.zcode/worktrees/alpha/task-9")).toBeTruthy();
    });
    const intent = utils.intentSlot.current!;

    let handled: boolean | undefined;
    await act(async () => {
      handled = await intent.interceptFirstSend();
    });
    expect(handled).toBe(true);
    // 创建请求始终用绝对路径（global 目录 + 仓库名 + 分支段）。
    expect(createWorktree).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      branchName: "task-9",
      baseBranch: "main",
      targetPath: "/Users/dev/.zcode/worktrees/alpha/task-9",
    });
    expect(utils.onOpenWorktreeDraft).toHaveBeenCalledWith(
      "/Users/dev/.zcode/worktrees/alpha/task-9",
    );
  });

  it("blocks the first send when global storage is unavailable (non-desktop, Stage F)", async () => {
    mocks.settings = { worktreeLocationMode: "global" };
    const utils = renderToggle();
    await openWorktreeForm(utils);
    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    const intent = utils.intentSlot.current!;

    let handled: boolean | undefined;
    await act(async () => {
      handled = await intent.interceptFirstSend();
    });
    expect(handled).toBe(true);
    expect(mocks.getAppWorktreesDir).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(utils.onOpenWorktreeDraft).not.toHaveBeenCalled();
    expect(
      screen.getByText("commandCenter.worktree.error.global-location-unavailable"),
    ).toBeTruthy();
  });
});
