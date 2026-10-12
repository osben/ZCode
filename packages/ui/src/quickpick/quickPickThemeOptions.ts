import type { Theme } from "@/useTheme.js";
import type { ThemePalette } from "@/lib/themePalettes.js";

/** Theme-mode rows for the `theme-mode` value-list page; values are the store's Theme union. */
export const THEME_MODE_OPTIONS: readonly { value: Theme; labelId: string; keywords: string[] }[] =
  [
    {
      value: "system",
      labelId: "settings.themeMode.system",
      keywords: ["system", "auto", "match system", "系统", "跟随系统", "自动"],
    },
    { value: "light", labelId: "settings.themeMode.light", keywords: ["light", "浅色", "亮色"] },
    { value: "dark", labelId: "settings.themeMode.dark", keywords: ["dark", "深色", "暗色"] },
  ];

export const THEME_PALETTE_KEYWORDS: Record<ThemePalette, string[]> = {
  neutral: ["neutral", "中性"],
  zai: ["zai", "Z.ai"],
  ocean: ["ocean", "blue", "海洋", "蓝色"],
  forest: ["forest", "green", "森林", "绿色"],
  ember: ["ember", "orange", "余烬", "橙色"],
  violet: ["violet", "purple", "紫罗兰", "紫色"],
  slate: ["slate", "gray", "石板灰", "灰色"],
  rose: ["rose", "pink", "玫瑰", "粉色"],
  sand: ["sand", "yellow", "砂色", "黄色"],
  mint: ["mint", "teal", "薄荷", "青色"],
};
