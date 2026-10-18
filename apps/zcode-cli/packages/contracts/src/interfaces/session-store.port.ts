// Session Store Port: stable storage boundary for session inputs, messages, and projections.
// ============================================================

import type {
  MessageId,
  PartId,
  ProjectId,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
  WorkspaceId,
} from "./shared.js";
import type {
  CompactBoundaryPayload,
  CompactPhase,
  CompactReason,
  CompactTimelineDisplay,
  CompactTimelineStatus,
  CompactTrigger,
} from "../compact/index.js";
import type {
  ModelId,
  ModelProviderId,
  ModelSelection,
  ModelToolSideEffectScope,
} from "../model/index.js";
import type { TodoItem } from "../tools/todo.js";
import type { SessionGoal, GoalStatus } from "../tools/target.js";
import type { PermissionRuleset } from "./permission.port.js";
import type { CollaborationMode } from "./session.port.js";
import type { EnvInfo } from "./context-source.port.js";

export const SESSION_TASK_TYPES = [
  "interactive",
  "fork",
  "selection_side_chat",
  "workflow_parent",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
] as const;
export type SessionTaskType = (typeof SESSION_TASK_TYPES)[number];

export const SESSION_TITLE_SOURCES = ["default", "first_input", "generated", "custom"] as const;
export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

export const MESSAGE_VISIBILITIES = ["user-visible", "model-only"] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

export const SYNTHETIC_USER_MESSAGE_SOURCES = [
  "agent_listing_delta",
  "background_task",
  "fork",
  "goal_state_change",
  "goal-continuation",
  "plugin_reference",
  "bot_topic_context",
  "rewind",
  "selection_side_chat",
  "subagent",
  "subagent_message",
  "todo_reminder",
  // Source of the user message created when the central interface directly starts a saved workflow.
  // It is synthetic (the GUI renders a launch card from metadata rather than showing the text), but
  // semantically represents a real user action: origin=real_user, kind=user_prompt, unlike other
  // runtime-injected reminder sources.
  "workflow_launch",
  "shared_context",
] as const;
export type SyntheticUserMessageSource = (typeof SYNTHETIC_USER_MESSAGE_SOURCES)[number];

export type MessageSemanticsOrigin =
  | "real_user"
  | "agent_runtime"
  | "system"
  | "migration"
  | "import";

export type MessageSemanticsKind =
  | "user_prompt"
  | "slash_command"
  | "system_reminder"
  | "background_notification"
  | "subagent_notification"
  | "todo_reminder"
  | "rewind_notice"
  | "fork_notice"
  | "timeline_event"
  | "compact_summary"
  | "shared_context"
  | "assistant_response";

export interface MessageSemantics {
  origin: MessageSemanticsOrigin;
  kind: MessageSemanticsKind;
  source?: string;
  commandName?: string;
  uiVisibility: "visible" | "hidden" | "debug";
  providerVisibility: "visible" | "hidden";
  transcriptVisibility: "visible" | "hidden";
}

// v4 projection anchor vocabulary (userInput.origin).
// Coexists with MessageSemanticsOrigin; neither replaces the other: semantics.origin is the legacy
// read-side meaning, while anchor.origin drives new protocol-row derivation. Older values are mapped
// read-only by the consumer.
export const MESSAGE_ANCHOR_ORIGINS = [
  "realUser",
  "backgroundResult",
  "goalContinuation",
  "mailbox",
  "synthetic",
] as const;
export type MessageAnchorOrigin = (typeof MESSAGE_ANCHOR_ORIGINS)[number];

/**
 * Goal fact at the fork point for a stable fork. `undefined` means legacy data only; new data must
 * explicitly write `none` or a complete snapshot so a fork does not mistake the parent's current
 * goal for historical state.
 */
export type StableForkGoalBoundaryMetadata =
  | { kind: "none" }
  | {
      kind: "snapshot";
      target: SessionGoal;
      verificationEntryIds: string[];
    };

/**
 * v4 transcript anchors (manifest): all optional, evolving additively through the message JSON blob;
 * historical data remains empty and readers degrade gracefully.
 * sourceCommandId is a fallback deduplication key for command-idempotent transcript entries; it is
 * written after the v4 command inbox is wired up.
 */
