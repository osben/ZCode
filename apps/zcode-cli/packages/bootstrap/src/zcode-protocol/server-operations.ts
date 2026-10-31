import {
  isAuxiliarySessionKind,
  isReadonlyAgentSessionKind,
  OFF_PEAK_EXECUTION_TOOL_DENYLIST,
} from "@zcode/shared";
/* eslint-disable max-lines -- ZCode Protocol's session/workspace methods share one server context and snapshot helpers; kept together during the migration. */
import { stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { observeDetachedChildSessionDebug, observeSessionDebug } from "./session-debug.js";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";
import { resolveEffectiveBashShellSelection } from "@zcode/adapters/exec";
import { inputIntentMetadata } from "../zcode-protocol-v4/commands/input-intent.js";
import { createModelExecutionContext } from "./model-execution.js";
import type { SendInputOptions } from "../app/types.js";
import {
  repairPersistedRemoteSessionPaths,
  type AgentRuntimeConfig,
  type TurnAttachment,
} from "@zcode/core";
import {
  CoreErrorType,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  createMessageId,
  createPartId,
  createSessionId,
  createCoreError,
  parseRewindTriggeredPayload,
  RewindScope,
  RewindStrategy,
  type EventId,
  type ExecutionShellSelection,
  type MessageWithParts,
  type ModelSelection,
  type MessageId,
  type ModelId,
  type ModelProviderId,
  type QueryId,
  type SessionEvent,
  SessionEventType,
  type SessionId,
  type SessionInfo,
  type SessionTaskType,
  type CollaborationMode,
  type TargetCompletionVerificationPayload,
  type TraceId,
  type TurnBackgroundAttribution,
  type TurnId,
  type UsageStorePort,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  subagentRuntimeConfigSchema,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  zcodeProtocolErrorCodes,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeChatGptPlanUsageUpdatedParamsSchema,
  zcodeSessionCancelBackgroundTaskParamsSchema,
  zcodeSessionCompactParamsSchema,
  zcodeSessionCloseParamsSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionEventsParamsSchema,
  zcodeSessionForkParamsSchema,
  zcodeSessionGoalParamsSchema,
  zcodeSessionListParamsSchema,
  zcodeSessionMessagesParamsSchema,
  zcodeSessionReadParamsSchema,
  elideSessionSnapshotForIndex,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionResumeParamsSchema,
  zcodeSessionSendParamsSchema,
  zcodeSessionSetModeParamsSchema,
  zcodeSessionSetModelParamsSchema,
  zcodeSessionSetThoughtLevelParamsSchema,
  zcodeSessionStopParamsSchema,
  zcodeSessionSubscribeParamsSchema,
  zcodeSessionSubagentsParamsSchema,
  zcodeTaskTokenUsageParamsSchema,
  zcodeUsageStatsParamsSchema,
  zcodeWorkspaceGenerateTextParamsSchema,
  getConversationMessageProjectionPolicy,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type AppToolSearchMode,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeSessionCreateParams,
  type ZCodeDeliveryKind,
  type IntegratedTerminalShellSelection,
  type ZCodeSessionRuntimePreferencesScope,
  type ZCodeSessionRuntimePreferencesResult,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeProtocolTrace,
  type ZCodeSessionEvent,
  type ZCodeSessionHistoryTarget,
  type ZCodeSessionResumeParams,
  type ZCodeSessionPersistence,
  type ZCodeWorkspaceRef,
  type ZCodeStateUpdatedNotification,
} from "@zcode/shared";
import {
  buildSessionSnapshot,
  buildWorkspaceRef,
  formatProtocolModelSelection,
  mapSessionEventForProtocol,
  mapSessionInfo,
  resolveSessionContextUsage,
  shouldExposeSessionEventToProtocol,
} from "./mapper.js";
import { optionalModelSelectionFromString } from "./model-mapper.js";
import {
  ProtocolRequestError,
  assertExpectedRevision,
  createProtocolLogger,
  createProtocolRootTraceContext,
  protocolTraceFromTraceContext,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
  type ZCodeProtocolToolInputTransmissionState,
} from "./server-types.js";
import { createWorkspaceZCodeApp, ensureSessionModelAvailable } from "./workspace-model-runtime.js";
import { runUsageStats } from "./usage-stats-run.js";
import { createProtocolInteractionBroker } from "./interaction-broker.js";
import { createProtocolAutomationPort } from "./automation-port.js";
import { createProtocolOffPeakPort } from "./offpeak-port.js";
import { createProtocolTopicResourcePort } from "./topic-resource-port.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import { mapComputerUseOperationEvent } from "./computer-use-operation-event.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { projectIdFromDirectory } from "../app/paths.js";
import {
  collectSubagentChildSessionIds,
  paginateEndedSubagents,
  projectSessionSubagents,
} from "./subagent-session-query.js";
import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";
import { resolveDynamicWorkflowRuntimeGate } from "./dynamic-workflow-policy.js";
import {
  runWithSessionResidencyFinalization,
  getSessionLifecycle,
  closeSessionRuntime,
  discardSessionRuntime,
} from "./session-residency.js";

const PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE = "Plan mode 下已记录 goal，但不会自动继续。";
const SLOW_SNAPSHOT_LOG_THRESHOLD_MS = 1000;
const REMOTE_AUTOMATION_TOOL_NAMES = [
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
  "CronPauseSelf",
] as const;

type ProtocolGoalTarget = NonNullable<
  Awaited<ReturnType<NonNullable<ZCodeProtocolSessionRecord["app"]["readTarget"]>>>
>;

type ZCodeSessionRecordParams = (
  | ZCodeSessionCreateParams
  | (ZCodeSessionResumeParams & {
      mode?: ZCodeSessionCreateParams["mode"];
      model?: ZCodeSessionCreateParams["model"];
      parentSessionId?: ZCodeSessionCreateParams["parentSessionId"];
      thoughtLevel?: ZCodeSessionCreateParams["thoughtLevel"];
      executionWorktree?: ZCodeSessionCreateParams["executionWorktree"];
      // Cold resume and fork carry the persisted profile: plugins, MCP, hooks and agents are
      // composed by createZCodeApp before core resume runs.
      incognito?: ZCodeSessionCreateParams["incognito"];
      // Automation sessions disable title regeneration at creation, and create/resume share the
      // record initializer; the resume compatibility branch must declare this policy field too.
      titleGenerationEnabled?: ZCodeSessionCreateParams["titleGenerationEnabled"];
    })
) & { taskType?: SessionTaskType };

interface SessionStartupPreferences {
  additionalDirectories?: readonly string[];
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  memoryIndexAsContext: boolean;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  nativeSearchEnhancementsEnabled: boolean;
  toolSearchMode: AppToolSearchMode;
  resolveInitialBashShellSelection: () => Promise<ExecutionShellSelection | undefined>;
}

type SessionStartupPreferencesSource =
  | { kind: "host" }
  | { kind: "inherit"; parent: ZCodeProtocolSessionRecord };

function resolveSupportedAppThoughtLevel(
  app: Pick<ZCodeProtocolSessionRecord["app"], "listThoughtLevels">,
  thoughtLevel: string | undefined,
): string | undefined {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return undefined;
  }
  const supportedLevels = app.listThoughtLevels();
  return supportedLevels.includes(normalizedThoughtLevel) ? normalizedThoughtLevel : undefined;
}

const DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY = "__default__";
const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS = 4 * 1024;
const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS = 750;
const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS = 2 * 1024;
const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS = 250;

type ProtocolStreamingDeltaKind = "reasoning_delta" | "text_delta" | "tool_input_delta";

interface ProtocolStreamingDeltaBatchInfo {
  batchKey: string;
  delta: string;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  shouldFlushFirstDelta: boolean;
  timestampMs: number;
}

interface ProtocolStreamingDeltaBatch {
  batchKey: string;
  delta: string;
  event: SessionEvent;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  startedAtMs: number;
  updatedAtMs: number;
}

interface LiveProtocolStreamingDeltaBatch {
  batch?: ProtocolStreamingDeltaBatch;
  flushedFirstDeltaBatchKeys: Set<string>;
  lastFlushAtByBatchKey: Map<string, number>;
}

const liveProtocolStreamingDeltaBatches = new WeakMap<
  ZCodeProtocolSessionRecord,
  Map<string, LiveProtocolStreamingDeltaBatch>
>();

function protocolEventSequenceKey(deliveryKind?: ZCodeDeliveryKind): string {
  return deliveryKind ?? DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY;
}

function getProtocolEventSequenceState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
) {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolEventSequences.get(key);
  if (existing) {
    return existing;
  }
  const created = {
    lastSeq: 0,
    seqBySourceEventKey: new Map<string, number>(),
  };
  record.protocolEventSequences.set(key, created);
  return created;
}

function getProtocolToolInputTransmissionState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeProtocolToolInputTransmissionState {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolToolInputTransmissions.get(key);
  if (existing) {
    return existing;
  }
  const created: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  record.protocolToolInputTransmissions.set(key, created);
  return created;
}

function protocolSourceEventKey(event: SessionEvent): string {
  return event.sequenceNumber > 0 ? `seq:${event.sequenceNumber}` : `event:${String(event.id)}`;
}

function assignProtocolEventSeq(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): number {
  const state = getProtocolEventSequenceState(record, deliveryKind);
  const sourceEventKey = protocolSourceEventKey(event);
  const existing = state.seqBySourceEventKey.get(sourceEventKey);
  if (existing !== undefined) {
    return existing;
  }
  const nextSeq = state.lastSeq + 1;
  state.lastSeq = nextSeq;
  state.seqBySourceEventKey.set(sourceEventKey, nextSeq);
  return nextSeq;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getLiveProtocolStreamingDeltaBatchState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): LiveProtocolStreamingDeltaBatch {
  let byDeliveryKind = liveProtocolStreamingDeltaBatches.get(record);
  if (!byDeliveryKind) {
    byDeliveryKind = new Map();
    liveProtocolStreamingDeltaBatches.set(record, byDeliveryKind);
  }
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = byDeliveryKind.get(key);
  if (existing) {
    return existing;
  }
  const created: LiveProtocolStreamingDeltaBatch = {
    flushedFirstDeltaBatchKeys: new Set(),
    lastFlushAtByBatchKey: new Map(),
  };
  byDeliveryKind.set(key, created);
  return created;
}

function buildProtocolStreamingDeltaBatchKey(params: {
  assistantMessageId?: string;
  inputId?: string;
  kind: ProtocolStreamingDeltaKind;
  partId?: string;
  parentToolUseId?: string;
  toolCallId?: string;
}): string {
  return [
    params.kind,
    params.assistantMessageId ?? "",
    params.inputId ?? "",
    params.partId ?? "",
    params.parentToolUseId ?? "",
    params.toolCallId ?? "",
  ].join(":");
}

function readProtocolStreamingParentToolUseId(
  payload: Record<string, unknown>,
): string | undefined {
  const direct = stringValue(payload.parentToolUseId) ?? stringValue(payload.parentToolCallId);
  if (direct) {
    return direct;
  }
  const meta = asRecord(payload._meta);
  const zcode = asRecord(meta.zcode);
  const claudeCode = asRecord(meta.claudeCode);
  return (
    stringValue(meta.parentToolUseId) ??
    stringValue(meta.parentToolCallId) ??
    stringValue(zcode.parentToolUseId) ??
    stringValue(zcode.parentToolCallId) ??
    stringValue(claudeCode.parentToolUseId) ??
    stringValue(claudeCode.parentToolCallId)
  );
}

