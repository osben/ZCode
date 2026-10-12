/* eslint-disable max-lines -- Centralize Settings navigation intent, sessionStorage, event bridging, and parsing/validation; splitting these could make one-shot intent consumption order harder to guarantee. */
import { logger } from "@/logger.js";

export type SettingsSectionId =
  | "general"
  | "appearance"
  | "migration"
  | "browser"
  | "modelProvider"
  | "instructions"
  | "memory"
  | "plugin"
  | "mcp"
  | "skill"
  | "plugins"
  | "usage"
  | "subagents"
  | "commands"
  | "hooks"
  | "workspaceFileSearch"
  | "computerUse"
  | "automations"
  | "shortcuts"
  | "worktrees"
  | "voiceDictation";

export type SettingsUsageTabTarget = "app" | "codingPlan";
export type SettingsPluginTabTarget = "plugins" | "mcps" | "skills" | "commands";
export type SettingsPluginNavigationOrigin = "plugin-store";

const SETTINGS_SECTION_INTENT_KEY = "zcode-settings-section-intent",
  SETTINGS_USAGE_TAB_INTENT_KEY = "zcode-settings-usage-tab-intent",
  SETTINGS_PLUGIN_TAB_INTENT_KEY = "zcode-settings-plugin-tab-intent",
  SETTINGS_PLUGIN_ORIGIN_INTENT_KEY = "zcode-settings-plugin-origin-intent",
  SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY = "zcode-settings-plugin-scope-key-intent";
const SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY = "zcode-settings-model-provider-id-intent";
const SETTINGS_SECTION_INTENT_EVENT = "zcode:settings-section-intent",
  SETTINGS_LAST_SECTION_STORAGE_KEY = "zcode-settings-last-section";
const HIDDEN_SETTINGS_SECTIONS = new Set<SettingsSectionId>([
  // Product behavior: Automations is a workspace main view and must not appear as a Settings section.
  // Note: Hooks is already a formal Settings section, so it is not listed here.
  "automations",
  // The old plugin marketplace has moved out of Settings; keep its ID only for migrating stored preferences and older callers.
  "plugins",
  // Hide the workspace search (.zcodeignore) entry for now. The rules file still applies and can be edited manually,
  // and the editor code remains; remove this entry from here when it is enabled again.
  "workspaceFileSearch",
]);

export interface SettingsSectionIntentEventDetail {
  section: SettingsSectionId;
  pluginTab?: SettingsPluginTabTarget;
  pluginOrigin?: SettingsPluginNavigationOrigin;
  pluginScopeKey?: string;
  usageTab?: SettingsUsageTabTarget;
  modelProviderId?: string;
}

export interface SettingsModelProviderTarget {
  providerId: string;
}

function isSettingsSectionId(value: string): value is SettingsSectionId {
  return (
    value === "general" ||
    value === "appearance" ||
    value === "migration" ||
    value === "browser" ||
    value === "modelProvider" ||
    value === "instructions" ||
    value === "memory" ||
    value === "plugin" ||
    value === "mcp" ||
    value === "skill" ||
    value === "plugins" ||
    value === "usage" ||
    value === "subagents" ||
    value === "commands" ||
    value === "hooks" ||
    value === "workspaceFileSearch" ||
    value === "computerUse" ||
    value === "automations" ||
    value === "shortcuts" ||
    value === "worktrees" ||
    value === "voiceDictation"
  );
}

export function isSettingsSectionEnabled(section: SettingsSectionId): boolean {
  return !HIDDEN_SETTINGS_SECTIONS.has(section);
}

