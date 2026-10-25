import { readdir } from "node:fs/promises";
import { join } from "node:path";

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";

/**
 * Keep in sync with defaultEnabled in apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts.
 * The services side (skills / commands / subagents) shares this single copy to avoid another divergence like the
 * one where zcode-guide was missed in one place.
 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  "document-skills@zcode-plugins-official",
  // The host contributes no skill/command/subagent; listed here only for one-to-one correspondence with the
  // definitions' defaultEnabled (see the comment on the same-named set in @zcode/shared). This copy has no
  // mechanical unit test to back it up, so a miss silently diverges.
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
]);

export interface OfficialPluginCacheRoot {
  /** Cache directory name, i.e. the official plugin's name. */
  name: string;
  /** Available version directories in numeric-aware descending order; the first entry is the newest version. */
  versionRoots: string[];
}

/**
 * Scans `<plugins storage>/cache/zcode-plugins-official/<name>/<version>/`.
 * Built-in official plugins are seeded here by the CLI and have no installed_plugins.json record, so services
 * that only read install records would miss them.
 * Version directories skip the CLI's backup / seed-lock / temp directories and are sorted in numeric-aware
 * descending order, matching the CLI's fallback selection.
 */
export async function scanOfficialPluginCacheRoots(
  pluginStorageRoot: string,
): Promise<OfficialPluginCacheRoot[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries;
  try {
    pluginEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: OfficialPluginCacheRoot[] = [];
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) continue;
    const pluginDir = join(cacheRoot, pluginEntry.name);
    let versionEntries;
    try {
      versionEntries = await readdir(pluginDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const versionRoots = versionEntries
      .filter((entry) => entry.isDirectory() && !isTransientCacheEntryName(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) =>
        right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }),
      )
      .map((version) => join(pluginDir, version));
    if (versionRoots.length > 0) {
      roots.push({ name: pluginEntry.name, versionRoots });
    }
  }
  return roots.sort((left, right) => left.name.localeCompare(right.name));
}

function isTransientCacheEntryName(name: string): boolean {
  return name.includes(".backup") || name.includes(".seed-lock") || name.includes(".tmp-");
}
