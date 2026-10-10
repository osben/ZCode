import { release } from "node:os";
import type { CuaOsSupport } from "@zcode/shared";

// The supported-version floor is max(Helper Info.plist LSMinimumSystemVersion 12.0, SEA binary minos 11.0).
// Incident in 2026-08: without the floor check, users on older macOS versions saw repeated unresponsive authorization
// (the actual cause was LaunchServices -10825 refusing to start the Helper).
const CUA_MINIMUM_MACOS_VERSION = "12.0";
// The floor is tied to LSMinimumSystemVersion(12.0) in upstream zcode-cua helperAppBundle.ts;
// when bumping either side, update the other constants too.
const CUA_MINIMUM_DARWIN_MAJOR = 21; // Darwin major - 9 = macOS major（21↔12, 22↔13）

function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  darwinRelease = release(),
): CuaOsSupport {
  if (platform !== "darwin") return { kind: "not-applicable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) return { kind: "supported" };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}
