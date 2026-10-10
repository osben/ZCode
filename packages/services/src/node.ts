/* eslint-disable max-lines -- Host-process service registration and startup wiring must stay together so dependency injection order remains easy to trace. */
// Node.js service implementations — NOT safe to import in browser code
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createNodeProviderRuntimePathEnv,
  NodeModelSelectionConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { getAppConfigDir as resolveAppConfigDir } from "./paths.js";
import {
  buildLocalMediaPreviewUrl,
  isProviderProvisioningAccountCredentialKey,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";

export {
  materializeZCodeBuiltinProviderConfig,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";

export { createFileService } from "./file/fileService.js";
export {
  attributeHostProcessTree,
  createProcessResourceSampler,
  createProcessResourceTableReader,
  type HostResourceUsageAgent,
  type ProcessResourceSample,
  type ProcessResourceSampler,
} from "./process/processResourceSampler.js";
export { createMediaPreviewService } from "./media-preview/mediaPreview.js";
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
export { ensureDeviceMid } from "./device/deviceMid.js";
export type { EnsureDeviceMidOptions } from "./device/deviceMid.js";
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
export { resolveAccountTeamPlanRuntimeApiKey } from "./model-provider/accountProviderTeamPlanRequestKey.js";
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
// The host domain reuses the existing task diff summary to populate files_changed at terminal state.
export { buildTaskChangeSummary } from "./session/taskChangeSummary.js";
export { OffPeakTaskService } from "./session/offPeakTaskService.js";
export { IOffPeakTaskService } from "./session/offPeakTask.js";
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
import { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import { IFeedbackService } from "./feedback/feedback.js";
import { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createFileService } from "./file/fileService.js";
import { createMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { WorkspaceFileSearchFilter } from "./file/workspaceFileMentionFilter.js";
import { createGitService } from "./git/gitService.js";
import { GitCommitMessageGenerator } from "./git/gitCommitMessageGenerator.js";
import { createGitCheckpointService } from "./git/gitCheckpointService.js";
import { createSystemService } from "./system/systemService.js";
import { createTerminalService } from "./terminal/terminalService.js";
import { createSettingServiceWithMigrations } from "./setting/settingService.js";
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
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { createOAuthProviderLogoutHandler } from "./oauth/oauthProviderLogout.js";
import { OAuthCredentialRepo } from "./oauth/repo/oauthCredentialRepo.js";
import { readLegacyZCodeConfigProviders } from "./model-provider/legacyZCodeConfigProviderReader.js";
import { resolveAccountTeamPlanRuntimeApiKey } from "./model-provider/accountProviderTeamPlanRequestKey.js";
import { createAccountProviderCredentialStore } from "./model-provider/accountProviderCredentialStore.js";
import { createAccountProviderCredentialService } from "./model-provider/accountProviderCredentialService.js";
import { createAccountProviderRequestAuthService } from "./model-provider/accountProviderRequestAuthService.js";
import {
  createAccountProviderConfigSource,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
} from "./model-provider/accountProviderConnectionResolver.js";
import { bindAccountProviderInvalidation } from "./model-provider/accountProviderInvalidation.js";
import { AccountProviderApiClient } from "./model-provider/accountProviderApiClient.js";
import { AccountProviderApiKeyResolver } from "./model-provider/accountProviderApiKeyResolver.js";
import { createProviderConfigRuntime } from "./model-provider/providerConfigRuntime.js";
import { fetchZCodeBuiltinRemoteRelease } from "./model-provider/zcodeBuiltinRemoteConfig.js";
import {
  createProviderRuntimeFromConfigRuntime,
  type ProviderRuntime,
} from "./model-provider/providerRuntime.js";
import {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import { createProviderSettingsConnectivityTester } from "./model-provider/providerSettingsConnectivity.js";
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
import { createPluginSyncService } from "./plugin-sync/pluginSyncService.js";
import { createPluginsService } from "./plugins/pluginsService.js";
import { createPluginManagementService } from "./plugins/pluginManagementService.js";
import { createSubagentsService } from "./subagents/subagentsService.js";
import { createCommandsService } from "./commands/commandsService.js";
import { createHooksService } from "./hooks/hooksService.js";
import { createMemoryService } from "./memory/memoryService.js";
import { createUserInstructionsService } from "./user-instructions/userInstructionsService.js";
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
import { OffPeakTaskService } from "./session/offPeakTaskService.js";
import { OffPeakTaskRepo } from "./session/offPeakTaskRepo.js";
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
  clearCuaProductHelperAgentEnvUnavailable,
  createCuaPipSessionService,
  createCuaProductMcpServerResolver,
  createProductCuaHelperHost,
  CuaHelperLifecycleManager,
  CuaProductHelperWorkspaceRegistry,
  hasCuaProductHelperAgentEnvUnavailable,
  ICuaPermissionService,
  ICuaPipSessionService,
  isCuaHelperError,
  isOfficialCuaPluginEnabledForWorkspace,
  isPotentialZCodeCuaAgentMcpServer,
  isScreenCaptureProbeSuccess,
  markCuaProductHelperAgentEnvUnavailable,
  reapOrphanedHelpers,
  shouldRunCuaScreenCaptureProbe,
  waitForCuaHelperStartup,
  type CuaHelperHost,
  type CuaHelperTransportHandle,
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
import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import { resolveBrokerSocketPath } from "@zcode/zcode-cua/broker/socketPath";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  resolveSafeEndpointHostname,
  ZCODE_JWT_INVALID_BROADCAST_CHANNEL,
  formatLogPrefix,
  isCredentialDecryptError,
  isStartPlanModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
  BIGMODEL_PROVIDER_ID,
  type ProviderFamilyDomain,
  type ServiceAuthorityMode,
  resolveRuntimeZCodeEndpointOrigin,
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

interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

const CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS = 30_000;
// Cold-start budget: the Helper's first cold launch (large Node SEA + first-time Gatekeeper/notarization
// assessment) routinely exceeds the old 5s health budget; warm it is <1s. Give the cold path
// plenty of headroom. Runs off the agent-spawn critical path (see buildCuaProductHelperAgentEnv).
const CUA_HELPER_HEALTH_TIMEOUT_MS = 30_000;
// Bounded spawn grace: give a normally signed Helper a short but realistic startup window. On real
// machines, Gatekeeper + SEA startup usually takes 300–500 ms; the old 250 ms threshold misclassified
// healthy first starts as BROKER_UNAVAILABLE.
// Fail closed only if it is still not ready after 1 second, while background startup continues to settle.
// Do not wait for the full 30-second health budget. When the Helper becomes ready, reconcileRecoveredHelper
// clears only the admission marker for future spawns and never touches existing Agents. Do not copy the
// 10-second caller wait from the feature branch.
const CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS = 1_000;

type DefaultCuaProductHelper = {
  host: ManagedCuaProductHelperHost;
  macPermissionHost?: CuaHelperHost;
  resolver: CuaProductMcpServerResolver;
};

type ManagedDefaultCuaProductHelper = {
  helper: DefaultCuaProductHelper;
  seedContext?: CuaProductMcpServerResolverContext;
};

const cuaProductHelperAgentEnvRetryAt = new WeakMap<Pick<CuaHelperHost, "start">, number>();
const cuaProductHelperTrackedStart = new WeakMap<Pick<CuaHelperHost, "start">, Promise<unknown>>();
/**
 * An agent consumed a reservation during this startup (it received a tuple reserved while the Helper was not ready).
 *
 * The revocation path is required: those spawns returned successfully and never entered catch, so no
 * existing mechanism would mark them for a later respawn if startup ultimately fails. Mark them here so
 * future spawns keep failing closed while the Helper is unavailable. Once it is ready, clear only the
 * marker and do not reclaim existing Agents.
 */
const cuaProductHelperReservedSpawns = new WeakSet<Pick<CuaHelperHost, "start">>();
/** An Agent consumed a Windows transport_ready tuple; keep the existing Agent if later full startup fails. */
const cuaProductHelperTransportSpawns = new WeakSet<Pick<CuaHelperHost, "start">>();

function trackCuaProductHelperStartup(
  host: Pick<CuaHelperHost, "start">,
  startup: Promise<unknown>,
): void {
  if (cuaProductHelperTrackedStart.get(host) === startup) return;
  cuaProductHelperTrackedStart.set(host, startup);
  void startup.then(
    () => {
      cuaProductHelperAgentEnvRetryAt.delete(host);
      cuaProductHelperReservedSpawns.delete(host);
      cuaProductHelperTransportSpawns.delete(host);
      if (cuaProductHelperTrackedStart.get(host) === startup) {
        cuaProductHelperTrackedStart.delete(host);
      }
    },
    () => {
      // The caller may already have timed out while the shared 30s startup continued. Its eventual
      // failure must still establish backoff; otherwise every new task immediately repeats install/
      // launch/health work during a persistent failure.
      cuaProductHelperAgentEnvRetryAt.set(host, Date.now() + CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS);
      if (cuaProductHelperReservedSpawns.delete(host)) {
        // An Agent holds a reserved tuple but the Helper never started. Mark future spawns fail-closed;
        // do not destroy the existing Agent.
        markCuaProductHelperAgentEnvUnavailable(host);
      }
      if (cuaProductHelperTransportSpawns.delete(host)) {
        markCuaProductHelperAgentEnvUnavailable(host);
      }
      if (cuaProductHelperTrackedStart.get(host) === startup) {
        cuaProductHelperTrackedStart.delete(host);
      }
    },
  );
}

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
) => Promise<{ apiKey: string; headers: Record<string, string> }>;
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
  return (opts.platform ?? process.platform) === "darwin" && opts.cuaEnabled;
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

export async function buildCuaProductHelperAgentEnv(
  host:
    | (Pick<CuaHelperHost, "start"> &
        Partial<
          Pick<CuaHelperHost, "running" | "checkHealth" | "reservedTransport"> & {
            waitForTransport(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
          }
        >)
    | undefined,
  logger = createServiceLogger("cua-product-helper"),
): Promise<Record<string, string>> {
  if (!host) return {};
  if (hasCuaProductHelperAgentEnvUnavailable(host)) {
    // The marker may be stale: after permission is granted or background startup completes, the Helper
    // may recover before the built-in plugin loads, with no new resolver call to clear the marker. This
    // previously left the app showing 0 tools on its next launch.
    // Run one short, bounded probe. If healthy, clear the marker and provide the current live tuple;
    // otherwise fail closed immediately. Both this path and reconcileRecoveredHelper affect admission
    // for future spawns only and do not reclaim existing Agents.
    if (host.running && host.checkHealth) {
      try {
        await host.checkHealth(CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS);
        clearCuaProductHelperAgentEnvUnavailable(host);
      } catch {
        // The Helper is still recovering (cold start or rotation in progress). Do not block; retry at the
        // next demand boundary.
      }
    }
    if (hasCuaProductHelperAgentEnvUnavailable(host)) {
      return {
        [BROKER_UNAVAILABLE_ENV]:
          "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
      };
    }
  }
  const retryAt = cuaProductHelperAgentEnvRetryAt.get(host);
  // Non-blocking design (a hard user requirement): spawn must never stall on a cold start. A warm Helper
  // (host.running) uses a quick checkHealth with a 1-second cap; healthy Helpers return in milliseconds,
  // and only unhealthy ones use the full timeout. A cold Helper with a safe reservation returns at once;
  // otherwise, race against a bounded 1-second deadline and fail closed with BROKER_UNAVAILABLE only if
  // it times out without a reservation. Shared background startup continues to settle. The resolver
  // updates admission for future spawns and provides a broker tuple at a later request boundary.
  // Never interrupt the first session asynchronously when background startup completes, and never make
  // spawn wait 10 seconds.
  //
  // Fail-closed rationale: when global CLI config contains zcode-cua, returning an empty environment
  // starts the MCP child process without broker credentials. This bypasses the authorized Helper broker
  // and makes the Python MCP process the actual TCC principal. If the broker is unavailable, return
  // BROKER_UNAVAILABLE; never return an empty environment.
  try {
    if (host.running && host.checkHealth) {
      // start() intentionally returns an existing handle without probing. Never spawn a new agent
      // with a dead Helper's stale tuple; the session resolver owns on-demand Helper restart,
      // while this lower-level spawn path fails closed until that recovery completes.
      await host.checkHealth(1000);
      // A successful resolver rotation may have recovered the same host while an earlier spawn
      // failure left a retry marker. Healthy live credentials always supersede stale backoff.
      cuaProductHelperAgentEnvRetryAt.delete(host);
      if (hasCuaProductHelperAgentEnvUnavailable(host)) {
        return {
          [BROKER_UNAVAILABLE_ENV]:
            "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
        };
      }
    } else if (retryAt && Date.now() < retryAt) {
      return {
        [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper startup retry is deferred",
      };
    }
    const startup = host.start();
    trackCuaProductHelperStartup(host, startup);
    if (host.waitForTransport) {
      // Windows named pipes cannot reserve/rename a final socket. The Helper sends
      // transport_ready once the pipe is bound; use that tuple while full health
      // (native/UIA initialization) continues in the shared startup promise.
      const transport = await waitForCuaHelperStartup(
        host.waitForTransport(CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS),
        CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS,
      );
      if (hasCuaProductHelperAgentEnvUnavailable(host)) {
        return {
          [BROKER_UNAVAILABLE_ENV]:
            "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
        };
      }
      cuaProductHelperTransportSpawns.add(host);
      cuaProductHelperAgentEnvRetryAt.delete(host);
      return {
        [BROKER_SOCKET_ENV]: transport.socketPath,
        [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: transport.pluginAuthority,
      };
    }
    // Previously, the reserved tuple was read only after a 1-second timeout, even when Host had safely
    // reserved the socket. Reuse the original admission condition to return early; the tracker above
    // still handles full startup failures.
    const reserved = host.reservedTransport;
    if (reserved && !hasCuaProductHelperAgentEnvUnavailable(host)) {
      cuaProductHelperReservedSpawns.add(host);
      cuaProductHelperAgentEnvRetryAt.delete(host);
      // This reserved path no longer supplies BROKER_TOKEN_ENV: broker token authentication has been
      // removed (connection admission uses code-signing identity). Credentials now consist only of the
      // socket and authority.
      return {
        [BROKER_SOCKET_ENV]: reserved.socketPath,
        [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: reserved.pluginAuthority,
      };
    }
    // Bounded deadline race: fail closed only if a cold launch is not ready within 1 second and has no
    // reservation. waitForCuaHelperStartup throws caller_timeout on timeout; the catch below treats this
    // as "still running in the background" and does not set retryAt.
    const handle = await waitForCuaHelperStartup(
      startup,
      CUA_PRODUCT_HELPER_SPAWN_READY_DEADLINE_MS,
    );
    // Another concurrent spawn may have timed out while this caller was waiting on the shared
    // startup. Never expose the recovered tuple while the resolver still has a pending admission marker.
    if (hasCuaProductHelperAgentEnvUnavailable(host)) {
      return {
        [BROKER_UNAVAILABLE_ENV]:
          "broker_unavailable: recovered Helper credentials are waiting for a future spawn",
      };
    }
    cuaProductHelperAgentEnvRetryAt.delete(host);
    return {
      [BROKER_SOCKET_ENV]: handle.socketPath,
      [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: handle.pluginAuthority,
    };
  } catch (error) {
    // caller_timeout only means the shared 30-second startup is still running in the background.
    // trackCuaProductHelperStartup sets backoff if startup actually fails. Backing off here could wrongly
    // disable a Helper that has already become ready for later Agents.
    const isCallerTimeout = isCuaHelperError(error) && error.code === "caller_timeout";
    if (isCallerTimeout) {
      // Cold-start rendezvous: the Helper is starting, but the host has claimed the final socket and
      // reserved a tuple. The credentials are usable: the host placeholder owns the final path, and the
      // unverified Helper is bound to .pending and cannot reach it. A client that connects to the
      // placeholder is immediately destroyed and retries with broker_unavailable backoff. Once the
      // Helper is verified, the host atomically renames the socket, and the retry reaches the real Helper.
      //
      // This branch rejects only this Agent's CUA MCP admission while the Helper is not ready. Once it is
      // ready, it affects only future Agent spawns; lifecycle operations must not tear down existing sessions.
      const reserved = host.reservedTransport;
      if (reserved && !hasCuaProductHelperAgentEnvUnavailable(host)) {
        // Check the unavailable marker first; do not provide a tuple before admission recovery is complete.
        cuaProductHelperReservedSpawns.add(host);
        cuaProductHelperAgentEnvRetryAt.delete(host);
        return {
          [BROKER_SOCKET_ENV]: reserved.socketPath,
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: reserved.pluginAuthority,
        };
      }
    }
    markCuaProductHelperAgentEnvUnavailable(host);
    if (!isCallerTimeout) {
      cuaProductHelperAgentEnvRetryAt.set(host, Date.now() + CUA_PRODUCT_HELPER_AGENT_ENV_RETRY_MS);
    }
    logger.warn(
      undefined,
      `Computer Use Helper broker_unavailable; disabling workspace zcode-cua MCP server for this agent spawn (${cuaHelperStartErrorDetail(error)})`,
    );
    return {
      [BROKER_UNAVAILABLE_ENV]: isCallerTimeout
        ? // Cold startup is still running in the background. Report "warming up"; once the Helper is
          // ready, reconcileRecoveredHelper clears only the future-spawn marker.
          "broker_unavailable: helper broker warming up"
        : `broker_unavailable: ${cuaHelperStartErrorDetail(error)}`,
    };
  }
}

function cuaHelperStartErrorDetail(error: unknown): string {
  return isCuaHelperError(error)
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * Create a ServiceCollection containing all local services.
 *
 * @param options.parentPort - The Electron host process's parentPort, used by BroadcastService to relay
 *        events across windows. Pass null to make broadcasts a no-op.
 */
export function createLocalServices(options: {
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
  feedback?: Partial<
    Omit<CreateFeedbackServiceOptions, "apiClient" | "credentialService" | "oauthService">
  >;
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
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
  agentRuntimeContext?: {
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
    console.error(formatLogPrefix("appCaCert", process.pid), "ensure app CA cert failed:", error);
  }

  const localSettings = options?.settingService ? null : createSettingServiceWithMigrations();
  const settingService = createObservableSettingService(
    options?.settingService ?? localSettings!.service,
  );
  const resolveCurrentZCodeEndpointOrigin = async () =>
    resolveRuntimeZCodeEndpointOrigin(process.env, {
      overrideOrigin: (await settingService.get()).zcodeEndpointOrigin,
    });
  const provisioningOAuthKeys = new Set<string>(PROVIDER_PROVISIONING_OAUTH_CREDENTIAL_KEYS);
  const credentialService = createCredentialService({
    onDidMutate: ({ key }) => {
      if (provisioningOAuthKeys.has(key) || isProviderProvisioningAccountCredentialKey(key)) {
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
    resolveZCodeEndpointOrigin: resolveCurrentZCodeEndpointOrigin,
  });
  const systemService = createSystemService();
  // Onboarding eligibility and the task list share the same global tasks-index. The repo loads the
  // database lazily, so constructing it early adds no startup I/O; the session syncer reuses this instance.
  const taskIndexRepo = new TaskIndexRepo();
  // Onboarding completion record; fill userId from the login state (null for API-key or logged-out sessions).
  const onboardingRecordService = createOnboardingRecordService({
    loadUserId: async () => (await oauthCredentialRepo.loadActiveUserProfile())?.id ?? null,
    hasExistingLocalTask: async () => (await taskIndexRepo.listTaskMetas({})).length > 0,
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
  const accountProviderApiKeyRemoteClient = new AccountProviderApiClient(apiClient);
  const accountProviderApiKeyResolver = new AccountProviderApiKeyResolver(
    accountProviderApiKeyRemoteClient.fetchRemoteData.bind(accountProviderApiKeyRemoteClient),
  );
  const accountProviderCredentialService = createAccountProviderCredentialService({
    credentialStore: accountProviderCredentialStore,
    async loadOAuthAccessToken(family) {
      const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
      return (await oauthCredentialRepo.loadTokenSet(oauthProviderId))?.accessToken ?? null;
    },
    resolveProviderApiKey: (family, accessToken) =>
      accountProviderApiKeyResolver.resolveProviderApiKey(
        family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID,
        accessToken,
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
  const accountRequestAuthService = createAccountRequestAuthService(
    createAccountProviderRequestAuthService({
      resolveCurrentAccountAccess: (access) =>
        resolveCurrentAccountAccess({
          access,
          readSettings: readAccountProviderSettings,
          loadAccountIdentity,
        }),
      loadOAuthTokenSet: (providerId) => oauthCredentialRepo.loadTokenSet(providerId),
      async loadIndividualPlanApiKey(providerId, family) {
        const oauthProviderId = family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
        const accountIdentity = (await oauthCredentialRepo.loadUserProfile(oauthProviderId))?.id;
        if (!accountIdentity) return null;
        return accountProviderCredentialService.loadCodingPlanApiKey({
          providerId,
          family,
          accountIdentity,
        });
      },
      resolveTeamPlanApiKey: (access) =>
        resolveAccountTeamPlanRuntimeApiKey({ apiClient, credentialService, access }),
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
    configSource: providerConfigRuntime.configService,
    readSettings: readAccountProviderSettings,
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
  const providerRuntime = createProviderRuntimeFromConfigRuntime({
    configRuntime: providerConfigRuntime,
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
  const subagentsService = createSubagentsService({
    isDesktopRuntime: true,
  });
  const commandsService = createCommandsService({ isDesktopRuntime: true });
  const hooksService = createHooksService({
    grantWorkspaceHookTrust: (params) => zcodeAgentService.grantWorkspaceHookTrust(params),
  });
  const memoryService = createMemoryService();
  // Once the current process has a Provider Runtime, that Environment's own Selection View determines
  // execution readiness. Desktop-attached remote also reads its own remote Config/Account Facts.
  const modelSelectionReadinessSource = providerRuntime.modelSelection;
  const agentAccountProviderConfigSource = accountProviderConfigSource;
  // ===== Computer Use Helper lifecycle layer (port from the feature branch) =====
  // Root-cause fix: agents pre-spawned during app startup can run before the broker is ready. If
  // buildCuaProductHelperAgentEnv cannot get a ready Helper within the 1-second grace period, it returns
  // BROKER_UNAVAILABLE and those Agents fail closed for the computer-use MCP server. Later conversations
  // may reuse them, so Helper lifecycle changes must not rebuild Agents.
  // Constraints: (1) bounded spawn grace, failing closed after 1 second without waiting for the full
  // health budget; (2) lazily obtain the lifecycle coordinator and use a generation fence, with dispose
  // only from an explicit workspace lifecycle; (3) do not add periodic health probes; call checkHealth
  // only at on-demand boundaries such as CUA spawn/resolve; (4) restart the Helper while reusing the host
  // transport whenever possible, leaving existing Agent sessions, processes, and MCP streams unchanged.
  const cuaProductHelperWorkspaceRegistry = new CuaProductHelperWorkspaceRegistry();
  // createDefaultCuaProductHelper() must assemble the resolver before zcodeAgentService exists, but the
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
    const socketPath = resolveBrokerSocketPath();
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
    // standaloneHelperCandidatePaths is not in the upstream exports allowlist, so enumerate install
    // candidates here using the same rules (dev-desktop gets the dev/ prefix; app names always come
    // from helperConstants rather than string literals).
    const home = process.env.ZCODE_HOME?.trim() || join(homedir(), ".zcode");
    const baseRoot = join(home, "computer-use");
    // See upstream helperLauncher.resolveCuaHelperInstallRoot for the install layout: dev uses its own
    // `dev/` subroot and DEV_HELPER_APP_NAME; preview uses its own `preview/` subroot but keeps the
    // stable app name. Separate roots prevent builds with different IDs from overwriting each other;
    // they do not indicate a rename.
    // Enumerating only HELPER_APP_NAME means dev can never find a candidate, so launching from Settings
    // silently fails and permissions appear unknown. Keep both dev names because a one-click dev bundle
    // may also be installed under the stable name.
    const candidates = [
      join(baseRoot, "dev", DEV_HELPER_APP_NAME),
      join(baseRoot, "dev", HELPER_APP_NAME),
      join(baseRoot, HELPER_APP_NAME),
      join(baseRoot, "preview", HELPER_APP_NAME),
    ];
    const appPath = candidates.find((candidate) => existsSync(candidate));
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
      if (process.platform !== "darwin") {
        return {
          available: false,
          reason: "CUA permissions are only available on macOS.",
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
          stable = await launchStandaloneCuaHelperForStatus();
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
  const codingPlanSubscriptionService = createCodingPlanSubscriptionService({
    apiClient,
    credentialService,
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
  const zcodeAgentService = createZCodeAgentService({
    ...(agentAccountProviderConfigSource
      ? { accountProviderConfigSource: agentAccountProviderConfigSource }
      : {}),
    accountRequestAuthService,
    ...(modelSelectionReadinessSource ? { modelSelectionReadinessSource } : {}),
    authorizeLocalMediaPreviewPath: options?.authorizeLocalMediaPreviewPath,
    ...offPeakToolWiring,
    // Unlike Off-Peak, dynamic-workflow rollout is not filtered by serviceAuthorityMode. The
    // desktop-attached-remote Host is the sole authority for its SSH/WSL/Docker workspaces, so those
    // remote workspaces also provide workflows when rollout is enabled.
    resolveDynamicWorkflowClientConfig: () =>
      codingPlanSubscriptionService.getDynamicWorkflowClientConfig(),
    commandResolver: options?.zcodeAgentCommandResolver,
    presentationSurface: resolveZCodeAgentPresentationSurface({
      runtimeSurface: options?.agentRuntimeContext?.runtimeSurface,
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
      // Import legacy overrides for built-in Subagents before the CLI reads them independently; do not
      // wait for a Settings action.
      await subagentsService.prepareRuntimeState();
      const agentNetwork =
        isDesktopAttachedRemote && options?.remoteAgentNetwork
          ? options.remoteAgentNetwork
          : {
              httpProxy: settings.httpProxy,
              noProxy: settings.httpProxyNoProxy,
            };
      // Use the same gate as Helper creation (isCuaEnabledForContext: dev/internal feature OR official
      // plugin enablement), so dev mode cannot create a Helper while resolveSpawnEnv omits its broker env.
      const cuaPluginEnabled = isCuaEnabledForContext(context);
      // Lazy startup: on darwin, spawn never calls acquire to launch the Helper. Reuse the tuple from
      // an existing host (peek, for example after an authorization flow); otherwise inject only the
      // stable socket and let the SDK launch the Helper on its first CUA call. Host startup and spawn do
      // not keep the Helper running. Keep acquire on win32 (token mode).
      const peekedHelper = defaultCuaProductHelperLifecycle.peek()?.helper;
      const helper = !cuaPluginEnabled
        ? undefined
        : peekedHelper && isDefaultCuaProductHelperCurrent(peekedHelper)
          ? peekedHelper
          : process.platform === "darwin"
            ? undefined
            : await getOrCreateDefaultCuaProductHelper(context);
      // setting.get and lifecycle queues can outlive host disposal. Checking only the earlier enabled
      // value could let a delayed resolveSpawnEnv resume after the terminal fence and restart the
      // Helper. Recheck the generation immediately before building the environment.
      const cuaProductHelperHost =
        helper && isDefaultCuaProductHelperCurrent(helper) ? helper.host : undefined;
      // Register before waiting for the Helper to start. The registry records only workspaces that
      // attempted admission, for later configuration/lifecycle bookkeeping. Recovery clears only the
      // marker; it does not reclaim existing Agents.
      cuaProductHelperWorkspaceRegistry.setEnabled(context, Boolean(cuaProductHelperHost));
      let cuaProductHelperEnv: Record<string, string> = {};
      if (!helper && cuaPluginEnabled && process.platform === "darwin") {
        // Lazy startup: when no managed host exists, inject the stable socket without a token (identity
        // mode) or pluginAuthority (only the host validates it, so it has no purpose without a host).
        // The SDK's ensureBrokerAvailable launches the Helper. pluginAuthority is a random config-provenance
        // value inside the Agent process: bootstrap captures it in the node_repl config environment, and
        // core compares the values to prove the config came from this bootstrap rather than a user file.
        // It does not require a host. The host mints it in managed mode; lazy mode mints it per spawn with
        // the same meaning and validation.
        cuaProductHelperEnv = {
          [BROKER_SOCKET_ENV]: resolveBrokerSocketPath(),
          [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: randomBytes(16).toString("hex"),
        };
        cuaProductHelperWorkspaceRegistry.setEnabled(context, false);
      } else if (cuaProductHelperHost && helper) {
        const candidateEnv = await buildCuaProductHelperAgentEnv(
          cuaProductHelperHost,
          createServiceLogger("cua-product-helper"),
        );
        // host.start/checkHealth also await, and dispose can set the terminal fence during that wait.
        // Recheck the generation before returning the spawn environment. If it is stale, mark the
        // Helper unavailable; never give a reclaimed tuple to an Agent that arrives late.
        if (isDefaultCuaProductHelperCurrent(helper)) {
          cuaProductHelperEnv = candidateEnv;
        } else {
          cuaProductHelperWorkspaceRegistry.setEnabled(context, false);
          cuaProductHelperEnv = {
            [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper lifecycle is disposed",
          };
        }
      } else if (cuaPluginEnabled && defaultCuaProductHelperLifecycle.disposed) {
        cuaProductHelperEnv = {
          [BROKER_UNAVAILABLE_ENV]: "broker_unavailable: helper lifecycle is disposed",
        };
      }
      const telemetryEnv = getCapturedZCodeAgentTelemetryEnv();
      const telemetryConfigured = Boolean(
        telemetryEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || telemetryEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
      );
      const telemetryProfile = telemetryConfigured
        ? await oauthCredentialRepo.loadActiveUserProfile().catch(() => null)
        : null;
      const telemetryDeviceMid = telemetryConfigured
        ? options?.agentRuntimeContext?.getDeviceMid?.()?.trim()
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
        // zcode-cua plugin's computer-use MCP server can reconnect to the broker after
        // __zcode-plugin-host restores its token. cuaProductHelperEnv above already validates the
        // generation and handles unavailable state, replacing the old staging-side call to
        // buildCuaProductHelperAgentEnv.
        ...cuaProductHelperEnv,
        ...buildAgentTelemetrySpawnEnv({
          deviceMid: telemetryDeviceMid,
          runtimeSurface: options?.agentRuntimeContext?.runtimeSurface ?? "remote_workspace_host",
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
  const zcodeTaskService = createZCodeTaskServiceAdapter({
    zcodeAgentService,
    taskIndexRepo,
    taskIndexSyncer: zcodeTaskIndexSyncer,
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
    onProviderLogout: handleOAuthProviderLogout,
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
  const services = new ServiceCollection()
    .register(IFileService, fileService)
    .register(IMediaPreviewService, mediaPreviewService)
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
    .register(ICuaPermissionService, cuaPermissionService)
    .register(ICuaPipSessionService, cuaPipSessionService)
    .register(IConversationShareService, conversationShareService)
    .register(
      IBotsService,
      createBotsService({
        credentialService,
        zcodeTaskService,
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
            resolveSafeEndpointHostname(await originResolver.resolveOrigin()),
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
    .register(ISkillsService, skillsService)
    .register(ISkillSyncService, createSkillSyncService())
    .register(IMcpSyncService, mcpSyncService)
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
      log.info("Provider Registry 已就绪", {
        configRevision: snapshot.sourceRevisions.config,
        providerCount: snapshot.registry.providers.length,
      });
    },
    (error: unknown) => {
      log.error("Provider 配置事实初始化失败", error);
    },
  );

  // See the sharedSqliteRepos declaration comment: register every tasks-index sqlite handle so the
  // dispose chain closes them all.
  sqliteReposToClose.push(taskIndexRepo);
  sharedSqliteRepos.set(services, sqliteReposToClose);
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
  // Before host-process exit, local services were not traversed through a shared resource cleanup path.
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
  // During app shutdown, the host must wait for graceful and forceful cleanup of the Agent process tree.
  // The old synchronous dispose dropped the force-kill timer when the host exited, leaving zcode-cli or
  // app-server as orphan processes.
  const disposableServices = [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IBotsService),
    services.getOptional(IFileWatcherService),
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
