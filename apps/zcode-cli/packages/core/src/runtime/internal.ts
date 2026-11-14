import type { LspService } from "../lsp/service.js";
import type { NestedInstructionTracker } from "../context/nested-instructions/tracker.js";
import { PermissionService, ToolScheduler } from "./deps.js";
import type { ModelRequestSessionFeature } from "@zcode/contracts";
import type { PromptSnapshot } from "./helpers/prompt-snapshot.js";
import type { TotalTokensBudgetState } from "./helpers/total-tokens-budget.js";
import type { InstructionRefreshReason } from "../context/types.js";
import type {
  Logger,
  ModelSelection,
  EventReducer,
  MessageId,
  TurnId,
  ModelToolContract,
  PermissionBrokerPort,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionMailboxPort,
  SessionStorePort,
  ContextSourcePort,
  ContextSourceSnapshot,
  ExecutionPort,
  FileSystemPort,
  HookRunner,
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
  TraceContext,
  MessageHistory,
  ReadFileStateMap,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ContextBuildResult,
  PendingInputEditLock,
} from "./deps.js";
import type {
  ActiveTurnSteeringState,
  ActiveTurnStartReservation,
  ActiveForegroundExecutionState,
  ForegroundPromotionLeaseState,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  BackgroundTaskNotificationSealReason,
  PendingModelChangeTimeline,
  ProviderRuntimeHeadersPort,
  MainTurnCacheHitAggregate,
  RuntimeTurnFileChangeMap,
} from "./types.js";
import type { RuntimeCommandQueue } from "./command-queue.js";
import type { RuntimeTaskRegistry } from "../runtime-task/registry.js";
import type { WorkflowBlockedReminderClock } from "../runtime-task/workflow-blocked-reminder.js";
import type { BackgroundSubagentStallClock } from "../subagent/background-stall.js";
import type { DynamicWorkflowActivationSource } from "./methods/dynamic-workflow-activation.js";
import type { AgentRuntimeCoreMethods } from "./internal-methods.js";
import type { AgentRuntimeTurnMethods } from "./internal-turn-methods.js";
import type { AgentRuntimeHookMethods } from "./internal-hook-methods.js";
import type { MemoryRecallState } from "../memory/recall/index.js";
import type { ProjectMemoryRecallPrefetch } from "./helpers/project-memory-recall.js";
import type { ProjectMemoryExtractionScheduler } from "./helpers/project-memory-extraction.js";
import type { BackgroundDreamRun, ProjectMemoryUpdate } from "./helpers/project-memory-dream.js";
import type { RuntimeTelemetryFacade } from "../telemetry/runtime-telemetry.js";
import type { WorkspaceHookRuntimeAdmissionPort } from "../hooks/workspace-hook-runtime-admission.js";

