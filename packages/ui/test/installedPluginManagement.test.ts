import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  ZCodePluginDiagnostic,
  ZCodePluginInfo,
  ZCodePluginUserConfigOption,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";
import { InstalledPluginDetailPanel } from "../src/settings/InstalledPluginManagement.js";

describe("InstalledPluginDetailPanel", () => {
  it("renders authoritative skill component names for both enabled and disabled plugins", () => {
    // Reproduces the reported superpowers case (14 skills). components come from the CLI's
    // authoritative enumeration via list, independent of the enabled state: both enabled and
    // disabled must show concrete skill names, not just counts, and the group must not vanish.
    const skillItems = Array.from({ length: 14 }, (_, index) => ({
      name: `superpowers-skill-${index + 1}`,
      ...(index === 0 ? { description: "Brainstorming ideas into designs" } : {}),
    }));

    for (const enabled of [true, false]) {
      const plugin: ZCodePluginInfo = {
        id: "superpowers@zcode-plugins-official",
        name: "superpowers",
        version: "5.1.0",
        enabled,
        source: "official",
        marketplace: "zcode-plugins-official",
        // When disabled the CLI reports skillCount 0, but components stay complete.
        skillCount: enabled ? 14 : 0,
        skillRootCount: enabled ? 1 : 0,
        commandRootCount: 0,
        declaredMcpServerNames: [],
        mcpServerNames: [],
        hookDetails: [],
        rootPath: "/cache/superpowers",
        components: [{ kind: "skill", items: skillItems }],
      };

      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(InstalledPluginDetailPanel, {
            getPluginOptionValue: (
              _plugin: ZCodePluginInfo,
              _key: string,
              option: ZCodePluginUserConfigOption,
            ) => option.default ?? "",
            onSavePluginOptions: () => {},
            activeOperations: [],
            plugin,
            renderPluginSource: (target: ZCodePluginInfo) => target.marketplace,
            setPluginOptionDraft: () => {},
          }),
        ),
      );

      // The count badge plus the first and last skill names must be visible.
      expect(html).toContain("14");
      expect(html).toContain("superpowers-skill-1");
      expect(html).toContain("superpowers-skill-14");
      expect(html).toContain("Brainstorming ideas into designs");
      // 不应再落到「启用后查看组件」的空态。
      expect(html).not.toContain(expectedCopy("settings.plugins.detail.componentsWhenEnabled"));
    }
  });

  it("renders warning diagnostics scoped to the plugin and hides them when none match", () => {
    // Bugfix regression (silent failure): warnings such as an empty declared skills path scan
    // previously had nowhere to render in the UI.
    const plugin: ZCodePluginInfo = {
      id: "mattpocock-skills@claude-plugins-official",
      name: "mattpocock-skills",
      enabled: true,
      source: "cache",
      marketplace: "claude-plugins-official",
      skillCount: 0,
      skillRootCount: 25,
      commandRootCount: 0,
      declaredMcpServerNames: [],
      mcpServerNames: [],
      hookDetails: [],
      rootPath: "/cache/mattpocock-skills",
      components: [],
    };

    const renderPanel = (diagnostics: ZCodePluginDiagnostic[]) =>
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "en-US" },
          createElement(InstalledPluginDetailPanel, {
            diagnostics,
            getPluginOptionValue: (
              _plugin: ZCodePluginInfo,
              _key: string,
              option: ZCodePluginUserConfigOption,
            ) => option.default ?? "",
            onSavePluginOptions: () => {},
            activeOperations: [],
            plugin,
            renderPluginSource: (target: ZCodePluginInfo) => target.marketplace,
            setPluginOptionDraft: () => {},
          }),
        ),
      );

    // Only the current plugin's own warnings render; other plugins / error severity stay out.
    const withWarnings = renderPanel([
      {
        code: "plugin_skill_root_empty",
        message: "Plugin skills path does not contain any skills: ./skills/engineering/tdd",
        pluginId: "mattpocock-skills@claude-plugins-official",
        severity: "warning",
      },
      {
        code: "plugin_skill_root_empty",
        message: "Plugin skills path does not contain any skills: ./other",
        pluginId: "other-plugin@claude-plugins-official",
        severity: "warning",
      },
      {
        code: "plugin_manifest_invalid",
        message: "boom",
        pluginId: "mattpocock-skills@claude-plugins-official",
        severity: "error",
      },
    ]);
    expect(withWarnings).toContain(expectedCopy("settings.plugins.detail.warnings"));
    expect(withWarnings).toContain("./skills/engineering/tdd");
    expect(withWarnings).not.toContain("./other");
    expect(withWarnings).not.toContain("boom");

    // No matching warnings: the empty block does not render.
    expect(renderPanel([])).not.toContain(expectedCopy("settings.plugins.detail.warnings"));
  });

  it("renders a details empty state for a plugin that declares no components", () => {
    // A plugin with no components gets an honest empty state, not a blank.
    const plugin: ZCodePluginInfo = {
      id: "empty-plugin@zcode-plugins-official",
      name: "empty-plugin",
      version: "0.1.0",
      enabled: false,
      source: "cache",
      marketplace: "zcode-plugins-official",
      skillCount: 0,
      skillRootCount: 0,
      commandRootCount: 0,
      declaredMcpServerNames: [],
      mcpServerNames: [],
      hookDetails: [],
      rootPath: "/cache/empty-plugin",
      components: [],
    };

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(InstalledPluginDetailPanel, {
          getPluginOptionValue: (
            _plugin: ZCodePluginInfo,
            _key: string,
            option: ZCodePluginUserConfigOption,
          ) => option.default ?? "",
          onSavePluginOptions: () => {},
          activeOperations: [],
          plugin,
          renderPluginSource: (target: ZCodePluginInfo) => target.marketplace,
          setPluginOptionDraft: () => {},
        }),
      ),
    );

    expect(html).toContain(expectedCopy("settings.plugins.detail.details"));
    expect(html).toContain(expectedCopy("settings.plugins.detail.componentsEmpty"));
  });
});
