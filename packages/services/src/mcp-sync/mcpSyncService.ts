import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpScope,
  McpServerConfig,
  McpSyncSource,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
} from "@zcode/shared";
import type { IMcpSyncService } from "./mcpSync.js";
import { checkRemoteSyncDirectoryWriteAccess } from "../remote-sync/remoteSyncWriteAccess.js";
import { createMcpDataSyncMethods } from "../data-sync/node.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

const logger = createServiceLogger("mcp-sync");

type McpConfigKeyName = "mcp.servers" | "mcpServers";

interface DirectoryMcpDescriptor {
  source: McpSyncSource;
  directorySource: SettingsDirectorySource;
  userConfigDirSegments: string[];
  workspaceConfigDirSegments: string[];
  fileName: string;
  configKeyName: McpConfigKeyName;
}

export interface UserMcpRecord {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

const ZCODE_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "zcode",
  directorySource: "zcode",
  userConfigDirSegments: [".zcode", "cli"],
  workspaceConfigDirSegments: [".zcode"],
  fileName: "config.json",
  configKeyName: "mcp.servers",
};

const AGENTS_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "agents",
  directorySource: "agents",
  userConfigDirSegments: [".agents"],
  workspaceConfigDirSegments: [".agents"],
  fileName: "mcp.json",
  configKeyName: "mcpServers",
};

const ENABLED_KEY = "enabled";
// Legacy: early desktop versions wrote the disabled state as enable, while the CLI contract field (contracts McpServerConfigBase)
// has always been enabled, leaving two representations for the same server and allowing disabled servers to start in the Agent.
// Reads and writes now use only enabled; keep this one-time migration until existing configurations are cleared, then remove the block.
const LEGACY_ENABLE_KEY = "enable";
const SECRET_CONFIG_FILE_MODE = 0o600;
const DIRECTORY_MCP_DESCRIPTORS: readonly DirectoryMcpDescriptor[] = [
  ZCODE_MCP_DESCRIPTOR,
  AGENTS_MCP_DESCRIPTOR,
];

export interface McpSyncServiceDependencies {
  setWorkspaceMcpTrust?: IMcpSyncService["setWorkspaceMcpTrust"];
  /**
   * Execution surface for checking MCP server runtime status. Actual connect/listTools checks must run in the
   * agent process (with the workspace PATH/cwd); the Host has no equivalent implementation. Calling listWorkspaceMcpServerStatuses on an instance
   * created without this dependency (for directory sync only/tests) throws explicitly.
   */
  listMcpServerStatuses?: IMcpSyncService["listWorkspaceMcpServerStatuses"];
}

export function createMcpSyncService(
  dependencies: McpSyncServiceDependencies = {},
): IMcpSyncService {
  return {
    ...createMcpDataSyncMethods(),
    async loadMcpFromUserDirectory(request) {
      return loadMcpFromUserDirectory(request);
    },
    async listWorkspaceMcpServerStatuses(params) {
      if (!dependencies.listMcpServerStatuses) {
        throw new Error("MCP server status listing is unavailable in this runtime");
      }
      return dependencies.listMcpServerStatuses(params);
    },
    async setWorkspaceMcpTrust(params) {
      if (!dependencies.setWorkspaceMcpTrust) throw new Error("workspace_mcp_trust_unavailable");
      return dependencies.setWorkspaceMcpTrust(params);
    },
    async saveMcpToUserDirectory(payload) {
      await saveMcpToUserDirectory(payload);
    },
  };
}

export function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

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

function buildUserConfigPath(descriptor: DirectoryMcpDescriptor): string {
  return buildDirectoryConfigPath(descriptor, "user");
}

