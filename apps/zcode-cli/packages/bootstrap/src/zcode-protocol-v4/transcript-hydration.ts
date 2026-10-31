/* eslint-disable max-lines -- Keeps the existing transcript → event recovery owner; this change only passes an input snapshot through instead of splitting the recovery state machine. */
// Transcript → SessionEvent synthesis ("reduce(transcript) ≡ reduce(events)").
//
// Motivation: the v4 projection is event-sourced, but some historical mutations
// (conversation-only forks copying messages without events, rewind truncation touching only the
// message store) leave the session's event log unable to cover the visible transcript. Cold
// subscription hydration cannot rebuild that history from the event log ("fork-child history").
//
// This module reverse-synthesizes the message store's transcript into a SessionEvent sequence the
// reducer can consume — reusing the whole ProductProjection reduction logic instead of writing a
// second, parallel message→row reducer. Synthesized events serve "view rebuild": only the minimal
// sequence "reduction-equivalent" to the real event stream is produced.
// v4 cold resume can only replay events ProductProjection knows; if transcript
// tool/reasoning/subagent/compact parts are not reverse-synthesized, the historical visible run
// state disappears from the snapshot after a restart.
import type {
  AssistantErrorInfo,
  BackgroundResultOriginMeta,
  CompactTimelineStatus as CompactTimelineStatusValue,
  MessagePart,
  MessageWithParts,
  ModelSelection,
  TurnFileChangeSummary,
  TurnInputIntentMetadata,
} from "@zcode/contracts";
import { INTERRUPT_MARKER_SOURCE, joinTaskNotificationBatch } from "@zcode/core";
import { isHighspeedProviderId } from "@zcode/shared";
import type { EventId, SessionEvent, SessionId, TraceId, TurnId } from "@zcode/contracts";
import {
  CompactTimelineStatus,
  CompactTrigger,
  CoreErrorType,
  createSessionId,
  ModelErrorCode,
  parseCompletedToolPartMetadata,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
} from "@zcode/contracts";
import {
  getConversationModelOnlyTurnTriggerSource,
  getConversationMessageProjectionPolicy,
  highspeedMessageMetaSchema,
  isConversationRealUserTurnStarter,
} from "@zcode/shared";
import {
  conversationInputIntentSchema,
  errorAttributionSchema,
  subagentResultMetaSchema,
  workflowBlockedMetaSchema,
  workflowLaunchMetaSchema,
  workflowNotificationMetaSchema,
  type ErrorAttribution,
  type WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import { ProductProjection } from "./product-projection.js";
import { HYDRATION_TRACE_ID } from "./projection-state.js";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE = "Model request was cancelled.";
const LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE = "ZCode Protocol session stopped";
const PERSISTED_CANCELLATION_CODES = new Set<string>([
  CoreErrorType.TurnCancelled,
  ModelErrorCode.ModelRequestCancelled,
  "MODEL_REQUEST_CANCELLED",
  "ABORT_ERR",
]);

type PushEvent = (
  type: SessionEventType,
  payload: unknown,
  turnId?: string,
  sourceTimestampMs?: number,
) => void;

type TurnResultForHydration = "success" | "cancelled" | "error_during_execution";

interface AssistantSynthesisState {
  toolCallCount: number;
  resultType: TurnResultForHydration;
}

interface TranscriptFootprint {
  userTurnCount: number;
  assistantTexts: string[];
  reasoningTexts: string[];
  toolCallIds: string[];
  compactMarkerCount: number;
  subagentCount: number;
  forkTimelineCount: number;
  // 16-timeline-authority-plan P1: the conservation check used to be blind to goal verify /
  // model change (footprint did not count them → event logs missing these markers were misjudged
  // as already covered).
  goalVerificationCount: number;
  modelChangeCount: number;
}

interface ParsedSubagentOutput {
  agentId?: string;
  agentType?: string;
  childSessionId?: string;
  description?: string;
  parentToolCallId?: string;
  prompt?: string;
  summaryText?: string;
}

interface SynthesizeOptions {
  sessionId: string;
  /**
   * Authoritative context window of the model actually selected for this session.
   * The transcript persists only token usage, not model capabilities; it must be injected by the
   * current workspace registry.
   */
  contextWindow?: number;
  /** Base timestamp for synthesis (deterministic: no Date.now; the caller passes the first message time as a fallback). */
  baseTimestampMs?: number;
  /**
   * Goal verify facts from the legacy session_entry source:
   * anchored ones land after the assistant named by anchorAssistantMessageId,
   * unanchored/mismatched ones land at the end of the known timeline; deduplicated against
   * timeline parts by key.
   */
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  /**
   * Per-turn summary rebuilt from the workspace checkpoint artifact keyed by the real user messageId.
   * The transcript lacks this field; a synthetic ModelComplete must be injected explicitly to
   * keep live/cold equivalence.
   */
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
}

function isRealUserTurnStarter(message: MessageWithParts): boolean {
  return isConversationRealUserTurnStarter(message);
}

/**
 * The launch-turn message of a workflow started directly by the hub. The core persists
 * `source: "workflow_launch"` + `metadata.workflowLaunch` (the authoritative source for cold
 * resume). It is synthetic yet semantically a visible message of a real user action; the shared
 * projection policy classifies synthetic users as hiddenSynthetic, so
 * `isConversationRealUserTurnStarter` does not recognize it. Guided by this predicate, the cold
 * path explicitly rebuilds — before the real-user branch — a controlOnly launch turn shaped like
 * the live projection's (TurnStarted{inputSource, workflowLaunch, executionKind} +
 * TurnComplete) instead of skipping it as a hidden synthetic. Malformed / absent metadata
 * returns null (falling back to the existing skip semantics).
 */
function workflowLaunchOfMessage(message: MessageWithParts): WorkflowLaunchMeta | null {
  if (message.info.role !== "user") return null;
  if (message.info.source !== "workflow_launch") return null;
  const metadata = message.info.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = workflowLaunchMetaSchema.safeParse(
    (metadata as Record<string, unknown>).workflowLaunch,
  );
  return parsed.success ? parsed.data : null;
}

/** Hidden reminder record written by core when it stops this turn (`interrupt-marker.ts`). */
function isInterruptMarkerMessage(message: MessageWithParts): boolean {
  const semantics = message.info.semantics;
  return semantics?.kind === "system_reminder" && semantics.source === INTERRUPT_MARKER_SOURCE;
}

function isProviderContextOnlyAssistant(message: MessageWithParts): boolean {
  return (
    message.info.role === "assistant" &&
    getConversationMessageProjectionPolicy(message) === "providerContextOnly"
  );
}

function textPartsOfMessage(parts: readonly MessagePart[]): string[] {
  return parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text" && part.ignored !== true,
    )
    .map((part) => part.text);
}

function textOfMessage(parts: readonly MessagePart[]): string {
  return textPartsOfMessage(parts).join("");
}

// Fix reason: idle batches store each notification as its own text part; joining with "" glued
// adjacent notifications together, unlike the live turn input. Use the same join function as
// live; old versions with a single part are unaffected.
function backgroundWakeInputOfMessage(parts: readonly MessagePart[]): string {
  return joinTaskNotificationBatch(textPartsOfMessage(parts));
}

function finiteTimeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function messageCreatedAtMs(message: MessageWithParts): number | undefined {
  return finiteTimeMs(message.info.time.created);
}

function intervalEndOrStartMs(time: { start: number } & Partial<{ end: number }>) {
  return finiteTimeMs(time.end) ?? finiteTimeMs(time.start);
}

function partEndAtMs(part: MessagePart): number | undefined {
  if (part.type === "reasoning") {
    return finiteTimeMs(part.time?.end) ?? finiteTimeMs(part.time?.start);
  }
  if (part.type === "tool" && "time" in part.state) {
    return intervalEndOrStartMs(part.state.time);
  }
  return undefined;
}

function messageEndAtMs(message: MessageWithParts): number | undefined {
  const time = message.info.time;
  // Cold resume handles user/assistant messages alike; users only have created while only
  // assistants may have completed, so narrow by field presence before taking the end time.
  let end =
    ("completed" in time ? finiteTimeMs(time.completed) : undefined) ?? finiteTimeMs(time.created);
  for (const part of message.parts) {
    const partEnd = partEndAtMs(part);
    if (partEnd !== undefined) {
      end = end === undefined ? partEnd : Math.max(end, partEnd);
    }
  }
  return end;
}

function normalizeTurnResult(
  current: TurnResultForHydration,
  next: TurnResultForHydration,
): TurnResultForHydration {
  if (current === "cancelled" || next === "cancelled") {
    return "cancelled";
  }
  if (current === "error_during_execution" || next === "error_during_execution") {
    return "error_during_execution";
  }
  return "success";
}

function assistantErrorData(error: AssistantErrorInfo): Record<string, unknown> | undefined {
  return error.data && typeof error.data === "object" && !Array.isArray(error.data)
    ? error.data
    : undefined;
}

function persistedErrorAttribution(
  data: Record<string, unknown> | undefined,
): ErrorAttribution | undefined {
  const parsed = errorAttributionSchema.safeParse(data?.attribution);
  return parsed.success ? parsed.data : undefined;
}

function isPersistedAssistantCancellation(error: AssistantErrorInfo): boolean {
  const data = assistantErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (
    data?.turnResult === "cancelled" ||
    data?.resultType === "cancelled" ||
    (code !== undefined && PERSISTED_CANCELLATION_CODES.has(code)) ||
    error.name === "AbortError"
  ) {
    return true;
  }

  if (
    code === undefined &&
    error.name === "Error" &&
    data?.message === LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE
  ) {
    // Old session/stop used a plain Error as AbortSignal.reason, and the transcript did not
    // persist a cancelled result; a cold resume recognizing only AbortError would re-synthesize
    // the user's stop into a TurnError and an error banner.
    return true;
  }

  // Old transcripts' AiSdkModelAdapterError did not persist a model error code; recovery can
  // only match the standard name/message pair ZCode itself generated — do not generalize to
  // matching provider wording.
  return (
    code === undefined &&
    error.name === "AiSdkModelAdapterError" &&
    data?.message === LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE
  );
}

