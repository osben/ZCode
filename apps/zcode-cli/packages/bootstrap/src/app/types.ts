import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ExternalAgentTurnHost } from "../acp-agent/acp-external-agent-host.js";
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

/** A new Session may use the Environment's default selection; a resumed Session may stay unbound — no default model is filled in. */
export type ZCodeAppRuntimeConfigInput = AgentRuntimeConfig;

export interface ZCodeAppOptions {
  /**
   * Turn drivers of ACP agent providers and the release of their resident processes on session close
   * (specs/acp-agent-runtime.md "Chat delegation (phase 4)"). Absent outside the protocol worker.
   */
  externalAgents?: ExternalAgentTurnHost;
  /** Input default edited by the standalone CLI's config menu; other assemblies keep explicit Session config semantics. */
  modelSelectionMode?: "cli-default";
  /** Passed in by the Host when the running instance is created; not refreshed while running. */
  additionalDirectories?: readonly string[];
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
   * In stdio protocol mode the agent process is launched by the Electron host, and the model
   * service needs to see the electron origin.
   * The plain CLI does not pass it and keeps the cli default.
   */
  sourceTitle?: ModelProviderSourceTitle;
  /** Local Host source-document reading; without this capability the startup config is kept. */
  readSubagentRuntimeConfig?: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<SubagentRuntimeConfig>;
  eventStore?: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  inputHistoryStore?: InputHistoryStorePort;
  modelAdapter?: AiSdkModelAdapter;
  /** A Registry owned by the worker process; the App only borrows it and does not release it. */
  providerRegistry: ProviderRegistryModelSource;
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  /** The Environment's default selection for new Sessions; participates in initialization only when there is no explicit runtime modelSelection. */
  configuredDefaultModelSelection?: ModelSelection;
  modelIoFullRetentionEnabled?: boolean;
  /** An in-process embedding host may inject a full borrowed process-level Owner; Endpoint config must not override it. */
  telemetryOwner?: AgentTelemetryRuntimeOwner;
  providerEndpointRoutingPort?: ProviderEndpointRoutingPort;
  /**
   * Provider runtime headers port: the main runtime reports its own session per call; a child
   * runtime always obtains a derived instance from the parent runtime.
   */
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  loggerFactory?: LoggerFactory;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  executionPort?: ExecutionPort;
  /**
   * Official command endpoint (technical plan 5.8): returns the endpoint address and token this
   * session's Bash/tool subprocesses must carry. workspace is this session's workspace, used by
   * the host to route when the endpoint takes identity headers.
   * Injected by the protocol host; when absent, official plugin CLIs get no identity.
   */
  officialCommandEnv?: (
    sessionId: string,
    workspace: { workspacePath: string; workspaceIdentity?: string },
  ) => Promise<Record<string, string>>;
  /** Resource telemetry bypass; injected by the protocol host and shared by the main task's and workflow's execution adapters. */
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  /** browser-use control port; once injected, node_repl's agent.browsers.* becomes available. Unavailable when absent. */
  browserControlPort?: BrowserControlPort;
  /** Process-level node_repl Browser broker injectable by the protocol host; when absent the app builds and owns its own. */
  nodeReplBrowserBroker?: NodeReplBrowserBroker;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  artifactStore?: ToolArtifactStorePort;
  contextSourcePort?: ContextSourcePort;
  /** Injected by the protocol host only; the plain CLI does not load the built-in visualize skill. */
  includeVisualize?: boolean;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  /** Per-app lease provided by the host; the resulting port belongs to the app. */
  mcpPortFactory?: (input: { workingDirectory?: string }) => McpPort;
  permissionBroker?: PermissionBrokerPort;
  eventSink?: SessionEventSink;
  onOffPeakLifecycleEvent?: (event: import("@zcode/shared").OffPeakLifecycleNotification) => void;
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
  /** Resolved once at the first real user execution or the cold-resume fallback, then cached for the app lifetime. */
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
  /** Internal admission observation point: only means the runtime sink saw TurnStarted, not that the projection has been applied. */
  onTurnStartedObserved?: (event: SessionEvent) => void;
  /** Removed from the provider tool list for the current turn only; does not permanently change the session runtime. */
  toolDisallowlist?: readonly string[];
  /** The App only reads the provided provider-only IAB environment state; it never enters the UI transcript. */
  browserAmbientContext?: ExecuteTurnOptions["browserAmbientContext"];
  /** Single-execution constraint on the standard Selection; does not enter the Session Selection or persistence. */
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
  /** Delivery semantics: queue = new turn when consumed; guide = inlined into the current turn. Defaults to queue. */
  delivery?: "guide" | "queue";
  intent?: TurnInputIntentMetadata;
  attachments?: TurnAttachment[];
  /** Tool names not exposed to the provider while the current queued/guide input is consumed. */
  toolDisallowlist?: readonly string[];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  traceContext?: TraceContext;
}

