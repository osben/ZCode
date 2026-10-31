import type { ExecutionOutputPreview } from "../interfaces/execution.port.js";
import type { RuntimeInputPresentation } from "../interfaces/runtime-input-presentation.js";
/* eslint-disable max-lines -- session event contracts are exported from one file so app/agent protocol types do not drift apart. */
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
  ExternalAgentConfigUpdatedPayload,
  ExternalAgentStatusPayload,
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
  // ACP agent session selects (specs/acp-agent-runtime.md "S6"): config state, never a transcript row.
  ExternalAgentConfigUpdated: "external_agent_config_updated",
  // ACP agent stall/resume during a prompt: a transient turn status, never a transcript row.
  ExternalAgentStatus: "external_agent_status",
  SessionEnded: "session_ended",
  TurnStarted: "turn_started",
  TurnInputReceived: "turn_input_received",
  TurnSteerQueued: "turn_steer_queued",
  // When guide closes without meeting a usable tool batch, the original intent re-routes in place to the ordinary queue.
  TurnSteerDeliveryChanged: "turn_steer_delivery_changed",
  // sendQueuedNow atomic promotion: reservation/promoting/rollback all enter the event stream; projections do not guess locally.
  TurnSteerDispatchChanged: "turn_steer_dispatch_changed",
  TurnSteerDrained: "turn_steer_drained",
  TurnSteerRejected: "turn_steer_rejected",
  TurnSteerDiscarded: "turn_steer_discarded",
  // session_input and the user message/parts were promoted in the same transaction; CommandInbox may safely unpin.
  SessionInputPromoted: "session_input_promoted",
  // v4 queue reorder: queue item order change (the reducer reorders queue rows by orderedPendingInputIds).
  TurnSteerReordered: "turn_steer_reordered",
  // v4 input control: the queue autoDrain toggle (held derives heldQueueInputRequiresChoice's authorization bit).
  QueueAutoDrainChanged: "queue_auto_drain_changed",
  // v4 input control: the followup routing mode (enqueue vs guide while running).
  FollowupModeChanged: "followup_mode_changed",
  TurnComplete: "turn_complete",
  TurnError: "turn_error",
  UserMessage: "user_message",
  AssistantMessage: "assistant_message",
  AssistantFeedbackUpdated: "assistant_feedback_updated",
  RowPinnedUpdated: "row_pinned_updated",
  HighspeedMetricsUpdated: "highspeed_metrics_updated",
  // (2026-09-12): the former ToolWidgetStateUpdated / SessionPluginUiStateUpdated were deleted;
  // plugin UI widgetState falls back to renderer memory and no longer flows through CLI events.
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
  // Real-time progress of a workflow run: one engine RunEvent becomes one event, appended to
  // the **parent session** (the run has no session of its own).
  // The v4 side reduces these into the workflowRuns state key; the v3 side strips them in
  // shouldExposeSessionEventToProtocol.
  // The dynamic_ prefix is deliberate: the legacy `Workflow` tool's script run events
  // (workflow_started / workflow_completed, script-workflow-runtime.ts) are a separate log, and a shared name would genuinely confuse.
  DynamicWorkflowRunProgress: "dynamic_workflow_run_progress",
  PermissionRequested: "permission_requested",
  PermissionResolved: "permission_resolved",
  PermissionDenied: "permission_denied",
  // MCP resource changes subscribed by plugin UI. Live projection only (v4Gateway.ingest, seq 0); not persisted, not in cold recovery.
  PluginUiResourceUpdated: "plugin_ui_resource_updated",
  PluginUiResourceListChanged: "plugin_ui_resource_list_changed",
  /** App-Provided Tools: model-initiated page tool calls; live projection only (instance mailbox), not persisted. */
  PluginUiInstanceClosed: "plugin_ui_instance_closed",
  PluginUiAppToolCallRequested: "plugin_ui_app_tool_call_requested",
  UserInputAutoResolutionUpdated: "user_input_auto_resolution_updated",
  WorkspaceHookReviewRequested: "workspace_hook_review_requested",
  WorkspaceHookReviewSettled: "workspace_hook_review_settled",
  WorkspaceHookReviewSuperseded: "workspace_hook_review_superseded",
  // Soft gate: emitted when admission state changes; when pendingCount=0 the projection layer clears the snapshot field.
  WorkspaceHookAdmissionUpdated: "workspace_hook_admission_updated",
  WorkspaceMcpAdmissionUpdated: "workspace_mcp_admission_updated",
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
 * Attachment rendering (additive): lightweight display metadata for user-input attachments,
 * delivered with TurnStarted; the v4 projection fills the userInput row's attachments from it.
 * Carries display fields only, never the content body (content travels via resolve/persist into FilePart/artifact).
 */
