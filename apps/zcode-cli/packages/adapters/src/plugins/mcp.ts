import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findOfficialMcpReservedHeaders } from "@zcode/shared";
import type {
  McpOAuthConfig,
  McpServerConfig,
  McpServerRuntimeSource,
  PluginDiagnostic,
  PluginManifest,
  PluginOptionValues,
} from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import type { LoadedPlugin } from "./types.js";
import { isNotFoundError, isPluginOptionValue, isRecord, resolveInside } from "./helpers.js";
import { buildOfficialProvenance, parseZCodeOfficialAuth } from "./mcp-official-auth.js";

const SUPPORTED_MCP_TYPES = new Set(["stdio", "http", "sse"]);
const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadPluginMcpServerDefinitions(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): Record<string, unknown> {
  const fromFile = loadMcpServersFromFile(join(input.loaded.rootPath, ".mcp.json"), input);
  const fromManifest = loadMcpServersFromSpec(input.loaded.manifest.mcpServers, input);
  return { ...fromFile, ...fromManifest };
}

export function resolvePluginMcpServers(input: {
  dataPath: string;
  definitions?: Record<string, unknown>;
  diagnostics: PluginDiagnostic[];
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  workingDirectory: string;
}): Record<string, McpServerConfig> {
  const merged = input.definitions ?? loadPluginMcpServerDefinitions(input);
  const context = createVariableContext(input);
  const result: Record<string, McpServerConfig> = {};

  for (const [name, server] of Object.entries(merged)) {
    try {
      result[toNamespacedServerName(input.loaded, name)] = resolveMcpServerConfig(server, context, {
        mcpKey: name,
        pluginId: input.loaded.id,
      });
    } catch (error) {
      input.diagnostics.push({
        code:
          error instanceof PluginVariableError
            ? "plugin_variable_missing"
            : "plugin_mcp_server_disabled",
        message: error instanceof Error ? error.message : `Invalid MCP server: ${name}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
    }
  }

  return result;
}

function toNamespacedServerName(loaded: LoadedPlugin, serverName: string): string {
  return `plugin:${loaded.manifest.name}:${serverName}`;
}

function loadMcpServersFromSpec(
  spec: unknown,
  input: {
    diagnostics: PluginDiagnostic[];
    loaded: LoadedPlugin;
  },
): Record<string, unknown> {
  if (spec === undefined) return {};
  if (typeof spec === "string") {
    const path = resolveInside(input.loaded.rootPath, spec);
    if (!path) {
      input.diagnostics.push({
        code: "plugin_component_path_invalid",
        message: `Plugin mcpServers path escapes plugin root: ${spec}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      return {};
    }
    return loadMcpServersFromFile(path, input);
  }
  if (Array.isArray(spec)) {
    return Object.assign({}, ...spec.map((item) => loadMcpServersFromSpec(item, input)));
  }
  return normalizeMcpServersShape(spec, input);
}

function loadMcpServersFromFile(
  path: string,
  input: {
    diagnostics: PluginDiagnostic[];
    loaded: LoadedPlugin;
  },
): Record<string, unknown> {
  try {
    return normalizeMcpServersShape(JSON.parse(readFileSync(path, "utf8")), input);
  } catch (error) {
    if (isNotFoundError(error)) return {};
    input.diagnostics.push({
      code: "plugin_mcp_read_failed",
      message: error instanceof Error ? error.message : `Failed to read MCP config: ${path}`,
      path,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return {};
  }
}

function normalizeMcpServersShape(
  value: unknown,
  input: {
    diagnostics: PluginDiagnostic[];
    loaded: LoadedPlugin;
  },
): Record<string, unknown> {
  if (!isRecord(value)) {
    input.diagnostics.push({
      code: "plugin_mcp_invalid",
      message: "Plugin MCP config must be an object",
      path: input.loaded.manifestPath,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return {};
  }
  const servers = isRecord(value.mcpServers) ? value.mcpServers : value;
  return Object.fromEntries(Object.entries(servers).filter(([, config]) => isRecord(config)));
}

interface VariableContext {
  dataPath: string;
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  userConfigDefaults: PluginOptionValues;
  workingDirectory: string;
}

function createVariableContext(input: {
  dataPath: string;
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  workingDirectory: string;
}): VariableContext {
  return {
    dataPath: input.dataPath,
    env: input.env,
    loaded: input.loaded,
    options: input.options,
    userConfigDefaults: getUserConfigDefaults(input.loaded.manifest),
    workingDirectory: input.workingDirectory,
  };
}

function getUserConfigDefaults(manifest: PluginManifest): PluginOptionValues {
  const defaults: PluginOptionValues = {};
  for (const [key, option] of Object.entries(manifest.userConfig ?? {})) {
    if (isPluginOptionValue(option.default)) defaults[key] = option.default;
  }
  return defaults;
}

function resolveMcpServerConfig(
  server: unknown,
  context: VariableContext,
  identity: { mcpKey: string; pluginId: string },
): McpServerConfig {
  if (!isRecord(server)) throw new Error("MCP server config must be an object");
  const type = typeof server.type === "string" ? server.type : inferMcpType(server);
  if (!SUPPORTED_MCP_TYPES.has(type)) throw new Error(`Unsupported MCP transport: ${type}`);
  // ZCode's official marketplace includes both built-in plugins loaded with the app and on-demand
  // CDN plugins. The latter have runtime source `cache`, so classify them by marketplace identity,
  // not only by loader source.
  const source: McpServerRuntimeSource = {
    kind: context.loaded.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE ? "builtin" : "plugin",
  };

  // zcode_official allows http and stdio. Disable this MCP when sse is configured rather than
  // silently ignoring it, which would make the configuration author think authentication is active.
  //
  // stdio is allowed because requests are sent by the plugin process itself, and identity headers
  // are included in each outbound protocol message's _meta (see adapters/src/mcp/index.ts). sse has
  // no corresponding channel and remains disallowed.
  const officialAuth = parseZCodeOfficialAuth(server.auth, identity.mcpKey);
  if (officialAuth && type !== "http" && type !== "stdio") {
    throw new Error(
      `MCP server ${identity.mcpKey}: ${officialAuth.type} auth requires type "http" or "stdio", got "${type}"`,
    );
  }

  if (type === "stdio") {
    const command = requireString(server.command, "stdio MCP server requires command");
    // stdio does not use the OAuth branch, so declaring oauth is invalid configuration. As with http,
    // do not choose a priority; disable the configuration.
    if (officialAuth && server.oauth !== undefined) {
      throw new Error(
        `MCP server ${identity.mcpKey}: ${officialAuth.type} auth cannot be combined with oauth`,
      );
    }
    const env = resolveStringRecord(
      {
        CLAUDE_PROJECT_DIR: context.workingDirectory,
        ZCODE_PLUGIN_DATA: context.dataPath,
        ZCODE_PLUGIN_ROOT: context.loaded.rootPath,
        ZCODE_PROJECT_DIR: context.workingDirectory,
        CLAUDE_PLUGIN_DATA: context.dataPath,
        CLAUDE_PLUGIN_ROOT: context.loaded.rootPath,
        ...(isRecord(server.env) ? server.env : {}),
      },
      context,
      { allowSensitive: true },
    );
    // A plugin manifest can customize env, but the resolver must authoritatively set plugin identity
    // (`loaded.id` comes from the local plugin registry, not serializable configuration). Otherwise a
    // third party could spoof the official zcode-cua identity and receive broker credentials intended
    // only for built-in plugins. Override the manifest env after spreading it so users and manifests
    // cannot replace the identity.
    env[ZCODE_PLUGIN_ID_ENV_KEY] = context.loaded.id;
    return {
      type: "stdio",
      command: resolveTemplate(command, context, { allowSensitive: false }),
      args: Array.isArray(server.args)
        ? server.args
            .filter((arg): arg is string => typeof arg === "string")
            .map((arg) => resolveTemplate(arg, context, { allowSensitive: false }))
        : undefined,
      cwd:
        typeof server.cwd === "string"
          ? resolveTemplate(server.cwd, context, { allowSensitive: false })
          : undefined,
      enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
      env,
      source,
      timeoutMs: typeof server.timeoutMs === "number" ? server.timeoutMs : undefined,
      ...(officialAuth
        ? {
            auth: officialAuth,
            // Provenance is generated by the host and overrides an `official` field in `.mcp.json`.
            official: buildOfficialProvenance(identity),
          }
        : {}),
    };
  }

  const url = requireString(server.url, `${type} MCP server requires url`);
  const headers = isRecord(server.headers)
    ? resolveStringRecord(server.headers, context, { allowSensitive: true })
    : undefined;
  const oauth = resolveMcpOAuthConfig(server.oauth, context);

  if (officialAuth) {
    // Phase 1 does not resolve priorities: declaring both authentication methods is a configuration
    // error, so disable the entry.
    if (oauth) {
      throw new Error(
        `MCP server ${identity.mcpKey}: ${officialAuth.type} auth cannot be combined with oauth`,
      );
    }
    // Block retained headers only on the official authentication path. Ordinary and third-party MCP
    // servers may legitimately provide a static authorization header; blocking it globally would
    // cause a regression.
    const reserved = findOfficialMcpReservedHeaders(headers);
    if (reserved.length > 0) {
      throw new Error(
        `MCP server ${identity.mcpKey}: static headers must not contain reserved header(s): ${reserved.join(", ")}`,
      );
    }
    return {
      type: "http",
      url: resolveTemplate(url, context, { allowSensitive: false }),
      enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
      headers,
      auth: officialAuth,
      source,
      // Provenance is generated by the host and overrides an `official` field in `.mcp.json`.
      official: buildOfficialProvenance(identity),
      timeoutMs: typeof server.timeoutMs === "number" ? server.timeoutMs : undefined,
    };
  }

  return {
    type,
    url: resolveTemplate(url, context, { allowSensitive: false }),
    enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
    headers,
    oauth,
    source,
    timeoutMs: typeof server.timeoutMs === "number" ? server.timeoutMs : undefined,
  } as McpServerConfig;
}

/**
 * Strict parsing of `auth` was moved to mcp-official-auth.ts because mcp.ts reached its max-lines
 * limit.
 */
function resolveMcpOAuthConfig(
  value: unknown,
  context: VariableContext,
): McpOAuthConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "client_credentials") {
    return {
      type: "client_credentials",
      clientId: resolveTemplate(
        requireString(value.clientId, "MCP OAuth client_credentials requires clientId"),
        context,
        { allowSensitive: false },
      ),
      clientSecret: resolveTemplate(
        requireString(value.clientSecret, "MCP OAuth client_credentials requires clientSecret"),
        context,
        { allowSensitive: true },
      ),
      ...(typeof value.clientName === "string"
        ? {
            clientName: resolveTemplate(value.clientName, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.scope === "string"
        ? {
            scope: resolveTemplate(value.scope, context, { allowSensitive: false }),
          }
        : {}),
    };
  }
  if (value.type === "authorization_code") {
    return {
      type: "authorization_code",
      ...(typeof value.clientId === "string"
        ? {
            clientId: resolveTemplate(value.clientId, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.clientSecret === "string"
        ? {
            clientSecret: resolveTemplate(value.clientSecret, context, { allowSensitive: true }),
          }
        : {}),
      ...(typeof value.clientName === "string"
        ? {
            clientName: resolveTemplate(value.clientName, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.redirectPath === "string"
        ? {
            redirectPath: resolveTemplate(value.redirectPath, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.scope === "string"
        ? {
            scope: resolveTemplate(value.scope, context, { allowSensitive: false }),
          }
        : {}),
    };
  }
  throw new Error(`Unsupported MCP OAuth type: ${String(value.type)}`);
}

function inferMcpType(server: Record<string, unknown>): string {
  return typeof server.command === "string" ? "stdio" : "http";
}

function requireString(value: unknown, message: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(message);
}

function resolveStringRecord(
  record: Record<string, unknown>,
  context: VariableContext,
  options: { allowSensitive: boolean },
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") result[key] = resolveTemplate(value, context, options);
  }
  return result;
}

function resolveTemplate(
  value: string,
  context: VariableContext,
  options: { allowSensitive: boolean },
): string {
  return value.replace(TEMPLATE_PATTERN, (match, name: string) => {
    switch (name) {
      case "CLAUDE_PLUGIN_ROOT":
      case "ZCODE_PLUGIN_ROOT":
        return context.loaded.rootPath;
      case "CLAUDE_PLUGIN_DATA":
      case "ZCODE_PLUGIN_DATA":
        return context.dataPath;
      case "CLAUDE_PROJECT_DIR":
      case "ZCODE_PROJECT_DIR":
        return context.workingDirectory;
      case "CLAUDE_CODE_SESSION_ID":
      case "CLAUDE_SESSION_ID":
      case "ZCODE_SESSION_ID":
        throw new PluginVariableError(
          `Plugin variable requires a runtime session context: ${name}`,
        );
      case "CLAUDE_SKILL_DIR":
      case "ZCODE_SKILL_DIR":
        throw new PluginVariableError(`Plugin variable requires a skill context: ${name}`);
      default:
        break;
    }

    if (name.startsWith("user_config.")) {
      const key = name.slice("user_config.".length);
      if (
        context.loaded.manifest.userConfig?.[key]?.sensitive === true &&
        !options.allowSensitive
      ) {
        throw new PluginVariableError(
          `Sensitive plugin user_config value cannot be used in this field: ${key}`,
        );
      }
      const configValue = context.options[key] ?? context.userConfigDefaults[key];
      if (configValue === undefined) {
        throw new PluginVariableError(`Missing plugin user_config value: ${key}`);
      }
      return String(configValue);
    }
    if (name.startsWith("ZCODE_")) {
      const envValue = context.env[name];
      if (envValue === undefined)
        throw new PluginVariableError(`Missing environment variable: ${name}`);
      return envValue;
    }
    if (options.allowSensitive && ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {

      // Resolve the token only at the sensitive sink so the secret is not expanded into args, a URL, or
      // another visible field.
      const envValue = context.env[name];
      if (envValue === undefined)
        throw new PluginVariableError(`Missing environment variable: ${name}`);
      return envValue;
    }

    return match;
  });
}

class PluginVariableError extends Error {}
