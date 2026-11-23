import type { ToolSearchExecutionContext } from "@zcode/contracts";
import type { SessionControlBinding } from "../session-control/contract.js";
import type {
  AgentExecutionTelemetryPort,
  AgentTelemetryActorKind,
  AutomationPort,
  BackgroundResultOriginMeta,
  BrowserControlPort,
  CollaborationMode,
  CoordinatorResponsePort,
  DynamicWorkflowRunPort,
  DynamicWorkflowSnippetPort,
  EmbeddedSearchBackend,
  ExecutionPort,
  ExecutionShellSelection,
  PluginDiscoveryPort,
  FileSystemPort,
  HttpClientPort,
  ImageProcessorPort,
  Logger,
  Model,
  ModelCatalogPort,
  OffPeakPort,
  TopicResourcePort,
  PdfDocumentPort,
  PermissionBrokerPort,
  SessionEvent,
  SessionId,
  SessionModePort,
  SessionStorePort,
  SkillPort,
  SubagentPort,
  SubagentRunOptions,
  ToolArtifactStorePort,
  TraceContext,
  TurnId,
  WorkflowEscalatePort,
  WorkflowWebSearchBudgetPort,
  WorkflowPort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { HookRunner } from "../../hooks/index.js";
import type { PermissionService } from "../../permission/service.js";
import type { LspService } from "../../lsp/service.js";
import type { RuntimeTaskRegistry } from "../../runtime-task/registry.js";
import type { ToolRegistry } from "../registry.js";
import type { NestedInstructionContext } from "../../context/nested-instructions/discover.js";
import type { ToolMetadata } from "../types.js";
import type { ToolSchedule } from "../scheduler.js";
import type {
  BackgroundTaskControlPort,
  DynamicWorkflowToolSurfaceDeferral,
  ExecutableToolCall,
  McpServerWaitPort,
  ReadFileStateMap,
  ToolBatchEvent,
  ToolEntry,
  ToolExecutionResult,
  ToolRuntimeScope,
} from "../types.js";

export interface BackgroundTaskNotificationCommand {
  originMeta?: BackgroundResultOriginMeta;
  taskId?: string;
  text: string;
  toolName?: string;
  traceContext: TraceContext;
}

export type EnqueueBackgroundTaskNotification = (
  notification: BackgroundTaskNotificationCommand,
) => undefined;

export interface BackgroundTaskNotificationPolicyInput {
  runtimeScope: ToolRuntimeScope;
  status: string;
  taskId: string;
  toolName: string;
  traceContext: TraceContext;
}

export type ShouldEnqueueBackgroundTaskNotification = (
  input: BackgroundTaskNotificationPolicyInput,
) => boolean;

export interface ToolExecutorOptions {
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryActorKind?: AgentTelemetryActorKind;
  registry: ToolRegistry;
  permissionService: PermissionService;
  permissionBroker?: PermissionBrokerPort;
  emitEvent: (event: SessionEvent) => Promise<void>;
  /** The real completion chain of background tracking (including the terminal write) belongs to the runtime and must not be lost when the tool returns. */
  registerResidencyBlockingWork?: (work: Promise<void>) => void;
  enqueueBackgroundTaskNotification?: EnqueueBackgroundTaskNotification;
  shouldEnqueueBackgroundTaskNotification?: ShouldEnqueueBackgroundTaskNotification;
  sessionId: SessionId;
  turnId?: TurnId;
  defaultTimeoutMs?: number;
  permissionTimeoutMs?: number;
  logger?: Logger;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  executionPort?: ExecutionPort;
  browserControlPort?: BrowserControlPort;
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  lsp?: LspService;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  nativeSearchEnhancementsEnabled?: boolean;
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  workflowSubmitPort?: WorkflowSubmitPort;
  /** Actor escalation port; when present, registers escalate for this session. */
  workflowEscalatePort?: WorkflowEscalatePort;
  /** actor 每个 ask 的 WebSearch 预算；缺席即无上限。 */
  webSearchBudget?: WorkflowWebSearchBudgetPort;
  artifactStore?: ToolArtifactStorePort;
  sessionControl?: SessionControlBinding;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  pluginDiscoveryPort?: PluginDiscoveryPort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** Workflow-run port; the background lifecycle provider for CreateWorkflow when looking up by tool name. */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** Model catalog port; when absent, ListModels reports the capability as unavailable and CreateWorkflow rejects subagent_model. */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState?: ReadFileStateMap;
  /** Nested AGENTS.md discovery; the runtime owns the tracker and answers history from provider-visible messages. */
  nestedInstructions?: NestedInstructionContext;
  /** Skill-gate probe (ToolInputResolutionContext.hasLoadedSkill); the runtime answers from provider-visible history. */
  hasLoadedSkill?: (skillName: string) => boolean;
  /** Skill 未激活提示的探针（ToolExecutionContext.getDynamicWorkflowToolSurfaceDeferral）；runtime 读自己的激活态。 */
  getDynamicWorkflowToolSurfaceDeferral?: () => DynamicWorkflowToolSurfaceDeferral;
  /** WaitForMcpServers 的端口；runtime 只在持有 MCP 会话时提供。 */
  mcpServerWaitPort?: McpServerWaitPort;
  /** 未注册工具报错的原因后缀（以 ". " 开头）；runtime 只对 MCP 工具给出说明。 */
  describeUnavailableTool?: (toolName: string, model?: Model) => string;
  /** 本 step registry 没有的 MCP 工具：按最新会话视图构造 entry，必要时等首次连接。 */
  resolveUnregisteredTool?: ResolveUnregisteredTool;
  subagentBackgroundBashMaxMs?: number;
  bashShellSelection?: ExecutionShellSelection;
  getBashShellSelection?: () => ExecutionShellSelection | undefined;
  workingDirectory?: string;
  workspaceRoot?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  runtimeScope?: ToolRuntimeScope;
  /** 本 runtime 是前台启动的子代理（见 RuntimeConfig.subagents.startedInForeground）。 */
  syncSubagent?: boolean;
  getWorkingDirectory?: () => string;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  getWorkspaceRoot?: () => string;
  getMemoryRoot?: () => string | undefined;
  traceContext?: TraceContext;
  mode?: CollaborationMode;
  getMode?: () => CollaborationMode;
  maxConcurrency?: number;
  hookRunner?: HookRunner;
  validateToolExecution?: (metadata: ToolMetadata) => Promise<string | undefined>;
}

export interface ToolExecutor {
  /** Use the same permission chain for MCP Apps; return approved input without running the handler or projecting model results. */
  authorizeAppTool?(
    toolCall: ExecutableToolCall,
    entry: import("../types.js").ToolEntry,
    options?: ToolExecuteOptions,
  ): Promise<unknown>;

  /**
   * Runs no hooks, shows no confirmation, and emits no events: decides per file whether a Read is denied
   * under the current mode and permission rules (all count as denied when Read is not registered).
   * Shares the same static check as Read tool calls, so the rules load once; compaction uses it to skip
   * files whose Read permission is denied when restoring files.
   */
  areReadsDeniedWithoutPrompt(
    filePaths: readonly string[],
    traceContext: TraceContext,
  ): Promise<boolean[]>;

  execute(toolCall: ExecutableToolCall, options?: ToolExecuteOptions): Promise<ToolExecutionResult>;
  executeBatch(
    toolCalls: ExecutableToolCall[],
    options?: ToolBatchExecuteOptions,
  ): Promise<ToolExecutionResult[]>;
  executeSchedule(
    toolCalls: ExecutableToolCall[],
    schedule: ToolSchedule,
    options?: ToolBatchExecuteOptions,
  ): AsyncGenerator<ToolBatchEvent, ToolExecutionResult[], void>;
  /**
   * Track a background task **not started by a tool call in this turn** (rearming a
   * resumed dwf run). `toolCall` is a descriptor synthesized by the caller (its id is
   * the original toolCallId, and its name selects the per-tool lifecycle); the tracker
   * reads only id/name/input and does not require a real in-flight tool call. It has the
   * same effects as the submit path: register in the runtime-task registry (session
   * cleanup guard), emit BackgroundTaskStarted (backgroundWorks panel + cancellable),
   * install polling/terminal waiters, and send settlement notifications. The tracker's
   * poller deduplicates repeated calls with the same taskId (idempotently).
   */
  trackExternalBackgroundTask(
    toolCall: ExecutableToolCall,
    output: Record<string, unknown>,
    traceContext: TraceContext,
    turnId?: TurnId,
  ): Promise<void>;
}

/**
 * 未注册工具的晚到解析。responseId 标识同一条 assistant 回复：回复内的调用共用等待预算。
 * 等待被取消时以 signal.reason 拒绝。
 */
export type ResolveUnregisteredTool = (
  toolName: string,
  options: { signal?: AbortSignal; responseId?: string },
) => Promise<ToolEntry | undefined>;

export interface ToolExecuteOptions {
  toolSearch?: ToolSearchExecutionContext;
  pluginDiscoveryUi?: boolean;
  /** 产生这批调用的 assistant 回复；未注册 MCP 工具的等待预算按它共享。 */
  responseId?: string;
  automationTurn?: boolean;
  automationId?: string;
  offPeakTurn?: boolean;
  signal?: AbortSignal;
  traceContext?: TraceContext;
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  model?: Model;
}

export interface ToolBatchExecuteOptions extends ToolExecuteOptions {
  maxConcurrency?: number;
}

export type { NestedInstructionContext };

export interface ToolExecutorDeps {
  agentTelemetry?: AgentExecutionTelemetryPort;
  agentTelemetryActorKind?: AgentTelemetryActorKind;
  registry: ToolRegistry;
  permissionService: PermissionService;
  permissionBroker: PermissionBrokerPort;
  emitEvent: (event: SessionEvent) => Promise<void>;
  /** The real completion chain of background tracking (including the terminal write) belongs to the runtime and must not be lost when the tool returns. */
  registerResidencyBlockingWork?: (work: Promise<void>) => void;
  enqueueBackgroundTaskNotification?: EnqueueBackgroundTaskNotification;
  shouldEnqueueBackgroundTaskNotification?: ShouldEnqueueBackgroundTaskNotification;
  sessionId: SessionId;
  turnId?: TurnId;
  defaultTimeoutMs: number;
  permissionTimeoutMs?: number;
  logger?: Logger;
  backgroundTaskControlPort?: BackgroundTaskControlPort;
  executionPort?: ExecutionPort;
  browserControlPort?: BrowserControlPort;
  browserDocumentationRoot?: string;
  fileSystemPort?: FileSystemPort;
  lsp?: LspService;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  model?: Model;
  embeddedSearchBackend?: EmbeddedSearchBackend;
  nativeSearchEnhancementsEnabled?: boolean;
  skillPort?: SkillPort;
  subagentPort?: SubagentPort;
  coordinatorResponsePort?: CoordinatorResponsePort;
  workflowSubmitPort?: WorkflowSubmitPort;
  /** Actor escalation port; when present, registers escalate for this session. */
  workflowEscalatePort?: WorkflowEscalatePort;
  /** actor 每个 ask 的 WebSearch 预算；缺席即无上限。 */
  webSearchBudget?: WorkflowWebSearchBudgetPort;
  artifactStore?: ToolArtifactStorePort;
  sessionControl?: SessionControlBinding;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  topicResourcePort?: TopicResourcePort;
  pluginDiscoveryPort?: PluginDiscoveryPort;
  sessionStore?: SessionStorePort;
  sessionModePort?: SessionModePort;
  workflowPort?: WorkflowPort;
  /** Workflow-run port; the background lifecycle provider for CreateWorkflow when looking up by tool name. */
  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  dynamicWorkflowSnippetPort?: DynamicWorkflowSnippetPort;
  /** Model catalog port; when absent, ListModels reports the capability as unavailable and CreateWorkflow rejects subagent_model. */
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry?: RuntimeTaskRegistry;
  readFileState: ReadFileStateMap;
  /** Nested AGENTS.md discovery; absent (e.g. incognito) means tool results are unchanged. */
  nestedInstructions?: NestedInstructionContext;
  /** Next sequence number for file-read snapshots; the executor owns the counter, which only increases. */
  nextReadFileStateSnapshotIndex: () => number;
  hasLoadedSkill?: (skillName: string) => boolean;
  getDynamicWorkflowToolSurfaceDeferral?: () => DynamicWorkflowToolSurfaceDeferral;
  mcpServerWaitPort?: McpServerWaitPort;
  describeUnavailableTool?: (toolName: string, model?: Model) => string;
  resolveUnregisteredTool?: ResolveUnregisteredTool;
  subagentBackgroundBashMaxMs?: number;
  bashShellSelection?: ExecutionShellSelection;
  getBashShellSelection?: () => ExecutionShellSelection | undefined;
  getWorkingDirectory: () => string;
  setWorkingDirectory?: (cwd: string) => Promise<void> | void;
  getWorkspaceRoot: () => string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: "desktop-continuous" | "web-remote-replayable";
  deliveryKind?: "desktop-continuous" | "web-remote-replayable";
  getMemoryRoot?: () => string | undefined;
  runtimeScope: ToolRuntimeScope;
  syncSubagent?: boolean;
  traceContext?: TraceContext;
  getMode: () => CollaborationMode;
  maxConcurrency: number;
  hookRunner?: HookRunner;
  validateToolExecution?: (metadata: ToolMetadata) => Promise<string | undefined>;
}
