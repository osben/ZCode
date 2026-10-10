// ============================================================
// amendWorkflowRunSettings: change two settings for a run from the GUI.
// ============================================================
// Extracted from command.ts to meet its max-lines limit. The payload, accepted result, and rejection
// vocabulary belong to one command; bootstrap creates fault codes and UI resolves copy from this shared
// vocabulary to prevent drift.

import { z } from "zod";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";

/**
 * Command payload. Both settings follow the tool's three-state rule: omitted = keep current, `null` =
 * reset to the default (session model / machine limit), value = set. The GUI sends only fields changed by
 * the user. Intentionally omits baseRevision, like cancelBackgroundWork and resumeWorkflowRun; the
 * workflowRuns surface has no revision.
 */
export const amendWorkflowRunSettingsPayloadSchema = z.object({
  /** Equals runId, using the same identity rule as cancel and resume. */
  workId: z.string(),
  /** Canonical string `providerId/modelId[$level]`; `null` = subagent returns to the session model. */
  subagentModel: z
    .string()
    .min(1)
    .max(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength)
    .nullable()
    .optional(),
  /** Concurrent-subagent limit; `null` removes this run's override and returns to the machine limit. The agent clamps it to `[1, ceiling]`. */
  maxConcurrency: z.number().int().min(1).nullable().optional(),
});
export type AmendWorkflowRunSettingsPayload = z.infer<typeof amendWorkflowRunSettingsPayloadSchema>;

/**
 * Result of an accepted ACK. `runId` / `toolCallId` refer to the **new** run (`toolCallId` is
 * `settings-<uuid>`, linking the settings-turn run card and details page). `supersededRunId` is present
 * only when the previous run was still active and this change stopped it.
 */
export const amendWorkflowRunSettingsResultSchema = z.object({
  type: z.literal("amendWorkflowRunSettings"),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  supersededRunId: z.string().min(1).optional(),
});

/**
 * Rejection vocabulary. Every rejection happens before stopping or creating anything:
 * not_found / not_configurable / unchanged / script_missing / model_unavailable / compile_failed
 * These are checks performed by the command itself; missing_boundaries comes from port preflight, and
 * start_failed means the port is missing or threw an error.
 */
export const workflowRunSettingsRejectionReasonSchema = z.enum([
  "not_found",
  "not_configurable",
  "unchanged",
  "script_missing",
  "model_unavailable",
  "compile_failed",
  "missing_boundaries",
  "start_failed",
]);
export type WorkflowRunSettingsRejectionReason = z.infer<
  typeof workflowRunSettingsRejectionReasonSchema
>;

/** Full fault code = prefix + reason; follows the workflowRunResumeRejected family. */
export const WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunSettingsRejected." as const;
