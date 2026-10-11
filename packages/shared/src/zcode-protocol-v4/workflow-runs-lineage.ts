// Readers for lineage fields: the reducer uses these two narrow helpers to carry `resumedFrom`,
// `supersededBy`, and stop reasons from progress payloads. They live in a separate file because the
// reducer itself has reached oxlint's 400-line limit.

import { WORKFLOW_RUN_STOP_REASONS } from "./workflow-observation-display.js";
import type { WorkflowRunState } from "./workflow-runs.js";

/** Run ID field from a payload; present only when it is a non-empty string. */
export function readRunIdField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Stop reason from a payload; values outside the allowlist (unknown to an older CLI or from a damaged payload) are treated as absent instead of dropping the whole frame. */
export function readWorkflowRunStopReason(value: unknown): WorkflowRunState["stopReason"] {
  return typeof value === "string" &&
    (WORKFLOW_RUN_STOP_REASONS as readonly string[]).includes(value)
    ? (value as WorkflowRunState["stopReason"])
    : undefined;
}
