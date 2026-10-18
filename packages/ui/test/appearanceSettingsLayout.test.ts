import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import ukUA from "../src/i18n/locales/uk-UA.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("appearance settings layout", () => {
  it("代码设置和代码预览上下排列，亮暗预览仅在宽屏左右排列", () => {
    const source = readFileSync("packages/ui/src/settingsCodePreview.tsx", "utf8");

    expect(source).toContain('className="space-y-6"');
    expect(source).toContain('className="grid gap-4 sm:grid-cols-2"');
    expect(source).not.toContain('className="grid gap-4 lg:grid-cols-2"');
    expect(source).not.toContain('className="grid gap-4 xl:grid-cols-2"');
    expect(source).not.toContain('className="grid gap-4 2xl:grid-cols-2"');
    expect(source).not.toContain('className="grid items-start gap-6 xl:grid-cols-2"');
    expect(source).toContain('id: "settings.appearance.codeTitle"');
    expect(source).toContain('id: "settings.previewSectionTitle"');
  });

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

  it("字体选择控件在有 Local Font Access 时用可搜索下拉，缺失时回退到自由输入", () => {
    const picker = readFileSync("packages/ui/src/settings/FontFamilyPicker.tsx", "utf8");
    expect(picker).toContain("getQueryLocalFonts");
    expect(picker).toContain("CommandInput");
    expect(picker).toContain("FontFamilyInputFallback");
    expect(picker).toContain('value={intl.formatMessage({ id: "settings.fontFamilyDefault" })}');
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
