import {
  SessionEventType,
  selectActiveConversationBranch,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionGoal,
  type TurnFileChangeSummary,
  type TurnId,
} from "@zcode/contracts";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  goalVerificationEntriesFromSessionEntries,
  synthesizeEventsFromMessages,
  type HydratedGoalVerificationEntry,
} from "./transcript-hydration.js";

export interface ConversationMaterializationSource {
  goalVerificationEntries: HydratedGoalVerificationEntry[];
  memoryEvents: SessionEvent[];
  messages: MessageWithParts[];
  /** shared_context body remains provider-only; only redacted handover metadata is passed through here. */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** Present only after session_target is read successfully; explicit null is also durable authority. */
  target?: SessionGoal | null;
}

interface PersistedConversationMaterializationStore {
  getSession(sessionId: import("@zcode/contracts").SessionId): Promise<{
    title?: string;
    revert?: {
      branchCutAfterMessageID?: import("@zcode/contracts").MessageId;
      branchGeneration?: number;
      createdMessageID?: import("@zcode/contracts").MessageId;
      keptMessageIDs?: import("@zcode/contracts").MessageId[];
      targetMessageID?: import("@zcode/contracts").MessageId;
    };
  } | null>;
  messages(input: { sessionID: import("@zcode/contracts").SessionId }): Promise<MessageWithParts[]>;
  readTarget(input: {
    sessionID: import("@zcode/contracts").SessionId;
  }): Promise<SessionGoal | null>;
  sessionEntries?(input: {
    sessionID: import("@zcode/contracts").SessionId;
    type?: string;
  }): Promise<SessionEntryInfo[]>;
}

/**
 * The single durable fact source for cold materialization.
 *
 * The old bridge read every message/part but did not read session.revert to remove rolled
 * back branches or read session_target. Runtime resume / stable fork therefore used the
 * active branch while a refreshed projection resurrected old branches and restored the
 * goal as null.
 */
export async function loadPersistedConversationMaterialization(input: {
  memoryEvents: readonly SessionEvent[];
  persistedMessages?: MessageWithParts[];
  sessionId: string;
  store?: PersistedConversationMaterializationStore;
}): Promise<ConversationMaterializationSource> {
  if (!input.store) {
    // Without a sessionStore, the old bridge filled target:null and treated “not read”
    // as “explicitly cleared in persistence”, suppressing the only in-memory
    // TargetChanged and forcing a synthesized value.
    return {
      goalVerificationEntries: [],
      memoryEvents: [...input.memoryEvents],
      messages: [],
    };
  }
  const sessionID = input.sessionId as import("@zcode/contracts").SessionId;
  const [session, allMessages, target, entries] = await Promise.all([
    input.store.getSession(sessionID),
    input.persistedMessages ?? input.store.messages({ sessionID }),
    input.store.readTarget({ sessionID }),
    input.store.sessionEntries ? input.store.sessionEntries({ sessionID }) : Promise.resolve([]),
  ]);
  const messages = selectActiveConversationBranch(allMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
  const sharedContextMessage = messages.find(
    (message) =>
      message.info.role === "user" &&
      message.info.source === "shared_context" &&
      message.info.semantics?.origin === "import" &&
      message.info.semantics?.kind === "shared_context",
  );
  const sharedContextEntry = entries.find((entry) => entry.type === "v4/shared_context_import");
  const sharedContextData =
    sharedContextEntry?.data && typeof sharedContextEntry.data === "object"
      ? (sharedContextEntry.data as Record<string, unknown>)
      : undefined;
  const contextId =
    typeof sharedContextData?.contextId === "string" ? sharedContextData.contextId : undefined;
  const shareUrl =
    typeof sharedContextData?.shareUrl === "string" ? sharedContextData.shareUrl : undefined;
  const status = sharedContextData?.status;
  const sharedContextImport =
    sharedContextMessage && session?.title?.trim()
      ? contextId &&
        shareUrl &&
        ["pending", "reserved", "attached", "discarded"].includes(String(status))
        ? {
            contextId,
            title: session.title.trim(),
            shareUrl,
            status: status as "pending" | "reserved" | "attached" | "discarded",
          }
        : { title: session.title.trim() }
      : undefined;
  return {
    goalVerificationEntries: goalVerificationEntriesFromSessionEntries(entries),
    memoryEvents: [...input.memoryEvents],
    messages,
    ...(sharedContextImport ? { sharedContextImport } : {}),
    target,
  };
}

export interface ColdEventMergeDiagnostic {
  code:
    | "cold_merge.durable_event_suppressed"
    | "cold_merge.ambiguous_legacy_turn_preserved"
    | "cold_merge.settled_queue_event_suppressed"
    | "cold_merge.memory_boundary_preserved"
    | "cold_merge.non_product_event_suppressed"
    | "cold_merge.unclassified_event_preserved";
  count: number;
  eventTypes: Record<string, number>;
}

export interface ColdEventMergeResult {
  diagnostics: ColdEventMergeDiagnostic[];
  events: SessionEvent[];
  usedDurableTranscript: boolean;
}

interface MergeInput {
  contextWindow?: number;
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  memoryEvents: readonly SessionEvent[];
  messages: readonly MessageWithParts[];
  sessionId: string;
  target?: SessionGoal | null;
}

const LIVE_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.PluginUiResourceUpdated,
  SessionEventType.PluginUiResourceListChanged,
  SessionEventType.PluginUiAppToolCallRequested,
  SessionEventType.PluginUiInstanceClosed,
]);