export interface TurnAttachmentMeta {
  fileName: string;
  mime: string;
  bytes: number;
  /** Content reference (local path / artifact URI); absent for data URLs and other unstable references. */
  ref?: string;
}

/**
 * Structured payload of a workflow notification.
 * Minted on the emitter side and bounded (summary≤500 / result≤4000 / error≤2000 /
 * reports.preview ≤500 each and ≤8 entries / artifacts ≤8 / title≤120 /
 * question·context≤4000); kept manually in sync with shared's
 * workflowNotificationMetaSchema.
 * Batch notification turns deliberately omit it — the one-manifest-per-turn mapping does not hold in batches.
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
       * Chips payload of user-facing artifacts: ≤ 8 entries;
       * anything beyond (including those filtered out by kind) sets `artifactsTruncated`.
       *
       * ⚠ Terminology: artifact here is what the script publishes for the user via `artifact.*`,
       * distinct from the `result` on the same payload (the script's top-level return value,
       * which the engine also calls artifact).
       */
      artifacts?: {
        id: string;
        kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
        title?: string;
        version: number;
        contentType?: string;
        /** The run's deliverable; the listing leads with it. Only it carries `description` (the completion card's deliverable line reads it aloud). */
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
   * The script reached a hole (the `hole` payload of
   * docs/dynamic-workflow/transcript-and-notifications.md): the main agent owes this run a
   * piece of code. `prompt` ≤4000 (same bound as escalation questions); `before` / `after` are
   * the stage names around the hole, and `draftPath` / `line` point at that line in the run
   * draft. Exactly one per `hole-reached`.
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
  /** Run-level stall: one per stall segment, not a terminal state. */
  | {
      kind: "stall";
      sinceMs: number;
      reason?: string;
      cap?: number;
    };

/**
 * Reminder for when the main agent is idle while a run still owes decisions: one per run,
 * carrying the open question count, waiting hole count, and longest wait at emission time.
 * Not a run event — emitted by the parent session's idle clock.
 *
 * It is a separate key on originMeta, not a WorkflowNotificationMeta member: that union is a
 * closed set on the wire, and an extra kind would make clients that do not know it reject the
 * whole frame and be unable to open the session; an unknown key is merely stripped
 * (docs/dynamic-workflow/transcript-and-notifications.md, "The payload").
 */
export interface WorkflowBlockedMeta {
  questions: number;
  holes: number;
  sinceMs: number;
}

/** Background Agent terminal state; product status reads this instead of parsing notification text. error appears only on failed, same cause as in the summary. */
export interface SubagentResultMeta {
  status: "completed" | "failed" | "killed";
  error?: string;
}

/** Display metadata of a standalone background-result turn; batch turns may reuse the representative task identity and synthesize a title instead of reverse-parsing notification text. */
export interface BackgroundResultOriginMeta {
  /** `workflow` is a dynamic-workflow run (workId ≡ runId), reusing the whole background-notification pipeline. */
  /** `dream` is the /dream memory-consolidation completion notification. */
  backgroundSource: "bash" | "subagent" | "workflow" | "dream";
  workId: string;
  title: string;
  /** Present only on a single-notification turn with backgroundSource === "workflow"; the sole data source for manifest rendering. */
  workflowNotification?: WorkflowNotificationMeta;
  /** Idle-reminder payload; at most one of it and workflowNotification is present. */
  workflowBlocked?: WorkflowBlockedMeta;
  /** Present only on a single-notification turn with backgroundSource === "subagent"; merged turns do not carry it. */
  subagentResult?: SubagentResultMeta;
}

/**
 * Whether the turn carries real Agent execution. controlOnly only establishes a timeline
 * boundary for visible control input; it must not advance session running/activeWorks and
 * should produce no "working/worked" state.
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
 * Launch-turn metadata for a hub-started saved workflow. The same copy is written into the
 * user message's `metadata` (cold-recovery source) and the `TurnStarted` payload (live
 * projection source) — identical shape cold and hot, letting the projection draw the launch
 * card from it instead of display text.
 */
/** The display on launch metadata allows only the create_workflow projection (same shape as the shared row schema). */
export type WorkflowLaunchDisplay = Extract<ToolResultDisplayPayload, { kind: "create_workflow" }>;

/**
 * The settings turn's (docs/dynamic-workflow/launch.md, "The settings turn") "what changed":
 * only changed settings are present; a missing from / to end means that end is the default
 * (model = session model, cap = default concurrency). `ceiling` is the default concurrency D
 * (the wire key predates the "default concurrency" concept and is kept for legacy clients),
 * supporting readings like "default 13 → 4". Same shape as shared's `workflowSettingsAmendMetaSchema`.
 */
export interface WorkflowSettingsAmendMeta {
  /**
   * The run this adjustment replaces (or continues). **Absent means applied in place**
   * (docs/dynamic-workflow/launch.md, "The settings turn"): when only the concurrency cap
   * changes and the run is still in flight, that "configure" neither stops the run nor starts
   * another, so there is no predecessor to point at — `runId` names the adjusted run itself.
   * Same shape as shared's `workflowSettingsAmendMetaSchema` (which records the legacy-desktop skew).
   */
  predecessorRunId?: string;
  subagentModel?: { from?: string; to?: string };
  maxConcurrency?: { from?: number; to?: number };
  ceiling?: number;
}

export interface WorkflowLaunchMeta {
  /** The run's identity (≡ backgroundTaskId ≡ cancelBackgroundWork's workId). */
  runId: string;
  /**
   * The synthetic toolCall id that launched this run (hub launch `launch-<uuid>`, settings
   * turn `settings-<uuid>`; the tool-card → detail-page link key).
   */
  toolCallId: string;
  /**
   * The workflow name (resolution result, not user/model overridable); both the launch card
   * title and the session title use it. Always present on hub launches; on the settings turn it
   * is the adjusted run's own name, absent for unnamed runs (the UI falls back to placeholder
   * wording rather than using the run id as a title).
   */
  name?: string;
  /** The resolved actual scope (not the request's possibly-absent scope). Hub launches only: the settings turn has no saved file to point to. */
  scope?: SavedWorkflowScope;
  /** Where the saved file landed, for details/diagnostics; not part of execution. Hub launches only. */
  path?: string;
  /** This run's arguments (validated against declarations with defaults filled in); bounds in {@link boundWorkflowLaunchMeta}. */
  args?: Record<string, unknown>;
  /** Workflow description (the saved metadata's description), bounded ≤ 500 characters. */
  description?: string;
  /**
   * The `create_workflow` result display compiled before launch (bounded causal graph +
   * diagnostics); same projection and constructor as the CreateWorkflow tool row's `display`.
   * The run detail side pane looks up the "originating row" by toolCallId for the graph — a
   * direct launch has no tool row, so the graph comes from here.
   */
  display?: WorkflowLaunchDisplay;
  /**
   * The raw script this run actually executes (same copy as `port.submit.scriptText`). The
   * tool path puts it on the tool input `input.script` for the side pane's Script section; this
   * is the same fact's launch-turn landing spot; bounds in
   * {@link WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS} (over-bound it is entirely absent, and the side
   * pane's Script section goes with it).
   */
  script?: string;
  /** Settings-turn only: which run this run was revised from via "Configure", and what changed. */
  amend?: WorkflowSettingsAmendMeta;
}

/** JSON serialization bound (bytes) for {@link WorkflowLaunchMeta.args}. Over-bound it is dropped and replaced with a marker key. */
export const WORKFLOW_LAUNCH_ARGS_MAX_BYTES = 4_096;
/** Character bound for {@link WorkflowLaunchMeta.description}. */
export const WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS = 500;
/**
 * Character bound for {@link WorkflowLaunchMeta.script}. The tool path's `input.script`
 * already enters the transcript unbounded, so this cap only needs to exceed any sane dwf
 * script while blocking an accidentally-inlined whole repo; over-bound it is entirely absent
 * rather than truncated (a half script is useless to the Script section — the graph still
 * lives in display).
 */
export const WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS = 256_000;
/**
 * The stand-in key used when args exceed the bound. Real arguments always travel via the
 * model-facing canonical sentence (that copy is never truncated); this metadata feeds only the
 * launch card — a 4KB argument bag is unshowable on a card anyway, so it is wholly replaced
 * with a single readable marker instead of being crammed in. The ellipsis is the key: it falls
 * outside `SAVED_WORKFLOW_NAME_PATTERN` and can never collide with a real argument name.
 */
export const WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY = "…";

/**
 * Pulls launch-turn metadata inside its bounds. If serialized args exceed
 * {@link WORKFLOW_LAUNCH_ARGS_MAX_BYTES}, they are wholly replaced with the
 * `{ "…": "arguments omitted (N bytes)" }` marker (see
 * {@link WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY}); if description exceeds
 * {@link WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS}, it is truncated with an ellipsis. Called at
 * the minting site so message metadata and the TurnStarted payload get the same bounded values.
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
  // display is already length-bounded at construction (createCreateWorkflowDisplay + boundCausalityGraph); passed through verbatim.
  if (input.display !== undefined) bounded.display = input.display;
  if (input.script !== undefined && input.script.length <= WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS) {
    bounded.script = input.script;
  }
  // The amend block is itself bounded (the two model strings come from the caller's resolved canonical form, same bound as run state).
  if (input.amend !== undefined) bounded.amend = input.amend;
  return bounded;
}

export interface TurnStartedPayloadBase {
  /** Client origin of the current input/background causal chain, for statistics only. */
  inputOrigin?: "desktop" | "mobile";
  /** Monotonic epoch ms of the execution entry; hooks/persistence happen before TurnStarted is published, so execution start cannot be inferred from publish time. */
  executionStartedAt?: number;
  turnNumber: number;
  input: string;
  /**
   * v4 file summaries query by turn rowId, but workspace checkpoints use the user messageId
   * as the recovery anchor; TurnStarted must carry the same persistent id so the projection
   * can map a userInput row back to its checkpoint.
   */
  messageId?: MessageId;
  inputId?: string;
  /** Passed through by admission only for bodyless telemetry facts; must not be inferred from session ownership. */
  /** Stable cancellation identity of the override-primary-turn → goal verify/continue within one runtime command. */
  foregroundExecutionId?: string;
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputVisibility?: MessageVisibility;
  /**
   * Launch-turn metadata for a hub-started saved workflow (present when
   * `inputSource === "workflow_launch"`). The live projection draws the launch card from it;
   * aligned with the same copy in message metadata (identical cold and hot).
   */
  workflowLaunch?: WorkflowLaunchMeta;
/** Defaults to agent, for legacy events and historical transcripts. */
  executionKind?: TurnExecutionKind;
  /**
   * From this index on, `input` is engine-appended text (dwf ask footnote / nudge); the GUI
   * folds it into the disclosure; 0 = the whole string is; absent = none. Aligned with the
   * same copy in message metadata (identical cold and hot).
   */
  epilogueStart?: number;
  /** Structured source of an idle background wake; active-loop merging does not create a separate TurnStarted. */
  originMeta?: BackgroundResultOriginMeta;
  /** Passed through only when every member of a background notification batch shares one source; left empty for mixed sources. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  targetId?: string;
  /** Attachment metadata of this turn's user input (absent when there are none). */
  attachments?: TurnAttachmentMeta[];
  /** CLI admission metadata; inputId remains the sourceCommandId compatibility anchor. */
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
  /** Trusted automation identity injected by Host admission; recovering it from tracking fields is forbidden. */
  automationId?: string;
  /** Tool names not exposed to the provider while the current queued input is consumed. */
  toolDisallowlist?: readonly string[];
  /** Delivery semantics: queue = new product turn when consumed; guide = inlined into the current turn. */
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
  /** The full intent after re-routing; reducer/cold replay must not guess delivery from side-channel state. */
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
   * The drain fact carries its own text and persistent messageId, so the projection no longer
   * depends on in-memory queue state for the text (a missing queue item used to silently drop
   * the user row).
   * delivery decides the turn-switch semantics; defaults to queue (one turn per item).
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
  // user_removed (v4 queue single-item delete): the user explicitly removed an item from the queue, distinct from turn-lifecycle discard.
  // promoted: sendQueuedNow has taken the execution right and the item is only removed from the
  // queue projection; session_input must stay admitted until the user message's atomic
  // promotion (or discarded after a restart).
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
  /** Count of model artifacts the current query has successfully committed to the provider-visible persistent history. */
  historyRoundCount?: number;
  duration: number;
  inputId?: string;
  resultType: TurnResultType;
  /** Whether the current turn consumed a subagent-sourced background result notification. */
  backgroundSubagentResultConsumed?: boolean;
  /** Whether the current turn consumed a workflow-sourced (dynamic-workflow run) background notification. */
  workflowResultConsumed?: boolean;
  /** An internal preemption (e.g. sendQueuedNow) only terminates the current turn; it is not equivalent to the user's manual Stop of the queue. */
  preserveQueueAutoDrainOnCancel?: boolean;
}

