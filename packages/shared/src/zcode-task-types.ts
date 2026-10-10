/* oxlint-disable eslint(max-lines) -- ZCode task projection types are maintained together in one file for now; keep new workspace events nearby. */
// ── Legacy protocol compatibility surface (transitional) ──
// 29 exports remain: workspace prewarming/workspace events, turn-steer results, session binding/import,
// trace/input/query ID factories, ZCodeError, ZCodeTaskCreateResult, and others.
// Consumers: legacy services stack (zcodeAgentService/zcodeTaskServiceAdapter/zcodeTaskService),
// and legacy UI stores/projections. Core types (ZCodeTaskMeta/ZCodeStreamEvent/ZCodeTaskSnapshot, etc.)
// have moved to zcode-task-types-core.ts. This file shares the lifecycle of the legacy task service group.
import { createUuid } from "./uuid.js";
import type {
  TaskRealtimeReason,
  TraceId,
  InputId,
  QueryId,
  ZCodeTaskGoal,
  ZCodeProvider,
  ZCodeConfigOption,
  ZCodeSlashCommand,
  ZCodeTaskMeta,
  ZCodeTaskRuntimeCommand,
  ZCodeTaskRuntimeCommandStatus,
  ZCodeTaskSnapshotBodyField,
  ZCodeTaskSnapshotToolField,
  ZCodeTaskSnapshotFileContentField,
  ZCodePersistedToolCall,
} from "./zcode-task-types-core.js";

/** Generate a traceId; retain the legacy function name for existing callers and match the agent's UUID trace format. */
export function generateTraceId(_taskId: string): TraceId {
  return createUuid();
}

/** Create a ZCode session-level observability traceId; subsequent prompts inherit it instead of generating a new one. */
export function createSessionTraceId(): TraceId {
  return createUuid();
}

export function createInputId(): InputId {
  return createUuid();
}

export function createQueryId(): QueryId {
  return createUuid();
}

/** Fixed system group ID for sessions created by cron schedules. */
export const CRON_DEFAULT_GROUP_ID = "zcode-default-group-cron";

/** Fixed system group ID for sessions dispatched by off-peak tasks (matching the cron group structure). */
export const OFF_PEAK_DEFAULT_GROUP_ID = "zcode-default-group-off-peak";

type CronTaskIdentity = Pick<ZCodeTaskMeta, "cronAutomationId"> & {
  automationId?: string;
};

/** Determine whether a task/session was created by a scheduled task. */
export function isCronTask(task: CronTaskIdentity): boolean {
  // Persisted task metadata uses cronAutomationId, but runtime dispatch/legacy paths use automationId.
  // If the UI checks only the former, newly created or resumed scheduled tasks temporarily have no icon.
  return Boolean(task.cronAutomationId || task.automationId);
}

/** Determine whether a task/placeholder row belongs to an off-peak task (check only the persisted metadata marker; the UI does not query the off-peak store). */
export function isOffPeakTask(task: Pick<ZCodeTaskMeta, "offPeakTaskId">): boolean {
  return Boolean(task.offPeakTaskId);
}

// ---- ZCode Provider ----
export type ZCodeTaskTarget = ZCodeTaskGoal;
// ---- ZCode task modes ----
// ---- ZCode runtime state ----

/** Workspace-level ZCode initialization state. */
export type ZCodeWorkspaceInitStatus = "idle" | "initializing" | "ready" | "failed";

/** Result returned while prewarming a workspace. */
export interface ZCodeWorkspacePrepareResult {
  workspacePath: string;
  preparedSessionId: string;
  version?: string;
  provider: ZCodeProvider;
  /** Initial configOptions returned by session/new, sent to the UI during prewarming so the user can choose a model early. */
  configOptions?: ZCodeConfigOption[];
  /** Slash commands already broadcast by the prewarmed session, available to display even in draft state. */
  slashCommands?: ZCodeSlashCommand[];
}

// ---- Task metadata ----

/** Result of createTask; adds transient initialization data needed for the first render beyond persisted metadata. */
export interface ZCodeTaskCreateResult extends ZCodeTaskMeta {
  /** Initial slash commands available during createTask, preventing initialization commands from being lost before the UI subscribes. */
  initialSlashCommands?: ZCodeSlashCommand[];
}

/** Source provider for imported external native sessions; decoupled from the agent runtime's ZCodeProvider, currently only Claude Code. */
export type ZCodeImportSessionSourceProvider = "claude";

