import { subagentProfilesFromSnapshot } from "../subagent-runtime-config.js";
import { isAbsolute, join, resolve } from "node:path";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
} from "@zcode/adapters/storage";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import {
  createNodeExecutionAdapter,
  resolveEffectiveBashShellSelection,
} from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeWebFetchHttpClientAdapter } from "@zcode/adapters/http";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import { createNodeSessionMailboxAdapter } from "@zcode/adapters/mailbox";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import {
  AgentRuntime,
  normalizeAgentProfiles,
  PermissionService,
  buildPluginReferenceCatalog,
  writeWorkflowDraft,
  type AmendWorkflowRunSettingsInput,
  type ResumeSessionResult,
} from "@zcode/core";
import { createModelTelemetry } from "@zcode/telemetry";
import {
  createRootTraceContext,
  traceContextToLogContext,
  type TraceContext,
  createSessionId,
  createSessionEvent,
  type ExecutionShellSelection,
  type MessageId,
} from "@zcode/contracts";
import { isRemoteWorkspaceIdentity, resolveZCodeRuntimeEnv } from "@zcode/shared";
import {
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";

import { createModelAdapter } from "../model-factory.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { scheduleStartupLogRetentionCleanup } from "../log-retention.js";
import type {
  PrepareUserExecutionBoundary,
  ResumeOptions,
  ZCodeApp,
  ZCodeAppOptions,
} from "./types.js";
import {
  createConfigCliOverrides,
  isMessageEnabled,
  resolveEffectiveLocale,
  resolveEffectiveConfigResult,
} from "./app-config-options.js";
import { getCliStorageRoot, getModelIoDir, projectIdFromDirectory } from "./paths.js";
import {
  asInputHistoryStore,
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
  readSessionModelSelection,
} from "./session-store.js";
import { createWorkflowFacade } from "./workflow-facade.js";
import { createInputFacade } from "./input-facade.js";
import { createPluginFacadeForApp } from "./plugin-facade.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { createSessionFacade } from "./session-facade.js";
import { resolveAppRuntimeConfig, runtimeConfigLogContext } from "./runtime-config.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
import { createWorkspaceHookRuntimeSecurity } from "./workspace-hook-trust.js";
import { createScriptWorkflowBridge } from "./script-workflow-methods.js";
import {
  createDynamicWorkflowRunService,
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
} from "./dynamic-workflow-run-service.js";
import { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
import { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";
import { createModelCatalogPort } from "./model-catalog-port.js";
import { createDynamicWorkflowRunProgressSink } from "./dynamic-workflow-run-progress-sink.js";
import { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";
import { workflowActorModelPolicy } from "./workflow-actor-model.js";
import {
  workflowActorInteractionDescription,
  workflowActorPermissionPolicy,
} from "./workflow-actor-permission.js";
import { workflowActorToolPolicy } from "./workflow-actor-tools.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { resolveZCodeCustomCommandPrompt } from "../custom-command-prompt.js";
import { resolveZCodeBuiltinPromptCommandInvocation } from "../builtin-prompt-command.js";
import { loadPersistedSystemPromptOverrides } from "../system-prompt.js";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import {
  loadPluginAgentTemplates,
  resolvePluginAgentProfiles,
  loadZCodeAgentProfiles,
} from "../subagents.js";
import { createRuntimeAiSdkModelExecutionConfig } from "../model-config.js";
import { ApiProviderModelRuntime } from "./provider-registry-model-runtime.js";
import {
  completeAppStartup,
  debugRuntimeConfigResolved,
  markConfigurationLoaded,
  markMcpAdapterInitialized,
  markRuntimeConstructed,
  markStorageAdaptersInitialized,
  resolveStartupPlugins,
  startAppStartup,
} from "./startup-marks.js";

function decodePromptAttachmentDataUrl(
  content: string,
  fallbackMime: string,
  maxBytes: number,
): { bytes: Uint8Array; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = (headerParts.shift()?.trim() || fallbackMime).split(";", 1)[0]!.toLowerCase();
  const payload = commaIndex >= 0 ? content.slice(commaIndex + 1) : "";
  if (
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) ||
    payload.length % 4 !== 0
  ) {
    throw new Error("fault.attachment.previewArtifactInvalid");
  }
  if (
    !mediaType.startsWith("image/") &&
    !mediaType.startsWith("video/") &&
    mediaType !== "application/pdf" &&
    // Root cause: text materials reuse uploaded artifacts, but the original data URL decoder
    // accepted only media types, so a legitimate preview was rejected a second time.
    !(
      mediaType === "text/plain" &&
      fallbackMime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
    )
  ) {
    throw new Error("fault.attachment.previewNotMedia");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength > maxBytes) {
    throw new Error("fault.attachment.previewTooLarge");
  }
  return { bytes, mediaType };
}

export async function createZCodeApp(options: ZCodeAppOptions): Promise<ZCodeApp> {
  if (!options?.providerRegistry) {
    throw new Error("createZCodeApp requires a Provider Registry");
  }
  const startupStartedAt = startupNow();
  const appVersion = options.version ?? "0.0.0";
  const sessionId = options.sessionId ?? createSessionId();
  const traceContext = options.traceContext ?? createRootTraceContext({ sessionId });
  const workingDirectory = resolve(options.runtimeConfig?.workingDirectory ?? process.cwd());
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const loggerFactory = options.loggerFactory ?? createNodeLoggerFactory({ env: options.env });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap",
  });
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap",
      startupKind: "zcode_app",
    },
    startupStartedAt,
  );
  startAppStartup({
    hasInjectedModelAdapter: options.modelAdapter !== undefined,
    resume: options.resume === true,
    startupTimer,
  });
  markConfigurationLoaded({
    configResult,
    startupTimer,
  });
  const modelLogger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "adapters.model",
  });
  const modelTelemetry = createModelTelemetry({
    owner: options.telemetryOwner,
    sessionId,
  });
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let providerModelRuntime: ApiProviderModelRuntime | undefined;
  try {
    const storageRoot = resolvePath(configResult.config.storage.dir);
    const cliStorageRoot = getCliStorageRoot(storageRoot);
    const modelIoDir = getModelIoDir(
      cliStorageRoot,
      resolveZCodeRuntimeEnv(options.env ?? process.env) === "development",
    );
    // Initialization and the parent turn must use the same Host source, preventing a separate
    // CLI storage.dir definition from disappearing in the first turn.
    const hostSubagentSnapshot = await options.readSubagentRuntimeConfig?.({
      signal: new AbortController().signal,
      traceContext,
    });
    const zcodeSubagentProfileOutcome = hostSubagentSnapshot
      ? subagentProfilesFromSnapshot(hostSubagentSnapshot)
      : await loadZCodeAgentProfiles({ logger, storageRoot, workingDirectory });
    const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
    const pluginOutcome = resolveStartupPlugins({
      cliStorageRoot,
      configResult,
      env: options.env,
      logger,
      options,
      startupTimer,
      workingDirectory,
    });
    // Skills shipped with the CLI (such as dynamic-workflows): they do not belong to a plugin, so users cannot disable or uninstall them.
    const bundledSkillRoots = resolveBundledSkillRoots({ cliStorageRoot, logger });
    const pluginTemplates = loadPluginAgentTemplates({ logger, plugins: pluginOutcome.plugins });
    const pluginSubagentProfiles =
      hostSubagentSnapshot?.kind === "built-in-fallback"
        ? []
        : resolvePluginAgentProfiles(
            {
              logger,
              plugins: pluginOutcome.plugins,
              reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
              modelSelectionOverrides:
                zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
            },
            pluginTemplates,
          ).profiles;
    const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
    const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
      pluginOutcome,
      workingDirectory,
    });
    // The user directory was migrated in place before the loader ran; do not add an in-memory
    // compatibility bypass for legacy project/plugin identities.
    const subagentProfiles = [...zcodeSubagentProfiles, ...pluginSubagentProfiles];
    const ownsSessionStore = options.sessionStore === undefined;
    const sessionStore =
      options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
    const localSettingStore = asLocalSettingStore(sessionStore);
    const projectID = projectIdFromDirectory(workingDirectory);
    const persistedMode = options.runtimeConfig?.mode
      ? undefined
      : readProjectPermissionMode(localSettingStore, projectID);
    // Session-level overrides win; otherwise fall back to the persisted files on disk.
    const persistedSystemPromptOverrides = options.runtimeConfig?.systemPromptOverrides
      ? undefined
      : await loadPersistedSystemPromptOverrides({ storageRoot });
    let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } =
      resolveAppRuntimeConfig({
        cliStorageRoot,
        configResult,
        options,
        persistedMode,
        persistedSystemPromptOverrides,
        pluginHooks: pluginOutcome.hooks,
        pluginMcpServers: pluginOutcome.mcpServers,
        builtInMcpServers,
        pluginRuntimeFeatures,
        builtInSubagentModelSelectionOverrides:
          zcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
        subagentOutputRootDir: join(cliStorageRoot, "agents"),
        subagentProfiles,
        storageRoot,
        workingDirectory,
        workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      });
    const browserControlPort = options.browserControlPort;
    if (
      browserControlPort &&
      pluginRuntimeFeatures.browserUse === true &&
      runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
    ) {
      nodeReplBrowserBroker =
        options.nodeReplBrowserBroker ??
        (ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
          browserControlPort,
          logger,
          platform: options.platform,
        }));
      configuredMcpServers = injectNodeReplBrowserBroker(
        configuredMcpServers,
        nodeReplBrowserBroker,
      );
      runtimeConfig.mcp = {
        ...runtimeConfig.mcp,
        servers: injectNodeReplBrowserBroker(
          runtimeConfig.mcp.servers ?? {},
          nodeReplBrowserBroker,
        ),
      };
    }
    startupTimer.mark("ZCode runtime configuration resolved", {
      context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
      event: "bootstrap.app.startup.runtime_config.completed",
      stage: "resolve_runtime_config",
    });
    // Plugin conversation references: freeze the identity catalog once when the App (Session
    // runtime) is created. Cold restore rebuilds the App and naturally gets the new catalog;
    // existing Sessions do not hot-load new Plugins.
    const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
    runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
    let runtime: AgentRuntime | undefined;
    const workspaceHookRuntimeSecurity = createWorkspaceHookRuntimeSecurity({
      appVersion,
      logger,
      projectConfigPath: options.projectConfigPath,
      policy: options.workspaceHookPolicy,
      policyProvider: options.workspaceHookPolicyProvider,
      reviewHost: options.workspaceHookReviewHost,
      workspaceHookTrustEnabled: options.workspaceHookTrustEnabled,
      runtimeRoot: configResult.sources.project.workspaceHookRuntimeRoot ?? {
        // The fallback applies only when config-factory is not exported (which should not happen).
        // Previously this unconditionally rebuilt runtimeRoot from the single runtimeConfig.hooks
        // layer, unlike config-factory, which walks default/user/project/env/cli layers. This
        // caused review snapshots and toggle rebuilds to produce different bundleDigest values,
        // so a "toggle during review" was incorrectly reported as workspace_hooks_snapshot_mismatch.
        enabled: runtimeConfig.hooks?.enabled === true,
        timeoutMs: runtimeConfig.hooks?.timeoutMs ?? 60_000,
        maxOutputBytes: runtimeConfig.hooks?.maxOutputBytes ?? 32_768,
      },
      sessionId,
      snapshot: configResult.sources.project.workspaceHookSnapshot,
      userConfigPath: configResult.sources.user.path,
      workingDirectory,
      ...(options.workspaceHookReviewHost
        ? {
            emitReviewEvent: async (event) => {
              if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
            emitAdmissionEvent: async (event) => {
              if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
              await runtime.appendEvent(
                createSessionEvent(event.type, sessionId, event.payload, {
                  traceId: traceContext.traceId,
                }),
                traceContext,
              );
            },
          }
        : {}),
    });
    const permissionService = new PermissionService({
      allowedTools: new Set(configResult.config.permission.allowedTools),
      autoApproveHighRisk: configResult.config.permission.autoApproveHighRisk,
      disallowedTools: new Set(configResult.config.permission.disallowedTools),
      allowMediumRiskInAutoMode: configResult.config.permission.allowMediumRiskInAuto,
    });
    const inputHistoryStore = options.inputHistoryStore ?? asInputHistoryStore(sessionStore);
    const artifactStore =
      options.artifactStore ??
      createNodeToolArtifactStore({
        imageCacheRootDir: join(storageRoot, "cli", "image-cache"),
        pdfCacheRootDir: join(storageRoot, "cli", "pdf-cache"),
        rootDir: join(storageRoot, "cli", "artifacts"),
        videoCacheRootDir: join(storageRoot, "cli", "video-cache"),
      });
    const imageProcessorPort = options.imageProcessorPort ?? createJimpImageProcessorAdapter();
    const messageEnabled = isMessageEnabled(options.env ?? process.env);
    const sessionMailboxPort =
      options.sessionMailboxPort ??
      (messageEnabled
        ? createNodeSessionMailboxAdapter({
            rootDir: resolvePath(
              (options.env ?? process.env).ZCODE_MAILBOX_ROOT ?? "~/.zcode/mailbox",
            ),
          })
        : undefined);
    markStorageAdaptersInitialized({
      cliStorageRoot,
      hasInjectedArtifactStore: options.artifactStore !== undefined,
      hasInjectedSessionStore: options.sessionStore !== undefined,
      startupTimer,
      storageRoot,
    });
    const mcpPort =
      options.mcpPort ??
      (runtimeConfig.mcp?.enabled === false
        ? undefined
        : (options.mcpPortFactory?.({ workingDirectory }) ??
          createMcpAdapter({
            clientVersion: appVersion,
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            workingDirectory,
          })));
    const ownsMcpPort = options.mcpPort === undefined && mcpPort !== undefined;
    const executionPort =
      options.executionPort ??
      createNodeExecutionAdapter({
        onToolExecResource: options.onToolExecResource,
        network: {
          httpProxy: configResult.config.network.httpProxy,
          noProxy: configResult.config.network.noProxy,
          caCertFile: configResult.config.network.caCertFile,
        },
        outputRootDir: join(storageRoot, "cli", "exec"),
        processEnv: options.env ?? process.env,
      });
    const ownsExecutionPort = options.executionPort === undefined;
    const pdfDocumentPort =
      options.pdfDocumentPort ?? createPopplerPdfDocumentAdapter({ executionPort });
    // browser-use control port: available only when injected by the host (desktop); no local
    // fallback exists because plain CLI has no browser foundation.
    const fileSystemPort = options.fileSystemPort ?? createNodeFileSystemAdapter();
    const httpClientPort =
      options.httpClientPort ??
      createNodeWebFetchHttpClientAdapter({
        env: options.env ?? process.env,
        timeoutMs: configResult.config.network.timeout,
        proxyUrl: configResult.config.network.httpProxy,
        noProxy: configResult.config.network.noProxy,
        caCertFile: configResult.config.network.caCertFile,
      });
    const providerEndpointRoutingPort = options.providerEndpointRoutingPort;
    markMcpAdapterInitialized({
      configuredMcpServers,
      hasInjectedMcpPort: options.mcpPort !== undefined,
      mcpEnabled: runtimeConfig.mcp?.enabled !== false,
      startupTimer,
      trustedMcpServerCount: Object.keys(runtimeConfig.mcp?.servers ?? {}).length,
    });
    debugRuntimeConfigResolved({
      configResult,
      logger,
      runtimeConfig,
    });
    const getRuntime = (): AgentRuntime => {
      if (!runtime) throw new Error("ZCode runtime is not initialized yet.");
      return runtime;
    };
    let resumePrepared = false;
    const resolveDefaultShellSelection = (): ExecutionShellSelection =>
      resolveEffectiveBashShellSelection({
        env: options.env ?? process.env,
        platform: options.platform ?? process.platform,
      }).selection;
    let initialShellSelectionPromise: Promise<ExecutionShellSelection> | undefined;
    const resolveInitialShellSelection = (): Promise<ExecutionShellSelection> => {
      initialShellSelectionPromise ??= (async () =>
        (await options.resolveInitialBashShellSelection?.()) ?? resolveDefaultShellSelection())();
      return initialShellSelectionPromise;
    };
    const initializeSessionShellEnvironment = async (): Promise<void> => {
      getRuntime().initializeSessionShellEnvironmentIfNeeded(await resolveInitialShellSelection());
    };

    const restorePersistedModelSelection = async (): Promise<
      ResumeSessionResult["modelSelection"]
    > => {
      const registry = options.providerRegistry;
      let selection: ResumeSessionResult["modelSelection"];
      try {
        // Database startup already completed the versioned migration; restore reads only the new
        // field and does not repeat the migration per session.
        selection = await readSessionModelSelection(sessionStore, sessionId);
      } catch (error) {
        // A failure to read/parse the selection entry must not break independent history restore.
        // Preserve the real storage error; do not mask it by reading old messages or a default model.
        logger.warn("Session model selection restore failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "session.model_selection.restore_failed",
          sessionId,
        });
      }
      const validation = selection && registry.validateSelection(selection);
      if (selection && validation && !validation.ok) {
        // Observability: a validation failure affects only the runtime binding, not the saved
        // intent; but once unbound, a later acceleration turn scoped to execution only has no
        // chance to rebind. This once silently cleared the selection in the ~600ms window where
        // the Registry was ready but account entitlements were unresolved; it only surfaced when
        // the expired acceleration card downgraded and found no target to fall back to, while
        // the logs showed no trace of this step.
        logger.warn("Session model selection restored but not bound to the runtime", {
          event: "session.model_selection.restore_unbound",
          modelId: selection.modelId,
          providerId: selection.providerId,
          sessionId,
          validationCode: validation.code,
        });
      }
      // Checking only whether a model exists would rebind selections with a missing level or a
      // deleted model into Runtime, undoing unbound initialization. History restore does not
      // require an executable model; only a complete selection can be bound.
      getRuntime().setSessionModelSelection(validation?.ok ? selection : undefined);
      // The restore result is a saved intent, not an executable binding. Clearing it or removing
      // its level here previously prevented the Host Selection View from retrieving that intent,
      // so it could not be re-resolved after an account switch or configuration restore.
      return selection;
    };

    const resumeFromStore = async (resumeOptions?: ResumeOptions): Promise<ResumeSessionResult> => {
      const runtime = getRuntime();
      const unsubscribe = resumeOptions?.onEvent
        ? runtime.subscribeEvents({ onSessionEvent: resumeOptions.onEvent })
        : undefined;

      try {
        const resumeTraceContext = resumeOptions?.traceContext ?? traceContext;
        const modelSelection = await restorePersistedModelSelection();
        await initializeSessionShellEnvironment();
        const result = await runtime.resumeFromStore({
          ...(resumeOptions?.abortSignal ? { abortSignal: resumeOptions.abortSignal } : {}),
          // Pass only the caller's original mode. Project/global defaults must not masquerade as
          // invocation overrides, or interactive resume cannot restore the actually persisted
          // session mode.
          modeOverride: options.runtimeConfig?.mode,
          persistedMessages: resumeOptions?.persistedMessages,
          traceContext: resumeTraceContext,
        });
        await runtime.activatePausedTargetAfterResume(resumeTraceContext);
        resumePrepared = true;
        return { ...result, modelSelection };
      } finally {
        unsubscribe?.();
      }
    };

    const prepareResume = async (
      submitTraceContext?: TraceContext,
      abortSignal?: AbortSignal,
    ): Promise<void> => {
      if (!options.resume || resumePrepared) return;
      await resumeFromStore({
        ...(abortSignal ? { abortSignal } : {}),
        traceContext: submitTraceContext ?? traceContext,
      });
      resumePrepared = true;
    };

    const prepareUserExecutionBoundary: PrepareUserExecutionBoundary = async (boundaryOptions) => {
      // The Bash shell snapshot belongs to the "first real user execution" boundary, not only
      // chat input. A regular prompt, expert workflow, or script workflow can each be the first
      // model/subagent entry point in a new session. Resolve it once before resume/context
      // initialization so the shell shown to the model does not diverge from the shell Bash runs.
      await initializeSessionShellEnvironment();
      await prepareResume(boundaryOptions?.traceContext, boundaryOptions?.abortSignal);
    };

    const modelExecutionConfig = createRuntimeAiSdkModelExecutionConfig(options.env, {
      appVersion,
      endpointRoutingPort: providerEndpointRoutingPort,
      network: configResult.config.network,
      sourceTitle: options.sourceTitle,
    });
    const modelAdapter =
      options.modelAdapter ??
      createModelAdapter({
        env: options.env,
        logger: modelLogger,
        modelIoDir,
        modelIoFullRetentionEnabled: options.modelIoFullRetentionEnabled,
        executionConfig: modelExecutionConfig,
        statusSink: modelTelemetry.statusSink,
        streamIdleTimeoutMs: configResult.config.modelStream.idleTimeoutMs,
      });
    if (options.modelAdapter && modelTelemetry.statusSink) {
      modelAdapter.addStatusSink(modelTelemetry.statusSink);
    }
    // Process-level concurrency governor: the run service passes its narrow port to the driver
    // (one request-admission port per actor runtime); the main runtime attaches its observer
    // (below in deps). It does not queue or inspect cooldown, but counts in-flight requests and
    // feeds signals. It is a process singleton because quotas belong to the account, not each
    // session. Do not feed signals through adapter-level addStatusSink anymore; each event must
    // flow through the ticket exactly once.
    const workflowConcurrencyGovernor = getWorkflowConcurrencyGovernor();
    modelAdapter.setModelIoFullRetentionEnabled(options.modelIoFullRetentionEnabled ?? false);
    providerModelRuntime = new ApiProviderModelRuntime({
      registry: options.providerRegistry,
      modelAdapter,
    });
    providerModelRuntime.start();
    // Construct the model factory before assembling the three workflow child paths: the script
    // workflow bridge, dwf actor runtime, and expert workflow facade all **share** the parent
    // session's factory. Newly created Models see Registry view updates; children do not each
    // freeze their own copy.
    const modelFactory = providerModelRuntime.modelFactory;
    const scriptWorkflowFacade = createScriptWorkflowBridge({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      configResult,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      pluginSkillRoots: pluginOutcome.skillRoots,
      prepareUserExecutionBoundary,
      getRuntime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });

    // Workflow run service: this is the side that actually starts the engine after the
    // CreateWorkflow confirmation dialog's Allow action. If journal narrowing fails (the store
    // lacks dwf_* tables), **do not construct** the service; leave the port undefined so
    // CreateWorkflow returns to its placeholder diagnostic path. This is a logged, visible
    // degradation, not a run path that silently loses persistence (see the header of
    // dynamic-workflow-run-service.ts).
    const dynamicWorkflowJournal = resolveDynamicWorkflowJournalStore(sessionStore, logger);
    const dynamicWorkflowRunPort =
      dynamicWorkflowJournal === undefined
        ? undefined
        : createDynamicWorkflowRunService({
            concurrency: workflowConcurrencyGovernor,
            createActorRuntime: ({
              actor,
              persona,
              pinnedModel,
              runSubagentModel,
              actorModel,
              subagentPermissionMode,
              sessionId: actorSessionId,
              submitPort,
              submitProfile,
              escalatePort,
              modelRequestAdmission,
            }) =>
              createScriptWorkflowAgentRuntime({
                childSessionId: actorSessionId,
                configOverrides: {
                  // Persona identity (effective name + system) → workflow-subagent path in the
                  // context builder. Omit the field for anonymous personas or those without a
                  // system prompt, so the builder omits the named clause and persona section.
                  workflowActor: {
                    ...(persona.name === undefined ? {} : { name: persona.name }),
                    ...(persona.system === undefined ? {} : { persona: persona.system }),
                  },
                  // The actor tool surface is subtractive (all tools minus plan and
                  // authority-exceeding meta-tools), so it must be expressed through
                  // configOverrides (request.opts.tools supports only an allowlist).
                  ...workflowActorToolPolicy(),
                  // Permission surface: subagents run the launching session's permission mode
                  // (plan excepted); when nothing was recorded, YOLO applies
                  // (docs/dynamic-workflow/launch.md "Permissions inside a run").
                  ...workflowActorPermissionPolicy(subagentPermissionMode),
                  // Model selection: `runSubagentModel` is specific to this run (`subagent_model`)
                  // and overrides the full selection when present, taking precedence over the
                  // pin; it does not affect the main agent. If neither it nor a pin is present,
                  // do not override: the child runtime baseline is already the parent session's
                  // current model (the factory baseline; see script-workflow-child-runtime.ts).
                  // A pin from resume locks the model used in the previous run (the persisted
                  // part of the persona-freezing invariant; see the priority table in
                  // workflow-actor-model.ts). parentSelection reads the parent session's
                  // **current** selection from the same source as the factory baseline, so pin
                  // comparisons do not drift.
                  ...workflowActorModelPolicy(
                    {
                      parentSelection: getRuntime().getSessionModelSelection(),
                      ...(runSubagentModel === undefined ? {} : { runSelection: runSubagentModel }),
                      // A model named by the persona (`agent(…, { model })` in the script) takes
                      // precedence over the run selection.
                      ...(actorModel === undefined ? {} : { actorSelection: actorModel }),
                    },
                    pinnedModel,
                  ).configOverrides,
                },
                deps: {
                  agentTelemetry: modelTelemetry.agentExecution,
                  appOptions: options,
                  appVersion,
                  artifactStore,
                  configResult,
                  fileSystemPort,
                  httpClientPort,
                  imageProcessorPort,
                  logger,
                  mcpPort,
                  // Parent session's model factory: actor and main turn create Models from the
                  // same Registry view instead of freezing separate copies.
                  modelFactory,
                  permissionService,
                  pluginSkillRoots: pluginOutcome.skillRoots,
                  runtime: getRuntime(),
                  runtimeConfig,
                  sessionId,
                  sessionStore,
                  storageRoot,
                  workingDirectory,
                },
                // Persona no longer replaces the subagent's entire system prompt through
                // request.opts.systemPrompt; workflowActor layers it on top of the base.
                // request is only a placeholder for the factory signature here: empty opts means
                // "override nothing."
                request: { opts: {} } as never,
                // The permission window's source badge names this subagent:
                // `<persona name> (<siteId>@<ordinal>)`.
                interactionDescription: workflowActorInteractionDescription({ actor, persona }),
                // Browser Use for subagents: the parent session's port, from which the factory
                // derives a child port via forChildSession (tab ownership belongs to the actor's
                // own sessionId). The actor runtime calls closeBrowserSession on run dispose,
                // which closes the tab as well and revokes its registration
                // (dynamic-workflow/docs/execution-engine.md "Subagent sessions").
                ...(browserControlPort === undefined ? {} : { browserControlPort }),
                traceContext,
                // Submit profile → submit_result shape:
                // `untyped` does not inject the port (core registers the tool only when the port is
                // present, so a fully untyped subagent has nowhere to submit); `mono` injects the
                // port + typed declaration; `generic` injects only the port (generic declaration).
                ...(submitProfile.kind === "untyped" ? {} : { workflowSubmitPort: submitPort }),
                // Spread the schema: dwf's JsonSchema is an interface without an index signature,
                // while contracts uses Record. Spreading the literal supplies the implicit index
                // signature, avoiding a conversion helper between the two packages.
                ...(submitProfile.kind === "mono"
                  ? { workflowSubmitSchema: { ...submitProfile.schema } }
                  : {}),
                // Escalation and submit ports are injected together: both are control channels
                // for the actor session, and port presence is the core-side registration gate.
                // Always pass them (the run service always constructs the ports); do not make
                // this opt-in, since the actor most likely to hit an unforeseen blocker is the
                // one the author did not mark.
                workflowEscalatePort: escalatePort,
                // Request-level admission port: the driver provides it when the governor is
                // present, and the runner checks the gate before every attempt.
                ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
              }),
            // Boundary accounting and transcript truncation both read/write actor-session
            // messages, so they must use the same store.
            actorTranscriptStore: sessionStore,
            // Byte destination for user-facing artifacts: share the same tool-artifact store as
            // the main session and workflow subagents, so artifacts live alongside other large results.
            artifactStore,
            executionPort,
            fileSystemPort,
            journal: dynamicWorkflowJournal,
            logger,
            // Progress projection seam: one engine event → one session event in the parent
            // session → a v4 workflowRuns state key. Use the runtime append path (not a direct
            // eventSink push): it persists, assigns sequenceNumber, and fans out together, which
            // makes cold restore and replayable reconnection work automatically.
            //
            // The three fallback paths (identity gate, runtime not ready, and append failure) are
            // collected here along with their unit tests; see the header of
            // dynamic-workflow-run-progress-sink.ts.
            onRunEvent: createDynamicWorkflowRunProgressSink({
              // Lazy: the run service is created before the runtime (it is one of AgentRuntime's dependencies).
              getRuntime,
              logger,
              sessionId,
            }),
            // Orphan recovery is scoped to this app's session. During construction, settle
            // nonterminal runs in the journal for **this session** (remnants of a dead process)
            // as failed, so in-flight runs belonging to sibling sessions are never affected.
            parentSessionId: sessionId,
            // Mints a draft when a fill lands on a run that has none
            // (docs/dynamic-workflow/launch.md "The draft after a fill"): the inline rules have a
            // single implementation in the tool layer, injected here instead of duplicated in the
            // run service.
            writeWorkflowDraft,
            // The session's permission mode at the moment the run was created (recorded in
            // run-launched; subagents follow it).
            // Lazy like onRunEvent: starts come only from tool calls or v4 commands, when the
            // runtime is necessarily ready.
            permissionMode: () => getRuntime().getMode(),
            // An in-flight engine pins this session as resident. 2026-09-15 bug: the engine was
            // not registered in the runtime task registry, so the residency pool closed an App
            // with an in-flight run as idle (10 minutes), and resume then started a second engine.
            // Resolve runtime lazily, like onRunEvent: the run service is an AgentRuntime
            // dependency and is constructed earlier, while starts come only from tool calls or
            // v4 commands, when the runtime is ready.
            registerResidencyBlockingWork: (work) => {
              void getRuntime().trackResidencyBlockingWork(work);
            },
            // Launch anchor: CreateWorkflow runs during an active turn in the parent session, and
            // that turn's inputId is the message the subagent agent_step should attach to. If
            // trace.turnId does not match the active turn (which should be impossible), let the
            // submit side mint a fallback; never record another turn's ID as the anchor.
            resolveLaunchInputId: (trace) => {
              const active = getRuntime().getActiveTurnInfo();
              return active !== undefined && active.turnId === trace.turnId
                ? active.inputId
                : undefined;
            },
            ...(isDynamicWorkflowTaskLinkStore(sessionStore)
              ? { taskLinkStore: sessionStore }
              : {}),
          });
    // dwf snippet service: execution surface for EvalWorkflowSnippet. It deliberately does
    // **not** depend on the dwf journal; snippets are fully transient (in-memory journal) and
    // should not inherit the run service's durability requirements. The experimental path
    // therefore remains available even if the run port is not constructed because the journal is absent.
    const dynamicWorkflowSnippetPort = createDynamicWorkflowSnippetService({
      executionPort,
      fileSystemPort,
      logger,
    });
    // Model catalog: the tool layer resolves a model name from the user into a workflow-run
    // subagent selection (model-catalog-port.ts).
    const modelCatalogPort = createModelCatalogPort({
      registry: options.providerRegistry,
      currentSelection: () => getRuntime().getSessionModelSelection(),
    });
    runtime = new AgentRuntime(sessionId, runtimeConfig, {
      ...(options.readSubagentRuntimeConfig
        ? {
            loadAgentDefinitions: async (input) => {
              const snapshot = await options.readSubagentRuntimeConfig!(input);
              const parsed = subagentProfilesFromSnapshot(snapshot);
              const pluginProfiles =
                snapshot.kind === "built-in-fallback"
                  ? []
                  : resolvePluginAgentProfiles(
                      {
                        logger,
                        plugins: pluginOutcome.plugins,
                        reservedProfileNames: parsed.profiles.map((profile) => profile.name),
                        modelSelectionOverrides: parsed.pluginAgentModelSelectionOverrides,
                      },
                      pluginTemplates,
                    ).profiles;
              return {
                activeAgents: normalizeAgentProfiles(
                  [
                    ...(options.runtimeConfig?.subagents?.profiles ?? []),
                    ...parsed.profiles,
                    ...pluginProfiles,
                  ],
                  {
                    builtInModelSelectionOverrides: {
                      ...parsed.builtInModelSelectionOverrides,
                      ...options.runtimeConfig?.subagents?.builtInModelSelectionOverrides,
                    },
                  },
                ),
              };
            },
          }
        : {}),
      agentTelemetry: modelTelemetry.agentExecution,
      // Main-agent model requests pass through the governor's observer: allow immediately, but
      // expose 429s and successes to the governor.
      modelRequestAdmission: workflowConcurrencyGovernor.observer(),
      eventStore: options.eventStore ?? createInMemorySessionEventStore(),
      sessionStore,
      sessionMailboxPort,
      logger,
      executionPort,
      workspaceHookAdmission: workspaceHookRuntimeSecurity?.admission,
      workspaceHookSnapshot: workspaceHookRuntimeSecurity?.snapshot,
      browserControlPort,
      fileSystemPort,
      httpClientPort,
      imageProcessorPort,
      pdfDocumentPort,
      artifactStore,
      contextSourcePort:
        options.contextSourcePort ?? createNodeContextSourceAdapter({ env: options.env }),
      skillPort:
        configResult.config.features.skill && configResult.config.skills.enabled
          ? (options.skillPort ??
            createNodeSkillAdapter({
              extraRoots: configResult.config.skills.roots,
              extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
              disabledPaths: [
                ...collectDisabledPaths(configResult.config.skillOverrides),
                // Do not provide the dynamic-workflows skill when dynamic workflows are disabled:
                // with all ten tools unavailable, showing the model how to write workflow scripts
                // would only prompt it to call nonexistent tools.
                ...(runtimeConfig.dynamicWorkflowEnabled === false
                  ? collectDynamicWorkflowDisabledSkillPaths(bundledSkillRoots)
                  : []),
              ],
            }))
          : undefined,
      mcpPort,
      eventSink: options.eventSink,
      modelFactory,
      modelIoDir,
      providerRuntimeHeadersPort: options.providerRuntimeHeadersPort,
      resolveEffectiveModelSelection: options.resolveEffectiveModelSelection,
      isRemoteWorkspace: () =>
        isRemoteWorkspaceIdentity(runtimeConfig.memory?.workspaceIdentity ?? ""),
      permissionBroker: options.permissionBroker,
      permissionService,
      workflowPort: scriptWorkflowFacade.workflowPort,
      dynamicWorkflowRunPort,
      dynamicWorkflowSnippetPort,
      modelCatalogPort,
      automationPort: options.automationPort,
      offPeakPort: options.offPeakPort,
      topicResourcePort: options.topicResourcePort,
      appVersion,
      traceContext,
    });
    markRuntimeConstructed({
      hasInjectedModelAdapter: options.modelAdapter !== undefined,
      sessionId,
      startupTimer,
    });
    completeAppStartup({
      sessionId,
      startupTimer,
      workingDirectory,
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    const inputFacade = createInputFacade({
      artifactStore,
      customCommandPromptResolver: async (text, resolverOptions) => {
        const builtin = resolveZCodeBuiltinPromptCommandInvocation(text, {
          // Do not expand the built-in `/workflow` when the dynamic-workflow rollout gate is off
          // (DWG-03). The catalog already removes it from the `/` panel, but users can still
          // type the command name manually, so both paths must reach the same conclusion. The
          // standalone CLI's TUI and headless modes use the explicit --workflow-mode value; when
          // it is absent (in-process embedders), do not gate (see the runtimeConfig field comment).
          dynamicWorkflowEnabled: runtimeConfig.dynamicWorkflowEnabled,
          workingDirectory,
        });
        if (builtin !== undefined) {
          if (builtin.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
            // The `/workflow` expansion point is also the onDemand session's activation point
            // (launch.md "On demand: activation"): it runs before executeTurn, so the first model
            // request of the turn already carries the ten tools. It is a no-op in alwaysOn or
            // already-activated sessions. Ask the runtime, not the runtimeConfig captured in the
            // closure — the config was copied at construction, so the closure cannot observe flips.
            await runtime?.activateDynamicWorkflowTools({
              source: "command",
              traceContext: resolverOptions?.traceContext ?? traceContext,
            });
          }
          return builtin.prompt;
        }
        return await resolveZCodeCustomCommandPrompt(text, {
          env: options.env,
          executionPort,
          logger,
          projectConfigPath: options.projectConfigPath,
          sessionId,
          signal: resolverOptions?.abortSignal,
          skipUserConfig: options.skipUserConfig,
          traceContext: resolverOptions?.traceContext ?? traceContext,
          userConfigPath: options.userConfigPath,
          workingDirectory,
        });
      },
      inputHistoryStore,
      logger,
      prepareUserExecutionBoundary,
      runtime,
      sessionId,
      traceContext,
    });
    const workflowFacade = createWorkflowFacade({
      agentTelemetry: modelTelemetry.agentExecution,
      appOptions: options,
      appVersion,
      artifactStore,
      cliStorageRoot,
      configResult,
      eventSink: options.eventSink,
      imageProcessorPort,
      pdfDocumentPort,
      logger,
      mcpPort,
      modelFactory,
      permissionService,
      prepareUserExecutionBoundary,
      runtime,
      runtimeConfig,
      sessionId,
      sessionStore,
      storageRoot,
      traceContext,
      workingDirectory,
    });
    const sessionFacade = createSessionFacade({
      // Stop dwf runs owned by this session when the App closes:
      // the engine lives in this App's closure, so closing the App without stopping it leaves
      // journal rows in running until the next orphan recovery.
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : { closeDynamicWorkflowRuns: () => dynamicWorkflowRunPort.close() }),
      configResult,
      configuredMcpServers,
      ...(options.configuredDefaultModelSelection
        ? {
            configuredDefaultModelSelection: options.configuredDefaultModelSelection,
          }
        : {}),
      executionPort,
      localSettingStore,
      logger,
      loggerFactory,
      mcpPort,
      ownsExecutionPort,
      ownsMcpPort,
      closeNodeReplBrowserBroker: async () => {
        await ownedNodeReplBrowserBroker?.close();
      },
      ownsSessionStore,
      prepareUserExecutionBoundary,
      prepareResume,
      projectID,
      providerRegistry: options.providerRegistry,
      resolveUiLocale: (locale) => resolveEffectiveLocale(locale, options),
      runtime,
      sessionId,
      sessionStore,
      traceContext,
      untrustedProjectMcpServers,
      workingDirectory,
    });

    const closeSession = sessionFacade.close;
    const resolvePromptAttachment = async (input: {
      ref: string;
      mime: string;
      messageId?: string;
      attachmentIndex?: number;
    }): Promise<{ ref: string; mediaType: string; artifactUri?: string }> => {
      let ref = input.ref;
      let mediaType = input.mime;
      let artifactUri: string | undefined;
      if (input.messageId && input.attachmentIndex !== undefined) {
        // Previewing one attachment used to decode the entire conversation through messages();
        // long sessions synchronously scanned every part, and unrelated corrupt rows could fail
        // the target preview. Read the specific session/message instead.
        const persistedMessage = await sessionStore.messageWithParts({
          sessionID: sessionId,
          messageID: input.messageId as MessageId,
        });
        const persistedAttachment = persistedMessage?.parts.filter((part) => part.type === "file")[
          input.attachmentIndex
        ];
        if (persistedAttachment?.type === "file") {
          mediaType = persistedAttachment.mime;
          // A live row's ref remains the original path. Reading it directly means that deleting
          // or overwriting the source makes the active preview disagree with the cold-restored
          // artifact. Prefer the immutable copy for the same message/index.
          artifactUri =
            persistedAttachment.metadata?.artifactUri ??
            (persistedAttachment.url.startsWith("zcode-artifact://")
              ? persistedAttachment.url
              : undefined);
          ref =
            artifactUri ??
            (!persistedAttachment.url.startsWith("data:") ? persistedAttachment.url : input.ref);
        }
        // Message rows are persisted before later FileParts, one at a time. If the target part is
        // not visible yet, use input.ref already authorized by the current projection instead of
        // creating a temporary preview-failure window.
      }
      return { ref, mediaType, ...(artifactUri ? { artifactUri } : {}) };
    };
    return {
      sessionId,
      traceId: traceContext.traceId,
      runtime,
      respondWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.respond(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.decision,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      toggleWorkspaceHookReviewItem: (input) =>
        workspaceHookRuntimeSecurity?.toggle(
          {
            sessionId: input.sessionId,
            taskId: input.taskId,
            runId: input.runId,
            ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
            workspaceIdentity: input.workspaceIdentity,
            bundleDigest: input.bundleDigest,
            reviewFlowId: input.reviewFlowId,
            generation: input.generation,
            interactionId: input.interactionId,
          },
          input.reviewItemId,
          input.enabled,
        ) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      revokeWorkspaceHookTrust: (input) =>
        ("hookDeclarationDigests" in input
          ? workspaceHookRuntimeSecurity?.revokeCurrent(input)
          : workspaceHookRuntimeSecurity?.revoke(
              {
                sessionId: input.sessionId,
                taskId: input.taskId,
                runId: input.runId,
                ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
                workspaceIdentity: input.workspaceIdentity,
                bundleDigest: input.bundleDigest,
                reviewFlowId: input.reviewFlowId,
                generation: input.generation,
                interactionId: input.interactionId,
              },
              input.reviewItemIds,
            )) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      requestWorkspaceHookReview: (input) =>
        workspaceHookRuntimeSecurity?.requestReview({
          workspaceIdentity: input.workspaceIdentity,
          bundleDigest: input.bundleDigest,
        }) ??
        Promise.resolve({
          accepted: false as const,
          reasonCode: "workspace_hooks_require_trust_capable_host" as const,
        }),
      // Called by the server per workspace after Settings pretrust is persisted: reload the
      // Trust store into this session's coordinator and resend admission state (see the comment
      // in types.ts).
      reloadWorkspaceHookTrust: () =>
        workspaceHookRuntimeSecurity?.reloadTrust() ?? Promise.resolve(),
      setModelIoFullRetentionEnabled: (enabled) =>
        modelAdapter.setModelIoFullRetentionEnabled(enabled),
      readToolResultArtifact: (uri) =>
        artifactStore.readToolResultArtifact({ uri, trace: traceContext }),
      // Wire/staging uses decoded chunks throughout; restore the existing data-URL artifact
      // shape inside the CLI process only after the full checksum commit, preserving compatibility
      // with provider reads.
      writePromptAttachment: async (input) => {
        const artifact = await artifactStore.writeToolResultArtifact({
          content: `data:${input.mime};base64,${Buffer.from(input.bytes).toString("base64")}`,
          contentType: "text/plain",
          retention: "session",
          sessionId,
          toolCallId: `prompt-attachment-upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          toolName: "prompt-attachment:upload",
          trace: traceContext,
        });
        if (
          input.mime.startsWith("image/") ||
          input.mime.startsWith("video/") ||
          input.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
        ) {
          // Derived media is only a rebuildable cache. A real I/O failure does not damage the
          // durable data URL; the final request projection will ensure it again.
          void artifactStore
            .primeMediaAttachmentPath?.({
              bytes: input.bytes,
              mediaType: input.mime,
              uri: artifact.uri,
            })
            .catch(() => undefined);
        }
        return { ref: artifact.uri };
      },
      readPromptAttachment: async (input) => {
        const { ref, mediaType } = await resolvePromptAttachment(input);
        // Keep reads inside the session runtime: artifacts use the session store, and paths use
        // the current FileSystemPort so SSH/WSL/Docker reach the correct remote filesystem.
        if (ref.startsWith("zcode-artifact://")) {
          const artifact = await artifactStore.readToolResultArtifact({
            uri: ref,
            trace: traceContext,
          });
          return decodePromptAttachmentDataUrl(artifact.content, mediaType, input.maxBytes);
        }
        const read = await fileSystemPort.readBinaryFile({
          path: ref,
          maxBytes: input.maxBytes,
          trace: traceContext,
        });
        return { bytes: read.content, mediaType };
      },
      statPromptAttachment: async (input) => {
        const { ref, mediaType, artifactUri } = await resolvePromptAttachment(input);
        if (artifactUri) {
          if (!artifactStore.statToolResultArtifact) {
            throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
          }
          const result = await artifactStore.statToolResultArtifact({
            uri: artifactUri,
            trace: traceContext,
          });
          return {
            totalBytes: result.bytes,
            mediaType: result.contentType || mediaType,
            ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
          };
        }
        const result = await fileSystemPort.stat({ path: ref, trace: traceContext });
        if (result.kind !== "file") {
          // A directory, symlink, or missing path means this attachment is no longer a shareable
          // file. Throw a stable code so share preflight can classify it deterministically
          // instead of guessing from error text.
          throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statNotFile);
        }
        return {
          totalBytes: result.sizeBytes,
          mediaType,
          ...(result.mtimeMs === undefined ? {} : { mtimeMs: result.mtimeMs }),
        };
      },
      resolvePromptAttachmentPreviewSource: async (input) => {
        const resolved = await resolvePromptAttachment(input);
        if (!resolved.mediaType.startsWith("video/")) return { kind: "chunked" };
        if (resolved.artifactUri) {
          if (!artifactStore.ensureMediaAttachmentPath) return { kind: "chunked" };
          try {
            const materialized = await artifactStore.ensureMediaAttachmentPath({
              uri: resolved.artifactUri,
              mediaType: resolved.mediaType,
            });
            if (materialized.status === "ready" && materialized.path.trim()) {
              return {
                kind: "local_path",
                path: materialized.path,
                mediaType: resolved.mediaType,
              };
            }
          } catch {
            // The artifact remains the immutable fact; if the derived file fails, the gateway
            // may fall back only to the artifact chunk.
          }
          return { kind: "chunked" };
        }
        if (isAbsolute(resolved.ref)) {
          return {
            kind: "local_path",
            path: resolved.ref,
            mediaType: resolved.mediaType,
          };
        }
        return { kind: "chunked" };
      },
      ...sessionFacade,
      close: async () => {
        try {
          await closeSession?.();
        } finally {
          try {
            providerModelRuntime?.dispose();
          } finally {
            await modelTelemetry.shutdown();
          }
        }
      },
      ...workflowFacade,
      ...scriptWorkflowFacade,
      // Read surface for the dwf event log. **Optional capability**: if the journal is
      // unavailable, the run service is not constructed and this method is absent. The v4
      // gateway returns a structured unsupported-capability error so the renderer can
      // distinguish "no events" from "this session lacks this capability."
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : {
            listDynamicWorkflowRunEvents: async (input: {
              runId: string;
              afterSequence?: number;
              limit?: number;
              maxBytes?: number;
            }) =>
              dynamicWorkflowRunPort.listEvents(input.runId, {
                ...(input.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                ...(input.limit === undefined ? {} : { limit: input.limit }),
                ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
              }),
          }),
      // Read surface for **user-facing artifacts** from workflow runs. Register or omit all three
      // together: they are three slices of the same journal read surface, and partial presence
      // would give the UI a card whose side panel cannot open. All three port members are
      // optional (stub ports do not implement them), so probe each one.
      // Terminology: artifact means output published by a script for the user, not the port's
      // `output` (the top-level return value).
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listArtifacts !== "function" ||
      typeof dynamicWorkflowRunPort.listArtifactItems !== "function" ||
      typeof dynamicWorkflowRunPort.readArtifact !== "function"
        ? {}
        : {
            listDynamicWorkflowRunArtifacts: async (input: { runId: string }) =>
              dynamicWorkflowRunPort.listArtifacts!(input.runId),
            listDynamicWorkflowRunArtifactItems: async (input: {
              runId: string;
              artifactId: string;
              afterSequence?: number;
              limit: number;
              maxBytes: number;
              fields?: readonly string[];
            }) =>
              dynamicWorkflowRunPort.listArtifactItems!(input.runId, input.artifactId, {
                ...(input.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                limit: input.limit,
                maxBytes: input.maxBytes,
                ...(input.fields === undefined ? {} : { fields: input.fields }),
              }),
            readDynamicWorkflowRunArtifact: async (input: {
              runId: string;
              artifactId: string;
              version: number;
            }) =>
              dynamicWorkflowRunPort.readArtifact!(input.runId, input.artifactId, input.version),
          }),
      // Workspace transcript for workflow runs: register or omit both together, for the same
      // reason as the three artifact methods above.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listWorkspaceNodes !== "function" ||
      typeof dynamicWorkflowRunPort.readWorkspaceNodeResult !== "function"
        ? {}
        : {
            listDynamicWorkflowRunWorkspaceNodes: async (input: { runId: string }) =>
              dynamicWorkflowRunPort.listWorkspaceNodes!(input.runId),
            readDynamicWorkflowRunNodeResult: async (input: {
              runId: string;
              siteId: string;
              ordinal: number;
              maxBytes: number;
            }) =>
              dynamicWorkflowRunPort.readWorkspaceNodeResult!(
                input.runId,
                input.siteId,
                input.ordinal,
                { maxBytes: input.maxBytes },
              ),
          }),
      // Session-level lifecycle read surface for workflow runs (in-flight count + settlement
      // subscription). The consumer is the host's provider registry safety boundary: subagents
      // share this session's live adapter, and replacing the registry during an in-flight run
      // would dispose the request resources they are bound to. Same absence condition as above.
      ...(dynamicWorkflowRunPort === undefined ? {} : {}),
      // Enumeration surface for workflow runs (discovery query after restart). Same capability
      // absence condition as above; listRunsForSession is optional on the port, so do not register
      // this capability if the method is absent.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.listRunsForSession !== "function"
        ? {}
        : {
            listDynamicWorkflowRuns: async (input: { limit?: number }) =>
              dynamicWorkflowRunPort.listRunsForSession!(input.limit),
          }),
      // Cold replay for workflow runs. Same capability absence condition as above.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.replayProgressForSession !== "function"
        ? {}
        : {
            replayDynamicWorkflowRuns: async (input: { excludeRunIds: ReadonlySet<string> }) =>
              dynamicWorkflowRunPort.replayProgressForSession!(input),
          }),
      // Resume a dwf run. Same capability absence condition as above. In addition, resume is an
      // optional port member (stub ports do not implement it); do not register this capability
      // when the method is absent. For the renderer, "port absent" and "method absent" are the
      // same business fact.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.resume !== "function"
        ? {}
        : {
            resumeWorkflowRun: async (input: { workId: string; name?: string }) => {
              const result = await dynamicWorkflowRunPort.resume!(input.workId);
              if (result.ok) {
                // Re-arm tracking immediately after a successful resume: register with the
                // registry (collection guard), add a backgroundWorks entry (cancellable), and
                // send terminal notifications. port.resume already replaced the registry entry,
                // so the waiter attaches to the new settlement promise (invariant 5 in the run
                // service header).
                await getRuntime().trackResumedDynamicWorkflowRun({
                  runId: result.runId,
                  ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
                  ...(input.name === undefined ? {} : { name: input.name }),
                  traceContext,
                });
              }
              return result;
            },
          }),
      // Start a saved workflow directly from the hub. Capability absence follows the same rule
      // as resumeWorkflowRun: do not register it when the entire dwf port is absent (stub/test
      // host). The GUI then receives and displays an unsupported-capability error instead of
      // mistaking "direct start unsupported" for a failed start.
      // Like the /goal control turn, go through the unified user-execution boundary first
      // (otherwise shell selection is empty before first persistence and cold restore falls back
      // to legacy behavior), then let runtime resolve + validate + compile + persist the launch
      // turn + submit.
      ...(dynamicWorkflowRunPort === undefined
        ? {}
        : {
            startSavedWorkflow: async (input: {
              name: string;
              scope?: "project" | "global";
              args?: Record<string, unknown>;
            }) => {
              await prepareUserExecutionBoundary({ traceContext });
              return await getRuntime().startSavedWorkflowRun({ ...input, traceContext });
            },
          }),
      // GUI "configure". It reuses the predecessor's script, so the port must both amend and
      // read back the script. If either is missing, do not register this capability and let the
      // GUI report it as unsupported.
      // Use the same user-execution boundary as startSavedWorkflow: on cold restore, restore the
      // Session boundary before persisting the settings turn.
      ...(dynamicWorkflowRunPort === undefined ||
      typeof dynamicWorkflowRunPort.amend !== "function" ||
      typeof dynamicWorkflowRunPort.getScript !== "function"
        ? {}
        : {
            amendWorkflowRunSettings: async (
              input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
            ) => {
              await prepareUserExecutionBoundary({ traceContext });
              return await getRuntime().amendWorkflowRunSettings({ ...input, traceContext });
            },
          }),
      ...createPluginFacadeForApp({ configResult, options, workingDirectory }),
      getPluginReferenceCatalog: () => pluginReferenceCatalog,
      getSkillCatalog: async () => {
        // The skill directory is part of context initialization. On cold restore, restore the
        // Session boundary first, then read the new runtime snapshot; do not bypass resume and
        // scan independently using the old working directory.
        await prepareUserExecutionBoundary({ traceContext });
        return await getRuntime().getSkillCatalog(traceContext);
      },
      resume: resumeFromStore,
      ...inputFacade,
    };
  } catch (error) {
    providerModelRuntime?.dispose();
    void modelTelemetry.shutdown().catch(() => undefined);
    void ownedNodeReplBrowserBroker?.close();
    startupTimer.fail("ZCode app startup failed", error, {
      context: { sessionId, workingDirectory },
      event: "bootstrap.app.startup.failed",
      stage: "total",
    });
    throw error;
  }
}
