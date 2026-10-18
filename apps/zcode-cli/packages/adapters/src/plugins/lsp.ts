import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { PluginDiagnostic, PluginOptionValues, ResolvedLspServer } from "@zcode/contracts";
import {
  LSP_DEFAULT_MAX_RESTARTS,
  LSP_DEFAULT_REQUEST_TIMEOUT_MS,
  LSP_DEFAULT_SHUTDOWN_TIMEOUT_MS,
  LSP_DEFAULT_STARTUP_TIMEOUT_MS,
  LspServerConfigSchema,
  type LspServerConfig,
} from "@zcode/contracts";
import { isNotFoundError, isRecord, resolveInside } from "./helpers.js";
import type { LoadedPlugin } from "./types.js";
import {
  buildPluginEnvBase,
  createVariableContext,
  resolveStringRecord,
  resolveTemplate,
  type VariableContext,
} from "./template.js";

// Claude Code compatible LSP declarations: the default `.lsp.json` at the plugin root, plus the
// manifest `lspServers` field (path, array, or inline map). Spec: docs/design/v2/tool/19-lsp.md §2.
const LSP_CONFIG_FILE_NAME = ".lsp.json";
const LSP_MANIFEST_FIELD = "lspServers";
const LSP_CONFIG_WRAPPER_KEY = "lspServers";
const LSP_DEFAULT_RESTART_ON_CRASH = true;
const LSP_DEFAULT_DIAGNOSTICS_AFTER_EDIT = true;
const LSP_EXTENSION_LIST_SEPARATOR = ", ";
const PATH_ESCAPE_PREFIX = `..${sep}`;

export interface LspDefinitionInput {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}

/**
 * Read and validate the declared language servers of one plugin, regardless of its enabled state
 * (the same rule as MCP definitions, so the management page can show them). Invalid entries are
 * dropped with an `lsp_config_invalid` warning; only that server is lost. Later declarations of the
 * same name replace earlier ones before validation, so an invalid replacement removes the server.
 */
export function loadPluginLspServerDefinitions(
  input: LspDefinitionInput,
): Record<string, LspServerConfig> {
  const defaultFile = join(input.loaded.rootPath, LSP_CONFIG_FILE_NAME);
  const fromFile = loadLspServersFromFile(defaultFile, input, { optional: true });
  const fromManifest = loadLspServersFromSpec(input.loaded.manifest[LSP_MANIFEST_FIELD], input);
  return validateLspServers({ ...fromFile, ...fromManifest }, input);
}

