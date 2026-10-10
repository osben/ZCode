import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  getZCodeGoalActiveIterationCount,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
  zcodeContextUsageBreakdownSchema,
  type ZCodeActiveToolCall,
  type ZCodeContextUsageBreakdownItem,
  type ZCodeDeliveryKind,
  type ZCodePendingPermission,
  type ZCodeSessionContextUsage,
  type ZCodeSessionEvent,
  type ZCodeSessionGoal,
  type ZCodeSessionGoalVerification,
  type ZCodeSessionGoalVerificationTimeline,
  type ZCodeSessionGoalStats,
  type ZCodeSessionInfo,
  type ZCodeSessionKind,
  type ZCodeSessionProjection,
  type ZCodeSessionRuntimeState,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
  type ZCodeSessionTodoGroup,
  type ZCodeWorkspaceRef,
  isMainAgentToolProjectionSource,
} from "@zcode/shared";
import {
  EventReducer,
  SessionEventType,
  getModelUsageContextTokens,
  type ActiveToolCall,
  type BackgroundTaskInfo,
  type GoalCompletionVerificationOutput,
  type MessageWithParts,
  type ModelCompletePayload,
  type PendingPermission,
  type SessionEvent,
  type SessionGoal,
  type SessionInfo,
  type SessionProjection,
  type TodoItem,
  type ToolState,
} from "@zcode/contracts";
import type { ZCodeApp } from "../app/types.js";
import { mapMessageWithParts } from "./message-mapper.js";
import { formatProtocolModelSelection, optionalModelSelectionFromString } from "./model-mapper.js";
import {
  buildProtocolPermissionOptions,
  toLegacyPermissionOptionsPolicy,
} from "./permission-options.js";
import {
  listProtocolSlashCommands,
  type ListProtocolSlashCommandsOptions,
} from "./slash-commands.js";

const SNAPSHOT_INLINE_IMAGE_DATA_URL_MAX_BYTES = 20 * 1024 * 1024;

export async function buildSessionSnapshot(input: {
  app: ZCodeApp;
  deliveryKind?: ZCodeDeliveryKind;
  eventSeq: number;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
  lastError?: SessionProjection["lastError"];
  messages: MessageWithParts[];
  modelAvailability?: "all" | "current";
  persistedGoalVerificationEvents?: SessionEvent[];
  persistedContextUsageBreakdownEvents?: SessionEvent[];
  session?: SessionInfo | null;
  stateRevision: number;
  slashCommandOptions?: ListProtocolSlashCommandsOptions;
  target?: SessionGoal | null;
  todos?: TodoItem[];
  workspace: ZCodeWorkspaceRef;
}): Promise<ZCodeSessionStateSnapshot> {
  const runtimeProjection = await input.app.runtime.getProjection();
  const activeTurn = input.app.runtime.getActiveTurnInfo();
  const persistedGoalProjection = mergePersistedGoalVerificationEvents(
    runtimeProjection,
    input.persistedGoalVerificationEvents ?? [],
    input.target === undefined ? runtimeProjection.target : input.target,
  );
  // The runtime projection is an eventStore reducer and may lack a target_changed record when
  // restoring a historical session; session_target is authoritative for goal state, so snapshots
  // must use the value read from the database.
  const projectionWithoutTitleFallback =
    input.target === undefined && input.lastError === undefined
      ? persistedGoalProjection
      : {
          ...persistedGoalProjection,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        };
  const projection = withGoalSummaryTitleFallback(
    projectionWithoutTitleFallback,
    input.session,
    input.messages,
  );
  const messages = await mapSnapshotMessages(input.app, input.messages);
  return {
    messages,
    projection: mapSessionProjection(projection),
    protocol: {
      name: ZCODE_PROTOCOL_NAME,
      version: ZCODE_PROTOCOL_VERSION,
    },
    runtime: mapRuntimeState({
      activeTurn,
      deliveryKind: input.deliveryKind,
      eventSeq: input.eventSeq,
      messages: input.messages,
      persistedContextUsageBreakdownEvents: input.persistedContextUsageBreakdownEvents,
      projection,
      stateRevision: input.stateRevision,
    }),
    session: mapSessionInfo({
      app: input.app,
      fallbackCreatedAt: input.fallbackCreatedAt,
      fallbackUpdatedAt: input.fallbackUpdatedAt,
      projection,
      session: input.session,
      workspace: input.workspace,
    }),
    settings: await mapSessionSettings(input.app, {
      currentModelContextWindow: projection.contextWindow,
      modelAvailability: input.modelAvailability,
    }),
    slashCommands: await listProtocolSlashCommands({
      ...input.slashCommandOptions,
      workingDirectory: input.workspace.workspacePath,
    }),
    goalStats: buildGoalStats(projection, input.messages),
    todos: input.todos?.map(mapTodoItem) ?? [],
    todoGroups: buildTodoGroups(input.messages, input.todos ?? [], projection),
  };
}

async function mapSnapshotMessages(
  app: Pick<ZCodeApp, "readToolResultArtifact">,
  messages: readonly MessageWithParts[],
) {
  const mapped = messages.map(mapMessageWithParts);
  return await Promise.all(
    mapped.map(async (message) => ({
      ...message,
      parts: await Promise.all(message.parts.map((part) => hydrateSnapshotFilePartUrl(app, part))),
    })),
  );
}

async function hydrateSnapshotFilePartUrl(
  app: Pick<ZCodeApp, "readToolResultArtifact">,
  part: ReturnType<typeof mapMessageWithParts>["parts"][number],
) {
  // Persisted historical image attachments contain only zcode-artifact:// references, which the
  // UI/mobile clients cannot render directly. Fill in data URLs on the agent side before creating
  // protocol snapshots, so local artifact-directory access does not leak to the frontend.
  if (part.type !== "file" || !isImageMime(part.mime) || isUsableDataUrl(part.url)) {
    return part;
  }
  const artifactUri = snapshotFilePartArtifactUri(part);
  if (!artifactUri) {
    return part;
  }

  try {
    const artifact = await app.readToolResultArtifact(artifactUri);
    const dataUrl = dataUrlFromSnapshotArtifact(artifact.content, artifact.contentType, part.mime);
    if (!dataUrl || Buffer.byteLength(dataUrl, "utf8") > SNAPSHOT_INLINE_IMAGE_DATA_URL_MAX_BYTES) {
      return part;
    }
    return { ...part, url: dataUrl };
  } catch {
    return part;
  }
}