/**
 * Stream recovery persists a discarded half-finished assistant as a message with an error, then
 * resends from the anchor and completes normally; the live projection settles it as an
 * interrupted row without a TurnError. The old cold resume treated any assistant with an error
 * as this turn's failure, popping a spurious "Partial assistant output was discarded" error
 * banner after reopening the session. This marker only serves compaction/fork boundary
 * isolation and must stay transparent to the turn result.
 */
function isPersistedStreamRecoveryDiscard(error: AssistantErrorInfo): boolean {
  return error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME;
}

function stableToolSchedule(toolCallId: string) {
  return {
    executionOrder: [toolCallId],
    parallelGroups: [[toolCallId]],
  };
}

function compactEventType(status: CompactTimelineStatusValue): SessionEventType {
  if (status === CompactTimelineStatus.Started || status === CompactTimelineStatus.Retrying) {
    return SessionEventType.CompactStarted;
  }
  if (status === CompactTimelineStatus.Completed || status === CompactTimelineStatus.Skipped) {
    return SessionEventType.CompactCompleted;
  }
  return SessionEventType.CompactFailed;
}

function normalizeCompactTimelineStatus(
  status: string | undefined,
): CompactTimelineStatusValue | null {
  switch (status) {
    case CompactTimelineStatus.Started:
    case CompactTimelineStatus.Retrying:
    case CompactTimelineStatus.Skipped:
    case CompactTimelineStatus.Completed:
    case CompactTimelineStatus.Failed:
    case CompactTimelineStatus.Interrupted:
      return status;
    case "cancelled":
      return CompactTimelineStatus.Interrupted;
    default:
      return null;
  }
}

function compactTriggerOfPart(part: Extract<MessagePart, { type: "compaction" }>) {
  return part.trigger ?? (part.auto ? CompactTrigger.Auto : CompactTrigger.Manual);
}

function compactPayloadFromTimelinePart(part: Extract<MessagePart, { type: "timeline" }>) {
  if (part.timelineType !== "context_compaction") return null;
  const status = normalizeCompactTimelineStatus(part.status);
  if (!status) return null;
  return {
    status,
    payload: {
      operationId: part.operationId,
      messageId: String(part.messageID),
      partId: part.id,
      status,
      trigger: part.trigger,
      display: part.display,
      ...(part.sourceCommandId ? { sourceCommandId: part.sourceCommandId } : {}),
      ...(part.anchorMessageId ? { anchorMessageId: part.anchorMessageId } : {}),
      ...(part.anchorTurnId ? { anchorTurnId: part.anchorTurnId } : {}),
      ...(part.phase ? { phase: part.phase } : {}),
      ...(part.compactReason ? { compactReason: part.compactReason } : {}),
      ...(part.reason ? { reason: part.reason } : {}),
      ...(part.boundaryId ? { boundaryId: part.boundaryId } : {}),
      ...(part.summaryMessageId ? { summaryMessageId: part.summaryMessageId } : {}),
      ...(part.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: part.preCompactTokenCount }
        : {}),
      ...(part.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: part.postCompactTokenCount }
        : {}),
      ...(part.truePostCompactTokenCount !== undefined
        ? { truePostCompactTokenCount: part.truePostCompactTokenCount }
        : {}),
      ...(part.attempt !== undefined ? { attempt: part.attempt } : {}),
      ...(part.maxAttempts !== undefined ? { maxAttempts: part.maxAttempts } : {}),
      ...(part.time?.start !== undefined ? { startedAt: part.time.start } : {}),
      ...(part.time?.end !== undefined ? { endedAt: part.time.end } : {}),
    },
  };
}

function compactPayloadFromLegacyCompactionPart(
  part: Extract<MessagePart, { type: "compaction" }>,
) {
  const status = normalizeCompactTimelineStatus(part.timelineStatus);
  if (!status) return null;
  return {
    status,
    payload: {
      operationId: part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      messageId: String(part.messageID),
      partId: part.id,
      status,
      trigger: compactTriggerOfPart(part),
      display: part.timelineDisplay ?? "separator",
      ...(part.phase ? { phase: part.phase } : {}),
      ...(part.compactReason ? { compactReason: part.compactReason } : {}),
      ...(part.reason ? { reason: part.reason } : {}),
      ...(part.boundaryId ? { boundaryId: part.boundaryId } : {}),
      ...(part.summaryMessageId ? { summaryMessageId: part.summaryMessageId } : {}),
      ...(part.tail_start_id ? { tailStartMessageId: part.tail_start_id } : {}),
      ...(part.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: part.preCompactTokenCount }
        : {}),
      ...(part.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: part.postCompactTokenCount }
        : {}),
      ...(part.truePostCompactTokenCount !== undefined
        ? { truePostCompactTokenCount: part.truePostCompactTokenCount }
        : {}),
      ...(part.attempt !== undefined ? { attempt: part.attempt } : {}),
      ...(part.maxAttempts !== undefined ? { maxAttempts: part.maxAttempts } : {}),
      ...(part.time?.start !== undefined ? { startedAt: part.time.start } : {}),
      ...(part.time?.end !== undefined ? { endedAt: part.time.end } : {}),
    },
  };
}

function parseJsonObject(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(
  source: Record<string, unknown> | undefined | null,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inputIntentOfMessage(message: MessageWithParts): TurnInputIntentMetadata | undefined {
  const persistedHighspeed = highspeedMessageMetaSchema.safeParse(message.info.metadata?.highspeed);
  const fullIntent = conversationInputIntentSchema.safeParse(
    message.info.metadata?.conversationInputIntent,
  );
  if (fullIntent.success) {
    const value = fullIntent.data;
    return {
      sourceCommandId: value.sourceCommandId,
      queueItemId: value.queueItemId,
      clientId: value.clientId,
      kind: value.kind,
      // The visible text is a display fact; the goal's canonical objective can only come from the
      // persisted intent.text — never re-parse case/keywords out of `/goal replace ...` wording.
      text: value.text,
      genUiContext: value.genUiContext,
      ...(value.modelSelection ? { modelSelection: value.modelSelection } : {}),
      ...(value.mode ? { mode: value.mode } : {}),
      ...(value.planEnabled !== undefined ? { planEnabled: value.planEnabled } : {}),
      admissionSeq: value.order.admissionSeq,
      admittedAt: value.admittedAt,
      requestedDelivery: value.delivery.requested,
      admittedDelivery: value.delivery.admitted,
      ...(value.order.queuePosition !== undefined
        ? { queuePosition: value.order.queuePosition }
        : {}),
      ...(value.delivery.fallbackReasonCode
        ? { fallbackReasonCode: value.delivery.fallbackReasonCode }
        : {}),
      ...(value.attachments.length > 0 ? { attachmentRefs: value.attachments } : {}),
      ...(value.highspeed
        ? { highspeed: value.highspeed }
        : persistedHighspeed.success
          ? { highspeed: persistedHighspeed.data }
          : {}),
      ...(value.inputOrigin ? { inputOrigin: value.inputOrigin } : {}),
      ...(value.conversationQuotes ? { conversationQuotes: value.conversationQuotes } : {}),
      ...(value.botGroupSource ? { botGroupSource: value.botGroupSource } : {}),
      ...(value.provenance ? { provenance: value.provenance } : {}),
      ...(value.source ? { source: value.source } : {}),
    };
  }

  // Compatibility with transcripts that previously persisted only the metadata seed; new writes always go through the full facts above.
  const value = message.info.metadata?.inputIntent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const intent = value as Record<string, unknown>;
  if (
    typeof intent.sourceCommandId !== "string" ||
    typeof intent.queueItemId !== "string" ||
    typeof intent.clientId !== "string" ||
    (intent.kind !== "sendText" && intent.kind !== "sendGoalCommand") ||
    typeof intent.admissionSeq !== "number" ||
    typeof intent.admittedAt !== "number" ||
    (intent.requestedDelivery !== "auto" &&
      intent.requestedDelivery !== "startNow" &&
      intent.requestedDelivery !== "queue" &&
      intent.requestedDelivery !== "guide") ||
    (intent.admittedDelivery !== "startNow" &&
      intent.admittedDelivery !== "queue" &&
      intent.admittedDelivery !== "guide")
  ) {
    return undefined;
  }
  return {
    ...(value as unknown as TurnInputIntentMetadata),
    ...(persistedHighspeed.success ? { highspeed: persistedHighspeed.data } : {}),
  };
}

function executionKindOfMessage(message: MessageWithParts): "agent" | "controlOnly" | undefined {
  const value = message.info.metadata?.executionKind;
  return value === "agent" || value === "controlOnly" ? value : undefined;
}

/**
 * Start of engine-appended text: on the hot path it lives on TurnStarted,
 * on the cold path the same field is read back from user-message metadata. Only non-negative
 * integers count — any other shape is treated as absent (prefer showing more).
 */
function epilogueStartOfMessage(message: MessageWithParts): number | undefined {
  const value = message.info.metadata?.epilogueStart;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Display-only pin bookmark persisted on user/assistant message metadata; cold hydration replays it
 * as a RowPinnedUpdated event after the row-creating event so live and cold projections agree.
 */
function pinnedAtOfMessage(message: MessageWithParts): number | undefined {
  const value = message.info.metadata?.pinnedAt;
  return typeof value === "number" ? value : undefined;
}

function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const chunks = value
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0);
  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

function subagentInfoFromToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
): ParsedSubagentOutput | null {
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const input =
    part.state.input && typeof part.state.input === "object"
      ? (part.state.input as Record<string, unknown>)
      : {};
  const output = part.state.status === "completed" ? parseJsonObject(part.state.output) : null;
  const metadata = part.metadata && typeof part.metadata === "object" ? part.metadata : {};
  const explicitAgentId =
    stringField(output, "agentId") ??
    stringField(metadata, "agentId") ??
    agentIdFromToolOutput(part.state.status === "completed" ? part.state.output : undefined);
  const agentId = explicitAgentId ?? part.callID;
  return {
    agentId,
    agentType:
      stringField(output, "agentType") ??
      stringField(metadata, "agentType") ??
      stringField(input, "agent") ??
      stringField(input, "agentType") ??
      stringField(input, "subagent_type") ??
      "subagent",
    childSessionId:
      stringField(output, "childSessionId") ??
      stringField(metadata, "childSessionId") ??
      // A background Agent's persisted tool output is human-readable text, not JSON; cold merge
      // suppresses duplicate durable spawned events, and without recovering the child session
      // from a stable agentId row, the sidebar entry would be lost.
      (explicitAgentId ? createSessionId(`subagent_${agentId}`) : undefined),
    description:
      stringField(output, "description") ??
      stringField(input, "description") ??
      stringField(metadata, "description"),
    parentToolCallId: part.callID,
    prompt: stringField(output, "prompt") ?? stringField(input, "prompt"),
    summaryText:
      contentBlocksToText(output?.content) ??
      stringField(output, "result") ??
      stringField(output, "summary") ??
      stringField(input, "description") ??
      stringField(input, "prompt"),
  };
}

function agentIdFromToolOutput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /(?:^|\r?\n)agentId:\s*([^\s(]+)/u.exec(value)?.[1];
}

function subagentStatusFromToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
): "completed" | "failed" | "cancelled" {
  switch (part.state.status) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default:
      return "cancelled";
  }
}

