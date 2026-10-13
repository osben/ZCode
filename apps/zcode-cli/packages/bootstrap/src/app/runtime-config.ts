import type { ConfigResult } from "@zcode/adapters/config";
import { GEN_UI_OUTPUT_ROOT_ENV } from "@zcode/shared/node";
import { resolveInitialModelSelection, type ModelSelectionOptions } from "@zcode/provider";
import { resolveBashTimeoutPolicy, type AgentProfile, type AgentRuntimeConfig } from "@zcode/core";
import { type BuiltInSubagentModelSelectionOverrides } from "@zcode/shared";
import {
  type CollaborationMode,
  type HookConfigSource,
  type HookEventName,
  type HookMatcherConfig,
  type HooksRuntimeConfig,
  type McpServerConfig,
} from "@zcode/contracts";
import { omitMcpServers, resolveTrustedOfficialCuaServerNames } from "../mcp-config.js";
import { resolveDefaultEmbeddedSearchBackend } from "./embedded-search-backend.js";
import { getProjectMemoryRoot } from "./paths.js";
import type { ZCodeAppOptions } from "./types.js";
import {
  resolveRegistryOwnedModelSelection,
  resolveRegistryModelSelection,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";

interface ResolvedAppRuntimeConfig {
  configuredMcpServers: Record<string, McpServerConfig>;
  runtimeConfig: AgentRuntimeConfig;
  untrustedProjectMcpServers: Set<string>;
}

interface ResolvedInitialRegistrySelection extends ResolvedRegistrySelection {
  readonly selectionOptions?: ModelSelectionOptions;
}

export function resolveAppRuntimeConfig(input: {
  cliStorageRoot: string;
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  persistedMode?: CollaborationMode;
  /** System-prompt section overrides loaded from disk (docs/system-prompt-overrides.md). */
  persistedSystemPromptOverrides?: AgentRuntimeConfig["systemPromptOverrides"];
  /** Active output style loaded from disk (docs/output-styles-settings.md); explicit session config wins. */
  persistedOutputStyle?: AgentRuntimeConfig["outputStyle"];
  builtInMcpServers?: Record<string, McpServerConfig>;
  builtInSubagentModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  pluginHooks?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  pluginMcpServers?: Record<string, McpServerConfig>;
  pluginRuntimeFeatures?: AgentRuntimeConfig["runtimeFeatures"];
  subagentOutputRootDir: string;
  subagentProfiles?: readonly AgentProfile[];
  storageRoot?: string;
  workingDirectory: string;
  workspaceIdentity?: string;
}): ResolvedAppRuntimeConfig {
  const {
    cliStorageRoot,
    configResult,
    options,
    persistedMode,
    persistedSystemPromptOverrides,
    persistedOutputStyle,
    builtInMcpServers,
    pluginMcpServers,
    pluginRuntimeFeatures,
    subagentOutputRootDir,
    subagentProfiles = [],
    workingDirectory,
    workspaceIdentity,
  } = input;
  const userInstructions = options.runtimeConfig?.userInstructions ?? { workingDirectory };
  const registrySelection = resolveInitialRegistrySelection(options);
  // Restoring history does not start execution: an invalid or missing selection remains unbound and must not be filled from the configured default.
  const initialModelSelection = options.resume
    ? registrySelection?.selection
    : (options.runtimeConfig?.modelSelection ?? registrySelection?.selection);
  // Create a blank session first, then apply this Submission's selection. Requiring an initial default model would prevent users without a configured default
  // from creating a session before switch/send. An unbound Runtime may exist; admission/ModelFactory still validates the full selection before execution.
  // Do not silently choose the first Registry entry here.
  const requestedTitleGeneration = options.runtimeConfig?.titleGeneration;
  const requestedTitleModelSelection = requestedTitleGeneration?.modelSelection;
  const titleGeneration =
    requestedTitleGeneration === undefined
      ? undefined
      : {
          ...requestedTitleGeneration,
          // The title-generation sidecar's 15s default can time out with slow models or proxy chains.
          // Set 60s at the entry layer so an old core default or empty config does not make desktop fall back to 15s.
          timeoutMs: requestedTitleGeneration.timeoutMs ?? 60_000,
          // An empty titleGeneration setting enables default title generation, which must follow the session's current model.
          // If another title model is fixed when creating the draft session, a later model switch updates only the main path,
          // and the first generate-title sidecar request continues using the old provider/model.
          ...(requestedTitleModelSelection
            ? {
                modelSelection: requestedTitleModelSelection,
              }
            : {}),
        };
  // mcp.servers passed to Protocol session/create contains only user config from UI MCP settings,
  // not MCP servers registered by plugins. Merge the host built-in server last and preserve its identity so user or third-party
  // same-name config cannot hijack mcp__node_repl__*; explicit user config may still override ordinary plugin MCP servers.
  const configuredMcpServers = {
    ...pluginMcpServers,
    ...(options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers),
    ...builtInMcpServers,
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginMcpServers ?? {},
  );
  const cuaBridgeServerNames = new Set(trustedOfficialCuaServerNames);
  if (pluginRuntimeFeatures?.computerUse === true && configuredMcpServers.node_repl) {
    // node_repl needs broker injection but is not a CUA MCP server. Keep injection eligibility separate from official CUA image
    // authority; adding it to trustedOfficialCuaServerNames would send all generic node_repl results through the exact-raster gate,
    // breaking Browser screenshots and console logs.
    cuaBridgeServerNames.add("node_repl");
  }
  // Product decision: workspace MCP is ready to use by default; project-scoped MCP is trusted and connected automatically.
  const untrustedProjectMcpServers = new Set<string>();
  const autoConnectMcpServers = omitMcpServers(
    configuredMcpServers,
    untrustedProjectMcpServers,
    cuaBridgeServerNames,
  );
  const runtimeBuiltInModelSelectionOverrides =
    options.runtimeConfig?.subagents?.builtInModelSelectionOverrides ?? {};
  const runtimeConfig: AgentRuntimeConfig = {
    ...options.runtimeConfig,
    genUiOutputRoot: (options.env ?? process.env)[GEN_UI_OUTPUT_ROOT_ENV],
    bashTimeoutPolicy:
      options.runtimeConfig?.bashTimeoutPolicy ??
      resolveBashTimeoutPolicy(options.env ?? process.env),
    mode: options.runtimeConfig?.mode ?? persistedMode ?? configResult.config.permission.mode,
    modelSelection: initialModelSelection,
    // Accept only an explicitly provided session-level tool surface (ZCode Protocol session/create or CLI
    // --allowed-tools/--disallowed-tools). Do not fall back to config.permission.allowedTools:
    // that existing key means "tools that do not require approval." Projecting it onto the registration surface would make users
    // with a legacy config listing only a few allowedTools suddenly lose access to every other tool.
    toolAllowlist: options.runtimeConfig?.toolAllowlist,
    toolDisallowlist: options.runtimeConfig?.toolDisallowlist,
    embeddedSearchBackend:
      options.runtimeConfig?.embeddedSearchBackend ??
      resolveDefaultEmbeddedSearchBackend({
        env: options.env,
      }),
    runtimeFeatures: pluginRuntimeFeatures,
    language: options.runtimeConfig?.language,
    systemPromptOverrides:
      options.runtimeConfig?.systemPromptOverrides ?? persistedSystemPromptOverrides,
    outputStyle: options.runtimeConfig?.outputStyle ?? persistedOutputStyle,
    titleGeneration,
    workingDirectory,
    userInstructions: {
      ...userInstructions,
      workingDirectory: userInstructions.workingDirectory ?? workingDirectory,
    },
    skillMetadataBudget:
      options.runtimeConfig?.skillMetadataBudget ?? configResult.config.skills.metadataBudget,
    toolConcurrency: {
      maxConcurrency:
        options.runtimeConfig?.toolConcurrency?.maxConcurrency ??
        configResult.config.toolConcurrency.maxConcurrency,
    },
    modelAnomalyGuard: {
      ...configResult.config.modelAnomalyGuard,
      ...options.runtimeConfig?.modelAnomalyGuard,
    },
    mcp: {
      enabled: options.runtimeConfig?.mcp?.enabled ?? configResult.config.features.mcp,
      servers: autoConnectMcpServers,
      trustedOfficialCuaServerNames: [...trustedOfficialCuaServerNames],
    },
    hooks: mergeRuntimeHooks(
      options.runtimeConfig?.hooks
        ? withHookConfigSource(options.runtimeConfig.hooks, { kind: "internal" })
        : configResult.config.hooks,
      input.pluginHooks,
    ),
    subagents: {
      ...options.runtimeConfig?.subagents,
      enabled: options.runtimeConfig?.subagents?.enabled ?? configResult.config.features.subagent,
      outputRootDir: options.runtimeConfig?.subagents?.outputRootDir ?? subagentOutputRootDir,
      builtInModelSelectionOverrides: {
        ...(input.builtInSubagentModelSelectionOverrides ?? {}),
        ...runtimeBuiltInModelSelectionOverrides,
      },
      profiles: [...(options.runtimeConfig?.subagents?.profiles ?? []), ...subagentProfiles],
    },
    memory: {
      cliStorageRoot,
      enabled: options.runtimeConfig?.memory?.enabled ?? configResult.config.features.memory,
      ...(options.runtimeConfig?.memory?.extractionEnabled === undefined
        ? {}
        : { extractionEnabled: options.runtimeConfig.memory.extractionEnabled }),
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      use: options.runtimeConfig?.memory?.use ?? configResult.config.memory.use,
      workspaceIdentity: workspaceIdentity?.trim() || undefined,
    },
  };
  return {
    configuredMcpServers,
    runtimeConfig,
    untrustedProjectMcpServers,
  };
}

function withHookConfigSource(
  config: HooksRuntimeConfig,
  source: HookConfigSource,
): HooksRuntimeConfig {
  return {
    ...config,
    events: Object.fromEntries(
      Object.entries(config.events).map(([eventName, matchers]) => [
        eventName,
        matchers?.map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.map((hook) => ({ ...hook, source: hook.source ?? source })),
        })),
      ]),
    ) as HooksRuntimeConfig["events"],
  };
}

