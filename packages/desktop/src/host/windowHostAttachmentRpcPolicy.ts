import { ProxyChannel, type IDisposable, type IChannelServer } from "@zcode/rpc";
import {
  ServiceCollection,
  type ITerminalService,
  IProjectService,
  IRemoteProjectService,
  IBroadcastService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  IMcpSyncService,
  IFeedbackService,
  IGenUiService,
  createWindowProjectChangesService,
  IQuickPromptService,
  createReadOnlyQuickPromptService,
  type ServiceExposurePolicy,
  type ZCodeAgentV4ClientMode,
  DEFINITION_PREVIEW_CHANNEL,
} from "@zcode/services";
import { ServiceChannels } from "@zcode/shared";

const WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS = new Set<string>([
  ServiceChannels.File,
  ServiceChannels.MediaPreview,
  ServiceChannels.System,
  // Mobile terminal calls used to be blocked by the allowlist before reaching the service and timed out; paired attachments reuse the original terminal service.
  ServiceChannels.Terminal,
  ServiceChannels.Git,
  ServiceChannels.GitCheckpoint,
  ServiceChannels.Setting,
  // Onboarding records share the attachment owner with settings; if omitted, mobile calls time out and the fallback to settings checks wrongly shows onboarding.
  ServiceChannels.OnboardingRecord,
  ServiceChannels.Credential,
  ServiceChannels.CuaPermission,
  ServiceChannels.CuaPipSession,
  ServiceChannels.Broadcast,
  ServiceChannels.ZCodeTask,
  ServiceChannels.WindowController,
  ServiceChannels.ZCodeAgent,
  ServiceChannels.ZCodeSession,
  ServiceChannels.Project,
  ServiceChannels.TaskGroups,
  // Mobile gets the controller's quick prompts read-only (createReadOnlyQuickPromptService below).
  ServiceChannels.QuickPrompts,
  ServiceChannels.RemoteProjects,
  ServiceChannels.WindowProject,
  ServiceChannels.WindowRemoteProjects,
  ServiceChannels.WindowProjectChanges,
  // ConversationShare is wrapped per clientMode by scopeConversationShareServiceForAttachment: mobile keeps
  // only the read-only pass-through of getCapabilities/getPreview; publish/import/continuation always return feature_disabled.
  ServiceChannels.ConversationShare,
  ServiceChannels.FileWatcher,
  ServiceChannels.OAuth,
  ServiceChannels.ProviderSettings,
  ServiceChannels.ModelSelection,
  // ProviderProvisioningTarget carries cross-Environment credential writes and may only be called by the trusted Desktop Host; never add it to the mobile allowlist.
  ServiceChannels.SourceServerWorkspace,
  ServiceChannels.UsageStats,
  ServiceChannels.CodingPlanSubscription,
  ServiceChannels.ClientScenes,
  ServiceChannels.Skills,
  // The mobile side has no sync UI, and hiding it in the UI layer alone does not prevent writes: import methods stay callable at the RPC layer.
  // Therefore SkillSync, PluginSync, and any sync channel added later must never enter the mobile allowlist.
  // McpSync is the exception: the channel mixes in config methods used by the mobile MCP settings page, which are allowed per method; see scopeMcpSyncServiceForMobile.
  ServiceChannels.McpSync,
  ServiceChannels.Plugins,
  ServiceChannels.PluginManagement,
  ServiceChannels.Subagents,
  // Read-only and confined to Host-discovered definition roots.
  DEFINITION_PREVIEW_CHANNEL,
  ServiceChannels.Commands,
  ServiceChannels.Hooks,
  ServiceChannels.Memory,
  ServiceChannels.OutputStyle,
  ServiceChannels.SettingsSync,
  ServiceChannels.Bots,
  ServiceChannels.Feedback,
  ServiceChannels.PromptAttachmentTransfer,
  ServiceChannels.OffPeakTask,
]);

const WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY: ServiceExposurePolicy = {
  allowedChannels: WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS,
};

export function resolveWindowHostServiceExposurePolicy(
  clientMode: ZCodeAgentV4ClientMode,
): ServiceExposurePolicy | undefined {
  // Host only exposes explicitly allowed channels to mobile, so newly registered high-privilege services are not opened automatically.
  // Mobile must use an explicit allowlist so unreviewed channels fail closed; desktop keeps the full service surface.
  return clientMode === "web-remote-replayable" ? WEB_REMOTE_REPLAYABLE_EXPOSURE_POLICY : undefined;
}