/**
 * Attachment rendering: FilePart → TurnStarted attachment display meta (TurnAttachmentMeta).
 * Historical attachments of cold subscriptions/fork-children are reverse-synthesized from the
 * transcript — through the same projection entry as live events (buildUserInputRow), keeping row
 * content identical across the cold/hot paths.
 */
function attachmentMetasOfMessage(
  parts: readonly MessagePart[],
): Array<{ fileName: string; mime: string; bytes: number; ref?: string }> {
  const fileParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "file" }> => part.type === "file",
  );
  return fileParts.map((part, index) => {
    const urlIsStableRef = part.url.length > 0 && !part.url.startsWith("data:");
    const basenameFromUrl = urlIsStableRef ? (part.url.split(/[\\/]/).pop() ?? "") : "";
    return {
      fileName: part.filename ?? (basenameFromUrl || `attachment-${index + 1}`),
      mime: part.mime,
      bytes: part.metadata?.sizeBytes ?? 0,
      ...(urlIsStableRef ? { ref: part.url } : {}),
    };
  });
}

function forkContextOfMessage(message: MessageWithParts):
  | {
      parentSessionId: string;
      restoredFileCount?: number;
      targetCheckpointId?: string;
      targetMessageId?: string;
    }
  | undefined {
  for (const part of message.parts) {
    if (part.type === "timeline" && part.timelineType === "session_fork") {
      return {
        parentSessionId: String(part.parentSessionId),
        ...(typeof part.restoredFileCount === "number"
          ? { restoredFileCount: part.restoredFileCount }
          : {}),
        ...(part.targetCheckpointId ? { targetCheckpointId: part.targetCheckpointId } : {}),
        ...(part.targetMessageId ? { targetMessageId: String(part.targetMessageId) } : {}),
      };
    }
    const metadata = part.type === "text" ? part.metadata : undefined;
    const context = forkContextFromMetadata(metadata);
    if (context) return context;
  }
  return message.info.role === "user" ? forkContextFromMetadata(message.info.metadata) : undefined;
}

function forkContextFromMetadata(metadata: Record<string, unknown> | undefined):
  | {
      parentSessionId: string;
      restoredFileCount?: number;
      targetCheckpointId?: string;
      targetMessageId?: string;
    }
  | undefined {
  const forkContext = metadata?.forkContext;
  if (typeof forkContext !== "object" || forkContext === null || Array.isArray(forkContext)) {
    return undefined;
  }
  const context = forkContext as Record<string, unknown>;
  if (context.kind !== "session_fork" || typeof context.parentSessionId !== "string") {
    return undefined;
  }
  return {
    parentSessionId: context.parentSessionId,
    ...(typeof context.restoredFileCount === "number"
      ? { restoredFileCount: context.restoredFileCount }
      : {}),
    ...(typeof context.targetCheckpointId === "string"
      ? { targetCheckpointId: context.targetCheckpointId }
      : {}),
    ...(typeof context.targetMessageId === "string"
      ? { targetMessageId: context.targetMessageId }
      : {}),
  };
}

function isForkTimelineMessage(message: MessageWithParts): boolean {
  return (
    getConversationMessageProjectionPolicy(message) === "timelineOnly" &&
    forkContextOfMessage(message) !== undefined
  );
}

function synthesizeTextPart(
  part: Extract<MessagePart, { type: "text" }>,
  assistantMessageId: string,
  assistantMessageCreatedAtMs: number | undefined,
  push: PushEvent,
  turnId: string,
): void {
  if (part.ignored === true || part.text.length === 0) return;
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "text_start",
      delta: "",
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
    // Cold synthesized events cannot uniformly use "first message time + seq": after a refresh
    // the assistant action bar would show different historical replies at nearly the same time.
    // Text row creation must keep the owning transcript assistant message's real creation time;
    // event order is still decided by seq.
    assistantMessageCreatedAtMs,
  );
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "text_delta",
      delta: part.text,
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    { kind: "text_end", delta: "", done: false, partId: part.id },
    turnId,
  );
}

function synthesizeReasoningPart(
  part: Extract<MessagePart, { type: "reasoning" }>,
  assistantMessageId: string,
  push: PushEvent,
  turnId: string,
): void {
  if (part.text.length === 0) return;
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "reasoning_start",
      delta: "",
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "reasoning_delta",
      delta: part.text,
      done: false,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    { kind: "reasoning_end", delta: "", done: false, partId: part.id },
    turnId,
  );
}

function synthesizeSubagentLifecycle(
  info: ParsedSubagentOutput,
  status: "completed" | "failed" | "cancelled",
  push: PushEvent,
  turnId: string,
  // The persisted Agent tool part's times; without them the synthetic events sit 1 ms apart and a
  // reloaded row shows "1s" instead of its real duration.
  time?: { start?: number; end?: number },
): void {
  const agentId = info.agentId ?? `subagent-${turnId}`;
  push(
    SessionEventType.SubagentSpawned,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description ?? info.summaryText ?? info.prompt ?? agentId,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      status: "running",
    },
    turnId,
    time?.start,
  );
  push(
    SessionEventType.SubagentStopped,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      summaryText: info.summaryText,
      status,
    },
    turnId,
    // A part persisted mid-run has a start but no end; never stop before the row started.
    time?.end ?? time?.start,
  );
}

function synthesizeToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
  assistantMessageId: string,
  push: PushEvent,
  turnId: string,
): AssistantSynthesisState {
  if (shouldHideInvalidToolCallFromProduct(part.tool, part.metadata)) {
    // Footprint filtering only decides whether events need backfilling; it cannot block actual
    // synthesis. Skip recovered parts carrying raw empty-name metadata at the event source here,
    // so cold hydration does not re-materialize tool rows.
    return { resultType: "success", toolCallCount: 0 };
  }
  const toolCallId = part.callID;
  const persistedMetadata = parseCompletedToolPartMetadata(
    "metadata" in part.state ? part.state.metadata : part.metadata,
  );
  push(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId,
      assistantMessageId,
      toolName: part.tool,
      input: part.state.input,
      ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
      schedule: stableToolSchedule(toolCallId),
    },
    turnId,
  );

  const started =
    part.state.status === "running" ||
    part.state.status === "completed" ||
    part.state.status === "error";
  if (started) {
    push(
      SessionEventType.ToolCallStarted,
      {
        toolCallId,
        toolName: part.tool,
        ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        startedAt: new Date(
          "time" in part.state && typeof part.state.time.start === "number"
            ? part.state.time.start
            : 0,
        ),
      },
      turnId,
    );
  }

  // (2026-09-12): leftover metadata.widgetState in historical transcripts no longer synthesizes
  // events; cold resume ignores it outright (widgetState lives only in renderer memory).

  const subagentInfo = subagentInfoFromToolPart(part);
  if (subagentInfo && started) {
    synthesizeSubagentLifecycle(
      subagentInfo,
      subagentStatusFromToolPart(part),
      push,
      turnId,
      "time" in part.state ? part.state.time : undefined,
    );
  }

  if (part.state.status === "completed") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: true,
          content: part.state.output,
          ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  if (part.state.status === "error") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: false,
          content: part.state.error,
          error: {
            type: "fault.runtime.toolFailed",
            message: part.state.error,
          },
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  // After a CLI restart there is no proof a historical pending/running tool is still running, so
  // the active work / stop buttons must not come back to life; let TurnComplete(cancelled)
  // uniformly settle everything into read-only history.
  return { resultType: "cancelled", toolCallCount: 1 };
}

