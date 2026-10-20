import type { ExecutionOutputPreview } from "../interfaces/execution.port.js";
import type { RuntimeInputPresentation } from "../interfaces/runtime-input-presentation.js";
/* eslint-disable max-lines -- Keep session event contracts exported from one file to prevent app/agent protocol types from drifting apart. */
// ============================================================
// Session Events - All event types for the agent loop
// ============================================================

import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MicrocompactBoundaryPayload,
} from "../compact/index.js";
import type { HookRunLifecyclePayload } from "../hooks/index.js";
import type { HttpClientEgressInfo } from "../interfaces/http-client.port.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "../interfaces/permission.port.js";
import type {
  MessageVisibility,
  SessionTitleSource,
  SyntheticUserMessageSource,
} from "../interfaces/session-store.port.js";
import type {
  CollaborationMode,
  HighspeedMessageMetadata,
  RiskLevel,
  TurnInputIntentMetadata,
  TurnSteerCommandKind,
  TurnSteerDeliveryMode,
  TurnSteerRejectReason,
  TurnSteerSource,
} from "../interfaces/session.port.js";
import type {
  EventId,
  InteractionRequestOrigin,
  MessageId,
  PartId,
  QueryId,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
} from "../interfaces/shared.js";
import type {
  ModelNetworkStatusEvent,
  ModelSelection,
  ModelUsage,
  ModelUsageSummary,
} from "../model/index.js";
import { createModelUsageSummary } from "../model/index.js";
import type { CheckpointCreatedPayload, RewindTriggeredPayload } from "../rewind/index.js";
import type { SkillTelemetryMetadata } from "../skills/index.js";
import type { ModelApiErrorPhase, ModelFailureExceptionKind } from "../telemetry/index.js";
import type { ToolSideEffectScope } from "../tools/contract.js";
import type { SavedWorkflowScope } from "../tools/saved-workflow.js";
import type { GoalCompletionVerificationOutput, SessionGoal } from "../tools/target.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamRecoveryAnchorSelectedPayload,
  StreamRecoveryBlockedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryTailDiscardedPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";

// Re-export for convenience
export type { CollaborationMode, RiskLevel } from "../interfaces/session.port.js";

// Re-export ModelToolCall as ToolCall for core usage
export type { ModelToolCall as ToolCall } from "../model/index.js";

// Base Event
export interface SessionEvent {
  id: EventId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: SessionEventType;
  timestamp: Date;
  traceId: TraceId;
  sequenceNumber: number;
  payload: unknown;
}

export const SessionEventType = {
  SessionCreated: "session_created",
  SessionResumed: "session_resumed",
  SessionForked: "session_forked",
  SessionCompacted: "session_compacted",
  SessionTitleUpdated: "session_title_updated",
  SessionModeChanged: "session_mode_changed",
  SessionEnded: "session_ended",
  TurnStarted: "turn_started",
  TurnInputReceived: "turn_input_received",
  TurnSteerQueued: "turn_steer_queued",
  // If guide closes without encountering a usable tool batch, route the original intent to the regular queue in place.
  TurnSteerDeliveryChanged: "turn_steer_delivery_changed",
  // Atomic promotion by sendQueuedNow: reservation/promoting/rollback all enter the event stream; the projection does not guess locally.
  TurnSteerDispatchChanged: "turn_steer_dispatch_changed",
  TurnSteerDrained: "turn_steer_drained",
  TurnSteerRejected: "turn_steer_rejected",
  TurnSteerDiscarded: "turn_steer_discarded",
  // session_input and the user message/parts were promoted in the same transaction; CommandInbox can safely release the pin.
  SessionInputPromoted: "session_input_promoted",
  // v4 queue reorder: queue-item order changed (the reducer reorders queue rows by orderedPendingInputIds).
  TurnSteerReordered: "turn_steer_reordered",
  // v4 input control: queue autoDrain toggle (authorization bit from which heldQueueInputRequiresChoice is derived).
  QueueAutoDrainChanged: "queue_auto_drain_changed",
  // v4 input control: followup routing mode (enqueue vs guide while running).
  FollowupModeChanged: "followup_mode_changed",
  TurnComplete: "turn_complete",
  TurnError: "turn_error",
  UserMessage: "user_message",
  AssistantMessage: "assistant_message",
  AssistantFeedbackUpdated: "assistant_feedback_updated",
  RowPinnedUpdated: "row_pinned_updated",
  HighspeedMetricsUpdated: "highspeed_metrics_updated",
  // (2026-09-12): the former ToolWidgetStateUpdated / SessionPluginUiStateUpdated events were removed.
  // Plugin UI widgetState now falls back to renderer memory and no longer travels through the CLI event stream.
  SystemMessage: "system_message",
  ModelRequest: "model_request",
  ModelSelected: "model_selected",
  TurnExecutionModelFallback: "turn_execution_model_fallback",
  ModelStreaming: "model_streaming",
  StreamingToolLedgerUpdated: "streaming_tool_ledger_updated",
  StreamRecoveryAnchorCreated: "stream_recovery_anchor_created",
  StreamRecoveryStarted: "stream_recovery_started",
  StreamRecoveryAnchorSelected: "stream_recovery_anchor_selected",
  StreamRecoveryTailDiscarded: "stream_recovery_tail_discarded",
  StreamRecoveryRetryStarted: "stream_recovery_retry_started",
  StreamRecoveryBlocked: "stream_recovery_blocked",
  ModelNetworkStatus: "model_network_status",
  ModelAnomalyWarning: "model_anomaly_warning",
  NetworkRequestStatus: "network_request_status",
  ModelComplete: "model_complete",
  ModelError: "model_error",
  ToolCallScheduled: "tool_call_scheduled",
  ToolCallStarted: "tool_call_started",
  ToolCallProgress: "tool_call_progress",
  ToolCallResult: "tool_call_result",
  ToolCallError: "tool_call_error",
  ToolBatchComplete: "tool_batch_complete",
  BackgroundTaskStarted: "background_task_started",
  BackgroundTaskUpdated: "background_task_updated",
  BackgroundTaskCompleted: "background_task_completed",
  // Real-time progress for a workflow run: one event per engine RunEvent, appended to the **parent session** (the run has no session of its own).
  // The v4 side reduces these into workflowRuns state keys; the v3 side strips them in shouldExposeSessionEventToProtocol.
  // The dynamic_ prefix is intentional: script-run events from the legacy `Workflow` tool (workflow_started /
  // workflow_completed in script-workflow-runtime.ts) are a separate log, and identical names would be confusing.
  DynamicWorkflowRunProgress: "dynamic_workflow_run_progress",
  PermissionRequested: "permission_requested",
  PermissionResolved: "permission_resolved",
  PermissionDenied: "permission_denied",
  // MCP resource changes subscribed to by plugin UI. Included only in the live projection (v4Gateway.ingest, seq 0); not persisted or restored on cold start.
  PluginUiResourceUpdated: "plugin_ui_resource_updated",
  PluginUiResourceListChanged: "plugin_ui_resource_list_changed",
  /** App-Provided Tools: model-initiated page tool call; included only in the live projection (instance mailbox), not persisted. */
  PluginUiInstanceClosed: "plugin_ui_instance_closed",
  PluginUiAppToolCallRequested: "plugin_ui_app_tool_call_requested",
  UserInputAutoResolutionUpdated: "user_input_auto_resolution_updated",
  WorkspaceHookReviewRequested: "workspace_hook_review_requested",
  WorkspaceHookReviewSettled: "workspace_hook_review_settled",
  WorkspaceHookReviewSuperseded: "workspace_hook_review_superseded",
  // Soft gate: emitted when admission state changes; the projection clears the snapshot field when pendingCount=0.
  WorkspaceHookAdmissionUpdated: "workspace_hook_admission_updated",
  HookRunStarted: "hook_run_started",
  HookRunProgress: "hook_run_progress",
  HookRunCompleted: "hook_run_completed",
  HookRunFailed: "hook_run_failed",
  HookRunBlocked: "hook_run_blocked",
  CompactStarted: "compact_started",
  CompactCompleted: "compact_completed",
  CompactFailed: "compact_failed",
  CompactBoundary: "compact_boundary",
  MicrocompactBoundary: "microcompact_boundary",
  RewindTriggered: "rewind_triggered",
  CheckpointCreated: "checkpoint_created",
  TargetChanged: "target_changed",
  TargetCompletionVerification: "target_completion_verification",
  SubagentSpawned: "subagent_spawned",
  SubagentMessage: "subagent_message",
  SubagentStopped: "subagent_stopped",
  Interrupt: "interrupt",
  Cancel: "cancel",
  Resume: "resume",
  Error: "error",
} as const;

