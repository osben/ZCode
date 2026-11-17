// Fork: node_repl in the helper (specs/fork-rust-node-helper.md "F4 node_repl and browser", F4-D1). Node injects node_repl
// from its plugin resolution, not from a plugin manifest, so the helper adds it to the resolved outcome with the same rule.
import type { PluginLoadOutcome } from "@zcode/contracts";
import { resolveBuiltInNodeReplMcpServers } from "../app/built-in-node-repl.js";

/** The outcome with node_repl's config added under its own key, as Node's app registers it. */
export function withNodeReplServer(outcome: PluginLoadOutcome, workingDirectory: string): PluginLoadOutcome {
  const nodeRepl = resolveBuiltInNodeReplMcpServers({ pluginOutcome: outcome, workingDirectory });
  if (Object.keys(nodeRepl).length === 0) return outcome;
  return { ...outcome, mcpServers: { ...outcome.mcpServers, ...nodeRepl } };
}