export interface MessageProjectionAnchor {
  turnId?: TurnId;
  origin?: MessageAnchorOrigin;
  sourceCommandId?: string;
  /** Historical turn index where the final assistant response committed the current query, for exact cold hydration. */
  historyRoundCount?: number;
  /** Stable-fork boundary for new data; absent on historical messages and lazily backfilled when the unique resolver is unambiguous. */
  productTurnId?: string;
  orderedMessageIds?: MessageId[];
  boundaryMessageId?: MessageId;
  goalBoundary?: StableForkGoalBoundaryMetadata;
}

export interface SessionInfo {
  id: SessionId;
  projectID: ProjectId;
  workspaceID?: WorkspaceId;
  parentID?: SessionId;
  traceID?: TraceId;
  taskType: SessionTaskType;
  slug: string;
  directory: string;
  path?: string;
  /**
   * Execution worktree facts (see docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md,
   * "execution worktree" section). directory/path keep the parent workspace so listing filters stay
   * correct; cold resume restores workingDirectory from executionDirectory first.
   */
  executionDirectory?: string;
  executionBranch?: string;
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  version: string;
  shareURL?: string;
  summaryAdditions?: number;
  summaryDeletions?: number;
  summaryFiles?: number;
  summaryDiffs?: FileDiff[];
  revert?: SessionRevert;
  permission?: PermissionRuleset;
  time: {
    created: number;
    updated: number;
    titleUpdated?: number;
    compacting?: number;
    archived?: number;
  };
}

export interface CreateSessionInput {
  id: SessionId;
  projectID: ProjectId;
  workspaceID?: WorkspaceId;
  parentID?: SessionId;
  traceID?: TraceId;
  taskType?: SessionTaskType;
  slug: string;
  directory: string;
  path?: string;
  executionDirectory?: string;
  executionBranch?: string;
  title: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId;
  version: string;
  shareURL?: string;
  permission?: PermissionRuleset;
  time?: {
    created?: number;
    updated?: number;
  };
}

/** Target product turn segment fixed by the V4 stable-fork resolver. */
export interface StableForkTargetMetadata {
  productTurnId: string;
  transcriptTurnId: string;
  orderedMessageIds: string[];
  boundaryMessageId: string;
}

/** Command-idempotency fact persisted in the same transaction as the child session. */
export interface ForkChildSessionMetadata {
  parentSessionId: string;
  sourceCommandId: string;
  forkTarget: StableForkTargetMetadata;
}

export type ForkCommandResult =
  | { type: "forkAssistant"; sessionId: string }
  | { type: "createSelectionSideSession"; sessionId: string }
  | { type: "editUserQuery"; disposition: "fork"; sessionId: string };

/**
 * The only atomic commit payload for a conversation fork. Core completes remapping in memory; the
 * adapter makes no business decisions and only guarantees that child/copy/goal/entries/input/parent
 * command fact are all persisted or none are.
 */
export interface ForkCommitBundle {
  child: CreateSessionInput;
  messages: MessageWithParts[];
  entries: SessionEntryInfo[];
  /** Stored copy source (target ID -> parent record ID); retained only for legacy disk snapshots and not used for model selection. */
  copySources?: { messages: Record<string, string>; parts: Record<string, string> };
  goal?: { source: SessionGoal; status: GoalStatus };
  initialInput?: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  };
  commandFact: {
    parentSessionId: string;
    sourceCommandId: string;
    ack: {
      commandId: string;
      status: "accepted";
      revisionAtDecision: number;
      result: ForkCommandResult;
    };
    metadata: Record<string, unknown>;
  };
}

export interface UpdateSessionInput {
  id: SessionId;
  directory?: string;
  path?: string | null;
  timeUpdated?: number;
  title?: string;
  titleSource?: SessionTitleSource;
  titleMessageID?: MessageId | null;
  expectedTitleSources?: readonly SessionTitleSource[];
  shareURL?: string | null;
  summary?: {
    additions?: number;
    deletions?: number;
    files?: number;
    diffs?: FileDiff[];
  } | null;
  revert?: SessionRevert | null;
  permission?: PermissionRuleset | null;
  timeCompacting?: number | null;
  timeArchived?: number | null;
}

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  oldPath?: string;
  newPath?: string;
}

