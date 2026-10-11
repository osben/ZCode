import { access } from "node:fs/promises";
import { join } from "node:path";

export interface BundledAgentWiring {
  ZCODE_AGENT_SERVER_COMMAND: string;
  ZCODE_AGENT_SERVER_ARGS_JSON: string;
}

export function createReleaseAgentWiring(
  runtimeRoot: string,
  runtimeNode: string,
  env: Record<string, string | undefined>,
): BundledAgentWiring | null {
  if (env.ZCODE_AGENT_SERVER_COMMAND?.trim()) return null;
  return {
    ZCODE_AGENT_SERVER_COMMAND: runtimeNode,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
      join(runtimeRoot, "zcode.cjs"),
      "app-server",
      "--stdio",
    ]),
  };
}

/**
 * Core in a release package is outside the monorepo and has no Electron runtime, so the default resolution chain in `zcodeAgentProcessManager`
 * (monorepo dev → Electron → deployed remote binary) has no match. Inject the bundled
 * `zcode.cjs` as the Agent startup command; environment overrides have the highest priority in that chain, so an explicit
 * `ZCODE_AGENT_SERVER_COMMAND` always wins, and development is unaffected when no colocated zcode.cjs exists.
 */
export async function resolveBundledAgentWiring(
  entryDir: string,
  env: Record<string, string | undefined>,
): Promise<BundledAgentWiring | null> {
  if (env.ZCODE_AGENT_SERVER_COMMAND?.trim()) {
    return null;
  }
  const bundlePath = join(entryDir, "zcode.cjs");
  try {
    await access(bundlePath);
  } catch {
    return null;
  }
  return {
    ZCODE_AGENT_SERVER_COMMAND: process.execPath,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([bundlePath, "app-server", "--stdio"]),
  };
}