function snapshotFilePartArtifactUri(
  part: Extract<ReturnType<typeof mapMessageWithParts>["parts"][number], { type: "file" }>,
): string | undefined {
  const metadataArtifactUri =
    typeof part.metadata?.artifactUri === "string" ? part.metadata.artifactUri : undefined;
  const artifactUri = metadataArtifactUri ?? part.url;
  return artifactUri.startsWith("zcode-artifact://") ? artifactUri : undefined;
}

function dataUrlFromSnapshotArtifact(
  content: string,
  contentType: string,
  fallbackMime: string,
): string | undefined {
  if (isUsableDataUrl(content)) {
    return content;
  }
  const mediaType = concreteImageMime(contentType) ?? concreteImageMime(fallbackMime);
  if (!mediaType) {
    return undefined;
  }
  return `data:${mediaType};base64,${content}`;
}

function isImageMime(mime: string): boolean {
  return mime === "image/*" || mime.startsWith("image/");
}

function concreteImageMime(mime: string): string | undefined {
  const normalized = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.startsWith("image/") && normalized !== "image/*" ? normalized : undefined;
}

function isUsableDataUrl(value: string): boolean {
  const commaIndex = value.indexOf(",");
  return value.startsWith("data:") && commaIndex >= 0 && value.slice(commaIndex + 1).length > 0;
}

export async function mapSessionSettings(
  app: ZCodeApp,
  options: {
    currentModelContextWindow?: number;
    modelAvailability?: "all" | "current";
  } = {},
): Promise<ZCodeSessionSettingsState> {
  const thoughtLevels = app.listThoughtLevels();
  const rawCurrentThoughtLevel = app.getThoughtLevel();
  // After setModel, runtime may temporarily retain the previous model's thoughtLevel.
  // Protocol snapshots are the source of truth shared by UI/tests and must not return a current
  // value outside the current model's available options.
  const currentThoughtLevel =
    rawCurrentThoughtLevel && thoughtLevels.includes(rawCurrentThoughtLevel)
      ? rawCurrentThoughtLevel
      : undefined;
  const rawDefaultThoughtLevel = app.getDefaultThoughtLevel();
  const defaultThoughtLevel =
    rawDefaultThoughtLevel && thoughtLevels.includes(rawDefaultThoughtLevel)
      ? rawDefaultThoughtLevel
      : undefined;
  const currentModel = app.getModel();
  const currentModelOption = app.getCurrentModelOption?.();
  const availableModels =
    options.modelAvailability === "current"
      ? currentModelOption
        ? [
            {
              ...currentModelOption,
              contextWindow:
                positiveInteger(options.currentModelContextWindow) ??
                currentModelOption.contextWindow,
            },
          ]
        : app
            .listModels()
            .filter((candidate) => formatProtocolModelSelection(candidate.ref) === currentModel)
      : app.listModels();
  return {
    mode: {
      current: app.getMode(),
    },
    model: {
      // In app/stdio scenarios, the provider catalog belongs to app state. Do not return the full
      // model marketplace on every session/read or setModel response; session settings need only
      // describe the current runtime model.
      available: availableModels,
      // The Session's original selection is the basis for resolving later input; strings and
      // filtered tiers would lose the original intent. `current` may be temporarily unexecutable;
      // the shared Selection View determines whether it can be displayed/dispatched.
      current: app.runtime.getSessionModelSelection(),
      lastUsed: optionalModelSelectionFromString(currentModel),
    },
    permission: {
      mode: app.getMode(),
    },
    thoughtLevel: {
      available: thoughtLevels.map((level) => ({ label: level, value: level })),
      current: currentThoughtLevel,
      // Cloud reasoning.defaultLevel exists only in model facts; old settings do not carry the
      // default tier, so when current is empty the UI could incorrectly select available[0].
      ...(defaultThoughtLevel ? { defaultLevel: defaultThoughtLevel } : {}),
      enabled: thoughtLevels.length > 0,
    },
  };
}

export function mapSessionInfo(input: {
  app?: Pick<ZCodeApp, "getMode" | "getModel" | "sessionId" | "traceId">;
  fallbackCreatedAt?: number;
  fallbackUpdatedAt?: number;
  projection?: SessionProjection;
  session?: SessionInfo | null;
  taskType?: SessionInfo["taskType"];
  parentSessionId?: string;
  workspace: ZCodeWorkspaceRef;
}): ZCodeSessionInfo {
  const sessionId = String(input.session?.id ?? input.app?.sessionId ?? "unknown");
  // A newly created protocol session may not have a persisted session row yet.
  // The runtime projection's timestamp may then be inherited from a workspace warm-up draft and
  // must not be used as the official session timestamp.
  const createdAt =
    input.session?.time.created ??
    input.fallbackCreatedAt ??
    input.projection?.createdAt.getTime() ??
    Date.now();
  const updatedAt =
    input.session?.time.updated ??
    input.fallbackUpdatedAt ??
    input.projection?.updatedAt.getTime() ??
    createdAt;
  return {
    archivedAt: input.session?.time.archived,
    createdAt,
    mode: input.projection?.mode ?? input.app?.getMode?.() ?? "build",
    model: input.app ? optionalModelSelectionFromString(input.app.getModel()) : undefined,
    parentSessionId: input.session?.parentID ?? input.parentSessionId,
    traceId: input.session?.traceID ?? input.app?.traceId,
    sessionId,
    sessionKind: (input.session?.taskType ?? input.taskType ?? "interactive") as ZCodeSessionKind,
    status: input.projection?.status ?? "idle",
    target: mapSessionGoal(input.projection?.target),
    title: input.session?.title ?? "",
    titleSource: input.session?.titleSource,
    updatedAt,
    workspace: input.workspace,
  };
}

export function mapSessionEvent(
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: { seq?: number } = {},
): ZCodeSessionEvent {
  return {
    deliveryKind,
    eventId: String(event.id),
    payload: mapSessionEventPayload(event),
    seq: options.seq ?? event.sequenceNumber,
    sessionId: String(event.sessionId),
    timestamp: event.timestamp.getTime(),
    traceId: String(event.traceId),
    turnId: event.turnId ? String(event.turnId) : undefined,
    type: mapSessionEventType(event.type),
  };
}

export function mapSessionEventForProtocol(
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: { seq?: number } = {},
): ZCodeSessionEvent | null {
  if (!shouldExposeSessionEventToProtocol(event)) {
    return null;
  }
  return mapSessionEvent(event, deliveryKind, options);
}