export interface TurnErrorPayload {
  error: ErrorPayload;
  turnPhase: string;
  inputId?: string;
  /** Whether the current turn consumed a subagent-sourced background result notification. */
  backgroundSubagentResultConsumed?: boolean;
  /** Whether the current turn consumed a workflow-sourced (dynamic-workflow run) background notification. */
  workflowResultConsumed?: boolean;
}

export type TurnResultType =
  | "success"
  // "cancelled": a user-initiated interruption (TurnCancelled) is a normal ending, reported via TurnComplete rather than TurnError.
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
  /** `external_agent_context_reset`: `content` is the agent id (specs/acp-agent-runtime.md "S5"). */
  type: "init" | "compact_boundary" | "interrupted" | "external_agent_context_reset";
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
  /** When sendQueuedNow preempts the verifier, only the goal is paused, not the future queue. */
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
  /** Reasoning already resolved by the Active Model, for execution-fact/display projections only; not part of the sparse Selection. */
  effectiveReasoningLevel?: string;
  /** Absent means only the current selection updates; null means an explicit ∅→selection model boundary. */
  previousModelSelection?: ModelSelection | null;
  /** Carried only when the Agent auto-restores a model; absent means an ordinary selection or a legacy event. */
  origin?: ModelSelectionOrigin;
  /** Thinking-tier capability of the current selection; published atomically with the model selection in the same event. */
  supportedThoughtLevels?: string[];
  /** Context window actually applied at runtime for the current selection; null is an explicit clear, and a missing field stays compatible with legacy events. */
  contextWindow?: number | null;
}