// Config methods used by the mobile MCP settings page (status list, remote workspace MCP directory read/write); all other methods are sync methods.
const MOBILE_MCP_SYNC_ALLOWED_METHODS = new Set<string>([
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "listWorkspaceMcpServerStatuses",
  // Trust is a settings command for the same target Host; do not open the desktop-only bulk sync methods.
  "setWorkspaceMcpTrust",
] satisfies ReadonlyArray<keyof IMcpSyncService>);

function scopeMcpSyncServiceForMobile(service: IMcpSyncService): IMcpSyncService {
  const rejectMobileSync = async (): Promise<never> => {
    throw Object.assign(new Error("Remote sync is only available from Desktop"), {
      kind: "feature_disabled" as const,
    });
  };
  // Use an allowlist instead of listing sync methods one by one: methods added to McpSync later are rejected on mobile by default.
  return new Proxy({} as IMcpSyncService, {
    get: (_target, key) => {
      // Non-string keys, thenable probes, and on* event keys are not disguised as methods, to avoid being treated as a Promise or an event subscription.
      if (typeof key !== "string" || key === "then" || /^on[A-Z]/.test(key)) return undefined;
      if (!MOBILE_MCP_SYNC_ALLOWED_METHODS.has(key)) return rejectMobileSync;
      const method = service[key as keyof IMcpSyncService] as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => method.apply(service, args);
    },
  });
}

function resolveAttachmentOverrides(
  services: ServiceCollection,
  clientMode: ZCodeAgentV4ClientMode,
  overrides: ReadonlyMap<string, unknown> | undefined,
): ReadonlyMap<string, unknown> | undefined {
  if (clientMode !== "web-remote-replayable") return overrides;
  const mcpSync =
    (overrides?.get(IMcpSyncService.channelName) as IMcpSyncService | undefined) ??
    services.getOptional(IMcpSyncService);
  if (!mcpSync) return overrides;
  return new Map(overrides).set(IMcpSyncService.channelName, scopeMcpSyncServiceForMobile(mcpSync));
}

export function exposeWindowHostAttachmentServices(params: {
  server: IChannelServer;
  services: ServiceCollection;
  clientMode: ZCodeAgentV4ClientMode;
  overrides?: ReadonlyMap<string, unknown>;
  attachmentScope?: { kind: "local" | "remote" | "source-settings" };
  windowServices?: ServiceCollection;
  /** The mobile window directory layers live interaction onto the project channel as well, so the remote-scope list does not miss the pending items. */
  decorateWindowProjectService?: (service: IProjectService) => IProjectService;
}): void {
  if (params.clientMode === "web-remote-replayable" && params.attachmentScope?.kind === "remote") {
    if (!params.windowServices) throw new Error("window-project-directory.unavailable");
    // The project service belongs to Source; replacing it would break calls such as mentions inside the workspace, so the window directory uses its own full channel group.
    // Acquire all required services first; if any is missing, do not publish partial channels or modify the shared remote ServiceCollection.
    const directory = new ServiceCollection()
      .register(
        IWindowProjectService,
        (params.decorateWindowProjectService ?? ((service: IProjectService) => service))(
          params.windowServices.get(IProjectService),
        ),
      )
      .register(IWindowRemoteProjectService, params.windowServices.get(IRemoteProjectService))
      .register(
        IWindowProjectChangesService,
        createWindowProjectChangesService(params.windowServices.get(IBroadcastService)),
      );
    directory.exposeOnChannelServer(
      params.server,
      undefined,
      resolveWindowHostServiceExposurePolicy(params.clientMode),
    );
  }
  // Wrap whatever source is exposed (the override when present, else the registered service), so a mobile
  // attachment is read-only regardless of its scope. Desktop attachments keep the full service.
  const overrides = new Map(params.overrides ?? []);
  if (params.clientMode === "web-remote-replayable") {
    const source =
      (overrides.get(IQuickPromptService.channelName) as IQuickPromptService | undefined) ??
      params.services.getOptional(IQuickPromptService);
    if (source) {
      overrides.set(IQuickPromptService.channelName, createReadOnlyQuickPromptService(source));
    }
  }
  params.services.exposeOnChannelServer(
    params.server,
    resolveAttachmentOverrides(params.services, params.clientMode, overrides),
    resolveWindowHostServiceExposurePolicy(params.clientMode),
  );
  if (params.clientMode === "web-remote-replayable") {
    const controllerServices =
      params.attachmentScope?.kind === "remote" ? params.windowServices! : params.services;
    if (params.attachmentScope?.kind === "remote") {
      // The Source collection does not own the feedback service; after mobile switches to remote, it must still reuse the controller's account, device, and diagnostic logs.
      params.server.registerChannel(
        IFeedbackService.channelName,
        ProxyChannel.fromService(controllerServices.get(IFeedbackService)),
      );
    }
    const genUi = controllerServices.getOptional(IGenUiService);
    if (genUi) {
      // listState before sending used to hit a fixed timeout because the whole channel was rejected. Publish only the controller's read-only context
      // interface; do not expose sandbox, file reads, or state writes to mobile together with the full Gen UI service.
      params.server.registerChannel(
        IGenUiService.channelName,
        ProxyChannel.fromService({ listState: genUi.listState.bind(genUi) }),
      );
    }
  }
}