export function getUserZcodeMcpConfigPath(): string {
  return buildUserConfigPath(ZCODE_MCP_DESCRIPTOR);
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

function findDescriptorByLocation(location: SettingsDirectoryLocation): DirectoryMcpDescriptor {
  const descriptor = DIRECTORY_MCP_DESCRIPTORS.find(
    (item) => item.directorySource === location.source,
  );
  if (!descriptor) {
    throw new Error(`Unsupported MCP settings directory source: ${location.source}`);
  }
  return descriptor;
}

export async function collectEffectiveUserMcpRecords(): Promise<UserMcpRecord[]> {
  const zcodeRecords = await readUserMcpRecordsFromFile(ZCODE_MCP_DESCRIPTOR);
  if (zcodeRecords.length > 0) {
    return sortMcpRecords(zcodeRecords);
  }
  return sortMcpRecords(await readUserMcpRecordsFromFile(AGENTS_MCP_DESCRIPTOR));
}

async function loadMcpFromUserDirectory(
  request?: LoadCliMcpFromUserDirectoryRequest,
): Promise<LoadCliMcpFromUserDirectoryResult> {
  const servers: NativeMcpServerRecord[] = [];
  if (request?.workspacePath) {
    servers.push(
      ...(await readDirectoryServersFromPreferredSources("workspace", request.workspacePath)),
    );
  }
  servers.push(...(await readDirectoryServersFromPreferredSources("user", request?.workspacePath)));
  return { servers };
}

async function saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void> {
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
  const existingServers = await readDirectoryServersFromFile(
    ZCODE_MCP_DESCRIPTOR,
    scope,
    payload.projectPath,
  );
  const nextServers = Object.fromEntries(
    existingServers.map((server) => [server.name, server.config as Record<string, unknown>]),
  );

  if (payload.action === "upsert") {
    if (!payload.config) {
      throw new Error("Missing MCP config for upsert action");
    }
    nextServers[payload.name] = payload.config as Record<string, unknown>;
  } else {
    delete nextServers[payload.name];
  }

  await writeZCodeServersToFile(scope, nextServers, payload.projectPath);
}

function sortMcpRecords(records: UserMcpRecord[]): UserMcpRecord[] {
  return records.sort((left, right) => left.name.localeCompare(right.name));
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
  if (zcodeServers.length > 0) {
    return zcodeServers;
  }
  return readDirectoryServersFromFile(AGENTS_MCP_DESCRIPTOR, scope, workspacePath);
}

async function readDirectoryServersFromFile(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const parsed = await readJsonObject(filePath);
  if (!parsed) {
    return [];
  }
  const serverMap = await readServerMapWithLegacyMigration(
    filePath,
    parsed,
    descriptor.configKeyName,
  );
  const location = buildDirectoryMcpLocation(descriptor, scope, workspacePath);
  return Object.entries(serverMap).map(([name, config]) => ({
    source: "zcodeagentmcp",
    scope,
    name,
    config: config as McpServerConfig,
    enabled: readServerEnabled(config),
    projectPath: scope === "workspace" ? workspacePath : undefined,
    location,
    file: {
      format: "json",
      filePath,
    },
  }));
}

async function writeZCodeServersToFile(
  scope: Exclude<McpScope, "common">,
  servers: Record<string, Record<string, unknown>>,
  workspacePath?: string,
): Promise<void> {
  const filePath = buildDirectoryConfigPath(ZCODE_MCP_DESCRIPTOR, scope, workspacePath);
  const current = (await readJsonObject(filePath)) ?? {};
  const next = writeServerMapToJson(current, ZCODE_MCP_DESCRIPTOR.configKeyName, servers);
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

async function readUserCliConfig(): Promise<Record<string, unknown>> {
  return (await readJsonObject(getUserZcodeMcpConfigPath())) ?? {};
}

async function writeUserCliConfig(config: Record<string, unknown>): Promise<void> {
  await writeTextAtomic(getUserZcodeMcpConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function removeLegacyMcpEnabledOverride(
  config: Record<string, unknown>,
  location: SettingsDirectoryLocation,
  name: string,
): { config: Record<string, unknown>; changed: boolean } {
  if (!isRecord(config.mcp) || !isRecord(config.mcp[location.directoryPath])) {
    return { config, changed: false };
  }

  const mcpConfig = { ...config.mcp };
  const pathConfig = {
    ...(mcpConfig[location.directoryPath] as Record<string, unknown>),
  };
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

async function cleanupLegacyMcpEnabledOverride(
  location: SettingsDirectoryLocation,
  name: string,
): Promise<void> {
  const userConfig = await readUserCliConfig();
  const result = removeLegacyMcpEnabledOverride(userConfig, location, name);
  if (result.changed) {
    await writeUserCliConfig(result.config);
  }
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
  const current = (await readJsonObject(filePath)) ?? {};
  const serverMap = readServerMapFromJson(current, descriptor.configKeyName);
  const currentServer = serverMap[name];
  if (!isRecord(currentServer)) {
    return;
  }
  // MCP already has an mcp.servers/mcpServers structure; store disabled state inside each server config
  // rather than at the mcp root, where it could be confused with real MCP configuration.
  const nextServerMap = {
    ...serverMap,
    [name]: setServerEnabled(currentServer as McpServerConfig, enabled) as Record<string, unknown>,
  };
  let next = writeServerMapToJson(current, descriptor.configKeyName, nextServerMap);
  const legacyCleanup = removeLegacyMcpEnabledOverride(next, location, name);
  if (legacyCleanup.changed) {
    next = legacyCleanup.config;
  }
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

async function readUserMcpRecordsFromFile(
  descriptor: DirectoryMcpDescriptor,
): Promise<UserMcpRecord[]> {
  const filePath = buildUserConfigPath(descriptor);
  const parsed = await readJsonObject(filePath);
  if (!parsed) {
    return [];
  }
  const serverMap = await readServerMapWithLegacyMigration(
    filePath,
    parsed,
    descriptor.configKeyName,
  );
  return Object.entries(serverMap).map(([name, config]) => ({
    name,
    config: config as McpServerConfig,
    enabled: readServerEnabled(config),
    source: descriptor.source,
    path: filePath,
  }));
}

export function normalizeMcpNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function readServerEnabled(config: Record<string, unknown>): boolean {
  return config[ENABLED_KEY] !== false;
}

export function setServerEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  // Enabled is the default state, so no redundant field is written to disk; any leftover legacy enable is also cleared
  // so that a self-contradictory config such as enable:false + enabled:true is never produced again.
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
    // If the two fields conflict, prefer disabled: when desktop writes enable:false it does not remove an imported enabled:true,
    // so using enabled alone would restart a server the user turned off.
    const disabled = config[LEGACY_ENABLE_KEY] === false || config[ENABLED_KEY] === false;
    migrated[name] = setServerEnabled(config as McpServerConfig, !disabled) as Record<
      string,
      unknown
    >;
  }

  return { servers: migrated, changed };
}

/**
 * Read the server map and fold any remaining enable values into enabled in place, persisting the result.
 * Do not write when there are no legacy fields, preserving idempotence; a write failure does not block the read because the in-memory result is already correct and will be retried on the next load.
 */
async function readServerMapWithLegacyMigration(
  filePath: string,
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Promise<Record<string, Record<string, unknown>>> {
  const migration = migrateLegacyEnableFlag(readServerMapFromJson(parsed, configKeyName));
  if (!migration.changed) {
    return migration.servers;
  }

  try {
    const next = writeServerMapToJson(parsed, configKeyName, migration.servers);
    await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    logger.warn(
      undefined,
      "legacy enable migration write-back failed; continuing with the in-memory result",
      {
        filePath,
        error: formatErrorMessage(error),
      },
    );
  }
  return migration.servers;
}

function readServerMapFromJson(
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Record<string, Record<string, unknown>> {
  if (configKeyName === "mcp.servers") {
    const mcp = parsed.mcp;
    if (!isRecord(mcp)) {
      return {};
    }
    const servers = mcp.servers;
    return isRecord(servers) ? (servers as Record<string, Record<string, unknown>>) : {};
  }

  const rawServerMap = parsed[configKeyName];
  return isRecord(rawServerMap) ? (rawServerMap as Record<string, Record<string, unknown>>) : {};
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

  const currentMcp = isRecord(current.mcp) ? current.mcp : {};
  return {
    ...current,
    mcp: {
      ...currentMcp,
      servers,
    },
  };
}

/** Reads `mcp.servers` from `config.json` (legacy enable fields already folded), for data sync to use after re-reading before a write. */
export function readZcodeServerMap(
  config: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return migrateLegacyEnableFlag(readServerMapFromJson(config, ZCODE_MCP_DESCRIPTOR.configKeyName))
    .servers;
}

export function writeZcodeServerMap(
  config: Record<string, unknown>,
  servers: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return writeServerMapToJson(config, ZCODE_MCP_DESCRIPTOR.configKeyName, servers);
}

export interface McpPathRewrite {
  sourceHomeDir: string;
  sourceWorkspacePath?: string;
  targetHomeDir: string;
  targetWorkspacePath?: string;
}

/** Rewrites only the `args` of filesystem-type stdio MCPs; args, env and cwd of other MCPs are kept as they are. */
export function rewriteFilesystemMcpConfig(
  name: string,
  config: McpServerConfig,
  paths: McpPathRewrite,
): McpServerConfig {
  if (!isStdioMcpConfig(config) || !isFilesystemMcpServer(name, config)) {
    return config;
  }
  if (!Array.isArray(config.args)) {
    return config;
  }
  return {
    ...config,
    args: config.args.map((arg) => rewritePathArgForRemote(arg, paths)),
  };
}

function isStdioMcpConfig(config: McpServerConfig): boolean {
  const type = typeof config.type === "string" ? config.type.trim().toLowerCase() : "";
  if (!type && typeof config.command === "string" && config.command.trim()) {
    return true;
  }
  return type === "stdio";
}

function isFilesystemMcpServer(name: string, config: McpServerConfig): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (
    normalizedName === "filesystem" ||
    normalizedName === "file-system" ||
    normalizedName === "fs"
  ) {
    return true;
  }
  const haystack = [config.command, ...(Array.isArray(config.args) ? config.args : [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes("@modelcontextprotocol/server-filesystem") ||
    haystack.includes("mcp-server-filesystem")
  );
}

function rewritePathArgForRemote(arg: string, paths: McpPathRewrite): string {
  const workspaceRelative = getRelativePathIfWithin(paths.sourceWorkspacePath, arg);
  if (workspaceRelative !== null && paths.targetWorkspacePath?.trim()) {
    return joinRemotePath(paths.targetWorkspacePath, workspaceRelative);
  }

  const homeRelative = getRelativePathIfWithin(paths.sourceHomeDir, arg);
  if (homeRelative !== null) {
    return joinRemotePath(paths.targetHomeDir, homeRelative);
  }

  return arg;
}

function getRelativePathIfWithin(
  basePath: string | undefined,
  candidatePath: string,
): string | null {
  if (!basePath?.trim()) {
    return null;
  }
  const base = normalizeComparablePath(basePath);
  const candidate = normalizeComparablePath(candidatePath);
  if (!base || !candidate) {
    return null;
  }
  const baseValue = base.caseInsensitive ? base.value.toLowerCase() : base.value;
  const candidateValue = base.caseInsensitive ? candidate.value.toLowerCase() : candidate.value;
  if (candidateValue === baseValue) {
    return "";
  }
  const prefix = baseValue.endsWith("/") ? baseValue : `${baseValue}/`;
  if (!candidateValue.startsWith(prefix)) {
    return null;
  }
  return candidate.value.slice(prefix.length);
}

function normalizeComparablePath(
  rawPath: string,
): { value: string; caseInsensitive: boolean } | null {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  const isWindowsPath = /^[a-zA-Z]:[\\/]/u.test(trimmed) || trimmed.startsWith("\\\\");
  const isPosixPath = trimmed.startsWith("/");
  if (!isWindowsPath && !isPosixPath) {
    return null;
  }

  let value = trimmed.replaceAll("\\", "/");
  value = value.replace(/\/+$/u, "");
  if (value === "") {
    value = "/";
  }
  return {
    value,
    caseInsensitive: isWindowsPath,
  };
}

function joinRemotePath(remoteBasePath: string, relativePath: string): string {
  if (!relativePath) {
    return remoteBasePath;
  }
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean);
  // MCP sync runs in the local process, but remoteWorkspacePath describes a path on the remote host.
  // Do not use process.platform to choose path syntax; a Windows client syncing to Linux/WSL would turn /srv/... into \srv\....
  const normalizedBasePath = remoteBasePath.trim();
  if (normalizedBasePath.startsWith("/")) {
    return posix.join(normalizedBasePath.replaceAll("\\", "/"), ...segments);
  }
  if (/^[a-zA-Z]:[\\/]/u.test(normalizedBasePath) || normalizedBasePath.startsWith("\\\\")) {
    return win32.join(normalizedBasePath, ...segments);
  }
  return posix.join(normalizedBasePath.replaceAll("\\", "/"), ...segments);
}

export function cloneMcpConfig(config: McpServerConfig): McpServerConfig {
  return JSON.parse(JSON.stringify(config)) as McpServerConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw new Error(`无法读取 MCP 配置文件 ${filePath}: ${formatErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // Before importing remote MCP configuration, confirm that the existing config.json can be read and merged;
    // treating corrupt JSON as an empty object would silently overwrite provider, MCP, and secret configuration.
    throw new Error(`无法解析 MCP 配置文件 ${filePath}: ${formatErrorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`MCP 配置文件 ${filePath} 必须是 JSON 对象`);
  }
  return parsed;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    // Remote MCP configuration persists secrets such as env/header/token;
    // do not rely on the remote umask for temporary-file permissions, or config.json may become readable to the group or other users after rename.
    await writeFile(tempPath, content, {
      encoding: "utf-8",
      mode: SECRET_CONFIG_FILE_MODE,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
