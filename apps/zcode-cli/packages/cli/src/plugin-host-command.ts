import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZCODE_PLUGIN_HOST_COMMAND } from "@zcode/contracts/plugins";
import {
  getCapturedZCodeCuaBrokerCredentials,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
} from "@zcode/shared/runtime-env";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared/mcp";
import type { RunContext } from "@zcode/shared-types";

const HOST_USAGE = `${ZCODE_PLUGIN_HOST_COMMAND} <server-path> [-- <server-arg>...]`;

type HostedPluginModule = {
  main?: unknown;
};

export function isPluginHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_PLUGIN_HOST_COMMAND;
}

// __zcode-plugin-host runs an official plugin's MCP server (server.js) in an Agent
// subprocess. The CLI entry's applyCliRuntimeEnvSanitization in main.ts removes the
// broker token from process.env and captures it in-process, making this the last host
// boundary that can restore the bearer token. The capture proves only that some Agent
// process received Helper credentials; it does not prove the supplied server is the
// official zcode-cua. Restoring the token for any server path based only on capture
// presence would let a third-party/replaced plugin obtain the CUA broker's TCC
// capability. Validate the plugin id written authoritatively by the resolver, the full
// captured credential group, and the canonical broker socket together. Reject any
// mismatch before import, so an untrusted module is not loaded before token exposure.
export async function runPluginHostCommand(ctx: RunContext, argv: string[]): Promise<number> {
  if (argv.length < 1) {
    ctx.stderr.write(`Usage: ${HOST_USAGE}\n`);
    return 1;
  }

  const [rawServerPath, ...serverArgs] = argv;

  try {
    if (rawServerPath === undefined) {
      throw new Error("Plugin server path is required.");
    }

    const serverPath = resolve(rawServerPath);
    if (!existsSync(serverPath)) {
      throw new Error("Plugin server file does not exist.");
    }
    const capturedBrokerCredentials = getCapturedZCodeCuaBrokerCredentials();
    assertCapturedBrokerLaunchIsAuthorized(capturedBrokerCredentials);
    const module = (await import(pathToFileURL(serverPath).href)) as HostedPluginModule;
    if (typeof module.main !== "function") {
      throw new Error("Plugin server does not export main().");
    }

    const originalArgv = process.argv;
    const originalBrokerSocket = process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
    // The shared node_repl restores the same credential group to the environment for the
    // broker bridge to read; the old standalone CUA MCP no longer has an execution entry point.
    process.argv = [process.execPath, serverPath, ...serverArgs];
    if (capturedBrokerCredentials.socket && process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] === "1") {
      process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = capturedBrokerCredentials.socket;
    }
    try {
      await module.main();
    } finally {
      process.argv = originalArgv;
      if (originalBrokerSocket === undefined) {
        delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY];
      } else {
        process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY] = originalBrokerSocket;
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Plugin host failed: ${message}\n`);
    return 1;
  }
}

type CapturedBrokerCredentials = ReturnType<typeof getCapturedZCodeCuaBrokerCredentials>;

function assertCapturedBrokerLaunchIsAuthorized(credentials: CapturedBrokerCredentials): void {
  const hasCapturedCredentials = Boolean(credentials.socket || credentials.pluginAuthority);
  if (!hasCapturedCredentials) return;

  const pluginId = process.env[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase();
  // The credential group no longer contains a token: the broker now uses identity mode
  // on every platform (Helper validates the peer's code signature). In
  // shared/runtimeEnv.ts, CapturedCuaBrokerCredentials contains only socket +
  // pluginAuthority (+ refreshMarker). Do not read `credentials.token` here; the token
  // was removed, and CLI's own typecheck is the only check that would catch a stale
  // reader (root `pnpm typecheck` excludes apps/zcode-cli).
  // socket + pluginAuthority must be present together (authority is the provenance
  // nonce bootstrap writes into node_repl config for core to recognize the official
  // server). Capture already snapshots only complete pairs; an incomplete pair is
  // cleared and fails closed. Validation also must not require a token: identity-mode
  // credentials have none, and strict token validation would make the node_repl host
  // exit at startup ("connection closed during the server/discover probe") with no tools.
  if (
    credentials.socket === undefined ||
    credentials.pluginAuthority === undefined ||
    pluginId !== ZCODE_CUA_OFFICIAL_PLUGIN_ID ||
    process.env[ZCODE_CUA_NODE_REPL_HOST_ENV_KEY] !== "1"
  ) {
    throw new Error(
      "Captured ZCode CUA broker credentials may only launch the trusted shared node_repl host",
    );
  }
}