export type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];

// -----------------------------------------------
// Event Payloads
// -----------------------------------------------

export interface SessionCreatedPayload {
  planEnabled?: boolean;
  mode: CollaborationMode;
  contextWindow: number;
}

export interface SessionResumedPayload {
  directory: string;
  interruptedToolCount: number;
  messageCount: number;
  partCount: number;
  recoveredCompactTimelineCount?: number;
  recoveredSteerInputCount?: number;
  resumedTodoCount?: number;
}

export interface SessionForkedPayload {
  forkedSessionId?: SessionId;
  originalSessionId: SessionId;
  restoredFileCount?: number;
  restoredSnapshotRef?: string;
  strategy?: "fork_required";
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  /** @deprecated Use targetMessageId for message-level forks. */
  forkPoint: number;
}

export interface SessionCompactedPayload {
  compactBoundary: CompactBoundaryPayload;
  summary?: string;
  preservedEventCount?: number;
  removedEventCount?: number;
}

export type CompactLifecyclePayload = CompactTimelinePayload;

export type MicrocompactBoundaryEventPayload = MicrocompactBoundaryPayload;

/**
 * Attachment rendering (additive): lightweight display metadata for user-input attachments, sent with
 * TurnStarted; the v4 projection uses it to populate attachments on the userInput row.
 * Carries display fields only, not the content itself (content goes through resolve/persist as FilePart/artifact).
 */
export interface TurnAttachmentMeta {
  fileName: string;
  mime: string;
  bytes: number;
  /** Content reference (local path / artifact URI); omitted when there is no stable reference, such as a data URL. */
  ref?: string;
}

/**
 * Structured payload for a workflow notification.
 * Bounded by the emitter (summary≤500 / result≤4000 / error≤2000 / reports.preview ≤500 each, ≤8 items /
 * artifacts ≤8 items, title≤120 / question·context≤4000); manually kept in sync with shared
 * workflowNotificationMetaSchema.
 * Intentionally omitted from batched notification turns—one manifest per turn does not map to batches.
 */
