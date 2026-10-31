/* eslint-disable max-lines -- The zcode-cli config schema centrally maintains file parsing and provider inheritance; splitting it would make config semantics harder to keep aligned. */
import { z } from "zod";
import { UI_THEME_PALETTES, type RuntimeConfigPatch } from "@zcode/contracts";

const stringRecordSchema = z.record(z.string(), z.string());
const unknownRecordSchema = z.record(z.string(), z.unknown());
const positiveNumberSchema = z.number().finite().positive();
const positiveIntegerSchema = z.number().int().positive();
const modelStreamSchema = z.object({
  idleTimeoutMs: positiveNumberSchema.optional(),
});

const permissionSchema = z.object({
  mode: z.enum(["plan", "build", "edit", "yolo", "guarded", "auto"]).optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  autoApproveHighRisk: z.boolean().optional(),
  allowMediumRiskInAuto: z.boolean().optional(),
});

const storageSchema = z.object({
  dir: z.string().min(1).optional(),
  sessionDbPath: z.string().min(1).optional(),
});

const networkSchema = z.object({
  httpProxy: z.string().min(1).optional(),
  noProxy: z.string().min(1).optional(),
  caCertFile: z.string().min(1).optional(),
  timeout: positiveNumberSchema.optional(),
});

const featuresSchema = z.object({
  compact: z.boolean().optional(),
  rewind: z.boolean().optional(),
  subagent: z.boolean().optional(),
  memory: z.boolean().optional(),
  skill: z.boolean().optional(),
  mcp: z.boolean().optional(),
});

const memorySchema = z.object({
  use: z.boolean().optional(),
});

const mcpServerBaseSchema = {
  alwaysLoad: z.boolean().optional(),
  // The Host DTO and connection pool already support isolation; file parsing must not drop an entire supported declaration.
  isolation: z.enum(["session", "workspace"]).optional(),
  // The settings page and MCP adapter already support protocol selection; omitting the field at the config entry would let strict validation drop the whole server.
  protocolVersion: z.enum(["auto", "legacy", "2026-07-28"]).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: positiveNumberSchema.optional(),
};

const mcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      clientName: z.string().min(1).optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      clientName: z.string().min(1).optional(),
      redirectPath: z.string().min(1).optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

const mcpStdioServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: stringRecordSchema.optional(),
  })
  .strict();

const mcpHttpServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("http"),
    url: z.string().min(1),
    headers: stringRecordSchema.optional(),
    oauth: mcpOAuthSchema.optional(),
  })
  .strict();

const mcpSseServerSchema = z
  .object({
    ...mcpServerBaseSchema,
    type: z.literal("sse"),
    url: z.string().min(1),
    headers: stringRecordSchema.optional(),
    oauth: mcpOAuthSchema.optional(),
  })
  .strict();

const mcpServerSchema = z.preprocess(
  normalizeMcpServerConfigInput,
  z.discriminatedUnion("type", [mcpStdioServerSchema, mcpHttpServerSchema, mcpSseServerSchema]),
);

const mcpSchema = z.object({
  servers: z.record(z.string(), mcpServerSchema).optional(),
});

const pluginOptionValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const pluginMarketplaceSourceSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("url"),
      url: z.string().min(1),
      headers: stringRecordSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("github"),
      repo: z.string().min(1),
      ref: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      sparsePaths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("git"),
      url: z.string().min(1),
      ref: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      sparsePaths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("npm"),
      package: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("file"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("directory"),
      path: z.string().min(1),
    })
    .strict(),
]);

const pluginsSchema = z.object({
  enabled: z.boolean().optional(),
  dirs: z.array(z.string().min(1)).optional(),
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  extraKnownMarketplaces: z
    .record(z.string().min(1), z.object({ source: pluginMarketplaceSourceSchema }).strict())
    .optional(),
  options: z.record(z.string(), z.record(z.string(), pluginOptionValueSchema)).optional(),
  suppressedBuiltins: z.array(z.string().min(1)).optional(),
});

