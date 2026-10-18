import type { LspService } from "../lsp/service.js";
import {
  createTurnAgentDefinitions,
  createAgentDefinitionsReader,
  type GetAgentDefinitions,
} from "../subagent/definitions.js";
import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY, resolveExecutionState } from "@zcode/shared";
import type { BackgroundBashOutputResult } from "@zcode/shared";
import {
  createDenyPermissionBroker,
  createRootTraceContext,
  createToolRegistry,
  defaultPermissionConfig,
  EventReducer,
  MessageHistoryImpl,
  PermissionService,
  ToolScheduler,
  traceContextToLogContext,
} from "./deps.js";
import type {
  CollaborationMode,
  Logger,
  BackgroundTaskCancelResult,
  SessionEvent,
  MessageId,
  Model,
  ModelSelection,
  ModelSelectionOrigin,
  ModelToolContract,
  PermissionBrokerPort,
  PermissionBrokerRequest,
  ProjectId,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  SessionStorePort,
  SessionGoal,
  SavedWorkflowScope,
  TargetChangedPayload,
  DynamicWorkflowRunProgressPayload,
  UserInputAutoResolutionUpdatedPayload,
  ContextSourcePort,
  ExecutionPort,
  FileSystemPort,
  ImageProcessorPort,
  PdfDocumentPort,
  McpConnectionSnapshot,
  SkillLoadOutcome,
  SkillPort,
  McpPort,
  DynamicWorkflowRunPort,
  ModelCatalogPort,
  SubagentPort,
  ToolArtifactStorePort,
  ToolCallId,
  TraceContext,
  TurnSteerInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  ToolCall,
  TurnState,
  MessageHistory,
  ReadFileStateMap,
  ToolSchedule,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
  ContextSourceSnapshot,
  ExecutionShellSelection,
  HookRunner,
  TurnId,
} from "./deps.js";
import { installAgentRuntimeMethods } from "./methods/index.js";
import type { StartSavedWorkflowRunResult } from "./methods/dynamic-workflow-run-start.js";
import type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./methods/dynamic-workflow-run-settings.js";
import { createRuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type {
  ModelConnectivityTestInput,
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "./methods/workspace-generate-text.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";
import { initializeRuntimeTooling } from "./helpers/runtime-tools.js";
import {
  resolveInitialDynamicWorkflowToolsActivated,
  type DynamicWorkflowActivationSource,
} from "./methods/dynamic-workflow-activation.js";
import type {
  ActiveTurnInfo,
  ActiveForegroundExecutionState,
  AcquireForegroundPromotionLeaseResult,
  ActiveTurnStartReservation,
  ActiveTurnSteeringState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ContinueActiveTargetLoopOptions,
  ConversationBeforeInputForkOptions,
  ConversationRewindResult,
  ExecuteToolsOptions,
  ExecuteToolsResult,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ForegroundPromotionLeaseMode,
  ForegroundPromotionLeaseState,
  PendingModelChangeTimeline,
  PermissionDecisionResult,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
  ResumeSessionOptions,
  ResumeSessionResult,
  SelectionSideChatCreateOptions,
  StableConversationForkOptions,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
} from "./types.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { InMemoryRuntimeTaskRegistry, type RuntimeTaskRegistry } from "../runtime-task/registry.js";
import { createMemoryRecallState } from "../memory/recall/index.js";
import type { MemoryRecallState } from "../memory/recall/index.js";
import type { ChildClientPortsContext, ClientFacingPorts } from "./helpers/child-client-ports.js";
import type { ProjectMemoryRecallPrefetch } from "./helpers/project-memory-recall.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { BackgroundDreamRun, ProjectMemoryUpdate } from "./helpers/project-memory-dream.js";
import { projectPersistentAgentMemoryTools } from "../subagent/persistent-memory.js";
import { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";
import { disposeNodeReplSession } from "../tool/handlers/node-repl.js";
import { cloneModelSelection } from "./model-selection.js";

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging
export class AgentRuntime {
  private sessionId: SessionId;
  private turnNumber: number;
  private config: AgentRuntimeConfig;
  private appVersion: string;
  private permissionService: PermissionService;
  private permissionBroker: PermissionBrokerPort;
  private toolScheduler: ToolScheduler;
  private eventReducer: EventReducer;
  private eventStore: SessionEventStorePort;
  private rootTraceContext: TraceContext;
  private logger?: Logger;
  private eventSinks = new Set<SessionEventSink>();
  private now: () => Date;
  private isRemoteWorkspace: () => boolean;
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private hookRunner?: HookRunner;
  private workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  private modelFactory: AgentRuntimeDeps["modelFactory"];
  private modelIoDir?: string;
  private providerRuntimeHeadersPort?: AgentRuntimeDeps["providerRuntimeHeadersPort"];
  private browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  /** Model-request admission port; included in each model request's call context. */
  private modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  private sessionModelSelection: ModelSelection | undefined;
  private messageHistory: MessageHistory;
  private readFileState: ReadFileStateMap;
  private cachedTools: ModelToolContract[] | null = null;
  /** launch.md, “On demand: activation”: onDemand sessions start as false; `activateDynamicWorkflowTools` changes this to true. */
  private dynamicWorkflowToolsActivated: boolean;
  private dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  private lspService?: LspService;
  private lspToolAvailable = false;
  private contextBuilder: ContextBuilder | null = null;
  private contextInitialized = false;
  private contextSourceSnapshot?: ContextSourceSnapshot;
  private latestContextBuildResult?: ContextBuildResult;
  private memoryRoot?: string;
  private memoryIndexContent?: string;
  private memoryRecallState: MemoryRecallState;
  private memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  private memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  private memoryDreamLastScanAtMs = 0;
  private pendingMemoryUpdate?: ProjectMemoryUpdate;
  private backgroundDreamRuns = new Map<string, BackgroundDreamRun>();
  private contextSourcePort?: ContextSourcePort;
  private skillPort?: SkillPort;
  private mcpPort?: McpPort;
  private mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  private residencyBlockingWorkCount = 0;
  private mcpInitialized = false;
  private mcpToolsRegistered = false;
  private registeredMcpToolNames?: string[];
  private mcpToolsSignature?: string;
  private mcpToolListRevision?: number;
  private subagentPort?: SubagentPort;
  private readonly getAgentDefinitions: GetAgentDefinitions;
  private readonly prepareAgentDefinitions: ReturnType<
    typeof createTurnAgentDefinitions
  >["prepare"];
  private dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  private modelCatalogPort?: ModelCatalogPort;
  private runtimeTaskRegistry: RuntimeTaskRegistry;
  private branchGeneration = 0;
  private artifactStore?: ToolArtifactStorePort;
  private executionPort?: ExecutionPort;
  private fileSystemPort?: FileSystemPort;
  private imageProcessorPort?: ImageProcessorPort;
  private pdfDocumentPort?: PdfDocumentPort;
  private skillLoadOutcome?: SkillLoadOutcome;
  private workingDirectory: string;
  private workspaceRoot: string;
  private sessionStore?: SessionStorePort;
  private sessionPersisted = false;
  private needsPlanModeExitReminder = false;
  private latestConversationMessageId?: MessageId;
  private latestAssistantMessageId?: MessageId;
  private latestAssistantTurnId?: TurnId;
  private mainTurnCacheHitAggregate: MainTurnCacheHitAggregate = {
    requestCount: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };
  private currentTurnFileChanges: RuntimeTurnFileChangeMap = new Map();
  private lastAssistantCompletedAtMs?: number;
  private lastEmittedLocalDate?: string;
  private autoCompactConsecutiveFailures = 0;
  private runtimeCommandQueue: RuntimeCommandQueue;
  private runtimeCommandDrainActive = false;
  private activeForegroundExecution?: ActiveForegroundExecutionState;
  /** Core scheduling authority for sendQueuedNow; process-local and consumed when the matching runtime command is dequeued. */
  private foregroundPromotionLease?: ForegroundPromotionLeaseState;
  private activeTurn?: ActiveTurnSteeringState;
  private activeTurnStartReservation?: ActiveTurnStartReservation;
  private pendingInputSequence = 0;
  /** sendQueuedNow reservation; local to the current CLI process to prevent duplicate promotion by drain/multiple clients. */
  private pendingInputReservations = new Map<string, string>();
  // v4 setAutoDrain: when false, queued input is not consumed automatically
  // (turn-stop does not resume, and there is no drain between roundtrips); keep it held
  // for explicit consumption.
  private queueAutoDrain = true;
  // After resuming the paused queue, the CLI promotes entries one at a time in projected
  // FIFO order. During this window, core must not drain only activeTurn.pendingInputs;
  // new messages could otherwise overtake older paused entries still in the projection.
  private queueExternalDrainActive = false;
  private shuttingDown = false;
  private backgroundTaskNotificationsSealed = false;
  private backgroundTaskNotificationSealReason?: "subagent_terminal" | "subagent_cancelled";
  private pendingModelChangeTimeline?: PendingModelChangeTimeline;
  private sessionStartHookRan = false;
  private sessionTitleGenerationAttempted = false;
  private agentTelemetry: RuntimeTelemetryFacade;

  constructor(sessionId: SessionId, config: AgentRuntimeConfig, deps: AgentRuntimeDeps) {
    const runtime = this as unknown as AgentRuntimeInternal;
    this.sessionId = sessionId;
    this.turnNumber = 0;
    // 3.12.2: accept legacy from older Hosts/internal callers, but this Runtime version, logs, and subagents use only preflight.
    this.config = projectPersistentAgentMemoryTools({
      ...config,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    });
    Object.assign(this.config, resolveExecutionState(config));
    const definitions = createTurnAgentDefinitions(
      deps.getAgentDefinitions ??
        createAgentDefinitionsReader(this.config.subagents?.profiles ?? [], {
          builtInModelSelectionOverrides: this.config.subagents?.builtInModelSelectionOverrides,
        }),
      deps.loadAgentDefinitions,
    );
    this.getAgentDefinitions = definitions.get;
    this.prepareAgentDefinitions = definitions.prepare;
    this.agentTelemetry = new RuntimeTelemetryFacade({
      agentName: config.agentName,
      causation: deps.agentTelemetryCausation,
      causationMode: deps.agentTelemetryCausationMode,
      parentSessionId: config.parentSessionId,
      port: deps.agentTelemetry,
      sessionId,
      taskType: config.taskType,
    });
    this.permissionService =
      deps.permissionService ?? new PermissionService(defaultPermissionConfig);
    this.permissionBroker = deps.permissionBroker ?? createDenyPermissionBroker();
    this.toolScheduler =
      deps.toolScheduler ??
      new ToolScheduler({
        maxConcurrency: this.config.toolConcurrency?.maxConcurrency,
      });
    this.eventReducer = new EventReducer();
    this.eventStore = deps.eventStore;
    this.sessionStore = deps.sessionStore;
    this.rootTraceContext = deps.traceContext ?? createRootTraceContext({ sessionId });
    this.appVersion = deps.appVersion ?? "0.0.0";
    this.logger = deps.logger?.child({
      ...traceContextToLogContext(this.rootTraceContext),
      module: "core.runtime",
    });
    if (deps.eventSink) {
      this.eventSinks.add(deps.eventSink);
    }
    this.now = deps.now ?? (() => new Date());
    this.isRemoteWorkspace = deps.isRemoteWorkspace ?? (() => false);
    this.modelFactory = deps.modelFactory;
    this.modelIoDir = deps.modelIoDir;
    this.providerRuntimeHeadersPort = deps.providerRuntimeHeadersPort;
    this.browserControlPort = deps.browserControlPort;
    this.modelRequestAdmission = deps.modelRequestAdmission;
    // A missing selection in an old session must not block history restoration; do not create a default model here.
    this.sessionModelSelection =
      config.modelSelection && cloneModelSelection(config.modelSelection);
    this.messageHistory = new MessageHistoryImpl();
    this.readFileState = new Map();
    this.memoryRecallState = createMemoryRecallState();
    this.runtimeCommandQueue = createRuntimeCommandQueue();
    this.workingDirectory = config.workingDirectory ?? ".";
    this.contextSourcePort = deps.contextSourcePort;
    this.skillPort = deps.skillPort;
    this.mcpPort = deps.mcpPort;
    this.runtimeTaskRegistry = deps.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry();
    this.runtimeTaskRegistry.setActiveBranchGeneration?.(this.branchGeneration);
    this.artifactStore = deps.artifactStore;
    this.executionPort = deps.executionPort;
    this.fileSystemPort = deps.fileSystemPort;
    this.imageProcessorPort = deps.imageProcessorPort;
    this.pdfDocumentPort = deps.pdfDocumentPort;
    this.subagentPort = deps.subagentPort ?? runtime.createDefaultSubagentPort(deps);
    this.dynamicWorkflowRunPort = deps.dynamicWorkflowRunPort;
    // Catalog used by GUI configuration to resolve subagent models (the same port used by the tool context).
    this.modelCatalogPort = deps.modelCatalogPort;
    this.registry = deps.toolRegistry ?? createToolRegistry();
    this.workspaceRoot = this.workingDirectory;
    // This must happen before tool setup: the gradual rollout gate in registerRuntimeBuiltInTools reads this state.
    this.dynamicWorkflowToolsActivated = resolveInitialDynamicWorkflowToolsActivated(this.config);
    this.lspService = deps.lsp;
    const tooling = initializeRuntimeTooling(runtime, deps, sessionId);
    // Availability needs an async binary check; the LSP tool joins the tool set once it resolves.
    if (this.lspService) void runtime.applyLspPreferences();
    this.hookRunner = tooling.hookRunner;
    this.workspaceHookAdmission = deps.workspaceHookAdmission;
    this.executor = tooling.executor;

    this.contextBuilder = deps.contextBuilder ?? null;
    if (this.contextBuilder) {
      runtime.initializeMessageHistoryFromContext(this.contextBuilder, this.rootTraceContext);
      this.contextInitialized = true;
    }
    runtime.startMcpStartup(this.rootTraceContext);
  }

  async closeBrowserSession(): Promise<void> {
    this.beginShutdown();
    disposeNodeReplSession(this.sessionId);
    try {
      await this.browserControlPort?.closeSession?.({
        sessionId: this.sessionId,
        traceContext: this.rootTraceContext,
      });
    } catch (error) {
      // Failure to clean up the browser backend must not block shutdown of execution/MCP/session store.
      this.logger?.warn("Browser session cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "browser.session_cleanup.failed",
      });
    }
  }

  beginShutdown(): void {
    // ExecutionPort.close() settles background Bash tasks as cancelled. If teardown
    // terminal events wake the model, they can race with the later session-store close.
    this.shuttingDown = true;
    // The process remains alive after one session closes, so stop this runtime's
    // Extraction first rather than merely abandoning the wait after a timeout.
    this.memoryExtractionScheduler?.shutdown();
    for (const run of this.backgroundDreamRuns.values()) run.controller.abort();
  }
}

export interface AgentRuntime {
  lastPermissionGrantId?: string;
  beginShutdown(): void;
  closeBrowserSession(): Promise<void>;
  updateConfig(
    patch: Pick<
      AgentRuntimeConfig,
      "mode" | "planEnabled" | "language" | "outputStyle" | "systemPromptOverrides"
    >,
  ): void;
  initializeSessionShellEnvironmentIfNeeded(
    selection: ExecutionShellSelection | (() => ExecutionShellSelection),
  ): boolean;
  getSessionShellSelection(): ExecutionShellSelection | undefined;
  getMode(): CollaborationMode;
  getPlanEnabled(): boolean;
  grantPermissionFullAccess(interactionId: string, signal?: AbortSignal): Promise<string>;
  setExecutionState(
    input: { mode?: string; planEnabled?: boolean },
    traceContext?: TraceContext,
  ): Promise<void>;
  getSessionModelSelection(): ModelSelection | undefined;
  setSessionModelSelection(selection: ModelSelection | undefined): void;
  getProjectId(): ProjectId;
  getExecutionWorktree(): { path: string; branchName?: string; missing?: boolean } | undefined;
  ensureSessionPersistedForExternalActivity(
    input: string,
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  maybeStartSessionTitleGenerationFromExternalInput(
    input: string,
    options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
  ): void;
  /** renameSession: explicit user rename (titleSource=custom; emits SessionTitleUpdated). */
  setCustomSessionTitle(input: { title: string; traceContext: TraceContext }): Promise<void>;
  maybeStartGoalSummaryTitleGeneration(
    input: string,
    targetID: string,
    options?: { traceContext?: TraceContext },
  ): boolean;
  recordExternalUserPrompt(
    input: string,
    options?: {
      goalSummaryTargetID?: string;
      traceContext?: TraceContext;
      intent?: TurnInputIntentMetadata;
    },
  ): Promise<MessageId>;
  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;
  getActiveTurnInfo(): ActiveTurnInfo | undefined;
  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;
  /** Authoritative runtime busy state for the session residency pool, including queue/drain/reservation. */
  hasActiveOrQueuedTurnWork(): boolean;
  /** Authoritative running state for background Bash/Agent/Workflow tasks, used by the session residency pool. */
  hasRunningBackgroundTasks(): boolean;
  /**
   * Aggregated runtime-owned-work state consumed only by the session residency pool.
   * Includes foreground/queued work, registry background tasks, detached sidecars, and memory work.
   */
  hasResidencyBlockingWork(): boolean;
  /**
   * Register runtime-owned work that outlives the current synchronous call stack. The
   * count increments in **this synchronous segment** and is released in the promise's
   * finally block (see runtime/methods/residency.ts).
   *
   * Expose this method because sidecars outside the runtime also need to register through
   * the same entry point. The dwf engine runs in the session App and is not in the
   * runtime task registry, which previously allowed the session to be closed as idle
   * while the engine was active. Register all new sidecars here instead of adding a
   * separate heuristic in bootstrap.
   */
  trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T>;
  /**
   * Whether the session has been persisted to the store. The protocol layer uses this as
   * the source of truth for whether a record is draft (deferred): any runtime path that
   * persists it for the first time (first input, external activity, or hub-launch turn)
   * moves the session out of draft.
   */
  isSessionPersisted(): boolean;
  getActiveForegroundExecutionId(): string | undefined;
  acquireForegroundPromotionLease(options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  }): AcquireForegroundPromotionLeaseResult;
  releaseForegroundPromotionLease(leaseId: string): boolean;
  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  /** v4 queue single-item delete: remove one queued input from the active turn by pendingInputId. */
  removePendingInputById(options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  reservePendingInputById(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  markPendingInputPromoting(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  releasePendingInputReservation(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue single-item edit: replace queued input text by pendingInputId (preserving position). */
  editPendingInputById(options: {
    pendingInputId: string;
    newText: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue reorder: move pendingInputId before beforePendingInputId (null means the end of the queue). */
  reorderPendingInput(options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /**
   * Execute v4 heldQueueDisposition=clearQueueAndSend: clear all queued inputs
   * (active-turn in-memory items + held projection residue) and return the number discarded.
   */
  clearAllPendingInputs(traceContext: TraceContext): Promise<number>;
  /** v4 setAutoDrain: toggle the session-level queue autoDrain authorization flag. */
  setQueueAutoDrain(options: { autoDrain: boolean; traceContext?: TraceContext }): Promise<void>;
  /** Resume in-turn draining of the running queue after the outer FIFO has consumed the paused queue. */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode: toggle the session-level follow-up routing mode (queue/guide). */
  setFollowupMode(options: { mode: "queue" | "guide"; traceContext?: TraceContext }): Promise<void>;
  /** v4 switchModelConfig: emit ModelSelected after model selection changes (config/marker projection). */
  emitModelSelected(options: {
    modelSelection: ModelSelection;
    model?: Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext?: TraceContext;
  }): Promise<void>;
  /** v4 switchCollaborationMode: emit SessionModeChanged after collaboration mode changes (config.mode projection). */
  emitModeChanged(options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  }): Promise<void>;
  getToolRegistry(): ToolRegistry;
  /**
   * Recompute getTools after the registry is modified externally. The only consumer is
   * the dwf driver's runtime guard for submit profiles: if the static profile disagrees
   * with the actual ask, replace the typed submit_result with its generic declaration.
   * Since it modifies the same registry, the cache must be invalidated or the old
   * declaration will continue to be sent to the model.
   */
  invalidateToolCache(): void;
  /**
   * Bootstrap calls this when LSP preferences change (sidecar fork_lsp_preferences.json). Re-evaluates
   * availability, registers or removes the LSP tool, and stops every server when code intelligence is off.
   */
  applyLspPreferences(): Promise<void>;
  getToolExecutor(): ToolExecutor;
  subscribeEvents(sink: SessionEventSink): () => void;
  /** Bootstrap-owned lifecycle producers append only validated session events through this durable path. */
  appendEvent(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  /**
   * External subruntime seam (1): expose this runtime's session-event store for sharing
   * with subruntimes constructed outside the class (following `eventStore:
   * this.eventStore` in `subagent.ts`). See the implementation comment in
   * `methods/config.ts` for the rationale.
   */
  getSessionEventStore(): SessionEventStorePort;
  /**
   * External subruntime seam (2): fan out raw events from the child session to this
   * runtime's external sink set (preserve the child sessionId; notify only, do not
   * append). **Install this as the child's `deps.eventSink` during construction**; see
   * the implementation comment in `methods/config.ts` for why.
   */
  notifyExternalChildSessionEvent(input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
    /**
     * Ownership of child-runtime interactions (shared with `createChildClientPorts`). When present, interaction events
     * (PermissionRequested / Resolved / Denied) are also mirrored to this session so confirmation dialogs appear in the parent interface.
     */
    interactionOrigin?: ChildClientPortsContext;
  }): Promise<void>;
  /**
   * External subruntime seam (3): create the child runtime's external interaction ports
   * (permission broker + provider runtime headers), already bound to this runtime's
   * client-routing identity. Subruntimes constructed outside the class **must** get both
   * ports here instead of reading appOptions; see the implementation comment in
   * `methods/config.ts` for why.
   */
  createChildClientPorts(context: ChildClientPortsContext): ClientFacingPorts;
  getContextBuilder(): ContextBuilder;
  /** Session Skill snapshot for Composer; frozen for this runtime and rediscovered when the runtime is rebuilt. */
  getSkillCatalog(traceContext: TraceContext): Promise<SkillLoadOutcome>;
  resumeFromStore(options?: ResumeSessionOptions): Promise<ResumeSessionResult>;
  recordTargetChanged(input: TargetChangedPayload & { traceContext: TraceContext }): Promise<void>;
  recordUserInputAutoResolutionUpdate(
    input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** Append workflow-run progress outside the turn (event source is bootstrap's run service). */
  recordDynamicWorkflowRunProgress(
    input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** Re-arm tracking for a restored dwf run (registry entry + started event + waiter + settlement notification). */
  /**
   * Register the ten workflow tools in an onDemand session (docs/dynamic-workflow/launch.md, “On demand: activation”).
   * If already activated, do nothing and return false. Triggered by expanding `/workflow`, GUI Resume / Configure / direct start, and cold restore.
   */
  activateDynamicWorkflowTools(input: {
    source: DynamicWorkflowActivationSource;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  trackResumedDynamicWorkflowRun(input: {
    runId: string;
    toolCallId?: string;
    name?: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  /**
   * Start a saved workflow directly from the hub: resolve, validate, and compile; if
   * clean, submit the run, persist a controlOnly launch turn, and register background
   * tracking. Implements the `app.startSavedWorkflow` capability (registered when its
   * port is available).
   */
  startSavedWorkflowRun(input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * Change a run's subagent model and concurrency limit through GUI configuration: revise
   * the same script into a new run, register background tracking, and queue a settings
   * turn. Implements `app.amendWorkflowRunSettings`.
   */
  amendWorkflowRunSettings(
    input: AmendWorkflowRunSettingsInput,
  ): Promise<AmendWorkflowRunSettingsResult>;
  recordGoalStateChangeReminder(input: {
    text: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  continueActiveTargetIfIdle(options?: {
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TurnInputIntentMetadata;
    traceContext?: TraceContext;
    verifyBeforeContinue?: boolean;
  }): Promise<TurnResult | null>;
  continueActiveTargetLoop(options: ContinueActiveTargetLoopOptions): Promise<TurnResult | null>;
  stopActiveForegroundExecution(
    options?: StopActiveForegroundExecutionOptions,
  ): StopActiveForegroundExecutionResult;
  activatePausedTargetAfterResume(traceContext: TraceContext): Promise<SessionGoal | null>;
  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;
  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;
  resolvePermission(toolCallId: ToolCallId, decision: PermissionDecisionResult): Promise<void>;
  getPendingPermissionRequests(): PermissionBrokerRequest[];
  getProjection(): Promise<SessionProjection>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  stopBackgroundTask(
    taskId: string,
    options: RuntimeBackgroundStopOptions,
  ): Promise<RuntimeBackgroundStopResult>;
  cancelRunningRuntimeBackgroundTasks(input: {
    reason: "subagent_cancelled";
    traceContext?: TraceContext;
  }): Promise<void>;
  sealBackgroundTaskNotifications(input: {
    reason: "subagent_terminal" | "subagent_cancelled";
    traceContext?: TraceContext;
  }): void;
  getSessionId(): SessionId;
  listWorkspaceCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkWorkspaceFromCheckpoint(options?: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  forkStableConversationAtMessage(
    options: StableConversationForkOptions,
  ): Promise<WorkspaceForkResult>;
  createSelectionSideConversation(
    options: SelectionSideChatCreateOptions,
  ): Promise<WorkspaceForkResult>;
  forkConversationBeforeMessage(
    options: ConversationBeforeInputForkOptions,
  ): Promise<WorkspaceForkResult>;
  /**
   * Same-session branch-cut primitive for conversation edit/retry.
   *
   * Deliberately bypass the executeTurn command queue: combined file rewind calls this
   * inside the file transaction's commit gate. Queueing `/rewind` would make the current
   * edit command wait for itself to release the queue.
   */
  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;
  previewWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceFileRewindPreview>;
  applyWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    commitAfterApply?: () => Promise<void>;
  }): Promise<WorkspaceFileRewindApplyResult>;
  sampleModel(
    input: import("./methods/sample-model.js").SampleModelInput,
    options: { abortSignal: AbortSignal; traceContext?: TraceContext },
  ): Promise<import("@zcode/shared/mcp-apps").McpAppsSamplingResult>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<WorkspaceGenerateTextResult>;
  testModelConnectivity(
    input: ModelConnectivityTestInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  isProjectMemoryEnabled(): boolean;
  /** Wait up to 60 seconds by default; null waits for all scheduled extractions without a drain deadline. */
  drainMemoryExtractions(timeoutMs?: number | null): Promise<void>;
  drainBackgroundDreams(timeoutMs?: number): Promise<void>;
}

installAgentRuntimeMethods(AgentRuntime);
