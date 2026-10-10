/**
 * MCP (Model Context Protocol) types for ZCode
 * Based on the original Tauri implementation
 */

import type { SettingsDirectoryLocation } from "./settings-source.js";
import type { McpServerFailureKind } from "./zcode-protocol/index.js";

// CUA official plugin identity constants (ported from feat; shared by the UI Settings panel and bootstrap to prevent literal drift).
export const ZCODE_CUA_OFFICIAL_PLUGIN_ID = "computer-use@zcode-plugins-official";
// CUA server identity strings (ported from feat mcp.ts): the server key is the model-visible tool-prefix segment (intentionally omitting zcode-);
// the namespace name is the official plugin runtime namespace, plugin:<pluginId>:<serverKey>.
export const ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME = "plugin:computer-use:computer-use";
// Plugin identity env key: the resolver (adapters/src/plugins/mcp.ts) writes loaded.id as the authority; manifest/user env cannot override it.
// bootstrap and cli/plugin-host-command.ts share this constant to identify the official zcode-cua plugin server and prevent literal drift.
export const ZCODE_PLUGIN_ID_ENV_KEY = "ZCODE_PLUGIN_ID";

export type McpSource = "mcp" | "zcodeagentmcp";
export type CliMcpSource = Exclude<McpSource, "mcp">;
export type McpScope = "common" | "user" | "workspace";
export type McpFileFormat = "json";

// Single MCP server configuration
export interface McpServerConfig {
  type?: string; // Supports stdio, http, sse, streamableHttp, etc.
  url?: string; // HTTP/SSE server URL
  command?: string; // stdio server command
  args?: string[]; // stdio server arguments
  env?: Record<string, string>; // stdio server environment variables
  headers?: Record<string, string>; // HTTP/SSE server request headers
  http_headers?: Record<string, string>; // Legacy compatibility field; older BigModel MCP configs put authentication headers here.
  oauth?: McpOAuthConfig; // HTTP/SSE OAuth machine credential configuration
  // Linear specific fields
  apiKey?: string;
  projectId?: string;
  issueType?: string;
  // Figma specific fields
  personalAccessToken?: string;
  fileId?: string;
  nodeId?: string;
  // Sentry specific fields
  organizationName?: string;
  projectName?: string;
  dsn?: string;
  // Context7 specific fields
  apiEndpoint?: string;
  [key: string]: any;
}

export type McpServerStatus = "connected" | "disconnected" | "error" | "connecting" | "unknown";

export interface CliMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
  projects: Record<string, Record<string, McpServerConfig>>;
}

export interface SaveCliMcpToUserDirectoryRequest {
  action: "upsert" | "delete" | "set-enabled";
  source: CliMcpSource;
  name: string;
  config?: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
}

export interface NativeMcpFileReference {
  format: McpFileFormat;
  filePath: string;
}

export interface NativeMcpServerRecord {
  source: McpSource;
  scope: McpScope;
  name: string;
  config: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface LoadCliMcpFromUserDirectoryRequest {
  workspacePath?: string;
}

export interface LoadCliMcpFromUserDirectoryResult {
  servers: NativeMcpServerRecord[];
}

export interface MigrateLegacyCommonMcpRequest {
  legacyStorageDir?: string;
}

export interface MigrateLegacyCommonMcpResult {
  servers: Record<string, McpServerConfig>;
  sourcePath?: string;
  /** Total MCP configurations found in legacy data. */
  totalCount: number;
  /** Number imported successfully. */
  importedCount: number;
  /** Number skipped because they already exist. */
  skippedCount: number;
}

export interface McpConfig {
  mcp: {
    mcpServers: Record<string, McpServerConfig>;
  };
  zcodeagentmcp: CliMcpConfig;
}

export interface ZCodeMcpServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  changed?: boolean;
  status?: McpServerStatus;
  lastConnected?: Date;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  toolCount?: number;
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface McpServerListItem {
  id: string;
  name: string;
  enabled: boolean;
  status: McpServerStatus;
  hasConfig: boolean;
  error?: string;
  toolCount?: number;
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  file?: NativeMcpFileReference;
}

export interface McpTestResult {
  success: boolean;
  error?: string;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: any;
  }>;
  serverInfo?: {
    name: string;
    version: string;
  };
  response_time?: number;
}

export type ZCodeAgentMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      timeoutMs?: number;
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      headers: Array<{ name: string; value: string }>;
      oauth?: McpOAuthConfig;
      timeoutMs?: number;
    };

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

export function getMcpServerRequestHeaders(
  config: McpServerConfig,
): Record<string, string> | undefined {
  return config.headers ?? config.http_headers;
}

// Single source of truth for identifying the zcode-cua MCP server. The Desktop product broker resolver
// (mcpBrokerInjection in @zcode/services) and CLI bootstrap (mcp-config in apps/zcode-cli) must use the
// exact same check. Otherwise the same MCP configuration could behave differently at each entry point,
// skip product-broker injection, and let Python/uvx own macOS TCC permissions (violating the fail-closed boundary).
// Changing this check updates both paths.
function zcodeCuaArgLeaf(value: string): string {
  // Remove trailing path separators before taking the basename: splitting `.../zcode-cua/` directly gives an empty basename and can cause a false negative (fail-open).
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? value
  );
}

