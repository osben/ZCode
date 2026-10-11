import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  ZCODE_PLUGIN_HOST_COMMAND,
  type McpServerConfig,
} from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  type OfficialPluginCacheRetryBudget,
  writeTextFileAtomicallyWithRetry,
} from "./official-plugin-cache-fs.js";

type SeaModule = typeof import("node:sea");

const MCP_SERVER_RELATIVE_PATH = ["dist", "mcp", "server.js"] as const;

export function createBundledMcpRuntimeConfig(input: {
  cwd: string;
  env?: Record<string, string>;
  relativeServerPath?: readonly string[];
  rootPath: string;
  timeoutMs?: number;
}): McpServerConfig | undefined {
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;
  return {
    args: [
      ...hostPrefixArgs,
      join(input.rootPath, ...(input.relativeServerPath ?? MCP_SERVER_RELATIVE_PATH)),
    ],
    command: process.execPath,
    cwd: input.cwd,
    env: {
      ...input.env,
      // In a packaged desktop app, process.execPath points to ZCode Helper; without Node mode it would enter Electron main by mistake.
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeoutMs: input.timeoutMs,
    type: "stdio",
  };
}

interface OfficialRuntimeManifestInput {
  pluginName: string;
  retryBudget?: OfficialPluginCacheRetryBudget;
  rootPath: string;
}

export function writeOfficialPluginRuntimeManifest(input: OfficialRuntimeManifestInput): void {
  const manifestPath = join(input.rootPath, ".zcode-plugin", "plugin.json");
  const currentContents = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(currentContents) as Record<string, unknown>;
  // Skill-only / command-only official plugins do not have mcpServers, so skip rewriting them.
  // Previously, calling asRecord(manifest.mcpServers) unconditionally threw on undefined,
  // blocking the entire seed flow and preventing listZCodeSkills from loading plugin skills.
  if (manifest.mcpServers === undefined) return;
  const mcpServers = asRecord(manifest.mcpServers);
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return;

  // Keep the generic rewrite for other legacy official plugin MCP servers. zcode-cua is currently skill/SDK-only,
  // so it does not enter this branch or create a separate CUA MCP server.
  for (const [serverKey, serverRaw] of Object.entries(mcpServers)) {
    const mcpServer = asRecord(serverRaw);
    const mcpServerEnv = isRecord(mcpServer.env) ? mcpServer.env : {};
    mcpServer.command = process.execPath;
    mcpServer.args = [...hostPrefixArgs, join(input.rootPath, ...MCP_SERVER_RELATIVE_PATH)];
    mcpServer.env = {
      ...mcpServerEnv,
      // In a packaged desktop app, process.execPath points to ZCode Helper.
      // Without the Node mode env, an official plugin MCP server would enter Electron main and trigger desktop side effects such as deep-link registration.
      ELECTRON_RUN_AS_NODE: "1",
      // Write the authoritative plugin identity (pluginName@marketplace, from the local plugin registry; manifest/user env cannot override it).
      // Other official plugins still receive an unforgeable plugin identity. CUA broker credentials are injected through trusted shared
      // node_repl config and are no longer written to a separate server.
      [ZCODE_PLUGIN_ID_ENV_KEY]: `${input.pluginName}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    };
    mcpServers[serverKey] = mcpServer;
  }
  manifest.mcpServers = mcpServers;

  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  // Unconditionally renaming an unchanged plugin.json at startup increases the chance of transient file locks from Windows antivirus/indexers.
  // Leave the file untouched when the bytes match exactly; actual updates retain atomic failure semantics.
  if (nextContents === currentContents) return;
  writeTextFileAtomicallyWithRetry(
    manifestPath,
    nextContents,
    input.retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

export function officialPluginHostPrefixArgs(): string[] | undefined {
  if (isSeaRuntime()) return [ZCODE_PLUGIN_HOST_COMMAND];

  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;

  return [...process.execArgv, resolve(entrypoint), ZCODE_PLUGIN_HOST_COMMAND];
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Official plugin manifest has invalid mcpServers.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
