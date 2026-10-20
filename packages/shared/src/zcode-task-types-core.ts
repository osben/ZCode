/* oxlint-disable eslint(max-lines) -- Re-homed task projection core types are kept together as one contract surface. */
// Re-homed as a step toward deleting the legacy protocol tree.
// This file holds the core types from the old task projection that are still consumed by the active stack: ZCodeTaskMeta / ZCodeProvider /
// ZCodeStreamEvent / TraceId/InputId/QueryId / ZCodePersistedMessage(Part) / ZCodeTaskSnapshot /
// ZCodePlanStep / ZCodePermissionRequest and their dependency closure (including realtime transport primitives).
// zcode-task-types.ts / task-realtime.ts retain the legacy protocol compatibility surface and share these core types.

import type { ZCodeBackgroundTaskControlItem } from "./background-task-controls.js";
import type { ToolCallDisplay } from "./zcode-protocol-v4/toolDisplay.js";
import type {
  ZCodeContextUsageBreakdownItem,
  ZCodeInteractionRequestOrigin,
  ZCodePermissionResponse,
  ZCodeSessionActiveTurnKind,
} from "./zcode-protocol-legacy-types.js";
import type { ErrorAttribution } from "./zcode-protocol-v4/snapshot.js";

/**
 * Shared type definitions for ZCode task/session projections.
 *
 * Types used by the renderer, host process, and ZCode agent service.
 */

// ---- Observability ----

/** End-to-end trace ID for logs and observability. */
export type TraceId = string;
/** Ownership ID for each user input, used to close out stop/queue/terminal state. */
export type InputId = string;
/** Semantic attribution ID for each actual user query, used in model-request headers and per-question observability. */
export type QueryId = string;
// ---- ZCode Provider ----

/** Supported ZCode agent providers; currently only glm is retained. */
export type ZCodeProvider = "glm";
export type ZCodeGlmAgentModelStateUpdateReason =
  | "session_initialized"
  | "model_changed"
  | "thought_level_changed";
export interface ZCodeGlmAgentModelStateOption {
  value: string;
  name: string;
}
export interface ZCodeGlmAgentModelStateUpdatePayload {
  version: 1;
  sessionId: string;
  reason: ZCodeGlmAgentModelStateUpdateReason;
  model: {
    currentValue: string;
  };
  thoughtLevel: {
    enabled: boolean;
    currentValue?: string;
    options: ZCodeGlmAgentModelStateOption[];
  };
  contextWindow: {
    tokens: number;
  };
}
/** Source of imported external history. Currently only Claude Code is stored here; future sources can be added here. */
export type ZCodeTaskMigrationSource = "claudeCode";
export type ZCodeTaskGoalStatus = "active" | "paused" | "budget_limited" | "complete";
export type ZCodeTaskTargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";
export type ZCodeTaskTargetChangedSource = "command" | "tool" | "runtime";
export interface ZCodeTaskGoal {
  sessionID: string;
  targetID: string;
  objective: string;
  summaryTitle: string | null;
  status: ZCodeTaskGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeInputId?: string | null;
  activeRunStartedAtMs?: number | null;
  activeRunLastSeenAtMs?: number | null;
  time: {
    created: number;
    updated: number;
  };
}
export interface ZCodeTaskGoalStats {
  /** Cumulative runtime seconds for the goal; from the agent's session_target or a historical turn projection. */
  timeUsedSeconds: number;
  /** Cumulative goal tokens; prefer goal accounting, with the agent falling back to historical turns if needed. */
  tokensUsed: number;
  /** Goal token budget explicitly set by the user; the UI may show the context window when absent. */
  tokenBudget: number | null;
  /** Tokens currently used in the session context window. */
  contextUsed: number;
  /** Capacity of the current session context window. */
  contextWindow: number;
  /** Number of historical tool calls related to the goal. */
  toolCallCount: number;
  /** Number of goal verifier lifecycle rounds triggered; distinct from ordinary runtime turns or user continuations. */
  iterationCount: number;
}
export interface ZCodeGoalVerification {
  nextAction?: string | null;
  passed: boolean;
  reason: string;
}
export type ZCodeGoalVerificationTimelineStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";
export interface ZCodeGoalVerificationTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "goal_verification";
  display: "separator";
  targetId: string;
  verificationId: string;
  status: ZCodeGoalVerificationTimelineStatus;
  verification?: ZCodeGoalVerification;
  goalIteration?: number;
  /** Anchor the verifier divider to the assistant message that completed this round, rather than letting it drift with time. */
  anchorAssistantMessageId?: string;
  /** Helps restore boundary semantics for the same turn; may be absent in older history. */
  anchorTurnId?: string;
  startedAt?: number;
  updatedAt: number;
}
export interface ZCodeTodoGroup {
  id: string;
  source: "goal_iteration" | "session";
  goalIteration?: number;
  targetId?: string;
  startedAt?: number;
  updatedAt?: number;
  todos: ZCodePlanStep[];
}
export interface ZCodeTaskGoalChangedPatch {
  action: ZCodeTaskTargetChangedAction;
  source: ZCodeTaskTargetChangedSource;
  target: ZCodeTaskGoal | null;
  previousTarget?: ZCodeTaskGoal | null;
}
// ---- ZCode task mode ----

