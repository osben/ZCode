// Session management command group: createSession / renameSession / deleteSession.
// One file per command group: the handler is a pure function (host, envelope) -> CommandResult|undefined.
// Decision logic directly invokes core; environment capabilities use Host hooks (see the migration notes in ../types.ts).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadata } from "../input-intent.js";
import { commandAdmissionOf } from "../executor.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { applyRequestedSessionConfig } from "./model-config.js";
import {
  hasPromptInput,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "../input-admission.js";

/**
 * createSession: native implementation of the final fallback path.
 * Semantic decisions owned by the native layer:
 * - Draft semantics: every new session is deferred (not written to sqlite); prompt-turn promotes it
 *   to immediate on the first send. The record creation hook always passes deferred; promotion does not happen there.
 * - firstInput is optional: when provided, submit it through the native prompt turn (the same write
 *   path as sendText, which provides draft promotion, immediate submission ACK, and the ready boundary),
 *   bypassing the legacy sendPrompt op.
 * - workspaceId: for a local workspace, use workspacePath (the local fallback required by Workspace
 *   Identity); the host.createSessionRecord hook resolves remote identities (remote:ssh/wsl/docker:...)
 *   through @zcode/shared parseRemoteWorkspaceIdentity (for split panes across workspaces).
 * Execution responsibilities still tied to the legacy host use the migration hook host.createSessionRecord
 *   (record creation, event wiring, catalog sync, and failure cleanup; see ../types.ts).
 */
async function createSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["createSession"];
  if (!host.createSessionRecord) {
    throw new Error("v4 createSession requires host.createSessionRecord capability");
  }
  // Reject a completely empty firstInput before creating the record, so a failed request does not leave an invalid deferred session.
  if (
    payload.firstInput &&
    !hasPromptInput(payload.firstInput.text, payload.firstInput.attachments)
  ) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  const { sessionId } = await host.createSessionRecord({
    workspaceId: payload.workspaceId,
    ...(payload.permissionScope ? { permissionScope: payload.permissionScope } : {}),
    mcpServers: payload.mcpServers,
    offPeakToolEnabled: payload.offPeakToolEnabled,
    dynamicWorkflowEnabled: payload.dynamicWorkflowEnabled,
    dynamicWorkflowMode: payload.dynamicWorkflowMode,
  });
  // Consume createSession.config: apply and emit events for draft UI selections (model/reasoning
  // depth/mode) before the first send so the first turn uses the chosen config. This must precede
  // firstInput. Ordinary configs keep the existing warn downgrade; Guarded is an explicit
  // authorization choice and must not silently fall back to default-mode execution on failure.
  if (payload.config) {
    const record = requireRecord(host, sessionId);
    try {
      await applyRequestedSessionConfig(host, record, payload.config);
    } catch (error) {
      if (payload.config.mode === "guarded" || payload.firstInput?.mode === "guarded") {
        // Cause: the old catch swallowed the mode-application failure and still submitted the first turn, so Guarded silently degraded.
        try {
          await host.closeSession?.(sessionId);
        } catch (closeError) {
          host.logger?.warn?.("v4 guarded draft cleanup failed", { sessionId, closeError });
        }
        throw error;
      }
      host.logger?.warn?.("v4 createSession config apply failed; session keeps runtime defaults", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
    }
  }
  let firstInput:
    | {
        delivery: "startNow" | "queue" | "guide";
        inputId: string;
        messageId?: string;
      }
    | undefined;
  if (payload.firstInput) {
    // Attachment command surface: send firstInput.attachments (AttachmentRef -> TurnAttachment) with the first input.
    const record = requireRecord(host, sessionId);
    const admission = commandAdmissionOf(envelope);
    const durableAdmission =
      (await host.admitInputCommand?.(envelope, sessionId, admission)) ?? null;
    try {
      const attachments = await mapAttachmentRefsToTurnAttachments(
        record.app,
        payload.firstInput.attachments,
      );
      const intent = inputIntentMetadata(envelope, {
        text: payload.firstInput.text,
        requestedDelivery: "startNow",
        attachmentRefs: payload.firstInput.attachments,
        ...resolveSubmittedExecutionState(record, payload.firstInput),
      });
      const started = await startPromptTurn(host, record, {
        content: payload.firstInput.text,
        inputId: envelope.commandId,
        intent,
        ...(attachments ? { attachments } : {}),
      });
      firstInput = {
        delivery: started.admission.kind === "queued" ? "queue" : "startNow",
        inputId: envelope.commandId,
        ...(started.messageId ? { messageId: started.messageId } : {}),
      };
    } catch (error) {
      if (durableAdmission) {
        try {
          await host.cancelInputCommand?.(
            sessionId,
            admission.queueItemId,
            "fault.command.inputRejected",
          );
        } catch (cancelError) {
          // A cancellation-ledger failure must not replace the actual first-send failure. Otherwise the
          // client receives the wrong failure reason, while admission can still finalize as discarded during
          // restart reconciliation and will not be misclassified as successful.
          host.logger?.warn?.("v4 createSession first input cancellation failed", {
            cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
            inputError: error instanceof Error ? error.message : String(error),
            queueItemId: admission.queueItemId,
            sessionId,
          });
        }
      }
      throw error;
    }
  }
  return { type: "createSession", sessionId, ...(firstInput ? { input: firstInput } : {}) };
}

/**
 * renameSession: explicit user rename -> core runtime.setCustomSessionTitle.
 * - Core enforces the sticky titleSource=custom behavior (later automatic title generation skips
 *   custom_title; see core/src/runtime/methods/session-title.ts); the handler does not duplicate it.
 * - Pass through the session root traceContext (a narrow record-view field): the rename belongs to
 *   that session's task chain and does not start a new trace (observability discipline).
 * - No legacy broadcast: core emits SessionTitleUpdated, the gateway updates the projection, and v4
 *   consumers observe the title change there.
 */
async function renameSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["renameSession"];
  const record = requireRecord(host, envelope.sessionId);
  // Call this method through runtime (do not destructure it): the implementation relies on `this` binding; see methods/index.ts.
  await record.app.runtime.setCustomSessionTitle({
    title: payload.title,
    traceContext: record.traceContext,
  });
  return undefined;
}

/**
 * deleteSession semantics = closeSession (close and clean up runtime resources), not delete the
 * record: the message store has no delete API, matching the legacy protocol path (legacy "delete" also
 * only closes; history remains in the database but disappears from the active registry).
 * The host still owns the session registry, so actual closure uses the migration hook host.closeSession
 * (the v4 layer will own the registry; see ../types.ts).
 */
async function deleteSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.closeSession) {
    // Do not silently degrade closure: a missing hook means the binder wiring is incomplete, so fail directly (ACK failed).
    throw new Error("v4 deleteSession requires host.closeSession capability");
  }
  await host.closeSession(record.app.sessionId);
  return undefined;
}

async function discardSharedContext(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["discardSharedContext"];
  const sessionId = envelope.sessionId;
  if (!sessionId || !host.discardSharedContext) {
    throw new Error("v4 discardSharedContext requires a session-scoped storage capability");
  }
  const updated = await host.discardSharedContext(sessionId, payload.contextId);
  if (!updated)
    throw new V4InputAdmissionRejectedError(
      "fault.command.inputRejected",
      "shared context is not pending",
    );
  return undefined;
}

export const sessionMgmtHandlers = {
  createSession,
  renameSession,
  deleteSession,
  discardSharedContext,
};
