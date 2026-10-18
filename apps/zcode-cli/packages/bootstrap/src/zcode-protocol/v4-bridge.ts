import { worktreePreparationStateSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  assertWorktreePreparationMutation,
  serializePreparedWorktreeMutation,
} from "./worktree-preparation-guard.js";
import {
  createChildSessionFactsResolver,
  toWireChildSession,
} from "../zcode-protocol-v4/child-session-facts.js";
import { readBackgroundBashOutputFromOwner } from "./background-work-owner.js";
// v4 gateway binder.
// ConversationV4Gateway is a domain-independent channel runtime; this file binds it to the protocol
// server context:
// - Frame output = context.notify (stdio NDJSON notifications coexist with the legacy session/event pipeline).
// - Command execution = V4CommandExecutor (zcode-protocol-v4/commands/, driving core natively).
//   All 20 commands are native; an unmatched supports() check (unknown command) maps to notImplemented.
// - Transitional hooks (ensureModelReady / afterLegacyStateMutation / closeSession /
//   createSessionRecord / child record registration / resumePersistedSession) inject legacy protocol
//   implementations here and will be removed with the legacy protocol.
//
// No bridge layer: dependencies may point only from the legacy directory to the v4 directory.
// This file lives in the legacy directory, so importing the v4 executor is valid; v4 files must not
// import any module from this directory in reverse.
import {
  incognitoProfilesEqual,
  isConversationRealUserTurnStarter,
  parseRemoteWorkspaceIdentity,
  type ZCodeSessionContextUsage,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import { createExternalTurnFaultError } from "@zcode/core";
import { projectIdFromDirectory } from "../app/paths.js";
import {
  V4_NOTIFICATIONS,
  conversationInputIntentSchema,
  type AttachmentRef,
  type CommandEnvelope,
  type ConversationInputIntent,
  type ConversationSnapshot,
  type V4ConversationFileChangesResult,
  type V4ConversationFileRewindPreviewResult,
  type SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";
import { V4QueuePromotionLeaseUnavailableError } from "../zcode-protocol-v4/commands/handlers/queue.js";
import { V4CapabilityUnsupportedError } from "../zcode-protocol-v4/commands/handlers/interaction-background.js";
import {
  buildColdFileChangeSummaries,
  readConversationFileChangesFromEvents,
} from "../zcode-protocol-v4/cold-file-change-summaries.js";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../zcode-protocol-v4/cold-event-merge.js";
import { lookupGlobalCreateSessionCommand } from "../zcode-protocol-v4/create-session-command-fact.js";
import type {
  V4CommandCoreHost,
  V4QueuedTurnExecution,
} from "../zcode-protocol-v4/commands/types.js";
import type {
  ConversationRowTargetResolution,
  SessionUsageSeed,
} from "../zcode-protocol-v4/product-projection.js";
import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";
import { queueItemIdForCommand } from "../zcode-protocol-v4/command-inbox.js";
import { resolveStableForkTargetFromTranscript } from "../zcode-protocol-v4/stable-fork-target.js";
import { shouldAutoDrainV4QueueHead } from "../zcode-protocol-v4/queue-auto-drain.js";
import { persistAssistantFeedback } from "../zcode-protocol-v4/assistant-feedback-persistence.js";
import { persistRowPinned } from "../zcode-protocol-v4/row-pin-persistence.js";
import {
  persistHighspeedMetrics,
  persistHighspeedTiming,
} from "../zcode-protocol-v4/highspeed-metrics-persistence.js";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";
import {
  loadPersistentCommandFacts,
  savePersistentCommandFact,
} from "../zcode-protocol-v4/persistent-command-facts.js";
import {
  ConversationV4Gateway,
  V4CommandNotImplementedError,
} from "../zcode-protocol-v4/v4-gateway.js";
import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SessionEventType,
  createEventId,
  createSessionId,
} from "@zcode/contracts";
import type {
  CollaborationMode,
  DynamicWorkflowRunProgressPayload,
  EventId,
  ForkCommitBundle,
  GoalStatus,
  MessageId,
  SessionEvent,
  SessionEventStorePort,
  SessionId,
  SessionStorePort,
  StableForkGoalBoundaryMetadata,
  TraceId,
  TurnId,
  WorkspaceId,
} from "@zcode/contracts";
import { HYDRATION_TRACE_ID } from "../zcode-protocol-v4/projection-state.js";
import { cloneModelSelection, derivedSessionModelSelection } from "./fork-model-selection.js";
import { resolveWorkspaceRefFromId } from "./mapper.js";
import { buildLiveWorkspaceConfigStateV4 } from "./v4-workspace-config.js";
import {
  hasSessionModelProvider,
  resolveSessionModelContextWindow,
} from "./workspace-model-runtime.js";
import {
  afterStateMutation,
  activateSessionForResume,
  createSessionRecordForV4,
  ensureSessionModelAvailableForNextTurn,
  listSessionSubagents,
  registerForkedSession,
  readSessionContextUsage,
  isWorktreeDirectoryMissing,
  isWorktreeDirectoryMissingSync,
} from "./server-operations.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolPreparedWorktreeSession,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createProtocolLogger } from "./server-types.js";

const PREPARED_WORKTREE_ENTRY_TYPE = "v4/worktree_preparation";

function preparedWorktreeMap(context: ZCodeProtocolAgentServerContext) {
  return (context.preparedWorktreeSessions ??= new Map());
}

function parsePreparedWorktreeEntry(data: unknown): {
  branchName: string;
  targetPath: string;
  baseBranch?: string;
  attemptId?: string;
  status: "preparing" | "failed" | "cancelled" | "active";
  failureMessage?: string;
} | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (
    typeof value.branchName !== "string" ||
    typeof value.targetPath !== "string" ||
    !["preparing", "failed", "cancelled", "active"].includes(String(value.status))
  ) {
    return null;
  }
  return {
    ...(typeof value.attemptId === "string" ? { attemptId: value.attemptId } : {}),
    branchName: value.branchName,
    targetPath: value.targetPath,
    ...(typeof value.baseBranch === "string" ? { baseBranch: value.baseBranch } : {}),
    status: value.status as "preparing" | "failed" | "cancelled" | "active",
    ...(typeof value.failureMessage === "string" ? { failureMessage: value.failureMessage } : {}),
  };
}

/**
 * Load the durable preparation for a session in any status (including `active`), preferring the
 * in-memory registry. Unlike restorePreparedWorktreeSession this never hides an `active` receipt:
 * repeat activation reads it to return the existing identity without re-materializing.
 */
async function loadStoredPreparedWorktreeSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<ZCodeProtocolPreparedWorktreeSession | null> {
  const map = preparedWorktreeMap(context);
  const resident = map.get(sessionId);
  if (resident) return resident;
  const store = context.deps.sessionStore;
  if (!store?.getSession || !store.sessionEntries) return null;
  const session = await store.getSession(sessionId as SessionId);
  if (!session) return null;
  const entries = await store.sessionEntries({
    sessionID: sessionId as SessionId,
    type: PREPARED_WORKTREE_ENTRY_TYPE,
  });
  const marker = entries.at(-1);
  const parsed = parsePreparedWorktreeEntry(marker?.data);
  if (!parsed) return null;
  const workspaceId = session.workspaceID ?? String(session.directory);
  const restored = {
    sessionId: sessionId as SessionId,
    workspace: resolveWorkspaceRefFromId(workspaceId),
    ...(parsed.attemptId ? { attemptId: parsed.attemptId } : {}),
    branchName: parsed.branchName,
    targetPath: parsed.targetPath,
    ...(parsed.baseBranch ? { baseBranch: parsed.baseBranch } : {}),
    createdAt: session.time?.created ?? Date.now(),
    updatedAt: session.time?.updated ?? Date.now(),
    status: parsed.status,
    ...(parsed.failureMessage ? { failureMessage: parsed.failureMessage } : {}),
  };
  if (parsed.status !== "active") map.set(sessionId, restored);
  return restored;
}

async function restorePreparedWorktreeSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<ZCodeProtocolPreparedWorktreeSession | null> {
  const loaded = await loadStoredPreparedWorktreeSession(context, sessionId);
  return loaded && loaded.status !== "active" ? loaded : null;
}

/**
 * Durable admission evidence for a prepared session: a session_input ledger row that was admitted
 * or promoted (not cancelled, discarded, or failed). Read only on the reactivation path, where
 * re-sending the frozen input under a new command id must be impossible unless no admission ever
 * durably happened. Without a readable ledger the result is conservatively "admitted".
 */
