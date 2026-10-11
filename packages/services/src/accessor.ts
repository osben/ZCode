import type { IGenUiService } from "./gen-ui/contract.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";
import type { IHighspeedCardService } from "./highspeed/highspeedCard.js";
import type { IPluginUiBridgeService } from "./plugin-ui-bridge/contract.js";
import type { IPluginUiSamplingService } from "./plugin-ui-bridge/samplingContract.js";
import type { IPluginUiAppToolsService } from "./plugin-ui-bridge/appToolsContract.js";
import type { IFileService } from "./file/file.js";
import type { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import type { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
import type { IGitService } from "./git/git.js";
import type { IGitCheckpointService } from "./git/gitCheckpoint.js";
import type { ISystemService } from "./system/system.js";
import type { ITerminalService } from "./terminal/terminal.js";
import type { ISettingService } from "./setting/setting.js";
import type { ICredentialService } from "./credential/credential.js";
import type { IBroadcastService } from "./broadcast/broadcast.js";
import type { IZCodeTaskService } from "./session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import type { ICuaPermissionService } from "./cua-permission-broker/cuaPermissionService.js";
import type { IBotsService } from "./bots/bots.js";
import type { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import type { IOAuthService } from "./oauth/oauth.js";
import type {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import type { IUsageStatsService } from "./usage-stats/usageStats.js";
import type { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import type { IClientConfigService } from "./client-config/clientConfig.js";
import type { IClientScenesService } from "./client-scenes/clientScenes.js";
import type { ISkillsService } from "./skills/skills.js";
import type { ISkillSyncService } from "./skill-sync/skillSync.js";
import type { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import type { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import type { IPluginsService } from "./plugins/plugins.js";
import type { IPluginManagementService } from "./plugins/pluginManagement.js";
import type { ISubagentsService } from "./subagents/subagents.js";
import type { ICommandsService } from "./commands/commands.js";
import type { IHooksService } from "./hooks/hooks.js";
import type { IMemoryService } from "./memory/memory.js";
import type { IUserInstructionsService } from "./user-instructions/userInstructions.js";
import type { IOutputStyleService } from "./output-style/outputStyle.js";
import type { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import type { IFeedbackService } from "./feedback/feedback.js";
import type { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import type { IWindowControllerService } from "./window-controller/windowController.js";
import type { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import type { IConversationShareService } from "./conversation-share/conversationShare.js";
import type { IVoiceDictationService } from "./voice-dictation/voiceDictation.js";

/** Unified service interface consumed by the UI layer */
export interface IServiceAccessor {
  readonly fileService: IFileService;
  readonly mediaPreviewService?: IMediaPreviewService;
  readonly cloudContentService?: ICloudContentService;
  readonly marketingTouchService?: IMarketingTouchService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly terminalService: ITerminalService;
  readonly settingService: ISettingService;
  /** Onboarding completion record (persisted locally); older test doubles or unsupported hosts may omit it. */
  readonly onboardingRecordService?: IOnboardingRecordService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  /** Window Host aggregation surface; older server wires or test doubles may omit it for now. */
  readonly windowControllerService?: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  // CUA is an opt-in beta feature provided by local macOS hosts but not other hosts. Keep it optional to avoid making it transitively required.
  readonly cuaPermissionService?: ICuaPermissionService;
  /** 本机语音输入（模型下载与离线转写）；远端 host 不提供。 */
  readonly voiceDictationService?: IVoiceDictationService;
  readonly conversationShareService: IConversationShareService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  readonly oauthService: IOAuthService;
  /** Provider configuration and settings view for the current Environment. */
  readonly providerSettingsService: IProviderSettingsService;
  /** The sole model-selection View published by the current Environment Registry. */
  readonly modelSelectionService: IModelSelectionService;
  readonly usageStatsService: IUsageStatsService;
  readonly codingPlanSubscriptionService: ICodingPlanSubscriptionService;
  readonly clientConfigService: IClientConfigService;
  readonly clientScenesService: IClientScenesService;
  /** Off-peak task management (a separate service surface). */
  readonly offPeakTaskService: IOffPeakTaskService;
  readonly highspeedCardService: IHighspeedCardService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly mcpSyncService: IMcpSyncService;
  /** Plugin UI bridge; web or older hosts may omit it, and the UI falls back to plain MCP cards. */
  readonly genUiService?: IGenUiService;
  readonly pluginUiBridgeService?: IPluginUiBridgeService;
  /** Page sampling; available only for desktop local tasks. */
  readonly pluginUiSamplingService?: IPluginUiSamplingService;
  /** App-Provided Tools; present only for the desktop local agent. */
  readonly pluginUiAppToolsService?: IPluginUiAppToolsService;
  readonly pluginSyncService: IPluginSyncService;
  readonly pluginsService: IPluginsService;
  /** Settings-page plugin management (the UI no longer calls the plugins/* surface of zcodeAgentService directly) */
  readonly pluginManagementService: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly userInstructionsService: IUserInstructionsService;
  readonly outputStyleService: IOutputStyleService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly feedbackService: IFeedbackService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;
}
