import type { McpAppsStyleVariables } from "@zcode/shared/mcp-apps";
import { buildPluginUiStyleVariables } from "../domain/pluginUiStyleVariables.js";

/**
 * Reads the computed values of theme tokens from the host root element (they change when `.dark` /
 * the zai theme class toggles). In non-DOM environments (unit tests, SSR) everything falls back.
 */
export function readPluginUiStyleVariables(): McpAppsStyleVariables {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return buildPluginUiStyleVariables(() => undefined);
  }
  const style = getComputedStyle(document.documentElement);
  return buildPluginUiStyleVariables((token) => style.getPropertyValue(token));
}