function timestampMsForProtocolEvent(event: SessionEvent): number {
  const timestampMs = event.timestamp.getTime();
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function readStreamingDeltaBatchableEvent(
  event: SessionEvent,
): ProtocolStreamingDeltaBatchInfo | null {
  if (event.type !== SessionEventType.ModelStreaming) {
    return null;
  }
  const payload = asRecord(event.payload);
  const kind = stringValue(payload.kind) as ProtocolStreamingDeltaKind | undefined;
  if (kind !== "tool_input_delta" && kind !== "text_delta" && kind !== "reasoning_delta") {
    return null;
  }
  const delta = stringValue(payload.delta);
  if (!delta) {
    return null;
  }
  const assistantMessageId = stringValue(payload.assistantMessageId);
  const inputId = stringValue(payload.inputId);
  const partId = stringValue(payload.partId);
  const parentToolUseId = readProtocolStreamingParentToolUseId(payload);
  const toolCallId = stringValue(payload.toolCallId);
  if (kind === "tool_input_delta" && !toolCallId) {
    return null;
  }
  return {
    batchKey: buildProtocolStreamingDeltaBatchKey({
      assistantMessageId,
      inputId,
      kind,
      partId,
      parentToolUseId,
      toolCallId,
    }),
    delta,
    kind,
    maxChars:
      kind === "tool_input_delta"
        ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS
        : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS,
    shouldFlushFirstDelta:
      kind === "text_delta" || kind === "reasoning_delta" || kind === "tool_input_delta",
    timestampMs: timestampMsForProtocolEvent(event),
  };
}

function mergeProtocolStreamingDeltaBatch(
  batch: ProtocolStreamingDeltaBatch | undefined,
  event: SessionEvent,
  deltaInfo: ProtocolStreamingDeltaBatchInfo,
): ProtocolStreamingDeltaBatch {
  if (!batch || batch.batchKey !== deltaInfo.batchKey) {
    return {
      batchKey: deltaInfo.batchKey,
      delta: deltaInfo.delta,
      event,
      kind: deltaInfo.kind,
      maxChars: deltaInfo.maxChars,
      startedAtMs: deltaInfo.timestampMs,
      updatedAtMs: deltaInfo.timestampMs,
    };
  }
  return {
    batchKey: deltaInfo.batchKey,
    delta: `${batch.delta}${deltaInfo.delta}`,
    event,
    kind: deltaInfo.kind,
    maxChars: deltaInfo.maxChars,
    startedAtMs: batch.startedAtMs,
    updatedAtMs: deltaInfo.timestampMs,
  };
}

function materializeProtocolStreamingDeltaBatch(batch: ProtocolStreamingDeltaBatch): SessionEvent {
  const payload = asRecord(batch.event.payload);
  return {
    ...batch.event,
    payload: {
      ...payload,
      delta: batch.delta,
    },
  };
}

function rememberProtocolStreamingDeltaBatchFlush(
  lastFlushAtByBatchKey: Map<string, number>,
  batch: ProtocolStreamingDeltaBatch,
): void {
  lastFlushAtByBatchKey.set(batch.batchKey, batch.updatedAtMs);
}

function shouldFlushProtocolStreamingDeltaBatchForInterval(
  batch: ProtocolStreamingDeltaBatch,
  lastFlushAtByBatchKey: Map<string, number>,
): boolean {
  const lastFlushAt = lastFlushAtByBatchKey.get(batch.batchKey);
  if (lastFlushAt === undefined) {
    return false;
  }
  // Streaming function calls of the active task cannot be packetized by a 4KB byte budget alone.
  // A single-line JSON argument would linger at the protocol boundary, showing up as the tool card's arguments no longer streaming.
  const maxIntervalMs =
    batch.kind === "tool_input_delta"
      ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS
      : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS;
  return batch.updatedAtMs - lastFlushAt >= maxIntervalMs;
}

function markStreamedToolInputIfPresent(
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): void {
  if (mappedEvent.type !== "model.streaming") {
    return;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "tool_call" || !("input" in payload)) {
    return;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) {
    return;
  }
  toolInputTransmissions.streamedToolCallIdsWithInput.add(toolCallId);
}

function omitDuplicateScheduledToolInput(
  event: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): ZCodeSessionEvent {
  markStreamedToolInputIfPresent(mappedEvent, toolInputTransmissions);
  if (event.type !== SessionEventType.ToolCallScheduled || mappedEvent.type !== "tool.updated") {
    return mappedEvent;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "scheduled" || !("input" in payload)) {
    return mappedEvent;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId || !toolInputTransmissions.streamedToolCallIdsWithInput.has(toolCallId)) {
    return mappedEvent;
  }

  const nextPayload: Record<string, unknown> = { ...payload };
  const input = nextPayload.input;
  delete nextPayload.input;
  nextPayload.inputByteLength = measureJsonBytes(input);
  nextPayload.inputOmitted = true;
  nextPayload.inputRef = "model_stream";
  // Performance fix: the AI SDK's tool_call already delivers the complete input in
  // model.streaming; scheduled is only a lifecycle boundary, and re-carrying large Write/Edit
  // arguments amplifies them twice over stdio and the renderer.
  return {
    ...mappedEvent,
    payload: nextPayload,
  };
}

function mapProtocolPromptAttachments(
  attachments: unknown[] | undefined,
): TurnAttachment[] | undefined {
  const mapped = (attachments ?? [])
    .map(mapProtocolPromptAttachment)
    .filter((attachment): attachment is TurnAttachment => attachment !== undefined);
  return mapped.length > 0 ? mapped : undefined;
}

function mapProtocolPromptAttachment(attachment: unknown): TurnAttachment | undefined {
  const record = asRecord(attachment);
  const kind = stringValue(record.kind);
  const filename = stringValue(record.filename) ?? "attachment";
  const localPath = stringValue(record.localPath);
  const mimeType = stringValue(record.mimeType);
  const isPdf =
    kind === "pdf" || mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
  // GUI protocol attachments use kind/localPath/dataBase64, while the core runtime only knows
  // type/path/content. The semantic conversion happens at the protocol boundary so the
  // renderer's transport format never leaks into the agent.
  // Display metadata (filename/mimeType/sizeBytes) passes through faithfully at the boundary;
  // TurnStarted events and the v4 userInput row's attachment display no longer depend on
  // basename/extension inference.
  const displayMeta = {
    filename,
    ...(mimeType ? { mimeType } : {}),
    ...(typeof record.sizeBytes === "number" ? { sizeBytes: record.sizeBytes } : {}),
  };
  if (isPdf) {
    if (localPath) {
      return { path: localPath, type: "pdf", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    return dataBase64
      ? {
          content: `data:application/pdf;base64,${dataBase64}`,
          path: filename,
          type: "pdf",
          ...displayMeta,
        }
      : undefined;
  }
  if (kind === "image") {
    if (localPath) {
      return { path: localPath, type: "image", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "image/*";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "image",
          ...displayMeta,
        }
      : undefined;
  }

  // Video: localPath is zero-copy (the agent reads the file for size validation); on Web, dataBase64 becomes a data-URL inline.
  if (kind === "video") {
    if (localPath) {
      return { path: localPath, type: "video", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "video/mp4";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "video",
          ...displayMeta,
        }
      : undefined;
  }

  if (kind === "file" || kind === "audio") {
    if (localPath) {
      return {
        path: localPath,
        ...(kind === "file" &&
        (stringValue(record.sourceKind) === "clipboard-text" ||
          stringValue(record.sourceKind) === "topic-history")
          ? { sourceKind: stringValue(record.sourceKind) as "clipboard-text" | "topic-history" }
          : {}),
        type: "file",
        ...displayMeta,
      };
    }
    const textContent = stringValue(record.textContent);
    if (textContent !== undefined) {
      return {
        content: textContent,
        path: filename,
        type: "file",
        ...displayMeta,
      };
    }
    const decoded = decodeTextProtocolAttachment(record);
    return decoded !== undefined
      ? { content: decoded, path: filename, type: "file", ...displayMeta }
      : undefined;
  }

  return undefined;
}

function decodeTextProtocolAttachment(record: Record<string, unknown>): string | undefined {
  const dataBase64 = stringValue(record.dataBase64);
  if (!dataBase64) return undefined;
  const sizeBytes = numberValue(record.sizeBytes);
  if (sizeBytes !== undefined && sizeBytes > 64 * 1024) return undefined;
  try {
    return Buffer.from(dataBase64, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function shouldHideProtocolSessionEvent(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): boolean {
  const payload = asRecord(event.payload);
  const querySource = stringValue(payload.querySource);
  if (event.type === "model_request" && querySource === "session_title") {
    return true;
  }
  if (event.type === "model_network_status" && querySource === "session_title") {
    // The global title-generation suppress flag cannot hide model_network_status:
    // a title-request retry would also swallow the concurrent main request's retry events,
    // hiding the retry count at the app input box's bottom-right.
    // Status events carry querySource — hide only title generation's own network status.
    return true;
  }
  if (event.type === "model_complete" && querySource === "session_title") {
    return true;
  }
  return false;
}

function mapProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: {
    toolInputTransmissions?: ZCodeProtocolToolInputTransmissionState;
  } = {},
): ZCodeSessionEvent | null {
  if (shouldHideProtocolSessionEvent(record, event)) {
    return null;
  }
  if (!shouldExposeSessionEventToProtocol(event)) {
    const payload = asRecord(event.payload);
    context.logger?.debug("ZCode Protocol session event filtered", {
      event: "zcode_protocol.session_event.filtered",
      eventId: String(event.id),
      module: "bootstrap.zcode_protocol",
      payloadKind: stringValue(payload.kind),
      sessionEventSequenceNumber: event.sequenceNumber,
      sessionEventType: event.type,
      sessionId: String(event.sessionId),
      turnId: event.turnId ? String(event.turnId) : undefined,
    });
    return null;
  }
  // The eventStore's sequenceNumber is the internal full ledger, including high-frequency
  // model intermediates like tool_input_delta that the protocol filters out. The ZCode
  // Protocol's seq is the UI/replay recovery key and must be renumbered continuously over the
  // "protocol-visible event stream" — the internal sequenceNumber cannot be exposed directly.
  // Subagent mirror/live-only events with sequenceNumber=0 never entered the parent
  // eventStore; they too must get distinct seqs by eventId, not all reuse the same 0 mapping.
  const protocolSeq = assignProtocolEventSeq(record, event, deliveryKind);
  const mappedEvent = mapSessionEventForProtocol(event, deliveryKind, {
    seq: protocolSeq,
  });
  if (!mappedEvent) {
    return null;
  }
  return omitDuplicateScheduledToolInput(
    event,
    mappedEvent,
    options.toolInputTransmissions ?? getProtocolToolInputTransmissionState(record, deliveryKind),
  );
}

async function readProtocolSessionEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<ZCodeSessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  const visibleEvents: ZCodeSessionEvent[] = [];
  const toolInputTransmissions: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  let pendingStreamingDeltaBatch: ProtocolStreamingDeltaBatch | undefined;
  const flushedFirstDeltaBatchKeys = new Set<string>();
  const lastFlushAtByBatchKey = new Map<string, number>();
  const pushMappedEvent = (event: SessionEvent): void => {
    const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind, {
      toolInputTransmissions,
    });
    if (!mappedEvent) return;
    if (options.afterSeq !== undefined && mappedEvent.seq <= options.afterSeq) return;
    visibleEvents.push(mappedEvent);
  };
  const flushPendingStreamingDeltaBatch = (): void => {
    if (!pendingStreamingDeltaBatch) {
      return;
    }
    rememberProtocolStreamingDeltaBatchFlush(lastFlushAtByBatchKey, pendingStreamingDeltaBatch);
    pushMappedEvent(materializeProtocolStreamingDeltaBatch(pendingStreamingDeltaBatch));
    pendingStreamingDeltaBatch = undefined;
  };
  const resetPendingStreamingDeltaBatch = (): void => {
    flushPendingStreamingDeltaBatch();
    flushedFirstDeltaBatchKeys.clear();
    lastFlushAtByBatchKey.clear();
  };
  for (const event of events) {
    if (
      shouldHideProtocolSessionEvent(record, event) ||
      !shouldExposeSessionEventToProtocol(event)
    ) {
      resetPendingStreamingDeltaBatch();
      pushMappedEvent(event);
      continue;
    }
    const deltaInfo = readStreamingDeltaBatchableEvent(event);
    if (deltaInfo) {
      if (
        pendingStreamingDeltaBatch &&
        pendingStreamingDeltaBatch.batchKey !== deltaInfo.batchKey
      ) {
        flushPendingStreamingDeltaBatch();
      }
      pendingStreamingDeltaBatch = mergeProtocolStreamingDeltaBatch(
        pendingStreamingDeltaBatch,
        event,
        deltaInfo,
      );
      if (deltaInfo.shouldFlushFirstDelta && !flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)) {
        flushPendingStreamingDeltaBatch();
        flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
        continue;
      }
      if (
        pendingStreamingDeltaBatch.delta.length >= pendingStreamingDeltaBatch.maxChars ||
        shouldFlushProtocolStreamingDeltaBatchForInterval(
          pendingStreamingDeltaBatch,
          lastFlushAtByBatchKey,
        )
      ) {
        flushPendingStreamingDeltaBatch();
      }
      continue;
    }
    resetPendingStreamingDeltaBatch();
    pushMappedEvent(event);
  }
  flushPendingStreamingDeltaBatch();
  return options.limit ? visibleEvents.slice(-options.limit) : visibleEvents;
}

async function getProtocolEventSeq(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): Promise<number> {
  await readProtocolSessionEvents(context, record, deliveryKind);
  return getProtocolEventSequenceState(record, deliveryKind).lastSeq;
}

function logProtocolSessionEventSent(
  context: ZCodeProtocolAgentServerContext,
  sourceEvent: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
): void {
  const payload =
    typeof mappedEvent.payload === "object" && mappedEvent.payload !== null
      ? (mappedEvent.payload as Record<string, unknown>)
      : {};
  const protocolMessage = {
    method: "session/event",
    params: mappedEvent,
  };
  context.logger?.debug("ZCode Protocol session event sent", {
    deliveryKind: mappedEvent.deliveryKind,
    event: "zcode_protocol.session_event.sent",
    eventId: mappedEvent.eventId,
    method: "session/event",
    module: "bootstrap.zcode_protocol",
    payloadKeys: Object.keys(payload).sort(),
    payloadKind: typeof payload.kind === "string" ? payload.kind : undefined,
    payloadSummary: summarizeProtocolPayload(payload),
    protocolMessageBytes: measureJsonBytes(protocolMessage),
    protocolPayloadBytes: measureJsonBytes(mappedEvent.payload),
    protocolEventType: mappedEvent.type,
    protocolSeq: mappedEvent.seq,
    sessionEventSequenceNumber: sourceEvent.sequenceNumber,
    sessionEventType: sourceEvent.type,
    sessionId: mappedEvent.sessionId,
    turnId: mappedEvent.turnId,
  });
}

function summarizeProtocolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  copyStringFields(summary, payload, [
    "action",
    "anchorId",
    "assistantMessageId",
    "inputId",
    "kind",
    "queryId",
    "reason",
    "requestId",
    "resultPartId",
    "source",
    "status",
    "taskId",
    "terminalId",
    "toolCallId",
    "toolName",
  ]);
  copyBooleanFields(summary, payload, ["concurrentSafe", "destructive", "done", "readOnly"]);
  copyNumberFields(summary, payload, [
    "durationMs",
    "elapsedMs",
    "outputBytes",
    "stderrBytes",
    "stdoutBytes",
    "tokenCount",
    "toolCallCount",
  ]);
  copyByteLength(summary, payload, "content", "contentBytes");
  copyByteLength(summary, payload, "delta", "deltaBytes");
  copyByteLength(summary, payload, "input", "inputBytes");
  copyByteLength(summary, payload, "outputTail", "outputTailBytes");
  copyByteLength(summary, payload, "previousTarget", "previousTargetBytes");
  copyByteLength(summary, payload, "response", "responseBytes");
  copyByteLength(summary, payload, "result", "resultBytes");
  copyByteLength(summary, payload, "stderrTail", "stderrTailBytes");
  copyByteLength(summary, payload, "stdoutTail", "stdoutTailBytes");
  copyByteLength(summary, payload, "target", "targetBytes");
  copyObjectKeySummary(summary, payload, "input", "input");
  copyObjectKeySummary(summary, payload, "requestHeaders", "requestHeader");
  copyObjectKeySummary(summary, payload, "responseHeaders", "responseHeader");
  copyObjectKeySummary(summary, payload, "result", "result");
  copySmallObject(summary, payload, "usage");
  copyContextUsageBreakdownSummary(summary, payload);
  return summary;
}

function copyStringFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      target[key] = value;
    }
  }
}

function copyBooleanFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      target[key] = value;
    }
  }
}

function copyNumberFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] = value;
    }
  }
}

function copyByteLength(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  if (source[sourceKey] !== undefined) {
    target[targetKey] = measureJsonBytes(source[sourceKey]);
  }
}

function copyObjectKeySummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetPrefix: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const keys = Object.keys(value).sort();
  target[`${targetPrefix}KeyCount`] = keys.length;
  target[`${targetPrefix}Keys`] = keys.slice(0, 20);
}

function copySmallObject(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (measureJsonBytes(value) <= 1024) {
    target[sourceKey] = value;
  }
}

function copyContextUsageBreakdownSummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  const value = source.contextUsageBreakdown;
  if (!Array.isArray(value)) {
    return;
  }
  target.contextUsageBreakdownCount = value.length;
  target.contextUsageBreakdownSources = value
    .map((item) => asRecord(item).source)
    .filter((source): source is string => typeof source === "string")
    .slice(0, 20);
}

function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

function slugifyImportedSession(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug.length > 0 ? slug : "imported-session";
}

function isImportedHistoryMessage(
  message: MessageWithParts,
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"],
): boolean {
  const messageId = String(message.info.id);
  if (/^msg_import_\d+$/u.test(messageId) || messageId.startsWith("msg_claude-import-")) {
    return true;
  }
  const messageMetadata = asRecord((message.info as unknown as { metadata?: unknown }).metadata);
  if (messageMetadata.migrationSource === source) {
    return true;
  }
  return message.parts.some((part) => {
    const partMetadata = asRecord((part as unknown as { metadata?: unknown }).metadata);
    return partMetadata.migrationSource === source;
  });
}

async function removePreviousImportedSessionHistory(params: {
  sessionStore: NonNullable<ZCodeProtocolAgentServerContext["deps"]["sessionStore"]>;
  sessionId: SessionId;
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"];
}): Promise<number> {
  const existingMessages = await params.sessionStore.messages({
    sessionID: params.sessionId,
  });
  let removedCount = 0;
  for (const message of existingMessages) {
    if (!isImportedHistoryMessage(message, params.source)) {
      continue;
    }
    // The old import reused globally fixed ids like msg_import_0/msg_import_1. A second
    // import session's saveMessage upsert re-bound the first session's messages over,
    // keeping the old time_created — sessions leaked messages into each other, ordering
    // flipped, or recovery came up empty. Before re-importing, clear only the current
    // session's migration messages and keep real messages the user continued in the imported session.
    await params.sessionStore.removeMessage({
      sessionID: params.sessionId,
      messageID: message.info.id,
    });
    removedCount += 1;
  }
  return removedCount;
}

