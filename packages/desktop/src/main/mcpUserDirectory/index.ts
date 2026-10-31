/**
 * MCP user-directory module - main entry point
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  CliMcpSource,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpScope,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
} from "@zcode/shared";
import { readJsonObjectFileForUpdate, updateJsonObjectFile } from "@zcode/services/node";
import type { McpConfigKeyName } from "./types.js";
import { isRecord } from "./utils.js";
import { migrateLegacyCommonMcp } from "./legacy.js";
import { logger } from "../logger.js";

// Re-export types and functions.
export type { McpConfigKeyName, OpenCodeMcpServerConfig, McpSourceDescriptor } from "./types.js";
export { MCP_SOURCE_DESCRIPTORS, getSourceDescriptor } from "./types.js";
export { migrateLegacyCommonMcp } from "./legacy.js";

interface DirectoryMcpDescriptor {
  source: CliMcpSource;
  directorySource: SettingsDirectorySource;
  userConfigDirSegments: string[];
  workspaceConfigDirSegments: string[];
  fileName: string;
  format: "json";
  configKeyName: McpConfigKeyName;
}

const ZCODE_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "zcodeagentmcp",
  directorySource: "zcode",
  userConfigDirSegments: [".zcode", "cli"],
  workspaceConfigDirSegments: [".zcode"],
  fileName: "config.json",
  format: "json",
  configKeyName: "mcp.servers",
};
const ENABLED_KEY = "enabled";
// Legacy behavior: early desktop versions wrote the disabled state as enable, while the CLI contract
// field (contracts McpServerConfigBase) has always been enabled. This gave one server two sources of
// truth and allowed the Agent to start it after it was disabled. Reads/writes now use enabled only;
// keep this one-time migration until existing configurations are cleared, then remove the whole block.
const LEGACY_ENABLE_KEY = "enable";

const AGENTS_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "zcodeagentmcp",
  directorySource: "agents",
  userConfigDirSegments: [".agents"],
  workspaceConfigDirSegments: [".agents"],
  fileName: "mcp.json",
  format: "json",
  configKeyName: "mcpServers",
};

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

const DIRECTORY_MCP_DESCRIPTORS: readonly DirectoryMcpDescriptor[] = [
  ZCODE_MCP_DESCRIPTOR,
  AGENTS_MCP_DESCRIPTOR,
];

function buildDirectoryConfigPath(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): string {
  const baseDir = scope === "user" ? resolveUserHomeDir() : workspacePath;
  if (!baseDir) {
    throw new Error(
      `Missing workspace path for ${descriptor.directorySource} workspace MCP config`,
    );
  }
  const segments =
    scope === "user" ? descriptor.userConfigDirSegments : descriptor.workspaceConfigDirSegments;
  return join(baseDir, ...segments, descriptor.fileName);
}

function getUserCliConfigPath(): string {
  return buildDirectoryConfigPath(ZCODE_MCP_DESCRIPTOR, "user");
}

function buildDirectoryMcpLocation(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): SettingsDirectoryLocation {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  return {
    source: descriptor.directorySource,
    scope: scope === "workspace" ? "project" : "user",
    directoryPath: dirname(filePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

function readServerMapFromJson(
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Record<string, Record<string, unknown>> {
  if (configKeyName === "mcp.servers") {
    const mcp = parsed.mcp;
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
      return {};
    }
    const servers = (mcp as Record<string, unknown>).servers;
    return servers && typeof servers === "object" && !Array.isArray(servers)
      ? (servers as Record<string, Record<string, unknown>>)
      : {};
  }

  const rawServerMap = parsed[configKeyName];
  return rawServerMap && typeof rawServerMap === "object" && !Array.isArray(rawServerMap)
    ? (rawServerMap as Record<string, Record<string, unknown>>)
    : {};
}

function writeServerMapToJson(
  current: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
  servers: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (configKeyName !== "mcp.servers") {
    return {
      ...current,
      [configKeyName]: servers,
    };
  }

  const currentMcp =
    current.mcp && typeof current.mcp === "object" && !Array.isArray(current.mcp)
      ? (current.mcp as Record<string, unknown>)
      : {};
  return {
    ...current,
    mcp: {
      ...currentMcp,
      servers,
    },
  };
}

function readServerEnabled(config: Record<string, unknown>): boolean {
  return config[ENABLED_KEY] !== false;
}

function setServerEnabled(
  config: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  // Enabled is the default, so do not persist a redundant field. Also remove any legacy enable field
  // to avoid writing contradictory values such as enable:false + enabled:true.
  const { [LEGACY_ENABLE_KEY]: _legacyEnable, [ENABLED_KEY]: _enabled, ...rest } = config;
  if (enabled) {
    return rest;
  }
  return { ...rest, [ENABLED_KEY]: false };
}

function migrateLegacyEnableFlag(serverMap: Record<string, Record<string, unknown>>): {
  servers: Record<string, Record<string, unknown>>;
  changed: boolean;
} {
  let changed = false;
  const migrated: Record<string, Record<string, unknown>> = {};

  for (const [name, config] of Object.entries(serverMap)) {
    if (!isRecord(config) || !(LEGACY_ENABLE_KEY in config)) {
      migrated[name] = config;
      continue;
    }
    changed = true;
    // If the fields conflict, prefer disabled: desktop may write enable:false without removing an
    // enabled:true left by an external import. Using enabled alone would restart a server the user turned off.
    const disabled = config[LEGACY_ENABLE_KEY] === false || config[ENABLED_KEY] === false;
    migrated[name] = setServerEnabled(config, !disabled);
  }

  return { servers: migrated, changed };
}

function removeLegacyMcpEnabledOverride(
  config: Record<string, unknown>,
  location: SettingsDirectoryLocation,
  name: string,
): { config: Record<string, unknown>; changed: boolean } {
  if (!isRecord(config.mcp) || !isRecord(config.mcp[location.directoryPath])) {
    return { config, changed: false };
  }

  const mcpConfig = isRecord(config.mcp) ? { ...config.mcp } : {};
  const pathConfig = isRecord(mcpConfig[location.directoryPath])
    ? { ...(mcpConfig[location.directoryPath] as Record<string, unknown>) }
    : {};
  if (!(name in pathConfig)) {
    return { config, changed: false };
  }

  delete pathConfig[name];

  if (Object.keys(pathConfig).length > 0) {
    mcpConfig[location.directoryPath] = pathConfig;
  } else {
    delete mcpConfig[location.directoryPath];
  }

  return {
    config: {
      ...config,
      mcp: mcpConfig,
    },
    changed: true,
  };
}

function findDescriptorByLocation(location: SettingsDirectoryLocation): DirectoryMcpDescriptor {
  const descriptor = DIRECTORY_MCP_DESCRIPTORS.find(
    (item) => item.directorySource === location.source,
  );
  if (!descriptor) {
    throw new Error(`Unsupported MCP settings directory source: ${location.source}`);
  }
  return descriptor;
}

// Fix: the settings page's three writers used lenient reads (read failure, corrupt JSON, or a
// non-object root all treated as an empty object) and then an atomic write without explicit
// permissions, which could flush the entire config.json (provider, MCP secrets) down to just
// the MCP field, with permissions following the umask. All writes now go through
// updateJsonObjectFile: strict read (throw on corruption, leave bytes untouched) + re-read
// before writing + atomic replace (0600). When nothing changed, a strict read decides and
// returns directly — no file is created or rewritten.
async function cleanupLegacyMcpEnabledOverride(
  location: SettingsDirectoryLocation,
  name: string,
): Promise<void> {
  const filePath = getUserCliConfigPath();
  if (
    !removeLegacyMcpEnabledOverride(await readJsonObjectFileForUpdate(filePath), location, name)
      .changed
  ) {
    return;
  }
  await updateJsonObjectFile(
    filePath,
    (current) => removeLegacyMcpEnabledOverride(current, location, name).config,
  );
}

async function writeServerEnabledToFile(
  descriptor: DirectoryMcpDescriptor,
  location: SettingsDirectoryLocation,
  name: string,
  enabled: boolean,
): Promise<void> {
  const scope: Exclude<McpScope, "common"> = location.scope === "project" ? "workspace" : "user";
  const workspacePath = scope === "workspace" ? location.projectPath : undefined;
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const hasServer = (current: Record<string, unknown>) =>
    isRecord(readServerMapFromJson(current, descriptor.configKeyName)[name]);
  if (!hasServer(await readJsonObjectFileForUpdate(filePath))) {
    return;
  }

  await updateJsonObjectFile(filePath, (current) => {
    if (!hasServer(current)) {
      return current;
    }
    const serverMap = readServerMapFromJson(current, descriptor.configKeyName);
    // MCP already has an mcp.servers/mcpServers structure. Store disabled state in each server's
    // configuration object so directory paths do not mix with actual MCP configuration at the mcp root.
    const nextServerMap = {
      ...serverMap,
      [name]: setServerEnabled(serverMap[name]!, enabled),
    };
    const next = writeServerMapToJson(current, descriptor.configKeyName, nextServerMap);
    return removeLegacyMcpEnabledOverride(next, location, name).config;
  });
}

async function readDirectoryServersFromFile(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migration = migrateLegacyEnableFlag(
      readServerMapFromJson(parsed, descriptor.configKeyName),
    );
    const serverMap = migration.servers;

    if (migration.changed) {
      // Fold any legacy enable fields into enabled in place and persist without user interaction.
      // Do not write when no legacy state remains, keeping this idempotent. A write failure (read-only
      // directory, insufficient permissions, etc.) must not block loading: the in-memory result is
      // already correct, and the next load will retry.
      try {
        await updateJsonObjectFile(filePath, (current) =>
          writeServerMapToJson(
            current,
            descriptor.configKeyName,
            migrateLegacyEnableFlag(readServerMapFromJson(current, descriptor.configKeyName))
              .servers,
          ),
        );
      } catch (error) {
        logger.warn("[mcp-user-directory] legacy enable migration failed:", filePath, error);
      }
    }

    const location = buildDirectoryMcpLocation(descriptor, scope, workspacePath);
    return Object.entries(serverMap).map(([name, config]) => ({
      source: descriptor.source,
      scope,
      name,
      config,
      enabled: readServerEnabled(config),
      projectPath: scope === "workspace" ? workspacePath : undefined,
      location,
      file: {
        format: descriptor.format,
        filePath,
      },
    }));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    // Parse/permission failure does not mean that no MCP configuration exists. Swallowing the error
    // would let the renderer send an empty list as explicit configuration through the replace path,
    // disconnecting servers that are already running.
    throw error;
  }
}

async function readDirectoryServersFromPreferredSources(
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const zcodeServers = await readDirectoryServersFromFile(
    ZCODE_MCP_DESCRIPTOR,
    scope,
    workspacePath,
  );
  // `.zcode` has higher priority; once an MCP server is read, `.agents` in the same scope is ignored.
  if (zcodeServers.length > 0) {
    return zcodeServers;
  }
  return readDirectoryServersFromFile(AGENTS_MCP_DESCRIPTOR, scope, workspacePath);
}

/** Re-read the `.zcode` server map before writing and touch only the servers the update involves; other fields are preserved. */
async function updateZCodeServersInFile(
  scope: Exclude<McpScope, "common">,
  workspacePath: string | undefined,
  update: (servers: Record<string, Record<string, unknown>>) => void,
): Promise<void> {
  const filePath = buildDirectoryConfigPath(ZCODE_MCP_DESCRIPTOR, scope, workspacePath);
  const key = ZCODE_MCP_DESCRIPTOR.configKeyName;
  await updateJsonObjectFile(filePath, (current) => {
    const servers = { ...migrateLegacyEnableFlag(readServerMapFromJson(current, key)).servers };
    update(servers);
    return writeServerMapToJson(current, key, servers);
  });
}

