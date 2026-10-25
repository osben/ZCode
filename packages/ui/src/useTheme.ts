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

/** Light/dark mode. The color scheme is determined separately by ThemePalette. */
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
 * Read the persisted theme selection. Older versions of `zcode-theme` stored the color scheme in the value (such as `zai-dark`),
 * so these values are migrated to the `zai` palette plus the corresponding mode, preserving the old appearance.
 * Convert only when reading; do not write back the old value. Use fallbackMode when the mode is missing or unrecognized.
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

/** Read the current persisted theme selection for pages that do not use the store (such as the share page). */
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

  // Electron keeps the root background transparent for vibrancy, but regular browsers need the document root and standard meta
  // to receive the page theme. Changing only React’s dark class leaves the browser toolbar, native controls, and overscroll in the old theme.
  root.setAttribute(BROWSER_THEME_SURFACE_ATTRIBUTE, resolved);
  root.style.colorScheme = resolved;
  setThemeMetaContent("color-scheme", resolved);

  const background = getComputedStyle(root).getPropertyValue("--color-background").trim();
  if (background) {
    setThemeMetaContent("theme-color", background);
  }
}

/**
 * Apply the light/dark mode and palette to <html>. Palette classes and mode classes are independent:
 * `theme-zai-*` is only for the zai palette; accent palettes override brand-color variables through `palette-<id>`.
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
