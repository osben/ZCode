import type { ZCodePluginInfo, ZCodePluginUserConfigOption } from "@zcode/shared";

export type PluginOptionDraftValue = string | number | boolean | null;

interface PluginConfigPatch {
  options: Record<string, string | number | boolean>;
  clearOptionKeys: string[];
}

/**
 * Build a write patch for Plugin configuration.
 *
 * `configuredOptions` is the effective value for the current scope and must not be written back as the entire draft during save;
 * otherwise, changing one field on the Workspace page would also freeze other User/default fields as Workspace overrides.
 * Only fields explicitly added to the draft belong in this write.
 */
export function buildPluginConfigPatch(
  plugin: Pick<ZCodePluginInfo, "userConfig">,
  drafts: Record<string, PluginOptionDraftValue | undefined>,
): PluginConfigPatch {
  const options: Record<string, string | number | boolean> = {};
  const clearOptionKeys: string[] = [];

  for (const [key, option] of Object.entries(plugin.userConfig ?? {}) as [
    string,
    ZCodePluginUserConfigOption,
  ][]) {
    const draft = drafts[key];
    if (draft === undefined) continue;
    if (draft === null) {
      clearOptionKeys.push(key);
      continue;
    }

    // An empty Sensitive value still means "do not modify the existing value"; only null explicitly clears it.
    if (option.sensitive && draft === "") continue;

    if (option.type === "number") {
      const numeric = typeof draft === "number" ? draft : Number(draft);
      if (Number.isFinite(numeric)) options[key] = numeric;
      continue;
    }
    options[key] = draft;
  }

  return { options, clearOptionKeys };
}
