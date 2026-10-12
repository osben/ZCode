import { readPluginUiStyleVariables } from "@/plugin-ui/hostPrimitives.js";

/** Gen UI uses the body text hierarchy and neutral-color controls; do not override the standard token projection of third-party MCP apps. */
export function readGenUiStyleVariables(): Record<string, string> {
  const variables = readPluginUiStyleVariables();
  const root = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(root.getPropertyValue("--ui-font-size")) || 14;
  return {
    ...variables,
    "--font-text-md-size": `${size}px`,
    "--font-text-sm-size": `${Math.max(11, size - 2)}px`,
  };
}