/** Import candidate for an external native session. */
export interface ZCodeImportableSessionCandidate {
  provider: ZCodeImportSessionSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  updatedAt: number;
  createdAt?: number;
  previewTitle?: string;
}

export interface ZCodeImportedSessionResultItem {
  provider: ZCodeImportSessionSourceProvider;
  sessionId: string;
  taskId: string;
  workspacePath: string;
}

export interface ZCodeImportedSessionSkippedItem {
  provider: ZCodeImportSessionSourceProvider;
  sessionId: string;
  reason: string;
  workspacePath?: string;
}

export interface ZCodeImportSessionsResult {
  imported: ZCodeImportedSessionResultItem[];
  skipped: ZCodeImportedSessionSkippedItem[];
  failed: ZCodeImportedSessionSkippedItem[];
}

// ---- ZCode configuration and command types ----
// ---- ZCode streaming events (Host → Renderer) ----
// ---- Additional streaming event types ----

export interface ZCodeEnqueueTaskCommandResult {
  accepted: true;
  command: ZCodeTaskRuntimeCommand;
}

export interface ZCodeCancelTaskCommandResult {
  canceled: boolean;
  commandId: string;
  status?: ZCodeTaskRuntimeCommandStatus;
  reason?: "not_found" | "already_running";
}

// ---- Workspace-level events (asynchronous notifications during prewarming, before task creation) ----

/**
 * Workspace-level events deliver asynchronous notifications pushed by the ZCode Agent (such as slash commands and configOptions)
 * to the UI in real time before task creation.
 *
 * Unlike ZCodeStreamEvent, which is bound to a specific taskId, ZCodeWorkspaceEvent is bound to workspacePath
 * and covers the gap before task creation.
 */
export type ZCodeWorkspaceEvent =
  | ZCodeWorkspaceSlashCommandsUpdate
  | ZCodeWorkspaceConfigOptionsUpdate
  | ZCodeWorkspaceTaskListChanged
  | ZCodeWorkspaceSessionMessageSendRequested;

export interface ZCodeWorkspaceSlashCommandsUpdate {
  type: "workspace_slash_commands_update";
  workspacePath: string;
  /**
   * Slash commands for remote workspaces are identity-isolated state and cannot be dispatched by workspacePath alone.
   * The same path may come from different SSH/WSL/Docker sessions; workspaceIdentity lets service/UI converge on the workspaceKey.
   */
  workspaceIdentity?: string;
  commands: ZCodeSlashCommand[];
}

export interface ZCodeWorkspaceConfigOptionsUpdate {
  type: "workspace_config_options_update";
  workspacePath: string;
  /**
   * Prewarmed configuration is also workspace identity state; remote scenarios must pass workspaceIdentity with the event.
   */
  workspaceIdentity?: string;
  configOptions: ZCodeConfigOption[];
}

export interface ZCodeWorkspaceTaskListChanged {
  type: "workspace_task_list_changed";
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
  reason: "auto_archive" | "realtime_sync" | TaskRealtimeReason;
  taskMeta?: ZCodeTaskMeta;
  /** Host confirmed that this terminal state should create a background unread item; ordinary status/resume/snapshot reconciliation must omit it. */
  unreadSignal?: "background_terminal";
}

export interface ZCodeWorkspaceSessionMessageSendRequested {
  type: "workspace_session_message_send_requested";
  workspacePath: string;
  workspaceIdentity?: string;
  request: {
    content: string;
    createdAt: string;
    fromSessionId: string;
    messageId: string;
    requestId: string;
    toSessionId: string;
  };
}

// ---- Errors ----

export interface ZCodeError {
  code: string;
  message: string;
  traceId?: TraceId;
  taskId?: string;
}

// ---- Persisted format ----

export interface ZCodeTaskSnapshotBody {
  refId: string;
  field: ZCodeTaskSnapshotBodyField;
  content: string;
  hash: string;
  fullBytes: number;
}

export type ZCodeTaskSnapshotRefKind = "tool_field" | "file_change_field";

export interface ZCodeTaskSnapshotRefContent {
  kind: ZCodeTaskSnapshotRefKind;
  refId: string;
  field: ZCodeTaskSnapshotToolField | ZCodeTaskSnapshotFileContentField;
  content: unknown;
  hash: string;
  fullBytes: number;
}

export interface ZCodeTaskSnapshotToolCallsSlice {
  taskId: string;
  messageIndex: number;
  totalTools: number;
  startToolIndex: number;
  endToolIndexExclusive: number;
  tools: ZCodePersistedToolCall[];
}
