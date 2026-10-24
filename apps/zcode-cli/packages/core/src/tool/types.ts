import type {
  ErrorAttribution,
  ModelCallWrapper,
  ToolSearchExecutionContext,
} from "@zcode/contracts";
import type { McpToolUiDescriptor } from "@zcode/shared/mcp-apps";
// ============================================================
// Tool Types - Core tool types for registry and executor
// ============================================================

import type {
  CollaborationMode,
  FileMutationSink,
  AutomationPort,
  BrowserControlPort,
  CoordinatorResponsePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  JsonSchema,
  Model,
  ModelCatalogPort,
  ModelContentProtection,
  ModelMessageContent,
  ModelToolSideEffectScope,
  OffPeakPort,
  TopicResourcePort,
  PdfDocumentPort,
  PermissionBrokerReasonSource,
  PermissionCapabilityGroup,
  PermissionRuleBehavior,
  PermissionRuleValue,
  PermissionUpdate,
  ProviderNativeToolSpec,
  RiskLevel,
  SessionEvent,
  SessionId,
  SessionModePort,
  SessionStorePort,
  SkillPort,
  SkillTelemetryMetadata,
  SubagentPort,
  SubagentRunOptions,
  ToolArtifactStorePort,
  ToolCancellationPolicy,
  ToolContractDeclaration,
  ToolExecutionMode,
  ToolExecutionSpanWriter,
  ToolExecutionTelemetry,
  ToolResultBudgetStrategy,
  ToolResultDisplayPayload,
  ToolTimeoutPolicy,
  TraceContext,
  TraceId,
  TurnId,
  WorkflowEscalatePort,
  WorkflowPort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { LspService } from "../lsp/service.js";
import type {
  PersistedReadFileStateMetadata,
  PersistedReadFileStateTool,
} from "./read-file-state-metadata.js";

// -----------------------------------------------
// Tool Metadata
// -----------------------------------------------

export interface ToolMetadata {
  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  searchHint?: string;
  name: string;
  description?: string;
  modelInstructions?: readonly string[];
  allowedInPlanMode?: boolean;
  readOnly: boolean;
  destructive: boolean;
  concurrentSafe: boolean;
  requiresUserInteraction?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sideEffectScope: ModelToolSideEffectScope;
  riskLevel: RiskLevel;
  needsApproval: boolean;
  providerVisible?: boolean;
  /**
   * Declares that this is a terminal tool whose success ends the turn: once it returns a successful result, the executor attaches
   * turnControl to that result and ends the current turn. This is an intrinsic tool capability (like concurrentSafe/destructive),
   * read by the executor instead of guessed from the tool name at the call site. submit_result uses it for terminal actor submissions.
   */
  stopTurnOnSuccess?: boolean;
  /** Trusted display source for MCP discovery; used only for UI projection, not permission decisions. */
  mcpPresentation?: {
    serverName: string;
    toolName: string;
    description?: string;
    /** MCP server authenticated through the declared zcode_official mechanism; used only to trust structured identifiers in its results. */
    official?: boolean;
    /** Stable ID of the plugin that owns this server (`${name}@${marketplace}`); empty for non-plugin MCP servers. */
    pluginId?: string;
    /** Normalized MCP App description from the tool's `_meta`; when present, project it to display.ui (use serverName if pluginId is absent). */
    ui?: McpToolUiDescriptor;
  };
}

// -----------------------------------------------
// Tool Execution Context
// -----------------------------------------------

export type ToolRuntimeScope = "main" | "subagent";

export interface BackgroundTaskControlStopOptions {
  /** Who stopped it: TaskStop sets "model", and the terminal notification uses this to choose its wording. */
  initiator?: "user" | "model";
  strict: true;
  traceContext?: TraceContext;
}

export interface BackgroundTaskControlStopResult {
  command?: string;
  ok: boolean;
  reason?:
    | "background_task_cancel_not_supported"
    | "background_task_not_found"
    | "background_task_not_running";
  status?: string;
  taskId: string;
  type?: string;
}

export interface BackgroundTaskControlPort {
  stopBackgroundTask(
    taskId: string,
    options: BackgroundTaskControlStopOptions,
  ): Promise<BackgroundTaskControlStopResult>;
}

export interface ToolExecutionContext {
  toolSearch?: ToolSearchExecutionContext;
  toolCallId: string;
  /**
   * Live observability writer for the current Tool. Handlers can write facts only through this narrow interface, not access raw OTel spans.
   */
  telemetry?: ToolExecutionSpanWriter;
  /** Whether this tool call belongs to an automation dispatch turn; write-tool handlers use it for final permission checks. */
  automationTurn?: boolean;
  /** Whether this tool call belongs to an off-peak task dispatch turn; OffPeakCreate uses it for the final denial check. */
  offPeakTurn?: boolean;
  traceContext?: TraceContext;
  traceId: TraceId;
  spanId?: string;
  parentSpanId?: string;
  abortSignal: AbortSignal;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort?: ExecutionPort;
  /** Browser-use control port; node_repl agent.browsers.* calls execute through it. Browser is unavailable when omitted. */
  browserControlPort?: BrowserControlPort;
  /** Official browser-use plugin docs asset directory, used by agent.browsers.documentation() only when browser-use is enabled. */
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  /** Publishes FileMutated after a successful Write or Edit; the LSP document sync consumes it. */
  fileMutationSink?: FileMutationSink;
  /** Starts the language server for a file being read (acquire only, never waits). */
  lspPrewarm?: (filePath: string) => void;
  /** Language-server service for the LSP tool and edit diagnostics; absent when code intelligence is unavailable. */
  lsp?: LspService;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  /** Selection override from Core Server for a foreground child. */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  /** Port for a workflow actor to submit a terminal result and await the engine's decision; injected only into workflow-actor sessions. */
  workflowSubmitPort?: WorkflowSubmitPort;
  /** Port for a workflow actor to escalate a blocking question and await the main agent's response; injected only into workflow-actor sessions. */
  workflowEscalatePort?: WorkflowEscalatePort;
  artifactStore?: ToolArtifactStorePort;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** Workflow-run submission port; if absent, CreateWorkflow returns a placeholder diagnostic without starting. */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /** Synchronous DWF snippet execution port; if absent, EvalWorkflowSnippet returns a business failure for unavailable capability. */
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** Model-catalog port; if absent, ListModels reports unavailable capability and CreateWorkflow rejects subagent_model. */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  recordReadFileStateMetadata?: (metadata: PersistedReadFileStateMetadata) => void;
  /** Record resolved Skill metadata for telemetry only; does not change model-visible results. */
  recordSkillTelemetryMetadata?: (metadata: SkillTelemetryMetadata) => void;
  bashShellSelection?: ExecutionShellSelection;
  embeddedSearch?: ToolEmbeddedSearchContext;
  /** Live session cwd from its owner; `workingDirectory` is the snapshot this call started from. */
  getWorkingDirectory?: () => string;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  workingDirectory: string;
  workspaceRoot: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  memoryRoot?: string;
  runtimeScope?: ToolRuntimeScope;
  providerVisibleToolNames?: readonly string[];
  sessionId: SessionId;
  turnId?: TurnId;
  /**
   * Fields adjusted by the user in the confirmation dialog and applied to this input ({@link ToolEntry.applyInputAdjustments}'s
   * `applied`). The handler uses them to tell the model that execution used different values from those it supplied; absent means no adjustment.
   */
  inputAdjustments?: Readonly<Record<string, unknown>>;
}

export interface ToolEmbeddedSearchContext {
  backend?: EmbeddedSearchBackend;
  enabled: boolean;
  findAndGrepEnabled?: boolean;
}

export interface ReadFileStateEntry {
  path: string;
  content: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAt: Date;
  sourceTool?: PersistedReadFileStateTool;
  revisionId?: string;
  mtimeMs?: number;
  sizeBytes?: number;
}

export type ReadFileStateMap = Map<string, ReadFileStateEntry>;

// -----------------------------------------------
// Tool Handler
// -----------------------------------------------

// Tool handlers use this return value for expected business failures; successful output does not use this reserved shape.
export interface ToolHandlerFailure {
  result: false;
  errorCode: number;
  message: string;
}

export interface ToolInputValidationContext {
  runtimeTaskRegistry?: RuntimeTaskRegistry;
}

export type ToolInputValidationResult = { result: true } | ToolHandlerFailure;

/**
 * Context for {@link ToolEntry.resolveInput}. Keep it limited to what parsing needs—the working directory is the only entry point
 * for locating project files. Adding more would turn a normalization hook into a second execution entry point.
 */
export interface ToolInputResolutionContext {
  workingDirectory?: string;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  /**
   * Workflow-run port and this session's ID: AmendWorkflow uses them to resolve `run_id` into facts about whether the predecessor belongs
   * to this session and is still running. This remains read-only—the normalization hook does not become a second execution entry point.
   */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /**
   * Model-catalog port: CreateWorkflow / AmendWorkflow use it to resolve `subagent_model` into canonical form; if it cannot be resolved,
   * return a business failure **before** the confirmation dialog.
   * It is synchronous and read-only, so it belongs here for the same reason as `dynamicWorkflowRunPort`. If it is absent, reject any supplied field—
   * do not silently allow a string the host cannot resolve.
   */
  modelCatalogPort?: ModelCatalogPort;
  sessionId?: string;
  /**
   * Probe for “is a skill loaded in this session now?” (handlers/workflow-skill-gate.ts). Runtime answers from provider-visible history
   * (agent/loaded-skills.ts), so after compaction the answer becomes false along with the history. Absent means this session has no Skill tool or the caller does not participate (for example, a test-created context), so the gate does not apply.
   */
  hasLoadedSkill?: (skillName: string) => boolean;
}

export type ToolInputResolutionResult = { result: true; input: unknown } | ToolHandlerFailure;

/**
 * Result of {@link ToolEntry.applyInputAdjustments}: adjusted input and the subset of changes that **actually took effect**
 * (keys match input field names; changes identical to original values do not count). Missing `applied` means nothing changed.
 */
export type ToolInputAdjustmentResult =
  | { result: true; input: unknown; applied?: Readonly<Record<string, unknown>> }
  | ToolHandlerFailure;

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: ToolExecutionContext,
) => Promise<TOutput>;