export const LEGACY_CUA_PLUGIN_ID = "zcode-cua@zcode-plugins-official";
export const CANONICAL_CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";

export function canonicalizePluginId(pluginId: string): string {
  return pluginId === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : pluginId;
}

export function pluginIdAliases(pluginId: string): readonly string[] {
  return canonicalizePluginId(pluginId) === CANONICAL_CUA_PLUGIN_ID
    ? [CANONICAL_CUA_PLUGIN_ID, LEGACY_CUA_PLUGIN_ID]
    : [pluginId];
}

const skillToggleSchema = z.object({
  enable: z.boolean().optional(),
});

// skill / command availability overrides: key is the corresponding .md absolute path; enable:false means disabled
const skillCommandOverrideSchema = z
  .object({
    enable: z.boolean().optional(),
  })
  .passthrough();
const skillCommandOverridesSchema = z.record(z.string(), skillCommandOverrideSchema);
const skillsSchema = z
  .object({
    enabled: z.boolean().optional(),
    includeInstructions: z.boolean().optional(),
    metadataBudget: positiveNumberSchema.optional(),
    roots: z.array(z.string()).optional(),
  })
  .catchall(skillToggleSchema);

const loggingSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  format: z.enum(["text", "json"]).optional(),
});

const uiSchema = z.object({
  // Ignore an unknown locale as unset (for example, when a newer version wrote it and an older version reads it) so parsing does not reject the entire config.
  locale: z.enum(["auto", "en-US", "zh-CN", "uk-UA"]).optional().catch(undefined),
  theme: z.enum(["auto", "dark", "light"]).optional(),
  // Ignore an unknown palette as unset (for example, when a newer version wrote it and an older version reads it), matching the locale compatibility policy.
  palette: z.enum(UI_THEME_PALETTES).optional().catch(undefined),
});

const toolConcurrencySchema = z.object({
  maxConcurrency: positiveNumberSchema.optional(),
});

const modelAnomalyGuardSchema = z.object({
  toolCallWarningThreshold: positiveIntegerSchema.optional(),
  repeatedToolCallWarningThreshold: positiveIntegerSchema.optional(),
  maxBudgetWarningsPerTurn: z.number().int().nonnegative().optional(),
});

