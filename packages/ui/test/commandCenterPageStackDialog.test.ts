// @vitest-environment jsdom
//
// Command Center page-stack 行为测试（Copilot 式 pushPage/popPage）：
// - 带 page 的命令：选择后压入子页面（placeholder 切换、scope 隐藏），而不是关闭对话框；
// - 返回：恢复上一页（根）的查询上下文并把焦点交还搜索框；
// - valueList 选择：立即应用取值并回到根，面板保持打开；
// - 无 page 的普通命令仍走“执行并关闭”的旧路径。
// Command 组件按 gitBranchSwitcher.test.ts 的先例 mock 掉（cmdk 的 Input 保持真实以覆盖键盘交互）。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandCenterDialog } from "@/command-center/CommandCenterDialog.js";
import type { QuickPickCommand } from "@/quickpick/quickPickCommands.js";

vi.mock("@/components/ui/command.js", async () => {
  // 保留真实的 cmdk Command 根：CommandPrimitive.Input 依赖 cmdk 的内部 context，
  // 完全 mock 会在 Input 挂载时崩溃；列表/条目组件仍按 gitBranchSwitcher.test.ts 的先例 mock。
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

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ gitService: {} }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: null,
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

const PAGE_COMMAND_ID = "theme-mode";
const PAGE_PLACEHOLDER_ID = "commandCenter.placeholder.themeMode";

function createCommands(onSelectValue: (value: string) => void): QuickPickCommand[] {
  return [
    {
      id: "plain-command",
      sectionId: "configure",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings"],
      run: () => {},
    },
    {
      id: PAGE_COMMAND_ID,
      sectionId: "configure",
      titleId: "quickPick.command.themeMode",
      icon: "themeMode",
      keywords: ["theme", "mode", "主题", "模式"],
      page: {
        id: PAGE_COMMAND_ID,
        placeholderId: PAGE_PLACEHOLDER_ID,
      },
      valueList: {
        options: [
          { value: "system", labelId: "settings.themeMode.system", keywords: ["system", "系统"] },
          { value: "dark", labelId: "settings.themeMode.dark", keywords: ["dark", "深色"] },
        ],
        current: "dark",
        onSelect: onSelectValue,
      },
    },
  ];
}

function renderDialog(commands: QuickPickCommand[]) {
  const onOpenChange = vi.fn();
  const utils = render(
    createElement(CommandCenterDialog, {
      open: true,
      commands,
      workspaceAbsPath: "/workspace",
      workspaceTabs: [],
      onOpenChange,
      onSelectTask: vi.fn(),
      onCreateTaskInWorkspace: vi.fn(),
      onOpenCodeViewer: vi.fn(),
    }),
  );
  return { ...utils, onOpenChange };
}

function getCommandItem(container: HTMLElement, value: string) {
  const item = container.querySelector(`[data-item-value^="${value}"]`);
  expect(item, `command item for ${value}`).not.toBeNull();
  return item as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe("CommandCenterDialog page stack", () => {
  it("pushes a sub-page instead of closing and switches the placeholder", () => {
    const { container, onOpenChange } = renderDialog(createCommands(vi.fn()));

    expect(screen.getByPlaceholderText("commandCenter.placeholder")).toBeTruthy();
    expect(screen.getByRole("tablist")).toBeTruthy();

    fireEvent.click(getCommandItem(container, "quickPick.command.themeMode"));

    expect(screen.getByPlaceholderText(PAGE_PLACEHOLDER_ID)).toBeTruthy();
    // 子页面不显示根级 scope，也不关闭对话框。
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    // valueList 选项按 labelId 渲染，当前值带选中标记（唯一的 svg 是 CheckIcon）。
    const darkRow = getCommandItem(container, "settings.themeMode.dark");
    expect(darkRow.querySelectorAll("svg")).toHaveLength(1);
    expect(
      getCommandItem(container, "settings.themeMode.system").querySelectorAll("svg"),
    ).toHaveLength(0);
  });

  it("restores the previous query and focuses the search input on back", () => {
    const { container } = renderDialog(createCommands(vi.fn()));
    const input = screen.getByPlaceholderText("commandCenter.placeholder") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "theme" } });
    fireEvent.click(getCommandItem(container, "quickPick.command.themeMode"));
    const pageInput = screen.getByPlaceholderText(PAGE_PLACEHOLDER_ID) as HTMLInputElement;
    expect(pageInput.value).toBe("");
    fireEvent.change(pageInput, { target: { value: "dark" } });

    fireEvent.click(screen.getByLabelText("quickPick.command.goBack"));

    const restoredInput = screen.getByPlaceholderText(
      "commandCenter.placeholder",
    ) as HTMLInputElement;
    expect(restoredInput.value).toBe("theme");
    expect(document.activeElement).toBe(restoredInput);
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  it("supports ArrowLeft as keyboard back when the page query is empty", () => {
    const { container } = renderDialog(createCommands(vi.fn()));

    fireEvent.click(getCommandItem(container, "quickPick.command.themeMode"));
    const pageInput = screen.getByPlaceholderText(PAGE_PLACEHOLDER_ID);
    fireEvent.keyDown(pageInput, { key: "ArrowLeft" });

    expect(screen.getByPlaceholderText("commandCenter.placeholder")).toBeTruthy();
  });

  it("applies a value-list selection immediately and returns to the root with the palette open", () => {
    const onSelectValue = vi.fn();
    const { container, onOpenChange } = renderDialog(createCommands(onSelectValue));

    const input = screen.getByPlaceholderText("commandCenter.placeholder") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "theme" } });
    fireEvent.click(getCommandItem(container, "quickPick.command.themeMode"));
    fireEvent.click(getCommandItem(container, "settings.themeMode.system"));

    expect(onSelectValue).toHaveBeenCalledWith("system");
    expect(onSelectValue).toHaveBeenCalledTimes(1);
    // 取值后回到根、恢复根查询词，并且面板保持打开（未调用关闭）。
    const restoredInput = screen.getByPlaceholderText(
      "commandCenter.placeholder",
    ) as HTMLInputElement;
    expect(restoredInput.value).toBe("theme");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("still closes the dialog for commands without a page", () => {
    const { container, onOpenChange } = renderDialog(createCommands(vi.fn()));

    fireEvent.click(getCommandItem(container, "quickPick.command.settings"));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