export type WorkflowNotificationMeta =
  | {
      kind: "terminal";
      status: "completed" | "errored" | "stopped";
      /** Present only when `status === "stopped"`. */
      stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
      summary: string;
      result?: string;
      resultForm?: "prose" | "json";
      resultTruncated?: true;
      error?: string;
      reports?: { count: number; shown: number; preview: string[] };
      /**
       * Chips payload for user-facing artifacts: at most 8 items.
       * Set `artifactsTruncated` when there are more (including items filtered out by kind).
       *
       * ⚠ Terminology: `artifact` here means output published for users through the script's `artifact.*`;
       * it is different from `result` on this payload (the script's top-level return value, also called artifact inside the engine).
       */
      artifacts?: {
        id: string;
        kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
        title?: string;
        version: number;
        contentType?: string;
        /** Run deliverable; it leads the list. Only this item has `description` (read aloud in the completion card's deliverable row). */
        primary?: true;
        description?: string;
      }[];
      artifactsTruncated?: true;
      durationMs?: number;
    }
  | {
      kind: "escalation";
      qid: string;
      actor: string;
      question: string;
      context?: string;
      askedAt?: number;
    }
  /**
   * The script reached a hole (the `hole` payload in docs/dynamic-workflow/transcript-and-notifications.md):
   * the main agent owes this run a code body. `prompt` ≤4000 (same cap as elicitation); `before` /
   * `after` are the phase names before and after the hole, and `draftPath` / `line` point to its line in
   * the run draft. Exactly one event is emitted per `hole-reached`.
   */
  | {
      kind: "hole";
      siteId: string;
      ordinal: number;
      name: string;
      type: string;
      prompt?: string;
      draftPath?: string;
      line?: number;
      before?: string;
      after?: string;
      reachedAt?: number;
    }
  /** Run-level stall: one per stall interval; not a terminal state. */
  | {
      kind: "stall";
      sinceMs: number;
      reason?: string;
      cap?: number;
    };

/** Display metadata for a standalone background-result turn; batches can reuse a representative task identity and synthesize a title instead of parsing notification text. */
export interface BackgroundResultOriginMeta {
  /** `workflow` is a dynamic-workflow run (workId ≡ runId) and reuses the full background-notification pipeline; `dream` is the /dream memory-consolidation completion notification. */
  backgroundSource: "bash" | "subagent" | "workflow" | "dream";
  workId: string;
  title: string;
  /** Present only on a single notification turn with backgroundSource === "workflow"; the sole data source for manifest rendering. */
  workflowNotification?: WorkflowNotificationMeta;
}

/**
 * Whether a turn carries real Agent execution. controlOnly establishes a timeline boundary only for
 * visible control input; it must not advance session running/activeWorks or produce an "working / has worked" state.
 */
export type TurnExecutionKind = "agent" | "controlOnly";

export type OffPeakRunType = "init" | "resume";

export type TurnBackgroundAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: OffPeakRunType;
      automationId?: never;
    }
  | {
      automationId?: undefined;
      offPeakTaskId?: undefined;
      offPeakRunType?: never;
    };

/**
 * Launch-turn metadata for a saved workflow started directly from the central interface. The same
 * value is written to the user message's `metadata` (cold-recovery source) and the `TurnStarted`
 * payload (live-projection source)—same shape for cold and live paths; the projection uses it to draw
 * the launch card rather than display text.
 */
/** Only the create_workflow projection is allowed in launch metadata's display (same shape as the shared row schema). */
export type WorkflowLaunchDisplay = Extract<ToolResultDisplayPayload, { kind: "create_workflow" }>;

/**
 * Describes what changed in a settings turn (docs/dynamic-workflow/launch.md, “The settings turn”):
 * only changed settings are present. If either `from` or `to` is absent, that side is the default
 * (model = session model; cap = default concurrency). `ceiling` is the default concurrency D; its
 * wire name predates the “default concurrency” concept and is retained for older clients. It supports
 * displays such as “default 13 → 4”. Matches shared's `workflowSettingsAmendMetaSchema`.
 */
export interface WorkflowSettingsAmendMeta {
  /**
   * Run replaced by this adjustment (or continued from it). **Omission means the change took effect
   * in place** (docs/dynamic-workflow/launch.md, “The settings turn”): when only the concurrency cap
   * changes while the run is still live, the settings turn neither stops it nor starts another run, so
   * there is no predecessor to identify; `runId` refers to the adjusted run itself. Matches shared's
   * `workflowSettingsAmendMetaSchema` (which documents an older desktop discrepancy).
   */
  predecessorRunId?: string;
  subagentModel?: { from?: string; to?: string };
  maxConcurrency?: { from?: number; to?: number };
  ceiling?: number;
}

export interface WorkflowLaunchMeta {
  /** Run identity (≡ backgroundTaskId ≡ cancelBackgroundWork workId). */
  runId: string;
  /**
   * Synthetic toolCall id that launched this run (central launch `launch-<uuid>`, settings turn
   * `settings-<uuid>`; join key from tool card to details).
   */
  toolCallId: string;
  /**
   * Workflow name (resolved value, not overridable by user / model); both the launch-card title and
   * session title use it. Always present for a central launch; a settings turn uses the adjusted run's
   * name and omits it if unnamed (UI uses a fallback, not the run id as title).
   */
  name?: string;
  /** Resolved effective scope (not the possibly omitted request scope). Central launch only; a settings turn has no saved file to reference. */
  scope?: SavedWorkflowScope;
  /** Location of the saved file, for details / diagnostics; not used for execution. Central launch only. */
  path?: string;
  /** Arguments for this run (validated against declarations with defaults filled in); bounded by {@link boundWorkflowLaunchMeta}. */
  args?: Record<string, unknown>;
  /** Workflow description (description from saved metadata), bounded to ≤ 500 characters. */
  description?: string;
  /**
   * `create_workflow` result display compiled before launch (bounded causality graph + diagnostics),
   * using the same projection and constructor as the CreateWorkflow tool row's `display`. The run
   * detail side panel finds the launching row by toolCallId to get the graph; direct launches have no
   * tool row, so the graph comes from here.
   */
  display?: WorkflowLaunchDisplay;
  /**
   * Original script text actually executed by this run (same value as `port.submit.scriptText`). The
   * tool path puts it in `input.script` for the side panel's Script section; this is the launch-turn
   * location for the same fact. Bounded by {@link WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS} (omitted entirely
   * if exceeded, which also omits the side-panel Script section).
   */
  script?: string;
  /** Present only on a settings turn: which run this one was amended from using "Configure," and what changed. */
  amend?: WorkflowSettingsAmendMeta;
}

