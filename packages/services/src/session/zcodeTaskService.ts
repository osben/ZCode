/* eslint-disable max-lines -- Keep the ZCode task wrapper service's app/runtime API together so it remains easier to trace during replacement. */
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "#src/descriptors.js";
import type {
  ZCodeImportSessionsResult,
  ZCodeImportableSessionCandidate,
  ZCodeSessionCompactResult,
  ZCodeSessionGoalAction,
  ZCodeSessionGoalResult,
  ZCodeCodexConnectivityCheckResult,
  ZCodeSwitchAgentResult,
  ZCodeSyncTaskSessionBindingResult,
  ZCodeTaskCreateResult,
  ZCodeTaskMeta,
  ZCodeStreamEvent,
  ZCodeTaskMode,
  ZCodeConfigOption,
  ZCodeError,
  ZCodeAssistantMessageFeedback,
  ZCodePromptAttachment,
  ZCodeProvider,
  ZCodeWorkspaceEvent,
  TraceId,
  ZCodeSessionFile,
  ZCodeAgentMcpServer,
  ZCodeTaskSnapshot,
  ZCodeTaskSnapshotBody,
  ZCodeTaskSnapshotToolCallsSlice,
  ZCodeTaskSnapshotRefContent,
  ZCodeEnqueueTaskCommandResult,
  ZCodeCancelTaskCommandResult,
  ZCodeTaskClientMode,
  ZCodeTaskTokenUsageResult,
  ZCodePermissionResponse,
  ModelSelection,
  ZCodeBackgroundTurnAttribution,
  ZCodeAutomationBotDeliveryTarget,
  ZCodeExecutionWorktree,
} from "@zcode/shared";
import type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "#src/session/sessionMailbox.js";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
  ZCodeWorkspaceEventSubscriptionParams,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";

export interface ZCodeTaskSnapshotWithEtagResult {
  snapshot: ZCodeTaskSnapshot | null;
  etag?: string;
  notModified?: boolean;
}

/** Fixed archive-deletion result set for one workspace; each deduplicated target belongs to exactly one result. */
export interface ZCodeArchivedTaskDeletionResult {
  deletedTaskIds: string[];
  skippedTaskIds: string[];
  failedTaskIds: string[];
}

/** A message content part from one model request (text / tool call / tool result / other raw structure). */
export type ZCodeModelTrajectoryContentPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolCallId?: string; toolName: string; input?: unknown }
  | { kind: "tool-result"; toolCallId?: string; toolName?: string; output?: unknown }
  | { kind: "image"; mediaType?: string }
  | { kind: "unknown"; raw: unknown };

/** One conversation message (system / user / assistant / tool). */
export interface ZCodeModelTrajectoryMessage {
  role: string;
  parts: ZCodeModelTrajectoryContentPart[];
}

/** Token usage normalized from a model_io record. */
export interface ZCodeModelTrajectoryUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

export type ZCodeModelTrajectoryCallSourceKind =
  | "main"
  | "sidecar"
  | "subagent"
  | "compact"
  | "unknown";

export interface ZCodeModelTrajectoryCallSource {
  kind: ZCodeModelTrajectoryCallSourceKind;
  querySource?: string;
}

/**
 * One model call (one model_io record). A trajectory consists of multiple calls in chronological order.
 * request.messages is the full context sent to the model for that request (and grows across turns);
 * response is the new content produced by this model call.
 */