async function persistImportedSessionHistory(params: {
  context: ZCodeProtocolAgentServerContext;
  record: ZCodeProtocolSessionRecord;
  sessionId: SessionId;
  createParams: ZCodeSessionCreateParams;
}): Promise<void> {
  const importedHistory = params.createParams.importedHistory;
  const sessionStore = params.context.deps.sessionStore;
  if (!importedHistory) return;
  if (!sessionStore) {
    throw new ProtocolRequestError(-32003, "Cannot import session history without session store");
  }

  const workspace = params.record.workspace;
  const workspaceIdentity = workspace.workspaceIdentity?.trim();
  const now = Date.now();
  const createdAt =
    importedHistory.createdAt ??
    (importedHistory.source === "claudeCode"
      ? importedHistory.messages[0]?.timestamp
      : undefined) ??
    now;
  const updatedAt =
    importedHistory.source === "claudeCode"
      ? (importedHistory.updatedAt ?? importedHistory.messages.at(-1)?.timestamp ?? createdAt)
      : createdAt;
  // History imports run no model; when unbound, message content is kept — do not demand a current selection or fabricate message origins.
  const currentModel = optionalModelSelectionFromString(params.record.app.getModel());
  const providerId = currentModel?.providerId as ModelProviderId | undefined;
  const modelId = currentModel?.modelId as ModelId | undefined;

  if (importedHistory.source === "sharedContext") {
    if (!sessionStore.commitSharedContextImportBundle) {
      throw new ProtocolRequestError(
        -32003,
        "Shared context import requires atomic session storage",
      );
    }
    const messageId = createMessageId(`${params.sessionId}_shared_context`);
    const importedAt = importedHistory.createdAt ?? now;
    const contextId =
      importedHistory.provenance.contextId ?? `legacy-shared-context-${params.sessionId}`;
    const contextStatus = importedHistory.provenance.status ?? "pending";
    await sessionStore.commitSharedContextImportBundle({
      session: {
        id: params.sessionId,
        projectID: projectIdFromDirectory(workspace.workspacePath),
        workspaceID: workspaceIdentity as WorkspaceId | undefined,
        traceID: params.record.traceContext.traceId,
        slug: slugifyImportedSession(params.sessionId),
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        // The app.resume() after this import marks the runtime persisted, so first-send
        // persistence never writes the profile: the import write must carry it (set-once).
        incognito: params.createParams.incognito,
        title: importedHistory.title,
        titleSource: "custom",
        version: params.context.deps.version ?? "0.0.0",
        permission: { mode: params.record.app.getMode() },
        time: { created: importedAt, updated: importedAt },
      },
      contextMessage: {
        info: {
          id: messageId,
          sessionID: params.sessionId,
          role: "user",
          time: { created: importedAt },
          agent: "zcode-agent",
          // The merged new share-import path still used the old model field, referencing a
          // dead variable and losing the unbound semantics.
          // It shares the ordinary import's structured-selection contract; imports do not require an executable model.
          ...(currentModel ? { modelSelection: currentModel } : {}),
          synthetic: true,
          source: "shared_context",
          visibility: "model-only",
          semantics: {
            origin: "import",
            kind: "shared_context",
            source: "conversation_share",
            uiVisibility: "hidden",
            providerVisibility: "visible",
            transcriptVisibility: "visible",
          },
          metadata: {
            shareId: importedHistory.provenance.shareId,
            contextId,
            sharedContextStatus: contextStatus,
          },
        },
        parts: [
          {
            id: createPartId(`${params.sessionId}_shared_context_text`),
            sessionID: params.sessionId,
            messageID: messageId,
            type: "text",
            text: importedHistory.markdown,
            time: { start: importedAt, end: importedAt },
            metadata: { sharedContext: true },
          },
        ],
      },
      provenance: {
        // session_entry.id is a whole-DB primary key (same class of fix as the fork command
        // fact in sqlite-session-store.ts); the old template contained only shareId. When the
        // same share was imported into a second workspace, the (shareCode, workspaceKey)
        // dedup missed and the markers each sat under their own workspace without conflict,
        // so saveSessionEntry's on conflict(id) re-bound the first session's provenance to
        // the new session and the old session's shared-context record silently vanished.
        // Verified: all reads go through (session_id, type) + data.contextId; none look up by
        // id, so old and new ids coexist safely — no data migration needed.
        id: `v4_shared_context_import:${params.sessionId}:${importedHistory.provenance.shareId}`,
        sessionID: params.sessionId,
        type: "v4/shared_context_import",
        time: { created: importedAt, updated: importedAt },
        data: {
          ...importedHistory.provenance,
          contextId,
          status: contextStatus,
        },
      },
    });
    return;
  }

  await sessionStore.createSession({
    id: params.sessionId,
    projectID: projectIdFromDirectory(workspace.workspacePath),
    // The imported session is resumed immediately after creation; the current identity must be persisted first so recovery does not degrade to path isolation.
    workspaceID: workspaceIdentity as WorkspaceId | undefined,
    traceID: params.record.traceContext.traceId,
    slug: slugifyImportedSession(params.sessionId),
    directory: workspace.workspacePath,
    path: workspace.workspacePath,
    // Same constraint as the shared-context bundle above: the resume that follows this write
    // suppresses first-send persistence, so the profile must land here.
    incognito: params.createParams.incognito,
    title: importedHistory.title?.trim() || "Imported session",
    titleSource: "custom",
    version: params.context.deps.version ?? "0.0.0",
    permission: {
      mode: params.record.app.getMode(),
    },
    time: {
      created: createdAt,
      updated: Math.max(createdAt, updatedAt),
    },
  });

  const removedMessageCount = await removePreviousImportedSessionHistory({
    sessionStore,
    sessionId: params.sessionId,
    source: importedHistory.source,
  });
  let lastUserMessageId: MessageId | undefined;
  let lastImportedMessageTimestamp = createdAt - 1;
  for (const [index, message] of importedHistory.messages.entries()) {
    const rawTimestamp = message.timestamp ?? createdAt + index;

    // The sessionStore reads messages ordered by time_created; if an assistant precedes its
    // user in time, the UI renders the imported session with assistant above user. The import
    // boundary treats array order as truth: converge timestamps to monotonically increasing
    // just before writing, keeping message content and roles unchanged.
    const timestamp =
      rawTimestamp > lastImportedMessageTimestamp ? rawTimestamp : lastImportedMessageTimestamp + 1;
    lastImportedMessageTimestamp = timestamp;
    const messageId = createMessageId(`${params.sessionId}_import_${index}`);
    if (message.role === "user") {
      lastUserMessageId = messageId;
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "user",
        time: { created: timestamp },
        agent: "zcode-agent",
        ...(currentModel ? { modelSelection: currentModel } : {}),
        metadata: { migrationSource: importedHistory.source },
      });
    } else {
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "assistant",
        time: { created: timestamp, completed: timestamp },
        parentID:
          lastUserMessageId ?? createMessageId(`${params.sessionId}_import_parent_${index}`),
        ...(currentModel ? { modelId, providerId } : {}),
        mode: params.record.app.getMode(),
        agent: "zcode-agent",
        path: {
          cwd: workspace.workspacePath,
          root: workspace.workspacePath,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: "stop",
      });
    }
    await sessionStore.savePart({
      id: createPartId(`${params.sessionId}_import_${index}_text`),
      sessionID: params.sessionId,
      messageID: messageId,
      type: "text",
      text: message.content,
      time: { start: timestamp, end: timestamp },
      metadata: { migrationSource: importedHistory.source },
    });
  }

  params.context.logger?.info("ZCode Protocol imported history persisted", {
    event: "zcode_protocol.session_import.persisted",
    messageCount: importedHistory.messages.length,
    module: "bootstrap.zcode_protocol",
    removedMessageCount,
    sessionId: params.sessionId,
    source: importedHistory.source,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
}

export async function createSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace?: ZCodeProtocolTrace,
) {
  return createSessionWithProjection(context, rawParams, trace, async (record) => {
    const result = await snapshotWithDiagnostics(context, record);
    return {
      value: result.snapshot,
      phaseDurationsMs: result.phaseDurationsMs,
      messageCount: result.snapshot.messages.length,
    };
  });
}

/** V4 creation needs only the record; do not force-parse an empty model for a discarded legacy snapshot. */
export async function createSessionRecordForV4(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  preparedSessionId?: string,
) {
  return createSessionWithProjection(
    context,
    rawParams,
    undefined,
    async (record) => ({
      value: { sessionId: record.app.sessionId },
    }),
    preparedSessionId,
  );
}

async function createSessionWithProjection<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
  preparedSessionId?: string,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const sessionId = (preparedSessionId ?? params.sessionId ?? createSessionId()) as SessionId;
  const claims = (context.sessionCreationIds ??= new Set<string>());
  // A Host reservation only decides identity and ownership; it cannot override CLI sessions
  // that already exist, are soft-deleted, or are being created.
  // Claim the id before any await so native and V4 cannot concurrently materialize the same runtime.
  if (context.sessions.has(sessionId) || claims.has(sessionId))
    throw new ProtocolRequestError(-32602, "sessionId already exists");
  claims.add(sessionId);
  try {
    // A prepared id is validated by the V4 bridge and already has its durable session row.
    if (!preparedSessionId && await context.deps.sessionStore?.getSession(sessionId))
      throw new ProtocolRequestError(-32602, "sessionId already exists");
    let result!: T;
    await getSessionLifecycle(context).initialize(sessionId, async () => {
      result = await materializeCreatedSession(context, { ...params, sessionId }, trace, project);
    });
    return result;
  } finally {
    claims.delete(sessionId);
  }
}

