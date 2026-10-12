/**
 * Plugin ids look like `<name>@<marketplace>`; only the name part is shown to users. Pure function,
 * shared by the source label and the confirmation dialog.
 */
export function formatPluginDisplayName(pluginId: string): string {
  const at = pluginId.indexOf("@");
  const name = at > 0 ? pluginId.slice(0, at) : pluginId;
  return name.trim() || pluginId;
}
