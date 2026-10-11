interface WorkspaceShellWindowChromeOptions {
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  macOSMajorVersion?: number | null;
  isWindowsMaximized: boolean;
  supportsNativeRoundedCorners: boolean | null;
}

type WorkspaceShellPlatformRadiusOptions = Pick<
  WorkspaceShellWindowChromeOptions,
  "isMacDesktop" | "isWindowsDesktop" | "isLinuxDesktop" | "macOSMajorVersion"
>;

export function resolveWorkspaceShellPanelRadiusPx({
  isMacDesktop,
  isWindowsDesktop,
  macOSMajorVersion,
}: WorkspaceShellPlatformRadiusOptions): number {
  if (isWindowsDesktop) return 5;
  // Ignoring the macOS version would make Sequoia's inner 12px radius look inconsistent with the native window's smaller radius.
  // Keep 4px of outer space; use 6px for older/unknown versions and 12px only when Tahoe 26+ is positively identified.
  if (isMacDesktop) return (macOSMajorVersion ?? 0) >= 26 ? 12 : 6;
  return 12;
}

export function resolveWorkspaceShellResizeHandleInsetPx(
  options: WorkspaceShellPlatformRadiusOptions,
): number {
  return resolveWorkspaceShellPanelRadiusPx(options) + 4;
}

export function resolveWorkspaceShellWindowChromeClass({
  isMacDesktop,
  isWindowsDesktop,
  isLinuxDesktop,
  macOSMajorVersion,
  supportsNativeRoundedCorners,
}: WorkspaceShellWindowChromeOptions): string {
  // Linux uses xl to match the settings page; the panel already has its own spacing and does not form the outer edge of the system window.
  if (isLinuxDesktop) return "rounded-xl border border-border";
  if (!isWindowsDesktop) {
    const radius = resolveWorkspaceShellPanelRadiusPx({ isMacDesktop, macOSMajorVersion });
    return radius === 6 ? "rounded-[6px] border border-border" : "rounded-xl border border-border";
  }

  if (supportsNativeRoundedCorners === null) {
    // When the bridge is unavailable or the initial query is incomplete, do not interpret “unknown” as Windows 10.
    // Keep the previous style so Win11 does not permanently fall back to square corners on a failure path.
    return "rounded-[5px] border border-border";
  }

  if (!supportsNativeRoundedCorners) {
    // Drawing the same right-side corners for all Windows versions would fake a window frame on Windows 10,
    // which does not support native rounded corners. Round only the right outer corners; do not remove the panel's three existing subtle borders.
    return "rounded-l-[5px] border border-border";
  }

  // The old maximized-window rule treated the panel as the outer edge of the system window and removed its corners and three borders.
  // The panel has its own 4px spacing and must retain full corner rounding and borders when maximized.
  // After insetting the Windows outer edge by 4px, a 12px radius creates an overly thick curved gap; use 5px for layout panels.
  return "rounded-[5px] border border-border";
}