async function materializeCreatedSession<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const startedAt = Date.now();
  const sessionId = params.sessionId! as SessionId;
  const workspace = params.workspace;
  context.logger?.info("ZCode Protocol session/create started", {
    event: "zcode_protocol.session_create.started",
    hasInitialModel: params.model !== undefined,
    hasInitialThoughtLevel: params.thoughtLevel !== undefined,
    inboundTraceId: trace?.traceId,
    module: "bootstrap.zcode_protocol",
    persistence: params.persistence,
    sessionId,
    status: "started",
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  const recordStartedAt = Date.now();
  const record = await materializeSessionRecord(
    context,
    { ...params, workspace },
    sessionId,
    false,
    { kind: "host" },
    trace,
  );
  const recordCreateDurationMs = Date.now() - recordStartedAt;
  context.assertServing?.();
  let setInitialModelDurationMs: number | undefined;
  let setInitialThoughtLevelDurationMs: number | undefined;
  let snapshotDurationMs = 0;
  let snapshotPhaseDurationsMs: SnapshotPhaseDurationsMs | undefined;
  const initialModel = params.model;
  const initialThoughtLevel = params.thoughtLevel;
  try {
    await runSessionModelConfigMutation(record.app, async () => {
      if (initialModel) {
        const setInitialModelStartedAt = Date.now();
        await record.app.setModel(formatProtocolModelSelection(initialModel));
        setInitialModelDurationMs = Date.now() - setInitialModelStartedAt;
        record.stateRevision++;
      }
      const supportedInitialThoughtLevel = resolveSupportedAppThoughtLevel(
        record.app,
        initialThoughtLevel,
      );
      if (supportedInitialThoughtLevel) {
        // The app has taken over default model/thinking-depth persistence; session/create
        // passes thoughtLevel explicitly.
        // Workspace Preferences must be read from persistence: reading only Agent memory
        // loses the user's last choice after a restart.
        const setInitialThoughtLevelStartedAt = Date.now();
        await record.app.setThoughtLevel(supportedInitialThoughtLevel);
        setInitialThoughtLevelDurationMs = Date.now() - setInitialThoughtLevelStartedAt;
        record.stateRevision++;
      } else if (initialThoughtLevel) {
        // The workspace default thoughtLevel may come from a previous model. When a new
        // session inherits a different model, an unsupported tier must not be forced onto the
        // runtime, or creation throws Unsupported reasoning effort.
        context.logger?.warn("ZCode Protocol session/create skipped unsupported thought level", {
          event: "zcode_protocol.session_create.thought_level_skipped",
          module: "bootstrap.zcode_protocol",
          requestedThoughtLevel: initialThoughtLevel,
          sessionId,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
        });
      }
    });
    if (params.importedHistory) {
      // History imports used to write only a legacy snapshot; the taskId was not a real
      // protocol sessionId, and setModel/sendPrompt hit a nonexistent runtime. The history is
      // now written to the sessionStore and resumed at creation, so the import is a
      // continuable, model-switchable ZCode session from the first moment.
      await persistImportedSessionHistory({
        context,
        record,
        sessionId,
        createParams: params,
      });
      await record.app.resume();
      record.stateRevision++;
    }
    const snapshotStartedAt = Date.now();
    const createdSnapshotResult = await project(record);
    const createdSnapshot = createdSnapshotResult.value;
    snapshotPhaseDurationsMs = createdSnapshotResult.phaseDurationsMs;
    snapshotDurationMs = Date.now() - snapshotStartedAt;
    context.logger?.info("ZCode Protocol session/create completed", {
      durationMs: Date.now() - startedAt,
      event: "zcode_protocol.session_create.completed",
      hasInitialModel: initialModel !== undefined,
      hasInitialThoughtLevel: initialThoughtLevel !== undefined,
      messageCount: createdSnapshotResult.messageCount,
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "completed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    context.assertServing?.();
    return createdSnapshot;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/create failed", {
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.session_create.failed",
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "failed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    // A failed creation keeps no temporary projection; a failed recovery's historical projection is managed by the gateway itself.
    context.v4Gateway?.disposeSession(sessionId);
    // The lifecycle owner cleans up half-initialized instances uniformly; do not swallow a close failure and then allow creating again.
    throw error;
  }
}

export interface ActivatedSessionForResume {
  record: ZCodeProtocolSessionRecord;
  knownSession?: SessionInfo;
  /** Used only to start this V4 hydration; not written into the record or cached across requests. */
  persistedMessages?: MessageWithParts[];
}

/** Tears down only this failed record; persistent history and the gateway publisher are not deleted. */
export async function discardFailedSessionResume(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (context.sessions.get(sessionId) !== record) return;
  await discardSessionRuntime(context, sessionId);
}

/**
 * Restores only the session runtime lifecycle; materializes no protocol representation.
 *
 * V4 cold subscriptions used to reuse resumeSession — the return value was discarded, yet a
 * full legacy snapshot was still built for large histories. Runtime activation and the legacy
 * representation are two responsibilities; this keeps the original order and side effects from
 * before the snapshot so V4 hydrates afterwards with its own durable projection.
 */
export async function activateSessionForResume(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionResumeParams,
  options: { reusePersistedMessages?: boolean; persistedMessages?: MessageWithParts[] } = {},
): Promise<ActivatedSessionForResume> {
  let activated: ActivatedSessionForResume | undefined;
  await getSessionLifecycle(context).initialize(params.sessionId, async () => {
    activated = await activateSessionRuntime(context, params, options);
  });
  const record = activated?.record ?? context.sessions.get(params.sessionId);
  if (!record) throw new Error("Session runtime unavailable after initialization");
  return activated ?? { record };
}

/** The lifecycle owner's dedicated init surface; external recovery must call activateSessionForResume. */
export async function activateSessionRuntime(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionResumeParams,
  options: { reusePersistedMessages?: boolean; persistedMessages?: MessageWithParts[] } = {},
): Promise<ActivatedSessionForResume> {
  const resumeStartedAt = Date.now();
  const activeBeforeWait = context.sessions.has(params.sessionId);
  context.logger?.debug("ZCode Protocol session resume started", {
    activeBeforeWait,
    event: "zcode_protocol.session.resume_started",
    hasSessionStore: Boolean(context.deps.sessionStore),
    module: "bootstrap.zcode_protocol",
    sessionId: params.sessionId,
  });
  const existing = context.sessions.get(params.sessionId);
  if (existing) {
    return { record: existing };
  }
  let session = await getPersistedSession(context, params.sessionId);
  if (!session || session.time.deleted !== undefined) {
    // Diagnostics: cold recovery only reaches here when even the persisted record is missing;
    // the error text alone cannot be distinguished from readSession's "runtime not yet
    // active", so both layers' states and the wait duration are logged.
    context.logger?.warn("ZCode Protocol session resume found no persisted record", {
      activeBeforeWait,
      activeSessionCount: context.sessions.size,
      durationMs: Math.max(0, Date.now() - resumeStartedAt),
      event: "zcode_protocol.session.resume_persisted_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  session = await repairLegacyRemoteSessionWorkspaceForResume(context, session);
  const workspace =
    params.workspace ??
    buildWorkspaceRef({
      // A V4 cold subscription of a historical session passes only sessionId; if a remote
      // session rebuilt its workspace here from the directory alone, identity would degrade
      // to a path key, miss the workspaceID-isolated provider registry, misjudge usable
      // models as unavailable, and trip restoreWarning forever.
      workspaceIdentity: session.workspaceID,
      workspacePath: session.path ?? session.directory,
    });
  let persistedMessages =
    options.persistedMessages ?? (await readPersistedSessionMessages(context, params.sessionId));
  const mode = derivePersistedSessionMode(persistedMessages);
  // Shell setting changes affect new sessions only; a cold recovery must use the Bash shell
  // snapshot persisted at creation. runtime.resumeFromStore reads the snapshot; this side's
  // only job is not re-injecting the resume request's current settings into the old session.
  const record = await materializeSessionRecord(
    context,
    {
      ...params,
      mode,
      incognito: session.incognito,
      ...(session.executionDirectory
        ? {
            executionWorktree: {
              path: session.executionDirectory,
              ...(session.executionBranch ? { branchName: session.executionBranch } : {}),
            },
          }
        : {}),
      // Restore the model only through the app's one-way migration/current entry; do not first create
      // a selection from a message or caller hint.
      model: undefined,
      ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
      // resume previously dropped persisted taskType, so createRecord fell back to the default
      // "interactive". Resumed workflow_child/subagent_child sessions then passed the
      // isTaskListSessionType filter and leaked into sessions-index via getSessionWorkspaceId. The
      // Desktop task list showed fake "workflow actor actor#N@k" tasks, and the task-index syncer
      // repeatedly sent session/resume for them. The fork path already preserves taskType; resume
      // must do the same.
      taskType: session.taskType,
      workspace,
    },
    params.sessionId as SessionId,
    true,
    { kind: "host" },
    session.traceID ? { traceId: session.traceID } : undefined,
  );
  // createRecord hardcodes createdAt/updatedAt to Date.now() — resuming an old session made
  // sessions-index treat it as "just created" (combined with the empty pre-hydration title,
  // the sidebar showed the original session vanish and a "new task just now" appear). The
  // recovery path backfills the store's real times.
  if (session.time?.created) record.createdAt = session.time.created;
  if (session.time?.updated) record.updatedAt = session.time.updated;
  record.lastOutcome = session.lastOutcome;
  context.assertServing?.();
  const resumeResult = await runSessionModelConfigMutation(record.app, async () => {
    const result = options.reusePersistedMessages
      ? await record.app.resume({ persistedMessages })
      : await record.app.resume();
    // Used only as the first projection seed, holding a valid model + empty tier; it is not a second executable Runtime selection.
    record.restoredModelSelection = result.modelSelection;
    return result;
  });
  if (options.reusePersistedMessages && resumeResult.persistedMessagesReloadRequired) {
    persistedMessages = await readPersistedSessionMessages(context, params.sessionId);
  }
  context.logger?.info("ZCode Protocol session resume completed", {
    activeSessionCount: context.sessions.size,
    durationMs: Math.max(0, Date.now() - resumeStartedAt),
    event: "zcode_protocol.session.resume_completed",
    module: "bootstrap.zcode_protocol",
    persistedMessageCount: persistedMessages.length,
    sessionId: params.sessionId,
    traceId: record.traceContext.traceId,
  });
  context.assertServing?.();
  return {
    knownSession: session,
    record,
    ...(options.reusePersistedMessages ? { persistedMessages } : {}),
  };
}

export async function resumeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionResumeParamsSchema, rawParams);
  const activated = await activateSessionForResume(context, params);
  return await snapshot(context, activated.record, activated.knownSession);
}

async function repairLegacyRemoteSessionWorkspaceForResume(
  context: ZCodeProtocolAgentServerContext,
  session: SessionInfo,
): Promise<SessionInfo> {
  if (session.workspaceID || !context.deps.sessionStore?.repairLegacyRemoteSessionWorkspace) {
    return session;
  }
  const legacyWorkspaceDirectory = session.path ?? session.directory;
  if (session.directory !== legacyWorkspaceDirectory) return session;
  const legacyRemote = resolveLegacyRemoteWorkspace(context, legacyWorkspaceDirectory);
  if (!legacyRemote) return session;

  const repaired = await context.deps.sessionStore.repairLegacyRemoteSessionWorkspace({
    sessionID: session.id,
    projectID: projectIdFromDirectory(legacyRemote.workspacePath),
    legacyWorkspaceDirectory,
    workspaceID: legacyRemote.workspaceIdentity,
    workspacePath: legacyRemote.workspacePath,
  });
  // After an atomic repair returned false, the runtime was still materialized with the old
  // directory/path and ended up executing tools in the wrong cwd. This must read the original
  // persisted facts — an in-memory path repair for an existing identity must not masquerade as
  // already on disk.
  const refreshed = await context.deps.sessionStore.getSession(session.id);
  const repairPersisted =
    refreshed?.workspaceID === legacyRemote.workspaceIdentity &&
    refreshed.directory === legacyRemote.workspacePath &&
    refreshed.path === legacyRemote.workspacePath;
  if (!repairPersisted) {
    context.logger?.warn("legacy remote session workspace repair was not persisted", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repair_rejected",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      repaired,
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Legacy remote session workspace repair was not persisted",
      {
        context: {
          directory: refreshed?.directory ?? session.directory,
          path: refreshed?.path ?? session.path,
          reason: "legacy_remote_session_workspace_repair_rejected",
          sessionId: session.id,
          workspaceIdentity: legacyRemote.workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }
  if (repaired) {
    context.logger?.info("legacy remote session workspace repaired", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repaired",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
  }
  // Core's resumeFromStore re-reads the DB; a NULL-identity repair must be persisted first, not just fixed in bootstrap memory.
  return refreshed;
}

function resolveLegacyRemoteWorkspace(
  context: ZCodeProtocolAgentServerContext,
  legacyWorkspaceDirectory: string,
): { workspaceIdentity: WorkspaceId; workspacePath: string } | null {
  const currentWorkspacePath = context.deps.cwd ?? process.cwd();
  const direct = parseRemoteWorkspaceIdentity(legacyWorkspaceDirectory);
  if (direct?.kind === "wsl" && direct.workspacePath === currentWorkspacePath) {
    return {
      workspaceIdentity: legacyWorkspaceDirectory as WorkspaceId,
      workspacePath: direct.workspacePath,
    };
  }

  const identityPrefix = currentWorkspacePath === "/" ? "/" : `${currentWorkspacePath}/`;
  if (!legacyWorkspaceDirectory.startsWith(identityPrefix)) return null;
  const embeddedIdentity = legacyWorkspaceDirectory.slice(identityPrefix.length);
  const embedded = parseRemoteWorkspaceIdentity(embeddedIdentity);
  if (
    embedded?.kind !== "wsl" ||
    `${identityPrefix}${embeddedIdentity}` !== legacyWorkspaceDirectory ||
    embedded.workspacePath !== currentWorkspacePath
  ) {
    return null;
  }

  // Accepts only the exact form spelled by the current app-server cwd; no fuzzy search for the remote: prefix in arbitrary paths.
  return {
    workspaceIdentity: embeddedIdentity as WorkspaceId,
    workspacePath: embedded.workspacePath,
  };
}

async function resolvePersistedDirectorySession(
  context: ZCodeProtocolAgentServerContext,
  session: SessionInfo,
  workspace: ZCodeWorkspaceRef,
  resolveOwner: boolean,
): Promise<SessionInfo | null> {
  const expectedKey = workspace.workspaceIdentity?.trim() || workspace.workspacePath;
  const visited = new Set<string>();
  let current: SessionInfo | null = session;
  while (current && current.time.deleted === undefined && !visited.has(current.id)) {
    visited.add(current.id);
    const path = current.path || current.directory;
    const key = current.workspaceID?.trim() || path;
    if (path !== workspace.workspacePath) return null;
    const auxiliary = isAuxiliarySessionKind(current.taskType);
    if (key === expectedKey && (!resolveOwner || !auxiliary)) return current;
    // A historical child may lack identity, but ownership can only be proven by a persisted
    // parent chain with the same cwd.
    // An existing explicit external identity, a missing parent chain, or a cyclic one must
    // not guess the project by directory, nor start the parent runtime.
    if (!auxiliary || !current.parentID || (key !== expectedKey && key !== path)) return null;
    current = (await context.deps.sessionStore?.getSession(current.parentID)) ?? null;
  }
  return null;
}

export async function listSessions(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionListParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  // An explicit id query reads persisted identity only, for the Host to repair old indexes; never activates a runtime just to identify a child.
  const candidates = params.sessionIds
    ? await Promise.all(params.sessionIds.map((id) => store?.getSession(id as SessionId) ?? null))
    : store
      ? await store.listSessions({
          directory: params.workspace?.workspacePath,
          limit: params.limit ?? 50,
          taskTypes: [...TASK_LIST_SESSION_TYPES],
        })
      : [];
  const scoped = await Promise.all(
    candidates.map(async (session) => {
      if (!session || session.time.deleted !== undefined) return null;
      const includeDirectorySource = Boolean(
        params.sessionIds && context.sessionDirectorySourceEnabled,
      );
      const source = params.workspace
        ? await resolvePersistedDirectorySession(
            context,
            session,
            params.workspace,
            includeDirectorySource,
          )
        : session;
      if (!source) return null;
      return {
        session,
        directorySessionId:
          includeDirectorySource && params.workspace ? String(source.id) : undefined,
      };
    }),
  );
  const stored = scoped.filter((entry) => entry !== null);
  const storedIds = new Set(stored.map(({ session }) => String(session.id)));
  const sessions = stored.map(({ session, directorySessionId }) => ({
    ...mapSessionInfo({
      session,
      workspace:
        params.workspace ?? buildWorkspaceRef({ workspacePath: session.path ?? session.directory }),
    }),
    ...(directorySessionId ? { directorySessionId } : {}),
  }));
  if (params.sessionIds) return { sessions };
  for (const record of context.sessions.values()) {
    if (record.persistence === "deferred") continue;
    if (!isTaskListSessionType(record.taskType)) continue;
    if (storedIds.has(record.app.sessionId)) continue;
    if (params.workspace && params.workspace.workspaceKey !== record.workspace.workspaceKey)
      continue;
    sessions.push(
      mapSessionInfo({
        app: record.app,
        workspace: record.workspace,
        taskType: record.taskType,
        parentSessionId: record.parentSessionId,
      }),
    );
  }
  return { sessions };
}

export async function listSessionSubagents(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  persistedMessages?: MessageWithParts[],
) {
  const params = parseParams(zcodeSessionSubagentsParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  const liveParent = context.sessions.get(params.sessionId);
  if (!store) {
    return {
      revision: liveParent?.stateRevision ?? 0,
      childSessionIds: [],
      running: [],
      ended: { total: 0, items: [] },
    };
  }

  const parentSession = await store.getSession(params.sessionId as SessionId);
  if (!parentSession) {
    // Diagnostics: hydrate reuses the child-task seed read; if the task index or an old ACP
    // task left an invalid id behind, this wraps "persisted record missing" into v4.hydrate —
    // log the call stage instead of relying on error text alone.
    context.logger?.warn("ZCode Protocol session subagents has no persisted parent", {
      activeSessionCount: context.sessions.size,
      activeSession: Boolean(liveParent),
      event: "zcode_protocol.session.persisted_missing",
      module: "bootstrap.zcode_protocol",
      operation: "session_subagents",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  const messages = persistedMessages ?? (await store.messages({ sessionID: parentSession.id }));
  const parentEvents = liveParent
    ? await liveParent.eventStore.getEvents(parentSession.id).catch(() => [])
    : [];
  const childSessionIds = collectSubagentChildSessionIds(parentSession, messages, parentEvents);
  const childEntries = await Promise.all(
    childSessionIds.map(async (childSessionId) => {
      const childSession = await store.getSession(childSessionId as SessionId);
      if (!childSession || childSession.taskType !== "subagent_child") return null;
      const childMessages = await store.messages({
        sessionID: childSession.id,
      });
      const liveChild = context.sessions.get(childSessionId);
      const childProjection = liveChild
        ? await liveChild.app.runtime.getProjection().catch(() => undefined)
        : undefined;
      return { childMessages, childProjection, childSession, childSessionId };
    }),
  );
  const persistedChildren = childEntries.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  const parentProjection = liveParent
    ? await liveParent.app.runtime.getProjection().catch(() => undefined)
    : undefined;
  const projection = projectSessionSubagents({
    revision: liveParent?.stateRevision ?? parentSession.time.updated,
    parentSession,
    messages,
    childSessionsById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childSession]),
    ),
    childMessagesById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childMessages]),
    ),
    childProjectionsById: new Map(
      persistedChildren.flatMap((entry) =>
        entry.childProjection ? [[entry.childSessionId, entry.childProjection]] : [],
      ),
    ),
    ...(parentProjection ? { parentProjection } : {}),
    ...(parentEvents.length > 0 ? { parentEvents } : {}),
  });
  const ended = paginateEndedSubagents(projection.ended, {
    cursor: params.endedCursor,
    limit: params.endedLimit,
  });
  return {
    revision: projection.revision,
    childSessionIds: persistedChildren.map((entry) => entry.childSessionId),
    running: projection.running,
    ended: {
      total: projection.ended.length,
      items: ended.items,
      ...(ended.nextCursor ? { nextCursor: ended.nextCursor } : {}),
    },
  };
}

export async function getUsageStats(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeUsageStatsParamsSchema, rawParams ?? {});
  // SessionStorePort and UsageStorePort are separate interfaces, but the actual store implements
  // both. Use the runtime narrowing pattern from core/usage-observability to access the read-only
  // aggregate method.
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  return runUsageStats(usageStore, params, Date.now(), context.logger);
}

export async function readSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionReadParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    deliveryKind: params.deliveryKind,
    operation: "session_read",
  });
  record.deliveryKind = params.deliveryKind ?? record.deliveryKind;
  const result = await snapshot(context, record, undefined, {
    messageLimit: params.messageLimit,
    modelAvailability: "current",
  });
  // A task-index resync needs only title/search text/visibility/status; a full history row
  // can reach ~15MB and saturate host stdio. Build from full first, then trim the large
  // payloads so index-derived fields stay consistent with full.
  return params.contentProfile === "index" ? elideSessionSnapshotForIndex(result) : result;
}

/**
 * Narrow read of V4 cold-recovery usage: reuses the legacy snapshot's meter computation without mapping a full protocol snapshot.
 */
export async function readSessionContextUsage(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
) {
  const record = context.sessions.get(sessionId);
  if (!record) return undefined;
  const [resolvedPersistedMessages, session, events] = await Promise.all([
    persistedMessages ?? readSessionMessages(context, record),
    getPersistedSession(context, sessionId),
    record.eventStore.getEvents(sessionId as SessionId),
  ]);
  // Keep legacy buildSessionSnapshot's read order: pin persisted facts first, then read the
  // runtime projection. If a first subscription mid-run coincides with ModelComplete/rewind,
  // the narrow read must not pull the projection into a parallel stage and create new
  // cross-watermark combinations.
  const projection = await record.app.runtime.getProjection();
  const messages = projectActiveSessionMessages(
    resolvedPersistedMessages,
    session,
    events.filter((event) => event.type === SessionEventType.RewindTriggered),
  );
  return resolveSessionContextUsage({
    messages,
    persistedContextUsageBreakdownEvents: events,
    projection,
  });
}

export async function readMessages(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionMessagesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const allMessages = await readActiveSessionMessages(context, record);
  const afterMessageIndex = params.afterMessageId
    ? allMessages.findIndex((message) => String(message.info.id) === params.afterMessageId)
    : -1;
  const messages = afterMessageIndex >= 0 ? allMessages.slice(afterMessageIndex + 1) : allMessages;
  return {
    messages: params.limit ? messages.slice(-params.limit) : messages,
  };
}

export async function readEvents(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionEventsParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  return {
    events: await readProtocolSessionEvents(context, record, record.deliveryKind, {
      afterSeq: params.afterSeq,
      limit: params.limit,
    }),
  };
}

export async function subscribeSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSubscribeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  record.deliveryKind = params.deliveryKind;
  // Compatibility guard: the legacy replayable stream has no unsubscribe RPC. Record only a
  // real subscribe here; do not reuse deliveryKind (written by session/read) or an ordinary
  // read would permanently block resident reclamation.
  record.legacyStreamSubscribed = true;
  const events =
    params.afterSeq === undefined
      ? []
      : await readProtocolSessionEvents(context, record, record.deliveryKind, {
          afterSeq: params.afterSeq,
        });
  return {
    eventSeq: await getProtocolEventSeq(context, record, record.deliveryKind),
    events,
    sessionId: params.sessionId,
    snapshot: params.includeSnapshot
      ? await snapshot(context, record, undefined, {
          modelAvailability: "current",
        })
      : undefined,
  };
}

export async function sendPrompt(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSendParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  // The legacy input entry must likewise stay subagent-readonly and cannot bypass V4 user-input admission.
  if (isReadonlyAgentSessionKind(record.taskType)) {
    throw new ProtocolRequestError(-32010, "Subagent sessions are read-only", {
      reasonCode: "guard.subagentReadOnly",
    });
  }
  assertExpectedRevision(record, params.expectedRevision);
  assertExpectedProviderRevision(context, record, params.expectedProviderRevision);
  if (record.activeAbortController) {
    context.logger?.warn("ZCode Protocol session/send rejected: active prompt exists", {
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: params.sessionId,
      textLength: params.content.length,
      workspacePath: record.workspace.workspacePath,
    });
    throw new ProtocolRequestError(-32010, "A prompt is already running for this session");
  }
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  if (record.persistence === "deferred") {
    // An unsent draft session enters neither sqlite; only when the user actually sends the
    // first message is it promoted to an ordinary session, after which list/syncer/task index
    // treat it as a real task.
    record.persistence = "immediate";
  }
  const abortController = new AbortController();
  record.activeAbortController = abortController;
  context.logger?.info("ZCode Protocol session/send accepted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: params.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  const inputId = params.inputId ?? (params.modelSelection ? crypto.randomUUID() : undefined);
  // Legacy attachment payloads also pin this turn's selection through the same canonical
  // intent without mutating the Session first. Only the shared metadata builder is borrowed
  // here (not the V4 ACK/replay entry); sequences without V4 admission keep the existing 0.
  const intent =
    params.modelSelection && inputId
      ? inputIntentMetadata(
          {
            commandId: inputId,
            clientId: "legacy-session-send",
            sessionId: params.sessionId,
            type: "sendText",
            payload: {},
            issuedAt: Date.now(),
          },
          {
            text: params.content,
            requestedDelivery: "startNow",
            modelSelection: params.modelSelection,
          },
        )
      : undefined;
  void runWithSessionResidencyFinalization(record, () =>
    runPromptTurnInBackground(context, record, {
      abortController,
      attachments: params.attachments,
      browserAmbientContext: params.browserAmbientContext,
      inputId,
      intent,
      modelExecution: params.modelExecution
        ? createModelExecutionContext(params.modelExecution)
        : undefined,
      queryId: (params.queryId ?? inputId) as QueryId | undefined,
      content: params.content,
      ...(params.automationId
        ? { automationId: params.automationId }
        : params.offPeakTaskId
          ? {
              offPeakTaskId: params.offPeakTaskId,
              ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
            }
          : {}),
      toolDenylist: params.toolDenylist,
      botDeliveryTarget: params.botDeliveryTarget,
    }),
  ).catch(() => {
    // Background-turn errors degrade through state/event streams; this backstop prevents an unhandled rejection in the protocol process.
  });
  // session/send is only the "submit user input" protocol request; it must not synchronously
  // await a whole model generation.
  // Synchronously waiting for the first token or the whole turn makes >30s requests trip the
  // host timeout and blocks later protocol messages like session/resume and list.
  // ACK immediately on input receipt; the background turn keeps pushing progress via session
  // event/state.updated.
  return afterPromptAccepted(context, record, "prompt_started");
}

export async function compactSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCompactParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  if (activeTurn?.kind === "compact") {
    // A repeated `/compact` is the same session's context-maintenance request; received again
    // mid-compaction it is dropped outright — it must not enter the ordinary prompt/steer
    // queue, nor render as a failed-compaction banner.
    return {
      response: "",
      snapshot: await snapshot(context, record, undefined, {
        modelAvailability: "current",
      }),
      compact: {
        state: "already_running" as const,
        ...(params.inputId ? { inputId: params.inputId } : {}),
      },
    };
  }
  ensureNoActiveTurn(record, "Cannot compact while a prompt is running");
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  const instructions = params.instructions?.trim();
  const command = instructions ? `/compact ${instructions}` : "/compact";
  const abortController = new AbortController();
  // compact's real model request runs in the background, but Stop still interrupts it via
  // record.activeAbortController. Without registering the controller here, the mid-compaction
  // model request would run to its natural end.
  record.activeAbortController = abortController;
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(context, record, {
      abortController,
      command,
      inputId: params.inputId,
    }),
  ).catch(() => {
    // Background compact errors degrade through the compact timeline/state.updated; this backstop prevents unhandled rejections.
  });
  record.stateRevision++;
  record.updatedAt = Date.now();
  const acceptedSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, "compact_started", { status: "running" });
  return {
    response: "",
    snapshot: acceptedSnapshot,
    compact: {
      state: "accepted" as const,
      ...(params.inputId ? { inputId: params.inputId } : {}),
    },
  };
}