export type ZCodeTaskMode =
  | "default"
  | "yolo"
  | "guarded"
  | "plan"
  | "edit"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | "autoEdit"
  | "build";

export type ZCodeOffPeakRunType = "init" | "resume";

/** Source attribution for one automated input turn; the two background business identities must not coexist. */
export type ZCodeBackgroundTurnAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: ZCodeOffPeakRunType;
      automationId?: never;
    }
  | { automationId?: undefined; offPeakTaskId?: undefined; offPeakRunType?: never };
/** Runtime state of a task in the current workspace. */
export type ZCodeTaskRuntimeStatus =
  | "idle"
  | "creating"
  | "notReady"
  | "restoring"
  | "ready"
  | "streaming"
  | "completed"
  | "failed";
/** Persisted task state, recording the result of the latest prompt. */
export type ZCodeTaskPersistStatus = "running" | "completed" | "error";
export interface ZCodeTaskLastError {
  attribution?: ErrorAttribution;
  code?: string;
  message: string;
  traceId?: TraceId;
  taskId?: string;
}
/**
 * Attachment types supported by the current prompt.
 * Small images use an agent image block; local files/large images prefer localPath so the agent can read them using its own thresholds.
 */
export interface ZCodePromptImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** agent ImageContent already carries mimeType separately, so only the raw base64 body is kept here. */
  dataBase64?: string;
  /** Actual local path on Desktop; large images are no longer embedded in the protocol body and are handled by the agent by path. */
  localPath?: string;
}
export interface ZCodePromptFileAttachment {
  kind: "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Attachment source; clipboard-text means long pasted text was written to disk and the agent should treat it only as a temporary file reference. */
  sourceKind?: "clipboard-text" | "topic-history";
  messageCount?: number;
  /** Compatibility fallback for older/pathless environments; the new Desktop GUI no longer sends base64 for ordinary files. */
  dataBase64?: string;
  /** Small-text fallback when there is no local path; when localPath exists, the agent reads it directly. */
  textContent?: string;
  localPath?: string;
}
export interface ZCodePromptAudioAttachment {
  kind: "audio";
  filename: string;
  mimeType: string;
  /** agent AudioContent already carries mimeType separately, so only the raw base64 body is kept here. */
  dataBase64?: string;
  localPath?: string;
}
/** Video attachment: small Web videos use dataBase64; Desktop prefers zero-copy localPath. */
export interface ZCodePromptVideoAttachment {
  kind: "video";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** Raw base64 body; mimeType is carried separately in its own field. */
  dataBase64?: string;
  /** Actual local path on Desktop; the agent reads it by path and validates its size. */
  localPath?: string;
}
export interface ZCodePromptPdfAttachment {
  kind: "pdf";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  dataBase64?: string;
  localPath?: string;
}
export type ZCodePromptAttachment =
  | ZCodePromptImageAttachment
  | ZCodePromptAudioAttachment
  | ZCodePromptVideoAttachment
  | ZCodePromptPdfAttachment
  | ZCodePromptFileAttachment;
// ---- Task metadata ----

export type ZCodeTaskInteractionAutoResolution =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface ZCodeTaskPendingInteraction {
  interactionId: string;
  kind: "permission" | "userInput";
  /** Lightweight tool identity sent by sessions-index; remains compatible when older summaries omit it. */
  toolName?: string;
  autoResolution?: ZCodeTaskInteractionAutoResolution;
}

/** One child conversation (side chat or subagent) listed under its parent task row. */
export interface ZCodeTaskChildSession {
  sessionId: string;
  title: string;
  taskType: "selection_side_chat" | "subagent_child";
  lastActivityAt: number;
  /** True while the child's runtime is alive in the CLI host (subagents executing work). */
  running: boolean;
}

