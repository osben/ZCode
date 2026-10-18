import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type {
  AgentTelemetryRuntimeOwner,
  AutomationPort,
  BackgroundTaskCancelResult,
  BrowserControlPort,
  CollaborationMode,
  ContextSourcePort,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItemsResult,
  DynamicWorkflowRunEventsResult,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunSessionSummary,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  ExecutionPort,
  ExecutionShellSelection,
  FileSystemPort,
  GoalStatus,
  HttpClientPort,
  ImageProcessorPort,
  InputDelivery,
  InputHistoryEntry,
  InputHistoryKind,
  InputHistoryStorePort,
  LoggerFactory,
  McpListResourceTemplatesResult,
  McpListResourcesResult,
  McpPort,
  McpReadResourceResult,
  McpServerStatus,
  McpToolCallResult,
  MessageWithParts,
  ModelSelection,
  ModelToolCall,
  ModelUsage,
  OffPeakPort,
  TopicResourcePort,
  PdfDocumentPort,
  PermissionBrokerPort,
  PluginLoadOutcome,
  PluginMetadata,
  PluginReferenceCatalog,
  ProviderEndpointRoutingPort,
  QueryId,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionGoal,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  SkillLoadOutcome,
  SkillPort,
  SupportedLocale,
  TodoItem,
  ToolArtifactReadResult,
  ToolArtifactStorePort,
  TraceContext,
  TurnId,
  TurnInputIntentMetadata,
  TurnSteerResult,
  UiLocale,
  UiThemePalette,
  UiThemePreference,
  WorkflowEvent,
  WorkflowRunListItem,
  WorkspaceHookPolicy,
} from "@zcode/contracts";
import type {
  AgentRuntime,
  AgentRuntimeConfig,
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
  ExecuteTurnOptions,
  ExpertWorkflowCommandResult,
  McpAppProvidedToolDefinition,
  McpAppProvidedToolExecutor,
  ModelExecutionContext,
  PresentationSurface,
  ProviderRuntimeHeadersPort,
  ResumeSessionResult,
  StartSavedWorkflowRunResult,
  TurnAttachment,
  TurnResult,
  WorkflowAgentRunner,
  WorkspaceCheckpointSummary,
  WorkspaceForkResult,
  WorkspaceGenerateTextInput,
  WorkspaceHookPolicyProvider,
  WorkspaceHookReviewTarget,
} from "@zcode/core";
import type {
  BackgroundBashOutputResult,
  SubagentRuntimeConfig,
  ZCodeModelOption,
  ZCodeToolExecResource,
} from "@zcode/shared";
import type { McpAppsToolVisibility } from "@zcode/shared/mcp-apps";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { ModelProviderSourceTitle } from "../model-config.js";
import type { ZCodeInstalledPluginData } from "../plugins.js";
import type { SessionTranscriptMessage } from "../session-transcript.js";
import type { NodeReplBrowserBroker } from "./node-repl-browser-broker.js";
import type { LspRuntimeHub } from "./lsp-runtime-hub.js";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-controller.js";
export type { ZCodeModelOption } from "@zcode/shared";

export interface WorkspaceHookReviewHostContext {
  taskId: string;
  runId: string;
  workspaceLabel: string;
  remoteSessionId?: string;
}

export type RespondWorkspaceHookReviewInput = WorkspaceHookReviewTarget & {
  decision: WorkspaceHookReviewDecision;
};

export type ToggleWorkspaceHookReviewItemInput = WorkspaceHookReviewTarget & {
  reviewItemId: string;
  enabled: boolean;
};

export type RevokeWorkspaceHookTrustInput =
  | (WorkspaceHookReviewTarget & { reviewItemIds: string[] })
  | WorkspaceHookTrustRevokeTarget;

/** New Sessions may use the Environment default selection; restored Sessions may remain unbound without a default model. */
export type ZCodeAppRuntimeConfigInput = AgentRuntimeConfig;

