// ============================================================
// Structured explanations when Cancel / Resume is rejected on the detail page.
// ============================================================
// When an old run is incorrectly left in running state, Cancel finds no such task in the CLI,
// while Resume hits an old script that is no longer compiled — both commands only log a warning to the console, leaving users with “nothing happened.”
// Now look up the ACK reasonCode in two vocabularies and render a sentence below the status header; use generic copy with the code for anything outside those vocabularies.

import {
  BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX,
  type CommandAck,
} from "@zcode/shared/zcode-protocol-v4";

export type WorkflowRunAction = "cancel" | "resume";

/** Same unsupported-capability fault as useSavedWorkflowLauncher (the gateway reasonCode for V4CapabilityUnsupportedError). */
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";

/** Closed set of core stopBackgroundTask reasons with the `background_task_` prefix removed (created by the bootstrap handler). */
const CANCEL_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_running",
  "cancel_not_supported",
]);
/** Closed set for DynamicWorkflowRunResumeErrorReason from the port. */
const RESUME_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_resumable",
  "superseded",
  "already_running",
  "script_missing",
  "script_mismatch",
  "compile_failed",
]);

export interface WorkflowRunActionRejection {
  action: WorkflowRunAction;
  /** Reason in a vocabulary, or `unsupported` (capability unavailable) / `generic` (not in a vocabulary; copy includes code). */
  reason: string;
  /** Original reasonCode (or ack.status when absent), shown in generic copy and included in logs. */
  code: string;
  /** Human-readable detail carried by ACK (bounded diagnostics for compile_failed). */
  message?: string;
}

/** accepted / noop are not rejections → undefined; normalize other outcomes against the vocabularies. */
export function describeWorkflowRunActionRejection(
  action: WorkflowRunAction,
  ack: Pick<CommandAck, "status" | "reasonCode" | "message">,
): WorkflowRunActionRejection | undefined {
  if (ack.status === "accepted" || ack.status === "noop") return undefined;
  const code = ack.reasonCode ?? ack.status;
  const prefix =
    action === "cancel"
      ? BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX
      : WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX;
  const known = action === "cancel" ? CANCEL_REASONS : RESUME_REASONS;
  let reason = "generic";
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) reason = "unsupported";
  else if (ack.reasonCode?.startsWith(prefix)) {
    const suffix = ack.reasonCode.slice(prefix.length);
    if (known.has(suffix)) reason = suffix;
  }
  return { action, reason, code, ...(ack.message ? { message: ack.message } : {}) };
}

/** Copy key: `chat.toolCall.workflow.run.rejection.<action>.<reason>`; both vocabularies + unsupported + generic exist in locale files. */
export function workflowRunActionRejectionMessageId(rejection: WorkflowRunActionRejection): string {
  return `chat.toolCall.workflow.run.rejection.${rejection.action}.${rejection.reason}`;
}
