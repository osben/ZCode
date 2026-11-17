// Fork: node_repl in the helper (specs/fork-rust-node-helper.md "F4 node_repl and browser", F4-D1). Node injects node_repl
// from its plugin resolution, not from a plugin manifest, so the helper adds it to the resolved outcome with the same rule.
import type { PluginLoadOutcome } from "@zcode/contracts";
import { ZCODE_CUA_BROKER_SOCKET_ENV_KEY } from "@zcode/shared";
import { resolveBuiltInNodeReplMcpServers } from "../app/built-in-node-repl.js";

/**
 * The outcome with node_repl's config added under its own key, as Node's app registers it. The computer-use broker
 * socket from the helper's env goes to node_repl only (F4c, F4-D6); no other server gets it.
 */
export function withNodeReplServer(
  outcome: PluginLoadOutcome,
  workingDirectory: string,
  env: NodeJS.ProcessEnv = {},
): PluginLoadOutcome {
  const nodeRepl = resolveBuiltInNodeReplMcpServers({ pluginOutcome: outcome, workingDirectory });
  if (Object.keys(nodeRepl).length === 0) return outcome;
  const socket = env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim();
  const withSocket = socket
    ? {
        ...nodeRepl,
        node_repl: {
          ...nodeRepl.node_repl,
          env: { ...nodeRepl.node_repl?.env, [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: socket },
        },
      }
    : nodeRepl;
  return { ...outcome, mcpServers: { ...outcome.mcpServers, ...withSocket } };
}
