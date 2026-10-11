import type { CuaAccessibilitySettingsResult } from "@zcode/shared";

function normalizeToolName(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/_/g, "-") ?? "";
}

export function isZCodeCuaToolName(value: string | null | undefined): boolean {
  const normalized = normalizeToolName(value);
  // The server key segment is computer-use. MCP tools use mcp__computer-use__*;
  // main v3.5.3 adds a namespace to plugin servers according to its plugin MCP naming convention:
  // mcp__plugin_zcode-cua_computer-use__* (the normalized server segment has a single hyphen
  // before cua-computer-use, not a double hyphen). Both forms contain "computer-use", so includes
  // supports both. Otherwise, main's namespace prefix would prevent CUA tool detection and make
  // ToolCallBlock fall back to the generic renderer. "computer-use" is specific enough because
  // only the CUA server uses this key; it does not match android-emulator or browser-use.
  return normalized === "computer-use" || normalized.includes("computer-use");
}

export function didReturnFromCuaPermissionSettings(
  result: CuaAccessibilitySettingsResult | null | undefined,
): boolean {
  // main sets this to true only after the entire staged pane group finishes and a return to the
  // ZCode application is observed. Renderer focus can come from a native TCC prompt, another
  // window, or an ordinary app switch, so it is no longer a signal that authorization completed.
  return (
    result?.success === true &&
    result.returnedFromSettings === true &&
    typeof result.sessionId === "string" &&
    result.sessionId.length > 0
  );
}

export function shouldRestartHelperAfterCuaPermissionReturn(
  result: CuaAccessibilitySettingsResult | null | undefined,
): boolean {
  // restartHelperAfterReturn is an additive main ABI field. Older main versions omit it and keep
  // the previous single-window-owner behavior. Newer main versions return false only for duplicate
  // joins from the same renderer/host; independent Helpers in different windows each recover.
  return didReturnFromCuaPermissionSettings(result) && result?.restartHelperAfterReturn !== false;
}

export interface CuaPermissionReturnRecoveryState {
  /** Monotonically unique across open/workspace resets; a local epoch alone cannot identify an async operation. */
  generation: number;
  contextKey: string;
  epoch: number;
  pending: boolean;
  automaticAttempted: boolean;
}

export interface CuaPermissionReturnRecoveryClaim {
  readonly state: CuaPermissionReturnRecoveryState;
  readonly generation: number;
  readonly contextKey: string;
  readonly epoch: number;
}

let nextCuaPermissionRecoveryGeneration = 0;

export function createCuaPermissionReturnRecoveryState(
  contextKey = "",
): CuaPermissionReturnRecoveryState {
  nextCuaPermissionRecoveryGeneration += 1;
  return {
    generation: nextCuaPermissionRecoveryGeneration,
    contextKey,
    epoch: 0,
    pending: false,
    automaticAttempted: false,
  };
}

function recoveryClaim(state: CuaPermissionReturnRecoveryState): CuaPermissionReturnRecoveryClaim {
  return {
    state,
    generation: state.generation,
    contextKey: state.contextKey,
    epoch: state.epoch,
  };
}

export function markCuaPermissionOnboardingOpened(
  state: CuaPermissionReturnRecoveryState,
): CuaPermissionReturnRecoveryClaim {
  state.epoch += 1;
  state.pending = true;
  state.automaticAttempted = false;
  return recoveryClaim(state);
}

export function claimCuaPermissionReturnRecovery(
  state: CuaPermissionReturnRecoveryState,
): CuaPermissionReturnRecoveryClaim | null {
  // Ordinary focus, intermediate focus from a native prompt, and duplicate focus for the same
  // authorization action have no effect.
  if (!state.pending || state.automaticAttempted) return null;
  state.automaticAttempted = true;
  return recoveryClaim(state);
}

export function captureCuaPermissionReturnRecovery(
  state: CuaPermissionReturnRecoveryState,
): CuaPermissionReturnRecoveryClaim | null {
  return state.pending ? recoveryClaim(state) : null;
}

export function isCuaPermissionReturnRecoveryCurrent(
  current: CuaPermissionReturnRecoveryState,
  claim: CuaPermissionReturnRecoveryClaim,
): boolean {
  return (
    current === claim.state &&
    current.generation === claim.generation &&
    current.contextKey === claim.contextKey &&
    current.epoch === claim.epoch &&
    current.pending
  );
}

export function completeCuaPermissionReturnRecovery(
  claim: CuaPermissionReturnRecoveryClaim,
  restartSucceeded: boolean,
): void {
  // The ref points to a new state after a workspace/open switch, and the local epoch restarts at 0.
  // If an old restart completes using `ref.current + epoch`, it could clear a matching event in the
  // new workspace. A claim stays bound to the state/context where it began; completion can modify
  // only that old object. On failure, pending remains available for a manual retry in that context.
  const state = claim.state;
  if (
    restartSucceeded &&
    state.pending &&
    state.generation === claim.generation &&
    state.contextKey === claim.contextKey &&
    state.epoch === claim.epoch
  ) {
    state.pending = false;
  }
}