export interface AgentRuntimeInternal
  extends AgentRuntimeCoreMethods, AgentRuntimeTurnMethods, AgentRuntimeHookMethods {
  sessionId: SessionId;
  turnNumber: number;
  config: AgentRuntimeConfig;
  permissionService: PermissionService;
  permissionBroker: PermissionBrokerPort;
  toolScheduler: ToolScheduler;
  eventReducer: EventReducer;
  eventStore: SessionEventStorePort;
  rootTraceContext: TraceContext;
  appVersion: string;
  logger?: Logger;
  eventSinks: Set<SessionEventSink>;
  now: () => Date;
  isRemoteWorkspace: () => boolean;
  registry: ToolRegistry;
  executor: ToolExecutor;
  hookRunner?: HookRunner;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  modelFactory: AgentRuntimeDeps["modelFactory"];
  modelIoDir?: string;
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  browserControlPort?: AgentRuntimeDeps["browserControlPort"];
  modelRequestAdmission?: AgentRuntimeDeps["modelRequestAdmission"];
  sessionModelSelection: ModelSelection | undefined;
  messageHistory: MessageHistory;
  readFileState: ReadFileStateMap;
  nestedInstructionTracker: NestedInstructionTracker;
  cachedTools: ModelToolContract[] | null;
  /** 首次装配选定的会话工具运行位置；分支刷新复用它，不能回落到另一种实现。 */
  sessionControlKind?: "cli" | "app";
  /** 工作流工具面是否已注册（launch.md「On demand: activation」）；非 onDemand 会话出生即 true。 */
  dynamicWorkflowToolsActivated: boolean;
  dynamicWorkflowActivationSource?: DynamicWorkflowActivationSource;
  /** Language-server service handed in through deps; absent when code intelligence is not wired. */
  lspService?: LspService;
  /** Whether the LSP tool is currently registered (service present, enabled, and a server binary installed). */
  lspToolAvailable: boolean;
  /** Capability tags used by this session (the session-features module is the only writer); append-only. */
  sessionFeatures: Set<ModelRequestSessionFeature>;
  /** Tail of the session-features entry write queue; writes are serial so an older set never overwrites a newer one. */
  sessionFeaturesWrite: Promise<void>;
  contextBuilder: ContextBuilder | null;
  contextInitialized: boolean;
  contextSourceSnapshot?: ContextSourceSnapshot;
  // Git state just read during new-session init has not been announced yet; cleared after the first check, never set for restored sessions.
  sessionStartGitPrefetch?: boolean;
  // Directories this runtime confirmed are not Git repositories; not rechecked (a later git init is picked up by a new runtime).
  nonGitDirectories?: Set<string>;
  // A runtime restored from storage has not checked for a repository itself yet; read once on the first environment announcement, then cleared.
  repositoryRecheckPending?: boolean;
  latestContextBuildResult?: ContextBuildResult;
  // 指令增量的 reason：未设置即 session_start；compaction 提交重读后改为 compaction，之后不再改回。
  instructionRefreshReason?: InstructionRefreshReason;
  // 最近一次读取时读不出来的指令文件与 Memory 索引路径（启动与 compaction 采用重读时写入）；不算删除。
  unreadableInstructionPaths?: ReadonlySet<string>;
  // 主会话的 prompt 快照（helpers/prompt-snapshot.ts 是唯一写入方）；undefined 没有，null 已清掉。
  promptSnapshot?: PromptSnapshot | null;
  memoryRoot?: string;
  memoryIndexContent?: string;
  memoryRecallState: MemoryRecallState;
  memoryRecallPrefetch?: ProjectMemoryRecallPrefetch;
  memoryExtractionScheduler?: ProjectMemoryExtractionScheduler;
  memoryDreamLastScanAtMs: number;
  pendingMemoryUpdate?: ProjectMemoryUpdate;
  /** Live background /dream runs keyed by runtime-task id; the background stop dispatch aborts the controller. */
  backgroundDreamRuns: Map<string, BackgroundDreamRun>;
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  mcpStartupPromise?: Promise<McpConnectionSnapshot>;
  residencyBlockingWorkCount: number;
  residencyBlockingWork: Set<Promise<unknown>>;
  mcpInitialized: boolean;
  mcpToolsRegistered: boolean;
  /** 初始化 / 上次刷新时注册的 MCP 工具名与集合签名。 */
  registeredMcpToolNames?: string[];
  mcpToolsSignature?: string;
  mcpToolListRevision?: number;
  subagentPort?: SubagentPort;
  getAgentDefinitions: NonNullable<AgentRuntimeDeps["getAgentDefinitions"]>;
  prepareAgentDefinitions: (input: {
    signal: AbortSignal;
    traceContext: TraceContext;
  }) => Promise<void>;

  dynamicWorkflowRunPort?: DynamicWorkflowRunPort;
  modelCatalogPort?: ModelCatalogPort;
  runtimeTaskRegistry: RuntimeTaskRegistry;
  /**
   * 「run 还欠着决定、主代理闲着」的提醒钟（methods/dynamic-workflow-blocked-reminder.ts）。真实 runtime 上
   * 恒在场；可选只为让手写的局部 runtime 桩不必带它。
   */
  workflowBlockedReminder?: WorkflowBlockedReminderClock;
  /** 后台 Agent 无进展提醒（subagent/background-stall.ts）。 */
  subagentStallReminder?: BackgroundSubagentStallClock;
  branchGeneration: number;
  artifactStore?: ToolArtifactStorePort;
  executionPort?: ExecutionPort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  skillLoadOutcome?: SkillLoadOutcome;
  workingDirectory: string;
  workspaceRoot: string;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  sessionPersisted: boolean;
  needsPlanModeExitReminder: boolean;
  /** 恢复时对账出的「上一代 runtime 退出时被中断的后台 Agent」提醒，下一轮请求前落盘后清空。 */
  pendingPreviousRuntimeAgentNotice?: string;
  latestConversationMessageId?: MessageId;
  latestAssistantMessageId?: MessageId;
  latestAssistantTurnId?: TurnId;
  mainTurnCacheHitAggregate: MainTurnCacheHitAggregate;
  /** token 预算倒数的计数器；只在内存，resume 时重新开始。 */
  totalTokensBudget: TotalTokensBudgetState;
  currentTurnFileChanges: RuntimeTurnFileChangeMap;
  lastAssistantCompletedAtMs?: number;
  autoCompactConsecutiveFailures: number;
  runtimeCommandQueue: RuntimeCommandQueue;
  runtimeCommandDrainActive: boolean;
  activeForegroundExecution?: ActiveForegroundExecutionState;
  foregroundPromotionLease?: ForegroundPromotionLeaseState;
  activeTurn?: ActiveTurnSteeringState;
  activeTurnStartReservation?: ActiveTurnStartReservation;
  pendingInputSequence: number;
  pendingInputReservations: Map<string, string>;
  pendingInputEditLocks: Map<string, PendingInputEditLock>;
  permissionFullAccessPending?: boolean;
  pendingInputDrains?: number;
  lastPermissionGrantId?: string;
  queueAutoDrain: boolean;
  queueExternalDrainActive: boolean;
  shuttingDown: boolean;
  readonly shutdownSignal: AbortSignal;
  workChanged: Set<() => void>;
  backgroundTaskNotificationsSealed: boolean;
  backgroundTaskNotificationSealReason?: BackgroundTaskNotificationSealReason;
  pendingModelChangeTimeline?: PendingModelChangeTimeline;
  pendingWorktreeCreation?: import("@zcode/contracts").WorktreeCreationFact;
  sessionStartHookRan: boolean;
  /** Title generation attempts that reached the model in this runtime (specs/session-title-polish.md §6). */
  sessionTitleGenerationAttempts: number;
  sessionTitleGenerationInFlight: boolean;
  /** True once a generated/custom title is known; stops further attempts. */
  sessionTitleGenerationSettled: boolean;
  /** First title seed this runtime saw; a retry prefers it over the current message. */
  sessionTitleSeed?: { input: string; messageID?: MessageId };
  agentTelemetry: RuntimeTelemetryFacade;
}