function synthesizeCompactPart(
  part: MessagePart,
  emittedCompactOperations: Set<string>,
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>,
  push: PushEvent,
  turnId: string,
): boolean {
  let compact =
    part.type === "timeline"
      ? compactPayloadFromTimelinePart(part)
      : part.type === "compaction"
        ? compactPayloadFromLegacyCompactionPart(part)
        : null;
  if (!compact) return false;
  const operationId = String(compact.payload.operationId);
  const durablePart = durableCompactPartsByOperation.get(operationId);
  if (durablePart) {
    // A same-operation timeline part usually precedes the durable compaction part.
    // The old "first come, first served" lost tail_start_id; prefer the durable payload that
    // carries the coverage boundary.
    const durablePayload = compactPayloadFromLegacyCompactionPart(durablePart);
    compact = durablePayload ?? {
      ...compact,
      payload: {
        ...compact.payload,
        ...(durablePart.tail_start_id ? { tailStartMessageId: durablePart.tail_start_id } : {}),
        ...(durablePart.boundaryId ? { boundaryId: durablePart.boundaryId } : {}),
        ...(durablePart.summaryMessageId ? { summaryMessageId: durablePart.summaryMessageId } : {}),
      },
    };
  }
  if (emittedCompactOperations.has(operationId)) return true;
  emittedCompactOperations.add(operationId);
  push(compactEventType(compact.status), compact.payload, turnId);
  return true;
}

// ── goal verification timeline part──
// Persistence contract (core events.ts persistDurableSessionEvent): on every verifier lifecycle
// change the same timeline part is upserted, identified by targetId_goalIteration, with status
// being the final lifecycle state. Reverse-synthesize it into a started(+terminal) event pair,
// reusing the projection's existing goalVerify marker state machine.
// The old hydration recognized only context_compaction, so goal_verification parts fell into an
// unconsumed branch — the goalVerify marker vanished on every cold resume.
function goalVerificationKeyOfPart(part: Extract<MessagePart, { type: "timeline" }>): string {
  if (part.timelineType !== "goal_verification") return String(part.id);
  return part.goalIteration !== undefined
    ? `${part.targetId}_${part.goalIteration}`
    : part.verificationId;
}

// Cold resume cannot prove a historical verifier is still running (same precedent as pending
// tools settling to cancelled): started/unknown states settle to cancelled; completed/failed_closed
// are restored verbatim.
function goalVerificationTerminalStatus(
  status: string | undefined,
): "completed" | "failed_closed" | "cancelled" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "failed_closed":
      return "failed_closed";
    default:
      return "cancelled";
  }
}

/** Normalized shape of a goal verify fact: shared by timeline parts (new contract) and session_entry (legacy main body). */
interface GoalVerificationFact {
  key: string;
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  anchorAssistantMessageId?: string;
  anchorTurnId?: string;
  status?: string;
  verification?: unknown;
}

function pushGoalVerificationFact(
  fact: GoalVerificationFact,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string | undefined,
): boolean {
  if (emittedGoalVerifications.has(fact.key)) return false;
  emittedGoalVerifications.add(fact.key);
  const base = {
    targetId: fact.targetId,
    verificationId: fact.verificationId,
    ...(fact.goalIteration !== undefined ? { goalIteration: fact.goalIteration } : {}),
    ...(fact.anchorAssistantMessageId
      ? { anchorAssistantMessageId: fact.anchorAssistantMessageId }
      : {}),
    ...(fact.anchorTurnId ? { anchorTurnId: fact.anchorTurnId } : {}),
  };
  push(SessionEventType.TargetCompletionVerification, { ...base, status: "started" }, turnId);
  push(
    SessionEventType.TargetCompletionVerification,
    {
      ...base,
      status: goalVerificationTerminalStatus(fact.status),
      ...(fact.verification ? { verification: fact.verification } : {}),
    },
    turnId,
  );
  return true;
}

function goalVerificationFactOfPart(
  part: Extract<MessagePart, { type: "timeline" }>,
): GoalVerificationFact | null {
  if (part.timelineType !== "goal_verification") return null;
  return {
    key: goalVerificationKeyOfPart(part),
    targetId: part.targetId,
    verificationId: part.verificationId,
    ...(part.goalIteration !== undefined ? { goalIteration: part.goalIteration } : {}),
    ...(part.anchorMessageId ? { anchorAssistantMessageId: String(part.anchorMessageId) } : {}),
    ...(part.anchorTurnId ? { anchorTurnId: String(part.anchorTurnId) } : {}),
    ...(part.status ? { status: part.status } : {}),
    ...(part.verification ? { verification: part.verification } : {}),
  };
}

function synthesizeGoalVerificationPart(
  part: MessagePart,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string,
): boolean {
  if (part.type !== "timeline") return false;
  const fact = goalVerificationFactOfPart(part);
  if (!fact) return false;
  pushGoalVerificationFact(fact, emittedGoalVerifications, push, turnId);
  return true;
}

// ── session_entry legacy source ──
// Historically goal verify was persisted mostly in session_entry (locally observed: 1,402 rows
// vs only 10 timeline parts); entry.data keeps the original event payload. The read side
// deduplicates across sources by targetId_goalIteration: when a timeline part and an entry
// express the same fact, emit it once (first come, first served, with identical anchor
// semantics).
export interface HydratedGoalVerificationEntry {
  payload: {
    targetId: string;
    status?: string;
    verificationId: string;
    verification?: unknown;
    goalIteration?: number;
    anchorAssistantMessageId?: string;
    anchorTurnId?: string;
  };
  sequenceNumber?: number;
  timeCreated: number;
}

/** SessionEntryInfo (target_completion_verification) → normalized entry; invalid data is silently dropped. */
export function goalVerificationEntriesFromSessionEntries(
  entries: readonly { data: unknown; time: { created: number } }[],
): HydratedGoalVerificationEntry[] {
  const parsed: HydratedGoalVerificationEntry[] = [];
  for (const entry of entries) {
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : null;
    const payload =
      data?.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
        ? (data.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;
    const targetId = typeof payload.targetId === "string" ? payload.targetId : null;
    const verificationId =
      typeof payload.verificationId === "string" ? payload.verificationId : null;
    if (!targetId || !verificationId) continue;
    parsed.push({
      payload: {
        targetId,
        verificationId,
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
        ...(typeof payload.goalIteration === "number"
          ? { goalIteration: payload.goalIteration }
          : {}),
        ...(typeof payload.anchorAssistantMessageId === "string"
          ? { anchorAssistantMessageId: payload.anchorAssistantMessageId }
          : {}),
        ...(typeof payload.anchorTurnId === "string" ? { anchorTurnId: payload.anchorTurnId } : {}),
        ...(payload.verification !== undefined ? { verification: payload.verification } : {}),
      },
      ...(typeof data?.sequenceNumber === "number" ? { sequenceNumber: data.sequenceNumber } : {}),
      timeCreated: entry.time.created,
    });
  }
  // Multiple entries per key (one started, one terminal): take the latest terminal state in event order.
  parsed.sort(
    (left, right) =>
      (left.sequenceNumber ?? left.timeCreated) - (right.sequenceNumber ?? right.timeCreated),
  );
  return parsed;
}

function goalVerificationFactOfEntry(entry: HydratedGoalVerificationEntry): GoalVerificationFact {
  const payload = entry.payload;
  return {
    key:
      payload.goalIteration !== undefined
        ? `${payload.targetId}_${payload.goalIteration}`
        : payload.verificationId,
    targetId: payload.targetId,
    verificationId: payload.verificationId,
    ...(payload.goalIteration !== undefined ? { goalIteration: payload.goalIteration } : {}),
    ...(payload.anchorAssistantMessageId
      ? { anchorAssistantMessageId: payload.anchorAssistantMessageId }
      : {}),
    ...(payload.anchorTurnId ? { anchorTurnId: payload.anchorTurnId } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.verification !== undefined ? { verification: payload.verification } : {}),
  };
}

/** Merge the per-lifecycle entries of one key into a single fact: the terminal state overrides started. */
function mergeGoalVerificationEntryFacts(
  entries: readonly HydratedGoalVerificationEntry[],
): GoalVerificationFact[] {
  const byKey = new Map<string, GoalVerificationFact>();
  for (const entry of entries) {
    const fact = goalVerificationFactOfEntry(entry);
    const existing = byKey.get(fact.key);
    if (!existing) {
      byKey.set(fact.key, fact);
      continue;
    }
    // Entries are already sorted in event order: a later lifecycle state (terminal) overrides; the anchor takes the first value seen.
    byKey.set(fact.key, {
      ...existing,
      ...fact,
      anchorAssistantMessageId: existing.anchorAssistantMessageId ?? fact.anchorAssistantMessageId,
      anchorTurnId: existing.anchorTurnId ?? fact.anchorTurnId,
      verification: fact.verification ?? existing.verification,
    });
  }
  return [...byKey.values()];
}

// ── Turn model-selection facts ──
// The modelChange marker is generated by the projection at TurnStarted by comparing lastTurnModel
// with config; cold resume has no ModelSelected events, so it is rebuilt here from each turn's
// persisted selection facts. Source priority: the user prompt's model snapshot (always present,
// consistent with config at submission time); preface turns (no user) take the assistant message
// fact. The model on a synthesized timeline host message (semantics.kind=timeline_event) is a
// host-compatibility placeholder, not this turn's fact.
interface HydratedTimelineModel {
  modelSelection: ModelSelection;
  previousModelSelection?: ModelSelection | null;
}

function hydratedModelKey(modelSelection: ModelSelection): string {
  return `${modelSelection.providerId}\u0000${modelSelection.modelId}\u0000${modelSelection.options?.reasoningLevel ?? ""}`;
}

function sessionModelSelectionOfHydratedMessage(
  modelSelection: ModelSelection,
): ModelSelection | null {
  // Bug cause: a highspeed card selection is a single-turn execution Selection
  // (selectionScope=execution) kept on the message to record the real execution model; cold resume
  // once mistook it for the session selection and generated a spurious "highspeed → original
  // model" switch notice after restart. The live path's execution scope never emits ModelSelected;
  // cold must match that semantics.
  return isHighspeedProviderId(modelSelection.providerId) ? null : modelSelection;
}

function turnModelSelectionOfUserMessage(message: MessageWithParts): ModelSelection | null {
  if (message.info.role !== "user") return null;
  const modelSelection = message.info.modelSelection;
  return modelSelection ? sessionModelSelectionOfHydratedMessage(modelSelection) : null;
}

function assistantModelSelectionOf(message: MessageWithParts): ModelSelection | null {
  if (message.info.role !== "assistant") return null;
  if (message.info.semantics?.kind === "timeline_event") return null;
  if (!message.info.providerId || !message.info.modelId) return null;
  return sessionModelSelectionOfHydratedMessage({
    providerId: String(message.info.providerId),
    modelId: String(message.info.modelId),
    ...(message.info.reasoningLevel
      ? { options: { reasoningLevel: message.info.reasoningLevel } }
      : {}),
  });
}

function modelChangeToModelOf(message: MessageWithParts): HydratedTimelineModel | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]!;
    if (part.type !== "timeline" || part.timelineType !== "model_change") continue;
    if (!part.toModel) return null;
    return {
      modelSelection: {
        providerId: part.toModel.providerId,
        modelId: part.toModel.modelId,
        ...(part.toModel.options ? { options: part.toModel.options } : {}),
      },
      previousModelSelection: part.fromModel
        ? {
            providerId: part.fromModel.providerId,
            modelId: part.fromModel.modelId,
            ...(part.fromModel.options ? { options: part.fromModel.options } : {}),
          }
        : null,
    };
  }
  return null;
}

