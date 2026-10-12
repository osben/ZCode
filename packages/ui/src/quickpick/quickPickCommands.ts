import type { ResolvedTheme, Theme } from "@/useTheme.js";
import { THEME_PALETTES, type ThemePalette } from "@/lib/themePalettes.js";
import { THEME_MODE_OPTIONS, THEME_PALETTE_KEYWORDS } from "@/quickpick/quickPickThemeOptions.js";
import {
  NEW_TASK_PROJECT_PAGE_ID,
  NEW_TASK_WORKTREE_COMMAND_ID,
} from "@/command-center/worktreeTaskFlow.js";

export type QuickPickCommandIcon =
  | "book"
  | "browser"
  | "community"
  | "diff"
  | "feedback"
  | "folder"
  | "login"
  | "logout"
  | "message"
  | "mcp"
  | "palette"
  | "settings"
  | "sidebarClose"
  | "sidebarOpen"
  | "skills"
  | "themeDark"
  | "themeLight"
  | "themeMode"
  | "terminal"
  | "worktree";

export type QuickPickCommandSectionId =
  | "suggested"
  | "chat"
  | "navigation"
  | "panels"
  | "configure"
  | "app";

export const QUICK_PICK_SECTION_ORDER: QuickPickCommandSectionId[] = [
  "suggested",
  "chat",
  "navigation",
  "panels",
  "configure",
  "app",
];

/** In-palette sub-page pushed onto the Command Center page stack when the command is selected. */
export interface QuickPickCommandPage {
  id: string;
  /** i18n message id used as the search input placeholder while the page is active. */
  placeholderId: string;
}

/** One selectable row of a value-list page. */
export interface QuickPickValueListOption {
  /** Value passed to QuickPickValueList.onSelect when the row is selected. */
  value: string;
  /** i18n message id for the row label. */
  labelId: string;
  keywords: string[];
  /**
   * Preview swatch color (hex). Present (possibly null) when the row renders a color swatch;
   * null renders an empty ring for palettes without an accent.
   */
  swatchColor?: string | null;
}

/** Option list the Command Center renders as the command's page; mirrors Copilot's valueList commands. */
export interface QuickPickValueList {
  options: readonly QuickPickValueListOption[];
  /** Currently applied value; its row is highlighted with a check mark. */
  current?: string;
  /** Applies the selected value immediately; the palette returns to its root and stays open. */
  onSelect: (value: string) => void;
}

export interface QuickPickCommand {
  id: string;
  sectionId: QuickPickCommandSectionId;
  titleId: string;
  icon: QuickPickCommandIcon;
  shortcut?: string;
  keywords: string[];
  disabled?: boolean;
  /** When present, selecting the command pushes this page instead of running and closing the dialog. */
  page?: QuickPickCommandPage;
  /** Option list rendered as the command's page. */
  valueList?: QuickPickValueList;
  /** Immediate action; required for commands without a page, omitted by page commands. */
  run?: () => void | Promise<void>;
}

interface QuickPickCommandHandlers {
  createTask: () => void;
  openWorkspace: () => void;
  openSettings: () => void;
  openSkillsSettings: () => void;
  openMcpSettings: () => void;
  switchTheme: () => void;
  setThemeMode: (mode: Theme) => void;
  setThemePalette: (palette: ThemePalette) => void;
  openFeedback: () => void | Promise<void>;
  openCommunity: () => void | Promise<void>;
  openProductDocs: () => void | Promise<void>;
  login?: () => void | Promise<void>;
  logout?: () => void | Promise<void>;
  toggleSidebar: () => void;
  toggleTerminal: () => void;
  togglePreview: () => void;
  openTerminalTab: () => void;
  openBrowserTab: () => void;
  openReviewTab: () => void;
}

interface CreateQuickPickCommandsOptions {
  allowOpenWorkspace: boolean;
  canOpenCommunity: boolean;
  isSidebarVisible: boolean;
  isLoggedIn: boolean;
  supportsEmbeddedBrowser?: boolean;
  supportsTerminal?: boolean;
  supportsReview?: boolean;
  /**
   * Desktop-local capability for the "New task in worktree" flow. Worktree creation runs
   * local Git on the local Host, so the command stays hidden on Web and remote-only shells.
   */
  supportsWorktreeTasks?: boolean;
  themeTarget: "dark" | "light";
  /** Current theme mode; feeds the theme-mode value-list page's current marker. */
  themeMode: Theme;
  /** Current color palette; feeds the theme-palette value-list page's current marker. */
  themePalette: ThemePalette;
  /** Resolved light/dark mode used to pick each accent palette's swatch color. */
  resolvedTheme: ResolvedTheme;
  shortcuts: {
    newTask: string;
    openWorkspace: string;
    toggleSidebar: string;
    toggleTerminal: string;
  };
  handlers: QuickPickCommandHandlers;
}