async function runCompactTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    command: string;
    inputId?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  context.logger?.info("ZCode Protocol background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt(params.command, {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
    context.logger?.info("ZCode Protocol background compact completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = params.abortController.signal.aborted
      ? "session_compact_cancelled"
      : "session_compact_failed";
    context.logger?.warn("ZCode Protocol background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // After compaction ends, release the active lock before broadcasting state; otherwise a
      // queued prompt or a later `/compact` briefly hits the old controller at the ready boundary.
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

export async function goalSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionGoalParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  // /goal is a goal-state write, not an ordinary prompt; allowing it mid-run (except pause)
  // bypasses the frontend queue and pollutes the current turn.
  // pause is the control-plane command for the user to explicitly stop the active goal and
  // must be able to interrupt the current assistant turn or verifier.
  const goalPauseMayInterruptActiveTurn = params.action === "pause";
  if (!goalPauseMayInterruptActiveTurn) {
    ensureNoActiveTurn(record, "Cannot manage goals while a prompt is running");
  }

  if (
    !record.app.readTarget ||
    !record.app.setTarget ||
    !record.app.updateTargetStatus ||
    !record.app.clearTarget
  ) {
    return {
      response: "Goal management is not available in this client.",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  if (params.action === "show") {
    return {
      response: formatGoalSummary(await record.app.readTarget()),
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  if (params.action === "pause") {
    const activeAbortController = record.activeAbortController;
    const target = await record.app.updateTargetStatus("paused");
    if (target && activeAbortController) {
      context.logger?.info("ZCode Protocol goal pause aborting active turn", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        targetId: target.targetID,
        workspacePath: record.workspace.workspacePath,
      });
      activeAbortController.abort(new Error("ZCode Protocol goal paused"));
    }
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_paused");
    return {
      // pause is a state-control action whose outcome the UI already shows via the goal panel
      // and runtime state; returning "Goal paused Objective..." would render a meaningless
      // assistant bubble and re-expose the goal body.
      response: target ? "" : "No goal to pause.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  if (params.action === "resume") {
    const target = await record.app.updateTargetStatus("active");
    if (!target) {
      return {
        response: "No goal to resume.",
        snapshot: await snapshot(context, record),
        startedTurn: false,
      };
    }
    return await continueGoalAfterChange(context, record, {
      inputId: params.inputId,
      reason: "goal_resumed",
      target,
      title: "Goal resumed",
    });
  }

  if (params.action === "clear") {
    const cleared = await record.app.clearTarget();
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_cleared");
    return {
      response: cleared ? "Goal cleared." : "No goal to clear.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  const objective = params.objective?.trim() ?? "";
  if (objective.length === 0) {
    return {
      response:
        params.action === "replace"
          ? "Usage: /goal replace <objective>"
          : "Usage: /goal <objective>",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  // `/goal new target` typed in the app input is an explicitly submitted new goal; with an
  // existing goal, still demanding replace makes the user think the goal changed while the DB
  // keeps the old one. A repeated set is converged into replace semantics here.
  const replacesExistingGoal =
    params.action === "replace" || Boolean(await record.app.readTarget());

  const target = await record.app.setTarget({ objective, status: "active" });
  return await continueGoalAfterChange(context, record, {
    inputId: params.inputId,
    reason: replacesExistingGoal ? "goal_replaced" : "goal_set",
    target,
    title: "Goal active",
  });
}

export async function forkSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionForkParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  ensureNoActiveTurn(record, "Cannot fork while a prompt is running");
  const forkTarget = await resolveForkTarget(context, record, params.target);
  const parentMode = record.app.getMode();
  const parentModel = record.app.getModel();
  const parentThoughtLevel = record.app.getThoughtLevel();
  const fork = await record.app.forkFromCheckpoint({
    targetCheckpointId: forkTarget.targetCheckpointId,
    targetMessageId: forkTarget.targetMessageId,
  });
  return await registerForkedSession(context, record, fork, {
    runtimeConfig: {
      mode: parentMode,
      model: parentModel,
      thoughtLevel: parentThoughtLevel,
    },
    inheritLatestTarget: true,
  });
}

/**
 * Only registers the child record after core finishes the copy. V4 running forks reuse this
 * host lifecycle but do not enter forkSession's active-turn guard / workspace fork;
 * runtimeConfig can be pinned at the fork point.
 */
export async function registerForkedSession(
  ...args: Parameters<typeof registerForkedSessionRuntime>
) {
  const [context, , fork] = args;
  let result: Awaited<ReturnType<typeof registerForkedSessionRuntime>> | undefined;
  await getSessionLifecycle(context).initialize(fork.forkedSessionId, async () => {
    result = await registerForkedSessionRuntime(...args);
  });
  if (!result) throw new Error("Fork runtime already initialized");
  return result;
}

async function registerForkedSessionRuntime(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Awaited<ReturnType<ZCodeProtocolSessionRecord["app"]["forkFromCheckpoint"]>>,
  options: {
    runtimeConfig: {
      mode: CollaborationMode;
      model: string;
      thoughtLevel?: string;
      followupMode?: "queue" | "guide";
    };
    inheritLatestTarget: boolean;
  },
) {
  const parentMode = options.runtimeConfig.mode;
  const parentModel = options.runtimeConfig.model;
  const parentThoughtLevel = options.runtimeConfig.thoughtLevel;
  const parentFollowupMode = options.runtimeConfig.followupMode;
  const forkedSession = await getPersistedSession(context, fork.forkedSessionId);
  if (!forkedSession) {
    throw new Error(`Persisted child session not found: ${fork.forkedSessionId}`);
  }
  const forkRecord = await materializeSessionRecord(
    context,
    {
      sessionId: fork.forkedSessionId,
      mode: parentMode,
      // History can be copied even if the parent session is unbound; do not choose a default model or
      // parse an empty string just because of the fork.
      model: optionalModelSelectionFromString(parentModel),
      ...(fork.parentSessionId ? { parentSessionId: fork.parentSessionId } : {}),
      incognito: forkedSession.incognito,
      taskType: forkedSession.taskType,
      workspace: record.workspace,
    },
    fork.forkedSessionId as SessionId,
    true,
    { kind: "inherit", parent: record },
  );
  context.assertServing?.();
  await runSessionModelConfigMutation(forkRecord.app, async () => {
    // A fork branches the parent session's running state; copying messages alone would make
    // the new record restore from workspace defaults, so the post-fork current model/mode gets
    // overwritten by the latest default settings. Explicitly inherit the parent's settings
    // before resume.
    if (forkRecord.app.getMode() !== parentMode) {
      await forkRecord.app.setMode(parentMode);
      forkRecord.stateRevision++;
    }
    if (parentModel && forkRecord.app.getModel() !== parentModel) {
      await forkRecord.app.setModel(parentModel);
      forkRecord.stateRevision++;
    }
    if (parentThoughtLevel && forkRecord.app.getThoughtLevel() !== parentThoughtLevel) {
      await forkRecord.app.setThoughtLevel(parentThoughtLevel);
      forkRecord.stateRevision++;
    }
    if (parentFollowupMode && parentFollowupMode !== "queue") {
      await forkRecord.app.setFollowupMode(parentFollowupMode);
      forkRecord.stateRevision++;
    }
  });
  if (options.inheritLatestTarget) {
    await inheritForkedSessionTarget(context, record, forkRecord, fork.forkedSessionId);
  }
  await forkRecord.app.resume();
  context.assertServing?.();
  return {
    forkedSessionId: fork.forkedSessionId,
    parentSessionId: fork.parentSessionId,
    targetMessageId: fork.targetMessageId,
    targetCheckpointId: fork.targetCheckpointId,
    response: fork.response,
    snapshot: await snapshot(context, forkRecord, forkedSession),
  };
}

async function inheritForkedSessionTarget(
  context: ZCodeProtocolAgentServerContext,
  parentRecord: ZCodeProtocolSessionRecord,
  forkRecord: ZCodeProtocolSessionRecord,
  forkedSessionId: string,
) {
  const parentTarget = await parentRecord.app.readTarget();
  if (!parentTarget || !context.deps.sessionStore) {
    return;
  }
  const existingChildTarget = await context.deps.sessionStore.readTarget({
    sessionID: forkedSessionId as SessionId,
  });
  if (existingChildTarget) {
    return;
  }
  if (!context.deps.sessionStore.cloneTargetForFork) {
    return;
  }

  // core fork now copies goal state; bootstrap keeps only the legacy app/fake-app fallback.
  // setTarget must not create a new targetId, or the verifier timeline disconnects from the copied transcript.
  await context.deps.sessionStore.cloneTargetForFork({
    sessionID: forkedSessionId as SessionId,
    source: parentTarget,
    status: parentTarget.status,
  });
  forkRecord.stateRevision++;
  forkRecord.updatedAt = Date.now();
}

async function runPromptTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    intent?: SendInputOptions["intent"];
    modelExecution?: SendInputOptions["modelExecution"];
    attachments?: unknown[];
    browserAmbientContext?: {
      tabCount: number;
      currentUrl?: string;
    };
    inputId?: string;
    queryId?: QueryId;
    content: string;
    toolDenylist?: readonly string[];
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  } & TurnBackgroundAttribution,
): Promise<void> {
  const startedAt = Date.now();
  context.logger?.info("ZCode Protocol background turn started", {
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  let mutationReason = "prompt_completed";
  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolvePromptTurnAutomationId(params);
  const activeOffPeakTaskId = resolvePromptTurnOffPeakTaskId(params);
  const turnToolDisallowlist = buildPromptTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) {
    // Automation identity is accepted only when explicitly injected by Host scheduling
    // dispatch. inputId is a caller-controllable tracking field and must not restore an
    // authorization identity, or an ordinary user turn could forge CronPauseSelf's pause target.
    record.activeAutomationId = activeAutomationId;
  }
  if (activeOffPeakTaskId) {
    // Same-shaped fallback marker for off-peak dispatched turns, letting the offpeak-port reject recursive OffPeakCreate.
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;
  try {
    const admission = await record.app.sendInput(
      {
        attachments: mapProtocolPromptAttachments(params.attachments),
        text: params.content,
      },
      {
        abortSignal: params.abortController.signal,
        intent: params.intent,
        modelExecution: params.modelExecution,
        browserAmbientContext: params.browserAmbientContext,
        inputId: params.inputId,
        queryId: params.queryId,
        // Only the task identity explicitly injected by the Host passes through; inputId is for tracking and idempotency only.
        ...(activeAutomationId
          ? { automationId: activeAutomationId }
          : activeOffPeakTaskId
            ? {
                offPeakTaskId: activeOffPeakTaskId,
                ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
              }
            : {}),
        // The legacy session/send can likewise reuse an active runtime; with only the port
        // rejecting, the model still sees CronCreate and may retry with CronDelete after the
        // failure. The automation turn and the cron task session's subsequent inputs all have
        // them removed directly from this turn's provider tool surface.
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
      },
    );
    // Admission is not the end of the turn. Cleaning up early loses the automation attribution
    // and the Stop controller; the ACK has already been returned by session/send, and the
    // background releases this turn's resources only after real completion.
    if (admission.kind === "rejected") {
      throw new ProtocolRequestError(-32010, `Prompt admission rejected: ${admission.reason}`);
    }
    if (admission.kind === "started_turn") await admission.completion;
    context.logger?.info("ZCode Protocol background turn completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = "prompt_failed";
    context.logger?.warn("ZCode Protocol background turn failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // prompt_completed/prompt_failed is the downstream host queue's ready boundary.
      // The active lock must be released before broadcasting state, or the phone's immediate
      // drain on ready gets rejected by session/send with "A prompt is already running for this session".
      record.activeAbortController = undefined;
      context.logger?.info("ZCode Protocol background turn cleared active controller", {
        durationMs: Date.now() - startedAt,
        inputId: params.inputId,
        sessionId: record.app.sessionId,
        workspacePath: record.workspace.workspacePath,
      });
    }
    record.activeAutomationId = previousAutomationId;
    record.activeOffPeakTaskId = previousOffPeakTaskId;
    // Bug cause: the legacy record is reused across turns; the Bot address must be restored,
    // or scheduled tasks created by a later ordinary UI turn wrongly inherit the previous
    // turn's Bot session.
    record.activeBotDeliveryTarget = previousBotDeliveryTarget;
  }
  await afterStateMutation(context, record, mutationReason);
}

function resolveSessionToolDenylist(
  params: Pick<ZCodeSessionCreateParams, "toolDenylist">,
  workspace: ZCodeWorkspaceRef,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity)) {
    // Bug cause: remote sessions (SSH/WSL/Docker/Server) still injected automationPort, so
    // Cron tools were registered remotely; a remote workspace has no reliable trigger boundary
    // for the local scheduler, so they must be disabled uniformly at session init — UI or
    // prompt-text constraints alone are not enough.
    for (const toolName of REMOTE_AUTOMATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? [...tools] : undefined;
}

function buildPromptTurnToolDisallowlist(
  params: {
    automationId?: string;
    offPeakTaskId?: string;
    inputId?: string;
    toolDenylist?: readonly string[];
  },
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (activeAutomationId) tools.add("CronCreate");
  // Off-peak dispatched turns hide OffPeakCreate (against recursive self-dispatch);
  // read-only OffPeakList stays.
  // Note automation turns do not deny OffPeakCreate — cron turns are allowed (they schedule
  // off-peak tasks by design). SendMessage / Workflow are likewise hidden, matching the V4
  // prompt-turn and core turn-loop-state values.
  if (activeOffPeakTaskId) {
    for (const toolName of OFF_PEAK_EXECUTION_TOOL_DENYLIST) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

function resolvePromptTurnAutomationId(params: { automationId?: string }): string | undefined {
  // Bug cause: inputId can be specified by the session/send caller; a tracking field must not be promoted to an authorization identity.
  return params.automationId?.trim() || undefined;
}

function resolvePromptTurnOffPeakTaskId(params: {
  offPeakTaskId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // Fallback: a resume dispatch's inputId looks like `offpeak-<uuid>:resume:<uuid>` (the first
  // traceId segment has no fixed prefix; the primary signal must be the explicit offPeakTaskId).
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("offpeak-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > "offpeak-".length ? offPeakTaskId : undefined;
}

async function continueGoalAfterChange(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    inputId?: string;
    reason: string;
    target: ProtocolGoalTarget;
    title: string;
  },
) {
  const response = formatGoalChanged(params.title, params.target);
  const isPlanMode = record.app.runtime.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget is a mandatory app capability; whether continuing is possible depends only on the current mode and whether an active turn exists.
  const canContinue = !isPlanMode && !record.activeAbortController;

  if (canContinue) {
    await ensureSessionModelAvailableForNextTurn(context, record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(context, record, {
        abortController,
        inputId: params.inputId,
      }),
    ).catch(() => {
      // Background goal-continuation failures degrade through state/event streams; this backstop prevents unhandled rejections.
    });
  }

  const snapshotAfterGoal = await afterStateMutation(context, record, params.reason);
  return {
    response: isPlanMode ? appendPlanModeGoalContinuationNote(response) : response,
    snapshot: snapshotAfterGoal,
    startedTurn: canContinue,
  };
}

async function runGoalContinuationInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    inputId?: string;
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (record.activeAbortController === params.abortController) {
      // The active lock must be released as soon as the continuation itself ends;
      // snapshot/command discovery is only a later broadcast — holding the lock would make
      // consecutive `/goal` be misjudged as already having an active turn.
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

export async function stopSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionStopParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const hadActivePrompt = Boolean(record.activeAbortController);
  let pausedTarget: ProtocolGoalTarget | null = null;
  context.logger?.info("ZCode Protocol session/stop received", {
    hadActivePrompt,
    sessionId: params.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  if (hadActivePrompt) {
    pausedTarget = await pauseActiveGoalForSessionStop(context, record, {
      sessionId: params.sessionId,
    });
  }
  record.activeAbortController?.abort(new Error("ZCode Protocol session stopped"));
  if (pausedTarget) {
    await afterStateMutation(context, record, "session_stop_goal_paused");
  }
  return {};
}

async function pauseActiveGoalForSessionStop(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: { sessionId: string },
): Promise<ProtocolGoalTarget | null> {
  if (!record.app.readTarget || !record.app.updateTargetStatus) {
    return null;
  }
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return null;
  }

  try {
    // When Stop only aborts the controller, a goal verifier that does not receive the abort
    // in time keeps the active goal while the queue still holds stopRequested, so later
    // queues cannot drain.
    const pausedTarget = await record.app.updateTargetStatus("paused");
    if (pausedTarget) {
      context.logger?.info("ZCode Protocol session/stop paused active goal", {
        sessionId: params.sessionId,
        targetId: pausedTarget.targetID,
        workspacePath: record.workspace.workspacePath,
      });
    }
    return pausedTarget;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: params.sessionId,
      targetId: target.targetID,
      workspacePath: record.workspace.workspacePath,
    });
    return null;
  }
}

export async function cancelBackgroundTask(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionCancelBackgroundTaskParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  context.logger?.info("ZCode Protocol session/cancelBackgroundTask received", {
    sessionId: params.sessionId,
    taskId: params.taskId,
    workspacePath: record.workspace.workspacePath,
  });

  if (!record.app.cancelBackgroundTask) {
    throw new ProtocolRequestError(
      -32031,
      "Background task cancellation is not supported by this session runtime",
      {
        sessionId: params.sessionId,
        taskId: params.taskId,
      },
    );
  }

  const result = await record.app.cancelBackgroundTask(params.taskId);
  // A background bash cancel is a running-state change and never passes through the ordinary
  // prompt terminal. Emit state.updated immediately after the cancel so desktop continuous
  // and mobile replayable both refresh projections through their own snapshot boundaries.
  await afterStateMutation(context, record, "background_task_cancelled");
  return result;
}

export async function setModel(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModelParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    // A full Session config command must not lose reasoning through the identity string; the shared setter validates/saves atomically.
    await record.app.setModel(params.model);
  });
  return await afterStateMutation(context, record, "model_changed");
}

export async function setThoughtLevel(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSetThoughtLevelParamsSchema, rawParams);
  if (!params.thoughtLevel) {
    throw new ProtocolRequestError(-32602, "thoughtLevel is required");
  }
  const thoughtLevel = params.thoughtLevel;
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    await record.app.setThoughtLevel(thoughtLevel);
  });
  return await afterStateMutation(context, record, "thought_level_changed");
}

export async function setMode(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await record.app.setMode(params.mode);
  return await afterStateMutation(context, record, "mode_changed");
}

export async function closeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCloseParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  if (!shouldCloseSessionForExpectedPersistence(record.persistence, params.expectedPersistence)) {
    // Connection switches and cross-client first sends can race. session/send first promotes
    // deferred to immediate; conditional close must be judged atomically on the Agent record,
    // not from the renderer's stale snapshot.
    return { closed: false };
  }
  await closeSessionRuntime(context, params.sessionId);
  return { closed: true };
}

export function shouldCloseSessionForExpectedPersistence(
  currentPersistence: ZCodeSessionPersistence,
  expectedPersistence?: ZCodeSessionPersistence,
): boolean {
  return expectedPersistence === undefined || currentPersistence === expectedPersistence;
}

export async function generateWorkspaceText(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeWorkspaceGenerateTextParamsSchema, rawParams);
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const input = {
    selection: params.selection,
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.messages ? { messages: params.messages } : {}),
    ...(params.tools
      ? {
          tools: params.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      : {}),
    querySource: params.querySource,
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
  };
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: context.deps.createSessionEventStore("workspace-generate-text"),
      runtimeConfig: {
        workingDirectory: params.workspace.workspacePath,
      },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));

  try {
    const result = await app.generateWorkspaceText(input, { abortSignal });
    return {
      text: result.text,
      selection: result.selection,
      finishReason: result.finishReason,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    };
  } finally {
    if (!active) {
      await app.close?.();
    }
  }
}

function ensureNoActiveTurn(record: ZCodeProtocolSessionRecord, message: string): void {
  if (!record.activeAbortController) {
    return;
  }
  throw new ProtocolRequestError(-32010, message);
}

function appendPlanModeGoalContinuationNote(response: string): string {
  return `${response}\n\n${PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE}`;
}

function formatGoalSummary(target: ProtocolGoalTarget | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }

  return formatGoalChanged(`Goal ${target.status}`, target);
}

function formatGoalChanged(title: string, target: ProtocolGoalTarget): string {
  const lines = [title, `Objective: ${target.objective}`];
  if (target.tokensUsed !== undefined || target.tokenBudget !== undefined) {
    const budget =
      target.tokenBudget === null || target.tokenBudget === undefined
        ? "none"
        : target.tokenBudget.toString();
    lines.push(`Usage: ${target.tokensUsed ?? 0} tokens / ${budget}`);
  }
  if (target.timeUsedSeconds !== undefined) {
    lines.push(`Time: ${target.timeUsedSeconds} seconds`);
  }
  return lines.join("\n");
}

function assertExpectedProviderRevision(
  _context: ZCodeProtocolAgentServerContext,
  _record: ZCodeProtocolSessionRecord,
  expectedProviderRevision: string | undefined,
): void {
  // Legacy-client compatibility field. Provider revision is managed by the in-process Registry itself; Host CAS is no longer accepted.
  void expectedProviderRevision;
}

export async function ensureSessionModelAvailableForNextTurn(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (await ensureSessionModelAvailable(context, record)) {
    record.stateRevision++;
  }
}

async function resolveForkTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  target: ZCodeSessionHistoryTarget,
): Promise<{ targetCheckpointId?: string; targetMessageId?: string }> {
  if (target.kind === "latestCheckpoint") {
    return {};
  }
  if (target.kind === "checkpoint") {
    return { targetCheckpointId: target.checkpointId };
  }
  if (target.kind === "message") {
    return { targetMessageId: target.messageId };
  }
  return {
    targetMessageId: await resolveTurnMessageId(context, record, target.turnIndex, "assistant"),
  };
}

async function resolveTurnMessageId(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  turnIndex: number,
  role: "assistant" | "user",
): Promise<MessageId> {
  const messages = (await readActiveSessionMessages(context, record)).filter(
    isUserVisibleSessionMessage,
  );
  let currentTurn = -1;
  let lastAssistantForTargetTurn: MessageId | undefined;
  for (const message of messages) {
    if (message.info.role === "user") {
      if (role === "assistant" && currentTurn === turnIndex && lastAssistantForTargetTurn) {
        // The fork/rewind legacy turn target is "the assistant of the target turn", not "still
        // inside the target turn when scanning reaches history's end". Clearing the found
        // assistant upon the next user meant only the last turn could fork; synthetic users
        // like compact summaries and fork notices further made the last turn not-last. Return
        // the stable target as soon as the target turn is left.
        return lastAssistantForTargetTurn;
      }
      currentTurn += 1;
      if (role === "user" && currentTurn === turnIndex) {
        return message.info.id as MessageId;
      }
      continue;
    }
    if (message.info.role === "assistant" && currentTurn === turnIndex) {
      lastAssistantForTargetTurn = message.info.id as MessageId;
    }
  }
  if (role === "assistant" && lastAssistantForTargetTurn) {
    return lastAssistantForTargetTurn;
  }
  throw new ProtocolRequestError(
    zcodeProtocolErrorCodes.sessionUnavailable,
    `Cannot resolve ${role} message for turnIndex=${turnIndex}`,
  );
}

export async function getTaskTokenUsage(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeTaskTokenUsageParamsSchema, rawParams ?? {});
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryTaskUsage) {
    return {
      sessionId: params.sessionId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    };
  }

  const usage = await usageStore.queryTaskUsage({
    sessionID: params.sessionId as SessionId,
  });
  return {
    sessionId: params.sessionId,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    modelRequestCount: usage.modelRequestCount,
    modelErrorCount: usage.modelErrorCount,
    inputBaselineBySource: usage.inputBaselineBySource,
  };
}

