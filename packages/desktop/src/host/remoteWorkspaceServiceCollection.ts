/* eslint-disable max-lines -- Keep remote workspace service registration centralized to preserve dependency-injection order. */
import {
  ServiceCollection,
  IFileService,
  IGenUiService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IConversationShareService,
  createUnsupportedConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  ISourceServerWorkspaceService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IUserInstructionsService,
  IOutputStyleService,
  ISystemPromptService,
  ISettingsSyncService,
  IProjectService,
  ITaskGroupService,
  IRemoteProjectService,
  IPromptAttachmentTransferService,
  type ServiceDescriptor,
  type IServiceAccessor,
} from "@zcode/services";
import {
  ConversationShareHttpClient,
  ConversationShareService,
  createSettingService,
  createCredentialService,
  createBroadcastService,
  createNodeApiClient,
  createHostApiNetworkTransport,
  registerHostApiNetworkTransportForDispose,
  createOAuthService,
  createOAuthProviderLogoutHandler,
  createAccountProviderCredentialStore,
  createAccountProviderCredentialService,
  createAccountProjectTokenClient,
  getAccountRequestAuthService,
  createAccountProviderRequestAuthService,
  createAccountRequestAuthService,
  resolveCurrentAccountAccess,
  resolveAccountTeamPlanRuntimeMaterial,
  createSettingsSyncService,
  createBotsService,
  createUsageStatsService,
  createCodingPlanSubscriptionService,
  createClientScenesService,
  createServiceLogger,
  createLegacySingleRootProjectService,
  createRemoteProjectService,
  createSubagentsService,
  createMemoryService,
  createRemoteConversationShareArtifactSource,
  OAuthCredentialRepo,
} from "@zcode/services/node";
import {
  BIGMODEL_PROVIDER_ID,
  buildRuntimeZCodeApiUrl,
  buildServerRemoteWorkspaceIdentity,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  remoteHostIdFromWorkspaceIdentity,
  type ProviderFamilyDomain,
  resolveBigModelApiOrigin,
  resolveZaiBusinessBaseUrl,
  type RemoteTarget,
  type ZCodeSessionRuntimePreferencesResult,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import {
  REMOTE_WORKSPACE_RPC_CHANNELS,
  assertRemoteWorkspaceRpcContract,
} from "./remoteWorkspaceRpcContract.js";
import { assertLegacyRemoteWorkspaceRpcContract } from "./legacyRemoteWorkspaceRpcContract.js";
import {
  createRemoteProviderProvisioningExecutorFromWorkspace,
  registerRemoteProviderProvisioningExecutor,
} from "./remoteProviderProvisioningService.js";

export const REMOTE_WORKSPACE_RPC_REGISTRATIONS = [
  ["fileService", IFileService],
  ["genUiService", IGenUiService],
  ["mediaPreviewService", IMediaPreviewService],
  ["gitService", IGitService],
  ["gitCheckpointService", IGitCheckpointService],
  ["systemService", ISystemService],
  ["terminalService", ITerminalService],
  ["settingService", ISettingService],
  ["onboardingRecordService", IOnboardingRecordService],
  ["credentialService", ICredentialService],
  ["broadcastService", IBroadcastService],
  ["zcodeTaskService", IZCodeTaskService],
  ["zcodeAgentService", IZCodeAgentService],
  ["zcodeSessionService", IZCodeSessionService],
  ["conversationShareService", IConversationShareService],
  ["botsService", IBotsService],
  ["fileWatcherService", IFileWatcherService],
  ["oauthService", IOAuthService],
  ["providerSettingsService", IProviderSettingsService],
  ["modelSelectionService", IModelSelectionService],
  ["sourceServerWorkspaceService", ISourceServerWorkspaceService],
  ["usageStatsService", IUsageStatsService],
  ["codingPlanSubscriptionService", ICodingPlanSubscriptionService],
  ["clientScenesService", IClientScenesService],
  ["skillsService", ISkillsService],
  ["skillSyncService", ISkillSyncService],
  ["mcpSyncService", IMcpSyncService],
  ["pluginSyncService", IPluginSyncService],
  ["pluginsService", IPluginsService],
  ["pluginManagementService", IPluginManagementService],
  ["subagentsService", ISubagentsService],
  ["commandsService", ICommandsService],
  ["hooksService", IHooksService],
  ["memoryService", IMemoryService],
  ["outputStyleService", IOutputStyleService],
  ["settingsSyncService", ISettingsSyncService],
  ["promptAttachmentTransferService", IPromptAttachmentTransferService],
] as const satisfies readonly [keyof IServiceAccessor, ServiceDescriptor<unknown>][];

const conversationShareLog = createServiceLogger("conversation-share");

function createUnsupportedRemoteConversationShareService(): IConversationShareService {
  return createUnsupportedConversationShareService({
    message: "Conversation sharing is not available for this client or remote target",
    onRejected: (action) => {
      conversationShareLog.warn(undefined, "conversation share action rejected", {
        action,
        kind: "feature_disabled",
        reason: "server_remote_unsupported",
      });
    },
  });
}

export function resolveServerProjectService(params: {
  connectionServices: IServiceAccessor;
  serverId: string;
  virtualProjects?: boolean;
  sourceServices?: ServiceCollection;
}): IProjectService {
  if (params.virtualProjects) {
    if (!params.connectionServices.projectService)
      throw new Error("Remote virtual-project RPC registration incomplete");
    return params.connectionServices.projectService;
  }
  const hostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: params.serverId, workspacePath: "/" }),
  )!;
  return createLegacySingleRootProjectService({
    hostId,
    directories: {
      info: () => params.connectionServices.systemService.info(),
      read: (input) => params.connectionServices.fileService.readdir(input),
    },
    readSettings: () => params.connectionServices.settingService.get(),
    readKnownWorkspaces: async () => {
      const directory = await params.sourceServices
        ?.getOptional(IRemoteProjectService)
        ?.readDirectory();
      return (directory?.entries ?? [])
        .filter((entry) => entry.hostId === hostId)
        .flatMap((entry) =>
          entry.roots.length
            ? entry.roots.map((root) => ({ workspacePath: root.rootPath }))
            : entry.legacyWorkspace
              ? [
                  {
                    workspacePath: entry.legacyWorkspace.workspacePath,
                    workspacePurpose: entry.legacyWorkspace.workspacePurpose,
                  },
                ]
              : [],
        );
    },
    readTasks: ({ workspacePath, kind }) => {
      const tasks = params.connectionServices.zcodeTaskService;
      const scope = { workspacePath };
      return kind === "pinned"
        ? tasks.listPinnedTasks(scope)
        : kind === "archived"
          ? tasks.listArchivedTasks(scope)
          : tasks.listTasks(scope);
    },
    ensureConversation: async () =>
      (await params.connectionServices.fileService.ensureConversationWorkspace()).path,
  });
}

