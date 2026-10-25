import { describe, expect, it, vi } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { THEME_PALETTE_IDS } from "@/lib/themePalettes.js";
import {
  createQuickPickCommands,
  QUICK_PICK_SECTION_ORDER,
} from "@/quickpick/quickPickCommands.js";

type CreateQuickPickCommandsOptions = Parameters<typeof createQuickPickCommands>[0];

function createHandlers() {
  return {
    createTask: vi.fn(),
    openWorkspace: vi.fn(),
    openSettings: vi.fn(),
    openSessionManager: vi.fn(),
    openSkillsSettings: vi.fn(),
    openMcpSettings: vi.fn(),
    switchTheme: vi.fn(),
    setThemeMode: vi.fn(),
    setThemePalette: vi.fn(),
    openFeedback: vi.fn(),
    openCommunity: vi.fn(),
    openProductDocs: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleTerminal: vi.fn(),
    togglePreview: vi.fn(),
    openTerminalTab: vi.fn(),
    openBrowserTab: vi.fn(),
    openReviewTab: vi.fn(),
  };
}

const shortcuts = {
  newTask: "⌘ N",
  openWorkspace: "⌘ O",
  toggleSidebar: "⌘ B",
  toggleTerminal: "⌘ J",
};

function createOptions(
  overrides: Partial<CreateQuickPickCommandsOptions> = {},
): CreateQuickPickCommandsOptions {
  return {
    allowOpenWorkspace: true,
    canOpenCommunity: true,
    isSidebarVisible: true,
    isLoggedIn: false,
    themeTarget: "dark",
    themeMode: "dark",
    themePalette: "zai",
    resolvedTheme: "dark",
    shortcuts,
    handlers: createHandlers(),
    ...overrides,
  };
}

