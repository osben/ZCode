import { IDefinitionPreviewService, IGenUiService } from "@zcode/services";
import { ProxyChannel, type IChannelClient } from "@zcode/rpc";
import {
  IFileService,
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
  IProjectService,
  ITaskGroupService,
  IQuickPromptService,
  IRemoteProjectService,
  ICuaPermissionService,
  IVoiceDictationService,
  IConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IModelSelectionService,
  IProviderSettingsService,
  IProviderProvisioningTargetService,
  ISourceServerWorkspaceService,
  ISourceServerManagementService,
  IDeviceSyncStateService,
  IProviderProvisioningStatusService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  ICloudContentService,
  IMarketingTouchService,
  IOffPeakTaskService,
  IHighspeedCardService,
  ISkillsService,
  ISkillSyncService,
  IUserConfigSyncService,
  IMcpSyncService,
  IPluginUiAppToolsService,
  IPluginUiSamplingService,
  IPluginUiBridgeService,
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
  IFeedbackService,
  IPromptAttachmentTransferService,
  IWindowControllerService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  type WindowProjectDirectoryServices,
  type IServiceAccessor,
} from "@zcode/services";

/**
 * RemoteServiceAccess — automatically create type-safe service proxies through ChannelClient.
 *
 * To add a service, add a getter here.
 */
export class RemoteServiceAccess implements IServiceAccessor {
  readonly windowProjectDirectory?: WindowProjectDirectoryServices;
  readonly fileService: IFileService;
  readonly mediaPreviewService: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  readonly onboardingRecordService: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  readonly windowControllerService: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  readonly taskGroupService: ITaskGroupService;
  /** Fork: composer quick prompts, owned by the controller Host (specs/composer-quick-prompts.md). */
  readonly quickPromptService: IQuickPromptService;
  readonly projectService: IProjectService;
  readonly remoteProjectService: IRemoteProjectService;
  // cuaPermissionService is optional on IServiceAccessor (remote/bots hosts do not provide it), but the Desktop renderer
  // can always access it through RPC (the main host always registers this descriptor; on non-macOS or when disabled, methods return available:false).
  readonly cuaPermissionService: ICuaPermissionService;
  readonly voiceDictationService: IVoiceDictationService;
  readonly conversationShareService: IConversationShareService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  readonly oauthService: IOAuthService;
  readonly providerSettingsService: IProviderSettingsService;
  readonly modelSelectionService: IModelSelectionService;
  /** Host-only target proxy; it is not part of IServiceAccessor, so the Renderer does not receive the Secret write interface. */
  readonly providerProvisioningTargetService!: IProviderProvisioningTargetService;
  readonly sourceServerWorkspaceService: ISourceServerWorkspaceService;
  /** Registered only on the desktop base attachment; other scopes must consume it as an optional capability. */
  readonly sourceServerManagementService?: ISourceServerManagementService;
  /** Registered only on the desktop base attachment: device sync status for the data-sync page. */
  readonly deviceSyncStateService?: IDeviceSyncStateService;
  readonly providerProvisioningStatusService?: IProviderProvisioningStatusService;
  readonly usageStatsService: IUsageStatsService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  readonly cloudContentService: ICloudContentService;
  readonly marketingTouchService: IMarketingTouchService;
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly highspeedCardService: IHighspeedCardService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  readonly genUiService: IGenUiService;
  readonly definitionPreviewService: IDefinitionPreviewService;
  readonly pluginUiBridgeService: IPluginUiBridgeService;
  readonly pluginUiSamplingService: IPluginUiSamplingService;
  readonly pluginUiAppToolsService: IPluginUiAppToolsService;
  readonly pluginSyncService: IPluginSyncService;
  readonly userConfigSyncService: IUserConfigSyncService;
  readonly pluginsService: IPluginsService;
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly userInstructionsService: IUserInstructionsService;
  readonly outputStyleService: IOutputStyleService;
  readonly systemPromptService: ISystemPromptService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;