export interface ZCodeTaskMeta {
  /** UI taskId matches the ZCode agent sessionId, for list selection, log correlation, and session recovery. */
  taskId: string;
  /** Session/task-level observability traceId; not used to distinguish individual user inputs. */
  traceId: TraceId;
  /** Task title (user-provided or extracted from the first message). */
  title: string;
  /**
   * Whether the user manually overrode the task title.
   *
   * The running agent continues to send automatically generated titles; the UI needs to know when the current title was set manually
   * so that status/target/updatedAt updates do not temporarily overwrite it.
   */
  titleOverridden?: boolean;
  /** Associated workspace absolute path. */
  workspacePath: string;
  /**
   * Stable identity for a remote workspace (authority + canonicalPath).
   *
   * If persistence uses only workspacePath, “same path on different remote hosts” writes to the same directory,
   * causing task lists, snapshots, and logs to cross-contaminate. workspaceIdentity is added here for isolation.
   */
  workspaceIdentity?: string;
  /** Controller/renderer 任务列表投影使用；不参与 workspace identity 或持久化 key。 */
  sourceServerId?: string;
  /** Source directory 的用户可读名称；缺失时 UI 回退 sourceServerId。 */
  serverDisplayName?: string;
  /** app-owned workspace 分类；缺省为 project，不参与 workspaceKey。 */
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
  createdAt: number;
  updatedAt: number;
  mode: ZCodeTaskMode;
  model?: string;
  /**
   * Task-level reasoning effort.
   *
   * When changing effort in an active task, writing only to workspace settings.json would affect other tasks in the same workspace;
   * changing only the session could be overwritten by the workspace default on the next prompt. Persist task-local thoughtLevel here,
   * then replay it to the session before sending.
   */
  thoughtLevel?: string;
  /**
   * Epoch of the last confirmation that this task matches the workspace runtime baseline.
   *
   * Previously, using only workspacePreferredModel to decide whether to override the current task model
   * treated “switch model within a task on the same supplier” as global convergence and changed other tasks.
   * Record runtimeEpoch here to distinguish “keep the task's own model” from “converge after the runtime baseline actually changes.”
   */
  runtimeEpoch?: number;
  /** Agent provider used when creating this task; defaults to "glm" for older data. */
  provider?: ZCodeProvider;
  /** Migration source; absent for ordinary new tasks, used to identify native Claude Code history imports. */
  migrationSource?: ZCodeTaskMigrationSource;
  /**
   * Cron identity marker: which automation this session belongs to.
   *
   * Cron identity must be defined on the shared ZCodeTaskMeta for persistence, V4 UI, and service contracts
   * to use together, preventing a persisted field from becoming inaccessible through the type contract.
   */
  cronAutomationId?: string;
  /**
   * Off-peak task identity marker: which off-peak task this session/phantom row belongs to.
   * It is a sibling marker to cronAutomationId (off-peak does not reuse the cron marker); row ID = sessionId
   * preallocated at creation. The marker remains constant from creation through execution for the moon icon and system-group ownership.
   */
  offPeakTaskId?: string;
  /** Forked tasks retain their source taskId for UI title fallback and later tracing. */
  forkedFromTaskId?: string;
  /** Unread tasks record the latest time they were marked or became unread, preserving the blue dot across restarts. */
  unreadAt?: number;
  /** Persisted task state, recording the result of the latest prompt. */
  status?: ZCodeTaskPersistStatus;
  /** Head-of-queue blocking interaction summary from sessions-index, used to render sidebar state for unopened background tasks. */
  pendingInteraction?: ZCodeTaskPendingInteraction;
  /**
   * Displayable reason for the most recent failure.
   *
   * When mobile remote control disconnects, a live task_error may not arrive; after recovery, only meta.status=error is visible,
   * without the error text, making the user think the send never started. Persist the failure reason with task metadata here.
   */
  lastError?: ZCodeTaskLastError;
  /** Task-level repair history state, used to avoid rerunning one-time migration logic when reading snapshots. */
  repairState?: ZCodeTaskRepairState;
  /** Task-level file-change summary for list/title display only; fileChanges remains the source of truth for rollback. */
  changeSummary?: ZCodeTaskChangeSummary;
  /**
   * Execution worktree facts (session runs in a linked worktree while listed under this project's
   * workspace). Drives the sidebar worktree badge and the header/file-tree open-in-IDE target.
   * Mirrors the sessions-index sessionSummary field; absent for ordinary sessions.
   */
  executionWorktree?: { path: string; branchName?: string };
  /**
   * Sidebar child-conversation facts (spec: sidebar-child-conversation-counts.md): true totals so
   * the row icons never lie when childSessions is capped. Mirrors the sessions-index fields;
   * absent for sessions without children.
   */
  sideChatCount?: number;
  subagentCount?: number;
  runningSubagentCount?: number;
  childSessions?: ZCodeTaskChildSession[];

  /** True when the execution worktree directory is absent on disk. */
  executionWorktreeMissing?: boolean;
  /** True for an incognito session (specs/incognito-session.md); session-projection-owned. */
  incognito?: boolean;
  /** zcode-cli /goal session target; null means it was explicitly cleared. */
  target?: ZCodeTaskGoal | null;
}
export interface ZCodeTaskRepairState {
  /** Repair version for backfilling assistant message bodies in historical snapshots from Claude native logs. */
  claudeNativeSnapshotAssistantContentVersion?: number;
  /** Repair version for backfilling subagent tool blocks in historical snapshots from Codex native logs. */
  codexNativeSnapshotSubagentToolsVersion?: number;
}
export interface ZCodeTaskChangeSummary {
  /** Number of unique files involved in the task. */
  fileCount: number;
  /** Added lines aggregated from final file results. */
  added: number;
  /** Deleted lines aggregated from final file results. */
  removed: number;
  /** File summaries for files involved in the task. */
  files: ZCodeTaskChangedFileSummary[];
}
export interface ZCodeTaskChangedFileSummary {
  path: string;
  added: number;
  removed: number;
  /** Total number of times this file was written within the task. */
  writeCount: number;
  /** Turn number of the last write, reusable by the rollback button. */
  lastTurnIndex: number;
}
// ---- ZCode configuration and command types ----

