import type { ConfigResult } from "@zcode/adapters/config";
import { GEN_UI_OUTPUT_ROOT_ENV } from "@zcode/shared/node";
import { resolveInitialModelSelection, type ModelSelectionOptions } from "@zcode/provider";
import { resolveBashTimeoutPolicy, type AgentProfile, type AgentRuntimeConfig } from "@zcode/core";
import { incognitoExcludes, type BuiltInSubagentModelSelectionOverrides } from "@zcode/shared";
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
  // Incognito profile (docs/design/v2/incognito-session.md): each excluded capability wins over every config source.
  const incognito = options.runtimeConfig?.incognito;
  const registrySelection = resolveInitialRegistrySelection(options);
  // Restoring history does not start execution: an invalid or missing selection remains unbound and must not be filled from the configured default.
  const initialModelSelection = options.resume
    ? registrySelection?.selection
    : (options.runtimeConfig?.modelSelection ?? registrySelection?.selection);
  // A blank session is created first, then this Submission's selection is applied; forcing an
  // initial default model would make session creation fail before switch/send for users without a
  // configured default. A Runtime without a binding may exist — real execution is still validated
  // by admission/ModelFactory against the full selection; never silently pick the Registry's first entry here.
  const requestedTitleGeneration = options.runtimeConfig?.titleGeneration;
  const requestedTitleModelSelection = requestedTitleGeneration?.modelSelection;
  const titleGeneration =
    requestedTitleGeneration === undefined
      ? undefined
      : {
          ...requestedTitleGeneration,
          // The title-generation sidecar's default 15s times out easily on slow models/proxy chains;
          // the entry layer uniformly supplies 60s so old core defaults or empty config do not keep the desktop falling back to 15s.
          timeoutMs: requestedTitleGeneration.timeoutMs ?? 60_000,
          // Empty titleGeneration means default title generation is enabled and the model must
          // follow the session's current model.
          // If another title model were frozen in here at draft-session creation, later model
          // switches would only update the main chain, and the first-turn generate-title sidecar
          // would keep using the pre-switch provider/model.
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
    ...(incognitoExcludes(incognito, "mcp")
      ? {}
      : (options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers)),
    ...builtInMcpServers,
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginMcpServers ?? {},
  );
  const cuaBridgeServerNames = new Set(trustedOfficialCuaServerNames);
  if (pluginRuntimeFeatures?.computerUse === true && configuredMcpServers.node_repl) {
    // node_repl needs broker injection but is not a CUA MCP server. Injection eligibility and the
    // official CUA image authority must stay separate; putting it into
    // trustedOfficialCuaServerNames would misroute every generic node_repl result into the
    // exact-raster gate and break both Browser screenshots and console logging.
    cuaBridgeServerNames.add("node_repl");
  }
  const untrustedProjectMcpServers = new Set<string>();
  for (const [name, config] of Object.entries(configuredMcpServers)) {
    if (
      config.source?.kind === "workspace" ||
      (!config.source && configResult.sources.mcp.serverSources[name] === "project")
    ) {
      configuredMcpServers[name] = { ...config, source: { kind: "workspace" } };
      untrustedProjectMcpServers.add(name);
    } else if (!config.source && configResult.sources.mcp.serverSources[name] === "user") {
      // headless configs keep the user source too; a corrupt project file must not turn user MCP into a to-be-trusted declaration.
      configuredMcpServers[name] = { ...config, source: { kind: "user" } };
    }
  }
  const autoConnectMcpServers = omitMcpServers(
    configuredMcpServers,
    new Set(),
    cuaBridgeServerNames,
  );
  const runtimeBuiltInModelSelectionOverrides =
    options.runtimeConfig?.subagents?.builtInModelSelectionOverrides ?? {};
  // Attach the parent workspace reference to the execution-worktree fact so the env bullet can name
  // it (spec: execution-worktree-model-context.md). options.runtimeConfig.workingDirectory is still
  // the parent path here; the local workingDirectory below is the (possibly worktree) execution cwd.
  const executionWorktreeFact = options.runtimeConfig?.executionWorktree;
  const executionWorktreeWorkspacePath = options.runtimeConfig?.workingDirectory;
  const runtimeConfig: AgentRuntimeConfig = {
    ...options.runtimeConfig,
    ...(executionWorktreeFact && executionWorktreeWorkspacePath
      ? {
          executionWorktree: {
            ...executionWorktreeFact,
            workspacePath: executionWorktreeWorkspacePath,
          },
        }
      : {}),
    genUiOutputRoot: (options.env ?? process.env)[GEN_UI_OUTPUT_ROOT_ENV],
    bashTimeoutPolicy:
      options.runtimeConfig?.bashTimeoutPolicy ??
      resolveBashTimeoutPolicy(options.env ?? process.env),
    mode: options.runtimeConfig?.mode ?? persistedMode ?? configResult.config.permission.mode,
    modelSelection: initialModelSelection,
    // Accept only an explicitly passed session-level tool surface (ZCode Protocol session/create
    // or CLI --allowed-tools/--disallowed-tools). Do not fall back to
    // config.permission.allowedTools: that key's existing semantics are an "approval-free list",
    // and projecting it onto the registration surface would suddenly strip every other tool from
    // users whose legacy config lists only a few allowedTools.
    toolAllowlist: options.runtimeConfig?.toolAllowlist,
    toolDisallowlist: options.runtimeConfig?.toolDisallowlist,
    embeddedSearchBackend:
      options.runtimeConfig?.embeddedSearchBackend ??
      resolveDefaultEmbeddedSearchBackend({
        env: options.env,
      }),
    runtimeFeatures: pluginRuntimeFeatures,
    language: options.runtimeConfig?.language,
    systemPromptOverrides: incognitoExcludes(incognito, "systemPromptOverrides")
      ? undefined
      : (options.runtimeConfig?.systemPromptOverrides ?? persistedSystemPromptOverrides),
    outputStyle: incognitoExcludes(incognito, "outputStyle")
      ? undefined
      : (options.runtimeConfig?.outputStyle ?? persistedOutputStyle),
    titleGeneration,
    workingDirectory,
    additionalDirectories: options.additionalDirectories,
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
    hooks: incognitoExcludes(incognito, "hooks")
      ? undefined
      : mergeRuntimeHooks(
          options.runtimeConfig?.hooks
            ? withHookConfigSource(options.runtimeConfig.hooks, { kind: "internal" })
            : configResult.config.hooks,
          input.pluginHooks,
        ),
    subagents: {
      ...options.runtimeConfig?.subagents,
      enabled: options.runtimeConfig?.subagents?.enabled ?? configResult.config.features.subagent,
      outputRootDir: options.runtimeConfig?.subagents?.outputRootDir ?? subagentOutputRootDir,
      // customAgents off must drop the model overrides with the profiles: built-in agents are
      // still available, but a user-configured Explore/general-purpose model override is a
      // custom-agent setting and would otherwise keep reaching them (incognito = default models).
      builtInModelSelectionOverrides: incognitoExcludes(incognito, "customAgents")
        ? {}
        : {
            ...(input.builtInSubagentModelSelectionOverrides ?? {}),
            ...runtimeBuiltInModelSelectionOverrides,
          },
      profiles: incognitoExcludes(incognito, "customAgents")
        ? []
        : [...(options.runtimeConfig?.subagents?.profiles ?? []), ...subagentProfiles],
    },
    memory: {
      cliStorageRoot,
      enabled: incognitoExcludes(incognito, "memory")
        ? false
        : (options.runtimeConfig?.memory?.enabled ?? configResult.config.features.memory),
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
