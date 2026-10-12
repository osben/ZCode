// @vitest-environment jsdom
//
// Worktrees 设置分区（Stage D，spec «Настройки Worktree»；Stage F 全局存储）：
// - 位置 Select：切到 Custom 才显示路径输入；相对路径就地报错且不落盘（WTS-01）；
//   Global storage 选项仅在平台实现 getAppWorktreesDir（desktop）时出现；
//   预置模式示例行为固定短格式，custom 仍计算真实路径（Stage F 评审要求）；
// - 默认分支前缀：blur 提交、示例用 composeBranchName、Reset 清空；
// - 项目覆盖：仅展开的行懒加载本地分支（WTS-02 / “不逐行打 Git”），blur 提交 override，
//   Reset to global 删除条目；未知基准分支显示温和告警。
// harness 持有 settings 状态：update patch 立即回灌，模拟真实 snapshot 刷新后的重渲染。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@zcode/shared";
import { WorktreesSection } from "@/settings/WorktreesSection.js";

const mocks = vi.hoisted(() => ({
  onSelectDirectory: vi.fn(),
  getLocalBranches: vi.fn(),
  selectOnValueChange: undefined as ((value: string) => void) | undefined,
  // Stage F：platform.getAppWorktreesDir 是否可用（desktop-only）按用例切换。
  platformAvailable: false,
  getAppWorktreesDir: vi.fn(async () => "/Users/dev/.zcode/worktrees"),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () =>
    mocks.platformAvailable ? { getAppWorktreesDir: mocks.getAppWorktreesDir } : null,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values
          ? `${id}:${Object.entries(values)
              .map(([key, value]) => `${key}=${value}`)
              .join(",")}`
          : id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/ui/select.js", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReturnType<typeof createElement>;
    value: string;
    onValueChange: (value: string) => void;
  }) => {
    mocks.selectOnValueChange = onValueChange;
    return createElement(
      "div",
      { "data-testid": "worktrees-location-select", "data-value": value },
      children,
    );
  },
  SelectTrigger: ({ children, ...props }: { children: ReturnType<typeof createElement> }) =>
    createElement("button", { ...props, "data-testid": "worktrees-location-trigger" }, children),
  SelectValue: () => createElement("span"),
  SelectContent: ({ children }: { children: ReturnType<typeof createElement> }) =>
    createElement("div", null, children),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReturnType<typeof createElement>;
  }) => createElement("div", { "data-option": value }, children),
}));

const LOCAL_TABS = [{ workspacePath: "/dev/alpha", label: "alpha" }];

function renderSection(initial: Partial<AppSettings> = {}, beforeUpdate?: () => Promise<void>) {
  let applyPatch: ((patch: Partial<AppSettings>) => void) | undefined;
  const update = vi.fn(async (patch: Partial<AppSettings>) => {
    if (beforeUpdate) {
      await beforeUpdate();
    }
    applyPatch?.(patch);
  });

  function SectionHarness() {
    const [settings, setSettings] = useState<AppSettings>({
      recentProjects: [],
      ...initial,
    } as AppSettings);
    applyPatch = (patch: Partial<AppSettings>) => {
      setSettings((previous) => ({ ...previous, ...patch }));
    };
    return createElement(WorktreesSection, {
      settings,
      onUpdate: update,
      workspaceTabs: LOCAL_TABS,
      recentProjects: [],
      onSelectDirectory: mocks.onSelectDirectory,
      gitService: { getLocalBranches: mocks.getLocalBranches },
    });
  }

  return { ...render(createElement(SectionHarness)), update };
}

