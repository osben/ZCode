// @vitest-environment jsdom
//
// Command Center "New task in worktree" flow tests (project page → setup page → Start):
// - project page: open local tabs + recentProjects (dedup, remote/conversation excluded); picking one pushes the setup page;
// - setup page: destination / branch name input / base-branch list / Start logic;
// - Start (checkout): closes the palette and follows the App open+draft contract without touching Git;
// - Start (worktree): opens the created directory after createWorktree succeeds;
// - target-path-exists with an existing worktree for the branch: inline recovery entry opens it (WT-04);
// - an already occupied branch disables Start and requires the explicit Open worktree action;
// - global storage (Stage F): with platform.getAppWorktreesDir the target path lives under ~/.zcode/worktrees and the
//   preview uses the ~ prefix; without the platform method Start is blocked as an invalid location with an inline error.
// The Command component is mocked following commandCenterPageStackDialog.test.ts (cmdk Input stays real).

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
// References must stay stable: the setup page's data-fetch effect depends on gitService; a fresh object per render would cause an infinite refetch/re-render loop.
const stableGitService = {
  createWorktree,
  listWorktrees,
  getLocalBranches,
  getWorkspaceRepositoryInfo,
};

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  // The worktree flow targets local project paths and must use base (local Host) services, not the active workspace's services.
  useBaseWorkspaceServices: () => ({ gitService: stableGitService }),
}));

