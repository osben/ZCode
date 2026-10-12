// @vitest-environment jsdom
//
// Command Center “New task in worktree” 流程测试（project 页 → setup 页 → Start）：
// - project 页：打开的本地 tab + recentProjects（去重、排除 remote/conversation），选择后推入 setup 页；
// - setup 页：destination / 分支名输入 / base-branch 列表 / Start 逻辑；
// - Start（checkout）：关闭面板并走 App 打开+draft 契约，不触发 Git；
// - Start（worktree）：createWorktree 成功后打开创建的目录；
// - target-path-exists 且该分支已有 worktree：内联展示恢复入口，打开现有目录而不是再建（WT-04）；
// - global 存储（Stage F）：平台提供 getAppWorktreesDir 时目标路径在 ~/.zcode/worktrees 下、
//   预览用 ~ 前缀；无平台方法时按无效位置阻塞 Start 并内联报错。
// Command 组件按 commandCenterPageStackDialog.test.ts 的先例 mock（cmdk Input 保持真实）。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitWorktreeCreateResult } from "@zcode/shared";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import type { QuickPickCommand } from "@/quickpick/quickPickCommands.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

vi.mock("@/components/ui/command.js", async () => {
  const { Command } = await vi.importActual<typeof import("cmdk")>("cmdk");
  const fake = ({ children, ...props }: { children: ReactNode }) =>
    createElement("div", props, children);

  return {
    Command,
    CommandDialog: fake,
    CommandEmpty: fake,
    CommandGroup: fake,
    CommandItem: ({
      children,
      onSelect,
      value,
      ...props
    }: {
      children: ReactNode;
      onSelect?: () => void;
      value?: string;
    }) =>
      createElement(
        "div",
        { ...props, "data-item-value": value ?? "", onClick: onSelect },
        children,
      ),
    CommandList: fake,
    CommandShortcut: ({ children, ...props }: { children: ReactNode }) =>
      createElement("span", props, children),
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: () => ({
    items: [],
    loading: false,
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    fileService: {
      listWorkspaceFiles: vi.fn(async () => []),
    },
  }),
}));

const createWorktree = vi.fn();
const listWorktrees = vi.fn();
const getLocalBranches = vi.fn();
const getWorkspaceRepositoryInfo = vi.fn();
// 引用必须稳定：setup 页的 data-fetch effect 依赖 gitService，每次渲染返回新对象会造成无限重取/重渲染循环。
const stableGitService = {
  createWorktree,
  listWorktrees,
  getLocalBranches,
  getWorkspaceRepositoryInfo,
};

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  // worktree flow 面向本地项目路径，必须走 base（本地 Host）服务而不是当前活动 workspace 的服务。
  useBaseWorkspaceServices: () => ({ gitService: stableGitService }),
}));

// Stage D：useSettings 快照按用例切换（prefix / override / 自定义位置）。
// Stage F：platform.getAppWorktreesDir（global 存储目录）按用例切换；默认无平台（非 desktop）。
const mocks = vi.hoisted(() => ({
  settings: { recentProjects: ["/dev/recent-project"] } as Record<string, unknown>,
  platformAvailable: false,
  getAppWorktreesDir: vi.fn(async () => "/Users/dev/.zcode/worktrees"),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () =>
    mocks.platformAvailable ? { getAppWorktreesDir: mocks.getAppWorktreesDir } : null,
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: mocks.settings,
    loading: false,
    error: null,
  }),
}));