export function mapSessionEvents(
  events: readonly SessionEvent[],
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeSessionEvent[] {
  return events
    .map((event) => mapSessionEventForProtocol(event, deliveryKind))
    .filter((event): event is ZCodeSessionEvent => event !== null);
}

export function shouldExposeSessionEventToProtocol(event: SessionEvent): boolean {
  if (event.type === SessionEventType.StreamingToolLedgerUpdated) {
    // Performance fix: StreamingToolLedgerUpdated is a runtime replay ledger and often carries the
    // same full tool input at closed/queued/started/committed stages. The UI protocol stream already
    // has model.streaming/tool.updated lifecycle events; forwarding this too would repeatedly
    // transfer large arguments across processes, and the mapper does not consume these internal states.
    return false;
  }

  if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
    // Same seam and rationale as above: workflow-run events are identical in v3 and v4. The v4
    // surface already has an authoritative projection (workflowRuns state key), while the v3
    // mapper does not consume these internal states; forwarding them would transfer every node
    // phase transition across processes. **Unlike the feature above, skew is not a concern here**:
    // stripping these events is not needed to prevent loss, because v3 will accept the new type
    // (mapSessionEventType defaults to session.updated with a permissive jsonObjectSchema payload).
    // This is purely for bandwidth and semantic clarity.
    return false;
  }

  if (event.type !== SessionEventType.ModelStreaming) {
    return true;
  }

  const payload = asRecord(event.payload);
  const kind = stringValue(payload.kind);
  const delta = stringValue(payload.delta);
  // Now that the UI supports tool-argument previews, do not drop tool_input_* at the protocol
  // boundary; otherwise Write/Edit remain invisible while the model is thinking. Runtime delta
  // coalescing controls pressure from small events.
  if (kind === "text_delta" || kind === "reasoning_delta") {
    return Boolean(delta);
  }
  return (
    kind === "tool_input_start" ||
    kind === "tool_input_delta" ||
    kind === "tool_input_end" ||
    kind === "tool_call"
  );
}

function mapSessionEventPayload(event: SessionEvent): unknown {
  const payload = event.payload;
  switch (event.type) {
    case SessionEventType.ModelRequest:
      return mapModelRequestPayload(payload);
    case SessionEventType.ModelNetworkStatus:
      return mapModelNetworkStatusPayload(payload);
    case SessionEventType.StreamRecoveryAnchorCreated:
    case SessionEventType.StreamRecoveryStarted:
    case SessionEventType.StreamRecoveryAnchorSelected:
    case SessionEventType.StreamRecoveryRetryStarted:
    case SessionEventType.StreamRecoveryTailDiscarded:
    case SessionEventType.StreamRecoveryBlocked:
      return mapStreamRecoveryPayload(payload);
    case SessionEventType.ToolCallScheduled:
      return { ...(payload as Record<string, unknown>), kind: "scheduled" };
    case SessionEventType.ToolCallStarted:
      return mapToolCallStartedPayload(payload, event.timestamp);
    case SessionEventType.ToolCallProgress:
      return { ...(payload as Record<string, unknown>), kind: "progress" };
    case SessionEventType.ToolCallResult:
      return { ...(payload as Record<string, unknown>), kind: "result" };
    case SessionEventType.ToolCallError:
      return { ...(payload as Record<string, unknown>), kind: "error" };
    case SessionEventType.ToolBatchComplete:
      return { ...(payload as Record<string, unknown>), kind: "batch" };
    case SessionEventType.PermissionRequested:
      return mapPermissionRequestedPayload(payload);
    case SessionEventType.PermissionDenied:
      return mapPermissionDeniedPayload(payload);
    default:
      return payload;
  }
}

function mapPermissionDeniedPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    ...record,
    // PermissionDenied reuses the permission.resolved protocol event.
    // Downstream projection requires decision=deny to close the already-visible tool card as failed.
    decision: "deny",
  };
}

function mapToolCallStartedPayload(
  payload: unknown,
  eventTimestamp: Date,
): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    ...record,
    // ToolCallStarted.startedAt comes from a runtime Date object; after crossing the protocol
    // process boundary it must be a stable JSON value or the receiving strict schema drops the
    // started event as invalid.
    startedAt: protocolInstantValue(record.startedAt) ?? eventTimestamp.getTime(),
    kind: "started",
  };
}

function protocolInstantValue(value: unknown): number | string | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function mapModelRequestPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const result: Record<string, unknown> = {
    messageCount: messages.length,
  };
  for (const key of [
    "providerId",
    "modelId",
    "temperature",
    "maxTokens",
    "toolCount",
    "iteration",
  ]) {
    if (record[key] !== undefined) {
      result[key] = record[key];
    }
  }
  // model_request messages contain the full context sent to the model and are for core-internal
  // tracing only. Previously mapping them to session.updated repeatedly pushed the full context
  // to desktop, making each packet larger as tool turns accumulated.
  return result;
}

function mapModelNetworkStatusPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const apiRetry = zcodeApiRetryFromModelNetworkStatusPayload(record);
  if (apiRetry === undefined) {
    return record;
  }
  const meta = asRecord(record._meta);
  const zcodeMeta = asRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcodeMeta,
        // Network retries are model-request runtime state, not persistable message content.
        // Expose them here through app-private metadata for the legacy task projection; the app then
        // writes them into the host runtime snapshot.
        apiRetry,
      },
    },
  };
}

function mapStreamRecoveryPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const apiRetry = zcodeApiRetryFromStreamRecoveryPayload(record);
  if (apiRetry === undefined) {
    return record;
  }
  const meta = asRecord(record._meta);
  const zcodeMeta = asRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcodeMeta,
        // streamRecovery.updated is the key progress event for SSE disconnect recovery.
        // Previously metadata was added only on a later model_request_started; if the UI missed
        // that event, retry counts were not displayed.
        apiRetry,
      },
    },
  };
}

function mapSessionProjection(projection: SessionProjection): ZCodeSessionProjection {
  return {
    activeToolCalls: projection.activeToolCalls.map(mapActiveToolCall),
    backgroundJobs: projection.backgroundTasks.map(mapBackgroundTask),
    contextUsed: projection.contextUsed,
    contextWindow: projection.contextWindow,
    currentTurnId: projection.currentTurnId ? String(projection.currentTurnId) : undefined,
    lastError: projection.lastError,
    mode: projection.mode,
    pendingPermissions: projection.pendingPermissions.map(mapPendingPermission),
    sessionId: String(projection.id),
    status: projection.status,
    target: mapSessionGoal(projection.target),
    totalTokenCount: projection.totalTokenCount,
    turnCount: projection.turnCount,
  };
}