// -----------------------------------------------
// Tool Entry
// -----------------------------------------------

export interface ToolEntry extends ToolContractDeclaration {
  /** Bind host resources before approval; release them on every return path and route revocation through the existing cancellation chain. */
  retainExecution?: (callId: string) => { signal: AbortSignal; release(): void };
  aliases?: readonly string[];
  /**
   * Host-issued atomicity policy for model content. Only an authority-verified
   * registration path may set this; executor code must never infer it from a
   * tool name or from model-visible content.
   */
  modelContentProtection?: ModelContentProtection["kind"];
  /**
   * Optional provider-visible character threshold for tools whose upstream contract
   * budgets UTF-16 characters rather than UTF-8 bytes.
   */
  maxModelChars?: number;
  /**
   * MIME type for provider-visible model content persisted by the result budget.
   * Defaults to the handler result shape when omitted.
   */
  resultArtifactContentType?: string;
  metadata: ToolMetadata;
  /**
   * Written only by a host-validated trusted source; never infer it from a model-visible MCP name or descriptor.
   */
  permissionCapabilityGroup?: PermissionCapabilityGroup;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  handler: ToolHandler;
  /** Projection of the current turn's model capabilities shared by the provider descriptor and executor schema. */
  resolveModelContract?: (context: ToolExecutionModelContext) => {
    description?: string;
    inputSchema?: JsonSchema;
  };
  validateInput?: (
    input: unknown,
    context: ToolInputValidationContext,
  ) => ToolInputValidationResult;
  /**
   * **Normalize model-supplied input into the execution facts that will take place.** The executor calls this after `validateInput`
   * and before the PreToolUse hook; its return value directly replaces `executionInput`.
   *
   * Its position is essential. Hooks, project permission rules, permission-event payloads, `prepareApproval`, and the handler
   * all read the same normalized input, accomplishing three things:
   *   1. Policies cannot be bypassed—a PreToolUse hook that scans scripts sees the actual script in saved runs too.
   *   2. It is visible across versions—the input channel passes through without a schema for every client version, unlike the display channel.
   *   3. Approval and execution use the same bytes—parse once and pass that value to the handler, so A cannot be approved while B runs.
   *
   * The return value must still satisfy `inputSchema` / `runtimeInputSchema` (the executor validates again after hook rewrites).
   * Return {@link ToolHandlerFailure} for parse failures; the executor handles them before hooks. This is a business failure, not an infrastructure fault,
   * and should not interrupt the user for confirmation first.
   */
  resolveInput?: (
    input: unknown,
    context: ToolInputResolutionContext,
  ) => Promise<ToolInputResolutionResult> | ToolInputResolutionResult;
  /**
   * Apply user changes to input from the confirmation dialog (docs/dynamic-workflow/launch.md, “Adjusting the settings in
   * the window”). The executor calls this after authorization and before the handler; `adjustments` is the broker result's
   * `inputAdjustments`. Returned input must retain the shape produced by `resolveInput`—handlers have no separate adjustment path;
   * on failure, fail the tool and do not run the handler. Synchronous: read only ports already in context; perform no I/O.
   * Tools without this method ignore all adjustments.
   */
  applyInputAdjustments?: (
    input: unknown,
    adjustments: Readonly<Record<string, unknown>>,
    context: ToolInputResolutionContext,
  ) => ToolInputAdjustmentResult;
  formatModelContent?: (output: unknown) => ModelMessageContent;
  formatPersistedModelContent?: (
    input: ToolPersistedModelContentInput,
  ) => ModelMessageContent | undefined;
  resolveTimeoutBudgetMs?: (
    input: unknown,
    context?: ToolExecutionModelContext,
  ) => number | undefined;
  resolvePermissionCapability?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolRuntimePermissionCapability | undefined;
  resolvePermissionRulePolicy?: (
    input: unknown,
    context?: ToolRuntimePermissionCapabilityContext,
  ) => ToolPermissionRulePolicy | undefined;
  /**
   * Last word on an `ask` decision, owned by the tool. Runs after the permission service
   * has already decided to ask, so it can only narrow the ask to a pass (`proceed`) or
   * enrich it with a preview — it can never turn an allow into an ask.
   *
   * Synchronous like the other permission hooks: it inspects the input the executor
   * already holds and must not perform I/O on the approval path. A tool that needs to
   * read the world before it can build a preview belongs in {@link resolveInput}, which
   * runs earlier, is async, and whose result the whole downstream chain shares.
   */
  prepareApproval?: (input: unknown) => ToolApprovalGate;
  inputSchema: JsonSchema;
  runtimeInputSchema?: unknown;
  runtimeOutputSchema?: unknown;
  timeout: ToolTimeoutPolicy;
  cancellation: ToolCancellationPolicy;
}