/**
 * Why an execution Selection fell back to the session Selection; same value domain as
 * @zcode/shared's selectionFallback rules: card expiry is matched by declared provider error
 * codes, and any other speed-up request failure is classified as request_failed.
 */
export type TurnExecutionModelFallbackReason =
  | "highspeed_card_expired"
  | "highspeed_request_failed"
  | "highspeed_selection_unavailable";

export interface TurnExecutionModelFallbackPayload {
  inputId?: string;
  reason: TurnExecutionModelFallbackReason;
  /**
   * After the Provider refactor, single-turn execution models are uniformly expressed as a
   * sparse Selection (the old ModelRef is gone): from is this turn's execution-scoped speed-up
   * Selection, to is the session's resident Selection.
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
  | "tool_call_rotation"
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
   * Effective auto-compact threshold in tokens for the executing model and compact config, resolved by the
   * runtime with the same math as `shouldAutoCompact`; `null` means auto-compact is disabled. Emitted on
   * main-turn completions only; absent in older events.
   */
  autoCompactThresholdTokens?: number | null;
  /** Effective microcompact threshold; null means disabled, absent is a legacy event. */
  microcompactThresholdTokens?: number | null;
  fileChanges?: TurnFileChangeSummary;
  querySource?: string;
  stopReason: string;
  /** Count of complete tool calls assembled by the current model request; may be missing on legacy events. */
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
  /** Human-readable title of an external agent tool call (ACP `title`); absent for ZCode tools. */
  title?: string;
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
   * The call's side-effect capability **after resolution** (tool metadata + runtime capability
   * resolved from inputs, e.g. Bash's read-only command detection). The event is emitted
   * before the handler acts, so subscribers know "about to write" before the first byte lands
   * — dynamic-workflow's driver uses it to close the amend-resume import cache
   * (`isWorkspaceMutatingToolCall`). Optional: events earlier than this field do not have it.
   */
  readOnly?: boolean;
  sideEffectScope?: ToolSideEffectScope;
}

