import type { UiThemeMode, UiThemePalette } from "@zcode/contracts";
import { BUILTIN_TUI_THEMES } from "./defaults.js";
import type { TuiThemeTokens } from "./types.js";

export const DEFAULT_TUI_THEME_PALETTE: UiThemePalette = "neutral";

/**
 * Override only accent-related tokens; keep the built-in background, text, and syntax highlighting unchanged.
 * Values match the accent colors in packages/ui/src/lib/themePalettes.ts. The TUI cannot import @zcode/ui,
 * so the values are duplicated here; update both sides together. neutral and zai have no overrides.
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
 * Return tokens for the requested mode and palette. Cache by mode:palette so the same combination returns the same object,
 * avoiding a new reference on every component render.
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