/** JSON-serialized size limit (bytes) for {@link WorkflowLaunchMeta.args}. If exceeded, replace with a marker key. */
export const WORKFLOW_LAUNCH_ARGS_MAX_BYTES = 4_096;
/** Character limit for {@link WorkflowLaunchMeta.description}. */
export const WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS = 500;
/**
 * Character limit for {@link WorkflowLaunchMeta.script}. The tool path already includes `input.script`
 * in the transcript without a bound, so this limit is much larger than any reasonable dwf script but
 * still prevents accidentally including an entire repository. If exceeded, omit the whole field
 * instead of truncating it (a partial script is useless in the Script section; the graph remains in display).
 */
export const WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS = 256_000;
/**
 * Replacement key used when args exceed the limit. Real arguments always use the canonical model-facing
 * representation (which is not truncated); this metadata is only for the launch card. A 4KB argument
 * bag cannot be displayed on the card, so replace it with one readable marker instead of forcing it
 * in. The ellipsis key is outside `SAVED_WORKFLOW_NAME_PATTERN` and cannot collide with a real argument name.
 */
export const WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY = "…";

/**
 * Bounds launch-turn metadata. If serialized args exceed {@link WORKFLOW_LAUNCH_ARGS_MAX_BYTES}, replace
 * them as a whole with the `{ "…": "arguments omitted (N bytes)" }` marker (see
 * {@link WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY}); truncate description over
 * {@link WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS} and add an ellipsis. Called at construction time so
 * message metadata and the TurnStarted payload receive the same bounded value.
 */
export function boundWorkflowLaunchMeta(input: WorkflowLaunchMeta): WorkflowLaunchMeta {
  const bounded: WorkflowLaunchMeta = {
    runId: input.runId,
    toolCallId: input.toolCallId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.path === undefined ? {} : { path: input.path }),
  };
  if (input.args !== undefined) {
    const serialized = JSON.stringify(input.args);
    const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
    bounded.args =
      bytes > WORKFLOW_LAUNCH_ARGS_MAX_BYTES
        ? { [WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY]: `arguments omitted (${bytes} bytes)` }
        : input.args;
  }
  if (input.description !== undefined) {
    bounded.description =
      input.description.length > WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS
        ? `${input.description.slice(0, WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS - 1)}…`
        : input.description;
  }
  // display was bounded at construction (createCreateWorkflowDisplay + boundCausalityGraph); pass it through unchanged.
  if (input.display !== undefined) bounded.display = input.display;
  if (input.script !== undefined && input.script.length <= WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS) {
    bounded.script = input.script;
  }
  // The amend block is already bounded (the caller supplies both model strings in canonical resolved form, with the same bounds as run state).
  if (input.amend !== undefined) bounded.amend = input.amend;
  return bounded;
}

export interface TurnStartedPayloadBase {
  /** Monotonic epoch milliseconds at execution entry; hooks / persistence happen before TurnStarted is published, so publication time cannot be used to infer execution start. */
  executionStartedAt?: number;
  turnNumber: number;
  input: string;
  /**
   * v4 file summaries query by turn rowId, but workspace checkpoints use user messageId as the recovery
   * anchor. TurnStarted must carry that same persistent id so the projection can resolve the userInput
   * row back to its checkpoint.
   */
  messageId?: MessageId;
  inputId?: string;
  /** Passed through only by admission as a body-free telemetry fact; cannot be inferred from session ownership. */
  /** Stable cancellation identity shared within one runtime command across primary turn → goal verify / continue. */
  foregroundExecutionId?: string;
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputVisibility?: MessageVisibility;
  /**
   * Launch-turn metadata for a saved workflow started directly from the central interface (present
   * when `inputSource === "workflow_launch"`). The live projection uses it to draw the launch card; it
   * matches the same value in message metadata (same shape for cold and live paths).
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** Defaults to agent for compatibility with older events and historical transcripts. */
  executionKind?: TurnExecutionKind;
  /**
   * Starting at this index, `input` contains engine-appended text (dwf ask suffix / nudge), which the
   * GUI folds into the disclosure. 0 = the whole input; omitted = none. Matches the value in message
   * metadata (same shape for cold and live paths).
   */
  epilogueStart?: number;
  /** Structured source for an idle background wake; active-loop merging does not create a separate TurnStarted. */
  originMeta?: BackgroundResultOriginMeta;
  /** Passed through only when all members of a background notification batch share one source; omitted for mixed sources. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  targetId?: string;
  /** Attachment metadata for this turn's user input (omitted when there are no attachments). */
  attachments?: TurnAttachmentMeta[];
  /** CLI admission metadata; inputId remains the compatibility anchor for sourceCommandId. */
  intent?: TurnInputIntentMetadata;
}

export type TurnStartedPayload = TurnStartedPayloadBase & TurnBackgroundAttribution;

export interface TurnInputReceivedPayload {
  input: string;
  attachments?: Attachment[];
}

