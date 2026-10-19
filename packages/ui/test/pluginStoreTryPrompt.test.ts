import { describe, expect, it } from "vitest";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";

const LOCALE_ZH = "zh-CN";

function pluginItem(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  return {
    id: "demo-plugin@demo-market",
    name: "demo-plugin",
    marketplace: "demo-market",
    installed: true,
    restorable: false,
    orphaned: false,
    listing: {
      displayName: "Demo [Plugin]",
      displayNameI18n: { "zh-CN": "演示插件" },
      icon: "https://cdn.example.com/demo-plugin.png",
    },
    ...overrides,
  };
}

describe("Plugin Store try prompt", () => {
  it("prefills only the shared canonical Plugin reference for Try now", () => {
    expect(
      buildPluginStoreTryPrompt({
        item: pluginItem(),
        locale: "en-US",
        prompt: "",
      }),
    ).toBe("[@Demo \\[Plugin\\]](plugin://demo-plugin@demo-market)");
  });

  it("prefills the shared canonical Plugin reference before the example prompt", () => {
    expect(
      buildPluginStoreTryPrompt({
        item: pluginItem(),
        locale: "en-US",
        prompt: "  Summarize this workspace.  ",
      }),
    ).toBe("[@Demo \\[Plugin\\]](plugin://demo-plugin@demo-market) Summarize this workspace.");
  });

  it("uses the localized display label without changing the stable destination", () => {
    expect(
      buildPluginStoreTryPrompt({
        item: pluginItem(),
        locale: LOCALE_ZH,
        prompt: "帮我检查配置",
      }),
    ).toBe("[@演示插件](plugin://demo-plugin@demo-market) 帮我检查配置");
  });

  it("builds the same structured Plugin mention used by the @ picker", () => {
    expect(
      buildPluginStoreTryMention({
        item: pluginItem(),
        locale: "en-US",
      }),
    ).toEqual({
      id: "plugin:demo-plugin@demo-market",
      category: "plugins",
      label: "Demo [Plugin]",
      value: "demo-plugin@demo-market",
      markdown: "[@Demo \\[Plugin\\]](plugin://demo-plugin@demo-market)",
      data: {
        pluginId: "demo-plugin@demo-market",
        icon: "https://cdn.example.com/demo-plugin.png",
      },
    });
  });
});