/** UI projection of ZCode configOptions (extracted from the session/new response). */
export interface ZCodeConfigOption {
  id: string;
  name: string;
  description?: string;
  /** mode | model | thought_level | custom */
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  /** Option list when type === "select". */
  options?: ZCodeConfigSelectValue[];
}
export interface ZCodeConfigSelectValue {
  value: string;
  name: string;
  description?: string;
  /** Value source: native model list or session-injected item (for UI deduplication and display control). */
  origin?: "native" | "injected";
  /** Provider/group ID for the model option, used for provider → model group selection. */
  modelProviderId?: string;
  /** Display name of the provider/group for the model option. */
  modelProviderName?: string;
  /** Missing means the capability is unknown; an empty array means no reasoning levels are available. */
  modelThoughtLevels?: string[];
  /** Default reasoning level declared by the model catalog; does not indicate an explicit user selection. */
  modelDefaultThoughtLevel?: string;
}
export interface ZCodeSlashCommand {
  name: string;
  description: string;
  inputHint?: string;
  /** Command source; may be absent in older protocols, and clients should treat it as builtin for compatibility. */
  source?: "builtin" | "custom";
}
export interface ZCodeTaskModeInfo {
  id: string;
  name: string;
  description?: string;
}
// ---- ZCode stream events (Host → Renderer) ----

export type TaskStreamMirrorableEvent = (
  | ZCodeAgentMessageChunk
  | ZCodeAgentThoughtChunk
  | ZCodeToolCall
  | ZCodeToolCallUpdate
  | ZCodePlan
  | ZCodePermissionRequest
  | ZCodeTaskPermissionResponse
  | ZCodeElicitationRequest
  | ZCodeElicitationResponse
  | ZCodeTaskComplete
  | ZCodeTaskRunStarted
  | ZCodeTaskWarning
  | ZCodeTaskError
  | ZCodeConfigOptionUpdate
  | ZCodeAvailableCommandsUpdate
  | ZCodeModeUpdate
  | ZCodeSessionInfoUpdate
  | ZCodeGoalVerificationUpdate
  | ZCodeTaskTokenUsageDelta
  | ZCodeTaskNetworkDebugStatus
  | ZCodeUsageUpdate
  | ZCodeBackgroundTaskControlItemsUpdate
) & { inputId?: InputId };
export type ZCodeStreamEvent = (
  | TaskStreamMirrorableEvent
  | ZCodeGlmAgentModelStateUpdate
  | ZCodeGoalIterationStarted
  | ZCodeTurnSteerQueued
  | ZCodeTurnSteerStatus
  | TaskStreamMirrorBatch
  | ZCodeTaskSnapshotUpdated
) & { inputId?: InputId };
export type ZCodeTurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";
export type ZCodeTurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";
export interface ZCodeTurnSteerQueued {
  type: "turn_steer_queued";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  pendingInputId: string;
  messageId?: string;
  commandKind?: ZCodeTurnSteerCommandKind;
  source?: ZCodeTurnSteerSource;
  targetTurnId?: string;
  content: string;
  raw?: unknown;
}
export interface ZCodeTurnSteerStatus {
  type: "turn_steer_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryIds?: QueryId[];
  status: "drained" | "discarded" | "rejected";
  pendingInputIds?: string[];
  injectedMessageIds?: string[];
  targetTurnId?: string;
  reason?: string;
  raw?: unknown;
}
export interface ZCodeAgentMessageChunk {
  type: "agent_message_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Parent toolCallId; null means primary-agent message content. */
  parentToolUseId?: string | null;
  /** agent messageId; ZCode synthetic timeline messages use it for upsert. */
  messageId?: string;
  content: string;
  zcodeTimeline?: ZCodeTimelineMeta;
}
export interface ZCodeAgentThoughtChunk {
  type: "agent_thought_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Parent toolCallId; null means primary-agent reasoning. */
  parentToolUseId?: string | null;
  content: string;
}
export type ZCodeTimelineStatus =
  | "started"
  | "retrying"
  | "skipped"
  | "completed"
  | "failed"
  | "interrupted";
export type ZCodeTimelineTrigger = "manual" | "auto" | "reactive" | "partial" | "session_memory";
export type ZCodeContextCompactionTimelinePhase =
  | "standalone_turn"
  | "pre_request"
  | "mid_turn"
  | "reactive";
export type ZCodeTimelineMeta =
  | ZCodeContextCompactionTimelineMeta
  | ZCodeGoalVerificationTimelineMeta
  | ZCodeSessionForkTimelineMeta;