async function sessionHasAdmittedInput(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<boolean> {
  const store = context.deps.sessionStore;
  if (!store?.listSessionInputs) return true;
  const inputs = await store.listSessionInputs({ sessionID: sessionId as SessionId });
  return inputs.some(
    (input) => input.status === "admitted" || input.status === "promoted",
  );
}

async function persistPreparedWorktreeStatus(
  context: ZCodeProtocolAgentServerContext,
  prepared: ZCodeProtocolPreparedWorktreeSession,
  status: "preparing" | "failed" | "cancelled" | "active",
  failureMessage?: string,
  worktreePreparation?: Pick<
    ZCodeProtocolPreparedWorktreeSession,
    "branchName" | "targetPath" | "baseBranch" | "attemptId"
  >,
): Promise<void> {
  const store = context.deps.sessionStore;
  if (!store?.saveSessionEntry)
    throw new Error("Worktree preparation requires session-entry storage");
  const now = Date.now();
  await store.saveSessionEntry({
    id: `v4/worktree_preparation:${prepared.sessionId}`,
    sessionID: prepared.sessionId,
    type: PREPARED_WORKTREE_ENTRY_TYPE,
    time: { created: prepared.createdAt, updated: now },
    data: {
      ...(worktreePreparation?.attemptId || prepared.attemptId
        ? { attemptId: worktreePreparation?.attemptId ?? prepared.attemptId }
        : {}),
      branchName: worktreePreparation?.branchName ?? prepared.branchName,
      targetPath: worktreePreparation?.targetPath ?? prepared.targetPath,
      ...((worktreePreparation ? worktreePreparation.baseBranch : prepared.baseBranch)
        ? { baseBranch: worktreePreparation?.baseBranch ?? prepared.baseBranch }
        : {}),
      status,
      ...(failureMessage ? { failureMessage } : {}),
    },
  });
  prepared.status = status;
  prepared.updatedAt = now;
  if (worktreePreparation) {
    if (worktreePreparation.attemptId) prepared.attemptId = worktreePreparation.attemptId;
    prepared.branchName = worktreePreparation.branchName;
    prepared.targetPath = worktreePreparation.targetPath;
    if (worktreePreparation.baseBranch) prepared.baseBranch = worktreePreparation.baseBranch;
    else delete prepared.baseBranch;
  }
  if (failureMessage) prepared.failureMessage = failureMessage;
  else delete prepared.failureMessage;
  if (status === "active") preparedWorktreeMap(context).delete(String(prepared.sessionId));
}

function normalizeStoredTitleSource(
  source: string | undefined,
): NonNullable<SessionSummary["titleSource"]> {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  return "generated";
}

function sessionUsageSeedFromRuntimeContextUsage(
  contextUsage: ZCodeSessionContextUsage | undefined,
  contextWindowOverride?: number,
): SessionUsageSeed | null {
  if (!contextUsage || contextUsage.used <= 0) {
    return null;
  }
  return {
    contextWindow: {
      usedTokens: contextUsage.used,
      maxTokens: contextWindowOverride ?? null,
      // Preserve the required V4 wire field; absent runtime threshold facts remain unknown.
      autoCompactThresholdTokens: null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    },
  };
}

const STABLE_FORK_MODES = new Set<CollaborationMode>([
  "plan",
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
]);

function stableForkMode(value: string, fallback: CollaborationMode): CollaborationMode {
  return STABLE_FORK_MODES.has(value as CollaborationMode)
    ? (value as CollaborationMode)
    : fallback;
}

async function readConversationFileChanges(
  record: ZCodeProtocolSessionRecord,
  sessionId: string,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileChangesResult> {
  const events = await record.eventStore.getEvents(sessionId as SessionId);
  return readConversationFileChangesFromEvents({
    events,
    messageIds,
    readArtifact: async (snapshotRef) =>
      (await record.app.readToolResultArtifact(snapshotRef)).content,
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

/**
 * During cold materialization, replay this session's workflow runs from the journal as
 * `DynamicWorkflowRunProgress` session events.
 *
 *   - Seed only the parent session whose record matched directly. A child session (actor transcript)
 *     that resolves to a parent record through parentID is not seeded: the journal is keyed by parent
 *     session, so a child projection must not acquire the parent's runs.
 *   - Let the CLI exclude runIds already present in memory. Runs executed in this process already
 *     have all their events in the memory store; progress events have no turnId and are not evicted
 *     by the turn window, so warm materialization has no duplicates.
 *   - On replay failure, log and return no events; the observation surface must never fail cold startup.
 *
 * Event ID / traceId follow transcript hydration's synthetic events; cold merge assigns sequenceNumber values.
 */
async function replayDynamicWorkflowRunEvents(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
  memoryEvents: readonly SessionEvent[],
): Promise<SessionEvent[]> {
  if (context.sessions.get(sessionId) !== record) return [];
  const replay = record.app.replayDynamicWorkflowRuns;
  if (!replay) return [];
  const excludeRunIds = new Set<string>();
  for (const event of memoryEvents) {
    if (event.type !== SessionEventType.DynamicWorkflowRunProgress) continue;
    const runId = (event.payload as { runId?: unknown } | undefined)?.runId;
    if (typeof runId === "string") excludeRunIds.add(runId);
  }
  let payloads: DynamicWorkflowRunProgressPayload[];
  try {
    payloads = await replay({ excludeRunIds });
  } catch (error) {
    context.logger?.warn("v4 hydrate dynamic workflow replay failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.v4.hydrate_workflow_replay_failed",
      module: "bootstrap.zcode_protocol",
      sessionId,
    });
    return [];
  }
  return payloads.map((payload, index) => ({
    id: `dwf-replay-${index + 1}` as EventId,
    sessionId: sessionId as SessionId,
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(0),
    traceId: HYDRATION_TRACE_ID as TraceId,
    sequenceNumber: 0,
    payload,
  }));
}

async function resolveConversationBackingRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<ZCodeProtocolSessionRecord | undefined> {
  const direct = context.sessions.get(sessionId);
  if (direct) return direct;

  // A running subagent has an independent child event log but no independent bootstrap record.
  // File summaries need only the shared event/artifact store, so use the persisted parentID to find
  // the parent record as the artifact reader while explicitly reading events with childSessionId.
  // Do not cold-resume a second child runtime for a read-only query.
  const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
  const parentSessionId = stored?.parentID ? String(stored.parentID) : null;
  return parentSessionId ? context.sessions.get(parentSessionId) : undefined;
}

async function previewConversationFileRewind(
  record: ZCodeProtocolSessionRecord,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileRewindPreviewResult> {
  return record.app.runtime.previewWorkspaceFileRewind({
    targetMessageIds: messageIds as MessageId[],
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

interface InputCommandForAdmission {
  inputOrigin?: "desktop" | "mobile";
  conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
  botGroupSource?: ConversationInputIntent["botGroupSource"];
  kind: ConversationInputIntent["kind"];
  text: string;
  attachments: readonly AttachmentRef[];
  sharedContextRefs?: ConversationInputIntent["sharedContextRefs"];
  requestedDelivery?: ConversationInputIntent["delivery"]["requested"];
  admittedDelivery?: ConversationInputIntent["delivery"]["admitted"];
  fallbackReasonCode?: string;
  highspeed?: ConversationInputIntent["highspeed"];
  provenance?: ConversationInputIntent["provenance"];
}

type ResolveAdmissionRowTarget = (
  sessionId: string,
  target: { rowId: number; entityId: string },
  action: "editUserQuery" | "retryTurn",
) => ConversationRowTargetResolution | null;

function admissionAttachmentRefs(
  attachments: NonNullable<
    Extract<ConversationRowTargetResolution, { ok: true }>["editTarget"]
  >["intent"]["attachments"],
): AttachmentRef[] {
  return (
    attachments?.flatMap((attachment) =>
      attachment.ref
        ? [
            {
              // Retry/edit must keep the same attachment source as the original row;
              // re-enumerating fields would drop the text-material marker.
              ...attachment,
              ref: attachment.ref,
            },
          ]
        : [],
    ) ?? []
  );
}

/**
 * Admission persists only commands that actually produce input. edit/retry cannot infer intent from
 * payload; they must reuse the projection's canonical target and fold the previous source into provenance.
 */
export function resolveInputCommandForAdmission(
  envelope: CommandEnvelope,
  admissionSessionId: string,
  resolveRowTarget: ResolveAdmissionRowTarget,
): InputCommandForAdmission | null {
  if (envelope.type === "createSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string; attachments?: AttachmentRef[] };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: firstInput.attachments ?? [],
        }
      : null;
  }
  if (envelope.type === "createSelectionSideSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: [],
        }
      : null;
  }
  if (envelope.type === "sendText" || envelope.type === "sendGoalCommand") {
    const payload = envelope.payload as {
      text: string;
      attachments?: AttachmentRef[];
      context_refs?: ConversationInputIntent["sharedContextRefs"];
      highspeedMeta?: ConversationInputIntent["highspeed"];
      inputOrigin?: "desktop" | "mobile";
      conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
      botGroupSource?: ConversationInputIntent["botGroupSource"];
    };
    return {
      kind: envelope.type,
      text: payload.text,
      attachments: payload.attachments ?? [],
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
      ...(payload.highspeedMeta ? { highspeed: payload.highspeedMeta } : {}),
      ...(payload.inputOrigin ? { inputOrigin: payload.inputOrigin } : {}),
      ...(payload.conversationQuotes ? { conversationQuotes: payload.conversationQuotes } : {}),
      ...(payload.botGroupSource ? { botGroupSource: payload.botGroupSource } : {}),
    };
  }
  if (envelope.type === "compact") {
    return { kind: "compact", text: "/compact", attachments: [] };
  }
  if (envelope.type !== "editUserQuery" && envelope.type !== "retryTurn") return null;
  if (!envelope.sessionId) return null;
  const payload = envelope.payload as {
    target: { rowId: number; entityId: string };
    newText?: string;
    conversationQuotes?: ConversationInputIntent["conversationQuotes"];
    attachments?: AttachmentRef[];
  };
  const resolution = resolveRowTarget(envelope.sessionId, payload.target, envelope.type);
  if (!resolution?.ok || !resolution.editTarget) return null;
  const canonical = resolution.editTarget;

  // Submit the append-only branch cut first; do not create a hidden child for edit.
  const originalSourceCommandId =
    canonical.intent.provenance?.sourceCommandId ?? canonical.intent.sourceCommandId;
  return {
    kind: canonical.intent.kind,
    ...(canonical.intent.inputOrigin ? { inputOrigin: canonical.intent.inputOrigin } : {}),
    ...((payload.conversationQuotes ?? canonical.intent.conversationQuotes)
      ? { conversationQuotes: payload.conversationQuotes ?? canonical.intent.conversationQuotes }
      : {}),
    ...(canonical.intent.botGroupSource ? { botGroupSource: canonical.intent.botGroupSource } : {}),
    text:
      envelope.type === "editUserQuery"
        ? (payload.newText ?? canonical.intent.text)
        : canonical.intent.text,
    attachments:
      envelope.type === "editUserQuery" && payload.attachments
        ? payload.attachments
        : admissionAttachmentRefs(canonical.intent.attachments),
    ...(canonical.intent.requestedDelivery
      ? { requestedDelivery: canonical.intent.requestedDelivery }
      : {}),
    ...(canonical.intent.admittedDelivery
      ? { admittedDelivery: canonical.intent.admittedDelivery }
      : {}),
    ...(canonical.intent.fallbackReasonCode
      ? { fallbackReasonCode: canonical.intent.fallbackReasonCode }
      : {}),
    ...(originalSourceCommandId
      ? {
          provenance: canonical.intent.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.intent.queueItemId ? { queueItemId: canonical.intent.queueItemId } : {}),
            ...(canonical.intent.clientId ? { clientId: canonical.intent.clientId } : {}),
          },
        }
      : {}),
  };
}

export function isConversationInputAdmissionCommand(type: CommandEnvelope["type"]): boolean {
  return (
    type === "sendText" ||
    type === "sendGoalCommand" ||
    type === "compact" ||
    type === "editUserQuery" ||
    type === "retryTurn"
  );
}

function buildForkInitialInput(
  envelope: CommandEnvelope,
  childSessionId: string,
  admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  input: InputCommandForAdmission,
): ForkCommitBundle["initialInput"] {
  const requested = input.requestedDelivery ?? "startNow";
  const fallbackReasonCode = input.fallbackReasonCode;
  const admitted =
    input.admittedDelivery ??
    (fallbackReasonCode ? "queue" : requested === "auto" ? "startNow" : requested);
  const intent = conversationInputIntentSchema.parse({
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind: input.kind,
    ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
    ...(input.conversationQuotes ? { conversationQuotes: input.conversationQuotes } : {}),
    ...(input.botGroupSource ? { botGroupSource: input.botGroupSource } : {}),
    text: input.text,
    attachments: input.attachments,
    delivery: {
      requested,
      admitted,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: { admissionSeq: admission.admissionSeq },
    steer: fallbackReasonCode
      ? { state: "fellBack", reasonCode: fallbackReasonCode }
      : { state: "notRequested" },
    dispatch: { state: "admitted" },
    admittedAt: admission.admittedAt,
    ...(input.highspeed ? { highspeed: input.highspeed } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  return {
    id: admission.queueItemId,
    sessionID: childSessionId as SessionId,
    kind: intent.kind,
    delivery: intent.delivery.admitted,
    payload: {
      text: intent.text,
      conversationInputIntent: intent,
      attachments: intent.attachments,
      sourceCommandType: envelope.type,
    },
  };
}

async function recordForkStartFailureBestEffort(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  command: Pick<CommandEnvelope, "commandId">,
  error: unknown,
  details: { parentSessionId?: string; registrationRequired?: boolean } = {},
): Promise<void> {
  const store = context.deps.sessionStore;
  const record = context.sessions.get(sessionId);
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  const warn = (stage: string, failure: unknown) => {
    try {
      context.logger?.warn("fork child post-commit failure recording degraded", {
        commandId: command.commandId,
        error: failure instanceof Error ? failure.message : String(failure),
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        stage,
      });
    } catch {
      // A logger sink failure is also post-commit; it must not reverse the durable child/fact.
    }
  };

  try {
    await store?.settleSessionInput?.({
      id: queueItemIdForCommand(command.commandId),
      sessionID: sessionId as SessionId,
      status: "failed",
      reason: "fault.command.childStartFailed",
    });
  } catch (failure) {
    warn("ledger", failure);
  }
  try {
    await store?.saveSessionEntry?.({
      id: `v4_fork_start_failure:${command.commandId}`,
      sessionID: sessionId as SessionId,
      type: "v4/fork_start_failure",
      time: { created: now, updated: now },
      data: {
        commandId: command.commandId,
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        ...(details.registrationRequired ? { registrationRequired: true } : {}),
        retryable: true,
        status: "failed",
        reasonCode: "fault.command.childStartFailed",
        message,
      },
    });
  } catch (failure) {
    warn("entry", failure);
  }
  if (!record) return;
  try {
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as SessionId,
      type: SessionEventType.TurnError,
      timestamp: new Date(now),
      traceId: record.traceContext.traceId,
      sequenceNumber: (await record.eventStore.getLatestSequenceNumber(sessionId as SessionId)) + 1,
      payload: {
        inputId: command.commandId,
        turnPhase: "fork_child_start",
        error: {
          type: "fault.command.childStartFailed",
          message,
          retryable: true,
        },
      },
    };
    const persisted = await record.eventStore.append(event);
    context.v4Gateway?.ingest(sessionId, persisted);
  } catch (failure) {
    warn("event", failure);
  }
}

/**
 * Committing the fork bundle is the command's point of no return. Catalog/model/resume/snapshot
 * afterward only restore runtime reachability. Failures in this phase must leave retryable facts and
 * a warning, but must not reverse a durably accepted child to failed.
 */
export async function registerCommittedForkBestEffort(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Parameters<typeof registerForkedSession>[2],
  options: Parameters<typeof registerForkedSession>[3] & { commandId: string },
  register: typeof registerForkedSession = registerForkedSession,
): Promise<void> {
  const { commandId, ...registrationOptions } = options;
  try {
    await register(context, record, fork, registrationOptions);
  } catch (error) {
    const forkedSessionId = String(fork.forkedSessionId);
    const parentSessionId = String(fork.parentSessionId ?? record.app.sessionId);
    await recordForkStartFailureBestEffort(context, forkedSessionId, { commandId }, error, {
      parentSessionId,
      registrationRequired: true,
    });
    try {
      context.logger?.warn("fork child registration failed after durable commit", {
        commandId,
        error: error instanceof Error ? error.message : String(error),
        forkedSessionId,
        parentSessionId,
        retryable: true,
      });
    } catch {
      // Previously, an exception from the logger bubbled past the point of no return and made the
      // gateway incorrectly settle the command as failed.
    }
  }
}

/** Narrowed context needed to persist turn-terminal timing; structural typing keeps it
 * compatible with the full server context. */
export interface HighspeedTurnTerminalPersistenceContext {
  sessions: Map<
    string,
    { eventStore: SessionEventStorePort; traceContext: { traceId: string | number } }
  >;
  deps: { sessionStore?: SessionStorePort };
  v4Gateway?: { ingest(sessionId: string, event: SessionEvent): unknown };
  logger?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * Turn-terminal hook: splits the real timing accumulated by the projection onto the
 * transcript's metadata.highspeed.
 * Bug root cause (2026-08-31 audit #1): the gateway invokes this hook for every
 * TurnComplete/TurnError, and the projection writes modelDurationMs/toolDurationMs for ordinary
 * turns too, so the old "return only when both are undefined" guard never fired — every ordinary
 * turn terminal first ran a full sessionStore.messages() scan and only then returned because
 * metadata.highspeed was missing, burning O(N) I/O on the hot path of long sessions. The
 * userInput row carries the persisted highspeed identity; short-circuit on it before scanning.
 */
export function persistHighspeedTimingOnTurnTerminal(
  context: HighspeedTurnTerminalPersistenceContext,
  sessionId: string,
  event: SessionEvent,
  snapshot: ConversationSnapshot,
): void {
  const record = context.sessions.get(sessionId);
  const sessionStore = context.deps.sessionStore;
  const payload = event.payload as { inputId?: unknown; duration?: unknown };
  const inputId = typeof payload.inputId === "string" ? payload.inputId : undefined;
  const header = snapshot.rows.window
    .filter(
      (row): row is Extract<(typeof snapshot.rows.window)[number], { kind: "turnHeader" }> =>
        row.kind === "turnHeader" &&
        (inputId === undefined
          ? row.turnId === String(event.turnId)
          : row.sourceCommandId === inputId),
    )
    .at(-1);
  if (!record || !sessionStore || !header?.sourceCommandId) return;
  const user = snapshot.rows.window.find(
    (row) => row.kind === "userInput" && row.sourceCommandId === header.sourceCommandId,
  );
  if (!user || user.kind !== "userInput") return;
  if (!user.highspeed) return;
  if (header.modelDurationMs === undefined && header.toolDurationMs === undefined) {
    return;
  }
  void persistHighspeedTiming({
    sessionStore,
    eventStore: record.eventStore,
    sessionId,
    sourceCommandId: header.sourceCommandId,
    timing: {
      modelDurationMs: header.modelDurationMs ?? 0,
      toolDurationMs: header.toolDurationMs ?? 0,
      otherDurationMs: header.otherDurationMs ?? 0,
    },
    ...(header.outputTokens !== undefined ? { outputTokens: header.outputTokens } : {}),
    ...(header.activeMs !== undefined ? { durationMs: header.activeMs } : {}),
    // fallbackAt exists only in the live projection: writing it to the transcript at turn
    // terminal keeps HighspeedMetricsUpdated and cold hydration from losing it (spec §5).
    ...(user.highspeed.fallbackAt !== undefined ? { fallbackAt: user.highspeed.fallbackAt } : {}),
    ...(user.highspeed.fallbackReason !== undefined
      ? { fallbackReason: user.highspeed.fallbackReason }
      : {}),
    traceId: String(record.traceContext.traceId),
    onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
    onLiveProjectionError: (error) =>
      context.logger?.warn("v4 highspeed timing live projection failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      }),
  }).catch((error) => {
    context.logger?.warn("v4 highspeed timing persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
  });
}

export function createConversationV4Gateway(
  context: ZCodeProtocolAgentServerContext,
): ConversationV4Gateway {
  const log = createProtocolLogger(context.deps)?.child({
    module: "bootstrap.zcode_protocol_v4_gateway",
  });
  const persistentCommands = new PersistentCommandIndex({
    loadSession: async (sessionId) => {
      const live = context.sessions.get(sessionId);
      const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!live && !stored) return null;
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) return null;
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      const facts = context.deps.sessionStore
        ? await loadPersistentCommandFacts(context.deps.sessionStore, sessionId as SessionId, {
            discardAdmittedOnLoad: !live,
          })
        : undefined;
      return {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        ...(facts ? { facts } : {}),
      };
    },
  });
  let nativeExecutor: V4CommandExecutor;
  const autoDrainRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Highspeed execution material contains temporary credentials: it lives only in memory keyed
  // by session/sourceCommandId and never enters TurnSteerQueued, snapshots, or the transcript.
  // If it is missing after a CLI restart, queue promotion automatically falls back to the
  // original model.
  const queuedTurnExecutions = new Map<string, Map<string, V4QueuedTurnExecution>>();
  const autoDrainV4QueueIfReady = async (record: ZCodeProtocolSessionRecord): Promise<void> => {
    const head = context.v4Gateway?.getQueueHead(record.app.sessionId);
    if (!head) {
      // The outer recovery FIFO has drained; the guide is still consumed only within the core tool-batch boundary.
      record.app.completeExternalQueueDrain();
      return;
    }
    const coreForegroundBusy = record.app.runtime.getActiveForegroundExecutionId() !== undefined;
    if (
      head.autoDrain &&
      head.dispatchState === "queued" &&
      (record.activeAbortController !== undefined || coreForegroundBusy)
    ) {
      // The bootstrap controller does not override model-only notifications. The old auto-drain
      // checked only the outer lock and incorrectly treated "consume when idle" as preemption. Do
      // not touch the reservation while busy.
      scheduleAutoDrainRetry(record);
      return;
    }
    let targetStatus: GoalStatus | null = null;
    if (head.autoDrain && head.dispatchState === "queued" && !record.activeAbortController) {
      try {
        targetStatus = (await record.app.readTarget())?.status ?? null;
      } catch (error) {
        // Treat a failed target read as "unknown and incomplete"; promoting directly could let an
        // ordinary queue item run before goal verification has a provable durable terminal state.
        context.logger?.warn("v4 auto-drain held because target state could not be read", {
          error: error instanceof Error ? error.message : String(error),
          queueItemId: head.queueItemId,
          sessionId: record.app.sessionId,
        });
        return;
      }
    }
    if (
      !shouldAutoDrainV4QueueHead({
        autoDrain: head.autoDrain,
        dispatchState: head.dispatchState,
        sessionBusy: Boolean(record.activeAbortController) || coreForegroundBusy,
        targetStatus,
      })
    ) {
      return;
    }
    // After restoring a paused queue, old items exist only in the projection, not in the new
    // activeTurn memory. Plain text must use the same projected head as typed /goal and /compact so
    // new input cannot overtake an older paused item.
    try {
      await nativeExecutor.execute(
        {
          baseRevision: 0,
          clientId: "v4-auto-drain",
          commandId: `auto-${head.kind}-${Date.now()}-${head.queueItemId}`,
          issuedAt: Date.now(),
          payload: { queueItemId: head.queueItemId },
          sessionId: record.app.sessionId,
          type: "sendQueuedNow",
        },
        undefined,
        { autoDrainPromotion: true },
      );
    } catch (error) {
      if (error instanceof V4QueuePromotionLeaseUnavailableError) {
        // A notification may enqueue new work between precheck and handler; idle-only is the final atomic condition.
        scheduleAutoDrainRetry(record);
        return;
      }
      // Failed automatic promotion must not bypass this FIFO barrier. Pause again and keep the item for user retry.
      await record.app.setQueueAutoDrain(false);
      context.logger?.warn("v4 auto-drain failed and queue was paused", {
        error: error instanceof Error ? error.message : String(error),
        queueItemId: head.queueItemId,
        sessionId: record.app.sessionId,
      });
    }
  };
  const scheduleAutoDrainRetry = (record: ZCodeProtocolSessionRecord): void => {
    const sessionId = record.app.sessionId;
    if (autoDrainRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      autoDrainRetryTimers.delete(sessionId);
      if (context.sessions.get(sessionId) !== record) return;
      void autoDrainV4QueueIfReady(record).catch((error: unknown) => {
        context.logger?.warn("v4 auto-drain idle reevaluation failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    }, 100);
    timer.unref?.();
    autoDrainRetryTimers.set(sessionId, timer);
  };
  const coreHost: V4CommandCoreHost = {
    // Same registry object reference: view is a narrow structured view of the legacy record, so
    // field changes are visible in both directions.
    getRecord: (sessionId) => context.sessions.get(sessionId),
    // Same registry instance: the broker (legacy directory) registers deferred reverse requests;
    // the v4 resolveInteraction handler delivers answers through it (native v4 infrastructure, not a transitional hook).
    interactions: context.v4Interactions,
    logger: {
      info: (message, fields) => context.logger?.info(message, fields),
      warn: (message, fields) => context.logger?.warn(message, fields),
    },
    // Native v4 capability (not a transitional hook): sendQueuedNow must read the complete intent
    // from the v4 projection. The server injects context.v4Gateway during command execution (it is
    // filled with createConversationV4Gateway's return value), so resolve it lazily to avoid a
    // construction-time self-reference.
    getQueueItem: (sessionId, queueItemId) =>
      context.v4Gateway?.getQueueItem(sessionId, queueItemId) ?? null,
    hasQueueItemKind: (sessionId, kind) =>
      context.v4Gateway?.hasQueueItemKind(sessionId, kind) ?? false,
    hasQueuedDelivery: (sessionId, delivery) =>
      context.v4Gateway?.hasQueuedDelivery(sessionId, delivery) ?? false,
    getQueueLength: (sessionId) => context.v4Gateway?.getQueueLength(sessionId) ?? 0,
    retainQueuedTurnExecution: (sessionId, sourceCommandId, execution) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId) ?? new Map();
      sessionExecutions.set(sourceCommandId, execution);
      queuedTurnExecutions.set(sessionId, sessionExecutions);
    },
    readQueuedTurnExecution: (sessionId, sourceCommandId) =>
      queuedTurnExecutions.get(sessionId)?.get(sourceCommandId),
    deleteQueuedTurnExecution: (sessionId, sourceCommandId) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId);
      sessionExecutions?.delete(sourceCommandId);
      if (sessionExecutions?.size === 0) queuedTurnExecutions.delete(sessionId);
    },
    clearQueuedTurnExecutions: (sessionId) => {
      queuedTurnExecutions.delete(sessionId);
    },
    waitForProjectionEventCommit: (sessionId, eventId, options) => {
      const gateway = context.v4Gateway;
      if (!gateway) {
        return Promise.reject(new Error("v4 gateway unavailable for projection commit wait"));
      }
      return gateway.waitForProjectionEventCommit(sessionId, eventId, options);
    },
    admitInputCommand: async (envelope, sessionId, admission) => {
      if (!context.deps.sessionStore?.saveSessionInput) return null;
      const input = resolveInputCommandForAdmission(
        envelope,
        sessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) return null;
      const kind = input.kind;
      const record = context.sessions.get(sessionId);
      if (record?.persistence === "deferred") {
        // session_input has a session foreign key, while the draft is persisted only in the
        // background startPromptTurn stage. Writing the ledger first would fail the FK, and before
        // acceptance there would be no authoritative record. Admission therefore passes through
        // the runtime's unified initial-persistence boundary first, then writes the ledger; the
        // handler only executes afterward.
        await record.app.runtime.ensureSessionPersistedForExternalActivity(input.text ?? "", {
          traceContext: record.traceContext,
        });
        record.persistence = "immediate";
      }
      const routingMode = context.v4Gateway?.getInputRoutingMode(sessionId) ?? null;
      // This is the pre-execution ledger's estimated delivery boundary. TurnSteerQueued idempotently
      // updates the same record with the actual delivery / fallback reason. startNow must not
      // pretend to be a queue, or the discarded diagnostic after restart becomes inaccurate.
      const requestedDelivery =
        input.requestedDelivery ??
        (kind === "compact" && routingMode !== null && routingMode !== "startNow"
          ? "queue"
          : routingMode === "enqueue"
            ? "queue"
            : routingMode === "guide" && kind === "sendText"
              ? "guide"
              : "startNow");
      const attachmentRefs = input.attachments;
      const fallbackReasonCode =
        input.fallbackReasonCode ??
        (requestedDelivery === "guide" && attachmentRefs.length > 0
          ? "guide.attachmentsUnsupported"
          : undefined);
      const admittedDelivery =
        input.admittedDelivery ??
        (fallbackReasonCode
          ? "queue"
          : requestedDelivery === "auto"
            ? "startNow"
            : requestedDelivery);
      const conversationInputIntent = conversationInputIntentSchema.parse({
        ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
        ...(input.conversationQuotes ? { conversationQuotes: input.conversationQuotes } : {}),
        ...(input.botGroupSource ? { botGroupSource: input.botGroupSource } : {}),
        sourceCommandId: envelope.commandId,
        queueItemId: admission.queueItemId,
        clientId: envelope.clientId || "cli",
        kind,
        text: input.text ?? "",
        attachments: attachmentRefs,
        ...(input.sharedContextRefs ? { sharedContextRefs: input.sharedContextRefs } : {}),
        delivery: {
          requested: requestedDelivery,
          admitted: admittedDelivery,
          ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
        },
        order: { admissionSeq: admission.admissionSeq },
        steer: fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : requestedDelivery === "guide"
            ? { state: "submitting" }
            : { state: "notRequested" },
        dispatch: { state: "admitted" },
        admittedAt: admission.admittedAt,
        ...(input.highspeed ? { highspeed: input.highspeed } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
      await context.deps.sessionStore.saveSessionInput({
        id: admission.queueItemId,
        sessionID: sessionId as SessionId,
        kind,
        delivery: conversationInputIntent.delivery.admitted,
        payload: {
          text: conversationInputIntent.text,
          intent: {
            sourceCommandId: conversationInputIntent.sourceCommandId,
            queueItemId: conversationInputIntent.queueItemId,
            clientId: conversationInputIntent.clientId,
            kind: conversationInputIntent.kind,
            admissionSeq: admission.admissionSeq,
            admittedAt: admission.admittedAt,
            requestedDelivery: conversationInputIntent.delivery.requested,
            admittedDelivery: conversationInputIntent.delivery.admitted,
            ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
            attachmentRefs,
            ...(conversationInputIntent.sharedContextRefs
              ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
              : {}),
          },
          conversationInputIntent,
          attachments: attachmentRefs,
          ...(conversationInputIntent.sharedContextRefs
            ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
            : {}),
          sourceCommandType: envelope.type,
        },
      });
      if (
        conversationInputIntent.sharedContextRefs?.length &&
        conversationInputIntent.delivery.admitted !== "startNow"
      ) {
        const reference = conversationInputIntent.sharedContextRefs[0]!;
        const reserved = await context.deps.sessionStore.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId: reference.context_id,
          expectedStatus: "pending",
          status: "reserved",
          sourceId: admission.queueItemId,
        });
        if (!reserved) {
          await context.deps.sessionStore.settleSessionInput?.({
            id: admission.queueItemId,
            sessionID: sessionId as SessionId,
            status: "failed",
            reason: "shared_context_not_attachable",
          });
          throw new Error("fault.command.sharedContextNotAttachable");
        }
        const entry = (
          await context.deps.sessionStore.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === reference.context_id,
          );
        });
        const data = entry?.data;
        const session = await context.deps.sessionStore.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: reference.context_id,
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "reserved",
          });
        }
      }
      return conversationInputIntent;
    },
    cancelInputCommand: async (sessionId, queueItemId, reason) => {
      await context.deps.sessionStore?.settleSessionInput?.({
        id: queueItemId,
        sessionID: sessionId as SessionId,
        status: "cancelled",
        reason,
      });
      const store = context.deps.sessionStore;
      const entries = await store?.sessionEntries?.({
        sessionID: sessionId as SessionId,
        type: "v4/shared_context_import",
      });
      const reserved = entries?.find((entry) => {
        const data = entry.data;
        return Boolean(
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          (data as Record<string, unknown>).status === "reserved" &&
          (data as Record<string, unknown>).sourceId === queueItemId,
        );
      });
      const contextId =
        reserved?.data && typeof reserved.data === "object"
          ? (reserved.data as Record<string, unknown>).contextId
          : undefined;
      if (typeof contextId === "string") {
        await store?.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId,
          expectedStatus: "reserved",
          status: "pending",
          sourceId: queueItemId,
        });
      }
    },
    discardSharedContext: async (sessionId, contextId) => {
      const store = context.deps.sessionStore;
      if (!store?.transitionSharedContextImport) return false;
      const updated = await store.transitionSharedContextImport({
        sessionID: sessionId as SessionId,
        contextId,
        expectedStatus: "pending",
        status: "discarded",
      });
      if (updated) {
        const entry = (
          await store.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === contextId,
          );
        });
        const data = entry?.data;
        const session = await store.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          typeof (data as Record<string, unknown>).contextId === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: String((data as Record<string, unknown>).contextId),
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "discarded",
          });
        }
      }
      return updated;
    },
    recordPersistentCommandFact: async (sessionId, source, ack, metadata) => {
      const store = context.deps.sessionStore;
      const live = context.sessions.get(sessionId);
      const stored = await store?.getSession(sessionId as SessionId);
      if (!store || (!live && !stored)) {
        throw new Error("fault.command.persistentFactSessionNotFound");
      }
      await savePersistentCommandFact(store, sessionId as SessionId, source, ack, metadata);
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) throw new Error("fault.command.persistentFactWorkspaceMissing");
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      await persistentCommands.record(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        },
        sessionId,
        source,
        ack,
      );
    },
    // Resolve held choices (heldQueueInputRequiresChoice) by reading projection inputRouting.mode.
    getInputRoutingMode: (sessionId) => context.v4Gateway?.getInputRoutingMode(sessionId) ?? null,
    // Translate rowId → messageId for fork/edit/retry targeting decisions, using the v4 projection
    // as the data source. Look it up lazily through the gateway.
    getMessageIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdForRow(sessionId, rowId) ?? null,
    resolveRowActionTarget: (sessionId, target, action) =>
      context.v4Gateway?.resolveRowActionTarget(sessionId, target, action) ?? null,
    getMessageIdsForTurnRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdsForTurnRow(sessionId, rowId) ?? [],
    isLatestAssistantSegmentRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestAssistantSegmentRow(sessionId, rowId) ?? null,
    resolveStableForkTarget: async (sessionId, rowId) => {
      const candidate = context.v4Gateway?.resolveStableForkCandidate(sessionId, rowId) ?? null;
      if (!candidate) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      if (!candidate.ok) return candidate;
      const store = context.deps.sessionStore;
      if (!store) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      return await resolveStableForkTargetFromTranscript({
        candidate: candidate.candidate,
        messages,
        store,
      });
    },
    isLatestRetryAssistantRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestRetryAssistantRow(sessionId, rowId) ?? null,
    isLatestEditableUserRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestEditableUserRow(sessionId, rowId) ?? null,
    getTurnIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null,
    // Timing self-heal probe for restoreWarning: the App's model view comes directly from the process Registry.
    hasUsableRuntimeModelTarget: (record) => record.app.listModels().length > 0,
    getTurnRewindAnchor: (sessionId, rowId) =>
      context.v4Gateway?.getTurnRewindAnchor(sessionId, rowId) ?? null,
    resolveUserMessageIdForRow: async (sessionId, rowId) => {
      const turnId = context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null;
      const sessionStore = context.deps.sessionStore;
      if (!turnId || !sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const user = messages
        .filter(
          (message) =>
            message.info.role === "user" &&
            String(message.info.anchor?.turnId ?? "") === turnId &&
            isConversationRealUserTurnStarter(message),
        )
        .at(-1);
      return user ? String(user.info.id) : null;
    },
    // Resolve retryTurn's original prompt: assistant messageId → parentID (user message) → text.
    // Source is core sessionStore (transcript authority); implementation is in the binder only
    // because deps are injected by the host, which owns this natively. If not found, return null so
    // the handler truncates without resending.
    resolveTurnUserPrompt: async (sessionId, assistantMessageId) => {
      const sessionStore = context.deps.sessionStore;
      if (!sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const assistantInfo = messages.find(
        (message) => message.info.id === assistantMessageId,
      )?.info;
      if (assistantInfo?.role !== "assistant") return null;
      const user = messages.find((message) => message.info.id === assistantInfo.parentID);
      if (!user || user.info.role !== "user") return null;
      const text = user.parts
        .filter(
          (part): part is Extract<(typeof user.parts)[number], { type: "text" }> =>
            part.type === "text" && part.ignored !== true,
        )
        .map((part) => part.text)
        .join("");
      return text.length > 0 ? text : null;
    },
    setAssistantFeedback: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      // Feedback must first be persisted to the transcript so CLI restart can recover it through
      // cold hydration. eventStore/projection advances afterward; retries can idempotently fill in
      // from the same durable fact.
      await persistAssistantFeedback({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        feedback: input.feedback,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 assistant feedback live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
    setRowPinned: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      // Pins follow the same transcript-first order as feedback: persist metadata so CLI restart
      // recovers it through cold hydration, then advance eventStore/projection from the same fact.
      await persistRowPinned({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        pinned: input.pinned,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 row pin live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
    setHighspeedMetrics: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      await persistHighspeedMetrics({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        metrics: input.metrics,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 highspeed metrics live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
    // ── Transitional hooks (removed in M5 wave 2) ──────────────────────────────
    ensureModelReady: (record) =>
      ensureSessionModelAvailableForNextTurn(context, record as ZCodeProtocolSessionRecord),
    // Before switching models, confirm that the target Provider exists in the current Environment
    // Registry. Ordinary model commands submit only Selection; Provider facts are always interpreted
    // by the Worker's own Registry.
    ensureProviderAvailable: async (sessionId, providerId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return { available: false, reason: "session_not_found" };
      if (!hasSessionModelProvider(context, record, providerId)) {
        return { available: false, reason: "provider_not_in_registry" };
      }
      return { available: true };
    },
    afterLegacyStateMutation: async (record, reason) => {
      await afterStateMutation(context, record as ZCodeProtocolSessionRecord, reason);
      await autoDrainV4QueueIfReady(record as ZCodeProtocolSessionRecord);
    },
    // deleteSession execution: inline the four steps from the old closeSession op (do not import the
    // old op; semantics match closeSession in server-operations.ts and can be absorbed into v4 when
    // the session registry moves).
    closeSession: async (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        // The handler already checked existence; handle only the concurrency race here (duplicate deletion succeeds idempotently).
        return;
      }
      record.unsubscribe?.();
      await record.app.close?.();
      // v4 channel: closing a session also clears its publisher / subscription scheduling; reopening
      // starts cold from a snapshot. Call disposeSession before removing the registry entry:
      // gateway uses getSessionWorkspaceId (reads context.sessions) to locate the workspace when
      // notifying sessions-index subscribers of session.removed. If deletion happens first,
      // workspaceId is always null and the sidebar item never disappears after session deletion
      // (caught by e2e conversation-session-v4-sidebar).
      context.v4Gateway?.disposeSession(sessionId);
      queuedTurnExecutions.delete(sessionId);
      context.sessions.delete(sessionId);
    },
    // createSession execution: record creation, event wiring, catalog sync, and failure cleanup all
    // live in the old createSession op (its cleanup order for partially initialized records fixed a
    // bug; do not reimplement it). Semantic decisions (draft persistence / firstInput through the
    // native prompt turn) live in the native handler.
    createSessionRecord: async ({
      workspaceId,
      preparedSessionId,
      expectedAttemptId,
      mcpServers,
      executionWorktree,
      incognito,
      offPeakToolEnabled,
      dynamicWorkflowEnabled,
      dynamicWorkflowMode,
      permissionScope,
    }) =>
      serializePreparedWorktreeMutation(context, preparedSessionId, async () => {
        if (permissionScope && !context.deps.sessionStore)
          throw new Error("Group task permission scope requires persistence");
        // The profile actually used for this prepared identity. A prepared row starts without one;
        // the first activation's request freezes it (durable via the row's set-once column,
        // in-memory via the prepared entry until that write lands).
        let activationIncognito = incognito;
        if (preparedSessionId) {
          const prepared = await loadStoredPreparedWorktreeSession(context, preparedSessionId);
          if (
            !prepared ||
            (prepared.status !== "preparing" && prepared.status !== "active") ||
            (prepared.attemptId && prepared.attemptId !== expectedAttemptId)
          ) {
            throw new Error("Prepared worktree session is unavailable");
          }
          if (
            prepared.workspace.workspaceKey !== workspaceId ||
            !executionWorktree ||
            executionWorktree.path !== prepared.targetPath ||
            (executionWorktree.branchName && executionWorktree.branchName !== prepared.branchName)
          ) {
            throw new Error("Prepared worktree session does not match the requested workspace");
          }
          const storedProfile = (
            await context.deps.sessionStore?.getSession(preparedSessionId as SessionId)
          )?.incognito;
          // Tri-state: a profile, `null` (frozen as a normal session), `undefined` (first use).
          const frozenChoice = storedProfile !== undefined ? storedProfile : prepared.incognito;
          if (
            frozenChoice !== undefined &&
            // `null` (frozen as a normal session) compares as an absent profile.
            !incognitoProfilesEqual(frozenChoice ?? undefined, incognito)
          ) {
            // Cause: a retry could report success for an incognito request while returning a
            // normal session (or materialize the retry's profile against a row that keeps the
            // original). The stored profile is the frozen fact; only an exact match may reuse it.
            throw new Error(
              "Prepared worktree session does not match the requested incognito profile",
            );
          }
          if (frozenChoice !== undefined) activationIncognito = frozenChoice ?? undefined;
          if (prepared.status === "active") {
            // The durable active entry is the receipt of a completed activation: return the
            // existing identity without a second runtime, re-applied startup configuration, or a
            // second first-input admission — including on a cold Host with no live runtime.
            return { sessionId: preparedSessionId, preparedActivation: "already-active" };
          }
          if (context.sessions.has(preparedSessionId)) {
            // The runtime exists but the durable receipt is not settled. A durable admitted input
            // row means the frozen input already reached Core (an activation whose completion did
            // not persist): never re-send it under a new command id. Without such a row the
            // earlier attempt failed before admission, so exactly one retry may admit it.
            return {
              sessionId: preparedSessionId,
              preparedActivation: (await sessionHasAdmittedInput(context, preparedSessionId))
                ? "input-admitted"
                : "input-pending",
            };
          }
          // First materialization freezes the choice for warm-host retries: the row's profile
          // lands only at first-send persistence, so until then only this stamp holds it
          // (`null` freezes a normal session just as a profile freezes an incognito one).
          prepared.incognito = activationIncognito ?? null;
        }
        // workspaceId has two forms (Workspace Identity constraint):
        // - Local workspace = workspacePath (fallback when identity is omitted).
        // - Remote pane (split view across workspaces) = remote identity
        //   (remote:ssh/wsl/docker:...:<path>, created by UI buildRemoteWorkspaceIdentity).
        //   Use the shared parser to recover the real workspacePath for workingDirectory. The CLI
        //   already runs on the remote machine, so path is local there; preserve identity in the
        //   workspace ref (workspaceKey = identity, with sessions-index topic / isolation unchanged).
        // The shared parser supports both legacy WSL and explicit user identities; other formats are
        // treated as local workspacePath.
        const created = await createSessionRecordForV4(
          context,
          {
            workspace: resolveWorkspaceRefFromId(workspaceId),
            // A group task was already triggered by the first real request: persist the isolation
            // grant first, then open tasks and configuration. Ordinary Desktop drafts stay deferred.
            persistence: "deferred",
            // Execution worktree: the record executes in the linked worktree while session identity
            // and listing stay under the parent workspace above.
            ...(executionWorktree ? { executionWorktree } : {}),
            // The frozen choice of the prepared identity (stored profile when one exists), not
            // the retry's request — see the compare above.
            incognito: activationIncognito,
            // MCP is runtime-creation configuration. v4 createSession must pass it through just like
            // legacy session/create, or sessions created here will never start these tools.
            mcpServers,
            // The Off-Peak tool-surface flag is also runtime-creation configuration and must be included in the record at creation.
            ...(offPeakToolEnabled === true ? { offPeakToolEnabled: true } : {}),
            // The dynamic-workflow rollout gate is also runtime-creation configuration. v4 createSession
            // must pass it through like legacy session/create, or headless sessions bypass the Host
            // rollout check and use only the process default.
            ...(dynamicWorkflowEnabled === true ? { dynamicWorkflowEnabled: true } : {}),
            ...(dynamicWorkflowEnabled === true && dynamicWorkflowMode !== undefined
              ? { dynamicWorkflowMode }
              : {}),
          },
          preparedSessionId,
        );
        if (permissionScope) {
          const record = context.sessions.get(created.sessionId);
          if (!record) throw new Error("Group task runtime is unavailable");
          await record.app.runtime.ensureSessionPersistedForExternalActivity("", {
            traceContext: record.traceContext,
          });
          await context.deps.sessionStore!.updateSession({
            id: created.sessionId as SessionId,
            permission: { version: 1, scope: "session", mode: "build" },
          });
          await record.app.runtime.setExecutionState({ mode: "build" }, record.traceContext);
          record.persistence = "immediate";
        }
        return {
          sessionId: created.sessionId,
          ...(preparedSessionId ? { preparedActivation: "materialized" as const } : {}),
        };
      }),
    prepareWorktreeSession: async ({
      workspaceId,
      branchName,
      targetPath,
      baseBranch,
      attemptId,
    }) => {
      const store = context.deps.sessionStore;
      if (!store?.saveSessionEntry || !store.deleteEmptySession) {
        throw new Error("Worktree preparation requires session and session-entry storage");
      }
      const workspace = resolveWorkspaceRefFromId(workspaceId);
      const sessionId = createSessionId();
      const now = Date.now();
      await store.createSession({
        id: sessionId,
        projectID: projectIdFromDirectory(workspace.workspacePath),
        workspaceID: workspace.workspaceIdentity as WorkspaceId | undefined,
        slug: String(sessionId).toLowerCase(),
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: `Worktree ${branchName}`,
        titleSource: "default",
        version: context.deps.version ?? "0.0.0",
        time: { created: now, updated: now },
      });
      const prepared = {
        sessionId,
        workspace,
        ...(attemptId ? { attemptId } : {}),
        branchName,
        targetPath,
        ...(baseBranch ? { baseBranch } : {}),
        createdAt: now,
        updatedAt: now,
        status: "preparing" as const,
      };
      preparedWorktreeMap(context).set(String(sessionId), prepared);
      try {
        await persistPreparedWorktreeStatus(context, prepared, "preparing");
      } catch (error) {
        preparedWorktreeMap(context).delete(String(sessionId));
        try {
          await store.deleteEmptySession(sessionId);
        } catch (cleanupError) {
          context.logger?.warn("Could not remove an empty worktree preparation session", {
            sessionId: String(sessionId),
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        }
        throw error;
      }
      context.v4Gateway?.notifyPreparedSessionChanged(String(sessionId));
      return { sessionId: String(sessionId) };
    },
    updateWorktreePreparation: async (sessionId, input) =>
      serializePreparedWorktreeMutation(context, sessionId, async () => {
        const prepared = await restorePreparedWorktreeSession(context, sessionId);
        if (
          !prepared ||
          context.sessions.has(sessionId) ||
          prepared.status === "active" ||
          (prepared.attemptId && prepared.attemptId !== input.expectedAttemptId)
        ) {
          throw new Error("Prepared worktree session is unavailable");
        }
        assertWorktreePreparationMutation(prepared, input);
        await persistPreparedWorktreeStatus(
          context,
          prepared,
          input.status,
          input.failureMessage,
          input.worktreePreparation,
        );
        context.v4Gateway?.notifyPreparedSessionChanged(sessionId);
      }),
    withPreparedWorktreeActivation: <T>(sessionId: string, body: () => Promise<T>) =>
      serializePreparedWorktreeMutation(context, sessionId, body),
    completePreparedWorktreeActivation: async (sessionId) =>
      serializePreparedWorktreeMutation(context, sessionId, async () => {
        const prepared = await loadStoredPreparedWorktreeSession(context, sessionId);
        if (!prepared || prepared.status !== "preparing") return;
        await persistPreparedWorktreeStatus(context, prepared, "active");
        context.v4Gateway?.notifyPreparedSessionChanged(sessionId);
      }),
    createSelectionSideSession: async (sessionId, options) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const modelSelection = cloneModelSelection(
        options.modelSelection ?? record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.createSelectionSideConversation({
        modelSelection,
        sourceCommandId: options.sourceCommandId,
        revisionAtDecision: options.revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: options.sourceCommandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
          followupMode: context.v4Gateway?.getSessionFollowupMode(sessionId) ?? "queue",
        },
        inheritLatestTarget: false,
      });
      return { sessionId: String(fork.forkedSessionId) };
    },
    // Running stable fork: copy only the core transcript, then register the child record. Do not
    // read, stop, or copy the parent runtime, queue, background/continuation inbox, or shared workspace.
    forkStableConversation: async (sessionId, options) => {
      const { goalBoundary, revisionAtDecision, sourceCommandId, target } = options;
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      const boundary = messages.find(
        (message) => String(message.info.id) === target.boundaryMessageId,
      );
      if (boundary?.info.role !== "assistant") {
        throw new Error("guard.forkTargetAmbiguous");
      }
      // A fork inherits the session selection at the fork point; accelerated-turn messages record
      // a single-turn execution Selection, so skip them and fall back to the parent session's
      // resident selection.
      const modelSelection = derivedSessionModelSelection(
        boundary.info.providerId && boundary.info.modelId
          ? {
              providerId: boundary.info.providerId,
              modelId: boundary.info.modelId,
              ...(boundary.info.reasoningLevel
                ? { options: { reasoningLevel: boundary.info.reasoningLevel } }
                : {}),
            }
          : undefined,
        record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.forkStableConversationAtMessage({
        modelSelection,
        target,
        goalBoundary,
        sourceCommandId,
        revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: sourceCommandId,
        runtimeConfig: {
          mode: stableForkMode(boundary.info.mode, record.app.getMode()),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        // Core copied the goal using copied-message / verifier boundaries; do not overwrite it with the parent's current target.
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    forkConversationBeforeInput: async (sessionId, { editTarget, envelope, admission }) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({
        sessionID: sessionId as SessionId,
      });
      const targetMessage = messages.find(
        (message) => String(message.info.id) === editTarget.transcriptMessageId,
      );
      if (targetMessage?.info.role !== "user") {
        throw new Error("guard.latestQueryEditOnly");
      }
      const modelSelection = derivedSessionModelSelection(
        targetMessage.info.modelSelection,
        record.app.runtime.getSessionModelSelection(),
      );
      const events = await record.eventStore.getEvents(sessionId as SessionId);
      const targetStarted = events.find(
        (event) =>
          event.type === SessionEventType.TurnStarted &&
          String((event.payload as { messageId?: unknown }).messageId ?? "") ===
            editTarget.transcriptMessageId,
      );
      const priorTargetChange = targetStarted
        ? events
            .filter(
              (event) =>
                event.sequenceNumber < targetStarted.sequenceNumber &&
                event.type === SessionEventType.TargetChanged,
            )
            .at(-1)
        : undefined;
      const forkedSessionId = String(createSessionId());
      const input = resolveInputCommandForAdmission(
        envelope,
        forkedSessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) throw new Error("fault.command.forkInputAdmissionMissing");
      const initialInput = buildForkInitialInput(envelope, forkedSessionId, admission, input);
      let goalBoundary: StableForkGoalBoundaryMetadata | null = priorTargetChange
        ? (() => {
            const target = (priorTargetChange.payload as { target?: unknown }).target;
            return target
              ? {
                  kind: "snapshot" as const,
                  target: target as Extract<
                    StableForkGoalBoundaryMetadata,
                    { kind: "snapshot" }
                  >["target"],
                  verificationEntryIds: [],
                }
              : { kind: "none" as const };
          })()
        : null;
      if (goalBoundary?.kind === "snapshot" && store.sessionEntries && targetStarted) {
        const targetId = goalBoundary.target.targetID;
        const boundaryTime = targetStarted.timestamp.getTime();
        const entries = await store.sessionEntries({
          sessionID: sessionId as SessionId,
          type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        });
        goalBoundary = {
          ...goalBoundary,
          verificationEntryIds: entries.flatMap((entry) => {
            const data = entry.data as { payload?: { targetId?: unknown } };
            return entry.time.updated <= boundaryTime && data.payload?.targetId === targetId
              ? [entry.id]
              : [];
          }),
        };
      }
      if (!goalBoundary) {
        const targetIndex = messages.indexOf(targetMessage);
        const previousAssistant = messages
          .slice(0, targetIndex)
          .reverse()
          .find((message) => message.info.role === "assistant");
        goalBoundary = previousAssistant?.info.anchor?.goalBoundary ?? null;
        if (!previousAssistant) goalBoundary = { kind: "none" };
      }
      if (!goalBoundary) {
        throw new Error("guard.forkTargetAmbiguous");
      }
      const fork = await record.app.runtime.forkConversationBeforeMessage({
        modelSelection,
        forkedSessionId: forkedSessionId as SessionId,
        targetMessageId: targetMessage.info.id,
        targetProductTurnId: editTarget.productTurnId,
        targetTranscriptTurnId: String(
          targetMessage.info.anchor?.turnId ?? editTarget.productTurnId,
        ),
        sourceCommandId: envelope.commandId,
        initialInput,
        commandFact: {
          parentSessionId: sessionId,
          sourceCommandId: envelope.commandId,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: envelope.baseRevision ?? 0,
            result: {
              type: "editUserQuery",
              disposition: "fork",
              sessionId: forkedSessionId,
            },
          },
          metadata: {
            parentSessionId: sessionId,
            sourceCommandId: envelope.commandId,
            editTarget,
          },
        },
        // Use only TargetChanged before TurnStarted or the previous stable assistant anchor. Never
        // present the parent's current target (which may be written by the goal being edited) as the
        // state before this input.
        goalBoundary,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: envelope.commandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    recordForkStartFailure: async (sessionId, envelope, error) => {
      await recordForkStartFailureBestEffort(context, sessionId, envelope, error, {
        parentSessionId: String(envelope.sessionId ?? ""),
      });
    },
  };
  const childSessionFactsResolver = createChildSessionFactsResolver({
    store: () => context.deps.sessionStore,
    sessions: context.sessions,
    getDetachedChildren: () => context.v4Gateway?.getDetachedChildSessionFacts() ?? [],
    onRefresh: (parentKeys) => {
      for (const parentKey of parentKeys) {
        context.v4Gateway?.publishSessionIndexChildFacts(
          parentKey,
          childSessionFactsResolver.resolve(parentKey),
        );
      }
    },
    logger: context.logger,
  });
  nativeExecutor = new V4CommandExecutor(coreHost);
  const loadStoredSessionSummaries = async (
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ) => {
    // Lightweight summary for unloaded sessions: store metadata → SessionSummary. Default phase to
    // idle/completed, and set sessionEnded=true to match the rule that successful turn completion
    // means ended. The gateway overlays accurate phase/preview/backgroundWork from the live
    // projection once loaded.
    // Local fallback for workspaceKey is workspacePath, so use it for listSessions directory filtering.
    if (!context.deps.sessionStore) return [];
    try {
      // In the remote sessions-index, workspaceId is the isolation identity, while the session
      // store's directory is the real file path. Queries must include both path and identity;
      // otherwise sessions at the same path under another authority could be mislabeled as this
      // workspace. A legacy empty identity cannot be claimed by path alone; only an exact taskId
      // ownership proof from the host task index may claim it.
      const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
      const persistedWorkspacePath = parsedRemote?.workspacePath ?? workspaceId;
      if (
        parsedRemote &&
        legacyTaskIds &&
        legacyTaskIds.length > 0 &&
        context.deps.sessionStore.claimLegacySessionWorkspace
      ) {
        try {
          const claimedCount = await context.deps.sessionStore.claimLegacySessionWorkspace({
            sessionIDs: legacyTaskIds as SessionId[],
            directory: persistedWorkspacePath,
            workspaceID: workspaceId as WorkspaceId,
          });
          if (claimedCount > 0) {
            context.logger?.info("legacy remote sessions claimed by task-index allowlist", {
              claimedCount,
              event: "zcode_protocol.v4.sessions_index_legacy_remote_claimed",
              module: "bootstrap.zcode_protocol",
              workspaceId,
            });
          }
        } catch (error) {
          // Claim is only a legacy-data compatibility step. On failure, still read sessions with a
          // complete identity. Later subscriptions with an allowlist may enter here again, so a
          // failed result must not block migration permanently.
          context.logger?.warn("legacy remote sessions claim failed; continuing strict load", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.sessions_index_legacy_remote_claim_failed",
            module: "bootstrap.zcode_protocol",
            workspaceId,
          });
        }
      }
      const stored = await context.deps.sessionStore.listSessions({
        directory: persistedWorkspacePath,
        includeArchived: false,
        limit: 200,
        // parentID expresses only session hierarchy; it is not task membership on the left side.
        // Explicit forks always have parentID, but after restart taskType must still project them into sessions-index.
        taskTypes: [...TASK_LIST_SESSION_TYPES],
        workspaceID: parsedRemote ? (workspaceId as WorkspaceId) : null,
      });
      const [childCountFacts, childListFacts] = await childSessionFactsResolver.fetch(
        stored.map((session) => session.id),
      );
      childSessionFactsResolver.seed(
        stored.map((session) => session.id),
        childCountFacts,
        childListFacts,
      );
      childSessionFactsResolver.noteParents(childCountFacts.keys());
      childSessionFactsResolver.noteParents(childListFacts.keys());
      return await Promise.all(
        stored.map(async (session) => {
          const childCounts = childCountFacts.get(String(session.id));
          const childList = childListFacts.get(String(session.id)) ?? [];
          const prepared = await restorePreparedWorktreeSession(context, String(session.id));
          const isPreparing = Boolean(prepared && prepared.status !== "active");
          const executionWorktreeMissing = session.executionDirectory
            ? await isWorktreeDirectoryMissing(session.executionDirectory)
            : false;
          return {
            sessionId: String(session.id),
            workspaceId,
            ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
            title:
              isPreparing && prepared?.branchName
                ? `Worktree ${prepared.branchName}`
                : (session.title ?? ""),
            ...(isPreparing && prepared
              ? { worktreePreparation: worktreePreparationStateSchema.parse(prepared) }
              : {}),
            titleSource: normalizeStoredTitleSource(session.titleSource),
            phase: isPreparing ? ("draft" as const) : ("completedSuccess" as const),
            sessionEnded: !isPreparing,
            hasBackgroundWork: false,
            lastActivityAt: session.time?.updated ?? 0,
            createdAt: session.time?.created ?? 0,
            // Execution-worktree sessions keep listing under the parent workspace; the badge and
            // "open in IDE/folder" consumers need the worktree facts on the cold-seeded row too.
            ...(session.executionDirectory
              ? {
                  executionWorktree: {
                    path: session.executionDirectory,
                    ...(session.executionBranch ? { branchName: session.executionBranch } : {}),
                  },
                }
              : {}),
            ...(childCounts?.sideChats ? { sideChatCount: childCounts.sideChats } : {}),
            ...(childCounts?.subagents ? { subagentCount: childCounts.subagents } : {}),
            ...(childList.length
              ? { childSessions: childList.map((child) => toWireChildSession(child, false)) }
              : {}),
            ...(executionWorktreeMissing ? { executionWorktreeMissing: true } : {}),
            ...(session.incognito ? { incognito: true } : {}),
          };
        }),
      );
    } catch (error) {
      context.logger?.warn("sessions-index stored summaries failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.sessions_index_stored_failed",
        module: "bootstrap.zcode_protocol",
      });
      return [];
    }
  };
  return new ConversationV4Gateway({
    cliVersion: context.deps.version,
    sessionExists: (sessionId) =>
      context.sessions.has(sessionId) || preparedWorktreeMap(context).has(sessionId),
    restorePreparedSession: async (sessionId) => {
      await restorePreparedWorktreeSession(context, sessionId);
    },
    onDebug: (message) => log?.debug(message),
    onTargetCompleted: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return;
      // The goal verifier for background task notifications does not pass through the v4 prompt's
      // finally/afterLegacyStateMutation. Although TargetChanged(complete) is committed, the future
      // queue receives no later mutation to trigger reevaluation. Start the existing gate detached
      // here; do not block projection.
      void Promise.resolve()
        .then(() => autoDrainV4QueueIfReady(record))
        .catch((error: unknown) => {
          context.logger?.warn("v4 auto-drain reevaluation after target completion failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    onHighspeedTurnTerminal: (sessionId, event, snapshot) => {
      persistHighspeedTimingOnTurnTerminal(context, sessionId, event, snapshot);
    },
    // The gateway's single READY promise owns concurrency and sequencing; the binder only
    // restores the runtime and returns M0/M1.
    resumePersistedSession: async (
      sessionId,
      resumeThoughtLevel,
      workspace?: ZCodeWorkspaceRef,
    ) => {
      const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!persisted) {
        context.logger?.warn("ZCode Protocol v4 cold resume has no persisted session", {
          activeSessionCount: context.sessions.size,
          event: "zcode_protocol.v4.resume_persisted_missing",
          module: "bootstrap.zcode_protocol",
          sessionId,
        });
        return { status: "notFound" };
      }
      const activated = await activateSessionForResume(
        context,
        {
          sessionId,
          // session.path may be the normalized execution cwd and must not override the workspace
          // identity known by the current attachment. Older sessions without attachment context
          // still use the existing persisted fallback.
          ...(workspace ? { workspace } : {}),
          ...(resumeThoughtLevel ? { thoughtLevel: resumeThoughtLevel } : {}),
        },
        { reusePersistedMessages: true },
      );
      return {
        status: "resumed",
        persistedMessages: activated.persistedMessages,
      };
    },
    emitWireFrame: (wire) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      }),
    emitLocalTtftFacts: (facts) =>
      context.notify({ method: V4_NOTIFICATIONS.localTtftFacts, params: facts }),
    emitConversationTelemetryFact: (fact) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationTelemetryFact,
        params: fact,
      }),
    emitCuaPermissionObservation: (observation) =>
      context.notify({
        method: V4_NOTIFICATIONS.cuaPermissionObservation,
        params: observation,
      }),
    // ── Config seed: projection initial value = runtime truth ─────────────
    // Covers three seed sources: startup defaults (Workspace model preference + persisted project
    // mode), createSession.config (the handler applies it to the runtime before seeding), and
    // historical-session resume (the App restore result may contain only model identity; do not bind
    // a partially initialized execution model just for projection).
    getSessionMemoryEnabled: (sessionId) => context.sessions.get(sessionId)?.memoryEnabled,
    getSessionConfigSeed: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const selection =
        record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
      return {
        modelSelection: cloneModelSelection(selection),
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        thoughtLevels: selection
          ? (record.app
              .listModels()
              .find(
                (model) =>
                  model.ref.providerId === selection.providerId &&
                  model.ref.modelId === selection.modelId,
              )
              ?.reasoning?.levels.map((level) => level.value) ?? [])
          : [],
        mode: record.app.getMode(),
        planEnabled: record.app.runtime.getPlanEnabled(),
        ...(record.app.runtime.lastPermissionGrantId
          ? { permissionGrant: { interactionId: record.app.runtime.lastPermissionGrantId } }
          : {}),
      };
    },
    getSessionUsageSeed: async (sessionId, persistedMessages) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const contextUsage = await readSessionContextUsage(context, sessionId, persistedMessages);
      // The usage seed overwrites the first-frame denominator again after hydration; use the same
      // current model-registry truth as the synthetic event, not a window from an old runtime projection.
      return sessionUsageSeedFromRuntimeContextUsage(
        contextUsage,
        resolveSessionModelContextWindow(context, record),
      );
    },
    // ── sessions-index hooks (workspace buckets + cold-start store seed) ──────────
    getSessionWorkspaceId: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (record && isTaskListSessionType(record.taskType)) return record.workspace.workspaceKey;
      return preparedWorktreeMap(context).get(sessionId)?.workspace.workspaceKey ?? null;
    },
    getChildSessionParentId: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (
        (record?.taskType === "selection_side_chat" || record?.taskType === "subagent_child") &&
        record.parentSessionId
      ) {
        return String(record.parentSessionId);
      }
      return null;
    },
    onChildSessionActivity: (parentSessionId) => {
      childSessionFactsResolver.invalidate([parentSessionId]);
      // Update live running flags immediately; refreshed persisted totals/list are published by onRefresh.
      context.v4Gateway?.publishSessionIndexChildFacts(
        parentSessionId,
        childSessionFactsResolver.resolve(parentSessionId),
      );
      void childSessionFactsResolver.refresh([parentSessionId]);
    },
    getSessionIndexMeta: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        const prepared = preparedWorktreeMap(context).get(sessionId);
        return prepared
          ? { createdAt: prepared.createdAt, lastActivityAt: prepared.updatedAt }
          : null;
      }
      const executionWorktree = record.app.runtime.getExecutionWorktree();
      // Worktree health at derive time: the runtime fact carries `missing` after the resume
      // fallback; a statSync (the hook is synchronous) also catches out-of-band deletion between
      // events so the badge converges on the next fan-out without a resume.
      const executionWorktreeMissing =
        executionWorktree !== undefined &&
        (executionWorktree.missing === true ||
          isWorktreeDirectoryMissingSync(executionWorktree.path));
      return {
        createdAt: record.createdAt,
        lastActivityAt: record.updatedAt,
        ...(record.parentSessionId ? { parentSessionId: String(record.parentSessionId) } : {}),
        ...(executionWorktree
          ? {
              // Strip the runtime-only `missing` field from the strict nested wire shape.
              executionWorktree: {
                path: executionWorktree.path,
                ...(executionWorktree.branchName
                  ? { branchName: executionWorktree.branchName }
                  : {}),
              },
            }
          : {}),
        ...(executionWorktreeMissing ? { executionWorktreeMissing: true } : {}),
        ...(record.app.runtime.isIncognito() ? { incognito: true } : {}),
        ...childSessionFactsResolver.resolve(sessionId),
      };
    },
    getSessionPreparationSeed: (sessionId) => {
      const prepared = preparedWorktreeMap(context).get(sessionId);
      if (!prepared || prepared.status === "active") return null;
      return {
        branchName: prepared.branchName,
        targetPath: prepared.targetPath,
        ...(prepared.baseBranch ? { baseBranch: prepared.baseBranch } : {}),
        ...(prepared.attemptId ? { attemptId: prepared.attemptId } : {}),
        status: prepared.status,
        ...(prepared.failureMessage ? { failureMessage: prepared.failureMessage } : {}),
      };
    },
    listWorkspaceSessionIds: (workspaceId) => [
      ...[...context.sessions.values()]
        .filter(
          (record) =>
            isTaskListSessionType(record.taskType) && record.workspace.workspaceKey === workspaceId,
        )
        .map((record) => record.app.sessionId),
      ...[...preparedWorktreeMap(context).values()]
        .filter((prepared) => prepared.workspace.workspaceKey === workspaceId)
        .map((prepared) => String(prepared.sessionId)),
    ],
    // Draft check: deferred means no first input has been sent (the first prompt turn promotes it to immediate).
    // Deferred sessions pre-created by the old workspace prepare must not appear as "new tasks" in the sidebar.
    isDraftSession: (sessionId) =>
      context.sessions.get(sessionId)?.persistence === "deferred" &&
      !preparedWorktreeMap(context).has(sessionId),
    // ── workspace-config hook (seed configuration-directory subscription; live-session fast path, no temporary App) ──
    getWorkspaceConfig: (workspaceId) => buildLiveWorkspaceConfigStateV4(context, workspaceId),
    getStoredSessionSummaries: loadStoredSessionSummaries,
    refreshLegacySessionSummaries: (workspaceId, legacyTaskIds) =>
      parseRemoteWorkspaceIdentity(workspaceId)
        ? loadStoredSessionSummaries(workspaceId, legacyTaskIds)
        : null,
    // The fallback surface is gone (all 20 commands are native): an unmatched supports check
    // (unknown command type) maps to notImplemented → ACK failed fault.command.notImplemented.
    executeCommand: (envelope, admission) =>
      nativeExecutor.supports(envelope.type)
        ? nativeExecutor.execute(envelope, admission)
        : Promise.reject(new V4CommandNotImplementedError(envelope.type)),
    admitCommandInput: async (envelope, admission) => {
      // Hiding only the composer does not stop an old child tab from continuing. Type admission
      // must happen before writing the ledger / input history; if a detached child has no record,
      // read metadata only and do not activate a second runtime.
      if (
        envelope.sessionId &&
        (isConversationInputAdmissionCommand(envelope.type) ||
          envelope.type === "resumeGoal" ||
          envelope.type === "sendQueuedNow" ||
          envelope.type === "forkAssistant" ||
          envelope.type === "createSelectionSideSession")
      ) {
        const taskType =
          context.sessions.get(envelope.sessionId)?.taskType ??
          (await context.deps.sessionStore?.getSession(envelope.sessionId as SessionId))?.taskType;
        if (taskType === "subagent_child") {
          throw Object.assign(new Error("Subagent sessions are read-only"), {
            reasonCode: "guard.subagentReadOnly",
          });
        }
      }
      if (!isConversationInputAdmissionCommand(envelope.type)) return null;
      if (!envelope.sessionId) return null;
      return (await coreHost.admitInputCommand?.(envelope, envelope.sessionId, admission)) ?? null;
    },
    cancelCommandInput: async (envelope, queueItemId, reason) => {
      if (!envelope.sessionId) return;
      await coreHost.cancelInputCommand?.(envelope.sessionId, queueItemId, reason);
    },
    terminateTurnForProjectionFault: (sessionId, reasonCode) => {
      const record = context.sessions.get(sessionId);
      const controller = record?.activeAbortController;
      if (!controller || controller.signal.aborted) return;
      // Once the projection exceeds 16 MiB, further output would make every later snapshot
      // unencodable. The gateway atomically rejects the oversized event and records a protocol fault
      // before calling this once to abort the model turn. The normal abort terminal state releases
      // the active lock; do not fabricate a TurnError across layers in the gateway.
      controller.abort(createExternalTurnFaultError(reasonCode));
    },
    // Persistent commands/query fallback: lazily build an index on the first query per session;
    // the four later sources share it. anchor/marker/child/discarded writes update the index incrementally.
    lookupTranscriptCommand: (key) =>
      key.sessionId === null
        ? lookupGlobalCreateSessionCommand(context.deps.sessionStore, key.commandId)
        : persistentCommands.lookup("transcript", key),
    lookupTimelineCommand: (key) => persistentCommands.lookup("timeline", key),
    lookupChildCommand: (key) => persistentCommands.lookup("child", key),
    lookupDiscardedCommand: (key) => persistentCommands.lookup("discarded", key),
    invalidatePersistentCommandFacts: (sessionId) => persistentCommands.invalidate(sessionId),
    // The gateway has checked aggregate size and checksum per chunk; atomically write only complete bytes to the artifact store.
    putSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.writePromptAttachment(input);
    },
    readBackgroundBashOutput: (sessionId, workId) =>
      readBackgroundBashOutputFromOwner(context, sessionId, workId),
    readSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.readPromptAttachment(input);
    },
    statSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.statPromptAttachment) {
        throw new Error("fault.attachment.statUnsupported");
      }
      return record.app.statPromptAttachment(input);
    },
    resolveSessionAttachmentPreviewSource: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.resolvePromptAttachmentPreviewSource(input);
    },
    getConversationFileChanges: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        throw new Error(`fault.fileChanges.sessionNotFound: ${sessionId}`);
      }
      return readConversationFileChanges(record, sessionId, messageIds, targetTurnId);
    },
    // DWF event log: capability lives on the App and exists only if run-service construction
    // succeeded. Do not substitute an empty page when absent; the gateway returns a structured
    // unsupported-capability error so the renderer can distinguish "no events" from "no capability."
    listDynamicWorkflowRunEvents: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunEvents.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunEvents) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", sessionId);
      }
      // Call through the App (do not destructure; the implementation may depend on `this`).
      return record.app.listDynamicWorkflowRunEvents(input);
    },
    // Workflow-run enumeration: same capability condition (available only after run-service construction).
    listDynamicWorkflowRuns: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRuns.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRuns) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", sessionId);
      }
      // Call through the App (do not destructure; the implementation may depend on `this`).
      return record.app.listDynamicWorkflowRuns(input);
    },
    // Three read surfaces for user-facing DWF artifacts: same capability condition as above.
    // ⚠ Terminology: artifact is output published for users through `artifact.*`, not the run's top-level return value.
    listDynamicWorkflowRunArtifacts: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifacts.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifacts) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifacts(input);
    },
    listDynamicWorkflowRunArtifactItems: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactData.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifactItems) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifactItems", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifactItems(input);
    },
    readDynamicWorkflowRunArtifact: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactRead.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunArtifact) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", sessionId);
      }
      return record.app.readDynamicWorkflowRunArtifact(input);
    },
    // Two read surfaces for the DWF workspace transcript: same capability condition as above.
    listDynamicWorkflowRunWorkspaceNodes: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunWorkspace.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunWorkspaceNodes) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunWorkspaceNodes", sessionId);
      }
      return record.app.listDynamicWorkflowRunWorkspaceNodes(input);
    },
    readDynamicWorkflowRunNodeResult: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunNodeResult.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunNodeResult) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", sessionId);
      }
      return record.app.readDynamicWorkflowRunNodeResult(input);
    },
    previewConversationFileRewind: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.fileRewindPreview.sessionNotFound: ${sessionId}`);
      }
      return previewConversationFileRewind(record, messageIds, targetTurnId);
    },
    // Cold subscriptions no longer XOR eventStore and transcript. message/part is authoritative
    // for completed content; session_entry adds only legacy goals, and memory events add only
    // unpersisted in-flight and ephemeral queue/permission/control state.
    loadPersistedEvents: async (sessionId, persistedMessages) => {
      // Detached live children such as DWF workflow actors / subagents have no bootstrap record of
      // their own (events route through the parent record's sink via ingestDetachedLiveSession).
      // If context.sessions.get cannot find a record, do not return synthesized:false immediately:
      // on first subscription, performHydration would take its "keep healthy live publisher" early
      // return and never run the durable three-source transcript merge. A projection fed only by
      // live events would then lose durable content that does not appear as live events. amend-resume
      // seeds actor sessions by copying the predecessor transcript prefix directly into session
      // storage; that prefix is exactly this kind of content, so the sidebar actor transcript would
      // contain only this run's live delta. Ordinary crash recovery would also miss actor messages
      // from before the crash in the warm window.
      // Use resolveConversationBackingRecord instead: when a child has no record, follow persisted
      // parentID to the parent record and borrow only its shared event/artifact store. Still read
      // events with the child's own sessionId (script-workflow child runtimes share the parent event
      // store, with events keyed by child sessionId), so sourceEventSeq remains the child's true
      // cursor. Cost: the contextWindow denominator is resolved from the parent's current model
      // instead of the actor model, a display-only discrepancy.
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        // Diagnostic: hydration is expected after cold-resume activates the runtime. If even the
        // parent-record fallback fails, returning no events would disguise a lifecycle race as
        // "empty history," so record the concrete failure.
        context.logger?.warn("ZCode Protocol v4 hydrate has no active runtime", {
          activeSessionCount: context.sessions.size,
          event: "zcode_protocol.v4.hydrate_runtime_missing",
          module: "bootstrap.zcode_protocol",
          phase: "loadPersistedEvents",
          sessionId,
        });
        return { events: [], synthesized: false, sourceEventSeq: 0 };
      }
      // The live sink can receive events while message/part and session_entry reads are pending.
      // The gateway needs the raw cursor from the memory eventStore snapshot so it can append only
      // the tail received during the await window and map transcript's synthetic 1..N sequence
      // consistently to subsequent runtime raw sequences. The in-memory event store evicts transient
      // events from completed turns, so max(events.seq) may be below the real cursor and cause an
      // evicted delta to be replayed as the await-window tail. With no await between these two
      // calls, both values come from the same consistent snapshot.
      const [liveEvents, sourceEventSeq] = await Promise.all([
        record.eventStore.getEvents(sessionId as SessionId),
        record.eventStore.getLatestSequenceNumber(sessionId as SessionId),
      ]);
      // Cold replay for workflow runs: prepend journal-replayed progress events to memory events.
      // cold merge classifies this type as memory-only authoritative (preserving order in
      // supplements), and projection reduces it with the same reducer, keeping `workflowRuns`
      // consistent across restart.
      const replayed = await replayDynamicWorkflowRunEvents(context, sessionId, record, liveEvents);
      const events = replayed.length === 0 ? liveEvents : [...replayed, ...liveEvents];
      const store = context.deps.sessionStore;
      const source = await loadPersistedConversationMaterialization({
        memoryEvents: events,
        persistedMessages,
        sessionId,
        ...(store
          ? {
              store: {
                getSession: (id) => store.getSession(id),
                messages: (input) => store.messages(input),
                readTarget: (input) => store.readTarget(input),
                ...(store.sessionEntries
                  ? {
                      sessionEntries: (input) =>
                        store.sessionEntries!(input).catch((error) => {
                          context.logger?.warn("v4 hydrate session entries read failed", {
                            error: error instanceof Error ? error.message : String(error),
                            event: "zcode_protocol.v4.hydrate_session_entries_failed",
                            module: "bootstrap.zcode_protocol",
                          });
                          return [];
                        }),
                    }
                  : {}),
              },
            }
          : {}),
      });
      // live ModelComplete.fileChanges exists only in memory events. When cold merge treats the
      // durable transcript as authoritative content, it removes that event, but the transcript
      // itself has no file-summary field. Workspace checkpoint + artifact are the cross-process
      // durable facts; rebuild summaries by user messageId here, then let transcript hydration
      // synthesize a matching ModelComplete.
      const fileChangeSummariesByMessageId = await buildColdFileChangeSummaries({
        events: source.memoryEvents,
        messageIds: source.messages.map((message) => String(message.info.id)),
        readArtifact: async (snapshotRef) =>
          (await record.app.readToolResultArtifact(snapshotRef)).content,
        onArtifactError: (messageId, error) =>
          context.logger?.warn("v4 cold file change artifact read failed", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.hydrate_file_changes_failed",
            messageId,
            module: "bootstrap.zcode_protocol",
            sessionId,
          }),
      });
      // Cold-recovery transcripts do not store model capability, and the old hydration filled in
      // 200,000 itself. The provider registry is synchronized before resume, so use the exact
      // current model value after recovery / fallback.
      const contextWindow = resolveSessionModelContextWindow(context, record);
      const usageSeed = sessionUsageSeedFromRuntimeContextUsage(
        await readSessionContextUsage(context, sessionId, source.messages),
        contextWindow,
      );
      const merged = mergeColdConversationEvents({
        contextWindow,
        fileChangeSummariesByMessageId,
        memoryEvents: source.memoryEvents,
        messages: source.messages,
        sessionId,
        goalVerificationEntries: source.goalVerificationEntries,
        ...(Object.prototype.hasOwnProperty.call(source, "target")
          ? { target: source.target }
          : {}),
      });
      for (const diagnostic of merged.diagnostics) {
        const fields = {
          ...diagnostic,
          event: "zcode_protocol.v4.hydrate_three_source_merge",
          module: "bootstrap.zcode_protocol",
          sessionId,
        };
        if (
          diagnostic.code === "cold_merge.ambiguous_legacy_turn_preserved" ||
          diagnostic.code === "cold_merge.memory_boundary_preserved" ||
          diagnostic.code === "cold_merge.unclassified_event_preserved"
        ) {
          context.logger?.warn("v4 hydrate preserved ambiguous cold fact", fields);
        } else {
          log?.debug("v4 hydrate merged duplicate cold facts", fields);
        }
      }
      // A transcript can restore an Agent row but cannot prove the child session was persisted.
      // Create the validation seed here before the gateway restores its raw-event buffer: this
      // excludes stale ghost references and prevents an async query from overwriting live spawn/stop
      // events that arrive after seeding.
      const subagents = await listSessionSubagents(
        context,
        { sessionId, endedLimit: 1 },
        persistedMessages,
      );
      return {
        events: merged.events,
        // Reuse the result of this query for synthetic events; do not reread a different capacity during later hydration.
        usageSeed,
        // The gateway's legacy field is still named synthesized; here it means the projection was
        // rematerialized from the durable transcript, replacing the cold publisher created earlier by ingest.
        synthesized: merged.usedDurableTranscript,
        subagentsSeed: {
          revision: subagents.revision,
          childSessionIds: subagents.childSessionIds,
          running: subagents.running,
        },
        ...(source.sharedContextImport ? { sharedContextImport: source.sharedContextImport } : {}),
        sourceEventSeq,
      };
    },
    onError: (scope, error, errorContext) =>
      context.logger?.warn("ZCode Protocol v4 gateway error", {
        ...errorContext,
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.gateway_error",
        module: "bootstrap.zcode_protocol",
        scope,
      }),
  });
}
