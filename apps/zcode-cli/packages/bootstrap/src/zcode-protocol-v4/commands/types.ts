// Core capability contract for the native v4 command layer (native rewrite).
//
// Layering rules (no bridge):
// - This directory contains native command implementations: handlers drive core (ZCodeApp/runtime)
//   directly for decisions (steer routing / draft promotion / abort lifecycle / goal-pause barrier),
//   without going through legacy protocol operations.
// - The host still owns the session registry: V4CommandCoreHost passes through the legacy
//   ZCodeProtocolSessionRecord as a "structured narrow view" (same object reference, bidirectional
//   field visibility, no second registry).
// - Environment capabilities (model readiness / legacy broadcast / shell resolution) are injected
//   hooks. The legacy protocol binder supplies implementations during the transition with the same
//   lifecycle as the old protocol; each hook documents its destination, and new hooks must do so too.
import type {
  SessionTaskType,
  StableForkGoalBoundaryMetadata,
  TraceContext,
} from "@zcode/contracts";
import type { DynamicWorkflowMode, ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
  ConversationInputIntent,
  QueueItem,
  StableForkTarget,
  StableForkTargetResolution,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp } from "../../app/types.js";
import type { V4InteractionRegistry } from "../interaction-registry.js";
import type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
} from "../product-projection.js";

/** Minimal logging surface (structured fields pass directly to the host logger). */
export interface V4CommandLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export type V4QueueItemCommand = QueueItem;

/**
 * Per-turn execution material for a queue item (protocol-native shape). The speed-up card's
 * Selection already enters the projection via QueueItem.modelSelection; only the non-projectable
 * dynamic credentials are staged here, frozen into a ModelExecutionContext on promotion.
 */
export type V4QueuedTurnExecution = NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>;

export type V4StableForkTargetResolution =
  | {
      ok: true;
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundaryMetadata;
    }
  | Extract<StableForkTargetResolution, { ok: false }>;

/**
 * Structured narrow view of the legacy ZCodeProtocolSessionRecord (declares only fields needed by
 * the command layer). Structurally compatible: the binder passes through the legacy record object;
 * once v4 owns the session registry, it will provide an object with the same shape.
 */
export interface V4SessionRecordView {
  app: ZCodeApp;
  /**
   * Session-root traceContext (traceId sits above sessionId and corresponds to the whole task chain).
   * Preserve it when command handlers call runtime methods or re-emit core events; do not start a
   * new trace midway. The legacy record already carries this field, so the narrow view passes it through.
   */
  traceContext: TraceContext;
  workspace: { workspacePath: string };
  /** Draft semantics: deferred means no first message has been sent and nothing is written to sqlite; the first send promotes it to immediate. */
  persistence: "immediate" | "deferred";
  /** Active-turn lock: present means a turn is running (sendText routes through steer; stop has a target). */
  activeAbortController?: AbortController;
  /** Reference count for record/runtime users finishing state mutations after the ready lock is released. */
  residencyFinalizationCount?: number;
  /** Currently executing automation-dispatch turn; present only while the turn runs. */
  activeAutomationId?: string;
  /** Currently executing idle-dispatch turn; present only while the turn runs. */
  activeOffPeakTaskId?: string;
  /** Stable callback address for the current inbound Bot turn; restore it when the turn ends. */
  activeBotDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  /** Recovery-failure warning; when present, reject new turns (do not silently continue corrupted history). */
  restoreWarning?: { message: string; type: string };
  taskType?: SessionTaskType;
}

export interface V4CommandCoreHost {
  /** Look up a session (same registry object reference; return undefined if absent, so the handler rejects). */
  getRecord(sessionId: string): V4SessionRecordView | undefined;
  logger?: V4CommandLogger;