/**
 * Pure-config event set: only changes the session's selections (model/collab mode) and does
 * not represent user message activity.
 * These events do not bump record.updatedAt (= sessions-index lastActivityAt),
 * so configuration operations do not reorder the sidebar by activity time.
 * - ModelSelected / SessionModeChanged: pure configuration changes (model/mode switch).
 * - ExternalAgentConfigUpdated / ExternalAgentStatus: ACP agent selects and stall status (S6).
 * - FollowupModeChanged: opening a session auto-syncs the queue/guide preference; that is
 *   configuration and must not refresh the historical activity time.
 * - SessionTitleUpdated: the title is session metadata; cold recovery re-emits a title event
 *   for the v4 projection, which must not make a historical task look freshly active and jump
 *   to the top of the list.
 * - SessionResumed: opening/resuming a session is a read, not activity. The cold-recovery
 *   path just backfilled record.updatedAt with the store's real time (see the note in the
 *   resumeSession op); if the resume event then overwrote it with Date.now(), merely opening
 *   or refreshing a task would push it to the top of the list and reorder the whole list.
 * - WorkspaceHookAdmissionUpdated / WorkspaceMcpAdmissionUpdated: admission banner refresh is
 *   not user activity; missing them from the blacklist would let post-SessionResumed
 *   admission events show a historical task as "just now".
 * - HookRun*: hook lifecycle is an internal execution detail of a turn/session; a normal turn
 *   already has message/tool activity events updating the time, and a cold-recovery
 *   SessionStart hook must not fabricate user activity on its own.
 */
function isNonActivitySessionEvent(event: SessionEvent): boolean {
  return (
    event.type === SessionEventType.ModelSelected ||
    event.type === SessionEventType.SessionModeChanged ||
    event.type === SessionEventType.ExternalAgentConfigUpdated ||
    event.type === SessionEventType.ExternalAgentStatus ||
    event.type === SessionEventType.FollowupModeChanged ||
    event.type === SessionEventType.SessionTitleUpdated ||
    event.type === SessionEventType.SessionResumed ||
    event.type === SessionEventType.WorkspaceHookAdmissionUpdated ||
    event.type === SessionEventType.WorkspaceMcpAdmissionUpdated ||
    event.type === SessionEventType.HookRunStarted ||
    event.type === SessionEventType.HookRunProgress ||
    event.type === SessionEventType.HookRunCompleted ||
    event.type === SessionEventType.HookRunFailed ||
    event.type === SessionEventType.HookRunBlocked
  );
}

/**
 * `record.persistence` is the protocol-side mirror of the runtime's "session persisted" fact:
 * deferred = draft (excluded from session/list, excluded from sessions-index, reclaimable by
 * a conditional close with expectedPersistence="deferred"). The first-send path promotes
 * eagerly at the accepted moment (the close race needs an atomic check, see startPromptTurn /
 * admission), but **any** path persisted by the runtime for the first time must take the
 * session out of draft — a hub-launched session is rowed in by the runtime via a controlOnly
 * launch turn with no first send, so its record stays deferred, sessions-index skips it as a
 * draft, and it never appears in the sidebar.
 * So the event stream's single entry point aligns once against the runtime fact: after
 * persistence the runtime must emit at least one event (SessionTitleUpdated first_input), and
 * the ingest right after advances the session into sessions-index.
 * A test-stub runtime may lack this method (`as never`); absence means no alignment.
 */
function reconcileRecordPersistence(record: ZCodeProtocolSessionRecord): void {
  if (record.persistence !== "deferred") return;
  if (record.app.runtime?.isSessionPersisted?.() === true) record.persistence = "immediate";
}

export function onSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): void {
  sendChatGptPlanUsageUpdated(context, event);
  const computerUseOperationEvent = mapComputerUseOperationEvent(event);
  if (computerUseOperationEvent) {
    try {
      // The desktop v4 main chain has no legacy session/event deliveryKind subscription, so
      // the top banner cannot keep relying on that old gate; only content-less lifecycle
      // metadata is sent here, in parallel with the v4 projection and never blocking it.
      context.notify({
        method: zcodeProtocolMethods.computerUseOperationEvent,
        params: computerUseOperationEvent,
      });
      // This notify used to log only on throw, leaving the success path traceless, so "the
      // agent never sent it" and "sent but silently dropped host-side" were
      // indistinguishable. The CLI's own jsonl captures debug level — enough to close the loop
      // at the source.
      context.logger?.debug("Computer Use operation lifecycle notification sent", {
        event: "zcode_protocol.computer-use.operation-event.sent",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        kind: computerUseOperationEvent.kind,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    } catch (error) {
      context.logger?.warn("Computer Use operation lifecycle notification failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.computer-use.operation-event.failed",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    }
  }
  if (String(event.sessionId) !== record.app.sessionId) {
    // The subagent runtime reuses the parent runtime's external event sink, but raw child
    // events still belong to the child session. Ingesting unconditionally under the parent
    // record id stops the child topic from updating once opened and may wrongly bump the
    // parent task's activity time. Route by the event's own sessionId and return first; the
    // parent mirror event itself carries the parent sessionId and continues down the existing path below.
    context.v4Gateway?.ingestDetachedLiveSession(
      String(event.sessionId),
      event,
      record.app.sessionId,
    );
    // Child-session throughput observation runs alongside chat projection. Child events do not
    // pass through a parent record; without routing here, session/debug can never show subagent tok/s.
    observeDetachedChildSessionDebug(String(event.sessionId), event);
    return;
  }
  // record.updatedAt is the source of truth for sessions-index's lastActivityAt (v4-bridge
  // getSessionIndexMeta), which the UI sidebar sorts by. Pure-config/recovery/title metadata
  // events are not user conversation activity; the old indiscriminate bump let "switch a
  // model once / open a task" push tasks to the top of the list and trigger a full re-sort.
  // core persists the result before publishing the terminal state; the list reuses that fact
  // instead of guessing from the trimmed body window.
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    const payload = event.payload as { resultType?: string };
    record.lastOutcome =
      event.type === SessionEventType.TurnError
        ? "error"
        : payload.resultType === "cancelled"
          ? "interrupted"
          : "completed";
  }
  const nonActivityEvent = isNonActivitySessionEvent(event);
  if (event.type === SessionEventType.ModelSelected) {
    // Recovery candidates serve only the initial UI; once the user's new choice takes effect, a later clear must not resurrect the old candidate.
    delete record.restoredModelSelection;
  }
  if (!nonActivityEvent) {
    record.updatedAt = Date.now();
  }
  reconcileRecordPersistence(record);
  // The debug side channel does not depend on the chat subscription; placed before the deliveryKind check so diagnostics do not cut out again once the legacy subscription exits.
  observeSessionDebug(record, event);
  // v4 channel: authoritative events are fed to the v4 projection/publisher unconditionally —
  // v4 subscriptions do not depend on the legacy protocol's deliveryKind subscription state;
  // frame pacing is scheduled by the gateway per subscriber profile.
  context.v4Gateway?.ingest(record.app.sessionId, event);
  if (!record.deliveryKind) return;
  const deltaInfo = readStreamingDeltaBatchableEvent(event);
  if (deltaInfo && !shouldHideProtocolSessionEvent(record, event)) {
    const batchState = getLiveProtocolStreamingDeltaBatchState(record, record.deliveryKind);
    if (batchState.batch && batchState.batch.batchKey !== deltaInfo.batchKey) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    batchState.batch = mergeProtocolStreamingDeltaBatch(batchState.batch, event, deltaInfo);
    if (
      deltaInfo.shouldFlushFirstDelta &&
      !batchState.flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
      batchState.flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
      return;
    }
    if (
      batchState.batch.delta.length >= batchState.batch.maxChars ||
      shouldFlushProtocolStreamingDeltaBatchForInterval(
        batchState.batch,
        batchState.lastFlushAtByBatchKey,
      )
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    return;
  }

  resetLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
  sendProtocolSessionEvent(context, record, event, record.deliveryKind);
}

/** Forward captured usage independently of legacy deliveryKind so V4-only sessions are covered. */
function sendChatGptPlanUsageUpdated(
  context: ZCodeProtocolAgentServerContext,
  event: SessionEvent,
): void {
  if (event.type !== SessionEventType.TurnComplete) return;
  const payload = asRecord(event.payload);
  const usage = asRecord(payload.usage);
  const parsed = zcodeChatGptPlanUsageUpdatedParamsSchema.safeParse({
    eventId: String(event.id),
    sessionId: String(event.sessionId),
    providerId: usage.providerRateLimitProviderId,
    usage: usage.providerRateLimits,
  });
  if (!parsed.success) return;
  try {
    context.notify({
      method: zcodeProtocolNotifications.chatGptPlanUsageUpdated,
      params: parsed.data,
    });
  } catch (error) {
    context.logger?.warn("ChatGPT plan usage notification failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.chatgpt-plan.usage-updated.failed",
      eventId: parsed.data.eventId,
      sessionId: parsed.data.sessionId,
    });
  }
}

function flushLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  if (!batchState.batch) {
    return;
  }
  rememberProtocolStreamingDeltaBatchFlush(batchState.lastFlushAtByBatchKey, batchState.batch);
  const event = materializeProtocolStreamingDeltaBatch(batchState.batch);
  batchState.batch = undefined;
  // Performance fix: providers split Write/Edit input and reasoning/text output into very
  // many tiny deltas. Adjacent diffs are coalesced at the protocol boundary under a
  // deterministic byte budget; the renderer still appends deltas but is no longer woken by
  // every small packet.
  // Text feel uses SessionEvent.timestamp for low-frequency flushes — no live setTimeout, or
  // replay could not reproduce the boundary.
  sendProtocolSessionEvent(context, record, event, deliveryKind);
}

function resetLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  flushLiveProtocolStreamingDeltaBatch(context, record, deliveryKind);
  batchState.flushedFirstDeltaBatchKeys.clear();
  batchState.lastFlushAtByBatchKey.clear();
}

function sendProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind);
  if (!mappedEvent) return;
  context.notify({
    method: "session/event",
    params: mappedEvent,
  });
  logProtocolSessionEventSent(context, event, mappedEvent);
}

