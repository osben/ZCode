import { isAbsolute, resolve } from "node:path";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import type { Logger } from "@zcode/contracts";
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
 * Seeding never fails storage preparation: a broken plugin asset must not block the app start. The
 * Rust agent then sees whatever usable cache is already there, as the Node agent does after a
 * degraded seed.
 */
export function seedOfficialPluginsForForkRustAgent(input: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}): void {
  const env = input.env ?? process.env;
  if (env[FORK_AGENT_RUNTIME_ENV]?.trim() !== "rust") return;
  try {
    resolveOfficialPluginRoots({
      env,
      logger: input.logger,
      storageRoot: resolveForkPluginStorageRoot({ cwd: input.cwd, env }),
    });
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