  // ── Native v4 capabilities (not transition hooks) ─────────────────────────────
  /** Complete authoritative intent for a queue item; sendQueuedNow must not degrade to resending text only. */
  getQueueItem?(sessionId: string, queueItemId: string): V4QueueItemCommand | null;
  /** Deduplicate typed maintenance commands using the same projection queue as the source of truth; maintain no side set. */
  hasQueueItemKind?(sessionId: string, kind: QueueItem["kind"]): boolean;
  /** Guide eligibility: block only when an ordinary queue already exists; existing guides may continue through FIFO admission. */
  hasQueuedDelivery?(sessionId: string, delivery: "guide" | "queue"): boolean;
  getQueueLength?(sessionId: string): number;
  /** Highspeed queue execution material contains credentials: keep it memory-resident only; it must never enter queue events/snapshots. */
  retainQueuedTurnExecution?(
    sessionId: string,
    sourceCommandId: string,
    execution: V4QueuedTurnExecution,
  ): void;
  readQueuedTurnExecution?(
    sessionId: string,
    sourceCommandId: string,
  ): V4QueuedTurnExecution | undefined;
  deleteQueuedTurnExecution?(sessionId: string, sourceCommandId: string): void;
  clearQueuedTurnExecutions?(sessionId: string): void;
  /** Persist deduplication facts for successful side effects without user messages, such as timeline/child operations. */
  recordPersistentCommandFact?(
    sessionId: string,
    source: "timeline" | "child",
    ack: CommandAck,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  /** Durable admission boundary shared by createSession.firstInput, selection-side firstInput, and ordinary sends. */
  admitInputCommand?(
    envelope: CommandEnvelope,
    sessionId: string,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<ConversationInputIntent | null>;
  cancelInputCommand?(sessionId: string, queueItemId: string, reason: string): Promise<void>;
  discardSharedContext?(sessionId: string, contextId: string): Promise<boolean>;
  /**
   * Current input routing mode (source: v4 projection inputRouting.mode).
   * The held-choice decision for sendText/sendGoalCommand (`heldQueueInputRequiresChoice`) uses it
   * to determine whether heldQueueDisposition is required.
   * If the session has no projection yet (no events), return null (treat as non-held).
   */
  getInputRoutingMode?(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null;
  /** After runtime event notification, wait for the target event to finish reorder drain and projection apply. */
  waitForProjectionEventCommit?(
    sessionId: string,
    eventId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /**
   * rowId -> authoritative messageId (source: v4 projection's rowId-to-messageId translation table).
   * Legacy-compatible lookup: translate a projected rowId (assistant row) to a transcript messageId.
   * If translation fails (non-assistant row/stale rowId), return null and let the handler reject;
   * never silently fall back to latestCheckpoint, which would fork/rewind at the wrong point.
   */
  getMessageIdForRow?(sessionId: string, rowId: number): string | null;
  /** Sole row-target resolver shared by row.actions, CommandInbox, and handlers. */
  resolveRowActionTarget?(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution | null;
  /**
   * rowId -> all transcript messageIds in its product turn (used to undo file summaries).
   * Pass multiple assistant segments/checkpoints to core together to avoid undoing only the last file segment.
   */
  getMessageIdsForTurnRow?(sessionId: string, rowId: number): string[];
  /**
   * Strict core-side check: a fork may attach only to the final segment at the end of a turn.
   * true = final segment; false = middle segment (reject); null = no projection/unknown (treat as translation failure).
   */
  isLatestAssistantSegmentRow?(sessionId: string, rowId: number): boolean | null;
  /** Sole stable-fork resolver: projection gate plus transcript-persistent anchor/fallback. */
  resolveStableForkTarget?(sessionId: string, rowId: number): Promise<V4StableForkTargetResolution>;
  /**
   * Core-side defense for latestAssistantRetryOnly: retryTurn may target only the last assistantText
   * row in the current projection. The handler rejects false/null to prevent legacy clients from bypassing the UI.
   */
  isLatestRetryAssistantRow?(sessionId: string, rowId: number): boolean | null;
  /**
   * Core-side defense for latestQueryEditOnly: editUserQuery may target only the last realUser
   * userInput row in the current projection. The handler rejects false/null to prevent legacy clients from bypassing the UI.
   */
  isLatestEditableUserRow?(sessionId: string, rowId: number): boolean | null;
  /** rowId -> product turnId (used to query the store when editUserQuery has no assistant anchor). */
  getTurnIdForRow?(sessionId: string, rowId: number): string | null;
  /**
   * Timing probe for restoreWarning self-healing: has the current process Registry published an
   * available model? Implemented by the binder; if the host does not support it, do not self-heal and keep rejecting.
   */
  hasUsableRuntimeModelTarget?(record: V4SessionRecordView): boolean;
  /**
   * rowId -> rewind anchor messageId for its turn (same data source as above).
   * editUserQuery targets a user row (which has no messageId), but rewind needs a messageId, so use
   * the assistant row's messageId from the same turn as the anchor.
   */
  getTurnRewindAnchor?(sessionId: string, rowId: number): string | null;
  /**
   * Fallback for a running latest edit before its assistant anchor exists: after stop, look up the
   * real user messageId in sessionStore using the row's turn.
   */
  resolveUserMessageIdForRow?(sessionId: string, rowId: number): Promise<string | null>;
  /**
   * Resolve retryTurn's original prompt: assistant messageId -> parentID (user message) -> text.
   * Source is core sessionStore (transcript authority), not the legacy protocol. The binder
   * implements it only because deps are injected at the host; once v4 owns the session registry,
   * the host will own this natively.
   * If unavailable (no parent/no store), return null; the handler truncates without resending.
   */
  resolveTurnUserPrompt?(sessionId: string, assistantMessageId: string): Promise<string | null>;
  /** Persist assistant feedback as transcript metadata first, then publish the projection event for the same entity. */
  setAssistantFeedback?(
    sessionId: string,
    input: {
      entityId: string;
      messageId: string;
      feedback: "like" | "dislike" | null;
    },
  ): Promise<void>;
  /** Persist a display-only pin as transcript metadata first, then publish the projection event for the same entity. */
  setRowPinned?(
    sessionId: string,
    input: {
      entityId: string;
      messageId: string;
      pinned: boolean;
    },
  ): Promise<void>;
  /** Highspeed completion metrics update user transcript metadata first, then publish the projection event for the same entity. */
  setHighspeedMetrics?(
    sessionId: string,
    input: {
      entityId: string;
      messageId: string;
      metrics: {
        regularTps: number;
        outputTokens: number;
        durationMs: number;
        highspeedTps: number;
        savedDurationMs: number;
        modelDurationMs?: number;
        toolDurationMs?: number;
        otherDurationMs?: number;
      };
    },
  ): Promise<void>;
  /**
   * Interaction response registry (native v4 infrastructure, not a transition hook): register a
   * deferred when interaction-broker issues a reverse request (permission/AskUserQuestion), then
   * deliver the response through the resolveInteraction command. The binder injects the same
   * instance used by the broker. It is optional only to simplify test fixtures; when absent, treat
   * as a miss (idempotently complete successfully).
   */
  interactions?: V4InteractionRegistry;

  // ── Transition hooks (legacy compatibility window) ─────────────────────────────
  /**
   * Check model readiness (credential/catalog resolution) before a turn starts.
   * Currently implemented by the legacy protocol binder (ensureSessionModelAvailableForNextTurn);
   * destination: replace this hook when the core app layer owns model resolution.
   */
  ensureModelReady?(record: V4SessionRecordView): Promise<void>;
  /**
   * Before switching models, validate the target Provider using the Agent process Registry.
   * Ordinary model commands carry only Selection, so this hook cannot accept or install a Host runtime snapshot.
   */
  ensureProviderAvailable?(
    sessionId: string,
    providerId: string,
  ): Promise<{ available: boolean; reason?: string }>;
  /**
   * Legacy broadcast (state.updated + record.stateRevision): legacy protocol consumers (sidebar/task
   * index) still rely on it for state changes until the sidebar migration is complete. v4 projection
   * uses gateway event ingestion and does not depend on this hook; remove the hook when legacy
   * broadcasting is retired.
   */
  afterLegacyStateMutation?(record: V4SessionRecordView, reason: string): Promise<void>;
  /**
   * Close a session (deleteSession execution: unsubscribe events -> app.close -> remove from registry
   * -> clear gateway channels). During transition, the legacy protocol host owns the session registry
   * and the binder implements this inline (order matches the old closeSession operation; see
   * zcode-protocol/server-operations.ts). Once v4 owns the registry, move this into the native implementation.
   */
  closeSession?(sessionId: string): Promise<void>;
  /**
   * Create a session record (createSession execution: record creation/event wiring/model catalog
   * synchronization/failure cleanup, all coupled to the legacy protocol host). The binder calls the
   * old createSession operation; replace this hook with a native implementation once v4 owns the
   * session registry. Semantic decisions (draft persistence/firstInput submission) stay in the
   * native handler, not in the hook.
   */
  createSessionRecord?(params: {
    workspaceId: string;
    /** Host-reserved identity to materialize; the Host must validate the preparation marker. */
    preparedSessionId?: string;
    permissionScope?: "session";
    mcpServers?: CommandPayloadMap["createSession"]["mcpServers"];
    /**
     * Execution worktree for "start in a new worktree without leaving this project": the record
     * runs with this directory as execution cwd while staying listed under workspaceId.
     */
    executionWorktree?: CommandPayloadMap["createSession"]["executionWorktree"];
    /** Host-determined Off-Peak tool-surface gate; tools are not registered by default. */
    offPeakToolEnabled?: boolean;
    /**
     * Host-determined dynamic-workflow rollout gate;
     * defaults to the process-level workspace decision, which remains fail-closed.
     */
    dynamicWorkflowEnabled?: boolean;
    /** Gradual-rollout mode accompanying the boolean (launch.md, "On demand: activation"); defaults to alwaysOn. */
    dynamicWorkflowMode?: DynamicWorkflowMode;
  }): Promise<{ sessionId: string }>;
  /** Reserve a durable session identity without creating a runtime. */
  prepareWorktreeSession?(params: {
    workspaceId: string;
    branchName: string;
    targetPath: string;
    baseBranch?: string;
  }): Promise<{ sessionId: string }>;
  updateWorktreePreparation?(sessionId: string, input: {
    status: "preparing" | "failed" | "cancelled";
    failureMessage?: string;
    worktreePreparation?: {
      branchName: string;
      targetPath: string;
      baseBranch?: string;
    };
  }): Promise<void>;
  /** Create a hidden selection_side_chat child from a stable persisted boundary in the parent session. */
  createSelectionSideSession?(
    sessionId: string,
    options: {
      sourceCommandId: string;
      revisionAtDecision: number;
      modelSelection?: NonNullable<
        CommandPayloadMap["createSelectionSideSession"]["firstInput"]
      >["modelSelection"];
    },
  ): Promise<{ sessionId: string }>;
  /** Stable conversation-only fork; do not stop the parent, rewind the workspace, or copy active work/queue. */
  forkStableConversation?(
    sessionId: string,
    options: {
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundaryMetadata;
      sourceCommandId: string;
      revisionAtDecision: number;
    },
  ): Promise<{ forkedSessionId: string }>;
  /** @deprecated Compatibility with the legacy host shape only; new editUserQuery never calls this, and explicit forkAssistant is unaffected. */
  forkConversationBeforeInput?(
    sessionId: string,
    options: {
      editTarget: ConversationEditTarget;
      envelope: CommandEnvelope;
      admission: { admissionSeq: number; admittedAt: number; queueItemId: string };
    },
  ): Promise<{ forkedSessionId: string }>;
  /** Runtime start failed synchronously after bundle commit: record only child failure and keep the parent fork ACK accepted. */
  recordForkStartFailure?(
    sessionId: string,
    envelope: CommandEnvelope,
    error: unknown,
  ): Promise<void>;
}