function modelChangeKeyOfPart(
  part: Extract<MessagePart, { type: "timeline" }> & { timelineType: "model_change" },
): string {
  const from = part.fromModel
    ? `${part.fromModel.providerId}/${part.fromModel.modelId}/${part.fromModel.options?.reasoningLevel ?? ""}`
    : "<unknown>";
  const to = part.toModel
    ? `${part.toModel.providerId}/${part.toModel.modelId}/${part.toModel.options?.reasoningLevel ?? ""}`
    : "<unknown>";
  return `${String(part.anchorMessageId ?? part.messageID)}\u0000${from}\u0000${to}`;
}

// Preface turn-opening threshold: an assistant message containing only non-renderable host
// content like model_change/session_fork does not open a turn, avoiding an empty shell turn that
// says only "worked".
function assistantMessageHasSynthesizableContent(message: MessageWithParts): boolean {
  return message.parts.some((part) => {
    switch (part.type) {
      case "text":
        return part.ignored !== true && part.text.length > 0;
      case "reasoning":
        return part.text.length > 0;
      case "tool":
        return !shouldHideInvalidToolCallFromProduct(part.tool, part.metadata);
      case "subtask":
      case "compaction":
        return true;
      case "timeline":
        return (
          part.timelineType === "context_compaction" || part.timelineType === "goal_verification"
        );
      default:
        return false;
    }
  });
}

function synthesizeSubtaskPart(
  part: Extract<MessagePart, { type: "subtask" }>,
  push: PushEvent,
  turnId: string,
): void {
  synthesizeSubagentLifecycle(
    {
      agentId: String(part.id),
      agentType: part.agent,
      description: part.description,
      prompt: part.prompt,
      summaryText: part.description,
    },
    "completed",
    push,
    turnId,
  );
}

function synthesizeAssistantParts(
  message: MessageWithParts,
  emittedCompactOperations: Set<string>,
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string,
): AssistantSynthesisState {
  let resultType: TurnResultForHydration =
    message.info.role === "assistant" && message.info.error
      ? isPersistedAssistantCancellation(message.info.error)
        ? "cancelled"
        : isPersistedStreamRecoveryDiscard(message.info.error)
          ? "success"
          : "error_during_execution"
      : message.info.role === "assistant" && message.info.time.completed === undefined
        ? // Bug root cause: a process exit may persist only step-start/partial without an
          // assistant error;
          // Old cold hydration defaulted to success, fabricating a normal TurnComplete and
          // collapsing the abnormal Worked state.
          "cancelled"
        : "success";
  let toolCallCount = 0;
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        synthesizeTextPart(
          part,
          String(message.info.id),
          messageCreatedAtMs(message),
          push,
          turnId,
        );
        break;
      case "reasoning":
        // Cold hydration used not to carry the transcript assistant message identity into
        // reasoning_start, so the recovered ReasoningRow could not reuse live projection's response boundary.
        synthesizeReasoningPart(part, String(message.info.id), push, turnId);
        break;
      case "tool": {
        const state = synthesizeToolPart(part, String(message.info.id), push, turnId);
        toolCallCount += state.toolCallCount;
        resultType = normalizeTurnResult(resultType, state.resultType);
        break;
      }
      case "timeline":
        if (synthesizeGoalVerificationPart(part, emittedGoalVerifications, push, turnId)) {
          break;
        }
        synthesizeCompactPart(
          part,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          push,
          turnId,
        );
        break;
      case "compaction":
        synthesizeCompactPart(
          part,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          push,
          turnId,
        );
        break;
      case "subtask":
        synthesizeSubtaskPart(part, push, turnId);
        break;
      default:
        break;
    }
  }
  const assistantFeedback = message.info.metadata?.assistantFeedback;
  if (assistantFeedback === "like" || assistantFeedback === "dislike") {
    push(
      SessionEventType.AssistantFeedbackUpdated,
      { entityId: String(message.info.id), feedback: assistantFeedback },
      turnId,
    );
  }
  const assistantPinnedAt = pinnedAtOfMessage(message);
  if (assistantPinnedAt !== undefined) {
    push(
      SessionEventType.RowPinnedUpdated,
      { entityId: String(message.info.id), pinnedAt: assistantPinnedAt },
      turnId,
    );
  }
  return { resultType, toolCallCount };
}

// ── model-only wake turns ──
// On the live path, background wake / goal continuation opens an independent turn with
// TurnStarted(inputVisibility=model-only); the cold path must not skip such synthetic users and
// fold the following assistant into the previous turn — live/cold must be structurally
// identical. The trigger source is maintained solely by the shared projection policy;
// non-trigger synthetic contexts like compact summaries / rewind notices still open no turn.