export interface ZCodeAppOptions {
  sessionId?: SessionId;
  /**
   * Process-wide language server pool and preferences (protocol mode). Plain CLI runs omit it and
   * the app creates and owns a private hub for its own lifetime.
   */
  lspRuntimeHub?: LspRuntimeHub;
  resume?: boolean;
  version?: string;
  traceContext?: TraceContext;
  runtimeConfig?: ZCodeAppRuntimeConfigInput;
  /**
   * In stdio protocol mode, the Electron host launches the agent process, so model services need
   * to see the electron source. Regular CLI does not pass this and continues using the cli default.
   */
  sourceTitle?: ModelProviderSourceTitle;
  /** Read local Host source documents; keep the startup configuration when this capability is absent. */
  readSubagentRuntimeConfig?: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<SubagentRuntimeConfig>;
  eventStore?: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  inputHistoryStore?: InputHistoryStorePort;
  modelAdapter?: AiSdkModelAdapter;
  /** Registry owned by the worker process; App borrows it and does not release it. */
  providerRegistry: ProviderRegistryModelSource;
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  /** Environment default selection for new Sessions; used for initialization only when runtime modelSelection is not explicit. */
  configuredDefaultModelSelection?: ModelSelection;
  modelIoFullRetentionEnabled?: boolean;
  /** Same-process embedded hosts may inject the full borrowed process-level Owner; Endpoint config must not override it. */
  telemetryOwner?: AgentTelemetryRuntimeOwner;
  providerEndpointRoutingPort?: ProviderEndpointRoutingPort;
  /**
   * Provider runtime headers port: the main runtime reports its own session on every call;
   * child runtimes always obtain a derived instance from the parent runtime.
   */
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  loggerFactory?: LoggerFactory;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  executionPort?: ExecutionPort;
  /** Resource-telemetry side channel; injected by the protocol host and shared by main-task and workflow execution adapters. */
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  /** browser-use control port; when injected, node_repl's agent.browsers.* is available. Unavailable by default. */
  browserControlPort?: BrowserControlPort;
  /** Process-level node_repl Browser broker injectable by the protocol host; the app creates and owns it by default. */
  nodeReplBrowserBroker?: NodeReplBrowserBroker;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  artifactStore?: ToolArtifactStorePort;
  contextSourcePort?: ContextSourcePort;
  /** Injected only by the protocol host; the regular CLI does not load the built-in visualize skill. */
  includeVisualize?: boolean;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  /** Per-app lease supplied by the host; the resulting port is owned by the app. */
  mcpPortFactory?: (input: { workingDirectory?: string }) => McpPort;
  permissionBroker?: PermissionBrokerPort;
  eventSink?: SessionEventSink;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  uiDetectedLocale?: string | null;
  uiLocale?: UiLocale;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  /** Resolve once on the first real user execution or cold-resume fallback, then cache for the app lifetime. */
  resolveInitialBashShellSelection?: () => Promise<ExecutionShellSelection | undefined>;
  /** Trusted embedder policy; workspace/project files cannot populate this field. */
  workspaceHookPolicy?: WorkspaceHookPolicy;
  /** Protocol Host-owned provider shared by session Runtime and no-session Settings pretrust. */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** Rollout gate; false keeps project Hooks hard-blocked and does not read Trust records. */
  workspaceHookTrustEnabled?: boolean;
  /** Presence means this owner Host supports the dedicated Workspace Hook review route. */
  workspaceHookReviewHost?: WorkspaceHookReviewHostContext;
}

export interface SubmitPromptOptionsBase {
  traceContext?: TraceContext;
  abortSignal?: AbortSignal;
  inputId?: string;
  queryId?: QueryId;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** Internal admission observation point: means only that the runtime sink saw TurnStarted, not that the projection applied it. */
  onTurnStartedObserved?: (event: SessionEvent) => void;
  /** Remove a tool from the provider tool list for the current turn only; does not permanently change the session runtime. */
  toolDisallowlist?: readonly string[];
  /** Read-only provider-only IAB environment state provided by the App; not added to the UI transcript. */
  browserAmbientContext?: ExecuteTurnOptions["browserAmbientContext"];
  /** Per-execution constraint for the standard Selection; not included in Session Selection or persistence. */
  modelExecution?: ModelExecutionContext;
}

