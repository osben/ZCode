/** State derivation for the always-available CUA composer entry button (dependency-free pure functions). It is a pure function because the state combination is the Cartesian product of platform × hidden setting × plugin state × permission state × session busy. Testing this in a component or hook would require store mocks and miss combinations. This file does not import React or read stores; callers (useCuaComposerEntry) inject all inputs. */
import { isCuaPermissionStatusAvailable, type CuaPermissionStatusResult } from "@zcode/services";
import { isCuaPermissionTccGranted } from "@/lib/cuaPermissionStatusStore.js";
import type { StatusDotTone } from "@/settings/StatusDot.js";

/** Four public UI states; internal distinctions are for logging only and are not exposed to users. There is no "disabled" (plugin not enabled) state: with computer control off by default, an unenabled plugin is no longer shown as a gray upsell button; it is not rendered at all (see the plugin gate in isEntryVisible), so that state is unreachable. */
export type CuaComposerEntryUiState =
  | "starting"
  /** Lazy startup: Helper is not running (normal idle; starts automatically on first use) — neutral gray dot, not an error. */
  | "idle"
  | "permission-required"
  | "ready"
  | "error";

export interface CuaComposerEntryInputs {
  /** Local macOS desktop with CUA onboarding capability (UA and preload capability must both match). */
  macLocalDesktop: boolean;
  /** Local Windows desktop. */
  windowsLocalDesktop: boolean;
  /** The Settings option "Show computer control button in the input" is off (internal hidden state). */
  hiddenBySettings: boolean;
  /** Whether cuaPermissionService exists; false on remote hosts. */
  permissionServiceAvailable: boolean;
  /** Whether the zcode-cua plugin is enabled. */
  pluginEnabled: boolean;
  /** Whether the zcode-cua plugin is being toggled. */
  pluginToggling: boolean;
  /** Most recent zcode-cua plugin operation failure. */
  pluginError: boolean;
  /** Helper permission state. The entry does not query permissions and always returns null (neutral idle); only the Settings page reads the actual value. */
  permissionStatus: CuaPermissionStatusResult | null;
  /** Whether a turn is running in any task in the current workspace. */
  sessionBusy: boolean;
}

export type CuaComposerEntryView =
  | { visible: false }
  | {
      visible: true;
      uiState: CuaComposerEntryUiState;
      tone: StatusDotTone;
      spinning: boolean;
      tooltipMessageId: string;
      /** open-settings = navigate to the Computer Use section in Settings; none = hover tooltip only. All visible states use open-settings; only the session-busy override uses none (see the comment at the end of resolve). */
      clickAction: "open-settings" | "none";
      /** session-busy override: dim the button and ignore clicks. Do not change uiState or tone. */
      interactionDisabled: boolean;
    };

const TOOLTIP_MESSAGE_ID: Record<CuaComposerEntryUiState, string> = {
  idle: "chat.toolbar.computerUse.tooltip.idle",
  starting: "chat.toolbar.computerUse.tooltip.starting",
  "permission-required": "chat.toolbar.computerUse.tooltip.permissionRequired",
  ready: "chat.toolbar.computerUse.tooltip.ready",
  error: "chat.toolbar.computerUse.tooltip.error",
};

const BUSY_TOOLTIP_MESSAGE_ID = "chat.toolbar.computerUse.tooltip.sessionBusy";

/** Four visibility gates. If any gate fails, do not render DOM instead of rendering a disabled button: a gray button in an unavailable scenario could mislead users into thinking they only need to install something. */
function isEntryVisible(inputs: CuaComposerEntryInputs): boolean {
  // Platform gate: remote workspaces, local Linux, regular Web, and mobile remote control do not qualify.
  if (!inputs.macLocalDesktop && !inputs.windowsLocalDesktop) return false;
  // Settings gate: once the user hides it, keep it hidden; do not restore it after restart or an update.
  if (inputs.hiddenBySettings) return false;
  // Service gate: on Mac, all status comes from Helper; without the service, the button cannot reflect any actual state.
  // Windows has no TCC and does not read Helper permissions, so it is not subject to this gate.
  if (inputs.macLocalDesktop && !inputs.permissionServiceAvailable) return false;
  // Do not show the entry when the computer-control plugin is disabled. This prevents a permanently visible gray promotional button
  // in the input after the default-off state or a user explicitly disables it.
  // Exception: while toggling, pluginEnabled still has its previous value. Blocking that state too would make the "enabling"
  // spinner disappear, leaving no progress feedback when the user returns to the session from Settings.
  if (!inputs.pluginEnabled && !inputs.pluginToggling) return false;
  return true;
}

