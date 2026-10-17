import {
  Monitor,
  Moon,
  Settings,
  Settings2,
  Package,
  Bot,
  Palette,
  Sun,
  BarChart3,
  History,
  Terminal,
  AlarmClock,
  Anchor,
  Brain,
  Blocks,
  Globe2,
  Cable,
  WandSparkles,
  Keyboard,
  FileSearch,
  ScrollText,
  MessageSquareText,
  GitBranchPlus,
  Mic,
} from "lucide-react";
import { isSettingsSectionEnabled, type SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";

export const THEME_MODES: Array<{
  mode: Theme;
  icon: typeof Sun;
}> = [
  { mode: "system", icon: Monitor },
  { mode: "dark", icon: Moon },
  { mode: "light", icon: Sun },
];

export type SettingsSectionGroupId = "basics" | "agentCapabilities" | "dataAndStats";

interface SettingsSectionDefinition {
  id: SettingsSectionId;
  icon: typeof Settings;
  titleId: string;
  contentTitleId?: string;
  titleBadgeId?: string;
  groupId: SettingsSectionGroupId;
}

const BASE_SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  titleId: string;
}> = [
  { id: "basics", titleId: "settings.sidebar.group.basics" },
  {
    id: "agentCapabilities",
    titleId: "settings.sidebar.group.agentCapabilities",
  },
  { id: "dataAndStats", titleId: "settings.sidebar.group.dataAndStats" },
];

const BASE_SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "general",
    icon: Settings2,
    titleId: "settings.systemTitle",
    groupId: "basics",
  },
  {
    id: "appearance",
    icon: Palette,
    titleId: "settings.appearanceTitle",
    groupId: "basics",
  },
  {
    id: "modelProvider",
    icon: Package,
    titleId: "settings.modelProviderTitle",
    groupId: "basics",
  },
  {
    id: "instructions",
    icon: ScrollText,
    titleId: "settings.instructions.title",
    groupId: "agentCapabilities",
  },
  // Output Styles shape the agent's response tone; they sit right after Instructions because
  // both edit user-scoped prompt material on the host of the active workspace.
  {
    id: "outputStyles",
    icon: MessageSquareText,
    titleId: "settings.outputStyles.title",
    groupId: "agentCapabilities",
  },
  {
    id: "memory",
    icon: Brain,
    titleId: "settings.memory",
    groupId: "agentCapabilities",
  },
  {
    id: "subagents",
    icon: Bot,
    titleId: "settings.subagents.title",
    groupId: "agentCapabilities",
  },
  {
    id: "plugin",
    icon: Blocks,
    titleId: "settings.plugins.title",
    groupId: "agentCapabilities",
  },
  {
    id: "mcp",
    icon: Cable,
    titleId: "settings.mcpTitle",
    groupId: "agentCapabilities",
  },
  {
    id: "skill",
    icon: WandSparkles,
    titleId: "settings.skills.title",
    groupId: "agentCapabilities",
  },
  {
    id: "commands",
    icon: Terminal,
    titleId: "settings.commands.title",
    groupId: "agentCapabilities",
  },
  {
    id: "automations",
    icon: AlarmClock,
    titleId: "settings.automations.title",
    titleBadgeId: "settings.automations.betaBadge",
    groupId: "agentCapabilities",
  },
  {
    id: "hooks",
    icon: Anchor,
    titleId: "settings.hooks.title",
    groupId: "agentCapabilities",
  },
  // Worktree defaults configure the “New task in worktree” flow (location, branch prefix,
  // per-project overrides); they sit with agent capabilities next to Commands and Hooks.
  // Desktop-only, mirroring the flow's supportsWorktreeTasks boundary; filtered for Web in
  // createSettingsPageConfig.
  {
    id: "worktrees",
    icon: GitBranchPlus,
    titleId: "settings.worktrees.title",
    groupId: "agentCapabilities",
  },
  {
    id: "browser",
    icon: Globe2,
    titleId: "settings.browser.title",
    groupId: "basics",
  },
  // Place Computer Use after Browser: both are local-control entry points for the Agent,
  // and keeping them in Basic Settings helps users understand "control the browser / control the whole computer" together.
  {
    id: "computerUse",
    icon: Monitor,
    titleId: "settings.computerUse.title",
    groupId: "basics",
  },
  // Place Keyboard Shortcuts after Computer Use: both configure local control/productivity and belong at the end of Basic Settings.
  {
    id: "shortcuts",
    icon: Keyboard,
    titleId: "settings.shortcuts.title",
    groupId: "basics",
  },
  // Voice input follows shortcuts: the recording shortcut can be changed in the Shortcuts section, while models, microphone, and recording mode are managed here.
  {
    id: "voiceDictation",
    icon: Mic,
    titleId: "settings.voiceDictation.title",
    groupId: "basics",
  },
  // Workspace search scope (.zcodeignore) is a basic workspace-behavior setting for all users, placed at the end of Basic Settings.
  {
    id: "workspaceFileSearch",
    icon: FileSearch,
    titleId: "settings.workspaceFileSearch.title",
    groupId: "basics",
  },
  {
    id: "usage",
    icon: BarChart3,
    titleId: "settings.usageTitle",
    groupId: "dataAndStats",
  },
  // Manage sessions lives next to Usage: both are cross-workspace "data and statistics"
  // management surfaces. The title reuses the sessionManager.* namespace the table already localizes.
  {
    id: "sessions",
    icon: History,
    titleId: "sessionManager.title",
    groupId: "dataAndStats",
  },
];

// Compatibility for existing readonly consumers: the default config represents a Web view without Desktop platform capabilities;
// macOS/Windows/Linux must continue to add Computer Use dynamically through createSettingsPageConfig.
// Worktrees follows the same Desktop-only boundary as the “New task in worktree” flow (supportsWorktreeTasks).
export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS.filter(
  (section) =>
    section.id !== "computerUse" &&
    section.id !== "worktrees" &&
    isSettingsSectionEnabled(section.id),
);

export interface SettingsPageConfigOptions {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}

export function createSettingsPageConfig({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
}: SettingsPageConfigOptions = {}) {
  const showComputerUse = isDesktop || isMacDesktop || isWindowsDesktop;
  const showWorktrees = isDesktop || isMacDesktop || isWindowsDesktop;
  const settingsSections = BASE_SETTINGS_SECTIONS.filter((section) => {
    if (section.id === "computerUse" && !showComputerUse) return false;
    if (section.id === "worktrees" && !showWorktrees) return false;
    return isSettingsSectionEnabled(section.id);
  });
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: settingsSections.filter((section) => section.groupId === group.id),
  })).filter((group) => group.sections.length > 0);

  return { settingsSectionGroups, settingsSections };
}

export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (visibleSections.some((candidate) => candidate.id === section)) return section;
  if (visibleSections.some((candidate) => candidate.id === fallbackSection)) {
    return fallbackSection;
  }
  return visibleSections[0]?.id ?? "general";
}

export type { SettingsSectionId };