export interface ZCodeModelTrajectoryRecord {
  requestId: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  turnId?: string;
  traceId?: string;
  callSource?: ZCodeModelTrajectoryCallSource;
  model: {
    modelId?: string;
    providerId?: string;
    role?: string;
    source?: string;
  };
  request: {
    messages: ZCodeModelTrajectoryMessage[];
    toolNames: string[];
  };
  response?: {
    finishReason?: string;
    text?: string;
    reasoningText?: string;
    toolCalls: ZCodeModelTrajectoryContentPart[];
    usage?: ZCodeModelTrajectoryUsage;
    responseId?: string;
    modelId?: string;
  };
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/** Complete model-call trajectory for a task/session. */
export interface ZCodeModelTrajectory {
  taskId: string;
  /** Whether the runtime supports reading model-io trajectories (only ZCode Agent writes model-io to disk). */
  available: boolean;
  records: ZCodeModelTrajectoryRecord[];
  /** Absolute path of the source file found, for troubleshooting. */
  sourceFiles: string[];
  /** Whether the result was truncated at the limit (keeping only the latest N entries). */
  truncated: boolean;
}

export type {
  ZCodeTaskListKind,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
  ZCodeWorkspaceEventSubscriptionParams,
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";

/** Terminal result for one task input turn, used by background dispatch (scheduled tasks) to write back the run result. */
export interface ZCodeTaskTerminalOutcome {
  taskId: string;
  /** Corresponding input-turn ID (= sendPrompt traceId/inputId), used to match a specific dispatch. */
  inputId?: string;
  outcome: "succeeded" | "failed" | "stopped";
  /** Error message on failure. */
  error?: string;
}

/** An input turn has fully completed, and the session can safely accept the next input. */
export interface ZCodeTaskReadyOutcome {
  taskId: string;
  reason: "prompt_completed" | "prompt_failed";
}

/**
 * IZCodeTaskService — ZCode task wrapper API service interface.
 *
 * UI and remote controllers use this layer to access task wrapper state; core session state is maintained by
 * the ZCode Agent server, so new features should prefer IZCodeSessionService.
 */
export interface IZCodeTaskService {
  // ---- Lifecycle ----

  /** Check whether the agent runtime is available. */
  initialize(params: { workspacePath: string }): Promise<{ available: boolean; version?: string }>;

  /** Release idle workspace sessions used only for prewarming so they do not keep running after switching tabs. */
  releaseWorkspacePreparation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<void>;

  /** Network check before Codex draft-state prewarming, used to warn early that chatgpt.com is unreachable. */
  checkCodexConnectivity(): Promise<ZCodeCodexConnectivityCheckResult>;

  // ---- Task/Session management ----

  /** Create a ZCode session and sync the task index. */
  createTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: ZCodeTaskMode;
    /** Production model selection; no longer split into model/thoughtLevel after the product submission boundary was fixed. */
    modelSelection?: ModelSelection;
    /** @deprecated Read only at legacy call boundaries that have not yet migrated. */
    model?: string;
    /** @deprecated Read only at legacy call boundaries that have not yet migrated. */
    thoughtLevel?: string;
    draftSessionId?: string;
    forkedFromTaskId?: string;
    mcpServers?: ZCodeAgentMcpServer[];
    /** Mark the owning automation during scheduled-task dispatch, persist cron_automation_id in tasks-index, and place it in the cron group. */
    automationId?: string;
    /** Mark the owning off-peak task during off-peak dispatch and persist off_peak_task_id in tasks-index. */
    offPeakTaskId?: string;
    /**
     * Headless dispatch first creates an empty session and immediately sends the first V4 input. Use deferred here
     * so input admission persists the session's primary record before writing the session_input foreign-key ledger.
     */
    deferPersistenceUntilFirstPrompt?: boolean;
    /** Bot/host uses native v4 createSession to create a draft, then configures and sends it. */
    v4Create?: boolean;
    permissionScope?: "session";
  }): Promise<ZCodeTaskCreateResult>;

  readBotTopicSummaries?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<Array<{ checkpoint: string; text: string }>>;

