// Rejection reason vocabularies and fault prefixes for dynamic workflow commands: split out of
// command.ts (that file is at its max-lines cap) and re-exported by command.ts; existing import
// paths stay unchanged.
import { z } from "zod";

// startSavedWorkflow rejection reasons (docs/dynamic-workflow/launch.md, "On the agent"):
// the bootstrap handler mints the fault code and the ui launcher looks up i18n copy from it; both
// sides share this enum to avoid drift.
// invalid_name / not_found: resolution phase; invalid_args: argument validation; compile_failed:
// analyzeScript diagnostics; session_busy: the session has an active turn; start_failed: any other
// startup failure before port.submit.
export const savedWorkflowStartRejectionReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "invalid_args",
  "compile_failed",
  "session_busy",
  "start_failed",
]);
export type SavedWorkflowStartRejectionReason = z.infer<
  typeof savedWorkflowStartRejectionReasonSchema
>;

// Full fault code = prefix + reason (e.g. fault.command.savedWorkflowStartRejected.not_found).
// Same family as the workflowRunResumeRejected namespace; exported so bootstrap can concatenate
// and ui can prefix-match.
export const SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX =
  "fault.command.savedWorkflowStartRejected." as const;

// resumeWorkflowRun rejections: prefix + port reason (not_found / not_resumable / superseded /
// already_running / script_missing / script_mismatch / compile_failed); `ack.message` carries the
// bounded diagnostic for compile_failed (docs/dynamic-workflow/presentation.md, "The run pane").
export const WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunResumeRejected." as const;