function mapRuntimeState(input: {
  activeTurn?: ReturnType<ZCodeApp["runtime"]["getActiveTurnInfo"]>;
  deliveryKind?: ZCodeDeliveryKind;
  eventSeq: number;
  messages: MessageWithParts[];
  persistedContextUsageBreakdownEvents?: readonly SessionEvent[];
  projection: SessionProjection;
  stateRevision: number;
}): ZCodeSessionRuntimeState {
  // projection.currentTurnId is the last turn processed by the projection, not necessarily a
  // currently running turn. If a session restore/subscribe snapshot copies it into
  // runtime.activeTurnId, already-idle/completed tasks appear to be thinking.
  const activeTurnId = input.activeTurn?.turnId;
  const contextUsage = resolveSessionContextUsage({
    messages: input.messages,
    persistedContextUsageBreakdownEvents: input.persistedContextUsageBreakdownEvents,
    projection: input.projection,
  });
  // Shared runtime schema already represents running turns through activeTurnId/activeTurnKind.
  // mainActive is an old UI-derived field; continuing to emit it from CLI snapshots breaks an
  // independent bootstrap build.
  return {
    activeTurnId: activeTurnId ? String(activeTurnId) : undefined,
    activeTurnKind: input.activeTurn?.kind,
    deliveryKind: input.deliveryKind,
    eventSeq: input.eventSeq,
    pendingRequestIds: input.projection.pendingPermissions.map(
      (permission) => permission.requestId ?? permission.toolCallId,
    ),
    ...(contextUsage ? { contextUsage } : {}),
    goalVerifications: mapGoalVerifications(input.projection.targetCompletionVerifications),
    goalVerificationTimeline: mapGoalVerificationTimeline(
      input.projection.targetCompletionVerificationTimeline,
    ),
    stateRevision: input.stateRevision,
  };
}

interface ContextUsageBreakdownCandidate {
  breakdown: ZCodeContextUsageBreakdownItem[];
  contextWindow?: number;
  used: number;
}

/**
 * Shared calculation semantics for legacy snapshots and the V4 narrow usage seed.
 *
 * V4 cold restore needs only context usage, but previously read it indirectly through a full legacy
 * snapshot. Extracting this pure projection lets both paths share the active-branch token/cache and
 * breakdown-alignment rules.
 */
export function resolveSessionContextUsage(input: {
  messages: readonly MessageWithParts[];
  persistedContextUsageBreakdownEvents?: readonly SessionEvent[];
  projection: SessionProjection;
}): ZCodeSessionContextUsage | undefined {
  const persistedContextUsage = contextUsageFromPersistedMessages(
    input.messages,
    input.projection.contextWindow,
  );
  return applyContextUsageBreakdown(
    contextUsageFromProjection(
      input.projection,
      persistedContextUsage?.used === input.projection.contextUsed
        ? persistedContextUsage.cache
        : undefined,
    ) ?? persistedContextUsage,
    latestContextUsageBreakdownFromEvents(input.persistedContextUsageBreakdownEvents ?? []),
  );
}

function applyContextUsageBreakdown(
  contextUsage: ZCodeSessionContextUsage | undefined,
  candidate: ContextUsageBreakdownCandidate | undefined,
): ZCodeSessionContextUsage | undefined {
  if (!contextUsage || !candidate || candidate.breakdown.length === 0) {
    return contextUsage;
  }
  if (contextUsage.breakdown && contextUsage.breakdown.length > 0) {
    return contextUsage;
  }
  if (candidate.used !== contextUsage.used) {
    return contextUsage;
  }
  if (candidate.contextWindow !== undefined && candidate.contextWindow !== contextUsage.size) {
    return contextUsage;
  }
  return {
    ...contextUsage,
    breakdown: candidate.breakdown,
  };
}

function latestContextUsageBreakdownFromEvents(
  events: readonly SessionEvent[],
): ContextUsageBreakdownCandidate | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== SessionEventType.ModelComplete) {
      continue;
    }
    const payload = event.payload as Partial<ModelCompletePayload>;
    const querySource = stringValue(payload.querySource);
    if (querySource !== undefined && querySource !== "main_turn") {
      continue;
    }
    const parsed = zcodeContextUsageBreakdownSchema.safeParse(payload.contextUsageBreakdown);
    const used = getModelUsageContextTokens(payload.usage);
    if (!parsed.success || parsed.data.length === 0 || used === undefined) {
      continue;
    }
    const contextWindow = positiveInteger(payload.contextWindow);
    // Cold restore can rebuild context breakdown only from eventStore; align by usage/window so
    // source ratios from an old branch or sidecar model request are not attached to the current task meter.
    return {
      breakdown: parsed.data,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      used,
    };
  }
  return undefined;
}

function mapGoalVerifications(
  verifications: SessionProjection["targetCompletionVerifications"] | undefined,
): ZCodeSessionGoalVerification[] {
  return (verifications ?? []).map((verification) => ({
    nextAction: verification.nextAction ?? null,
    passed: verification.passed,
    reason: verification.reason,
  }));
}

function mapGoalVerificationTimeline(
  timeline: SessionProjection["targetCompletionVerificationTimeline"] | undefined,
): ZCodeSessionGoalVerificationTimeline[] {
  return (timeline ?? []).map((item) => ({
    version: 1,
    kind: "synthetic",
    type: "goal_verification",
    display: "separator",
    targetId: item.targetId,
    verificationId: item.verificationId,
    status: item.status,
    ...(item.goalIteration ? { goalIteration: item.goalIteration } : {}),
    ...(item.anchorAssistantMessageId
      ? { anchorAssistantMessageId: item.anchorAssistantMessageId }
      : {}),
    ...(item.anchorTurnId ? { anchorTurnId: item.anchorTurnId } : {}),
    ...(item.verification
      ? {
          verification: {
            nextAction: item.verification.nextAction ?? null,
            passed: item.verification.passed,
            reason: item.verification.reason,
          },
        }
      : {}),
    ...(item.startedAt ? { startedAt: item.startedAt.getTime() } : {}),
    updatedAt: item.updatedAt.getTime(),
  }));
}

function contextUsageFromProjection(
  projection: SessionProjection,
  cache: ZCodeSessionContextUsage["cache"] | undefined,
): ZCodeSessionContextUsage | undefined {
  if (projection.contextUsed <= 0 || projection.contextWindow <= 0) {
    return undefined;
  }
  return {
    ...(cache ? { cache } : {}),
    cost: null,
    size: projection.contextWindow,
    used: projection.contextUsed,
  };
}

