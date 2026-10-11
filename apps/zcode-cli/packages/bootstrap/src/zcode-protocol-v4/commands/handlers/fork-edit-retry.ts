// fork/edit/retry command group: forkAssistant / editUserQuery / retryTurn.
// All three locate a historical entity by {rowId, entityId}, then use the host's v4 projection
// translation surface to map it to a transcript messageId. Translation is a native v4 decision: reject
// if it fails, and never silently fall back to latestCheckpoint, which could target the wrong item.
// - editUserQuery = retryTurn with replacement text: rewind truncates the turn, then the native prompt turn resends new text.
// - retryTurn = rewind truncates and resends the original user prompt (resolve its text before rewind, since truncation removes it).
// - forkAssistant = stable resolver + conversation-only copy; leave the running parent and workspace untouched.
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import {
  RewindStrategy,
  traceContextToLogContext,
  type MessageId,
  type TurnId,
} from "@zcode/contracts";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { V4PromptRejectedError } from "../prompt-turn.js";
import { commandAdmissionOf } from "../executor.js";
import { hasPromptInput, V4InputAdmissionRejectedError } from "../input-admission.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import { startCanonicalIntent, stableAttachmentRefs } from "./canonical-intent-replay.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";

const CONVERSATION_COMMAND_LOG_MODULE = "bootstrap.zcode_protocol_v4.commands";
const EDIT_USER_QUERY_COMPLETED_EVENT = "conversation.command.edit_user_query.completed";
const FORK_ASSISTANT_COMPLETED_EVENT = "conversation.command.fork_assistant.completed";

/** Row target to messageId translation failed (non-assistant row / stale entity / session has no projection). */
export class V4RowTranslationError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(command: string, targetRowId: number) {
    super(`${command} targetRowId ${targetRowId} 无法解析到 transcript messageId`);
    this.name = "V4RowTranslationError";
  }
}

/** Reject when the fork target is not the final assistantText segment of its turn. */
export class V4ForkTargetNotLatestSegmentError extends Error {
  readonly reasonCode = "fault.command.executionFailed";

  constructor(targetRowId: number) {
    super(
      `forkAssistant targetRowId ${targetRowId} 不是所属轮的最后一段 assistant（fork 只挂轮尾段）`,
    );
    this.name = "V4ForkTargetNotLatestSegmentError";
  }
}

export class V4ForkTargetGuardError extends Error {
  constructor(
    readonly reasonCode: string,
    targetRowId: number,
  ) {
    super(`forkAssistant targetRowId ${targetRowId} 被稳定目标解析器拒绝: ${reasonCode}`);
    this.name = "V4ForkTargetGuardError";
  }
}

/** latestQueryEditOnly: reject stale rows, non-realUser rows, or missing projections without stopping the current turn. */
export class V4EditTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestQueryEditOnly";

  constructor(targetRowId: number) {
    super(`editUserQuery targetRowId ${targetRowId} 不是最后一轮 real user query`);
    this.name = "V4EditTargetNotLatestError";
  }
}

/** latestAssistantRetryOnly: retrying an older assistant reply would rewind the active branch, so reject it. */
export class V4RetryTargetNotLatestError extends Error {
  readonly reasonCode = "guard.latestAssistantRetryOnly";

  constructor(targetRowId: number) {
    super(`retryTurn targetRowId ${targetRowId} 不是最后一轮 assistant 回复`);
    this.name = "V4RetryTargetNotLatestError";
  }
}

/**
 * Rewind truncation (direct Core call): edit/retry no longer synthesize a `/rewind` slash turn;
 * they submit a same-session active branch cut directly. With workspaceMode=rewind, this
 * primitive is called at the same commit gate after all file writes succeed.
 *
 * Previously, combined rewind called app.submitPrompt inside a file transaction callback,
 * which queued `/rewind` again in the runtime command queue. The current edit command waited
 * for the callback while the nested rewind waited for the current command to release the queue,
 * leaving the UI stuck in edit mode.
 * On completion, emit the legacy session_rewound event (a transition hook for old sidebar
 * consumers; the v4 projection closes through RewindTriggered and does not depend on this event).
 */
async function submitConversationRewind(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  anchorMessageId: string,
): Promise<void> {
  const result = await record.app.runtime.rewindConversationToMessage({
    events: [],
    targetMessageId: anchorMessageId as MessageId,
    traceContext: record.traceContext,
  });
  if (result.strategy !== RewindStrategy.ActiveChain) {
    throw new Error(`conversation rewind unavailable for ${anchorMessageId}: ${result.strategy}`);
  }
  await host.afterLegacyStateMutation?.(record, "session_rewound");
}

/**
 * editUserQuery: target a user entity, use its canonical transcript messageId as the rewind
 * anchor, truncate the full turn, then resend newText through the native prompt turn.
 * Attachment command surface: submit attachments (AttachmentRef → TurnAttachment) with the resend.
 */
