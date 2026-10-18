import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import ukUA from "../src/i18n/locales/uk-UA.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("appearance settings layout", () => {
  it("字体设置文案在三种语言下齐全且指向内置默认字体", () => {
    for (const locale of [enUS, ukUA, zhCN]) {
      expect(locale["settings.uiFont"]).toBeTruthy();
      expect(locale["settings.uiFontDescription"]).toContain("Inter");
      expect(locale["settings.monoFont"]).toBeTruthy();
      expect(locale["settings.monoFontDescription"]).toContain("JetBrains Mono");
      expect(locale["settings.fontFamilyReset"]).toBeTruthy();
      expect(locale["settings.fontFamilyNotFound"]).toBeTruthy();
      expect(locale["settings.fontFamilyDefault"]).toBeTruthy();
      expect(locale["settings.fontFamilySearchPlaceholder"]).toBeTruthy();
      expect(locale["settings.fontFamilyEmpty"]).toBeTruthy();
      expect(locale["settings.fontFamilyBundled"]).toBeTruthy();
      expect(locale["settings.fontFamilyInstalled"]).toBeTruthy();
      expect(locale["settings.fontFamilyLoading"]).toBeTruthy();
    }
  });

  it("українські описи шрифтів називають вбудований шрифт типовим за замовчуванням", () => {
    expect(ukUA["settings.uiFontDescription"]).toContain("шрифт за замовчуванням");
    expect(ukUA["settings.monoFontDescription"]).toContain("шрифт за замовчуванням");
  });

  it("文案描述可见效果，不再声称修改 rem 布局或显示右侧单一预览", () => {
    expect(zhCN["settings.appearance.interfaceDescription"]).toBe("设置应用主题和界面文字大小。");
    expect(zhCN["settings.uiFontSizeDescription"]).toContain("图标和布局尺寸不受影响");
    expect(zhCN["settings.previewDescription"]).toContain("同时预览浅色与深色代码主题");
    expect(enUS["settings.uiFontSizeDescription"]).toContain(
      "without changing icons or layout dimensions",
    );
    expect(enUS["settings.previewDescription"]).toContain(
      "Preview the light and dark code themes together",
    );

    for (const copy of [
      zhCN["settings.appearance.interfaceDescription"],
      zhCN["settings.uiFontSizeDescription"],
      zhCN["settings.previewDescription"],
      enUS["settings.appearance.interfaceDescription"],
      enUS["settings.uiFontSizeDescription"],
      enUS["settings.previewDescription"],
    ]) {
      expect(copy.toLowerCase()).not.toContain("rem");
      expect(copy).not.toContain("右侧");
      expect(copy.toLowerCase()).not.toContain("on the right");
    }
  });
});