export interface SessionRevert {
  messageID: MessageId;
  partID?: PartId;
  snapshot?: string;
  diff?: string;
  kind?: "conversation_rewind";
  scope?: "conversation" | "workspace" | "both";
  targetMessageID?: MessageId;
  createdMessageID?: MessageId;
  keptMessageIDs?: MessageId[];
  /**
   * Cut cursor for an append-only conversation branch: the last persisted message before this rewind
   * is committed. Active branch = keptMessageIDs + messages appended afterward. Legacy
   * createdMessageID is retained only for compatibility.
   */
  branchCutAfterMessageID?: MessageId;
  /** Monotonically incremented on each destructive conversation rewind to isolate asynchronous results from old branches. */
  branchGeneration?: number;
}

export interface ListSessionsInput {
  projectID?: ProjectId;
  /** undefined = no identity filter; null = only local / legacy empty identity; string = exact workspace identity. */
  workspaceID?: WorkspaceId | null;
  directory?: string;
  path?: string;
  roots?: boolean;
  taskTypes?: SessionTaskType[];
  includeArchived?: boolean;
  limit?: number;
}

export interface ClaimLegacySessionWorkspaceInput {
  sessionIDs: SessionId[];
  directory: string;
  workspaceID: WorkspaceId;
}

export interface RepairLegacyRemoteSessionWorkspaceInput {
  sessionID: SessionId;
  projectID: ProjectId;
  legacyWorkspaceDirectory: string;
  workspaceID: WorkspaceId;
  workspacePath: string;
}

export interface RepairRemoteSessionPathsInput {
  sessionID: SessionId;
  workspaceID: WorkspaceId;
  expectedDirectory: string;
  expectedPath: string | null;
  directory: string;
  path: string | null;
  timeUpdated: number;
}

export type OutputFormat =
  | { type: "text" }
  | { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };

export interface MessageSummary {
  title?: string;
  body?: string;
  diffs: FileDiff[];
}

export interface MessageContextSnapshot {
  envInfo?: EnvInfo;
}

export interface UserMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "user";
  time: {
    created: number;
  };
  format?: OutputFormat;
  summary?: MessageSummary;
  agent: string;
  /** Synthetic messages in unbound sessions and old messages without model information do not fabricate request provenance. */
  modelSelection?: ModelSelection;
  system?: string;
  tools?: Record<string, boolean>;
  contextSnapshot?: MessageContextSnapshot;
  synthetic?: boolean;
  source?: SyntheticUserMessageSource;
  visibility?: MessageVisibility;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  metadata?: Record<string, unknown>;
}

export interface AssistantErrorInfo {
  name: string;
  data?: Record<string, unknown>;
}

export interface TokenUsageInfo {
  total?: number;
  input: number;
  output: number;
  reasoning: number;
  cache: {
    read: number;
    write: number;
  };
}

export interface AssistantMessageInfo {
  id: MessageId;
  sessionID: SessionId;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  error?: AssistantErrorInfo;
  parentID: MessageId;
  /** Actual model output should include its source; synthetic timelines restored from history may have no executing model. */
  modelId?: ModelId;
  providerId?: ModelProviderId;
  mode: string;
  /** Plan state corresponding to the current output; when absent in older records, interpret using the old mode without backfilling history. */
  planEnabled?: boolean;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: TokenUsageInfo;
  structured?: unknown;
  reasoningLevel?: string;
  finish?: string;
  semantics?: MessageSemantics;
  anchor?: MessageProjectionAnchor;
  /** Additional domain semantics (such as forkOrigin provenance for fork copies). */
  metadata?: Record<string, unknown>;
}

export type MessageInfo = UserMessageInfo | AssistantMessageInfo;

export interface TextPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface ReasoningPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "reasoning";
  text: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end?: number;
  };
}