export interface ZCodeContextCompactionTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "context_compaction";
  operationId: string;
  status: ZCodeTimelineStatus;
  trigger: ZCodeTimelineTrigger;
  display: "separator";
  /**
   * Locally, `/compact` first renders an optimistic banner, while the agent lifecycle event arrives later.
   * Use inputId to merge them so the same compaction does not first show “Compacting” and then append a separate “Compacted” item.
   */
  inputId?: InputId;
  /** Retain the user's original `/compact ...` command for retries after failure. */
  command?: string;
  replace?: boolean;
  reason?: string;
  boundaryId?: string;
  summaryMessageId?: string;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  /** Distinguishes actual compaction boundaries such as mid_turn / pre_request, so the UI and E2E do not have to guess from text. */
  phase?: ZCodeContextCompactionTimelinePhase;
  startedAt?: number;
  endedAt?: number;
}
export interface ZCodeSessionForkTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "session_fork";
  display: "separator";
  parentSessionId: string;
  targetMessageId: string;
  /** A conversation-only fork has no workspace checkpoint; the UI only needs targetMessageId to jump back to the parent message. */
  targetCheckpointId?: string;
  restoredFileCount?: number;
}
export interface ZCodeToolCall {
  type: "tool_call";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** Parent toolCallId; null means the primary agent initiated the tool call directly. */
  parentToolUseId?: string | null;
  input: unknown;
  /** Fixed ZCode tool name; this field separates tool identity from the historical kind classification. */
  toolName?: string;
  /** Historical classification for compatibility; in current ZCode streams it usually equals toolName. */
  kind: string;
  /** agent ToolCall.title, a human-readable title describing the current tool action. */
  title: string;
  /** Raw agent ToolCall payload; use this when debugging protocol fields. */
  raw: unknown;
  pluginMetadata?: { pluginId: string; component: "mcp" };
  /** Skill resolved metadata；只用于 telemetry attribution。 */
  skillMetadata?: {
    name?: string;
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
  };
}
export interface ZCodeToolCallUpdate {
  type: "tool_call_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** Parent toolCallId; null means the primary agent initiated the tool call directly. */
  parentToolUseId?: string | null;
  status: "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";
  /**
   * Optional agent ToolCallUpdate.title; may be absent if the Agent did not update the title.
   */
  title?: string;
  /** Fixed ZCode tool name; ToolCallResult may include only toolId, which the service layer fills from the preceding call cache. */
  toolName?: string;
  /** Historical classification for compatibility; in current ZCode streams it usually equals toolName. */
  kind?: string;
  input?: unknown;
  content?: unknown;
  error?: string;
  /** Raw agent ToolCallUpdate payload; use this when debugging protocol fields. */
  raw: unknown;
  pluginMetadata?: { pluginId: string; component: "mcp" };
  /** Skill resolved metadata；只用于 telemetry attribution。 */
  skillMetadata?: {
    name?: string;
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
  };
}
export interface ZCodePlan {
  type: "plan";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  steps: ZCodePlanStep[];
}
export interface ZCodePlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}
export interface ZCodePermissionRequest {
  type: "permission_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  description: string;
  kind: string;
  title?: string;
  options: ZCodePermissionOption[];
  /** Whether V4 permission allows user feedback to accompany Deny. */
  freeText?: boolean;
  origin?: ZCodeInteractionRequestOrigin;
  /**
   * Confirmation preview reported by the tool, reusing the tool-call row display projection (same bounded shape).
   * Absent means a plain-text ask (the legacy v3 path explicitly strips this field).
   */
  display?: ToolCallDisplay;
  /** Raw agent RequestPermissionRequest.toolCall payload. */
  raw: unknown;
}
export interface ZCodeTaskPermissionResponse {
  type: "permission_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  optionId: string;
  response: ZCodePermissionResponse;
}
export interface ZCodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: ZCodePermissionResponse;
}
/** ZCode Elicitation request event for tools that require user interaction, such as AskUserQuestion. */
export interface ZCodeElicitationRequest {
  type: "elicitation_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  message: string;
  header?: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
  /** AskUserQuestion multi-question structure; when present, the UI collects all answers at once in tabs. */
  questions?: ZCodeElicitationQuestion[];
  /** Current question index synchronized by the remote-control link to preserve AskUserQuestion progress across devices. */
  currentQuestionIndex?: number;
  /** Draft answers synchronized by the remote-control link; keys are answer_0 / answer_1. */
  answerDrafts?: Record<string, string[]>;
  origin?: ZCodeInteractionRequestOrigin;
  /** Raw ElicitationSchema payload. */
  schema?: unknown;
}
/** One ZCode Elicitation question. */
export interface ZCodeElicitationQuestion {
  question: string;
  header: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
}
/** ZCode Elicitation option. */
export interface ZCodeElicitationOption {
  value: string;
  label: string;
  description?: string;
}
/** ZCode Elicitation response event. */
export interface ZCodeElicitationResponse {
  type: "elicitation_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
export interface ZCodeTaskComplete {
  type: "task_complete";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  stopReason: string;
  usage?: ZCodeUsage;
}
export interface ZCodeTaskRunStarted {
  inputOrigin?: "desktop" | "mobile";
  type: "task_run_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  startedAt: number;
}
export interface ZCodeGoalIterationStarted {
  type: "goal_iteration_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  targetId?: string;
  startedAt: number;
}
export interface ZCodeTaskError {
  type: "task_error";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  error: string;
  code?: string;
  detail?: string;
  attribution?: ErrorAttribution;
}
export interface ZCodeTaskWarning {
  type: "task_warning";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  warning: string;
  code?: string;
  detail?: string;
}
export interface ZCodeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tokens consumed by reasoning/thinking; matches agent `thoughtTokens`. */
  reasoningTokens?: number;
  /** Number of input tokens read from cache. */
  cachedInputTokens?: number;
  /** Number of input tokens written to cache. */
  cachedWriteInputTokens?: number;
}
export interface ZCodeContextCacheUsage {
  /** Input token count for the most recent primary turn reported by the Provider. */
  inputTokens: number;
  /** Cache-read token count for the most recent primary turn reported by the Provider. */
  cacheReadTokens: number;
  /** Cache-write token count for the most recent primary turn reported by the Provider. */
  cacheWriteTokens: number;
  /** Cache hit rate for the most recent primary-turn provider usage; null when unknown. */
  latestHitRate?: number | null;
  /** Number of primary-turn requests included in the cumulative average. */
  hitRateRequestCount?: number;
  /** Total primary-turn input tokens included in the cumulative average. */
  totalInputTokens?: number;
  /** Total primary-turn cache-read tokens included in the cumulative average. */
  totalCacheReadTokens?: number;
  /** Total primary-turn cache-write tokens included in the cumulative average. */
  totalCacheWriteTokens?: number;
  /** Cumulative average cache hit rate for primary turns, normalized by Agent and returned to the app; null when unknown. */
  hitRate: number | null;
}
/** Cumulative task token delta pushed by Agent after each model request completes. */
export interface ZCodeTaskTokenUsageDelta {
  type: "task_token_usage_delta";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  /** Stable deduplication key, usually from ZCode Protocol eventId. */
  eventKey: string;
  eventId?: string;
  querySource?: string;
  usage: ZCodeUsage;
}
export type ZCodeTaskNetworkDebugStatusType =
  | "model_request_started"
  | "model_request_completed"
  | "model_request_failed"
  | "model_retry_scheduled"
  | "model_stream_stalled";
