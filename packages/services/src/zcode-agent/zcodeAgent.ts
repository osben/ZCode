import type {
  BackgroundBashOutputResult,
  SessionDebugSnapshot,
  ZCodeSessionContentProfile,
} from "@zcode/shared";
/* eslint-disable max-lines -- The ZCode Agent service interface declares protocol/session/workspace methods together; splitting it would increase service descriptor migration costs. */
import type { Event, IDisposable } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type {
  AppUsageFilters,
  AppUsageInclude,
  AppUsageRange,
  AppUsageSnapshot,
  AppUsageWindow,
  ZCodeTaskTokenUsageResult,
} from "@zcode/shared";
import type { DynamicWorkflowMode } from "@zcode/shared";
import type { ZCodeAutomation, ZCodeAutomationRun } from "@zcode/shared";
import type {
  ZCodeStorageStartupState,
  ZCodeDeliveryKind,
  ZCodeAgentMcpServer,
  ZCodeBackgroundTurnAttribution,
  TraceId,
  ZCodeSessionCompactResult,
  ZCodeSessionGoalAction,
  ZCodeSessionGoalResult,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodeSessionImportHistory,
  ZCodePermissionRequestParams,
  AgentLaneResourceSample,
  ZCodeMcpTelemetryEvent,
  ZCodeMcpResourceSample,
  ZCodeToolExecResource,
  ZCodeProcessChildProcess,
  ZCodeMcpListResult,
  ZCodePluginsListResult,
  ZCodePluginsOverviewResult,
  ZCodePluginsMarketplaceMutationResult,
  ZCodePluginsInstallResult,
  ZCodePluginsReferenceCatalogResult,
  ZCodeSkillsReferenceCatalogResult,
  ZCodeMcpReadResourceResult,
  ZCodeMcpUiCallToolResult,
  ZCodeMcpUiCancelCallResult,
  ZCodeMcpUiReadResourceResult,
  ZCodeMcpUiListResourcesResult,
  ZCodeMcpUiAppToolAcceptedResult,
  ZCodeMcpUiRegisterAppToolsResult,
  ZCodeMcpUiUnregisterAppToolsResult,
  ZCodeMcpUiListResourceTemplatesResult,
  ZCodePluginsListUiSurfacesResult,
  ZCodeWorkflowsDeleteResult,
  ZCodeWorkflowsForRunResult,
  ZCodeWorkflowsGetResult,
  ZCodeWorkflowsListResult,
  ZCodeWorkflowsMoveResult,
  ZCodeWorkflowsRunsResult,
  ZCodeWorkflowsSaveResult,
  ZCodeWorkflowsUpdateMetaResult,
  ZCodePluginsUninstallResult,
  ZCodePluginsRestoreBuiltinResult,
  ZCodePluginsConfigureResult,
  ZCodePluginsDescribeResult,
  ZCodePluginsValidateResult,
  ZCodePluginsSetEnabledResult,
  ZCodeLspPreferences,
  ZCodeLspStatusResult,
  ZCodePluginsCancelOperationResult,
  ZCodePluginOperationProgressNotification,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeProviderRuntimeHeadersCancelled,
  ZCodeProviderTestModelConnectivityParams,
  ZCodeProviderTestModelConnectivityResult,
  ZCodeUserInputRequestParams,
  ZCodeUserInputResponse,
  ZCodeSessionEvent,
  ZCodeSessionInfo,
  ZCodeSessionMode,
  ZCodeSessionPersistence,
  ZCodeSessionSendResult,
  ZCodeSessionRequestRuntimePreferencesParams,
  ZCodeSessionRuntimePreferencesResult,
  ZCodeSessionStateSnapshot,
  ZCodeSessionSubagentsResult,
  ZCodeSessionTreeCountsResult,
  ZCodeSessionEraseTreeResult,
  ZCodeStateUpdatedNotification,
  ZCodeTaskClientMode,
  ZCodeBrowserAmbientContext,
  ZCodeWorkspacePresentation,
  ZCodeWorkspaceGenerateTextResult,
  ZCodeWorkspaceGenerateTextParams,
  ZCodeWorkspaceHookTrustGrantResult,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type {
  ClientHello,
  CommandAck,
  CommandEnvelope,
  CommandKey,
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationTelemetryFact,
  CuaPermissionObservation,
  ConversationRowTarget,
  HelloMessage,
  SessionsIndexTopicWireCandidate,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConnectionFlowState,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  V4ConversationRowsRangeResult,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "../descriptors.js";

export * from "./zcodeAgentPluginParams.js";
export * from "./zcodeAgentWorkflowParams.js";
import type {
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentAutomationIdParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentCreateAutomationParams,
  ZCodeAgentDeleteAutomationRunParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentListMcpServerStatusesParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentSkillReferenceCatalogParams,
  ZCodeAgentReadMcpResourceParams,
  ZCodeAgentReadMcpResourceForUiParams,
  ZCodeAgentListMcpResourcesForUiParams,
  ZCodeAgentAppToolCallForUiParams,
  ZCodeAgentAppToolInstanceForUiParams,
  ZCodeAgentRegisterAppToolsForUiParams,
  ZCodeAgentResolveAppToolCallForUiParams,
  ZCodeAgentMcpResourceSubscriptionForUiParams,
  ZCodeAgentCallMcpToolForUiParams,
  ZCodeAgentCancelMcpToolCallForUiParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentSetLspPreferencesParams,
  ZCodeAgentSetAutomationEnabledParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentUpdateAutomationParams,
  ZCodeAgentValidatePluginParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgentPluginParams.js";
import type {
  ZCodeAgentDeleteSavedWorkflowParams,
  ZCodeAgentFindSavedWorkflowForRunParams,
  ZCodeAgentGetSavedWorkflowParams,
  ZCodeAgentListSavedWorkflowRunsParams,
  ZCodeAgentListSavedWorkflowsParams,
  ZCodeAgentMoveSavedWorkflowParams,
  ZCodeAgentSaveSavedWorkflowFromRunParams,
  ZCodeAgentUpdateSavedWorkflowMetaParams,
} from "./zcodeAgentWorkflowParams.js";

export interface ZCodeAgentSessionTarget extends ZCodeAgentWorkspaceTarget {
  sessionId: string;
}

/** Session ids are global in the CLI store; the workspace only selects which agent process answers. */
export interface ZCodeAgentSessionTreeParams extends ZCodeAgentWorkspaceTarget {
  sessionIds: string[];
  /** existing-only never starts an agent; it fails when the workspace has no runtime yet. */
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export interface ZCodeAgentResumeSessionParams extends ZCodeAgentSessionTarget {
  model?: ModelSelection;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  // Cold recovery recreates the runtime, so tool-surface isolation must use the same security boundary as creation (for example, CUA allows only zcode-cua tools
  // and blocks Bash). Otherwise, after resume, the model may see more tools or permissions than it had at creation.
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface ZCodeAgentInitializeResult {
  available: boolean;
  workspaceKey: string;
  protocolName?: string;
  protocolVersion?: number;
  transportKind?: "stdio" | "websocket";
  reason?: string;
  reasonCode?: "provider_not_ready";
}

export interface ZCodeAgentRunAutomationNowResult {
  status: "queued" | "duplicate";
}

export interface ZCodeAgentWorkspaceRuntimeIdentity {
  generation: number;
  identity: string;
  processId?: number;
  workspaceKey: string;
}

export const ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE = "ZCODE_AGENT_RUNTIME_UNAVAILABLE";

export type ZCodeAgentRuntimePolicy = "start-if-needed" | "existing-only";

export interface ZCodeAgentRuntimeLifecycleEvent extends ZCodeAgentWorkspaceTarget {
  workspaceKey: string;
  runtimeIdentity: ZCodeAgentWorkspaceRuntimeIdentity;
  state: "available" | "unavailable";
}

export type ZCodeAgentCuaPermissionObservation = CuaPermissionObservation &
  ZCodeAgentWorkspaceTarget;

export interface ZCodeAgentCreateSessionParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
  sessionTraceId?: TraceId;
  parentSessionId?: string;
  mode?: ZCodeSessionMode;
  model?: ModelSelection;
  persistence?: ZCodeSessionPersistence;
  thoughtLevel?: string;
  /** Disable model-generated renaming for automation sessions and keep the first user query as the stable title. */
  titleGenerationEnabled?: boolean;
  mcpServers?: ZCodeAgentMcpServer[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  importedHistory?: ZCodeSessionImportHistory;
}

export interface ZCodeAgentListSessionsParams extends ZCodeAgentWorkspaceTarget {
  sessionIds?: string[];
  runtimePolicy?: ZCodeAgentRuntimePolicy;
  includeArchived?: boolean;
  limit?: number;
}

export interface ZCodeAgentListSessionSubagentsParams extends ZCodeAgentSessionTarget {
  endedCursor?: string;
  endedLimit?: number;
  /** Host connection identity for a remote workspace; used only to select an existing Host and not included in the CLI wire query. */
  remoteSessionId?: string;
}

export interface ZCodeAgentAppUsageParams {
  range: AppUsageRange;
  timeZone?: string;
  window?: AppUsageWindow;
  compare?: boolean;
  filters?: AppUsageFilters;
  include?: AppUsageInclude[];
}

export interface ZCodeAgentTaskTokenUsageParams extends ZCodeAgentSessionTarget {}

export interface ZCodeAgentReadSessionParams extends ZCodeAgentSessionTarget {
  deliveryKind?: ZCodeDeliveryKind;
  messageLimit?: number;
  afterSeq?: number;
  /** Passive indexers/observers may read only an existing runtime and must not start a session just to read a snapshot. */
  runtimePolicy?: ZCodeAgentRuntimePolicy;
  /** “index” is only for the task index: return a snapshot with the same structure but large payloads stripped; do not write back UI state. */
  contentProfile?: ZCodeSessionContentProfile;
}

export interface ZCodeAgentReadSessionMessagesParams extends ZCodeAgentSessionTarget {
  afterMessageId?: string;
  limit?: number;
}

export interface ZCodeAgentReadSessionEventsParams extends ZCodeAgentSessionTarget {
  afterSeq?: number;
  limit?: number;
}

export type ZCodeAgentReadWorkspacePresentationParams = ZCodeAgentWorkspaceTarget;

export interface ZCodeAgentGrantWorkspaceHookTrustParams extends ZCodeAgentWorkspaceTarget {
  bundleDigest: string;
  hookDeclarationDigest: string;
}

export interface ZCodeAgentSendPromptParamsBase extends ZCodeAgentSessionTarget {
  modelSelection?: ModelSelection;
  modelExecution?: import("@zcode/shared/zcode-protocol-v4").CommandPayloadMap["sendText"]["modelExecution"];
  inputId?: string;
  queryId?: string;
  messageId?: string;
  sessionTraceId?: TraceId;
  content: string;
  attachments?: Record<string, unknown>[];
  /** Current provider-only IAB state; UI/session persistence continues to use the original content. */
  browserAmbientContext?: ZCodeBrowserAmbientContext;
  clientMode?: ZCodeTaskClientMode;
  expectedRevision?: number;
  expectedProviderRevision?: string;
  runtimeProviderHeaders?: Record<string, string>;
  toolDenylist?: string[];
  /** Stable callback address for a Bot-originated turn; read by CronCreate only during the current turn. */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
}

export type ZCodeAgentSendPromptParams = ZCodeAgentSendPromptParamsBase &
  ZCodeBackgroundTurnAttribution;

export interface ZCodeAgentCompactParams extends ZCodeAgentSessionTarget {
  inputId?: string;
  instructions?: string;
  expectedRevision?: number;
}

export interface ZCodeAgentGoalParams extends ZCodeAgentSessionTarget {
  inputId?: string;
  action: ZCodeSessionGoalAction;
  objective?: string;
  expectedRevision?: number;
}

export interface ZCodeAgentSetModelParams extends ZCodeAgentSessionTarget {
  model: ModelSelection;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeAgentSetThoughtLevelParams extends ZCodeAgentSessionTarget {
  thoughtLevel?: string;
  expectedRevision?: number;
  persistAsWorkspaceLastUsed?: boolean;
}

export interface ZCodeAgentSetModeParams extends ZCodeAgentSessionTarget {
  mode: ZCodeSessionMode;
  expectedRevision?: number;
}

export interface ZCodeAgentGenerateWorkspaceTextParams extends ZCodeAgentWorkspaceTarget {
  selection: ZCodeWorkspaceGenerateTextParams["selection"];
  prompt?: string;
  messages?: ZCodeWorkspaceGenerateTextParams["messages"];
  tools?: ZCodeWorkspaceGenerateTextParams["tools"];
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /**
   * Protocol-layer RPC timeout. Long requests from thinking models may exceed the protocol client's default
   * three minutes. Callers must pass their own deadline through here; otherwise the default timeout fires first
   * and onRequestTimeout may mistake the request for stale and kill the process.
   */
  requestTimeoutMs?: number;
}

export interface ZCodeAgentTestModelConnectivityParams extends ZCodeAgentWorkspaceTarget {
  selection: ZCodeProviderTestModelConnectivityParams["selection"];
  signal?: AbortSignal;
}

// The merge previously mixed in the Agent’s full authentication response; the UI can only return request validation, while account authentication must be composed by the Host.
export type ProviderRuntimeHeadersUiResponse =
  | { headersApplied: true; runtimeProviderHeaders: Record<string, string>; errorMessage?: string }
  | { headersApplied: false; errorMessage?: string };

export interface ZCodeAgentRespondProviderRuntimeHeadersParams extends ZCodeAgentSessionTarget {
  requestId: string;
  response: ProviderRuntimeHeadersUiResponse;
}

export interface ZCodeAgentSessionRuntimePreferencesRequest extends ZCodeSessionRequestRuntimePreferencesParams {
  requestId: string;
}

export interface ZCodeAgentRespondSessionRuntimePreferencesParams {
  requestId: string;
  resolution:
    | { status: "resolved"; preferences: ZCodeSessionRuntimePreferencesResult }
    | { status: "failed"; message: string };
}

export interface ZCodeAgentSessionSubscribeParams extends ZCodeAgentSessionTarget {
  deliveryKind: ZCodeDeliveryKind;
  afterSeq?: number;
  includeSnapshot?: boolean;
  eventCoalescing?: {
    mode: "background-summary";
    intervalMs?: number;
  };
}

// ── V4 conversation channel (vertical slice) ──
// The host only forwards: pass subscribe/unsubscribe/command through to the CLI V4 gateway,
// and fan out v4/conversation/frame notifications by workspace to the renderer.

export interface ZCodeAgentConversationSubscribeParams extends ZCodeAgentSessionTarget {
  /** Watermark invariant: include it only when the client actually holds a consistent state at that point in time. */
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface ZCodeAgentConversationUnsubscribeParams extends ZCodeAgentWorkspaceTarget {
  subscriptionId: string;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export interface ZCodeAgentConversationResyncParams extends ZCodeAgentWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

/** Row pagination query (rows/range): fetch a window of historical rows backward from the cursor. */
export interface ZCodeAgentConversationRowsRangeParams extends ZCodeAgentSessionTarget {
  /** Fetch rows with rowId < beforeRowId; by default, start at the current end and move backward. */
  beforeRowId?: number;
  /** 1..rowsRangeMaxLimit（200）。 */
  limit: number;
}

/** Terminal ExitPlanMode catalog for the currently active branch. */
export type ZCodeAgentConversationPlansParams = ZCodeAgentSessionTarget;

/** Paginated workflow run event log for the detail-page audit surface; cursor = journal sequence. */
export interface ZCodeAgentConversationWorkflowRunEventsParams extends ZCodeAgentSessionTarget {
  runId: string;
  afterSequence?: number;
  limit?: number;
}

/** Enumerate dwf runs (discovery query after restart). */
export interface ZCodeAgentConversationWorkflowRunsParams extends ZCodeAgentSessionTarget {
  limit?: number;
}

// ── DWF user-facing artifacts ──
// ⚠ Terminology: artifact means output published by a script through `artifact.*` for **users** (files/Markdown/prebuilt dashboards),
// not the run's top-level return value (the engine uses the same word internally for that).

/** Artifact catalog; durable read path for UI cold recovery and central details. */
export interface ZCodeAgentConversationWorkflowRunArtifactsParams extends ZCodeAgentSessionTarget {
  runId: string;
}

/** Data-read surface for prebuilt dashboards; cursor = journal sequence (strictly greater than). */
export interface ZCodeAgentConversationWorkflowRunArtifactDataParams extends ZCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  afterSequence?: number;
  limit?: number;
}

/** Bytes for a content artifact, one chunk at a time (≤ 512 KiB, with the same shape as attachmentRead). */
export interface ZCodeAgentConversationWorkflowRunArtifactReadParams extends ZCodeAgentSessionTarget {
  runId: string;
  artifactId: string;
  version: number;
  offset: number;
  limit: number;
}

// ── DWF workspace transcript ──
/** Lightweight row catalog for one run's files.* / git.* / world.run entries, without body content. */
export interface ZCodeAgentConversationWorkflowRunWorkspaceParams extends ZCodeAgentSessionTarget {
  runId: string;
}

/** Body for one workspace node, bounded by maxBytes without changing its shape (default and limit are set by the CLI gateway). */
export interface ZCodeAgentConversationWorkflowRunNodeResultParams extends ZCodeAgentSessionTarget {
  runId: string;
  siteId: string;
  ordinal: number;
  maxBytes?: number;
}

export interface ZCodeAgentBackgroundBashOutputParams extends ZCodeAgentSessionTarget {
  workId: string;
}

export interface ZCodeAgentConversationFileChangesParams extends ZCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZCodeAgentConversationFileRewindPreviewParams extends ZCodeAgentSessionTarget {
  target: ConversationRowTarget;
  baseRevision: number;
  baseLogEpoch: string;
}

export interface ZCodeAgentConversationCommandParams extends ZCodeAgentWorkspaceTarget {
  envelope: CommandEnvelope;
  /** Host-internal only, for the Browser Use runtime boundary; not included in the V4 wire envelope. */
  clientMode?: ZCodeTaskClientMode;
}

export interface ZCodeAgentCommandsQueryParams extends ZCodeAgentWorkspaceTarget {
  clock?: true;
  commands: CommandKey[];
}

/** UI does not carry connectionId; connection scope injects wire identity through a trusted carrier. */
export interface ZCodeAgentAttachmentBeginParams extends ZCodeAgentSessionTarget {
  uploadId: string;
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

export interface ZCodeAgentAttachmentChunkParams extends ZCodeAgentSessionTarget {
  uploadId: string;
  chunkIndex: number;
  dataBase64: string;
}

export interface ZCodeAgentAttachmentTerminalParams extends ZCodeAgentSessionTarget {
  uploadId: string;
}

export interface ZCodeAgentAttachmentReadParams extends ZCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
  offset: number;
  limit: number;
}

export interface ZCodeAgentConversationAttachmentReadParams extends ZCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
  offset: number;
  limit: number;
}

export interface ZCodeAgentConversationAttachmentStatParams extends ZCodeAgentSessionTarget {
  ref: string;
  target: ConversationRowTarget;
  attachmentIndex: number;
}

export interface ZCodeAgentAttachmentPreviewSourceParams extends ZCodeAgentSessionTarget {
  ref: string;
  target?: ConversationRowTarget;
  attachmentIndex?: number;
}

/** Host-scoped internal transport control surface; connectionId can be injected only through a trusted carrier. */
export interface ZCodeAgentConnectionFlowParams extends ZCodeAgentWorkspaceTarget {
  state: V4ConnectionFlowState;
}

/** sessions-index: workspace-level list subscription (not scoped by sessionId). */
export interface ZCodeAgentSessionsIndexSubscribeParams extends ZCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  /**
   * Subscriber scope suffix: the CLI replaces subscriptions by (connectionId, topic).
   * When independent consumers in the host process (renderer sidebar / task-index syncer)
   * subscribe to the same topic, they must use different connectionIds to avoid replacing
   * each other's subscription generations. Defaults to the shared host connection ID.
   */
  subscriberScope?: string;
  /**
   * Passive observers such as task-list must use existing-only. If no runtime exists,
   * return a stable unavailable result; do not start an Agent just to establish a list
   * subscription. By default, retain the previous behavior for explicit session entry points.
   */
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

/** workspace-config: workspace-level subscriptions for config options and slash directories. */
export interface ZCodeAgentWorkspaceConfigSubscribeParams extends ZCodeAgentWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
  runtimePolicy?: ZCodeAgentRuntimePolicy;
}

export type ZCodeAgentServiceEvent =
  | { type: "session.event"; event: ZCodeSessionEvent }
  | { type: "state.updated"; notification: ZCodeStateUpdatedNotification }
  | { type: "permission.request"; request: ZCodePermissionRequestParams }
  | { type: "userInput.request"; request: ZCodeUserInputRequestParams }
  | {
      type: "userInput.response";
      requestId: string;
      response: ZCodeUserInputResponse;
    }
  | { type: "providerRuntimeHeaders.request"; request: ZCodeProviderRuntimeHeadersRequestParams }
  | { type: "snapshot"; snapshot: ZCodeSessionStateSnapshot };

export interface ZCodeAgentAppRuntimePreferences {
  askUserQuestionAutoResolutionEnabled: boolean;
  modelIoFullRetentionEnabled?: boolean;
}

export interface ZCodeAgentLocalRuntimeChildProcesses {
  pid: number;
  provider: string;
  workspacePath: string;
  lane?: string;
  children: ZCodeProcessChildProcess[];
}

export interface ZCodeAgentStorageStartupSnapshot {
  generation: number;
  state: ZCodeStorageStartupState | null;
}

export interface IZCodeAgentService {
  /** The control plane needs no account or model and sends no regular protocol requests. */
  prepareStorage(params: ZCodeAgentWorkspaceTarget): Promise<void>;
  getStorageStartupState(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodeAgentStorageStartupSnapshot | null>;
  onDynamicStorageStartupState(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeAgentStorageStartupSnapshot>;
  initialize(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAgentInitializeResult>;
  /**
   * Sync App-wide runtime preferences to every active workspace; do not start idle Agents
   * for this purpose.
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  /**
   * Signal that the user’s dynamic-workflow choice changed (docs/dynamic-workflow/launch.md “The user’s choice”): the Host recomputes the
   * effective mode and serially resends workspace/updateDynamicWorkflowPolicy. A Host with local settings authority uses its settings file;
   * a desktop-attached remote Host uses the incoming value (omitted = follow the server). Do not start an idle Agent for this.
   */
  syncDynamicWorkflowUserMode(params: { mode?: DynamicWorkflowMode }): Promise<void>;
  getWorkspaceRuntimeIdentity(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodeAgentWorkspaceRuntimeIdentity>;
  createSession(params: ZCodeAgentCreateSessionParams): Promise<ZCodeSessionStateSnapshot>;
  resumeSession(params: ZCodeAgentResumeSessionParams): Promise<ZCodeSessionStateSnapshot>;
  listSessions(params: ZCodeAgentListSessionsParams): Promise<ZCodeSessionInfo[]>;
  listSessionSubagents(
    params: ZCodeAgentListSessionSubagentsParams,
  ): Promise<ZCodeSessionSubagentsResult>;
  getAppUsageStats(params: ZCodeAgentAppUsageParams): Promise<AppUsageSnapshot>;
  getTaskTokenUsage(params: ZCodeAgentTaskTokenUsageParams): Promise<ZCodeTaskTokenUsageResult>;
  readSession(params: ZCodeAgentReadSessionParams): Promise<ZCodeSessionStateSnapshot>;
  readSessionMessages(
    params: ZCodeAgentReadSessionMessagesParams,
  ): Promise<ZCodeMessageWithParts[]>;
  readSessionDebug(params: ZCodeAgentSessionTarget): Promise<SessionDebugSnapshot>;
  readSessionEvents(params: ZCodeAgentReadSessionEventsParams): Promise<ZCodeSessionEvent[]>;
  readWorkspacePresentation(
    params: ZCodeAgentReadWorkspacePresentationParams,
  ): Promise<ZCodeWorkspacePresentation>;
  /** Pre-trust from Settings without a task/session; the Agent rediscovers and validates the canonical snapshot. */
  grantWorkspaceHookTrust(
    params: ZCodeAgentGrantWorkspaceHookTrustParams,
  ): Promise<ZCodeWorkspaceHookTrustGrantResult>;
  listMcpServerStatuses(params: ZCodeAgentListMcpServerStatusesParams): Promise<ZCodeMcpListResult>;
  listPlugins(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsListResult>;
  /**
   * Plugin conversation-reference catalog: a session-scoped, read-only projection.
   * Use the workspace-level agent client (session records exist only in that process),
   * not the standalone plugin management process.
   */
  getPluginReferenceCatalog(
    params: ZCodeAgentPluginReferenceCatalogParams,
  ): Promise<ZCodePluginsReferenceCatalogResult>;
  /** Composer Skill reference catalog; when sessionId is provided, read that runtime's frozen snapshot. */
  getSkillReferenceCatalog(
    params: ZCodeAgentSkillReferenceCatalogParams,
  ): Promise<ZCodeSkillsReferenceCatalogResult>;
  /** Plugin UI: read plugin MCP `ui://` resources through the workspace agent process for the session. */
  openMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPrepareSandboxParams & {
      accountContext?: string;
    },
  ): Promise<import("@zcode/shared/mcp-apps").McpAppInstance>;
  validateMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  recycleMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<boolean>;
  closeMcpUiInstance(
    params: import("../plugin-ui-bridge/contract.js").PluginUiPluginScope,
  ): Promise<void>;
  readMcpResource(params: ZCodeAgentReadMcpResourceParams): Promise<ZCodeMcpReadResourceResult>;
  /** Plugin UI: tool calls initiated by the UI; reuse existing permission approval and do not create a transcript row. */
  sampleMcpApp(
    params: import("../plugin-ui-bridge/samplingContract.js").PluginUiSamplingParams,
  ): Promise<import("@zcode/shared/mcp-apps").McpAppsSamplingResult>;
  cancelMcpAppSampling(
    params: import("../plugin-ui-bridge/samplingContract.js").PluginUiCancelSamplingParams,
  ): Promise<{ cancelled: boolean }>;
  callMcpToolForUi(params: ZCodeAgentCallMcpToolForUiParams): Promise<ZCodeMcpUiCallToolResult>;
  /** Plugin UI cancels an in-progress UI tool call by callId; abort it on the agent side through the MCP client. */
  cancelMcpToolCallForUi(
    params: ZCodeAgentCancelMcpToolCallForUiParams,
  ): Promise<ZCodeMcpUiCancelCallResult>;
  /** `resources/read` initiated by a plugin UI page; the agent restricts it to the same plugin server, 8 MiB, and the mimeType allowlist. */
  readMcpResourceForUi(
    params: ZCodeAgentReadMcpResourceForUiParams,
  ): Promise<ZCodeMcpUiReadResourceResult>;
  /** Proxy resources/list, resources/templates/list, subscribe, and unsubscribe requests initiated by a plugin UI page. */
  listMcpResourcesForUi(
    params: ZCodeAgentListMcpResourcesForUiParams,
  ): Promise<ZCodeMcpUiListResourcesResult>;
  listMcpResourceTemplatesForUi(
    params: ZCodeAgentListMcpResourcesForUiParams,
  ): Promise<ZCodeMcpUiListResourceTemplatesResult>;
  subscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  unsubscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams): Promise<void>;
  /** App-Provided Tools: register/unregister page tools and claim/return model calls (mailbox delivery uses V4 live deltas). */
  registerAppToolsForUi(
    params: ZCodeAgentRegisterAppToolsForUiParams,
  ): Promise<ZCodeMcpUiRegisterAppToolsResult>;
  unregisterAppToolsForUi(
    params: ZCodeAgentAppToolInstanceForUiParams,
  ): Promise<ZCodeMcpUiUnregisterAppToolsResult>;
  claimAppToolCallForUi(
    params: ZCodeAgentAppToolCallForUiParams,
  ): Promise<ZCodeMcpUiAppToolAcceptedResult>;
  resolveAppToolCallForUi(
    params: ZCodeAgentResolveAppToolCallForUiParams,
  ): Promise<ZCodeMcpUiAppToolAcceptedResult>;
  /** Plugin UI workspace-level panel entry point (the enabled plugin list `ui.surfaces[]`). */
  listPluginUiSurfaces(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ZCodePluginsListUiSurfacesResult>;
  // GUI entry point for saved workflows: workspace-level, sessionless, and rescans
  // `<cwd>/.zcode/workflows/` on every call.
  // For global scope, pass `scope: "global"`; use the supplied workspace as the carrier,
  // or let the services layer choose a local carrier runtime when none is supplied.
  listSavedWorkflows(params: ZCodeAgentListSavedWorkflowsParams): Promise<ZCodeWorkflowsListResult>;
  getSavedWorkflow(params: ZCodeAgentGetSavedWorkflowParams): Promise<ZCodeWorkflowsGetResult>;
  updateSavedWorkflowMeta(
    params: ZCodeAgentUpdateSavedWorkflowMetaParams,
  ): Promise<ZCodeWorkflowsUpdateMetaResult>;
  deleteSavedWorkflow(
    params: ZCodeAgentDeleteSavedWorkflowParams,
  ): Promise<ZCodeWorkflowsDeleteResult>;
  listSavedWorkflowRuns(
    params: ZCodeAgentListSavedWorkflowRunsParams,
  ): Promise<ZCodeWorkflowsRunsResult>;
  // Move a same-named file between project and global scopes:
  // `workspace` is the carrier (target project when moving to project scope, source project
  // when moving to global scope); `to` is the destination scope. Existing targets are not overwritten.
  moveSavedWorkflow(params: ZCodeAgentMoveSavedWorkflowParams): Promise<ZCodeWorkflowsMoveResult>;
  // “Save directly” on the completion card (docs/dynamic-workflow/transcript-and-notifications.md): use runId to read
  // the scripts actually run in this run from the journal and save them without a model turn. Both require a workspace (where the journal is stored).
  saveSavedWorkflowFromRun(
    params: ZCodeAgentSaveSavedWorkflowFromRunParams,
  ): Promise<ZCodeWorkflowsSaveResult>;
  /** Which saved workflow corresponds to this run (derived, not remembered); also return the run arguments to prefill “Run again.” */
  findSavedWorkflowForRun(
    params: ZCodeAgentFindSavedWorkflowForRunParams,
  ): Promise<ZCodeWorkflowsForRunResult>;
  resolveSuggestedPluginReference(
    params: ZCodeAgentResolveSuggestedPluginReferenceParams,
  ): Promise<import("@zcode/shared").ZCodePluginsResolveSuggestedReferenceResult>;
  /** Operation-scoped refresh progress after the first local check finds a recommended Plugin missing. */
  onDynamicPluginOperationProgress(
    operationId: string,
  ): Event<ZCodePluginOperationProgressNotification>;
  getPluginsOverview(params: ZCodeAgentPluginViewParams): Promise<ZCodePluginsOverviewResult>;
  /**
   * Resource manager: enumerate all local Agent processes on this Host (including plugin
   * and mcp-status lanes), then request `process/childProcesses` from each live runtime.
   * A failure in one runtime leaves only that runtime's children empty.
   */
  collectLocalRuntimeChildProcesses(
    signal?: AbortSignal,
  ): Promise<ZCodeAgentLocalRuntimeChildProcesses[]>;
  addPluginMarketplace(
    params: ZCodeAgentAddPluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  removePluginMarketplace(
    params: ZCodeAgentRemovePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  updatePluginMarketplace(
    params: ZCodeAgentUpdatePluginMarketplaceParams,
  ): Promise<ZCodePluginsMarketplaceMutationResult>;
  installPlugin(params: ZCodeAgentInstallPluginParams): Promise<ZCodePluginsInstallResult>;
  cancelPluginOperation(
    params: ZCodeAgentCancelPluginOperationParams,
  ): Promise<ZCodePluginsCancelOperationResult>;
  uninstallPlugin(params: ZCodeAgentUninstallPluginParams): Promise<ZCodePluginsUninstallResult>;
  updatePlugin(params: ZCodeAgentUpdatePluginParams): Promise<ZCodePluginsInstallResult>;
  restoreBuiltinPlugin(
    params: ZCodeAgentRestoreBuiltinPluginParams,
  ): Promise<ZCodePluginsRestoreBuiltinResult>;
  configurePlugin(params: ZCodeAgentConfigurePluginParams): Promise<ZCodePluginsConfigureResult>;
  resetPluginConfig(
    params: ZCodeAgentResetPluginConfigParams,
  ): Promise<ZCodePluginsConfigureResult>;
  validatePlugin(params: ZCodeAgentValidatePluginParams): Promise<ZCodePluginsValidateResult>;
  describePlugin(params: ZCodeAgentDescribePluginParams): Promise<ZCodePluginsDescribeResult>;
  setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams): Promise<ZCodePluginsSetEnabledResult>;
  /** LSP preferences live in the CLI sidecar; the workspace target only selects the process that owns them. */
  getLspPreferences(params: ZCodeAgentPluginViewParams): Promise<ZCodeLspPreferences>;
  setLspPreferences(params: ZCodeAgentSetLspPreferencesParams): Promise<ZCodeLspPreferences>;
  getLspStatus(params: ZCodeAgentPluginViewParams): Promise<ZCodeLspStatusResult>;
  // ---- Scheduled task (automation) management ----
  listAutomations(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAutomation[]>;
  listAllAutomations(): Promise<ZCodeAutomation[]>;
  createAutomation(params: ZCodeAgentCreateAutomationParams): Promise<ZCodeAutomation>;
  updateAutomation(params: ZCodeAgentUpdateAutomationParams): Promise<ZCodeAutomation | null>;
  deleteAutomation(params: ZCodeAgentAutomationIdParams): Promise<void>;
  setAutomationEnabled(params: ZCodeAgentSetAutomationEnabledParams): Promise<void>;
  restartAutomation(params: ZCodeAgentAutomationIdParams): Promise<void>;
  runAutomationNow(params: ZCodeAgentAutomationIdParams): Promise<ZCodeAgentRunAutomationNowResult>;
  listAutomationRuns(params: ZCodeAgentAutomationIdParams): Promise<ZCodeAutomationRun[]>;
  deleteAutomationRun(params: ZCodeAgentDeleteAutomationRunParams): Promise<void>;
  generateWorkspaceText(
    params: ZCodeAgentGenerateWorkspaceTextParams,
  ): Promise<ZCodeWorkspaceGenerateTextResult>;
  testModelConnectivity(
    params: ZCodeAgentTestModelConnectivityParams,
  ): Promise<ZCodeProviderTestModelConnectivityResult>;
  /**
   * @deprecated The main send path now uses the v4 sendText command. Only two consumers
   * remain: the adapter's attachment-input fallback (remove after attachment commands land)
   * and the zcodeSessionService pass-through. Do not use this in new code.
   */
  sendPrompt(params: ZCodeAgentSendPromptParams): Promise<ZCodeSessionSendResult>;
  compactSession(params: ZCodeAgentCompactParams): Promise<ZCodeSessionCompactResult>;
  goalSession(params: ZCodeAgentGoalParams): Promise<ZCodeSessionGoalResult>;
  closeSession(
    params: ZCodeAgentSessionTarget & { expectedPersistence?: "deferred" | "immediate" },
  ): Promise<boolean>;
  /** Read-only totals for a permanent erase; resolves null when the connected CLI predates the method. */
  countSessionTrees?(
    params: ZCodeAgentSessionTreeParams,
  ): Promise<ZCodeSessionTreeCountsResult | null>;
  /** Permanently erase session trees; resolves null when the connected CLI predates the method. */
  eraseSessionTrees?(
    params: ZCodeAgentSessionTreeParams,
  ): Promise<ZCodeSessionEraseTreeResult | null>;
  setModel(params: ZCodeAgentSetModelParams): Promise<ZCodeSessionStateSnapshot>;
  setThoughtLevel(params: ZCodeAgentSetThoughtLevelParams): Promise<ZCodeSessionStateSnapshot>;
  setMode(params: ZCodeAgentSetModeParams): Promise<ZCodeSessionStateSnapshot>;
  respondProviderRuntimeHeaders(
    params: ZCodeAgentRespondProviderRuntimeHeadersParams,
  ): Promise<void>;
  respondSessionRuntimePreferences(
    params: ZCodeAgentRespondSessionRuntimePreferencesParams,
  ): Promise<void>;
  /**
   * The V4 UI Start Plan runtime-auth bridge needs only local pending-request events,
   * and must not open the legacy `session/subscribe` for this, or it will reintroduce the old replay/continuous read path
   * into the V4 pane.
   */
  onDynamicProviderRuntimeHeadersRequest(
    params: ZCodeAgentSessionTarget,
  ): Event<ZCodeProviderRuntimeHeadersRequestParams>;
  /**
   * Workspace-level subscription entry point for Start Plan runtime headers (used by the production responder).
   * Bug cause (2026-08-16 Web remote-control hang): the session-level entry point subscribes only when a Desktop pane mounts,
   * but sessions created by Web remote control have no Desktop pane and no Web responder, leaving request validation pending,
   * and the task stuck “working” forever. The Desktop window uses this entry point to keep a persistent responder for each open workspace tab;
   * register a live listener first, then deliver pending requests by workspaceKey prefix, matching session-level semantics.
   */
  onDynamicWorkspaceProviderRuntimeHeadersRequest(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeProviderRuntimeHeadersRequestParams>;
  /** Deliver validation cancellations for this workspace only; these are not part of the conversation stream. */
  onDynamicWorkspaceProviderRuntimeHeadersCancelled(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ZCodeProviderRuntimeHeadersCancelled>;
  onDynamicSessionRuntimePreferencesRequest(): Event<ZCodeAgentSessionRuntimePreferencesRequest>;
  /**
   * CLI process-level resource samples, tagged with the lane by services (the CLI does not
   * know the lane). Use a dynamic event to prevent the RPC service from buffering periodic
   * events when nobody is subscribed. This event is not session/conversation continuous or
   * replayable state.
   */
  onDynamicProcessResourceSample(): Event<AgentLaneResourceSample>;
  /** MCP process lifecycle and low-frequency memory events, for reporting to ARMS by a trusted Host relay only. */
  onDynamicMcpTelemetry(): Event<ZCodeMcpTelemetryEvent>;
  /** MCP process-tree resource facts, for aggregation and reporting by a trusted Host only. */
  onDynamicMcpResourceSamples(): Event<ZCodeMcpResourceSample[]>;
  /** Bash completion facts, for resource side-channel subscriptions by a trusted Host only. */
  onDynamicToolExecResource(): Event<ZCodeToolExecResource>;
  /**
   * @deprecated Legacy protocol subscription surface (session/subscribe + session/event + state.updated).
   * The task-index syncer has moved to v4 sessions-index/workspace-config frames.
   * Only zcodeTaskServiceAdapter.onDynamicTaskEvent (the replayable read path) still consumes this.
   * Writes now use v4 commands; this subscription is the projection source for reads.
   */
  onDynamicSessionEvent(params: ZCodeAgentSessionSubscribeParams): Event<ZCodeAgentServiceEvent>;
  // ── v4 conversation channel (vertical slice) ──
  /** Read the trusted host hello after establishing the RPC attachment. */
  helloConversationV4(): Promise<HelloMessage>;
  /** Send clientHello after validating hello; metadata cannot override the connection mode/profile. */
  initializeConversationV4(clientHello: ClientHello): Promise<void>;
  /** For trusted host relays/facades only; the connection scope must reject terminal RPC callers. */
  setConnectionFlowStateV4(params: ZCodeAgentConnectionFlowParams): Promise<void>;
  subscribeConversationV4(
    params: ZCodeAgentConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** Paginated rows/range query (the loadOlder cursor fetches earlier history). */
  conversationRowsRangeV4(
    params: ZCodeAgentConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  conversationPlansV4(
    params: ZCodeAgentConversationPlansParams,
  ): Promise<V4ConversationPlansResult>;
  /** Paginated workflow-run event log; like plans, it is read-only, stateless, and safe to retry after a timeout. */
  conversationWorkflowRunEventsV4(
    params: ZCodeAgentConversationWorkflowRunEventsParams,
  ): Promise<V4ConversationWorkflowRunEventsResult>;
  /** Enumerate workflow runs; the journal-backed discovery surface after a restart. */
  conversationWorkflowRunsV4(
    params: ZCodeAgentConversationWorkflowRunsParams,
  ): Promise<V4ConversationWorkflowRunsResult>;
  /** List user-facing workflow-run artifacts; like plans, this is read-only, stateless, and safe to retry after a timeout. */
  conversationWorkflowRunArtifactsV4(
    params: ZCodeAgentConversationWorkflowRunArtifactsParams,
  ): Promise<V4ConversationWorkflowRunArtifactsResult>;
  /** Paginated entries for the preset board; the hook incrementally fetches when itemCount changes. */
  conversationWorkflowRunArtifactDataV4(
    params: ZCodeAgentConversationWorkflowRunArtifactDataParams,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  /** Read content-artifact bytes one chunk at a time; authorization is enforced by the CLI, using the journal row as evidence. */
  conversationWorkflowRunArtifactReadV4(
    params: ZCodeAgentConversationWorkflowRunArtifactReadParams,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  /** List the transcript for a DWF workspace. */
  conversationWorkflowRunWorkspaceV4(
    params: ZCodeAgentConversationWorkflowRunWorkspaceParams,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  /** Bounded content for one workspace node. */
  conversationWorkflowRunNodeResultV4(
    params: ZCodeAgentConversationWorkflowRunNodeResultParams,
  ): Promise<V4ConversationWorkflowRunNodeResultResult>;
  backgroundBashOutputV4(
    params: ZCodeAgentBackgroundBashOutputParams,
  ): Promise<BackgroundBashOutputResult>;
  conversationFileChangesV4(
    params: ZCodeAgentConversationFileChangesParams,
  ): Promise<V4ConversationFileChangesResult>;
  conversationFileRewindPreviewV4(
    params: ZCodeAgentConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  sendConversationCommandV4(params: ZCodeAgentConversationCommandParams): Promise<CommandAck>;
  queryConversationCommandsV4(params: ZCodeAgentCommandsQueryParams): Promise<CommandsQueryResult>;
  attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams): Promise<V4AttachmentBeginResult>;
  attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams): Promise<V4AttachmentChunkResult>;
  attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams): Promise<V4AttachmentCommitResult>;
  attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams): Promise<void>;
  /** Source query for sent videos on local Desktop; remote and Web return chunked data. */
  attachmentPreviewSourceV4(
    params: ZCodeAgentAttachmentPreviewSourceParams,
  ): Promise<V4AttachmentPreviewSourceResult>;
  /** Read-only chunk query for sent images/videos; the connection scope injects a trusted workspace connection. */
  attachmentReadV4(params: ZCodeAgentAttachmentReadParams): Promise<V4AttachmentReadResult>;
  /** Read userInput attachments for Share, including non-media types such as text/plain. */
  conversationAttachmentReadV4(
    params: ZCodeAgentConversationAttachmentReadParams,
  ): Promise<V4ConversationAttachmentReadResult>;
  /** Read only userInput attachment metadata during Share selection; do not read full contents. */
  conversationAttachmentStatV4(
    params: ZCodeAgentConversationAttachmentStatParams,
  ): Promise<V4ConversationAttachmentStatResult>;
  /** Workspace-level downlink frame stream (v4/conversation/frame); the renderer routes by topic. */
  onDynamicConversationFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ConversationTopicWireCandidate>;
  /** Workspace-level live telemetry facts; the connection facade exposes them only to trusted desktop-continuous consumers. */
  onDynamicLocalTtftFacts(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<import("@zcode/shared").LocalTtftFacts>;
  onDynamicConversationTelemetryFact(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<ConversationTelemetryFact>;
  /** CUA permission observations for all local live tasks in the current window; history, remote tasks, and replayable events are excluded. */
  onDynamicCuaPermissionObservation(): Event<ZCodeAgentCuaPermissionObservation>;
  // ── sessions-index channel (list activity) ──
  subscribeSessionsIndexV4(
    params: ZCodeAgentSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** Workspace-level sessions-index downlink frame stream (shares the conversation notification and routes by topic prefix). */
  onDynamicSessionsIndexFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<SessionsIndexTopicWireCandidate>;
  // ── workspace-config channel (config-directory activity; consumed by task-index syncer) ──
  subscribeWorkspaceConfigV4(
    params: ZCodeAgentWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(
    params: ZCodeAgentConversationResyncParams,
  ): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(params: ZCodeAgentConversationUnsubscribeParams): Promise<void>;
  /** Workspace-level workspace-config downlink frame stream (shares the conversation notification and routes by topic prefix). */
  onDynamicWorkspaceConfigFrame(
    params: ZCodeAgentWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  /**
   * (CLI reconnect/resubscribe): notification that the Agent process has been replaced
   * (after timeout cleanup or a crash and restart). v4 subscriptions live in CLI process
   * memory and expire when the process is replaced. Subscribers such as the task-index
   * syncer must subscribe again for that workspaceKey or the frame stream will stop silently.
   */
  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable;
  /**
   * Publish available after the Agent client is registered in the service, and unavailable
   * when the current client closes. This is the only lifecycle signal for passive observer
   * attach/detach; it does not represent a user usage lease.
   */
  onAgentRuntimeLifecycle?: (
    listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void,
  ) => IDisposable;
  /** Whether a desktop-local CUA turn is still running, so Helper recovery does not reclaim the Agent mid-turn. */
  hasActiveCuaOperationTurn(): boolean;
  disposeWorkspace(params: ZCodeAgentWorkspaceTarget): Promise<void>;
  disposeAll(): void;
}

export const IZCodeAgentService = createServiceDescriptor<IZCodeAgentService>(
  ServiceChannels.ZCodeAgent,
);
