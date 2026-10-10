import type { UiThemeMode, UiThemePalette, UiThemePreference } from "@zcode/contracts";
import { DEFAULT_TUI_THEME_MODE } from "./defaults.js";
import { DEFAULT_TUI_THEME_PALETTE, resolveTuiThemeTokens } from "./palettes.js";
import type { TuiThemeTokens } from "./types.js";

let activeThemeMode: UiThemeMode = DEFAULT_TUI_THEME_MODE;
let activeThemePalette: UiThemePalette = DEFAULT_TUI_THEME_PALETTE;

export function activeTuiTheme(mode: UiThemeMode = activeThemeMode): TuiThemeTokens {
  return resolveTuiThemeTokens(mode, activeThemePalette);
}

export function getActiveTuiThemeMode(): UiThemeMode {
  return activeThemeMode;
}

export function setActiveTuiThemeMode(mode: UiThemeMode): void {
  activeThemeMode = mode;
}

export function getActiveTuiThemePalette(): UiThemePalette {
  return activeThemePalette;
}

/** 配置缺失时回退到 neutral，即不覆盖任何强调色，与未引入调色板前的输出一致。 */
export function setActiveTuiThemePalette(palette: UiThemePalette | undefined): void {
  activeThemePalette = palette ?? DEFAULT_TUI_THEME_PALETTE;
}

export function resolveTuiThemeMode(
  preference: UiThemePreference | undefined,
  terminalThemeMode: UiThemeMode | null | undefined,
): UiThemeMode {
  if (preference === "dark" || preference === "light") return preference;
  return terminalThemeMode ?? DEFAULT_TUI_THEME_MODE;
}

export function isTuiThemeMode(value: unknown): value is UiThemeMode {
  return value === "dark" || value === "light";
}
