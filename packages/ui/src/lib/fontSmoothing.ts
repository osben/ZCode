import { readSafeLocalStorage } from "@/lib/browserEnvironment.js";

/** macOS font smoothing preference; stored as "true" / "false" and shared with 3.18.1 renderers. */
export const FONT_SMOOTHING_STORAGE_KEY = "zcode-macos-font-smoothing";

/** Unset means enabled, which keeps the antialiased rendering the body had before the toggle existed. */
export function loadFontSmoothingEnabled(): boolean {
  return readSafeLocalStorage(FONT_SMOOTHING_STORAGE_KEY) !== "false";
}

/** The CSS rule only applies under `.platform-mac-desktop`, so the class is harmless on other platforms. */
export function applyFontSmoothingEnabled(enabled: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.classList.toggle("font-smoothing-enabled", enabled);
}
