import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BarChart3,
  Blocks,
  Cable,
  FileText,
  GitBranchPlus,
  Package,
  WandSparkles,
} from "lucide-react";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { isSettingsSectionAvailable } from "../src/settings/settingsPageConfig.js";

async function loadSettingsPageConfig(env: "test" | "production") {
  vi.resetModules();
  vi.doMock("@zcode/shared", async () => {
    const actual = await vi.importActual<typeof import("@zcode/shared")>("@zcode/shared");
    return {
      ...actual,
      ZCODE_ENV: env,
    };
  });
  return import("../src/settings/settingsPageConfig.js");
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("settingsPageConfig", () => {
  it("only exposes remote device management on desktop", () => {
    expect(isSettingsSectionAvailable("remoteDevices", true)).toBe(true);
    expect(isSettingsSectionAvailable("remoteDevices", false)).toBe(false);
    expect(isSettingsSectionAvailable("general", false)).toBe(true);
  });
  it("按设置页分组与顺序展示公开分区", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSectionGroups, settingsSections } = createSettingsPageConfig({});
    expect(
      settingsSectionGroups.map((group) => ({
        id: group.id,
        sections: group.sections.map((section) => section.id),
      })),
    ).toEqual([
      {
        id: "basics",
        sections: [
          "general",
          "appearance",
          "modelProvider",
          "remoteDevices",
          "shortcuts",
          "voiceDictation",
        ],
      },
      {
        id: "agentCapabilities",
        sections: [
          "instructions",
          "outputStyles",
          "systemPrompt",
          "memory",
          "incognito",
          "subagents",
          "plugin",
          "mcp",
          "skill",
          "commands",
          "hooks",
          "browser",
        ],
      },
      {
        id: "dataAndStats",
        sections: ["usage", "sessions", "archives"],
      },
    ]);
    expect(settingsSections.map((section) => section.id)).toEqual([
      "general",
      "appearance",
      "modelProvider",
      "instructions",
      "outputStyles",
      "systemPrompt",
      "memory",
      "incognito",
      "subagents",
      "plugin",
      "mcp",
      "skill",
      "commands",
      "hooks",
      "browser",
      "remoteDevices",
      "shortcuts",
      "voiceDictation",
      "usage",
      "sessions",
      "archives",
    ]);
  });

  it("按设置页心智顺序展示 production 分区并保留 usage", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("production");
    const { settingsSections } = createSettingsPageConfig({});

    expect(settingsSections.map((section) => section.id)).toEqual([
      "general",
      "appearance",
      "modelProvider",
      "instructions",
      "outputStyles",
      "systemPrompt",
      "memory",
      "incognito",
      "subagents",
      "plugin",
      "mcp",
      "skill",
      "commands",
      "hooks",
      "browser",
      "remoteDevices",
      "shortcuts",
      "voiceDictation",
      "usage",
      "sessions",
      "archives",
    ]);
    const sessionsSection = settingsSections.find((section) => section.id === "sessions");
    expect(sessionsSection?.titleId).toBe("sessionManager.title");
    expect(enUS["sessionManager.title"]).toBeTruthy();
    expect(zhCN["sessionManager.title"]).toBeTruthy();
  });

  it("Plugins 内容标题不再配置 beta 徽标", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    const pluginsSection = SETTINGS_SECTIONS.find((section) => section.id === "plugin");

    expect(pluginsSection?.titleBadgeId).toBeUndefined();
  });

  it("Models 与 Plugins 菜单使用统一资源图标", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    expect(SETTINGS_SECTIONS.find((section) => section.id === "modelProvider")?.icon).toBe(Package);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "plugin")?.icon).toBe(Blocks);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "mcp")?.icon).toBe(Cable);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "skill")?.icon).toBe(WandSparkles);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "systemPrompt")?.icon).toBe(FileText);
    expect(enUS["settings.systemPrompt.title"]).toBe("System Prompts");
  });

  it("Worktrees 分区仅桌面平台注册，排在基础设置末尾并提供中英文标题", async () => {
    const { createSettingsPageConfig, SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    const { settingsSections, settingsSectionGroups } = createSettingsPageConfig({
      isDesktop: true,
    });
    const worktreesSection = settingsSections.find((section) => section.id === "worktrees");

    expect(worktreesSection?.icon).toBe(GitBranchPlus);
    expect(worktreesSection?.titleId).toBe("settings.worktrees.title");
    expect(enUS["settings.worktrees.title"]).toBe("Worktrees");
    expect(zhCN["settings.worktrees.title"]).toBe("Worktrees");
    // Desktop: Worktrees closes the Basics group.
    expect(
      settingsSectionGroups
        .find((group) => group.id === "basics")
        ?.sections.map((section) => section.id),
    ).toEqual([
      "general",
      "appearance",
      "modelProvider",
      "remoteDevices",
      "shortcuts",
      "voiceDictation",
      "worktrees",
    ]);
    // Web default config (same boundary as the supportsWorktreeTasks Command Center command).
    expect(SETTINGS_SECTIONS.some((section) => section.id === "worktrees")).toBe(false);
    expect(
      createSettingsPageConfig({}).settingsSections.some((section) => section.id === "worktrees"),
    ).toBe(false);
  });

  it("Usage 分区文案和头像菜单使用统计入口保持一致", async () => {
    const { SETTINGS_SECTIONS } = await loadSettingsPageConfig("test");
    const usageSection = SETTINGS_SECTIONS.find((section) => section.id === "usage");

    expect(usageSection?.icon).toBe(BarChart3);
    expect(enUS["settings.usageTitle"]).toBe(enUS["sidebar.usage.plan.openStats"]);
    expect(enUS["settings.usage.sectionTitle"]).toBe(enUS["sidebar.usage.plan.openStats"]);
    expect(zhCN["settings.usageTitle"]).toBe(zhCN["sidebar.usage.plan.openStats"]);
  });

  it.each([
    ["macOS", { isMacDesktop: true }, true],
    ["Windows", { isWindowsDesktop: true }, true],
    ["Linux 桌面", { isDesktop: true }, true],
    ["Web", {}, false],
  ] as const)("%s 的电脑控制入口符合桌面平台边界", async (_name, options, expected) => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSections } = createSettingsPageConfig(options);

    expect(settingsSections.some((section) => section.id === "computerUse")).toBe(expected);
  });

  it("桌面平台的电脑控制排在 Agent 能力的浏览器之后", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSectionGroups } = createSettingsPageConfig({
      isMacDesktop: true,
    });
    const capabilities = settingsSectionGroups.find((group) => group.id === "agentCapabilities");

    expect(capabilities?.sections.map((section) => section.id).slice(-2)).toEqual([
      "browser",
      "computerUse",
    ]);
    expect(
      settingsSectionGroups
        .find((group) => group.id === "basics")
        ?.sections.some((section) => section.id === "computerUse"),
    ).toBe(false);
  });

  it("不可见的电脑控制落点回退到 general", async () => {
    const { createSettingsPageConfig, resolveSettingsSectionForPlatform } =
      await loadSettingsPageConfig("test");
    const { settingsSections } = createSettingsPageConfig({});

    expect(resolveSettingsSectionForPlatform("computerUse", settingsSections, "general")).toBe(
      "general",
    );
  });

  it("migration 落点不可见并回退到 general", async () => {
    const { createSettingsPageConfig, resolveSettingsSectionForPlatform } =
      await loadSettingsPageConfig("test");
    const { settingsSections } = createSettingsPageConfig({ isDesktop: true });

    expect(settingsSections.some((section) => section.id === "migration")).toBe(false);
    const { resolveSettingsSection } = await import("../src/lib/settingsNavigation.js");
    expect(resolveSettingsSection("migration")).toBe("general");
    expect(resolveSettingsSectionForPlatform("migration", settingsSections, "general")).toBe(
      "general",
    );
  });

  it("Web 仍展示语音输入入口，内容可以说明仅支持 Desktop", async () => {
    const { createSettingsPageConfig } = await loadSettingsPageConfig("test");
    const { settingsSections } = createSettingsPageConfig({});

    expect(settingsSections.some((section) => section.id === "voiceDictation")).toBe(true);
  });
});