export interface ToolCallProgressPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  elapsedMs?: number;
  /** MCP `notifications/progress` (A8): progress / total / message forwarded verbatim. */
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
  /** Skill metadata is for telemetry only and never enters model-visible result.content. */
  skillMetadata?: SkillTelemetryMetadata;
  /** The ToolEntry's plugin attribution at execution time; not inferred from the tool name. */
  pluginId?: string;
}

export interface ToolCallErrorPayload {
  toolCallId: ToolCallId;
  error: ErrorPayload;
  /** Skill metadata is for telemetry only and never enters the model-visible error body. */
  skillMetadata?: SkillTelemetryMetadata;
  /** The ToolEntry's plugin attribution at execution time; not inferred from the tool name. */
  pluginId?: string;
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
  // "workflow" = a workflow run (CreateWorkflow). Tracker behavior is already dispatched per
  // tool via lifecycleProvider; taskKind only decides panel grouping and icons, so widening it
  // is a pure display fix that changes no lifecycle semantics.
  // "dream" = background memory consolidation launched by the /dream command (registry task, not a tool call).
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
 * One workflow run progress event (parent session). Fields share the shape of
 * {@link DynamicWorkflowRunEvent} — **one serialization, two consumers**: `listEvents`' event
 * page and this session event use the same bounded payload, so readers need no two sets of
 * interpretation rules. `type` is taken by the session-event envelope, hence the engine event
 * kind is called `eventType`.
 */
export interface DynamicWorkflowRunProgressPayload {
  runId: string;
  /** The CreateWorkflow tool call that launched this run (tool-card → detail-page link key). */
  toolCallId?: ToolCallId | string;
  /** journal sequence (monotonic, allocated by `appendEvent`); the event-log cursor uses the same ruler. */
  sequence: number;
  /** Engine event kind: run-started / actor-created / node-* / usage-updated / log / report / phase-entered / run-settled. */
  eventType: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  /** Derived field (toProgressPayload): the subagent session's id on `actor-created` (driver-minted `sess_dwf-…`). */
  actorSessionId?: string;
  /**
   * Derived field (same family as `actorSessionId`, see toProgressPayload): the run's
   * `run-launched.inputId`. Attached only to `actor-created` / `run-settled` events so
   * downstream can attribute the subagent to the turn that launched the run. Pre-upgrade runs
   * have no `run-launched`, and the field is absent.
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
   * The tool's self-reported confirmation preview, produced by the `prepareApproval` hook.
   * Reuses the result channel's display projection so ask and result cards share the same
   * bounded shape, adding no unbounded fields.
   */
  display?: ToolResultDisplayPayload;
  fullAccessSupported?: boolean;
  optionsPolicy?: PermissionOptionsPolicy;
}

/** Subscribers identify a sandbox instance by (scopeId, generation); the renderer delivers only to instances whose generation matches. */
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
/** App-Provided Tools: one pending page tool call, delivered to the single instance among subscribers. */
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

// Soft gate: the admission layer reports pending state after evaluating.
// pendingCount = declarations that are configuredEnabled && admissionClass === "pending";
// pendingCount === 0 → the projection layer sets snapshot.workspaceHookAdmission to null (the banner disappears).
export interface WorkspaceHookAdmissionUpdatedPayload {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

/** The MCP declaration-set digest is only for banner deduplication; per-item authorization still uses each declarationDigest. */
export interface WorkspaceMcpAdmissionUpdatedPayload {
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
  /** The raw message of the deepest non-wrapper frame in the error chain, for client telemetry root-cause location. */
  underlyingErrorMessage?: string;
  /** The detail/errorDetails/details content of the same underlying frame. */
  underlyingErrorDetail?: string;
  type: string;
  message: string;
  attribution?: ErrorAttribution;
  retryable?: boolean;
  stack?: string;
  data?: unknown;
}

/** Carries aggregatable failure facts only — no request bodies, credentials, URLs, or monitoring policies. */
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
  /** string = that Highspeed card was used; null = explicitly unused; undefined = a legacy Agent did not publish it. */
  highspeedCardId?: string | null;
  /**
   * true = this turn's Highspeed creation- or request-phase failure matched a fallback
   * declaration but no fallback target could be created, so the whole turn ended with the real
   * error. The renderer invalidates the matched card from this; error codes are no longer
   * inferred — a request-phase 3402/network failure's code is a provider error code.
   */
  highspeedFallbackUnavailable?: boolean;
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
    if (event.type === SessionEventType.ModelNetworkStatus) {
      const payload = event.payload as ModelNetworkStatusEvent;
      // Successful requests are counted by ModelComplete; only the failed request's already-reported usage is added, avoiding double counting.
      if (payload.type === "model_request_failed" && payload.usage) usages.push(payload.usage);
    }
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload as Partial<ModelCompletePayload>;
    if (payload.usage) {
      usages.push(payload.usage as ModelUsage);
    }
  }

  return createModelUsageSummary(usages);
}

/**
 * Latest ChatGPT plan (SIWC) usage reading carried by this turn's model_complete events. Keep provider id
 * beside its snapshot so model switches and queued turns cannot attribute the reading using a later session selection.
 */
export function latestProviderRateLimitReadingFromEvents(
  events: readonly SessionEvent[],
): { providerId: string; usage: NonNullable<ModelUsage["providerRateLimits"]> } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== SessionEventType.ModelComplete) continue;
    const usage = (event.payload as Partial<ModelCompletePayload>).usage as ModelUsage | undefined;
    if (usage?.providerRateLimits && usage.providerRateLimitProviderId) {
      return { providerId: usage.providerRateLimitProviderId, usage: usage.providerRateLimits };
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
  | ExternalAgentConfigUpdatedPayload
  | ExternalAgentStatusPayload
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
  | WorkspaceMcpAdmissionUpdatedPayload
  | HookRunLifecyclePayload
  | CompactLifecyclePayload
  | MicrocompactBoundaryEventPayload
  | CheckpointCreatedPayload
  | RewindTriggeredPayload
  | CompactBoundaryPayload;