function selectLocationMode(mode: string) {
  act(() => {
    mocks.selectOnValueChange?.(mode);
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.selectOnValueChange = undefined;
  mocks.platformAvailable = false;
});

describe("WorktreesSection location", () => {
  it("shows no custom path field in the default sibling mode", () => {
    renderSection();
    expect(screen.getByTestId("worktrees-location-select").getAttribute("data-value")).toBe(
      "sibling",
    );
    expect(screen.queryByLabelText("settings.worktrees.location.customPath")).toBeNull();
  });

  it("hides the global storage option when the platform cannot supply the app worktrees dir", () => {
    const { container } = renderSection();
    expect(container.querySelector('[data-option="global"]')).toBeNull();
    expect(container.querySelectorAll("[data-option]")).toHaveLength(3);
  });

  it("offers global storage only on platforms with getAppWorktreesDir and shows fixed short examples", () => {
    mocks.platformAvailable = true;
    const { container, update } = renderSection();
    expect(container.querySelector('[data-option="global"]')).toBeTruthy();
    expect(container.querySelectorAll("[data-option]")).toHaveLength(4);

    // 预置模式示例行为固定短格式（Stage F 评审字符串），不依赖真实项目路径。
    expect(
      screen.getByText("settings.worktrees.location.example: example-repo-worktrees/my-branch"),
    ).toBeTruthy();

    act(() => {
      mocks.selectOnValueChange?.("inside");
    });
    expect(update).toHaveBeenCalledWith({ worktreeLocationMode: "inside" });
    expect(
      screen.getByText("settings.worktrees.location.example: example-repo/.worktrees/my-branch"),
    ).toBeTruthy();

    act(() => {
      mocks.selectOnValueChange?.("global");
    });
    expect(update).toHaveBeenCalledWith({ worktreeLocationMode: "global" });
    expect(
      screen.getByText(
        "settings.worktrees.location.example: ~/.zcode/worktrees/example-repo/my-branch",
      ),
    ).toBeTruthy();
  });

  it("computes the real example path for custom mode from an open project", () => {
    renderSection({
      worktreeLocationMode: "custom",
      worktreeCustomLocationPath: "/wt-root",
    });
    // custom 仍计算真实路径：LOCAL_TABS 的 /dev/alpha + 示例分支名 task-name。
    expect(
      screen.getByText("settings.worktrees.location.example: /wt-root/alpha-task-name"),
    ).toBeTruthy();
  });

  it("reveals the path field for custom mode and keeps relative paths un-persisted with a field error", async () => {
    const { update } = renderSection();
    selectLocationMode("custom");

    expect(update).toHaveBeenCalledWith({ worktreeLocationMode: "custom" });
    const input = await screen.findByLabelText("settings.worktrees.location.customPath");
    expect(screen.queryByText("settings.worktrees.location.customPathInvalid")).toBeNull();

    fireEvent.change(input, { target: { value: "wt/relative" } });
    fireEvent.blur(input);
    expect(screen.getByText("settings.worktrees.location.customPathInvalid")).toBeTruthy();
    expect(update).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "/wt-root" } });
    fireEvent.blur(input);
    expect(screen.queryByText("settings.worktrees.location.customPathInvalid")).toBeNull();
    expect(update).toHaveBeenCalledWith({ worktreeCustomLocationPath: "/wt-root" });
  });

  it("persists the folder chosen through the platform directory picker", async () => {
    mocks.onSelectDirectory.mockResolvedValue("/wt-picked");
    const { update } = renderSection({
      worktreeLocationMode: "custom",
      worktreeCustomLocationPath: "/old",
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.worktrees.chooseFolder" }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ worktreeCustomLocationPath: "/wt-picked" });
    });
    expect(screen.getByLabelText("settings.worktrees.location.customPath")).toHaveProperty(
      "value",
      "/wt-picked",
    );
  });
});

