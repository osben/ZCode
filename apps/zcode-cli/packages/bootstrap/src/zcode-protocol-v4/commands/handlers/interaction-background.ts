import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
// Permission/background command group: resolveInteraction / cancelBackgroundWork.
// - resolveInteraction: closes the loop on reverse requests (permission/AskUserQuestion) with a
//   forward command, delivered through host.interactions (V4InteractionRegistry) to the waiting broker-side deferred.
// - cancelBackgroundWork: directly invokes core's optional cancelBackgroundTask capability (workId ≡ taskId).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
  SavedWorkflowStartRejectionReason,
  WorkflowRunSettingsRejectionReason,
} from "@zcode/shared/zcode-protocol-v4";
import {
  BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX,
  SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

/**
 * Capability-not-supported error, thrown when the session runtime does not implement an optional
 * capability (matching the ProtocolRequestError -32031 semantics of legacy server-operations.ts
 * cancelBackgroundTask). The v4 side no longer uses JSON-RPC error codes; it uses a structured Error
 * with reasonCode (fault namespace), which the gateway uses to finalize the ACK.
 */
export class V4CapabilityUnsupportedError extends Error {
  readonly reasonCode = "fault.command.capabilityUnsupported";

  constructor(capability: string, sessionId: string) {
    super(`capability not supported by this session runtime: ${capability} (session ${sessionId})`);
    this.name = "V4CapabilityUnsupportedError";
  }
}

/**
 * resolveInteraction: deliver an answer to a pending reverse request (the interaction-broker race deferred).
 *
 * Preserve these semantics (confirmed by investigation):
 * - A miss (delivered === false because the interaction was answered, unregistered, or has an
 *   unknown id) completes as an idempotent success without throwing. Multiple clients race;
 *   a late answer is harmless, and reporting failure would mislead the client.
 * - Do not call requireRecord: a late answer may arrive after the session is closed or deleted
 *   and must remain harmless. The registry is addressed globally by interactionId and does not
 *   depend on a record existing.
 */
async function resolveInteraction(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resolveInteraction"];
  const delivered =
    payload.answer.optionId === PERMISSION_FULL_ACCESS_OPTION_ID
      ? ((await host.interactions?.resolveFullAccess(payload.interactionId, envelope.sessionId!)) ??
        false)
      : (host.interactions?.resolve(payload.interactionId, payload.answer) ?? false);
  if (!delivered) {
    host.logger?.info?.("v4 resolveInteraction no pending interaction (idempotent)", {
      event: "zcode_protocol.v4.interaction_already_resolved",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

async function snoozeInteractionAutoResolution(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["snoozeInteractionAutoResolution"];
  const snoozed = (await host.interactions?.snoozeAutoResolution(payload.interactionId)) ?? false;
  if (!snoozed) {
    host.logger?.info?.("v4 snoozeInteractionAutoResolution no active countdown (idempotent)", {
      event: "zcode_protocol.v4.interaction_auto_resolution_already_snoozed",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

class V4WorkspaceHookReviewRejectedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Workspace Hook review command rejected: ${reasonCode}`);
    this.name = "V4WorkspaceHookReviewRejectedError";
  }
}

async function respondWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["respondWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.respondWorkspaceHookReview(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function toggleWorkspaceHookReviewItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["toggleWorkspaceHookReviewItem"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.toggleWorkspaceHookReviewItem(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function revokeWorkspaceHookTrust(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["revokeWorkspaceHookTrust"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.revokeWorkspaceHookTrust(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

/**
 * Soft gate: open a review flow on demand.
 *
 * Called when the user clicks "Review." It goes through controller.requestReview →
 * openOrReuseFlow + superviseFlow. Reuse an existing active flow idempotently. Safely no-op
 * when there are no pending items.
 */
async function requestWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["requestWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.requestWorkspaceHookReview({
    workspaceIdentity: payload.workspaceIdentity,
    bundleDigest: payload.bundleDigest,
  });
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

function requireWorkspaceHookReviewRecord(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
  payloadSessionId: string,
) {
  if (envelope.sessionId !== payloadSessionId) {
    throw new V4WorkspaceHookReviewRejectedError("workspace_hooks_snapshot_mismatch");
  }
  return requireRecord(host, envelope.sessionId);
}

/**
 * Business rejection for cancelBackgroundWork: Core explicitly reports that nothing was
 * cancelled (a reason is present).
 *
 * If cold replay incorrectly leaves an old run as running, Cancel remains clickable on the detail
 * page, but Core finds no such task (`background_task_not_found`). The old handler discarded the
 * structured result and returned accepted, making the click appear to do nothing. Core's reason
 * is authoritative; this handler only maps its prefix.
 */
class V4BackgroundWorkCancelRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, workId: string) {
    super(`background work ${workId} was not cancelled: ${reason}`);
    this.name = "V4BackgroundWorkCancelRejectedError";
    this.reasonCode = `${BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX}${reason.replace(/^background_task_/, "")}`;
  }
}

/**
 * cancelBackgroundWork: pass workId (equivalent to the legacy taskId) directly to Core.
 * - cancelBackgroundTask is an optional ZCodeApp capability; if absent, throw the unsupported
 *   capability error described above.
 * - If Core returns a `reason` (not found, already terminal, or unsupported type), ACK with the
 *   `fault.command.backgroundWorkCancelRejected.<reason>` reasonCode. Return accepted only when
 *   cancellation succeeded or the result is absent (stub host).
 * - No legacy broadcast is needed: Core emits the BackgroundTask* (Started/Updated/Completed)
 *   lifecycle events directly, and the v4 projection (product-projection backgroundWorks) closes
 *   itself. Unlike the old op's afterStateMutation("background_task_cancelled"), v4 has no such duty.
 */
async function cancelBackgroundWork(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["cancelBackgroundWork"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.cancelBackgroundTask) {
    throw new V4CapabilityUnsupportedError("cancelBackgroundTask", record.app.sessionId);
  }
  // Call the method through app; do not destructure it because the implementation may depend on this binding.
  const result = await record.app.cancelBackgroundTask(payload.workId);
  if (result?.reason !== undefined) {
    throw new V4BackgroundWorkCancelRejectedError(result.reason, payload.workId);
  }
  return undefined;
}

/**
 * resumeWorkflowRun: pass workId (equivalent to runId) directly to the app capability.
 * - If the capability is absent (journal unavailable or no resume port), throw the unsupported
 *   capability error (same semantics as cancel).
 * - Business rejections (not_found / not_resumable / already_running / script_missing /
 *   script_mismatch / compile_failed) ACK with `fault.command.workflowRunResumeRejected.<reason>`.
 *   The gateway forwards domain errors with reasonCode unchanged, and the UI routes by code rather
 *   than error text. Bounded compile_failed diagnostics are copied from `error.message` into
 *   `ack.message` (the same convention as startSavedWorkflow).
 */
class V4WorkflowRunResumeRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, message?: string) {
    super(message ?? `workflow run resume rejected: ${reason}`);
    this.name = "V4WorkflowRunResumeRejectedError";
    this.reasonCode = `${WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function resumeWorkflowRun(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resumeWorkflowRun"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.resumeWorkflowRun) {
    throw new V4CapabilityUnsupportedError("resumeWorkflowRun", record.app.sessionId);
  }
  // Call the method through app; do not destructure it because the implementation may depend on this binding.
  const result = await record.app.resumeWorkflowRun({
    workId: payload.workId,
    ...(payload.name === undefined ? {} : { name: payload.name }),
  });
  if (!result.ok) throw new V4WorkflowRunResumeRejectedError(result.reason, result.message);
  return undefined;
}

/**
 * startSavedWorkflow: start a saved workflow directly from the hub.
 * - If the capability is absent (no DWF port or a stub host), throw the unsupported-capability
 *   error (same semantics as resume). The GUI displays "This agent does not support direct start"
 *   as-is and cleans up the empty session.
 * - Business rejections (invalid_name / not_found / invalid_args / compile_failed / session_busy /
 *   start_failed) ACK with `fault.command.savedWorkflowStartRejected.<reason>`. `message` carries
 *   a bounded, human-readable diagnostic (including merged compile diagnostics) for inline display
 *   in the arguments dialog. The gateway forwards domain errors with reasonCode unchanged and copies
 *   `error.message` to `ack.message`; the UI routes by code rather than using error text for control flow.
 * - Success returns `{ type: "startSavedWorkflow", runId, toolCallId }` in ACK.result (linking the tool card to the detail page).
 * Note: this is a non-input command (not queued and has no baseRevision), grouped with resume/cancel in interaction-background.
 */
class V4SavedWorkflowStartRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: SavedWorkflowStartRejectionReason, message?: string) {
    // message is copied directly to ack.message (gateway convention: error.message is folded into ACK); use a readable fallback when absent.
    super(message ?? `saved workflow start rejected: ${reason}`);
    this.name = "V4SavedWorkflowStartRejectedError";
    this.reasonCode = `${SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function startSavedWorkflow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["startSavedWorkflow"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.startSavedWorkflow) {
    throw new V4CapabilityUnsupportedError("startSavedWorkflow", record.app.sessionId);
  }
  // Call the method through app; do not destructure it because the implementation may depend on this binding.
  const result = await record.app.startSavedWorkflow({
    name: payload.name,
    ...(payload.scope === undefined ? {} : { scope: payload.scope }),
    ...(payload.args === undefined ? {} : { args: payload.args }),
  });
  if (!result.ok) throw new V4SavedWorkflowStartRejectedError(result.reason, result.message);
  return { type: "startSavedWorkflow", runId: result.runId, toolCallId: result.toolCallId };
}

/**
 * amendWorkflowRunSettings: configure a run from its card/detail page. workId is runId; pass the
 * three-state values of both settings through to the runtime unchanged.
 * - If the capability is absent (no DWF port or no amend/getScript on the port), throw the
 *   unsupported-capability error and show "Unsupported" in the dialog.
 * - Business rejections ACK with `fault.command.workflowRunSettingsRejected.<reason>`; `message`
 *   carries diagnostics (compile, model resolution, or startup failure). The existing run keeps running.
 * - Success returns `{ type, runId, toolCallId, supersededRunId? }` in ACK.result. The detail page
 *   uses the new run's two linkage keys to switch the tab to that run.
 */
class V4WorkflowRunSettingsRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: WorkflowRunSettingsRejectionReason, message?: string) {
    super(message ?? `workflow run settings rejected: ${reason}`);
    this.name = "V4WorkflowRunSettingsRejectedError";
    this.reasonCode = `${WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function amendWorkflowRunSettings(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["amendWorkflowRunSettings"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.amendWorkflowRunSettings) {
    throw new V4CapabilityUnsupportedError("amendWorkflowRunSettings", record.app.sessionId);
  }
  // Call the method through app; do not destructure it because the implementation may depend on this binding.
  const result = await record.app.amendWorkflowRunSettings({
    runId: payload.workId,
    ...(payload.subagentModel === undefined ? {} : { subagentModel: payload.subagentModel }),
    ...(payload.maxConcurrency === undefined ? {} : { maxConcurrency: payload.maxConcurrency }),
  });
  if (!result.ok) throw new V4WorkflowRunSettingsRejectedError(result.reason, result.message);
  return {
    type: "amendWorkflowRunSettings",
    runId: result.runId,
    toolCallId: result.toolCallId,
    ...(result.supersededRunId === undefined ? {} : { supersededRunId: result.supersededRunId }),
  };
}

export const interactionBackgroundHandlers = {
  resolveInteraction,
  respondWorkspaceHookReview,
  toggleWorkspaceHookReviewItem,
  revokeWorkspaceHookTrust,
  requestWorkspaceHookReview,
  snoozeInteractionAutoResolution,
  cancelBackgroundWork,
  resumeWorkflowRun,
  startSavedWorkflow,
  amendWorkflowRunSettings,
};
