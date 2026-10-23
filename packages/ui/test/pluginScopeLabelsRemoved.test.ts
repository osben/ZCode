/**
 * 3.16.3 port: plugin scope badges and the "Browse all plugins" / "Browse plugins" labels are gone.
 *
 * Installed plugin rows no longer state their scope; the browse actions use the marketplace label;
 * the store detail view returns with "Back"; the manage view has an icon-only back button.
 * The removed keys must not remain in any locale catalog.
 */
import { describe, expect, it } from "vitest";
import { readSourceText } from "./readSourceText.js";

function readSource(relativePath: string): string {
  return readSourceText(new URL(relativePath, import.meta.url), "utf8");
}

const pluginsSectionSource = readSource("../src/settings/PluginsSection.tsx");
const pluginStorePageSource = readSource("../src/settings/PluginStorePage.tsx");
const enUsSource = readSource("../src/i18n/locales/en-US.ts");
const zhCnSource = readSource("../src/i18n/locales/zh-CN.ts");
const ukUaSource = readSource("../src/i18n/locales/uk-UA.ts");

const REMOVED_KEYS = [
  "settings.plugins.scope.inheritedUser",
  "settings.plugins.scope.userDefault",
  "settings.plugins.scope.workspaceOverride",
  "settings.plugin.plugins.browse",
  "settings.plugins.store.browseAll",
];

describe("plugin scope labels and browse actions", () => {
  it("installed plugin rows render no scope badge", () => {
    expect(pluginsSectionSource).not.toContain("SettingsScopeBadge");
    expect(pluginsSectionSource).not.toContain("plugin.enabledSource");
    expect(pluginsSectionSource).not.toContain("settings.plugins.scope.userDefault");
    expect(pluginsSectionSource).not.toContain("settings.plugins.scope.inheritedUser");
    expect(pluginsSectionSource).not.toContain("settings.plugins.scope.workspaceOverride");
  });

  it("the workspace scope hint stays visible", () => {
    expect(pluginsSectionSource).toContain("settings.plugins.scope.workspaceHint");
  });

  it("plugin browse buttons use the marketplace label in both header and empty state", () => {
    expect(pluginsSectionSource).not.toContain("settings.plugin.plugins.browse");
    expect(pluginsSectionSource.match(/chat\.plugins\.browseMarketplace/g)?.length).toBe(2);
  });

  it("store detail view returns with the Back label", () => {
    expect(pluginStorePageSource).toContain('"settings.plugins.store.back"');
    expect(pluginStorePageSource).toContain('data-testid="plugin-store-detail-back"');
  });

  it("manage view uses an icon-only back button instead of a browse-all action", () => {
    expect(pluginStorePageSource).not.toContain("settings.plugins.store.browseAll");
    expect(pluginStorePageSource).not.toContain("plugin-store-browse-all");
    expect(pluginStorePageSource).toContain('data-testid="plugin-store-manage-back"');
    expect(pluginStorePageSource).toContain(
      'aria-label={intl.formatMessage({ id: "project.back" })}',
    );
  });

  it("removed keys are absent from every locale catalog", () => {
    for (const source of [enUsSource, zhCnSource, ukUaSource]) {
      for (const key of REMOVED_KEYS) {
        expect(source).not.toContain(`"${key}"`);
      }
    }
  });

  it("keys still used by the plugin UI stay in every locale catalog", () => {
    for (const source of [enUsSource, zhCnSource, ukUaSource]) {
      expect(source).toContain('"settings.plugins.scope.workspaceHint"');
      expect(source).toContain('"settings.plugins.scope.restoreUserDefault"');
      expect(source).toContain('"chat.plugins.browseMarketplace"');
    }
  });
});