  constructor(
    channelClient: IChannelClient,
    options: {
      sourceServerManagementService?: boolean;
      deviceSyncStateService?: boolean;
      windowProjectDirectory?: boolean;
    } = {},
  ) {
    // A remote workspace's project must keep Source semantics; only an explicit capability creates the full window directory group.
    if (options.windowProjectDirectory) {
      this.windowProjectDirectory = {
        projectService: ProxyChannel.toService(
          channelClient.getChannel(IWindowProjectService.channelName),
        ),
        remoteProjectService: ProxyChannel.toService(
          channelClient.getChannel(IWindowRemoteProjectService.channelName),
        ),
        changesService: ProxyChannel.toService(
          channelClient.getChannel(IWindowProjectChangesService.channelName),
        ),
      };
    }
    this.fileService = ProxyChannel.toService<IFileService>(
      channelClient.getChannel(IFileService.channelName),
    );
    // If the Host registers the media-preview channel but the renderer proxy is missing, PreviewPane
    // silently falls back to the 8 MiB file.readMediaPreview limit, preventing large MP4 files from opening.
    this.mediaPreviewService = ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(IMediaPreviewService.channelName),
    );
    this.gitService = ProxyChannel.toService<IGitService>(
      channelClient.getChannel(IGitService.channelName),
    );
    this.gitCheckpointService = ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(IGitCheckpointService.channelName),
    );
    this.systemService = ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(ISystemService.channelName),
    );
    this.terminalService = ProxyChannel.toService<ITerminalService>(
      channelClient.getChannel(ITerminalService.channelName),
    );
    this.settingService = ProxyChannel.toService<ISettingService>(
      channelClient.getChannel(ISettingService.channelName),
    );
    this.onboardingRecordService = ProxyChannel.toService<IOnboardingRecordService>(
      channelClient.getChannel(IOnboardingRecordService.channelName),
    );
    this.credentialService = ProxyChannel.toService<ICredentialService>(
      channelClient.getChannel(ICredentialService.channelName),
    );
    this.broadcastService = ProxyChannel.toService<IBroadcastService>(
      channelClient.getChannel(IBroadcastService.channelName),
    );
    this.zcodeTaskService = ProxyChannel.toService<IZCodeTaskService>(
      channelClient.getChannel(IZCodeTaskService.channelName),
    );
    this.windowControllerService = ProxyChannel.toService<IWindowControllerService>(
      channelClient.getChannel(IWindowControllerService.channelName),
    );
    this.zcodeAgentService = ProxyChannel.toService<IZCodeAgentService>(
      channelClient.getChannel(IZCodeAgentService.channelName),
    );
    this.remoteProjectService = ProxyChannel.toService<IRemoteProjectService>(
      channelClient.getChannel(IRemoteProjectService.channelName),
    );
    this.taskGroupService = ProxyChannel.toService<ITaskGroupService>(
      channelClient.getChannel(ITaskGroupService.channelName),
    );
    this.quickPromptService = ProxyChannel.toService<IQuickPromptService>(
      channelClient.getChannel(IQuickPromptService.channelName),
    );
    this.projectService = ProxyChannel.toService<IProjectService>(
      channelClient.getChannel(IProjectService.channelName),
    );
    this.zcodeSessionService = ProxyChannel.toService<IZCodeSessionService>(
      channelClient.getChannel(IZCodeSessionService.channelName),
    );
    this.cuaPermissionService = ProxyChannel.toService<ICuaPermissionService>(
      channelClient.getChannel(ICuaPermissionService.channelName),
    );
    this.voiceDictationService = ProxyChannel.toService<IVoiceDictationService>(
      channelClient.getChannel(IVoiceDictationService.channelName),
    );
    this.conversationShareService = ProxyChannel.toService<IConversationShareService>(
      channelClient.getChannel(IConversationShareService.channelName),
    );
    this.botsService = ProxyChannel.toService<IBotsService>(
      channelClient.getChannel(IBotsService.channelName),
    );
    this.fileWatcherService = ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(IFileWatcherService.channelName),
    );
    this.oauthService = ProxyChannel.toService<IOAuthService>(
      channelClient.getChannel(IOAuthService.channelName),
    );
    this.providerSettingsService = ProxyChannel.toService<IProviderSettingsService>(
      channelClient.getChannel(IProviderSettingsService.channelName),
    );
    this.modelSelectionService = ProxyChannel.toService<IModelSelectionService>(
      channelClient.getChannel(IModelSelectionService.channelName),
    );
    Object.defineProperty(this, "providerProvisioningTargetService", {
      value: ProxyChannel.toService<IProviderProvisioningTargetService>(
        channelClient.getChannel(IProviderProvisioningTargetService.channelName),
      ),
      enumerable: false,
    });
    this.sourceServerWorkspaceService = ProxyChannel.toService<ISourceServerWorkspaceService>(
      channelClient.getChannel(ISourceServerWorkspaceService.channelName),
    );
    // Bug cause: ProxyChannel is lazy and can construct a "seemingly existing" object whether or
    // not the server registered the channel, so the optional contract only fails on first call.
    // Capabilities must be declared explicitly at scope creation.
    this.sourceServerManagementService = options.sourceServerManagementService
      ? ProxyChannel.toService<ISourceServerManagementService>(
          channelClient.getChannel(ISourceServerManagementService.channelName),
        )
      : undefined;
    this.deviceSyncStateService = options.deviceSyncStateService
      ? ProxyChannel.toService<IDeviceSyncStateService>(
          channelClient.getChannel(IDeviceSyncStateService.channelName),
        )
      : undefined;
    // A local Host service on the same data-sync page as device sync status: same switch (enabled only on the desktop base connection).
    this.providerProvisioningStatusService = options.deviceSyncStateService
      ? ProxyChannel.toService<IProviderProvisioningStatusService>(
          channelClient.getChannel(IProviderProvisioningStatusService.channelName),
        )
      : undefined;
    this.usageStatsService = ProxyChannel.toService<IUsageStatsService>(
      channelClient.getChannel(IUsageStatsService.channelName),
    );
    this.codingPlanSubscriptionService = ProxyChannel.toService<ICodingPlanSubscriptionService>(
      channelClient.getChannel(ICodingPlanSubscriptionService.channelName),
    );
    this.clientConfigService = ProxyChannel.toService<IClientConfigService>(
      channelClient.getChannel(IClientConfigService.channelName),
    );
    this.clientScenesService = ProxyChannel.toService<IClientScenesService>(
      channelClient.getChannel(IClientScenesService.channelName),
    );
    this.cloudContentService = ProxyChannel.toService<ICloudContentService>(
      channelClient.getChannel(ICloudContentService.channelName),
    );
    this.marketingTouchService = ProxyChannel.toService<IMarketingTouchService>(
      channelClient.getChannel(IMarketingTouchService.channelName),
    );
    this.offPeakTaskService = ProxyChannel.toService<IOffPeakTaskService>(
      channelClient.getChannel(IOffPeakTaskService.channelName),
    );
    this.highspeedCardService = ProxyChannel.toService<IHighspeedCardService>(
      channelClient.getChannel(IHighspeedCardService.channelName),
    );
    this.skillsService = ProxyChannel.toService<ISkillsService>(
      channelClient.getChannel(ISkillsService.channelName),
    );
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
    this.mcpSyncService = ProxyChannel.toService<IMcpSyncService>(
      channelClient.getChannel(IMcpSyncService.channelName),
    );
    this.genUiService = ProxyChannel.toService<IGenUiService>(
      channelClient.getChannel(IGenUiService.channelName),
    );
    this.definitionPreviewService = ProxyChannel.toService<IDefinitionPreviewService>(
      channelClient.getChannel(IDefinitionPreviewService.channelName),
    );
    this.pluginUiBridgeService = ProxyChannel.toService<IPluginUiBridgeService>(
      channelClient.getChannel(IPluginUiBridgeService.channelName),
    );
    this.pluginUiSamplingService = ProxyChannel.toService<IPluginUiSamplingService>(
      channelClient.getChannel(IPluginUiSamplingService.channelName),
    );
    this.pluginUiAppToolsService = ProxyChannel.toService<IPluginUiAppToolsService>(
      channelClient.getChannel(IPluginUiAppToolsService.channelName),
    );
    this.pluginSyncService = ProxyChannel.toService<IPluginSyncService>(
      channelClient.getChannel(IPluginSyncService.channelName),
    );
    this.userConfigSyncService = ProxyChannel.toService<IUserConfigSyncService>(
      channelClient.getChannel(IUserConfigSyncService.channelName),
    );
    this.pluginsService = ProxyChannel.toService<IPluginsService>(
      channelClient.getChannel(IPluginsService.channelName),
    );
    this.pluginManagementService = ProxyChannel.toService<IPluginManagementService>(
      channelClient.getChannel(IPluginManagementService.channelName),
    );
    this.subagentsService = ProxyChannel.toService<ISubagentsService>(
      channelClient.getChannel(ISubagentsService.channelName),
    );
    this.commandsService = ProxyChannel.toService<ICommandsService>(
      channelClient.getChannel(ICommandsService.channelName),
    );
    this.hooksService = ProxyChannel.toService<IHooksService>(
      channelClient.getChannel(IHooksService.channelName),
    );
    this.memoryService = ProxyChannel.toService<IMemoryService>(
      channelClient.getChannel(IMemoryService.channelName),
    );
    this.userInstructionsService = ProxyChannel.toService<IUserInstructionsService>(
      channelClient.getChannel(IUserInstructionsService.channelName),
    );
    this.outputStyleService = ProxyChannel.toService<IOutputStyleService>(
      channelClient.getChannel(IOutputStyleService.channelName),
    );
    this.systemPromptService = ProxyChannel.toService<ISystemPromptService>(
      channelClient.getChannel(ISystemPromptService.channelName),
    );
    this.settingsSyncService = ProxyChannel.toService<ISettingsSyncService>(
      channelClient.getChannel(ISettingsSyncService.channelName),
    );
    this.feedbackService = ProxyChannel.toService<IFeedbackService>(
      channelClient.getChannel(IFeedbackService.channelName),
    );
    this.promptAttachmentTransferService = ProxyChannel.toService<IPromptAttachmentTransferService>(
      channelClient.getChannel(IPromptAttachmentTransferService.channelName),
    );
  }
}