function loadLspServersFromSpec(spec: unknown, input: LspDefinitionInput): Record<string, unknown> {
  if (spec === undefined) return {};
  if (typeof spec === "string") {
    const path = resolveInside(input.loaded.rootPath, spec);
    if (!path) {
      input.diagnostics.push({
        code: "plugin_component_path_invalid",
        message: `Plugin lspServers path escapes plugin root: ${spec}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      return {};
    }
    return loadLspServersFromFile(path, input, { optional: false });
  }
  if (Array.isArray(spec)) {
    return Object.assign({}, ...spec.map((item) => loadLspServersFromSpec(item, input)));
  }
  if (isRecord(spec)) return normalizeLspServersShape(spec, input);
  pushInvalid(input, "lspServers must be a path, an array, or an object");
  return {};
}

function loadLspServersFromFile(
  path: string,
  input: LspDefinitionInput,
  options: { optional: boolean },
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // The default file is optional; a declared path that is missing is a configuration error.
    if (isNotFoundError(error) && options.optional) return {};
    input.diagnostics.push({
      code: "lsp_config_invalid",
      message: `Failed to read LSP config ${path}: ${error instanceof Error ? error.message : String(error)}`,
      path,
      pluginId: input.loaded.id,
      severity: "warning",
    });
    return {};
  }
  return normalizeLspServersShape(parsed, input, path);
}

/** Accept either a bare server map or the `{ "lspServers": { ... } }` wrapper used by some files. */
function normalizeLspServersShape(
  value: unknown,
  input: LspDefinitionInput,
  path?: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    pushInvalid(input, "LSP config must be an object", path);
    return {};
  }
  const servers = isRecord(value[LSP_CONFIG_WRAPPER_KEY]) ? value[LSP_CONFIG_WRAPPER_KEY] : value;
  return { ...servers };
}

function validateLspServers(
  raw: Record<string, unknown>,
  input: LspDefinitionInput,
): Record<string, LspServerConfig> {
  const valid: Record<string, LspServerConfig> = {};
  for (const [serverName, value] of Object.entries(raw)) {
    const parsed = LspServerConfigSchema.safeParse(value);
    if (parsed.success) {
      valid[serverName] = parsed.data;
      continue;
    }
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    input.diagnostics.push({
      code: "lsp_config_invalid",
      message: `LSP server "${serverName}" in plugin ${input.loaded.id} is invalid and was skipped: ${issues}`,
      path: input.loaded.manifestPath,
      pluginId: input.loaded.id,
      severity: "warning",
    });
  }
  return valid;
}

function pushInvalid(input: LspDefinitionInput, message: string, path?: string): void {
  input.diagnostics.push({
    code: "lsp_config_invalid",
    message: `${message} (plugin ${input.loaded.id})`,
    path: path ?? input.loaded.manifestPath,
    pluginId: input.loaded.id,
    severity: "warning",
  });
}

export interface ResolveLspServersInput {
  dataPath: string;
  definitions: Record<string, LspServerConfig>;
  diagnostics: PluginDiagnostic[];
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  priority: number;
  workingDirectory: string;
}

/**
 * Turn validated declarations into runnable servers for an enabled plugin: expand templates with
 * the MCP stdio resolver, apply defaults, and namespace the id. A server whose templates cannot be
 * expanded is skipped with `lsp_config_invalid`; the rest of the plugin still loads.
 */
export function resolvePluginLspServers(input: ResolveLspServersInput): ResolvedLspServer[] {
  const context = createVariableContext(input);
  const result: ResolvedLspServer[] = [];
  for (const [serverName, config] of Object.entries(input.definitions)) {
    try {
      result.push(resolveLspServer(config, serverName, context, input.priority));
    } catch (error) {
      input.diagnostics.push({
        code: "lsp_config_invalid",
        message: `LSP server "${serverName}" in plugin ${input.loaded.id} could not be resolved and was skipped: ${error instanceof Error ? error.message : String(error)}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "warning",
      });
    }
  }
  return result;
}

function resolveLspServer(
  config: LspServerConfig,
  serverName: string,
  context: VariableContext,
  priority: number,
): ResolvedLspServer {
  const env = resolveStringRecord(
    { ...buildPluginEnvBase(context), ...config.env },
    context,
    { allowSensitive: true },
  );
  const workspaceFolder =
    config.workspaceFolder !== undefined
      ? resolveWorkspaceFolder(
          resolveTemplate(config.workspaceFolder, context, { allowSensitive: false }),
          context.workingDirectory,
        )
      : undefined;
  const pluginId = context.loaded.id;
  return {
    id: `${pluginId}/${serverName}`,
    pluginId,
    serverName,
    priority,
    command: resolveTemplate(config.command, context, { allowSensitive: false }),
    args: (config.args ?? []).map((arg) =>
      resolveTemplate(arg, context, { allowSensitive: false }),
    ),
    env,
    extensionToLanguage: { ...config.extensionToLanguage },
    ...(config.initializationOptions !== undefined
      ? { initializationOptions: config.initializationOptions }
      : {}),
    ...(config.settings !== undefined ? { settings: config.settings } : {}),
    ...(workspaceFolder !== undefined ? { workspaceFolder } : {}),
    startupTimeoutMs: config.startupTimeout ?? LSP_DEFAULT_STARTUP_TIMEOUT_MS,
    shutdownTimeoutMs: config.shutdownTimeout ?? LSP_DEFAULT_SHUTDOWN_TIMEOUT_MS,
    requestTimeoutMs: config.requestTimeout ?? LSP_DEFAULT_REQUEST_TIMEOUT_MS,
    restartOnCrash: config.restartOnCrash ?? LSP_DEFAULT_RESTART_ON_CRASH,
    maxRestarts: config.maxRestarts ?? LSP_DEFAULT_MAX_RESTARTS,
    diagnosticsAfterEdit: config.diagnostics ?? LSP_DEFAULT_DIAGNOSTICS_AFTER_EDIT,
  };
}

