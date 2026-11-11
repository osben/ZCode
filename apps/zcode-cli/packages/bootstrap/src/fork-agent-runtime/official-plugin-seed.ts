import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { writeBundledOfficialMarketplacePartitionSync } from "@zcode/adapters";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { type Logger, ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { FORK_AGENT_RUNTIME_ENV } from "@zcode/shared";
import { resolveOfficialPluginRoots } from "../app/bundled-plugins.js";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";

/**
 * Fork (specs/fork-agent-runtime-selection.md, rule 3): the Rust agent `zcode-rs` only reads the
 * official plugin cache that Node seeds; it has no copy of the plugin sources. With Rust effective
 * no Node agent ever runs, so the Node storage-preparation Worker, which the Host runs before every
 * agent spawn for both runtimes, is the one owner that lays out the cache for it. With Node
 * effective the agent seeds the cache itself on its first plugin resolution, so this is a no-op.
 *
 * Seeding never fails storage preparation: a broken plugin asset must not block the app start. When
 * a plugin's new version cannot be laid out, the seeder returns the last usable older cache, which
 * the Node agent passes to discovery next to the catalog. `zcode-rs` reads only the catalog, so the
 * catalog entry is pointed at that cache instead; the Rust agent then loads the same plugins.
 */
export function seedOfficialPluginsForForkRustAgent(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}): void {
  const env = input.env ?? process.env;
  if (env[FORK_AGENT_RUNTIME_ENV]?.trim() !== "rust") return;
  try {
    const storageRoot = resolveForkPluginStorageRoot({ cwd: input.cwd, env });
    const fallbackRoots = resolveOfficialPluginRoots({ env, logger: input.logger, storageRoot });
    pointCatalogAtFallbackCaches(storageRoot, fallbackRoots);
  } catch (error) {
    input.logger?.warn("Official plugin seed for the Rust agent failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "fork.rust_agent.official_plugin_seed.failed",
      module: "bootstrap.zcode_protocol",
    });
  }
}

/**
 * The plugin storage root the Rust agent reads (`StoragePaths::plugin_storage`): the merged
 * `storage.dir`, `~/` expanded to home, a relative path resolved against the workspace, not the
 * Worker's cwd (the storage Worker cannot chdir).
 */
export function resolveForkPluginStorageRoot(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const config = createConfig({ env: input.env, workingDirectory: input.cwd });
  const configured = config.config.storage.dir;
  const storageRoot =
    configured.startsWith("~/") || isAbsolute(configured)
      ? resolvePath(configured)
      : resolve(input.cwd, configured);
  return getPluginStorageRoot(getCliStorageRoot(storageRoot));
}

/**
 * Rewrites `cachePath` of each degraded plugin in the bundled catalog partition to its fallback
 * cache (`cache/zcode-plugins-official/<name>/<older version>`). Only `cachePath` changes: the entry
 * keeps the bundled version, as the Node catalog does after the same degraded seed.
 */
function pointCatalogAtFallbackCaches(storageRoot: string, fallbackRoots: string[]): void {
  if (fallbackRoots.length === 0) return;
  const fallbackByName = new Map(fallbackRoots.map((root) => [basename(dirname(root)), root]));
  const partitionPath = join(
    storageRoot,
    "marketplaces",
    ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    "bundled-marketplace.json",
  );
  const partition = JSON.parse(readFileSync(partitionPath, "utf8")) as {
    manifest: Record<string, unknown>;
  };
  const plugins = Array.isArray(partition.manifest.plugins) ? partition.manifest.plugins : [];
  writeBundledOfficialMarketplacePartitionSync({
    manifest: {
      ...partition.manifest,
      plugins: plugins.map((plugin: unknown) => {
        if (!plugin || typeof plugin !== "object") return plugin;
        const entry = plugin as Record<string, unknown>;
        const fallback = typeof entry.name === "string" ? fallbackByName.get(entry.name) : undefined;
        return fallback ? { ...entry, cachePath: fallback } : entry;
      }),
    },
    storageRoot,
  });
}
