import { IGenUiService } from "./gen-ui/contract.js";
import { createGenUiService } from "./gen-ui/node.js";
import { channelReplyHostRequestSchema, channelReplyResultSchema } from "@zcode/shared";
/* eslint-disable max-lines -- Host-process service registration and startup wiring must stay together so dependency injection order remains easy to trace. */
// Node.js service implementations — NOT safe to import in browser code
import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createNodeProviderRuntimePathEnv,
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { getAppConfigDir as resolveAppConfigDir } from "./paths.js";
import { createVoiceDictationService, IVoiceDictationService } from "./voice-dictation/index.js";
import {
  buildLocalMediaPreviewUrl,
  parseChatGptPlanAccountProviderId,
  type DynamicWorkflowMode,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";

// Stable only for this process: revisions are cache keys, and a per-process random HMAC key
// keeps account identifiers and display names out of logged configRevision values. It keys
// ONLY the process-local top-level derived `revision`; `zcodeBuiltinRevision`, the cross-process
// contract carried by account snapshots (`basedOnZCodeBuiltinRevision`), stays raw on every
// side and never embeds this fingerprint.
const chatGptPlanRevisionKey = randomBytes(32);

export * from "./voice-dictation/index.js";
export {
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { randomUUID } from "node:crypto";
import {
  getAppConfigDir as getContentAppConfigDir,
  getZCodeDataRootDir as projectDataRoot,
} from "#src/paths.js";
import { ICloudContentService } from "#src/cloud-content/cloudContent.js";
import { createCloudContentService } from "#src/cloud-content/cloudContentService.js";
import { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
import { createMarketingTouchService } from "#src/marketing-touch/marketingTouchService.js";
import { createMarketingAssetRegistry } from "#src/marketing-touch/marketingAssetRegistry.js";
import type { IChannel } from "@zcode/rpc";
import {
  readTopicResourceFromRelay,
  validateTopicResourceFromRelay,
} from "./zcode-agent/topicResourceRelayClient.js";
export {
  createTopicResourcePeers,
  type TopicResourcePeers,
} from "./zcode-agent/topicResourcePeers.js";
export { createTopicResourceRelayChannel } from "./zcode-agent/topicResourceRelayChannel.js";

export { createFileService } from "./file/fileService.js";
export {
  bindRemoteProjectIdentities,
  createLegacySingleRootProjectService,
} from "#src/project/index.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
} from "./process/processResourceSampler.js";
export { createMediaPreviewService } from "./media-preview/mediaPreview.js";
export { createContentBundleCache } from "#src/cloud-content/contentBundleCache.js";
export type { ContentBundle } from "#src/cloud-content/contentBundleCache.js";
export type { CreateFileServiceOptions } from "./file/fileService.js";
export {
  defaultWorkspaceFileSearchFilter,
  type WorkspaceFileSearchDecision,
  type WorkspaceFileSearchEntry,
  type WorkspaceFileSearchFilter,
} from "./file/workspaceFileMentionFilter.js";
export {
  createFsFaultInjector,
  getProcessFsFaultInjector,
  maybeThrowInjectedFsFault,
  parseFsFaultRulesFromEnvValue,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
  ZCODE_E2E_FS_FAULTS_ALLOW_ENV,
  ZCODE_E2E_FS_FAULTS_ENV,
} from "./fs/fsFaultInjection.js";
export type {
  FsFaultCheckInput,
  FsFaultHit,
  FsFaultInjector,
  FsFaultOperation,
  FsFaultRuleConfig,
  InjectedFsFaultError,
} from "./fs/fsFaultInjection.js";
export {
  setDataBaseDir,
  getDataBaseDir,
  getZCodeDataRootDir,
  getConversationWorkspaceDir,
  getAppConfigDir,
  getExportLogStageDir,
  getExportLogDir,
  getFeedbackRootDir,
  getFeedbackAttachmentDir,
  getFeedbackLogArchiveDir,
  getGitCheckpointIndexRootDir,
  copyDataDirectory,
  validateDataBaseDirTarget,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "./paths.js";
export { createGitService } from "./git/gitService.js";
export { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
export { createGitCheckpointService } from "./git/gitCheckpointService.js";
export { createSystemService } from "./system/systemService.js";
export { listSSHConfigAliasesFromLocalConfig } from "./system/sshConfigAlias.js";
export { createTerminalService } from "./terminal/terminalService.js";
export {
  createSettingService,
  createSettingServiceWithMigrations,
} from "./setting/settingService.js";
export { createCredentialService } from "./credential/credentialService.js";
export { createBroadcastService } from "./broadcast/broadcastService.js";
export { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
export { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
export { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
export {
  resolveDefaultZCodeAgentCommand,
  ZCodeAgentProcessManager,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export type {
  ZCodeAgentCommand,
  ZCodeAgentCommandResolver,
  ZCodeAgentCommandResolverContext,
  ZCodeAgentProcessManagerOptions,
} from "./zcode-agent/zcodeAgentProcessManager.js";
export { ZCodeProtocolClient } from "./zcode-agent/zcodeProtocolClient.js";
export type { ZCodeProtocolTransport } from "./zcode-agent/zcodeProtocolTransport.js";
export { ZCodeStdioTransport } from "./zcode-agent/zcodeStdioTransport.js";
export {
  getZCodeStdioTapDevLogDir,
  readZCodeStdioTapDevState,
  setZCodeStdioTapDevEnabled,
} from "./zcode-agent/zcodeStdioTapDevConfig.js";
export type { ZCodeStdioTapDevState } from "@zcode/shared";
export {
  createCuaHelperInstaller,
  requestHelperAccessibilityPermissionViaLaunchServices,
  requestHelperScreenRecordingPermissionViaLaunchServices,
} from "./cua-permission-broker/index.js";
export {
  canonicalizeCuaHelperInstallerOptions,
  createCanonicalCuaHelperInstaller,
  normalizeCuaHelperArch,
  normalizeCuaHelperArchs,
} from "./cua-permission-broker/cuaHelperInstaller.js";
export type {
  CuaHelperInstaller,
  CuaHelperInstallerOptions,
} from "./cua-permission-broker/index.js";
export { createBotsService } from "./bots/botsService.js";
export { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
export { createOAuthService } from "./oauth/oauthService.js";
export { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
export { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
export { createTelemetryCore, ensureTelemetryDeviceMid } from "./telemetry/telemetryCore.js";
export type { EnsureTelemetryDeviceMidOptions } from "./telemetry/telemetryCore.js";
export type { AccountRequestAuthResolver } from "./model-provider/accountProviderRequestAuthService.js";
export { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
export type {
  AccountProviderCredentialStore,
  AccountProviderCredentialStoreOptions,
} from "./model-provider/accountProviderCredentialStore.js";
export { importLegacyPersonalProviderConfig } from "./model-provider/legacyPersonalProviderConfigImporter.js";
export {
  createAccountProviderConfigSource,
  createAccountProviderConnectionResolver,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
export { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
export type {
  AccountProviderConfigSourceOptions,
  AccountProviderConnectionResolverOptions,
  AccountProviderConnectionSettings,
  AccountProviderFamilyAvailabilityInput,
  AccountProviderFamilyAvailabilityResolver,
  CodingPlanFamilyAvailabilityResolverOptions,
} from "./model-provider/accountProviderConnectionResolver.js";
export {
  createProviderConfigRuntime,
  ProviderConfigRuntime,
} from "./model-provider/providerConfigRuntime.js";
export type { ProviderConfigRuntimeOptions } from "./model-provider/providerConfigRuntime.js";
export {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
  EmptyAccountProviderConfigSource,
  ProviderRuntime,
} from "./model-provider/providerRuntime.js";
export type {
  ProviderRuntimeDependencies,
  ProviderRuntimeOptions,
} from "./model-provider/providerRuntime.js";
export {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
  type ProviderProvisioningSourceOptions,
} from "./model-provider/providerProvisioningSource.js";
export {
  createProviderProvisioningTarget,
  type ProviderProvisioningTargetOptions,
} from "./model-provider/providerProvisioningTarget.js";
export {
  createModelSelectionService,
  createProviderSettingsService,
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
export { createAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export type { IAccountRequestAuthService } from "./model-provider/accountRequestAuthService.js";
export { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
export {
  resolveAccountTeamPlanRuntimeApiKey,
  resolveAccountTeamPlanRuntimeMaterial,
} from "./model-provider/accountProviderTeamPlanRequestKey.js";
export { createAccountProjectTokenClient } from "./model-provider/accountProjectTokenClient.js";
export { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
export { createUsageStatsService } from "./usage-stats/usageStatsService.js";
// Storage service and adapter factories; the desktop host assembles them (the Worker runner lives in the desktop package).
export { createStorageService } from "./storage/app/storageService.js";
export type {
  FsCleanerPort as StorageFsCleanerPort,
  RootsResolverPort as StorageRootsResolverPort,
  ScanRunnerPort as StorageScanRunnerPort,
  StorageScanProgress,
  StorageScanRunRequest,
} from "./storage/app/ports.js";
export { createFsStorageCleaner } from "./storage/adapters/fsCleaner.js";
export {
  createStorageRootsResolver,
  resolveStorageRoots,
} from "./storage/adapters/rootsResolver.js";
export { createFsVolumeProbe } from "./storage/adapters/volumeProbe.js";
export { runStorageScan } from "./storage/adapters/inProcessScanRunner.js";
export { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
export { createClientConfigService } from "./client-config/clientConfigService.js";
export { createClientScenesService } from "./client-scenes/clientScenesService.js";
export { createSkillsService } from "./skills/skillsService.js";
export { createSkillSyncService } from "./skill-sync/skillSyncService.js";
export { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
export { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
export { createPluginsService } from "./plugins/pluginsService.js";
export { createPluginManagementService } from "./plugins/pluginManagementService.js";
export { createSubagentsService } from "./subagents/subagentsService.js";
export { createCommandsService } from "./commands/commandsService.js";
export { createHooksService } from "./hooks/hooksService.js";
export { createMemoryService } from "./memory/memoryService.js";
export { createUserInstructionsService } from "./user-instructions/userInstructionsService.js";
export { createOutputStyleService } from "./output-style/outputStyleService.js";
export { createSystemPromptService } from "./system-prompt/systemPromptService.js";
export { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
export { createFeedbackDiagnosticArchive } from "./feedback/feedbackLogArchive.js";
export { createFeedbackService } from "./feedback/feedbackService.js";
export type { CreateFeedbackServiceOptions } from "./feedback/feedbackService.js";
export { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
export {
  createLocalConversationShareArtifactSource,
  createRemoteConversationShareArtifactSource,
} from "./conversation-share/conversationShareArtifactSource.js";
export { createNodeApiClient, NodeApiClient } from "./providers/api/nodeApiClient.js";
export {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
export {
  buildRuntimeProcessEnvPatch,
  captureLoginShellEnvSnapshot,
  normalizeRuntimeProcessEnv,
  prepareRuntimeProcessEnvPatch,
} from "./runtime-tools/runtimeCommandEnv.js";

// Automation management and the scheduler share the same Node-only storage and cron semantics.
export {
  AutomationRepo,
  DISPATCH_RETRY_BASE_MS,
  DISPATCH_RETRY_CAP_MS,
  DISPATCH_MAX_ATTEMPTS,
  CLAIM_STALE_MS,
  computeRetryAt,
} from "./session/automationRepo.js";
export { AutomationService, InvalidCronExprError } from "./session/automationService.js";
// Off-peak tasks share the database with automations but use separate tables, types, and constants.
export { OffPeakTaskRepo, OFF_PEAK_CLAIM_STALE_MS } from "./session/offPeakTaskRepo.js";
// Fork-owned sidebar project pins live in the fork_workspace_pins table of tasks-index.sqlite.
export { ForkWorkspacePinRepo } from "./session/forkWorkspacePinRepo.js";
// The host domain reuses the existing task diff summary to populate files_changed at terminal state.
export { buildTaskChangeSummary } from "./session/taskChangeSummary.js";
export { OffPeakTaskService } from "./session/offPeakTaskService.js";
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export { IHighspeedCardService } from "./highspeed/highspeedCard.js";
export { createOffPeakServerClient, OffPeakServerError } from "./session/offPeakServerClient.js";
export { isOffPeakMockEnabled, startOffPeakMockGateway } from "./session/offPeakMockGateway.js";
export {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
  OffPeakCodingPlanUnavailableError,
  OffPeakCredentialsUnavailableError,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
} from "./session/offPeakRuntimeModel.js";
export { createServiceLogger } from "./logger/serviceLogger.js";
export {
  buildOfficialMcpAuthHeaders,
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
export {
  computeAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  isOneShotAutomation,
  isValidCronExpr,
} from "./session/automationCron.js";

import { ServiceCollection } from "./collection.js";
import { IFileService } from "./file/file.js";
import { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import { IGitService } from "./git/git.js";
import { IGitCheckpointService } from "./git/gitCheckpoint.js";
import { ISystemService } from "./system/system.js";
import { ITerminalService } from "./terminal/terminal.js";
import { ISettingService } from "./setting/setting.js";
import { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
import { ICredentialService } from "./credential/credential.js";
import { IBroadcastService } from "./broadcast/broadcast.js";
import { IZCodeTaskService } from "./session/zcodeTaskService.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { CuaOperationStateReporter } from "./zcode-agent/cuaOperationTurnTracker.js";
import { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import {
  createUnsupportedConversationShareService,
  IConversationShareService,
  type IConversationShareService as IConversationShareServiceType,
} from "./conversation-share/conversationShare.js";
import {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
} from "./conversation-share/conversationShareService.js";
import { createLocalConversationShareArtifactSource } from "./conversation-share/conversationShareArtifactSource.js";
import { ConversationShareHttpClient } from "./conversation-share/conversationShareHttpClient.js";
import { IBotsService } from "./bots/bots.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import { IOAuthService } from "./oauth/oauth.js";
import { IUsageStatsService } from "./usage-stats/usageStats.js";
import { ICodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscription.js";
import { IClientScenesService } from "./client-scenes/clientScenes.js";
import { ISkillsService } from "./skills/skills.js";
import { ISkillSyncService } from "./skill-sync/skillSync.js";
import { IMcpSyncService } from "./mcp-sync/mcpSync.js";
import { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import { IPluginsService } from "./plugins/plugins.js";
import { IPluginManagementService } from "./plugins/pluginManagement.js";
import { ISubagentsService } from "./subagents/subagents.js";
import { ICommandsService } from "./commands/commands.js";
import { IHooksService } from "./hooks/hooks.js";
import { IMemoryService } from "./memory/memory.js";
import { IUserInstructionsService } from "./user-instructions/userInstructions.js";
import { IOutputStyleService } from "./output-style/outputStyle.js";
import { ISystemPromptService } from "./system-prompt/systemPrompt.js";
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IFeedbackService } from "./feedback/feedback.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { IProjectService } from "./project/contract.js";
import { IRemoteProjectService } from "./remote-projects/contract.js";
import { createProjectService } from "./project/index.js";
import { createTaskGroupService, groupTaskKey } from "#src/task-groups/index.js";
import { ITaskGroupService } from "./task-groups/contract.js";
import type { BotProjectConnection } from "./bot-project-runtime/contract.js";
import { createRemoteProjectService } from "#src/remote-projects/index.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import { createSettingServiceWithMigrations } from "./setting/settingService.js";
import { createSourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspaceService.js";
import { ISourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspace.js";
import { SourceServerWorkspaceAliasRepo } from "./session/sourceServerWorkspaceAliasRepo.js";
import { SourceServerWorkspaceIdentityMapper } from "./source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import { createOnboardingRecordService } from "./onboarding/onboardingRecordService.js";
import { createLegacyTeamOrganizationResolver } from "./model-provider/legacyTeamOrganizationResolver.js";
import { createObservableSettingService } from "./setting/observableSettingService.js";
import { createCredentialService } from "./credential/credentialService.js";
import { createBroadcastService } from "./broadcast/broadcastService.js";
import { createZCodeAgentService } from "./zcode-agent/zcodeAgentService.js";
import type { ZCodeAgentCommandResolver } from "./zcode-agent/zcodeAgentProcessManager.js";
import { buildAgentTelemetrySpawnEnv } from "./zcode-agent/agentTelemetryEnv.js";
import { resolveZCodeAgentPresentationSurface } from "./zcode-agent/zcodeAgentPresentationSurface.js";
import { createZCodeTaskServiceAdapter } from "./zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "./zcode-session/zcodeSessionService.js";
import { createZCodeTaskIndexSyncer } from "./zcode-agent/zcodeTaskIndexSyncer.js";
import { TaskIndexRepo } from "./session/taskIndexRepo.js";
import { createBotsService } from "./bots/botsService.js";
import { createBotRemoteWorkspaceService } from "./bots/botRemoteWorkspaceBridge.js";
import type { SessionMessageSendRequested } from "#src/session/sessionMailbox.js";
import { createFileWatcherService } from "./fileWatcher/fileWatcherService.js";
import { createOAuthService } from "./oauth/oauthService.js";
import {
  isOAuthBusinessRequest,
  isCurrentOAuthCredentialRequest,
} from "#src/oauth/oauthUnauthorizedRequest.js";
import { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
import { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
import { readLegacyZCodeConfigProviders } from "./model-provider/legacyZCodeConfigProviderReader.js";
import { resolveAccountTeamPlanRuntimeMaterial } from "./model-provider/accountProviderTeamPlanRequestKey.js";
import { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
import { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
import { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
import { SiwcAuthService } from "./oauth/siwc/siwcAuthService.js";
import {
  createAccountProviderConfigSource,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
import { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
import { AccountProviderApiClient } from "./model-provider/accountProviderApiClient.js";
import { createAccountProjectTokenClient } from "./model-provider/accountProjectTokenClient.js";
import { AccountProviderApiKeyResolver } from "./model-provider/accountProviderApiKeyResolver.js";
import { createProviderConfigRuntime } from "./model-provider/providerConfigRuntime.js";
import { fetchZCodeBuiltinRemoteRelease } from "./model-provider/zcodeBuiltinRemoteConfig.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "./model-provider/providerRuntime.js";
import {
  createDerivedChatGptPlanConfigSource,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./model-provider/providerSettingsConnectivity.js";
import { createHostAcpAgentsBridge } from "./model-provider/acpAgents.js";
import {
  createProviderProvisioningSource,
  listProviderProvisioningCredentialKeys,
  PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS,
  resolveCredentialFilePath,
  type ProviderProvisioningSource,
} from "./model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "./model-provider/providerProvisioningTarget.js";
import { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
import { buildOffPeakModelSelectionView } from "./model-provider/offPeakModelSelectionView.js";
import { resolveClientConfigPlatform } from "./runtime-tools/clientPlatform.js";
import {
  createAccountRequestAuthService,
  type IAccountRequestAuthService,
} from "./model-provider/accountRequestAuthService.js";
import { createUsageStatsService } from "./usage-stats/usageStatsService.js";
import { createCodingPlanSubscriptionService } from "./coding-plan-subscription/codingPlanSubscriptionService.js";
import { createClientConfigService } from "./client-config/clientConfigService.js";
import { IClientConfigService } from "./client-config/clientConfig.js";
import { createClientScenesService } from "./client-scenes/clientScenesService.js";
import { createSkillsService } from "./skills/skillsService.js";
import { createSkillSyncService } from "./skill-sync/skillSyncService.js";
import { createMcpSyncService } from "./mcp-sync/mcpSyncService.js";
import {
  IPluginUiAppToolsService,
  IPluginUiSamplingService,
  createPluginUiSamplingService,
  IPluginUiBridgeService,
  createPluginUiAppToolsService,
  createPluginUiBridgeService,
} from "./plugin-ui-bridge/index.js";
import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
import { createPluginsService } from "./plugins/pluginsService.js";
import { createPluginManagementService } from "./plugins/pluginManagementService.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createHooksService } from "./hooks/hooksService.js";
import { createMemoryService } from "./memory/memoryService.js";
import { createUserInstructionsService } from "./user-instructions/userInstructionsService.js";
import { createOutputStyleService } from "./output-style/outputStyleService.js";
import { createSystemPromptService } from "./system-prompt/systemPromptService.js";
import { createSettingsSyncService } from "./settings-sync/settingsSyncService.js";
import {
  createFeedbackService,
  type CreateFeedbackServiceOptions,
} from "./feedback/feedbackService.js";
import { createLocalPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransferService.js";
import { createNodeApiClient } from "./providers/api/nodeApiClient.js";
import {
  createHostApiNetworkTransport,
  type HostApiNetworkTransport,
} from "./providers/api/nodeApiNetwork.js";
import type {
  RuntimeProcessLifecycleReporter,
  RuntimeTaskReporter,
} from "#src/process/runtimeProcessLifecycle.js";
import { initializeRuntimeProcessEnv } from "./runtime-tools/runtimeCommandEnv.js";
import {
  buildAgentEndpointOriginEnv,
  buildAgentRuntimeEnv,
} from "./runtime-tools/agentProxyEnv.js";
import { ensureAppCaCert } from "./runtime-tools/appCaCert.js";
import { buildHelperOpenArgs, isCuaLocalDevelopmentRuntime } from "@zcode/zcode-cua/broker/server";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { IOffPeakTaskService } from "./session/offPeakTask.js";
import type { HighspeedMockScenario } from "@zcode/shared";
import { IHighspeedCardService } from "./highspeed/highspeedCard.js";
import {
  buildHighspeedCodingPlanAuthHeaders,
  HighspeedCardService,
  createHighspeedHttpTransport,
} from "./highspeed/highspeedCardService.js";
import { createHighspeedMockTransport } from "./highspeed/highspeedMockTransport.js";
import { OffPeakTaskService } from "./session/offPeakTaskService.js";
import { OffPeakTaskRepo } from "./session/offPeakTaskRepo.js";
import { ForkWorkspacePinRepo } from "./session/forkWorkspacePinRepo.js";
import { migrateForkWorkspacePinsToProjects } from "./project-storage/forkWorkspacePinMigration.js";
import { createOffPeakServerClient } from "./session/offPeakServerClient.js";
import {
  buildOffPeakRequestAuth,
  createOffPeakOriginResolver,
  resolveOffPeakCredentials,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakMockUpstream,
} from "./session/offPeakRuntimeModel.js";
import {
  createOfficialMcpAuthHeadersResolver,
  resolveOfficialMcpCredentials,
} from "./official-mcp/officialMcpCredentials.js";
import {
  createOfficialMcpTrustedOriginRegistry,
  OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV,
} from "@zcode/shared";
import {
  BROKER_SOCKET_ENV,
  BROKER_UNAVAILABLE_ENV,
  createCuaPipSessionService,
  createCuaProductMcpServerResolver,
  createProductCuaHelperHost,
  CuaHelperLifecycleManager,
  ICuaPermissionService,
  ICuaPipSessionService,
  isOfficialCuaPluginEnabledForWorkspace,
  isPotentialZCodeCuaAgentMcpServer,
  isScreenCaptureProbeSuccess,
  reapOrphanedHelpers,
  resolveStandaloneStatusLaunchCandidates,
  shouldRunCuaScreenCaptureProbe,
  type CuaHelperHost,
  type CuaHelperTransportRestartOptions,
  type CuaHelperTransportRestartResult,
  type ManagedCuaProductHelperHost,
  type CuaProductMcpServerResolver,
  type CuaProductMcpServerResolverContext,
  type CuaPermissionRestartOptions,
  type CuaPermissionRestartResult,
  type CuaPermissionState,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
} from "#src/cua-permission-broker/index.js";
import {
  resolveWindowsCuaRuntime,
  WindowsCuaDevRuntimeResolutionError,
  type WindowsCuaRuntime,
} from "#src/cua-permission-broker/windowsCuaDevRuntime.js";
import { createCanonicalCuaHelperInstaller } from "./cua-permission-broker/cuaHelperInstaller.js";
import { WindowsCuaHelperHost } from "#src/cua-permission-broker/windowsCuaDevHelperHost.js";
import {
  getStableCuaPipeName,
  resolveStableCuaWinRecipe,
} from "#src/cua-permission-broker/stableCuaTransport.js";
import { HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import { resolveBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
  isCredentialDecryptError,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
  BIGMODEL_PROVIDER_ID,
  type ProviderFamilyDomain,
  type ServiceAuthorityMode,
  resolveRuntimeZCodeEndpointOrigin,
  resolveSafeTelemetryHostname,
  type BrowserBackendDescriptor,
  type BrowserClientMode,
  type BrowserCommand,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
  isZCodeCuaInternalFeatureEnabled,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  getCapturedZCodeAgentTelemetryEnv,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZAI_PROVIDER_ID,
  zcodeAccountAccessSchema,
  zcodeProviderAccountAccessSchema,
  ZCODE_VERSION,
  ZCODE_ENV,
  buildRuntimeZCodeApiUrl,
} from "@zcode/shared";

// These conversation-share implementations depend on the Node filesystem and are exposed only through
// @zcode/services/node so the browser-safe root entry does not bring node:* dependencies into the renderer.
export {
  ConversationShareService,
  ConversationShareHttpClient,
  conversationShareConnectionScopeFactory,
};

import { createPluginUiAccountBindings } from "./plugin-ui-bridge/instanceAccounts.js";
interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

// Bug A: the Helper's first cold launch (large Node SEA + first-time Gatekeeper/notarization
// assessment) routinely exceeds the old 5s health budget; warm it is <1s. Give the cold path
// plenty of headroom.
const CUA_HELPER_HEALTH_TIMEOUT_MS = 30_000;

type DefaultCuaProductHelper = {
  host: ManagedCuaProductHelperHost;
  macPermissionHost?: CuaHelperHost;
  resolver: CuaProductMcpServerResolver;
};

type ManagedDefaultCuaProductHelper = {
  helper: DefaultCuaProductHelper;
  seedContext?: CuaProductMcpServerResolverContext;
};

function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

interface ManagedCuaHelperHostDispose {
  stop(): Promise<void>;
}

// The default Computer Use Helper is a long-lived, separate TCC-authorized process that holds the broker
// socket and Accessibility/Screen Recording permissions. It is not an IPC service and is not included in
// ServiceCollection.disposeAll, but it must be terminated explicitly when the host is disposed. Otherwise,
// the authorized process remains alive or another starts when services are rebuilt, causing multiple
// instances, orphans, or leaked permission principals. Register it in a WeakMap associated with the
// ServiceCollection and terminate it during disposal (best-effort, without blocking other cleanup).
const managedCuaHelperHosts = new WeakMap<ServiceCollection, ManagedCuaHelperHostDispose>();
const providerRuntimes = new WeakMap<ServiceCollection, ProviderRuntime>();
const providerProvisioningSources = new WeakMap<ServiceCollection, ProviderProvisioningSource>();
const providerProvisioningTriggerDisposers = new WeakMap<
  ServiceCollection,
  readonly (() => void)[]
>();
// TaskIndexRepo, OffPeakTaskRepo, and others each hold a connection to tasks-index.sqlite.
// The disposal chain must close them all: on Windows, an open handle makes cleanup of the temporary
// directory fail with EBUSY after the host exits (reproduced reliably by the stdioDesktopPresentationSurface
// unit test). Linux's unlink-while-open behavior hides the leak. Register them in a side table keyed by
// ServiceCollection and close them together during disposal.
const sharedSqliteRepos = new WeakMap<ServiceCollection, ReadonlyArray<{ close(): void }>>();
const accountRequestAuthServices = new WeakMap<ServiceCollection, IAccountRequestAuthService>();
export type OffPeakRequestAuthBuilder = (
  ticketId: string,
) => Promise<{ apiKey: string; headers: Record<string, string>; accountScope?: string }>;
const offPeakRequestAuthBuilders = new WeakMap<ServiceCollection, OffPeakRequestAuthBuilder>();

/** Local Host process capability; not exposed through ServiceCollection on the generic RPC channel. */
export function getAccountRequestAuthService(
  services: ServiceCollection,
): IAccountRequestAuthService | undefined {
  return accountRequestAuthServices.get(services);
}

/** Provisioning source within the Local Host process; credentials are not exposed to the Renderer over generic RPC. */
export function getProviderProvisioningSource(
  services: ServiceCollection,
): ProviderProvisioningSource | undefined {
  return providerProvisioningSources.get(services);
}

/** Private off-peak request authentication wiring for Local Host; reuses production Registry/Account Access resolution and is not exposed over RPC. */
export function getOffPeakRequestAuthBuilder(
  services: ServiceCollection,
): OffPeakRequestAuthBuilder | undefined {
  return offPeakRequestAuthBuilders.get(services);
}
const managedHostApiNetworkTransports = new WeakMap<ServiceCollection, HostApiNetworkTransport>();

export function registerManagedCuaHelperHostForDispose(
  services: ServiceCollection,
  host: ManagedCuaHelperHostDispose,
): void {
  managedCuaHelperHosts.set(services, host);
}

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  managedHostApiNetworkTransports.set(services, transport);
}

export function shouldEnableDefaultCuaProductHelper(
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  // CUA is enabled by default in production (isZCodeCuaInternalFeatureEnabled defaults to ON and is
  // disabled only by explicit 0/false/off; corrected in 2026-08 because the old comment saying it was
  // disabled by default was outdated). When enabled, macOS uses the existing product Helper and Windows
  // uses the runtime bundled with the installer; both start on demand. When disabled, do not create a
  // host, probe resources, spawn a process, or show permission prompts.
  const env = options.env ?? process.env;
  if (!isZCodeCuaInternalFeatureEnabled(env)) return false;
  const platform = options.platform ?? process.platform;
  return platform === "darwin" || platform === "win32";
}

/**
 * Whether to create the default CUA product Helper in the current host. The Computer Use Helper may be
 * created only by a **desktop-local** authority:
 * - Never create it automatically for desktop-attached-remote or standalone-server, to avoid starting
 *   the Helper on the wrong host for a remote workspace and violating shared-host attachment and
 *   permission boundaries.
 * - Do not create it again when a resolver has been injected explicitly.
 * Platform/environment enablement is decided separately by shouldEnableDefaultCuaProductHelper.
 */
export function shouldCreateDefaultCuaProductHelper(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasRemoteWorkspaceIdentity?: boolean;
  hasInjectedResolver: boolean;
  hasBuiltInCuaPlugin: boolean;
}): boolean {
  return (
    opts.hasBuiltInCuaPlugin &&
    opts.serviceAuthorityMode === "desktop-local" &&
    !opts.hasRemoteWorkspaceIdentity &&
    !opts.hasInjectedResolver
  );
}

export function shouldUseCuaPermissionService(opts: {
  platform?: NodeJS.Platform;
  cuaEnabled: boolean;
}): boolean {
  const platform = opts.platform ?? process.platform;
  return (platform === "darwin" || platform === "win32") && opts.cuaEnabled;
}

export function shouldRetainDefaultCuaProductHelper(): boolean {
  // The CUA switch gates only future Agent admission; stop an existing Helper only when the Host/App is disposed.
  return true;
}

export function shouldEnableCuaOperationStateReporter(opts: {
  serviceAuthorityMode?: ServiceAuthorityMode;
  hasReporter: boolean;
}): boolean {
  // CUA operation state projects activity on the physical desktop; a remote workspace/server must not project its turn onto the local screen.
  return opts.hasReporter && opts.serviceAuthorityMode === "desktop-local";
}

export async function runCuaScreenCaptureReadinessProbe(
  host: Pick<CuaHelperHost, "queryScreenCaptureProbe">,
  screenRecording: "granted" | "denied" | "unknown",
  queryOptions?: CuaPermissionStatusQueryOptions,
): Promise<boolean> {
  if (!shouldRunCuaScreenCaptureProbe(screenRecording, queryOptions)) {
    return false;
  }
  try {
    return isScreenCaptureProbeSuccess(await host.queryScreenCaptureProbe());
  } catch {
    return false;
  }
}

/**
 * Screen Recording display state: prefer the actual TCC value read by a short-lived Helper, and use the
 * persistent Helper's report only when that value is unavailable.
 *
 * Why the persistent Helper cannot be trusted directly: macOS revoking Screen Recording does not affect
 * an **already running process**. It retains the previously granted capture capability until it exits,
 * and `CGPreflightScreenCaptureAccess()` continues returning the pre-revocation value.
 * After a user revokes access in System Settings, the persistent broker Helper therefore keeps reporting
 * granted until it restarts, and the Settings page continues to show "Authorized"; after the next restart,
 * CUA is actually unavailable. The reverse can also be stale: after granting access, the persistent
 * Helper may still report denied.
 *
 * Fail-open is intentional: if the preflight fails (open failure, timeout, or invalid result), use the
 * reported value, which is no worse than skipping preflight. Hard-coding denied would send an already
 * authorized user through an unnecessary permission flow.
 */
export async function resolveCuaScreenRecordingState(
  host: Pick<CuaHelperHost, "queryScreenRecordingPreflight">,
  reported: "granted" | "denied" | "unknown",
): Promise<"granted" | "denied" | "unknown"> {
  // unknown means the CGPreflight symbol itself was unavailable (before macOS 10.15). Preflight invokes
  // the same native call, so another process would also return unknown; a cold LaunchServices start is not worthwhile.
  if (reported === "unknown") return reported;
  try {
    return (await host.queryScreenRecordingPreflight()) ?? reported;
  } catch {
    return reported;
  }
}

export function createDynamicCuaProductMcpServerResolver(options: {
  isPluginEnabled: (context?: CuaProductMcpServerResolverContext) => boolean;
  getResolver: (
    context?: CuaProductMcpServerResolverContext,
  ) => CuaProductMcpServerResolver | undefined | Promise<CuaProductMcpServerResolver | undefined>;
  isResolverCurrent?: (
    resolver: CuaProductMcpServerResolver,
    context?: CuaProductMcpServerResolverContext,
  ) => boolean;
}): CuaProductMcpServerResolver {
  return {
    async resolveMcpServers(servers, context) {
      if (!options.isPluginEnabled(context)) return servers;
      const resolver = await options.getResolver(context);
      if (!resolver) return servers;
      const resolved = await resolver.resolveMcpServers(servers, context);
      // A delegate may cross an await for Helper start/health. If dispose sets the terminal state while
      // it waits, do not give the stale socket/token to a late Agent. Remove the CUA candidate and leave
      // other MCP servers unchanged.
      return options.isResolverCurrent?.(resolver, context) === false
        ? servers?.filter((server) => !isPotentialZCodeCuaAgentMcpServer(server))
        : resolved;
    },
    async restart() {
      // Delegate to the underlying resolver (called here by ICuaPermissionService.restartHelper).
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restart();
    },
    async restartAfterPermissionGrant(onboardingSessionId) {
      // A restart after authorization must preserve the session ID to retain the underlying idempotency
      // and ordering guarantees.
      const resolver = await options.getResolver();
      if (!resolver) {
        throw new Error("ZCode Computer Use is not enabled (plugin off or not product mode).");
      }
      await resolver.restartAfterPermissionGrant(onboardingSessionId);
    },
  };
}

let orphanHelperReaperHasRun = false;

type CreateDefaultCuaProductHelperOptions = {
  // Forward this to the resolver so it can check for an active turn before restart (see
  // cuaProductMcpResolver.ts). The desktop-local agent service provides the actual CUA turn state; use
  // false only when another caller does not provide it.
  hasActiveTurn?: () => boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string;
  arch?: NodeJS.Architecture;
  electronVersion?: string;
  resolveWindowsRuntime?: () => Promise<WindowsCuaRuntime>;
  createMacHost?: () => CuaHelperHost;
  createWindowsHost?: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
};

/**
 * Lazy-resolution wrapper for the Windows Helper host: defer resolving the installer runtime until the
 * first start()/checkHealth() call, and cache the result (including rejection).
 *
 * resolveWindowsCuaRuntime can fail for reasons such as missing-native-addon, artifact-integrity-mismatch,
 * or incompatible-runtime-manifest. If it only throws to the caller without a diagnostic record, the
 * Settings page's "Not loaded" state cannot explain the cause. Record one error log with a reason here.
 * Because the rejection is cached and the log is on the same promise chain, repeated start() calls do not
 * flood the logs.
 * The payload contains only reason/artifact/errorName/message. Resolution happens before minting a token
 * or creating a named pipe, so it cannot contain a secret.
 */
export function createWindowsCuaHelperHost(options: {
  resolveRuntime: () => Promise<WindowsCuaRuntime>;
  createHost: (runtime: WindowsCuaRuntime) => ManagedCuaProductHelperHost;
  logger?: ServiceLogger;
}): ManagedCuaProductHelperHost {
  let host: ManagedCuaProductHelperHost | undefined;
  let resolving: Promise<ManagedCuaProductHelperHost> | undefined;
  let stopped = false;
  let lifecycleEpoch = 0;
  let stopDrain: Promise<void> | undefined;
  const logResolutionFailure = (error: unknown): void => {
    if (!options.logger) return;
    const resolutionError =
      error instanceof WindowsCuaDevRuntimeResolutionError ? error : undefined;
    const artifact = resolutionError?.artifact;
    options.logger.error(undefined, "Windows CUA Helper runtime resolution failed", {
      reason: resolutionError?.reason ?? "unknown",
      ...(artifact ? { artifact } : {}),
      errorName: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const assertActive = (epoch: number): void => {
    if (stopped || epoch !== lifecycleEpoch) {
      throw new Error("Windows Computer Use Helper startup stopped");
    }
  };
  const getHost = async (epoch: number): Promise<ManagedCuaProductHelperHost> => {
    assertActive(epoch);
    if (host) return host;
    resolving ??= options
      .resolveRuntime()
      // Catch only resolveRuntime itself. An assertActive error in the following then is a stop() race,
      // not a resolution failure, and must not be included in the same diagnostic log.
      .catch((error: unknown) => {
        logResolutionFailure(error);
        throw error;
      })
      .then((runtime) => {
        // stop() advances the epoch synchronously. Check again after runtime resolution so a new orphan
        // Helper is not constructed and started after dispose returns.
        assertActive(epoch);
        const nextHost = options.createHost(runtime);
        assertActive(epoch);
        host = nextHost;
        return nextHost;
      });
    const resolvedHost = await resolving;
    assertActive(epoch);
    return resolvedHost;
  };
  const withActiveHost = async <T>(
    operation: (activeHost: ManagedCuaProductHelperHost) => Promise<T>,
  ): Promise<T> => {
    const epoch = lifecycleEpoch;
    const activeHost = await getHost(epoch);
    assertActive(epoch);
    return operation(activeHost);
  };
  return {
    get running() {
      return host?.running ?? false;
    },
    get socketPath() {
      return host?.socketPath ?? null;
    },
    get pluginAuthority() {
      return host?.pluginAuthority ?? null;
    },
    async start() {
      return withActiveHost((activeHost) => activeHost.start());
    },
    async checkHealth(timeoutMs?: number) {
      return withActiveHost((activeHost) => activeHost.checkHealth(timeoutMs));
    },
    async waitForTransport(timeoutMs?: number) {
      return withActiveHost((activeHost) => {
        if (!activeHost.waitForTransport) {
          // Compatibility with older injected Hosts: if the two-phase interface is unavailable, the
          // complete start handle is the only available tuple.
          return activeHost.start().then((handle) => ({
            socketPath: handle.socketPath,
            pluginAuthority: handle.pluginAuthority,
          }));
        }
        return activeHost.waitForTransport(timeoutMs);
      });
    },
    async restart() {
      return withActiveHost((activeHost) => activeHost.restart());
    },
    async restartAfterCurrentStart() {
      return withActiveHost((activeHost) => activeHost.restartAfterCurrentStart());
    },
    async restartAfterCurrentStartPreservingTransport(
      restartOptions?: CuaHelperTransportRestartOptions,
    ): Promise<CuaHelperTransportRestartResult> {
      return withActiveHost((activeHost) => {
        if (activeHost.restartAfterCurrentStartPreservingTransport) {
          return activeHost.restartAfterCurrentStartPreservingTransport(restartOptions);
        }
        // Compatibility with older injected Hosts: once the wrapper exposes the preserving interface,
        // it must commit the fresh-start marker on their behalf. Otherwise the producer may see a new
        // tuple started without the required fail-closed contract.
        restartOptions?.beforeFreshStart?.();
        return activeHost.restartAfterCurrentStart().then((handle) => ({ handle, reused: false }));
      });
    },
    async stop() {
      if (stopDrain) return stopDrain;
      stopped = true;
      lifecycleEpoch += 1;
      const pendingResolution = resolving;
      stopDrain = (async () => {
        // Wait for started resolution to settle so it observes the terminal epoch; otherwise the Helper
        // could start late, after dispose.
        await pendingResolution?.catch(() => undefined);
        await host?.stop();
      })();
      return stopDrain;
    },
  };
}

export function createDefaultCuaProductHelper(
  options: CreateDefaultCuaProductHelperOptions,
): DefaultCuaProductHelper | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (!shouldEnableDefaultCuaProductHelper({ platform, env })) {
    return undefined;
  }
  const logger = createServiceLogger("cua-product-helper");
  // Best-effort, once per process: reap Helpers orphaned by prior sessions before minting a
  // fresh one. Complements the per-Helper launcher-pid watchdog (helperMain); the reaper never
  // throws, so it cannot block startup.
  if (platform === "darwin" && !orphanHelperReaperHasRun) {
    orphanHelperReaperHasRun = true;
    reapOrphanedHelpers({ logger, env });
  }
  let macPermissionHost: CuaHelperHost | undefined;
  let host: ManagedCuaProductHelperHost;
  if (platform === "darwin") {
    const bundledHelperAppPath = resolveBundledCuaHelperAppPath();
    if (!bundledHelperAppPath) {
      logger.error(
        undefined,
        "CUA product Helper is unavailable: packaged Resources path was not resolved",
      );
      return undefined;
    }
    macPermissionHost =
      options.createMacHost?.() ??
      createProductCuaHelperHost({
        logger,
        env: process.env,
        helperInstaller: createCanonicalCuaHelperInstaller({
          logger,
          env: process.env,
          bundledAppPath: bundledHelperAppPath,
        }),
        // Conflict resolution: macOS continues to require the app-bundled Helper and must not fall back
        // to downloads. Only Windows uses the separate installer-runtime resolution path below.
        bundledHelperAppPath,
        // tolerate the Helper's cold first-launch instead of the 5s default.
        healthTimeoutMs: CUA_HELPER_HEALTH_TIMEOUT_MS,
        // The producer product factory fixes ghost cursor/PiP=true and background=false.
        // Consumers no longer pass placeholder dynamic getters, avoiding duplicated product policy in
        // two repositories.
      });
    host = macPermissionHost;
  } else {
    host = createWindowsCuaHelperHost({
      resolveRuntime:
        options.resolveWindowsRuntime ??
        (() =>
          resolveWindowsCuaRuntime({
            platform,
            env,
            resourcesPath: options.resourcesPath,
            arch: options.arch,
            electronVersion: options.electronVersion,
          })),
      createHost:
        options.createWindowsHost ??
        ((runtime) =>
          new WindowsCuaHelperHost({
            runtime,
            logger,
            mintSocketPath: () => getStableCuaPipeName(),
          })),
      logger,
    });
  }
  const resolver = createCuaProductMcpServerResolver(host, {
    hasActiveTurn: options.hasActiveTurn,
  });
  return {
    host,
    ...(macPermissionHost ? { macPermissionHost } : {}),
    resolver,
  };
}

export { ZCODE_APPLE_FM_HELPER_ENV } from "./voice-dictation/voicePostProcessor.js";
export const ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV = "ZCODE_CUA_BUNDLED_HELPER_APP_PATH";

export function resolveBundledCuaHelperAppPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const injectedPath = env[ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV]?.trim();
  if (injectedPath) {
    return injectedPath;
  }
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath?.trim();
  return resourcesPath ? join(resourcesPath, "cua-helper", HELPER_APP_NAME) : undefined;
}

export { isOfficialCuaPluginEnabledForWorkspace };

export function hasGlobalCliZCodeCuaServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.HOME?.trim() || homedir();
  const configPath = join(home, ".zcode", "cli", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (isRecord(parsed.features) && parsed.features.mcp === false) return false;
  if (!isRecord(parsed.mcp) || !isRecord(parsed.mcp.servers)) return false;
  return Object.entries(parsed.mcp.servers).some(([name, config]) =>
    isGlobalCliZCodeCuaServer(name, config),
  );
}

function isGlobalCliZCodeCuaServer(name: string, config: unknown): boolean {
  if (!isRecord(config)) return false;
  if (config.enabled === false) return false;
  if (typeof config.type === "string" && config.type !== "stdio") return false;
  if (name === "computer-use") return true;
  // Reuse @zcode/shared's single source of truth with the desktop/services resolver and CLI bootstrap to
  // avoid drift in a third check. If a git/.git/local-path form of zcode-cua is missed here, global CLI
  // environment injection omits the broker socket/token and the agent falls back to Python/uvx holding
  // macOS TCC permissions itself, violating the product broker boundary.
  if (typeof config.command === "string" && isZCodeCuaMcpCommand(config.command)) {
    return true;
  }
  return (
    Array.isArray(config.args) &&
    config.args.some((arg) => typeof arg === "string" && isZCodeCuaMcpPackageArg(arg))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Create a ServiceCollection containing all local services.
 *
 * @param options.parentPort - The Electron host process's parentPort, used by BroadcastService to relay
 *        events across windows. Pass null to make broadcasts a no-op.
 */
export function createLocalServices(options: {
  /** Private callback channel provided by an authenticated Desktop stdio connection; not exposed as a public service. */
  topicResourceRelayChannel?: (request: unknown) => IChannel;
  parentPort?: Parameters<typeof createBroadcastService>[0];
  /** Settings authority injected by the Host assembly layer; it must share a Window Host lifecycle with the network transport. */
  settingService?: ISettingService;
  /** Share the write queue with the injected local Setting. Do not pass an external remote Setting; its authoritative Host runs the migration. */
  prepareLegacyAccountConnections?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["prepareLegacyAccountConnections"];
  /** After injection, ServiceCollection owns disposal; other app-managed downloads in Host may reuse it. */
  hostApiNetworkTransport?: HostApiNetworkTransport;
  /** Let Desktop Host ask Main to register the exact local video path authorized for the Agent. */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  /** Desktop Host can query Main's all-window workspace inventory; unavailable inventory fails closed. */
  getOpenWorkspacePaths?: () => Promise<string[]>;
  /**
   * Forwarding hook for dynamic-workflow user-choice changes (docs/dynamic-workflow/launch.md “The user's choice”):
   * the Desktop Host pushes the local setting to every online desktop-attached remote Host in this window.
   */
  forwardDynamicWorkflowUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
  /** Desktop Host asks Main to register validated plugin UI HTML in exchange for a sandbox handle. */
  registerPluginSandbox?: (input: PluginSandboxRegisterInput) => Promise<PluginSandboxHandle>;
  feedback?: Partial<
    Omit<CreateFeedbackServiceOptions, "apiClient" | "credentialService" | "oauthService">
  >;
  /**
   * COMPILE BRIDGE (fork): upstream project-storage / Source-bot hooks. The fork still runs the legacy
   * single-root project service and its own bot remote path, so these are accepted for the desktop host
   * wiring but are not consumed here. Nothing in the fork calls them; see specs/upstream-sync-final-ledger.md.
   */
  resolveBotRemoteWorkspace?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
  }) => Promise<{ workspacePath: string; workspaceIdentity: string } | null>;
  setWorkspaceProjection?: ReturnType<
    typeof createSettingServiceWithMigrations
  >["setWorkspaceProjection"];
  resolveProjectHostService?: (hostId: string) => Promise<IProjectService>;
  /** Bot reuse of an existing window Source connection (upstream); accepted, unwired in the fork's bot path. */
  resolveBotProjectConnection?: (hostId: string) => BotProjectConnection | undefined;
  /** Live UI language for X-Client-Language; the fork's source headers keep their own resolution (accepted, unwired). */
  resolveClientLanguage?: () => string | undefined;
  remoteProjectConnection?: Pick<
    Parameters<typeof createRemoteProjectService>[0],
    "connectHost" | "readConnectionStates"
  >;
  /** Plugin UI telemetry sink supplied by the desktop host; the fork's thin plugin-management service intentionally emits none. */
  reportPluginTelemetryEvent?: (
    event: import("@zcode/shared").RendererTelemetryEventPayload,
  ) => void | Promise<void>;
  processLifecycleReporter?: RuntimeProcessLifecycleReporter;
  taskRuntimeReporter?: RuntimeTaskReporter;
  /** Workspace file search uses the built-in filter by default; Host assembly can inject the final implementation when another rule source is added. */
  workspaceFileSearchFilter?: WorkspaceFileSearchFilter;
  forwardSessionMessageSendRequested?: (
    request: SessionMessageSendRequested,
  ) => Promise<void> | void;
  /** The desktop local host dispatches a manual run directly after persisting it, bypassing the scheduler's normal path. */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /** Wake the scheduler immediately after an off-peak task becomes schedulable (desktop host injects a parentPort forwarder). */
  onOffPeakSchedulerWakeRequested?: () => void;
  // Injection point: the default resolver covers development, desktop, and SSH remote environments.
  // Tests or special hosts can inject a custom binary/arguments here.
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** Local runtime environment collected asynchronously by Desktop Main; once injected into Local Host, do not start a login shell synchronously. */
  runtimeProcessEnvPatch?: Record<string, string>;
  /** Fallback for Agent child-process spawn.cwd when the last local desktop workspace is missing. */
  zcodeAgentSpawnFallbackCwd?: string;
  /** One-time Agent network configuration received by a desktop-attached remote server from Desktop Host. */
  remoteAgentNetwork?: {
    httpProxy?: string;
    noProxy?: string;
  };
  /** Filesystem path to the ZCode Built-in Provider Config for the owning Environment. */
  zcodeBuiltinProviderConfigFilePath: string;
  /** HTTP Server exposes a cross-Environment Provisioning target only when the caller explicitly configures authentication. */
  providerProvisioningTargetEnabled?: boolean;
  /** Private notification for Desktop Host; ask Main to schedule a remote mirror only after Source is persisted successfully. */
  onProviderProvisioningSourceChanged?: (
    trigger: Exclude<ProviderProvisioningTrigger, "environment-online">,
  ) => void;
  serviceAuthorityMode?: ServiceAuthorityMode;
  /**
   * Standalone Source Server storage identity. Accepted for the host assembly contract only: the fork
   * TaskIndexRepo still uses the single local tasks-index path; per-host storage ownership is deferred.
   */
  projectStorageHostId?: string;
  /** Standalone Source Server workspace service; when omitted no Source Server workspace service is registered. */
  sourceServerWorkspaceService?: ISourceServerWorkspaceService;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
  agentTelemetry?: {
    getDeviceMid?: () => string | undefined;
    runtimeSurface?: "desktop_local_host" | "remote_workspace_host";
  };
  /** browser-use execution bridge (host→main WebContentsView+CDP), injected by the desktop host. Browser is unavailable when omitted. */
  browserControlExecutor?: {
    list(input: {
      requestId: string;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
    }): Promise<BrowserBackendDescriptor[]>;
    execute(input: {
      requestId: string;
      browserId?: string;
      browserGeneration?: number;
      sessionId: string;
      turnId?: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
      clientMode: BrowserClientMode;
      sessionContext: "live" | "cached";
      command: BrowserCommand;
    }): Promise<{ ok: boolean; [k: string]: unknown }>;
  };
  /** CUA turn state projection for a Windows desktop-local Host; assembly rejects other authorities. */
  cuaOperationStateReporter?: CuaOperationStateReporter;
}): ServiceCollection {
  const isDesktopAttachedRemote = options?.serviceAuthorityMode === "desktop-attached-remote";
  // Host/remote server previously started downstream services with the current process environment.
  // A desktop launched from the GUI or a remote server started through SSH/WSL/Docker often lacks the
  // user's login-shell PATH, making commands such as bun (added only in a shell profile) unavailable in
  // ZCode Agent and the terminal.
  // Normalize the runtime environment before starting local services and add the bundled rg to PATH so
  // ZCode Agent, the terminal, and authentication runtimes resolve commands consistently.
  initializeRuntimeProcessEnv(options?.runtimeProcessEnvPatch);

  const desktopContextPromptEnabledRaw =
    process.env[ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]?.trim();
  const desktopContextPromptEnabled =
    desktopContextPromptEnabledRaw === "1"
      ? true
      : desktopContextPromptEnabledRaw === "0"
        ? false
        : undefined;

  // App self-signed CA: generate a root CA on first startup (idempotently). Agent child processes trust
  // it through NODE_EXTRA_CA_CERTS, and the egress proxy uses its private key to re-sign traffic. Failure
  // to generate it (for example, on a read-only filesystem) must not block startup; log and continue.
  try {
    ensureAppCaCert();
  } catch (error) {
    createServiceLogger("appCaCert").warn(undefined, "ensure app CA cert failed:", error);
  }

  const localSettings = options?.settingService ? null : createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(
    options?.settingService ?? localSettings!.service,
  );
  const resolveCurrentZCodeEndpointOrigin = async () =>
    resolveRuntimeZCodeEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).zcodeEndpointOrigin,
    });
  let invalidateProjectTokens = () => {};
  let invalidatePluginUiAccounts: (() => void) | undefined;
  const provisioningOAuthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const credentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (key === "oauth:active_provider" || /^oauth:[^:]+:user_info$/.test(key))
        invalidatePluginUiAccounts?.();
      if (provisioningOAuthKeys.has(key)) invalidateProjectTokens();
      if (provisioningOAuthKeys.has(key)) {
        options.onProviderProvisioningSourceChanged?.("credential");
      }
    },
  });
  const accountProviderCredentialStore = createAccountProviderCredentialStore({
    credentialService,
  });
  const broadcastService = createBroadcastService(options?.parentPort ?? null);
  const gitCheckpointService = createGitCheckpointService();
  const hostApiNetworkTransport =
    options?.hostApiNetworkTransport ??
    createHostApiNetworkTransport(async () => {
      const settings = await settingService.get();
      return {
        httpProxy: settings.httpProxy,
        noProxy: settings.httpProxyNoProxy,
        caCertPath: settings.httpProxyCaCertPath,
      };
    });
  const zcodeJwtLogoutHandlerRef: {
    current: ((input: string | URL, headers: Headers) => void) | null;
  } = { current: null };
  const apiClient = createNodeApiClient({
    fetchImpl: hostApiNetworkTransport.fetch,
    onZcodeJwtInvalid: (input, headers) => zcodeJwtLogoutHandlerRef.current?.(input, headers),
    isZcodeJwtRequest: (input, headers) =>
      isCurrentOAuthCredentialRequest({ input, headers, credentialService }),
    isBusinessUnauthorizedRequest: (input, _headers) =>
      isOAuthBusinessRequest({ input, credentialService }),
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  });
  const systemService = createSystemService();
  // Onboarding eligibility and the task list share the same global tasks-index. The repo loads the
  // database lazily, so constructing it early adds no startup I/O; the session syncer reuses this instance.
  const taskIndexRepo = new TaskIndexRepo(undefined, undefined, options?.projectStorageHostId);
  // Onboarding completion record; fill userId from the login state (null for API-key or logged-out sessions). See docs/onboarding-record-spec.md.
  const onboardingRecordService = createOnboardingRecordService({
    loadUserId: async () => (await oauthCredentialRepo.loadActiveUserProfile())?.id ?? null,
    hasExistingLocalTask: () => taskIndexRepo.hasTaskMetas(),
  });
  let handleOAuthProviderLogout: ReturnType<typeof createOAuthProviderLogoutHandler> | null = null;
  const oauthCredentialRepo = new OAuthCredentialRepo(credentialService, {
    onCorruptOAuthSessionCleared: async (providers) => {
      // A background path outside telemetry may encounter corrupted OAuth credentials first.
      // Treat this recovery like logout and reuse the same handler to remove derived model provider keys.
      await Promise.all(
        providers.map((provider) => handleOAuthProviderLogout?.(provider) ?? Promise.resolve()),
      );
    },
  });
  const projectTokenClient = createAccountProjectTokenClient(apiClient, credentialService);
  invalidateProjectTokens = () => projectTokenClient.clear();
  const accountProviderApiKeyRemoteClient = new AccountProviderApiClient(apiClient);
  const accountProviderApiKeyResolver = new AccountProviderApiKeyResolver(
    accountProviderApiKeyRemoteClient.fetchRemoteData.bind(accountProviderApiKeyRemoteClient),
    projectTokenClient,
  );
  const accountProviderCredentialService = createAccountProviderCredentialService({
    async loadOAuthAccessToken(family) {
      const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await oauthCredentialRepo.loadTokenSet(oauthProviderId))?.accessToken ?? null;
    },
    resolveProviderMaterial: (
      family,
      accessToken,
      accountIdentity,
      rejectedProjectTokenFingerprint,
    ) =>
      accountProviderApiKeyResolver.resolveProviderMaterial(
        family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID,
        accessToken,
        accountIdentity,
        rejectedProjectTokenFingerprint,
      ),
  });
  const resolveLegacyTeamOrganization = createLegacyTeamOrganizationResolver({
    apiClient,
    loadOAuthTokenSet: (family) =>
      oauthCredentialRepo.loadTokenSet(family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID),
  });
  const readAccountProviderSettings = async () => {
    // Coordinate migration only at the account-facts entry point. ApiClient proxy/endpoint settings still
    // come from regular Setting and must not recursively wait for migration.
    // Settings injected by an external remote attachment are managed by its owning Host; do not read the
    // local legacy file.
    const prepare =
      options?.prepareLegacyAccountConnections ?? localSettings?.prepareLegacyAccountConnections;
    const unresolvedFamilies = (await prepare?.(resolveLegacyTeamOrganization)) ?? [];
    const settings = await settingService.get();
    return {
      providerFamilyDomain: settings.providerFamilyDomain ?? null,
      selections: settings.providerFamilyConnectionSelections ?? {},
      unresolvedFamilies,
    };
  };
  const loadAccountIdentity = async (family: ProviderFamilyDomain) => {
    const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
    return (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id ?? null;
  };
  // ChatGPT plan (SIWC) host-side request auth: local credentials only, routed per account
  // (providerId → accountKey → that account's slot); the stable scope fingerprint matches the
  // CLI resolver (per-account provider id + issued client id + subject).
  const siwcAuthService = new SiwcAuthService(credentialService);
  const chatGptPlanRequestAuth = {
    async resolve(input: {
      expectedAccountScope?: string;
      forceRefresh: boolean;
      providerId: string;
    }): Promise<{ accountScope?: string; apiKey: string }> {
      const accountKey = parseChatGptPlanAccountProviderId(input.providerId);
      if (!accountKey) {
        throw new Error(`siwc_account_not_found: ${input.providerId}`);
      }
      const apiKey = await siwcAuthService.resolveAccessToken(accountKey, {
        forceRefresh: input.forceRefresh,
      });
      const accountScope = await siwcAuthService.resolveAccountScope(accountKey);
      if (input.expectedAccountScope !== undefined && input.expectedAccountScope !== accountScope) {
        throw new Error("siwc_account_scope_invalidated");
      }
      return { apiKey, ...(accountScope ? { accountScope } : {}) };
    },
  };
  // Derived per-account ChatGPT plan provider entries (template rule + model rules cloned per
  // signed-in account; base entry dropped). One wrapper instance feeds both the Registry
  // config source and the Account Provider config source so their revisions stay consistent.
  const chatGptPlanConfigSourceWrapper = (
    source: ProviderSource<ProviderConfigSnapshot>,
  ): ProviderSource<ProviderConfigSnapshot> =>
    createDerivedChatGptPlanConfigSource(source, async () => {
      const status = await siwcAuthService.getStatus();
      return status.accounts.map((account) => {
        const providerName = account.user.email ?? account.user.displayName ?? account.accountKey;
        return {
          accountKey: account.accountKey,
          providerName,
          // Key the account+presentation fingerprint so neither account keys nor email/name
          // values can be recovered from the logged registry revision.
          revisionKey: createHmac("sha256", chatGptPlanRevisionKey)
            .update(JSON.stringify([account.accountKey, providerName]), "utf-8")
            .digest("hex")
            .slice(0, 32),
        };
      });
    });
  const accountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readAccountProviderSettings,
          loadAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => oauthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanMaterial(providerId, family, rejectedProjectTokenFingerprint) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id;
        if (!accountIdentity) return null;
        return accountProviderCredentialService.loadCodingPlanMaterial({
          providerId,
          family,
          accountIdentity,
          rejectedProjectTokenFingerprint,
        });
      },
      resolveTeamPlanMaterial: async (access, rejectedProjectTokenFingerprint) => {
        const accountIdentity = await loadAccountIdentity(access.family);
        if (!accountIdentity) return null;
        return resolveAccountTeamPlanRuntimeMaterial({
          apiClient,
          credentialService,
          access,
          accountIdentity,
          tokenClient: projectTokenClient,
          rejectedProjectTokenFingerprint,
        });
      },
    }),
  );
  const providerConfigLog = createServiceLogger("provider-config");
  const clientConfigPlatform = resolveClientConfigPlatform();
  const providerConfigRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: options.zcodeBuiltinProviderConfigFilePath,
    zcodeBuiltinEnvironment: {
      environmentConfigRoot: resolveAppConfigDir(),
      platform: clientConfigPlatform,
      appVersion: ZCODE_VERSION,
      resolveEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
      onRefreshResult: (event) => {
        if (event.result === "updated")
          providerConfigLog.info(undefined, "ZCode Built-in CDN 配置已更新", event);
        else providerConfigLog.debug(undefined, "ZCode Built-in 刷新检查", event);
      },
      fetchRelease: (endpointOrigin, signal) =>
        fetchZCodeBuiltinRemoteRelease({
          apiClient,
          endpointOrigin,
          signal,
          appVersion: ZCODE_VERSION,
          platform: clientConfigPlatform,
        }),
    },
    onZCodeBuiltinRefreshError: (error) => {
      providerConfigLog.warn(undefined, "ZCode Built-in Config 远端刷新失败", { error });
    },
    onPersonalConfigRecovery: (event) => {
      providerConfigLog.warn(
        undefined,
        "Personal Provider Config 加载失败，已保留磁盘状态并以内存空配置降级",
        {
          error: event.error,
        },
      );
    },
    onPersonalConfigPollingError: (error) => {
      // Report a polling error only once when entering the failed state. The next poll retries, avoiding
      // repeated disk writes during a persistent failure.
      providerConfigLog.warn(undefined, "Personal Provider Config 轮询暂时失败，将继续重试", {
        error,
      });
    },
    // The published config.json contains ZCode user settings. Cleaning up third-party ACP must not remove
    // this upgrade path.
    // The repository imports it only when the new Personal config is absent and keeps the old file for rollback.
    readLegacyProviders: () => readLegacyZCodeConfigProviders(),
  });
  const accountProviderConfigSource = createAccountProviderConfigSource({
    configSource: chatGptPlanConfigSourceWrapper(providerConfigRuntime.configService),
    readSettings: readAccountProviderSettings,
    loadChatGptPlanEntitlement: async () => {
      const status = await siwcAuthService.getStatus();
      const statuses = new Map<string, "entitled" | "identity-only">();
      for (const account of status.accounts) {
        statuses.set(account.accountKey, account.planUsageEntitled ? "entitled" : "identity-only");
      }
      return statuses;
    },
    async loadCodingPlanApiKey(providerId, family, accountIdentity, forceRefresh) {
      if (isStartPlanModelProviderId(providerId)) return null;
      return accountProviderCredentialService.loadCodingPlanApiKey({
        providerId,
        family,
        accountIdentity,
        forceRefresh,
      });
    },
    loadAccountIdentity,
    resolveFamilyAvailability: createCodingPlanFamilyAvailabilityResolver({
      apiClient,
      credentialService,
    }),
  });
  const accountProviderRuntimeLog = createServiceLogger("account-provider-runtime");
  const modelSelectionConfiguredDefaultSource = new NodeModelSelectionConfigRepository({
    personalRepository: providerConfigRuntime.personalRepository,
  });
  const providerProvisioningSource = createProviderProvisioningSource({
    personalRepository: providerConfigRuntime.personalRepository,
    settingService,
    credentialFilePath: resolveCredentialFilePath(resolveAppConfigDir()),
    personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
  });
  const providerProvisioningDisposers = [
    providerConfigRuntime.configService.onDidChange((reason) => {
      // Every Window Host polls the same file. Trigger sync only when this process successfully commits
      // an update, so another Host's poll-changed event does not count one save in multiple generations.
      if (reason === "personal:updated") {
        options.onProviderProvisioningSourceChanged?.("personal-config");
      }
    }),
    settingService.onDidUpdate((event) => {
      if (
        event.keys.includes("providerFamilyDomain") ||
        event.keys.includes("providerFamilyConnectionSelections")
      ) {
        options.onProviderProvisioningSourceChanged?.("account-settings");
      }
    }),
  ];
  const disposeAccountProviderInvalidation = bindAccountProviderInvalidation({
    onDidUpdateSetting: (listener) => settingService.onDidUpdate(listener),
    refresh: (reason) => accountProviderConfigSource.refresh(reason),
  });
  const accountProviderRefreshErrorDispose = accountProviderConfigSource.onDidRefreshError(
    (event) => {
      accountProviderRuntimeLog.warn(undefined, "account provider source refresh failed", {
        error: event.error,
        reasons: event.reasons,
      });
    },
  );
  let providerConnectivityAgentService:
    | Pick<IZCodeAgentService, "testModelConnectivity">
    | undefined;
  // Dev-only stabilization gate, enforced on the host as well as in the UI.
  const acpAgentsBridge = createHostAcpAgentsBridge();
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
    wrapConfigSource: chatGptPlanConfigSourceWrapper,
    accountSource: accountProviderConfigSource,
    modelSelectionConfiguredDefaultSource,
    disposeModelSelectionConfiguredDefaultSource: () =>
      modelSelectionConfiguredDefaultSource.dispose(),
    testConnectivity: createProviderSettingsConnectivityTester({
      testModelConnectivity: async (input) => {
        if (!providerConnectivityAgentService) {
          throw new Error("Agent Service 尚未完成模型连通性测试装配");
        }
        return providerConnectivityAgentService.testModelConnectivity(input);
      },
    }),
    ...(acpAgentsBridge ? { acpAgents: acpAgentsBridge } : {}),
    disposeAccountSource: () => {
      disposeAccountProviderInvalidation();
      accountProviderRefreshErrorDispose();
      accountProviderConfigSource.dispose();
    },
  });
  handleOAuthProviderLogout = createOAuthProviderLogoutHandler({
    accountProviderCredentialStore,
    refreshAccountProviders: (reason: string) => accountProviderConfigSource.refresh(reason),
  });
  // Credential resolution for the official Server MCP. MCP request identity headers and MCP quota
  // queries (/api/v1/mcp/usage) must share this implementation or they may disagree about the currently
  // selected Coding Plan connection.
  // Quota checks receive credential resolution rather than resolveHeaders because ownership validation
  // needs providerFamily, which is absent from identity headers. The headers themselves are still built
  // by the same buildOfficialMcpAuthHeaders function.
  const officialMcpCredentialSource = {
    resolve: () =>
      resolveOfficialMcpCredentials({
        accountRequestAuthService,
        credentialService,
        modelSelectionService: providerRuntime.modelSelection,
      }),
  };
  // Closures referencing zcodeAgentService from mcpSync/hooks are invoked lazily, so declaration order does not affect initialization.
  const skillsService = createSkillsService({ isDesktopRuntime: true });
  const mcpSyncService = createMcpSyncService({
    // Consolidate the host-side consumer for mcp/list in mcpSync; the Agent process still checks the actual state.
    listMcpServerStatuses: (params) => zcodeAgentService.listMcpServerStatuses(params),
  });
  const pluginSyncService = createPluginSyncService();
  const pluginUiAccounts = createPluginUiAccountBindings({
    async readAccount() {
      const provider = await oauthCredentialRepo.loadActiveProvider();
      const profile = provider ? await oauthCredentialRepo.loadUserProfile(provider) : null;
      return [provider, profile?.id ?? null];
    },
    open: (params) => zcodeAgentService.openMcpUiInstance(params),
    close: (params) => zcodeAgentService.closeMcpUiInstance(params),
  });
  invalidatePluginUiAccounts = () => pluginUiAccounts.invalidate();
  const pluginUiBridgeService = createPluginUiBridgeService({
    reportTelemetryEvent: options?.reportPluginTelemetryEvent,
    openInstance: (params) => pluginUiAccounts.open(params),
    closeInstance: (params) => pluginUiAccounts.close(params),
    validateInstance: (params) => zcodeAgentService.validateMcpUiInstance(params),
    recycleInstance: (params) => zcodeAgentService.recycleMcpUiInstance(params),
    // Plugin UI: resource reads and UI tool calls all happen in the agent process that owns the session; the host only validates and registers.
    readMcpResource: (params) => zcodeAgentService.readMcpResource(params),
    callMcpToolForUi: (params) => zcodeAgentService.callMcpToolForUi(params),
    cancelMcpToolCallForUi: (params) => zcodeAgentService.cancelMcpToolCallForUi(params),
    readMcpResourceForUi: (params) => zcodeAgentService.readMcpResourceForUi(params),
    listMcpResourcesForUi: (params) => zcodeAgentService.listMcpResourcesForUi(params),
    listMcpResourceTemplatesForUi: (params) =>
      zcodeAgentService.listMcpResourceTemplatesForUi(params),
    subscribeMcpResourceForUi: (params) => zcodeAgentService.subscribeMcpResourceForUi(params),
    unsubscribeMcpResourceForUi: (params) => zcodeAgentService.unsubscribeMcpResourceForUi(params),
    listPluginUiSurfaces: (params) => zcodeAgentService.listPluginUiSurfaces(params),
    registerSandbox: options?.registerPluginSandbox,
  });
  // App-Provided Tools: page-tool registration and model-call claiming/returning all happen in the agent process that owns the session.
  const pluginUiSamplingService = createPluginUiSamplingService({
    sample: (params) => zcodeAgentService.sampleMcpApp(params),
    cancelSampling: (params) => zcodeAgentService.cancelMcpAppSampling(params),
  });
  const pluginUiAppToolsService = createPluginUiAppToolsService({
    registerAppToolsForUi: (params) => zcodeAgentService.registerAppToolsForUi(params),
    unregisterAppToolsForUi: (params) => zcodeAgentService.unregisterAppToolsForUi(params),
    claimAppToolCallForUi: (params) => zcodeAgentService.claimAppToolCallForUi(params),
    resolveAppToolCallForUi: (params) => zcodeAgentService.resolveAppToolCallForUi(params),
  });
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
  const hooksService = createHooksService({
    grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
  });
  const memoryService = createMemoryService();
  // Once the current process has a Provider Runtime, that Environment's own Selection View determines
  // execution readiness. Desktop-attached remote also reads its own remote Config/Account Facts.
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
  const agentAccountProviderConfigSource = accountProviderConfigSource;
  // ===== Computer Use Helper lifecycle layer (port from the feature branch) =====
  // Constraints: lazily obtain the lifecycle coordinator and use a generation fence, with dispose only from
  // an explicit workspace lifecycle; do not add periodic health probes; restart the Helper while reusing the
  // host transport whenever possible, leaving existing Agent sessions, processes, and MCP streams unchanged.
  // P1-a mitigation: createDefaultCuaProductHelper() must assemble the resolver before zcodeAgentService exists, but the
  // active-turn signal is available only after that service is created. Use a forward reference as a
  // placeholder: the resolver calls hasActiveTurn() later during an asynchronous resolveMcpServers,
  // after hasActiveTurnRef has been assigned.
  // Connect the Agent service's CUA turn tracker through the forward reference to avoid restarting the
  // Helper during an active CUA request. Assign it after service creation. Helper recovery must never
  // reclaim an Agent.
  let hasActiveTurnRef: (() => boolean) | undefined;
  const isCuaEnabledForContext = (context?: CuaProductMcpServerResolverContext): boolean =>
    // Preserve the existing main gate behavior: dev/internal features (ZCODE_CUA_DEV_MODE=1 or
    // ZCODE_CUA_PRODUCT_HELPER=1) count as enabled without requiring config.json to explicitly enable
    // them. Main bootstrap gates the bundled plugin with isZCodeCuaInternalFeatureEnabled, unlike feat's
    // workspace enablement. In production (dev mode off), fall back to the official plugin's workspace
    // enablement check, matching feat.
    isZCodeCuaInternalFeatureEnabled(process.env) ||
    isOfficialCuaPluginEnabledForWorkspace({
      env: process.env,
      workingDirectory: context?.workspacePath,
    });
  const defaultCuaProductHelperLifecycle =
    new CuaHelperLifecycleManager<ManagedDefaultCuaProductHelper>(async (managed) => {
      await managed.helper.host.stop();
    });
  const createManagedDefaultCuaProductHelper = (
    context?: CuaProductMcpServerResolverContext,
  ): ManagedDefaultCuaProductHelper | undefined => {
    const helper = createDefaultCuaProductHelper({
      // Forward active-turn queries through a forward reference assigned after zcodeAgentService is created.
      hasActiveTurn: () => hasActiveTurnRef?.() ?? false,
    });
    if (!helper) return undefined;

    // The previous default setup started a watchdog every 10 seconds. A single broker_info timeout
    // while idle could call resolver.restart() in the background. The Helper does not own the Agent
    // runtime and does not need to self-heal when CUA is unused. Keep health checks at the spawn-env
    // and resolver-request boundaries so a background timer cannot interfere with other modules.
    return {
      helper,
      ...(context ? { seedContext: context } : {}),
    };
  };
  const getOrCreateDefaultCuaProductHelper = async (
    context?: CuaProductMcpServerResolverContext,
  ): Promise<DefaultCuaProductHelper | undefined> => {
    const managed = await defaultCuaProductHelperLifecycle.acquire({
      isAdmitted: () =>
        shouldCreateDefaultCuaProductHelper({
          serviceAuthorityMode: options?.serviceAuthorityMode,
          hasRemoteWorkspaceIdentity: Boolean(context?.workspaceIdentity?.trim()),
          hasInjectedResolver: Boolean(options?.cuaProductMcpServerResolver),
          hasBuiltInCuaPlugin: isCuaEnabledForContext(context),
        }),
      shouldRetainCurrent: shouldRetainDefaultCuaProductHelper,
      create: () => createManagedDefaultCuaProductHelper(context),
    });
    return managed?.helper;
  };
  const isDefaultCuaProductHelperCurrent = (helper: DefaultCuaProductHelper): boolean =>
    defaultCuaProductHelperLifecycle.peek()?.helper === helper;
  // Start the Helper lazily: at host startup, only probe for a Helper already running on the stable
  // socket (started by the SDK's first call). Ping only; never launch it, with a 300 ms budget. The
  // probe is only for status display and PiP credential discovery. Permission details and onboarding
  // still use the explicit host flow.
  const probeStableCuaHelperSocket = async (): Promise<string | null> => {
    const socketPath =
      process.platform === "win32" ? getStableCuaPipeName() : resolveBrokerSocketPath();
    try {
      const { createConnection } = await import("node:net");
      return await new Promise<string | null>((resolve) => {
        const socket = createConnection(socketPath);
        const finish = (value: string | null): void => {
          socket.destroy();
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), 300);
        socket.on("connect", () => {
          clearTimeout(timer);
          socket.write(`{"id":0,"method":"ping","params":{}}\n`);
          let buffer = "";
          socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            if (buffer.includes("\n")) {
              try {
                const nl = buffer.indexOf("\n");
                const reply = JSON.parse(buffer.slice(0, nl)) as { ok?: boolean };
                finish(reply.ok === true ? socketPath : null);
              } catch {
                finish(null);
              }
            }
          });
        });
        socket.on("error", () => {
          clearTimeout(timer);
          finish(null);
        });
      });
    } catch {
      return null;
    }
  };

  // Launch the standalone Helper on demand (stable socket). In dev builds, where this Helper embeds
  // the dev policy, pass unsigned-launcher/external-escape together so this ad-hoc-signed process can
  // pass the signature-gate check. The product Helper does not embed the dev policy, so these arguments
  // have no effect there; its product signature passes the Team gate. Poll ping after launch (5 s,
  // every 100 ms); return the socket path when ready, or null on timeout.
  //
  // Use upstream isCuaLocalDevelopmentRuntime from @zcode/zcode-cua/broker/server for dev detection.
  // This is the same subpath already used in this file to import buildHelperOpenArgs.
  //
  // This preserves behavior; it is not a security hardening. Upstream checks
  // `COMPILED_LOCAL_DEVELOPMENT_RUNTIME && ZCODE_RUNTIME_ENV!=="production"`. Only
  // scripts/build-cua-helper-app.mjs defines that compile-time constant for the Helper bundle. The
  // desktop host bundle has no such define, so upstream falls back to
  // `process.env.NODE_ENV !== "production"`, the same check the local copy used. Thus they are
  // textually equivalent with the current packaging. Production is gated by ZCODE_RUNTIME_ENV=production,
  // which packaging injects explicitly without passing NODE_ENV.
  //
  // Using the upstream helper removes a source of drift: the compile-time folding point, number of
  // factors, and fail-closed behavior stay defined in one place. If the host bundle later adds the
  // __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__ define (already present in the Helper), the compile-time gate
  // will apply automatically without another change here.

  const launchStandaloneCuaHelperForStatus = async (): Promise<string | null> => {
    if (process.platform !== "darwin") return null;
    const { existsSync } = await import("node:fs");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const socketPath = resolveBrokerSocketPath();
    const appPath = resolveStandaloneStatusLaunchCandidates(process.env).find((candidate) =>
      existsSync(candidate),
    );
    if (!appPath) return null;
    // Build Helper launch arguments through buildHelperOpenArgs to avoid omissions and drift from
    // hand-building them at multiple call sites. Read-only permission checks from Settings do not host
    // PiP, so they omit --launcher-pid and --pip-mode; their exit log is .settings.exit.log. Define any
    // new arguments in HelperLaunchSpec for callers to share.
    const args = buildHelperOpenArgs({
      appPath,
      socketPath,
      exitLogPath: `${socketPath}.settings.exit.log`,
      ...(isCuaLocalDevelopmentRuntime(process.env)
        ? { allowUnsignedLauncherLocalDev: true, allowExternalBrokerClientLocalDev: true }
        : {}),
    });
    try {
      await promisify(execFile)("/usr/bin/open", args, { timeout: 5_000 });
    } catch {
      // LaunchServices may time out even after accepting the request; keep waiting for ping.
    }
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  const launchWindowsCuaHelperForStatus = async (): Promise<string | null> => {
    try {
      const managed = await getOrCreateDefaultCuaProductHelper(undefined);
      if (managed) void managed.host.start().catch(() => {});
    } catch {}
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await probeStableCuaHelperSocket();
      if (ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  };

  // serviceAuthorityMode is the single source for both enabled and whether
  // onCuaPipSessionLifecycle is attached. Name it here so startup diagnostics cannot drift from
  // the actual value below.
  const cuaPipSessionEnabled =
    process.platform === "darwin" && options?.serviceAuthorityMode === "desktop-local";
  const cuaPipSessionService = createCuaPipSessionService({
    enabled: cuaPipSessionEnabled,
    resolveCredentials: async () => {
      const host = defaultCuaProductHelperLifecycle.peek()?.helper.macPermissionHost;
      // PiP clients declare role=presentation. The Helper determines eligibility from the peer's
      // (ZCode main process) signing identifier.
      if (host?.running && host.socketPath) {
        return {
          socketPath: host.socketPath,
        };
      }
      // Lazy startup: when no managed host exists, probe for an SDK-started Helper on the stable
      // socket. This only probes and never launches it.
      const stable = await probeStableCuaHelperSocket();
      return stable ? { socketPath: stable } : undefined;
    },
  });
  // Log the PiP delivery wiring state at startup. In a dev run, no PiP events were delivered, but
  // neither `enabled=false` nor a missing lifecycle callback (tracker is undefined, so accept is a
  // no-op) produces runtime logs. This startup line distinguishes the causes after a restart without
  // first running a CUA turn. Keep the cua-pip-session scope; its info logs are confirmed in host logs.
  createServiceLogger("cua-pip-session").info(undefined, "[cua-pip-session] wiring resolved", {
    enabled: cuaPipSessionEnabled,
    platform: process.platform,
    serviceAuthorityMode: options?.serviceAuthorityMode ?? null,
    lifecycleWired: options?.serviceAuthorityMode === "desktop-local",
  });
  // Computer Use Helper macOS permission-status service: the renderer queries the current Helper
  // runtime and permissions through host RPC, then restarts the Helper once from an explicit entry
  // point after the user grants permission. Restart must go through resolver.restart(), not bare
  // host.restart(), because the resolver prefers reusing the existing socket/token. A bare host.restart()
  // may create fresh credentials while existing Agents retain the old transport and cannot connect to
  // the new broker.
  const cuaPermissionService: ICuaPermissionService = {
    async getStatus(
      workspacePath: string,
      workspaceIdentity?: string,
      queryOptions?: CuaPermissionStatusQueryOptions,
    ): Promise<CuaPermissionStatusResult> {
      if (process.platform !== "darwin" && process.platform !== "win32") {
        return {
          available: false,
          reason: "CUA permissions are only available on macOS and Windows.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // Disabling the plugin gates only future Agents. Refreshing the permissions page must not call
      // acquire, which could stop a Helper still in use by existing Agents.
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          available: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // Lazy startup: status queries never launch the Helper. If a managed host exists (for example,
      // after an authorization flow), query it fully. Otherwise probe the stable socket for an
      // SDK-started Helper. If neither exists, report it as stopped; first use starts it automatically.
      const peeked = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = peeked && isDefaultCuaProductHelperCurrent(peeked) ? peeked : undefined;
      const host = helper ? helper.macPermissionHost : undefined;
      if (!host || !host.running) {
        // Start the Helper on demand: a Settings query launches the standalone Helper on the stable
        // socket, without launcher-pid. It sleeps after 300 seconds without access and is not managed
        // by the host. Query the actual state through the stable socket after launch.
        let stable = await probeStableCuaHelperSocket();
        if (!stable) {
          stable =
            process.platform === "darwin"
              ? await launchStandaloneCuaHelperForStatus()
              : await launchWindowsCuaHelperForStatus();
        }
        if (!stable) {
          return {
            available: false,
            reason:
              "ZCode Computer Use is not running; it will start automatically on first Computer Use use.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
        // Query actual permissions directly from the standalone Helper (identity mode, no token).
        try {
          const { callBrokerMethod } = await import("@zcode/zcode-cua/broker/helperHealth");
          const report = await callBrokerMethod<{
            grant_owner: string;
            owner?: { display_name?: string };
            accessibility: CuaPermissionState;
            accessibility_probe_ok?: boolean;
            screen_recording: CuaPermissionState;
          }>({
            socketPath: stable,
            method: "permission_status",
            timeoutMs: 3000,
          });
          return {
            grantOwner: report.grant_owner,
            grantOwnerDisplayName: report.owner?.display_name ?? report.grant_owner,
            accessibility: report.accessibility,
            accessibilityProbeOk: report.accessibility_probe_ok === true,
            screenRecording: report.screen_recording,
            screenCaptureProbeOk: false,
          };
        } catch {
          return {
            available: false,
            reason: "ZCode Computer Use is starting up; retry in a moment.",
            idle: true,
          } satisfies { available: false; reason: string; idle: true };
        }
      }
      try {
        const report = await host.queryPermissionStatus();
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // Read the actual Screen Recording permission from a new process: revocation does not affect
        // an already-running persistent Helper, which would keep reporting its previous granted state.
        // If the actual state cannot be read, fail open and keep the reported value.
        const screenRecording = await resolveCuaScreenRecordingState(host, report.screen_recording);
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        // Probe actual screen capture: TCC screen_recording === "granted" only means the system recorded
        // permission; it does not guarantee WindowServer allows this process to read pixels (wallpaper
        // frame / SR-not-live mismatch). Only a non-empty capture proves end-to-end screen access and
        // drives the UI's ready/auto-close state. Fail closed: errors and timeouts return false. Use the
        // preflight state as a gate; when it is already denied, there is no need to capture again.
        const screenCaptureProbeOk = await runCuaScreenCaptureReadinessProbe(
          host,
          screenRecording,
          queryOptions,
        );
        if (!isDefaultCuaProductHelperCurrent(helper)) {
          return {
            available: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        const reportedOwnerDisplayName =
          typeof report.owner?.display_name === "string" ? report.owner.display_name : undefined;
        return {
          grantOwner: report.grant_owner,
          grantOwnerDisplayName: reportedOwnerDisplayName ?? report.grant_owner,
          accessibility: report.accessibility,
          accessibilityProbeOk:
            report.accessibility_probe?.ok === true &&
            report.accessibility_probe?.classification === "functional",
          screenRecording,
          screenCaptureProbeOk,
        };
      } catch (error) {
        return {
          available: false,
          reason: `Could not read Computer Use Helper permission status: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
    async restartHelper(
      workspacePath: string,
      workspaceIdentity?: string,
      restartOptions?: CuaPermissionRestartOptions,
    ): Promise<CuaPermissionRestartResult> {
      if (process.platform !== "darwin") {
        return {
          ok: false,
          reason: "CUA permissions are only available on macOS.",
        };
      }
      const context = workspacePath ? { workspacePath, workspaceIdentity } : undefined;
      // Match getStatus: when the plugin is disabled, do not touch an existing Helper or let a Settings
      // action change the runtime used by existing Agents.
      if (
        !shouldUseCuaPermissionService({
          cuaEnabled: isCuaEnabledForContext(context),
        })
      ) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      // Use resolver.restart() so the host can reuse the transport where possible. Do not recreate a
      // running Agent through disposeWorkspace.
      const helper = await getOrCreateDefaultCuaProductHelper(context);
      const resolver =
        helper && helper.macPermissionHost && isDefaultCuaProductHelperCurrent(helper)
          ? helper.resolver
          : undefined;
      if (!resolver) {
        return {
          ok: false,
          reason: "ZCode Computer Use is not enabled (plugin off or not product mode).",
        };
      }
      try {
        if (restartOptions?.reason === "permission_granted") {
          await resolver.restartAfterPermissionGrant(restartOptions.onboardingSessionId);
        } else {
          await resolver.restart();
        }
        if (!helper || !isDefaultCuaProductHelperCurrent(helper)) {
          return {
            ok: false,
            reason: "ZCode Computer Use lifecycle is disposed.",
          };
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason: `Failed to restart ZCode Computer Use: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };
  // Dynamic-workflow user choice (docs/dynamic-workflow/launch.md “The user's choice”): the local settings file is the
  // only source, read on each use. A desktop-attached remote Host cannot read the desktop's settings; the choice is
  // pushed by desktop (zcodeAgentService.syncDynamicWorkflowUserMode), so nothing is injected here. On read failure, fall back to “follow”.
  const resolveDynamicWorkflowUserMode = isDesktopAttachedRemote
    ? undefined
    : async () => (await settingService.get()).dynamicWorkflowMode;
  const codingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient,
    credentialService,
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    resolveOffPeakModelSelectionView: async () => {
      await providerRuntime.start();
      return buildOffPeakModelSelectionView(providerRuntime.registryService.getView());
    },
  });
  // OffPeakTaskService is created in the DI registration IIFE below, after the agent service. Bind it
  // lazily through a forward-reference holder; offPeak/create protocol requests only arrive after the
  // service collection has been assembled.
  let offPeakTaskServiceForAgent: OffPeakTaskService | undefined;
  // The desktop-attached-remote setup does not expose the Off-Peak tool surface; remote use is not
  // supported.
  const offPeakToolWiring =
    options?.serviceAuthorityMode === "desktop-attached-remote"
      ? {}
      : {
          resolveOffPeakClientConfig: () => codingPlanSubscriptionService.getOffPeakClientConfig(),
          resolveOffPeakTaskService: () => offPeakTaskServiceForAgent,
        };
  // projectService is created later in this function; these closures only run on demand, after wiring.
  const prepareProjectExecution = async (projectId: string) => ({
    ...(await projectService.prepareSession({ projectId })),
    hostId: options?.projectStorageHostId ?? "local",
    workspaceIdentity: undefined,
  });
  const zcodeAgentService = createZCodeAgentService({
    prepareProjectExecution,
    prepareSessionCreation: async (target) =>
      (await taskIndexRepo.getProjectRepository()).reserveCreatedTask({
        task: { ...target, taskId: target.sessionId },
        projectId: target.projectId,
        additionalDirectories: target.additionalDirectories,
      }).additionalDirectories,
    resolveSessionDirectories: async (target) =>
      (await projectService.resolveSessionDirectories({ ...target, taskId: target.sessionId }))
        .additionalDirectories,
    ...(agentAccountProviderConfigSource
      ? { accountProviderConfigSource: agentAccountProviderConfigSource }
      : {}),
    accountRequestAuthService,
    chatGptPlanRequestAuth,
    chatGptPlanUsageRecorder: siwcAuthService,
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    ...offPeakToolWiring,
    // Unlike Off-Peak, dynamic-workflow rollout is not filtered by serviceAuthorityMode. The
    // desktop-attached-remote Host is the sole authority for its SSH/WSL/Docker workspaces, so those
    // remote workspaces also provide workflows when rollout is enabled.
    resolveDynamicWorkflowClientConfig: () =>
      codingPlanSubscriptionService.getDynamicWorkflowClientConfig(),
    ...(resolveDynamicWorkflowUserMode ? { resolveDynamicWorkflowUserMode } : {}),
    forwardDynamicWorkflowUserMode: options?.forwardDynamicWorkflowUserMode,
    commandResolver: options?.zcodeAgentCommandResolver,
    presentationSurface: resolveZCodeAgentPresentationSurface({
      runtimeSurface: options?.agentTelemetry?.runtimeSurface,
      serviceAuthorityMode: options?.serviceAuthorityMode,
      desktopContextPromptEnabled,
    }),
    onAutomationManualRunRequested: options?.onAutomationManualRunRequested,
    // Although createLocalServices exposes a reporter injection point, the previous setup did not pass
    // it to ZCodeAgentProcessManager. The host therefore never reported Agent spawn/exit to main, so
    // the process monitor could not see running Agents or verify that a read-only to writable upgrade
    // reused the same process.
    processLifecycleReporter: options?.processLifecycleReporter,
    spawnFallbackCwd: options?.zcodeAgentSpawnFallbackCwd,
    // Route browser-use execution requests through the host-to-main bridge to the agent service's
    // onRequest browserExecute handler.
    browserControlExecutor: options?.browserControlExecutor,
    // Robot credentials belong only to the authorized Host; a standalone remote service must not borrow local configuration to widen its read scope.
    channelReplyExecutor: async (value) => {
      const request = channelReplyHostRequestSchema.parse(value);
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return channelReplyResultSchema.parse(
          await options.topicResourceRelayChannel(request).call("reply", request),
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop channel reply peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.replyToChannel) throw new Error("Bot channel reply unavailable");
      return bots.replyToChannel(request);
    },
    topicResourceExecutor: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return readTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.readTopicResource) throw new Error("Topic resource service is unavailable");
      return bots.readTopicResource({ ...request, signal });
    },
    topicResourceValidator: async (request, signal) => {
      if (
        options?.topicResourceRelayChannel &&
        (isDesktopAttachedRemote || request.remoteSessionId)
      )
        return validateTopicResourceFromRelay(
          options.topicResourceRelayChannel(request),
          request,
          signal,
        );
      if (isDesktopAttachedRemote) throw new Error("Desktop topic resource peer unavailable");
      const bots = services.getOptional(IBotsService);
      if (!bots?.validateTopicResource)
        throw new Error("Topic resource authorization is unavailable");
      return bots.validateTopicResource({ ...request, signal });
    },
    // Official Server MCP identity headers: the host is the sole identity authority, and Agents request
    // them through the reverse-request path. Check provider presence in the canonical Model Selection
    // View; do not restore the old Provider Snapshot.
    officialMcpAuthHeadersResolver: createOfficialMcpAuthHeadersResolver({
      accountRequestAuthService,
      credentialService,
      modelSelectionService: providerRuntime.modelSelection,
    }),
    // The host is the identity authority boundary: validate provenance/origin here as well rather than
    // relying only on the Agent adapter's fetch wrapper. Share the implementation with the CLI through
    // @zcode/shared to avoid divergent checks. Resolve origin with resolveCurrentZCodeEndpointOrigin,
    // matching off-peak tasks (including Settings overrides); otherwise off-peak tasks could connect
    // while official MCP cannot. Pass the dev flag too, or local testing will be rejected by the host.
    officialMcpTrustedOrigins: createOfficialMcpTrustedOriginRegistry({
      devTrustedOriginsRaw: process.env[OFFICIAL_MCP_DEV_TRUSTED_ORIGINS_ENV],
      resolveZCodeApiOrigin: resolveCurrentZCodeEndpointOrigin,
    }),
    cuaOperationStateReporter: shouldEnableCuaOperationStateReporter({
      serviceAuthorityMode: options?.serviceAuthorityMode,
      hasReporter: Boolean(options?.cuaOperationStateReporter),
    })
      ? options?.cuaOperationStateReporter
      : undefined,
    // ZCode publishes only turn/session facts; the producer coordinator decides the panel terminal policy.
    ...(options?.serviceAuthorityMode === "desktop-local"
      ? {
          onCuaPipSessionLifecycle: (_workspace, event) => {
            void cuaPipSessionService.publishLifecycle(event);
          },
        }
      : {}),
    // Read the Settings HTTP proxy, No Proxy, and custom CA at spawn time and inject them into the Agent
    // process environment. This covers model API, MCP, and Bash egress and trusts certificates the user
    // explicitly configured. Changes take effect when the Agent next starts.
    resolveSpawnEnv: async (context) => {
      const [settings] = await Promise.all([settingService.get(), providerRuntime.start()]);
      // The local Host prepares the resolution snapshot; the remote CLI keeps reading and migrating configuration through its own file loader.
      if (!isDesktopAttachedRemote) await subagentsService.prepareRuntimeState(context);
      const agentNetwork =
        isDesktopAttachedRemote && options?.remoteAgentNetwork
          ? options.remoteAgentNetwork
          : {
              httpProxy: settings.httpProxy,
              noProxy: settings.httpProxyNoProxy,
            };
      const cuaPluginEnabled = isCuaEnabledForContext(context);
      let cuaProductHelperEnv: Record<string, string> = {};
      if (cuaPluginEnabled && (process.platform === "darwin" || process.platform === "win32")) {
        const brokerSocket =
          process.platform === "win32" ? getStableCuaPipeName() : resolveBrokerSocketPath();
        cuaProductHelperEnv = {
          [BROKER_SOCKET_ENV]: brokerSocket,
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: randomBytes(16).toString("hex"),
        };
        if (process.platform === "win32") {
          const recipe = await resolveStableCuaWinRecipe();
          if (recipe) {
            cuaProductHelperEnv["ZCODE_CUA_WIN_HELPER_RECIPE"] = JSON.stringify({
              ...recipe,
              hostPid: process.pid,
            });
          } else {
            cuaProductHelperEnv = {
              [BROKER_UNAVAILABLE_ENV]:
                "broker_unavailable: windows helper recipe could not be resolved",
            };
          }
        }
      }
      const telemetryEnv = getCapturedZCodeAgentTelemetryEnv();
      const telemetryConfigured = Boolean(
        telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || telemetryEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
      );
      const telemetryProfile = telemetryConfigured
        ? await oauthCredentialRepo.loadActiveUserProfile().catch(() => null)
        : null;
      const telemetryDeviceMid = telemetryConfigured
        ? options?.agentTelemetry?.getDeviceMid?.()?.trim()
        : undefined;
      // The Host is the sole writer for legacy config migration. Wait for initialization before Agent
      // spawn so a Worker cannot read a not-yet-created provider_config.json and briefly publish an
      // empty Registry.
      await providerConfigRuntime.start();
      return {
        ...buildAgentRuntimeEnv({
          httpProxy: agentNetwork.httpProxy,
          noProxy: agentNetwork.noProxy,
          caCertPath: settings.httpProxyCaCertPath,
        }),
        // Pass the authoritative origin resolved by the host (including Settings overrides) to the
        // Agent. Otherwise the Agent derives it only from env, and a test environment with a custom
        // endpoint makes the two sides validate different inputs, causing official MCP to fail closed.
        ...buildAgentEndpointOriginEnv(await resolveCurrentZCodeEndpointOrigin()),
        // Inject broker credentials (socket/token) into the Agent spawn environment so the built-in
        // zcode-cua plugin's computer-use MCP server can reconnect to the broker after __zcode-plugin-host restores its token.
        ...cuaProductHelperEnv,
        ...buildAgentTelemetrySpawnEnv({
          deviceMid: telemetryDeviceMid,
          runtimeSurface: options?.agentTelemetry?.runtimeSurface ?? "remote_workspace_host",
          telemetryEnv,
          userId: telemetryProfile?.id,
        }),
        ...createNodeProviderRuntimePathEnv({
          // The built-in Active path is isolated by the current Endpoint, so it cannot be read through
          // the synchronous fixed-path getter. Agent spawn must wait for this Endpoint Source to finish
          // resolving and materializing.
          zcodeBuiltinFilePath: await providerConfigRuntime.resolveZCodeBuiltinActiveFilePath(),
          personalFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        }),
      };
    },
    ...(!isDesktopAttachedRemote
      ? { readSubagentRuntimeConfig: subagentsService.readRuntimeConfig }
      : {}),
    ...(isDesktopAttachedRemote
      ? { sessionRuntimePreferencesAuthority: "external" as const }
      : {
          sessionRuntimePreferencesAuthority: "local" as const,
          resolveSessionRuntimePreferences: async (scope) => {
            // Budgets are unified. Optional remote configuration must not become a prerequisite for
            // creating a session on a local/mobile shared host.
            const settings = await settingService.get();
            const modelContextBudgetStrategy = DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY;
            return {
              askUserQuestionAutoResolutionEnabled:
                settings.askUserQuestionAutoResolutionEnabled !== false,
              nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
              memoryEnabled: settings.memoryEnabled === true,
              memoryIndexAsContext: settings.memoryIndexAsContext === true,
              modelContextBudgetStrategy,
              // user-execution consumes only Shell. The shared default policy is a compatibility
              // placeholder for the unified result schema and does not override the strategy fixed
              // during runtime materialization.
              ...(scope === "user-execution" && settings.integratedTerminalShell
                ? { integratedTerminalShell: settings.integratedTerminalShell }
                : {}),
            };
          },
        }),
  });
  providerConnectivityAgentService = zcodeAgentService;
  // A brief Helper health-probe timeout must not reclaim the Agent in the middle of a Computer Use
  // turn. The resolver defers restart until the next request/turn boundary. If the broker is truly
  // unavailable, the current turn fails naturally and the next request recovers it.
  hasActiveTurnRef = () => zcodeAgentService.hasActiveCuaOperationTurn();
  // The desktop-continuous UI subscribes directly to zcodeSessionService and bypasses the ZCode task
  // adapter's mapServiceEvent path. As a result, task_complete is never written to sqlite and the
  // sidebar spinner keeps running. Assemble a shared taskIndexRepo and syncer in the services layer so
  // any session entry point wakes the shadow subscription and persists runtime terminal state in sqlite.
  const zcodeTaskIndexSyncer = createZCodeTaskIndexSyncer({
    agentService: zcodeAgentService,
    taskIndexRepo,
  });
  // The plugin can be toggled at runtime. Do not let a previously created resolver continue
  // health-checking/restarting Helper after disable, and create it lazily after enable.
  // Dynamic resolver: use the same isCuaEnabledForContext gate for isPluginEnabled and Helper creation
  // (including dev mode), so development cannot pass through the resolver while a Helper already exists.
  const defaultCuaProductMcpServerResolver = createDynamicCuaProductMcpServerResolver({
    isPluginEnabled: (context) => isCuaEnabledForContext(context),
    getResolver: async () => {
      // Peek only: the resolver belongs to the managed-host system. Return undefined when no host exists;
      // under lazy startup, CUA uses node_repl and the stable socket without this resolver. Never acquire here.
      const helper = defaultCuaProductHelperLifecycle.peek()?.helper;
      return helper && isDefaultCuaProductHelperCurrent(helper) ? helper.resolver : undefined;
    },
    isResolverCurrent: (resolver) =>
      defaultCuaProductHelperLifecycle.peek()?.helper.resolver === resolver,
  });
  const cuaProductMcpServerResolver =
    options?.cuaProductMcpServerResolver ?? defaultCuaProductMcpServerResolver;
  const zcodeSessionService = createZCodeSessionService({
    agentService: zcodeAgentService,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    cuaProductMcpServerResolver,
  });
  const gitCommitMessageGenerator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        // The Git sidecar belongs to the target Environment. Read the initial model from the same Host
        // View instead of inferring model and reasoning from temporary Agent workspace state.
        return (await providerRuntime.modelSelection.getView()).preferredSelection ?? null;
      },
    },
    textGenerator: {
      async generateText(params) {
        return await zcodeAgentService.generateWorkspaceText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          selection: params.selection,
          prompt: params.prompt,
          querySource: params.querySource,
        });
      },
    },
    logger: createServiceLogger("git-commit-message"),
  });
  const gitService = createGitService({
    commitMessageGenerator: gitCommitMessageGenerator,
  });
  // The ZCode task service adapter provides the task wrapper; the ZCode agent server owns core session state.
  // The fork repository owns its tasks-index.sqlite connection for sidebar project pins.
  const forkWorkspacePinRepo = new ForkWorkspacePinRepo();
  const zcodeTaskService = createZCodeTaskServiceAdapter({
    zcodeAgentService,
    taskIndexRepo,
    taskIndexSyncer: zcodeTaskIndexSyncer,
    gitService,
    getOpenWorkspacePaths: options?.getOpenWorkspacePaths,
    settingService,
    cuaProductMcpServerResolver,
  });
  const botRemoteWorkspaceService = createBotRemoteWorkspaceService({
    parentPort: options?.parentPort,
    settingService,
    credentialService,
  });
  const oauthService = createOAuthService(credentialService, {
    apiClient,
    siwcAuthService,
    onProviderLogout: handleOAuthProviderLogout,
    onChatGptPlanSessionChange: async () => {
      // ChatGPT plan login/logout changes account entitlements; refresh the account
      // overlays so the provider appears/disappears in the registry and pickers.
      await accountProviderConfigSource.refresh("chatgpt-plan-session-changed");
    },
  });
  const zcodeJwtLogoutLogger = createServiceLogger("zcode-jwt-logout");
  zcodeJwtLogoutHandlerRef.current = (input, headers) => {
    // Conditional logout is already serialized and deduplicated. Do not discard a new credential 401
    // that arrives while waiting for the old candidate.
    void oauthService
      .logoutIfCurrentCredentialRequest(input, headers)
      .then((invalidated) => {
        // A new login may finish after the 401 is classified. Broadcast expiration only if the queued
        // operation actually cleared the old session.
        if (invalidated) {
          void broadcastService.send({
            channel: ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
            payload: {},
          });
        }
      })
      .catch((error) => {
        zcodeJwtLogoutLogger.warn("ZCode JWT logout failed", { error });
      });
  };
  // Desktop Host previously scanned Account Providers again from the Settings View. This bypassed the
  // Registry's entitlement/executable facts and could not choose uniquely when multiple plans were
  // visible. Off-peak services and Host dispatch must share the same Registry-backed credential resolver.
  const offPeakCredentialResolverDeps = {
    credentialService,
    accountRequestAuthService,
    resolveAccountProvider: async () => {
      await providerRuntime.start();
      // start caches initial readiness. After an account arrives or changes, read the Registry's most
      // recently completed snapshot.
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      const providers = snapshot.resolution.registryProviders.filter(
        (candidate) =>
          candidate.config.access.type === "zhipu-account" &&
          (candidate.config.access.mode === "individual-coding-plan" ||
            candidate.config.access.mode === "team-coding-plan"),
      );
      if (providers.length !== 1) return null;
      const provider = providers[0]!;
      const config = provider.config;
      const staticAccess = zcodeProviderAccountAccessSchema.parse(config.access.toJSON());
      const access = await accountRequestAuthService.resolveAccessCurrent(staticAccess);
      if (!access) return null;
      return {
        providerId: provider.providerId,
        access: zcodeAccountAccessSchema.parse(access),
        ...(config.api?.baseUrl ? { baseURL: config.api.baseUrl } : {}),
      };
    },
  };
  const buildOffPeakRequestAuthForTicket: OffPeakRequestAuthBuilder = async (ticketId) =>
    buildOffPeakRequestAuth({
      credentials: await resolveOffPeakCredentials(offPeakCredentialResolverDeps),
      ticketId,
    });
  const fileService = createFileService({
    workspaceFileSearchFilter: options?.workspaceFileSearchFilter,
  });
  const mediaPreviewService = createMediaPreviewService({
    fileService,
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
  });
  const conversationShareClient = new ConversationShareHttpClient({
    // The sharing runtime always uses the real API. Tests and mock scenarios must inject their behavior
    // explicitly in service unit tests or Web fixtures; the development environment must not generate
    // mock-share links that exist only in process memory by default.
    apiClient,
    baseUrl: buildRuntimeZCodeApiUrl(process.env, "/api/v1"),
    tokenProvider: async (): Promise<string | null> => {
      const activeProvider = await oauthCredentialRepo.getActiveProvider();
      if (!activeProvider) {
        return null;
      }
      const tokenSet = await oauthCredentialRepo.loadTokenSet(activeProvider);
      return tokenSet?.zcodeJwtToken ?? tokenSet?.accessToken ?? null;
    },
  });
  const conversationShareService: IConversationShareServiceType = isDesktopAttachedRemote
    ? createUnsupportedConversationShareService({
        message: "Conversation publishing is not available for remote workspaces",
      })
    : new ConversationShareService({
        zcodeAgentService,
        zcodeSessionService,
        client: conversationShareClient,
        artifactSource: createLocalConversationShareArtifactSource(),
      });
  // Lazy factories in the registration chain (such as OffPeak) create their own tasks-index sqlite
  // repositories. Collect them here and register them in the sharedSqliteRepos side table after the
  // services collection has been built and before it is returned.
  const sqliteReposToClose: Array<{ close(): void }> = [];
  const marketingAssets = createMarketingAssetRegistry({
    allowLoopback: ZCODE_ENV === "test" || process.env.NODE_ENV === "development",
  });
  // Project storage services over the tasks-index database (upstream wiring).
  const remoteProjectService = createRemoteProjectService({
    ...options?.remoteProjectConnection,
    controller: !options?.projectStorageHostId || options.projectStorageHostId === "local",
    database: () => taskIndexRepo.getOrganizationDatabase(),
    afterChange: () => broadcastService.send({ channel: "state:projects", payload: {} }),
  });
  const projectService = createProjectService({
    directories: {
      home: async () => (await systemService.info()).homedir,
      read: (params) => fileService.readdir(params),
    },
    ownerHostId: options?.projectStorageHostId,
    resolveHost: options?.resolveProjectHostService,
    repository: () => taskIndexRepo.getProjectRepository(),
    workspaceDirectory: join(projectDataRoot(), "workspace"),
    afterChange: () => broadcastService.send({ channel: "state:projects", payload: {} }),
  });
  const taskGroupService = createTaskGroupService({
    database: () => taskIndexRepo.getOrganizationDatabase(),
    resolveTasks: async (refs) => {
      // Read only the owning Host's authoritative tree; grouping never opens connections or starts an Agent.
      const hostIds = [...new Set(refs.map((task) => task.hostId))];
      const results = await Promise.all(
        hostIds.map(async (hostId) => {
          const tree = await projectService.readTree({ hostId, includeDeletedTasks: true });
          const facts = new Map(
            [
              ...tree.tasks,
              ...(tree.deletedTasks ?? []).map((task) => ({ ...task, deleted: true })),
            ].map((task) => [groupTaskKey(task), task]),
          );
          return refs
            .filter((ref) => ref.hostId === hostId)
            .flatMap((ref) => {
              const fact = facts.get(groupTaskKey(ref));
              return fact && fact.hostId === ref.hostId && fact.workspacePath === ref.workspacePath
                ? [{ ...fact, ...ref }]
                : [];
            });
        }),
      );
      return results.flat();
    },
    afterChange: () => broadcastService.send({ channel: "state:task-groups", payload: {} }),
  });
  // One-time import of fork sidebar pins into upstream project pins (specs/ui-pins-upstream-migration.md).
  // Startup must not wait on or fail because of it: a failed run is retried on the next start.
  const forkPinLog = createServiceLogger("project-pins-migration");
  void migrateForkWorkspacePinsToProjects({
    source: forkWorkspacePinRepo,
    projects: projectService,
    isDirectory: async (path) => (await stat(path).catch(() => null))?.isDirectory() ?? false,
    log: {
      info: (message, data) => forkPinLog.info(undefined, message, data),
      warn: (message, data) => forkPinLog.warn(undefined, message, data),
    },
  }).catch((error: unknown) => forkPinLog.error(undefined, "fork pin migration failed", { error }));
  const services = new ServiceCollection()
    .register(
      IMarketingTouchService,
      createMarketingTouchService({
        apiClient,
        getToken: () => credentialService.load("zcodejwttoken"),
        getDeviceMid: () => options?.agentTelemetry?.getDeviceMid?.(),
        baseUrl: buildRuntimeZCodeApiUrl(process.env, "/"),
        appVersion: ZCODE_VERSION,
        onSnapshot: (snapshot) => marketingAssets.accept(snapshot),
      }),
    )
    .register(IFileService, fileService)
    .register(IMediaPreviewService, mediaPreviewService)
    .register(
      ICloudContentService,
      createCloudContentService({
        publishedAssets: marketingAssets,
        cacheRoot: join(getContentAppConfigDir(), "cache", "content-bundles", randomUUID()),
      }),
    )
    .register(IGitService, gitService)
    .register(IGitCheckpointService, gitCheckpointService)
    .register(ISystemService, systemService)
    .register(ITerminalService, createTerminalService({ settingService }))
    .register(ISettingService, settingService)
    .register(IOnboardingRecordService, onboardingRecordService)
    .register(ICredentialService, credentialService)
    .register(IBroadcastService, broadcastService)
    .register(IZCodeTaskService, zcodeTaskService)
    .register(IZCodeAgentService, zcodeAgentService)
    .register(IZCodeSessionService, zcodeSessionService)
    .register(IProjectService, projectService)
    .register(ITaskGroupService, taskGroupService)
    .register(IRemoteProjectService, remoteProjectService)
    .register(ICuaPermissionService, cuaPermissionService)
    .register(ICuaPipSessionService, cuaPipSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService,
        zcodeTaskService,
        projectService,
        remoteProjectService,
        ownerHostId: options?.projectStorageHostId,
        broadcastService,
        settingService,
        modelSelectionService: providerRuntime.modelSelection,
        remoteWorkspaceService: botRemoteWorkspaceService,
        // Remote and local Bots both read the Model Selection View for their Environment. Remote startup
        // no longer polls the old Preset, avoiding a second source of model candidates.
        runStartupBackgroundTasks: !isDesktopAttachedRemote,
      }),
    )
    .register(IFileWatcherService, createFileWatcherService())
    .register(IOAuthService, oauthService)
    .register(
      IUsageStatsService,
      createUsageStatsService({
        apiClient,
        accountRequestAuthService,
        credentialService,
        zcodeAgentService,
        officialMcpCredentialSource,
      }),
    )
    .register(ICodingPlanSubscriptionService, codingPlanSubscriptionService)
    .register(
      IClientConfigService,
      createClientConfigService({
        apiClient,
        resolveRequestContext: async () => ({
          endpointOrigin: await resolveCurrentZCodeEndpointOrigin(),
          appVersion: ZCODE_VERSION,
          platform: `${process.platform}-${process.arch}`,
        }),
      }),
    )
    .register(IClientScenesService, createClientScenesService({ apiClient }))
    .register(
      IOffPeakTaskService,
      (() => {
        // Off-peak task orchestration service, independent of the automation service surface. This
        // collection owns the singleton; the renderer connects through ProxyChannel and host dispatch
        // uses getOptional to retrieve the same instance.
        const offPeakLogger = createServiceLogger("off-peak");
        const resolveCredentials = () => resolveOffPeakCredentials(offPeakCredentialResolverDeps);
        const originResolver = createOffPeakOriginResolver({
          logger: offPeakLogger,
          resolveUpstream: () => resolveOffPeakMockUpstream(offPeakCredentialResolverDeps),
        });
        const offPeakTaskRepo = new OffPeakTaskRepo();
        // OffPeakTaskRepo also holds a tasks-index.sqlite connection. Collect it in the array declared
        // before the registration chain, then register it after services is built. The factory runs
        // while evaluating the chain, before the services constant is initialized, so it cannot refer
        // to services directly.
        sqliteReposToClose.push(offPeakTaskRepo);
        const offPeakTaskService = new OffPeakTaskService({
          repo: offPeakTaskRepo,
          client: createOffPeakServerClient({
            resolveOrigin: originResolver.resolveOrigin,
            resolveCredentials,
            logger: offPeakLogger,
          }),
          resolveCodingPlanSupport: () =>
            resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps),
          resolveTelemetryProviderName: async () =>
            resolveSafeTelemetryHostname(await originResolver.resolveOrigin()),
          resolveModelSelection: async (input) => {
            await providerRuntime.start();
            const support = await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps);
            const providerId = support.supported
              ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
              : undefined;
            const provider = providerId
              ? providerRuntime.registryService
                  .getView()
                  .providers.find((candidate) => candidate.providerId === providerId)
              : undefined;
            const modelId = input.modelId ?? provider?.models[0]?.modelId;
            if (!provider || !modelId) {
              return {
                ok: false as const,
                validation: {
                  ok: false as const,
                  code: "provider-not-found" as const,
                  providerId: OFF_PEAK_PROVIDER_IDS.zai,
                },
              };
            }
            // Legacy rows have no Provider identity. Reuse only the Account Family already determined
            // by the current account credential chain; do not guess between Z.ai and BigModel based on
            // Registry or JSON ordering.
            const selection = {
              providerId: provider.providerId,
              modelId,
              ...(input.reasoningLevel
                ? { options: { reasoningLevel: input.reasoningLevel } }
                : {}),
            };
            const validation = providerRuntime.registryService.validateSelection(selection);
            return validation.ok
              ? { ok: true as const, selection }
              : { ok: false as const, validation };
          },
          logger: offPeakLogger,
          requestSchedulerWake: options?.onOffPeakSchedulerWakeRequested,
          stopRunningTask: async (params) => {
            await zcodeTaskService.stopGeneration({
              taskId: params.conversationId,
              workspacePath: params.workspacePath,
              ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            });
          },
          onDispose: () => {
            void originResolver.close().catch(() => undefined);
          },
        });
        offPeakTaskService.startSync();
        // Assign the forward reference for the offPeak/create and offPeak/list protocol handlers in
        // zcodeAgentService.
        offPeakTaskServiceForAgent = offPeakTaskService;
        return offPeakTaskService;
      })(),
    )
    .register(
      IHighspeedCardService,
      (() => {
        const origin = resolveRuntimeZCodeEndpointOrigin(process.env);
        const rawMockScenario = process.env.ZCODE_HIGHSPEED_MOCK_SCENARIO;
        const mockScenarios = new Set<HighspeedMockScenario>([
          "hit-fast",
          "miss",
          "hit-after-timeout",
          "existing-foreign-task-card",
          "expired-card",
        ]);
        const mockScenario = mockScenarios.has(rawMockScenario as HighspeedMockScenario)
          ? (rawMockScenario as HighspeedMockScenario)
          : null;
        const resolveHighspeedLoginHeaders = async (): Promise<Record<string, string>> => {
          const jwt = (await credentialService.load("zcodejwttoken"))?.trim() ?? "";
          if (!jwt) throw new Error("highspeed request requires zcode jwt");
          return { Authorization: /^Bearer\s/i.test(jwt) ? jwt : `Bearer ${jwt}` };
        };
        const transport = mockScenario
          ? createHighspeedMockTransport({ scenario: mockScenario })
          : createHighspeedHttpTransport({
              drawUrl: `${origin}/api/v1/highspeed/draw`,
              healthyBaseUrl: `${origin}/api/v1/highspeed/`,
              logger: createServiceLogger("highspeed"),
              drawHeaders: async () => {
                const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
                  allowMockCredentials: false,
                });
                const codingPlanAuthorization =
                  (
                    await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
                  )?.trim() ?? "";
                return buildHighspeedCodingPlanAuthHeaders({
                  zcodeJwt: credentials.jwt,
                  codingPlanAuthorization,
                  targetType:
                    credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
                  ...(credentials.organizationId
                    ? { organizationId: credentials.organizationId }
                    : {}),
                  ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
                });
              },
              healthyHeaders: resolveHighspeedLoginHeaders,
            });
        return new HighspeedCardService({
          transport,
          inferenceMode: mockScenario ? "session-default" : "highspeed",
          // Rule 11: draw is open to Coding Plan users only; the mock scenario is allowed through for local verification.
          resolveCodingPlanSupported: mockScenario
            ? async () => true
            : async () =>
                (await resolveOffPeakCodingPlanSupport(offPeakCredentialResolverDeps)).supported,
          // Rule 14: the session model must belong to the selected Coding Plan Provider's model catalog
          // (Built-in Provider Config projection) to start a new draw; the mock scenario is allowed through for local verification.
          resolveModelCovered: mockScenario
            ? async () => true
            : async (providerId, modelId) => {
                const view = await providerRuntime.modelSelection.getView();
                const provider = view.providers.find((item) => item.providerId === providerId);
                return provider?.models.some((model) => model.modelId === modelId) ?? false;
              },
          // Accelerated inference and draw share the same highspeed gateway and the same Coding Plan dual-JWT contract: requests must carry
          // the zcode JWT + Coding Plan business JWT + Team identity headers. Previously only the zcode JWT + card ID were sent, so the gateway
          // could not verify Coding Plan entitlements and returned 401 auth_failed. Reuse the same selected-connection resolution as the draw
          // headers to avoid sending a ZAI-identity card to the BigModel accelerated Provider.
          resolveInferenceAuth: async () => {
            const credentials = await resolveOffPeakCredentials(offPeakCredentialResolverDeps, {
              allowMockCredentials: false,
            });
            const codingPlanAuthorization =
              (
                await credentialService.load(`oauth:${credentials.providerFamily}:access_token`)
              )?.trim() ?? "";
            return {
              zcodeJwt: credentials.jwt,
              family: credentials.providerFamily,
              codingPlanAuthorization,
              targetType: credentials.organizationId && credentials.projectId ? "TEAM" : "PERSONAL",
              ...(credentials.organizationId ? { organizationId: credentials.organizationId } : {}),
              ...(credentials.projectId ? { projectId: credentials.projectId } : {}),
            };
          },
        });
      })(),
    )
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
    .register(
      IGenUiService,
      createGenUiService({ registerSandbox: options?.registerPluginSandbox }),
    )
    .register(IPluginUiBridgeService, pluginUiBridgeService)
    .register(IPluginUiSamplingService, pluginUiSamplingService)
    .register(IPluginUiAppToolsService, pluginUiAppToolsService)
    // The MCP/Plugin Management service merge accidentally removed plugin-sync registration. Since
    // RemoteServiceAccess still requests this channel, local candidate enumeration timed out and remote
    // synchronization could not start.
    .register(IPluginSyncService, pluginSyncService)
    .register(IPluginsService, createPluginsService({ isDesktopRuntime: true }))
    // Thin plugin-management service for Settings; the only host-side consumer of the legacy plugins/*
    // protocol terms.
    .register(IPluginManagementService, createPluginManagementService({ zcodeAgentService }))
    .register(ISubagentsService, subagentsService)
    .register(ICommandsService, createCommandsService({ isDesktopRuntime: true }))
    .register(
      IHooksService,
      createHooksService({
        grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
      }),
    )
    .register(IMemoryService, createMemoryService())
    // Each host process (Desktop local Host or remote server) reads and writes its own ~/.zcode/AGENTS.md.
    .register(IUserInstructionsService, createUserInstructionsService())
    .register(IOutputStyleService, createOutputStyleService())
    .register(ISystemPromptService, createSystemPromptService())
    .register(ISettingsSyncService, createSettingsSyncService({ settingService }))
    .register(
      IFeedbackService,
      createFeedbackService({
        ...options?.feedback,
        apiClient,
        credentialService,
        oauthService,
      }),
    )
    .register(IPromptAttachmentTransferService, createLocalPromptAttachmentTransferService());

  // Voice dictation depends on the local microphone and a local transcription model (koffi native library), so per the
  // accessor contract it is provided only by the desktop-local host; remote/standalone servers do not register it, and
  // callers fail cleanly through the optional accessor with an RPC "not found".
  // Downloads go through the host's unified network stack, inheriting proxy and self-signed certificate settings; otherwise
  // users who need a proxy cannot download models at all.
  if (options?.serviceAuthorityMode === "desktop-local") {
    services.register(
      IVoiceDictationService,
      createVoiceDictationService({ fetchImpl: hostApiNetworkTransport.fetch }),
    );
  }

  // Register the lifecycle disposer even when initially disabled. The terminal fence must precede any
  // delayed settings/acquire continuation; do not treat "no Helper now" as "no lifecycle owner needed".
  // Stop the host serially during dispose.
  registerManagedCuaHelperHostForDispose(services, {
    stop: async () => {
      await defaultCuaProductHelperLifecycle.dispose();
    },
  });
  registerHostApiNetworkTransportForDispose(services, hostApiNetworkTransport);
  // Schedule prewarming only after registering the disposer. If createLocalServices throws midway, do
  // not leave a high-privilege Helper that is unowned but starts after the current stack returns. If
  // dispose runs immediately after return, the terminal fence must take effect before acquire.
  // The Helper starts lazily and is not prewarmed: the SDK launches it on the first CUA call (the spawn
  // environment injects the stable socket), or the user's explicit authorization flow launches it via
  // restartHelper. Startup leaves no Helper running persistently.

  accountRequestAuthServices.set(services, accountRequestAuthService);
  offPeakRequestAuthBuilders.set(services, buildOffPeakRequestAuthForTicket);

  providerRuntimes.set(services, providerRuntime);
  providerProvisioningSources.set(services, providerProvisioningSource);
  providerProvisioningTriggerDisposers.set(services, providerProvisioningDisposers);
  services
    .register(IProviderSettingsService, providerRuntime.providerSettings)
    .register(IModelSelectionService, providerRuntime.modelSelection);
  if (isDesktopAttachedRemote || options.providerProvisioningTargetEnabled === true) {
    services.register(
      IProviderProvisioningTargetService,
      createProviderProvisioningTarget({
        providerRuntime,
        personalRepository: providerConfigRuntime.personalRepository,
        accountProviderSource: accountProviderConfigSource,
        credentialService,
        settingService,
        personalConfigFilePath: join(resolveAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
        stateFilePath: join(resolveAppConfigDir(), "runtime", "provider", "provisioning.json"),
        listProvisioningCredentialKeys: () =>
          listProviderProvisioningCredentialKeys(resolveCredentialFilePath(resolveAppConfigDir())),
      }),
    );
  }
  const log = createServiceLogger("provider-runtime");
  void providerRuntime.start().then(
    () => {
      const snapshot = providerRuntime.registryService.getSnapshot()!;
      log.info(undefined, "Provider Registry 已就绪", {
        configRevision: snapshot.sourceRevisions.config,
        providerCount: snapshot.registry.providers.length,
      });
    },
    (error: unknown) => {
      log.error(undefined, "Provider 配置事实初始化失败", error);
    },
  );

  // See the sharedSqliteRepos declaration comment: register every tasks-index sqlite handle so the
  // dispose chain closes them all.
  sqliteReposToClose.push(taskIndexRepo);
  sqliteReposToClose.push(forkWorkspacePinRepo);
  sharedSqliteRepos.set(services, sqliteReposToClose);
  if (options?.sourceServerWorkspaceService) {
    services.register(ISourceServerWorkspaceService, options.sourceServerWorkspaceService);
  }
  return services;
}

export function createTelemetryUserIdLoader(
  credentialService: Pick<ICredentialService, "load">,
): () => Promise<string> {
  const log = createServiceLogger("telemetry-user-id");
  return async () => {
    try {
      const activeProvider = (await credentialService.load("oauth:active_provider"))?.trim() ?? "";
      if (!activeProvider) {
        return "";
      }

      const rawUserInfo = await credentialService.load(`oauth:${activeProvider}:user_info`);
      return readTelemetryOAuthUserId(rawUserInfo);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      // Telemetry is a read-only userId reporting entry point and must not partially clean up corrupted
      // credentials before the host OAuthService runs; otherwise logout cleanup can miss derived model
      // provider keys.
      log.warn(undefined, "skip telemetry user id: OAuth credential decrypt failed", error);
      return "";
    }
  };
}

/** Return the current ZCode JWT only for the account in the same event; do not cache or modify login credentials. */
export function createTelemetryAuthorizationLoader(
  credentialService: Pick<ICredentialService, "load">,
): (userId: string) => Promise<string | null> {
  return async (userId) => {
    if (!userId) return null;
    try {
      const provider = (await credentialService.load("oauth:active_provider"))?.trim();
      if (provider !== "zai" && provider !== "bigmodel") return null;
      const readUserId = async () =>
        readTelemetryOAuthUserId(await credentialService.load(`oauth:${provider}:user_info`));
      if ((await readUserId()) !== userId) return null;
      const jwt = (await credentialService.load("zcodejwttoken"))?.trim();
      // Logout or account switching may happen during the async read. Never attach a token for the old
      // identity to an event for another account.
      if (
        (await credentialService.load("oauth:active_provider"))?.trim() !== provider ||
        (await readUserId()) !== userId
      )
        return null;
      return jwt && /^[\x21-\x7e]+$/.test(jwt) ? `Bearer ${jwt}` : null;
    } catch {
      return null;
    }
  };
}

export function createTelemetryMarketingParamsLoader(
  credentialService: ICredentialService,
): () => Promise<import("@zcode/shared").OAuthLoginAttribution | null> {
  // Recovery reason: always returning null loses saved channel attribution. Analytics should use the
  // same source of truth as OAuth.
  const repo = new OAuthCredentialRepo(credentialService);
  return () => repo.loadLoginAttribution();
}

function readTelemetryOAuthUserId(rawUserInfo: string | null): string {
  if (!rawUserInfo) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawUserInfo) as {
      id?: unknown;
      user_id?: unknown;
    };
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const userId = typeof parsed.user_id === "string" ? parsed.user_id : "";
    return id.trim() || userId.trim();
  } catch {
    return "";
  }
}

export function disposeServiceResources(services: ServiceCollection): void {
  const content = services.getOptional(ICloudContentService);
  if (content && hasDisposeAllAndWait(content)) void content.disposeAllAndWait().catch(() => {});
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // Bugfix: Before host-process exit, local services were not traversed through a shared resource cleanup path.
  // Services such as terminal/task wrappers that spawn child processes had to wait for the host itself
  // to exit, which could leave short-lived processes behind. Call each service's local disposeAll hook
  // here so app exit reliably reclaims all managed resources.
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // Synchronous best effort: terminate the managed Computer Use Helper without awaiting, so the
  // synchronous dispose path is not blocked.
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    void managedCuaHelperHost.stop().catch(() => {});
  }
  // Close shared tasks-index sqlite handles; on Windows, open handles can make later directory cleanup
  // fail with EBUSY.
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  managedHostApiNetworkTransports.get(services)?.dispose();
}

export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  (
    services.getOptional(IGenUiService) as (IGenUiService & { dispose?(): void }) | undefined
  )?.dispose?.();
  // During app shutdown, the host must wait for graceful and forceful cleanup of the Agent process tree.
  // The old synchronous dispose dropped the force-kill timer when the host exited, leaving zcode-cli or
  // app-server as orphan processes.
  const disposableServices = [
    services.getOptional(ICloudContentService),
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
    services.getOptional(ISubagentsService),
    services.getOptional(IOffPeakTaskService),
  ].filter((service) => service !== undefined);

  for (const service of disposableServices) {
    if (hasDisposeAllAndWait(service)) {
      await service.disposeAllAndWait();
    } else if (hasDisposeAll(service)) {
      service.disposeAll();
    }
  }

  // Wait for the managed Computer Use Helper to terminate (best effort). It is a long-lived, high-
  // privilege process, so service disposal must explicitly close it rather than relying only on the
  // launcher-pid watchdog or process exit as a fallback.
  const managedCuaHelperHost = managedCuaHelperHosts.get(services);
  if (managedCuaHelperHost) {
    await managedCuaHelperHost.stop().catch(() => {});
  }
  // Close shared tasks-index sqlite handles, as in disposeServiceResources; the async disposal path
  // must release them too.
  for (const repo of sharedSqliteRepos.get(services) ?? []) repo.close();
  sharedSqliteRepos.delete(services);
  providerRuntimes.get(services)?.dispose();
  for (const dispose of providerProvisioningTriggerDisposers.get(services) ?? []) dispose();
  providerProvisioningTriggerDisposers.delete(services);
  providerProvisioningSources.delete(services);
  await managedHostApiNetworkTransports
    .get(services)
    ?.disposeAndWait()
    .catch(() => {});
}
export { localRuntimeNetworkCapture } from "./zcode-agent/localRuntimeNetworkCapture.js";
export { SourceServerWorkspaceAliasRepo } from "./session/sourceServerWorkspaceAliasRepo.js";
export {
  SourceServerWorkspaceIdentityChannelServer,
  SourceServerWorkspaceIdentityMapper,
} from "./source-server-workspace/sourceServerWorkspaceIdentityChannelServer.js";
export { scopeConversationShareServiceForAttachment } from "./conversation-share/conversationShareConnectionScope.js";

/**
 * Tasks-index startup for the Source Server host. Desktop keeps its own barrier
 * (project-storage/startup.ts, run by the tasks storage worker); this entry is used only by the
 * standalone host and must finish before it opens RPC or schedulers.
 * Automations and off-peak still self-initialize on first use until their DB layer lands.
 */
export async function migrateApplicationStorage(): Promise<{ backupSkipped: boolean }> {
  const tasks = new TaskIndexRepo();
  try {
    await tasks.ensureReady();
    return { backupSkipped: false };
  } finally {
    tasks.close();
  }
}

/** Standalone Source Server assembly: one storage identity, one workspace alias owner, one identity mapper. */
export async function createServerHostServices(options: {
  topicResourceRelayChannel?: NonNullable<
    Parameters<typeof createLocalServices>[0]
  >["topicResourceRelayChannel"];
  sourceServerId: string;
  zcodeBuiltinProviderConfigFilePath: string;
  providerProvisioningTargetEnabled?: boolean;
}) {
  const projectStorageHostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: options.sourceServerId, workspacePath: "/" }),
  );
  if (!projectStorageHostId) throw new Error("Invalid Source Server storage identity");
  await migrateApplicationStorage();
  const workspaceAliasRepo = new SourceServerWorkspaceAliasRepo();
  const workspaceIdentityMapper = new SourceServerWorkspaceIdentityMapper();
  const sourceServerWorkspaceService = createSourceServerWorkspaceService(workspaceAliasRepo, {
    defaultWorkspaceIdentity: (workspacePath) =>
      buildServerRemoteWorkspaceIdentity({ serverId: options.sourceServerId, workspacePath }),
    onResolved: ({ workspacePath, canonicalWorkspaceKey }) => {
      workspaceIdentityMapper.register({
        stableIdentity: buildServerRemoteWorkspaceIdentity({
          serverId: options.sourceServerId,
          workspacePath,
        }),
        canonicalIdentity: canonicalWorkspaceKey,
      });
    },
  });
  const migrationFailedPathCount = await workspaceAliasRepo.getFailedPathCount();
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: options.providerProvisioningTargetEnabled,
    serviceAuthorityMode: "standalone-server",
    topicResourceRelayChannel: options.topicResourceRelayChannel,
    projectStorageHostId,
    sourceServerWorkspaceService,
  });
  return { services, workspaceIdentityMapper, migrationFailedPathCount };
}

// Upstream 3.16.1 barrel exports (module contracts are fork-present; these lines only expose them to the hosts).
export { createRemoteProjectService } from "#src/remote-projects/index.js";
export {
  createRemoteProjectConnectionAdmission,
  remoteProjectHostIdForProfile,
  remoteProjectHostIdForTarget,
  prepareRemoteServerConnection,
} from "#src/remote-projects/index.js";
export { createProjectWorkspaceNavigation } from "#src/project-workspace-navigation/index.js";
export { migrateControllerRemoteWorkspaceIdentity } from "./session/controllerRemoteIdentityMigration.js";
export type { ControllerRemoteIdentityMigrationReport } from "./session/controllerRemoteIdentityMigration.js";
export type { BotProjectConnection } from "#src/bot-project-runtime/contract.js";
export { prepareTasksIndexStorage } from "#src/project-storage/startup.js";