export type SubmitPromptOptions = SubmitPromptOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

export type PrepareUserExecutionBoundary = (
  options?: Pick<SubmitPromptOptions, "abortSignal" | "traceContext">,
) => Promise<void>;

export interface SteerTurnOptions {
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  /** Delivery semantics: queue starts a new turn on consumption; guide is inline in the current turn. Defaults to queue. */
  delivery?: "guide" | "queue";
  intent?: TurnInputIntentMetadata;
  attachments?: TurnAttachment[];
  /** Tool names hidden from the provider while consuming the current queued/guide input. */
  toolDisallowlist?: readonly string[];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  traceContext?: TraceContext;
}

export type SendInputOptions = SubmitPromptOptions & {
  inputId?: string;
  /** Presentation marker determined by the trusted consumption entry point; does not change original user content or scheduling semantics. */
  inputPresentation?: ExecuteTurnOptions["inputPresentation"];
  delivery?: InputDelivery;
  /** Product guide/queue intent for sendText; Core admission still determines whether the session is busy. */
  queueDelivery?: "guide" | "queue";
  /** Inputs like Highspeed must be deferred to a separate turn; they stay queued even if the session has become idle by admission time. */
  requireQueue?: boolean;
  requireIdle?: boolean;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
};

export interface UserPromptInput {
  text: string;
  attachments?: TurnAttachment[];
}

export type PromptInput = string | UserPromptInput;

export type SendInputResult =
  | {
      /** Core completed admission; completion is only for lifecycle cleanup, not an ACK wait boundary. */
      completion: Promise<TurnResult>;
      kind: "started_turn";
      turnId: TurnId;
    }
  | TurnSteerResult;

export interface ResumeOptions {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** Call-level materialized result for this cold restore; not cached for the app lifetime. Refresh from the returned value after compact repair. */
  persistedMessages?: MessageWithParts[];
}

export interface ZCodePluginSetResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface ZCodePluginUninstallResult {
  // null means this plugin ID is not currently installed (idempotent no-op); the caller uses it to show "not installed."
  removed: ZCodeInstalledPluginData | null;
}

export interface SetLocaleResult {
  configPath: string;
  locale: SupportedLocale;
  previousLocale: SupportedLocale;
  requestedLocale: UiLocale;
  traceId: TraceContext["traceId"];
}