const runtimePreferencesLogger = createServiceLogger("remote-runtime-preferences");
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";

export function createRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  sourceServices?: ServiceCollection;
  localOnboardingRecordService: IOnboardingRecordService;
  parentPort: Parameters<typeof createBroadcastService>[0];
  createReportingRemoteZCodeTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentTaskService: <T extends object>(service: T) => T;
  createRemotePromptAttachmentSessionService: <T extends object>(service: T) => T;
  promptAttachmentTransferService: IPromptAttachmentTransferService;
  runtimePreferencesBridge: {
    onError: (error: unknown) => void;
  };
}): ServiceCollection {
  assertLegacyRemoteWorkspaceRpcContract(params.connectionServices);
  const localSettingService = createSettingService();
  let fallbackTokenClient: ReturnType<typeof createAccountProjectTokenClient> | undefined;
  const localCredentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (key.startsWith("oauth:") || key === ZCODE_JWT_TOKEN_KEY) fallbackTokenClient?.clear();
    },
  });
  const localAccountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService: localCredentialService,
  });
  const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
    const settings = await localSettingService.get();
    return {
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
      caCertPath: settings.httpProxyCaCertPath,
    };
  });
  const localApiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
  });
  const localBroadcastService = createBroadcastService(params.parentPort);
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const localOAuthCredentialRepo = new OAuthCredentialRepo(localCredentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // The remote workspace Host reads and writes local OAuth credentials.
      // Corruption recovery must clear derived Start/Coding Plan providers as the local Host does, so mobile remote does not retain stale keys.
      await Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      );
    },
  });
  const readLocalAccountProviderSettings = async () => {
    const settings = await localSettingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
    };
  };
  const loadLocalAccountIdentity = async (family: ProviderFamilyDomain) => {
    const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await localOAuthCredentialRepo.loadUserProfile(providerId))?.id ?? null;
  };
  const localAccountRequestAuthService =
    (params.sourceServices ? getAccountRequestAuthService(params.sourceServices) : undefined) ??
    (() => {
      // The old implementation only read the disk key and resolve was always empty; after the migration, reuse the official owner or exchange credentials at this boundary.
      const tokenClient = createAccountProjectTokenClient(localApiClient, localCredentialService);
      fallbackTokenClient = tokenClient;
      // 401 recovery must propagate the rejected PAT fingerprint through the personal/team callbacks, or the cache will return the rejected credential again.
      const credentialResolver = createAccountProviderCredentialService({
        async loadOAuthAccessToken(family) {
          const providerId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
          return (await localOAuthCredentialRepo.loadTokenSet(providerId))?.accessToken ?? null;
        },
        async resolveProviderMaterial(
          family,
          loginToken,
          accountIdentity,
          rejectedProjectTokenFingerprint,
        ) {
          const result = await tokenClient.resolve({
            origin:
              family === "zai"
                ? resolveZaiBusinessBaseUrl(process.env)
                : resolveBigModelApiOrigin(process.env),
            family,
            loginToken,
            accountId: accountIdentity,
            rejectedProjectTokenFingerprint,
          });
          return result;
        },
      });
      return createAccountRequestAuthService(
        createAccountProviderRequestAuthService({
          resolveCurrentAccountAccess: (access) =>
            resolveCurrentAccountAccess({
              access,
              readSettings: readLocalAccountProviderSettings,
              loadAccountIdentity: loadLocalAccountIdentity,
            }),
          loadOAuthTokenSet: (providerId) => localOAuthCredentialRepo.loadTokenSet(providerId),
          async loadIndividualPlanMaterial(providerId, family, rejectedProjectTokenFingerprint) {
            const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
            const accountIdentity = (
              await localOAuthCredentialRepo.loadUserProfile(oauthProviderId)
            )?.id;
            if (!accountIdentity) return null;
            return credentialResolver.loadCodingPlanMaterial({
              providerId,
              family,
              accountIdentity,
              rejectedProjectTokenFingerprint,
            });
          },
          resolveTeamPlanMaterial: async (access, rejectedProjectTokenFingerprint) => {
            const accountIdentity = await loadLocalAccountIdentity(access.family);
            if (!accountIdentity) return null;
            return resolveAccountTeamPlanRuntimeMaterial({
              apiClient: localApiClient,
              credentialService: localCredentialService,
              accountIdentity,
              tokenClient,
              access,
              rejectedProjectTokenFingerprint,
            });
          },
        }),
      );
    })();
  const localCodingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient: localApiClient,
    credentialService: localCredentialService,
  });
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore: localAccountProviderCredentialStore,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // Sharing from a remote workspace must also use the real API; the local Mock is only for unit tests and does not create links accessible across processes.
    apiClient: localApiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async () =>
      (await localCredentialService.load(ZCODE_JWT_TOKEN_KEY))?.trim() || null,
  });
  const conversationShareService = new ConversationShareService({
    zcodeAgentService: params.connectionServices.zcodeAgentService,
    client: conversationShareClient,
    artifactSource: createRemoteConversationShareArtifactSource(
      params.connectionServices.fileService,
    ),
  });
  const reportingRemoteZCodeTaskService = params.createReportingRemoteZCodeTaskService(
    params.connectionServices.zcodeTaskService,
  );
  // The mobile remote replayable mirror publishes user messages inside the reporting wrapper.
  // Attachment materialization must wrap the reporting layer so the mirror and the prompt sent to the remote agent use the same remote paths.
  const remoteZCodeTaskService = params.createRemotePromptAttachmentTaskService(
    reportingRemoteZCodeTaskService,
  );
  const remoteZCodeSessionService = params.createRemotePromptAttachmentSessionService(
    params.connectionServices.zcodeSessionService,
  );
  const remoteProviderProvisioningService =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);

  // The Agent for a Desktop-attached remote runs remotely, but app-global settings remain authoritative in
  // the Desktop shared Host. Route a narrow runtime-preferences request back through it so the remote does not read its own settings.
  const { onError } = params.runtimePreferencesBridge;
  params.connectionServices.zcodeAgentService.onDynamicSessionRuntimePreferencesRequest()(
    (request) => {
      const startedAt = Date.now();
      const requestContext = {
        event: "zcode_protocol.runtime_preferences.host_request_received",
        module: "desktop.host.remote_workspace",
        requestId: request.requestId,
        scope: request.scope,
        sessionId: request.sessionId,
      };
      // Diagnostics: an Agent-side timeout only means no response arrived. Record whether Host received the request
      // to distinguish "received but no response" from transport loss or a stalled settings read.
      runtimePreferencesLogger.info(
        undefined,
        "runtime preferences host request received",
        requestContext,
      );
      void (async () => {
        const trackStage = <T>(stage: string, promise: Promise<T>): Promise<T> => {
          const stageStartedAt = Date.now();
          return promise.then(
            (value) => {
              runtimePreferencesLogger.debug(
                undefined,
                "runtime preferences host stage completed",
                {
                  ...requestContext,
                  durationMs: Math.max(0, Date.now() - stageStartedAt),
                  stage,
                },
              );
              return value;
            },
            (error: unknown) => {
              runtimePreferencesLogger.warn(undefined, "runtime preferences host stage failed", {
                ...requestContext,
                durationMs: Math.max(0, Date.now() - stageStartedAt),
                error: error instanceof Error ? error.message : String(error),
                stage,
              });
              throw error;
            },
          );
        };
        let resolution:
          | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
          | { status: "failed"; message: string };
        try {
          // Use the same source as the local Host: fixed budgets do not depend on the config gateway, so remote/mobile preference responses no longer wait on network requests serially.
          const settings = await trackStage("settings", localSettingService.get());
          const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
          resolution = {
            status: "resolved",
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              memoryEnabled: settings.memoryEnabled === true,
              memoryIndexAsContext: settings.memoryIndexAsContext === true,
              modelContextBudgetStrategy,
              // Keep the same scope boundary as the local Host; the first execution in a remote workspace must not wait for client config again.
              ...(request.scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            },
          };
        } catch (error) {
          resolution = {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
          runtimePreferencesLogger.warn(undefined, "runtime preferences host resolution failed", {
            ...requestContext,
            durationMs: Math.max(0, Date.now() - startedAt),
            error: resolution.message,
          });
        }
        // Encode only settings-read failures as -32603; let the final onError record send failures and do not retry the same request.
        await params.connectionServices.zcodeAgentService.respondSessionRuntimePreferences({
          requestId: request.requestId,
          resolution,
        });
        runtimePreferencesLogger.info(undefined, "runtime preferences host response sent", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          resolutionStatus: resolution.status,
        });
      })().catch((error: unknown) => {
        runtimePreferencesLogger.warn(undefined, "runtime preferences host response failed", {
          ...requestContext,
          durationMs: Math.max(0, Date.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        onError(error);
      });
    },
  );

  // When Web mobile remote control opens an SSH task, it connects only to the remote workspace Host;
  // there is no Desktop renderer layer that merges `baseServices + remoteServices`.
  // Add local global channels to the remote workspace Host here. Files, terminal, and ZCode Agent still come from the remote,
  // while settings, credentials, OAuth, model providers, and settings-sync continue to read and write local config.
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, localSettingService)
    // Rebuilding the remote Root on mobile once re-showed onboarding because this channel was missing; reuse the Local Host owner so records and login state share one source.
    .register(IOnboardingRecordService, params.localOnboardingRecordService)
    .register(ICredentialService, localCredentialService)
    .register(IBroadcastService, localBroadcastService)
    .register(IZCodeTaskService, remoteZCodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, remoteZCodeSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService: localCredentialService,
        zcodeTaskService: remoteZCodeTaskService,
        broadcastService: localBroadcastService,
        settingService: localSettingService,
        modelSelectionService: params.connectionServices.modelSelectionService,
        // Fix: the remote workspace Host's initial screen needs only remote file/agent capabilities.
        // If bot startup immediately polls or calls getAll, it fetches local presets again and increases SSH/Docker connection time.
        runStartupBackgroundTasks: false,
      }),
    )
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(
      IOAuthService,
      createOAuthService(localCredentialService, {
        apiClient: localApiClient,
        onProviderLogout: handleOAuthProviderLogout,
      }),
    )
    // Provider/Model facts belong to the target Environment. The remote workspace's selector and settings view
    // must read the remote Registry directly rather than continue showing Desktop-local providers.
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient: localApiClient,
        accountRequestAuthService: localAccountRequestAuthService,
        credentialService: localCredentialService,
        zcodeAgentService: params.connectionServices.zcodeAgentService,
      }),
    )
    .register(ICodingPlanSubscriptionService, localCodingPlanSubscriptionService)
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, createClientScenesService({ apiClient: localApiClient }))
    // Project-level skills/plugins/commands for a remote workspace live on the SSH/Docker filesystem.
    // Expose the remote services here so local services do not scan the remote workspacePath on the local filesystem.
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    // Plugin management in remote settings must also call the remote agent because the plugin directory is on the remote filesystem.
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(ISubagentsService, createSubagentsService({ isDesktopRuntime: true }))
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, createMemoryService())
    // Global instructions belong to the target host: the remote CLI reads the remote ~/.zcode/AGENTS.md.
    // Do not fall back to the local instance as Memory does, or it will silently edit a local file.
    .register(IUserInstructionsService, params.connectionServices.userInstructionsService)
    // Output styles follow the same rule: a local instance would edit the desktop's ~/.zcode
    // while the remote CLI reads the remote host's files.
    .register(IOutputStyleService, params.connectionServices.outputStyleService)
    // System-prompt overrides follow the same rule: the remote CLI reads ~/.zcode/system-prompt
    // on the remote host, so a local instance must not serve these reads/writes.
    .register(ISystemPromptService, params.connectionServices.systemPromptService)
    .register(
      ISettingsSyncService,
      createSettingsSyncService({ settingService: localSettingService }),
    )
    .register(IPromptAttachmentTransferService, params.promptAttachmentTransferService);
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningService);
  return services;
}