export type SendInputOptions = SubmitPromptOptions & {
  inputId?: string;
  delivery?: InputDelivery;
  /** The product's guide/queue intent of sendText; whether it is busy is still decided by Core admission. */
  queueDelivery?: "guide" | "queue";
  /** Inputs like Highspeed that must be deferred to a separate turn stay queued even if admission finds the session idle. */
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
      /** Core has finished admission; completion is for lifecycle cleanup only, not an ACK wait boundary. */
      completion: Promise<TurnResult>;
      kind: "started_turn";
      turnId: TurnId;
    }
  | TurnSteerResult;

export interface ResumeOptions {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** Call-scoped materialized result of the same cold recovery; not part of the app lifetime cache. Must be refreshed from the return value after a compact patch. */
  persistedMessages?: MessageWithParts[];
}

export interface ZCodePluginSetResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface ZCodePluginUninstallResult {
  // null means that plugin id is currently not installed (idempotent no-op); callers use it to show "not installed".
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
  /** Soft gate: opens the review flow on demand; a safe no-op when nothing is pending */
  requestWorkspaceHookReview(input: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  /**
   * After the trust store lands on disk, this session's coordinator in-memory image does not
   * refresh itself (per-session, loaded once at creation). After a Settings task-less pretrust
   * authorization succeeds, the server calls this method per workspace to reload the file into
   * the coordinator and re-emit admission state — otherwise already-trusted Hooks keep being
   * rejected and the banner does not refresh.
   */
  reloadWorkspaceHookTrust(): Promise<void>;
  /** After a settings authorization lands on disk, updates the prompts of sessions in the same workspace; does not auto-connect. */
  reloadWorkspaceMcpTrust?(): Promise<void>;
  close?(): Promise<void>;
  getMode(): CollaborationMode;
  getModel(): string;
  /** A current-only protocol snapshot reads exactly the current Registry model, avoiding enumerating the whole catalog. */
  getCurrentModelOption?(): ZCodeModelOption | undefined;
  /** Read-only Registry metadata; does not require complete options and binds no execution model. */
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
  /** After the chunk transaction commits, atomically registers the complete binary into the session artifact store. */
  writePromptAttachment(input: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
  /** Sent image/video previews: read the artifact or real path inside the runtime owning the session. */
  readPromptAttachment(input: {
    ref: string;
    mime: string;
    maxBytes: number;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** During Share selection, reads only userInput attachment metadata; full content is not read. */
  statPromptAttachment?(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** Desktop local sent videos: resolve an artifact-first local playback source; otherwise keep chunked reading. */
  resolvePromptAttachmentPreviewSource(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;
  setTarget(input: {
    objective: string;
    /** The raw goal command the user submitted; the target still stores only the objective, and the chat row displays this text. */
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
   * The Session's frozen Plugin identity catalog.
   * Built once at App creation from the resolveStartupPlugins result, read-only afterwards;
   * when `plugins/referenceCatalog` is given a sessionId, this is the session authority.
   */
  getPluginReferenceCatalog(): PluginReferenceCatalog;
  /** The current Session's AgentRuntime skill discovery snapshot; re-discovered after a cold recovery rebuilds the runtime. */
  getSkillCatalog(): Promise<SkillLoadOutcome>;
  listMcpServers(): Promise<Record<string, McpServerStatus>>;
  connectMcpServer(name: string): Promise<McpServerStatus>;
  /**
   * Plugin UI: resource reads and tool calls initiated by the UI go through the session's own
   * mcpPort; ownership checks happen in the mcp-ui handler and are not repeated here.
   */
  readMcpResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<McpReadResourceResult>;
  onMcpAppConnectionInvalidated(serverName: string, listener: () => void): () => void;
  getMcpAppConnectionSnapshot(serverName: string): { identity: string; generation: number } | null;
  waitForMcpAppConnection(
    serverName: string,
  ): Promise<{ identity: string; generation: number } | null>;
  callMcpToolForUi(
    serverName: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<McpToolCallResult>;
  /**
   * Tool visibility per the tools/list descriptor; returns null when the tool does not exist.
   * mcp-ui uses it to reject UI calls to model-only tools.
   */
  getMcpToolVisibility(
    serverName: string,
    toolName: string,
  ): Promise<readonly McpAppsToolVisibility[] | null>;
  /**
   * App-Provided Tools: wholesale-replaces this session's App tools with the given set,
   * invalidating the tool cache so the next model request sees them.
   * Definitions that collide with non-App tool names are skipped. Returns the model-side names actually registered.
   */
  replaceMcpAppProvidedTools(
    definitions: readonly McpAppProvidedToolDefinition[],
    execute: McpAppProvidedToolExecutor,
  ): string[];
  /** Page-initiated resources/list, resources/templates/list, and subscriptions (subscriber identity supplied by the caller). */
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
  /** Session close: drops all of this session's subscriptions (subscriberKey prefix). */
  unsubscribeMcpResourcesForUi(subscriberKeyPrefix: string): Promise<number>;
  /** Plugin-page-initiated resources/read; same port as readMcpResource but a separate entry for auditing and rate limiting. */
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
   * Paginated event log of a workflow run (the detail page's audit surface). Optional
   * capability: when the dwf journal is unavailable the run service is not constructed at all,
   * this method is absent with it, and the gateway returns a structured capability-unsupported
   * error rather than an empty page — "no events" and "this session lacks the capability" are
   * two different things.
   *
   * cursor = journal sequence (monotonic, allocated by `appendEvent`), the same ruler as
   * workflowRuns[].lastEventSequence; an out-of-range cursor returns an empty page, not an error.
   */
  listDynamicWorkflowRunEvents?(input: {
    runId: string;
    afterSequence?: number;
    limit?: number;
    maxBytes?: number;
  }): Promise<DynamicWorkflowRunEventsResult>;
  /**
   * Resume a dwf run. Optional capability, absent under the same conditions as
   * {@link listDynamicWorkflowRunEvents}. The success path, besides port.resume, also performs
   * **tracking re-arming** (runtime.trackResumedDynamicWorkflowRun): skipping it leaves the
   * resumed run uncancellable, loses the completion notification, and lets the reclamation
   * guard treat the session as idle. Failures return a structured reason (not a throw) — all
   * five causes are business branches the caller can expect.
   */
  resumeWorkflowRun?(input: {
    workId: string;
    name?: string;
  }): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * The hub launches a saved workflow directly. The GUI creates an empty session in the target
   * project and sends it `startSavedWorkflow`: the agent resolves the saved source + validates
   * arguments + compiles, and if clean records the user's real action into the session as a
   * controlOnly "launch turn" and starts the run via `port.submit` (no model turn, no
   * `CreateWorkflow` confirmation dialog — the user's click in the hub is the consent).
   * Optional capability, absent under the same conditions as {@link resumeWorkflowRun} (not
   * registered without a dwf port; the gateway returns a capability-unsupported error).
   * Failures return a structured `reason` (not a throw) — all six causes are business branches
   * the caller can expect, and `message` carries a human-readable diagnosis for inline display
   * in the arguments window; stage-①② failures happen **before any persistence** (no run, no
   * messages, no events, no task), so the GUI can `deleteSession` to reclaim the empty session
   * and only runs that truly started appear in the transcript.
   */
  startSavedWorkflow?(input: {
    name: string;
    scope?: "project" | "global";
    args?: Record<string, unknown>;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * The GUI's "Configure" changes a run's subagent model and concurrency cap: revises a new run
   * from the same script, with no model turn and no confirmation dialog. Optional capability:
   * not registered when the port is absent or lacks `amend` / `getScript` (the gateway returns
   * a capability-unsupported error). Failures return a structured `reason` — each happens before
   * anything is stopped or created.
   */
  amendWorkflowRunSettings?(
    input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
  ): Promise<AmendWorkflowRunSettingsResult>;
  /**
   * The workflow run enumeration surface (the post-restart discovery query). Optional
   * capability, absent under the same conditions as {@link listDynamicWorkflowRunEvents}; when
   * the journal has no narrow enumeration query it returns an empty list (the honest answer —
   * in-memory journal runs never outlive the process anyway). `resumable` is precomputed with
   * the same predicate as the resume gate.
   */
  listDynamicWorkflowRuns?(input: { limit?: number }): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * Cold replay of workflow runs: runs under this session other than `excludeRunIds` are
   * replayed from the journal as progress-event payloads, and cold materialization feeds them
   * to the same reducer as in-memory events — so the `workflowRuns` projection is identical
   * before and after a restart. Optional capability, absent under the same conditions as
   * {@link listDynamicWorkflowRuns}.
   */
  replayDynamicWorkflowRuns?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * The read surface of a workflow run's **user-facing artifacts**. The three capabilities are
   * registered together and absent together: they are three slices of the same journal read
   * surface, and having only some would hand the UI a side panel with cards that cannot be
   * opened. Absent under the same conditions as {@link listDynamicWorkflowRunEvents}, plus the
   * port's three optional members must all be present.
   *
   * ⚠ Terminology: artifact here means what the script publishes for the **user** to see via
   * `artifact.*`, not the engine's internal same-named term for the "script top-level return value".
   *
   * An unknown runId returns `undefined` (the gateway normalizes it to not found); a part-owning run returns an empty array.
   */
  listDynamicWorkflowRunArtifacts?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * Paginated `report` entries fed to a preset dashboard (cursor = journal sequence, strictly greater).
   * `limit` and `maxBytes` are fixed by the gateway before being passed down and honored here
   * **exactly**; `hasMore` is decided by the storage layer.
   * Absent under the same conditions as {@link listDynamicWorkflowRunArtifacts}.
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
   * Reads **all** bytes of one artifact version; chunking belongs to the gateway (≤ 512 KiB per
   * chunk). The authorization chain lives on the port-implementation side: the run must belong
   * to this session ∧ the journal must hold a completed row for `(artifactId, version)`, and
   * only then is the uri **from that row** read from the store — any id passed by the caller
   * never becomes a path directly.
   * A missing version / preset dashboard (no bytes) / absent store all return `undefined`.
   * Absent under the same conditions as {@link listDynamicWorkflowRunArtifacts}.
   */
  readDynamicWorkflowRunArtifact?(input: {
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * A workflow run's workspace transcript: journal rows of `files.*` / `git.*` / `world.run`,
   * the two registered together and absent together (listing + one node's bounded body).
   * Authorization is on the port-implementation side (the run must belong to this session); a
   * run that is not yours / an unknown run both return `undefined`.
   * Absent under the same conditions as {@link listDynamicWorkflowRunArtifacts}.
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
       * per-turn (off-peak idle plan): true = switch runtime state only — no disk model
       * selection write, no modelChange chat notification. Used for turn-scoped temporary
       * switches (apply/restore come in pairs).
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
   * v4 deferred queue: when busy without a steerable active turn (compact / goal verifier /
   * goal continuation boundaries), ordinary input must first land in TurnSteerQueued and must
   * not vanish from the composer because of
   * runtime.steerTurn(no_active_turn/turn_not_steerable).
   */
  enqueueDeferredInput?(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  steerTurn(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  /** v4 queue single-item delete: removes one queued input by pendingInputId. Returns whether it hit. */
  removeQueueItem(
    pendingInputId: string,
    options?: {
      reason?: "user_removed" | "promoted";
      reservationId?: string;
      traceContext?: TraceContext;
    },
  ): Promise<boolean>;
  /** sendQueuedNow atomic promotion: after reserve, ordinary drain/delete must not consume the item. */
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
  /** v4 queue single-item edit: replaces the queued input text by pendingInputId (position preserved). Returns whether it hit. */
  editQueueItem(
    pendingInputId: string,
    newText: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue reorder: moves pendingInputId to before beforePendingInputId (null = tail). */
  reorderQueueItem(
    pendingInputId: string,
    beforePendingInputId: string | null,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 heldQueueDisposition=clearQueueAndSend: clears all queued inputs, returning how many were dropped. */
  clearQueueItems(options?: { traceContext?: TraceContext }): Promise<number>;
  /** v4 setAutoDrain: toggles the queue autoDrain authorization bit (session-level config). */
  setQueueAutoDrain(autoDrain: boolean, options?: { traceContext?: TraceContext }): Promise<void>;
  /** The paused queue has been drained empty by the CLI outer layer: restore core's inline drain of the subsequent running queue. */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode: toggles the followup routing mode (queue/guide, session-level config). */
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
  /** The entry point owns the exit deadline; bootstrap only orchestrates cancellation and resource cleanup, never exits the process directly. */
  lifecycle?: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number | undefined;
    requestShutdown(error?: Error): void;
  };
  /** Desktop internal command: runs only the raw storage preparation and exits. */
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