export function resolveSettingsSection(
  section: SettingsSectionId,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (section === "plugins") return "plugin";
  return isSettingsSectionEnabled(section) ? section : fallbackSection;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch (error) {
    // Some WebView/mobile remote-control containers may disable localStorage.
    // Remembering the Settings section is only a UI preference; use the default entry when storage is unavailable and do not block opening Settings.
    logger.warn("[settingsNavigation] localStorage 不可用", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function readLastSettingsSectionPreference(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const storage = getLocalStorage();
  if (!storage) {
    return fallbackSection;
  }

  try {
    const raw = storage.getItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    // The old section ID was merged into plugin; migrate persisted values to avoid propagating legacy routing behavior.
    if (raw === "plugins") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "plugin");
      setPendingPluginTab("plugins");
      return "plugin";
    }
    if (raw === "skills") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "skill");
      return "skill";
    }
    // The old “Code Preview” section was merged into “Appearance”; preserve migration behavior for the user’s last visited section.
    if (raw === "codePreview") {
      storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, "appearance");
      return "appearance";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
    if (raw !== null) {
      storage.removeItem(SETTINGS_LAST_SECTION_STORAGE_KEY);
    }
  } catch (error) {
    logger.warn("[settingsNavigation] 读取上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return fallbackSection;
}

export function writeLastSettingsSectionPreference(section: SettingsSectionId): void {
  const resolvedSection = resolveSettingsSection(section);
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(SETTINGS_LAST_SECTION_STORAGE_KEY, resolvedSection);
  } catch (error) {
    logger.warn("[settingsNavigation] 写入上次设置分区失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function consumeInitialSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  const lastSection = readLastSettingsSectionPreference(fallbackSection);
  // Previously, a regular Settings open hard-coded modelProvider as the fallback for consumePendingSettingsSection,
  // so without an explicit navigation intent it always opened “Model Providers.” Read the last visited section first,
  // then let one-shot intents such as quickpick / model management override it, preserving direct navigation for explicit entry points.
  return resolveSettingsSection(consumePendingSettingsSection(lastSection), lastSection);
}

export function setPendingSettingsSection(section: SettingsSectionId): void {
  setPendingSettingsSectionIntent(section);
}

export function setPendingSettingsUsageIntent(): void {
  // The Usage entry point opens only the Usage section; do not force a particular statistics tab.
  setPendingSettingsSectionIntent("usage");
}

export function setPendingSettingsUsageCodingPlanIntent(): void {
  // The remaining-quota details entry should navigate directly to Coding Plan usage statistics;
  // the avatar-menu entry only opens Usage so it does not override the last statistics tab the user viewed.
  setPendingSettingsSectionIntent("usage", { usageTab: "codingPlan" });
}

export function setPendingSettingsPluginIntent(
  tab: SettingsPluginTabTarget,
  options: {
    origin?: SettingsPluginNavigationOrigin;
    scopeKey?: string;
  } = {},
): void {
  const section =
    tab === "mcps"
      ? "mcp"
      : tab === "skills"
        ? "skill"
        : tab === "commands"
          ? "commands"
          : "plugin";
  setPendingSettingsSectionIntent(section, {
    pluginTab: tab === "plugins" ? tab : undefined,
    pluginOrigin: options.origin,
    pluginScopeKey: options.scopeKey,
  });
}

export function setPendingSettingsSectionIntent(
  section: SettingsSectionId,
  options: {
    pluginTab?: SettingsPluginTabTarget;
    pluginOrigin?: SettingsPluginNavigationOrigin;
    pluginScopeKey?: string;
    modelProviderId?: string;
    usageTab?: SettingsUsageTabTarget;
  } = {},
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(SETTINGS_SECTION_INTENT_KEY, section);
    if (options.pluginTab) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, options.pluginTab);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    }
    if (options.pluginOrigin) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY, options.pluginOrigin);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    }
    const normalizedPluginScopeKey = options.pluginScopeKey?.trim();
    if (normalizedPluginScopeKey) {
      window.sessionStorage.setItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY, normalizedPluginScopeKey);
    } else {
      window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    }
    if (options.usageTab) {
      window.sessionStorage.setItem(SETTINGS_USAGE_TAB_INTENT_KEY, options.usageTab);
    }
    if (options.modelProviderId) {
      window.sessionStorage.setItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY, options.modelProviderId);
    } else {
      window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    }
  } catch {
    // Ignore browser storage failures; they do not affect the main flow.
  }

  // SettingsPage is already open and will not remount, so writing sessionStorage alone has no subscriber to react.
  // Dispatch a same-window custom event so the open SettingsPage can immediately navigate to the quickpick section.
  window.dispatchEvent(
    new CustomEvent<SettingsSectionIntentEventDetail>(SETTINGS_SECTION_INTENT_EVENT, {
      detail: {
        section,
        pluginTab: options.pluginTab,
        pluginOrigin: options.pluginOrigin,
        pluginScopeKey: options.pluginScopeKey?.trim() || undefined,
        usageTab: options.usageTab,
        modelProviderId: options.modelProviderId,
      },
    }),
  );
}