/** Agent model-network status debug event; carries only metadata and redacted headers, never the response body/data. */
export interface ZCodeTaskNetworkDebugStatus {
  type: "task_network_debug_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  eventKey: string;
  eventId?: string;
  statusType: ZCodeTaskNetworkDebugStatusType;
  requestId?: string;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: string;
  baseURL?: string;
  querySource?: string;
  attempt?: number;
  maxAttempts?: number;
  nextAttempt?: number;
  retryable?: boolean;
  statusCode?: number;
  durationMs?: number;
  delayMs?: number;
  idleMs?: number;
  timeoutMs?: number;
  reason?: string;
  message?: string;
  timestamp?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestHeaderCount: number;
  responseHeaderCount: number;
}
// ---- Additional stream event types ----

/** Agent proactively pushes configuration changes (for example, rate-limit model downgrade or linked mode changes). */
export interface ZCodeConfigOptionUpdate {
  type: "config_option_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  configOptions: ZCodeConfigOption[];
}
/** Specific to zcode-cli/GLM agent: synchronizes reasoning-level options and context window after a model change. */
export interface ZCodeGlmAgentModelStateUpdate extends ZCodeGlmAgentModelStateUpdatePayload {
  type: "glm_agent_model_state_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
}
/** Agent pushes the list of available slash commands. */
export interface ZCodeAvailableCommandsUpdate {
  type: "available_commands_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  commands: ZCodeSlashCommand[];
}
/** Agent pushes mode changes (for example, automatically switching from architect to code). */
export interface ZCodeModeUpdate {
  type: "mode_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  currentModeId: string;
  availableModes: ZCodeTaskModeInfo[];
}
/** Temporary state when the Agent API encounters a retryable error; used only by in-memory UI, not persisted with the task.
 * attempt is the retry number currently in progress, starting at 1; it is not the total number of attempts.
 */
export interface ZCodeApiRetryStatus {
  kind: "api_retry";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
}
/** Agent pushes session title and other metadata updates. */
export interface ZCodeSessionInfoUpdate {
  type: "session_info_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  title?: string | null;
  /**
   * Optional API retry-state patch.
   *
   * `undefined` means this session_info_update did not touch the field;
   * `null` explicitly clears retry state;
   * an object means retrying has started or was updated.
   */
  apiRetry?: ZCodeApiRetryStatus | null;
  /**
   * /goal state patch projected by zcode-cli through the compatible session_info_update._meta.zcode.target field.
   * `undefined` means the target did not change; `target: null` means it was cleared.
   */
  target?: ZCodeTaskGoalChangedPatch;
}
export interface ZCodeGoalVerificationUpdate {
  type: "goal_verification_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  verification: ZCodeGoalVerification;
}
/** Agent pushes live context-window usage. */
export interface ZCodeUsageUpdate {
  type: "usage_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Total context-window size (tokens). */
  size: number;
  /** Number of tokens currently used. */
  used: number;
  /** Cumulative cost. */
  cost?: { amount: number; currency: string } | null;
  /** Cache-hit information exposed by the current primary-turn provider usage. */
  cache?: ZCodeContextCacheUsage;
  /** Context character count estimated by Agent by source for UI proportions; not a token ledger. */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}
/** Background-task controls reported by the Agent runtime; describes only current Host in-memory state and is not written to session files. */
export interface ZCodeBackgroundTaskControlItemsUpdate {
  type: "background_bash_jobs_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  jobs: ZCodeBackgroundTaskControlItem[];
}
/** Notifies the UI to reload the snapshot after residual data is flushed, so late stream data can be rendered. */
export interface ZCodeTaskSnapshotUpdated {
  type: "task_snapshot_updated";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  reason?: TaskRealtimeReason;
  eventId?: string;
  runId?: string;
  streamWatermark?: TaskStreamWatermark;
}
export type ZCodeTaskClientMode = "desktop-continuous" | "web-remote-replayable";
export type ZCodeTaskRuntimeCommandStatus = "accepted" | "running" | "failed";
export interface ZCodeTaskRuntimeCommandBase {
  commandId: string;
  taskId: string;
  traceId: TraceId;
  queryId?: QueryId;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  status: ZCodeTaskRuntimeCommandStatus;
  createdAt: number;
  updatedAt: number;
  clientId?: string;
  clientLabel?: string;
  error?: string;
}
export interface ZCodeTaskSendPromptCommand extends ZCodeTaskRuntimeCommandBase {
  type: "send_prompt";
  content: string;
  attachments?: ZCodePromptAttachment[];
  /** Host commands dispatched by scheduled tasks must retain automation context, preventing CronCreate from becoming available again after the queue drains. */
  automationId?: string;
}
export type ZCodeTaskRuntimeCommand = ZCodeTaskSendPromptCommand;
export interface TaskStreamMirrorBatch {
  type: "task_stream_mirror_batch";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  runId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  batchSeq: number;
  fromSeq: number;
  toSeq: number;
  ops: TaskStreamMirrorOp[];
  terminal: boolean;
}
// ---- Persistence format ----