function contextUsageFromPersistedMessages(
  messages: readonly MessageWithParts[],
  contextWindow: number,
): ZCodeSessionContextUsage | undefined {
  if (contextWindow <= 0) {
    return undefined;
  }
  const cache = contextCacheUsageFromMessages(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (message.info.role === "user" && message.info.summary) {
      const compactPart = message.parts.find(
        (part) => part.type === "compaction" && part.compactBoundary,
      );
      if (compactPart?.type === "compaction" && compactPart.compactBoundary) {
        const used = positiveInteger(
          compactPart.compactBoundary.truePostCompactTokenCount ??
            compactPart.compactBoundary.postCompactTokenCount,
        );
        // Usage from successful compaction is persisted at the user summary boundary; scanning
        // assistant messages only would skip it and restore the pre-compaction watermark. Older
        // assistant boundaries and incomplete histories still use the existing fallback, and must
        // not attach pre-compaction cache to the post-compaction watermark.
        if (used !== undefined) {
          return {
            cost: null,
            size: contextWindow,
            used,
          };
        }
      }
    }
    if (message.info.role !== "assistant" || message.info.summary) {
      continue;
    }
    const used = contextUsedFromTokens(message.info.tokens);
    if (used === undefined) {
      continue;
    }
    // protocol eventStore is an in-memory runtime ledger, so after restart/resume projection.contextUsed returns to 0.
    // Context-window consumption is input + output; restore from provider total when available,
    // otherwise reconstruct the meter from persisted input/output.
    return {
      ...(cache ? { cache } : {}),
      cost: null,
      size: contextWindow,
      used,
    };
  }
  return undefined;
}

function contextUsedFromTokens(
  tokens:
    | {
        total?: number;
        input: number;
        output?: number;
      }
    | undefined,
): number | undefined {
  if (!tokens) {
    return undefined;
  }

  const total = positiveInteger(tokens.total);
  if (total !== undefined) {
    return total;
  }

  const input = positiveInteger(tokens.input);
  if (input === undefined) {
    return undefined;
  }

  return input + (nonNegativeInteger(tokens.output) ?? 0);
}

function contextCacheUsageFromMessages(
  messages: readonly MessageWithParts[],
): ZCodeSessionContextUsage["cache"] | undefined {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let requestCount = 0;
  let latestInputTokens = 0;
  let latestCacheReadTokens = 0;
  let latestCacheWriteTokens = 0;

  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.summary) {
      continue;
    }
    const input = nonNegativeInteger(message.info.tokens.input) ?? 0;
    const read = nonNegativeInteger(message.info.tokens.cache.read) ?? 0;
    const write = nonNegativeInteger(message.info.tokens.cache.write) ?? 0;
    if (input <= 0 && read <= 0 && write <= 0) {
      continue;
    }
    requestCount += 1;
    inputTokens += input;
    cacheReadTokens += read;
    cacheWriteTokens += write;
    latestInputTokens = input;
    latestCacheReadTokens = read;
    latestCacheWriteTokens = write;
  }

  if (requestCount <= 0) {
    return undefined;
  }
  return {
    inputTokens: latestInputTokens,
    cacheReadTokens: latestCacheReadTokens,
    cacheWriteTokens: latestCacheWriteTokens,
    latestHitRate: latestInputTokens > 0 ? latestCacheReadTokens / latestInputTokens : null,
    hitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : null,
    hitRateRequestCount: requestCount,
    totalInputTokens: inputTokens,
    totalCacheReadTokens: cacheReadTokens,
    totalCacheWriteTokens: cacheWriteTokens,
  };
}

function mapPendingPermission(permission: PendingPermission): ZCodePendingPermission {
  // Deliberately omit display/optionsPolicy from legacy v3 output.
  // The root cause is not that "schema expansion is only backward-compatible in one direction";
  // strict schemas are bundled into every desktop build from packages/shared. Making
  // zcodePendingPermissionSchema (shared/src/zcode-protocol/index.ts:1139) and
  // zcodePermissionRequestedEventPayloadSchema (same file:1536) optional today would not protect
  // already-shipped desktop clients. If a new CLI sends these fields over v3, an old desktop fails
  // to parse the whole snapshot and safeParse silently drops the permission.requested event, taking
  // away the confirmation dialog. That violates "preview may degrade, gate may not." Stripping at
  // the source is the only version-skew-safe approach; legacy also has no causal-graph UI.
  // optionsPolicy still takes effect: it is input to buildProtocolPermissionOptions, which removes
  // allow_always, and only the reduced options list crosses the protocol. Session-level approval is
  // likewise reduced to a list; old desktops return the raw response and cannot recognize its
  // session semantics (see toLegacyPermissionOptionsPolicy).
  return {
    input: permission.input,
    ...(permission.origin ? { origin: permission.origin } : {}),
    options: buildProtocolPermissionOptions({
      ...permission,
      optionsPolicy: toLegacyPermissionOptionsPolicy(permission.optionsPolicy),
    }),
    reason: permission.reason ?? "",
    requestId: permission.requestId ?? permission.toolCallId,
    requestedAt: permission.requestedAt.getTime(),
    riskLevel: permission.riskLevel,
    toolCallId: permission.toolCallId,
    toolName: permission.toolName,
  };
}

function mapPermissionRequestedPayload(payload: unknown): Record<string, unknown> {
  // Same as mapPendingPermission: this payload is spread as a whole, so destructure new fields out
  // here explicitly or they will leak into the strict zcodePermissionRequestedEventPayloadSchema.
  const { display: _display, optionsPolicy, ...record } = asRecord(payload);
  const toolName = stringValue(record.toolName) ?? "unknown";
  return {
    ...record,
    options: buildProtocolPermissionOptions({
      input: record.input,
      suggestedPermissionUpdates: Array.isArray(record.suggestedPermissionUpdates)
        ? (record.suggestedPermissionUpdates as PendingPermission["suggestedPermissionUpdates"])
        : undefined,
      optionsPolicy: toLegacyPermissionOptionsPolicy(optionsPolicy),
      toolName,
    }),
  };
}

function mapActiveToolCall(toolCall: ActiveToolCall): ZCodeActiveToolCall {
  return {
    startedAt: toolCall.startedAt?.getTime(),
    status: toolCall.status,
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
  };
}