export async function loadCliMcpFromUserDirectory(
  request?: LoadCliMcpFromUserDirectoryRequest,
): Promise<LoadCliMcpFromUserDirectoryResult> {
  const servers: NativeMcpServerRecord[] = [];

  // After removing other providers, the ZCode Agent reads only by directory convention: workspace first, then user.
  if (request?.workspacePath) {
    servers.push(
      ...(await readDirectoryServersFromPreferredSources("workspace", request.workspacePath)),
    );
  }

  servers.push(...(await readDirectoryServersFromPreferredSources("user", request?.workspacePath)));

  return { servers };
}

export async function saveCliMcpToUserDirectory(
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  if (payload.action === "set-enabled") {
    if (typeof payload.enabled !== "boolean") {
      throw new Error("Missing enabled value for MCP set-enabled action");
    }
    const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
    const location =
      payload.location ??
      buildDirectoryMcpLocation(ZCODE_MCP_DESCRIPTOR, scope, payload.projectPath);
    await writeServerEnabledToFile(
      findDescriptorByLocation(location),
      location,
      payload.name,
      payload.enabled,
    );
    await cleanupLegacyMcpEnabledOverride(location, payload.name);
    return;
  }

  const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
  const config = payload.action === "upsert" ? payload.config : undefined;
  if (payload.action === "upsert" && !config) {
    throw new Error("Missing MCP config for upsert action");
  }
  await updateZCodeServersInFile(scope, payload.projectPath, (servers) => {
    if (config) {
      servers[payload.name] = config as Record<string, unknown>;
    } else {
      delete servers[payload.name];
    }
  });
}
