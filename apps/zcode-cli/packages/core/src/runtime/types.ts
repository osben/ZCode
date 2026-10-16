import type { RequestVerificationReason, SystemPromptOverrides } from "@zcode/shared";
import type { GetAgentDefinitions, LoadAgentDefinitions } from "../subagent/definitions.js";
import type { RuntimeInputPresentation, TurnExecutionModelFallbackReason } from "@zcode/contracts";
/* eslint-disable max-lines -- Runtime types centrally define the public core/runtime structures; splitting them requires a separate migration. */
import { PermissionService, ToolScheduler } from "./deps.js";
import type {
  JsonSchema,
  AgentExecutionTelemetryPort,
  AgentTelemetryCausation,
  BackgroundResultOriginMeta,
  ContextUsageBreakdownItem,
  CoordinatorResponsePort,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  ModelRequestAuth,
  ModelRequestDependencies,
  ModelSelection,
  PluginReferenceCatalog,
  ResolvedUserInstructions,
  StableForkGoalBoundaryMetadata,
  StableForkTargetMetadata,
  WorkspaceHookBundleSnapshot,
  WorkspaceId,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import type {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CollaborationMode,
  EmbeddedSearchBackend,
  Logger,
  AttachmentStorageMetadata,
  MessageId,
  MessageVisibility,
  FilePartSource,
  ModelRequestAdmission,
  Model,
  ModelNetworkStatusEvent,
  ModelMessageContentBlock,
  ModelReasoningContentBlock,
  ModelStreamRecoveryStatus,
  ModelToolCall,
  ModelToolContract,
  ModelUsage,
  ModelUsageSummary,
  ModelInputMessage,
  MessageWithParts,
  PendingTurnInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  PartId,
  PermissionBrokerPort,
  PermissionUpdate,
  QueryId,
  RewindScope,
  RewindStrategy,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionTaskType,
  SessionMailboxPort,
  SessionProjection,
  SessionStorePort,
  ContextSourcePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  ModelCatalogPort,
  ExecutionPort,
  BrowserControlPort,
  ExecutionShellSelection,
  AutomationPort,
  OffPeakPort,
  TopicResourcePort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  HooksRuntimeConfig,
  SkillPort,
  McpPort,
  McpServerConfig,
  SubagentPort,
  ToolArtifactStorePort,
  ToolCallId,
  WorkflowPort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
  TraceContext,
  TraceId,
  TurnId,
  CheckpointCreatedPayload,
  RewindTargetEvaluation,
  SessionHistoryHydrationResult,
  SyntheticUserMessageSource,
  HookRunner,
  ToolExecutionResult,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  EnvInfo,
  ProjectContext,
  UserInstructionsOptions,
  AutoCompactPolicyConfig,
  ModelAnomalyGuardConfig,
  OutputStylePromptConfig,
} from "./deps.js";
import type { AgentProfile } from "../subagent/profile.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { BashTimeoutPolicy } from "../tool/bash-timeout-policy.js";
import type { PresentationSurface } from "../context/types.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

// -----------------------------------------------
// Agent Runtime
// -----------------------------------------------

export interface AgentRuntimeConfig {
  /** shared-host CUA request routing metadata; desktop is the safe default. */
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  remoteSessionId?: string;
  bashTimeoutPolicy?: BashTimeoutPolicy;
  presentationSurface?: PresentationSurface;
  /** Execution Host's output root, independent of the working repository. */
  genUiOutputRoot?: string;
  mode?: CollaborationMode;
  planEnabled?: boolean;
  modelStreaming?: "off" | "on";
  streamingToolExecution?: "off" | "readOnly";
  /** Fixed when the Session is created; defaults to the shared model-context budget policy. */
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  maxTurns?: number;
  permissionTimeoutMs?: number;
  compact?: AutoCompactPolicyConfig;
  targetCompletionVerification?: { enabled?: boolean };
  midConversationSystem?: {
    mode?: "auto" | "force";
  };
  subagents?: {
    enabled?: boolean;
    // Maximum idle time for a foreground subagent with no child events; defaults to the model-stream idle timeout.
    inactivityTimeoutMs?: number;
    autoBackgroundMs?: number;
    backgroundBashMaxMs?: number;
    maxTurns?: number;
    outputRootDir?: string;
    profiles?: readonly AgentProfile[];
    builtInModelSelectionOverrides?: Partial<Record<"general-purpose" | "Explore", ModelSelection>>;
  };
  toolAllowlist?: readonly string[];
  toolDisallowlist?: readonly string[];
  /**
   * Defaults to main. Explore child runtimes use the explore toolset to opt into
   * Read-only exploration tool allowlist; whether direct Glob/Grep are included is determined by
   * the embedded search branch. In main mode, allowlist only filters by direct intersection;
   * explore child runtimes also add the default read-only allowlist.
   */
  toolset?: "main" | "explore";
  toolConcurrency?: { maxConcurrency?: number };
  runtimeFeatures?: {
    /**
     * Whether to register the node_repl tool (js).
     * Derived by bootstrap from whether the official ZCode plugin is enabled; ordinary plugin manifests cannot declare it.
     */
    nodeRepl?: boolean;
    /**
     * Whether node_repl may inject agent.browsers. The host must also provide browserControlPort.
     */
    browserUse?: boolean;
    /** Whether to inject CUA broker credentials into shared node_repl; this does not register a separate CUA MCP. */
    computerUse?: boolean;
    /**
     * Docs asset directory for the official browser-use plugin. Derived by bootstrap from
     * plugin metadata.rootPath; not part of the plugin manifest schema.
     */
    browserDocumentationRoot?: string;
  };
  modelAnomalyGuard?: Partial<ModelAnomalyGuardConfig>;
  mcp?: {
    enabled?: boolean;
    servers?: Record<string, McpServerConfig>;
    /**
     * Process-local provenance supplied by bootstrap after resolving bundled
     * official plugins. Never derive this list from serialized MCP config.
     */
    trustedOfficialCuaServerNames?: readonly string[];
  };
  /**
   * Plugin identity catalog frozen by the Session.
   * Built by bootstrap from plugin loader results when the App is created; runtime reads it only
   * to resolve `plugin://` references at turn start and intersect them with the live inventory.
   */
  pluginReferenceCatalog?: PluginReferenceCatalog;
  hooks?: HooksRuntimeConfig;
  bashShellSelection?: ExecutionShellSelection | undefined;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  /** Fixed when the root Session runtime is created; false disables only the Bash bfs/ugrep prelude. */
  nativeSearchEnhancementsEnabled?: boolean;
  memory?: MemoryRuntimeConfig;
  /** Historical restore may be unbound; only a complete selection can create this turn's execution Model. */
  modelSelection?: ModelSelection;
  titleGeneration?: {
    enabled?: boolean;
    modelSelection?: ModelSelection;
    timeoutMs?: number;
  };
  parentSessionId?: SessionId;
  taskType?: SessionTaskType;
  /**
   * Dynamic-workflow gradual rollout gate (docs/dynamic-workflow/launch.md, “Gray release”): Host decides and sends it through
   * ZCode Protocol; runtime only consumes it. **Absent means enabled** (this polarity is used by in-process embedders);
   * standalone CLI TUI and headless modes explicitly pass true/false through --workflow-mode (default disabled, DWG-04),
   * and workflow_child inherits the parent configuration.
   * false disables the ten workflow tools without changing registration policy for other tools.
   */
  dynamicWorkflowEnabled?: boolean;
  /**
   * Gradual rollout mode `onDemand` (docs/dynamic-workflow/launch.md, “On demand: activation”): defer registration of the ten workflow
   * tools until the session's first `/workflow` (or a GUI Resume / Configure / direct start for this session, or cold restore when a workflow already exists).
   * **Absent means register immediately**, matching the polarity of dynamicWorkflowEnabled; only the protocol server writes true when the Host sends mode onDemand.
   * Activation state belongs to runtime (`dynamicWorkflowToolsActivated`).
   */
  dynamicWorkflowToolsOnDemand?: boolean;

  // Context Builder config
  systemPrompt?: string;
  /**
   * Identity input for a dynamic-workflow subagent. When present, the context builder uses the
   * "base + workflow subagent contract + persona overlay" path instead of replacing the entire
   * `systemPrompt` with the persona. Mutually exclusive with `systemPrompt` (the builder throws).
   */
  workflowActor?: { name?: string; persona?: string };
  /**
   * Selects the subagent-specific context builder for child runtimes. The
   * builder still receives env/date/model data through the normal runtime
   * context snapshot, but assembles provider-visible system sections with the
   * subagent prompt shape instead of the main ContextBuilder stack.
   */
  subagentContext?: {
    agentPrompt: string;
    userInstructions?: ResolvedUserInstructions;
  };
  language?: string;
  outputStyle?: OutputStylePromptConfig;
  /** User overrides for editable system-prompt sections (docs/system-prompt-overrides.md). */
  systemPromptOverrides?: SystemPromptOverrides;
  agentName?: string; // Default: "zcode-agent"
  workingDirectory?: string; // Required for context builder
  /**
   * Actual workspace path representation supplied by the caller, used for session persistence and
   * local identity restoration. File and command execution still use only normalized workingDirectory.
   */
  workspacePath?: string;
  /**
   * Linked git worktree the agent executes in while the session stays listed under the parent
   * workspace (docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md).
   * Persisted as session.execution_directory/execution_branch; cold resume restores
   * workingDirectory from it. Session listing identity still uses workspacePath.
   * `missing` marks a worktree directory that vanished out-of-band (resume falls back to the
   * parent workspace but keeps the fact for the wire meta and the env bullet);
   * `workspacePath` is the parent workspace reference, never sent on the wire.
   */
  executionWorktree?: {
    path: string;
    branchName?: string;
    missing?: boolean;
    workspacePath?: string;
  };
  /** Used only for persistence isolation; file and command execution still use workingDirectory. */
  workspaceIdentity?: WorkspaceId;
  envInfo?: EnvInfo; // Optional, will be auto-detected if not provided
  currentDate?: string; // YYYY-MM-DD, resolved by adapter when omitted
  userInstructions?: UserInstructionsOptions; // P1: AGENTS.md
  projectContext?: ProjectContext; // P2: auto-detected if not provided
  skillMetadataBudget?: number;
}

export interface ResumeSessionOptions {
  /** Abort the cold-resume admission wait; does not fabricate a Workspace Hook review decision. */
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  /** Call-level materialized result supplied by the cold-restore caller; not stored in the lifecycle cache, and reread from the return value after patching. */
  persistedMessages?: MessageWithParts[];
  /**
   * Mode resolved for this invocation. Explicit --mode and headless's default yolo are call-level
   * overrides and must take precedence over historical session mode. For interactive resume with
   * no explicit mode, leave undefined so the historical mode applies.
   */
  modeOverride?: CollaborationMode;
}

export interface MainTurnCacheHitAggregate {
  requestCount: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

export type BackgroundTaskNotificationSealReason = "subagent_terminal" | "subagent_cancelled";

export interface SealBackgroundTaskNotificationsInput {
  reason: BackgroundTaskNotificationSealReason;
  traceContext?: TraceContext;
}

export interface PendingModelChangeTimeline {
  createdAt: number;
  fromModel?: ModelSelection;
  fromModelLabel?: string;
  requestId: string;
  toModel: ModelSelection;
  toModelLabel: string;
}

export interface EnqueueSubagentMessageInput {
  responseId: string;
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  childToolCallId: string;
  parentToolCallId?: string;
  summary: string;
  message: string;
  traceContext: TraceContext;
}

export interface MemoryRuntimeConfig {
  cliStorageRoot?: string;
  enabled?: boolean;
  /** Whether to schedule automatic Extraction after a successful Main turn; defaults to true. */
  extractionEnabled?: boolean;
  storageRoot?: string;
  use?: boolean;
  workspaceIdentity?: string;
}

export interface AgentRuntimeDeps {
  /** Read-only catalog access; read synchronously from memory and do not perform I/O while collecting a request. */
  getAgentDefinitions?: GetAgentDefinitions;
  /** Read once for a new parent context; child executions must not inherit this loader. */
  loadAgentDefinitions?: LoadAgentDefinitions;
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryCausation?: AgentTelemetryCausation;
  agentTelemetryCausationMode?: "child" | "linked_root";
  appVersion?: string;
  eventStore: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  modelFactory: RuntimeModelFactory;
  /** Optional host capability: resolve explicit intent for future execution; does not modify the frozen Model. */
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  permissionService?: PermissionService;
  permissionBroker?: PermissionBrokerPort;
  toolScheduler?: ToolScheduler;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
  executionPort?: ExecutionPort;
  /** Browser Use control port, passed to ToolExecutionContext.browserControlPort for node_repl. */
  browserControlPort?: BrowserControlPort;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** Port for workflow actors to submit terminal results; when present, gates registration of the submit_result tool. */
  workflowSubmitPort?: WorkflowSubmitPort;
  /**
   * Typed `submit_result` for a mono subagent: when present, the registered tool declaration is
   * `{ result: <this schema> }` instead of arbitrary JSON. This changes only the provider-visible
   * declaration and strict eligibility; handler, permissions, and termination semantics match the
   * workflowSubmitPort-only case. Ignored when the port is absent (the port is the registration gate).
   */
  workflowSubmitSchema?: JsonSchema;
  /**
   * Port for workflow actors to escalate blocking questions; when present, gates registration of
   * the escalate tool. Injected in the same way as workflowSubmitPort and uses the same gate.
   */
  workflowEscalatePort?: WorkflowEscalatePort;
  /**
   * Process-level admission port for model requests. When present, every model request attempt
   * first obtains a permit here, which flows through call context to the adapter. The dwf actor
   * runtime gets a per-actor driver wrapper (gated), while the main runtime gets the coordinator's
   * observer (signals only). Absence means no gate.
   */
  modelRequestAdmission?: ModelRequestAdmission;
  workflowPort?: WorkflowPort;
  /** Submit/observe/cancel port for workflow runs; when present, CreateWorkflow launches for real, otherwise it returns a placeholder diagnostic. */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** Model-catalog port; when absent, ListModels reports missing capability and CreateWorkflow rejects subagent_model. */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  contextSourcePort?: ContextSourcePort;
  eventSink?: SessionEventSink;
  logger?: Logger;
  traceContext?: TraceContext;
  contextBuilder?: ContextBuilder; // Optional, will be created from config
  now?: () => Date;
  isRemoteWorkspace?: () => boolean;
  memoryRoot?: string;
}

export interface RuntimeModelFactoryInput {
  selection: ModelSelection;
  /** Bound only to the Model created for this request; not included in public ModelRequest or Session persistence. */
  requestDependencies?: ModelRequestDependencies;
}

export type RuntimeModelFactory = (input: RuntimeModelFactoryInput) => Model;

/**
 * Provider runtime headers port for protocol clients.
 *
 * The input sessionId must route to a session held by the client. A child runtime's ledger identity
 * cannot be used directly for client requests: the client could not find the session or return a
 * response, leaving the first model request waiting indefinitely. Child runtimes derive ports
 * through deriveChildClientPorts to route requests to the client session bound to the parent port.
 */
export interface ProviderRuntimeHeadersPort {
  shouldRefreshBeforeModelRequest?(input: { providerId: string; modelId: string }): boolean;
  refreshBeforeModelRequest(input: {
    accountAccess?: ZCodeProviderAccountAccess;
    expectedAccountScope?: string;
    rejectedProjectTokenFingerprint?: string;
    abortSignal?: AbortSignal;
    modelId: string;
    providerId: string;
    reason: RequestVerificationReason;
    sessionId: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  }): Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
}

export interface TurnResult {
  response: string;
  turnId: TurnId;
  traceId: TraceId;
  usage?: ModelUsageSummary;
  events: SessionEvent[];
  projection: SessionProjection;
}

/**
 * Execution-time constraints for the standard Submission Selection. It carries no static
 * Provider/Model facts and is not a second source for Session Selection.
 */
export interface ModelExecutionContext {
  /** Skip automatic Project Memory Extraction for this Turn only; does not modify Session Memory config. */
  memoryExtraction?: "skip";
  selectionScope: "execution";
  requestDependencies?: ModelRequestDependencies;
  subagents?: {
    foregroundModel: "submission";
    background: "deny";
  };
  /**
   * If this execution's Selection fails, fall back to the original model within the same Turn and continue (preserving committed history and replacing only the model for subsequent requests),
   * rather than failing the whole turn. The caller must declare the trigger conditions: `providerId` restricts matching to the provider selected by this execution,
   * `rules` are checked in declaration order and the first match determines the fallback reason, and an omitted `providerErrorCode` means any failure from that provider.
   * Core does not hard-code provider IDs, model names, or error messages.
   * Resolve the fallback target from `target` first (the committed selection at draw time, meaning the session's original model), then from the persistent Session Selection;
   * if neither resolves, there is no fallback and the real error is returned.
   */
  selectionFallback?: {
    providerId: string;
    rules: Array<{
      reason: TurnExecutionModelFallbackReason;
      providerErrorCode?: string;
    }>;
    target?: ModelSelection;
  };
}

export interface ExecuteTurnOptionsBase {
  abortSignal?: AbortSignal;
  browserAmbientContext?: {
    tabCount: number;
    currentUrl?: string;
  };
  continueActiveTargetAfterTurn?: boolean;
  displayInput?: string;
  /**
   * From this index onward, `input` is engine text appended by the caller (dwf ask suffix/nudge).
   * It is recorded only in TurnStarted and user-message metadata for GUI collapsing; model history
   * and persisted text parts retain the full text (amend-resume transcript copying needs it all).
   */
  epilogueStart?: number;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputPresentation?: RuntimeInputPresentation;
  inputVisibility?: MessageVisibility;
  originMeta?: BackgroundResultOriginMeta;
  /** Used only to freeze the causal source for the entire background notification batch; not for display. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  /** Computed by runtime command drain; indicates this turn consumed a subagent background result. */
  backgroundSubagentResultConsumed?: boolean;
  /** Computed by runtime command drain; indicates this turn consumed a dynamic-workflow run notification (completion/question). */
  workflowResultConsumed?: boolean;
  recordedInputMessageId?: MessageId;
  skipInputRecord?: boolean;
  skipUserPromptSubmitHooks?: boolean;
  targetId?: string;
  /** Tools hidden from the provider for this turn only; does not modify the session runtime's persistent tool surface. */
  toolDisallowlist?: readonly string[];
  traceContext?: TraceContext;
  /** Selection for the current Submission applies only to this execution and may bind per-request dependencies. */
  modelExecution?: ModelExecutionContext;
}

export type ExecuteTurnOptions = ExecuteTurnOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

/**
 * Call parameters for Core prompt admission. Bootstrap supplies input facts and desired delivery
 * semantics only; AgentRuntime, which owns the session state, atomically chooses start or queue.
 */
export type PromptAdmissionOptions = ExecuteTurnOptions & {
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  delivery?: "auto" | "start_turn" | "steer_active_turn";
  expectedTurnId?: TurnId;
  /** Product queue semantics when busy; Core falls back to queue for attachments or non-steerable input. */
  queueDelivery?: "guide" | "queue";
  /** Force FIFO admission; used for temporary run models that can only be installed in a future independent turn. */
  requireQueue?: boolean;
  /** Internal calls such as queue promotion require idle admission; otherwise reject immediately. */
  requireIdle?: boolean;
};

export type PromptAdmissionReceipt =
  | {
      kind: "started";
      completion: Promise<TurnResult>;
      turnId: TurnId;
    }
  | TurnSteerResult;

export type ActiveTargetLoopTrigger = "manual" | "user-prompt" | "task-notification";

export interface ContinueActiveTargetLoopOptions {
  abortSignal?: AbortSignal;
  inputId?: string;
  intent?: TurnInputIntentMetadata;
  traceContext?: TraceContext;
  trigger: ActiveTargetLoopTrigger;
  verifyBeforeFirstContinue?: boolean;
}

export interface ActiveForegroundExecutionState {
  controller: AbortController;
  disposeParentAbort: () => void;
  foregroundExecutionId: string;
  preserveQueueAutoDrainOnCancel: boolean;
}

export interface StopActiveForegroundExecutionOptions {
  expectedForegroundExecutionId?: string;
  preserveQueueAutoDrainOnCancel?: boolean;
  reason?: string;
}

export type StopActiveForegroundExecutionResult =
  | { kind: "stopped"; foregroundExecutionId: string }
  | { kind: "idle" }
  | { kind: "mismatch"; activeForegroundExecutionId: string };

export type ForegroundPromotionLeaseMode = "after-current" | "idle-only";

export interface ForegroundPromotionLeaseState {
  leaseId: string;
  promotedInputId: string;
}

export type AcquireForegroundPromotionLeaseResult =
  | { kind: "acquired"; leaseId: string }
  | { kind: "busy" }
  | { kind: "conflict"; leaseId: string };

export interface ActiveTurnInfo {
  kind: ActiveTurnKind;
  /** This turn's inputId (same value as TurnStarted.inputId); workflow runs use it as their launch anchor. */
  inputId?: string;
  queueLength: number;
  steerable: boolean;
  turnId: TurnId;
}

export interface WorkspaceRewindRestoredFile {
  action: "delete" | "restore";
  bytesWritten?: number;
  path: string;
}

export interface WorkspaceRewindResult {
  checkpoint?: CheckpointCreatedPayload;
  evaluation?: RewindTargetEvaluation;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
}

export type WorkspaceFileRewindAction = "restore" | "delete";

export type WorkspaceFileRewindUnsafeReason =
  | "checkpoint_missing"
  | "checkpoint_unreadable"
  | "external_modified"
  | "file_read_failed"
  | "unsupported_checkpoint";

export interface WorkspaceFileRewindSafeFile {
  action: WorkspaceFileRewindAction;
  operationCount: number;
  path: string;
  toolNames: string[];
}

export interface WorkspaceFileRewindUnsafeFile {
  currentHash?: string;
  expectedHash?: string;
  message?: string;
  operationCount: number;
  path: string;
  reason: WorkspaceFileRewindUnsafeReason;
  toolNames: string[];
}

export interface WorkspaceFileRewindIgnoredFile {
  operationCount: number;
  path: string;
  reason: "bash_ignored";
  toolNames: string[];
}

export interface WorkspaceFileRewindPreview {
  canApply: boolean;
  ignoredFiles: WorkspaceFileRewindIgnoredFile[];
  safeFiles: WorkspaceFileRewindSafeFile[];
  unsafeFiles: WorkspaceFileRewindUnsafeFile[];
}

export interface WorkspaceFileRewindApplyResult {
  applied: boolean;
  preview: WorkspaceFileRewindPreview;
  response: string;
}

export interface ConversationRewindResult {
  branchGeneration?: number;
  evaluation?: RewindTargetEvaluation;
  keptMessageCount: number;
  response: string;
  rewindId: string;
  strategy: RewindStrategy;
  targetMessageId: MessageId;
}

export interface WorkspaceForkResult {
  checkpoint?: CheckpointCreatedPayload;
  copiedMessageCount: number;
  forkedSessionId: SessionId;
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFiles: WorkspaceRewindRestoredFile[];
  response: string;
}

/** Raw transcript segment for the target product turn fixed by the V4 resolver. */
export type StableConversationForkTarget = StableForkTargetMetadata;

/** Explicit none or complete goal/verifier snapshot at a fork point; undefined is not valid new data. */
export type StableConversationForkGoalBoundary = StableForkGoalBoundaryMetadata;

export type StableConversationForkChildMetadata = ForkChildSessionMetadata;

export interface StableConversationForkOptions {
  forkedSessionId?: SessionId;
  modelSelection?: ModelSelection;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  revisionAtDecision?: number;
  target: StableConversationForkTarget;
  traceContext?: TraceContext;
}

/** Create a hidden side-panel child from a stable persisted boundary in the parent session; do not copy goal/queue/blocked runtime state. */
export interface SelectionSideChatCreateOptions {
  modelSelection?: ModelSelection;
  sourceCommandId: string;
  revisionAtDecision?: number;
  traceContext?: TraceContext;
}

export interface ConversationBeforeInputForkOptions {
  modelSelection?: ModelSelection;
  forkedSessionId?: SessionId;
  goalBoundary: StableConversationForkGoalBoundary;
  sourceCommandId: string;
  targetMessageId: MessageId;
  targetProductTurnId: string;
  targetTranscriptTurnId: string;
  initialInput: ForkCommitBundle["initialInput"];
  commandFact: ForkCommitBundle["commandFact"];
  traceContext?: TraceContext;
}

export interface WorkspaceCheckpointSummary {
  checkpointId: string;
  compactBoundaryId?: string;
  coveredByCompact?: boolean;
  createdAt: Date;
  diffRef?: string;
  fileCount?: number;
  messageId: MessageId;
  targetMessageId?: MessageId;
  toolMessageId?: MessageId;
  preview?: string;
  scope: RewindScope;
  snapshotRef: string;
}

export interface RuntimeTurnFileChangeEntry {
  afterContent?: string;
  beforeContent: string | null;
  fallbackAdditions: number;
  fallbackDeletions: number;
  path: string;
  toolNames: Set<string>;
  writeCount: number;
}

export type RuntimeTurnFileChangeMap = Map<string, RuntimeTurnFileChangeEntry>;

export interface CompactTimelineContext {
  operationId: string;
  messageId: MessageId;
  partId: PartId;
  trigger: CompactTrigger;
  phase: CompactPhase;
  compactReason: CompactReason;
  sourceCommandId?: string;
  startedAt: number;
  preCompactTokenCount?: number;
}

export interface ResumeSessionResult extends SessionHistoryHydrationResult {
  directory: string;
  /** Current restore candidate: a valid model identity alone is enough for the UI to select a tier; this does not mean Runtime is bound. */
  modelSelection?: ModelSelection;
  /** Whether resume persisted compact repair facts that the current materialization cannot fully represent. */
  persistedMessagesReloadRequired: boolean;
  readFileStateRestoredCount: number;
  readFileStateSkippedRangeReadCount: number;
  readFileStateSkippedUnreadableEditCount: number;
  traceId: TraceId;
}

export interface PermissionDecisionResult {
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  permissionUpdates?: PermissionUpdate[];
}

export interface ExecuteToolsOptions {
  automationTurn?: boolean;
  offPeakTurn?: boolean;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  /** Passed only to the Agent child synchronously awaited by the current turn. */
  subagentModelOverride?: import("@zcode/contracts").SubagentRunOptions["modelOverride"];
  model?: Model;
  onBatchStart?: (toolCallIds: string[]) => Promise<void>;
}

export interface ExecuteToolsResult {
  results: ToolExecutionResult[];
  events: SessionEvent[];
}

export type ActiveTurnKind = "regular" | "compact" | "rewind";

export const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;

export const INLINE_MEDIA_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export const MAX_IMAGE_ATTACHMENT_DIMENSION = 2000;

export interface ResolvedTurnAttachment {
  contentBlock: ModelMessageContentBlock;
  filename?: string;
  metadata: AttachmentStorageMetadata;
  mime: string;
  source?: FilePartSource;
  url: string;
}

export interface PreparedImageData {
  dataUrl: string;
  mediaType: string;
  metadata?: AttachmentStorageMetadata["image"];
}

export interface ActiveTurnSteeringState {
  kind: ActiveTurnKind;
  // When Stop aborts an active turn, a goal reminder must not be inserted before tool results are closed.
  // Deferral is opened only inside the regular model/tool loop; close it and materialize pending reminders when leaving the loop.
  goalStateChangeReminderDeferralOpen: boolean;
  pendingGoalStateChangeReminder?: {
    text: string;
  };
  pendingInputs: PendingTurnInput[];
  steerable: boolean;
  traceContext: TraceContext;
  turnId: TurnId;
  /** This turn's inputId (same source as TurnStarted.inputId); recorded by beginActiveTurn for regular turns. */
  inputId?: string;
}

export interface ActiveTurnStartReservation {
  kind: ActiveTurnKind;
  traceContext: TraceContext;
  turnId: TurnId;
}

export interface DrainedPendingInputDiagnostics {
  injectedMessageIds: MessageId[];
  /** Atomic Submission config carried by the inline Guide itself; consumed at the next model-step boundary. */
  intent?: TurnInputIntentMetadata;
  latestMessageId: MessageId | undefined;
  pendingInputIds: string[];
  queryIds?: QueryId[];
  /** Immutable entries from canonical history committed by this drain, used to advance the turn-local query in sync. */
  runtimeEntries: readonly RuntimeMessageEntry[];
  /** Tool-hidden list attached to input injected by this drain; it must remain effective for the next provider request. */
  toolDisallowlist?: readonly string[];
}

export interface ProviderContextUsageSnapshot {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokens?: number;
  inputTokens: number;
  messageCount: number;
  model: { providerId: Model["providerId"]; modelId: Model["modelId"] };
  outputTokens?: number;
  recordedAt: number;
  traceId: TraceId;
  turnId?: TurnId;
}

export interface RunModelTextRequestOptions {
  abortSignal?: AbortSignal;
  assistantMessageId: MessageId;
  events: SessionEvent[];
  maxOutputTokens?: number;
  latestRealUserMessageIndex?: number;
  messages: ModelInputMessage[];
  /** Canonical sources aligned by index with messages; used only for local usage accounting. */
  sourceEntries?: readonly (RuntimeMessageEntry | undefined)[];
  model: Model;
  onStreamSnapshot?: (snapshot: RuntimeModelStreamSnapshot) => void;
  onStreamReasoningDelta?: (text: string) => void;
  onStreamTextDelta?: (text: string) => void;
  onStreamToolCall?: (toolCall: ModelToolCall) => void;
  onModelNetworkStatus?: (event: ModelNetworkStatusEvent) => void;
  streamRecovery?: ModelStreamRecoveryStatus;
  tools: ModelToolContract[];
  traceContext: TraceContext;
}

export interface RuntimeModelStreamSnapshot {
  reasoning: ModelReasoningContentBlock[];
  text: string;
}

export interface StreamedToolExecutionResult {
  input: Record<string, unknown>;
  ledgerRecorded?: boolean;
  partID: PartId;
  result: ToolExecutionResult;
  toolCallId: ToolCallId;
}

export interface RuntimeModelTextResult {
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  finishReason: string;
  providerMetadata?: Record<string, unknown>;
  reasoning?: ModelReasoningContentBlock[];
  text: string;
  toolCalls?: ModelToolCall[];
  usage: ModelUsage;
}

export type ParsedRewindCommand =
  | {
      action: "apply";
      targetCheckpointId?: string;
    }
  | {
      action: "fork";
      targetCheckpointId?: string;
    }
  | {
      action: "cascade-message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "message";
      scope: RewindScope;
      targetMessageId: MessageId;
    }
  | {
      action: "status";
    };

export type ContextUsageTokenMethod = "estimated" | "provider_count" | "proportional_estimate";

export type ContextUsageConfidence = "high" | "medium" | "low";

export interface ContextUsageMetric {
  chars: number;
  confidence: ContextUsageConfidence;
  tokenMethod: ContextUsageTokenMethod;
  tokenizer: string;
  tokens: number;
}

export interface ContextUsageCategory extends ContextUsageMetric {
  name: string;
  percentTokens: number;
  source:
    | "system_prompt"
    | "meta_user_context"
    | "skills"
    | "tool_prompt"
    | "system_tool_schemas"
    | "mcp_tool_schemas"
    | "messages";
}

export interface ContextUsageToolDetail extends ContextUsageMetric {
  name: string;
  readOnly?: boolean;
  serverName?: string;
  sideEffectScope?: string;
  source: "system_tool" | "mcp_tool";
}

export interface ContextUsageSkillDetail extends ContextUsageMetric {
  name: string;
  path: string;
  scope: string;
  source: string;
}

export interface ContextUsageMessageRoleBreakdown extends ContextUsageMetric {
  count: number;
  role: string;
}