export interface ZCodeApp {
  readonly sessionId: SessionId;
  readonly traceId: string;
  readonly runtime: AgentRuntime;
  respondWorkspaceHookReview(
    input: RespondWorkspaceHookReviewInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggleWorkspaceHookReviewItem(
    input: ToggleWorkspaceHookReviewItemInput,
  ): Promise<WorkspaceHookReviewCommandResult & { request?: unknown }>;
  revokeWorkspaceHookTrust(
    input: RevokeWorkspaceHookTrustInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  /** Soft gate: open the review flow on demand; safely no-op when there are no pending items. */
  requestWorkspaceHookReview(input: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  /**
   * After the Trust store is persisted, this session's coordinator does not automatically
   * update its in-memory mirror (per-session, loaded only once at creation). After task-free
   * pretrust succeeds in Settings, the server calls this method for each workspace to reload the
   * file into the coordinator and resend admission state. Otherwise, an already trusted Hook
   * continues to be rejected and the banner does not refresh.
   */
  reloadWorkspaceHookTrust(): Promise<void>;
  close?(): Promise<void>;
  getMode(): CollaborationMode;
  getModel(): string;
  /** Read the current Registry model exactly for a current-only protocol snapshot, avoiding enumeration of the whole directory. */
  getCurrentModelOption?(): ZCodeModelOption | undefined;
  /** Read-only Registry metadata; does not require a complete selection or bind an execution model. */
  getModelOption?(selection: ModelSelection): ZCodeModelOption | undefined;
  getLocale(): SupportedLocale;
  getTheme(): UiThemePreference;
  getPalette(): UiThemePalette;
  getDefaultThoughtLevel(): string | undefined;
  getThoughtLevel(): string | undefined;
  loadSessionTranscript(): Promise<SessionTranscriptMessage[]>;
  readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;
  readSubagentTranscript(
    childSessionId: string,
  ): Promise<import("./subagent-observation.js").SubagentTranscriptSnapshot>;
  readTodos(): Promise<TodoItem[]>;
  readTarget(): Promise<SessionGoal | null>;
  setCustomSessionTitle(input: { title: string; traceContext?: TraceContext }): Promise<void>;
  readToolResultArtifact(uri: string): Promise<ToolArtifactReadResult>;
  /** Atomically register complete binary content in the session artifact store after chunk transaction commit. */
  writePromptAttachment(input: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
  /** Preview a sent image/video: read its artifact or actual path inside the runtime that owns the session. */
  readPromptAttachment(input: {
    ref: string;
    mime: string;
    maxBytes: number;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** During Share selection, read only userInput attachment metadata; do not read full contents. */
  statPromptAttachment?(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** For a sent video on local Desktop, resolve an artifact-first local playback source; otherwise keep chunked reading. */
  resolvePromptAttachmentPreviewSource(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;
  setTarget(input: {
    objective: string;
    /** Original goal command submitted by the user; target stores only the objective, while the chat row displays this text. */
    displayText?: string;
    status?: GoalStatus;
    tokenBudget?: number | null;
    intent?: TurnInputIntentMetadata;
  }): Promise<SessionGoal>;
  updateTargetStatus(status: GoalStatus): Promise<SessionGoal | null>;
  clearTarget(): Promise<boolean>;
  continueActiveTarget(options?: SubmitPromptOptions): Promise<TurnResult | null>;
  recordInputHistory(
    input: PromptInput,
    kind?: InputHistoryKind,
  ): Promise<InputHistoryEntry | null>;
  recallPreviousInputHistory(skip?: number): Promise<InputHistoryEntry | null>;
  listModels(): ZCodeModelOption[];
  listThoughtLevels(): string[];
  listPlugins(): Promise<PluginLoadOutcome>;
  setPluginEnabled(plugin: string, enabled: boolean): Promise<ZCodePluginSetResult>;
  uninstallPlugin(plugin: string): Promise<ZCodePluginUninstallResult>;
  /**
   * Session-frozen Plugin identity catalog.
   * Built once from resolveStartupPlugins when the App is created and read-only afterward;
   * this is the session authority for `plugins/referenceCatalog` requests with a sessionId.
   */
  getPluginReferenceCatalog(): PluginReferenceCatalog;
  /** AgentRuntime Skill discovery snapshot for the current Session; rediscovered after runtime reconstruction on cold restore. */
  getSkillCatalog(): Promise<SkillLoadOutcome>;
  listMcpServers(): Promise<Record<string, McpServerStatus>>;
  connectMcpServer(name: string): Promise<McpServerStatus>;
  /**
   * Plugin UI: resource reads and tool calls initiated by the UI
   * go through the session's own mcpPort; ownership checks happen in the mcp-ui handler and are not repeated here.
   */
  readMcpResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpReadResourceResult>;
  onMcpAppConnectionInvalidated(serverName: string, listener: () => void): () => void;
  getMcpAppConnectionSnapshot(serverName: string): { identity: string; generation: number } | null;
  callMcpToolForUi(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<McpToolCallResult>;
  /**
   * Tool visibility based on the tools/list descriptor; returns null when the tool does not exist.
   * mcp-ui uses it to reject UI calls to model-only tools.
   */
  getMcpToolVisibility(
    serverName: string,
    toolName: string,
  ): Promise<readonly McpAppsToolVisibility[] | null>;
  /**
   * App-Provided Tools: replace this session's App tools wholesale with the given set; invalidate the tool cache so the next model request sees them.
   * Definitions whose names collide with non-App tools are skipped. Returns the model-side names actually registered.
   */
  replaceMcpAppProvidedTools(
    definitions: readonly McpAppProvidedToolDefinition[],
    execute: McpAppProvidedToolExecutor,
  ): string[];
  /** Page-initiated resources/list, resources/templates/list, and subscriptions (the caller supplies the subscriber identity). */
  listMcpResourcesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpListResourcesResult>;
  listMcpResourceTemplatesForUi(
    serverName: string,
    cursor?: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpListResourceTemplatesResult>;
  subscribeMcpResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  unsubscribeMcpResourceForUi(
    serverName: string,
    uri: string,
    subscriberKey: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /** Session close: clear all subscriptions for this session (subscriberKey prefix). */
  unsubscribeMcpResourcesForUi(subscriberKeyPrefix: string): Promise<number>;
  /** Plugin-page-initiated resources/read; same port as readMcpResource, with a separate entry point for auditing and rate limiting. */
  readMcpResourceForUi(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpReadResourceResult>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask?(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  /**
   * Paginated event log for a workflow run (detail-page audit surface). Optional capability: if
   * the dwf journal is unavailable, the run service is not constructed and this method is absent.
   * The gateway then returns a structured unsupported-capability error instead of an empty page;
   * "no events" and "this session lacks the capability" are different facts.
   *
   * cursor = journal sequence (assigned monotonically by `appendEvent`), using the same scale as
   * workflowRuns[].lastEventSequence. An out-of-range cursor returns an empty page without error.
   */
  listDynamicWorkflowRunEvents?(input: {
    runId: string;
    afterSequence?: number;
    limit?: number;
    maxBytes?: number;
  }): Promise<DynamicWorkflowRunEventsResult>;
  /**
   * Resume a dwf run. Optional capability, with the same absence condition as
   * {@link listDynamicWorkflowRunEvents}. On success, in addition to port.resume it must
   * **re-arm tracking** (runtime.trackResumedDynamicWorkflowRun). Omitting this would make the
   * resumed run uncancellable, lose its completion notification, and make the session appear
   * idle to the reclamation guard. Failures return a structured reason (not throw); all five
   * reasons are expected business branches for the caller.
   */
  resumeWorkflowRun?(input: {
    workId: string;
    name?: string;
  }): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * Start a saved workflow directly from the hub. After the GUI creates an empty session in the
   * target project, it sends `startSavedWorkflow`: the agent resolves the saved source, validates
   * arguments, and compiles. If valid, it records the user's real action in the session as a
   * controlOnly "launch turn" and starts the run with `port.submit` (no model turn or
   * `CreateWorkflow` confirmation dialog; the user's hub click is consent). Optional capability,
   * with the same absence condition as {@link resumeWorkflowRun} (not registered without a dwf
   * port; the gateway returns unsupported-capability). Failures return a structured `reason`
   * rather than throwing; all six reasons are expected caller branches. `message` carries a
   * human-readable diagnostic for inline display in the argument dialog. Failures in stages 1–2
   * happen **before any persistence** (no run, message, event, or task), so the GUI can call
   * `deleteSession` to remove the empty session; the transcript then includes only runs that
   * actually started.
   */
  startSavedWorkflow?(input: {
    name: string;
    scope?: "project" | "global";
    args?: Record<string, unknown>;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * GUI "configure": change a run's subagent model and concurrency cap by amending the same
   * script into a new run, without a model turn or confirmation dialog. Optional capability: do
   * not register if the port or its `amend` / `getScript` methods are absent (the gateway returns
   * unsupported-capability). Failures return a structured `reason`; each occurs before stopping
   * or creating anything.
   */
  amendWorkflowRunSettings?(
    input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
  ): Promise<AmendWorkflowRunSettingsResult>;
  /**
   * Enumeration surface for workflow runs (discovery query after restart). Optional capability,
   * with the same absence condition as {@link listDynamicWorkflowRunEvents}. If the journal has
   * no narrow enumeration query, return an empty list (the honest answer; in-memory journal runs
   * do not survive process exit). `resumable` is computed with the same predicate as the resume gate.
   */
  listDynamicWorkflowRuns?(input: { limit?: number }): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * Cold replay for workflow runs: replay journal entries for runs owned by this session, except
   * `excludeRunIds`, into progress-event payloads. Cold materialization feeds them to the same
   * reducer as in-memory events, keeping the `workflowRuns` projection consistent before and
   * after restart. Optional capability, with the same absence condition as
   * {@link listDynamicWorkflowRuns}.
   */
  replayDynamicWorkflowRuns?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * **User-facing artifact** read surface for workflow runs. Register all three capabilities
   * together or omit them together: they are three slices of the same journal read surface, and
   * partial presence would give the UI a card with a side panel that cannot open. Same absence
   * condition as {@link listDynamicWorkflowRunEvents}, plus all three optional port members must
   * be present.
   *
   * Terminology: artifact here means output the script publishes for the **user** through
   * `artifact.*`, not the engine-internal term for the script's top-level return value.
   *
   * Unknown runId returns `undefined` (the gateway normalizes it to not found); a run with no
   * artifacts returns an empty array.
   */
  listDynamicWorkflowRunArtifacts?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * Paginate `report` entries for a predeclared dashboard (cursor = journal sequence, strictly greater than).
   * The gateway decides `limit` and `maxBytes` before passing them here; honor them **exactly**; `hasMore` is decided by the storage layer.
   * Same absence condition as {@link listDynamicWorkflowRunArtifacts}.
   */
  listDynamicWorkflowRunArtifactItems?(input: {
    runId: string;
    artifactId: string;
    afterSequence?: number;
    limit: number;
    maxBytes: number;
    fields?: readonly string[];
  }): Promise<DynamicWorkflowRunArtifactItemsResult>;
  /**
   * Read **all** bytes for one artifact version; the gateway handles chunking (≤ 512 KiB per
   * chunk). Authorization belongs to the port implementation: the run must belong to this
   * session and the journal must contain a completed row for `(artifactId, version)`. Only then
   * read from the store using the URI from the **journal row**; never use caller-supplied IDs
   * directly as paths.
   * Return `undefined` if the version is missing, the item is a predeclared dashboard (no bytes),
   * or the store is unavailable. Same absence condition as
   * {@link listDynamicWorkflowRunArtifacts}.
   */
  readDynamicWorkflowRunArtifact?(input: {
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * Workspace transcript for a workflow run: journal rows for `files.*` / `git.*` / `world.run`.
   * Register or omit both methods together (list + bounded body for one node). Authorization is
   * in the port implementation (the run must belong to this session); return `undefined` for a
   * run owned by another session or an unknown run. Same absence condition as
   * {@link listDynamicWorkflowRunArtifacts}.
   */
  listDynamicWorkflowRunWorkspaceNodes?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(input: {
    runId: string;
    siteId: string;
    ordinal: number;
    maxBytes: number;
  }): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  disconnectMcpServer(name: string): Promise<McpServerStatus | undefined>;
  listCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkFromCheckpoint(options?: {
    targetCheckpointId?: string;
    targetMessageId?: string;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  sampleModel(
    input: Parameters<AgentRuntime["sampleModel"]>[0],
    options: Parameters<AgentRuntime["sampleModel"]>[1],
  ): ReturnType<AgentRuntime["sampleModel"]>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<{
    text: string;
    selection: WorkspaceGenerateTextInput["selection"];
    finishReason: string;
    usage?: ModelUsage;
    toolCalls?: ModelToolCall[];
  }>;
  testModelConnectivity(
    input: { selection: ModelSelection },
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  expertWorkflowStatus(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  workflowStatus?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  validateWorkflowScript?(input: { scriptPath: string }): Promise<ExpertWorkflowCommandResult>;
  runWorkflowScript?(
    input: { args?: unknown; resumeFromRunId?: string; scriptPath: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflowScript?(
    input: { runId: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  scriptWorkflowStatus?(options?: { runId?: string }): Promise<ExpertWorkflowCommandResult>;
  listScriptWorkflows?(options?: { limit?: number }): Promise<ExpertWorkflowCommandResult>;
  retryWorkflow?(options?: {
    abortSignal?: AbortSignal;
    activityId?: string;
    definitionId?: string;
    nodeId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    phase?: string;
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  listExpertWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  listWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  readExpertWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  readWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  resume(options?: ResumeOptions): Promise<ResumeSessionResult>;
  resumeExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  sendInput(input: PromptInput, options?: SendInputOptions): Promise<SendInputResult>;
  setMode(mode: CollaborationMode): Promise<{
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceId: TraceContext["traceId"];
  }>;
  setModelIoFullRetentionEnabled?(enabled: boolean): void;
  setModel(
    modelId: string | ModelSelection,
    options?: {
      /**
       * Per-turn (off-peak idle plan): true means change runtime state only—do not write the
       * persisted model selection or emit a modelChange chat notification. Used for temporary
       * turn-level switches (apply/restore as a pair).
       */
      transient?: boolean;
    },
  ): Promise<{
    model: string;
    previousModel: string;
    thoughtLevel?: string;
    traceId: TraceContext["traceId"];
  }>;
  setThoughtLevel(level: string): Promise<{
    previousThoughtLevel?: string;
    thoughtLevel: string;
    traceId: TraceContext["traceId"];
  }>;
  setLocale(locale: UiLocale): Promise<SetLocaleResult>;
  stopExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  stopWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  runExpertWorkflowBackground?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  runWorkflowBackground?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  /**
   * v4 deferred queue: when busy but there is no steerable active turn (compact / goal verifier /
   * goal continuation boundary), ordinary input must first be persisted as TurnSteerQueued; it
   * must not disappear from the composer due to runtime.steerTurn(no_active_turn/turn_not_steerable).
   */
  enqueueDeferredInput?(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  steerTurn(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  /** v4 queue item deletion: remove one queued input by pendingInputId. Returns whether it matched. */
  removeQueueItem(
    pendingInputId: string,
    options?: {
      reason?: "user_removed" | "promoted";
      reservationId?: string;
      traceContext?: TraceContext;
    },
  ): Promise<boolean>;
  /** Atomic promotion for sendQueuedNow: after reserve, ordinary drain/delete must not consume this item. */
  reserveQueueItem(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  markQueueItemPromoting(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  releaseQueueItemReservation(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue item edit: replace queued input text by pendingInputId without changing its position. Returns whether it matched. */
  editQueueItem(
    pendingInputId: string,
    newText: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue reorder: move pendingInputId before beforePendingInputId (null = end of queue). */
  reorderQueueItem(
    pendingInputId: string,
    beforePendingInputId: string | null,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 heldQueueDisposition=clearQueueAndSend: clear all queued inputs and return the number discarded. */
  clearQueueItems(options?: { traceContext?: TraceContext }): Promise<number>;
  /** v4 setAutoDrain: toggle the queue autoDrain authorization bit (session-level setting). */
  setQueueAutoDrain(autoDrain: boolean, options?: { traceContext?: TraceContext }): Promise<void>;
  /** The CLI outer layer drained the paused queue; resume core's inline drain for later running queue items. */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode: toggle followup routing mode (queue/guide, session-level setting). */
  setFollowupMode(
    mode: "queue" | "guide",
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  runExpertWorkflow(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  runWorkflow?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  submitPrompt(prompt: PromptInput, options?: SubmitPromptOptions): Promise<TurnResult>;
}

export interface ResolveLatestSessionOptions {
  directory: string;
  env?: NodeJS.ProcessEnv;
  sessionStore?: SessionStorePort;
}

export interface RunZCodeProtocolAgentOptions {
  /** The entry point owns the exit deadline; bootstrap only coordinates cancellation and cleanup, and does not exit the process directly. */
  lifecycle?: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number | undefined;
    requestShutdown(error?: Error): void;
  };
  /** Internal Desktop command: run only the existing storage preparation, then exit. */
  prepareStorageOnly?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  presentationSurface?: PresentationSurface;
  providerEndpointRoutingPort?: ProviderEndpointRoutingPort;
  version?: string;
}

export interface ListZCodeSessionsOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  sessionStore?: SessionStorePort;
}

export type { WorkflowAgentRunner };
