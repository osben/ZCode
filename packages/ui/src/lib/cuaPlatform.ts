import type { IPlatformService } from "@zcode/shared";

// Only macOS has TCC permissions, permission onboarding, and Helper status polling; the local Windows desktop only reuses
// the zcode-cua plugin toggle and does not read TCC or Helper state. Linux, regular Web, and mobile remote control do not show computer-control settings.
// Therefore, permission dialogs, preflight checks, and Helper status polling must first confirm that this is local macOS desktop.
// Check navigator.userAgent and explicitly exclude iOS (iPhone/iPad UAs contain the Macintosh substring).
//
// Changed from a module-level constant to a lazy function. The constant used to be evaluated on module import, preventing unit tests for UA branches
// from covering multiple platforms in the same process (changing navigator.userAgent cannot affect an already-evaluated constant). Runtime behavior is equivalent —
// the UA does not change at runtime in real environments.
function isMacOsDesktopUserAgent(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Macintosh|Mac OS X/.test(navigator.userAgent) &&
    !/iPhone|iPad|iPod/.test(navigator.userAgent)
  );
}

function isWindowsDesktopUserAgent(): boolean {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

/**
 * Actual platform-capability gate for the CUA permission UI.
 *
 * Checking only the UA would mistake macOS Safari/Web for desktop and open a permission dialog that cannot execute local IPC.
 * The desktop preload injects onboarding methods only when the capability exists, so both UA and capability must match.
 */
export function supportsLocalMacCuaPermissionOnboarding(
  platform: Pick<IPlatformService, "openCuaPermissionOnboarding"> | null | undefined,
): boolean {
  return isMacOsDesktopUserAgent() && typeof platform?.openCuaPermissionOnboarding === "function";
}

/**
 * CUA capability gate for the local Windows desktop (symmetric with the macOS gate above).
 *
 * Windows has no TCC and does not read Helper permissions, so openCuaPermissionOnboarding cannot be used as the capability check;
 * use executeDesktopCommand instead — it is injected only by the desktop preload and excludes regular browsers on Windows.
 */
export function supportsLocalWindowsCuaEntry(
  platform: Pick<IPlatformService, "executeDesktopCommand"> | null | undefined,
): boolean {
  return isWindowsDesktopUserAgent() && typeof platform?.executeDesktopCommand === "function";
}