async function editUserQuery(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editUserQuery"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "editUserQuery",
  );
  if (!resolution?.ok || !resolution.editTarget) {
    throw new V4EditTargetNotLatestError(payload.target.rowId);
  }
  const editTarget = resolution.editTarget;
  const attachmentRefs = payload.attachments ?? stableAttachmentRefs(editTarget);
  // Omitted attachments and [] have different meanings. Validate the effective refs so
  // attachment-only edits remain allowed, while an empty body and attachment list are rejected before rewind.
  if (
    !hasPromptInput(payload.newText, attachmentRefs) &&
    !(payload.conversationQuotes ?? editTarget.intent.conversationQuotes)?.length
  ) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  // Map attachments before rewind so invalid references are reported before truncating history.
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  const runtimeHasActiveTurn =
    record.app.runtime?.getActiveTurnInfo?.() !== undefined ||
    record.app.runtime?.getActiveForegroundExecutionId?.() !== undefined;
  if (record.activeAbortController || runtimeHasActiveTurn) {
    // Bug root cause: when a Highspeed/notification turn is held by the Core runtime there is no Bootstrap
    // activeAbortController; checking only the latter lets rewind race with the old model request, after which
    // the new prompt is rejected with turn_not_steerable. Runtime-owned active turns must also join the preempt barrier.
    await preemptActiveTurnAndWait(host, record, {
      abortMessage: "v4 editUserQuery preempts active turn",
      goalPausedMutationReason: "edit_user_query_goal_paused",
    });
  }
  let conversationRewindCommitted = false;
  if ((payload.workspaceMode ?? "preserve") === "rewind") {
    const turnMessageIds = resolution.messageIds ??
      host.getMessageIdsForTurnRow?.(record.app.sessionId, resolution.row.rowId) ?? [
        editTarget.transcriptMessageId,
      ];
    const fileOptions = {
      targetMessageIds: turnMessageIds as MessageId[],
      targetTurnId: resolution.row.turnId as TurnId,
      traceContext: record.traceContext,
    };
    const preview = await record.app.runtime.previewWorkspaceFileRewind(fileOptions);
    // Shell/ignored changes cannot guarantee a complete rollback. Fail closed in combined mode
    // and return the latest preview to the UI unchanged.
    if (!preview.canApply || preview.ignoredFiles.length > 0 || preview.safeFiles.length === 0) {
      const reasonCode =
        preview.unsafeFiles.length > 0
          ? "guard.workspaceRewindUnsafeFiles"
          : preview.ignoredFiles.length > 0
            ? "guard.workspaceRewindIgnoredFiles"
            : preview.safeFiles.length === 0
              ? "guard.workspaceRewindUnavailable"
              : "guard.workspaceRewindApplyConflict";
      await host.cancelInputCommand?.(
        record.app.sessionId,
        commandAdmissionOf(envelope).queueItemId,
        reasonCode,
      );
      return {
        type: "editUserQuery",
        disposition: "blocked",
        sessionId: record.app.sessionId,
        reasonCode,
        preview,
      };
    }
    const applied = await record.app.runtime.applyWorkspaceFileRewind({
      ...fileOptions,
      commitAfterApply: async () => {
        await submitConversationRewind(host, record, editTarget.transcriptMessageId);
        conversationRewindCommitted = true;
      },
    });
    if (!applied.applied) {
      await host.cancelInputCommand?.(
        record.app.sessionId,
        commandAdmissionOf(envelope).queueItemId,
        "guard.workspaceRewindApplyConflict",
      );
      return {
        type: "editUserQuery",
        disposition: "blocked",
        sessionId: record.app.sessionId,
        reasonCode: "guard.workspaceRewindApplyConflict",
        preview: applied.preview,
      };
    }
  }
  if (!conversationRewindCommitted) {
    await submitConversationRewind(host, record, editTarget.transcriptMessageId);
  }
  // Edit-and-resend is treated as a new proactive send: only the card re-prepared this time counts
  // (this session's taskId, unexpired), and the Selection must genuinely point at the accelerated
  // Provider — never accelerate with stale credentials or a cross-session card.
  const highspeedEdit =
    editTarget.intent.kind === "sendText" &&
    payload.highspeedMeta !== undefined &&
    payload.highspeedMeta.taskId === record.app.sessionId &&
    payload.highspeedMeta.expiresAt > Date.now() &&
    payload.modelSelection !== undefined &&
    payload.modelExecution !== undefined &&
    isHighspeedProviderId(payload.modelSelection.providerId)
      ? {
          card: payload.highspeedMeta,
          modelSelection: payload.modelSelection,
          execution: payload.modelExecution,
        }
      : undefined;
  try {
    await startCanonicalIntent(
      host,
      record,
      envelope,
      editTarget,
      payload.newText,
      attachmentRefs,
      attachments,
      highspeedEdit,
    );
  } catch (error) {
    if (
      editTarget.intent.kind === "sendText" &&
      error instanceof V4PromptRejectedError &&
      error.reasonCode === "activePrompt"
    ) {
      // Bug root cause: after rewind has been committed, Core may still be settling the old turn; an admission
      // carrying accelerated-execution material cannot be steered and only returns turn_not_steerable. The new
      // text must be enqueued atomically then, otherwise the old message is already truncated and the new one
      // is lost along with the exception.
      host.logger?.warn?.("v4 editUserQuery admission recovered by queue", {
        reason: error.message,
        sessionId: record.app.sessionId,
        targetRowId: payload.target.rowId,
      });
      await startCanonicalIntent(
        host,
        record,
        envelope,
        editTarget,
        payload.newText,
        attachmentRefs,
        attachments,
        highspeedEdit,
        { requireQueue: true },
      );
    } else {
      throw error;
    }
  }
  // Bugfix: The production Renderer does not write logs, so edits could previously only be inferred
  // from generic rewind + send events and could not be reliably distinguished from retries.
  // After the command side effects complete, the Agent server writes a low-frequency info audit entry.
  host.logger?.info?.("v4 editUserQuery completed", {
    ...traceContextToLogContext(record.traceContext),
    attachmentCount: attachmentRefs?.length ?? 0,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: EDIT_USER_QUERY_COMPLETED_EVENT,
    intentKind: editTarget.intent.kind,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    sessionId: record.app.sessionId,
    status: "completed",
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
    workspaceMode: payload.workspaceMode ?? "preserve",
  });
  return {
    type: "editUserQuery",
    disposition: "rewind",
    sessionId: record.app.sessionId,
  };
}

