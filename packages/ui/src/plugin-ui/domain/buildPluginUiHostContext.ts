import type {
  McpUiAppCapabilities,
  McpUiDisplayMode,
  McpUiHostContext,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpAppsHostTitleBar, McpAppsStyleVariables } from "@zcode/shared/mcp-apps";
import { PLUGIN_UI_CARD_MAX_HEIGHT_PX } from "../contract.js";

export interface PluginUiHostContextInput {
  theme: "light" | "dark";
  locale: string;
  displayMode: McpUiDisplayMode;
  /** Container width (px); 0 when unknown. */
  width: number;
  /** Card height cap (spec `containerDimensions.maxHeight`: the page arbitrates size-changed from it); defaults to the host cap. */
  maxHeight?: number;
  timeZone?: string;
  /** Header for the fullscreen container; omitted for inline. Host-provided extension key (hostContext allows extra keys). */
  titleBar?: McpAppsHostTitleBar;
  /** Modes this instance can actually switch to; both by default. */
  availableDisplayModes?: readonly McpUiDisplayMode[];
  /** Theme tokens mapped to standard MCP Apps variables; styles omitted by default. */
  styleVariables?: McpAppsStyleVariables;
}

/** Single construction point for hostContext. */
export function buildPluginUiHostContext(input: PluginUiHostContextInput): McpUiHostContext {
  return {
    theme: input.theme,
    locale: input.locale,
    displayMode: input.displayMode,
    availableDisplayModes: [...(input.availableDisplayModes ?? ["inline", "fullscreen"])],
    // Spec: inline card height follows content (size-changed); the host only provides the cap. Width is a definite value.
    containerDimensions: {
      width: Math.max(0, Math.round(input.width)),
      maxHeight: input.maxHeight ?? PLUGIN_UI_CARD_MAX_HEIGHT_PX,
    },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    platform: "desktop",
    userAgent: "zcode",
    timeZone: input.timeZone ?? resolveTimeZone(),
    // Desktop host always has hover and no touch.
    deviceCapabilities: { hover: true, touch: false },
    ...(input.styleVariables ? { styles: { variables: input.styleVariables as McpUiStyles } } : {}),
    ...(input.titleBar ? { titleBar: input.titleBar } : {}),
  };
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A page that did not declare `availableDisplayModes` counts as supporting all; once declared, it can only switch to declared modes (spec MUST NOT). */
export function appAllowsDisplayMode(
  capabilities: McpUiAppCapabilities | undefined,
  mode: McpUiDisplayMode,
  preferredDisplayMode?: McpUiDisplayMode,
): boolean {
  const declared = capabilities?.availableDisplayModes;
  if (declared && !declared.includes(mode)) return false;
  // The fullscreen tool previously fell back to inline after the side pane closed; capability support for both modes does not mean this presentation should return to the conversation.
  return !(
    mode === "inline" &&
    preferredDisplayMode === "fullscreen" &&
    (!declared || declared.includes("fullscreen"))
  );
}

/** Registered capabilities are a hard boundary; preference and anchor updates must not reintroduce modes the page does not support. */
export function constrainPluginUiDisplayModes(
  context: McpUiHostContext,
  capabilities: McpUiAppCapabilities | undefined,
  preferredDisplayMode?: McpUiDisplayMode,
): McpUiHostContext {
  const availableDisplayModes = (context.availableDisplayModes ?? ["inline", "fullscreen"]).filter(
    (mode) => mode !== "pip" && appAllowsDisplayMode(capabilities, mode, preferredDisplayMode),
  );
  const current = context.displayMode ?? "inline";
  return {
    ...context,
    availableDisplayModes,
    displayMode: availableDisplayModes.includes(current)
      ? current
      : (availableDisplayModes[0] ?? current),
  };
}

/** Inline instance receives `ui/request-display-mode`: switch only within the host's available set; `pip` and unavailable modes honestly return the current mode. */
export function resolveRequestedDisplayMode(
  requested: McpUiDisplayMode,
  current: McpUiDisplayMode,
  available: readonly McpUiDisplayMode[],
): McpUiDisplayMode {
  return requested !== "pip" && available.includes(requested) ? requested : current;
}

/**
 * Side pane instance receives `ui/request-display-mode`: a request for inline only succeeds when the scope
 * still has an inline card in the session flow to take over (the host closes the pane and returns to
 * inline); otherwise it honestly returns fullscreen. pip also falls back to fullscreen.
 */
export function resolveSidePaneDisplayModeRequest(
  requested: McpUiDisplayMode,
  canReturnInline: boolean,
): McpUiDisplayMode {
  return requested === "inline" && canReturnInline ? "inline" : "fullscreen";
}