export type FilePartSource =
  | {
      type: "file";
      path: string;
      text: { value: string; start: number; end: number };
    }
  | {
      type: "symbol";
      path: string;
      range: unknown;
      name: string;
      kind: number;
      text: { value: string; start: number; end: number };
    }
  | {
      type: "resource";
      clientName: string;
      uri: string;
      text: { value: string; start: number; end: number };
    };

export interface AttachmentStorageMetadata {
  sizeBytes?: number;
  sha256?: string;
  image?: {
    maxDimension?: number;
    originalWidth?: number;
    originalHeight?: number;
    width?: number;
    height?: number;
    resized?: boolean;
    transformedSizeBytes?: number;
  };
  storageKind?: "inline" | "artifact" | "local_ref" | "remote_ref" | "metadata_only";
  artifactUri?: string;
  originalUrl?: string;
  recoverability?: "provider_ready" | "rebuildable" | "preview_only" | "metadata_only" | "missing";
  preview?: {
    text?: string;
    truncated?: boolean;
    originalBytes?: number;
    startLine?: number;
    totalLines?: number;
    truncatedByTokenCap?: boolean;
    partialViewNotice?: string;
  };
  errorCode?: string;
}

export interface FilePart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
  metadata?: AttachmentStorageMetadata;
}

export interface AgentPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
}

export interface CompactionPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "compaction";
  auto: boolean;
  trigger?: CompactTrigger;
  phase?: CompactPhase;
  compactReason?: CompactReason;
  overflow?: boolean;
  tail_start_id?: MessageId;
  compactBoundary?: CompactBoundaryPayload;
  operationId?: string;
  timelineStatus?: CompactTimelineStatus;
  timelineDisplay?: CompactTimelineDisplay;
  timelineText?: string;
  replace?: boolean;
  reason?: string;
  boundaryId?: string;
  summaryMessageId?: MessageId;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  time?: {
    start?: number;
    end?: number;
  };
}

export type TimelinePartDisplay = "separator" | "worklog";

export type TimelinePartStatus =
  | "started"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | string;

export interface TimelineModelSelection extends ModelSelection {
  label?: string;
}

export interface TimelinePartBase {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "timeline";
  display: TimelinePartDisplay;
  status?: TimelinePartStatus;
  anchorMessageId?: MessageId;
  anchorTurnId?: TurnId;
  /** Deduplication anchor for markers created by user commands; omitted for auto/system markers. */
  sourceCommandId?: string;
  /**
   * Degraded provenance for fork copies: when an anchor points to a message / parent turn that was
   * not copied, clear the local anchor (it must not affect child placement) and retain the original
   * reference only in origin* fields for tracing.
   */
  originAnchorMessageId?: MessageId;
  originAnchorTurnId?: TurnId;
  time?: {
    start?: number;
    end?: number;
  };
}

export interface ContextCompactionTimelinePart extends TimelinePartBase {
  timelineType: "context_compaction";
  operationId: string;
  trigger: CompactTrigger;
  phase?: CompactPhase;
  compactReason?: CompactReason;
  boundaryId?: string;
  summaryMessageId?: MessageId;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
}

export interface GoalVerificationTimelinePart extends TimelinePartBase {
  timelineType: "goal_verification";
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  verification?: {
    passed: boolean;
    reason: string;
    nextAction?: string | null;
  };
}

export interface SessionForkTimelinePart extends TimelinePartBase {
  timelineType: "session_fork";
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFileCount?: number;
}

export interface ModelChangeTimelinePart extends TimelinePartBase {
  timelineType: "model_change";
  fromModel?: TimelineModelSelection;
  /** Model configuration may be absent after rollback and upgrade; do not discard the entire history entry for that reason. */
  toModel?: TimelineModelSelection & { label: string };
}

export type TimelinePart =
  | ContextCompactionTimelinePart
  | GoalVerificationTimelinePart
  | SessionForkTimelinePart
  | ModelChangeTimelinePart;

export type TimelinePartDraft = TimelinePart extends infer Part
  ? Part extends TimelinePart
    ? Omit<Part, "id" | "messageID" | "sessionID" | "type">
    : never
  : never;

export interface SubtaskPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerId: ModelProviderId;
    modelId: ModelId;
  };
  command?: string;
}