/**
 * `workspaceFolder` must stay inside the workspace. Absolute paths are accepted only when they
 * are inside it, and the result is stored relative to the workspace (undefined means the root).
 */
function resolveWorkspaceFolder(value: string, workingDirectory: string): string | undefined {
  const relativePath = isAbsolute(value)
    ? relative(workingDirectory, value)
    : relative(workingDirectory, join(workingDirectory, value));
  if (relativePath === "") return undefined;
  const escapesWorkspace =
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(PATH_ESCAPE_PREFIX);
  if (escapesWorkspace) {
    throw new Error(`workspaceFolder must be inside the workspace: ${value}`);
  }
  return relativePath;
}

export interface LspExtensionShadow {
  extensions: string[];
  pluginId: string;
  serverId: string;
  serverName: string;
  winnerId: string;
}

/**
 * Resolve extension conflicts across enabled plugins. The rule matches skills and commands: the
 * lower load priority value is processed first and keeps an extension, so the earlier-loaded
 * plugin wins. A losing server keeps its non-conflicting extensions and is dropped when none
 * remain. Each shadowed server gets one `lsp_extension_shadowed` warning.
 */
export function resolveLspExtensionConflicts(
  servers: readonly ResolvedLspServer[],
  input: { diagnostics: PluginDiagnostic[]; manifestPathByPluginId: ReadonlyMap<string, string> },
): { servers: ResolvedLspServer[]; shadows: LspExtensionShadow[] } {
  const owners = new Map<string, string>();
  const keptExtensions = new Map<string, Record<string, string>>();
  const shadows: LspExtensionShadow[] = [];
  const ordered = [...servers].sort((a, b) => a.priority - b.priority);

  for (const server of ordered) {
    const kept: Record<string, string> = {};
    const shadowed: string[] = [];
    let winnerId: string | undefined;
    for (const [extension, language] of Object.entries(server.extensionToLanguage)) {
      const owner = owners.get(extension);
      if (owner === undefined) {
        owners.set(extension, server.id);
        kept[extension] = language;
      } else {
        shadowed.push(extension);
        winnerId ??= owner;
      }
    }
    keptExtensions.set(server.id, kept);
    if (shadowed.length === 0 || winnerId === undefined) continue;
    shadows.push({
      extensions: shadowed,
      pluginId: server.pluginId,
      serverId: server.id,
      serverName: server.serverName,
      winnerId,
    });
    input.diagnostics.push({
      code: "lsp_extension_shadowed",
      message: `LSP server "${server.serverName}" in plugin ${server.pluginId} lost extension(s) ${shadowed.join(LSP_EXTENSION_LIST_SEPARATOR)} to ${winnerId}`,
      path: input.manifestPathByPluginId.get(server.pluginId),
      pluginId: server.pluginId,
      severity: "warning",
    });
  }

  const resolved: ResolvedLspServer[] = [];
  for (const server of servers) {
    const kept = keptExtensions.get(server.id) ?? {};
    if (Object.keys(kept).length === 0) continue;
    resolved.push({ ...server, extensionToLanguage: kept });
  }
  return { servers: resolved, shadows };
}

/** Human-readable extension list for component listings, e.g. ".ts, .tsx". */
export function formatLspExtensions(config: LspServerConfig): string {
  return Object.keys(config.extensionToLanguage).join(LSP_EXTENSION_LIST_SEPARATOR);
}