export function createQuickPickCommands({
  allowOpenWorkspace,
  canOpenCommunity,
  isSidebarVisible,
  isLoggedIn,
  supportsEmbeddedBrowser = true,
  supportsTerminal = true,
  supportsReview = true,
  supportsWorktreeTasks = false,
  themeTarget,
  themeMode,
  themePalette,
  resolvedTheme,
  shortcuts,
  handlers,
}: CreateQuickPickCommandsOptions): QuickPickCommand[] {
  const commands: QuickPickCommand[] = [
    {
      id: "new-task",
      sectionId: "suggested",
      titleId: "quickPick.command.newTask",
      icon: "message",
      shortcut: shortcuts.newTask,
      keywords: ["new", "task", "任务", "新任务", "新建任务"],
      run: handlers.createTask,
    },
    ...(supportsWorktreeTasks
      ? [
          {
            id: NEW_TASK_WORKTREE_COMMAND_ID,
            sectionId: "suggested",
            titleId: "quickPick.command.newTaskWorktree",
            icon: "worktree",
            keywords: [
              "worktree",
              "git",
              "branch",
              "new",
              "task",
              "工作树",
              "工作区",
              "分支",
              "新任务",
              "新建任务",
            ],
            // 页面命令不携带 run：选择它会推入 new-task-project 子页面（项目 → setup → Start）。
            page: {
              id: NEW_TASK_PROJECT_PAGE_ID,
              placeholderId: "commandCenter.placeholder.newTaskProject",
            },
          } satisfies QuickPickCommand,
        ]
      : []),
    {
      id: "open-workspace",
      sectionId: "suggested",
      titleId: "quickPick.command.openWorkspace",
      icon: "folder",
      shortcut: shortcuts.openWorkspace,
      keywords: ["open", "workspace", "folder", "project", "打开", "文件夹", "项目"],
      disabled: !allowOpenWorkspace,
      run: handlers.openWorkspace,
    },
    {
      id: "suggested-settings",
      sectionId: "suggested",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "配置", "设置"],
      run: handlers.openSettings,
    },
    {
      id: "toggle-sidebar",
      sectionId: "panels",
      titleId: "quickPick.command.toggleSidebar",
      icon: isSidebarVisible ? "sidebarClose" : "sidebarOpen",
      shortcut: shortcuts.toggleSidebar,
      keywords: ["sidebar", "left sidebar", "toggle sidebar", "侧栏", "侧边栏", "切换侧栏"],
      run: handlers.toggleSidebar,
    },
    {
      id: "toggle-terminal",
      sectionId: "panels",
      titleId: "quickPick.command.toggleTerminal",
      icon: "terminal",
      shortcut: shortcuts.toggleTerminal,
      keywords: ["terminal", "shell", "console", "终端"],
      run: handlers.toggleTerminal,
    },
    ...(supportsEmbeddedBrowser
      ? [
          {
            id: "toggle-preview",
            sectionId: "panels",
            titleId: "quickPick.command.togglePreview",
            icon: "browser",
            keywords: [
              "preview",
              "browser",
              "web",
              "show",
              "hide",
              "预览",
              "浏览器",
              "网页",
              "显示",
              "隐藏",
            ],
            run: handlers.togglePreview,
          } satisfies QuickPickCommand,
        ]
      : []),
    {
      id: "add-terminal-tab",
      sectionId: "panels",
      titleId: "quickPick.command.addTerminalTab",
      icon: "terminal",
      keywords: ["add", "terminal", "tab", "new terminal", "添加终端", "终端标签"],
      run: handlers.openTerminalTab,
    },
    ...(supportsEmbeddedBrowser
      ? [
          {
            id: "add-browser-tab",
            sectionId: "panels",
            titleId: "quickPick.command.addBrowserTab",
            icon: "browser",
            keywords: ["add", "browser", "tab", "preview", "添加浏览器", "浏览器标签"],
            run: handlers.openBrowserTab,
          } satisfies QuickPickCommand,
        ]
      : []),
    {
      id: "add-review-tab",
      sectionId: "panels",
      titleId: "quickPick.command.addReviewTab",
      icon: "diff",
      keywords: ["add", "review", "diff", "changes", "添加审查", "审查标签", "变更"],
      run: handlers.openReviewTab,
    },
    {
      id: "settings",
      sectionId: "configure",
      titleId: "quickPick.command.settings",
      icon: "settings",
      keywords: ["settings", "preferences", "配置", "设置"],
      run: handlers.openSettings,
    },
    {
      id: "switch-theme",
      sectionId: "configure",
      titleId:
        themeTarget === "dark"
          ? "quickPick.command.switchThemeToDark"
          : "quickPick.command.switchThemeToLight",
      icon: themeTarget === "dark" ? "themeDark" : "themeLight",
      keywords: ["theme", "dark", "light", "主题", "深色", "浅色"],
      run: handlers.switchTheme,
    },
    {
      id: "theme-mode",
      sectionId: "configure",
      titleId: "quickPick.command.themeMode",
      icon: "themeMode",
      keywords: ["theme", "mode", "appearance", "system", "主题", "模式", "外观", "跟随系统"],
      page: {
        id: "theme-mode",
        placeholderId: "commandCenter.placeholder.themeMode",
      },
      valueList: {
        options: THEME_MODE_OPTIONS,
        current: themeMode,
        onSelect: (value) => {
          const mode = THEME_MODE_OPTIONS.find((option) => option.value === value)?.value;
          if (mode) {
            handlers.setThemeMode(mode);
          }
        },
      },
    },
    {
      id: "theme-palette",
      sectionId: "configure",
      titleId: "quickPick.command.themePalette",
      icon: "palette",
      keywords: ["theme", "palette", "color", "accent", "主题", "配色", "颜色", "强调色"],
      page: {
        id: "theme-palette",
        placeholderId: "commandCenter.placeholder.themePalette",
      },
      valueList: {
        options: THEME_PALETTES.map((definition) => ({
          value: definition.id,
          labelId: `settings.themePalette.${definition.id}`,
          keywords: THEME_PALETTE_KEYWORDS[definition.id],
          swatchColor: definition.accent?.[resolvedTheme] ?? null,
        })),
        current: themePalette,
        onSelect: (value) => {
          const palette = THEME_PALETTES.find((definition) => definition.id === value)?.id;
          if (palette) {
            handlers.setThemePalette(palette);
          }
        },
      },
    },
    {
      id: "skills-settings",
      sectionId: "configure",
      titleId: "quickPick.command.skills",
      icon: "skills",
      keywords: ["skills", "skill", "配置", "技能"],
      run: handlers.openSkillsSettings,
    },
    {
      id: "mcp-settings",
      sectionId: "configure",
      titleId: "quickPick.command.mcpServers",
      icon: "mcp",
      keywords: ["mcp", "server", "servers", "MCP", "服务器"],
      run: handlers.openMcpSettings,
    },
  ];

  commands.push({
    id: "feedback",
    sectionId: "app",
    titleId: "quickPick.command.feedback",
    icon: "feedback",
    keywords: [
      "feedback",
      "issue",
      "support",
      "tickets",
      "问题上报",
      "问题反馈",
      "反馈",
      "我的反馈",
      "工单",
    ],
    run: handlers.openFeedback,
  });

  if (canOpenCommunity) {
    commands.push({
      id: "community",
      sectionId: "app",
      titleId: "quickPick.command.community",
      icon: "community",
      keywords: ["community", "users", "chat", "用户社群", "社群"],
      run: handlers.openCommunity,
    });
  }

  commands.push({
    id: "product-docs",
    sectionId: "app",
    titleId: "quickPick.command.productDocs",
    icon: "book",
    keywords: ["docs", "documentation", "product docs", "文档", "产品文档"],
    run: handlers.openProductDocs,
  });

  if (isLoggedIn && handlers.logout) {
    commands.push({
      id: "logout",
      sectionId: "app",
      titleId: "quickPick.command.logout",
      icon: "logout",
      keywords: ["disconnect", "logout", "sign out", "断开连接", "登出"],
      run: handlers.logout,
    });
  } else if (!isLoggedIn && handlers.login) {
    commands.push({
      id: "login",
      sectionId: "app",
      titleId: "quickPick.command.login",
      icon: "login",
      // Account actions in the command palette are presented as “Connect/Disconnect,” so search terms must match.
      keywords: ["connect", "login", "sign in", "连接", "登录"],
      run: handlers.login,
    });
  }

  return commands.filter(
    (command) =>
      (supportsTerminal ||
        (command.id !== "toggle-terminal" && command.id !== "add-terminal-tab")) &&
      (supportsReview || command.id !== "add-review-tab"),
  );
}