export interface RetryPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "retry";
  attempt: number;
  error: AssistantErrorInfo;
  time: {
    created: number;
  };
}

export interface StepStartPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-start";
  snapshot?: string;
}

export interface StepFinishPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: TokenUsageInfo;
}

export interface SnapshotPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "snapshot";
  snapshot: string;
}

export interface PatchPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "patch";
  hash: string;
  files: string[];
}

export interface ToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface ToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
  };
}

export interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  attachments?: FilePart[];
}

export interface ToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export interface ToolPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "tool";
  callID: string;
  /** Declaration order of local tools within the same assistant message; absent in older records and must not be replaced with persistence order. */
  declarationIndex?: number;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | FilePart
  | AgentPart
  | CompactionPart
  | TimelinePart
  | SubtaskPart
  | RetryPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | ToolPart;

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

/** Single-transaction payload for a shared import: new session, unique model-only context, and provenance are all persisted or none are. */
export interface SharedContextImportCommitBundle {
  session: CreateSessionInput;
  contextMessage: MessageWithParts;
  provenance: SessionEntryInfo;
}

export type SharedContextImportStatus = "pending" | "reserved" | "attached" | "discarded";

export interface SharedContextImportTransition {
  sessionID: SessionId;
  contextId: string;
  expectedStatus: SharedContextImportStatus | readonly SharedContextImportStatus[];
  status: SharedContextImportStatus;
  /** queue/input identity or accepted user message identity for audit/recovery. */
  sourceId?: string;
}

export const SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION =
  "target_completion_verification" as const;
export const SESSION_ENTRY_BASH_SHELL_SELECTION = "runtime/bash_shell_selection" as const;
export const SESSION_ENTRY_MODEL_SELECTION = "runtime/model_selection" as const;
export const SESSION_ENTRY_EXECUTION_STATE = "runtime/execution_state" as const;
export const SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION =
  "runtime/user_input_auto_resolution" as const;
export const SESSION_ENTRY_WORKSPACE_CHECKPOINT = "runtime/workspace_checkpoint" as const;
export const SESSION_ENTRY_WORKSPACE_FILE_REWIND = "runtime/workspace_file_rewind" as const;
/** Dynamic-workflow tools have been activated in this session (docs/dynamic-workflow/launch.md, “On demand: activation”). */
export const SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION =
  "runtime/dynamic_workflow_activation" as const;

export const SESSION_ENTRY_TYPES = [
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_BASH_SHELL_SELECTION,
  SESSION_ENTRY_MODEL_SELECTION,
  SESSION_ENTRY_EXECUTION_STATE,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SESSION_ENTRY_WORKSPACE_CHECKPOINT,
  SESSION_ENTRY_WORKSPACE_FILE_REWIND,
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
] as const;

export type SessionEntryType = (typeof SESSION_ENTRY_TYPES)[number];

export interface SessionEntryInfo {
  id: string;
  sessionID: SessionId;
  type: SessionEntryType | string;
  // A session entry carries both user / tool activity and session-local configuration snapshots.
  // Restoring or switching configuration should update only the entry's own version, not make task
  // activity appear to have happened "just now."
  touchSession?: boolean;
  time: {
    created: number;
    updated: number;
  };
  /**
   * Logical payload, not database JSON. Reads and writes of runtime/model_selection use the public
   * ModelSelection type (`null` means no selection); the SQLite adapter handles the modelSelection
   * wrapper. Legacy flattened fields are for one-time migration / rollback only and must not be
   * exposed to regular consumers or copied into fork child records.
   */
  data: unknown;
}

// ── session_input ledger ──
// Durable input lifecycle: admitted (accepted, queued / awaiting injection) → promoted (consumed as a
// transcript user message in the same transaction as message persistence) / cancelled (for example,
// user removed the queue item) / discarded (session_resumed = queue not retained after restart;
// user_cleared = heldQueue cleared for sending) / failed (accepted but runtime could not start; keep
// this terminal state and do not rewrite it as discarded on restart).
// id = input / command id (present at admission); promoted_message_id is a nullable foreign key—
// messageId is generated only when draining. startNow must also go through durable admission first: if
// the CLI crashes after ACK but before atomic promotion to a user message, recovery can clearly mark
// the input as discarded.
export type SessionInputDelivery = "startNow" | "guide" | "queue";