const MEMORY_ONLY_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionResumed,
  SessionEventType.SessionTitleUpdated,
  SessionEventType.SessionModeChanged,
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
  SessionEventType.UserInputAutoResolutionUpdated,
  SessionEventType.BackgroundTaskStarted,
  SessionEventType.BackgroundTaskUpdated,
  SessionEventType.BackgroundTaskCompleted,
  // Workflow-run progress: its authoritative facts live in the dwf_event journal and
  // in-memory events; the durable transcript (message/part) never synthesizes it. It is
  // therefore like BackgroundTask*: memory-only authority. Failing to classify it does
  // not drop the event (the fallback also preserves it), but emits an unclassified
  // diagnostic on every cold recovery, drowning out the signal that the vocabulary may
  // actually be missing an event.
  SessionEventType.DynamicWorkflowRunProgress,
  SessionEventType.TargetChanged,
  SessionEventType.RewindTriggered,
  SessionEventType.TurnExecutionModelFallback,
]);

const TRANSCRIPT_DERIVED_EVENT_TYPES = new Set<string>([
  SessionEventType.SessionCreated,
  SessionEventType.TurnStarted,
  SessionEventType.ModelSelected,
  SessionEventType.ModelStreaming,
  SessionEventType.ModelComplete,
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
  SessionEventType.TurnComplete,
  SessionEventType.TurnError,
  SessionEventType.CompactStarted,
  SessionEventType.CompactCompleted,
  SessionEventType.CompactFailed,
  SessionEventType.TargetCompletionVerification,
  SessionEventType.SessionForked,
  SessionEventType.SubagentSpawned,
  SessionEventType.SubagentMessage,
  SessionEventType.SubagentStopped,
]);

const HOOK_LIFECYCLE_EVENT_TYPES = new Set<string>([
  SessionEventType.HookRunStarted,
  SessionEventType.HookRunProgress,
  SessionEventType.HookRunCompleted,
  SessionEventType.HookRunFailed,
  SessionEventType.HookRunBlocked,
]);

function hookInvocationTurnIds(events: readonly SessionEvent[]): Map<string, string> {
  const resolved = new Map<string, string>();
  const pending = new Set<string>();
  for (const event of events) {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      if (!invocationId) continue;
      const eventName = stringField(event.payload, "hookEventName");
      if (eventName === "SessionStart") {
        // Startup SessionStart may already carry a runtime turnId that has not been
        // mapped yet; only a later real TurnStarted identifies the durable product turn.
        // Reuse the mapping if an async terminal event has already resolved it.
        if (!resolved.has(invocationId)) pending.add(invocationId);
        continue;
      }
      if (event.turnId) {
        resolved.set(invocationId, String(event.turnId));
        pending.delete(invocationId);
      } else if (!resolved.has(invocationId)) {
        pending.add(invocationId);
      }
      continue;
    }
    if (event.type !== SessionEventType.TurnStarted || !event.turnId || pending.size === 0) {
      continue;
    }
    // Model-only maintenance turns (manual /compact, goal continuation) cannot carry a
    // SessionStart summary. A resume SessionStart must wait until the next real,
    // user-visible turn is resolved.
    if (stringField(event.payload, "inputVisibility") === "model-only") continue;
    // In Runtime, resume SessionStart precedes the next real TurnStarted. Cold merge must
    // establish ownership in that same event order; do not append it to the end of
    // history or let the Renderer guess the most recent turn.
    for (const invocationId of pending) resolved.set(invocationId, String(event.turnId));
    pending.clear();
  }
  return resolved;
}

