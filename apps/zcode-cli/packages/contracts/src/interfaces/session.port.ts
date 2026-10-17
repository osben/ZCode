import type { RuntimeInputPresentation } from "./runtime-input-presentation.js";
// ============================================================
// Session Ports - Core interfaces for session management
// ============================================================

import type { ErrorAttribution, SessionEvent } from "../events/session.events.js";
import type {
  InteractionRequestOrigin,
  MessageId,
  QueryId,
  SessionId,
  TurnId,
  TraceId,
} from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { CompactProjectionInfo } from "../compact/index.js";
import type { CheckpointProjectionInfo, RewindProjectionInfo } from "../rewind/index.js";
import type {
  StreamRecoveryAnchorProjectionInfo,
  StreamingToolLedgerProjectionInfo,
} from "../events/stream-recovery.events.js";
import type { SessionGoal } from "../tools/target.js";
import type { GoalCompletionVerificationOutput } from "../tools/target.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "./permission.port.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { ModelSelection } from "../model/model.js";

// -----------------------------------------------
// Collaboration Mode and Risk Level
// -----------------------------------------------

export type CollaborationMode = "plan" | "build" | "edit" | "yolo" | "guarded" | "auto";

/** A guarded parent only tightens internal YOLO derivations; other explicitly selected submodes keep their own policies. */
export function inheritPermissionMode<T extends CollaborationMode | undefined>(
  parent: CollaborationMode | undefined,
  resolved: T,
): T | "guarded" {
  return parent === "guarded" && resolved === "yolo" ? "guarded" : resolved;
}
export type SessionStatus = "idle" | "running" | "waiting" | "paused" | "completed" | "error";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type InputDelivery = "auto" | "start_turn" | "steer_active_turn";
export type TurnSteerRejectReason =
  | "no_active_turn"
  | "expected_turn_mismatch"
  | "turn_not_steerable"
  | "empty_input"
  | "input_too_large";

// -----------------------------------------------
// Session Event Store Port
// -----------------------------------------------

/** Retained size of the in-memory event store; only for local memory diagnostic logs. */
export interface SessionEventStoreStats {
  sessions: number;
  events: number;
  /** Cumulative transient events evicted by the turn-window strategy; always 0 in unbounded mode. */
  evictedEvents?: number;
  /** Transient events still retained (the in-progress turn plus one lagging turn). */
  retainedTransient?: number;
}

export interface SessionEventStorePort {
  append(event: SessionEvent): Promise<SessionEvent>;
  getEvents(sessionId: SessionId): Promise<SessionEvent[]>;
  getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]>;
  getLatestSequenceNumber(sessionId: SessionId): Promise<number>;
  deleteSession(sessionId: SessionId): Promise<void>;
  /** Synchronous, read-only O(sessions) statistics; persistent implementations may omit this. */
  getStats?(): SessionEventStoreStats;
  /**
   * Time-based fallback eviction of transient events, triggered by a low-frequency tick.
   * Returns the number evicted. Persistent implementations may omit this.
   */
  pruneTransientEvents?(nowMs?: number): number;
}

// -----------------------------------------------
// Live Session Event Sink Port
// -----------------------------------------------

export interface SessionEventSink {
  onSessionEvent(event: SessionEvent): void | Promise<void>;
}

// -----------------------------------------------
// Session Projection Port
// -----------------------------------------------

export interface SessionProjection {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  planEnabled?: boolean;
  status: SessionStatus;
  turnCount: number;
  totalTokenCount: number;
  contextUsed: number;
  contextWindow: number;
  pendingPermissions: PendingPermission[];
  pendingSteerInputs: PendingSteerInputInfo[];
  activeToolCalls: ActiveToolCall[];
  streamingToolLedger: StreamingToolLedgerProjectionInfo[];
  backgroundTasks: BackgroundTaskInfo[];
  currentTurnId?: TurnId;
  lastError?: ErrorInfo;
  lastCompact?: CompactProjectionInfo;
  lastCheckpoint?: CheckpointProjectionInfo;
  lastStreamRecoveryAnchor?: StreamRecoveryAnchorProjectionInfo;
  lastRewind?: RewindProjectionInfo;
  target?: SessionGoal | null;
  targetCompletionVerifications: GoalCompletionVerificationOutput[];
  targetCompletionVerificationTimeline: TargetCompletionVerificationProjectionInfo[];
}

