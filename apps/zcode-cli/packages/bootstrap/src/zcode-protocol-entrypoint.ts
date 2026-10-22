import { createConfig, resolvePath } from "@zcode/adapters/config";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createLanguageServerPool } from "@zcode/adapters/lsp";
import type { McpElicitationPort, McpNotificationPort } from "@zcode/contracts";
import { createNodeModelSelectionFacade } from "@zcode/provider-node";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import {
  createMcpAdapterConnectionPool,
  createMcpTelemetryTracker,
  type McpConnectionPool,
  type McpTelemetryTracker,
} from "@zcode/adapters/mcp";
import {
  zcodeProtocolNotifications,
  type ZCodeMcpResourceSample,
  type ZCodeMcpTelemetryEvent,
} from "@zcode/shared";
import type { SqliteSessionStore } from "@zcode/adapters/storage";
import { traceContextToLogContext, createRootTraceContext } from "@zcode/contracts";
import type { McpPort, ModelSelection } from "@zcode/contracts";
import { createLspDocumentSync, type PresentationSurface } from "@zcode/core";
import type { RunZCodeProtocolAgentOptions, ZCodeAppOptions } from "./app/types.js";
import { createZCodeApp } from "./app/create-app.js";
import { createLspPreferencesStore } from "./app/lsp-preferences.js";
import { createLspRuntimeHub, type LspRuntimeHub } from "./app/lsp-runtime-hub.js";
import { getCliStorageRoot } from "./app/paths.js";
import { resolveZCodePlugins } from "./plugins.js";
import {
  createNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./app/node-repl-browser-broker.js";
import {
  openProtocolStartupStorage,
  prepareProtocolStartupStorage,
} from "./zcode-protocol/storage-startup.js";
import { closeSessionStore, getSessionDbPath } from "./app/session-store.js";
import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
import { AcpSessionPool, acpRuntimeLoggerFrom } from "./acp-agent/acp-session-pool.js";
import { createAcpExternalAgentHost } from "./acp-agent/acp-external-agent-host.js";
import { scheduleStartupLogRetentionCleanup } from "./log-retention.js";
import { resolveProcessProviderEndpointRoutingPort } from "./provider-endpoint-routing.js";
import { StartupTimer, startupNow } from "./startup-logging.js";
import { installZCodeProtocolAiSdkWarningLogger } from "./zcode-protocol/ai-sdk-warning-logger.js";
import {
  createOfficialMcpAuthHeadersPort,
  type OfficialMcpAuthRequestContext,
} from "./zcode-protocol/official-mcp-auth-port.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
  ZCODE_WORKSPACE_IDENTITY_ENV,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "./zcode-protocol/server.js";
import { ZCodeProtocolNdjsonConnection } from "./zcode-protocol/transport.js";
import { cleanupProtocolRuntime } from "./zcode-protocol/runtime-cleanup.js";
import { startProtocolResourceSampler } from "./zcode-protocol/resource-sampler.js";
import { acquireProtocolStartupResource } from "./zcode-protocol/startup-resource.js";
import { prepareZCodeTelemetryEnv, shutdownZCodeTelemetry } from "./telemetry-bootstrap.js";
import type { ZCodeProcessResourceSampler } from "./process-resource-sampler.js";

export function applyProtocolPresentationSurface(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  presentationSurface: PresentationSurface,
): Omit<ZCodeAppOptions, "providerRegistry"> {
  return {
    ...options,
    runtimeConfig: {
      ...options.runtimeConfig,
      presentationSurface,
    },
  };
}

/**
 * Once the process-level Registry is ready, it is the source of truth for models in the current Environment.
 *
 * The old workspace snapshot no longer participates in Provider or Model execution.
 */
export function applyProtocolProviderRegistry(
  options: Omit<ZCodeAppOptions, "providerRegistry">,
  providerRegistry: ZCodeAppOptions["providerRegistry"],
  configuredDefaultModelSelection?: ModelSelection,
): ZCodeAppOptions {
  return {
    ...options,
    providerRegistry,
    ...(configuredDefaultModelSelection ? { configuredDefaultModelSelection } : {}),
  };
}

export async function runZCodeProtocolAgent(
  options: RunZCodeProtocolAgentOptions = {},
): Promise<void> {
  if (options.prepareStorageOnly) {
    const config = createConfig({ env: options.env });
    await prepareProtocolStartupStorage({
      dbPath: getSessionDbPath(config, options.cwd),
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    return;
  }
  const startupStartedAt = startupNow();
  const presentationSurface = options.presentationSurface ?? "terminal";
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const loggerFactory = createNodeLoggerFactory({ env: options.env });
  const traceContext = createRootTraceContext({
    attributes: {
      entrypoint: "zcode_protocol",
    },
  });
  const logger = loggerFactory.createLogger("zcode").child({
    ...traceContextToLogContext(traceContext),
    module: "bootstrap.zcode_protocol",
  });
  installZCodeProtocolAiSdkWarningLogger(logger);
  const startupTimer = new StartupTimer(
    logger,
    {
      ...traceContextToLogContext(traceContext),
      module: "bootstrap.zcode_protocol",
      startupKind: "zcode_protocol_agent",
    },
    startupStartedAt,
  );
  startupTimer.start("ZCode Protocol agent startup started", {
    context: { version: options.version },
    event: "zcode_protocol.startup.started",
    stage: "start",
  });

  let sessionStore: SqliteSessionStore | undefined;
  let serverForCleanup: ZCodeProtocolAgentServer | undefined;
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let mcpConnectionPool: McpConnectionPool | undefined;
  let lspRuntimeHub: LspRuntimeHub | undefined;
  let mcpPort: McpPort | undefined;
  let mcpTelemetryTracker: McpTelemetryTracker | undefined;
  let mcpResourceSink: ((samples: ZCodeMcpResourceSample[]) => void) | undefined;
  let mcpTelemetrySink: ((event: ZCodeMcpTelemetryEvent) => void) | undefined;
  let processResourceSampler: ZCodeProcessResourceSampler | undefined;
  let providerRegistryRuntime:
    | Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>
    | undefined;
  let acpSessionPool: AcpSessionPool | undefined;
  try {
    // Prepare the database before accounts, Registry, and telemetry; do not mix waiting for remote materials into the migration gate.
    const configResult = createConfig({ env: options.env });
    sessionStore = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: (store) => closeSessionStore(store),
      create: () =>
        openProtocolStartupStorage({
          dbPath: getSessionDbPath(configResult),
          output,
          onProgress: (progress) =>
            logger.info("SQLite startup state", {
              event: "zcode_protocol.startup.storage_state",
              ...progress,
            }),
        }),
    });
    const runtimeEnv = options.env ?? process.env;
    options.lifecycle?.signal.throwIfAborted();
    providerRegistryRuntime = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      create: () => startProcessProviderRegistryRuntime(runtimeEnv),
      disposeLate: (runtime) => runtime.dispose(),
    });
    options.lifecycle?.signal.throwIfAborted();
    logger.info("Worker Provider Registry 已就绪", {
      accountRevision: providerRegistryRuntime.snapshot.sourceRevisions.account,
      configRevision: providerRegistryRuntime.snapshot.sourceRevisions.config,
      event: "zcode_protocol.provider_registry.ready",
      module: "bootstrap.zcode_protocol",
      providerCount: providerRegistryRuntime.snapshot.registry.providers.length,
    });
    const runtimeSurface = resolveProtocolRuntimeSurface(runtimeEnv);
    const telemetryEnv = await acquireProtocolStartupResource({
      signal: options.lifecycle?.signal,
      logger,
      disposeLate: () => shutdownZCodeTelemetry(),
      create: () =>
        prepareZCodeTelemetryEnv(runtimeEnv, {
          cliVersion: options.version,
          productVersion: options.env?.ZCODE_APP_VERSION,
          runtimeSurface,
        }),
    });
    const telemetryDeviceMid = telemetryEnv.ZCODE_TELEMETRY_DEVICE_MID;
    mcpTelemetryTracker =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpTelemetryTracker({
            idSalt: telemetryDeviceMid ?? traceContext.traceId,
            onEvent: (event) => mcpTelemetrySink?.(event),
            onResourceSamples: (samples) => mcpResourceSink?.(samples),
          });
    const providerEndpointRoutingPort =
      options.providerEndpointRoutingPort ??
      resolveProcessProviderEndpointRoutingPort({
        appVersion: options.version,
        env: options.env,
        logger,
        network: configResult.config.network,
        sourceTitle: "electron",
      });
    // Official MCP identity-header port (spec §7.1/§7.2): the connection pool is constructed before the server, so
    // populate a lazy holder later. Before the server is ready, the port returns
    // official_auth_unavailable. HTTP tools/call reaches the server anonymously and receives a
    // structured permission error; stdio passes the reason to the plugin. Connection and tool discovery are unaffected.
    let officialMcpAuthContext: OfficialMcpAuthRequestContext | undefined;
    // Official stdio MCP has no URL to validate, so the host must provide targetOrigin.
    // It must use the same expression as resolveZCodeApiOrigin for trustedOrigins below, or the two checks can diverge.
    const resolveZCodeApiOrigin = (): string =>
      resolveRuntimeZCodeEndpointOrigin(options.env ?? process.env);
    const workspaceIdentity = (options.env ?? process.env)[ZCODE_WORKSPACE_IDENTITY_ENV]?.trim();
    const officialMcpAuth = {
      authHeadersPort: createOfficialMcpAuthHeadersPort({
        resolveContext: () => officialMcpAuthContext,
        // workspaceKey must follow the repository convention `workspaceIdentity?.trim() || workspacePath`,
        // or remote workspaces with the same path and different identities cannot be distinguished in audit context.
        // Note: the agent process currently has no identity source, so this is usually undefined and the key
        // falls back to path; see "Remaining gap" in official-mcp-auth-port.ts.
        resolveWorkspace: ({ workspaceIdentity, workspacePath }) => {
          const path = workspacePath ?? options.cwd;
          if (!path) return undefined;
          const identity = workspaceIdentity?.trim();
          return {
            ...(identity ? { workspaceIdentity: identity } : {}),
            workspaceKey: identity || path,
            workspacePath: path,
          };
        },
      }),
      resolveZCodeApiOrigin,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      // Trust check has one criterion: target origin equals the current ZCode API origin (https). pluginId is not involved.
      // Resolve origin at runtime for production/test and self-hosted environments; do not hardcode a domain.
      trustedOrigins: createOfficialMcpTrustedOriginRegistry({
        devTrustedOriginsRaw: (options.env ?? process.env)[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
        resolveZCodeApiOrigin,
      }),
    };
    // MCP elicitation belongs to the protocol server's session; the pool is created before the server, so the port binds lazily.
    let elicitationServer: {
      requestMcpElicitation: McpElicitationPort["requestElicitation"];
      handleMcpNotification: McpNotificationPort["onNotification"];
    } | null = null;
    mcpConnectionPool =
      configResult.config.features.mcp === false
        ? undefined
        : createMcpAdapterConnectionPool({
            elicitation: {
              requestElicitation: (request, elicitationOptions) =>
                elicitationServer
                  ? elicitationServer.requestMcpElicitation(request, elicitationOptions)
                  : Promise.resolve({ action: "decline" as const }),
            },
            // Server notifications also bind lazily to the protocol server.
            notifications: {
              onNotification: (notification) =>
                elicitationServer?.handleMcpNotification(notification),
            },
            clientVersion: options.version ?? "0.0.0",
            env: options.env,
            logger,
            network: {
              httpProxy: configResult.config.network.httpProxy,
              noProxy: configResult.config.network.noProxy,
              caCertFile: configResult.config.network.caCertFile,
            },
            officialMcpAuth,
            telemetry: mcpTelemetryTracker,
            workingDirectory: options.cwd,
          });
    mcpPort = mcpConnectionPool?.acquireLease({ leaseId: "protocol-settings" });
    // One language server pool and one preferences owner per process, shared by all sessions.
    lspRuntimeHub = createLspRuntimeHub({
      port: createLanguageServerPool({ baseEnv: options.env ?? process.env, logger }),
      documents: createLspDocumentSync({ fileSystem: createNodeFileSystemAdapter(), logger }),
      preferences: createLspPreferencesStore({
        cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
        fileSystem: createNodeFileSystemAdapter(),
        logger,
      }),
      resolveServers: (workspacePath) =>
        resolveZCodePlugins({ logger, workingDirectory: workspacePath }).lspServers,
      logger,
    });
    const activeLspRuntimeHub = lspRuntimeHub;
    const activeProviderRegistryRuntime = providerRegistryRuntime;
    // One resident ACP agent process per ZCode session; the sidecar store is read per turn.
    acpSessionPool = new AcpSessionPool({ logger: acpRuntimeLoggerFrom(logger) });
    const externalAgents = createAcpExternalAgentHost({
      records: activeProviderRegistryRuntime.acpAgentStore,
      pool: acpSessionPool,
      logger,
    });
    const modelSelectionFacade = createNodeModelSelectionFacade(
      activeProviderRegistryRuntime.runtime.registryService,
    );
    options.lifecycle?.signal.throwIfAborted();
    const server = (serverForCleanup = new ZCodeProtocolAgentServer({
      createZCodeApp: (appOptions = {}) =>
        createZCodeApp({
          ...applyProtocolProviderRegistry(
            applyProtocolPresentationSurface(appOptions, presentationSurface),
            activeProviderRegistryRuntime.runtime.registryService,
            activeProviderRegistryRuntime.configuredDefaultModelSelection,
          ),
          externalAgents,
          // Read only the applied snapshot in this process; do not issue another Host RPC for a child task or switch models inside ModelFactory.
          resolveEffectiveModelSelection: (selection) => {
            const view = modelSelectionFacade.getView(undefined, undefined, { selection });
            return {
              effectiveSelection: view.effectiveSelection ?? null,
              selectionIssue: view.selectionIssue,
            };
          },
          env: {
            ...telemetryEnv,
            ...appOptions.env,
            ...(telemetryDeviceMid ? { ZCODE_TELEMETRY_DEVICE_MID: telemetryDeviceMid } : {}),
          },
          ...(nodeReplBrowserBroker ? { nodeReplBrowserBroker } : {}),
          lspRuntimeHub: activeLspRuntimeHub,
          ...(mcpConnectionPool
            ? {
                mcpPortFactory: () =>
                  mcpConnectionPool!.acquireLease({
                    leaseId: appOptions.sessionId,
                    sessionId: appOptions.sessionId,
                  }),
              }
            : {}),
          providerEndpointRoutingPort,
          sourceTitle: "electron",
          onToolExecResource: (params) =>
            connection.send({ method: zcodeProtocolNotifications.toolExecResource, params }),
        }),
      cwd: options.cwd,
      env: options.env,
      loggerFactory,
      lsp: activeLspRuntimeHub.protocolHost,
      mcpPort,
      mcpTelemetry: mcpTelemetryTracker,
      sessionStore,
      storageRoot: resolvePath(configResult.config.storage.dir),
      syncAccountProviderConfig: activeProviderRegistryRuntime.syncAccountProviderConfig,
      refreshProviderRegistry: async (reason) => {
        await activeProviderRegistryRuntime.runtime.registryService.refresh(reason);
      },
      version: options.version,
    }));
    officialMcpAuthContext = server.officialMcpAuthRequestContext;
    elicitationServer = server;
    if (configResult.config.features.mcp !== false) {
      nodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort: server.browserControlPort,
        logger,
        platform: process.platform,
      });
      const broker = nodeReplBrowserBroker;
      await acquireProtocolStartupResource({
        signal: options.lifecycle?.signal,
        logger,
        create: () => broker.ready,
      });
    }
    const connection = new ZCodeProtocolNdjsonConnection({
      signal: options.lifecycle?.signal,
      clearPostResponseMessages: () => server.clearPostResponseMessages(),
      handleMessage: (message) => server.handleMessage(message),
      input,
      logger,
      onTransportClosed: (error) => server.disconnectClient(error),
      output,
      takePostResponseBatch: (requestId) => server.takePostResponseBatch(requestId),
    });
    server.setNotificationSink((notification) => connection.send(notification));
    mcpResourceSink = (samples) =>
      connection.send({
        method: zcodeProtocolNotifications.mcpResourceSamples,
        params: samples,
      });
    mcpTelemetrySink = (event) => {
      // The five-minute resource notification replaces the old memory notification; the tracker's internal orphan facts retain their existing criteria.
      if (event.kind === "memory") return;
      connection.send({
        method: zcodeProtocolNotifications.mcpTelemetry,
        params: event,
      });
    };
    connection.start();
    mcpTelemetryTracker?.start();
    processResourceSampler = startProtocolResourceSampler(
      server,
      (message) => connection.send(message),
      logger,
    );
    startupTimer.complete("ZCode Protocol agent startup completed", {
      event: "zcode_protocol.startup.completed",
      stage: "total",
    });
    scheduleStartupLogRetentionCleanup(loggerFactory, logger);
    await connection.waitForClose();
  } catch (error) {
    options.lifecycle?.requestShutdown(
      error instanceof Error ? error : new Error("Protocol runtime failed", { cause: error }),
    );
    startupTimer.fail("ZCode Protocol agent startup failed", error, {
      event: "zcode_protocol.startup.failed",
      stage: "total",
    });
    throw error;
  } finally {
    options.lifecycle?.requestShutdown();
    await cleanupProtocolRuntime({
      logger,
      deadlineAt: options.lifecycle?.deadlineAt,
      server: serverForCleanup,
      processResourceSampler,
      mcpTelemetryTracker,
      nodeReplBrowserBroker,
      mcpPort,
      mcpConnectionPool,
      languageServerPort: lspRuntimeHub?.port,
      sessionStore,
      providerRegistryRuntime,
      acpSessionPool,
    });
    logger.info("ZCode Protocol agent shutdown completed", {
      ...traceContextToLogContext(traceContext),
      event: "zcode_protocol.shutdown.completed",
      module: "bootstrap.zcode_protocol",
      status: "completed",
    });
  }
}

function resolveProtocolRuntimeSurface(
  env: NodeJS.ProcessEnv,
): "desktop_local_host" | "remote_workspace_host" {
  // Bug root cause: the entry point used to unconditionally overwrite the Host-injected value, assigning remote SSH/WSL/container traces to the local Desktop.
  return env.ZCODE_TELEMETRY_RUNTIME_SURFACE?.trim() === "remote_workspace_host"
    ? "remote_workspace_host"
    : "desktop_local_host";
}