function integratedTerminalShellToExecutionSelection(
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection | undefined {
  if (!selection || selection.mode === "auto") {
    return undefined;
  }
  return {
    display: {
      name: selection.dialect === "git-bash" ? "Git Bash" : "CMD",
    },
    dialect: selection.dialect,
    id: selection.id,
    label: selection.label,
    path: selection.path,
    source: "user-config",
  };
}

function resolveProtocolBashShellSelection(
  context: ZCodeProtocolAgentServerContext,
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection {
  const configuredSelection = integratedTerminalShellToExecutionSelection(selection);
  return resolveEffectiveBashShellSelection({
    env: context.deps.env ?? process.env,
    override: configuredSelection,
    platform: context.deps.platform ?? process.platform,
  }).selection;
}

async function requestSessionRuntimePreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  scope: ZCodeSessionRuntimePreferencesScope,
  trace?: ZCodeProtocolTrace,
  directorySessionId?: string,
  workspace?: ZCodeWorkspaceRef,
): Promise<ZCodeSessionRuntimePreferencesResult> {
  const startedAt = Date.now();
  // ZCodeProtocolTrace.traceId is the protocol layer's plain string; LogContext needs a
  // branded TraceId. Assert-narrow per this file's existing convention so multiple log
  // constructions do not each re-convert.
  const traceId = trace?.traceId as TraceId | undefined;
  context.logger?.debug("ZCode Protocol runtime preferences request started", {
    event: "zcode_protocol.runtime_preferences.request_started",
    module: "bootstrap.zcode_protocol",
    scope,
    sessionId,
    traceId,
  });
  try {
    const result = await context.requestClient(
      zcodeProtocolMethods.sessionRequestRuntimePreferences,
      {
        sessionId,
        scope,
        ...(directorySessionId ? { directorySessionId } : {}),
        ...(context.sessionWorkspaceRoutingEnabled && workspace ? { workspace } : {}),
      },
      zcodeSessionRuntimePreferencesResultSchema,
      {
        timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        ...(trace ? { trace } : {}),
      },
    );
    context.logger?.debug("ZCode Protocol runtime preferences response received", {
      durationMs: Math.max(0, Date.now() - startedAt),
      event: "zcode_protocol.runtime_preferences.response_received",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    });
    return result;
  } catch (error) {
    const errorCode = error instanceof ProtocolRequestError ? error.code : undefined;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnostic = {
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode,
      errorMessage,
      event: "zcode_protocol.runtime_preferences.request_failed",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    };
    if (errorCode === -32022) {
      // Diagnostics: a preference-request timeout happens before the runtime registers; log
      // session/scope to tell "Host never received/replied" apart from "another recovery phase failed".
      context.logger?.warn("ZCode Protocol runtime preferences request timed out", diagnostic);
    } else if (errorCode !== -32601 && errorCode !== -32020) {
      context.logger?.warn("ZCode Protocol runtime preferences request failed", diagnostic);
    } else {
      context.logger?.debug(
        "ZCode Protocol runtime preferences compatibility fallback",
        diagnostic,
      );
    }
    if (error instanceof ProtocolRequestError && (error.code === -32601 || error.code === -32020)) {
      // Compatibility for legacy Hosts or Host-less pure-CLI creation; Memory follows the
      // product default of off, enhanced search keeps its existing default of on, and other
      // protocol/transport errors still block runtime creation.
      return {
        askUserQuestionAutoResolutionEnabled: true,
        memoryEnabled: false,
        memoryIndexAsContext: false,
        modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
        nativeSearchEnhancementsEnabled: true,
        toolSearchMode: "off",
      };
    }
    throw error;
  }
}

async function resolveSessionStartupPreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
  directorySessionId?: string,
  workspace?: ZCodeWorkspaceRef,
): Promise<SessionStartupPreferences> {
  if (source.kind === "inherit") {
    const inheritedShellSelection = source.parent.app.runtime.getSessionShellSelection();
    return {
      memoryEnabled: source.parent.memoryEnabled,
      memoryIndexAsContext: source.parent.memoryIndexAsContext,
      subagentRuntimeConfigEnabled: source.parent.subagentRuntimeConfigEnabled,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
      nativeSearchEnhancementsEnabled: source.parent.nativeSearchEnhancementsEnabled,
      toolSearchMode: source.parent.toolSearchMode,
      resolveInitialBashShellSelection: async () => inheritedShellSelection,
    };
  }

  const runtimePreferences = await requestSessionRuntimePreferences(
    context,
    sessionId,
    "runtime-materialization",
    trace,
    directorySessionId,
    workspace,
  );
  // Must apply before the session runtime can issue its first prompt; the disable path waits for an in-flight snooze persistence to finish.
  await context.v4Interactions.initializeAskUserQuestionAutoResolutionEnabled(
    runtimePreferences.askUserQuestionAutoResolutionEnabled,
  );
  return {
    additionalDirectories: runtimePreferences.additionalDirectories,
    subagentRuntimeConfigEnabled: runtimePreferences.subagentRuntimeConfigEnabled,
    memoryEnabled: runtimePreferences.memoryEnabled,
    memoryIndexAsContext: runtimePreferences.memoryIndexAsContext,
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    nativeSearchEnhancementsEnabled: runtimePreferences.nativeSearchEnhancementsEnabled,
    // Shared compat keeps toolSearchMode optional for unsynced Hosts; the parsed default is "off".
    toolSearchMode: runtimePreferences.toolSearchMode ?? "off",
    resolveInitialBashShellSelection: async () => {
      const executionPreferences = await requestSessionRuntimePreferences(
        context,
        sessionId,
        "user-execution",
        trace,
        undefined,
        workspace,
      );
      return resolveProtocolBashShellSelection(
        context,
        executionPreferences.integratedTerminalShell,
      );
    },
  };
}

async function materializeSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  let directorySessionId: string | undefined;
  if (source.kind === "host" && context.sessionDirectorySourceEnabled) {
    directorySessionId = sessionId;
    if (resume) {
      const session = await getPersistedSession(context, sessionId);
      const workspace =
        params.workspace ?? buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() });
      const directorySession = session
        ? await resolvePersistedDirectorySession(context, session, workspace, true)
        : null;
      if (!directorySession) throw new Error("project.session-lineage-invalid");
      directorySessionId = directorySession.id;
    }
  }
  // Cold recovery used to look up the project with the child as the main task. The reverse
  // request now carries the persisted ownership directly, so the Host need not issue a
  // session/list that queues behind the current recovery request and deadlocks both sides;
  // the original sessionId and write target stay unchanged.
  const startupPreferences = await resolveSessionStartupPreferences(
    context,
    sessionId,
    source,
    trace,
    directorySessionId,
    params.workspace ?? buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() }),
  );
  return createRecord(context, params, sessionId, resume, startupPreferences, trace);
}

/**
 * Execution-worktree boundary health check (spec: execution-worktree-missing-handling.md §1-2).
 * A single stat in the CLI process — the same machine workingDirectory resolves against. Create
 * rejects with a precise error; resume keeps the fact marked missing so the session continues in
 * the parent workspace while the wire meta and env bullet still see the worktree fact.
 */
async function resolveRecordExecutionWorktree(
  resume: boolean,
  executionWorktree: ZCodeSessionCreateParams["executionWorktree"] | undefined,
): Promise<AgentRuntimeConfig["executionWorktree"]> {
  if (!executionWorktree) return undefined;
  if (!(await isWorktreeDirectoryMissing(executionWorktree.path))) return executionWorktree;
  if (!resume) {
    throw new ProtocolRequestError(
      -32602,
      `Execution worktree path does not exist or is not a directory: ${executionWorktree.path}`,
    );
  }
  return { ...executionWorktree, missing: true };
}

/** True when the path is absent or not a directory (the async variant for cold-seed fan-outs). */
export async function isWorktreeDirectoryMissing(path: string): Promise<boolean> {
  try {
    return !(await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingWorktreePathError(error)) return true;
    throw error;
  }
}

/** Synchronous variant for hooks that must not await (sessions-index meta derivation). */
export function isWorktreeDirectoryMissingSync(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch (error) {
    if (isMissingWorktreePathError(error)) return true;
    throw error;
  }
}

function isMissingWorktreePathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function createRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  startupPreferences: SessionStartupPreferences,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const workspace =
    "workspace" in params && params.workspace
      ? params.workspace
      : buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() });
  // Execution-worktree health at the session boundary (spec: execution-worktree-missing-handling.md
  // §1-2): create rejects so a session never starts executing in a dead cwd; resume keeps the
  // persisted fact but marks it missing, and createZCodeApp then falls back to the parent workspace.
  const recordExecutionWorktree = await resolveRecordExecutionWorktree(
    resume,
    "executionWorktree" in params ? params.executionWorktree : undefined,
  );
  const eventStore = context.deps.createSessionEventStore(sessionId);
  const traceContext = createProtocolRootTraceContext(sessionId, trace);
  const initialModel = "model" in params ? params.model : undefined;
  const parentSessionId =
    "parentSessionId" in params && params.parentSessionId
      ? (params.parentSessionId as SessionId)
      : undefined;
  const taskType = params.taskType ?? "interactive";
  const runtimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  context.logger?.info("ZCode Protocol createRecord MCP config", {
    event: "zcode_protocol.create_record.mcp_config",
    rootTraceId: traceContext.traceId,
    inboundTraceId: trace?.traceId,
    paramMcpServerCount: params.mcpServers?.length ?? 0,
    runtimeHasMcpConfig: Boolean(runtimeMcp),
    runtimeMcpServerCount: Object.keys(runtimeMcp?.servers ?? {}).length,
    sessionId,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  // The automation-port needs to read "this session's" live model/mode/thought; the record is
  // created only after the app. Bind lazily through a mutable holder: by the time CronCreate
  // calls create() mid-turn, the record is long ready.
  let ownSessionRecord: ZCodeProtocolSessionRecord | undefined;
  const app = await createWorkspaceZCodeApp(context, workspace, {
    env: context.deps.env,
    eventStore,
    resume,
    additionalDirectories: params.additionalDirectories ?? startupPreferences.additionalDirectories,
    runtimeConfig: {
      mode: "mode" in params ? params.mode : undefined,
      modelSelection: "model" in params ? toRuntimeModelSelection(initialModel) : undefined,
      parentSessionId,
      taskType,
      // Dynamic-workflow gray-release gate (docs/dynamic-workflow/launch.md "Gray release" /
      // "On demand: activation"): same read logic as offPeakPort — this create/resume's params
      // take priority; absent that, read the workspace-level conclusion the Host synced into
      // the process. Values and the "must be an explicit boolean" rationale live in
      // resolveDynamicWorkflowRuntimeGate.
      ...resolveDynamicWorkflowRuntimeGate(
        {
          dynamicWorkflowEnabled:
            "dynamicWorkflowEnabled" in params ? params.dynamicWorkflowEnabled : undefined,
          dynamicWorkflowMode:
            "dynamicWorkflowMode" in params ? params.dynamicWorkflowMode : undefined,
        },
        context.appRuntimePreferences,
      ),
      // Root cause: the protocol-side tool allow/deny lists are a session-level security
      // boundary and must enter runtimeConfig; prompt-text constraints alone let built-in
      // tools and dynamic MCP tools still slip past the call surface.
      toolAllowlist: "toolAllowlist" in params ? params.toolAllowlist : undefined,
      toolDisallowlist: resolveSessionToolDenylist(params, workspace),
      nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
      toolSearch: { mode: startupPreferences.toolSearchMode },
      modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
      // memoryIndexAsContext only chooses the index rendering, so write it before the master-switch
      // override below: when Memory is disabled, { enabled: false } must win over { indexAsContext }.
      ...(startupPreferences.memoryIndexAsContext ? { memory: { indexAsContext: true } } : {}),
      // Memory Settings is a master switch in addition to existing CLI features.memory/use. Write an
      // override only when disabled so the enabled value does not override a user's existing CLI disablement.
      ...(startupPreferences.memoryEnabled ? {} : { memory: { enabled: false } }),
      // For desktop-continuous session/create, UI first resolves enabled MCP servers from
      // ~/.zcode/.agents, but protocol app-server does not read the UI/main-side MCP store. Previously,
      // createRecord did not inject params.mcpServers into runtimeConfig, so logs showed
      // runtimeHasMcpConfig=false and tools never started. MCP is runtime startup configuration and
      // must be written into runtimeConfig.mcp once at the session create/resume boundary.
      ...(runtimeMcp ? { mcp: runtimeMcp } : {}),
      // Previously only the TUI path (tui-prompt-handler) injected titleGeneration; sessions
      // created by the ZCode Protocol app-server (Desktop/Web/mobile) did not, so
      // shouldAttemptSessionTitleGeneration's `if (!config.titleGeneration) return false` always
      // matched. Model title generation never ran and the sidebar title stayed at the first_input
      // user query. Add an enabled default here; runtime still decides whether to generate based on
      // parent/taskType/turnNumber. Explicitly disable retitling for automation sessions so answers
      // do not overwrite the original user-query title.
      titleGeneration: params.titleGenerationEnabled === false ? { enabled: false } : {},
      workingDirectory: workspace.workspacePath,
      // Execution worktree: createZCodeApp derives the execution cwd from it while workspacePath
      // above keeps the session identity/persistence anchored to the parent workspace. The fact was
      // health-checked above (create rejects a dead path; resume carries missing: true).
      ...(recordExecutionWorktree ? { executionWorktree: recordExecutionWorktree } : {}),
      incognito: params.incognito,
      // Keep identity isolation separate from execution paths: core writes only identity to
      // session.workspace_id, while workingDirectory remains the actual path on the remote machine.
      // Local workspaces keep it undefined.
      workspaceIdentity: workspace.workspaceIdentity as WorkspaceId | undefined,
    },
    // ZCode Protocol app-server previously injected no waitable interaction broker, so core could
    // only deny permission/AskUserQuestion by default and the UI never received a blocking request.
    // Convert blocking interactions into server-to-client JSON-RPC requests; the app releases runtime
    // through its response.
    permissionBroker: createProtocolInteractionBroker(context),
    automationPort: createProtocolAutomationPort(context, () => ownSessionRecord),
    topicResourcePort: createProtocolTopicResourcePort(context),
    // Only attach tool surfaces the Host has opened; inject nothing by default. Reuses the
    // existing async factory — no revival of the old deferred ModelAdapter/Registry overlay,
    // and no change to the Session Selection.
    ...(("offPeakToolEnabled" in params && params.offPeakToolEnabled === true) ||
    context.appRuntimePreferences.offPeakToolEnabled === true
      ? { offPeakPort: createProtocolOffPeakPort(context, () => ownSessionRecord) }
      : {}),
    resolveInitialBashShellSelection: startupPreferences.resolveInitialBashShellSelection,
    // Fix: this used to exclude remotes by workspace identity, so even a remote Host with a
    // snapshot could not attach and pushed subagents required a new task to work.
    // Whether to attach depends only on the capabilities declared by the Host holding this stdio.
    ...(startupPreferences.subagentRuntimeConfigEnabled
      ? {
          readSubagentRuntimeConfig: async ({ signal, traceContext }) => {
            signal.throwIfAborted();
            const result = await context.requestClient(
              zcodeProtocolMethods.subagentsReadRuntimeConfig,
              { sessionId, ...(context.sessionWorkspaceRoutingEnabled ? { workspace } : {}) },
              subagentRuntimeConfigSchema,
              {
                signal,
                timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
                trace: { traceId: traceContext.traceId },
              },
            );
            signal.throwIfAborted();
            return result;
          },
        }
      : {}),
    // browser-use: agent.browsers.* turns commands into interaction/browserExecute reverse requests through this.
    browserControlPort: createProtocolBrowserControlBroker(context),
    // The protocol server is a trusted Desktop/Web/Mobile Host; the gray-release switch is
    // injected explicitly here — never read from workspace/project config or env vars, and
    // removing the field rolls back to the hard block.
    workspaceHookTrustEnabled: true,
    // Session-less Settings Trust once bypassed the managed policy; the session Runtime and
    // workspace RPC must share the same provider held by the Host, never each create their
    // own default policy.
    workspaceHookPolicyProvider: context.deps.workspaceHookPolicyProvider,
    workspaceHookReviewHost: {
      taskId: sessionId,
      runId: `workspace-hook-run:${sessionId}:${crypto.randomUUID()}`,
      workspaceLabel:
        workspace.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace.workspacePath,
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
    },
    sessionId,
    sessionStore: context.deps.sessionStore,
    traceContext,
    version: context.deps.version,
    modelIoFullRetentionEnabled: context.appRuntimePreferences.modelIoFullRetentionEnabled,
  });
  const now = Date.now();
  const record: ZCodeProtocolSessionRecord = {
    app,
    createdAt: now,
    eventStore,
    memoryEnabled: startupPreferences.memoryEnabled,
    memoryIndexAsContext: startupPreferences.memoryIndexAsContext,
    subagentRuntimeConfigEnabled: startupPreferences.subagentRuntimeConfigEnabled,
    modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
    nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
    toolSearchMode: startupPreferences.toolSearchMode,
    ...(parentSessionId ? { parentSessionId } : {}),
    persistence: "persistence" in params ? (params.persistence ?? "immediate") : "immediate",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    taskType,
    traceContext,
    updatedAt: now,
    workspace,
  };
  // Once the app materializes, the lifecycle execution surface owns it. If subscription wiring throws, it must still be findable and releasable.
  context.sessions.set(sessionId, record);
  context.assertServing?.();
  let subscribed = true;
  let unsubscribeSessionEvents = () => {};
  record.unsubscribe = () => {
    subscribed = false;
    unsubscribeSessionEvents();
  };
  unsubscribeSessionEvents = app.runtime.subscribeEvents({
    // Callbacks queued before the unsubscribe can still arrive late and must not pollute the same-named session's projection after a restart.
    onSessionEvent: (event) => {
      if (subscribed) onSessionEvent(context, record, event);
    },
  });
  // Binds the owning session so the automation-port can read this session's live model/mode/thought.
  ownSessionRecord = record;
  return record;
}

async function readPersistedSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<MessageWithParts[]> {
  return await (context.deps.sessionStore?.messages({
    sessionID: sessionId as SessionId,
  }) ?? []);
}

function derivePersistedSessionMode(
  messages: readonly MessageWithParts[],
): ZCodeSessionCreateParams["mode"] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "assistant" && isZCodeSessionMode(info.mode)) return info.mode;
  }
  return undefined;
}

