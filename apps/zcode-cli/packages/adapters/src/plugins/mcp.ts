import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findOfficialMcpReservedHeaders } from "@zcode/shared";
import type {
  McpOAuthConfig,
  McpServerConfig,
  McpServerConfigBase,
  PluginDiagnostic,
  PluginOptionValues,
} from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import type { LoadedPlugin } from "./types.js";
import { isNotFoundError, isRecord, resolveInside } from "./helpers.js";
import { buildOfficialProvenance, parseZCodeOfficialAuth } from "./mcp-official-auth.js";
import {
  buildPluginEnvBase,
  createVariableContext,
  PluginVariableError,
  resolveStringRecord,
  resolveTemplate,
  type VariableContext,
} from "./template.js";

const SUPPORTED_MCP_TYPES = new Set(["stdio", "http", "sse"]);

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
  // Shared fields are resolved once here so every transport keeps alwaysLoad; a transport that rebuilt
  // its config without them silently deferred always-loaded plugin tools.
  const official = context.loaded.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE;
  const baseConfig: McpServerConfigBase = {
    alwaysLoad: typeof server.alwaysLoad === "boolean" ? server.alwaysLoad : undefined,
    enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
    // A workspace-shared server must partition its own state by _meta.session_id; only official plugins are trusted to do so
    // (docs plugin viewer spec §8); other plugins' declarations are ignored to keep session isolation.
    isolation:
      official && (server.isolation === "workspace" || server.isolation === "session")
        ? server.isolation
        : undefined,
    timeoutMs: typeof server.timeoutMs === "number" ? server.timeoutMs : undefined,
    source: { kind: official ? "builtin" : "plugin" },
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
      { ...buildPluginEnvBase(context), ...(isRecord(server.env) ? server.env : {}) },
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
      ...baseConfig,
      env,
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
      ...baseConfig,
      headers,
      auth: officialAuth,
      // Provenance is generated by the host and overrides an `official` field in `.mcp.json`.
      official: buildOfficialProvenance(identity),
    };
  }

  return {
    type,
    url: resolveTemplate(url, context, { allowSensitive: false }),
    ...baseConfig,
    headers,
    oauth,
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