// Hooks schema:
// The ideal shape is re-exporting shared/workspace-hook-config, but the two pnpm workspaces
// resolve physically distinct zod instances (adapters 4.4.3 / shared 4.3.6): embedding the
// shared schema into this package's composite schema makes the dts reference foreign zod
// internal types (TS2742), and typeof/ZodType annotations fall into a type cycle.
// So this copy is kept as-is (constructed with this package's zod) and kept semantically
// equivalent to shared's validation; runtime validation semantics remain owned by shared
// (the discovery/trust assembly entries all use the shared schema — this schema only handles
// config-file loading diagnostics). If zod is ever unified, delete this copy and re-export.
export const hookProcessSchema = z
  .object({
    type: z.literal("process"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    args: z.array(z.string()).optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
    onError: z.enum(["allow", "deny"]).optional(),
  })

  .passthrough();

export const hookCommandSchema = z
  .object({
    type: z.literal("command"),
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    async: z.boolean().optional(),
    shell: z.union([z.literal(true), z.string().min(1)]).optional(),
    timeout: positiveNumberSchema.optional(),
    timeoutMs: positiveNumberSchema.optional(),
    statusMessage: z.string().min(1).optional(),
    onError: z.enum(["allow", "deny"]).optional(),
  })
  .passthrough();

export const hookMatcherSchema = z
  .object({
    matcher: z.string().min(1).optional(),
    hooks: z.array(z.discriminatedUnion("type", [hookProcessSchema, hookCommandSchema])).min(1),
  })
  .strict();

export const hooksSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutMs: positiveNumberSchema.optional(),
    maxOutputBytes: positiveNumberSchema.optional(),
    events: z
      .object({
        SessionStart: z.array(hookMatcherSchema).optional(),
        UserPromptSubmit: z.array(hookMatcherSchema).optional(),
        PreToolUse: z.array(hookMatcherSchema).optional(),
        PermissionRequest: z.array(hookMatcherSchema).optional(),
        PostToolUse: z.array(hookMatcherSchema).optional(),
        PostToolUseFailure: z.array(hookMatcherSchema).optional(),
        Stop: z.array(hookMatcherSchema).optional(),
        PreCompact: z.array(hookMatcherSchema).optional(),
        PostCompact: z.array(hookMatcherSchema).optional(),
        SessionEnd: z.array(hookMatcherSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ZCodeConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    modelStream: modelStreamSchema.optional(),
    permission: permissionSchema.optional(),
    storage: storageSchema.optional(),
    network: networkSchema.optional(),
    features: featuresSchema.optional(),
    memory: memorySchema.optional(),
    mcp: mcpSchema.optional(),
    plugins: pluginsSchema.optional(),
    skills: skillsSchema.optional(),
    skill: skillCommandOverridesSchema.optional(),
    command: skillCommandOverridesSchema.optional(),
    logging: loggingSchema.optional(),
    ui: uiSchema.optional(),
    toolConcurrency: toolConcurrencySchema.optional(),
    modelAnomalyGuard: modelAnomalyGuardSchema.optional(),
    hooks: hooksSchema.optional(),
  })
  .passthrough();

// Projects once reused the user config schema and could rewrite proxies, CAs, and the plugin
// storage root. Only extension declarations are exposed; runtime parameters are stripped before
// validation so newly added user fields do not automatically open to projects, and invalid
// disabled fields cannot break MCP/Hook.
const projectConfigFileSchema = ZCodeConfigFileSchema.pick({
  mcp: true,
  hooks: true,
  skill: true,
  command: true,
})
  .extend({
    plugins: pluginsSchema.pick({ enabledPlugins: true, options: true }).optional(),
    skills: z
      .preprocess(
        (value) =>
          isPlainRecord(value)
            ? Object.fromEntries(
                Object.entries(value).filter(([path]) => isAbsoluteConfigPath(path)),
              )
            : value,
        z.record(z.string(), skillToggleSchema),
      )
      .optional(),
  })
  .strip();

export type ZCodeConfigFile = z.infer<typeof ZCodeConfigFileSchema>;

type SkillCommandOverrideMap = Record<string, { enable?: boolean }>;

export type ConfigDiagnosticSeverity = "warning" | "error";
export type ConfigDiagnosticCode =
  | "config_file_invalid"
  | "config_mcp_server_invalid"
  | "config_project_hooks_pending_trust";

export interface ConfigDiagnostic {
  code: ConfigDiagnosticCode;
  filePath?: string;
  message: string;
  path?: string;
  severity: ConfigDiagnosticSeverity;
}

export interface ParseConfigFileResult {
  config: RuntimeConfigPatch;
  diagnostics: ConfigDiagnostic[];
}

function normalizeMcpServerConfigInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const server = { ...(value as Record<string, unknown>) };
  if (!("env" in server) && "environment" in server) {
    // Legacy configs and some external imports use environment; the runtime consumes only env.
    // Normalize at the parsing entry so one legacy MCP server cannot break the whole config.
    server.env = server.environment;
  }
  delete server.environment;

  if (typeof server.enable === "boolean" || typeof server.enabled === "boolean") {
    // Legacy fallback: early desktop builds wrote the disabled state as enable, while the
    // contract field has always been enabled. The desktop and mcp-sync now write only enabled
    // and migrate existing enable values in place when loading config; the CLI parses read-only
    // and cannot write, so this covers only the "user ran the CLI before ever opening the
    // desktop" window. On conflict, "disabled" wins: writing enable:false on desktop does not
    // clean up an enabled:true left by external imports, and honoring enabled would bring a
    // user-disabled server back up (disabled but still being called).
    // Once legacy configs are fully migrated, this block plus the delete below can be removed.
    server.enabled = server.enable === false ? false : (server.enabled ?? true);
  }
  delete server.enable;

  // External MCP configs may carry provider-specific timeout fields. ZCode does not migrate
  // those values, but the strict runtime schema should still accept old imported entries.
  delete server.timeout;
  delete server.startup_timeout_sec;

  if (server.type === "remote") {
    // External agent configs often mark HTTP MCP as remote; ZCode's runtime protocol type is http.
    server.type = "http";
  } else if (typeof server.type !== "string") {
    // The app management layer treats the command form as default stdio; the CLI needs the same
    // inference, or historical app configs missing type would block model config loading.
    if (typeof server.command === "string" && server.command.trim().length > 0) {
      server.type = "stdio";
    } else if (typeof server.url === "string" && server.url.trim().length > 0) {
      server.type = "http";
    }
  }

  if (
    (server.type === "http" || server.type === "sse") &&
    server.headers === undefined &&
    server.http_headers !== undefined
  ) {
    // Legacy BigModel MCP config compat: the old field name is http_headers; the agent runtime consumes only headers.
    server.headers = server.http_headers;
  }
  delete server.http_headers;

  return server;
}

export function parseConfigFileToRuntimePatchWithDiagnostics(
  value: unknown,
  scope: "user" | "project" = "user",
): ParseConfigFileResult {
  const diagnostics: ConfigDiagnostic[] = [];
  const normalized = normalizeConfigFileInput(value, diagnostics);
  const parsed = (scope === "project" ? projectConfigFileSchema : ZCodeConfigFileSchema).parse(
    normalized,
  );
  return {
    config: parsedConfigFileToRuntimePatch(parsed),
    diagnostics,
  };
}

function parsedConfigFileToRuntimePatch(parsed: ZCodeConfigFile): RuntimeConfigPatch {
  const config: RuntimeConfigPatch = {};
  if (parsed.modelStream) config.modelStream = parsed.modelStream;

  if (parsed.permission) config.permission = parsed.permission;
  if (parsed.storage) config.storage = parsed.storage;
  if (parsed.network) config.network = parsed.network;
  if (parsed.features) config.features = parsed.features;
  if (parsed.memory) config.memory = parsed.memory;
  if (parsed.mcp) config.mcp = parsed.mcp;
  if (parsed.plugins) config.plugins = normalizePluginConfig(parsed.plugins);
  const skillsConfig = parseSkillsRuntimeConfig(parsed.skills);
  if (skillsConfig) config.skills = skillsConfig;
  const skillOverrides = mergeSkillCommandOverrides(
    parsed.skill,
    parseSkillOverridesFromPluralSkills(parsed.skills),
  );
  if (skillOverrides) config.skillOverrides = skillOverrides;
  if (parsed.command) config.commandOverrides = parsed.command;
  if (parsed.logging) config.logging = parsed.logging;
  if (parsed.ui) config.ui = parsed.ui;
  if (parsed.toolConcurrency) config.toolConcurrency = parsed.toolConcurrency;
  if (parsed.modelAnomalyGuard) config.modelAnomalyGuard = parsed.modelAnomalyGuard;
  if (parsed.hooks) config.hooks = parsed.hooks;

  return config;
}

function normalizePluginConfig(
  plugins: ZCodeConfigFile["plugins"],
): NonNullable<RuntimeConfigPatch["plugins"]> {
  if (!plugins) return {};
  const enabledPlugins = plugins.enabledPlugins ? { ...plugins.enabledPlugins } : undefined;
  if (enabledPlugins?.[LEGACY_CUA_PLUGIN_ID] !== undefined) {
    if (enabledPlugins[CANONICAL_CUA_PLUGIN_ID] === undefined) {
      enabledPlugins[CANONICAL_CUA_PLUGIN_ID] = enabledPlugins[LEGACY_CUA_PLUGIN_ID];
    }
    delete enabledPlugins[LEGACY_CUA_PLUGIN_ID];
  }
  const suppressedBuiltins = plugins.suppressedBuiltins
    ? plugins.suppressedBuiltins.reduce<string[]>((ids, id) => {
        const canonicalId = id === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : id;
        if (canonicalId === CANONICAL_CUA_PLUGIN_ID && ids.includes(CANONICAL_CUA_PLUGIN_ID)) {
          return ids;
        }
        ids.push(canonicalId);
        return ids;
      }, [])
    : undefined;
  const options = plugins.options ? { ...plugins.options } : undefined;
  if (options?.[LEGACY_CUA_PLUGIN_ID] !== undefined) {
    if (options[CANONICAL_CUA_PLUGIN_ID] === undefined) {
      options[CANONICAL_CUA_PLUGIN_ID] = options[LEGACY_CUA_PLUGIN_ID];
    }
    delete options[LEGACY_CUA_PLUGIN_ID];
  }
  return {
    ...plugins,
    ...(enabledPlugins ? { enabledPlugins } : {}),
    ...(suppressedBuiltins ? { suppressedBuiltins } : {}),
    ...(options ? { options } : {}),
  };
}

function normalizeConfigFileInput(value: unknown, diagnostics: ConfigDiagnostic[]): unknown {
  if (!isPlainRecord(value)) return value;

  const root = { ...value };
  const mcp = root.mcp;
  if (!isPlainRecord(mcp)) return root;

  const servers = mcp.servers;
  if (servers === undefined) return root;

  if (!isPlainRecord(servers)) {
    diagnostics.push({
      code: "config_mcp_server_invalid",
      message: "mcp.servers must be a JSON object; ignoring all MCP servers.",
      path: "mcp.servers",
      severity: "warning",
    });
    root.mcp = {
      ...mcp,
      servers: {},
    };
    return root;
  }

  const parsedServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    const parsed = mcpServerSchema.safeParse(server);
    if (parsed.success) {
      parsedServers[name] = parsed.data;
      continue;
    }

    // MCP servers are optional tool config; a single server error must not lose provider/plugin and other config.
    diagnostics.push({
      code: "config_mcp_server_invalid",
      message: formatMcpServerError(parsed.error),
      path: `mcp.servers.${name}`,
      severity: "warning",
    });
  }

  root.mcp = {
    ...mcp,
    servers: parsedServers,
  };
  return root;
}