function isZCodeSessionMode(
  value: unknown,
): value is NonNullable<ZCodeSessionCreateParams["mode"]> {
  return (
    value === "plan" ||
    value === "build" ||
    value === "edit" ||
    value === "yolo" ||
    value === "guarded" ||
    value === "auto"
  );
}

function toRuntimeModelSelection(
  model: ZCodeSessionCreateParams["model"],
): ModelSelection | undefined {
  if (!model) return undefined;
  return {
    modelId: model.modelId,
    providerId: model.providerId,
    ...(model.options ? { options: model.options } : {}),
  };
}

interface SnapshotPhaseDurationsMs {
  contextUsageBreakdownEvents: number;
  eventSeq: number;
  goalVerificationEvents: number;
  persistedMessages: number;
  persistedSession: number;
  rewindEvents: number;
  target: number;
  todos: number;
  buildSnapshot: number;
}

interface SnapshotWithDiagnostics {
  snapshot: Awaited<ReturnType<typeof buildSessionSnapshot>>;
  phaseDurationsMs: SnapshotPhaseDurationsMs;
}

async function snapshot(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
) {
  return (await snapshotWithDiagnostics(context, record, knownSession, options)).snapshot;
}

async function snapshotWithDiagnostics(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
): Promise<SnapshotWithDiagnostics> {
  const snapshotStartedAt = Date.now();
  const phaseDurationsMs: SnapshotPhaseDurationsMs = {
    contextUsageBreakdownEvents: 0,
    eventSeq: 0,
    goalVerificationEvents: 0,
    persistedMessages: 0,
    persistedSession: 0,
    rewindEvents: 0,
    target: 0,
    todos: 0,
    buildSnapshot: 0,
  };
  const measureSnapshotPhase = async <T>(
    phase: keyof Omit<SnapshotPhaseDurationsMs, "buildSnapshot">,
    read: () => Promise<T>,
  ): Promise<T> => {
    const phaseStartedAt = Date.now();
    try {
      return await read();
    } finally {
      phaseDurationsMs[phase] = Date.now() - phaseStartedAt;
    }
  };
  const [
    eventSeq,
    persistedMessages,
    session,
    rewindEvents,
    persistedTarget,
    persistedTodos,
    persistedGoalVerificationEvents,
    persistedContextUsageBreakdownEvents,
  ] = await Promise.all([
    measureSnapshotPhase("eventSeq", () =>
      getProtocolEventSeq(context, record, record.deliveryKind),
    ),
    measureSnapshotPhase("persistedMessages", () => readSessionMessages(context, record)),
    knownSession === undefined
      ? measureSnapshotPhase("persistedSession", () =>
          getPersistedSession(context, record.app.sessionId),
        )
      : knownSession,
    measureSnapshotPhase("rewindEvents", () => readSessionRewindEvents(record)),
    measureSnapshotPhase("target", () => readSnapshotTarget(context, record)),
    measureSnapshotPhase("todos", () => readSnapshotTodos(context, record)),
    measureSnapshotPhase("goalVerificationEvents", () =>
      readSessionTargetCompletionVerificationEvents(context, record),
    ),
    measureSnapshotPhase("contextUsageBreakdownEvents", () =>
      readSessionContextUsageBreakdownEvents(record),
    ),
  ]);
  const messages = projectActiveSessionMessages(persistedMessages, session, rewindEvents);
  const buildStartedAt = Date.now();
  const builtSnapshot = await buildSessionSnapshot({
    app: record.app,
    deliveryKind: record.deliveryKind,
    eventSeq,
    fallbackCreatedAt: record.createdAt,
    fallbackUpdatedAt: record.updatedAt,
    lastError: record.restoreWarning,
    messages: limitMessages(messages, options.messageLimit),
    modelAvailability: options.modelAvailability,
    persistedContextUsageBreakdownEvents,
    persistedGoalVerificationEvents,
    session,
    slashCommandOptions: {
      // The session snapshot's `/` directory and the workspace presentation must give the same
      // gray-release verdict, or the sidebar panel still shows `workflow` while disabled.
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
    },
    stateRevision: record.stateRevision,
    target: persistedTarget,
    todos: persistedTodos,
    workspace: record.workspace,
  });
  phaseDurationsMs.buildSnapshot = Date.now() - buildStartedAt;
  const totalDurationMs = Date.now() - snapshotStartedAt;
  if (totalDurationMs >= SLOW_SNAPSHOT_LOG_THRESHOLD_MS) {
    // Under SSH the slow spots concentrate in the session snapshot, but the old logs had only
    // the total duration. Past the threshold, log each sub-phase to tell sqlite waits, message
    // reads, and projection building apart.
    context.logger?.warn("ZCode Protocol session snapshot slow", {
      durationMs: totalDurationMs,
      event: "zcode_protocol.session_snapshot.slow",
      messageCount: messages.length,
      module: "bootstrap.zcode_protocol",
      phaseDurationsMs,
      sessionId: record.app.sessionId,
      status: "completed",
      workspaceKey: record.workspace.workspaceKey,
      workspacePath: record.workspace.workspacePath,
    });
  }
  return { snapshot: builtSnapshot, phaseDurationsMs };
}

async function readSnapshotTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTarget();
  } catch (error) {
    // The goal is the session_target's persisted business state; a snapshot recovery failure
    // must not be silently swallowed, or the UI mistakes the historical session for having no
    // goal. Keep the runtime projection and log at the protocol layer.
    context.logger?.warn("Failed to read persisted session goal for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.target_read_failed",
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
}

async function readSnapshotTodos(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTodos();
  } catch (error) {
    // The todo is the authoritative short-term plan in the DB; if the recovery read fails the
    // UI needs a clear log, but the protocol snapshot can still restore the first screen from
    // message history.
    context.logger?.warn("Failed to read persisted session todos for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.todos_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

async function readSessionTargetCompletionVerificationEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore?.sessionEntries) {
    return [];
  }
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: record.app.sessionId as SessionId,
      type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
    });
    return entries
      .map((entry, index) =>
        sessionEntryToTargetCompletionVerificationEvent(entry, record.app.sessionId, index),
      )
      .filter((event): event is SessionEvent => event !== null);
  } catch (error) {
    // The goal verifier timeline is a persistent fact of the UI turn; a read failure must not
    // affect the session's main recovery, but it must leave a log — otherwise lost grouping
    // after a cold start is very hard to diagnose.
    context.logger?.warn("Failed to read persisted goal verification entries", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.goal_verification_entries_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

function sessionEntryToTargetCompletionVerificationEvent(
  entry: {
    id: string;
    sessionID: SessionId;
    time: { created: number; updated: number };
    data: unknown;
  },
  fallbackSessionId: string,
  index: number,
): SessionEvent | null {
  const data = asRecord(entry.data);
  const payload = readTargetCompletionVerificationPayload(data.payload);
  if (!payload) {
    return null;
  }
  const eventId = stringValue(data.eventId) ?? entry.id;
  const traceId = stringValue(data.traceId) ?? "trace_restored_goal_verification";
  const turnId = stringValue(data.turnId);
  return {
    id: eventId as EventId,
    payload,
    sequenceNumber: numberValue(data.sequenceNumber) ?? index + 1,
    sessionId: (entry.sessionID ?? fallbackSessionId) as SessionId,
    timestamp: new Date(entry.time.updated || entry.time.created),
    traceId: traceId as TraceId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type: SessionEventType.TargetCompletionVerification,
  };
}

function readTargetCompletionVerificationPayload(
  value: unknown,
): TargetCompletionVerificationPayload | null {
  const record = asRecord(value);
  const targetId = stringValue(record.targetId);
  const verificationId = stringValue(record.verificationId);
  const status = stringValue(record.status);
  if (!targetId || !verificationId || !isTargetCompletionVerificationStatus(status)) {
    return null;
  }
  const verification = asGoalCompletionVerification(record.verification);
  const goalIteration = numberValue(record.goalIteration);
  const anchorAssistantMessageId = stringValue(record.anchorAssistantMessageId);
  const anchorTurnId = stringValue(record.anchorTurnId);
  return {
    targetId,
    verificationId,
    status,
    ...(verification ? { verification } : {}),
    ...(goalIteration ? { goalIteration } : {}),
    ...(anchorAssistantMessageId
      ? { anchorAssistantMessageId: anchorAssistantMessageId as MessageId }
      : {}),
    ...(anchorTurnId ? { anchorTurnId: anchorTurnId as TurnId } : {}),
  };
}

function isTargetCompletionVerificationStatus(
  status: string | undefined,
): status is TargetCompletionVerificationPayload["status"] {
  return (
    status === "started" ||
    status === "completed" ||
    status === "failed_closed" ||
    status === "cancelled"
  );
}

function asGoalCompletionVerification(
  value: unknown,
): TargetCompletionVerificationPayload["verification"] | undefined {
  const record = asRecord(value);
  if (typeof record.passed !== "boolean") {
    return undefined;
  }
  const reason = stringValue(record.reason);
  if (!reason) {
    return undefined;
  }
  return {
    nextAction: stringValue(record.nextAction),
    passed: record.passed,
    reason,
  };
}

function limitMessages<T>(messages: T[], limit?: number): T[] {
  return limit && limit > 0 ? messages.slice(-limit) : messages;
}

async function readSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  if (!context.deps.sessionStore) return [];
  return await context.deps.sessionStore.messages({
    sessionID: record.app.sessionId as SessionId,
  });
}

async function readSessionContextUsageBreakdownEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.ModelComplete);
}

async function readActiveSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<MessageWithParts[]> {
  const [messages, session, rewindEvents] = await Promise.all([
    readSessionMessages(context, record),
    getPersistedSession(context, record.app.sessionId),
    readSessionRewindEvents(record),
  ]);
  return projectActiveSessionMessages(messages, session, rewindEvents);
}

async function readSessionRewindEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.RewindTriggered);
}

function projectActiveSessionMessages(
  messages: MessageWithParts[],
  session: SessionInfo | null | undefined,
  rewindEvents: readonly SessionEvent[],
): MessageWithParts[] {
  const activeConversationRewinds: ActiveConversationRewindPayload[] = [];
  const sessionRewindPayload = activeConversationRewindPayloadFromSession(session);
  if (sessionRewindPayload) {
    activeConversationRewinds.push(sessionRewindPayload);
  }
  let activeMessages = applyRewindBranch(messages, messages, {
    createdMessageId: sessionRewindPayload?.createdMessageId,
    keptMessageIds: session?.revert?.keptMessageIDs,
    targetMessageId: sessionRewindPayload?.targetMessageId,
  });

  for (const event of rewindEvents) {
    const payload = parseActiveConversationRewindPayload(event);
    if (!payload?.targetMessageId) {
      continue;
    }
    activeConversationRewinds.push(payload);
    activeMessages = applyRewindBranch(activeMessages, messages, payload);
  }

  return filterRewindCommandAckMessages(activeMessages, activeConversationRewinds);
}

type ActiveConversationRewindPayload = {
  createdMessageId: MessageId;
  targetMessageId: MessageId;
};

function activeConversationRewindPayloadFromSession(
  session: SessionInfo | null | undefined,
): ActiveConversationRewindPayload | null {
  const createdMessageId = session?.revert?.createdMessageID;
  const targetMessageId = session?.revert?.targetMessageID;
  if (!createdMessageId || !targetMessageId) {
    return null;
  }
  return { createdMessageId, targetMessageId };
}

function parseActiveConversationRewindPayload(
  event: SessionEvent,
): ActiveConversationRewindPayload | null {
  try {
    const payload = parseRewindTriggeredPayload(event.payload);
    if (
      payload.strategy !== RewindStrategy.ActiveChain ||
      (payload.scope !== RewindScope.Conversation && payload.scope !== RewindScope.Both) ||
      !payload.createdMessageId ||
      !payload.targetMessageId
    ) {
      // core records an unavailable event for an unusable rewind, but such events carry no
      // createdMessageId. They are not the start of a new active branch; the protocol
      // projection must not trim messages on them, or consecutive edits empty the visible messages.
      return null;
    }
    return {
      createdMessageId: payload.createdMessageId,
      targetMessageId: payload.targetMessageId,
    };
  } catch {
    return null;
  }
}

function filterRewindCommandAckMessages(
  messages: MessageWithParts[],
  activeConversationRewinds: readonly ActiveConversationRewindPayload[],
): MessageWithParts[] {
  if (activeConversationRewinds.length === 0) {
    return messages;
  }
  const targetByNoticeMessageId = new Map<MessageId, MessageId>();
  for (const rewind of activeConversationRewinds) {
    targetByNoticeMessageId.set(rewind.createdMessageId, rewind.targetMessageId);
  }
  return messages.filter((message) => !isRewindCommandAckMessage(message, targetByNoticeMessageId));
}

function isRewindCommandAckMessage(
  message: MessageWithParts,
  targetByNoticeMessageId: ReadonlyMap<MessageId, MessageId>,
): boolean {
  if (message.info.role !== "assistant") {
    return false;
  }
  const targetMessageId = targetByNoticeMessageId.get(message.info.parentID);
  if (!targetMessageId) {
    return false;
  }
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  const ackText = `Rewound conversation to before message ${targetMessageId}.`;
  // The internal `/rewind conversation <messageId>` success receipt could be projected by
  // the legacy event projection into assistant text. It is only the control-command ACK for
  // edit/retry and must not be rendered to the user again on refresh or recovery.
  return text === ackText || text.endsWith(`\n${ackText}`);
}

function isUserVisibleSessionMessage(message: MessageWithParts): boolean {
  if (message.info.role !== "user") {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "realUserInput" || policy === "timelineOnly";
}

function applyRewindBranch(
  activeMessages: MessageWithParts[],
  allMessages: MessageWithParts[],
  options: {
    createdMessageId?: MessageId;
    keptMessageIds?: readonly MessageId[];
    targetMessageId?: MessageId;
  },
): MessageWithParts[] {
  if (!options.targetMessageId) {
    return activeMessages;
  }

  if (options.keptMessageIds) {
    // After consecutive rewinds, the ledger's target prefix differs from the active branch's.
    // Prefer the keptMessageIDs the runtime saved at rewind time, so old branches do not
    // resurrect in snapshot/readMessages.
    const messagesById = new Map(allMessages.map((message) => [message.info.id, message]));
    const keptMessages = options.keptMessageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithParts => message !== undefined);
    if (!options.createdMessageId) {
      return keptMessages;
    }

    const createdIndex = allMessages.findIndex(
      (message) => message.info.id === options.createdMessageId,
    );
    return createdIndex >= 0 ? [...keptMessages, ...allMessages.slice(createdIndex)] : keptMessages;
  }

  const targetIndex = activeMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    return activeMessages;
  }
  const keptMessages = activeMessages.slice(0, targetIndex);
  if (!options.createdMessageId) {
    return keptMessages;
  }

  const createdIndex = allMessages.findIndex(
    (message) => message.info.id === options.createdMessageId,
  );
  if (createdIndex < 0) {
    return keptMessages;
  }

  // The conversation rewind's persisted ledger keeps the rolled-back old branches.
  // UI snapshot/readMessages must project the active branch, or after an edit-and-resend both
  // the mis-sent original and the new message appear.
  return [...keptMessages, ...allMessages.slice(createdIndex)];
}

async function getPersistedSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore) return null;
  const session = await sessionStore.getSession(sessionId as SessionId);
  if (!session) return null;
  // Protocol cold recovery first creates the runtime from session.path; legacy data mixing identity/cwd must be cleaned before materialization.
  return await repairPersistedRemoteSessionPaths(sessionStore, session, {
    onPersistenceFailure: (error) => {
      context.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.path_repair.persist_failed",
        sessionId,
      });
    },
  });
}

/**
 * Pure-config mutation reasons: only change the session's selections and do not count as
 * user activity. Same verdict as isConfigOnlySessionEvent — record.updatedAt is the source
 * of truth for sessions-index lastActivityAt / snapshot.session.updatedAt (the task index's
 * sort time), so switching model/thinking-depth/mode must not push a task to the top of the list.
 */
const CONFIG_ONLY_MUTATION_REASONS = new Set([
  "model_changed",
  "thought_level_changed",
  "mode_changed",
]);

export async function afterStateMutation(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  if (!record.activeAbortController) {
    // The provider registry may remove the current model mid-turn. An update must not rewrite
    // in-flight requests; after turn/compact/goal continuation releases the active lock, they
    // all pass through this safety boundary uniformly and immediately complete the same-Agent
    // fallback — no waiting for the user's next send, and no handing the fallback duty back
    // to the renderer.
    await ensureSessionModelAvailable(context, record);
  }
  record.stateRevision++;
  const configOnlyMutation = CONFIG_ONLY_MUTATION_REASONS.has(reason);
  if (!configOnlyMutation) {
    record.updatedAt = Date.now();
  }
  const stateSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, reason, stateSnapshot.settings);
  return stateSnapshot;
}

function afterPromptAccepted(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  record.stateRevision++;
  record.updatedAt = Date.now();
  emitStateUpdated(context, record, reason, { status: "running" });
  return {
    accepted: true as const,
    sessionId: record.app.sessionId,
    stateRevision: record.stateRevision,
  };
}

function emitStateUpdated(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
  patch: unknown,
): void {
  const notification: ZCodeStateUpdatedNotification = {
    patch,
    reason,
    revision: record.stateRevision,
    scope: "session",
    sessionId: record.app.sessionId,
    type: "state.updated",
    workspace: record.workspace,
  };
  context.notify({ method: "state.updated", params: notification });
}