export type SessionInputStatus = "admitted" | "promoted" | "cancelled" | "discarded" | "failed";

export interface SessionInputRecord {
  id: string;
  sessionID: SessionId;
  kind: string;
  delivery: SessionInputDelivery;
  payload: { text: string; [key: string]: unknown };
  admittedSequence: number;
  promotedSequence?: number;
  promotedMessageID?: MessageId;
  status: SessionInputStatus;
  statusReason?: string;
  time: { created: number; updated: number };
}

export type UsageQuerySource =
  | "main_turn"
  | "compact"
  | "session_title"
  | "goal_completion_verification"
  | "subagent"
  | "workflow_child"
  | "unknown";

export type UsageStatus = "running" | "completed" | "error" | "cancelled";

export interface ModelUsageRecord {
  id: string;
  logicalRequestId: string;
  attemptIndex?: number;
  sessionID: SessionId;
  turnID?: TurnId;
  traceID?: TraceId;
  spanID?: string;
  assistantMessageID?: MessageId;
  parentUserMessageID?: MessageId;
  querySource: UsageQuerySource | string;
  providerId: ModelProviderId | string;
  modelId: ModelId | string;
  reasoningLevel?: string;
  agent?: string;
  mode?: string;
  taskType?: SessionTaskType;
  status: UsageStatus;
  startedAt: number;
  firstTokenAt?: number;
  completedAt?: number;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  finishReason?: string;
  toolCallCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  providerTotalTokens?: number;
  computedTotalTokens?: number;
  retryCount?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  contextExceeded?: boolean;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  rawUsage?: unknown;
  providerMetadata?: unknown;
}

export interface TurnUsageRecord {
  sessionID: SessionId;
  turnID: TurnId;
  traceID?: TraceId;
  userMessageID?: MessageId;
  status: UsageStatus;
  startedAt: number;
  firstModelStartAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  modelRequestCount?: number;
  modelRetryCount?: number;
  toolCallCount?: number;
  toolErrorCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  computedTotalTokens?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  contextExceeded?: boolean;
  errorType?: string;
  errorCode?: string;
}

