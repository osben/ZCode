import type { CuaPermissionKind } from "@zcode/shared";
import type { CuaPermissionStatus } from "@zcode/services";

function isActionablePermissionState(state: CuaPermissionStatus["accessibility"]): boolean {
  return state === "denied" || state === "stale";
}

/**
 * After a modal or click entry re-queries, pass only definite gaps in a fresh available TCC snapshot to one-click authorization.
 * Failed capability probes and unknown states go only to verification/retry; do not infer that system permission is missing.
 */
export function requiredCuaPermissionsForFreshStatus(
  status: CuaPermissionStatus | null,
): CuaPermissionKind[] {
  if (!status) return [];
  const required: CuaPermissionKind[] = [];
  if (isActionablePermissionState(status.accessibility)) {
    required.push("accessibility");
  }
  if (isActionablePermissionState(status.screenRecording)) {
    required.push("screen_recording");
  }
  return required;
}