vi.mock("@/workspace-file-search/fetchWorkspaceFileEntries.js", () => ({
  fetchWorkspaceFileEntriesPacked: vi.fn(async () => ""),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

const WORKTREE_COMMAND: QuickPickCommand = {
  id: "new-task-worktree",
  sectionId: "suggested",
  titleId: "quickPick.command.newTaskWorktree",
  icon: "worktree",
  keywords: ["worktree", "任务"],
  page: {
    id: "new-task-project",
    placeholderId: "commandCenter.placeholder.newTaskProject",
  },
};

const LOCAL_TABS: WorkspaceTabState[] = [
  {
    id: "tab-alpha" as WorkspaceTabState["id"],
    kind: "workspace",
    label: "alpha",
    workspacePath: "/dev/alpha",
    workspaceIdentity: "alpha-id",
  },
  {
    id: "tab-remote" as WorkspaceTabState["id"],
    kind: "workspace",
    label: "remote",
    workspacePath: "/remote/beta",
    remoteSessionId: "session-1",
  },
];

function stubRepositoryData() {
  getWorkspaceRepositoryInfo.mockResolvedValue({
    workspacePath: "/dev/alpha",
    kind: "main-tree",
    isGitAvailable: true,
  });
  getLocalBranches.mockResolvedValue({
    headRefType: "branch",
    currentBranchName: "main",
    branches: [
      { name: "main", isCurrent: true, upstreamName: null, commitHash: "a", commitTimestampMs: 1 },
      { name: "dev", isCurrent: false, upstreamName: null, commitHash: "b", commitTimestampMs: 1 },
    ],
  });
}

function renderWorktreeDialog() {
  const onOpenChange = vi.fn();
  const onCreateTaskInWorkspace = vi.fn();
  const utils = render(
    createElement(CommandCenterDialog, {
      open: true,
      commands: [WORKTREE_COMMAND],
      workspaceAbsPath: "/dev/alpha",
      workspaceIdentity: "alpha-id",
      workspaceTabs: LOCAL_TABS,
      onOpenChange,
      onSelectTask: vi.fn(),
      onCreateTaskInWorkspace,
      onOpenCodeViewer: vi.fn(),
    }),
  );
  return { ...utils, onOpenChange, onCreateTaskInWorkspace };
}

function getRow(container: HTMLElement, value: string) {
  const row = container.querySelector(`[data-item-value^="${value}"]`);
  expect(row, `row for ${value}`).not.toBeNull();
  return row as HTMLElement;
}

function openSetupPage(container: HTMLElement) {
  // 命令选择推入 project 页，再选择 alpha 项目推入 setup 页。
  fireEvent.click(getRow(container, "quickPick.command.newTaskWorktree"));
  fireEvent.click(getRow(container, "alpha /dev/alpha"));
  expect(screen.getByPlaceholderText("commandCenter.placeholder.newTaskSetup")).toBeTruthy();
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.settings = { recentProjects: ["/dev/recent-project"] };
  mocks.platformAvailable = false;
});

describe("CommandCenterDialog worktree flow", () => {
  it("lists open local tabs and unopened recent projects, then pushes the setup page", () => {
    const { container } = renderWorktreeDialog();
    fireEvent.click(getRow(container, "quickPick.command.newTaskWorktree"));

    // 打开的 alpha 一起列出；remote tab 不出现；recentProjects 中已打开的不重复。
    expect(getRow(container, "alpha /dev/alpha")).toBeTruthy();
    expect(getRow(container, "recent-project /dev/recent-project")).toBeTruthy();
    expect(container.querySelector('[data-item-value*="/remote/beta"]')).toBeNull();

    fireEvent.click(getRow(container, "alpha /dev/alpha"));
    expect(screen.getByPlaceholderText("commandCenter.placeholder.newTaskSetup")).toBeTruthy();

    // 返回 project 页（CC-01）：上下文由 page-stack 保留。
    fireEvent.click(screen.getByLabelText("quickPick.command.goBack"));
    expect(screen.getByPlaceholderText("commandCenter.placeholder.newTaskProject")).toBeTruthy();
    expect(getRow(container, "alpha /dev/alpha")).toBeTruthy();
  });

  it("loads branches, defaults the base branch to HEAD, and requires a branch name", async () => {
    stubRepositoryData();
    const { container } = renderWorktreeDialog();
    openSetupPage(container);

    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });
    // 默认 base branch 是当前分支（CheckIcon 存在于 main 行内）。
    expect(getRow(container, "base main").querySelectorAll("svg")).toHaveLength(1);

    const startButton = screen.getByRole("button", { name: "commandCenter.worktree.start" });
    expect(startButton).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
  });

  it("start with current checkout closes the palette and opens the workspace without Git calls", async () => {
    stubRepositoryData();
    const { container, onOpenChange, onCreateTaskInWorkspace } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });

    fireEvent.click(getRow(container, "destination checkout"));
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreateTaskInWorkspace).toHaveBeenCalledWith("/dev/alpha", "alpha-id");
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it("start with a new worktree creates the sibling directory and opens the created path", async () => {
    stubRepositoryData();
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/dev/alpha-worktrees/task-9",
      branchName: "task-9",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const { container, onOpenChange, onCreateTaskInWorkspace } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    // 分支行渲染与 loading=false 可能分两次提交；点击前等待 Start 真正可用。
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));

    await waitFor(() => {
      expect(createWorktree).toHaveBeenCalledWith({
        workspacePath: "/dev/alpha",
        branchName: "task-9",
        baseBranch: "main",
        targetPath: "/dev/alpha-worktrees/task-9",
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // 新 worktree 是新的 workspace：不传 identity（显式 undefined）。
    expect(onCreateTaskInWorkspace).toHaveBeenCalledWith("/dev/alpha-worktrees/task-9", undefined);
  });

  it("target-path-exists with an existing worktree offers recovery instead of a second directory", async () => {
    stubRepositoryData();
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
    const { container, onOpenChange, onCreateTaskInWorkspace } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    // 分支行渲染与 loading=false 可能分两次提交；点击前等待 Start 真正可用。
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
    // act 包裹点击，冲刷 createWorktree → listWorktrees 恢复查询的整条异步链。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));
    });

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onCreateTaskInWorkspace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.openExisting" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreateTaskInWorkspace).toHaveBeenCalledWith("/dev/alpha-worktrees/task-9", undefined);
    // 恢复路径不触发第二次 createWorktree（WT-04）。
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });
});