export interface ZCodeSessionFile {
  meta: ZCodeTaskMeta;
  messages: ZCodePersistedMessage[];
  /** File-change records, stored by turn. */
  fileChanges?: ZCodePersistedFileChange[];
  /** Git checkpoint metadata, stored by turn and used only to orchestrate undo. */
  turnCheckpoints?: ZCodePersistedTurnCheckpoint[];
}
export interface ZCodeSessionRuntimeSnapshot {
  pendingPermissions?: ZCodePermissionRequest[];
  pendingElicitations?: ZCodeElicitationRequest[];
  /** Active-turn type for the current session; lets the UI distinguish ordinary streaming from compact maintenance state. */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  /** Agent API network retry is a runtime hint; restored only from snapshots and not written to session JSON. */
  apiRetry?: ZCodeApiRetryStatus | null;
  /** Context-window usage from the ZCode Protocol projection, used to restore the bottom-right context meter in the legacy task UI. */
  contextUsage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
    cache?: ZCodeContextCacheUsage;
    breakdown?: ZCodeContextUsageBreakdownItem[];
  };
  streamWatermark?: TaskStreamWatermark;
  pendingCommands?: ZCodeTaskRuntimeCommand[];
  /**
   * Restored state projected from persistent todos in the agent session store.
   * The UI uses it only to restore the todo panel and does not write this field back to legacy session JSON.
   */
  plan?: ZCodePlanStep[] | null;
  /**
   * Runtime projection of the goal summary; computed on demand from the agent DB / message tool parts and not written to task-index.
   */
  goalStats?: ZCodeTaskGoalStats | null;
  goalVerifications?: ZCodeGoalVerification[] | null;
  goalVerificationTimeline?: ZCodeGoalVerificationTimelineMeta[] | null;
  /**
   * Grouped todos projected from historical session TodoWrite messages; used to restore display, not as the authoritative todo store.
   */
  todoGroups?: ZCodeTodoGroup[] | null;
  /** Compatibility field for Host/runtime in-memory background task controls; restored from snapshots but not persisted to session JSON. */
  backgroundBashJobs?: ZCodeBackgroundTaskControlItem[];
}
export interface ZCodeTaskSnapshotHistory {
  /** Whether the response history window omitted earlier messages; returned only by getTaskSnapshot and not written to session JSON. */
  truncatedBefore: boolean;
  /** Total visible message count before trimming, used by the UI to determine whether earlier history can be fetched. */
  totalMessages: number;
}
export type ZCodeTaskSnapshot = ZCodeSessionFile & {
  /** Non-persistent runtime state assembled and returned only by getTaskSnapshot; must not be written to session JSON. */
  runtime?: ZCodeSessionRuntimeSnapshot;
  /** Non-persistent history-window metadata, describing only whether this snapshot response is a tail window. */
  history?: ZCodeTaskSnapshotHistory;
  /** Visible command list returned by Agent/app communication; used to restore the `/` panel and not written to session JSON. */
  slashCommands?: ZCodeSlashCommand[];
  /** UI configuration projected from session settings; returned only with snapshots and not written to session JSON. */
  configOptions?: ZCodeConfigOption[];
};
export type ZCodeTurnFileState = "applied" | "reverted";
/** Persisted per-turn file changes. */
export interface ZCodePersistedFileChange {
  turnIndex: number;
  snapshots: ZCodePersistedFileSnapshot[];
  /** Whether this turn's file changes are still applied in the workspace. */
  fileState?: ZCodeTurnFileState;
}
/** Persisted per-turn file checkpoint metadata. */
export interface ZCodePersistedTurnCheckpoint {
  turnIndex: number;
  /** File-state checkpoint from before the turn started. */
  baseFileCheckpointId: string;
  /** File-state checkpoint from after the turn ended; may be absent if the turn is incomplete. */
  resultFileCheckpointId?: string;
}
/** Persisted file snapshot. */
export interface ZCodePersistedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
  /** Response snapshot only: indicates the file snapshot body was trimmed to fit the initial-view budget and full content can be fetched by ref. */
  contentRefs?: ZCodeTaskSnapshotFileContentRef[];
}
/** Parts element for a persisted message, recording the interleaved order of content / thought / tool calls.
 *  Used to restore the UI parts array when loading history, so text and tool calls retain their original order. */
export type ZCodePersistedMessagePart =
  | { type: "content"; content: string }
  | { type: "thought"; content: string }
  | { type: "tool-call"; toolIndex: number };