function mapBackgroundTask(task: BackgroundTaskInfo): Record<string, unknown> {
  return { ...task };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function mergePersistedGoalVerificationEvents(
  projection: SessionProjection,
  events: readonly SessionEvent[],
  target?: SessionGoal | null,
): SessionProjection {
  if (events.length === 0) {
    return projection;
  }

  const baseProjection = {
    ...projection,
    targetCompletionVerifications: projection.targetCompletionVerifications ?? [],
    targetCompletionVerificationTimeline: projection.targetCompletionVerificationTimeline ?? [],
  };
  const targetId = target?.targetID ?? projection.target?.targetID;
  const reducer = new EventReducer();
  const restored = [...events]
    .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
    .filter((event) => {
      const payload = asRecord(event.payload);
      const eventTargetId = stringValue(payload.targetId);
      return !targetId || !eventTargetId || eventTargetId === targetId;
    })
    .sort(compareEventsByTimelineTime)
    .reduce((current, event) => reducer.apply(current, event), baseProjection);
  const timeline = getTargetGoalVerificationTimeline(restored, target).sort(
    compareGoalVerificationTimeline,
  );
  return {
    ...restored,
    targetCompletionVerificationTimeline: timeline,
    targetCompletionVerifications: mergeGoalVerificationSummaries(
      restored.targetCompletionVerifications,
      timeline,
    ),
  };
}

function compareEventsByTimelineTime(left: SessionEvent, right: SessionEvent): number {
  const byTime = left.timestamp.getTime() - right.timestamp.getTime();
  if (byTime !== 0) return byTime;
  return left.sequenceNumber - right.sequenceNumber;
}

function mergeGoalVerificationSummaries(
  verifications: readonly GoalCompletionVerificationOutput[],
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): GoalCompletionVerificationOutput[] {
  const result: GoalCompletionVerificationOutput[] = [];
  const seen = new Set<string>();
  for (const verification of [
    ...verifications,
    ...timeline
      .map((item) => item.verification)
      .filter((item): item is GoalCompletionVerificationOutput => item !== undefined),
  ]) {
    const key = goalVerificationSummaryKey(verification);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(verification);
  }
  return result;
}

function goalVerificationSummaryKey(verification: GoalCompletionVerificationOutput): string {
  return [
    verification.passed ? "1" : "0",
    normalizeTodoContent(verification.reason),
    normalizeTodoContent(verification.nextAction ?? ""),
  ].join("\u0000");
}

function withGoalSummaryTitleFallback(
  projection: SessionProjection,
  session: SessionInfo | null | undefined,
  messages: readonly MessageWithParts[],
): SessionProjection {
  const target = projection.target;
  if (!target || target.summaryTitle || !session?.title) {
    return projection;
  }
  const firstUserMessage = messages
    .filter((message) => message.info.role === "user")
    .sort(compareMessagesByCreatedTime)[0];
  if (
    !firstUserMessage ||
    Math.abs(firstUserMessage.info.time.created - target.time.created) > 5_000
  ) {
    return projection;
  }
  if (normalizeText(readMessageText(firstUserMessage)) !== normalizeText(target.objective)) {
    return projection;
  }
  return {
    ...projection,
    target: {
      ...target,
      // When the first user request is itself a goal, the session title is the durable source for
      // the first-round title. Older data may lack target.summaryTitle, so after restore use
      // session.title to fill in the first-round title.
      summaryTitle: session.title,
    },
  };
}

function readMessageText(message: MessageWithParts): string {
  return message.parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function mapSessionGoal(goal: SessionGoal | null | undefined): ZCodeSessionGoal | null | undefined {
  if (goal === undefined) return undefined;
  if (goal === null) return null;
  return {
    createdAt: goal.time.created,
    objective: goal.objective,
    sessionId: String(goal.sessionID),
    status: goal.status,
    summaryTitle: goal.summaryTitle,
    targetId: goal.targetID,
    timeUsedSeconds: goal.timeUsedSeconds ?? 0,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed ?? 0,
    activeInputId: goal.activeInputId ?? null,
    activeRunStartedAtMs: goal.activeRunStartedAtMs ?? null,
    activeRunLastSeenAtMs: goal.activeRunLastSeenAtMs ?? null,
    updatedAt: goal.time.updated,
  };
}

function mapTodoItem(todo: TodoItem): TodoItem {
  return {
    content: todo.content,
    priority: todo.priority,
    status: todo.status,
  };
}

interface GoalIterationBucket {
  goalIteration: number;
  id: string;
  messageIds: Set<string>;
  startedAt?: number;
  targetId?: string;
  toolCallCount: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt?: number;
}

function buildGoalStats(
  projection: SessionProjection,
  messages: readonly MessageWithParts[],
): ZCodeSessionGoalStats | undefined {
  const target = projection.target;
  if (!target) {
    return undefined;
  }
  const goalIterations = collectGoalIterationBuckets(messages, {
    projection,
    target,
  });
  const activeIterationCount = getGoalActiveIterationCount(projection, target);
  const derivedTokensUsed = goalIterations.reduce(
    (sum, iteration) => sum + iteration.tokensUsed,
    0,
  );
  const derivedTimeUsedSeconds = goalIterations.reduce(
    (sum, iteration) => sum + iteration.timeUsedSeconds,
    0,
  );
  return {
    contextUsed: projection.contextUsed,
    contextWindow: projection.contextWindow,
    // Goal rounds advance only at verifier lifecycle boundaries; user messages, TodoWrite, or
    // manual continuation belong to the currently open round and cannot start a new one by themselves.
    iterationCount: activeIterationCount,
    // The active goal run is already represented by session_target.active_run_started_at.
    // While it is running, do not use a timestamp inferred from assistant messages as the settled
    // base; the UI would add the live run again and double-count after switching/restoring.
    timeUsedSeconds:
      target.timeUsedSeconds > 0 || target.activeRunStartedAtMs != null
        ? target.timeUsedSeconds
        : derivedTimeUsedSeconds,
    // Older session_target rows may have no tokenBudget. The protocol schema requires a stable JSON
    // value, so use null for an unset budget, matching mapSessionGoal.
    tokenBudget: target.tokenBudget ?? null,
    tokensUsed: target.tokensUsed > 0 ? target.tokensUsed : derivedTokensUsed,
    toolCallCount: goalIterations.reduce((sum, iteration) => sum + iteration.toolCallCount, 0),
  };
}

function buildTodoGroups(
  messages: readonly MessageWithParts[],
  currentTodos: readonly TodoItem[],
  projection: SessionProjection,
): ZCodeSessionTodoGroup[] {
  const target = projection.target;
  const timeline = getTargetGoalVerificationTimeline(projection, target);
  const groups = new Map<string, ZCodeSessionTodoGroup>();
  const todoOwners = new Map<string, { fingerprint: string; groupId: string }>();
  const sortedMessages = [...messages].sort(compareMessagesByCreatedTime);

  for (const message of sortedMessages) {
    if (message.info.role !== "assistant") {
      continue;
    }
    const goalIteration = getGoalIterationForMessageTime(
      message.info.time.created,
      target,
      timeline,
    );
    for (const part of message.parts) {
      if (
        part.type !== "tool" ||
        !isTodoWriteToolName(part.tool) ||
        !isMainAgentToolProjectionSource(part.metadata, readToolStateMetadata(part.state))
      ) {
        continue;
      }
      const todos = readTodosFromToolInput(part.state.input);
      if (!todos) {
        continue;
      }
      const updatedAt =
        readToolStateUpdatedAt(part.state) ??
        message.info.time.completed ??
        message.info.time.created;
      const groupId = goalIteration ? `goal-iteration-${goalIteration}` : "session";
      const group = ensureTodoGroup(groups, {
        goalIteration,
        groupId,
        startedAt: goalIteration
          ? getGoalIterationStartedAt(goalIteration, target, timeline, message.info.time.created)
          : message.info.time.created,
        targetId: goalIteration ? target?.targetID : undefined,
        updatedAt,
      });
      for (const todo of todos) {
        const fingerprint = normalizeTodoContent(todo.content);
        const ownerKey = `${target?.targetID ?? "session"}\u0000${fingerprint}`;
        const owner = todoOwners.get(ownerKey);
        if (owner) {
          const ownerGroup = groups.get(owner.groupId);
          if (ownerGroup) {
            addOrUpdateTodoInGroup(ownerGroup, owner.fingerprint, todo);
            ownerGroup.updatedAt = Math.max(ownerGroup.updatedAt ?? 0, updatedAt);
          }
          continue;
        }
        todoOwners.set(ownerKey, { fingerprint, groupId });
        addOrUpdateTodoInGroup(group, fingerprint, todo);
      }
    }
  }

  if (groups.size === 0 && currentTodos.length > 0) {
    groups.set("session-current", {
      id: "session-current",
      source: "session",
      todos: currentTodos.map(mapTodoItem),
    });
  }

  return [...groups.values()].sort((left, right) => {
    const leftTime = left.startedAt ?? Number.MAX_SAFE_INTEGER;
    const rightTime = right.startedAt ?? Number.MAX_SAFE_INTEGER;
    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.id.localeCompare(right.id);
  });
}

function ensureTodoGroup(
  groups: Map<string, ZCodeSessionTodoGroup>,
  input: {
    goalIteration: number | undefined;
    groupId: string;
    startedAt: number;
    targetId?: string;
    updatedAt: number;
  },
): ZCodeSessionTodoGroup {
  const existing = groups.get(input.groupId);
  if (existing) {
    existing.updatedAt = Math.max(existing.updatedAt ?? 0, input.updatedAt);
    return existing;
  }
  const group: ZCodeSessionTodoGroup = {
    id: input.groupId,
    source: input.goalIteration ? "goal_iteration" : "session",
    ...(input.goalIteration ? { goalIteration: input.goalIteration } : {}),
    ...(input.targetId ? { targetId: input.targetId } : {}),
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    todos: [],
  };
  groups.set(input.groupId, group);
  return group;
}

function addOrUpdateTodoInGroup(
  group: ZCodeSessionTodoGroup,
  fingerprint: string,
  todo: TodoItem,
): void {
  const nextTodo = mapTodoItem(todo);
  const existingIndex = group.todos.findIndex(
    (item) => normalizeTodoContent(item.content) === fingerprint,
  );
  if (existingIndex >= 0) {
    group.todos[existingIndex] = nextTodo;
    return;
  }
  group.todos.push(nextTodo);
}

function getGoalActiveIterationCount(
  projection: SessionProjection,
  target?: SessionGoal | null,
): number {
  const timeline = getTargetGoalVerificationTimeline(projection, target);
  return getZCodeGoalActiveIterationCount({
    targetStatus: target?.status ?? null,
    timeline,
  });
}

function collectGoalIterationBuckets(
  messages: readonly MessageWithParts[],
  options: { projection: SessionProjection; target?: SessionGoal | null },
): GoalIterationBucket[] {
  const target = options.target ?? null;
  const timeline = getTargetGoalVerificationTimeline(options.projection, target);
  const buckets: GoalIterationBucket[] = [];
  const byIteration = new Map<number, GoalIterationBucket>();
  const sortedMessages = [...messages].sort(compareMessagesByCreatedTime);

  for (const message of sortedMessages) {
    if (message.info.role !== "assistant") {
      continue;
    }
    const goalIteration = getGoalIterationForMessageTime(
      message.info.time.created,
      target,
      timeline,
    );
    if (!goalIteration) {
      continue;
    }
    const bucket =
      byIteration.get(goalIteration) ??
      createGoalIterationBucket(goalIteration, target, timeline, message.info.time.created);
    if (!byIteration.has(goalIteration)) {
      byIteration.set(goalIteration, bucket);
      buckets.push(bucket);
    }
    const messageId = String(message.info.id);
    bucket.messageIds.add(messageId);
    const completedAt = message.info.time.completed ?? message.info.time.created;
    bucket.toolCallCount += message.parts.filter((part) => part.type === "tool").length;
    bucket.tokensUsed += tokenTotal(message.info.tokens);
    bucket.timeUsedSeconds += Math.max(
      0,
      Math.ceil((completedAt - message.info.time.created) / 1000),
    );
    bucket.updatedAt = Math.max(bucket.updatedAt ?? 0, completedAt);
  }

  return buckets;
}

function createGoalIterationBucket(
  goalIteration: number,
  target: SessionGoal | null,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
  fallbackStartedAt: number,
): GoalIterationBucket {
  return {
    goalIteration,
    id: `goal-iteration-${goalIteration}`,
    messageIds: new Set(),
    startedAt: getGoalIterationStartedAt(goalIteration, target, timeline, fallbackStartedAt),
    targetId: target?.targetID,
    toolCallCount: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    updatedAt: fallbackStartedAt,
  };
}

function getTargetGoalVerificationTimeline(
  projection: SessionProjection,
  target?: SessionGoal | null,
): SessionProjection["targetCompletionVerificationTimeline"] {
  const targetId = target?.targetID;
  return (projection.targetCompletionVerificationTimeline ?? [])
    .filter((item) => !targetId || item.targetId === targetId)
    .sort(compareGoalVerificationTimeline);
}

function compareGoalVerificationTimeline(
  left: SessionProjection["targetCompletionVerificationTimeline"][number],
  right: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  const leftIteration = left.goalIteration ?? 0;
  const rightIteration = right.goalIteration ?? 0;
  if (leftIteration !== rightIteration && leftIteration > 0 && rightIteration > 0) {
    return leftIteration - rightIteration;
  }
  const byTime = goalVerificationTimelineTime(left) - goalVerificationTimelineTime(right);
  if (byTime !== 0) return byTime;
  return left.verificationId.localeCompare(right.verificationId);
}

function goalVerificationTimelineTime(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  return (item.startedAt ?? item.updatedAt).getTime();
}

function getGoalIterationForMessageTime(
  messageCreatedAt: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): number | undefined {
  if (!target || messageCreatedAt < target.time.created) {
    return undefined;
  }
  let activeIteration = 1;
  for (const item of timeline) {
    const itemIteration = item.goalIteration ?? activeIteration;
    const boundaryTime = item.updatedAt.getTime();
    if (messageCreatedAt <= boundaryTime) {
      return itemIteration;
    }
    if (item.status === "started") {
      activeIteration = itemIteration;
      continue;
    }
    if (isPassingGoalVerification(item)) {
      return undefined;
    }
    activeIteration = itemIteration + 1;
  }
  return activeIteration;
}

function getGoalIterationStartedAt(
  goalIteration: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
  fallbackStartedAt: number,
): number {
  if (!target || goalIteration <= 1) {
    return target?.time.created ?? fallbackStartedAt;
  }
  const previousBoundary = [...timeline]
    .filter((item) => (item.goalIteration ?? 0) === goalIteration - 1)
    .filter((item) => item.status !== "started")
    .sort(compareGoalVerificationTimeline)
    .at(-1);
  return previousBoundary?.updatedAt.getTime() ?? fallbackStartedAt;
}

function isPassingGoalVerification(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): boolean {
  return item.status === "completed" && item.verification?.passed === true;
}

function normalizeTodoContent(content: string): string {
  return normalizeText(content);
}

function readTodosFromToolInput(input: Record<string, unknown>): TodoItem[] | undefined {
  const rawTodos = input.todos;
  if (!Array.isArray(rawTodos)) {
    return undefined;
  }
  const todos = rawTodos.map(readTodoItem).filter((todo): todo is TodoItem => todo !== null);
  return todos.length === rawTodos.length ? todos : undefined;
}

function readTodoItem(value: unknown): TodoItem | null {
  const record = asRecord(value);
  const content = stringValue(record.content)?.trim();
  const status = stringValue(record.status);
  const priority = stringValue(record.priority);
  if (!content || !isTodoStatus(status) || !isTodoPriority(priority)) {
    return null;
  }
  return { content, priority, status };
}

function isTodoWriteToolName(toolName: string): boolean {
  return toolName.toLowerCase().replace(/[_\s-]/g, "") === "todowrite";
}

function readToolStateMetadata(state: ToolState): Record<string, unknown> | undefined {
  switch (state.status) {
    case "pending":
      return undefined;
    case "running":
    case "completed":
    case "error":
      return state.metadata;
  }
}

function isTodoStatus(status: string | undefined): status is TodoItem["status"] {
  return status === "pending" || status === "in_progress" || status === "completed";
}

function isTodoPriority(priority: string | undefined): priority is TodoItem["priority"] {
  return priority === "high" || priority === "medium" || priority === "low";
}

function readToolStateUpdatedAt(state: ToolState): number | undefined {
  if (state.status === "completed" || state.status === "error") {
    return state.time.end;
  }
  if (state.status === "running") {
    return state.time.start;
  }
  return undefined;
}

function tokenTotal(tokens: {
  cache: { read: number; write: number };
  input: number;
  output: number;
  reasoning: number;
  total?: number;
}): number {
  return (
    tokens.total ??
    tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  );
}

function compareMessagesByCreatedTime(left: MessageWithParts, right: MessageWithParts): number {
  const byTime = left.info.time.created - right.info.time.created;
  if (byTime !== 0) return byTime;
  return String(left.info.id).localeCompare(String(right.info.id));
}

function mapSessionEventType(type: SessionEvent["type"]): ZCodeSessionEvent["type"] {
  switch (type) {
    case SessionEventType.SessionCreated:
      return "session.created";
    case SessionEventType.SessionResumed:
      return "session.resumed";
    case SessionEventType.SessionTitleUpdated:
      return "session.titleUpdated";
    case SessionEventType.SessionEnded:
      return "session.closed";
    case SessionEventType.TurnStarted:
      return "turn.started";
    case SessionEventType.TurnSteerQueued:
      return "turn.steerQueued";
    case SessionEventType.TurnSteerDrained:
      return "turn.steerDrained";
    case SessionEventType.TurnComplete:
      return "turn.completed";
    case SessionEventType.TurnError:
      return "turn.failed";
    case SessionEventType.UserMessage:
    case SessionEventType.AssistantMessage:
    case SessionEventType.SystemMessage:
      return "message.upserted";
    case SessionEventType.ModelStreaming:
      return "model.streaming";
    case SessionEventType.ToolCallScheduled:
    case SessionEventType.ToolCallStarted:
    case SessionEventType.ToolCallProgress:
    case SessionEventType.ToolCallResult:
    case SessionEventType.ToolCallError:
    case SessionEventType.ToolBatchComplete:
      return "tool.updated";
    case SessionEventType.PermissionRequested:
      return "permission.requested";
    case SessionEventType.PermissionResolved:
    case SessionEventType.PermissionDenied:
      return "permission.resolved";
    case SessionEventType.CheckpointCreated:
      return "checkpoint.created";
    case SessionEventType.RewindTriggered:
      return "rewind.triggered";
    case SessionEventType.StreamRecoveryAnchorCreated:
    case SessionEventType.StreamRecoveryStarted:
    case SessionEventType.StreamRecoveryAnchorSelected:
    case SessionEventType.StreamRecoveryRetryStarted:
    case SessionEventType.StreamRecoveryTailDiscarded:
    case SessionEventType.StreamRecoveryBlocked:
      return "streamRecovery.updated";
    default:
      return "session.updated";
  }
}
