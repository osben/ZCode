/**
 * cli-fork-agent-runtime public contract (specs/fork-agent-runtime-selection.md, rule 3).
 *
 * - seedOfficialPluginsForForkRustAgent: called by the storage-preparation branch of
 *   `runZCodeProtocolAgent` after the database is prepared. With `ZCODE_FORK_AGENT_RUNTIME=rust` it
 *   lays out the official plugin store the Rust agent reads; otherwise it does nothing. Never throws.
 * - resolveForkPluginStorageRoot: the plugin store root the Rust agent reads for a workspace.
 */
export {
  resolveForkPluginStorageRoot,
  seedOfficialPluginsForForkRustAgent,
} from "./official-plugin-seed.js";