/** Determine the internal state from top to bottom, short-circuiting in fixed priority order. The caller has already passed isEntryVisible, so pluginEnabled || pluginToggling must be true. "Plugin not enabled" is no longer a UI state; it is not rendered, so this function has no matching branch. */
function resolveUiState(inputs: CuaComposerEntryInputs): CuaComposerEntryUiState {
  // toggling has the highest priority: the prior enabled/permission values must not override the intermediate state during a switch.
  // It also covers the only disabled-plugin combination that can pass the plugin gate: disabled + toggling.
  if (inputs.pluginToggling) return "starting";
  if (inputs.pluginError) return "error";

  // Windows has no TCC: an enabled plugin is ready, so permission checks do not apply.
  if (!inputs.macLocalDesktop) return "ready";

  // A lazy-start entry does not display status, so permissionStatus is always null —
  // there is no "checking during cold start" state (checking would start Helper on demand, and querying on mount would start Helper
  // every time the app opens). Treat null as neutral idle; read actual permissions only in Settings (queried when opened).
  if (inputs.permissionStatus === null) return "idle";

  // An unhealthy Helper state (no accessibility field) maps to error, corresponding to "Helper failed to start".
  if (!isCuaPermissionStatusAvailable(inputs.permissionStatus)) {
    // unavailable with an idle marker is a normal response after Helper self-exits while idle (no access for 300 seconds),
    // not an error. Report an error only for an explicit failure without the idle marker.
    if ((inputs.permissionStatus as { idle?: true }).idle === true) return "idle";
    return "error";
  }

  // Permission readiness must be tested, but the persistent entry can only perform a read-only refresh. An active screenshot probe must come from
  // explicit user intent (the upstream shouldRunCuaScreenCaptureProbe requires includeFunctionalProbes); background refresh always returns
  // screenCaptureProbeOk=false. Using it to determine readiness would leave already-authorized users permanently stuck at the "missing macOS permission"
  // yellow dot. Use the same TCC source as the permission row in Settings; when permission is truly unavailable, the tool returns
  // a regular error and the model recovers from the original cause. The Renderer does not automatically open permission guidance.
  return isCuaPermissionTccGranted(inputs.permissionStatus) ? "ready" : "permission-required";
}

export function resolveCuaComposerEntryView(inputs: CuaComposerEntryInputs): CuaComposerEntryView {
  if (!isEntryVisible(inputs)) return { visible: false };

  const uiState = resolveUiState(inputs);
  // session-busy overrides interactivity: toggling the plugin changes the toolset for every session in the workspace and invalidates
  // prompt caches, with the highest cost while a turn is running. It does not change uiState/tone and clears automatically when all turns finish.
  // Simplification (product decision): the input entry no longer displays a status dot. It is always clickable and always opens Settings;
  // status is entirely owned by Settings (which starts Helper on demand and reads its actual state when opened). sessionBusy no longer disables the click.
  const interactionDisabled = false;

  return {
    visible: true,
    uiState,
    tone: "subtle",
    spinning: uiState === "starting",
    tooltipMessageId: interactionDisabled ? BUSY_TOOLTIP_MESSAGE_ID : TOOLTIP_MESSAGE_ID[uiState],
    // Previously only "plugin disabled" and
    // permission-required were clickable; ready/starting/error were status lights only.
    // In production, after users completed authorization and the button turned green, clicking it did nothing,
    // which made it seem broken. The Computer Use section in Settings always offers an action: plugin toggle, permission row,
    // or error details. So remove the clickable-state allowlist: any visible state can navigate, except while session-busy
    // (when the button is already dimmed and shows a "session in progress" tooltip; allowing navigation would contradict that feedback).
    clickAction: interactionDisabled ? "none" : "open-settings",
    interactionDisabled,
  };
}