function clearPendingSettingsSectionIntent(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // Ignore browser storage failures; they do not affect the main flow.
  }
}

export function consumePendingSettingsSection(
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (typeof window === "undefined") {
    return fallbackSection;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_SECTION_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_SECTION_INTENT_KEY);
    }

    if (raw === "skills") {
      // Older Skills used a plural ID; migrate it to the current standalone Skill section.
      return "skill";
    }
    if (raw && isSettingsSectionId(raw)) {
      return resolveSettingsSection(raw, fallbackSection);
    }
  } catch {
    // Ignore browser storage failures; they do not affect the main flow.
  }

  return fallbackSection;
}

function setPendingPluginTab(tab: SettingsPluginTabTarget): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SETTINGS_PLUGIN_TAB_INTENT_KEY, tab);
  } catch {
    // Ignore browser storage failures; they do not affect opening Settings.
  }
}

export function consumePendingSettingsPluginTab(): SettingsPluginTabTarget | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_TAB_INTENT_KEY);
    return raw === "plugins" || raw === "mcps" || raw === "skills" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsPluginOrigin(): SettingsPluginNavigationOrigin | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
    return raw === "plugin-store" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function consumePendingSettingsPluginScopeKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
    return raw?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingSettingsPluginScopeKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_SCOPE_KEY_INTENT_KEY);
  } catch {
    // Ignore browser storage failures; they do not affect the main flow.
  }
}

export function clearPendingSettingsPluginOrigin(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SETTINGS_PLUGIN_ORIGIN_INTENT_KEY);
  } catch {
    // Ignore browser storage failures; they do not affect opening Settings.
  }
}

export function consumePendingSettingsUsageTab(): SettingsUsageTabTarget | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const raw = window.sessionStorage.getItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    if (raw !== null) {
      window.sessionStorage.removeItem(SETTINGS_USAGE_TAB_INTENT_KEY);
    }
    return raw === "app" || raw === "codingPlan" ? raw : undefined;
  } catch {
    // Ignore browser storage failures; they do not affect the main flow.
    return undefined;
  }
}

export function consumePendingSettingsModelProviderTarget():
  | SettingsModelProviderTarget
  | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const providerId = window.sessionStorage.getItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    window.sessionStorage.removeItem(SETTINGS_MODEL_PROVIDER_ID_INTENT_KEY);
    if (!providerId?.trim()) {
      return undefined;
    }
    return {
      providerId: providerId.trim(),
    };
  } catch {
    // Ignore browser storage failures; they do not affect the main flow.
    return undefined;
  }
}

export function shouldFallbackSettingsUsageTabToApp({
  activeTab,
  checkingCodingPlanTab,
  loadingModelProviders,
  showCodingPlanTab,
}: {
  activeTab: SettingsUsageTabTarget;
  checkingCodingPlanTab: boolean;
  loadingModelProviders: boolean;
  showCodingPlanTab: boolean;
}): boolean {
  // Coding Plan navigation intent may arrive before provider/entitlement data finishes loading.
  // Fall back to App Usage only after loading ends and there is still no valid plan; avoid having the first frame undo a click on “More” by restoring the default tab.
  return (
    activeTab === "codingPlan" &&
    !showCodingPlanTab &&
    !loadingModelProviders &&
    !checkingCodingPlanTab
  );
}

export function addPendingSettingsSectionListener(
  listener: (section: SettingsSectionId, detail?: SettingsSectionIntentEventDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleIntent = (event: Event) => {
    const detail = (event as CustomEvent<SettingsSectionIntentEventDetail>).detail;
    if (detail?.section && isSettingsSectionId(detail.section)) {
      // When Settings is already open, the event has already carried this navigation intent.
      // Clear sessionStorage synchronously here so that after the user switches sections and closes Settings,
      // a later mount is not overridden by a stale pending intent instead of the last visited section.
      clearPendingSettingsSectionIntent();
      listener(detail.section, detail);
    }
  };

  window.addEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  return () => {
    window.removeEventListener(SETTINGS_SECTION_INTENT_EVENT, handleIntent);
  };
}