// Stage D: the useSettings snapshot is toggled per test case (prefix / override / custom location).
// Stage F: platform.getAppWorktreesDir (global storage directory) toggled per test case; no platform by default (non-desktop).
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
  // The command selection pushes the project page, then picking alpha pushes the setup page.
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

    // The open alpha tab is listed too; remote tabs do not appear; already-open recentProjects entries are not duplicated.
    expect(getRow(container, "alpha /dev/alpha")).toBeTruthy();
    expect(getRow(container, "recent-project /dev/recent-project")).toBeTruthy();
    expect(container.querySelector('[data-item-value*="/remote/beta"]')).toBeNull();

    fireEvent.click(getRow(container, "alpha /dev/alpha"));
    expect(screen.getByPlaceholderText("commandCenter.placeholder.newTaskSetup")).toBeTruthy();

    // Back to the project page (CC-01): context is preserved by the page stack.
    fireEvent.click(screen.getByLabelText("quickPick.command.goBack"));
    expect(screen.getByPlaceholderText("commandCenter.placeholder.newTaskProject")).toBeTruthy();
    expect(getRow(container, "alpha /dev/alpha")).toBeTruthy();
  });

  it("loads branches, prefills a generated branch name, and still requires one to start", async () => {
    stubRepositoryData();
    const { container } = renderWorktreeDialog();
    openSetupPage(container);

    await waitFor(() => {
      expect(getRow(container, "base main")).toBeTruthy();
    });
    // The default base branch is the current branch (CheckIcon sits inside the main row).
    expect(getRow(container, "base main").querySelectorAll("svg")).toHaveLength(1);

    // 2026-10-13 spec: the field arrives pre-filled with a generated name, so Start is
    // enabled right away; clearing the field re-enables the emptiness gate.
    const branchNameInput = screen.getByLabelText(
      "commandCenter.worktree.branchName",
    ) as HTMLInputElement;
    await waitFor(() => {
      expect(branchNameInput.value).toMatch(/^[a-z]+-[a-z]+$/);
    });
    expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
      "disabled",
      false,
    );

    fireEvent.change(branchNameInput, { target: { value: "" } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        true,
      );
    });

    fireEvent.change(branchNameInput, { target: { value: "task-9" } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
  });

  it("keeps Start disabled for an occupied branch until Open worktree is selected", async () => {
    stubRepositoryData();
    getLocalBranches.mockResolvedValue({
      headRefType: "branch",
      currentBranchName: "main",
      branches: [
        {
          name: "main",
          isCurrent: true,
          upstreamName: null,
          commitHash: "a",
          commitTimestampMs: 1,
        },
        {
          name: "zcode/task-9",
          isCurrent: false,
          upstreamName: null,
          commitHash: "b",
          commitTimestampMs: 1,
        },
      ],
    });
    listWorktrees.mockResolvedValue({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [
        {
          path: "/dev/alpha-worktrees/zcode-task-9",
          headCommitHash: "c",
          branchName: "zcode/task-9",
          isMain: false,
          isBare: false,
          isDetached: false,
          isCurrent: false,
        },
      ],
    });
    const { container, onOpenChange, onCreateTaskInWorkspace } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => expect(getRow(container, "base main")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
      target: { value: "task-9" },
    });

    const start = screen.getByRole("button", { name: "commandCenter.worktree.start" });
    await waitFor(() => expect(start).toHaveProperty("disabled", true));
    fireEvent.click(start);
    expect(createWorktree).not.toHaveBeenCalled();
    expect(onCreateTaskInWorkspace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.openExisting" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreateTaskInWorkspace).toHaveBeenCalledWith(
      "/dev/alpha-worktrees/zcode-task-9",
      undefined,
    );
  });

  it("keeps Start available when only the optional worktree list fails", async () => {
    stubRepositoryData();
    listWorktrees.mockRejectedValue(new Error("worktree list unavailable"));
    const { container } = renderWorktreeDialog();
    openSetupPage(container);
    await waitFor(() => expect(getRow(container, "base main")).toBeTruthy());
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
      worktreePath: "/dev/alpha-worktrees/zcode-task-9",
      branchName: "zcode/task-9",
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
    // Branch rows and loading=false may land in two commits; wait until Start is actually enabled before clicking.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));

    // The default zcode/ prefix composes into the branch name and target path (2026-10-13).
    await waitFor(() => {
      expect(createWorktree).toHaveBeenCalledWith({
        workspacePath: "/dev/alpha",
        branchName: "zcode/task-9",
        baseBranch: "main",
        targetPath: "/dev/alpha-worktrees/zcode-task-9",
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // A new worktree is a new workspace: no identity is passed (explicit undefined).
    expect(onCreateTaskInWorkspace).toHaveBeenCalledWith(
      "/dev/alpha-worktrees/zcode-task-9",
      undefined,
    );
  });

  it("keeps the newer Start busy when an older request finishes after reopening the palette", async () => {
    stubRepositoryData();
    let resolveOld!: (result: GitWorktreeCreateResult) => void;
    let resolveNew!: (result: GitWorktreeCreateResult) => void;
    const oldRequest = new Promise<GitWorktreeCreateResult>((resolve) => {
      resolveOld = resolve;
    });
    const newRequest = new Promise<GitWorktreeCreateResult>((resolve) => {
      resolveNew = resolve;
    });
    createWorktree.mockReturnValueOnce(oldRequest).mockReturnValueOnce(newRequest);
    const props = {
      open: true,
      commands: [WORKTREE_COMMAND],
      workspaceAbsPath: "/dev/alpha",
      workspaceIdentity: "alpha-id",
      workspaceTabs: LOCAL_TABS,
      onOpenChange: vi.fn(),
      onSelectTask: vi.fn(),
      onCreateTaskInWorkspace: vi.fn(),
      onOpenCodeViewer: vi.fn(),
    };
    const view = render(createElement(CommandCenterDialog, props));

    const enterTask = async () => {
      openSetupPage(view.container);
      await waitFor(() => expect(getRow(view.container, "base main")).toBeTruthy());
      fireEvent.change(screen.getByLabelText("commandCenter.worktree.branchName"), {
        target: { value: "task-9" },
      });
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
          "disabled",
          false,
        );
      });
    };

    await enterTask();
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));
    await waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(1));

    view.rerender(createElement(CommandCenterDialog, { ...props, open: false }));
    view.rerender(createElement(CommandCenterDialog, props));
    await enterTask();
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));
    await waitFor(() => expect(createWorktree).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveOld({
        ok: true,
        worktreePath: "/dev/alpha-worktrees/old",
        branchName: "task-9",
        issues: [],
      });
      await oldRequest;
    });

    expect(screen.getByRole("button", { name: /commandCenter\.worktree\.start/ })).toHaveProperty(
      "disabled",
      true,
    );

    await act(async () => {
      resolveNew({
        ok: true,
        worktreePath: "/dev/alpha-worktrees/new",
        branchName: "task-9",
        issues: [],
      });
      await newRequest;
    });
  });

  it("target-path-exists with an existing worktree offers recovery instead of a second directory", async () => {
    stubRepositoryData();
    createWorktree.mockResolvedValue({
      ok: false,
      worktreePath: null,
      branchName: null,
      issues: [{ code: "target-path-exists", message: "Target path already exists." }],
    } satisfies GitWorktreeCreateResult);
    listWorktrees
      .mockResolvedValueOnce({ isGitAvailable: true, isRepository: true, worktrees: [] })
      .mockResolvedValue({
        isGitAvailable: true,
        isRepository: true,
        worktrees: [
          {
            path: "/dev/alpha-worktrees/zcode-task-9",
            headCommitHash: "c",
            branchName: "zcode/task-9",
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
    // Branch rows and loading=false may land in two commits; wait until Start is actually enabled before clicking.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
    // Wrap the click in act to flush the whole createWorktree → listWorktrees recovery chain.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));
    });

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onCreateTaskInWorkspace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.openExisting" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreateTaskInWorkspace).toHaveBeenCalledWith(
      "/dev/alpha-worktrees/zcode-task-9",
      undefined,
    );
    // The recovery path does not fire a second createWorktree (WT-04).
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
    // The default base branch comes from the override: the dev row is checked, the main row is not.
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
      worktreePath: "/wt-root/alpha-zcode-task-9",
      branchName: "zcode/task-9",
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
      expect(screen.getByText("/wt-root/alpha-zcode-task-9")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));

    await waitFor(() => {
      expect(createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "zcode/task-9",
          targetPath: "/wt-root/alpha-zcode-task-9",
        }),
      );
    });
  });

  it("blocks Start with an inline error when the custom location is not an absolute path", async () => {
    stubRepositoryData();
    mocks.settings = {
      recentProjects: [],
      worktreeLocationMode: "custom",
      // Relative path: computeWorktreeTargetPath returns null and the target path spot shows the inline error.
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
      worktreePath: "/Users/dev/.zcode/worktrees/alpha/zcode-task-9",
      branchName: "zcode/task-9",
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
    // The preview shows the ~ prefix; the title tooltip still shows the absolute path.
    await waitFor(() => {
      expect(screen.getByText("~/.zcode/worktrees/alpha/zcode-task-9")).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "commandCenter.worktree.start" })).toHaveProperty(
        "disabled",
        false,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "commandCenter.worktree.start" }));

    // The create request always uses the absolute path (composed name flattened to a segment).
    await waitFor(() => {
      expect(createWorktree).toHaveBeenCalledWith({
        workspacePath: "/dev/alpha",
        branchName: "zcode/task-9",
        baseBranch: "main",
        targetPath: "/Users/dev/.zcode/worktrees/alpha/zcode-task-9",
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onCreateTaskInWorkspace).toHaveBeenCalledWith(
      "/Users/dev/.zcode/worktrees/alpha/zcode-task-9",
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