// Whether a candidate string is a zcode-cua package spec. PyPI treats `_` and `-` as equivalent, so normalize
// underscores to hyphens first (zcode_cua → zcode-cua). Supports uv/npm `@version`, pip `==version`, extras `[...]`,
// git `.git`/`.git@`, and dotted submodules such as `python -m zcode_cua.server` (`zcode-cua.<submodule>`).
// At this fail-closed boundary, false positives are preferable to false negatives; `zcode-cua-proxy` is still
// excluded because a hyphen continuation is not one of the `.`, `@`, `[`, or `==` boundaries.
function matchesZCodeCuaSpec(candidate: string): boolean {
  const c = candidate.replace(/_/g, "-");
  return (
    c === "zcode-cua" ||
    c.startsWith("zcode-cua[") ||
    c.startsWith("zcode-cua@") ||
    c.startsWith("zcode-cua==") ||
    // The `.` branch covers `zcode-cua.git` / `zcode-cua.git@v1` and Python submodules such as `zcode-cua.server`.
    c.startsWith("zcode-cua.")
  );
}

/**
 * Whether an MCP server command points to zcode-cua. Uses the same package-spec check as args (and compares
 * the path basename), covering `command: "zcode-cua"`, `/opt/bin/zcode-cua`, and package specs used directly
 * as commands (such as `zcode-cua@1.2.3`). At this fail-closed boundary, false positives are preferable to false negatives.
 */
export function isZCodeCuaMcpCommand(command: string): boolean {
  return matchesZCodeCuaSpec(command) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(command));
}

/**
 * Whether one arg is a zcode-cua package spec. Covers `zcode-cua`, `zcode-cua[macos]`, `zcode-cua@1.2.3`,
 * `zcode-cua==1.2.3`, `zcode_cua`, and git/local path forms (`.../zcode-cua`, `zcode-cua.git`,
 * `git+https://.../zcode-cua.git@v1`). Checks both the raw value and path basename to cover `--from <path>` and `--from <git-url>`.
 */
export function isZCodeCuaMcpPackageArg(value: string): boolean {
  return matchesZCodeCuaSpec(value) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(value));
}

export function convertToZCodeAgentMcpServer(
  name: string,
  config: McpServerConfig,
): ZCodeAgentMcpServer | null {
  let inferredType = config.type;
  if (!inferredType) {
    if (config.command) inferredType = "stdio";
    else if (config.url) inferredType = "http";
  }

  const isStdio = inferredType === "stdio";
  if (isStdio && config.command) {
    // On Windows, the agent usually starts subprocesses with shell: true.
    // "cmd /c npx ..." then gets wrapped twice as "cmd.exe /c cmd /c npx ...", causing connection failures.
    // Remove the cmd /c wrapper here and use the inner command directly.
    let command = config.command;
    let args = config.args || [];
    // Detect the platform automatically: use process.platform in Node.js and navigator.platform in browsers.
    const isWin32 =
      (typeof process !== "undefined" && process.platform === "win32") ||
      (typeof navigator !== "undefined" && /win/i.test(navigator.platform));
    if (isWin32) {
      const lowerCmd = command.toLowerCase();
      const unwrappedCommand = args[1];
      if ((lowerCmd === "cmd" || lowerCmd === "cmd.exe") && args[0] === "/c" && unwrappedCommand) {
        // With noUncheckedIndexedAccess, args[1] remains string | undefined even after checking length.
        // Read it explicitly and check for emptiness to narrow the type and avoid passing an empty command to the ZCode Agent.
        command = unwrappedCommand;
        args = args.slice(2);
      }
    }
    return {
      name,
      command,
      args,
      env: config.env
        ? Object.entries(config.env).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      // The MCP Settings page writes timeoutMs to config. When session/create passes it through a protocol DTO,
      // only positive integers are allowed; otherwise the strict protocol schema would turn an ignored legacy
      // invalid value into a session-creation failure.
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  } else if (config.url && inferredType) {
    const normalizedType: "http" | "sse" = inferredType === "sse" ? "sse" : "http";
    const headers = getMcpServerRequestHeaders(config);
    return {
      name,
      type: normalizedType,
      url: config.url,
      headers: headers
        ? Object.entries(headers).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      ...(isValidMcpOAuthConfig(config.oauth) ? { oauth: config.oauth } : {}),
      // HTTP/SSE MCP must preserve timeout configuration just like stdio, so saving in the UI does not drop the field from the actual session.
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  }
  return null;
}

function isValidMcpTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isMcpIsolation(value: unknown): value is "session" | "workspace" {
  return value === "session" || value === "workspace";
}

function isMcpProtocolVersion(value: unknown): value is "legacy" | "auto" | "2026-07-28" {
  return value === "legacy" || value === "auto" || value === "2026-07-28";
}

function isValidMcpOAuthConfig(value: unknown): value is McpOAuthConfig {
  if (!isRecord(value)) return false;
  if (
    value.type === "client_credentials" &&
    typeof value.clientId === "string" &&
    value.clientId.trim().length > 0 &&
    typeof value.clientSecret === "string" &&
    value.clientSecret.trim().length > 0
  ) {
    return (
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  if (value.type === "authorization_code") {
    return (
      (value.clientId === undefined || typeof value.clientId === "string") &&
      (value.clientSecret === undefined || typeof value.clientSecret === "string") &&
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.redirectPath === undefined || typeof value.redirectPath === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