export function createServerRemoteWorkspaceServiceCollection(params: {
  clientConfigService: IClientConfigService;
  connectionServices: IServiceAccessor;
  virtualProjects?: boolean;
  serverId?: string;
  targetKind: RemoteTarget["kind"];
  /** 本机 Local Host 服务；提供 Provider Provisioning Source，缺失时 Provisioning 按 unsupported 处理。 */
  sourceServices?: ServiceCollection;
}): ServiceCollection {
  assertRemoteWorkspaceRpcContract(params.connectionServices);
  // Server remote 连接的是一个已经运行的完整 ZCode server。
  // Host 只做 RPC 转接，不替 server 决定 workspace/runtime/provider 归属；
  // Provider 配置只经 Host 私有的 Provisioning executor 从本机单向下发到远端。
  const remoteProviderProvisioningExecutor =
    createRemoteProviderProvisioningExecutorFromWorkspace(params);
  const services = new ServiceCollection()
    .register(IFileService, params.connectionServices.fileService)
    // 根因：客户端已有 gen-ui 代理，但 Host 漏转发使远端读取成为 Unknown channel。
    // 复用 Source 的读取与输出目录校验；桌面状态/沙箱仍由 base services 提供。
    .register(IGenUiService, params.connectionServices.genUiService)
    .register(IMediaPreviewService, params.connectionServices.mediaPreviewService)
    .register(IGitService, params.connectionServices.gitService)
    .register(IGitCheckpointService, params.connectionServices.gitCheckpointService)
    .register(ISystemService, params.connectionServices.systemService)
    .register(ITerminalService, params.connectionServices.terminalService)
    .register(ISettingService, params.connectionServices.settingService)
    // Bug 原因：远程集合曾漏注册此通道，手机重建 Root 后调用失败，回退 settings 判定而误弹引导。
    // 引导记录必须与该入口的 settings/OAuth 同源：R3 下四种 transport 都由 Source 持有，不借用本机记录。
    .register(IOnboardingRecordService, params.connectionServices.onboardingRecordService)
    .register(ICredentialService, params.connectionServices.credentialService)
    .register(IBroadcastService, params.connectionServices.broadcastService)
    .register(IZCodeTaskService, params.connectionServices.zcodeTaskService)
    .register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
    .register(IZCodeSessionService, params.connectionServices.zcodeSessionService)
    // R3 的分享属于目标 Environment；不能恢复旧 SSH 的本机 JWT 混装。
    .register(
      IConversationShareService,
      params.targetKind === "server"
        ? createUnsupportedRemoteConversationShareService()
        : params.connectionServices.conversationShareService,
    )
    .register(IBotsService, params.connectionServices.botsService)
    .register(IFileWatcherService, params.connectionServices.fileWatcherService)
    .register(IOAuthService, params.connectionServices.oauthService)
    .register(IProviderSettingsService, params.connectionServices.providerSettingsService)
    .register(IModelSelectionService, params.connectionServices.modelSelectionService)
    .register(ISourceServerWorkspaceService, params.connectionServices.sourceServerWorkspaceService)
    .register(IUsageStatsService, params.connectionServices.usageStatsService)
    .register(
      ICodingPlanSubscriptionService,
      params.connectionServices.codingPlanSubscriptionService,
    )
    .register(IClientConfigService, params.clientConfigService)
    .register(IClientScenesService, params.connectionServices.clientScenesService)
    .register(ISkillsService, params.connectionServices.skillsService)
    .register(ISkillSyncService, params.connectionServices.skillSyncService)
    .register(IMcpSyncService, params.connectionServices.mcpSyncService)
    // Bug 原因：RPC 合同已经要求 plugin-sync，但旧全转发集合漏注册，远端插件同步会在 Host
    // 二次暴露时变成 Unknown channel。全转发集合必须与合同逐项一致。
    .register(IPluginSyncService, params.connectionServices.pluginSyncService)
    .register(IPluginsService, params.connectionServices.pluginsService)
    .register(IPluginManagementService, params.connectionServices.pluginManagementService)
    .register(ISubagentsService, params.connectionServices.subagentsService)
    .register(ICommandsService, params.connectionServices.commandsService)
    .register(IHooksService, params.connectionServices.hooksService)
    .register(IMemoryService, params.connectionServices.memoryService)
    .register(IOutputStyleService, params.connectionServices.outputStyleService)
    .register(ISystemPromptService, params.connectionServices.systemPromptService)
    .register(ISettingsSyncService, params.connectionServices.settingsSyncService)
    .register(
      IPromptAttachmentTransferService,
      params.connectionServices.promptAttachmentTransferService,
    );
  // 新频道必须以握手能力为准；客户端总能生成 proxy，不能用对象存在性判断旧 Server 支持。
  if (params.virtualProjects) {
    if (
      !params.connectionServices.projectService ||
      !params.connectionServices.remoteProjectService
    )
      throw new Error("Remote virtual-project RPC registration incomplete");
    services.register(IProjectService, params.connectionServices.projectService);
    services.register(IRemoteProjectService, params.connectionServices.remoteProjectService);
  } else if (params.serverId) {
    services.register(
      IProjectService,
      resolveServerProjectService({ ...params, serverId: params.serverId }),
    );
    services.register(
      IRemoteProjectService,
      createRemoteProjectService({
        controller: false,
        database: async () => {
          throw new Error("remote-project.controller-only");
        },
      }),
    );
  }
  const controllerGroups = params.sourceServices?.getOptional(ITaskGroupService);
  const controllerBroadcast = params.sourceServices?.getOptional(IBroadcastService);
  if (controllerGroups) services.register(ITaskGroupService, controllerGroups);
  if (controllerGroups && controllerBroadcast) {
    const remoteBroadcast = params.connectionServices.broadcastService;
    services.register(IBroadcastService, {
      send: (message) =>
        (message.channel === "state:task-groups" ? controllerBroadcast : remoteBroadcast).send(
          message,
        ),
      acquireClaim: (key) => remoteBroadcast.acquireClaim(key),
      commitClaim: (lease) => remoteBroadcast.commitClaim(lease),
      releaseClaim: (lease) => remoteBroadcast.releaseClaim(lease),
      tryClaim: (key) => remoteBroadcast.tryClaim(key),
      onMessage: (listener) => {
        const remote = remoteBroadcast.onMessage((event) => {
          if (event.channel !== "state:task-groups") listener(event);
        });
        const local = controllerBroadcast.onMessage((event) => {
          if (event.channel === "state:task-groups") listener(event);
        });
        return {
          dispose: () => {
            remote.dispose();
            local.dispose();
          },
        };
      },
    });
  }
  const registrationKeys = new Set(REMOTE_WORKSPACE_RPC_REGISTRATIONS.map(([key]) => key));
  const missing = [
    ...REMOTE_WORKSPACE_RPC_CHANNELS.filter((key) => !registrationKeys.has(key)),
    ...REMOTE_WORKSPACE_RPC_REGISTRATIONS.filter(
      ([, descriptor]) =>
        services.getOptional(descriptor as ServiceDescriptor<unknown>) === undefined,
    ).map(([key]) => key),
  ];
  if (missing.length > 0) {
    throw new Error(`Remote workspace RPC registration incomplete: ${missing.join(", ")}`);
  }
  registerRemoteProviderProvisioningExecutor(services, remoteProviderProvisioningExecutor);
  return services;
}