describe("CommandCenterDialog worktree flow with worktree settings (Stage D)", () => {
  it("composes the global branch prefix into the final name, preview and target path", async () => {
    stubRepositoryData();
    mocks.settings = {
      recentProjects: ["/dev/recent-project"],
      worktreeBranchPrefix: "dev/",
    };
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/dev/alpha-worktrees/dev-task-9",
      branchName: "dev/task-9",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const { container } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    await waitFor(() => {
      expect(screen.getByText("commandCenter.worktree.branchName.final")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));

    await waitFor(() => {
      expect(createWorktree).toHaveBeenCalledWith({
        workspacePath: "/dev/alpha",
        branchName: "dev/task-9",
        baseBranch: "main",
        targetPath: "/dev/alpha-worktrees/dev-task-9",
      });
    });
  });

  it("lets the project prefix override win over the global prefix (WTS-02)", async () => {
    stubRepositoryData();
    mocks.settings = {
      recentProjects: [],
      worktreeBranchPrefix: "global/",
      worktreeProjectOverrides: { "/dev/alpha": { branchPrefix: "ov-" } },
    };
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/dev/alpha-worktrees/ov-task-9",
      branchName: "ov-task-9",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const { container } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));

    await waitFor(() => {
      expect(createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "ov-task-9",
          targetPath: "/dev/alpha-worktrees/ov-task-9",
        }),
      );
    });
  });

  it("prefers the project override's default base branch when it exists in the loaded list", async () => {
    stubRepositoryData();
    mocks.settings = {
      recentProjects: [],
      worktreeProjectOverrides: { "/dev/alpha": { defaultBaseBranch: "dev" } },
    };
    const { container } = renderWorktreeDialog();
    openSetupPage(container);

    await waitFor(() => {
      expect(getRow(container, "base dev")).toBeTruthy();
    });
    // 默认基准分支来自 override：dev 行带选中标记，main 行没有。
    expect(getRow(container, "base dev").querySelectorAll("svg")).toHaveLength(1);
    expect(getRow(container, "base main").querySelectorAll("svg")).toHaveLength(0);
  });

  it("uses the custom location for the target path", async () => {
    stubRepositoryData();
    mocks.settings = {
      recentProjects: [],
      worktreeLocationMode: "custom",
      worktreeCustomLocationPath: "/wt-root",
    };
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/wt-root/alpha-task-9",
      branchName: "task-9",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const { container } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    await waitFor(() => {
      expect(screen.getByText("/wt-root/alpha-task-9")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));

    await waitFor(() => {
      expect(createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ branchName: "task-9", targetPath: "/wt-root/alpha-task-9" }),
      );
    });
  });

  it("blocks Start with an inline error when the custom location is not an absolute path", async () => {
    stubRepositoryData();
    mocks.settings = {
      recentProjects: [],
      worktreeLocationMode: "custom",
      // 相对路径：computeWorktreeTargetPath 返回 null，target path 位置显示就地错误。
      worktreeCustomLocationPath: "wt/relative",
    };
    const { container, onOpenChange, onCreateTaskInWorkspace } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    await waitFor(() => {
      expect(screen.getByText("commandCenter.worktree.error.custom-location-invalid")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));
    expect(createWorktree).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onCreateTaskInWorkspace).not.toHaveBeenCalled();
  });
});

describe("CommandCenterDialog worktree flow with the global storage mode (Stage F)", () => {
  it("creates under the app worktrees dir and previews it with the ~ prefix", async () => {
    stubRepositoryData();
    mocks.platformAvailable = true;
    mocks.settings = {
      recentProjects: [],
      worktreeLocationMode: "global",
    };
    createWorktree.mockResolvedValue({
      ok: true,
      worktreePath: "/Users/dev/.zcode/worktrees/alpha/task-9",
      branchName: "task-9",
      issues: [],
    } satisfies GitWorktreeCreateResult);
    const { container, onOpenChange, onCreateTaskInWorkspace } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => {
      expect(mocks.getAppWorktreesDir).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    // 预览用 ~ 前缀显示；title 悬浮仍是绝对路径。
    await waitFor(() => {
      expect(screen.getByText("~/.zcode/worktrees/alpha/task-9")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));

    // 创建请求始终用绝对路径。
    await waitFor(() => {
      expect(createWorktree).toHaveBeenCalledWith({
        workspacePath: "/dev/alpha",
        branchName: "task-9",
        baseBranch: "main",
        targetPath: "/Users/dev/.zcode/worktrees/alpha/task-9",
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreateTaskInWorkspace).toHaveBeenCalledWith(
      "/Users/dev/.zcode/worktrees/alpha/task-9",
      undefined,
    );
  });

  it("blocks Start with the global-location-unavailable error when the platform has no app worktrees dir", async () => {
    stubRepositoryData();
    mocks.settings = {
      recentProjects: [],
      worktreeLocationMode: "global",
    };
    const { container, onOpenChange, onCreateTaskInWorkspace } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });
    await waitFor(() => {
      expect(
        screen.getByText("commandCenter.worktree.error.global-location-unavailable"),
      ).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));
    expect(mocks.getAppWorktreesDir).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onCreateTaskInWorkspace).not.toHaveBeenCalled();
  });
});
