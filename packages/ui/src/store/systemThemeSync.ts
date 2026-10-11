import { applyTheme, type Theme, type ThemeSelection } from "../useTheme.js";

/**
 * Returns a synchronization function: subscribe to system light/dark changes when switching to system mode, and unsubscribe when leaving it.
 * getSelection reads the latest state each time so the listener applies the current colors rather than those from subscription time.
 */
export function createSystemThemeSync(getSelection: () => ThemeSelection) {
  let cleanup: (() => void) | null = null;

  return (theme: Theme) => {
    cleanup?.();
    cleanup = null;

    if (theme !== "system" || typeof window === "undefined") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => {
      if (getSelection().mode !== "system") {
        return;
      }

      // System mode must stay subscribed to system light/dark changes; applying them only once when switching to system is insufficient.
      // Otherwise, when the user changes the system theme later, the DOM's dark class will not update and "follow system" will appear broken.
      applyTheme("system", getSelection().palette);
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      cleanup = () => {
        mediaQuery.removeEventListener("change", handleSystemThemeChange);
      };
      return;
    }

    // Some Electron/Chromium combinations still support only the legacy MediaQueryList listener API.
    // If only addEventListener is called here, system mode will receive no notification when the system theme changes.
    mediaQuery.addListener(handleSystemThemeChange);
    cleanup = () => {
      mediaQuery.removeListener(handleSystemThemeChange);
    };
  };
}