export interface TurnSteerQueuedPayload {
  pendingInputId: string;
  inputId?: string;
  queryId?: QueryId;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** Tool name hidden from the provider when consuming the currently queued input. */
  toolDisallowlist?: readonly string[];
  /** Delivery semantics: queue = start a new product turn when consumed; guide = inline into the current turn. */
  delivery?: TurnSteerDeliveryMode;
  targetTurnId: TurnId;
  queueLength: number;
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerDeliveryChangedPayload {
  pendingInputId: string;
  targetTurnId: TurnId;
  requestedDelivery: "guide";
  admittedDelivery: "queue";
  fallbackReasonCode: string;
  /** Full intent after rerouting; reducer / cold replay do not infer delivery from side-channel state. */
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerReorderedPayload {
  orderedPendingInputIds: string[];
  targetTurnId: TurnId;
}

export interface TurnSteerDispatchChangedPayload {
  pendingInputId: string;
  reservationId?: string;
  state: "queued" | "reserved" | "promoting";
  targetTurnId: TurnId;
}

export interface QueueAutoDrainChangedPayload {
  autoDrain: boolean;
}

export interface FollowupModeChangedPayload {
  mode: "queue" | "guide";
}

export interface TurnSteerDrainedPayload {
  pendingInputIds: string[];
  queryIds?: QueryId[];
  targetTurnId: TurnId;
  injectedMessageIds: MessageId[];
  /**
   * Drain fact includes the text and persistent messageId, so the projection no longer depends on
   * in-memory queue state to retrieve text (otherwise a missing queue item silently drops the user
   * row). Delivery determines turn-boundary semantics; defaults to queue (one turn per item).
   */
  drainedInputs?: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: TurnSteerDeliveryMode;
    intent?: TurnInputIntentMetadata;
    toolDisallowlist?: readonly string[];
  }>;
}

export interface TurnSteerRejectedPayload {
  reason: TurnSteerRejectReason;
  activeTurnId?: TurnId;
  expectedTurnId?: TurnId;
  inputPreview?: string;
  inputSize?: number;
}

export interface TurnSteerDiscardedPayload {
  pendingInputIds: string[];
  targetTurnId: TurnId;
  // user_removed (v4 single-item queue deletion): user explicitly removed an item from the queue, distinct from turn-lifecycle discard.
  // promoted: sendQueuedNow acquired execution rights; remove it only from the queue projection. session_input must remain
  // admitted until atomic promotion to a user message (or discarded after restart).
  reason: "turn_cancelled" | "turn_failed" | "session_resumed" | "user_removed" | "promoted";
}

export interface SessionInputPromotedPayload {
  pendingInputId: string;
  sourceCommandId: string;
  messageId: MessageId;
}

export interface TurnCompletePayload {
  response: string;
  tokenCount: number;
  usage?: ModelUsageSummary;
  toolCallCount: number;
  /** Number of model outputs from the current query successfully committed to provider-visible persistent history. */
  historyRoundCount?: number;
  duration: number;
  inputId?: string;
  resultType: TurnResultType;
  /** Whether the current turn consumed a background-result notification from a subagent. */
  backgroundSubagentResultConsumed?: boolean;
  /** Whether the current turn consumed a background notification from a workflow (dynamic-workflow run). */
  workflowResultConsumed?: boolean;
  /** Internal preemption (such as sendQueuedNow) ends only the current turn; it is not equivalent to the user manually stopping the queue. */
  preserveQueueAutoDrainOnCancel?: boolean;
}

export interface TurnErrorPayload {
  error: ErrorPayload;
  turnPhase: string;
  inputId?: string;
  /** Whether the current turn consumed a background-result notification from a subagent. */
  backgroundSubagentResultConsumed?: boolean;
  /** Whether the current turn consumed a background notification from a workflow (dynamic-workflow run). */
  workflowResultConsumed?: boolean;
}

export type TurnResultType =
  | "success"
  // "cancelled": a user-initiated interruption (TurnCancelled) is a normal end; report it through TurnComplete rather than TurnError.
  | "cancelled"
  | "error_max_turns"
  | "error_max_budget"
  | "error_during_execution"
  | "error_max_tool_calls";

export interface UserMessagePayload {
  content: string;
  attachments?: Attachment[];
}

export interface AssistantMessagePayload {
  content: string;
  toolCalls?: ToolCallPayload[];
}

export interface AssistantFeedbackUpdatedPayload {
  entityId: string;
  feedback: "like" | "dislike" | null;
}

/** Display-only pin bookmark (unix ms, CLI clock); null unpins. Not injected into agent context. */
export interface RowPinnedUpdatedPayload {
  entityId: string;
  pinnedAt: number | null;
}

export interface HighspeedMetricsUpdatedPayload {
  entityId: string;
  highspeed: HighspeedMessageMetadata;
}

export interface SystemMessagePayload {
  type: "init" | "compact_boundary" | "interrupted";
  content: string;
  compactBoundary?: CompactBoundaryPayload;
}

export interface SessionTitleUpdatedPayload {
  messageID?: MessageId;
  previousTitle: string;
  source: SessionTitleSource;
  title: string;
}

export interface SessionModeChangedPayload {
  permissionGrant?: { interactionId: string; queueItemIds: string[] };
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  source: "tool" | "command" | "system";
  toolCallId?: ToolCallId;
}

export type TargetCompletionVerificationStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";

export interface TargetCompletionVerificationPayload {
  targetId: string;
  status: TargetCompletionVerificationStatus;
  verificationId: string;
  /** Shared with the foreground runtime command that triggered this verification, for Stop's stale guard. */
  foregroundExecutionId?: string;
  /** When sendQueuedNow preempts the verifier, pause only the goal, not the future queue. */
  preserveQueueAutoDrainOnCancel?: boolean;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
}

export interface ModelRequestPayload {
  messages: ModelMessage[];
  providerId: string;
  modelId: string;
  querySource?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ModelSelectionOrigin = "registryFallback";

export interface ModelSelectedPayload {
  modelSelection: ModelSelection;
  /** Resolved reasoning from Active Model, for execution facts / display projection only; not part of sparse Selection. */
  effectiveReasoningLevel?: string;
  /** Missing means only update the current selection; null marks an explicit ∅→selection model boundary. */
  previousModelSelection?: ModelSelection | null;
  /** Present only when the Agent automatically restores a model; missing means an ordinary selection or an older event. */
  origin?: ModelSelectionOrigin;
  /** Reasoning-level capabilities for the current selection; published atomically with model selection in the same event. */
  supportedThoughtLevels?: string[];
  /** Context window actually applied at runtime for the current selection; null means explicitly cleared, and omission supports older events. */
  contextWindow?: number | null;
}

/**
 * Reason that the execution Selection fell back to the session Selection. Uses the same value set as
 * @zcode/shared's selectionFallback rule and persisted highspeed metadata share this reason set.
 */
export type TurnExecutionModelFallbackReason = NonNullable<HighspeedMessageMetadata["fallbackReason"]>;

export interface TurnExecutionModelFallbackPayload {
  inputId?: string;
  reason: TurnExecutionModelFallbackReason;
  /**
   * After the provider refactor, per-turn execution models use sparse Selections (the old ModelRef was
   * removed): `from` is the accelerated Selection scoped to this execution; `to` is the persistent
   * session Selection.
   */
  fromModelSelection: ModelSelection;
  toModelSelection: ModelSelection;
}

export type ModelStreamingKind =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_input_start"
  | "tool_input_delta"
  | "tool_input_end"
  | "tool_call"
  | "finish"
  | "error";

export interface ModelStreamingPayload {
  delta: string;
  done: boolean;
  kind?: ModelStreamingKind;
  assistantMessageId?: MessageId;
  partId?: PartId;
  toolCallId?: ToolCallId;
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export type ModelNetworkStatusPayload = ModelNetworkStatusEvent;

export type ModelAnomalyWarningCategory =
  | "tool_call_budget"
  | "repeated_tool_call"
  | "provider_finish_mismatch"
  | "malformed_tool_call";

export type ModelAnomalyWarningSeverity = "info" | "warning";

export interface ModelAnomalyWarningPayload {
  category: ModelAnomalyWarningCategory;
  severity: ModelAnomalyWarningSeverity;
  observedCount?: number;
  threshold?: number;
  toolName?: string;
  toolCallId?: ToolCallId;
  warningInjected: boolean;
  modelVisibleMessageId?: MessageId;
}

export type NetworkRequestSource = "http_client" | "model" | "tool" | "mcp" | "plugin" | "unknown";

export type NetworkRequestLifecycleStatus = "pending" | "complete" | "error";

export interface NetworkRequestStatusPayload {
  requestId: string;
  source: NetworkRequestSource;
  status: NetworkRequestLifecycleStatus;
  method: string;
  url: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  statusCode?: number;
  error?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  attempt?: number;
  egress?: HttpClientEgressInfo;
}

export interface ModelCompletePayload {
  cacheHit?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    latestHitRate: number | null;
    hitRate: number | null;
    hitRateRequestCount: number;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
  };
  content: string;
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  contextWindow?: number;
  /**
   * Effective auto-compact threshold in tokens for the executing model and compact config,
   * resolved by the runtime with the same math as `shouldAutoCompact`; `null` means auto-compact
   * is disabled. Emitted on main-turn completions only; absent in older events.
   */
  autoCompactThresholdTokens?: number | null;
  /** Effective microcompact threshold; null means disabled, absent is a legacy event. */
  microcompactThresholdTokens?: number | null;
  fileChanges?: TurnFileChangeSummary;
  querySource?: string;
  stopReason: string;
  /** Number of complete tool calls assembled by the current model request; may be absent in older events. */
  toolCallCount?: number;
  usage: TokenUsage | ModelUsage;
}

export interface TurnFileChangeSummary {
  additions: number;
  deletions: number;
  files: number;
  items: TurnFileChangeSummaryItem[];
}

export interface TurnFileChangeSummaryItem {
  additions: number;
  deletions: number;
  path: string;
  toolNames?: string[];
  writeCount: number;
}

export type ContextUsageBreakdownSource =
  | "system_prompt"
  | "meta_user_context"
  | "skills"
  | "tool_prompt"
  | "system_tool_schemas"
  | "mcp_tool_schemas"
  | "messages";

export interface ContextUsageBreakdownItem {
  source: ContextUsageBreakdownSource;
  chars: number;
}

export interface ModelErrorPayload {
  error: ErrorPayload;
  retryable: boolean;
}

export interface ToolCallScheduledPayload {
  toolCallId: ToolCallId;
  assistantMessageId?: MessageId;
  toolName: string;
  input: unknown;
  dependencies?: ToolCallId[];
  parallelGroupIndex?: number;
  canRunParallel?: boolean;
  display?: ToolResultDisplayPayload;
  schedule: ToolSchedulePayload;
}

export interface ToolCallStartedPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  startedAt: Date;
  display?: ToolResultDisplayPayload;
  /**
   * Side-effect capability for this call **after resolution** (tool metadata + runtime capability
   * resolved from input, such as Bash's read-only-command check). The event is emitted before the
   * handler acts, so subscribers know "this will write" before the first byte is persisted—the
   * dynamic-workflow driver uses it to close the amend-resume import cache
   * (`isWorkspaceMutatingToolCall`). Optional; older events do not have this field.
   */
  readOnly?: boolean;
  sideEffectScope?: ToolSideEffectScope;
}

export interface ToolCallProgressPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  elapsedMs?: number;
  /** MCP `notifications/progress` (A8): forward progress / total / message unchanged. */
  progress?: number;
  total?: number;
  message?: string;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputBytes?: number;
  outputPreview?: ExecutionOutputPreview;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface ToolCallResultPayload {
  toolCallId: ToolCallId;
  result: ToolResultPayload;
  duration: number;
  /** Skill metadata is for telemetry only and is not included in model-visible result.content. */
  skillMetadata?: SkillTelemetryMetadata;
}

export interface ToolCallErrorPayload {
  toolCallId: ToolCallId;
  error: ErrorPayload;
  /** Skill metadata is for telemetry only and is not included in model-visible error text. */
  skillMetadata?: SkillTelemetryMetadata;
}

export interface ToolBatchCompletePayload {
  toolCallIds: ToolCallId[];
  successCount: number;
  errorCount: number;
}

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskPayloadBase {
  taskId: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  // "workflow" = workflow run (CreateWorkflow). Tracker behavior now dispatches through per-tool lifecycleProvider;
  // "dream" = background memory consolidation launched by the /dream command (registry task, not a tool call).
  // taskKind only controls panel grouping and icon, so widening it is a display-only correction with no lifecycle change.
  taskKind?: "bash" | "subagent" | "workflow" | "dream";
  childSessionId?: SessionId | string;
  blocked?: boolean;
  blockedReason?: "interactive_prompt_detected" | "no_output_progress" | string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskStatus;
  pid?: number;
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  terminalId?: string;
}

export type BackgroundTaskStartedPayload = BackgroundTaskPayloadBase & {
  status: "running";
};

export type BackgroundTaskUpdatedPayload = BackgroundTaskPayloadBase;

export type BackgroundTaskCompletedPayload = BackgroundTaskPayloadBase & {
  status: Exclude<BackgroundTaskStatus, "running">;
};

/**
 * One workflow-run progress event (parent session). Its fields match {@link DynamicWorkflowRunEvent}—
 * **one serialization, two consumers**: the event page from `listEvents` and this session event share
 * one bounded payload, so readers need only one set of interpretation rules. `type` is already used by
 * the session-event envelope, so the engine event kind is named `eventType`.
 */
export interface DynamicWorkflowRunProgressPayload {
  runId: string;
  /** CreateWorkflow tool call that launched this run (join key from tool card to details). */
  toolCallId?: ToolCallId | string;
  /** Journal sequence (assigned monotonically by `appendEvent`); the event-log cursor uses the same scale. */
  sequence: number;
  /** Engine event kind: run-started / actor-created / node-* / usage-updated / log / report / phase-entered / run-settled. */
  eventType: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  /** Derived by toProgressPayload: on `actor-created`, the subagent session id (minted by the driver as `sess_dwf-…`). */
  actorSessionId?: string;
  /**
   * Derived by toProgressPayload (same as `actorSessionId`): this run's `run-launched.inputId`.
   * Attached only to `actor-created` / `run-settled` events so downstream consumers can associate a
   * subagent with the turn that launched its run. Runs from before the upgrade have no `run-launched`,
   * so this field is omitted.
   */
  launchInputId?: string;
}

export interface PermissionRequestedPayload {
  approvalMode?: "user-once";
  requestId?: string;
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  input: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /**
   * Tool-provided approval preview, produced by the `prepareApproval` hook. Reuses the result channel's
   * display projection so ask and result cards share one bounded shape, without adding an unbounded field.
   */
  display?: ToolResultDisplayPayload;
  fullAccessSupported?: boolean;
  optionsPolicy?: PermissionOptionsPolicy;
}

/** Identify a sandbox instance by (scopeId, generation); the renderer delivers only to a matching generation. */
export interface PluginUiResourceSubscriberRef {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  scopeId: string;
  generation: number;
}
export interface PluginUiResourceUpdatedPayload {
  pluginId: string;
  serverName: string;
  uri: string;
  subscribers: PluginUiResourceSubscriberRef[];
}
export interface PluginUiResourceListChangedPayload {
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
}
/** App-Provided Tools: a pending page-tool call delivered to the single matching subscriber instance. */
export interface PluginUiAppToolCallRequestedPayload {
  activity?: boolean;
  cancelled?: boolean;
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface PermissionResolvedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
}

export interface PermissionDeniedPayload {
  toolCallId: ToolCallId;
  toolName: string;
  reason: string;
  inputSummary?: unknown;
}

export type UserInputAutoResolutionState =
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

export interface UserInputAutoResolutionUpdatedPayload {
  interactionId: string;
  toolCallId: ToolCallId;
  autoResolution: UserInputAutoResolutionState;
}

export interface WorkspaceHookReviewRequestedPayload {
  request: unknown;
}

export interface WorkspaceHookReviewSettledPayload {
  interactionId: string;
  state: "resolved" | "timed_out" | "configuration_error";
  reasonCode?: string;
}

export interface WorkspaceHookReviewSupersededPayload {
  interactionId: string;
  supersededByInteractionId: string;
}

// Soft gate: the admission layer reports pending state after evaluation.
// pendingCount = number of declarations where configuredEnabled && admissionClass === "pending";
// pendingCount === 0 → the projection sets snapshot.workspaceHookAdmission to null (the banner disappears).
export interface WorkspaceHookAdmissionUpdatedPayload {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export type PermissionDecision = "allow" | "deny" | "escalate" | "modify";

export type TargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

export type TargetChangedSource = "command" | "tool" | "runtime";

export interface TargetChangedPayload {
  action: TargetChangedAction;
  source: TargetChangedSource;
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}

// -----------------------------------------------
// Supporting Types
// -----------------------------------------------

export interface Attachment {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
  mimeType?: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallPayload[];
  toolCallId?: string;
}

export interface ToolCallPayload {
  id: ToolCallId;
  name: string;
  input: unknown;
}

export interface ToolResultPayload {
  success: boolean;
  content: string;
  display?: ToolResultDisplayPayload;
  perf?: import("../tools/performance.js").ToolExecutionTelemetry;
  error?: ErrorPayload;
  truncated?: boolean;
  originalBytes?: number;
  returnedBytes?: number;
  budgetStrategy?: string;
  artifactPath?: string;
}

export interface ToolSchedulePayload {
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheTokens?: number;
}

export interface ErrorPayload {
  code?: string;
  detail?: string;
  /** Original message from the deepest non-wrapper frame in the error chain, for client telemetry root-cause analysis. */
  underlyingErrorMessage?: string;
  /** detail / errorDetails / details content from the same underlying frame. */
  underlyingErrorDetail?: string;
  type: string;
  message: string;
  attribution?: ErrorAttribution;
  retryable?: boolean;
  stack?: string;
  data?: unknown;
}

/** Carries only aggregatable failure facts; excludes request bodies, credentials, URLs, and monitoring policy. */
export interface ErrorAttribution {
  source?: "provider" | "runtime" | "tool" | "network";
  reason?: string;
  errorPhase?: ModelApiErrorPhase;
  exceptionKind?: ModelFailureExceptionKind;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: "http" | "sse" | "websocket";
  statusCode?: number;
  providerErrorCode?: string;
  retryable?: boolean;
}

// CollaborationMode and RiskLevel are re-exported from ports

// -----------------------------------------------
// Event Factory
// -----------------------------------------------

export function createSessionEvent<T>(
  type: SessionEventType,
  sessionId: SessionId,
  payload: T,
  options?: {
    turnId?: TurnId;
    traceId?: TraceId;
    sequenceNumber?: number;
  },
): SessionEvent {
  return {
    id: crypto.randomUUID() as EventId,
    sessionId,
    turnId: options?.turnId,
    type,
    timestamp: new Date(),
    traceId: options?.traceId ?? (crypto.randomUUID() as TraceId),
    sequenceNumber: options?.sequenceNumber ?? 0,
    payload,
  };
}

export function createModelUsageSummaryFromEvents(
  events: readonly SessionEvent[],
): ModelUsageSummary | undefined {
  const usages: ModelUsage[] = [];

  for (const event of events) {
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload as Partial<ModelCompletePayload>;
    if (payload.usage) {
      usages.push(payload.usage as ModelUsage);
    }
  }

  return createModelUsageSummary(usages);
}

/**
 * Latest ChatGPT plan (SIWC) usage reading carried by this turn's model_complete events.
 * Keep provider id beside its snapshot so model switches and queued turns cannot attribute
 * the reading using a later session selection.
 */
export function latestProviderRateLimitReadingFromEvents(
  events: readonly SessionEvent[],
): { providerId: string; usage: NonNullable<ModelUsage["providerRateLimits"]> } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== SessionEventType.ModelComplete) continue;
    const usage = (event.payload as Partial<ModelCompletePayload>).usage as
      | ModelUsage
      | undefined;
    if (usage?.providerRateLimits && usage.providerRateLimitProviderId) {
      return {
        providerId: usage.providerRateLimitProviderId,
        usage: usage.providerRateLimits,
      };
    }
  }
  return undefined;
}

