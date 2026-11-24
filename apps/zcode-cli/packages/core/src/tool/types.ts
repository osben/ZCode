import type {
  ErrorAttribution,
  ModelCallWrapper,
  ToolSearchExecutionContext,
  WaitForMcpServersOutput,
  InputPreemptionControl,
  InputPreemptionHandling,
} from "@zcode/contracts";
import type { SessionControlBinding } from "./session-control/contract.js";
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
  PluginDiscoveryPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  ExecutionShellSelection,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  JsonSchema,
  Logger,
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
  SubagentIdentity,
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
  WorkflowWebSearchBudgetPort,
  WorkflowPort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { LspService } from "../lsp/service.js";
import type { SystemReminderSource } from "../system-reminder/source.js";
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

/**
 * Agent 工具写进父 transcript tool part 的子代理事实。身份（含输出文件）在 child session 就绪时记下；
 * launch 返回 `async_launched` 时再记一次，带上 `background`。
 */
export interface SubagentToolPartFacts extends SubagentIdentity {
  background?: true;
}

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

/** executor 侧的输入抢占接管点：工具经 `register` 注册判断函数，executor 用 `decide` 取结果。 */
export interface InputPreemptionSlot extends InputPreemptionControl {
  /** 没有注册判断函数时返回 `cancel`。 */
  decide(): InputPreemptionHandling;
}

/**
 * 工作流工具面的未激活形态（docs/dynamic-workflow/launch.md「On demand: activation」）。
 * - `none`：不是「按需且未激活」（disabled、alwaysOn、已激活）。
 * - `session`：有 `/workflow` 入口的会话，用户发命令后工具会出现在本会话。
 * - `subagent`：子 runtime（Agent 子代理、`/expert` 等 workflow 子会话）。未激活状态是创建时从父配置
 *   带来的，自己没有命令入口，本会话的工具面不会再变。
 */
export type DynamicWorkflowToolSurfaceDeferral = "none" | "session" | "subagent";

export interface ToolExecutionContext {
  toolSearch?: ToolSearchExecutionContext;
  toolCallId: string;
  /**
   * Live observability writer for the current Tool. Handlers can write facts only through this narrow interface, not access raw OTel spans.
   */
  telemetry?: ToolExecutionSpanWriter;
  /**
   * Runtime 日志。只给需要记录工具内部事实（如 Bash 子进程 pid）的 handler 用，
   * 工具调用开始/结束的通用日志仍由 executor 写。
   */
  logger?: Logger;
  /** 当前工具调用是否属于 automation 派发轮；写工具 handler 用它做最终权限校验。 */
  automationTurn?: boolean;
  /** The automationId of this turn injected by Host admission; the only pause target of CronPauseSelf, never taken from model input. */
  automationId?: string;
  /** Whether this tool call belongs to an off-peak task dispatch turn; OffPeakCreate uses it for the final denial check. */
  offPeakTurn?: boolean;
  traceContext?: TraceContext;
  traceId: TraceId;
  spanId?: string;
  parentSpanId?: string;
  abortSignal: AbortSignal;
  /**
   * 本次调用的输入抢占接管点（executor 每次调用新建）。只有 Agent handler 把它传给 SubagentPort；
   * 其他工具不注册判断函数，立即发送时照旧取消。这里只暴露 register：判断函数有副作用
   * （能转后台时会把前台 Agent 转入后台），只由 executor 在立即发送到达时调用。
   */
  inputPreemption?: InputPreemptionControl;
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
  /** 工作流 actor 每个 ask 的 WebSearch 预算；仅在 workflow actor 会话注入，缺席即无上限。 */
  webSearchBudget?: WorkflowWebSearchBudgetPort;
  artifactStore?: ToolArtifactStorePort;
  /** 仅可信根会话装配；子代理不继承此控制权。 */
  sessionControl?: SessionControlBinding;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  pluginDiscoveryPort?: PluginDiscoveryPort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** Workflow-run submission port; if absent, CreateWorkflow returns a placeholder diagnostic without starting. */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  /** Synchronous DWF snippet execution port; if absent, EvalWorkflowSnippet returns a business failure for unavailable capability. */
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** Model-catalog port; if absent, ListModels reports unavailable capability and CreateWorkflow rejects subagent_model. */
  modelCatalogPort?: ModelCatalogPort;
  /** WaitForMcpServers 的端口；缺席则该工具报能力缺席。 */
  mcpServerWaitPort?: McpServerWaitPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  recordReadFileStateMetadata?: (metadata: PersistedReadFileStateMetadata) => void;
  /** Records the subagent facts derived by this call; the executor attaches the last record (for both success and failure results), and settlement writes it into the tool part. */
  recordSubagent?: (facts: SubagentToolPartFacts) => void;
  /** Record resolved Skill metadata for telemetry only; does not change model-visible results. */
  recordSkillTelemetryMetadata?: (metadata: SkillTelemetryMetadata) => void;
  /**
   * 「本会话的工作流工具面此刻是不是按需且尚未激活、是哪一种」的同步只读探针（handlers/skill.ts 的
   * 未激活提示）。runtime 直接读它自己的 `dynamicWorkflowToolsActivated`，这里不存任何副本。缺席 =
   * 调用方不参与（单元测试直接造的 context、没有 runtime 的嵌入方），不加提示——与技能门「探针缺席
   * 不生效」同一约定。
   */
  getDynamicWorkflowToolSurfaceDeferral?: () => DynamicWorkflowToolSurfaceDeferral;
  bashShellSelection?: ExecutionShellSelection;
  embeddedSearch?: ToolEmbeddedSearchContext;
  /** Live session cwd from its owner; `workingDirectory` is the snapshot this call started from. */
  getWorkingDirectory?: () => string;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  workingDirectory: string;
  workspaceRoot: string;
  workspaceIdentity?: string;
  /** 会话所属 workspace 的 key；受管 worktree 会话 = 项目，不等于 workingDirectory。 */
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  memoryRoot?: string;
  runtimeScope?: ToolRuntimeScope;
  /** 本 runtime 是前台启动的子代理；后台 Bash 据此说明最终回复之后不会再有通知。 */
  syncSubagent?: boolean;
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
  /**
   * 模型看到的正文。工具执行时写入的记录都有；冷恢复或 rewind 从新快照重建的记录只带
   * contentSha256，没有正文。
   * 比较内容一律用 read-file-state.ts 的 readFileStateContentMatches。
   */
  content?: string;
  /** 正文的 sha256（read-file-state.ts 的 hashReadFileStateContent）；只有冷恢复或 rewind 从新快照重建的记录带它。 */
  contentSha256?: string;
  offset?: number;
  limit?: number;
  isPartialView: boolean;
  readAt: Date;
  sourceTool?: PersistedReadFileStateTool;
  /**
   * The original spelling of `file_path` in the tool input; present only when it differs from path. Read permission
   * rules match against the original string, so compaction restore evaluates deny once with it and once with path
   * (see file restore in rewind-compact.md).
   */
  requestedPath?: string;
  revisionId?: string;
  mtimeMs?: number;
  sizeBytes?: number;
  /** Written by context at session start (MEMORY.md index); in-process only, never put into tool part metadata. */
  seededFromContext?: true;
  /** Written from a tool part snapshot on cold resume; in-process only. Compaction orders files to restore by read time. */
  restoredFromSession?: true;
}