function recordDiagnostic(
  diagnostics: Map<ColdEventMergeDiagnostic["code"], ColdEventMergeDiagnostic>,
  code: ColdEventMergeDiagnostic["code"],
  event: SessionEvent,
): void {
  const existing = diagnostics.get(code);
  if (existing) {
    existing.count += 1;
    existing.eventTypes[event.type] = (existing.eventTypes[event.type] ?? 0) + 1;
    return;
  }
  diagnostics.set(code, {
    code,
    count: 1,
    eventTypes: { [event.type]: 1 },
  });
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArrayField(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function memoryAuthorityTurnIds(
  events: readonly SessionEvent[],
  messages: readonly MessageWithParts[],
): { ambiguousLegacyStarts: SessionEvent[]; turnIds: Set<string> } {
  const started = new Map<string, SessionEvent>();
  const terminal = new Set<string>();
  for (const event of events) {
    const turnId = event.turnId ? String(event.turnId) : null;
    if (!turnId) continue;
    if (event.type === SessionEventType.TurnStarted) started.set(turnId, event);
    if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
      terminal.add(turnId);
    }
  }

  const persistedMessageIds = new Set(messages.map((message) => String(message.info.id)));
  const persistedTurnIds = new Set(
    messages.flatMap((message) =>
      message.info.anchor?.turnId ? [String(message.info.anchor.turnId)] : [],
    ),
  );
  const authority = new Set<string>();
  const ambiguousLegacyStarts: SessionEvent[] = [];
  for (const [turnId, start] of started) {
    if (!terminal.has(turnId)) {
      authority.add(turnId);
      continue;
    }
    const messageId = stringField(start.payload, "messageId");
    const hasDurableStarter =
      (messageId !== null && persistedMessageIds.has(messageId)) || persistedTurnIds.has(turnId);
    if (!hasDurableStarter) {
      authority.add(turnId);
      if (messageId === null) ambiguousLegacyStarts.push(start);
    }
  }
  return { ambiguousLegacyStarts, turnIds: authority };
}

function resumedSubagentLifecycleEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const keep = new Set<number>();
  const resumedAgentIds = new Set<string>();
  events.forEach((event, index) => {
    const agentId = stringField(event.payload, "agentId");
    if (!agentId) return;
    if (event.type === SessionEventType.SubagentSpawned) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.resumed === true) {
        resumedAgentIds.add(agentId);
        keep.add(index);
      }
      return;
    }
    if (event.type === SessionEventType.SubagentStopped && resumedAgentIds.has(agentId)) {
      keep.add(index);
    }
  });
  return keep;
}

function queueStateEventIndexes(events: readonly SessionEvent[]): Set<number> {
  const queuedLifecycleById = new Map<string, number[]>();
  const latestDispatchById = new Map<string, number>();
  const latestDeliveryChangeById = new Map<string, number>();
  const pendingIds = new Set<string>();
  let latestReorder: number | null = null;
  let latestAutoDrain: number | null = null;
  let latestFollowupMode: number | null = null;

  events.forEach((event, index) => {
    if (event.type === SessionEventType.TurnSteerQueued) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) {
        pendingIds.add(id);
        const lifecycle = queuedLifecycleById.get(id) ?? [];
        lifecycle.push(index);
        queuedLifecycleById.set(id, lifecycle);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerDispatchChanged) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) latestDispatchById.set(id, index);
      return;
    }
    if (event.type === SessionEventType.TurnSteerDeliveryChanged) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) latestDeliveryChangeById.set(id, index);
      return;
    }
    if (event.type === SessionEventType.TurnSteerDrained) {
      for (const id of stringArrayField(event.payload, "pendingInputIds")) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerDiscarded) {
      for (const id of stringArrayField(event.payload, "pendingInputIds")) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.SessionInputPromoted) {
      const id = stringField(event.payload, "pendingInputId");
      if (id) {
        pendingIds.delete(id);
        queuedLifecycleById.delete(id);
        latestDispatchById.delete(id);
        latestDeliveryChangeById.delete(id);
      }
      return;
    }
    if (event.type === SessionEventType.TurnSteerReordered) latestReorder = index;
    if (event.type === SessionEventType.QueueAutoDrainChanged) latestAutoDrain = index;
    if (event.type === SessionEventType.FollowupModeChanged) latestFollowupMode = index;
  });

  const keep = new Set<number>();
  for (const id of pendingIds) {
    const queuedLifecycle = queuedLifecycleById.get(id) ?? [];
    const dispatch = latestDispatchById.get(id);
    const deliveryChange = latestDeliveryChangeById.get(id);
    // An older editQueueItem event may resend only the new text; full intent/attachments/
    // source exist only on the original queued event. During cold replay from an empty
    // projection, preserve the full queued lifecycle for this id since its latest
    // admission so the reducer can merge fields in place.
    for (const queued of queuedLifecycle) keep.add(queued);
    const latestQueued = queuedLifecycle.at(-1) ?? -1;
    if (dispatch !== undefined && dispatch > latestQueued) keep.add(dispatch);
    if (deliveryChange !== undefined && deliveryChange > latestQueued) keep.add(deliveryChange);
  }
  if (latestReorder !== null && pendingIds.size > 0) keep.add(latestReorder);
  if (latestAutoDrain !== null) keep.add(latestAutoDrain);
  if (latestFollowupMode !== null) keep.add(latestFollowupMode);
  return keep;
}