// ── guide steer inlining ──
// Drain-persisted user messages carry metadata.turnSteerDelivery: guide = inlined into the
// current turn (not a turn boundary), queue = independent turn (a real starter, matching the
// live split). Legacy unmarked messages are treated as queue.
function steerDeliveryOfMessage(message: MessageWithParts): "guide" | "queue" | null {
  if (message.info.role !== "user") return null;
  const metadata = (message.info as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const delivery = (metadata as Record<string, unknown>).turnSteerDelivery;
  return delivery === "guide" || delivery === "queue" ? delivery : null;
}

/**
 * Turn-boundary decision: a real user starter (except guide steer — inlined into the current
 * turn) or a model-only wake trigger (background wake / goal continuation each opening a turn).
 * Note: the live "merger" case (a notification folded into the current turn while the active
 * loop is still running) cannot be distinguished from persisted facts on the cold path; it is
 * uniformly treated as a boundary — no content is lost and no bubbles appear; only turn
 * attribution differs from the live merger case, a known deviation.
 */
function isTurnBoundaryStarter(message: MessageWithParts): boolean {
  if (isRealUserTurnStarter(message)) {
    return steerDeliveryOfMessage(message) !== "guide";
  }
  // The launch turn is a visible controlOnly user turn and must act as a boundary so the previous
  // turn's output collection stops here (under one-run-per-session it is already the first
  // message, but semantically it is still an independent turn boundary and must not fold into the
  // previous turn).
  if (workflowLaunchOfMessage(message)) return true;
  return getConversationModelOnlyTurnTriggerSource(message) !== null;
}

function backgroundResultOriginMetaOfMessage(
  message: MessageWithParts,
): BackgroundResultOriginMeta | undefined {
  const messageMetadata = message.info.metadata;
  const partMetadata = message.parts.find((part) => part.type === "text")?.metadata;
  const candidate = messageMetadata?.originMeta ?? partMetadata?.originMeta;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const backgroundSource = record.backgroundSource;
  const workId = typeof record.workId === "string" ? record.workId.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  // The three values stay in sync with BackgroundResultOriginMeta (contracts/src/events/session.events.ts).
  // "workflow" is a workflow run (workId ≡ runId): omit it and a workflow's background result
  // turn silently degrades after cold resume into an untitled model-only message, losing the
  // tool-card→detail-page association key.
  if (
    (backgroundSource !== "bash" &&
      backgroundSource !== "subagent" &&
      backgroundSource !== "workflow") ||
    !workId ||
    !title
  ) {
    return undefined;
  }
  // The manifest payload (workflowNotification) must also survive cold resume: reading back only
  // the three base fields here would drop the payload — manifest entries would degrade to bare
  // title rows. Validate with shared's zod schema; when malformed, **drop only the payload** and
  // keep the base fields — never throw: this is a projection rebuild path, and one bad payload
  // must not take down the whole cold resume.
  const workflowNotification = parseWorkflowNotificationMeta(record.workflowNotification);
  // The idle-notice payload lives on its own key (contracts' WorkflowBlockedMeta); likewise malformed means drop only the payload.
  const workflowBlocked = workflowBlockedMetaSchema.safeParse(record.workflowBlocked);
  // A background Agent's structured terminal state must also survive cold resume, or the failure details degrade to the full-sentence summary.
  const subagentResult = subagentResultMetaSchema.safeParse(record.subagentResult);
  return {
    backgroundSource,
    title,
    workId,
    ...(workflowNotification ? { workflowNotification } : {}),
    ...(workflowBlocked.success ? { workflowBlocked: workflowBlocked.data } : {}),
    ...(subagentResult.success ? { subagentResult: subagentResult.data } : {}),
  };
}

/** Defensively parse the manifest payload: malformed / absent both return undefined (the caller then omits the field); never throws. */
function parseWorkflowNotificationMeta(
  value: unknown,
): BackgroundResultOriginMeta["workflowNotification"] {
  if (value === undefined || value === null) return undefined;
  const parsed = workflowNotificationMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function isLegacyCompactMaintenanceInput(
  message: MessageWithParts,
  nextMessage: MessageWithParts | undefined,
): boolean {
  if (message.info.role !== "user") return false;
  // Only repair old data missing the canonical policy; an explicitly user-visible `/compact`
  // must be delivered verbatim — the UI must not override the CLI's visibility authority via
  // text matching.
  if (message.info.visibility !== undefined || message.info.semantics !== undefined) return false;
  const text = textOfMessage(message.parts).trim();
  if (text !== "/compact" && !text.startsWith("/compact ")) return false;
  if (!nextMessage || nextMessage.info.role !== "assistant") return false;
  return nextMessage.parts.some(
    (part) =>
      part.type === "compaction" ||
      (part.type === "timeline" && part.timelineType === "context_compaction"),
  );
}

interface TurnOutputCollection {
  failure?: {
    type: string;
    message: string;
    attribution?: ErrorAttribution;
    retryable?: boolean;
    data?: unknown;
  };
  nextIndex: number;
  resultType: TurnResultForHydration;
  toolCallCount: number;
  historyRoundCount: number;
  turnEndedAtMs: number;
}

/** Collect one turn's assistant output (up to the next turn boundary); shared by normal and preface turns. */
function collectTurnOutput(options: {
  messages: readonly MessageWithParts[];
  startIndex: number;
  turnId: string;
  turnStartedAtMs: number;
  emittedCompactOperations: Set<string>;
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>;
  emittedGoalVerifications: Set<string>;
  goalVerificationsByAnchor: ReadonlyMap<string, GoalVerificationFact[]>;
  onModelChange: (selection: HydratedTimelineModel) => void;
  push: PushEvent;
}): TurnOutputCollection {
  const { messages, turnId, push } = options;
  let index = options.startIndex;
  let resultType: TurnResultForHydration = "success";
  let failure: TurnOutputCollection["failure"];
  // If a stream-recovery-discarded tail is this turn's last assistant, the recovery request never
  // made it to disk (the process exited before resending); settle this turn as interrupted. A
  // later assistant, when present, decides the result instead.
  let awaitingStreamRecovery = false;
  let toolCallCount = 0;
  let historyRoundCount = 0;
  let turnEndedAtMs = options.turnStartedAtMs;
  while (index < messages.length && !isTurnBoundaryStarter(messages[index]!)) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      // Selection side chats mark the inherited assistant history model-only; the old cold
      // hydration hid only the user carrier, then synthesized the assistant as preface/previous
      // turn output, leaking the parent timeline on both the side pane's first open and cold
      // resume. Obey the projection policy uniformly and skip the whole chain.
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(
          SessionEventType.SessionForked,
          {
            forkPoint: 0,
            originalSessionId: forkContext.parentSessionId,
            restoredFileCount: forkContext.restoredFileCount,
            targetCheckpointId: forkContext.targetCheckpointId,
            targetMessageId: forkContext.targetMessageId,
          },
          turnId,
        );
      }
      index += 1;
      continue;
    }
    // Guide steer: inlined into the current turn — synthesize TurnSteerDrained (with
    // drainedInputs); the projection follows delivery=guide into an inlined userInput row,
    // the same reduction entry as live.
    if (message.info.role === "user" && steerDeliveryOfMessage(message) === "guide") {
      const intent = inputIntentOfMessage(message);
      // Cold guide used to improvise pendingInputId from messageId alone and did not carry the
      // transcript's persisted ConversationInputIntent back into events; the recovered row lost
      // sourceCommandId/clientId/attachments, and command dedup/display stopped matching live.
      // New data reuses the original queueItemId; only legacy uses the diagnosable hydration
      // fallback.
      const pendingInputId = intent?.queueItemId ?? `hydrate-steer-${String(message.info.id)}`;
      push(
        SessionEventType.TurnSteerDrained,
        {
          pendingInputIds: [pendingInputId],
          injectedMessageIds: [String(message.info.id)],
          drainedInputs: [
            {
              pendingInputId,
              messageId: String(message.info.id),
              text: textOfMessage(message.parts),
              delivery: "guide",
              ...(intent ? { intent } : {}),
            },
          ],
          targetTurnId: turnId,
        },
        turnId,
        messageCreatedAtMs(message),
      );
      index += 1;
      continue;
    }
    if (message.info.role !== "assistant") {
      // Fix reason: when stopping after the final text fully streamed, the assistant is
      // finish=stop with no error; live records cancelled while cold resume settled it as
      // success. The interrupt marker is the persisted fact of the stop and wins; with a
      // persisted error already present, finishTurn still prefers showing the error (host
      // faults also write the marker).
      if (isInterruptMarkerMessage(message)) {
        resultType = normalizeTurnResult(resultType, "cancelled");
      }
      index += 1;
      continue;
    }
    awaitingStreamRecovery =
      message.info.error !== undefined && isPersistedStreamRecoveryDiscard(message.info.error);
    if (
      message.info.error &&
      !isPersistedAssistantCancellation(message.info.error) &&
      !awaitingStreamRecovery
    ) {
      const data = assistantErrorData(message.info.error);
      const attribution = persistedErrorAttribution(data);
      failure = {
        type: message.info.error.name,
        message: (typeof data?.message === "string" && data.message) || message.info.error.name,
        // Old cold hydration left attribution inside data where the TurnError projection could not read it, degrading to runtime after restart.
        ...(attribution ? { attribution } : {}),
        ...(typeof data?.retryable === "boolean" ? { retryable: data.retryable } : {}),
        ...(message.info.error.data !== undefined ? { data: message.info.error.data } : {}),
      };
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      options.onModelChange(timelineModel);
      index += 1;
      continue;
    }
    // The Host cannot infer model rounds from toolCallCount or the trimmed history length.
    // New transcripts pin the exact value on the final assistant anchor; only old transcripts
    // fall back to compatibility counting per distinct assistant history entry.
    historyRoundCount = message.info.anchor?.historyRoundCount ?? historyRoundCount + 1;
    const messageEnd = messageEndAtMs(message);
    if (messageEnd !== undefined) {
      turnEndedAtMs = Math.max(turnEndedAtMs, messageEnd);
    }
    // Live has a start stream event for every model request; cold synthesizes the same event per
    // assistant message. Fix reason: an assistant with no visible content produced no events at
    // all, the projection could not see the model step between two guide fetches, and folded the
    // second fetch's guide into the previous work segment.
    push(
      SessionEventType.ModelStreaming,
      { kind: "start", delta: "", done: false, assistantMessageId: String(message.info.id) },
      turnId,
    );
    const synthesized = synthesizeAssistantParts(
      message,
      options.emittedCompactOperations,
      options.durableCompactPartsByOperation,
      options.emittedGoalVerifications,
      push,
      turnId,
    );
    resultType = normalizeTurnResult(resultType, synthesized.resultType);
    toolCallCount += synthesized.toolCallCount;
    if (
      message.info.role === "assistant" &&
      message.info.finish?.trim().toLowerCase() === "length" &&
      synthesized.toolCallCount === 0
    ) {
      // The live ProductProjection recognizes output-token Continue from per-request
      // ModelComplete, but the cold transcript used to synthesize a single end_turn at turn end,
      // so after a refresh the same sentence degraded back into multiple assistant rows. The
      // persisted finish is the request-termination fact; use a zero-usage hydration-only
      // ModelComplete to restore eligibility without double-counting tokens or injecting a
      // Continue user.
      push(
        SessionEventType.ModelComplete,
        {
          content: "",
          stopReason: "length",
          querySource: "main_turn",
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        turnId,
        messageEnd,
      );
    }
    // session_entry-sourced goal verify: facts anchored to this assistant land right after it
    // (deduplicated against timeline parts by key, first come first served).
    const anchored = options.goalVerificationsByAnchor.get(String(message.info.id));
    if (anchored) {
      for (const fact of anchored) {
        pushGoalVerificationFact(fact, options.emittedGoalVerifications, push, turnId);
      }
    }
    index += 1;
  }
  if (awaitingStreamRecovery) {
    resultType = normalizeTurnResult(resultType, "cancelled");
  }
  return {
    ...(failure ? { failure } : {}),
    nextIndex: index,
    resultType,
    toolCallCount,
    historyRoundCount,
    turnEndedAtMs,
  };
}

/**
 * Synthesize the transcript (MessageWithParts in time/parentID order) into a reduction-equivalent SessionEvent sequence.
 * Turn grouping: a user message opens a turn; the assistant messages that follow (same-turn output) run until the next user message.
 */