export type ToolApprovalGate =
  | { gate: "proceed" }
  | { gate: "ask"; display?: ToolResultDisplayPayload };

export interface ToolPermissionRulePolicy {
  evaluateRules: (
    behavior: PermissionRuleBehavior,
    rules: readonly PermissionRuleValue[],
  ) => boolean;
  suggestedPermissionUpdates: PermissionUpdate[];
}

export interface ToolPersistedModelContentInput {
  output: unknown;
  content: string;
  persistedPath: string;
  originalBytes: number;
}

export interface ToolRuntimePermissionCapability {
  userApprovalRule?: string;
  allowedInPlanMode?: boolean;
  /** Input-aware override of `metadata.concurrentSafe`, consumed by tool scheduling. */
  concurrentSafe?: boolean;
  destructive?: boolean;
  needsApproval?: boolean;
  readOnly?: boolean;
  requiresUserInteraction?: boolean;
  riskLevel?: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  permission?: Partial<ToolContractDeclaration["permission"]>;
}

export interface ToolRuntimePermissionCapabilityContext {
  mode?: CollaborationMode;
  bashShellSelection?: ExecutionShellSelection;
  runtimeScope?: ToolRuntimeScope;
  workingDirectory?: string;
  workspaceRoot?: string;
}

export interface ToolExecutionModelContext {
  model?: Model;
}