function formatMcpServerError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<server>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseSkillsRuntimeConfig(
  skills: ZCodeConfigFile["skills"],
): RuntimeConfigPatch["skills"] | undefined {
  if (!skills) return undefined;
  const next: NonNullable<RuntimeConfigPatch["skills"]> = {};
  if (skills.enabled !== undefined) next.enabled = skills.enabled;
  if (skills.includeInstructions !== undefined) {
    next.includeInstructions = skills.includeInstructions;
  }
  if (skills.metadataBudget !== undefined) next.metadataBudget = skills.metadataBudget;
  if (skills.roots !== undefined) next.roots = skills.roots;
  return Object.keys(next).length > 0 ? next : undefined;
}

function parseSkillOverridesFromPluralSkills(
  skills: ZCodeConfigFile["skills"],
): SkillCommandOverrideMap | undefined {
  if (!skills) return undefined;
  const overrides: SkillCommandOverrideMap = {};
  for (const [path, value] of Object.entries(skills)) {
    if (!isAbsoluteConfigPath(path) || !isSkillCommandOverrideValue(value)) {
      continue;
    }
    // The settings page currently writes individual skill toggles to skills[absolute SKILL.md path].
    // The agent runtime consumes only skillOverrides, so map here at config parsing to keep UI
    // state from diverging from what the agent actually loads.
    overrides[path] = { enable: value.enable };
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function mergeSkillCommandOverrides(
  ...overridesList: Array<SkillCommandOverrideMap | undefined>
): SkillCommandOverrideMap | undefined {
  const merged: SkillCommandOverrideMap = {};
  for (const overrides of overridesList) {
    if (!overrides) continue;
    Object.assign(merged, overrides);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function isSkillCommandOverrideValue(value: unknown): value is { enable?: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("enable" in value ? typeof (value as { enable?: unknown }).enable === "boolean" : true)
  );
}

function isAbsoluteConfigPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path);
}