describe("createQuickPickCommands", () => {
  it("通用模式过滤技术面板命令并保留浏览器和普通命令", () => {
    const commands = createQuickPickCommands(
      createOptions({ supportsTerminal: false, supportsReview: false }),
    );
    const ids = commands.map((command) => command.id);
    expect(ids).not.toContain("toggle-terminal");
    expect(ids).not.toContain("add-terminal-tab");
    expect(ids).not.toContain("add-review-tab");
    expect(ids).toContain("add-browser-tab");
    expect(ids).toContain("new-task");
    expect(ids).toContain("settings");
  });

  it("creates the starter command registry in stable sections", () => {
    const commands = createQuickPickCommands(createOptions());

    expect(commands.map((command) => command.id)).toEqual([
      "new-task",
      "open-workspace",
      "suggested-settings",
      "manage-sessions",
      "toggle-sidebar",
      "toggle-terminal",
      "toggle-preview",
      "add-terminal-tab",
      "add-browser-tab",
      "add-review-tab",
      "settings",
      "switch-theme",
      "theme-mode",
      "theme-palette",
      "skills-settings",
      "mcp-settings",
      "feedback",
      "community",
      "product-docs",
      "login",
    ]);
    expect(commands.find((command) => command.id === "open-workspace")).toMatchObject({
      sectionId: "suggested",
      shortcut: "⌘ O",
      disabled: false,
    });
    expect(commands.find((command) => command.id === "new-task")).toMatchObject({
      sectionId: "suggested",
    });
    expect(commands.find((command) => command.id === "suggested-settings")).toMatchObject({
      sectionId: "suggested",
    });
    expect(commands.find((command) => command.id === "settings")).toMatchObject({
      sectionId: "configure",
    });
    expect(commands.find((command) => command.id === "switch-theme")).toMatchObject({
      sectionId: "configure",
      titleId: "quickPick.command.switchThemeToDark",
      icon: "themeDark",
    });
    expect(commands.find((command) => command.id === "skills-settings")).toMatchObject({
      sectionId: "configure",
    });
    expect(commands.find((command) => command.id === "mcp-settings")).toMatchObject({
      sectionId: "configure",
    });
    expect(commands.find((command) => command.id === "toggle-sidebar")).toMatchObject({
      sectionId: "panels",
      shortcut: "⌘ B",
      icon: "sidebarClose",
    });
    expect(commands.find((command) => command.id === "toggle-terminal")).toMatchObject({
      sectionId: "panels",
    });
    expect(commands.find((command) => command.id === "toggle-preview")).toMatchObject({
      sectionId: "panels",
    });
    expect(commands.find((command) => command.id === "add-terminal-tab")).toMatchObject({
      sectionId: "panels",
    });
    expect(commands.find((command) => command.id === "add-browser-tab")).toMatchObject({
      sectionId: "panels",
    });
    expect(commands.find((command) => command.id === "add-review-tab")).toMatchObject({
      sectionId: "panels",
    });
    expect(commands.find((command) => command.id === "product-docs")).toMatchObject({
      sectionId: "app",
    });
  });

  it("keeps unavailable workspace opening visible but disabled", () => {
    const commands = createQuickPickCommands(createOptions({ allowOpenWorkspace: false }));

    expect(commands.find((command) => command.id === "open-workspace")).toMatchObject({
      disabled: true,
    });
  });

  it("matches the sidebar toggle icon to the current sidebar state", () => {
    const closedSidebarCommands = createQuickPickCommands(
      createOptions({ isSidebarVisible: false }),
    );

    expect(closedSidebarCommands.find((command) => command.id === "toggle-sidebar")).toMatchObject({
      icon: "sidebarOpen",
    });
  });

  it("omits embedded browser commands when the shell does not support browser tabs", () => {
    const commands = createQuickPickCommands(createOptions({ supportsEmbeddedBrowser: false }));

    expect(commands.map((command) => command.id)).not.toContain("toggle-preview");
    expect(commands.map((command) => command.id)).not.toContain("add-browser-tab");
  });

  it("runs the registered panel handler", () => {
    const handlers = createHandlers();
    const command = createQuickPickCommands(createOptions({ handlers })).find(
      (item) => item.id === "add-browser-tab",
    );

    command?.run?.();

    expect(handlers.openBrowserTab).toHaveBeenCalledTimes(1);
  });

  it("runs configure and app handlers", () => {
    const handlers = createHandlers();
    const commands = createQuickPickCommands(createOptions({ handlers }));

    commands.find((item) => item.id === "skills-settings")?.run?.();
    commands.find((item) => item.id === "product-docs")?.run?.();

    expect(handlers.openSkillsSettings).toHaveBeenCalledTimes(1);
    expect(handlers.openProductDocs).toHaveBeenCalledTimes(1);
  });

  it("has locale messages for every visible command label", () => {
    const commands = createQuickPickCommands(createOptions({ themeTarget: "light" }));
    expect(commands.find((command) => command.id === "switch-theme")).toMatchObject({
      titleId: "quickPick.command.switchThemeToLight",
      icon: "themeLight",
    });
    const messageIds = new Set([
      "quickPick.title",
      "quickPick.description",
      "quickPick.placeholder",
      "quickPick.empty",
      "quickPick.commandFailed",
      "commandCenter.scopeTabs",
      "commandCenter.scope.all",
      "commandCenter.scope.commands",
      "commandCenter.scope.conversations",
      "commandCenter.scope.files",
      "commandCenter.section.recentChanges",
      "commandCenter.section.recentTasks",
      "commandCenter.empty.recentChanges",
      "commandCenter.empty.recentTasks",
      ...commands.flatMap((command) => {
        const ids = [command.titleId];
        if (command.page) {
          ids.push(command.page.placeholderId);
        }
        if (command.valueList) {
          ids.push(...command.valueList.options.map((option) => option.labelId));
        }
        return ids;
      }),
      ...QUICK_PICK_SECTION_ORDER.map((sectionId) => `quickPick.section.${sectionId}`),
    ]);

    for (const id of messageIds) {
      expect(zhCN[id], `zh-CN missing ${id}`).toBeTruthy();
      expect(enUS[id], `en-US missing ${id}`).toBeTruthy();
    }
  });

  it("uses logout instead of login for authenticated users", () => {
    const commands = createQuickPickCommands(
      createOptions({ isLoggedIn: true, canOpenCommunity: false }),
    );

    expect(commands.some((command) => command.id === "login")).toBe(false);
    expect(commands.find((command) => command.id === "logout")).toMatchObject({
      sectionId: "app",
      titleId: "quickPick.command.logout",
    });
    expect(commands.some((command) => command.id === "community")).toBe(false);
  });
});

describe("worktree task command", () => {
  it("is hidden by default and registered right after new-task when the capability is on", () => {
    const defaultCommands = createQuickPickCommands(createOptions());
    expect(defaultCommands.some((command) => command.id === "new-task-worktree")).toBe(false);

    const commands = createQuickPickCommands(createOptions({ supportsWorktreeTasks: true }));
    const ids = commands.map((command) => command.id);
    expect(ids.indexOf("new-task-worktree")).toBe(ids.indexOf("new-task") + 1);
    expect(commands.find((command) => command.id === "new-task-worktree")).toMatchObject({
      sectionId: "suggested",
      titleId: "quickPick.command.newTaskWorktree",
      icon: "worktree",
      page: {
        id: "new-task-project",
        placeholderId: "commandCenter.placeholder.newTaskProject",
      },
    });
    // 页面命令不携带立即执行的 run：选择它会推入项目子页面而不是关闭面板。
    expect(commands.find((command) => command.id === "new-task-worktree")?.run).toBeUndefined();
  });
});

