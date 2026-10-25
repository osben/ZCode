import { useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import { resolveTheme, type Theme } from "@/useTheme.js";

export function useDesktopNativeThemeSync({
  enabled,
  isDesktop,
  platform,
  theme,
}: {
  enabled: boolean;
  isDesktop?: boolean;
  platform: IPlatformService;
  theme: Theme;
}) {
  useEffect(() => {
    if (!enabled || !isDesktop) {
      return;
    }

    let disposed = false;
    const titleBarTheme = theme === "system" ? "system" : resolveTheme(theme);

    // The native window theme affects macOS vibrancy; do not write nativeTheme during startup loading
    // so the app theme does not override the window shell while RootStartupLoading is visible; sync it after entering the main UI.
    platform.setTitleBarTheme(titleBarTheme).catch((error) => {
      if (disposed) {
        return;
      }
      logger.error("[Root] 同步标题栏主题失败", { titleBarTheme, error });
    });

    return () => {
      disposed = true;
    };
  }, [enabled, isDesktop, platform, theme]);
}