export type ZCodeAssistantMessageFeedback = "like" | "dislike";
export type ZCodeAssistantCheckpointState = "partial";
export type ZCodeAssistantCheckpointReason = "tool_completed" | "part_boundary" | "periodic";
export interface ZCodePersistedMessage {
  /** Original protocol messageId; keeps live messages and timeline dividers restored from snapshots under the same identity. */
  id?: string;
  /** Original messageId set retained after assistant projection merges, so timeline anchors can still match merged child messages. */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Legacy goal display iteration associated with the assistant; used only for UI history status rows, not verifier-round decisions. */
  goalIteration?: number;
  /** Model associated with this message when sent; readers fall back to task.meta.model when missing from old history. */
  model?: string;
  /** Plain-text character-count snapshot; token estimates use a shared constant divisor and can be recalculated if the method changes. */
  characterCount?: number;
  /** Final elapsed time for the assistant history row; persisted only after the turn ends to avoid inaccurate duration estimates from timestamps during restore. */
  durationMs?: number;
  /** Whether the assistant ended due to a user stop or abnormal interruption; used to prevent promotion in the latest-reply area. */
  interrupted?: boolean;
  /** Local user feedback on the assistant response; for ZCode display/metrics only and not injected into Agent context. */
  feedback?: ZCodeAssistantMessageFeedback;
  /** Display-only pin bookmark (unix ms, CLI clock); presence means pinned. For ZCode display only and not injected into Agent context. */
  pinnedAt?: number;
  attachments?: ZCodePromptAttachment[];
  tools?: ZCodePersistedToolCall[];
  thought?: string;
  /** Interleaved order of message parts, preserving content and tool-call order during history restore. */
  parts?: ZCodePersistedMessagePart[];
  /** Snapshot of the assistant while running; restores to the latest parts boundary after a crash/restart and does not indicate natural turn completion. */
  checkpointState?: ZCodeAssistantCheckpointState;
  checkpointReason?: ZCodeAssistantCheckpointReason;
  checkpointUpdatedAt?: number;
  /** Conversation turn for this message, used to associate per-turn file-change summaries and rollback. */
  turnIndex?: number;
  /** Response snapshot only: indicates large fields were trimmed for the initial-view budget and full content can be fetched by ref. */
  bodyRefs?: ZCodeTaskSnapshotBodyRef[];
  /** Response snapshot only: slice metadata when tools are trimmed by count, used to fetch more tool calls. */
  toolSlice?: ZCodeTaskSnapshotToolSlice;
  /** Synthetic divider metadata (context_compaction / session_fork), restored with snapshots for UI separator rendering. */
  syntheticTimeline?: ZCodeTimelineMeta;
}
export type ZCodeTaskSnapshotBodyField = "content" | "thought";
export interface ZCodeTaskSnapshotBodyRef {
  field: ZCodeTaskSnapshotBodyField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export type ZCodeTaskSnapshotToolField = "input" | "output" | "raw";
export type ZCodeTaskSnapshotFileContentField = "beforeContent" | "afterContent";
export interface ZCodeTaskSnapshotToolFieldRef {
  field: ZCodeTaskSnapshotToolField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export interface ZCodeTaskSnapshotFileContentRef {
  field: ZCodeTaskSnapshotFileContentField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export interface ZCodeTaskSnapshotToolSlice {
  persistedMessageIndex: number;
  totalTools: number;
  startToolIndex: number;
  endToolIndexExclusive: number;
}
export interface ZCodePersistedToolCall {
  /** Fixed ZCode tool name; older snapshots may have stored title here, so readers must remain compatible. */
  toolName?: string;
  title?: string;
  kind?: string;
  status?: "completed" | "failed" | "denied" | "stopped";
  input: unknown;
  output?: unknown;
  error?: string;
  raw?: unknown;
  /** Response snapshot only: indicates large tool fields were trimmed for the initial-view budget and full content can be fetched by ref. */
  snapshotRefs?: ZCodeTaskSnapshotToolFieldRef[];
}
export type TaskRealtimeReason =
  | "task_created"
  | "user_message_saved"
  | "assistant_message_saved"
  | "task_status_changed"
  | "task_meta_changed"
  // Pure configuration changes such as model switches were previously broadcast as task_meta_changed, so the UI could not distinguish
  // “membership-related metadata changes (rename/unread)” from “configuration changes unrelated to list membership,”
  // causing every model switch to refetch global membership and refresh the whole table. A separate reason lets the policy layer downgrade precisely.
  | "task_model_changed"
  // Title updates (title written from the first message / generated automatically at turn close) are also frequent and unrelated to membership;
  // including them in task_meta_changed would refetch global membership on every send/turn close.
  | "task_title_changed"
  | "task_pinned"
  | "task_unpinned"
  | "task_archived"
  | "task_unarchived"
  | "task_deleted"
  | "stream_mirror_gap"
  | "stream_mirror_owner_lost";
export interface TaskStreamMirrorUserMessageOp {
  kind: "user_message";
  messageId: string;
  content: string;
  attachments?: ZCodePromptAttachment[];
  timestamp: number;
}
export interface TaskStreamMirrorStreamEventOp {
  kind: "stream_event";
  event: TaskStreamMirrorableEvent;
}
export type TaskStreamMirrorOp =
  | (TaskStreamMirrorUserMessageOp & { seq: number })
  | (TaskStreamMirrorStreamEventOp & { seq: number });
export interface TaskStreamWatermark {
  runId: string;
  opSeq: number;
}