describe("WorktreesSection branch prefix", () => {
  it("commits on blur with a live composed example and clears via reset", () => {
    const { update } = renderSection({ worktreeBranchPrefix: "dev/" });
    const input = screen.getByLabelText("settings.worktrees.branchPrefix");
    expect(
      screen.getByText("settings.worktrees.branchPrefix.example:name=dev/task-name"),
    ).toBeTruthy();

    fireEvent.change(input, { target: { value: "feat/" } });
    // 输入过程不落盘，只有 blur 提交。
    expect(update).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(update).toHaveBeenCalledWith({ worktreeBranchPrefix: "feat/" });
    expect(
      screen.getByText("settings.worktrees.branchPrefix.example:name=feat/task-name"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "settings.worktrees.branchPrefix.reset" }));
    expect(update).toHaveBeenCalledWith({ worktreeBranchPrefix: "" });
    expect(screen.getByText("settings.worktrees.branchPrefix.example:name=task-name")).toBeTruthy();
  });
});

describe("WorktreesSection project overrides", () => {
  function stubBranches(names: string[]) {
    mocks.getLocalBranches.mockResolvedValue({
      headRefType: "branch",
      currentBranchName: names[0] ?? null,
      branches: names.map((name) => ({
        name,
        isCurrent: false,
        upstreamName: null,
        commitHash: null,
        commitTimestampMs: null,
      })),
    });
  }

  it("lists project rows without probing Git until a row is expanded", async () => {
    stubBranches(["main"]);
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));

    await waitFor(() => {
      expect(mocks.getLocalBranches).toHaveBeenCalledTimes(1);
    });
    expect(mocks.getLocalBranches).toHaveBeenCalledWith({ workspacePath: "/dev/alpha" });
  });

  it("persists an override entry on blur and deletes it on reset (WTS-02)", async () => {
    stubBranches(["main", "dev"]);
    const { update } = renderSection({
      worktreeProjectOverrides: { "/dev/alpha": { defaultBaseBranch: "dev" } },
    });
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    const baseBranchInput = await screen.findByLabelText(
      "settings.worktrees.projects.defaultBaseBranch",
    );

    // 清空基准分支并 blur：两个字段都空 → 删除 override 条目（= Reset 语义）。
    fireEvent.change(baseBranchInput, { target: { value: "" } });
    fireEvent.blur(baseBranchInput);
    expect(update).toHaveBeenCalledWith({ worktreeProjectOverrides: {} });

    // 重新输入并提交：写入单字段 override。
    fireEvent.change(baseBranchInput, { target: { value: "dev" } });
    fireEvent.blur(baseBranchInput);
    expect(update).toHaveBeenLastCalledWith({
      worktreeProjectOverrides: { "/dev/alpha": { defaultBaseBranch: "dev" } },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "settings.worktrees.projects.resetToGlobal" }),
    );
    expect(update).toHaveBeenLastCalledWith({ worktreeProjectOverrides: {} });
  });

  it("keeps an in-progress prefix draft when a base-branch save refreshes settings", async () => {
    stubBranches(["main", "dev"]);
    let finishUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    renderSection(
      { worktreeProjectOverrides: { "/dev/alpha": { defaultBaseBranch: "main" } } },
      () => updateGate,
    );
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));
    const baseBranchInput = await screen.findByLabelText(
      "settings.worktrees.projects.defaultBaseBranch",
    );
    const prefixInput = screen.getByLabelText("settings.worktrees.projects.branchPrefix");

    fireEvent.change(baseBranchInput, { target: { value: "dev" } });
    fireEvent.blur(baseBranchInput);
    fireEvent.change(prefixInput, { target: { value: "task/" } });

    await act(async () => {
      finishUpdate();
      await updateGate;
    });

    expect(prefixInput).toHaveProperty("value", "task/");
  });

  it("warns mildly when the default base branch is not among the local branches", async () => {
    stubBranches(["main"]);
    renderSection({ worktreeProjectOverrides: { "/dev/alpha": { defaultBaseBranch: "gone" } } });
    fireEvent.click(screen.getByRole("button", { name: /alpha/ }));

    await waitFor(() => {
      expect(screen.getByText("settings.worktrees.projects.defaultBaseBranchUnknown")).toBeTruthy();
    });
  });
});