export function synthesizeEventsFromMessages(
  messages: readonly MessageWithParts[],
  options: SynthesizeOptions,
): SessionEvent[] {
  const sessionId = options.sessionId as SessionId;
  const traceId = HYDRATION_TRACE_ID as TraceId;
  let seq = 0;
  const baseMs = options.baseTimestampMs ?? messages[0]?.info.time.created ?? 0;
  const events: SessionEvent[] = [];

  const push = (
    type: SessionEventType,
    payload: unknown,
    turnId?: string,
    sourceTimestampMs?: number,
  ): void => {
    seq += 1;
    events.push({
      id: `hydrate-${seq}` as EventId,
      sessionId,
      turnId: turnId as TurnId | undefined,
      type,
      // The source timestamp only restores display facts like row.createdAt; the event total order is always decided by sequenceNumber.
      timestamp: new Date(sourceTimestampMs ?? baseMs + seq),
      traceId,
      sequenceNumber: seq,
      payload,
    });
  };

  // Historical messages declare no model capacity; when the caller does not know it, keep it unknown — no synthesized default denominator.
  const contextWindow = options.contextWindow;
  push(SessionEventType.SessionCreated, {
    mode: "default",
    contextWindow,
  });

  let turnNumber = 0;
  let index = 0;
  const emittedCompactOperations = new Set<string>();
  const durableCompactPartsByOperation = new Map<
    string,
    Extract<MessagePart, { type: "compaction" }>
  >();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction") continue;
      if (!part.timelineStatus && !part.tail_start_id && !part.compactBoundary) continue;
      const operationId = String(
        part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      );
      const existing = durableCompactPartsByOperation.get(operationId);
      if (!existing || (!existing.tail_start_id && part.tail_start_id)) {
        durableCompactPartsByOperation.set(operationId, part);
      }
    }
  }
  const emittedGoalVerifications = new Set<string>();
  let lastTurnId: string | undefined;

  const entryFacts = mergeGoalVerificationEntryFacts(options.goalVerificationEntries ?? []);
  const goalVerificationsByAnchor = new Map<string, GoalVerificationFact[]>();
  for (const fact of entryFacts) {
    if (!fact.anchorAssistantMessageId) continue;
    const list = goalVerificationsByAnchor.get(fact.anchorAssistantMessageId) ?? [];
    list.push(fact);
    goalVerificationsByAnchor.set(fact.anchorAssistantMessageId, list);
  }

  // MC-cold: the modelChange marker is generated by the projection at TurnStarted by comparing
  // lastTurnModel with config; cold resume synthesizes ModelSelected before TurnStarted from each
  // turn's persisted selection facts — the plain first turn stays silent, while explicit
  // source-less and later A→B boundaries are always rebuilt.
  // The synthesized event carries HYDRATION_TRACE_ID and claims no seed authority (see onModelSelected).
  let lastSelectedModelKey: string | null = null;
  let pendingTimelineModel: HydratedTimelineModel | null = null;
  const selectTurnModel = (selection: HydratedTimelineModel | null): void => {
    if (!selection) return;
    const key = hydratedModelKey(selection.modelSelection);
    if (key === lastSelectedModelKey) return;
    lastSelectedModelKey = key;
    push(SessionEventType.ModelSelected, {
      modelSelection: selection.modelSelection,
      ...(selection.previousModelSelection !== undefined
        ? {
            previousModelSelection: selection.previousModelSelection
              ? selection.previousModelSelection
              : null,
          }
        : {}),
    });
  };
  const selectAcceptedTurnModel = (fallback: ModelSelection | null): void => {
    const selected = pendingTimelineModel ?? (fallback ? { modelSelection: fallback } : null);
    pendingTimelineModel = null;
    selectTurnModel(selected);
  };
  const recordTimelineModel = (selection: HydratedTimelineModel): void => {
    pendingTimelineModel = selection;
    selectTurnModel(selection);
  };

  const finishTurn = (input: {
    failure?: TurnOutputCollection["failure"];
    fileChanges?: TurnFileChangeSummary;
    turnId: string;
    resultType: TurnResultForHydration;
    toolCallCount: number;
    historyRoundCount: number;
    turnStartedAtMs: number;
    turnEndedAtMs: number;
  }): void => {
    if (input.failure) {
      // A failure before the provider's first token is persisted only in assistant.info.error;
      // the old cold path folded it into TurnComplete(error_during_execution), losing
      // lastError's code/message entirely. Reuse live's TurnError state machine here instead of
      // building a cold-only error reducer.
      push(
        SessionEventType.TurnError,
        { error: input.failure, turnPhase: "model" },
        input.turnId,
        input.turnEndedAtMs,
      );
      return;
    }
    push(
      SessionEventType.ModelComplete,
      {
        content: "",
        stopReason: "end_turn",
        querySource: "main_turn",
        // Cold resume used to pin synthesized events' window at 200K, overriding the same
        // model's 1M capability in the workspace provider registry; use the caller-resolved
        // current model truth here.
        contextWindow,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        ...(input.fileChanges ? { fileChanges: input.fileChanges } : {}),
      },
      input.turnId,
      input.turnEndedAtMs,
    );
    push(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: input.toolCallCount,
        historyRoundCount: input.historyRoundCount,
        // Cold resume reverse-synthesizes events from the message transcript and cannot rely on
        // a runtime startedAt like live events; pinning 0 would show historical turns as 1 second.
        duration: Math.max(0, input.turnEndedAtMs - input.turnStartedAtMs),
        resultType: input.resultType,
      },
      input.turnId,
      input.turnEndedAtMs,
    );
  };

  while (index < messages.length) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      index += 1;
      continue;
    }
    if (isLegacyCompactMaintenanceInput(message, messages[index + 1])) {
      // An old manual compact's user host is just a maintenance command, not real-user intent;
      // after skipping the host, the next assistant compact fact takes the preface model-only
      // turn and generates the canonical marker.
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(SessionEventType.SessionForked, {
          forkPoint: 0,
          originalSessionId: forkContext.parentSessionId,
          restoredFileCount: forkContext.restoredFileCount,
          targetCheckpointId: forkContext.targetCheckpointId,
          targetMessageId: forkContext.targetMessageId,
        });
      }
      index += 1;
      continue;
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      // A model_change timeline part is the persisted boundary fact of an accepted turn;
      // the host message cannot be skipped entirely with reconstruction left to the next user
      // message's model snapshot by luck: with the snapshot missing or lagging, the marker would
      // vanish. So consume the explicit toModel first, and let the next TurnStarted use only that
      // authoritative selection, no longer overridden by a lagging snapshot.
      recordTimelineModel(timelineModel);
      index += 1;
      continue;
    }
    const workflowLaunch = workflowLaunchOfMessage(message);
    if (workflowLaunch) {
      // A hub-launched launch turn: a visible controlOnly user turn whose cold-resume shape must
      // match the live projection — same messageId, origin workflowLaunch (mapped from
      // inputSource), the same workflowLaunch metadata, no assistant output.
      // Placed before the real-user branch so this synthetic user is not skipped as hiddenSynthetic.
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const launchText = textOfMessage(message.parts);
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
      push(
        SessionEventType.TurnStarted,
        {
          turnNumber,
          // The text still goes into userInput.text (degraded rendering for old clients / TUI); the GUI draws the launch card from metadata.
          input: launchText,
          // The persisted messageId is the turn's authoritative target, shared with the live projection — otherwise the productTurn identity forks between cold and live.
          messageId: String(message.info.id),
          // The launch turn runs no Agent (controlOnly, no work time); the source drives origin=workflowLaunch.
          executionKind: "controlOnly",
          inputSource: "workflow_launch",
          workflowLaunch,
        },
        turnId,
        turnStartedAtMs,
      );
      index += 1;
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }
    if (!isRealUserTurnStarter(message)) {
      // A model-only wake turn: the synthetic user triggered by background wake /
      // goal continuation opens an independent model-only turn (no visible bubble, notification
      // text stays out of rows), and the assistant after it belongs to this turn — structurally
      // identical to live's TurnStarted(inputVisibility=model-only), no longer folded into the
      // previous turn.
      const wakeSource = getConversationModelOnlyTurnTriggerSource(message);
      if (wakeSource) {
        turnNumber += 1;
        const turnId = `hydrate-turn-${turnNumber}`;
        lastTurnId = turnId;
        const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
        selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
        push(
          SessionEventType.TurnStarted,
          {
            turnNumber,
            // Cold hydration used to blank the model-only background wake's original text, so
            // even though ProductProjection can consume task-notification, recovery could not get
            // the tool-use-id or failure details. The input stays model-only and generates no
            // user bubble.
            input:
              wakeSource === "background_task" ? backgroundWakeInputOfMessage(message.parts) : "",
            inputVisibility: "model-only",
            inputSource: wakeSource,
            ...(wakeSource === "background_task"
              ? { originMeta: backgroundResultOriginMetaOfMessage(message) }
              : {}),
            // The model-only trigger is likewise a persisted user entity; without messageId,
            // cold degrades to hydrate-turn-N and the live/cold productTurn identity forks again.
            messageId: String(message.info.id),
          },
          turnId,
          turnStartedAtMs,
        );
        index += 1;
        const collected = collectTurnOutput({
          messages,
          startIndex: index,
          turnId,
          turnStartedAtMs,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          emittedGoalVerifications,
          goalVerificationsByAnchor,
          onModelChange: recordTimelineModel,
          push,
        });
        index = collected.nextIndex;
        finishTurn({
          failure: collected.failure,
          fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
          turnId,
          resultType: collected.resultType,
          toolCallCount: collected.toolCallCount,
          historyRoundCount: collected.historyRoundCount,
          turnStartedAtMs,
          turnEndedAtMs: collected.turnEndedAtMs,
        });
        continue;
      }
      // assistant-head-skip fix (the cold-path vector of "assistant replies vanish entirely"):
      // messages before the first real user message cannot be skipped wholesale — when the
      // session head is a rewind notice / compact summary or other non-real-user message, the
      // assistant replies after it would disappear entirely on refresh. So synthesize a preface
      // model-only turn for head assistant output (no visible user bubble, content rendered as
      // usual). Non-trigger synthetic contexts in the user role stay invisible by design and are
      // still skipped.
      if (message.info.role !== "assistant" || !assistantMessageHasSynthesizableContent(message)) {
        index += 1;
        continue;
      }
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(assistantModelSelectionOf(message));
      push(
        SessionEventType.TurnStarted,
        { turnNumber, input: "", inputVisibility: "model-only" },
        turnId,
        turnStartedAtMs,
      );
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }

    turnNumber += 1;
    const turnId = `hydrate-turn-${turnNumber}`;
    lastTurnId = turnId;
    const userText = textOfMessage(message.parts);
    const attachments = attachmentMetasOfMessage(message.parts);
    const intent = inputIntentOfMessage(message);
    const executionKind = executionKindOfMessage(message);
    const epilogueStart = epilogueStartOfMessage(message);
    const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
    // Legacy synthetic context can sit between a timeline part and the next accepted turn;
    // do not guess by "the immediately preceding one". Hold the explicit boundary until a turn
    // actually opens.
    selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
    push(
      SessionEventType.TurnStarted,
      {
        turnNumber,
        input: userText,
        ...(epilogueStart === undefined ? {} : { epilogueStart }),
        // Root cause: cold hydration used to rebuild only the visible user row and omit the
        // persisted messageId, leaving a historical message visible in the UI yet unaddressable
        // by edit/rewind commands. The real user transcript message is the row's authoritative
        // target and must enter ProductProjection with the same messageId field as live
        // TurnStarted.
        messageId: String(message.info.id),
        ...(executionKind ? { executionKind } : {}),
        ...(message.info.anchor?.sourceCommandId
          ? { inputId: message.info.anchor.sourceCommandId }
          : {}),
        ...(intent ? { intent } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      turnId,
      turnStartedAtMs,
    );
    const userPinnedAt = pinnedAtOfMessage(message);
    if (userPinnedAt !== undefined) {
      push(
        SessionEventType.RowPinnedUpdated,
        { entityId: String(message.info.id), pinnedAt: userPinnedAt },
        turnId,
      );
    }
    index += 1;

    const collected = collectTurnOutput({
      messages,
      startIndex: index,
      turnId,
      turnStartedAtMs,
      emittedCompactOperations,
      durableCompactPartsByOperation,
      emittedGoalVerifications,
      goalVerificationsByAnchor,
      onModelChange: recordTimelineModel,
      push,
    });
    index = collected.nextIndex;
    finishTurn({
      failure: collected.failure,
      fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
      turnId,
      resultType: collected.resultType,
      toolCallCount: collected.toolCallCount,
      historyRoundCount: collected.historyRoundCount,
      turnStartedAtMs,
      turnEndedAtMs: collected.turnEndedAtMs,
    });
  }

  // Entry facts whose anchor is missing or points to a message absent from the transcript: land
  // at the end of the known timeline (already deduplicated by key; anchored ones were emitted in
  // the loop above; no timestamp guessing, no silent drops).
  for (const fact of entryFacts) {
    pushGoalVerificationFact(fact, emittedGoalVerifications, push, lastTurnId);
  }

  return events;
}