/**
 * retryTurn: assistant target → messageId → rewind truncation + resend the
 * canonical user intent. Resolve the intent in the projection resolver, **before** rewind;
 * after truncation, do not reread visible text or infer the original input from the transcript parent.
 */
async function retryTurn(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["retryTurn"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "retryTurn",
  );
  if (!resolution?.ok || !resolution.messageId || !resolution.editTarget) {
    throw new V4RetryTargetNotLatestError(payload.target.rowId);
  }
  const attachmentRefs = stableAttachmentRefs(resolution.editTarget);
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, attachmentRefs);
  await submitConversationRewind(host, record, resolution.messageId);
  await startCanonicalIntent(
    host,
    record,
    envelope,
    resolution.editTarget,
    resolution.editTarget.intent.text,
    attachmentRefs,
    attachments,
  );
  return undefined;
}

/**
 * forkAssistant: the stable resolver fixes the logical-turn/message boundary, then performs a
 * conversation-only fork. This path does not read activeAbortController, stop the parent, or enter
 * legacy forkSession (which includes ensureNoActiveTurn + workspace rewind).
 */
async function forkAssistant(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["forkAssistant"];
  const record = requireRecord(host, envelope.sessionId);
  const targetResolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "forkAssistant",
  );
  if (!targetResolution?.ok) {
    throw new V4ForkTargetGuardError("guard.forkTargetNotStable", payload.target.rowId);
  }
  if (!host.resolveStableForkTarget) {
    throw new Error("v4 forkAssistant requires host.resolveStableForkTarget capability");
  }
  const resolution = await host.resolveStableForkTarget(record.app.sessionId, payload.target.rowId);
  if (!resolution.ok) {
    throw new V4ForkTargetGuardError(resolution.reasonCode, payload.target.rowId);
  }
  if (!host.forkStableConversation) {
    throw new Error("v4 forkAssistant requires host.forkStableConversation capability");
  }
  const { forkedSessionId } = await host.forkStableConversation(record.app.sessionId, {
    target: resolution.target,
    goalBoundary: resolution.goalBoundary,
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
  });
  // Fork completion was previously recorded only in session events/debug and could not be searched
  // directly in the default production JSONL. Write info only after the child is created and
  // registered with the host, so rejected or failed requests are not recorded as successful.
  host.logger?.info?.("v4 forkAssistant completed", {
    ...traceContextToLogContext(record.traceContext),
    childSessionId: forkedSessionId,
    clientId: envelope.clientId,
    commandId: envelope.commandId,
    event: FORK_ASSISTANT_COMPLETED_EVENT,
    module: CONVERSATION_COMMAND_LOG_MODULE,
    parentSessionId: record.app.sessionId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    sessionId: record.app.sessionId,
    status: "completed",
    targetBoundaryMessageId: resolution.target.boundaryMessageId,
    targetEntityId: payload.target.entityId,
    targetRowId: payload.target.rowId,
  });
  const result = { type: "forkAssistant" as const, sessionId: forkedSessionId };
  return result;
}

export const forkEditRetryHandlers = {
  forkAssistant,
  editUserQuery,
  retryTurn,
};
