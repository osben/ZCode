// Fork: node_repl in the helper (specs/fork-rust-node-helper.md "F4 node_repl and browser", F4-D1). Node injects node_repl
// from its plugin resolution, not from a plugin manifest, so the helper adds it to the resolved outcome with the same rule.
import type { PluginLoadOutcome } from "@zcode/contracts";
import {
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
  getCapturedZCodeCuaBrokerCredentials,
} from "@zcode/shared";
import { resolveBuiltInNodeReplMcpServers } from "../app/built-in-node-repl.js";

/** Node's refresh marker key (mcp-config.ts REFRESH_MARKER_ENV). */
const REFRESH_MARKER_ENV = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";

/**
 * The env node_repl gets for the computer-use broker, as Node's injectCuaCredentialsIntoNodeRepl builds it. The CLI
 * entry strips the socket from process.env before the helper runs, so the in-process capture comes first (Node's
 * resolveZCodeCuaBrokerSocket). The markers let node_repl's plugin-host child restore the socket after its own
 * sanitization; without them the child drops it and Computer Use degrades silently.
 */
function cuaNodeReplEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const captured = getCapturedZCodeCuaBrokerCredentials();
  const socket = captured.socket || env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim();
  if (!socket) return undefined;
  const refreshMarker = captured.refreshMarker || env[REFRESH_MARKER_ENV]?.trim();
  return {
    [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: socket,
    ...(refreshMarker ? { [REFRESH_MARKER_ENV]: refreshMarker } : {}),
    ...(captured.pluginAuthority ? { [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: captured.pluginAuthority } : {}),
    [ZCODE_CUA_NODE_REPL_HOST_ENV_KEY]: "1",
    [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  };
}

/**
 * The outcome with node_repl's config added under its own key, as Node's app registers it. The computer-use broker
 * socket goes to node_repl only (F4c, F4-D6); no other server gets it.
 */
export function withNodeReplServer(
  outcome: PluginLoadOutcome,
  workingDirectory: string,
  env: NodeJS.ProcessEnv = {},
): PluginLoadOutcome {
  const nodeRepl = resolveBuiltInNodeReplMcpServers({ pluginOutcome: outcome, workingDirectory });
  if (Object.keys(nodeRepl).length === 0) return outcome;
  // Node's injection only touches a stdio node_repl (injectCuaCredentialsIntoNodeRepl).
  const config = nodeRepl.node_repl;
  const cuaEnv = config?.type === "stdio" ? cuaNodeReplEnv(env) : undefined;
  const withCua =
    config?.type === "stdio" && cuaEnv
      ? { ...nodeRepl, node_repl: { ...config, env: { ...config.env, ...cuaEnv } } }
      : nodeRepl;
  return { ...outcome, mcpServers: { ...outcome.mcpServers, ...withCua } };
}