  invalidateBotTopicInputs?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<void>;
  readBotTopicExecution?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<{ executionId: string; sourceCommandId?: string } | undefined>;
  stopBotTopicExecution?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    executionId: string;
  }): Promise<void>;

  /** Read the block reason for bot group-task switching from the CLI's authoritative snapshot; returns null when idle. */
  getBotGroupTaskBlockReason?(params: {
    taskId: string;
    remoteSessionId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<"running" | "queued" | "interaction" | null>;
  cancelBotGroupInput?(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    taskId: string;
    remoteSessionId?: string;
    commandId: string;
    sourceCommandId: string;
    actorId: string;
    ownerId: string;
    botId: string;
    chatId: string;
  }): Promise<import("@zcode/shared/zcode-protocol-v4").CommandAck>;
  submitBotGroupInput?(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    taskId: string;
    remoteSessionId?: string;
    commandId: string;
    content: string;
    conversationQuotes?: import("@zcode/shared").ConversationSelectionText[];
    attachments?: ZCodePromptAttachment[];
    source: import("@zcode/shared").BotGroupInputSource;
  }): Promise<import("@zcode/shared/zcode-protocol-v4").CommandAck>;

  /** Send a prompt to the specified task. */
  sendPrompt(
    params: {
      taskId: string;
      remoteSessionId?: string;
      traceId: TraceId;
      queryId?: string;
      messageId?: string;
      content: string;
      attachments?: ZCodePromptAttachment[];
      clientId?: string;
      clientLabel?: string;
      clientMode?: ZCodeTaskClientMode;
      /** Additional tools hidden for the current turn; merged with the session/automation tool isolation rules. */
      toolDenylist?: string[];
      /** Stable callback address for a Bot-originated turn; injected by BotsService and not controlled by the model. */
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
      /** Standard model selection; off-peak tasks also create a Model through Registry / ModelFactory. */
      modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
      /** Per-execution constraints and dynamic authorization; accepted only for idle start-now and not added to the regular queue. */
      modelExecution?: CommandPayloadMap["sendText"]["modelExecution"];
    } & ZCodeBackgroundTurnAttribution,
  ): Promise<void>;

  deliverSessionMessage(
    request: SessionMessageSendRequested,
  ): Promise<SessionMessageDeliveryResult>;

  sendSessionMessageDeliveryResult(result: SessionMessageDeliveryResult): Promise<void>;

  /** Submit a task runtime command to the host; on return, the owner Host has received it. */
  enqueueTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    traceId: TraceId;
    queryId?: string;
    type: "send_prompt";
    content: string;
    attachments?: ZCodePromptAttachment[];
    clientId?: string;
    clientLabel?: string;
    /** Preserve automation context when scheduled-task dispatch is deferred through the host command queue. */
    automationId?: string;
    ownerRunId?: TraceId;
  }): Promise<ZCodeEnqueueTaskCommandResult>;

  promoteTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    ownerRunId: TraceId;
    clientMode: ZCodeTaskClientMode;
  }): Promise<ZCodeEnqueueTaskCommandResult>;

  cancelTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    ownerRunId?: TraceId;
    clientMode: ZCodeTaskClientMode;
  }): Promise<ZCodeCancelTaskCommandResult>;

  /** Stop the generation currently in progress. */
  stopGeneration(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    /** Execution identity observed in the CLI's activeWorks, so a late stop does not kill a fresh turn. */
    expectedForegroundExecutionId?: string;
  }): Promise<void>;

  /** Run the agent's built-in /compact command; mobile replayable still routes through the shared host. */
  compactSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    instructions?: string;
    expectedRevision?: number;
  }): Promise<ZCodeSessionCompactResult>;

  /** Run the agent's built-in /goal command; do not send /goal as an ordinary prompt body. */
  goalSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    action: ZCodeSessionGoalAction;
    objective?: string;
    expectedRevision?: number;
  }): Promise<ZCodeSessionGoalResult>;

  /** Respond to a permission request. */
  respondPermission(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    requestId: string;
    optionId: string;
    response: ZCodePermissionResponse;
  }): Promise<boolean>;

  /** Respond to a user elicitation request. */
  respondElicitation(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    requestId: string;
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
    clientMode?: ZCodeTaskClientMode;
  }): Promise<boolean>;

  /** Close a task (prefer session/close; reclaim the shared process only when the last task in the workspace ends). */
  closeTask(params: { taskId: string }): Promise<void>;

  /** Resume an existing task (reuse the workspace-level agent process or create one if absent, then run session/load). */
  resumeTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    mode?: ZCodeTaskMode;
    model?: string;
    thoughtLevel?: string;
    /** Resume an existing targetTaskId during scheduled-task dispatch, preserving automation tool-surface isolation. */
    automationId?: string;
    /** Add the off-peak marker when resuming a pre-session for off-peak continuation (new sessions are marked in createTask). */
    offPeakTaskId?: string;
    mcpServers?: ZCodeAgentMcpServer[];
  }): Promise<ZCodeTaskMeta>;

  /** List all persisted tasks in a workspace. */
  listTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    /**
     * Host sessions-index convergence input (BUG-GWT-010): persist these execution-worktree facts into
     * tasks-index meta_json before reading. Used by the window controller so worktree facts learned from
     * the live overlay survive restarts of closed workspaces; callers that omit it get a plain read.
     */
    executionWorktreeFacts?: ReadonlyArray<{
      taskId: string;
      executionWorktree: ZCodeExecutionWorktree;
    }>;
  }): Promise<ZCodeTaskMeta[]>;

  /** Read the global pinned task ID list; tasks-index.sqlite is the source of truth. */
  listPinnedTaskIds(): Promise<string[]>;

  /** List all pinned tasks in the current workspace according to tasks-index.sqlite. */
  listPinnedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Read deleted task IDs in the workspace; used for a persistent negative-membership join in the sessions-index list. */
  listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<string[]>;

  /**
   * Query an aggregated task list for the currently open workspace scopes; tasks-index.sqlite is the source of truth.
   * Consumers: full-text search (searchable_text/snippets) and the remoteTimelineTaskStore supplement path.
   * Unsearched list views use listTasks/listPinnedTasks/listArchivedTasks; clients build workspace rows from each endpoint's task rows + session details (converged across clients).
   */
  listTaskList(params: ZCodeTaskListQuery): Promise<ZCodeTaskListResult>;

  /** Create a minimal task group; full deletion will be added with group management. */
  createTaskGroup(params?: {
    title?: string;
    color?: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup>;

  /** Rename a task group; workspaceScopes only notify currently visible grouped views to refresh. */
  renameTaskGroup(params: {
    groupId: string;
    title: string;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeTaskGroup>;

  /** Update a task group color; workspaceScopes only notify currently visible grouped views to refresh. */
  updateTaskGroupColor(params: {
    groupId: string;
    color: ZCodeTaskGroupColor;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeTaskGroup>;

  /** Delete a task group; callers should first move its tasks back to the top-level root. */
  deleteTaskGroup(params: {
    groupId: string;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<void>;

  // The server's grouped query returns only the raw structure (without joining the tasks table);
  // the renderer builds a unified projection from task row partitions and session details.

  /**
   * Query the raw structure for the Grouped view (group/member/top-level ordering; no tasks table join).
   * The client joins this structure against task row partitions; sessions-index only adds live details.
   */
  listGroupedTaskViewStructure(params: {
    workspaceScopes: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeGroupedTaskViewStructure>;

  /** Commit the final grouped-view ordering and membership at once, persisted in a SQLite transaction. */
  applyGroupedTaskViewOrder(params: ZCodeGroupedTaskViewOrderInput): Promise<ZCodeGroupedTaskView>;

  /** List all archived tasks in a workspace. */
  listArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Bulk-archive stale tasks that are complete, read, not pinned, and not currently open. */
  archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
  }): Promise<ZCodeTaskMeta[]>;

  /** When removing a workspace, bulk-archive all its unarchived tasks, including pinned tasks. */
  archiveWorkspaceTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Read a task's locally persisted snapshot for the initial display of historical tasks. */
  getTaskSnapshot(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageLimit?: number;
    byteBudget?: number;
    toolLimit?: number;
    clientMode?: ZCodeTaskClientMode;
    resumeModelPolicy?: "task-index" | "ui-resolved-only";
    model?: string;
    thoughtLevel?: string;
  }): Promise<ZCodeTaskSnapshot | null>;

  /** Read a task snapshot with its ETag to reduce repeated large transfers through if-none-match. */
  getTaskSnapshotWithEtag(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageLimit?: number;
    ifNoneMatch?: string;
    byteBudget?: number;
    toolLimit?: number;
    clientMode?: ZCodeTaskClientMode;
    resumeModelPolicy?: "task-index" | "ui-resolved-only";
    model?: string;
    thoughtLevel?: string;
  }): Promise<ZCodeTaskSnapshotWithEtagResult>;

  /** Read the full body of a large message truncated by the initial-view budget, using bodyRef. */
  getTaskSnapshotBody(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<ZCodeTaskSnapshotBody | null>;

  /** Read the full fields of a tool call or file change truncated by the initial-view budget, using ref. */
  getTaskSnapshotRef(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<ZCodeTaskSnapshotRefContent | null>;

  /** Fetch a tools slice by message and index range for incremental loading after remote initial-view truncation. */
  getTaskSnapshotToolCallsSlice(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageIndex: number;
    startToolIndex: number;
    limit: number;
  }): Promise<ZCodeTaskSnapshotToolCallsSlice | null>;

  /** Read lightweight task metadata (without messages/fileChanges) as a display fallback for title/provider. */
  getTaskMeta(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta | null>;

  /** Read config options from the active task's in-memory state; do not fall back to workspace prewarming. */
  getTaskConfigOptions(params: { taskId: string }): Promise<ZCodeConfigOption[]>;

  /** Read the original model selection bound to the session; do not infer it from candidates, resolve, or write it. */
  getTaskModelSelection(params: { taskId: string }): Promise<ModelSelection | null>;

  /** Persist local user feedback on an assistant reply; it is not injected into provider context. */
  setAssistantMessageFeedback(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    turnIndex: number;
    feedback: ZCodeAssistantMessageFeedback | null;
  }): Promise<ZCodeSessionFile>;

  /**
   * Backfill the provider session already attached to a task so it covers the full conversation
   * boundary of the current canonical task. Only backfills the native log; does not switch the
   * current active provider.
   */
  syncTaskSessionBinding(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    provider: ZCodeProvider;
    validate?: boolean;
  }): Promise<ZCodeSyncTaskSessionBindingResult>;

  /**
   * Switch the current active provider within the same task.
   * Currently supports `claude` / `codex` / `gemini` as switch targets.
   */
  switchAgent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    provider: ZCodeProvider;
  }): Promise<ZCodeSwitchAgentResult>;

  /** Scan importable native Claude sessions, optionally filtered by workspace. */
  scanImportableClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<ZCodeImportableSessionCandidate[]>;

  /** Import selected native Claude sessions and create minimal task snapshots; without workspacePath, use each original workspace. */
  importClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    sessionIds: string[];
  }): Promise<ZCodeImportSessionsResult>;

  /** Change the task mode. */
  setMode(params: { taskId: string; mode: ZCodeTaskMode }): Promise<void>;

  /** Change a configOption (model, thinking level, etc.) and return the full updated configOptions list. */
  setConfigOption(params: {
    taskId: string;
    traceId: TraceId;
    configId: string;
    value: string;
  }): Promise<ZCodeConfigOption[]>;

  /** Change the model and return the server-authoritative configOptions. */
  setModel(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
  }): Promise<ZCodeConfigOption[]>;

  /** For scheduled-task dispatch: converge the model, thinking level, and permission mode, and update the V4 conversation projection. */
  setAutomationSessionConfig(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
    thoughtLevel?: string;
    mode?: ZCodeTaskMode;
  }): Promise<ZCodeConfigOption[]>;

  /** Get the primary config file path for a workspace + provider pair. */
  getWorkspaceProviderConfigFile(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<{
    provider: ZCodeProvider;
    path: string;
    exists: boolean;
  }>;

  /** Get the native session log file path for a task (e.g. Claude's session jsonl). */
  getTaskNativeSessionLogFile(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    provider: ZCodeProvider | null;
    path: string | null;
    exists: boolean;
  }>;

  /**
   * Read the model-call trajectory for a task (model-io JSONL from ~/.zcode/cli/{debug,rollout}).
   * taskId is the ZCode Agent sessionId and is matched against model-io records by sessionId.
   */
  getModelTrajectory(params: {
    taskId: string;
    /** Maximum number of calls to return (keep the most recent N in reverse chronological order); defaults to 200. */
    limit?: number;
  }): Promise<ZCodeModelTrajectory>;

  /** Read cumulative model-token usage for a task/session from the agent usage database. */
  getTaskTokenUsage(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskTokenUsageResult>;

  /** Get the persisted task snapshot path (normally {taskId}.json; soft-deleted tasks use .deleted.json). */
  getTaskSessionFilePath(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    path: string;
    exists: boolean;
  }>;

  /**
   * Restart the shared ZCode Agent process for a workspace.
   * Use this when configuration changes require reloading the process environment.
   * Optionally pass resumeTaskId to resume the current chat immediately after restart.
   */
  restartWorkspaceProcess(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    resumeTaskId?: string;
    bumpRuntimeEpoch?: boolean;
  }): Promise<void>;

  /** Hide a persisted task from the list while retaining its CLI session content. */
  deleteTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;

  /** Delete only tasks still archived at write time; return false if restored, deleted, or missing, and keep the CLI session. */
  deleteArchivedTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean>;

  /** Delete tasks one by one under the archived condition, notify the list once per batch, and keep CLI sessions. */
  deleteArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskIds: string[];
  }): Promise<ZCodeArchivedTaskDeletionResult>;

  /** Rename a persisted task. */
  renameTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  }): Promise<ZCodeTaskMeta>;

  /** Update a task's pinned state. */
  setTaskPinned(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    pinned: boolean;
  }): Promise<ZCodeTaskMeta>;

  /** List sidebar-pinned workspace keys (fork shell state in tasks-index.sqlite). */
  listPinnedWorkspaceKeys(): Promise<string[]>;

  /** Pin or unpin a sidebar project row by workspace key. */
  setWorkspacePinned(params: { workspaceKey: string; pinned: boolean }): Promise<void>;

  /** Update a task's unread state. */
  setTaskUnread(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    unread: boolean;
    /** Used only for read compare-and-clear; when omitted, preserve the existing unconditional write semantics. */
    expectedUnreadAt?: number;
  }): Promise<ZCodeTaskMeta>;

  /** Archive a task to hide it from the default task list. */
  archiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta>;

  /** Unarchive a task to return it to the default task list. */
  unarchiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta>;

  /** Create a blank branch from a source task's session configuration to edit a user input again. */
  branchTaskFromPrompt(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourceTaskId: string;
  }): Promise<ZCodeTaskCreateResult>;

  // ---- Streaming events ----

  /** Subscribe to streaming updates for a task (a ProxyChannel dynamic event). */
  onDynamicStreamEvent(taskId: string): Event<ZCodeStreamEvent>;

  /**
   * Subscribe to a task's terminal outcome (succeeded / failed / stopped).
   * This uses the always-on session subscription from the task index and does not depend on the renderer viewing the task,
   * so background dispatches (such as scheduled tasks) can reliably receive the outcome. Used to update automation_runs.outcome.
   */
  onDynamicTaskTerminalOutcome(taskId: string): Event<ZCodeTaskTerminalOutcome>;

  /**
   * Subscribe to the input-ready boundary for a task. sendPrompt only returns a remote ACK and cannot indicate that the Agent is idle;
   * Host runtime cleanup must wait for this event to avoid interrupting a running Agent when closing a workspace.
   */
  onDynamicTaskReady(taskId: string): Event<ZCodeTaskReadyOutcome>;

  /** Subscribe to streaming updates for a workspace and task to prevent streams crossing workspaces with the same taskId. */
  onDynamicTaskEvent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    clientId?: string;
    deliveryKind?: "continuous" | "bot-channel-continuous" | "replayable" | "mixed";
  }): Event<ZCodeStreamEvent>;

  /**
   * Subscribe to workspace-level asynchronous notifications (such as slash commands and configOptions pushed during Agent prewarming).
   * Covers the gap before task creation so the UI can update draft toolbars and command lists in real time.
   * Follows ProxyChannel's onDynamic prefix convention so the RPC proxy recognizes it as a dynamic event.
   */
  onDynamicWorkspaceEvent(
    workspace: string | ZCodeWorkspaceEventSubscriptionParams,
  ): Event<ZCodeWorkspaceEvent>;

  /** Global error event. */
  onError: Event<ZCodeError>;
}

export const IZCodeTaskService = createServiceDescriptor<IZCodeTaskService>(
  ServiceChannels.ZCodeTask,
);
