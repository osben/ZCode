// Build a session-frozen catalog of Plugin identities.
// Bootstrap builds it once from resolveStartupPlugins when the App (session runtime) is created;
// workspace configuration changes do not update it afterward.
import type {
  PluginMetadata,
  PluginReferenceCatalog,
  PluginReferenceCatalogEntry,
} from "@zcode/contracts";

function collectDeclaredSkillQualifiedNames(plugin: PluginMetadata): string[] {
  const names = new Set<string>();
  for (const group of plugin.components) {
    if (group.kind !== "skill") continue;
    for (const item of group.items) {
      const skillName = item.name.trim();
      if (!skillName) continue;
      names.add(`${plugin.name}:${skillName}`);
    }
  }
  return [...names].sort();
}

function collectDeclaredSubagentNames(plugin: PluginMetadata): string[] {
  const names = new Set<string>();
  for (const group of plugin.components) {
    if (group.kind !== "agent") continue;
    for (const item of group.items) {
      const subagentName = item.name.trim();
      if (!subagentName) continue;
      names.add(`${plugin.name}:${subagentName}`);
    }
  }
  return [...names].sort();
}

/**
 * Build the identity catalog from authoritative metadata provided by the plugin loader.
 * - Include every discovered Plugin, including disabled ones: disabled entries support
 *   `disabled_in_session` diagnostics and Picker filtering, but cannot be referenced.
 * - Conflicts are enabled Plugins sharing a manifest.name; each receives the others' IDs in
 *   conflictingPluginIds (the machine-readable basis for V1 fail-closed behavior). Disabled entries
 *   do not conflict because they are absent from the runtime namespace.
 */
export function buildPluginReferenceCatalog(
  plugins: readonly PluginMetadata[],
): PluginReferenceCatalog {
  const enabledIdsByName = new Map<string, string[]>();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const ids = enabledIdsByName.get(plugin.name) ?? [];
    ids.push(plugin.id);
    enabledIdsByName.set(plugin.name, ids);
  }

  const entries: PluginReferenceCatalogEntry[] = plugins.map((plugin) => {
    const sameNameEnabledIds = plugin.enabled ? (enabledIdsByName.get(plugin.name) ?? []) : [];
    return {
      pluginId: plugin.id,
      name: plugin.name,
      marketplace: plugin.marketplace,
      enabled: plugin.enabled,
      conflictingPluginIds: sameNameEnabledIds.filter((id) => id !== plugin.id).sort(),
      skillQualifiedNames: collectDeclaredSkillQualifiedNames(plugin),
      // mcpServerNames come from namespaced servers resolved by the enabled branch (`plugin:${name}:${server}`);
      // disabled Plugins have no runtime MCP names, so keep this array empty.
      mcpServerNames: [...plugin.mcpServerNames].sort(),
      subagentNames: collectDeclaredSubagentNames(plugin),
      rootPath: plugin.rootPath,
    };
  });

  return { plugins: entries };
}

export function findPluginReferenceCatalogEntry(
  catalog: PluginReferenceCatalog | undefined,
  pluginId: string,
): PluginReferenceCatalogEntry | undefined {
  return catalog?.plugins.find((entry) => entry.pluginId === pluginId);
}