function setupModelEventIndexes(
  events: readonly SessionEvent[],
  authorityTurnIds: ReadonlySet<string>,
  messages: readonly MessageWithParts[],
): Set<number> {
  const keep = new Set<number>();
  let latestModelSelected: number | null = null;
  events.forEach((event, index) => {
    if (event.type === SessionEventType.ModelSelected) latestModelSelected = index;
    if (
      event.type === SessionEventType.TurnStarted &&
      event.turnId &&
      authorityTurnIds.has(String(event.turnId)) &&
      latestModelSelected !== null
    ) {
      keep.add(latestModelSelected);
    }
  });
  if (messages.length === 0 && latestModelSelected !== null) keep.add(latestModelSelected);
  return keep;
}

interface DurableBoundaryKeys {
  compact: Set<string>;
  fork: Set<string>;
  goal: Set<string>;
}

function goalKey(payload: unknown): string | null {
  const targetId = stringField(payload, "targetId");
  const verificationId = stringField(payload, "verificationId");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const goalIteration = (payload as Record<string, unknown>).goalIteration;
  if (targetId && typeof goalIteration === "number") return `${targetId}_${goalIteration}`;
  return verificationId;
}

function durableBoundaryKeys(
  messages: readonly MessageWithParts[],
  goalEntries: readonly HydratedGoalVerificationEntry[],
): DurableBoundaryKeys {
  const compact = new Set<string>();
  const fork = new Set<string>();
  const goal = new Set<string>();
  for (const entry of goalEntries) {
    const key = goalKey(entry.payload);
    if (key) goal.add(key);
  }
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "timeline") {
        if (part.timelineType === "goal_verification") {
          const key = goalKey(part);
          if (key) goal.add(key);
        } else if (part.timelineType === "context_compaction") {
          compact.add(String(part.operationId));
        } else if (part.timelineType === "session_fork") {
          fork.add(`${String(part.parentSessionId)}\u0000${String(part.targetMessageId)}`);
        }
        continue;
      }
      if (part.type === "compaction") {
        compact.add(String(part.operationId ?? part.boundaryId ?? `legacy-compact-${part.id}`));
      }
    }
  }
  return { compact, fork, goal };
}

function durableBoundaryKeyForEvent(
  event: SessionEvent,
): { key: string | null; kind: keyof DurableBoundaryKeys } | null {
  if (event.type === SessionEventType.TargetCompletionVerification) {
    return { kind: "goal", key: goalKey(event.payload) };
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    return { kind: "compact", key: stringField(event.payload, "operationId") };
  }
  if (event.type === SessionEventType.SessionForked) {
    const parent = stringField(event.payload, "originalSessionId");
    const target = stringField(event.payload, "targetMessageId");
    return { kind: "fork", key: parent && target ? `${parent}\u0000${target}` : null };
  }
  return null;
}

function eventMessageIds(event: SessionEvent): string[] {
  const ids = [
    stringField(event.payload, "messageId"),
    stringField(event.payload, "assistantMessageId"),
  ].filter((id): id is string => id !== null);
  ids.push(...stringArrayField(event.payload, "injectedMessageIds"));
  if (event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
    const drainedInputs = (event.payload as Record<string, unknown>).drainedInputs;
    if (Array.isArray(drainedInputs)) {
      for (const input of drainedInputs) {
        const messageId = stringField(input, "messageId");
        if (messageId) ids.push(messageId);
      }
    }
  }
  return ids;
}