// -----------------------------------------------
// Execution Results
// -----------------------------------------------

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  output: unknown;
  turnControl?: ToolExecutionTurnControl;
  followUpUserInput?: ToolExecutionFollowUpUserInput;
  display?: ToolResultDisplayPayload;
  modelContent?: ModelMessageContent;
  readFileStateMetadata?: PersistedReadFileStateMetadata;
  serialization?: ToolResultSerialization;
  /** Internal performance facts aggregated by the executor; not part of model-visible Tool Output. */
  performance?: ToolExecutionTelemetry;
  error?: {
    /** Safe provider facts only; never ids, URLs or credentials. */
    attribution?: ToolErrorAttribution;
    code?: string;
    detail?: string;
    type: string;
    message: string;
    reasonSource?: PermissionBrokerReasonSource;
    stack?: string;
  };
  durationMs: number;
  startedAt: Date;
  completedAt: Date;
}

export type ToolErrorAttribution = Pick<
  ErrorAttribution,
  "providerErrorCode" | "retryable" | "source" | "statusCode"
>;

export interface ToolExecutionFollowUpUserInput {
  input: string;
  reasonSource: PermissionBrokerReasonSource;
}

export interface ToolExecutionTurnControl {
  reason: "automation_create_limit" | "plan_exit_denied" | "subagent_terminal";
  stopTurnAfterResult: boolean;
}

