import type { UiThemeMode, UiThemePalette } from "@zcode/contracts";
import { BUILTIN_TUI_THEMES } from "./defaults.js";
import type { TuiThemeTokens } from "./types.js";

export const DEFAULT_TUI_THEME_PALETTE: UiThemePalette = "neutral";

/**
 * 仅覆盖强调色相关 token；背景、文本与语法高亮保持内置主题不变。
 * 数值与 packages/ui/src/lib/themePalettes.ts 的 accent 保持一致。TUI 无法导入 @zcode/ui，
 * 因此在此复制，修改任一侧时需同步另一侧。neutral 与 zai 没有覆盖项。
 */
const ACCENT_OVERRIDES: Partial<Record<UiThemePalette, Record<UiThemeMode, string>>> = {
  ocean: { light: "#2563eb", dark: "#60a5fa" },
  forest: { light: "#15803d", dark: "#4ade80" },
  ember: { light: "#c2410c", dark: "#fb923c" },
  violet: { light: "#7c3aed", dark: "#a78bfa" },
  slate: { light: "#475569", dark: "#94a3b8" },
  rose: { light: "#be185d", dark: "#f472b6" },
  sand: { light: "#a16207", dark: "#facc15" },
  mint: { light: "#0f766e", dark: "#2dd4bf" },
};

const resolvedTokenCache = new Map<string, TuiThemeTokens>();

/**
 * 返回指定模式与调色板下的 token。结果按 mode:palette 缓存，保证同一组合返回同一对象，
 * 避免组件每次渲染拿到新引用。
 */
export function resolveTuiThemeTokens(mode: UiThemeMode, palette: UiThemePalette): TuiThemeTokens {
  const base = BUILTIN_TUI_THEMES[mode];
  const accent = ACCENT_OVERRIDES[palette]?.[mode];
  if (!accent) return base;

  const key = `${mode}:${palette}`;
  const cached = resolvedTokenCache.get(key);
  if (cached) return cached;

  const resolved: TuiThemeTokens = {
    ...base,
    primary: accent,
    accent,
    borderActive: accent,
  };
  resolvedTokenCache.set(key, resolved);
  return resolved;
}