export interface TargetCompletionVerificationProjectionInfo {
  targetId: string;
  status: "started" | "completed" | "failed_closed" | "cancelled";
  verificationId: string;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
  startedAt?: Date;
  updatedAt: Date;
}

export interface PendingPermission {
  approvalMode?: "user-once";
  requestId?: string;
  toolCallId: string;
  toolName: string;
  reason?: string;
  riskLevel: RiskLevel;
  input?: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /** Ask preview from the request event; prompts reconstructed during cold recovery still need the diagram, so keep it in projection state. */
  display?: ToolResultDisplayPayload;
  optionsPolicy?: PermissionOptionsPolicy;
  requestedAt: Date;
}

export interface PendingSteerInputInfo {
  pendingInputId: string;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** Tool-deny list attached to the queued input; automation busy queueing must remain effective when the input is consumed. */
  toolDisallowlist?: readonly string[];
  queuedAt: Date;
  targetTurnId: TurnId;
  traceId: TraceId;
  intent?: TurnInputIntentMetadata;
}

export interface ActiveToolCall {
  toolCallId: string;
  toolName: string;
  status: ToolCallStatus;
  startedAt?: Date;
}

export type ToolCallStatus = "pending" | "running" | "completed" | "failed" | "denied";

export type BackgroundTaskInfoStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskInfo {
  taskId: string;
  toolCallId?: string;
  toolName?: string;
  taskKind?: "bash" | "subagent" | "workflow" | "dream";
  childSessionId?: string;
  blocked?: boolean;
  blockedReason?: string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskInfoStatus;
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

export interface BackgroundTaskCancelResult {
  cancelled: boolean;
  reason?: string;
  snapshot?: BackgroundTaskInfo;
  status: BackgroundTaskInfoStatus;
  taskId: string;
}

export interface ErrorInfo {
  attribution?: ErrorAttribution;
  code?: string;
  detail?: string;
  type: string;
  message: string;
}

// -----------------------------------------------
// Event Reducer Port
// -----------------------------------------------

export interface EventReducerPort {
  reduce(events: SessionEvent[]): SessionProjection;
  apply(projection: SessionProjection, event: SessionEvent): SessionProjection;
}

// -----------------------------------------------
// Session Manager Port
// -----------------------------------------------

export interface SessionManagerPort {
  createSession(config: SessionConfig): Promise<Session>;
  resumeSession(sessionId: SessionId): Promise<Session>;
  forkSession(sessionId: SessionId, forkPoint?: number): Promise<Session>;
  getSession(sessionId: SessionId): Promise<Session | null>;
  listSessions(): Promise<SessionSummary[]>;
}

export interface SessionConfig {
  mode?: CollaborationMode;
  contextWindow?: number;
  traceId?: TraceId;
}

export interface Session {
  id: SessionId;
  config: SessionConfig;
  eventStore: SessionEventStorePort;
  projection: SessionProjection;
  eventReducer: EventReducerPort;
}

export interface TurnSteerInput {
  input: string;
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  pendingInputId?: string;
  traceContext?: TraceContext;
  /** Tool names not exposed to the provider while consuming the current input. */
  toolDisallowlist?: readonly string[];
}

export type TurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";
export type TurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * Input delivery semantics:
 * - "queue": a future intent placed in the queue; consuming it starts a new product turn
 *   (one turn per item, with its own response, work, and edit scope).
 * - "guide": supplemental guidance for work in progress, inlined into the current turn.
 * Runtime injection is the same for both (boundary injection); only the product presentation
 * and ledger semantics differ.
 */
export type TurnSteerDeliveryMode = "guide" | "queue";

/** Persistence contract for message.data metadata.highspeed; excludes runtime credentials. */
export interface HighspeedMessageMetadata {
  schemaVersion: 1;
  cardId: string;
  taskId: string;
  provider: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
  regularTps?: number;
  outputTokens?: number;
  durationMs?: number;
  savedDurationMs?: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
  fallbackAt?: number;
  fallbackReason?: "highspeed_card_expired" | "highspeed_request_failed";
}

/** Protocol-independent input intent metadata; bootstrap v4 assembles ConversationInputIntent at the event boundary. */
export type TurnInputSourceMetadata =
  | { kind: "pluginUi"; pluginId: string; toolCallId: string }
  | { kind: "genUi"; path: string; title?: string };

export interface TurnInputIntentMetadata {
  planEnabled?: boolean;
  conversationQuotes?: Array<{
    text: string;
    path?: string;
    senderName?: string;
    senderId?: string;
    messageId?: string;
    sentAt?: string;
  }>;
  inputOrigin?: "desktop" | "mobile";
  botGroupSource?: {
    botIdentity?: { name: string; openId?: string };
    mentionedBot?: boolean;
    appId?: string;
    contentParts?: import("@zcode/shared").ChannelContentPart[];
    messages?: Array<{
      mentionedBot?: boolean;
      messageId: string;
      senderId: string;
      senderName: string;
      text: string;
      attachmentIndexes: number[];
      contentParts?: import("@zcode/shared").ChannelContentPart[];
    }>;
    /** Injected by Host when queued; historical resource requests cannot borrow a later reauthorization version. */
    authorizationId?: string;
    botId: string;
    provider: "feishu" | "lark";
    chatId: string;
    threadId?: string;
    rootMessageId?: string;
    topicContext?: {
      checkpoint: string;
      hasGap: boolean;
      messages: Array<{
        id: string;
        chatId: string;
        threadId: string;
        senderId: string;
        senderType: "user" | "app";
        text: string;
        createdAt: number;
        kind: string;
        deleted?: boolean;
      }>;
    };
    senderId: string;
    senderName: string;
    messageId: string;
  };
  sourceCommandId: string;
  queueItemId: string;
  clientId: string;
  kind: TurnSteerCommandKind;
  /** Canonical command text carried through the full ConversationInputIntent during transcript hydration. */
  text?: string;
  /** Fixed at admission; Queue/Guide must not later reread the Composer or the Session's latest selection. */
  modelSelection?: ModelSelection;
  /** Collaboration mode fixed with this user Submission. */
  mode?: "build" | "edit" | "plan" | "yolo" | "guarded";
  admissionSeq: number;
  admittedAt: number;
  requestedDelivery: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery: "startNow" | "queue" | "guide";
  queuePosition?: number;
  fallbackReasonCode?: string;
  attachmentRefs?: Array<{
    ref: string;
    fileName: string;
    mime: string;
    bytes: number;
    previewRef?: string;
    sourceKind?: "clipboard-text" | "topic-history";
    messageCount?: number;
  }>;
  highspeed?: HighspeedMessageMetadata;
  sharedContextRefs?: Array<{
    kind: "shared_context_import";
    context_id: string;
  }>;
  /** Stable trace from a command rebuilt by edit/retry to the original canonical input cause. */
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
  /** Source of a plugin UI-sent message (MCP Apps ui/message); omitted for direct user input. */
  source?: TurnInputSourceMetadata;
}

/** Unresolved attachment descriptors retained in the queue; the same resolver as a normal turn is used when consumed. */
export interface PendingTurnAttachment {
  type: "file" | "image" | "video" | "pdf" | "url";
  path?: string;
  content?: string;
  sourceKind?: "clipboard-text" | "topic-history";
  messageCount?: number;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface PendingTurnInput {
  id: string;
  input: string;
  queuedAt: Date;
  traceId: TraceId;
  queryId?: QueryId;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  delivery?: TurnSteerDeliveryMode;
  intent?: TurnInputIntentMetadata;
  attachments?: PendingTurnAttachment[];
  /** Tool names not exposed to the provider after draining the current pending input. */
  toolDisallowlist?: readonly string[];
  turnId: TurnId;
}

export type TurnSteerResult =
  | {
      kind: "queued";
      pendingInputId: string;
      queueLength: number;
      turnId: TurnId;
    }
  | {
      activeTurnId?: TurnId;
      kind: "rejected";
      reason: TurnSteerRejectReason;
    };

export interface SessionSummary {
  id: SessionId;
  createdAt: Date;
  updatedAt: Date;
  mode: CollaborationMode;
  status: SessionStatus;
  turnCount: number;
}