export interface ToolResultSerialization {
  content: string;
  modelContent?: ModelMessageContent;
  originalBytes: number;
  /**
   * Bytes actually included in the model request. In protected structured CUA frames, image blocks in serialized text
   * render as short placeholders, but the real base64 raster is sent unchanged. Therefore this value is serialized text
   * bytes plus actual media payload; cost/usage telemetry (setOutputBytes, turn-tool-usage,
   * usage-observability) must count images. This aggregate is the only public metering state.
   */
  returnedBytes: number;
  truncated: boolean;
  budgetStrategy: ToolResultBudgetStrategy;
  artifactPath?: string;
}

export interface ToolBatchResult {
  toolCallId: string;
  results: ToolExecutionResult[];
  allSucceeded: boolean;
}

// -----------------------------------------------
// Executable Tool Call
// -----------------------------------------------

export interface ExecutableToolCall {
  modelCallWrapper?: ModelCallWrapper;
  id: string;
  name: string;
  input: unknown;
}

// -----------------------------------------------
// Batch Events
// -----------------------------------------------

export type ToolBatchEvent =
  | { type: "batch_start"; parallelGroupIndex: number; toolCallIds: string[] }
  | {
      type: "batch_complete";
      parallelGroupIndex: number;
      results: ToolExecutionResult[];
    }
  | { type: "tool_start"; toolCallId: string }
  | { type: "tool_complete"; result: ToolExecutionResult }
  | { type: "error"; error: Error; toolCallId?: string };