/**
 * Build the transcript message → hydration-turn mapping using only durable entity ids.
 * An assistant without a text part may not directly produce assistantMessageId, so also
 * propagate through durable parentID / anchor.turnId. Never infer turn ownership from
 * text or temporal proximity.
 */
function durableTurnByMessageId(
  messages: readonly MessageWithParts[],
  events: readonly SessionEvent[],
): Map<string, string> {
  const turnByMessageId = new Map<string, string>();
  for (const event of events) {
    if (!event.turnId) continue;
    for (const messageId of eventMessageIds(event)) {
      turnByMessageId.set(messageId, String(event.turnId));
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const turnByRuntimeAnchor = new Map<string, string>();
    for (const message of messages) {
      const turnId = turnByMessageId.get(String(message.info.id));
      const runtimeAnchor = message.info.anchor?.turnId;
      if (turnId && runtimeAnchor) turnByRuntimeAnchor.set(String(runtimeAnchor), turnId);
    }
    for (const message of messages) {
      const messageId = String(message.info.id);
      if (turnByMessageId.has(messageId)) continue;
      const parentTurn =
        message.info.role === "assistant" && message.info.parentID
          ? turnByMessageId.get(String(message.info.parentID))
          : undefined;
      const anchorTurn = message.info.anchor?.turnId
        ? turnByRuntimeAnchor.get(String(message.info.anchor.turnId))
        : undefined;
      const turnId = parentTurn ?? anchorTurn;
      if (!turnId) continue;
      turnByMessageId.set(messageId, turnId);
      changed = true;
    }
  }
  return turnByMessageId;
}

/**
 * Hook lifecycle carries only runtime turnId and no durable messageId; cold transcript
 * hydration generates new hydrate-turn-* ids. Use only durable message anchors to build
 * an unambiguous identity map; never infer by text or temporal proximity. If one runtime
 * anchor points to multiple hydration turns, keep the original event until an explicit
 * recovery boundary rather than attaching the Hook to the wrong turn.
 */
function durableTurnByRuntimeAnchor(
  messages: readonly MessageWithParts[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const turnByRuntimeAnchor = new Map<string, string>();
  const ambiguousRuntimeAnchors = new Set<string>();
  for (const message of messages) {
    const runtimeAnchor = message.info.anchor?.turnId;
    const durableTurnId = turnByMessageId.get(String(message.info.id));
    if (!runtimeAnchor || !durableTurnId) continue;
    const runtimeTurnId = String(runtimeAnchor);
    if (ambiguousRuntimeAnchors.has(runtimeTurnId)) continue;
    const existing = turnByRuntimeAnchor.get(runtimeTurnId);
    if (existing && existing !== durableTurnId) {
      turnByRuntimeAnchor.delete(runtimeTurnId);
      ambiguousRuntimeAnchors.add(runtimeTurnId);
      continue;
    }
    turnByRuntimeAnchor.set(runtimeTurnId, durableTurnId);
  }
  return turnByRuntimeAnchor;
}

/**
 * Queue drain can split multiple product turns within one runtime turn. Hooks still carry
 * only runtime turnId, so follow durable message boundaries in event order. Once the
 * first lifecycle resolves, freeze the invocation owner so a background terminal event
 * cannot reattach across a boundary.
 */
function durableHookTurnByInvocationId(
  events: readonly SessionEvent[],
  turnByMessageId: ReadonlyMap<string, string>,
): Map<string, string> {
  const currentTurnByRuntimeId = new Map<string, string>();
  const runtimeTurnByPendingInputId = new Map<string, string>();
  const runtimeTurnByInvocationId = hookInvocationTurnIds(events);
  const durableTurnByInvocationId = new Map<string, string>();

  const advance = (runtimeTurnId: string | null, messageId: string | null): void => {
    if (!runtimeTurnId || !messageId) return;
    const durableTurnId = turnByMessageId.get(messageId);
    if (durableTurnId) currentTurnByRuntimeId.set(runtimeTurnId, durableTurnId);
  };

  for (const event of events) {
    if (event.type === SessionEventType.TurnStarted) {
      advance(event.turnId ? String(event.turnId) : null, stringField(event.payload, "messageId"));
    } else if (event.type === SessionEventType.TurnSteerDrained) {
      const runtimeTurnId =
        stringField(event.payload, "targetTurnId") ?? (event.turnId ? String(event.turnId) : null);
      const drainedInputs =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>).drainedInputs
          : undefined;
      if (runtimeTurnId && Array.isArray(drainedInputs)) {
        for (const input of drainedInputs) {
          const pendingInputId = stringField(input, "pendingInputId");
          if (pendingInputId) runtimeTurnByPendingInputId.set(pendingInputId, runtimeTurnId);
          if (stringField(input, "delivery") !== "guide") {
            advance(runtimeTurnId, stringField(input, "messageId"));
          }
        }
      }
    } else if (event.type === SessionEventType.SessionInputPromoted) {
      const pendingInputId = stringField(event.payload, "pendingInputId");
      const runtimeTurnId = event.turnId
        ? String(event.turnId)
        : pendingInputId
          ? (runtimeTurnByPendingInputId.get(pendingInputId) ?? null)
          : null;
      advance(runtimeTurnId, stringField(event.payload, "messageId"));
    }

    if (!HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) continue;
    const invocationId = stringField(event.payload, "hookInvocationId");
    if (!invocationId || durableTurnByInvocationId.has(invocationId)) continue;
    const runtimeTurnId =
      runtimeTurnByInvocationId.get(invocationId) ??
      (event.turnId ? String(event.turnId) : undefined);
    const durableTurnId = runtimeTurnId ? currentTurnByRuntimeId.get(runtimeTurnId) : undefined;
    if (durableTurnId) durableTurnByInvocationId.set(invocationId, durableTurnId);
  }
  return durableTurnByInvocationId;
}

function boundaryAnchorMessageId(event: SessionEvent): string | null {
  if (event.type === SessionEventType.TargetCompletionVerification) {
    return (
      stringField(event.payload, "anchorAssistantMessageId") ??
      stringField(event.payload, "anchorMessageId")
    );
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    return stringField(event.payload, "anchorMessageId");
  }
  if (event.type === SessionEventType.SessionForked) {
    return (
      stringField(event.payload, "targetMessageId") ?? stringField(event.payload, "anchorMessageId")
    );
  }
  return null;
}

function insertAtDurableTurnBoundaries(input: {
  durableEvents: readonly SessionEvent[];
  trailingEvents: readonly SessionEvent[];
  turnPrefixEvents: ReadonlyMap<string, readonly SessionEvent[]>;
  turnTailEvents: ReadonlyMap<string, readonly SessionEvent[]>;
}): SessionEvent[] {
  const firstIndexByTurnId = new Map<string, number>();
  const tailIndexByTurnId = new Map<string, number>();
  input.durableEvents.forEach((event, index) => {
    if (!event.turnId) return;
    const turnId = String(event.turnId);
    if (!firstIndexByTurnId.has(turnId)) firstIndexByTurnId.set(turnId, index);
    tailIndexByTurnId.set(turnId, index);
  });
  const beforeIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnPrefixEvents) {
    const firstIndex = firstIndexByTurnId.get(turnId);
    if (firstIndex === undefined) continue;
    beforeIndex.set(firstIndex, [...(beforeIndex.get(firstIndex) ?? []), ...events]);
  }
  const afterIndex = new Map<number, SessionEvent[]>();
  for (const [turnId, events] of input.turnTailEvents) {
    const tailIndex = tailIndexByTurnId.get(turnId);
    if (tailIndex === undefined) continue;
    afterIndex.set(tailIndex, [...(afterIndex.get(tailIndex) ?? []), ...events]);
  }

  const merged: SessionEvent[] = [];
  input.durableEvents.forEach((event, index) => {
    merged.push(...(beforeIndex.get(index) ?? []));
    merged.push(event);
    merged.push(...(afterIndex.get(index) ?? []));
  });
  merged.push(...input.trailingEvents);
  return merged;
}