function resolveInitialRegistrySelection(
  options: ZCodeAppOptions,
): ResolvedInitialRegistrySelection | undefined {
  const registry = options.providerRegistry;
  if (!registry) return undefined;

  if (options.runtimeConfig?.modelSelection) {
    const selection = options.runtimeConfig.modelSelection;
    if (options.resume && !registry.validateSelection(selection).ok) return undefined;
    const resolved = resolveRegistryOwnedModelSelection(registry, selection);
    return resolved
      ? {
          ...resolved,
          ...(selection.options ? { selectionOptions: selection.options } : {}),
        }
      : undefined;
  }

  if (options.resume) return undefined;
  const initial = resolveInitialModelSelection({
    configuredDefault: options.configuredDefaultModelSelection,
    registry: registry.getView(),
  });
  if (initial.source === "none") return undefined;
  const resolved = resolveRegistryOwnedModelSelection(registry, initial.selection);
  return resolved
    ? {
        ...resolved,
        ...(initial.selection.options ? { selectionOptions: initial.selection.options } : {}),
      }
    : undefined;
}

function mergeRuntimeHooks(
  base: HooksRuntimeConfig | undefined,
  pluginHooks: Partial<Record<HookEventName, HookMatcherConfig[]>> | undefined,
): HooksRuntimeConfig | undefined {
  if (!pluginHooks || Object.values(pluginHooks).every((matchers) => !matchers?.length)) {
    return base;
  }

  const mergedEvents: HooksRuntimeConfig["events"] = {
    ...base?.events,
  };
  for (const [eventName, matchers] of Object.entries(pluginHooks) as Array<
    [HookEventName, HookMatcherConfig[]]
  >) {
    if (matchers.length === 0) continue;
    mergedEvents[eventName] = [...(mergedEvents[eventName] ?? []), ...matchers];
  }

  return {
    enabled: true,
    events: mergedEvents,
    maxOutputBytes: base?.maxOutputBytes ?? 32768,
    timeoutMs: base?.timeoutMs ?? 60000,
  };
}

export function runtimeConfigLogContext(
  runtimeConfig: AgentRuntimeConfig,
  workingDirectory: string,
) {
  const memoryRoot = runtimeConfig.memory?.cliStorageRoot
    ? getProjectMemoryRoot(
        runtimeConfig.memory.cliStorageRoot,
        workingDirectory,
        runtimeConfig.memory.workspaceIdentity,
      )
    : undefined;
  return {
    mcpEnabled: runtimeConfig.mcp?.enabled !== false,
    memoryEnabled: runtimeConfig.memory?.enabled !== false,
    memoryExtractionEnabled: runtimeConfig.memory?.extractionEnabled !== false,
    memoryRoot,
    memoryUse: runtimeConfig.memory?.use !== false,
    mcsMode: runtimeConfig.midConversationSystem?.mode,
    mode: runtimeConfig.mode,
    model: runtimeConfig.modelSelection
      ? `${runtimeConfig.modelSelection.providerId}/${runtimeConfig.modelSelection.modelId}`
      : undefined,
    runtimeFeatureBrowserUse: runtimeConfig.runtimeFeatures?.browserUse === true,
    runtimeFeatureNodeRepl: runtimeConfig.runtimeFeatures?.nodeRepl === true,
    workingDirectory,
  };
}
