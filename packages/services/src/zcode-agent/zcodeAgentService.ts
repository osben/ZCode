import { isAuxiliarySessionKind } from "@zcode/shared";
import {
  pluginUiToolResultNotificationSchema,
  type PluginUiToolResultNotification,
} from "@zcode/shared/mcp-apps";
import {
  offPeakControlParamsSchema,
  offPeakControlResultSchema,
  offPeakLifecycleNotificationSchema,
  type OffPeakLifecycleNotification,
  type OffPeakControlParams,
} from "@zcode/shared";
import {
  requiresRequestVerification,
  allowRequestVerificationHeaders,
  requestVerificationInteractionAvailable,
} from "@zcode/shared";
import { zcodeMcpUiSamplingResultSchema } from "@zcode/shared";
import {
  isChatGptPlanAccountProviderId,
  parseChatGptPlanAccountProviderId,
  zcodeChatGptPlanUsageUpdatedParamsSchema,
  type SiwcPlanUsageSnapshot,
} from "@zcode/shared";
import { MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS } from "@zcode/shared/mcp-apps";
import {
  channelReplyRequestSchema,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
} from "@zcode/shared";
import { requestPluginReferenceCatalog } from "#src/zcode-agent/pluginReferenceCatalogRequest.js";
import {
  localTtftFactsSchema,
  sessionDebugSnapshotSchema,
  type LocalTtftFacts,
} from "@zcode/shared";
/* oxlint-disable eslint(max-lines) -- ZCode Protocol transport, notification wiring, and app-facing session methods must share the same client/emitter context. */
import {
  ensureIncognitoSupport,
  ensureDurableFirstSubmissionSupport,
  ensureIndependentPlanSupport,
  supportsHistoryFirst,
} from "./runtimeCapabilitySupport.js";
import { createHash, randomUUID } from "node:crypto";
import { createTopicResourceBridge } from "./topicResourceBridge.js";
import { uploadTopicResourceToClient } from "./topicResourceUpload.js";
import {
  zcodeTopicResourceCancelParamsSchema,
  type ZCodeTopicResourceReadParams,
  type ZCodeProtocolTrace,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import type { IDisposable } from "@zcode/rpc";
import type {
  AccountProviderConfigSnapshot,
  ModelSelectionView,
  ProviderSource,
} from "@zcode/provider";
import { completeNewModelSelection } from "@zcode/provider";
import type { OffPeakClientConfig } from "#src/coding-plan-subscription/codingPlanSubscription.js";
import {
  subagentRuntimeConfigSchema,
  zcodeSubagentsReadRuntimeConfigParamsSchema,
  type SubagentRuntimeConfig,
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  resolveWorkspaceKey,
  type TraceId,
  ZCODE_AGENT_PROVIDER,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
  ZCODE_MODEL_REASONING_SEPARATOR,
  isRemoteWorkspaceIdentity,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeMcpListResultSchema,
  zcodePermissionRequestParamsSchema,
  zcodeBrowserListParamsSchema,
  zcodeBrowserExecuteParamsSchema,
  zcodePluginsConfigureResultSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsMarketplaceMutationResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodeProcessChildProcessesResultSchema,
  type ZCodeProcessChildProcess,
  zcodeSkillsReferenceCatalogResultSchema,
  zcodeMcpReadResourceResultSchema,
  zcodeMcpUiCallToolResultSchema,
  zcodeMcpUiCancelCallResultSchema,
  zcodeMcpUiReadResourceResultSchema,
  zcodeMcpUiListResourcesResultSchema,
  zcodeMcpUiAppToolAcceptedResultSchema,
  zcodeMcpUiRegisterAppToolsResultSchema,
  zcodeMcpUiUnregisterAppToolsResultSchema,
  zcodeMcpUiListResourceTemplatesResultSchema,
  zcodeMcpUiResourceSubscriptionResultSchema,
  zcodePluginsListUiSurfacesResultSchema,
  zcodeWorkflowsDeleteResultSchema,
  zcodeWorkflowsForRunResultSchema,
  zcodeWorkflowsGetResultSchema,
  zcodeWorkflowsListResultSchema,
  zcodeWorkflowsMoveResultSchema,
  zcodeWorkflowsRunsResultSchema,
  zcodeWorkflowsSaveResultSchema,
  zcodeWorkflowsUpdateMetaResultSchema,
  zcodePluginsResolveSuggestedReferenceResultSchema,
  zcodePluginOperationProgressNotificationSchema,
  zcodePluginsRestoreBuiltinResultSchema,
  zcodePluginsSetEnabledResultSchema,
  zcodePluginsCancelOperationResultSchema,
  zcodePluginsUninstallResultSchema,
  zcodePluginsValidateResultSchema,
  zcodePluginsDescribeResultSchema,
  zcodeLspPreferencesGetResultSchema,
  zcodeLspPreferencesSetResultSchema,
  zcodeLspStatusResultSchema,
  zcodeAutomationCheckTaskBindingParamsSchema,
  zcodeAutomationCreateParamsSchema,
  zcodeAutomationDeleteParamsSchema,
  zcodeAutomationListParamsSchema,
  zcodeAutomationUpdateParamsSchema,
  zcodeOffPeakCreateParamsSchema,
  zcodeOffPeakListParamsSchema,
  OFF_PEAK_PROVIDER_IDS,
  zcodeComputerUseOperationEventSchema,
  zcodeProviderRuntimeHeadersCancelledSchema,
  zcodeProviderRuntimeHeadersRequestParamsSchema,
  zcodeProviderRefreshRegistryResultSchema,
  zcodeProviderTestModelConnectivityResultSchema,
  zcodeOfficialMcpAuthHeadersRequestParamsSchema,
  summarizeOfficialMcpIdentityHeaders,
  zcodeProtocolEmptyResultSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeMcpTelemetryEventSchema,
  zcodeMcpResourceSamplesSchema,
  zcodeToolExecResourceSchema,
  zcodeProcessResourceSampleSchema,
  zcodeSessionCloseResultSchema,
  zcodeSessionCompactResultSchema,
  zcodeSessionEventsResultSchema,
  zcodeSessionGoalResultSchema,
  zcodeSessionListResultSchema,
  zcodeSessionSubagentsResultSchema,
  zcodeSessionTreeCountsResultSchema,
  zcodeSessionEraseTreeResultSchema,
  zcodeSessionMessagesResultSchema,
  zcodeSessionEventSchema,
  zcodeSessionSendResultSchema,
  zcodeSessionRequestRuntimePreferencesParamsSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeSessionSubscribeResultSchema,
  zcodeStateUpdatedNotificationSchema,
  zcodeUserInputRequestParamsSchema,
  zcodeWorkspacePresentationSchema,
  zcodeWorkspaceCancelGenerateTextResultSchema,
  zcodeWorkspaceGenerateTextResultSchema,
  zcodeWorkspaceHookTrustGrantResultSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
  zcodeProviderUpdateAccountConfigResultSchema,
  type ZCodeSessionStateSnapshot,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
  zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
  type DynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  isDynamicWorkflowModeEnabled,
  normalizeDynamicWorkflowMode,
  type AgentLaneResourceSample,
  type ProcessResourceCliLane,
  type ZCodeMcpTelemetryEvent,
  type ZCodeMcpResourceSample,
  type ZCodeToolExecResource,
  type ZCodePluginOperationProgressNotification,
  type ZCodeTaskMode,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { createOfficialMcpIssuanceAudit } from "#src/official-mcp/officialMcpIssuanceAudit.js";
import type {
  AccountRequestAuthMaterial,
  IAccountRequestAuthService,
} from "#src/model-provider/accountRequestAuthService.js";
import {
  mergeAutomationMutationToolDenylist,
  mergeOffPeakMutationToolDenylist,
} from "#src/zcode-agent/automationToolPolicy.js";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./zcodeAgent.js";
import type {
  ZCodeProtocolRequestId,
  ModelSelection,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeProviderRuntimeHeadersCancelled,
  ZCodeSessionEvent,
  ZCodeSessionRuntimePreferencesScope,
  ZCodeSavedWorkflowScope,
  ZCodeStateUpdatedNotification,
  ZCodeWorkspacePresentation,
  ZCodeWorkspaceRef,
  ZCodeSessionRuntimePreferencesResult,
} from "@zcode/shared";
import type {
  IZCodeAgentService,
  ZCodeAgentBackgroundBashOutputParams,
  ZCodeAgentAppRuntimePreferences,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentAppUsageParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentCompactParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentGenerateWorkspaceTextParams,
  ZCodeAgentTestModelConnectivityParams,
  ZCodeAgentGoalParams,
  ZCodeAgentGrantWorkspaceHookTrustParams,
  ZCodeAgentInitializeResult,
  ZCodeAgentListSessionsParams,
  ZCodeAgentListSessionSubagentsParams,
  ZCodeAgentReadWorkspacePresentationParams,
  ZCodeAgentReadSessionEventsParams,
  ZCodeAgentReadSessionMessagesParams,
  ZCodeAgentReadSessionParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRespondProviderRuntimeHeadersParams,
  ZCodeAgentRespondSessionRuntimePreferencesParams,
  ZCodeAgentResumeSessionParams,
  ZCodeAgentSendPromptParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionSubscribeParams,
  ZCodeAgentSessionTarget,
  ZCodeAgentSessionTreeParams,
  ZCodeAgentSessionRuntimePreferencesRequest,
  ZCodeAgentTaskTokenUsageParams,
  ZCodeAgentSetModeParams,
  ZCodeAgentSetModelParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentSetLspPreferencesParams,
  ZCodeAgentSetThoughtLevelParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentSkillReferenceCatalogParams,
  ZCodeAgentReadMcpResourceParams,
  ZCodeAgentCallMcpToolForUiParams,
  ZCodeAgentCancelMcpToolCallForUiParams,
  ZCodeAgentReadMcpResourceForUiParams,
  ZCodeAgentListMcpResourcesForUiParams,
  ZCodeAgentAppToolCallForUiParams,
  ZCodeAgentAppToolInstanceForUiParams,
  ZCodeAgentRegisterAppToolsForUiParams,
  ZCodeAgentResolveAppToolCallForUiParams,
  ZCodeAgentMcpResourceSubscriptionForUiParams,
  ZCodeAgentDeleteSavedWorkflowParams,
  ZCodeAgentFindSavedWorkflowForRunParams,
  ZCodeAgentGetSavedWorkflowParams,
  ZCodeAgentListSavedWorkflowRunsParams,
  ZCodeAgentListSavedWorkflowsParams,
  ZCodeAgentMoveSavedWorkflowParams,
  ZCodeAgentSaveSavedWorkflowFromRunParams,
  ZCodeAgentSavedWorkflowTarget,
  ZCodeAgentUpdateSavedWorkflowMetaParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentValidatePluginParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentListMcpServerStatusesParams,
  ZCodeAgentWorkspaceTarget,
  ZCodeAgentCuaPermissionObservation,
  ZCodeAgentCreateAutomationParams,
  ZCodeAgentUpdateAutomationParams,
  ZCodeAgentAutomationIdParams,
  ZCodeAgentSetAutomationEnabledParams,
  ZCodeAgentDeleteAutomationRunParams,
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentReadParams,
  ZCodeAgentConversationAttachmentReadParams,
  ZCodeAgentConversationAttachmentStatParams,
  ZCodeAgentAttachmentPreviewSourceParams,
  ZCodeAgentAttachmentTerminalParams,
  ZCodeAgentConversationCommandParams,
  ZCodeAgentCommandsQueryParams,
  ZCodeAgentConversationFileChangesParams,
  ZCodeAgentConversationFileRewindPreviewParams,
  ZCodeAgentConversationRowsRangeParams,
  ZCodeAgentConversationPlansParams,
  ZCodeAgentConversationWorkflowRunEventsParams,
  ZCodeAgentConversationWorkflowRunArtifactDataParams,
  ZCodeAgentConversationWorkflowRunArtifactReadParams,
  ZCodeAgentConversationWorkflowRunArtifactsParams,
  ZCodeAgentConversationWorkflowRunNodeResultParams,
  ZCodeAgentConversationWorkflowRunWorkspaceParams,
  ZCodeAgentConversationWorkflowRunsParams,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationSubscribeParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentConnectionFlowParams,
  ZCodeAgentSessionsIndexSubscribeParams,
  ZCodeAgentWorkspaceConfigSubscribeParams,
} from "./zcodeAgent.js";
import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  V4_WIRE_PROTOCOL_VERSION,
  PROTOCOL_V4_LIMITS,
  clientHelloSchema,
  commandAckSchema,
  commandPayloadSchemas,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  conversationTopic,
  conversationTopicWireCandidateSchema,
  conversationTelemetryFactSchema,
  cuaPermissionObservationSchema,
  sessionsIndexTopic,
  sessionsIndexReconcileResultSchema,
  sessionsIndexTopicWireCandidateSchema,
  MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE,
  V4_METHODS,
  V4_NOTIFICATIONS,
  v4AttachmentAbortResultSchema,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4AttachmentReadResultSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  v4ConnectionFlowResultSchema,
  v4ConversationFileChangesResultSchema,
  v4ConversationFileRewindPreviewResultSchema,
  v4ConversationRowsRangeResultSchema,
  v4ConversationPlansResultSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4ConversationResyncResultSchema,
  v4ConversationSubscribeResultSchema,
  v4ConversationUsageResultSchema,
  v4SessionsIndexSubscribeResultSchema,
  v4UsageStatsResultSchema,
  v4WorkspaceConfigSubscribeResultSchema,
  workspaceConfigTopic,
  workspaceConfigTopicWireCandidateSchema,
  utf8JsonByteLength,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  type CommandAck,
  type ConversationTopicWireCandidate,
  type ConversationTelemetryFact,
  type SessionsIndexTopicWireCandidate,
  type WorkspaceConfigTopicWireCandidate,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import {
  readTrustedZCodeAgentV4Connection,
  readTrustedZCodeAgentV4UnsubscribeRoute,
  type ZCodeAgentV4ConnectionContext,
} from "./zcodeAgentConnectionScope.js";
import { createBackgroundSessionEventCoalescer } from "#src/zcode-agent/zcodeSessionEventCoalescer.js";
import { AutomationService } from "#src/session/automationService.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { ZCodeAgentMcpStatusModeUnsupportedError } from "#src/zcode-agent/zcodeAgentErrors.js";
import { ZCodeAgentProcessManager } from "./zcodeAgentProcessManager.js";
import type { ZCodeAgentProcessManagerOptions } from "./zcodeAgentProcessManager.js";
import type { IOffPeakTaskService } from "#src/session/offPeakTask.js";
import {
  ZCodeProtocolRequestTimeoutError,
  type ZCodeProtocolClient,
} from "./zcodeProtocolClient.js";
import { getDataBaseDir } from "../paths.js";
import {
  collectBrowserAmbientContext,
  type BrowserAmbientContextExecutor,
} from "./zcodeAgentBrowserAmbientContext.js";
import {
  createCuaOperationTurnTracker,
  type CuaOperationWorkspaceTarget,
  type CuaOperationStateReporter,
} from "./cuaOperationTurnTracker.js";
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

import {
  zcodeMcpUiResourceSubscriptionResultSchema as mcpUiEmptyResultSchema,
  zcodeMcpUiCloseInstanceResultSchema,
  zcodeMcpUiOpenInstanceResultSchema,
} from "@zcode/shared";
const logger = createServiceLogger("zcode-agent-service");

/**
 * Session id reserved by prepareSessionCreation for a plain create. Durable submissions, worktree preparations and prepared ids keep
 * their reservation for explicit Retry (specs/first-submission-lifecycle.md), so they never report a discardable reservation.
 */
function plainCreateReservationSessionId(
  params: ZCodeAgentConversationCommandParams,
  envelope: CommandEnvelope,
): string | undefined {
  if (params.envelope.type !== "createSession" || envelope.type !== "createSession")
    return undefined;
  const source = params.envelope.payload as Record<string, unknown>;
  if (
    source.submissionPreparation !== undefined ||
    source.expectedSubmissionId !== undefined ||
    source.preparedSessionId !== undefined ||
    source.worktreePreparation !== undefined
  )
    return undefined;
  const sessionId = (envelope.payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}
const cuaOperationLogger = createServiceLogger("cua-operation-turn");
const PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME = "plugin-workspace";
// Release idle MCP subprocesses after status probing; this affects only the control plane, not session processes.
const MCP_STATUS_LANE_IDLE_TIMEOUT_MS = 5 * 60_000;
// Initial setup from the official Claude marketplace clones/copies a GitHub repository, so the default 30-second protocol timeout can kill a healthy agent.
// Plugin marketplace management is infrequent network I/O; extend its timeout separately without affecting the real-time failure boundary for ordinary session messages.
const PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** The resource manager refreshes every second; subprocess mapping is an in-memory request, so treat a timeout as no mapping for this cycle and do not slow sampling. */
const CHILD_PROCESSES_REQUEST_TIMEOUT_MS = 800;
const PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS = 5_000;
const SESSION_COMPACT_REQUEST_TIMEOUT_MS = 5 * 60_000;

interface PendingPermissionRequest {
  client: ZCodeProtocolClient;
  protocolRequestId: ZCodeProtocolRequestId;
}

interface PendingProviderRuntimeHeadersRequest extends PendingPermissionRequest {
  request: ZCodeProviderRuntimeHeadersRequestParams;
  responding?: boolean;
}

interface PendingSessionRuntimePreferencesRequest extends PendingPermissionRequest {
  workspace: ZCodeAgentWorkspaceTarget;
  request: ZCodeAgentSessionRuntimePreferencesRequest;
  timeout: ReturnType<typeof setTimeout>;
  workspaceKey: string;
}

type SessionCreateCompatField =
  | "persistence"
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled"
  | "dynamicWorkflowMode";
type SessionResumeCompatField =
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled"
  | "dynamicWorkflowMode";
type SessionSendCompatField =
  | "browserAmbientContext"
  | "automationId"
  | "offPeakTaskId"
  | "offPeakRunType"
  | "botDeliveryTarget"
  | "toolDenylist";

const SESSION_CREATE_OPTIONAL_COMPAT_FIELDS = new Set<SessionCreateCompatField>([
  "persistence",
  "thoughtLevel",
  "mcpServers",
  // CUA tool isolation adds toolAllowlist/toolDenylist to buildSessionCreateParams. If an older app-server
  // does not recognize them in its .strict() schema, retry without them instead of failing createSession entirely.
  "toolAllowlist",
  "toolDenylist",
  // The Off-Peak tool-surface flag is also optional for compatibility; if an older app-server rejects it, retry without it (the tools then remain unregistered, fail-closed).
  "offPeakToolEnabled",
  // The dynamic-workflow rollout flag follows the same rule: if an older CLI rejects it,
  // retry without it; the workflow tool group then remains unregistered, without failing the entire create.
  "dynamicWorkflowEnabled",
  // Gray-release mode (launch.md “On demand: activation”): only the boolean is recognized; if the CLI omits this field, it behaves as alwaysOn.
  "dynamicWorkflowMode",
]);
const SESSION_RESUME_OPTIONAL_COMPAT_FIELDS = new Set<SessionResumeCompatField>([
  "thoughtLevel",
  "mcpServers",
  // Cold recovery also carries tool-surface constraints; if an older app-server rejects them, retry without them instead of failing (same as create).
  "toolAllowlist",
  "toolDenylist",
  "offPeakToolEnabled",
  "dynamicWorkflowEnabled",
  "dynamicWorkflowMode",
]);
const SESSION_SEND_OPTIONAL_COMPAT_FIELDS = new Set<SessionSendCompatField>([
  "browserAmbientContext",
  "automationId",
  "offPeakTaskId",
  "offPeakRunType",
  "botDeliveryTarget",
  "toolDenylist",
]);
// If getClient / sessionSubscribe transiently fails while onDynamicSessionEvent establishes the upstream subscription
// (agent process just started, runtime races with "Session is not active", or transport flickers),
// swallowing it with .catch(() => {}) and never retrying makes callers (including syncer shadow subscriptions) cache
// emitter.event as a "successful subscription" forever. The session's terminal event never arrives,
// SQLite stays stale, and the sidebar spinner keeps running. Retry with bounded exponential backoff to cover transient failures.
const SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS = 500;
const SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS = 5_000;
const SESSION_SUBSCRIBE_MAX_ATTEMPTS = 8;
const MAX_TRACKED_SESSION_EVENT_IDS = 10_000;
const SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:ssh:";
const WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:wsl:";

export function supportsLegacyRemoteTaskAllowlist(workspaceIdentity: string | undefined): boolean {
  return Boolean(
    workspaceIdentity?.startsWith(SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX) ||
    workspaceIdentity?.startsWith(WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX),
  );
}

function isClosedStdioTransportError(error: unknown): boolean {
  return error instanceof Error && error.message === "ZCode agent stdio transport is closed";
}

interface SessionEventSequenceState {
  assignedSeqByEventId: Map<string, number>;
  assignedSeqEventIds: string[];
  liveEventIds: Set<string>;
  liveEventIdOrder: string[];
  lastAssignedSeq: number;
}

function isProtocolMethodNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

function buildWorkspaceRef(params: ZCodeAgentWorkspaceTarget): ZCodeWorkspaceRef {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    remoteSessionId: params.remoteSessionId,
    workspaceKey: resolveWorkspaceKey(params),
  };
}

// Whether a saved-workflow target includes a workspace: project profiles and
// actions in GUI project groups that explicitly specify `scope:"global"` include workspacePath; actions
// in global groups that specify only `{ scope: "global" }` do not, leaving services to choose the carrier.
function savedWorkflowTargetHasWorkspace(
  params: ZCodeAgentSavedWorkflowTarget,
): params is ZCodeAgentWorkspaceTarget & { scope?: ZCodeSavedWorkflowScope } {
  return typeof (params as Partial<ZCodeAgentWorkspaceTarget>).workspacePath === "string";
}

// Forward scope to RPC params only when it is defined; project profiles without scope retain today's exact wire shape.
function savedWorkflowScopeParam(params: ZCodeAgentSavedWorkflowTarget): {
  scope?: ZCodeSavedWorkflowScope;
} {
  return params.scope === undefined ? {} : { scope: params.scope };
}

function ensurePluginManagementWorkspacePath(): string {
  const workspacePath = join(getDataBaseDir(), ".zcode", PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME);
  // Plugin management is a control-plane capability and cannot reuse a session process that may get EPIPE if the real workspace is deleted.
  // Give it a fixed internal cwd; the real workspace is still passed to the CLI in protocol params for workspace-scope checks.
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

// NOTE: this counts ONLY the per-session MCP servers passed through the ZCode Protocol
// session/create params (the app→protocol channel). It is deliberately independent of the
// CLI/bootstrap MCP servers configured in ~/.zcode/cli/config.json (mcp.servers), which the agent
// runtime connects separately and reports via the `mcp.server.connected`/toolCount events. So a
// createSession log line with mcpServerCount:0 is EXPECTED when zcode-cua is a CLI-config MCP server
// (e.g. the product Helper broker path injected through the gated bootstrap env): the model still receives those
// tools — the two numbers describe different channels, not a missing tool set. Verified on-machine:
// real kimi-k2.6 turns call mcp__zcode-cua__* tools (get_app_state/type/open_application, status
// completed) in sessions whose createSession logged mcpServerCount:0.
function getMcpServerCount(params: { mcpServers?: readonly unknown[] }): number {
  return params.mcpServers?.length ?? 0;
}

function getMcpServerNames(params: { mcpServers?: readonly { name: string }[] }): string[] {
  return params.mcpServers?.map((server) => server.name) ?? [];
}

function parseInvalidParamsIssues(error: unknown): unknown[] {
  const errorLike = error as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
  const message = errorLike.message;
  if (
    errorLike.code !== -32602 ||
    typeof message !== "string" ||
    (message !== "Invalid params" && !message.startsWith("Invalid params — "))
  ) {
    return [];
  }
  const data = errorLike.data;
  if (!data || typeof data !== "object") {
    return [];
  }
  // Newer Agents append a Zod summary to the top-level message, while the old compatibility parser accepts only
  // an exact "Invalid params" string. On App/Agent version mismatch, this prevented retrying without new fields.
  // Field detection still trusts only structured issues in data; do not infer field names from mutable human-readable summaries.
  const serializedIssues = (data as { message?: unknown }).message;
  if (typeof serializedIssues !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(serializedIssues) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getUnrecognizedTopLevelKeys(error: unknown): string[] {
  const keys = new Set<string>();
  for (const issue of parseInvalidParamsIssues(error)) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const issueLike = issue as {
      code?: unknown;
      keys?: unknown;
      path?: unknown;
    };
    if (
      issueLike.code !== "unrecognized_keys" ||
      (Array.isArray(issueLike.path) && issueLike.path.length > 0) ||
      !Array.isArray(issueLike.keys)
    ) {
      continue;
    }
    for (const key of issueLike.keys) {
      if (typeof key === "string") {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

function getSessionCreateCompatFields(error: unknown): SessionCreateCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionCreateCompatField =>
      SESSION_CREATE_OPTIONAL_COMPAT_FIELDS.has(key as SessionCreateCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function getSessionResumeCompatFields(error: unknown): SessionResumeCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionResumeCompatField =>
      SESSION_RESUME_OPTIONAL_COMPAT_FIELDS.has(key as SessionResumeCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function getSessionSendCompatFields(error: unknown): SessionSendCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
  if (keys.length === 0) {
    return [];
  }
  if (
    !keys.every((key): key is SessionSendCompatField =>
      SESSION_SEND_OPTIONAL_COMPAT_FIELDS.has(key as SessionSendCompatField),
    )
  ) {
    return [];
  }
  return keys;
}

function isProtocolRequestTimeout(error: unknown, method: string): boolean {
  if (error instanceof ZCodeProtocolRequestTimeoutError) {
    return error.method === method;
  }
  return error instanceof Error && error.message === `ZCode Protocol request timed out: ${method}`;
}

function assertV4AttachmentNdjsonEnvelope(method: string, params: unknown): void {
  // Actual CLI request IDs are incrementing integers; use a wider 32-character ID here for a conservative exact-JSON size measurement.
  const bytes = utf8JsonByteLength({ id: "9".repeat(32), method, params }) + 1; // NDJSON newline
  if (bytes > PROTOCOL_V4_LIMITS.maxFrameBytes) {
    throw new Error("proto.frameTooLarge");
  }
}

function buildSessionCreateParams(
  params: ZCodeAgentCreateSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  },
  omittedFields: ReadonlySet<SessionCreateCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    additionalDirectories: params.additionalDirectories,
    workspace: buildWorkspaceRef(params),
    parentSessionId: params.parentSessionId,
    mode: params.mode,
    model: params.model,
    ...(params.persistence !== undefined && !omittedFields.has("persistence")
      ? { persistence: params.persistence }
      : {}),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    ...(params.titleGenerationEnabled !== undefined
      ? { titleGenerationEnabled: params.titleGenerationEnabled }
      : {}),
    // desktop-continuous create/recovery goes through the session service, not the legacy task adapter.
    // Previously, the MCP servers already resolved by the UI were not included in strict protocol params, so runtimeConfig saw an empty MCP list.
    // MCP is runtime startup configuration and must be passed at the create/resume request boundary; sendPrompt cannot add it later.
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    // CUA tool-isolation fields are optional for compatibility: if an older app-server's .strict() schema rejects them,
    // the compatibility retry adds them to omittedFields and retries (rather than failing). Gate them on omittedFields here too.
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    // importedHistory is an integrity boundary for imported history. Do not omit it during an old-protocol compatibility retry like thoughtLevel/persistence,
    // or the result would be an empty session with model switching enabled but no history.
    ...(params.importedHistory !== undefined ? { importedHistory: params.importedHistory } : {}),
    // Send true only when the rollout is enabled (omit the field by default); compatibility handling omits it if an older CLI strict schema rejects it.
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    // Dynamic-workflow rollout uses the same payload shape as Off-Peak;
    // omit the field when disabled—the CLI default is to leave those nine tools unregistered.
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
    ...buildDynamicWorkflowModeField(params, omittedFields),
  };
}

/**
 * Gray-release mode is sent alongside the boolean (launch.md “On demand: activation”): write it only when enabled and only when the boolean is also being written
 * —mode alone has no meaning to the CLI. Compatibility omits it for older CLIs with strict schemas, which then behave as alwaysOn.
 */
function buildDynamicWorkflowModeField(
  params: { dynamicWorkflowEnabled?: boolean; dynamicWorkflowMode?: DynamicWorkflowMode },
  omittedFields: ReadonlySet<SessionCreateCompatField | SessionResumeCompatField>,
): { dynamicWorkflowMode?: DynamicWorkflowMode } {
  return params.dynamicWorkflowEnabled === true &&
    params.dynamicWorkflowMode !== undefined &&
    !omittedFields.has("dynamicWorkflowEnabled") &&
    !omittedFields.has("dynamicWorkflowMode")
    ? { dynamicWorkflowMode: params.dynamicWorkflowMode }
    : {};
}

function buildSessionResumeParams(
  params: ZCodeAgentResumeSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  },
  omittedFields: ReadonlySet<SessionResumeCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    additionalDirectories: params.additionalDirectories,
    workspace: buildWorkspaceRef(params),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    // During cold session recovery, the app-server may recreate the runtime; MCP servers must also be included in the resume request.
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    // Resume must carry the same tool-surface constraints as create, or a runtime rebuilt during cold recovery loses allow/deny
    // isolation (a CUA session could see disabled tools such as Bash again). If an older app-server rejects them, omittedFields handles the fallback.
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    // Without this flag, cold recovery loses the Off-Peak tool surface (same reason as toolAllowlist).
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    // Same reason: without this flag, cold recovery loses the workflow tool group.
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
    ...buildDynamicWorkflowModeField(params, omittedFields),
  };
}

function buildSessionSendParams(
  params: ZCodeAgentSendPromptParams,
  omittedFields: ReadonlySet<SessionSendCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    // Execution identity/constraints are not optional compatibility fields; fail if an older Worker does not support them instead of silently stripping them.
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
    inputId: params.inputId,
    queryId: params.queryId,
    content: params.content,
    attachments: params.attachments,
    ...(params.browserAmbientContext !== undefined && !omittedFields.has("browserAmbientContext")
      ? { browserAmbientContext: params.browserAmbientContext }
      : {}),
    expectedRevision: params.expectedRevision,
    expectedProviderRevision: params.expectedProviderRevision,
    ...(params.automationId !== undefined && !omittedFields.has("automationId")
      ? { automationId: params.automationId }
      : {}),
    ...(params.offPeakTaskId !== undefined && !omittedFields.has("offPeakTaskId")
      ? { offPeakTaskId: params.offPeakTaskId }
      : {}),
    ...(params.offPeakRunType !== undefined && !omittedFields.has("offPeakRunType")
      ? { offPeakRunType: params.offPeakRunType }
      : {}),
    ...(params.botDeliveryTarget !== undefined && !omittedFields.has("botDeliveryTarget")
      ? { botDeliveryTarget: params.botDeliveryTarget }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
  };
}

function buildSessionCompactParams(params: ZCodeAgentCompactParams) {
  return {
    sessionId: params.sessionId,
    inputId: params.inputId,
    instructions: params.instructions,
    expectedRevision: params.expectedRevision,
  };
}

function formatModelSelectionForLog(ref: ModelSelection | undefined): string | null {
  if (!ref) {
    return null;
  }

  const base = `${ref.providerId}/${ref.modelId}`;
  const reasoningLevel = ref.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

function sessionEventKey(params: ZCodeAgentSessionTarget): string {
  return `${resolveWorkspaceKey(params)}\u0000${params.sessionId}`;
}

function rememberBoundedEventId(ids: Set<string>, order: string[], eventId: string): boolean {
  if (ids.has(eventId)) {
    return false;
  }
  ids.add(eventId);
  order.push(eventId);
  while (order.length > MAX_TRACKED_SESSION_EVENT_IDS) {
    const removed = order.shift();
    if (removed) {
      ids.delete(removed);
    }
  }
  return true;
}

function permissionRequestKey(params: ZCodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function userInputRequestKey(params: ZCodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function providerRuntimeHeadersRequestKey(
  params: ZCodeAgentSessionTarget & { requestId: string },
): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

/**
 * Read-only selection projection of the process-level Provider Registry.
 *
 * The local Worker owns the full Registry; the Host uses this projection only to decide whether model execution can start.
 * Do not expand it into runtimeModel or override the Worker as the source of execution facts.
 */
interface ModelSelectionReadinessSource {
  getView(): Promise<ModelSelectionView>;
  onDidChange?: (listener: (view: ModelSelectionView) => void) => IDisposable;
}

interface ZCodeAgentProviderReadinessSnapshot {
  readonly providerCount: number;
  readonly revision: string;
  readonly readiness: {
    readonly ready: boolean;
    readonly providerId?: string;
    readonly modelId?: string;
  };
}

function createProviderReadinessSnapshotFromSelectionView(
  view: ModelSelectionView,
): ZCodeAgentProviderReadinessSnapshot {
  for (const provider of view.providers) {
    const model = provider.models[0];
    if (!model) continue;
    return {
      providerCount: view.providers.length,
      revision: `model-selection:${view.revision}`,
      readiness: {
        ready: true,
        providerId: provider.providerId,
        modelId: model.modelId,
      },
    };
  }
  return {
    providerCount: view.providers.length,
    revision: `model-selection:${view.revision}`,
    readiness: { ready: false },
  };
}

interface WaitingWorkspaceStartup {
  cancelled: boolean;
  lastLoggedRevision?: string;
  starting?: Promise<ZCodeProtocolClient>;
  workspace: ZCodeAgentWorkspaceTarget;
}

interface ActiveWorkspaceClient {
  client: ZCodeProtocolClient;
  interactionPreferencesReady?: Promise<void>;
  /**
   * Records only whether provider/model startup gating has passed during this process lifetime.
   * A read-only topic may start the CLI, but must not let later create/command calls bypass the gate.
   */
  modelExecutionEnabled: boolean;
  workspace: ZCodeAgentWorkspaceTarget;
  /**
   * Dynamic-workflow policy currently held by this CLI process (launch.md “The user’s choice”). It defaults to disabled when the CLI starts,
   * and is updated only after workspace/updateDynamicWorkflowPolicy succeeds; resync uses it to skip unchanged requests.
   */
  dynamicWorkflowPolicyMode: DynamicWorkflowMode;
}

function requiresProviderRegistryRefresh(commandType: string): boolean {
  // Bug 原因：模型切换遗漏刷新屏障，会用存量 Worker 的旧 Registry 校验新下发的 Provider。
  // 复用同一刷新队列，成功后才下发切换命令，失败则直接拒绝本次切换。
  switch (commandType) {
    case "createSession":
    case "createSelectionSideSession":
    case "sendText":
    case "sendGoalCommand":
    case "compact":
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "sendQueuedNow":
    case "switchModelConfig":
      return true;
    default:
      return false;
  }
}

function createRuntimeUnavailableError(params: ZCodeAgentWorkspaceTarget): Error & {
  code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  workspaceKey: string;
} {
  const error = new Error("ZCode Agent runtime is not running.") as Error & {
    code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
    workspaceKey: string;
  };
  error.code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  error.workspaceKey = resolveWorkspaceKey(params);
  return error;
}

interface CreateZCodeAgentServiceOptions extends Omit<
  ZCodeAgentProcessManagerOptions,
  "idleTimeoutMs"
> {
  /** Used only by the MCP status-probing process; do not apply idle cleanup to chat. */
  mcpStatusIdleTimeoutMs?: number;
  accountProviderConfigSource?: ProviderSource<AccountProviderConfigSnapshot>;
  accountRequestAuthService?: IAccountRequestAuthService;
  /** ChatGPT plan (SIWC) request-auth resolver owned by the host (local credentials only). */
  chatGptPlanRequestAuth?: {
    resolve(input: {
      expectedAccountScope?: string;
      forceRefresh: boolean;
      providerId: string;
    }): Promise<{ accountScope?: string; apiKey: string }>;
  };
  /**
   * ChatGPT plan (SIWC) usage recorder owned by the host: receives passively captured plan
   * usage windows from turn-completion usage payloads and keeps the latest snapshot per
   * account in memory. Injected by the desktop host; omitted in pure CLI setups.
   */
  chatGptPlanUsageRecorder?: {
    recordUsage(accountKey: string, snapshot: SiwcPlanUsageSnapshot): void;
  };
  /** Desktop Host asks Main to register the exact local video path authorized for the Agent. */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  modelSelectionReadinessSource?: ModelSelectionReadinessSource;
  readSubagentRuntimeConfig?: (workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<SubagentRuntimeConfig>;
  sessionRuntimePreferencesAuthority?: "local" | "external";
  prepareProjectExecution?: (
    projectId: string,
  ) => Promise<import("@zcode/shared").ProjectExecutionSnapshot>;
  prepareSessionCreation?: (
    target: ZCodeAgentSessionTarget & {
      projectId: string | null;
      additionalDirectories?: string[];
    },
  ) => Promise<string[]>;
  /**
   * Removes the reservation placeholder that prepareSessionCreation wrote for a create the CLI never admitted (see
   * discardAbandonedSessionReservation). The implementation must delete only rows that still have no CLI facts.
   */
  discardSessionReservation?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    sessionId: string;
  }) => Promise<unknown>;
  /**
   * Claims the fork child for its parent's project after the CLI acknowledges forkAssistant (see claimForkedSessionOwnership).
   * The CLI does not know projects, and its sessions-index row may arrive before or after this ack, so the claim must be idempotent.
   * Resolves null when the parent has no owner yet; the child then stays unclaimed until admission (never an error).
   */
  prepareForkedSession?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    parentSessionId: string;
    sessionId: string;
  }) => Promise<unknown>;
  resolveSessionDirectories?: (target: ZCodeAgentSessionTarget) => Promise<string[]>;
  resolveSessionRuntimePreferences?: (
    scope: ZCodeSessionRuntimePreferencesScope,
  ) => Promise<ZCodeSessionRuntimePreferencesResult>;
  /** After a manual run is persisted, the current host dispatches it directly; by return, the session must have accepted the prompt. */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  /**
   * Creates Off-Peak sessions. config handles both the exposure gate (enabled && non-empty Selection View →
   * include offPeakToolEnabled in session create/resume) and defaults (model = last item in the allowlist /
   * thoughtLevel = highest level); the service is used by offPeak/create and offPeak/list protocol handlers.
   * If either value is missing, disable the feature entirely (pure CLI / desktop-attached-remote setups do not pass it).
   */
  resolveOffPeakClientConfig?: () => Promise<OffPeakClientConfig | undefined>;
  /**
   * Dynamic-workflow rollout snapshot. Host is the sole authority:
   * the result is sent to the CLI as a workspace-level fact and determines whether session create/resume/v4 includes
   * dynamicWorkflowEnabled. Omitted by default (pure CLI setup) means always disabled, matching the CLI default.
   */
  resolveDynamicWorkflowClientConfig?: () => Promise<DynamicWorkflowClientConfig | undefined>;
  /**
   * User-choice read point (launch.md “The user’s choice”): the Host that owns settings authority injects this and reads the
   * settings file on every use. A desktop-attached remote Host does not inject it and instead uses the value pushed by Desktop (syncDynamicWorkflowUserMode).
   */
  resolveDynamicWorkflowUserMode?: () => Promise<DynamicWorkflowMode | undefined>;
  /** After syncing the user choice, pass it to the composition layer for forwarding (from the Desktop Host to this window’s remote Host); the value comes from local settings. */
  forwardDynamicWorkflowUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
  resolveOffPeakTaskService?: () =>
    | Pick<IOffPeakTaskService, "createTask" | "list" | "getCodingPlanSupport">
    | undefined;
  /**
   * browser-use execution bridge: forwards the agent's interaction/browserExecute reverse request to main
   * (WebContentsView+CDP). Injected by the desktop host; when absent (pure CLI/remote control without main),
   * browser commands return backend_unavailable without affecting other features.
   */
  browserControlExecutor?: BrowserAmbientContextExecutor;
  channelReplyExecutor?: (request: ChannelReplyHostRequest) => Promise<ChannelReplyResult>;
  topicResourceExecutor?: (
    request: ZCodeTopicResourceReadParams &
      ZCodeAgentWorkspaceTarget & { trace?: ZCodeProtocolTrace },
    signal: AbortSignal,
  ) => Promise<ZCodePromptAttachment>;
  topicResourceValidator?: (
    request: ZCodeTopicResourceReadParams &
      ZCodeAgentWorkspaceTarget & { trace?: ZCodeProtocolTrace },
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * Official Server MCP identity-header resolver. The Agent process is not authoritative for user identity;
   * it requests headers for this request from the host via interaction/requestOfficialMcpAuthHeaders.
   *
   * When absent, the request always returns official_auth_unavailable and never falls back to an anonymous request—
   * for example, when a standalone CLI has no host auth port.
   */
  officialMcpAuthHeadersResolver?: {
    resolveHeaders(request: {
      mcpKey: string;
      pluginId: string;
      targetOrigin: string;
      workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
    }): Promise<
      | { ok: true; headers: Record<string, string> }
      | { ok: false; reason: "official_auth_unavailable" | "official_auth_plan_required" }
    >;
  };
  /**
   * Trusted-origin validator for official MCP. **The host is the identity authority boundary**, so
   * targetOrigin must be validated here; relying only on the agent adapter's fetch wrapper would let
   * the party being checked act as its own reviewer. In desktop-attached remote setups, the agent runs remotely while the host holds local user identity.
   *
   * This check constrains the target origin for credential requests; it does not provide per-plugin permission control.
   * HTTP authentication is injected by the host fetch wrapper; stdio authentication gives credentials to the plugin process,
   * which must be managed as trusted executable code. The server must still validate identity, permissions, and quotas on every call.
   *
   * Reject all requests when absent (fail closed); do not fall back to "validate only the schema, then send credentials."
   */
  officialMcpTrustedOrigins?: {
    isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
      detail?: string;
      trusted: boolean;
    }>;
  };
  /** Injected by the desktop-local Host; consumes only validated, deduplicated live session events. */
  cuaOperationStateReporter?: CuaOperationStateReporter;
  onCuaPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
}

function toProtocolAutomation(automation: ZCodeAutomation) {
  return {
    automationId: automation.automationId,
    title: automation.title,
    cronExpr: automation.cronExpr,
    prompt: automation.prompt,
    modelSelection: automation.modelSelection,
    mode: automation.mode,
    targetTaskId: automation.targetTaskId,
    enabled: automation.enabled,
    lifecycleStatus: automation.lifecycleStatus,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    runCount: automation.runCount,
    recurring: automation.recurring,
    maxRuns: automation.maxRuns,
    // Forward the authoritative scheduleRule; session cards need this field to display intervals cron cannot express
    // (such as every 50 hours or every 40 days), or they would infer incorrect descriptions like "at minute 00 every hour" from the compatibility cronExpr.
    scheduleRule: automation.scheduleRule,
  };
}

export function toProtocolOffPeakTaskSnapshot(task: {
  offPeakTaskId: string;
  title: string;
  status: "queued" | "paused" | "running" | "completed" | "failed" | "cancelled";
  queuePosition?: number;
  sessionId?: string;
  createdAt: number;
}) {
  // Keep the protocol surface minimal: do not expose serverTicketId / providerName / workspace details.
  return {
    offPeakTaskId: task.offPeakTaskId,
    title: task.title,
    status: task.status,
    ...(typeof task.queuePosition === "number" && task.queuePosition > 0
      ? { queuePosition: task.queuePosition }
      : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    createdAt: task.createdAt,
  };
}

export const OFF_PEAK_INTERNAL_ERROR_CODE = "offpeak_internal_error";
export const OFF_PEAK_INTERNAL_ERROR_MESSAGE = "Internal off-peak service error";

/**
 * Fallback catches for offPeak/create and offPeak/list must not pass cross-layer exception text (SQLite/file paths/
 * upstream response fragments) through the protocol; it would appear in CLI logs and model-visible errors. Log the original error only on the server,
 * and expose a stable error code plus generic message. Business failure categories still go through respond({ok:false}), not this path.
 */
async function respondOffPeakInternalError(
  client: Pick<ZCodeProtocolClient, "respondError">,
  request: { id: ZCodeProtocolRequestId; method: string },
  workspace: ZCodeAgentWorkspaceTarget,
  error: unknown,
): Promise<void> {
  logger.warn(undefined, "Off-peak 协议请求处理失败", {
    method: request.method,
    workspaceKey: resolveWorkspaceKey(workspace),
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
  await client.respondError(request.id, {
    code: -32603,
    message: OFF_PEAK_INTERNAL_ERROR_MESSAGE,
    data: { errorCode: OFF_PEAK_INTERNAL_ERROR_CODE },
  });
}

/** D49-8/SG-02: creation is allowed only when gray release is effectively enabled and the allowlist is non-empty; otherwise treat it as disabled (empty array). */
export function resolveOffPeakAllowedModels(
  grayConfig: OffPeakClientConfig | undefined,
  providerId?: string,
): readonly string[] {
  if (grayConfig?.enabled !== true) return [];
  return grayConfig.modelSelectionView.providers
    .filter((provider) => providerId === undefined || provider.providerId === providerId)
    .flatMap((provider) => provider.models.map((model) => model.modelId));
}

/**
 * Model resolution: omitted → last item in the allowlist (the server's final item is approximately the newest/strongest); explicit → trim and match case-insensitively,
 * returning the allowlist's original spelling on a match or null otherwise (the caller returns model_not_allowed).
 */
export function resolveOffPeakCreateModel(
  allowedModels: readonly string[],
  requested: string | undefined,
): string | null {
  const wanted = requested?.trim();
  if (!wanted) return allowedModels[allowedModels.length - 1] ?? null;
  const lower = wanted.toLowerCase();
  return allowedModels.find((model) => model.trim().toLowerCase() === lower) ?? null;
}

/**
 * New tool tasks reuse the shared highest-level completion; old metadata/model-specific exceptions would diverge from the semantic order of values.
 * Leave explicit levels to createTask's existing validation; do not change them at the entry point.
 */
export function resolveOffPeakToolSelection(
  view: ModelSelectionView,
  providerId: string,
  modelId: string,
  thoughtLevel?: string,
): ModelSelection | undefined {
  const selection = completeNewModelSelection(view, { providerId, modelId });
  if (!selection) return undefined;
  return thoughtLevel === undefined
    ? selection
    : { ...selection, options: { reasoningLevel: thoughtLevel } };
}
export function createZCodeAgentService(
  options?: CreateZCodeAgentServiceOptions,
): IZCodeAgentService & { disposeAllAndWait(): Promise<void> } {
  const processManager = new ZCodeAgentProcessManager(options);
  // The Windows indicator and macOS producer lifecycle client share validated, deduplicated sideband facts.
  const cuaOperationTurnTracker =
    options?.cuaOperationStateReporter || options?.onCuaPipSessionLifecycle
      ? createCuaOperationTurnTracker({
          ...(options?.cuaOperationStateReporter
            ? { reporter: options.cuaOperationStateReporter }
            : {}),
          ...(options?.onCuaPipSessionLifecycle
            ? { onPipSessionLifecycle: options.onCuaPipSessionLifecycle }
            : {}),
          logger: {
            debug: (message) => cuaOperationLogger.debug(undefined, message),
            info: (message) => cuaOperationLogger.info(undefined, message),
            warn: (message) => cuaOperationLogger.warn(undefined, message),
          },
        })
      : undefined;
  // AutomationRepo also holds a tasks-index.sqlite connection, so disposeAll must close it too (see the disposeAll comment below).
  const automationRepo = new AutomationRepo();
  // Fork AutomationService takes no project-execution hook; upstream project binding is deferred with the project PR.
  const automationService = new AutomationService(automationRepo);
  const automationTaskIndexRepo = new TaskIndexRepo();
  const pluginProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
  });
  // A merge accidentally removed the dedicated process: a slow mcp/list handshake blocks the serial stdio queue and plugin uninstall as well.
  // Restore the dedicated control-plane process and idle cleanup; share the workspace path, but not the request queue or watchdog.
  const mcpStatusProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    processLifecycleReporter: options?.processLifecycleReporter,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
    lane: "mcp-status",
    idleTimeoutMs: options?.mcpStatusIdleTimeoutMs ?? MCP_STATUS_LANE_IDLE_TIMEOUT_MS,
  });
  const sessionEmitters = new Map<string, Emitter<ZCodeAgentServiceEvent>>();
  /**
   * (pluginId, mcpKey, workspaceKey) tuples for which the "first official identity-header issuance" audit log has already been written.
   *
   * Rationale: the success path cannot log only at debug level—production's minimum level is Info, so later we could not answer
   * "which plugin obtained the credentials." But every initialize / tools\_list / tools\_call issues them,
   * and logging every issue at info would create message-level log volume. Instead, log one info entry for each tuple on its first issuance in this process,
   * then continue at debug. This preserves the audit detail "which plugin, which workspace, and when it first obtained them."
   */
  const officialMcpIssuanceAudit = createOfficialMcpIssuanceAudit();
  const providerRuntimeHeadersWorkspaceEmitters = new Map<
    string,
    Emitter<ZCodeProviderRuntimeHeadersRequestParams>
  >();
  const providerRuntimeHeadersCancelledEmitters = new Map<
    string,
    Emitter<ZCodeProviderRuntimeHeadersCancelled>
  >();
  function cancelProviderRuntimeHeaders(
    key: string,
    pending: PendingProviderRuntimeHeadersRequest,
  ): void {
    pendingProviderRuntimeHeaders.delete(key);
    const { requestId, sessionId, workspace } = pending.request;
    // Remove it before delivery so a late subscriber cannot restart a canceled request check.
    providerRuntimeHeadersCancelledEmitters
      .get(resolveWorkspaceKey(workspace))
      ?.fire({ requestId, sessionId, workspace });
    logger.info(undefined, "请求校验已取消", {
      requestId,
      sessionId,
      workspaceKey: resolveWorkspaceKey(workspace),
    });
  }
  const sessionRuntimePreferencesRequestEmitter =
    new Emitter<ZCodeAgentSessionRuntimePreferencesRequest>();
  const processResourceSampleEmitter = new Emitter<AgentLaneResourceSample>();
  const toolExecResourceEmitter = new Emitter<ZCodeToolExecResource>();
  const mcpResourceSamplesEmitter = new Emitter<ZCodeMcpResourceSample[]>();
  const mcpTelemetryEmitter = new Emitter<ZCodeMcpTelemetryEvent>();
  const pluginOperationProgressEmitters = new Map<
    string,
    Emitter<ZCodePluginOperationProgressNotification>
  >();
  // v4 conversation frame fan-out: workspace-level emitter; the renderer routes by topic.
  const conversationFrameEmitters = new Map<string, Emitter<ConversationTopicWireCandidate>>();
  const localTtftFactsEmitter = new Emitter<{ workspaceKey: string; facts: LocalTtftFacts }>();
  const conversationTelemetryFactEmitters = new Map<string, Emitter<ConversationTelemetryFact>>();
  const offPeakLifecycleEmitters = new Map<string, Emitter<OffPeakLifecycleNotification>>();
  const pluginUiToolResultEmitter = new Emitter<
    PluginUiToolResultNotification & ZCodeAgentWorkspaceTarget
  >();
  const cuaPermissionObservationEmitter = new Emitter<ZCodeAgentCuaPermissionObservation>();
  // sessions-index frame fan-out: shares the conversationFrame notification and is routed to this emitter by topic prefix.
  const sessionsIndexFrameEmitters = new Map<string, Emitter<SessionsIndexTopicWireCandidate>>();
  // workspace-config frame fan-out: configuration-directory activity (consumed by task-index syncer); the same notification is routed by prefix.
  const workspaceConfigFrameEmitters = new Map<
    string,
    Emitter<WorkspaceConfigTopicWireCandidate>
  >();
  // v4 subscriptions are replaced by (connectionId, topic); each host process serves one
  // renderer window, so a stable connectionId naturally replaces the old subscription on resubscribe.
  const v4ConnectionId = `host-${randomUUID()}`;
  interface V4SubscriptionRoute {
    workspaceKey: string;
    topic: string;
    subscriptionId: string;
    connectionId: string;
  }
  const v4SubscriptionRoutes = new Map<string, V4SubscriptionRoute>();
  const v4RouteKeyByOwnership = new Map<string, string>();
  const v4RouteRuntimeRestartDisposable = processManager.onRuntimeRestarted(({ workspaceKey }) => {
    clearV4SubscriptionRoutes(workspaceKey);
    cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
  });
  const sessionEventSequenceStates = new Map<string, SessionEventSequenceState>();
  const wiredClients = new WeakSet<ZCodeProtocolClient>();
  const clientDisposables = new WeakMap<ZCodeProtocolClient, IDisposable[]>();
  const pendingPermissions = new Map<string, PendingPermissionRequest>();
  const pendingUserInputs = new Map<string, PendingPermissionRequest>();
  // In-memory diagnostic counters: read only the sizes of per-session mirror tables.
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("agent", () => ({
    sessionEmitters: sessionEmitters.size,
    seqStates: sessionEventSequenceStates.size,
    pendingPermissions: pendingPermissions.size,
    pendingUserInputs: pendingUserInputs.size,
  }));
  const pendingProviderRuntimeHeaders = new Map<string, PendingProviderRuntimeHeadersRequest>();
  const pendingSessionRuntimePreferences = new Map<
    string,
    PendingSessionRuntimePreferencesRequest
  >();
  const activeClientsByWorkspaceKey = new Map<string, ActiveWorkspaceClient>();
  const interactionPreferenceSyncByWorkspaceKey = new Map<string, Promise<void>>();
  let latestAppRuntimePreferences: ZCodeAgentAppRuntimePreferences | undefined;
  /** One-time, in-process read of the server-provided value; see the comment on resolveDynamicWorkflowGate. */
  let dynamicWorkflowOffer: Promise<DynamicWorkflowClientConfig | undefined> | undefined;
  /** User choice pushed by Desktop; use only when there is no local settings authority (resolveDynamicWorkflowUserMode was not injected). */
  let pushedDynamicWorkflowUserMode: DynamicWorkflowMode | undefined;
  /** Per-workspace policy sync chain: each queued step reads the effective mode and sends it only after the previous step completes. */
  const dynamicWorkflowPolicySyncByWorkspaceKey = new Map<string, Promise<void>>();
  const waitingWorkspaceStartups = new Map<string, WaitingWorkspaceStartup>();
  function cancelWaitingWorkspaceStartup(workspaceKey: string): void {
    const waiting = waitingWorkspaceStartups.get(workspaceKey);
    if (waiting) {
      waiting.cancelled = true;
      waitingWorkspaceStartups.delete(workspaceKey);
    }
  }
  function cancelAllWaitingWorkspaceStartups(): void {
    for (const waiting of waitingWorkspaceStartups.values()) {
      waiting.cancelled = true;
    }
    waitingWorkspaceStartups.clear();
  }
  const accountConfigSyncByClient = new WeakMap<ZCodeProtocolClient, Promise<void>>();
  // This cache only deduplicates delivered account snapshots; it does not mean the Worker Registry has applied this revision.
  const accountConfigReceivedRevisionByClient = new WeakMap<ZCodeProtocolClient, string>();
  const sessionTraceIdBySessionKey = new Map<string, TraceId>();
  const accountRequestAuthService = options?.accountRequestAuthService;
  const chatGptPlanRequestAuth = options?.chatGptPlanRequestAuth;
  const chatGptPlanUsageRecorder = options?.chatGptPlanUsageRecorder;
  const accountProviderConfigSource = options?.accountProviderConfigSource;
  const modelSelectionReadinessSource = options?.modelSelectionReadinessSource;
  const sessionRuntimePreferencesAuthority = options?.sessionRuntimePreferencesAuthority ?? "local";
  const resolveSessionRuntimePreferences = options?.resolveSessionRuntimePreferences;

  function invalidateWorkspaceClient(workspaceKey: string, client: ZCodeProtocolClient): void {
    for (const [key, pending] of pendingPermissions) {
      if (pending.client === client) {
        pendingPermissions.delete(key);
      }
    }
    for (const [key, pending] of pendingUserInputs) {
      if (pending.client === client) {
        pendingUserInputs.delete(key);
      }
    }
    for (const [key, pending] of pendingProviderRuntimeHeaders) {
      if (pending.client === client) {
        cancelProviderRuntimeHeaders(key, pending);
      }
    }
    for (const [key, pending] of pendingSessionRuntimePreferences) {
      if (pending.client === client) {
        clearTimeout(pending.timeout);
        pendingSessionRuntimePreferences.delete(key);
      }
    }
    for (const disposable of clientDisposables.get(client) ?? []) {
      disposable.dispose();
    }
    clientDisposables.delete(client);

    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.client !== client) {
      // Runtime lifecycle events may interleave with the next generation's startup; late cleanup from an old client may release
      // only its own bindings and must never remove a newly registered client or runtime state for the same workspace.
      return;
    }
    activeClientsByWorkspaceKey.delete(workspaceKey);
    // Interaction preferences live in CLI process memory; after the runtime changes, synchronize them again even if the app revision
    // is unchanged. Do not reuse the completion Promise from the old client.
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
  }

  const runtimeLifecycleDisposable = processManager.onRuntimeLifecycle((event) => {
    if (event.state !== "unavailable") return;
    // When the protocol closes, the process crashes, or a request times out, the runtime may not send turn-failed/
    // session-closed and may not successfully start the next runtime generation. Clear the CUA tracker at the authoritative
    // unavailable lifecycle boundary, or the Windows top banner and Helper recovery gate may remain indefinitely.
    cuaOperationTurnTracker?.clearWorkspaceKey(event.workspaceKey);
    const active = activeClientsByWorkspaceKey.get(event.workspaceKey);
    if (!active) return;
    // The process manager publishes unavailable only for the current available runtime; bind the current
    // active client here as a second identity guard so late cleanup from an old runtime cannot affect the replacement.
    invalidateWorkspaceClient(event.workspaceKey, active.client);
  });

  async function resolveAccountRequestAuth(
    request: ZCodeProviderRuntimeHeadersRequestParams,
  ): Promise<AccountRequestAuthMaterial | undefined> {
    // ChatGPT plan (SIWC) carries no zhipu-shaped accountAccess on the wire; the host
    // resolves it by provider id, mirroring the CLI standalone resolver semantics.
    if (chatGptPlanRequestAuth && isChatGptPlanAccountProviderId(request.providerId)) {
      return chatGptPlanRequestAuth.resolve({
        expectedAccountScope: request.expectedAccountScope,
        forceRefresh: request.rejectedProjectTokenFingerprint !== undefined,
        providerId: request.providerId,
      });
    }
    if (!request.accountAccess || !accountRequestAuthService) {
      return undefined;
    }
    return accountRequestAuthService.resolveCurrent({
      providerId: request.providerId,
      modelId: request.modelSelection.modelId,
      accountAccess: request.accountAccess,
      expectedAccountScope: request.expectedAccountScope,
      rejectedProjectTokenFingerprint: request.rejectedProjectTokenFingerprint,
      reason: request.reason,
    });
  }

  async function respondAccountRequestAuthWithoutInteraction(params: {
    key: string;
    pending: PendingProviderRuntimeHeadersRequest;
  }): Promise<void> {
    params.pending.responding = true;
    try {
      const requestAuth = await resolveAccountRequestAuth(params.pending.request);
      // Account resolution is asynchronous I/O; after cancellation/process exit, do not send late data to a revoked request.
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      if (!requestAuth) {
        throw new Error("Account request auth resolver returned no material");
      }
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: true,
        requestAuth,
      });
      logger.info(undefined, "ZCode provider runtime headers 已应用", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
    } catch (error) {
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      logger.warn(undefined, "ZCode provider runtime headers 应用失败", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        error: error instanceof Error ? error.message : String(error),
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (pendingProviderRuntimeHeaders.get(params.key) === params.pending) {
        pendingProviderRuntimeHeaders.delete(params.key);
      }
    }
  }

  function takePendingSessionRuntimePreferences(
    requestId: string,
  ): PendingSessionRuntimePreferencesRequest | undefined {
    const pending = pendingSessionRuntimePreferences.get(requestId);
    if (!pending) {
      return undefined;
    }
    pendingSessionRuntimePreferences.delete(requestId);
    clearTimeout(pending.timeout);
    return pending;
  }

  function expireSessionRuntimePreferencesRequest(requestId: string): void {
    const pending = takePendingSessionRuntimePreferences(requestId);
    if (!pending) {
      return;
    }
    // If the remote Host transport remains alive but the settings responder never returns, the old pending request
    // has no termination condition and blocks the Session lifecycle. A timeout ends only this request; it does not retry or downgrade.
    logger.warn(undefined, "运行时偏好请求等待 Host 响应超时", {
      event: "zcode_agent.runtime_preferences.host_response_timeout",
      module: "services.zcode_agent",
      requestId,
      scope: pending.request.scope,
      sessionId: pending.request.sessionId,
      timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
      workspaceKey: pending.workspaceKey,
    });
    void pending.client
      .respondError(pending.protocolRequestId, {
        code: -32022,
        message: "Session runtime preferences request timed out",
        data: {
          timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        },
      })
      .catch((error: unknown) => {
        logger.debug(undefined, "运行时偏好超时响应发送失败", {
          error: error instanceof Error ? error.message : String(error),
          requestId,
          scope: pending.request.scope,
          sessionId: pending.request.sessionId,
        });
      });
  }

  let modelSelectionSubscription = modelSelectionReadinessSource?.onDidChange?.((view) => {
    void handleProviderReadinessChanged({
      reason: "model_selection_changed",
      snapshot: createProviderReadinessSnapshotFromSelectionView(view),
    }).catch((error) => {
      logger.warn(undefined, "model selection readiness 热同步失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  let accountProviderConfigUnsubscribe = accountProviderConfigSource?.onDidChange((reason) => {
    void handleAccountProviderConfigChanged(reason).catch((error) => {
      logger.warn(undefined, "account provider config 热同步失败", {
        message: error instanceof Error ? error.message : String(error),
        reason,
      });
    });
  });

  async function syncAccountProviderConfigToClient(params: {
    client: ZCodeProtocolClient;
    reason: string;
    refreshRegistry?: boolean;
  }): Promise<void> {
    if (!accountProviderConfigSource) return;
    const previous = accountConfigSyncByClient.get(params.client) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // A previous failure must not block a newer Account Config; this call retries.
      })
      .then(async () => {
        // An asynchronous read before queueing may return late and put an old result after a new one. Reads and delivery
        // share the existing Client serial queue; do not add a send barrier or infer ordering from content revisions.
        const snapshot = await accountProviderConfigSource.read();
        // Skip delivery when the client already acknowledged this exact revision; reads and delivery share the Client serial queue.
        if (accountConfigReceivedRevisionByClient.get(params.client) !== snapshot.revision) {
          const result = await params.client.request(
            zcodeProtocolMethods.providerUpdateAccountConfig,
            {
              revision: snapshot.revision,
              basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
              // Account is a runtime-facts envelope, not the on-disk Provider rule set; preserve the existing protocol dictionary.
              providers: Object.fromEntries(
                [...snapshot.providers.entries()].map(([providerId, config]) => [
                  providerId,
                  config.toJSON(),
                ]),
              ),
              states: snapshot.states ?? {},
            },
            zcodeProviderUpdateAccountConfigResultSchema,
          );
          if (result.receivedRevision !== snapshot.revision) {
            throw new Error("Account Config 接收回执版本与交付版本不一致");
          }
          accountConfigReceivedRevisionByClient.set(params.client, result.receivedRevision);
          logger.info(undefined, "account provider config delivered to ZCode agent", {
            providerCount: result.providerCount,
            reason: params.reason,
            receivedRevision: result.receivedRevision,
            status: result.status,
          });
        }
        if (params.refreshRegistry) {
          await params.client.request(
            zcodeProtocolMethods.providerRefreshRegistry,
            { reason: params.reason },
            zcodeProviderRefreshRegistryResultSchema,
          );
        }
      });
    accountConfigSyncByClient.set(params.client, current);
    try {
      await current;
    } finally {
      if (accountConfigSyncByClient.get(params.client) === current) {
        accountConfigSyncByClient.delete(params.client);
      }
    }
  }

  async function ensureAccountProviderConfigSynced(params: {
    client: ZCodeProtocolClient;
    reason: string;
    workspace: ZCodeAgentWorkspaceTarget;
    refreshRegistry?: boolean;
  }): Promise<void> {
    await syncAccountProviderConfigToClient({
      client: params.client,
      reason: params.reason,
      refreshRegistry: params.refreshRegistry,
    });
  }

  async function handleAccountProviderConfigChanged(reason: string): Promise<void> {
    await Promise.all(
      Array.from(activeClientsByWorkspaceKey.values()).map(async (active) => {
        await syncAccountProviderConfigToClient({
          client: active.client,
          reason,
        });
      }),
    );
  }

  function enqueueInteractionPreferenceSync(params: {
    client: ZCodeProtocolClient;
    preferences: ZCodeAgentAppRuntimePreferences;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const previous = interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // A previous failure must not reorder subsequent toggle submissions; continue trying this snapshot.
      })
      .then(async () => {
        await params.client.request(
          zcodeProtocolMethods.workspaceUpdateInteractionPreferences,
          {
            workspace: buildWorkspaceRef(params.workspace),
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                params.preferences.askUserQuestionAutoResolutionEnabled,
            },
          },
          zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
        );
        try {
          await params.client.request(
            zcodeProtocolMethods.workspaceUpdateModelIoPreferences,
            {
              workspace: buildWorkspaceRef(params.workspace),
              preferences: {
                fullRetentionEnabled: params.preferences.modelIoFullRetentionEnabled === true,
              },
            },
            zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
          );
        } catch (error) {
          // A newer Host remains compatible with an unupgraded CLI: only method-not-found may downgrade; other synchronous failures must still be thrown.
          if (!isProtocolMethodNotFoundError(error)) throw error;
        }
      });
    interactionPreferenceSyncByWorkspaceKey.set(workspaceKey, current);
    void current.then(
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
      () => {
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
    );
    return current;
  }

  async function handleProviderReadinessChanged(event: {
    reason: string;
    snapshot: ZCodeAgentProviderReadinessSnapshot;
  }): Promise<void> {
    if (event.snapshot.readiness.ready) {
      await Promise.allSettled(
        Array.from(waitingWorkspaceStartups.entries()).map(async ([workspaceKey, waiting]) => {
          // A ready event may arrive before the old readiness read returns. First settle the old attempt, then read the new state,
          // so the event does not reuse a Promise that is about to fail with provider-not-ready and lose the only ready notification.
          try {
            await waiting.starting;
          } catch (error) {
            if (!isProviderNotReadyError(error)) throw error;
          }
          // Bug cause: the provider-ready event snapshots the waiting list before starting asynchronously; if the workspace is
          // removed during await, the stale snapshot can restart an Agent that was already released. Allow only the current
          // generation for the waiting identity to continue; callbacks after removal or generation change must be invalidated.
          if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
            return;
          }
          const { workspace } = waiting;
          const client = await getClient(workspace);
          await ensureAccountProviderConfigSynced({
            client,
            reason: `startup_ready:${event.reason}`,
            workspace,
          });
          logger.info(undefined, "provider/model 就绪后已启动等待中的 ZCode agent", {
            providerCount: event.snapshot.providerCount,
            reason: event.reason,
            revision: event.snapshot.revision,
            workspaceKey: resolveWorkspaceKey(workspace),
            workspacePath: workspace.workspacePath,
          });
        }),
      );
    }
  }

  function getSessionEmitter(params: ZCodeAgentSessionTarget) {
    const key = sessionEventKey(params);
    const existing = sessionEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ZCodeAgentServiceEvent>();
    sessionEmitters.set(key, created);
    return created;
  }

  function getPluginOperationProgressEmitter(operationId: string) {
    const existing = pluginOperationProgressEmitters.get(operationId);
    if (existing) return existing;
    let created: Emitter<ZCodePluginOperationProgressNotification>;
    created = new Emitter({
      onDidRemoveLastListener: () => {
        if (pluginOperationProgressEmitters.get(operationId) !== created) return;
        pluginOperationProgressEmitters.delete(operationId);
        created.dispose();
      },
    });
    pluginOperationProgressEmitters.set(operationId, created);
    return created;
  }

  function getConversationFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ConversationTopicWireCandidate>();
    conversationFrameEmitters.set(key, created);
    return created;
  }

  function getProviderRuntimeHeadersWorkspaceEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = providerRuntimeHeadersWorkspaceEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<ZCodeProviderRuntimeHeadersRequestParams>();
    providerRuntimeHeadersWorkspaceEmitters.set(key, created);
    return created;
  }

  function getConversationTelemetryFactEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationTelemetryFactEmitters.get(key);
    if (existing) return existing;
    const created = new Emitter<ConversationTelemetryFact>();
    conversationTelemetryFactEmitters.set(key, created);
    return created;
  }

  function getOffPeakLifecycleEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    let emitter = offPeakLifecycleEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<OffPeakLifecycleNotification>();
      offPeakLifecycleEmitters.set(key, emitter);
    }
    return emitter;
  }

  function getSessionsIndexFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = sessionsIndexFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<SessionsIndexTopicWireCandidate>();
    sessionsIndexFrameEmitters.set(key, created);
    return created;
  }

  function getWorkspaceConfigFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    const existing = workspaceConfigFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
    const created = new Emitter<WorkspaceConfigTopicWireCandidate>();
    workspaceConfigFrameEmitters.set(key, created);
    return created;
  }

  /** v4 subscription connectionId: distinguish multiple consumers in one host process (renderer/syncer) with a scope suffix. */
  function v4ConnectionIdFor(subscriberScope?: string): string {
    return subscriberScope ? `${v4ConnectionId}#${subscriberScope}` : v4ConnectionId;
  }

  function resolveV4Connection(
    params: unknown,
    fallbackConnectionId: string = v4ConnectionId,
  ): ZCodeAgentV4ConnectionContext {
    return (
      readTrustedZCodeAgentV4Connection(params) ?? {
        // Without a trusted carrier this is a direct call from the host: subscribe as an old consumer (whole-key patch) without guessing capabilities.
        connectionId: fallbackConnectionId,
        clientMode: "desktop-continuous" as const,
      }
    );
  }

  function v4SubscriptionRouteKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.subscriptionId}\0${route.connectionId}`;
  }

  function v4SubscriptionOwnershipKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.connectionId}`;
  }

  function rememberV4SubscriptionRoute(
    workspace: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ): void {
    const route: V4SubscriptionRoute = {
      workspaceKey: resolveWorkspaceKey(workspace),
      topic,
      subscriptionId,
      connectionId,
    };
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    const previous = v4RouteKeyByOwnership.get(ownershipKey);
    if (previous) v4SubscriptionRoutes.delete(previous);
    const routeKey = v4SubscriptionRouteKey(route);
    v4RouteKeyByOwnership.set(ownershipKey, routeKey);
    v4SubscriptionRoutes.set(routeKey, route);
  }

  function forgetV4SubscriptionRoute(route: V4SubscriptionRoute): void {
    const routeKey = v4SubscriptionRouteKey(route);
    v4SubscriptionRoutes.delete(routeKey);
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    if (v4RouteKeyByOwnership.get(ownershipKey) === routeKey) {
      v4RouteKeyByOwnership.delete(ownershipKey);
    }
  }

  function isCurrentV4SubscriptionRoute(route: V4SubscriptionRoute): boolean {
    return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) === route;
  }

  function clearV4SubscriptionRoutes(workspaceKey?: string): void {
    for (const route of v4SubscriptionRoutes.values()) {
      if (workspaceKey !== undefined && route.workspaceKey !== workspaceKey) {
        continue;
      }
      forgetV4SubscriptionRoute(route);
    }
  }

  function resolveV4UnsubscribeRoute(
    params: ZCodeAgentConversationUnsubscribeParams | ZCodeAgentConversationResyncParams,
    topicPrefix: string,
  ): V4SubscriptionRoute | null {
    const expectedWorkspaceKey = resolveWorkspaceKey(params);
    const trusted = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (trusted) {
      if (!trusted.topic.startsWith(topicPrefix)) return null;
      const route: V4SubscriptionRoute = {
        workspaceKey: expectedWorkspaceKey,
        topic: trusted.topic,
        subscriptionId: params.subscriptionId,
        connectionId: trusted.connectionId,
      };
      return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) ?? null;
    }
    // Internal consumers calling the base service directly have no facade carrier; support them only when there is a unique
    // match in the method topic domain. Reject ambiguous matches instead of guessing, and never broadcast removals to multiple publishers.
    const matches = [...v4SubscriptionRoutes.values()].filter(
      (route) =>
        route.workspaceKey === expectedWorkspaceKey &&
        route.subscriptionId === params.subscriptionId &&
        route.topic.startsWith(topicPrefix),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  async function unsubscribeV4Route(
    params: ZCodeAgentConversationUnsubscribeParams,
    topicPrefix: string,
  ): Promise<void> {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) return;
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    // getReadOnlyClient may start a new runtime while awaiting; the restart listener has cleared the old route, and the new
    // runtime may reuse the same key/subId. Recheck by object identity; do not send a locally held stale route to the new CLI.
    if (!isCurrentV4SubscriptionRoute(route)) return;
    await client.request(
      V4_METHODS.conversationUnsubscribe,
      {
        topic: route.topic,
        subscriptionId: route.subscriptionId,
        connectionId: route.connectionId,
      },
      zcodeProtocolEmptyResultSchema,
    );
    // A runtime restart/resubscription during an in-flight request may create a new object with the same route key;
    // a late response from the old generation may clean up only that generation, not delete the new route by its composite key.
    if (isCurrentV4SubscriptionRoute(route)) forgetV4SubscriptionRoute(route);
  }

  async function resyncV4Route(params: ZCodeAgentConversationResyncParams, topicPrefix: string) {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) throw new Error("fault.subscription.notOwned");
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = await client.request(
      V4_METHODS.conversationResync,
      {
        topic: route.topic,
        connectionId: route.connectionId,
        subscriptionId: route.subscriptionId,
        base: params.base,
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      },
      v4ConversationResyncResultSchema,
    );
    // A resync ACK is valid only for the route generation that initiated it. If a restart/resubscription happened while awaiting,
    // returning stale success would make the consumer treat old recovery as the result for the new subscription.
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    return result;
  }

  function emitSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
    event: ZCodeAgentServiceEvent,
  ): void {
    sessionEmitters.get(sessionEventKey({ ...workspace, sessionId }))?.fire(event);
  }

  function emitWorkspaceEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeAgentServiceEvent,
  ): void {
    const workspaceKey = resolveWorkspaceKey(workspace);
    for (const [key, emitter] of sessionEmitters) {
      if (key.startsWith(`${workspaceKey}\u0000`)) {
        emitter.fire(event);
      }
    }
  }

  function getSessionEventSequenceState(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): SessionEventSequenceState {
    const key = sessionEventKey({ ...workspace, sessionId });
    const existing = sessionEventSequenceStates.get(key);
    if (existing) {
      return existing;
    }
    const created: SessionEventSequenceState = {
      assignedSeqByEventId: new Map<string, number>(),
      assignedSeqEventIds: [],
      liveEventIds: new Set<string>(),
      liveEventIdOrder: [],
      lastAssignedSeq: 0,
    };
    sessionEventSequenceStates.set(key, created);
    return created;
  }

  function normalizeSessionEventSeq(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): ZCodeSessionEvent {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    if (event.seq > 0) {
      state.lastAssignedSeq = Math.max(state.lastAssignedSeq, event.seq);
      return event;
    }

    const assignedSeq = state.assignedSeqByEventId.get(event.eventId);
    if (assignedSeq !== undefined) {
      return { ...event, seq: assignedSeq };
    }

    const nextSeq = state.lastAssignedSeq + 1;
    state.lastAssignedSeq = nextSeq;
    state.assignedSeqByEventId.set(event.eventId, nextSeq);
    state.assignedSeqEventIds.push(event.eventId);
    while (state.assignedSeqEventIds.length > MAX_TRACKED_SESSION_EVENT_IDS) {
      const removed = state.assignedSeqEventIds.shift();
      if (removed) {
        state.assignedSeqByEventId.delete(removed);
      }
    }
    // The old agent live sink sent createSessionEvent to the app with its default seq=0,
    // while replay/read assigned a sequence later through the event store. Keep this only for old-version compatibility; the event store remains the ordering source for new runtimes.
    return { ...event, seq: nextSeq };
  }

  function shouldDeliverLiveSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): boolean {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    return rememberBoundedEventId(state.liveEventIds, state.liveEventIdOrder, event.eventId);
  }

  function handleSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): void {
    const normalizedEvent = normalizeSessionEventSeq(workspace, event);
    if (!shouldDeliverLiveSessionEvent(workspace, normalizedEvent)) {
      return;
    }
    emitSessionEvent(workspace, normalizedEvent.sessionId, {
      type: "session.event",
      event: normalizedEvent,
    });
  }

  function handleStateUpdated(
    workspace: ZCodeAgentWorkspaceTarget,
    notification: ZCodeStateUpdatedNotification,
  ): void {
    if (notification.sessionId) {
      emitSessionEvent(workspace, notification.sessionId, {
        type: "state.updated",
        notification,
      });
      return;
    }
    emitWorkspaceEvent(workspace, { type: "state.updated", notification });
  }

  function wireClient(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    /**
     * Process lane that owns this client. The CLI process does not know which process manager started it,
     * so the caller must supply the lane for resource samples here.
     */
    lane: ProcessResourceCliLane,
  ): void {
    if (wiredClients.has(client)) {
      return;
    }
    wiredClients.add(client);
    const topicResources = createTopicResourceBridge(() => {
      // Prewarming may not have a remoteSessionId; do not permanently capture wireClient’s initial arguments.
      // Get routing from the current trusted entry point for the same actual CLI and keep it stable throughout one resource operation.
      const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace));
      const resourceWorkspace =
        active?.client === client ? { ...active.workspace } : { ...workspace };
      return {
        validate: (request, signal, trace) => {
          if (!options?.topicResourceValidator)
            throw new Error("Topic resource authorization is unavailable");
          return options.topicResourceValidator(
            { ...request, ...resourceWorkspace, trace },
            signal,
          );
        },
        read: (request, signal, trace) => {
          if (!options?.topicResourceExecutor)
            throw new Error("Topic attachment retrieval is unavailable on this host");
          return options.topicResourceExecutor({ ...request, ...resourceWorkspace, trace }, signal);
        },
        upload: (request, attachment, signal, trace) =>
          uploadTopicResourceToClient(
            client,
            v4ConnectionId,
            { ...resourceWorkspace, sessionId: request.taskId },
            attachment,
            signal,
            trace,
          ),
      };
    });
    const disposables = [
      topicResources,
      client.onNotification((message) => {
        if (message.method === zcodeProtocolNotifications.providerRuntimeHeadersCancelled) {
          const parsed = zcodeProviderRuntimeHeadersCancelledSchema.safeParse(message.params);
          if (
            !parsed.success ||
            resolveWorkspaceKey(parsed.data.workspace) !== resolveWorkspaceKey(workspace)
          )
            return;
          const key = providerRuntimeHeadersRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const pending = pendingProviderRuntimeHeaders.get(key);
          // Cancellation from an old client or a different identity at the same path must not delete requests for a new runtime or another workspace.
          if (pending?.client === client) cancelProviderRuntimeHeaders(key, pending);
          return;
        }
        if (message.method === zcodeProtocolNotifications.processResourceSample) {
          const parsed = zcodeProcessResourceSampleSchema.safeParse(message.params);
          if (parsed.success) {
            processResourceSampleEmitter.fire({ ...parsed.data, lane });
          } else {
            logger.debug(undefined, "丢弃无效 ZCode CLI 资源样本", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolNotifications.toolExecResource) {
          const parsed = zcodeToolExecResourceSchema.safeParse(message.params);
          if (parsed.success) toolExecResourceEmitter.fire(parsed.data);
          return;
        }
        if (message.method === zcodeProtocolNotifications.mcpResourceSamples) {
          const parsed = zcodeMcpResourceSamplesSchema.safeParse(message.params);
          if (parsed.success) mcpResourceSamplesEmitter.fire(parsed.data);
          else logger.debug(undefined, "丢弃无效 MCP 资源样本");
          return;
        }

        if (message.method === zcodeProtocolNotifications.mcpTelemetry) {
          const parsed = zcodeMcpTelemetryEventSchema.safeParse(message.params);
          if (parsed.success) {
            mcpTelemetryEmitter.fire(parsed.data);
          } else {
            logger.debug(undefined, "丢弃无效 ZCode CLI MCP 遥测事件", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolNotifications.pluginOperationProgress) {
          const parsed = zcodePluginOperationProgressNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            pluginOperationProgressEmitters.get(parsed.data.operationId)?.fire(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 ZCode Protocol 插件操作进度", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolNotifications.chatGptPlanUsageUpdated) {
          const parsed = zcodeChatGptPlanUsageUpdatedParamsSchema.safeParse(message.params);
          const accountKey = parsed.success
            ? parseChatGptPlanAccountProviderId(parsed.data.providerId)
            : null;
          if (parsed.success && accountKey) {
            chatGptPlanUsageRecorder?.recordUsage(accountKey, parsed.data.usage);
          } else if (!parsed.success) {
            logger.warn(undefined, "Dropped invalid ChatGPT plan usage notification", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolMethods.computerUseOperationEvent) {
          const parsed = zcodeComputerUseOperationEventSchema.safeParse(message.params);
          if (parsed.success) {
            // v4 sessions do not project legacy session/event data; CUA indicators must consume runtime sideband directly,
            // avoiding a mix of sequenceNumber/seq from two independent event streams.
            cuaOperationTurnTracker?.accept(workspace, parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 ZCode Protocol Computer Use operation event", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === "session/event") {
          const parsed = zcodeSessionEventSchema.safeParse(message.params);
          if (parsed.success) {
            handleSessionEvent(workspace, parsed.data);
          } else {
            const rawParams =
              typeof message.params === "object" && message.params !== null
                ? (message.params as Record<string, unknown>)
                : {};
            logger.warn(
              typeof rawParams.traceId === "string" ? rawParams.traceId : undefined,
              "丢弃无效 ZCode Protocol session event",
              {
                eventId: rawParams.eventId,
                issues: parsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                sessionId: rawParams.sessionId,
                type: rawParams.type,
              },
            );
          }
          return;
        }

        if (message.method === "state.updated") {
          const parsed = zcodeStateUpdatedNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            handleStateUpdated(workspace, parsed.data);
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.localTtftFacts) {
          const parsed = localTtftFactsSchema.safeParse(message.params);
          if (parsed.success && !workspace.remoteSessionId && !workspace.workspaceIdentity?.trim())
            localTtftFactsEmitter.fire({
              workspaceKey: resolveWorkspaceKey(workspace),
              facts: parsed.data,
            });
          return;
        }
        if (message.method === V4_NOTIFICATIONS.conversationTelemetryFact) {
          const parsed = conversationTelemetryFactSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationTelemetryFactEmitter(workspace).fire(parsed.data);
          } else {
            // Strictly discard unknown fields so new CLI runtime fields do not reach the renderer reporter without review.
            logger.warn(undefined, "丢弃无效 v4 conversation telemetry fact", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
        if (message.method === V4_NOTIFICATIONS.offPeakLifecycle) {
          const parsed = offPeakLifecycleNotificationSchema.safeParse(message.params);
          if (parsed.success) getOffPeakLifecycleEmitter(workspace).fire(parsed.data);
          else
            logger.warn(undefined, "丢弃无效闲时生命周期通知", {
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          return;
        }

        if (message.method === V4_NOTIFICATIONS.pluginUiToolResult) {
          const parsed = pluginUiToolResultNotificationSchema.safeParse(message.params);
          // 只接受当前本地 runtime；旧进程迟到结果和远程客户端不能在本窗口创建 UI。
          if (
            parsed.success &&
            !workspace.remoteSessionId &&
            !isRemoteWorkspaceIdentity(workspace.workspaceIdentity ?? "") &&
            activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace))?.client === client
          ) {
            pluginUiToolResultEmitter.fire({
              ...parsed.data,
              workspacePath: workspace.workspacePath,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
            });
          }
          return;
        }
        if (message.method === V4_NOTIFICATIONS.cuaPermissionObservation) {
          const parsed = cuaPermissionObservationSchema.safeParse(message.params);
          if (
            parsed.success &&
            !workspace.remoteSessionId &&
            !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
          ) {
            cuaPermissionObservationEmitter.fire({
              ...parsed.data,
              workspacePath: workspace.workspacePath,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
            });
          } else if (!parsed.success) {
            // Permission observation triggers renderer side effects, so unknown fields must fail closed rather than pass through permissively.
            logger.warn(undefined, "丢弃无效 v4 CUA 权限观察", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.conversationFrame) {
          // The same notification also carries sessions-index frames; route them by topic prefix to the list emitter
          // (otherwise conversation schema validation would discard them).
          const topic = (message.params as { topic?: unknown } | null)?.topic;
          if (typeof topic === "string" && topic.startsWith("sessions-index/")) {
            const indexParsed = sessionsIndexTopicWireCandidateSchema.safeParse(message.params);
            if (indexParsed.success) {
              getSessionsIndexFrameEmitter(workspace).fire(indexParsed.data);
            } else {
              logger.warn(undefined, "丢弃无效 v4 sessions-index frame", {
                issues: indexParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          if (typeof topic === "string" && topic.startsWith("workspace-config/")) {
            const configParsed = workspaceConfigTopicWireCandidateSchema.safeParse(message.params);
            if (configParsed.success) {
              getWorkspaceConfigFrameEmitter(workspace).fire(configParsed.data);
            } else {
              logger.warn(undefined, "丢弃无效 v4 workspace-config frame", {
                issues: configParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          const parsed = conversationTopicWireCandidateSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationFrameEmitter(workspace).fire(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 v4 conversation frame", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
      }),
      client.onRequest((request) => {
        if (request.method === zcodeProtocolMethods.subagentsReadRuntimeConfig) {
          void (async () => {
            const parsed = zcodeSubagentsReadRuntimeConfigParamsSchema.safeParse(request.params);
            if (!parsed.success) {
              await client.respondError(request.id, {
                code: -32602,
                message: "Invalid subagent runtime config request",
              });
              return;
            }
            let configuration: SubagentRuntimeConfig;
            try {
              if (!options?.readSubagentRuntimeConfig)
                throw new Error("Subagent runtime config is unavailable on this Host");
              configuration = subagentRuntimeConfigSchema.parse(
                await options.readSubagentRuntimeConfig(workspace),
              );
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
              return;
            }
            await client.respond(request.id, configuration);
          })().catch((error) =>
            logger.debug(undefined, "Subagent 配置响应发送失败", { error: String(error) }),
          );
          return;
        }
        if (request.method === zcodeProtocolMethods.channelReply) {
          void (async () => {
            const params = channelReplyRequestSchema.parse(request.params);
            if (!options?.channelReplyExecutor) throw new Error("Channel reply unavailable");
            const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace));
            if (active?.client !== client)
              throw new Error("Channel reply client is no longer active");
            const currentWorkspace = active.workspace;
            const result = await options.channelReplyExecutor({
              ...params,
              // An active connection also carries internal fields such as the V4 envelope; the cross-reply contract may project only workspace identity, not spread the entire object.
              workspacePath: currentWorkspace.workspacePath,
              workspaceIdentity: currentWorkspace.workspaceIdentity,
              remoteSessionId: currentWorkspace.remoteSessionId,
              trace: request.trace,
            });
            await client.respond(request.id, result);
          })().catch((error: unknown) =>
            client.respondError(request.id, {
              code: -32603,
              message: error instanceof Error ? error.message : "Channel reply failed",
            }),
          );
          return;
        }
        if (request.method === zcodeProtocolMethods.topicResourceRead) {
          void topicResources
            .read(request.params, request.trace)
            .then((result) => client.respond(request.id, result))
            .catch((error: unknown) =>
              client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : "Topic resource read failed",
              }),
            );
          return;
        }
        if (request.method === zcodeProtocolMethods.topicResourceCancel) {
          const parsed = zcodeTopicResourceCancelParamsSchema.safeParse(request.params);
          void client.respond(request.id, {
            cancelled: parsed.success && topicResources.cancel(parsed.data),
          });
          return;
        }
        if (request.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
          const reportResponseFailure = (error: unknown): void => {
            logger.debug(undefined, "运行时偏好响应发送失败", {
              error: error instanceof Error ? error.message : String(error),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          };
          const parsed = zcodeSessionRequestRuntimePreferencesParamsSchema.safeParse(
            request.params,
          );
          if (!parsed.success) {
            void client
              .respondError(request.id, {
                code: -32602,
                message: "Invalid session runtime preferences request params",
                data: parsed.error.flatten(),
              })
              .catch(reportResponseFailure);
            return;
          }
          if (sessionRuntimePreferencesAuthority === "local") {
            void (async () => {
              let preferences: ZCodeSessionRuntimePreferencesResult;
              try {
                preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
                  // The same RPC covers both runtime creation and first execution; continue passing the
                  // validated scope to avoid waiting for remote client config again before the first Shell execution.
                  (await resolveSessionRuntimePreferences?.(parsed.data.scope)) ?? {
                    askUserQuestionAutoResolutionEnabled: true,
                    nativeSearchEnhancementsEnabled: true,
                    memoryEnabled: false,
                  },
                );
                if (
                  parsed.data.scope === "runtime-materialization" &&
                  options?.resolveSessionDirectories
                ) {
                  preferences.additionalDirectories = await options.resolveSessionDirectories({
                    ...workspace,
                    sessionId: parsed.data.sessionId,
                  });
                }
                preferences.subagentRuntimeConfigEnabled =
                  Boolean(options?.readSubagentRuntimeConfig) &&
                  !(
                    workspace.workspaceIdentity &&
                    isRemoteWorkspaceIdentity(workspace.workspaceIdentity)
                  );
              } catch (error) {
                await client.respondError(request.id, {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                });
                return;
              }
              // A failed response send means the transport is closed; do not treat it as a settings-read failure
              // and attempt to send a second error response.
              await client.respond(request.id, preferences);
            })().catch(reportResponseFailure);
            return;
          }

          const requestId = randomUUID();
          const dynamicRequest: ZCodeAgentSessionRuntimePreferencesRequest = {
            ...parsed.data,
            requestId,
          };
          pendingSessionRuntimePreferences.set(requestId, {
            client,
            protocolRequestId: request.id,
            request: dynamicRequest,
            workspace,
            timeout: setTimeout(
              () => expireSessionRuntimePreferencesRequest(requestId),
              ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
            ),
            workspaceKey: resolveWorkspaceKey(workspace),
          });
          logger.info(undefined, "运行时偏好请求已转发给 Host", {
            event: "zcode_agent.runtime_preferences.host_request_dispatched",
            module: "services.zcode_agent",
            requestId,
            scope: dynamicRequest.scope,
            sessionId: dynamicRequest.sessionId,
            workspaceKey: resolveWorkspaceKey(workspace),
          });
          sessionRuntimePreferencesRequestEmitter.fire(dynamicRequest);
          return;
        }

        if (request.method === zcodeProtocolMethods.interactionRequestPermission) {
          const parsed = zcodePermissionRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid permission request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const key = permissionRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const wasPending = pendingPermissions.has(key);
          pendingPermissions.set(key, {
            client,
            protocolRequestId: request.id,
          });
          if (!wasPending) {
            emitSessionEvent(workspace, parsed.data.sessionId, {
              type: "permission.request",
              request: parsed.data,
            });
          }
          return;
        }

        if (request.method === zcodeProtocolMethods.interactionRequestUserInput) {
          const parsed = zcodeUserInputRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid user input request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const key = userInputRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const wasPending = pendingUserInputs.has(key);
          pendingUserInputs.set(key, { client, protocolRequestId: request.id });
          if (!wasPending) {
            // To recover a lost protocol ID, the agent resends the same business requestId.
            // The host must refresh the protocolRequestId it can respond to without broadcasting to the UI again,
            // or a multi-question AskUserQuestion would reset to the first page when the user moves to a later question.
            emitSessionEvent(workspace, parsed.data.sessionId, {
              type: "userInput.request",
              request: parsed.data,
            });
          }
          return;
        }

        if (request.method === zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders) {
          const parsed = zcodeProviderRuntimeHeadersRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid provider runtime headers request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const pendingKey = providerRuntimeHeadersRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const pending = {
            client,
            protocolRequestId: request.id,
            request: parsed.data,
          };
          pendingProviderRuntimeHeaders.set(pendingKey, pending);
          logger.info(request.trace?.traceId, "收到 ZCode provider runtime headers 请求", {
            modelId: parsed.data.modelSelection.modelId,
            providerId: parsed.data.providerId,
            requestId: parsed.data.requestId,
            sessionId: parsed.data.sessionId,
            turnId: parsed.data.turnId ?? null,
            workspaceKey: resolveWorkspaceKey(workspace),
            workspacePath: workspace.workspacePath,
          });
          const accountAccess = parsed.data.accountAccess;
          if (
            accountRequestAuthService &&
            ((accountAccess && !requiresRequestVerification(accountAccess)) ||
              (chatGptPlanRequestAuth && isChatGptPlanAccountProviderId(parsed.data.providerId)))
          ) {
            // Account API Keys and Team Runtime Keys require no Renderer interaction. The Host automatically responds using the Account Access fixed by the Model
            // to avoid making background tasks and sessions without a pane depend on UI subscribers.
            void respondAccountRequestAuthWithoutInteraction({
              key: pendingKey,
              pending,
            });
            return;
          }
          if (!requestVerificationInteractionAvailable) {
            pendingProviderRuntimeHeaders.delete(pendingKey);
            void pending.client.respond(pending.protocolRequestId, {
              headersApplied: false,
              errorMessage: "Provider request auth is unavailable",
            });
            return;
          }
          emitSessionEvent(workspace, parsed.data.sessionId, {
            type: "providerRuntimeHeaders.request",
            request: parsed.data,
          });
          // Workspace-level mirrored delivery: the persistent responder in the Desktop window (one per open workspace tab)
          // does not know the sessionId, so it must receive the same request here by workspaceKey.
          providerRuntimeHeadersWorkspaceEmitters
            .get(resolveWorkspaceKey(workspace))
            ?.fire(parsed.data);
          return;
        }

        // Official Server MCP identity headers: pure RPC relay; the host resolves and responds automatically.
        // Do not emitSessionEvent or add to the pending map—this request has no UI semantics and the renderer is not involved.
        if (request.method === zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders) {
          const parsed = zcodeOfficialMcpAuthHeadersRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/requestOfficialMcpAuthHeaders params",
              data: parsed.error.flatten(),
            });
            return;
          }
          // The host-side second check must happen **before reading credentials**: return on a miss without calling resolveHeaders,
          // so no credentials are read into memory.
          void (async () => {
            const trustedOrigins = options?.officialMcpTrustedOrigins;
            const trust = trustedOrigins
              ? await trustedOrigins
                  .isTrusted({
                    mcpKey: parsed.data.mcpKey,
                    origin: parsed.data.targetOrigin,
                    pluginId: parsed.data.pluginId,
                  })
                  // Treat errors in the check itself as untrusted; never allow a request through because validation failed.
                  .catch(() => ({ detail: "validator_error", trusted: false }))
              : { detail: "validator_missing", trusted: false };
            if (!trust.trusted) {
              // Record only non-sensitive request context; credentials were not read and therefore cannot be exposed.
              logger.warn(request.trace?.traceId, "官方 MCP 身份头请求未通过 host 侧可信校验", {
                detail: trust.detail ?? "unknown",
                mcpKey: parsed.data.mcpKey,
                pluginId: parsed.data.pluginId,
                requestId: parsed.data.requestId,
                targetOrigin: parsed.data.targetOrigin,
                workspaceKey: parsed.data.workspace.workspaceKey,
              });
              void client.respond(request.id, {
                ok: false,
                reason: "official_mcp_origin_untrusted",
              });
              return;
            }
            const resolver = options?.officialMcpAuthHeadersResolver;
            if (!resolver) {
              void client.respond(request.id, {
                ok: false,
                reason: "official_auth_unavailable",
              });
              return;
            }
            try {
              const resolveStartedAt = Date.now();
              const result = await resolver.resolveHeaders({
                mcpKey: parsed.data.mcpKey,
                pluginId: parsed.data.pluginId,
                targetOrigin: parsed.data.targetOrigin,
                workspace: parsed.data.workspace,
              });
              // The host cannot log only failures; a silent success path would make it impossible to answer "which headers were sent?"
              // Log only header names and plan tier; never log credential values because log retention is not controlled here.
              if (result.ok) {
                const firstIssuance = officialMcpIssuanceAudit.markFirst(
                  parsed.data.pluginId,
                  parsed.data.mcpKey,
                  parsed.data.workspace.workspaceKey,
                );
                const logIssuance = firstIssuance ? logger.info : logger.debug;
                logIssuance(request.trace?.traceId, "官方 MCP 身份头已解析", {
                  firstIssuance,
                  ...summarizeOfficialMcpIdentityHeaders(result.headers),
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  requestId: parsed.data.requestId,
                  resolveDurationMs: Date.now() - resolveStartedAt,
                  targetOrigin: parsed.data.targetOrigin,
                });
              } else {
                logger.info(request.trace?.traceId, "官方 MCP 身份头不可用", {
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  reason: result.reason,
                  requestId: parsed.data.requestId,
                  resolveDurationMs: Date.now() - resolveStartedAt,
                  targetOrigin: parsed.data.targetOrigin,
                });
              }
              void client.respond(request.id, result);
            } catch (error: unknown) {
              // Return resolver errors as unavailable instead of respondError: the adapter routes only on enumerable reasons,
              // and MCP must never fall back to an anonymous request here. Do not log raw credential values.
              logger.warn(request.trace?.traceId, "官方 MCP 身份头解析失败", {
                error: error instanceof Error ? error.message : String(error),
                mcpKey: parsed.data.mcpKey,
                pluginId: parsed.data.pluginId,
                requestId: parsed.data.requestId,
                targetOrigin: parsed.data.targetOrigin,
              });
              void client.respond(request.id, {
                ok: false,
                reason: "official_auth_unavailable",
              });
            }
          })();
          return;
        }

        // browser-use discovery: backend availability and plugin/skill exposure are separate states.
        // Return an empty list without an executor; the facade must not fabricate IAB availability.
        if (request.method === zcodeProtocolMethods.interactionBrowserList) {
          const parsed = zcodeBrowserListParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserList params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const executor = options?.browserControlExecutor;
          if (!executor) {
            void client.respond(request.id, { browsers: [] });
            return;
          }
          void executor
            .list(parsed.data)
            .then((browsers) => client.respond(request.id, { browsers }))
            .catch((error: unknown) => {
              void client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          return;
        }

        // browser-use: the agent's agent.browsers.* requests arrive here through interaction/browserExecute.
        // Pure RPC relay—forward to main (WebContentsView+CDP), then respondResult; do not emitSessionEvent
        // or use the pending map (unlike the UI-blocking permission flow). Without an executor, return backend_unavailable.
        if (request.method === zcodeProtocolMethods.interactionBrowserExecute) {
          const parsed = zcodeBrowserExecuteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserExecute params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const executor = options?.browserControlExecutor;
          if (!executor) {
            void client.respond(request.id, {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: "browser control not available",
              },
              elapsedMs: 0,
            });
            return;
          }
          void executor
            .execute({
              requestId: parsed.data.requestId,
              ...(parsed.data.browserId ? { browserId: parsed.data.browserId } : {}),
              ...(parsed.data.browserGeneration !== undefined
                ? { browserGeneration: parsed.data.browserGeneration }
                : {}),
              sessionId: parsed.data.sessionId,
              ...(parsed.data.turnId ? { turnId: parsed.data.turnId } : {}),
              workspaceKey: parsed.data.workspaceKey ?? resolveWorkspaceKey(workspace),
              workspacePath: parsed.data.workspacePath ?? workspace.workspacePath,
              ...((parsed.data.workspaceIdentity ?? workspace.workspaceIdentity)
                ? {
                    workspaceIdentity: parsed.data.workspaceIdentity ?? workspace.workspaceIdentity,
                  }
                : {}),
              ...(parsed.data.remoteSessionId
                ? { remoteSessionId: parsed.data.remoteSessionId }
                : {}),
              clientMode: parsed.data.clientMode ?? "desktop-continuous",
              sessionContext: parsed.data.sessionContext ?? "live",
              command: parsed.data.command,
            })
            .then((result) => client.respond(request.id, result))
            .catch((error: unknown) => {
              void client.respond(request.id, {
                ok: false,
                error: {
                  code: "execution_error",
                  message: error instanceof Error ? error.message : String(error),
                },
                elapsedMs: 0,
              });
            });
          return;
        }

        if (request.method === zcodeProtocolMethods.automationCreate) {
          const parsed = zcodeAutomationCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const automation = await automationService.create({
                title: parsed.data.title ?? "",
                cronExpr: parsed.data.cronExpr,
                relativeDelayMinutes: parsed.data.relativeDelayMinutes,
                // Pass the session-side long-interval carrier (intervalUnit+interval) to the service to normalize into the authoritative scheduleRule.
                intervalUnit: parsed.data.intervalUnit,
                interval: parsed.data.interval,
                prompt: parsed.data.prompt,
                modelSelection: parsed.data.modelSelection,
                mode: parsed.data.mode,
                targetTaskId: parsed.data.targetTaskId,
                botDeliveryTarget: parsed.data.botDeliveryTarget,
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
                recurring: parsed.data.recurring ?? true,
                maxRuns: parsed.data.maxRuns,
              });
              if (automation.targetTaskId) {
                const taskMeta = await automationTaskIndexRepo
                  .getTaskMeta({
                    workspacePath: automation.workspacePath,
                    workspaceIdentity: automation.workspaceIdentity,
                    taskId: automation.targetTaskId,
                  })
                  .catch(() => null);
                if (taskMeta) {
                  await automationTaskIndexRepo.syncTaskMeta({
                    meta: {
                      ...taskMeta,
                      // An automation created within a session reuses the current session; explicitly add the marker for display in the V4 sidebar.
                      cronAutomationId: automation.automationId,
                    },
                  });
                }
              }
              await client.respond(request.id, {
                automation: toProtocolAutomation(automation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.offPeakCreate) {
          const parsed = zcodeOffPeakCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const offPeakTaskService = options?.resolveOffPeakTaskService?.();
              if (!offPeakTaskService) {
                await client.respondError(request.id, {
                  code: -32601,
                  message: "Off-peak task service is unavailable on this host",
                });
                return;
              }
              const grayConfig = await options
                ?.resolveOffPeakClientConfig?.()
                .catch(() => undefined);
              // If rollout is disabled or config parsing fails after tool registration, do not continue with the "empty allowlist" inference
              // (an explicit model would incorrectly report model_not_allowed, while an omitted model would be persisted empty); return a stable category directly.
              // The model view can contain both domains; confirm ownership with the existing support snapshot rather than guessing from the first Provider.
              const support =
                resolveOffPeakAllowedModels(grayConfig).length > 0
                  ? await offPeakTaskService.getCodingPlanSupport()
                  : undefined;
              const providerId = support?.supported
                ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
                : undefined;
              const allowedModels = providerId
                ? resolveOffPeakAllowedModels(grayConfig, providerId)
                : [];
              if (allowedModels.length === 0) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "offpeak_disabled",
                });
                return;
              }
              // Prevalidate the model allowlist: if an explicit input is not in the allowlist, return a stable category.
              // Reuse the client_validation category with a dedicated errorCode; do not expand the category enum.
              // Match using the same semantics as thoughtLevel/UI (trim + case-insensitive) and restore the allowlist's original spelling on a match.
              const model = resolveOffPeakCreateModel(allowedModels, parsed.data.model);
              if (model === null) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "model_not_allowed",
                });
                return;
              }
              const modelSelection =
                grayConfig && providerId
                  ? resolveOffPeakToolSelection(
                      grayConfig.modelSelectionView,
                      providerId,
                      model,
                      parsed.data.thoughtLevel,
                    )
                  : undefined;
              if (!modelSelection) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "model_not_allowed",
                });
                return;
              }
              const result = await offPeakTaskService.createTask({
                title: parsed.data.title,
                prompt: parsed.data.prompt,
                permissionMode: parsed.data.permissionMode ?? "yolo",
                modelSelection,
                // Creation within a session binds to the current session; dispatch resumes that session for execution.
                ...(parsed.data.boundSessionId
                  ? { boundSessionId: parsed.data.boundSessionId }
                  : {}),
                // The host injects workspace from the current session (matching automation/create); it is not part of protocol params.
                workspacePath: workspace.workspacePath,
                ...(workspace.workspaceIdentity
                  ? { workspaceIdentity: workspace.workspaceIdentity }
                  : {}),
              });
              if (!result.ok) {
                // Pass failure categories through the protocol unchanged (do not use respondError) so the CLI handler can map them to stable errors.
                await client.respond(request.id, {
                  ok: false,
                  failureStage: result.failureStage,
                  errorCategory: result.errorCategory,
                  errorCode: result.errorCode,
                });
                return;
              }
              await client.respond(request.id, {
                ok: true,
                task: toProtocolOffPeakTaskSnapshot(result.task),
              });
            } catch (error) {
              await respondOffPeakInternalError(client, request, workspace, error);
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.offPeakList) {
          const parsed = zcodeOffPeakListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const offPeakTaskService = options?.resolveOffPeakTaskService?.();
              if (!offPeakTaskService) {
                await client.respondError(request.id, {
                  code: -32601,
                  message: "Off-peak task service is unavailable on this host",
                });
                return;
              }
              const workspaceKey = resolveWorkspaceKey(workspace);
              const tasks = (await offPeakTaskService.list())
                .filter((task) => task.workspaceKey === workspaceKey)
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 20);
              await client.respond(request.id, {
                tasks: tasks.map(toProtocolOffPeakTaskSnapshot),
              });
            } catch (error) {
              await respondOffPeakInternalError(client, request, workspace, error);
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationList) {
          const parsed = zcodeAutomationListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const automations = await automationService.list(workspace);
              await client.respond(request.id, {
                automations: automations.map(toProtocolAutomation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationCheckTaskBinding) {
          const parsed = zcodeAutomationCheckTaskBindingParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation task binding params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const bound = await automationService.hasTaskBinding({
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
                targetTaskId: parsed.data.targetTaskId,
              });
              await client.respond(request.id, { bound });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationUpdate) {
          const parsed = zcodeAutomationUpdateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation update params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const automation = await automationService.update(
                parsed.data.automationId,
                {
                  title: parsed.data.title,
                  cronExpr: parsed.data.cronExpr,
                  prompt: parsed.data.prompt,
                  recurring: parsed.data.recurring,
                  maxRuns: parsed.data.maxRuns,
                  // Pass the session-side long-interval carrier (intervalUnit+interval) to the service to normalize into the authoritative scheduleRule.
                  intervalUnit: parsed.data.intervalUnit,
                  interval: parsed.data.interval,
                },
                workspace,
              );
              if (!automation) {
                throw new Error("Scheduled task not found in the current workspace.");
              }
              await client.respond(request.id, {
                automation: toProtocolAutomation(automation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        if (request.method === zcodeProtocolMethods.automationDelete) {
          const parsed = zcodeAutomationDeleteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation delete params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              const deleted = await automationService.delete(parsed.data.automationId, workspace);
              await client.respond(request.id, { deleted });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        void client.respondError(request.id, {
          code: -32601,
          message: `Unsupported ZCode Protocol request: ${request.method}`,
        });
      }),
      client.onClose(() => {
        invalidateWorkspaceClient(resolveWorkspaceKey(workspace), client);
      }),
    ];
    clientDisposables.set(client, disposables);
  }

  function rememberSessionTrace(
    target: ZCodeAgentSessionTarget,
    snapshot: ZCodeSessionStateSnapshot,
  ): TraceId | undefined {
    const traceId = snapshot.session.traceId as TraceId | undefined;
    if (traceId) {
      sessionTraceIdBySessionKey.set(sessionEventKey(target), traceId);
    }
    return traceId;
  }

  function getSessionTraceId(target: ZCodeAgentSessionTarget): TraceId | undefined {
    return sessionTraceIdBySessionKey.get(sessionEventKey(target));
  }

  function createProviderNotReadyError(params: {
    snapshot?: ZCodeAgentProviderReadinessSnapshot;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Error & {
    code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    data: {
      providerCount: number;
      reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
      revision: string | null;
      workspaceKey: string;
      workspacePath: string;
    };
  } {
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const error = new Error("当前没有可用的模型供应商和模型，请先登录或配置 API Key。") as Error & {
      code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
      data: {
        providerCount: number;
        reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
        revision: string | null;
        workspaceKey: string;
        workspacePath: string;
      };
    };
    error.code = ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    error.data = {
      providerCount: params.snapshot?.providerCount ?? 0,
      reason: ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
      revision: params.snapshot?.revision ?? null,
      workspaceKey,
      workspacePath: params.workspace.workspacePath,
    };
    return error;
  }

  function isProviderNotReadyError(
    error: unknown,
  ): error is Error & { code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE } {
    return (
      error instanceof Error &&
      (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE
    );
  }

  async function resolveStartupReadiness(): Promise<
    ZCodeAgentProviderReadinessSnapshot | undefined
  > {
    if (modelSelectionReadinessSource) {
      return createProviderReadinessSnapshotFromSelectionView(
        await modelSelectionReadinessSource.getView(),
      );
    }
    return undefined;
  }

  /**
   * A stop/cancel RPC timeout or watchdog may dispose the client/process while the process exits asynchronously,
   * leaving activeClientsByWorkspaceKey pointing to the disposed client before client.onClose fires.
   * Every path that reuses an active entry must run this check first; when disposed, clear the stale entry and return false,
   * so the caller can restart the process (start-if-needed) or handle it as "no runtime" (existing-only).
   */
  function isReusableActiveClientEntry(
    params: ZCodeAgentWorkspaceTarget,
    active: ActiveWorkspaceClient | undefined,
  ): boolean {
    if (!active) {
      return false;
    }
    if (!active.client.isDisposed) {
      return true;
    }
    const workspaceKey = resolveWorkspaceKey(params);
    activeClientsByWorkspaceKey.delete(workspaceKey);
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
    logger.warn(undefined, "复用的 ZCode Protocol client 已 disposed，清理 stale entry", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return false;
  }

  async function getOrStartReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ActiveWorkspaceClient> {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      await active.interactionPreferencesReady;
      return active;
    }

    const client = await processManager.getClient(params);
    wireClient(client, params, "chat");

    // processManager makes concurrent startup single-flight by workspaceKey. If another
    // read/write path registers the same client while awaiting, reuse the existing entry; do not reset elevated write capability to false.
    const concurrent = activeClientsByWorkspaceKey.get(workspaceKey);
    if (concurrent && isReusableActiveClientEntry(params, concurrent)) {
      concurrent.workspace = params;
      await concurrent.interactionPreferencesReady;
      return concurrent;
    }

    const entry: ActiveWorkspaceClient = {
      client,
      modelExecutionEnabled: false,
      workspace: params,
      dynamicWorkflowPolicyMode: "disabled",
    };
    activeClientsByWorkspaceKey.set(workspaceKey, entry);
    const interactionPreferencesReady = (async () => {
      let appliedSnapshot: ZCodeAgentAppRuntimePreferences | undefined;
      while (latestAppRuntimePreferences && latestAppRuntimePreferences !== appliedSnapshot) {
        const snapshot = latestAppRuntimePreferences;
        await enqueueInteractionPreferenceSync({
          client,
          preferences: { ...snapshot },
          workspace: params,
        });
        appliedSnapshot = snapshot;
      }
    })();
    // Off-Peak local support is a workspace-level fact; synchronize it to the CLI before any session work is allowed,
    // so v4 cold recovery (which has no per-request flag channel) also gets the tool surface. Ignore method-not-found from older CLIs.
    // The CLI defaults to false and each agent process serves only one workspace, so send no request while the gate is closed (no impact
    // on older CLIs or test doubles that do not implement the method).
    const offPeakToolPolicyReady = (async () => {
      if (!isOffPeakToolSupported(params)) return;
      try {
        await client.request(
          zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy,
          { workspace: buildWorkspaceRef(params), enabled: true },
          zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
        );
      } catch (error) {
        // Policy sync is best-effort capability distribution and fails closed (the CLI default is not to register the tools).
        // Timeouts/transient IPC errors must not block client readiness; -32601 is the expected fallback for older CLIs.
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "Off-Peak 工具策略同步失败，CLI 维持缺省关闭", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    // Dynamic-workflow gray-release gate: like Off-Peak, this is a
    // workspace-level fact synced to the CLI before any session work is allowed, so V4 cold recovery can also access the tool surface.
    // Send no request when the effective mode is disabled (the CLI defaults to disabled, so older CLIs and test fakes are unaffected); when the user later changes the choice,
    // resend through the same per-workspace serial chain (launch.md “The user’s choice”).
    const dynamicWorkflowPolicyReady = enqueueDynamicWorkflowPolicySync(entry);
    entry.interactionPreferencesReady = Promise.all([
      interactionPreferencesReady,
      offPeakToolPolicyReady,
      dynamicWorkflowPolicyReady,
    ]).then(() => undefined);
    try {
      // Bring a new or restarted runtime up to date with the cache before allowing session work; new toggles during synchronization
      // see the registered entry and enter the same workspace serial queue, preserving submission order.
      await entry.interactionPreferencesReady;
    } catch (error) {
      if (activeClientsByWorkspaceKey.get(workspaceKey) === entry) {
        activeClientsByWorkspaceKey.delete(workspaceKey);
      }
      throw error;
    } finally {
      delete entry.interactionPreferencesReady;
    }
    logger.info(undefined, "为只读会话控制面启动 ZCode agent", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry;
  }

  async function getClient(params: ZCodeAgentWorkspaceTarget) {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.modelExecutionEnabled && isReusableActiveClientEntry(params, active)) {
      active.workspace = params;
      return active.client;
    }

    const waiting: WaitingWorkspaceStartup = waitingWorkspaceStartups.get(workspaceKey) ?? {
      cancelled: false,
      workspace: params,
    };
    waiting.workspace = params;
    waitingWorkspaceStartups.set(workspaceKey, waiting);

    // Bug cause: concurrent calls each await readiness; the first successful one removes the waiting record, so a late call
    // mistakes success for a released workspace. Share the entire startup Promise; cancellation remains controlled by the waiting identity.
    const starting = (waiting.starting ??= startModelExecutionClient(params, waiting));
    try {
      return await starting;
    } finally {
      if (waiting.starting === starting) delete waiting.starting;
    }
  }

  async function startModelExecutionClient(
    params: ZCodeAgentWorkspaceTarget,
    waiting: WaitingWorkspaceStartup,
  ): Promise<ZCodeProtocolClient> {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);

    const readinessSnapshot = await resolveStartupReadiness();
    // Readiness reads may interleave with workspace release; after release removes the waiting identity,
    // an old continuation must not create a new process. Reopening the same path later gets a new identity and is unaffected.
    if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
      throw createRuntimeUnavailableError(params);
    }
    const readiness = readinessSnapshot?.readiness;
    if (!readinessSnapshot || !readiness?.ready) {
      const revision = readinessSnapshot?.revision ?? "missing";
      if (waiting.lastLoggedRevision !== revision) {
        waiting.lastLoggedRevision = revision;
        logger.info(
          undefined,
          active
            ? "provider/model 尚未就绪，ZCode agent 保持只读"
            : "provider/model 尚未就绪，ZCode agent 保持未启动",
          {
            providerCount: readinessSnapshot?.providerCount ?? 0,
            revision: readinessSnapshot?.revision ?? null,
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
      }
      throw createProviderNotReadyError({ snapshot: readinessSnapshot, workspace: params });
    }

    const entry = await getOrStartReadOnlyClient(params);
    if (waiting.cancelled) {
      throw createRuntimeUnavailableError(params);
    }
    entry.modelExecutionEnabled = true;
    processManager.markReady(params, entry.client);
    entry.workspace = params;
    waitingWorkspaceStartups.delete(workspaceKey);
    logger.info(undefined, "provider/model 就绪，允许 ZCode agent 模型执行", {
      modelId: readiness.modelId,
      providerId: readiness.providerId,
      revision: readinessSnapshot.revision,
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry.client;
  }

  async function getReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
    runtimePolicy: "start-if-needed" | "existing-only" = "start-if-needed",
  ) {
    if (runtimePolicy === "existing-only") {
      const workspaceKey = resolveWorkspaceKey(params);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      // Observer paths must also reject disposed stale entries; after cleanup, handle as "no runtime",
      // and never start a process for an observer (preserving existing-only semantics).
      if (active && isReusableActiveClientEntry(params, active)) {
        active.workspace = params;
        return active.client;
      }
      // runtime available may arrive before the original startup call's await continuation. Allow the
      // process manager's registered client to become the service's active entry here, but never create a new process.
      const existingClient = processManager.getExistingClient(params);
      if (!existingClient) {
        throw createRuntimeUnavailableError(params);
      }
      wireClient(existingClient, params, "chat");
      activeClientsByWorkspaceKey.set(workspaceKey, {
        client: existingClient,
        modelExecutionEnabled: false,
        workspace: params,
        // Only promote the existing client; do not replay policy sync from the readiness phase. Treat the CLI default as disabled and send an update when the user changes the choice.
        dynamicWorkflowPolicyMode: "disabled",
      });
      return existingClient;
    }
    return (await getOrStartReadOnlyClient(params)).client;
  }

  async function getPluginManagementClient(): Promise<ZCodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await pluginProcessManager.getClient(workspace);
    wireClient(client, workspace, "plugin");
    return client;
  }

  // Choose a carrier runtime for global workflows:
  // When the caller provides only `{ scope: "global" }` without a workspace, first reuse any active **local** runtime
  // (existing-only semantics: inspect activeClientsByWorkspaceKey and never start a process for this purpose); otherwise fall back to
  // the management workspace, following getPluginManagementClient by starting a control-plane runtime through the dedicated pluginProcessManager.
  // This is preferable to getOrStartReadOnlyClient because workflows/* are workspace-level methods without a session or provider/model
  // readiness requirement. The management process is intended for control-plane capabilities that do not belong to a real project and is not
  // reclaimed by the watchdog when a real workspace closes; getOrStartReadOnlyClient would add the synthetic workspace to activeClientsByWorkspaceKey
  // and synchronize interaction preferences, polluting the session client map. Both paths run locally,
  // so homedir() is the user's home and the global root `~/.zcode/workflows/` resolves to the actual directory.
  // A remote runtime (SSH/WSL identity or one with remoteSessionId) has a non-local home and must never be selected as the carrier.
  function isLocalActiveWorkspaceClient(workspace: ZCodeAgentWorkspaceTarget): boolean {
    return (
      !workspace.remoteSessionId &&
      !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
    );
  }

  async function resolveGlobalSavedWorkflowCarrier(): Promise<{
    client: ZCodeProtocolClient;
    workspace: ZCodeWorkspaceRef;
  }> {
    for (const active of activeClientsByWorkspaceKey.values()) {
      if (!isLocalActiveWorkspaceClient(active.workspace)) {
        continue;
      }
      // Cleanup for disposed/stale entries matches getReadOnlyClient(existing-only):
      // isReusableActiveClientEntry clears reclaimed entries, then we continue searching.
      if (!isReusableActiveClientEntry(active.workspace, active)) {
        continue;
      }
      return { client: active.client, workspace: buildWorkspaceRef(active.workspace) };
    }
    const managementWorkspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await getPluginManagementClient();
    return { client, workspace: buildWorkspaceRef(managementWorkspace) };
  }

  // Carrier for the five workflows/* methods: pass through when a workspace is supplied (project profile or GUI project-group action with an explicit scope);
  // when only `scope:"global"` is provided, let services choose a local carrier.
  async function resolveSavedWorkflowCarrier(
    params: ZCodeAgentSavedWorkflowTarget,
  ): Promise<{ client: ZCodeProtocolClient; workspace: ZCodeWorkspaceRef }> {
    if (savedWorkflowTargetHasWorkspace(params)) {
      return { client: await getReadOnlyClient(params), workspace: buildWorkspaceRef(params) };
    }
    return resolveGlobalSavedWorkflowCarrier();
  }

  // Dedicated to mcp/list: isolate it from plugin-management commands; see the mcpStatusProcessManager comment.
  async function getMcpStatusClient(): Promise<ZCodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await mcpStatusProcessManager.getClient(workspace);
    wireClient(client, workspace, "mcp-status");
    return client;
  }

  function disposeLocalState(): void {
    accountProviderConfigUnsubscribe?.();
    accountProviderConfigUnsubscribe = undefined;
    modelSelectionSubscription?.dispose();
    modelSelectionSubscription = undefined;
    memoryDiagnostics.dispose();
    for (const emitter of sessionEmitters.values()) {
      emitter.dispose();
    }
    sessionEmitters.clear();
    for (const emitter of providerRuntimeHeadersWorkspaceEmitters.values()) {
      emitter.dispose();
    }
    providerRuntimeHeadersWorkspaceEmitters.clear();
    for (const emitter of providerRuntimeHeadersCancelledEmitters.values()) emitter.dispose();
    providerRuntimeHeadersCancelledEmitters.clear();
    sessionRuntimePreferencesRequestEmitter.dispose();
    processResourceSampleEmitter.dispose();
    mcpTelemetryEmitter.dispose();
    toolExecResourceEmitter.dispose();
    mcpResourceSamplesEmitter.dispose();
    for (const emitter of pluginOperationProgressEmitters.values()) {
      emitter.dispose();
    }
    pluginOperationProgressEmitters.clear();
    for (const emitter of conversationFrameEmitters.values()) {
      emitter.dispose();
    }
    conversationFrameEmitters.clear();
    for (const emitter of conversationTelemetryFactEmitters.values()) {
      emitter.dispose();
    }
    conversationTelemetryFactEmitters.clear();
    for (const emitter of offPeakLifecycleEmitters.values()) emitter.dispose();
    offPeakLifecycleEmitters.clear();
    localTtftFactsEmitter.dispose();
    cuaPermissionObservationEmitter.dispose();
    pluginUiToolResultEmitter.dispose();
    for (const emitter of workspaceConfigFrameEmitters.values()) {
      emitter.dispose();
    }
    workspaceConfigFrameEmitters.clear();
    for (const emitter of sessionsIndexFrameEmitters.values()) {
      emitter.dispose();
    }
    sessionsIndexFrameEmitters.clear();
    sessionEventSequenceStates.clear();
    pendingPermissions.clear();
    pendingUserInputs.clear();
    pendingProviderRuntimeHeaders.clear();
    for (const pending of pendingSessionRuntimePreferences.values()) {
      clearTimeout(pending.timeout);
    }
    pendingSessionRuntimePreferences.clear();
    activeClientsByWorkspaceKey.clear();
    cancelAllWaitingWorkspaceStartups();
    interactionPreferenceSyncByWorkspaceKey.clear();
    cuaOperationTurnTracker?.clearAll();
    clearV4SubscriptionRoutes();
    v4RouteRuntimeRestartDisposable.dispose();
    runtimeLifecycleDisposable.dispose();
  }

  // 3.12.2: remote rollout reads must not run during client readiness or create commands; serial retries on failure would block ordinary chat.
  // Registration checks only local support; rollout, plan, and model eligibility are still checked by the offPeak/create handler before allocating a task ID.
  function isOffPeakToolSupported(params: {
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): boolean {
    if (!options?.resolveOffPeakClientConfig || !options.resolveOffPeakTaskService) return false;
    if (params.remoteSessionId) return false;
    return !params.workspaceIdentity || !isRemoteWorkspaceIdentity(params.workspaceIdentity);
  }

  /**
   * Server-provided value (docs/dynamic-workflow/launch.md “Gray release”): the Host reads it once and keeps it fixed within this process.
   * Three reasons:
   *   1. 1. The decision is made on the client readiness path, so session creation cannot wait on the remote service each time—this caused a regression in 3.12.2;
   *   2. 2. A read failure fails closed and is not retried, avoiding a request timeout on every create while offline;
   *   3. 3. Server-side gray-release changes take effect in the next Host process by design (the provider also has a 1-hour snapshot and forceRefresh).
   * Unlike Off-Peak, this also works for remote workspaces, so it does not inspect workspaceIdentity / remoteSessionId.
   */
  function resolveDynamicWorkflowOffer(): Promise<DynamicWorkflowClientConfig | undefined> {
    const resolve = options?.resolveDynamicWorkflowClientConfig;
    if (!resolve) return Promise.resolve(undefined);
    dynamicWorkflowOffer ??= (async () => {
      try {
        return await resolve();
      } catch (error) {
        logger.warn(undefined, "动态工作流灰度读取失败，按关闭处理", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })();
    return dynamicWorkflowOffer;
  }

  /** User choice (launch.md “The user’s choice”): reread local settings each time when they are authoritative; otherwise use the value pushed by Desktop. */
  async function resolveDynamicWorkflowUserMode(): Promise<DynamicWorkflowMode | undefined> {
    const read = options?.resolveDynamicWorkflowUserMode;
    if (!read) return pushedDynamicWorkflowUserMode;
    try {
      return normalizeDynamicWorkflowMode(await read());
    } catch (error) {
      // A settings read failure must not disable the feature or block session creation; treat it as “follow the server.”
      logger.warn(undefined, "动态工作流用户选择读取失败，按跟随服务端处理", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Effective mode = the latched server-provided offer + the user's current choice. Policy sync and all three creation paths share this source, so policy and
   * create cannot disagree. The choice is not latched; a settings change applies to the next session creation.
   * `onDemand` is passed to the CLI unchanged: it decides whether the ten tools register on the first request or wait for the first `/workflow`.
   *
   * An unreadable offer (failed remote read or no value) falls back to the default `disabled`; the user's choice then has no effect, because a choice
   * cannot enable a feature the offer disables (see applyDynamicWorkflowUserMode). A Host without a wired resolver does not take part in the feature.
   */
  async function resolveDynamicWorkflowGate(): Promise<DynamicWorkflowMode> {
    if (!options?.resolveDynamicWorkflowClientConfig) return "disabled";
    const offer =
      (await resolveDynamicWorkflowOffer()) ??
      createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
    return applyDynamicWorkflowUserMode(offer, await resolveDynamicWorkflowUserMode()).mode;
  }

  /**
   * Sync the effective mode to a workspace’s CLI (launch.md “The user’s choice”). Operations for the same workspace are serialized:
   * each step reads the effective mode only when it runs, so a later queued step sees the updated choice and a slow request cannot apply after a newer decision.
   * Do not send when the CLI already holds the same policy; when disabled, send enabled:false so the online CLI removes workflow from its slash-command directory.
   */
  function enqueueDynamicWorkflowPolicySync(entry: ActiveWorkspaceClient): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(entry.workspace);
    const previous = dynamicWorkflowPolicySyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    const current = previous.then(async () => {
      const mode = await resolveDynamicWorkflowGate();
      if (mode === entry.dynamicWorkflowPolicyMode) return;
      const enabled = isDynamicWorkflowModeEnabled(mode);
      try {
        await entry.client.request(
          zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy,
          // Send mode alongside the boolean (launch.md “On demand: activation”); older CLIs that recognize only the boolean have a strict
          // schema that rejects mode. The warning branch below preserves the disabled default, treating it like other non- -32601 errors.
          { workspace: buildWorkspaceRef(entry.workspace), enabled, ...(enabled ? { mode } : {}) },
          zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
        );
        entry.dynamicWorkflowPolicyMode = mode;
      } catch (error) {
        // Same rule as Off-Peak: -32601 is the normal fallback for older CLIs (their z.object also strips the session flag,
        // so the feature remains disabled); warn on other errors without blocking client readiness.
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "动态工作流策略同步失败，CLI 维持原策略", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    dynamicWorkflowPolicySyncByWorkspaceKey.set(workspaceKey, current);
    return current;
  }

  /** Shared by all three creation paths: send the boolean and mode as a pair (omit both when disabled). */
  async function resolveDynamicWorkflowSessionFlags(): Promise<{
    dynamicWorkflowEnabled: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  }> {
    const mode = await resolveDynamicWorkflowGate();
    return isDynamicWorkflowModeEnabled(mode)
      ? { dynamicWorkflowEnabled: true, dynamicWorkflowMode: mode }
      : { dynamicWorkflowEnabled: false };
  }

  /**
   * Abandoned create/prewarm reservations are cleared here, the same place that reserved them. A deleteSession ACK accepted or noop
   * means the CLI no longer holds the session; a deleteSession rejected with proto.sessionNotFound means the CLI never initialized it
   * (an abandoned draft). A plain create ACK rejected means the CLI refused it before creating anything. Unknown outcomes (a thrown
   * request, duplicate or stale ACKs) keep the reservation, because the CLI may have created the session. Discarding on
   * proto.sessionNotFound is safe: a concurrent create that lands later re-creates a missing row when its CLI facts apply.
   */
  async function discardAbandonedSessionReservation(
    params: ZCodeAgentConversationCommandParams,
    ack: CommandAck,
    createReservationSessionId: string | undefined,
  ): Promise<void> {
    if (!options?.discardSessionReservation) return;
    let sessionId: string | undefined;
    if (params.envelope.type === "deleteSession") {
      if (
        ack.status === "accepted" ||
        ack.status === "noop" ||
        (ack.status === "rejected" && ack.reasonCode === "proto.sessionNotFound")
      )
        sessionId = params.envelope.sessionId ?? undefined;
    } else if (createReservationSessionId !== undefined && ack.status === "rejected") {
      sessionId = createReservationSessionId;
    }
    if (sessionId === undefined) return;
    try {
      await options.discardSessionReservation({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        sessionId,
      });
    } catch (error) {
      logger.warn(undefined, "放弃的会话预留清理失败", {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * A fork child is created by the CLI, so the Host never reserves it on the create path. The accepted forkAssistant ACK names the
   * child, and this is the only point where the Host knows its parent; the child claims the parent's project and directories here.
   */
  async function claimForkedSessionOwnership(
    params: ZCodeAgentConversationCommandParams,
    envelope: CommandEnvelope,
    ack: CommandAck,
  ): Promise<void> {
    if (!options?.prepareForkedSession) return;
    if (envelope.type !== "forkAssistant" || !envelope.sessionId) return;
    if (ack.result?.type !== "forkAssistant") return;
    const claim = await options.prepareForkedSession({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      parentSessionId: envelope.sessionId,
      sessionId: ack.result.sessionId,
    });
    // The CLI has already forked, so an unowned parent must not fail the command. admitForkSummary claims the child later.
    if (claim === null) {
      logger.warn(undefined, "fork child left unclaimed: parent has no owner yet", {
        parentSessionId: envelope.sessionId,
        sessionId: ack.result.sessionId,
      });
    }
  }

  async function buildConversationCommandEnvelope(
    params: ZCodeAgentConversationCommandParams,
  ): Promise<CommandEnvelope> {
    const envelope = params.envelope;
    if (envelope.type === "createSession") {
      // V4 createSession bypasses legacy session/create param construction, so inject the tool-surface flag from the same source
      // at the envelope; omit the field when the gate is false (the default is fail-closed, matching legacy behavior).
      const { dynamicWorkflowEnabled, dynamicWorkflowMode } =
        await resolveDynamicWorkflowSessionFlags();
      const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
      const sessionId =
        payload.preparedSessionId ??
        (payload.submissionPreparation ? payload.sessionId : undefined) ??
        (params.projectId !== undefined || options?.prepareSessionCreation
          ? `session_${createHash("sha256")
              .update(
                JSON.stringify([
                  resolveWorkspaceKey(params),
                  envelope.clientId,
                  envelope.commandId,
                ]),
              )
              .digest("hex")
              .slice(0, 32)}`
          : payload.sessionId);
      const additionalDirectories =
        params.projectId !== undefined || options?.prepareSessionCreation
          ? await options?.prepareSessionCreation?.({
              ...params,
              sessionId: sessionId!,
              projectId: params.projectId ?? null,
              additionalDirectories: payload.additionalDirectories,
            })
          : payload.additionalDirectories;
      if (params.projectId !== undefined && !options?.prepareSessionCreation)
        throw new Error("project.creation-unavailable");
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      return {
        ...envelope,
        payload: {
          ...payload,
          ...(dynamicWorkflowEnabled ? { dynamicWorkflowEnabled: true, dynamicWorkflowMode } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(offPeakToolEnabled ? { offPeakToolEnabled: true } : {}),
          // Dynamic-workflow rollout: V4 createSession is the actual desktop new-session path; without forwarding this, the nine tools are never registered.
          ...(dynamicWorkflowEnabled ? { dynamicWorkflowEnabled: true } : {}),
          ...(dynamicWorkflowEnabled && dynamicWorkflowMode !== undefined
            ? { dynamicWorkflowMode }
            : {}),
        },
      };
    }
    if (envelope.type !== "sendText") return envelope;

    const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
    // After reading the persisted cronAutomationId, do not treat the entire bound session as an automation
    // execution context forever; otherwise later user input would also lose CronUpdate/CronDelete. Use only this turn's payload here;
    // the CLI's resolveTurnAutomationId handles compatibility when an automation runId is missing from the payload.
    if (payload.automationId) {
      // Automation dispatch in desktop-continuous does not always go through the task adapter; merge this turn's
      // denylist at the protocol envelope without overriding the caller's existing policy.
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeAutomationMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    if (payload.offPeakTaskId) {
      // Apply the same defense in depth to off-peak dispatch turns: deny only OffPeakCreate (keep OffPeakList read-only and available).
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeOffPeakMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    return envelope;
  }

  return {
    async prepareStorage(params) {
      const client = await processManager.getClient(params);
      wireClient(client, params, "chat");
      await client.storageStartup.wait();
    },
    async getStorageStartupState(params) {
      return processManager.getStorageStartupState(params);
    },
    onDynamicStorageStartupState(params) {
      const workspaceKey = resolveWorkspaceKey(params);
      return (listener) =>
        processManager.onStorageStartupChanged((event) => {
          if (event.workspaceKey === workspaceKey) listener(event.snapshot);
        });
    },
    hasActiveCuaOperationTurn(): boolean {
      return cuaOperationTurnTracker?.hasActiveTurn() ?? false;
    },
    async initialize(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAgentInitializeResult> {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "开始初始化 ZCode agent", {
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        const client = await getClient(params);
        logger.info(undefined, "ZCode agent 初始化完成", {
          durationMs: Date.now() - startedAt,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return {
          available: true,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
        };
      } catch (error) {
        const providerNotReady = isProviderNotReadyError(error);
        logger[providerNotReady ? "info" : "warn"](
          undefined,
          providerNotReady ? "ZCode agent 等待 provider/model 就绪" : "ZCode agent 初始化失败",
          {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
        // initialize now warms up the host at startup, but the first screen must not crash because the agent is missing.
        // Preserve the available=false result so the UI/caller can use the existing recoverable error path.
        return {
          available: false,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          reason: error instanceof Error ? error.message : String(error),
          ...(providerNotReady ? { reasonCode: ZCODE_AGENT_PROVIDER_NOT_READY_REASON } : {}),
        };
      }
    },

    async syncDynamicWorkflowUserMode(params: { mode?: DynamicWorkflowMode }): Promise<void> {
      // launch.md “The user’s choice”: when local settings are authoritative, the incoming value is only a change signal; use the settings file as the source of truth.
      // A desktop-attached remote Host has no local settings, so the pushed value is the choice.
      pushedDynamicWorkflowUserMode = normalizeDynamicWorkflowMode(params.mode);
      options?.forwardDynamicWorkflowUserMode?.(await resolveDynamicWorkflowUserMode());
      await Promise.all(
        [...activeClientsByWorkspaceKey.values()].map((entry) =>
          enqueueDynamicWorkflowPolicySync(entry),
        ),
      );
    },

    async syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void> {
      const normalizedPreferences: ZCodeAgentAppRuntimePreferences = {
        ...preferences,
        modelIoFullRetentionEnabled: preferences.modelIoFullRetentionEnabled === true,
      };
      latestAppRuntimePreferences = normalizedPreferences;
      const activeClients = [...activeClientsByWorkspaceKey.values()];
      await Promise.all(
        activeClients.map((entry) =>
          enqueueInteractionPreferenceSync({
            client: entry.client,
            preferences: { ...normalizedPreferences },
            workspace: entry.workspace,
          }),
        ),
      );
    },

    async getWorkspaceRuntimeIdentity(params: ZCodeAgentWorkspaceTarget) {
      // Querying runtime identity may observe only an existing process; do not turn a dormant workspace into an active process.
      await getReadOnlyClient(params, "existing-only");
      return await processManager.getRuntimeIdentity(params);
    },

    async createSession(params: ZCodeAgentCreateSessionParams) {
      if (options?.prepareSessionCreation) {
        const sessionId = params.sessionId ?? `session_${randomUUID()}`;
        const directories = await options.prepareSessionCreation({
          ...params,
          sessionId,
          projectId: params.projectId ?? null,
        });
        params = {
          ...params,
          sessionId,
          additionalDirectories: params.additionalDirectories ?? directories,
        };
      } else if (params.projectId !== undefined) {
        throw new Error("project.creation-unavailable");
      }
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_create",
        workspace: params,
      });
      const sessionTraceId = params.sessionTraceId;
      logger.info(sessionTraceId, "开始请求 ZCode Protocol session/create", {
        hasInitialModel: params.model !== undefined,
        hasInitialThoughtLevel: params.thoughtLevel !== undefined,
        initialModel: formatModelSelectionForLog(params.model),
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        persistence: params.persistence,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // The rollout was evaluated when the client became ready; this awaits the already-resolved in-process promise (no remote request).
      const dynamicWorkflowFlags = await resolveDynamicWorkflowSessionFlags();
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          buildSessionCreateParams({ ...params, offPeakToolEnabled, ...dynamicWorkflowFlags }),
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        logger.info(sessionTraceId, "ZCode Protocol session/create 完成", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          persistence: params.persistence,
          sessionId: snapshot.session.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        const compatFields = getSessionCreateCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(sessionTraceId, "ZCode Protocol session/create 失败", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            persistence: params.persistence,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(sessionTraceId, "ZCode Protocol session/create 命中新旧协议兼容重试", {
          compatFields,
          durationMs: Date.now() - startedAt,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        // The host/UI may send newer optional session/create fields while a local package,
        // remote deployment, or still-running older app-server uses the old strict schema. Retry without only known
        // optional fields so thoughtLevel/persistence version mismatches do not block first-time creation.
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          buildSessionCreateParams(
            { ...params, offPeakToolEnabled, ...dynamicWorkflowFlags },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        if (!compatFields.includes("thoughtLevel") || !params.thoughtLevel) {
          logger.info(sessionTraceId, "ZCode Protocol session/create 兼容重试完成", {
            durationMs: Date.now() - startedAt,
            sessionId: snapshot.session.sessionId,
            snapshotTraceId: snapshot.session.traceId ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return snapshot;
        }
        // If the old create schema does not recognize thoughtLevel, use the existing
        // session/setThoughtLevel protocol after creation so the first prompt still uses the reasoning level selected in the toolbar.
        const snapshotWithThoughtLevel = await client.request(
          zcodeProtocolMethods.sessionSetThoughtLevel,
          {
            sessionId: snapshot.session.sessionId,
            thoughtLevel: params.thoughtLevel,
            persistAsWorkspaceLastUsed: true,
          },
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace(
          { ...params, sessionId: snapshotWithThoughtLevel.session.sessionId },
          snapshotWithThoughtLevel,
        );
        logger.info(
          sessionTraceId,
          "ZCode Protocol session/create 兼容重试后设置 thoughtLevel 完成",
          {
            durationMs: Date.now() - startedAt,
            sessionId: snapshot.session.sessionId,
            snapshotTraceId: snapshotWithThoughtLevel.session.traceId ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          },
        );
        return snapshotWithThoughtLevel;
      }
    },

    async resumeSession(params: ZCodeAgentResumeSessionParams) {
      params = {
        ...params,
        additionalDirectories:
          params.additionalDirectories ?? (await options?.resolveSessionDirectories?.(params)),
      };
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_resume",
        workspace: params,
      });
      const cachedTraceId = getSessionTraceId(params);
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // Cold recovery must also use the Host's rollout decision, or the restored session loses the workflow tool group.
      const dynamicWorkflowFlags = await resolveDynamicWorkflowSessionFlags();
      logger.info(cachedTraceId, "开始请求 ZCode Protocol session/resume", {
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        modelHint: params.model ?? null,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams({ ...params, offPeakToolEnabled, ...dynamicWorkflowFlags }),
          zcodeSessionStateSnapshotSchema,
        );
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ZCode Protocol session/resume 完成", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        const compatFields = getSessionResumeCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(cachedTraceId, "ZCode Protocol session/resume 失败", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(cachedTraceId, "ZCode Protocol session/resume 命中新旧协议兼容重试", {
          compatFields,
          durationMs: Date.now() - startedAt,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams(
            { ...params, offPeakToolEnabled, ...dynamicWorkflowFlags },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
        );
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ZCode Protocol session/resume 兼容重试完成", {
          durationMs: Date.now() - startedAt,
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      }
    },

    async listSessions(params: ZCodeAgentListSessionsParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const result = await client.request(
        zcodeProtocolMethods.sessionList,
        {
          workspace: buildWorkspaceRef(params),
          limit: params.limit,
          ...(params.sessionIds ? { sessionIds: params.sessionIds } : {}),
        },
        zcodeSessionListResultSchema,
      );
      for (const session of result.sessions) {
        if (session.traceId) {
          sessionTraceIdBySessionKey.set(
            sessionEventKey({ ...params, sessionId: session.sessionId }),
            session.traceId as TraceId,
          );
        }
      }
      return result.sessions;
    },

    async listSessionSubagents(params: ZCodeAgentListSessionSubagentsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.sessionSubagents,
        {
          sessionId: params.sessionId,
          endedCursor: params.endedCursor,
          endedLimit: params.endedLimit ?? 20,
        },
        zcodeSessionSubagentsResultSchema,
      );
    },

    async getAppUsageStats(params: ZCodeAgentAppUsageParams) {
      // The usage table is in the global session database; any connected workspace client can retrieve application-wide data.
      const active = activeClientsByWorkspaceKey.values().next().value;
      if (!active) {
        throw new Error("no_active_workspace");
      }
      // usage/stats → v4/usage/stats (additive query; the CLI usage store is the source of truth,
      // and the payload is unchanged. Old-term consumption is zero; the old CLI case remains until the old term is removed.)
      // Optional fields are attached only when set: an older host validates this payload with a
      // strict schema, so a default request must stay byte-identical to the pre-window shape.
      return active.client.request(
        V4_METHODS.usageStats,
        {
          range: params.range,
          timeZone: params.timeZone,
          ...(params.window ? { window: params.window } : {}),
          ...(params.compare ? { compare: true } : {}),
          ...(params.filters ? { filters: params.filters } : {}),
          ...(params.include?.length ? { include: params.include } : {}),
        },
        v4UsageStatsResultSchema,
      );
    },

    async getTaskTokenUsage(params: ZCodeAgentTaskTokenUsageParams) {
      const client = await getReadOnlyClient(params);
      // session/usage → v4/conversation/usage (same as above; task is a UI projection concept,
      // while the v4 namespace uses conversation.)
      return client.request(
        V4_METHODS.conversationUsage,
        { sessionId: params.sessionId },
        v4ConversationUsageResultSchema,
      );
    },

    async readSession(params: ZCodeAgentReadSessionParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      // When task-index calls readSession to fill in the body index, the default policy would restart the Agent
      // after its runtime was reclaimed; this observation path must not change the session lifecycle. Only explicit
      // ordinary reads synchronize the provider registry; existing-only reads must remain observational.
      if (params.runtimePolicy !== "existing-only") {
        await ensureAccountProviderConfigSynced({
          client,
          reason: "session_read",
          workspace: params,
        });
      }
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionRead,
        {
          sessionId: params.sessionId,
          deliveryKind: params.deliveryKind,
          messageLimit: params.messageLimit,
          afterSeq: params.afterSeq,
          contentProfile: params.contentProfile,
        },
        zcodeSessionStateSnapshotSchema,
      );
      rememberSessionTrace(params, snapshot);
      return snapshot;
    },

    async readSessionMessages(params: ZCodeAgentReadSessionMessagesParams) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionMessages,
        {
          sessionId: params.sessionId,
          afterMessageId: params.afterMessageId,
          limit: params.limit,
        },
        zcodeSessionMessagesResultSchema,
      );
      return result.messages;
    },

    async readSessionDebug(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(
        zcodeProtocolMethods.sessionDebug,
        { sessionId: params.sessionId },
        sessionDebugSnapshotSchema,
      );
    },

    async readSessionEvents(params: ZCodeAgentReadSessionEventsParams) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionEvents,
        {
          sessionId: params.sessionId,
          afterSeq: params.afterSeq,
          limit: params.limit,
        },
        zcodeSessionEventsResultSchema,
      );
      return result.events;
    },

    async readWorkspacePresentation(params: ZCodeAgentReadWorkspacePresentationParams) {
      const startedAt = Date.now();
      logger.info(undefined, "开始请求 ZCode Protocol workspace/readPresentation", {
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        let presentation: ZCodeWorkspacePresentation | undefined;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const client = await getReadOnlyClient(params);
          try {
            await ensureAccountProviderConfigSynced({
              client,
              reason: "workspace_read_presentation",
              workspace: params,
            });
            presentation = await client.request(
              zcodeProtocolMethods.workspaceReadPresentation,
              { workspace: buildWorkspaceRef(params) },
              zcodeWorkspacePresentationSchema,
            );
            break;
          } catch (error) {
            if (attempt > 0 || !isClosedStdioTransportError(error)) {
              throw error;
            }
            // A config update may restart the workspace Agent while workspace state is being read.
            // The old client may be acquired but its stdio transport closed before sending; reacquire
            // the current client and retry this read-only request once so the lifecycle race is not exposed to the user.
            logger.warn(
              undefined,
              "workspace/readPresentation 命中已关闭 transport，重新获取 Agent",
              {
                workspaceKey: resolveWorkspaceKey(params),
                workspacePath: params.workspacePath,
              },
            );
            const workspaceKey = resolveWorkspaceKey(params);
            if (activeClientsByWorkspaceKey.get(workspaceKey)?.client === client) {
              // transport.send may observe the closure before onClose cleanup runs; use identity-guarded
              // invalidation consistently so preference/model sync state is not left behind after removing only the active entry.
              invalidateWorkspaceClient(workspaceKey, client);
            }
          }
        }
        if (!presentation) {
          throw new Error("ZCode Protocol workspace/readPresentation did not return a result");
        }
        logger.info(undefined, "ZCode Protocol workspace/readPresentation 完成", {
          durationMs: Date.now() - startedAt,
          slashCommandCount: presentation.slashCommands.length,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return presentation;
      } catch (error) {
        logger.warn(undefined, "ZCode Protocol workspace/readPresentation 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async grantWorkspaceHookTrust(params: ZCodeAgentGrantWorkspaceHookTrustParams) {
      // Explicit pre-trust is allowed even without a task, but start only the read-only Agent control plane;
      // do not fabricate a session for a Settings operation or require provider/model readiness.
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workspaceHookTrustGrant,
        {
          workspace: buildWorkspaceRef(params),
          bundleDigest: params.bundleDigest,
          hookDeclarationDigest: params.hookDeclarationDigest,
        },
        zcodeWorkspaceHookTrustGrantResultSchema,
      );
    },

    async listMcpServerStatuses(params: ZCodeAgentListMcpServerStatusesParams) {
      const requestMcpList = async (options?: { omitMcpServers?: boolean; omitMode?: boolean }) => {
        const client = await getMcpStatusClient();
        return client.request(
          zcodeProtocolMethods.mcpList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.mcpServers !== undefined && !options?.omitMcpServers
              ? { mcpServers: params.mcpServers }
              : {}),
            ...(params.mode !== undefined && !options?.omitMode ? { mode: params.mode } : {}),
          },
          zcodeMcpListResultSchema,
        );
      };
      try {
        return await requestMcpList();
      } catch (error) {
        const unrecognizedKeys = getUnrecognizedTopLevelKeys(error);
        if (params.mode === "status" && unrecognizedKeys.includes("mode")) {
          // If an old Agent does not recognize status-only, retrying without mode falls back to the default connect,
          // reapplying replace semantics and possibly disconnecting MCP servers explicitly supplied by the UI but absent from the old Agent config.
          // Preserve the stable error code across host RPC so the UI can stop polling for an operation that cannot succeed.
          logger.warn(undefined, "旧 Agent 不支持 MCP status-only，跳过会改变连接集合的兼容重试", {
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw new ZCodeAgentMcpStatusModeUnsupportedError();
        }
        if (
          (params.mode !== undefined && unrecognizedKeys.includes("mode")) ||
          (params.mcpServers !== undefined && unrecognizedKeys.includes("mcpServers"))
        ) {
          const omitMode = unrecognizedKeys.includes("mode");
          const omitMcpServers = unrecognizedKeys.includes("mcpServers");
          logger.warn(undefined, "MCP 状态列表命中新旧协议兼容重试", {
            omittedKeys: [...(omitMode ? ["mode"] : []), ...(omitMcpServers ? ["mcpServers"] : [])],
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return await requestMcpList({
            omitMcpServers,
            omitMode,
          });
        }
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.mcpList)) {
          throw error;
        }
        logger.warn(undefined, "MCP 状态列表请求超时，重启无响应 agent 后重试一次", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        return await requestMcpList();
      }
    },

    async listPlugins(params: ZCodeAgentPluginViewParams) {
      const requestPluginsList = async () => {
        const client = await getPluginManagementClient();
        // plugins/list reads only local plugin metadata and uses the default protocol timeout, like mcp/list,
        // so a stale client is reclaimed and retried within a reasonable time instead of waiting on the 5-minute marketplace I/O timeout.
        return client.request(
          zcodeProtocolMethods.pluginsList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.configScope ? { configScope: params.configScope } : {}),
          },
          zcodePluginsListResultSchema,
        );
      };
      try {
        return await requestPluginsList();
      } catch (error) {
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.pluginsList)) {
          throw error;
        }
        logger.warn(undefined, "插件列表请求超时，重启无响应 agent 后重试一次", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        // The plugin list reads only CLI plugin metadata. If an old agent process is alive but the protocol does not respond,
        // do not keep reusing the stale client after the first plugins/list timeout. The process manager reclaims that client on timeout;
        // retry this idempotent list request once so the settings page can recover automatically after restarting the app-server.
        return await requestPluginsList();
      }
    },

    async getPluginReferenceCatalog(params: ZCodeAgentPluginReferenceCatalogParams) {
      // The Plugin reference catalog must use the workspace agent client that holds session records
      // (getReadOnlyClient prefers the active client), not the dedicated plugin-management process—
      // that process has no sessions, so a session-owned catalog would never be found.
      const client = await getReadOnlyClient(params);
      return requestPluginReferenceCatalog(client, {
        workspace: buildWorkspaceRef(params),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
    },

    async getSkillReferenceCatalog(params: ZCodeAgentSkillReferenceCatalogParams) {
      // Like Plugin references, Session snapshots exist only in the workspace agent process; the dedicated management process
      // has no resident Session and cannot serve as the conversation authority.
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.skillsReferenceCatalog,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        },
        zcodeSkillsReferenceCatalogResultSchema,
      );
    },

    async openMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiOpenInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          accountContext: params.accountContext,
          resourceUri: params.resourceUri,
          ownerWebContentsId: params.ownerWebContentsId,
        },
        zcodeMcpUiOpenInstanceResultSchema,
      );
    },
    async validateMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiValidateInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
        },
        mcpUiEmptyResultSchema,
      );
    },
    async recycleMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.mcpUiCloseInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
          onlyIfIdle: true,
        },
        zcodeMcpUiCloseInstanceResultSchema,
      );
      return result.closed;
    },
    async closeMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiCloseInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
        },
        zcodeMcpUiCloseInstanceResultSchema,
      );
    },
    async readMcpResource(params: ZCodeAgentReadMcpResourceParams) {
      // As with Skill/Plugin references, the session-frozen catalog exists only in the workspace agent process.
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpReadResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          uri: params.uri,
        },
        zcodeMcpReadResourceResultSchema,
      );
    },

    async sampleMcpApp(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      const { workspacePath: _path, workspaceIdentity: _identity, ...bound } = params;
      const wire = { ...bound, workspace: buildWorkspaceRef(params) };
      try {
        return await client.request(
          zcodeProtocolMethods.mcpUiSampling,
          wire,
          zcodeMcpUiSamplingResultSchema,
          { timeoutMs: MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS },
        );
      } catch (error) {
        // A timeout/channel failure cancels only the original call; it must not restart the Agent and initiate sampling again.
        const { request: _request, ...cancelParams } = wire;
        void client
          .request(
            zcodeProtocolMethods.mcpUiCancelSampling,
            cancelParams,
            zcodeMcpUiCancelCallResultSchema,
          )
          .catch(() => undefined);
        throw error;
      }
    },
    async cancelMcpAppSampling(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      const { workspacePath: _path, workspaceIdentity: _identity, ...bound } = params;
      return client.request(
        zcodeProtocolMethods.mcpUiCancelSampling,
        { ...bound, workspace: buildWorkspaceRef(params) },
        zcodeMcpUiCancelCallResultSchema,
      );
    },
    async callMcpToolForUi(params: ZCodeAgentCallMcpToolForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiCallTool,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          toolName: params.toolName,
          ...(params.arguments ? { arguments: params.arguments } : {}),
          callId: params.callId,
        },
        zcodeMcpUiCallToolResultSchema,
      );
    },

    async cancelMcpToolCallForUi(params: ZCodeAgentCancelMcpToolCallForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiCancelCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          callId: params.callId,
        },
        zcodeMcpUiCancelCallResultSchema,
      );
    },

    async readMcpResourceForUi(params: ZCodeAgentReadMcpResourceForUiParams) {
      // In the same process as callMcpToolForUi: ownership (pluginId ↔ serverName), the mimeType allowlist, and the 8 MiB limit all fail closed on the agent side.
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiReadResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          uri: params.uri,
        },
        zcodeMcpUiReadResourceResultSchema,
      );
    },

    async listMcpResourcesForUi(params: ZCodeAgentListMcpResourcesForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiListResources,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        zcodeMcpUiListResourcesResultSchema,
      );
    },

    async listMcpResourceTemplatesForUi(params: ZCodeAgentListMcpResourcesForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiListResourceTemplates,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        zcodeMcpUiListResourceTemplatesResultSchema,
      );
    },

    async subscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams) {
      // Subscriptions are registered on the agent side (reference-counted by server / uri and replayed after reconnect); the host only forwards the identity tuple.
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiSubscribeResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          uri: params.uri,
        },
        zcodeMcpUiResourceSubscriptionResultSchema,
      );
    },

    async unsubscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams) {
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiUnsubscribeResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          uri: params.uri,
        },
        zcodeMcpUiResourceSubscriptionResultSchema,
      );
    },

    async registerAppToolsForUi(params: ZCodeAgentRegisterAppToolsForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiRegisterAppTools,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          tools: params.tools,
        },
        zcodeMcpUiRegisterAppToolsResultSchema,
      );
    },

    async unregisterAppToolsForUi(params: ZCodeAgentAppToolInstanceForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiUnregisterAppTools,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
        },
        zcodeMcpUiUnregisterAppToolsResultSchema,
      );
    },

    async claimAppToolCallForUi(params: ZCodeAgentAppToolCallForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiClaimAppToolCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          callId: params.callId,
        },
        zcodeMcpUiAppToolAcceptedResultSchema,
      );
    },

    async resolveAppToolCallForUi(params: ZCodeAgentResolveAppToolCallForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiResolveAppToolCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          callId: params.callId,
          ...(params.result ? { result: params.result } : {}),
          ...(params.error ? { error: params.error } : {}),
        },
        zcodeMcpUiAppToolAcceptedResultSchema,
      );
    },

    async listPluginUiSurfaces(params: ZCodeAgentWorkspaceTarget) {
      // The panel is available only when a session exists, so the workspace agent is guaranteed to exist; use the read-only client to read its parsed list,
      // rather than a separate plugin-management process (which lacks this workspace’s enabled/disabled state context, as with mcp/readResource).
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.pluginsListUiSurfaces,
        { workspace: buildWorkspaceRef(params) },
        zcodePluginsListUiSurfacesResultSchema,
      );
    },

    // GUI entry point for saved workflows: use the same workspace agent client path
    // as the Skill catalog; files are in the workspace, so remote workspaces are scanned by the remote process.
    // For global scope, resolveSavedWorkflowCarrier selects the carrier;
    // forward `scope` only when it is defined.
    async listSavedWorkflows(params: ZCodeAgentListSavedWorkflowsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsList,
        { workspace, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsListResultSchema,
      );
    },

    async getSavedWorkflow(params: ZCodeAgentGetSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsGet,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsGetResultSchema,
      );
    },

    async updateSavedWorkflowMeta(params: ZCodeAgentUpdateSavedWorkflowMetaParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsUpdateMeta,
        { workspace, name: params.name, meta: params.meta, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsUpdateMetaResultSchema,
      );
    },

    async deleteSavedWorkflow(params: ZCodeAgentDeleteSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsDelete,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsDeleteResultSchema,
      );
    },

    async listSavedWorkflowRuns(params: ZCodeAgentListSavedWorkflowRunsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsRuns,
        {
          workspace,
          ...(params.name === undefined ? {} : { name: params.name }),
          limit: params.limit,
          ...savedWorkflowScopeParam(params),
        },
        zcodeWorkflowsRunsResultSchema,
      );
    },

    // Move a global profile back to a project profile (this direction only):
    // `workspace` is required and serves as both the carrier and target project (the protocol handler uses it to determine the project root), so pass it
    // directly to getReadOnlyClient(params) without global carrier selection.
    async moveSavedWorkflow(params: ZCodeAgentMoveSavedWorkflowParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsMove,
        { workspace: buildWorkspaceRef(params), name: params.name },
        zcodeWorkflowsMoveResultSchema,
      );
    },

    // “Save directly” on the completion card (docs/dynamic-workflow/transcript-and-notifications.md) must target
    // the agent client for the **workspace that owns this run**—the script reads from that process’s journal, and the same applies to global scope
    // (the agent computes the destination from scope, independent of the delivery mechanism). So call getReadOnlyClient directly without global delivery selection.
    async saveSavedWorkflowFromRun(params: ZCodeAgentSaveSavedWorkflowFromRunParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsSave,
        {
          workspace: buildWorkspaceRef(params),
          runId: params.runId,
          name: params.name,
          meta: params.meta,
          ...(params.scope === undefined ? {} : { scope: params.scope }),
          ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
        },
        zcodeWorkflowsSaveResultSchema,
      );
    },

    async findSavedWorkflowForRun(params: ZCodeAgentFindSavedWorkflowForRunParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsForRun,
        {
          workspace: buildWorkspaceRef(params),
          runId: params.runId,
          ...(params.candidates === undefined ? {} : { candidates: [...params.candidates] }),
        },
        zcodeWorkflowsForRunResultSchema,
      );
    },

    async resolveSuggestedPluginReference(params: ZCodeAgentResolveSuggestedPluginReferenceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsResolveSuggestedReference,
        {
          workspace: buildWorkspaceRef(params),
          stableId: params.stableId,
          operationId: params.operationId,
          clientMode: params.clientMode,
          deliveryKind: params.deliveryKind,
        },
        zcodePluginsResolveSuggestedReferenceResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    onDynamicPluginOperationProgress(operationId: string) {
      return getPluginOperationProgressEmitter(operationId).event;
    },

    async collectLocalRuntimeChildProcesses(signal?: AbortSignal) {
      const managed = [processManager, pluginProcessManager, mcpStatusProcessManager]
        .flatMap((manager) => manager.listManagedProcesses())
        .filter(
          (runtime) => !runtime.client.isDisposed && !runtime.client.storageStartup.isWaiting,
        );
      return Promise.all(
        managed.map(async (runtime) => {
          let children: ZCodeProcessChildProcess[] = [];
          try {
            const result = await runtime.client.request(
              zcodeProtocolMethods.processChildProcesses,
              {},
              zcodeProcessChildProcessesResultSchema,
              { timeoutMs: CHILD_PROCESSES_REQUEST_TIMEOUT_MS, lifecycle: "observation", signal },
            );
            children = result.processes;
          } catch {
            // If an older CLI does not recognize this method or the runtime is busy, all descendants of this Agent belong to cli for this turn; other runtimes are unaffected.
          }
          return {
            pid: runtime.pid,
            provider: ZCODE_AGENT_PROVIDER,
            workspacePath: runtime.workspacePath,
            ...(runtime.lane ? { lane: runtime.lane } : {}),
            children,
          };
        }),
      );
    },

    async getPluginsOverview(params: ZCodeAgentPluginViewParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsOverview,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.configScope ? { configScope: params.configScope } : {}),
        },
        zcodePluginsOverviewResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async addPluginMarketplace(params: ZCodeAgentAddPluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceAdd,
        {
          workspace: buildWorkspaceRef(params),
          source: params.source,
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async removePluginMarketplace(params: ZCodeAgentRemovePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceRemove,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePluginMarketplace(params: ZCodeAgentUpdatePluginMarketplaceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async installPlugin(params: ZCodeAgentInstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsInstall,
        {
          workspace: buildWorkspaceRef(params),
          pluginName: params.pluginName,
          marketplace: params.marketplace,
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async cancelPluginOperation(params: ZCodeAgentCancelPluginOperationParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsCancelOperation,
        { operationId: params.operationId },
        zcodePluginsCancelOperationResultSchema,
        { timeoutMs: PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS },
      );
    },

    async uninstallPlugin(params: ZCodeAgentUninstallPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsUninstall,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.removeCache !== undefined ? { removeCache: params.removeCache } : {}),
        },
        zcodePluginsUninstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async updatePlugin(params: ZCodeAgentUpdatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async restoreBuiltinPlugin(params: ZCodeAgentRestoreBuiltinPluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsRestoreBuiltin,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
        },
        zcodePluginsRestoreBuiltinResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async configurePlugin(params: ZCodeAgentConfigurePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsConfigure,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          options: params.options,
          ...(params.clearOptionKeys?.length ? { clearOptionKeys: params.clearOptionKeys } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async resetPluginConfig(params: ZCodeAgentResetPluginConfigParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsResetConfig,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async validatePlugin(params: ZCodeAgentValidatePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsValidate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.source ? { source: params.source } : {}),
        },
        zcodePluginsValidateResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async describePlugin(params: ZCodeAgentDescribePluginParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsDescribe,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
          pluginName: params.pluginName,
        },
        zcodePluginsDescribeResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async getLspPreferences(params: ZCodeAgentPluginViewParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.lspPreferencesGet,
        { workspace: buildWorkspaceRef(params) },
        zcodeLspPreferencesGetResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async setLspPreferences(params: ZCodeAgentSetLspPreferencesParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.lspPreferencesSet,
        { workspace: buildWorkspaceRef(params), patch: params.patch },
        zcodeLspPreferencesSetResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async getLspStatus(params: ZCodeAgentPluginViewParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.lspStatus,
        { workspace: buildWorkspaceRef(params) },
        zcodeLspStatusResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsSetEnabled,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          enabled: params.enabled,
          ...(params.operationId ? { operationId: params.operationId } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsSetEnabledResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    async listAutomations(params: ZCodeAgentWorkspaceTarget) {
      return automationService.list(params);
    },

    async listAllAutomations() {
      return automationService.list();
    },

    async createAutomation(params: ZCodeAgentCreateAutomationParams) {
      return automationService.create({
        title: params.title,
        cronExpr: params.cronExpr,
        relativeDelayMinutes: params.relativeDelayMinutes,
        prompt: params.prompt,
        modelSelection: params.modelSelection,
        mode: params.mode as ZCodeTaskMode | undefined,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        recurring: params.recurring ?? true,
        maxRuns: params.maxRuns,
        endAt: params.endAt,
        scheduleRule: params.scheduleRule,
      });
    },

    async updateAutomation(params: ZCodeAgentUpdateAutomationParams) {
      return automationService.update(
        params.automationId,
        {
          title: params.title,
          cronExpr: params.cronExpr,
          prompt: params.prompt,
          modelSelection: params.modelSelection,
          mode: params.mode === null ? null : (params.mode as ZCodeTaskMode | undefined),
          recurring: params.recurring,
          maxRuns: params.maxRuns,
          endAt: params.endAt,
          scheduleRule: params.scheduleRule,
          scheduleEditedByUser: params.scheduleEditedByUser,
        },
        // Ownership check: write operations must be limited to the caller's current workspace to prevent cross-workspace access.
        {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      );
    },

    async deleteAutomation(params: ZCodeAgentAutomationIdParams) {
      await automationService.delete(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async setAutomationEnabled(params: ZCodeAgentSetAutomationEnabledParams) {
      return automationService.setEnabled(params.automationId, params.enabled, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async restartAutomation(params: ZCodeAgentAutomationIdParams) {
      return automationService.restart(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async runAutomationNow(params: ZCodeAgentAutomationIdParams) {
      const dispatch = options?.onAutomationManualRunRequested;
      if (!dispatch) {
        // runNow first writes the manual run and claims the single-flight slot; a missing dispatcher is a synchronous, detectable configuration error.
        // Fail before claiming instead of relying on stale-crash recovery.
        throw new Error("Automation immediate dispatcher is unavailable.");
      }
      const claimed = await automationService.runNow(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      if (!claimed) {
        // When single-flight has rejected a duplicate run, the old empty success response made the UI think
        // a new run was queued, showing "triggered" on every repeated click.
        return { status: "duplicate" as const };
      }
      await dispatch(claimed);
      return { status: "queued" as const };
    },

    async listAutomationRuns(params: ZCodeAgentAutomationIdParams) {
      return automationService.listRuns(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async deleteAutomationRun(params: ZCodeAgentDeleteAutomationRunParams) {
      return automationService.deleteRun(params.runId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    async generateWorkspaceText(params: ZCodeAgentGenerateWorkspaceTextParams) {
      const client = await getClient(params);
      // The Worker reads ZCode Built-in / Personal Config itself; before execution, the Host only ensures the Account Config Overlay
      // derived from account state has synchronized, so a new process does not create a Model using stale plan status.
      await ensureAccountProviderConfigSynced({
        client,
        reason: "workspace_generate_text",
        workspace: params,
      });
      const operationId = params.signal ? randomUUID() : undefined;
      const cancel = () => {
        if (!operationId) return;
        void client
          .request(
            zcodeProtocolMethods.workspaceCancelGenerateText,
            { operationId },
            zcodeWorkspaceCancelGenerateTextResultSchema,
            { timeoutMs: 5_000 },
          )
          .catch((error: unknown) => {
            // Cancellation is a best-effort control-plane operation; a failure must not replace the caller's original AbortError.
            // Keep a debug trace to distinguish "stopped waiting locally" from "CLI received the cancellation."
            logger.debug(undefined, "workspace 模型请求取消通知失败", {
              operationId,
              workspaceKey: resolveWorkspaceKey(params),
              error: error instanceof Error ? error.message : String(error),
            });
          });
      };
      params.signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await client.request(
          zcodeProtocolMethods.workspaceGenerateText,
          {
            workspace: buildWorkspaceRef(params),
            selection: params.selection,
            ...(params.prompt ? { prompt: params.prompt } : {}),
            ...(params.messages ? { messages: params.messages } : {}),
            ...(params.tools ? { tools: params.tools } : {}),
            querySource: params.querySource,
            ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
            ...(operationId ? { operationId } : {}),
          },
          zcodeWorkspaceGenerateTextResultSchema,
          // Without timeoutMs, the protocol client's default 3-minute timeout may fire before the caller's own deadline
          // for a long thinking-model request, causing onRequestTimeout to misclassify it as stale and kill the process.
          // Honor requestTimeoutMs when the caller explicitly supplies it (its own deadline plus cancellation buffer).
          {
            signal: params.signal,
            ...(params.requestTimeoutMs ? { timeoutMs: params.requestTimeoutMs } : {}),
          },
        );
      } finally {
        params.signal?.removeEventListener("abort", cancel);
      }
    },

    async testModelConnectivity(params: ZCodeAgentTestModelConnectivityParams) {
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "provider_test_model_connectivity",
        workspace: params,
      });
      return client.request(
        zcodeProtocolMethods.providerTestModelConnectivity,
        {
          workspace: buildWorkspaceRef(params),
          selection: params.selection,
        },
        zcodeProviderTestModelConnectivityResultSchema,
        { signal: params.signal },
      );
    },

    async sendPrompt(params: ZCodeAgentSendPromptParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_send",
        workspace: params,
      });
      const sessionTraceId = params.sessionTraceId?.trim() || getSessionTraceId(params);
      const logTraceId = sessionTraceId ?? params.inputId;
      const browserAmbientContext =
        params.browserAmbientContext ??
        (await collectBrowserAmbientContext(options?.browserControlExecutor, {
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        }));
      const protocolParams: ZCodeAgentSendPromptParams = {
        ...params,
        ...(browserAmbientContext ? { browserAmbientContext } : {}),
      };
      logger.info(logTraceId, "ZCode Agent session/send 开始", {
        attachmentCount: params.attachments?.length ?? 0,
        hasBrowserAmbientContext: browserAmbientContext !== undefined,
        inputId: params.inputId,
        queryId: params.queryId ?? null,
        sessionId: params.sessionId,
        sessionTraceId: sessionTraceId ?? null,
        textLength: params.content.length,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionSend,
          buildSessionSendParams(protocolParams),
          zcodeSessionSendResultSchema,
        );
        logger.info(logTraceId, "ZCode Agent session/send ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        const compatFields = getSessionSendCompatFields(error);
        if (compatFields.length > 0) {
          logger.warn(logTraceId, "ZCode Agent session/send 命中新旧协议兼容重试", {
            compatFields,
            durationMs: Date.now() - startedAt,
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          const result = await client.request(
            zcodeProtocolMethods.sessionSend,
            buildSessionSendParams(protocolParams, new Set(compatFields)),
            zcodeSessionSendResultSchema,
          );
          return result;
        }
        logger.warn(logTraceId, "ZCode Agent session/send 失败", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async compactSession(params: ZCodeAgentCompactParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      const sessionTraceId = getSessionTraceId(params);
      logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact 开始", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionCompact,
          buildSessionCompactParams(params),
          zcodeSessionCompactResultSchema,
          {
            // Model maintenance during compact may last several minutes; this widens only the ACK boundary.
            // The terminal state still arrives through the session timeline/snapshot, so do not treat this as a synchronous compact result.
            timeoutMs: SESSION_COMPACT_REQUEST_TIMEOUT_MS,
          },
        );
        logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact 失败", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async goalSession(params: ZCodeAgentGoalParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(params.inputId, "开始请求 ZCode Protocol session/goal", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const result = await client.request(
          zcodeProtocolMethods.sessionGoal,
          {
            sessionId: params.sessionId,
            inputId: params.inputId,
            action: params.action,
            objective: params.objective,
            expectedRevision: params.expectedRevision,
          },
          zcodeSessionGoalResultSchema,
        );
        logger.info(params.inputId, "ZCode Protocol session/goal 完成", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          messageCount: result.snapshot.messages.length,
          responseLength: result.response?.length ?? 0,
          sessionId: params.sessionId,
          startedTurn: result.startedTurn,
          status: result.snapshot.session.status,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(params.inputId, "ZCode Protocol session/goal 失败", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async closeSession(
      params: ZCodeAgentSessionTarget & {
        expectedPersistence?: "deferred" | "immediate";
      },
    ): Promise<boolean> {
      const client = await getClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionClose,
        {
          sessionId: params.sessionId,
          ...(params.expectedPersistence
            ? { expectedPersistence: params.expectedPersistence }
            : {}),
        },
        zcodeSessionCloseResultSchema,
      );
      // Support Agents that do not yet return the closed field but have successfully completed a normal close.
      return result.closed ?? true;
    },

    async countSessionTrees(params: ZCodeAgentSessionTreeParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      try {
        return await client.request(
          zcodeProtocolMethods.sessionTreeCounts,
          { sessionIds: params.sessionIds },
          zcodeSessionTreeCountsResultSchema,
        );
      } catch (error) {
        // Older CLIs predate the method: callers fall back to generic copy and hide Erase.
        if (isProtocolMethodNotFoundError(error)) return null;
        throw error;
      }
    },

    async eraseSessionTrees(params: ZCodeAgentSessionTreeParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      try {
        return await client.request(
          zcodeProtocolMethods.sessionEraseTree,
          { sessionIds: params.sessionIds },
          zcodeSessionEraseTreeResultSchema,
        );
      } catch (error) {
        if (isProtocolMethodNotFoundError(error)) return null;
        throw error;
      }
    },

    async setModel(params: ZCodeAgentSetModelParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      logger.info(undefined, "开始请求 ZCode Protocol session/setModel", {
        expectedRevision: params.expectedRevision ?? null,
        persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed ?? null,
        requestedModel: formatModelSelectionForLog(params.model),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionSetModel,
          {
            sessionId: params.sessionId,
            model: params.model,
            expectedRevision: params.expectedRevision,
            persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
          },
          zcodeSessionStateSnapshotSchema,
        );
        logger.info(undefined, "ZCode Protocol session/setModel 完成", {
          durationMs: Date.now() - startedAt,
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          snapshotModel: formatModelSelectionForLog(snapshot.settings.model.current),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      } catch (error) {
        logger.warn(undefined, "ZCode Protocol session/setModel 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    async setThoughtLevel(params: ZCodeAgentSetThoughtLevelParams) {
      const client = await getClient(params);
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionSetThoughtLevel,
        {
          sessionId: params.sessionId,
          thoughtLevel: params.thoughtLevel,
          expectedRevision: params.expectedRevision,
          persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
        },
        zcodeSessionStateSnapshotSchema,
      );
      return snapshot;
    },

    async setMode(params: ZCodeAgentSetModeParams) {
      const client = await getClient(params);
      return client.request(
        zcodeProtocolMethods.sessionSetMode,
        {
          sessionId: params.sessionId,
          mode: params.mode,
          expectedRevision: params.expectedRevision,
        },
        zcodeSessionStateSnapshotSchema,
      );
    },

    async respondSessionRuntimePreferences(
      params: ZCodeAgentRespondSessionRuntimePreferencesParams,
    ): Promise<void> {
      const pending = takePendingSessionRuntimePreferences(params.requestId);
      if (!pending) {
        logger.warn(undefined, "运行时偏好响应找不到 pending 请求", {
          event: "zcode_agent.runtime_preferences.response_without_pending",
          module: "services.zcode_agent",
          requestId: params.requestId,
        });
        throw new Error(`ZCode session runtime preferences request not found: ${params.requestId}`);
      }
      const responseContext = {
        event: "zcode_agent.runtime_preferences.host_response_received",
        module: "services.zcode_agent",
        requestId: params.requestId,
        scope: pending.request.scope,
        sessionId: pending.request.sessionId,
        workspaceKey: pending.workspaceKey,
      };
      if (params.resolution.status === "failed") {
        logger.warn(undefined, "Host 返回运行时偏好失败", {
          ...responseContext,
          error: params.resolution.message,
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: params.resolution.message,
        });
        return;
      }
      let preferences: ZCodeSessionRuntimePreferencesResult;
      try {
        preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
          params.resolution.preferences,
        );
        // 远端组织态由远端 Host 读取；客户端设置回包不能覆盖本机目录事实。
        if (
          pending.request.scope === "runtime-materialization" &&
          options?.resolveSessionDirectories
        ) {
          preferences.additionalDirectories = await options.resolveSessionDirectories({
            ...pending.workspace,
            sessionId: pending.request.sessionId,
          });
        }
      } catch (error) {
        logger.warn(undefined, "Host 返回运行时偏好格式非法", {
          ...responseContext,
          error: error instanceof Error ? error.message : String(error),
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // A send failure means the transport is closed; do not mistake it for a preference-validation failure and send a second response.
      await pending.client.respond(pending.protocolRequestId, preferences);
      logger.info(undefined, "运行时偏好响应已回传 Agent", responseContext);
    },

    onDynamicWorkspaceProviderRuntimeHeadersCancelled(params: ZCodeAgentWorkspaceTarget) {
      const key = resolveWorkspaceKey(params);
      let emitter = providerRuntimeHeadersCancelledEmitters.get(key);
      if (!emitter) {
        emitter = new Emitter<ZCodeProviderRuntimeHeadersCancelled>();
        providerRuntimeHeadersCancelledEmitters.set(key, emitter);
      }
      return emitter.event;
    },

    onDynamicSessionRuntimePreferencesRequest() {
      return (listener) => {
        const disposable = sessionRuntimePreferencesRequestEmitter.event(listener);
        for (const pending of pendingSessionRuntimePreferences.values()) {
          listener(pending.request);
        }
        return disposable;
      };
    },

    async respondProviderRuntimeHeaders(
      params: ZCodeAgentRespondProviderRuntimeHeadersParams,
    ): Promise<void> {
      const key = providerRuntimeHeadersRequestKey(params);
      const pending = pendingProviderRuntimeHeaders.get(key);
      if (!pending) {
        throw new Error(`ZCode provider runtime headers request not found: ${params.requestId}`);
      }
      if (pending.responding) {
        throw new Error(
          `ZCode provider runtime headers response already pending: ${params.requestId}`,
        );
      }
      // Do not delete pending before waiting for account I/O, or a newly merged cancellation notification will not find the request;
      // retain the identity until resolution completes, while preventing both workspace and session consumers from responding.
      pending.responding = true;
      if (!params.response.headersApplied) {
        pendingProviderRuntimeHeaders.delete(key);
        await pending.client.respond(pending.protocolRequestId, {
          headersApplied: false,
          ...(params.response.errorMessage ? { errorMessage: params.response.errorMessage } : {}),
        });
        return;
      }
      let accountRequestAuth: AccountRequestAuthMaterial | undefined;
      try {
        accountRequestAuth = await resolveAccountRequestAuth(pending.request);
      } catch (error) {
        if (pendingProviderRuntimeHeaders.get(key) !== pending) return;
        pendingProviderRuntimeHeaders.delete(key);
        logger.warn(undefined, "ZCode provider runtime headers 应用失败", {
          modelId: pending.request.modelSelection.modelId,
          providerId: pending.request.providerId,
          requestId: pending.request.requestId,
          sessionId: pending.request.sessionId,
          error: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(pending.request.workspace),
        });
        await pending.client.respond(pending.protocolRequestId, {
          headersApplied: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      if (pendingProviderRuntimeHeaders.get(key) !== pending) return;
      pendingProviderRuntimeHeaders.delete(key);
      const requestHeaders = {
        ...accountRequestAuth?.headers,
      };
      Object.assign(
        requestHeaders,
        allowRequestVerificationHeaders(params.response.runtimeProviderHeaders ?? {}),
      );
      const requestAuth =
        accountRequestAuth?.apiKey || Object.keys(requestHeaders).length > 0
          ? {
              ...(accountRequestAuth?.apiKey ? { apiKey: accountRequestAuth.apiKey } : {}),
              ...(accountRequestAuth?.apiKeyId ? { apiKeyId: accountRequestAuth.apiKeyId } : {}),
              ...(accountRequestAuth?.accountScope
                ? { accountScope: accountRequestAuth.accountScope }
                : {}),
              ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
            }
          : undefined;
      await pending.client.respond(
        pending.protocolRequestId,
        requestAuth
          ? { headersApplied: true, requestAuth }
          : { headersApplied: false, errorMessage: "Provider request auth is missing" },
      );
      const logContext = {
        modelId: pending.request.modelSelection.modelId,
        providerId: pending.request.providerId,
        requestId: pending.request.requestId,
        sessionId: pending.request.sessionId,
        ...(params.response.errorMessage ? { error: params.response.errorMessage } : {}),
        workspaceKey: resolveWorkspaceKey(pending.request.workspace),
      };
      if (requestAuth) {
        logger.info(undefined, "ZCode provider runtime headers 已应用", logContext);
      } else {
        logger.warn(undefined, "ZCode provider runtime headers 应用失败", logContext);
      }
    },

    onDynamicProviderRuntimeHeadersRequest(params: ZCodeAgentSessionTarget) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        const disposable = emitter.event((event) => {
          if (event.type !== "providerRuntimeHeaders.request") {
            return;
          }
          listener(event.request);
        });
        // Bug cause: the first draft starts a turn before binding the new sessionId to the React pane;
        // the provider runtime headers request can arrive before the pane’s live subscription. The old implementation only fired an event,
        // leaving the request in the pending map while the request-validation consumer never received it, so the real model request could not be sent.
        // Register the live listener first, then deliver pending requests for the current session to close both race windows.
        const pendingSessionPrefix = `${sessionEventKey(params)}\u0000`;
        for (const [key, pending] of pendingProviderRuntimeHeaders) {
          if (key.startsWith(pendingSessionPrefix)) {
            listener(pending.request);
          }
        }
        return disposable;
      };
    },

    onDynamicWorkspaceProviderRuntimeHeadersRequest(params: ZCodeAgentWorkspaceTarget) {
      const emitter = getProviderRuntimeHeadersWorkspaceEmitter(params);
      return (listener) => {
        const disposable = emitter.event((request) => {
          listener(request);
        });
        // Bug cause (2026-08-16 web remote-control hang): the session-level entry point requires subscribers to know the sessionId,
        // but sessions created by Web remote control have no pane on Desktop, so nothing subscribes there and the headers request
        // remains pending forever. Workspace-level subscriptions have the same semantics as session-level subscriptions: register a live listener first,
        // then deliver pending requests with the workspaceKey prefix, closing the race where a request arrives before subscription;
        // isolate by workspaceKey (identity takes precedence) and never cross-deliver requests between remote workspaces that share a path.
        const pendingWorkspacePrefix = `${resolveWorkspaceKey(params)}\u0000`;
        for (const [key, pending] of pendingProviderRuntimeHeaders) {
          if (key.startsWith(pendingWorkspacePrefix)) {
            listener(pending.request);
          }
        }
        return disposable;
      };
    },

    onDynamicSessionEvent(params: ZCodeAgentSessionSubscribeParams) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        // cancelled / retryTimer are scoped to one subscriber: when a caller disposes, cancel its retry
        // without affecting other subscribers on the shared emitter.
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let subscriptionReady = false;
        const pendingLiveEvents: ZCodeAgentServiceEvent[] = [];
        const deliveredEventIds = new Set<string>();
        const deliveredEventIdOrder: string[] = [];
        const eventCoalescer =
          params.eventCoalescing?.mode === "background-summary"
            ? createBackgroundSessionEventCoalescer({
                emit: listener,
                flushDelayMs: params.eventCoalescing.intervalMs,
              })
            : null;

        const deliverToListener = (event: ZCodeAgentServiceEvent): void => {
          if (cancelled) {
            return;
          }
          if (event.type === "session.event") {
            const firstDelivery = rememberBoundedEventId(
              deliveredEventIds,
              deliveredEventIdOrder,
              event.event.eventId,
            );
            if (!firstDelivery) {
              return;
            }
          }
          // Performance: background tasks need only low-frequency summaries; do not wake the renderer for every token/progress
          // update from an invisible task. Active subscriptions have no eventCoalescing and remain real-time continuous.
          if (eventCoalescer) {
            eventCoalescer.accept(event);
            return;
          }
          listener(event);
        };

        const releaseBufferedLiveEvents = (): void => {
          if (subscriptionReady) {
            return;
          }
          subscriptionReady = true;
          const bufferedEvents = pendingLiveEvents.splice(0);
          for (const event of bufferedEvents) {
            deliverToListener(event);
          }
        };

        const subscription = emitter.event((event) => {
          if (cancelled) {
            return;
          }
          if (!subscriptionReady) {
            pendingLiveEvents.push(event);
            return;
          }
          deliverToListener(event);
        });

        const establishSubscription = async (attempt: number): Promise<void> => {
          if (cancelled) {
            return;
          }
          try {
            const client = await getReadOnlyClient(params);
            if (cancelled) {
              return;
            }
            const result = await client.request(
              zcodeProtocolMethods.sessionSubscribe,
              {
                sessionId: params.sessionId,
                deliveryKind: params.deliveryKind,
                afterSeq: params.afterSeq,
                includeSnapshot: params.includeSnapshot ?? false,
              },
              zcodeSessionSubscribeResultSchema,
            );
            if (cancelled) {
              return;
            }
            const replayEvents = result.events
              .map((event) => normalizeSessionEventSeq(params, event))
              .sort((left, right) => left.seq - right.seq || left.timestamp - right.timestamp);
            // session/subscribe returns a replay gap for the current subscriber only.
            // Do not fire replay events on the shared emitter: that would rebroadcast historical events to other live subscribers
            // and insert completed tools into the UI timeline after the current model output.
            for (const event of replayEvents) {
              deliverToListener({ type: "session.event", event });
            }
            if (result.snapshot) {
              deliverToListener({
                type: "snapshot",
                snapshot: result.snapshot,
              });
            }
            releaseBufferedLiveEvents();
          } catch (error) {
            if (cancelled) {
              return;
            }
            if (attempt >= SESSION_SUBSCRIBE_MAX_ATTEMPTS - 1) {
              // Warn on terminal failure so the issue remains observable instead of silently failing.
              logger.warn(
                undefined,
                "session subscription failed after the maximum retry attempts; giving up",
                {
                  sessionId: params.sessionId,
                  workspaceKey: resolveWorkspaceKey(params),
                  attempts: attempt + 1,
                  message: error instanceof Error ? error.message : String(error),
                },
              );
              // After subscription failure, do not hold back live events indefinitely; without an authoritative replay to fill the gap, resume the continuous stream.
              releaseBufferedLiveEvents();
              return;
            }
            const delay = Math.min(
              SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS * 2 ** attempt,
              SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS,
            );
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void establishSubscription(attempt + 1);
            }, delay);
          }
        };

        void establishSubscription(0);

        return {
          dispose() {
            cancelled = true;
            if (retryTimer) {
              clearTimeout(retryTimer);
              retryTimer = undefined;
            }
            pendingLiveEvents.length = 0;
            eventCoalescer?.dispose();
            subscription.dispose();
          },
        };
      };
    },

    // ── v4 conversation channel (vertical slice): Host only forwards data and stores no business state ──

    async helloConversationV4() {
      return {
        kind: "hello" as const,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: v4ConnectionId,
        clientMode: "desktop-continuous" as const,
        deliveryProfile: "continuous" as const,
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none" as const,
          workspaceHookReview: true,
          independentPlanState: true,
          durableFirstSubmission: true,
          incognitoSession: true,
          incognitoPromptToggles: true,
          // Use the same capability set as the connection-scope hello so internal consumers that call the base service directly
          // can also receive `workflowRun.*` deltas (their own clientHello determines whether they actually receive them).
          workflowRunDeltas: true,
          historyFirst: true,
        },
        auth: {},
      };
    },

    async initializeConversationV4(rawClientHello) {
      clientHelloSchema.parse(rawClientHello);
    },

    async setConnectionFlowStateV4(params: ZCodeAgentConnectionFlowParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.connection.flowControlUntrusted");
      const client = await getReadOnlyClient(params);
      await client.request(
        V4_METHODS.connectionFlow,
        { connectionId: trusted.connectionId, state: params.state },
        v4ConnectionFlowResultSchema,
      );
    },

    async subscribeConversationV4(params: ZCodeAgentConversationSubscribeParams) {
      const subscribeStartedAt = performance.now();
      const existingClient = processManager.getExistingClient(params);
      const cliProcessState: "reused" | "spawned" =
        existingClient && !existingClient.isDisposed ? "reused" : "spawned";
      const cliBootstrapStartedAt = performance.now();
      // The history topic is the read-only source of truth after a task-list click. If provider/model are not configured and we reuse
      // the model-execution gate, the item could appear in the list but still fail to open; subscription starts the CLI without granting write capability.
      const client = await getReadOnlyClient(params);
      const cliBootstrapMs =
        cliProcessState === "spawned"
          ? Math.max(0, Math.round(performance.now() - cliBootstrapStartedAt))
          : undefined;
      // A cold conversation subscription restores the historical Session inside the CLI and publishes the first frame immediately.
      // If Account Config has not arrived, the first frame is resolved against a Registry without the Account Overlay; establish
      // only an Account Config ordering barrier here, without granting model-execution permission. The Worker still owns ZCode Built-in / Personal.
      const providerRegistryStartedAt = performance.now();
      await ensureAccountProviderConfigSynced({
        client,
        reason: "conversation_subscribe",
        workspace: params,
      });
      const providerRegistrySyncMs = Math.max(
        0,
        Math.round(performance.now() - providerRegistryStartedAt),
      );
      const connection = resolveV4Connection(params);
      const historyFirst = connection.historyFirst === true && (await supportsHistoryFirst(client));
      const topic = conversationTopic(params.sessionId);
      const taskMetaStartedAt = performance.now();
      const resumeThoughtLevel = await automationTaskIndexRepo
        .getTaskMeta({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId: params.sessionId,
        })
        .then((meta) => meta?.thoughtLevel?.trim() || undefined)
        .catch((error) => {
          // V4 cold subscriptions in desktop-continuous bypass the task adapter, so an old session without
          // Agent durable selection would lose its task-local thought. Allow read-only recovery even if reading the index fails.
          logger.warn(undefined, "读取 V4 cold resume thought hint 失败，继续无 hint 订阅", {
            error: error instanceof Error ? error.message : String(error),
            event: "v4.conversation.subscribe.resume_thought_hint_failed",
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return undefined;
        });
      let directorySessionId = params.sessionId;
      if (options?.resolveSessionDirectories) {
        // 子会话按设计不进主任务索引；直接查 child 的项目会被远端必选项目校验拒绝。
        // 旧 child 索引也不能证明主任务身份；只信 Agent 持久化父链，再执行原项目校验。
        const visited = new Set<string>();
        while (true) {
          if (visited.has(directorySessionId)) throw new Error("project.session-lineage-invalid");
          visited.add(directorySessionId);
          const { sessions } = await client.request(
            zcodeProtocolMethods.sessionList,
            { workspace: buildWorkspaceRef(params), sessionIds: [directorySessionId] },
            zcodeSessionListResultSchema,
          );
          const session = sessions.find((entry) => entry.sessionId === directorySessionId);
          if (!session) {
            if (directorySessionId !== params.sessionId)
              throw new Error("project.session-lineage-invalid");
            break;
          }
          if (
            resolveWorkspaceKey(session.workspace) !== resolveWorkspaceKey(params) ||
            session.workspace.workspacePath !== params.workspacePath
          )
            throw new Error("project.session-lineage-invalid");
          if (!isAuxiliarySessionKind(session.sessionKind)) break;
          if (!session.parentSessionId) throw new Error("project.session-lineage-invalid");
          directorySessionId = session.parentSessionId;
        }
      }
      const additionalDirectories = await options?.resolveSessionDirectories?.({
        ...params,
        sessionId: directorySessionId,
      });
      const taskMetaReadMs = Math.max(0, Math.round(performance.now() - taskMetaStartedAt));
      const cliRequestStartedAt = performance.now();
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          // Trusted bit in the same family as clientMode (10 §3.1): inject it only here from the connection's clientHello.
          // If absent, the CLI sends a whole-key patch for an old consumer and first constrains it to the old boundary. Resubscription, recovery, and mobile
          // relay attachment all use this subscribe path, so handling it here covers them all.
          ...(connection.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
          ...(historyFirst
            ? {
                historyFirst: true,
                ...(params.retryInitialization
                  ? { retryInitialization: params.retryInitialization }
                  : {}),
              }
            : {}),
          // Root cause: cold subscriptions previously passed only sessionId, forcing the CLI to infer
          // workspace identity from historical session.path, which path.resolve may already have changed. The current attachment is authoritative.
          workspace: buildWorkspaceRef(params),
          ...(resumeThoughtLevel ? { resumeThoughtLevel } : {}),
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4ConversationSubscribeResultSchema,
      );
      const cliRequestMs = Math.max(0, Math.round(performance.now() - cliRequestStartedAt));
      const hostPrepareMs = Math.max(0, Math.round(cliRequestStartedAt - subscribeStartedAt));
      const openTiming = {
        ...(result.ack.openTiming ? result.ack.openTiming : {}),
        version: 1 as const,
        hostPrepareMs,
        ...(cliBootstrapMs !== undefined ? { cliBootstrapMs } : {}),
        cliProcessState,
        providerRegistrySyncMs,
        taskMetaReadMs,
        cliRequestMs,
      };
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return {
        ...result,
        ack: {
          ...result.ack,
          openTiming,
        },
      };
    },

    async unsubscribeConversationV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "conversation/");
    },

    async resyncConversationV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "conversation/");
    },

    async sendConversationCommandV4(params: ZCodeAgentConversationCommandParams) {
      const client = await getClient(params);
      const planPayload = params.envelope.payload as {
        planEnabled?: boolean;
        config?: { planEnabled?: boolean };
        firstInput?: { planEnabled?: boolean };
      };
      if (
        planPayload.planEnabled ||
        planPayload.config?.planEnabled ||
        planPayload.firstInput?.planEnabled
      ) {
        await ensureIndependentPlanSupport(client);
      }
      if (
        params.envelope.type === "createSession" &&
        (params.envelope.payload as { incognito?: unknown }).incognito !== undefined
      ) {
        await ensureIncognitoSupport(client);
      }
      if (params.envelope.type === "createSession") {
        const payload = params.envelope.payload as {
          submissionPreparation?: unknown;
          expectedSubmissionId?: unknown;
        };
        if (
          payload.submissionPreparation !== undefined ||
          payload.expectedSubmissionId !== undefined
        ) {
          await ensureDurableFirstSubmissionSupport(client);
        }
      }
      // The RPC facade removes the caller-forgeable top-level clientMode and injects the Host's
      // trusted value via the trusted carrier; direct calls from internal Host adapters still support explicit clientMode.
      const commandClientMode =
        readTrustedZCodeAgentV4Connection(params)?.clientMode ??
        params.clientMode ??
        "desktop-continuous";
      if (
        params.envelope.type === "createSession" &&
        !(params.envelope.payload as { submissionPreparation?: unknown }).submissionPreparation
      ) {
        // V4 draft warmup forwards commands directly; before creating a new session, wait only for Account Config,
        // since the Worker process assembles ZCode Built-in / Personal in its own Registry.
        await ensureAccountProviderConfigSynced({
          client,
          reason: "v4_command",
          workspace: params,
        });
      }
      let envelope = await buildConversationCommandEnvelope(params);
      const createReservationSessionId =
        options?.prepareSessionCreation !== undefined
          ? plainCreateReservationSessionId(params, envelope)
          : undefined;
      // The first TTFT version allows only trusted desktop-local continuous sessions; mobile/remote forwarding cannot enable local observation.
      if (
        commandClientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      ) {
        const { ttft: _ttft, ...withoutTtft } = envelope;
        envelope = withoutTtft;
      }
      if (envelope.type === "sendText" && envelope.sessionId) {
        const sessionId = envelope.sessionId;
        const payload = {
          ...commandPayloadSchemas.sendText.parse(envelope.payload),
          inputOrigin:
            commandClientMode === "web-remote-replayable"
              ? ("mobile" as const)
              : ("desktop" as const),
        };
        envelope = { ...envelope, payload };
        const browserAmbientContext = await collectBrowserAmbientContext(
          options?.browserControlExecutor,
          {
            sessionId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
            clientMode: commandClientMode,
          },
        );
        if (browserAmbientContext) {
          envelope = {
            ...envelope,
            payload: { ...payload, browserAmbientContext },
          };
        }
      }
      const ack: CommandAck = await client.request(V4_METHODS.command, envelope, commandAckSchema);
      await discardAbandonedSessionReservation(params, ack, createReservationSessionId);
      await claimForkedSessionOwnership(params, envelope, ack);
      // The Prompt command returns as soon as either committed TurnStarted or committed WorkspaceHookReviewRequested authority arrives;
      // human review must not occupy Host RPC, so keep the shared default timeout/watchdog. Extending it to the review deadline would only hide a serial protocol queue deadlock.
      // A duplicate proves only that commandId was processed before, not that its target still matches the current session configuration.
      // If an old command for B is replayed after the user switched to C, it must not use duplicate status to change derived caches back to B.
      return ack;
    },

    async queryConversationCommandsV4(params: ZCodeAgentCommandsQueryParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.command.queryConnectionUntrusted");
      }
      const query = commandsQueryParamsSchema.parse({
        commands: params.commands,
        ...(params.clock ? { clock: true } : {}),
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.commandsQuery, query, commandsQueryResultSchema);
    },

    async attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        fileName: params.fileName,
        mime: params.mime,
        totalBytes: params.totalBytes,
        totalChunks: params.totalChunks,
        checksum: params.checksum,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentBegin, wireParams);
      return client.request(V4_METHODS.attachmentBegin, wireParams, v4AttachmentBeginResultSchema);
    },

    async attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        chunkIndex: params.chunkIndex,
        dataBase64: params.dataBase64,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentChunk, wireParams);
      return client.request(V4_METHODS.attachmentChunk, wireParams, v4AttachmentChunkResultSchema);
    },

    async attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentCommit, wireParams);
      return client.request(
        V4_METHODS.attachmentCommit,
        wireParams,
        v4AttachmentCommitResultSchema,
      );
    },

    async attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentAbort, wireParams);
      await client.request(V4_METHODS.attachmentAbort, wireParams, v4AttachmentAbortResultSchema);
    },

    async attachmentReadV4(params: ZCodeAgentAttachmentReadParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.attachment.readConnectionUntrusted");
      }
      const wireParams = v4AttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.attachmentRead, wireParams, v4AttachmentReadResultSchema);
    },

    async conversationAttachmentReadV4(params: ZCodeAgentConversationAttachmentReadParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
        offset: params.offset,
        limit: params.limit,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentRead,
        wireParams,
        v4ConversationAttachmentReadResultSchema,
      );
    },

    async conversationAttachmentStatV4(params: ZCodeAgentConversationAttachmentStatParams) {
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted,
        );
      }
      const wireParams = v4ConversationAttachmentStatParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
      });
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentStat,
        wireParams,
        v4ConversationAttachmentStatResultSchema,
      );
    },

    async attachmentPreviewSourceV4(params: ZCodeAgentAttachmentPreviewSourceParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.previewSourceConnectionUntrusted");
      if (trusted.clientMode !== "desktop-continuous" || params.remoteSessionId) {
        return { kind: "chunked" } as const;
      }
      const wireParams = v4AttachmentPreviewSourceParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        clientMode: trusted.clientMode,
      });
      const client = await getReadOnlyClient(params);
      const source = await client.request(
        V4_METHODS.attachmentPreviewSource,
        wireParams,
        v4AttachmentPreviewSourceResultSchema,
      );
      if (source.kind !== "local_path") return source;
      if (!options?.authorizeLocalMediaPreviewPath) {
        throw new Error("fault.attachment.previewPathAuthorizationUnavailable");
      }
      return {
        ...source,
        path: await options.authorizeLocalMediaPreviewPath(source.path),
      };
    },

    // Row pagination: forward the read-only query (safe to retry after timeout; no subscription state).
    async conversationRowsRangeV4(params: ZCodeAgentConversationRowsRangeParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.conversation.rowsRangeConnectionUntrusted");
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationRowsRange,
        {
          sessionId: params.sessionId,
          clientMode: trusted.clientMode,
          ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
          limit: params.limit,
        },
        v4ConversationRowsRangeResultSchema,
      );
    },

    // Forward the read-only plan catalog over the existing workspace attachment; do not create a new runtime.
    async conversationPlansV4(params: ZCodeAgentConversationPlansParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationPlans,
        { sessionId: params.sessionId },
        v4ConversationPlansResultSchema,
      );
    },

    // Workflow-run event log: also a read-only query forwarded through the existing workspace attachment.
    // Pagination happens in storage (JournalStorePort.listEvents accepts afterSequence/limit); do not slice here,
    // because paginating at the RPC layer would load the entire journal into memory on every page.
    async conversationWorkflowRunEventsV4(params: ZCodeAgentConversationWorkflowRunEventsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunEvents,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunEventsResultSchema,
      );
    },

    // Workflow-run enumeration: journal-backed discovery after restart (the workflowRuns projection does not survive across processes).
    async conversationWorkflowRunsV4(params: ZCodeAgentConversationWorkflowRunsParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRuns,
        {
          sessionId: params.sessionId,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunsResultSchema,
      );
    },

    // Three read surfaces for user-facing DWF artifacts.
    // ⚠ Terminology: artifact = output published by a script for users, not the run's top-level return value.
    // Like plans / workflowRunEvents, these are read-only, stateless, safe to retry after timeout, and use the read-only client.
    async conversationWorkflowRunArtifactsV4(
      params: ZCodeAgentConversationWorkflowRunArtifactsParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifacts,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunArtifactsResultSchema,
      );
    },

    // Dashboard data: the CLI gateway owns the default and bounds for limit, so only forward it here. Clamping in both places
    // would eventually give the same limit different page sizes at the two layers.
    async conversationWorkflowRunArtifactDataV4(
      params: ZCodeAgentConversationWorkflowRunArtifactDataParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactData,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunArtifactDataResultSchema,
      );
    },

    // Bytes: one chunk at a time (≤ 512 KiB), assembled by the renderer hook. Authorization stays entirely on the CLI side—
    // the ID passed here is used only to look up a journal row and never becomes a path.
    async conversationWorkflowRunArtifactReadV4(
      params: ZCodeAgentConversationWorkflowRunArtifactReadParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactRead,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
          version: params.version,
          offset: params.offset,
          limit: params.limit,
        },
        v4ConversationWorkflowRunArtifactReadResultSchema,
      );
    },

    // Two read surfaces for DWF workspace transcripts. Like the others, they are
    // read-only, stateless, safe to retry after timeout, and use the read-only client. The CLI gateway owns the maxBytes default and bounds.
    async conversationWorkflowRunWorkspaceV4(
      params: ZCodeAgentConversationWorkflowRunWorkspaceParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunWorkspace,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunWorkspaceResultSchema,
      );
    },

    async conversationWorkflowRunNodeResultV4(
      params: ZCodeAgentConversationWorkflowRunNodeResultParams,
    ) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationWorkflowRunNodeResult,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          siteId: params.siteId,
          ordinal: params.ordinal,
          ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        },
        v4ConversationWorkflowRunNodeResultResultSchema,
      );
    },

    async backgroundBashOutputV4(params: ZCodeAgentBackgroundBashOutputParams) {
      if (!readTrustedZCodeAgentV4Connection(params))
        throw new Error("fault.bashOutput.connectionUntrusted");
      const wireParams = v4BackgroundBashOutputParamsSchema.parse({
        sessionId: params.sessionId,
        workId: params.workId,
      });
      try {
        const client = await getReadOnlyClient(params, "existing-only");
        return await client.request(
          V4_METHODS.backgroundBashOutput,
          wireParams,
          backgroundBashOutputResultSchema,
        );
      } catch (error) {
        if (isProtocolMethodNotFoundError(error))
          return { kind: "unsupported", workId: params.workId };
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
        ) {
          return { kind: "unavailable", workId: params.workId };
        }
        throw error;
      }
    },

    async conversationFileChangesV4(params: ZCodeAgentConversationFileChangesParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileChanges,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileChangesResultSchema,
      );
    },

    async conversationFileRewindPreviewV4(params: ZCodeAgentConversationFileRewindPreviewParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationFileRewindPreview,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileRewindPreviewResultSchema,
      );
    },

    onDynamicConversationFrame(params: ZCodeAgentWorkspaceTarget) {
      return getConversationFrameEmitter(params).event;
    },

    onDynamicLocalTtftFacts(params: ZCodeAgentWorkspaceTarget) {
      return (listener: (facts: LocalTtftFacts) => void) =>
        localTtftFactsEmitter.event((event) => {
          if (event.workspaceKey === resolveWorkspaceKey(params)) listener(event.facts);
        });
    },
    onDynamicConversationTelemetryFact(params: ZCodeAgentWorkspaceTarget) {
      return getConversationTelemetryFactEmitter(params).event;
    },
    onDynamicOffPeakLifecycle(params: ZCodeAgentWorkspaceTarget) {
      return getOffPeakLifecycleEmitter(params).event;
    },
    async controlOffPeakExecutionV4(
      params: ZCodeAgentWorkspaceTarget & { control: OffPeakControlParams },
    ) {
      const control = offPeakControlParamsSchema.parse(params.control);
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(V4_METHODS.offPeakControl, control, offPeakControlResultSchema);
    },

    onDynamicPluginUiToolResult() {
      return pluginUiToolResultEmitter.event;
    },
    onDynamicCuaPermissionObservation() {
      return cuaPermissionObservationEmitter.event;
    },

    // ── sessions-index channel (list activity): reuse conversationSubscribe RPC,
    // dispatched by topic prefix in the CLI server ──

    async reconcileSessionsIndexV4(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(
        V4_METHODS.sessionsIndexReconcile,
        { workspaceId: resolveWorkspaceKey(params), sessionIds: params.sessionIds },
        sessionsIndexReconcileResultSchema,
      );
    },

    async subscribeSessionsIndexV4(params: ZCodeAgentSessionsIndexSubscribeParams) {
      // The sidebar registers all restored workspaces at once. If passive subscriptions use a startup client,
      // the number of workspaces directly multiplies the number of CLIs; existing-only becomes dormant when no runtime exists.
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = sessionsIndexTopic(resolveWorkspaceKey(params));
      // CLI sessions from 3.3.6 did not write remote workspace_id, but the same-version Host task index
      // already isolates by full identity. During upgrade, use taskId under the current workspaceKey as ownership proof;
      // do not pass only workspacePath to the CLI, or different SSH/WSL authorities at the same path could claim each other's history.
      let legacyTaskIds: string[] = [];
      if (supportsLegacyRemoteTaskAllowlist(params.workspaceIdentity)) {
        try {
          legacyTaskIds = (
            await automationTaskIndexRepo.listTaskMetas({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              provider: "glm",
            })
          )
            .slice(0, MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE)
            .map((task) => task.taskId);
        } catch (error) {
          // Ownership proof is only for upgrade migration; if the task index is unavailable, existing 3.4 sessions with full
          // identity must still use strict queries. A compatibility-read failure must not make the entire list unavailable.
          logger.warn(undefined, "读取远端历史任务归属证明失败，继续按严格 identity 订阅", {
            error: error instanceof Error ? error.message : String(error),
            event: "sessions_index.legacy_remote_allowlist_read_failed",
            workspaceIdentity: params.workspaceIdentity,
            workspacePath: params.workspacePath,
          });
        }
      }
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(legacyTaskIds.length > 0 ? { legacyTaskIds } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4SessionsIndexSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeSessionsIndexV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "sessions-index/");
    },

    async resyncSessionsIndexV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "sessions-index/");
    },

    onDynamicSessionsIndexFrame(params: ZCodeAgentWorkspaceTarget) {
      return getSessionsIndexFrameEmitter(params).event;
    },

    // ── workspace-config channel (configuration-directory activity): reuse conversationSubscribe RPC,
    // dispatched by topic prefix in the CLI server ──

    async subscribeWorkspaceConfigV4(params: ZCodeAgentWorkspaceConfigSubscribeParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      const topic = workspaceConfigTopic(resolveWorkspaceKey(params));
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4WorkspaceConfigSubscribeResultSchema,
      );
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    async unsubscribeWorkspaceConfigV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "workspace-config/");
    },

    async resyncWorkspaceConfigV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "workspace-config/");
    },

    onDynamicWorkspaceConfigFrame(params: ZCodeAgentWorkspaceTarget) {
      return getWorkspaceConfigFrameEmitter(params).event;
    },

    onDynamicProcessResourceSample() {
      return processResourceSampleEmitter.event;
    },

    onDynamicToolExecResource() {
      return toolExecResourceEmitter.event;
    },
    onDynamicMcpResourceSamples() {
      return mcpResourceSamplesEmitter.event;
    },

    onDynamicMcpTelemetry() {
      return mcpTelemetryEmitter.event;
    },

    // (CLI reconnect/resubscription): process-generation changes pass directly through the process manager; v4 subscribers (such as task-index
    // syncer) use this to resend subscribe—the subscriptions live in CLI process memory and silently become inactive after a generation change.
    onAgentRuntimeRestarted(listener) {
      return processManager.onRuntimeRestarted(listener);
    },

    onAgentRuntimeLifecycle(listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void) {
      return processManager.onRuntimeLifecycle(listener);
    },

    async disposeWorkspace(params): Promise<void> {
      const workspaceKey = resolveWorkspaceKey(params);
      // Release must not only terminate the current process, but also invalidate queued provider-ready continuations;
      // otherwise one could restart the Agent for the same workspace after dispose completes.
      cancelWaitingWorkspaceStartup(workspaceKey);
      clearV4SubscriptionRoutes(workspaceKey);
      cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      if (active) {
        invalidateWorkspaceClient(workspaceKey, active.client);
      } else {
        interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
      }
      // restartWorkspaceProcess uses this entry point for runtime invalidation, not an actual
      // workspace/service teardown. Disposing the workspace emitter would leave existing UI/task-index
      // listeners permanently attached to a dead object; emitters are released only by disposeLocalState/disposeAll.
      await processManager.disposeWorkspace(params);
    },

    disposeAll(): void {
      processManager.disposeAll();
      pluginProcessManager.disposeAll();
      mcpStatusProcessManager.disposeAll();
      // AutomationRepo and TaskIndexRepo each hold a tasks-index.sqlite connection handle;
      // close both during dispose or the handle remains open on Windows (temporary-directory cleanup hits EBUSY).
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },

    async disposeAllAndWait(): Promise<void> {
      await Promise.all([
        processManager.disposeAllAndWait(),
        pluginProcessManager.disposeAllAndWait(),
        mcpStatusProcessManager.disposeAllAndWait(),
      ]);
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },
  };
}
