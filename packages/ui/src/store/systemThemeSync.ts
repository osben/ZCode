import { applyTheme, type Theme, type ThemeSelection } from "../useTheme.js";

/**
 * 返回一个同步函数：模式切换到 system 时订阅系统亮暗变化，切离 system 时取消订阅。
 * getSelection 每次都读取最新状态，保证监听回调应用的是当前配色而不是订阅时的配色。
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

      // system 模式需要持续订阅系统亮暗变化，不能只在切换到 system 的瞬间应用一次。
      // 否则用户后续切系统主题时，DOM 上的 dark class 不会同步更新，看起来就像“跟随系统失效”。
      applyTheme("system", getSelection().palette);
    };

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleSystemThemeChange);
      cleanup = () => {
        mediaQuery.removeEventListener("change", handleSystemThemeChange);
      };
      return;
    }

    // 某些 Electron / Chromium 组合仍然只支持旧版 MediaQueryList listener API。
    // 如果这里只调用 addEventListener，system 模式切系统主题时会完全收不到通知。
    mediaQuery.addListener(handleSystemThemeChange);
    cleanup = () => {
      mediaQuery.removeListener(handleSystemThemeChange);
    };
  };
}