/** The key is `createReadFileStatePathKey(path)`: one entry per file. */
export type ReadFileStateMap = Map<string, ReadFileStateEntry>;

// -----------------------------------------------
// Tool Handler
// -----------------------------------------------

/**
 * Runtime port for WaitForMcpServers. The session view is the only source of state: the port only selects targets by name, waits for them to leave
 * the connecting state and classifies them, and never starts a connection or authorization. When servers is omitted it waits for all pending ones; with none pending it reports the failed servers.
 */
export interface McpServerWaitPort {
  waitForServers(
    servers: readonly string[] | undefined,
    signal?: AbortSignal,
  ): Promise<WaitForMcpServersOutput>;
}

// Tool handlers use this return value for expected business failures; successful output does not use this reserved shape.
export interface ToolHandlerFailure {
  result: false;
  errorCode: number;
  message: string;
}

export interface ToolInputValidationContext {
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  /** 与 handler 相同的执行端口；Bash 用它判断后台是否可用。 */
  executionPort?: ExecutionPort;
  /** 与 handler 相同的 shell 选择；CMD 下不按 Bash 语法判断。 */
  bashShellSelection?: ExecutionShellSelection;
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
  /**
   * provider contract 已冻结后，把 advertisement entry 原子切换为当前 live execution entry。
   * 该步骤发生在输入校验、Hook 和权限判断之前，不能改变 provider-visible contracts。
   */
  resolveForExecution?: (input: {
    signal?: AbortSignal;
  }) => Promise<{ status: "ready"; entry: ToolEntry } | { status: "unavailable"; message: string }>;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  handler: ToolHandler;
  /**
   * 调用在 handler 返回之前超时或取消时，追加给模型的对账说明（规格 0.15）；返回 undefined 不追加。
   *
   * 只服务「请求可能已被受理、但回执没能送回」的写操作：它们靠回执把请求身份交给模型，回执送不回来，
   * 模型就拿不到身份，只能另起新请求，于是重复执行。执行器只在超时与执行中取消这两种错误上调用它。
   */
  describeUnsettledCall?: (input: unknown, toolCallId: string) => string | undefined;
  /**
   * 工具调用失败时（handler 抛错，或之后的结果处理阶段报错）追加给模型的补充文本，接在错误原文之后；
   * 返回 undefined 不追加。只进入 `ToolExecutionResult.modelContent`，不改 `error.message`、工具错误事件和日志。
   * 在执行器的失败分支里同步调用，不得抛错：抛错会让这次失败结果生成不出来。
   */
  formatErrorModelContent?: (error: unknown) => string | undefined;
  /** 当前 turn 模型能力对 provider descriptor 与 executor schema 的同源投影。 */
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
  /**
   * Returns true when formatModelContent has already bounded the length of this output itself (for example, a failed
   * Bash result keeps its head and tail by character count); the serializer then no longer persists or truncates
   * such output according to resultBudget.
   */
  isModelContentBounded?: (output: unknown) => boolean;
  /** A notice placed right after this batch of results once the tool batch settles; not part of tool_result (for example, the truncation note for a Read partial view). */
  formatBatchNotice?: (output: unknown) => ToolBatchNotice | undefined;
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

export interface ToolBatchNotice {
  source: SystemReminderSource;
  content: string;
}

export interface ToolExecutionResult {
  toolCallId: string;
  toolName: string;
  success: boolean;
  output: unknown;
  turnControl?: ToolExecutionTurnControl;
  followUpUserInput?: ToolExecutionFollowUpUserInput;
  display?: ToolResultDisplayPayload;
  modelContent?: ModelMessageContent;
  /**
   * Additional context a tool Hook gives the model; each entry is already written as
   * `<Event>:<ToolName> hook additional context: …`. It is not part of the tool result; settlement writes each entry
   * as a `tool_hook_context` attachment after this batch of tool results.
   */
  hookAdditionalContexts?: string[];
  readFileStateMetadata?: PersistedReadFileStateMetadata;
  /** Agent 调用派生的子代理事实（child session 就绪后才有）；成功与失败结果都带。 */
  subagent?: SubagentToolPartFacts;
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