/** The mobile terminal belongs to the page owner, not to the RPC attachment that is replaced on navigation. */
export function createWindowHostTerminalOwners(onCleanupError: (error: unknown) => void) {
  let current:
    | { id: string; scopes: Map<string, ReturnType<typeof createTerminalScope>> }
    | undefined;
  return {
    setOwner(id: string | null): void {
      if (current?.id === id) return;
      const previous = current;
      current = id === null ? undefined : { id, scopes: new Map() };
      // Revoke the old owner first, then reclaim asynchronously; neither the old attachment nor a late create may revive it.
      for (const scope of previous?.scopes.values() ?? []) scope.dispose();
    },
    bind(ownerId: string, scopeKey: string, base: ITerminalService): ITerminalService {
      if (current?.id !== ownerId) throw new Error("Terminal owner has ended");
      let scope = current.scopes.get(scopeKey);
      if (!scope) {
        scope = createTerminalScope(base, onCleanupError);
        current.scopes.set(scopeKey, scope);
      }
      return scope.service;
    },
  };
}

/** When an old client has no page owner, reclaim per attachment to avoid continuing to create unowned PTYs. */
export function createTerminalScope(
  base: ITerminalService,
  onCleanupError: (error: unknown) => void,
) {
  let active = true;
  const terminals = new Map<string, IDisposable>();
  function assertActive(id?: string): void {
    if (!active || (id !== undefined && !terminals.has(id))) {
      throw new Error("Terminal owner has ended or does not own this terminal");
    }
  }
  const release = async (id: string) => {
    await base.dispose({ id });
    terminals.get(id)?.dispose();
    terminals.delete(id);
  };
  const service: ITerminalService = {
    async create(params) {
      assertActive();
      const result = await base.create(params);
      // create awaits across RPC/loading; if the owner has ended, the real PTY that was returned must be reclaimed, not just the response dropped.
      if (!active) {
        await base.dispose({ id: result.id });
        throw new Error("Terminal owner has ended");
      }
      const subscription = base.onDynamicExit(result.id)(() => {
        terminals.get(result.id)?.dispose();
        terminals.delete(result.id);
      });
      terminals.set(result.id, subscription);
      return result;
    },
    async write(params) {
      assertActive(params.id);
      await base.write(params);
    },
    async resize(params) {
      assertActive(params.id);
      await base.resize(params);
    },
    async dispose({ id }) {
      if (!active || !terminals.has(id)) return;
      await release(id);
    },
    onDynamicData(id) {
      assertActive(id);
      return base.onDynamicData(id);
    },
    onDynamicExit(id) {
      assertActive(id);
      return base.onDynamicExit(id);
    },
  };
  return {
    service,
    dispose(): void {
      if (!active) return;
      active = false;
      for (const [id, subscription] of terminals) {
        subscription.dispose();
        void release(id).catch(onCleanupError);
      }
    },
  };
}