export type SessionEventPayload =
  | SessionCreatedPayload
  | SessionResumedPayload
  | SessionForkedPayload
  | SessionCompactedPayload
  | SessionTitleUpdatedPayload
  | SessionModeChangedPayload
  | TurnStartedPayload
  | TurnInputReceivedPayload
  | TurnSteerQueuedPayload
  | TurnSteerDeliveryChangedPayload
  | TurnSteerDispatchChangedPayload
  | TurnSteerDrainedPayload
  | TurnSteerReorderedPayload
  | QueueAutoDrainChangedPayload
  | FollowupModeChangedPayload
  | TurnSteerRejectedPayload
  | TurnSteerDiscardedPayload
  | SessionInputPromotedPayload
  | TurnCompletePayload
  | TurnErrorPayload
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload
  | ModelRequestPayload
  | ModelSelectedPayload
  | TurnExecutionModelFallbackPayload
  | ModelStreamingPayload
  | StreamingToolLedgerPayload
  | StreamRecoveryAnchorPayload
  | StreamRecoveryStartedPayload
  | StreamRecoveryAnchorSelectedPayload
  | StreamRecoveryTailDiscardedPayload
  | StreamRecoveryRetryStartedPayload
  | StreamRecoveryBlockedPayload
  | ModelNetworkStatusPayload
  | ModelAnomalyWarningPayload
  | NetworkRequestStatusPayload
  | ModelCompletePayload
  | TargetCompletionVerificationPayload
  | ModelErrorPayload
  | ToolCallScheduledPayload
  | ToolCallStartedPayload
  | ToolCallProgressPayload
  | ToolCallResultPayload
  | ToolCallErrorPayload
  | ToolBatchCompletePayload
  | BackgroundTaskStartedPayload
  | BackgroundTaskUpdatedPayload
  | BackgroundTaskCompletedPayload
  | DynamicWorkflowRunProgressPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload
  | PermissionDeniedPayload
  | PluginUiResourceUpdatedPayload
  | PluginUiResourceListChangedPayload
  | PluginUiAppToolCallRequestedPayload
  | UserInputAutoResolutionUpdatedPayload
  | WorkspaceHookReviewRequestedPayload
  | WorkspaceHookReviewSettledPayload
  | WorkspaceHookReviewSupersededPayload
  | WorkspaceHookAdmissionUpdatedPayload
  | HookRunLifecyclePayload
  | CompactLifecyclePayload
  | MicrocompactBoundaryEventPayload
  | CheckpointCreatedPayload
  | RewindTriggeredPayload
  | CompactBoundaryPayload;