function transcriptFootprint(
  messages: readonly MessageWithParts[],
  goalVerificationEntries: readonly HydratedGoalVerificationEntry[] = [],
): TranscriptFootprint {
  const compactOperations = new Set<string>();
  const goalVerificationKeys = new Set<string>();
  const modelChangeKeys = new Set<string>();
  for (const fact of mergeGoalVerificationEntryFacts(goalVerificationEntries)) {
    goalVerificationKeys.add(fact.key);
  }
  const footprint: TranscriptFootprint = {
    userTurnCount: 0,
    assistantTexts: [],
    reasoningTexts: [],
    toolCallIds: [],
    compactMarkerCount: 0,
    subagentCount: 0,
    forkTimelineCount: 0,
    goalVerificationCount: 0,
    modelChangeCount: 0,
  };
  // Model-switch footprint = the number of changes in persisted selection snapshots across
  // adjacent real user turns (same origin as the projection marker's generation condition: this
  // turn's actual selection ≠ the previous turn's).
  let lastModelKey: string | null = null;

  for (const message of messages) {
    if (isForkTimelineMessage(message)) {
      footprint.forkTimelineCount += 1;
    }
    if (isRealUserTurnStarter(message)) {
      footprint.userTurnCount += 1;
      const model = turnModelSelectionOfUserMessage(message);
      if (model) {
        const key = hydratedModelKey(model);
        if (lastModelKey !== null && key !== lastModelKey) {
          footprint.modelChangeCount += 1;
        }
        lastModelKey = key;
      }
    }
    if (message.info.role !== "assistant" || isProviderContextOnlyAssistant(message)) {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "text" && part.ignored !== true && part.text.length > 0) {
        footprint.assistantTexts.push(part.text);
        continue;
      }
      if (part.type === "reasoning" && part.text.length > 0) {
        footprint.reasoningTexts.push(part.text);
        continue;
      }
      if (part.type === "tool") {
        if (shouldHideInvalidToolCallFromProduct(part.tool, part.metadata)) continue;
        footprint.toolCallIds.push(part.callID);
        const subagentInfo = subagentInfoFromToolPart(part);
        if (subagentInfo && part.state.status !== "pending") {
          footprint.subagentCount += 1;
        }
        continue;
      }
      if (part.type === "subtask") {
        footprint.subagentCount += 1;
        continue;
      }
      if (part.type === "timeline" && part.timelineType === "goal_verification") {
        goalVerificationKeys.add(goalVerificationKeyOfPart(part));
        continue;
      }
      if (part.type === "timeline" && part.timelineType === "model_change") {
        modelChangeKeys.add(modelChangeKeyOfPart(part));
        continue;
      }
      const compact =
        part.type === "timeline"
          ? compactPayloadFromTimelinePart(part)
          : part.type === "compaction"
            ? compactPayloadFromLegacyCompactionPart(part)
            : null;
      if (compact) {
        compactOperations.add(String(compact.payload.operationId));
      }
    }
  }
  footprint.compactMarkerCount = compactOperations.size;
  footprint.goalVerificationCount = goalVerificationKeys.size;
  // New data's timeline parts are the explicit boundary authority; only old data without parts
  // relies on the adjacent-turn model snapshot change count. Both express the same set of
  // boundaries — take the max to avoid double counting.
  footprint.modelChangeCount = Math.max(footprint.modelChangeCount, modelChangeKeys.size);
  return footprint;
}

function projectionFootprint(
  events: readonly SessionEvent[],
  sessionId: string,
): TranscriptFootprint {
  const projection = new ProductProjection(sessionId, "hydrate-footprint");
  for (const event of events) {
    projection.applyEvent(event);
  }
  const rows = projection.getSnapshot().rows.window;
  return {
    userTurnCount: rows.filter((row) => row.kind === "userInput").length,
    assistantTexts: rows
      .filter((row) => row.kind === "assistantText")
      .map((row) => (row.kind === "assistantText" ? row.text : "")),
    reasoningTexts: rows
      .filter((row) => row.kind === "reasoning")
      .map((row) => (row.kind === "reasoning" ? row.text : "")),
    toolCallIds: rows
      .filter((row) => row.kind === "toolCall")
      .map((row) => (row.kind === "toolCall" ? row.toolCallId : "")),
    compactMarkerCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "compact",
    ).length,
    subagentCount: rows.filter((row) => row.kind === "subagent").length,
    forkTimelineCount: rows.filter(
      (row) =>
        row.kind === "timelineMarker" &&
        (row.marker.type === "forkNotice" || row.marker.type === "forkCreated"),
    ).length,
    goalVerificationCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
    ).length,
    modelChangeCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
    ).length,
  };
}

function valuesCover(expected: readonly string[], actual: readonly string[]): boolean {
  const remaining = [...actual];
  for (const value of expected) {
    const index = remaining.indexOf(value);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function footprintCovered(expected: TranscriptFootprint, actual: TranscriptFootprint): boolean {
  return (
    actual.userTurnCount >= expected.userTurnCount &&
    actual.compactMarkerCount >= expected.compactMarkerCount &&
    actual.subagentCount >= expected.subagentCount &&
    actual.forkTimelineCount >= expected.forkTimelineCount &&
    actual.goalVerificationCount >= expected.goalVerificationCount &&
    actual.modelChangeCount >= expected.modelChangeCount &&
    valuesCover(expected.assistantTexts, actual.assistantTexts) &&
    valuesCover(expected.reasoningTexts, actual.reasoningTexts) &&
    valuesCover(expected.toolCallIds, actual.toolCallIds)
  );
}

/**
 * Decide whether the event log suffices to cover the transcript's visible product state.
 * Fix reason: the old check counted only user turns, so an event log missing
 * tool/reasoning/compact/subagent was still misjudged as complete, leaving the cold-resume
 * snapshot without corresponding rows.
 */
export function eventsCoverTranscript(
  events: readonly SessionEvent[],
  messages: readonly MessageWithParts[],
  options: {
    goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  } = {},
): boolean {
  const expected = transcriptFootprint(messages, options.goalVerificationEntries ?? []);
  if (
    expected.userTurnCount === 0 &&
    expected.assistantTexts.length === 0 &&
    expected.reasoningTexts.length === 0 &&
    expected.toolCallIds.length === 0 &&
    expected.compactMarkerCount === 0 &&
    expected.subagentCount === 0 &&
    expected.forkTimelineCount === 0 &&
    expected.goalVerificationCount === 0 &&
    expected.modelChangeCount === 0
  ) {
    return true;
  }
  const sessionId = String(messages[0]?.info.sessionID ?? events[0]?.sessionId ?? "unknown");
  return footprintCovered(expected, projectionFootprint(events, sessionId));
}