describe("theme value-list commands", () => {
  it("registers theme-mode with page and value-list metadata", () => {
    const commands = createQuickPickCommands(createOptions({ themeMode: "system" }));
    const command = commands.find((item) => item.id === "theme-mode");

    expect(command).toMatchObject({
      sectionId: "configure",
      titleId: "quickPick.command.themeMode",
      icon: "themeMode",
      keywords: ["theme", "mode", "appearance", "system", "主题", "模式", "外观", "跟随系统"],
      page: {
        id: "theme-mode",
        placeholderId: "commandCenter.placeholder.themeMode",
      },
    });
    // 页面命令不携带立即执行的 run：选择它会打开子页面而不是关闭面板。
    expect(command?.run).toBeUndefined();
    expect(command?.valueList?.current).toBe("system");
    expect(command?.valueList?.options.map((option) => option.value)).toEqual([
      "system",
      "light",
      "dark",
    ]);
    expect(command?.valueList?.options.map((option) => option.labelId)).toEqual([
      "settings.themeMode.system",
      "settings.themeMode.light",
      "settings.themeMode.dark",
    ]);
  });

  it("applies the selected mode immediately and leaves the palette untouched", () => {
    const handlers = createHandlers();
    const command = createQuickPickCommands(createOptions({ handlers })).find(
      (item) => item.id === "theme-mode",
    );

    command?.valueList?.onSelect("light");

    expect(handlers.setThemeMode).toHaveBeenCalledWith("light");
    // 模式与配色独立：选模式不得触发配色 setter。
    expect(handlers.setThemePalette).not.toHaveBeenCalled();
    expect(handlers.switchTheme).not.toHaveBeenCalled();
  });

  it("registers theme-palette with one row per palette and accent swatches", () => {
    const commands = createQuickPickCommands(
      createOptions({ themePalette: "ocean", resolvedTheme: "dark" }),
    );
    const command = commands.find((item) => item.id === "theme-palette");

    expect(command).toMatchObject({
      sectionId: "configure",
      titleId: "quickPick.command.themePalette",
      icon: "palette",
      keywords: ["theme", "palette", "color", "accent", "主题", "配色", "颜色", "强调色"],
      page: {
        id: "theme-palette",
        placeholderId: "commandCenter.placeholder.themePalette",
      },
    });
    expect(command?.run).toBeUndefined();
    const options = command?.valueList?.options ?? [];
    expect(options.map((option) => option.value)).toEqual([...THEME_PALETTE_IDS]);
    expect(options.map((option) => option.labelId)).toEqual(
      THEME_PALETTE_IDS.map((id) => `settings.themePalette.${id}`),
    );
    expect(command?.valueList?.current).toBe("ocean");
    // accent 配色带当前模式下的色板；neutral/zai 无 accent，渲染空环（null）。
    expect(options.find((option) => option.value === "ocean")?.swatchColor).toBe("#60a5fa");
    expect(options.find((option) => option.value === "mint")?.swatchColor).toBe("#2dd4bf");
    expect(options.find((option) => option.value === "neutral")?.swatchColor).toBeNull();
    expect(options.find((option) => option.value === "zai")?.swatchColor).toBeNull();
  });

  it("picks the light accent swatch when the resolved mode is light", () => {
    const commands = createQuickPickCommands(createOptions({ resolvedTheme: "light" }));
    const options = commands.find((item) => item.id === "theme-palette")?.valueList?.options ?? [];

    expect(options.find((option) => option.value === "ocean")?.swatchColor).toBe("#2563eb");
  });

  it("applies the selected palette immediately without touching the mode", () => {
    const handlers = createHandlers();
    const command = createQuickPickCommands(createOptions({ handlers })).find(
      (item) => item.id === "theme-palette",
    );

    command?.valueList?.onSelect("forest");

    expect(handlers.setThemePalette).toHaveBeenCalledWith("forest");
    expect(handlers.setThemeMode).not.toHaveBeenCalled();
    expect(handlers.switchTheme).not.toHaveBeenCalled();
  });

  it("ignores unknown values passed to onSelect", () => {
    const handlers = createHandlers();
    const commands = createQuickPickCommands(createOptions({ handlers }));

    commands.find((item) => item.id === "theme-mode")?.valueList?.onSelect("neon");
    commands.find((item) => item.id === "theme-palette")?.valueList?.onSelect("neon");

    expect(handlers.setThemeMode).not.toHaveBeenCalled();
    expect(handlers.setThemePalette).not.toHaveBeenCalled();
  });

  it("keeps the switch-theme quick toggle runnable and unchanged", () => {
    const handlers = createHandlers();
    createQuickPickCommands(createOptions({ handlers }))
      .find((item) => item.id === "switch-theme")
      ?.run?.();

    expect(handlers.switchTheme).toHaveBeenCalledTimes(1);
  });
});
