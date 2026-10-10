import { readSafeLocalStorage } from "./lib/browserEnvironment.js";
import {
  DEFAULT_THEME_PALETTE,
  THEME_PALETTE_IDS,
  isAccentPalette,
  isThemePalette,
  type ThemePalette,
} from "./lib/themePalettes.js";

export {
  DEFAULT_THEME_PALETTE,
  THEME_PALETTES,
  THEME_PALETTE_IDS,
  isAccentPalette,
  isThemePalette,
  type ThemeAccentPaletteId,
  type ThemePalette,
  type ThemePaletteDefinition,
} from "./lib/themePalettes.js";

/** 明暗模式。配色由 ThemePalette 单独决定。 */
export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeSelection {
  mode: Theme;
  palette: ThemePalette;
}

export const THEME_STORAGE_KEY = "zcode-theme";
export const THEME_PALETTE_STORAGE_KEY = "zcode-theme-palette";
const BROWSER_THEME_SURFACE_ATTRIBUTE = "data-zcode-browser-theme-surface";

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return getSystemTheme();
  }

  return theme === "dark" ? "dark" : "light";
}

/**
 * 读取持久化的主题选择。旧版 `zcode-theme` 曾把配色写进值里（`zai-dark` 等），
 * 这些值统一迁移为 `zai` 配色 + 对应模式，外观与旧版一致。
 * 只在读取时转换，不回写旧值。缺失或无法识别的模式使用 fallbackMode。
 */
export function migrateThemeSelection(
  storedMode: string | null,
  storedPalette: string | null,
  fallbackMode: Theme = "dark",
): ThemeSelection {
  let mode: Theme;
  switch (storedMode) {
    case "light":
    case "zai-light":
      mode = "light";
      break;
    case "dark":
    case "zai-dark":
      mode = "dark";
      break;
    case "system":
      mode = "system";
      break;
    default:
      mode = fallbackMode;
      break;
  }

  return {
    mode,
    palette: isThemePalette(storedPalette) ? storedPalette : DEFAULT_THEME_PALETTE,
  };
}

/** 读取当前持久化的主题选择，供不经过 store 的页面（如分享页）使用。 */
export function readStoredThemeSelection(fallbackMode: Theme = "dark"): ThemeSelection {
  return migrateThemeSelection(
    readSafeLocalStorage(THEME_STORAGE_KEY),
    readSafeLocalStorage(THEME_PALETTE_STORAGE_KEY),
    fallbackMode,
  );
}

function setThemeMetaContent(name: "theme-color" | "color-scheme", content: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.append(meta);
  }
  meta.content = content;
}

function syncBrowserThemeSurface(resolved: ResolvedTheme) {
  const root = document.documentElement;
  if (
    typeof root.hasAttribute !== "function" ||
    !root.hasAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE)
  ) {
    return;
  }

  // Electron 为 vibrancy 保持透明根背景，但普通浏览器需要从文档根和标准 meta
  // 获得页面主题。只切换 React 的 dark class 会让浏览器工具栏、原生控件和 overscroll 留在旧主题。
  root.setAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE, resolved);
  root.style.colorScheme = resolved;
  setThemeMetaContent("color-scheme", resolved);

  const background = getComputedStyle(root).getPropertyValue("--color-background").trim();
  if (background) {
    setThemeMetaContent("theme-color", background);
  }
}

/**
 * 把明暗模式与配色应用到 <html>。配色 class 与明暗 class 互不影响：
 * `theme-zai-*` 只属于 zai 配色；accent 配色通过 `palette-<id>` 覆盖品牌色变量。
 */
export function applyTheme(mode: Theme, palette: ThemePalette = DEFAULT_THEME_PALETTE) {
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("theme-zai-light", palette === "zai" && resolved === "light");
  root.classList.toggle("theme-zai-dark", palette === "zai" && resolved === "dark");
  for (const id of THEME_PALETTE_IDS) {
    if (isAccentPalette(id)) {
      root.classList.toggle(`palette-${id}`, id === palette);
    }
  }
  syncBrowserThemeSurface(resolved);
}