function resequence(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, sequenceNumber: index + 1 }));
}

/**
 * Merge three sources during cold recovery: message/part are authoritative for completed
 * content; session_entry supplements only legacy goals; in-memory events supplement only
 * unfinished turns and current state without a transcript representation.
 */
export function mergeColdConversationEvents(input: MergeInput): ColdEventMergeResult {
  const diagnostics = new Map<ColdEventMergeDiagnostic["code"], ColdEventMergeDiagnostic>();
  const hasPersistedTargetAuthority = Object.prototype.hasOwnProperty.call(input, "target");
  const authorityTurns = memoryAuthorityTurnIds(input.memoryEvents, input.messages);
  const authorityTurnIds = authorityTurns.turnIds;
  for (const event of authorityTurns.ambiguousLegacyStarts) {
    // If an old TurnStarted has no messageId and the transcript has no matching turn
    // anchor, do not infer entity identity from input text/time. Identical text may be
    // two genuine submissions. Keep the in-memory turn and emit a diagnostic rather
    // than mistakenly dropping an unpersisted in-flight turn as a duplicate.
    recordDiagnostic(diagnostics, "cold_merge.ambiguous_legacy_turn_preserved", event);
  }
  const durableMessages = input.messages.filter(
    (message) =>
      !message.info.anchor?.turnId || !authorityTurnIds.has(String(message.info.anchor.turnId)),
  );
  const durableGoalEntries = (input.goalVerificationEntries ?? []).filter(
    (entry) => !entry.payload.anchorTurnId || !authorityTurnIds.has(entry.payload.anchorTurnId),
  );
  const transcriptEvents = synthesizeEventsFromMessages(durableMessages, {
    sessionId: input.sessionId,
    contextWindow: input.contextWindow,
    fileChangeSummariesByMessageId: input.fileChangeSummariesByMessageId,
    goalVerificationEntries: durableGoalEntries,
  });
  const durableEvents = input.target
    ? [
        ...transcriptEvents.slice(0, 1),
        {
          id: "hydrate-goal-state" as SessionEvent["id"],
          sessionId: input.sessionId as SessionEvent["sessionId"],
          type: SessionEventType.TargetChanged,
          timestamp: new Date(input.target.time.updated),
          traceId: "trace-hydration" as SessionEvent["traceId"],
          sequenceNumber: 0,
          payload: { action: "set", source: "runtime", target: input.target },
        },
        ...transcriptEvents.slice(1),
      ]
    : transcriptEvents;
  const durableTurnIds = new Set(
    durableEvents.flatMap((event) => (event.turnId ? [String(event.turnId)] : [])),
  );
  const queueIndexes = queueStateEventIndexes(input.memoryEvents);
  const resumedSubagentIndexes = resumedSubagentLifecycleEventIndexes(input.memoryEvents);
  const modelSetupIndexes = setupModelEventIndexes(
    input.memoryEvents,
    authorityTurnIds,
    input.messages,
  );
  const supplements: SessionEvent[] = [];
  const prefixEventsByTurnId = new Map<string, SessionEvent[]>();
  const boundaryEventsByTurnId = new Map<string, SessionEvent[]>();
  const boundaryKeys = durableBoundaryKeys(durableMessages, durableGoalEntries);
  const turnByMessageId = durableTurnByMessageId(durableMessages, durableEvents);
  const turnByRuntimeAnchor = durableTurnByRuntimeAnchor(durableMessages, turnByMessageId);
  const hookTurnIdByInvocationId = hookInvocationTurnIds(input.memoryEvents);
  const durableHookTurnByInvocation = durableHookTurnByInvocationId(
    input.memoryEvents,
    turnByMessageId,
  );

  input.memoryEvents.forEach((event, index) => {
    if (HOOK_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      const invocationId = stringField(event.payload, "hookInvocationId");
      // Invocation scanning remaps the temporary runtime turn for startup/resume
      // SessionStart to the later real TurnStarted. This mapping must take precedence
      // over a turnId on an individual event before a product mapping exists. Ordinary
      // prompt/tool invocations still resolve to the same runtime turn.
      const resolvedTurnId = invocationId
        ? (hookTurnIdByInvocationId.get(invocationId) ??
          (event.turnId ? String(event.turnId) : undefined))
        : event.turnId
          ? String(event.turnId)
          : undefined;
      const durableTurnId =
        (invocationId ? durableHookTurnByInvocation.get(invocationId) : undefined) ??
        (resolvedTurnId
          ? durableTurnIds.has(resolvedTurnId)
            ? resolvedTurnId
            : turnByRuntimeAnchor.get(resolvedTurnId)
          : undefined);
      if (durableTurnId) {
        const eventName = stringField(event.payload, "hookEventName");
        const target = eventName === "SessionStart" ? prefixEventsByTurnId : boundaryEventsByTurnId;
        const events = target.get(durableTurnId) ?? [];
        // Memory Hooks retain runtime turnId while transcript synthesis uses
        // hydrate-turn-*; comparing them directly would turn completed Hooks into
        // orphan rows and leave SessionStart pending. Remap to the hydration turn first,
        // then the existing ProductProjection TurnStarted mapping resolves to the stable
        // message product turn.
        events.push({ ...event, turnId: durableTurnId as TurnId });
        target.set(durableTurnId, events);
      } else {
        // A resume SessionStart that only opens history and has no following real turn
        // remains pending in the projection; do not create a synthetic turn for it. A
        // later live TurnStarted will resolve it.
        supplements.push(event);
      }
      return;
    }
    const boundary = durableBoundaryKeyForEvent(event);
    if (boundary) {
      if (boundary.key && boundaryKeys[boundary.kind].has(boundary.key)) {
        recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
        return;
      }
      // If writing the durable boundary to part/session_entry failed, the in-memory event
      // is the only remaining fact. The boundary's durable entity anchor takes priority
      // over the active runtime turn at event arrival; otherwise a late boundary would
      // remain incorrectly at the end of the unfinished turn.
      const anchorMessageId = boundaryAnchorMessageId(event);
      const durableTurnId = anchorMessageId ? turnByMessageId.get(anchorMessageId) : undefined;
      if (durableTurnId) {
        const events = boundaryEventsByTurnId.get(durableTurnId) ?? [];
        // Do not concatenate durableEvents + supplements directly: even a boundary with
        // a durable message anchor would move to the end of the entire transcript. Remap
        // it to the hydration product turn and insert it at that turn's tail, aligning
        // identity and physical order together.
        events.push({ ...event, turnId: durableTurnId as TurnId });
        boundaryEventsByTurnId.set(durableTurnId, events);
      } else {
        // For legacy events without an explicit/resolvable anchor, use the frozen
        // fallback after the last known host. Keep this degradation observable through
        // the memory_boundary_preserved diagnostic.
        supplements.push(event);
      }
      recordDiagnostic(diagnostics, "cold_merge.memory_boundary_preserved", event);
      return;
    }
    const turnId = event.turnId ? String(event.turnId) : null;
    if (turnId && authorityTurnIds.has(turnId)) {
      supplements.push(event);
      return;
    }
    if (queueIndexes.has(index) || modelSetupIndexes.has(index)) {
      supplements.push(event);
      return;
    }
    if (
      event.type === SessionEventType.TurnSteerQueued ||
      event.type === SessionEventType.TurnSteerDeliveryChanged ||
      event.type === SessionEventType.TurnSteerDispatchChanged ||
      event.type === SessionEventType.TurnSteerDrained ||
      event.type === SessionEventType.TurnSteerDiscarded ||
      event.type === SessionEventType.SessionInputPromoted ||
      event.type === SessionEventType.TurnSteerReordered ||
      event.type === SessionEventType.QueueAutoDrainChanged ||
      event.type === SessionEventType.FollowupModeChanged
    ) {
      recordDiagnostic(diagnostics, "cold_merge.settled_queue_event_suppressed", event);
      return;
    }
    if (event.type === SessionEventType.TargetChanged && hasPersistedTargetAuthority) {
      // session_target is already durable authority, but the old merge appended an
      // in-memory TargetChanged as an ephemeral tail event, allowing an old goal to
      // override the recovered state. Explicit null must suppress old events too.
      recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
      return;
    }
    if (LIVE_ONLY_EVENT_TYPES.has(event.type)) {
      // Plugin UI resource notifications matter only to sandbox instances alive at the time; cold recovery always drops them.
      recordDiagnostic(diagnostics, "cold_merge.non_product_event_suppressed", event);
      return;
    }
    if (MEMORY_ONLY_EVENT_TYPES.has(event.type)) {
      supplements.push(event);
      return;
    }
    if (resumedSubagentIndexes.has(index)) {
      // A SendMessage tool transcript does not synthesize the recovered child lifecycle.
      // Deduplicating it like ordinary transcript-derived Subagent* events would remove
      // the running row and Stop control after a replayable reconnect.
      supplements.push(event);
      return;
    }
    if (TRANSCRIPT_DERIVED_EVENT_TYPES.has(event.type)) {
      recordDiagnostic(diagnostics, "cold_merge.durable_event_suppressed", event);
      return;
    }
    // ProductProjection may currently ignore these events, but the reader must not
    // silently drop unknown historical facts. Preserve the original event and aggregate
    // a diagnostic so it remains traceable if a later normalizer expands the vocabulary.
    supplements.push(event);
    recordDiagnostic(diagnostics, "cold_merge.unclassified_event_preserved", event);
  });

  return {
    diagnostics: [...diagnostics.values()],
    events: resequence(
      insertAtDurableTurnBoundaries({
        durableEvents,
        trailingEvents: supplements,
        turnPrefixEvents: prefixEventsByTurnId,
        turnTailEvents: boundaryEventsByTurnId,
      }),
    ),
    usedDurableTranscript:
      durableMessages.length > 0 || durableGoalEntries.length > 0 || hasPersistedTargetAuthority,
  };
}