export interface ToolUsageRecord {
  id: string;
  sessionID: SessionId;
  turnID?: TurnId;
  traceID?: TraceId;
  toolCallID: ToolCallId | string;
  toolName: string;
  sideEffectScope?: ModelToolSideEffectScope | string;
  readOnly?: boolean;
  destructive?: boolean;
  approvalStatus?: "none" | "requested" | "allowed" | "denied";
  status: UsageStatus;
  startedAt: number;
  firstOutputAt?: number;
  completedAt?: number;
  durationMs?: number;
  timeToFirstOutputMs?: number;
  exitCode?: number;
  outputBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  truncated?: boolean;
  retryCount?: number;
  retryable?: boolean;
  cancelledByUser?: boolean;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface AppUsageQueryInput {
  /** Inclusive lower bound of the (since, until] interval (Unix ms). */
  since: number;
  /** Upper bound (Unix ms), usually now. */
  until: number;
  /** Calling client's fixed offset from UTC (ms), used to bucket by local day. */
  tzOffsetMs: number;
}

export interface AppUsageTotalsRow {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
  avgTimeToFirstTokenMs: number | null;
}

export interface AppUsageTurnTotalsRow {
  totalSessions: number;
  totalTurns: number;
  avgTurnDurationMs: number | null;
  longestSessionMs: number;
}

export interface AppUsageToolTotalsRow {
  toolCallCount: number;
  toolErrorCount: number;
}

export interface AppUsageModelRow {
  modelId: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface AppUsageToolRow {
  toolName: string;
  callCount: number;
  errorCount: number;
  avgDurationMs: number | null;
}

export interface AppUsageDayRow {
  dayIndex: number;
  totalTokens: number;
  turnCount: number;
  toolCallCount: number;
}

export interface AppUsageDayModelRow {
  dayIndex: number;
  modelId: string | null;
  totalTokens: number;
}

export interface AppUsageQueryResult {
  totals: AppUsageTotalsRow;
  turnTotals: AppUsageTurnTotalsRow;
  toolTotals: AppUsageToolTotalsRow;
  models: AppUsageModelRow[];
  tools: AppUsageToolRow[];
  days: AppUsageDayRow[];
  dayModels: AppUsageDayModelRow[];
}

export interface TaskUsageQueryInput {
  sessionID: SessionId;
}

export interface TaskUsageQueryResult {
  sessionID: SessionId;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
  inputBaselineBySource: Record<string, number>;
}

export interface UsageStorePort {
  recordModelUsage(input: ModelUsageRecord): Promise<void>;
  upsertTurnUsage(input: TurnUsageRecord): Promise<void>;
  upsertToolUsage(input: ToolUsageRecord): Promise<void>;
  pruneUsage(input?: { beforeTime?: number }): Promise<void>;
  queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult>;
  queryTaskUsage(input: TaskUsageQueryInput): Promise<TaskUsageQueryResult>;
}

export interface LocalSettingStorePort {
  getProjectPermissionMode(
    projectID: ProjectId,
  ): CollaborationMode | null | Promise<CollaborationMode | null>;
  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode | Promise<CollaborationMode>;
}

/**
 * Bounded child-session fact for sidebar child lists (specs/sidebar-child-conversation-counts.md).
 * Only selection_side_chat and subagent_child children are listed; workflow children stay owned by
 * workflowActivity and forks are not children for this purpose.
 */
export interface ChildSessionInfo {
  id: SessionId;
  title: string;
  taskType: Extract<SessionTaskType, "selection_side_chat" | "subagent_child">;
  lastActivityAt: number;
}

/**
 * Task types that belong to a parent's tree for permanent erase (specs/session-deletion-cascade.md).
 * Forks and interactive sessions also carry parent_id but are independent conversations: never descendants.
 */
export const SESSION_TREE_CHILD_TASK_TYPES = [
  "selection_side_chat",
  "subagent_child",
  "workflow_child",
  "nested_workflow_child",
] as const;

/** Read-only totals for the sessions an erase of the given roots would remove. */
export interface SessionTreeCounts {
  /** Every session in the tree that exists, roots included. */
  total: number;
  sideChats: number;
  subagents: number;
  /** workflow_child and nested_workflow_child sessions. */
  workflowSessions: number;
  /** workflow_run plus dwf_run rows owned by sessions in the tree. */
  workflowRuns: number;
}

export interface SessionStorePort {
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  /** Remove a session row only when it has no messages, entries, or admitted input records. */
  deleteEmptySession?(sessionID: SessionId): Promise<boolean>;
  /**
   * Totals for the roots plus their descendants through SESSION_TREE_CHILD_TASK_TYPES, archived
   * children included, forks excluded. Unknown ids count as zero. Read-only.
   */
  countSessionTree?(input: { rootIds: readonly SessionId[] }): Promise<SessionTreeCounts>;
  /** Session ids of the roots that exist plus their descendants (same scope as countSessionTree). Read-only. */
  listSessionTreeIds?(input: { rootIds: readonly SessionId[] }): Promise<SessionId[]>;
  /**
   * Permanently remove the roots and their descendants (same scope as countSessionTree) in one
   * transaction, including workflow_run / dwf_run rows that foreign keys would otherwise orphan.
   * Idempotent: ids that no longer exist are skipped. Returns the session ids that were removed.
   */
  deleteSessionTree?(input: { rootIds: readonly SessionId[] }): Promise<{ erasedIds: SessionId[] }>;
  /** Legacy compatibility primitive; V4 stable / compact-edit forks must use commitForkBundle instead. */
  createForkedSessionWithMetadata?(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo>;
  /** Only transaction entry point for V4 stable / compact-edit forks. Legacy workspace forks do not call it. */
  commitForkBundle?(bundle: ForkCommitBundle): Promise<SessionInfo>;
  commitSharedContextImportBundle?(bundle: SharedContextImportCommitBundle): Promise<SessionInfo>;
  transitionSharedContextImport?(input: SharedContextImportTransition): Promise<boolean>;
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  /**
   * Grouped child counts for sidebar rows: one count per (parent, kind) over non-archived
   * selection_side_chat / subagent_child children. Counts are true totals even when the
   * corresponding listChildSessions result is capped.
   */
  countChildSessions(input: {
    parentIds: readonly SessionId[];
  }): Promise<Map<string, { sideChats: number; subagents: number }>>;
  /**
   * Latest non-archived child sessions per parent, newest first, capped at limitPerParent;
   * same task-type scope as countChildSessions. Parents with no children are omitted.
   */
  listChildSessions(input: {
    parentIds: readonly SessionId[];
    limitPerParent: number;
  }): Promise<Map<string, ChildSessionInfo[]>>;
  /**
   * Backfill workspace identity for an old remote session using the host task-index allowlist.
   * Implementations must validate id, directory, and workspace_id is null together, and must not
   * overwrite an existing identity.
   */
  claimLegacySessionWorkspace?(input: ClaimLegacySessionWorkspaceInput): Promise<number>;
  /**
   * Repair one historical session where remote identity was written into directory / path.
   * Implementations must validate session id, NULL workspace_id, and exact old-directory match; bulk
   * path migrations are forbidden.
   */
  repairLegacyRemoteSessionWorkspace?(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean>;
  /**
   * Maintenance CAS for path self-healing on a session with an existing remote identity.
   * Implementations may update only directory, path, and monotonically increasing time_updated; they
   * must not write back other session metadata.
   */
  repairRemoteSessionPaths?(input: RepairRemoteSessionPathsInput): Promise<boolean>;
  saveMessage(input: MessageInfo, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void>;
  savePart(input: MessagePart, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removePart(input: { sessionID: SessionId; messageID: MessageId; partID: PartId }): Promise<void>;
  messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null>;
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  saveSessionEntry?(input: SessionEntryInfo): Promise<void>;
  sessionEntries?(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]>;
  // ── session_input ledger (optional methods; older hosts may omit them) ──
  /** Admission: input was accepted (queued / awaiting injection); persist it durably. Idempotent (reentry with the same id updates the payload). */
  saveSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void>;
  /** Approve full access: execution, fixed queue permission, and idempotency receipt in one transaction; no schema migration. */
  commitPermissionFullAccess?(input: {
    sessionID: SessionId;
    queueItemIds: string[];
    execution: SessionEntryInfo;
    receipt: SessionEntryInfo;
    signal?: AbortSignal;
  }): Promise<void>;
  /** Durable atomic update for queue edits / reordering; only admitted records may be changed. */
  updateSessionInputs?(input: {
    sessionID: SessionId;
    updates: Array<{
      delivery?: SessionInputDelivery;
      id: string;
      intent?: import("./session.port.js").TurnInputIntentMetadata;
      text?: string;
      queuePosition?: number;
    }>;
  }): Promise<void>;
  /**
   * Promotion (atomicity is mandatory): mark the ledger row promoted and persist the user message / parts
   * in the same transaction—preventing the orphan window where the queue was consumed but the transcript
   * has no user message.
   */
  promoteSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void>;
  /**
   * Non-atomic promotion marker: for paths where the message was persisted elsewhere (a synthetic
   * notice from a background wake), update only the ledger status. New paths should prefer the atomic
   * promoteSessionInput method.
   */
  markSessionInputPromoted?(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void>;
  /** Set terminal state: cancelled (for example user_removed) / discarded (session_resumed / user_cleared). */
  settleSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void>;
  listSessionInputs?(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]>;
  /** Global createSession.firstInput deduplication: find the real session by queue_<sourceCommandId>. */
  getSessionInputById?(id: string): Promise<SessionInputRecord | null>;
  readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]>;
  updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void>;
  readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal>;
  cloneTargetForFork?(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal>;
  createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null>;
  updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null>;
  startTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null>;
  heartbeatTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null>;
  finishTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null>;
  recoverInterruptedTargetRun?(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null>;
  updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null>;
  clearTarget(input: { sessionID: SessionId }): Promise<boolean>;
  getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null>;
  saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset>;
  setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void>;
  clearRevert(sessionID: SessionId): Promise<void>;
}
