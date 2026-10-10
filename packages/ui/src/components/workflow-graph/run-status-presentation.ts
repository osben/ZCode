import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";

/**
 * All status-indicator shapes and colors. Consumers provide size and `rounded-full`; this module supplies only shape variants
 * (pulse / solid dot / halo / hollow ring) and colors. Timeline station indicators, sidebar lists, run directory, and task list share this,
 * so one feature has one visual treatment for "running."
 *
 * Use warning (the activity color) for running instead of primary: primary is inverted across themes (nearly black in light mode), reading as
 * "emphasis" rather than "in motion." Reserve the activity color for things that are actually moving (indicator, marching dashes, spinner).
 */
export const STATUS_DOT: Record<StepRunStatus, string> = {
  done: "bg-success",
  failed: "bg-destructive ring-2 ring-destructive/30",
  pending: "border-[1.5px] border-foreground-subtlest bg-transparent",
  running: "animate-pulse bg-warning motion-reduce:animate-none",
};

/**
 * Hollow-ring indicator for a compile feedback row. Like "compiled" and a station waiting to start, the shape means nothing ran.
 * Color indicates whether attention is still pending: `open` is the latest draft in the lineage (the loop is still active or the model stopped here);
 * `settled` has a later update. Never use destructive: red is reserved for failed runs in this feature.
 */
export const DRAFT_FEEDBACK_DOT = {
  open: "border-[1.5px] border-warning bg-transparent",
  settled: STATUS_DOT.pending,
} as const;

/**
 * Visual vocabulary for the **overall** run status (five values), derived from the four-value `STATUS_DOT`
 * (terminal statuses = completed / errored / stopped).
 * `stopped` uses a neutral color instead of destructive: stopping (user cancellation, process death, model-side error) is recoverable,
 * not a script failure; only `errored` is destructive.
 */
export const RUN_STATUS_DOT: Record<WorkflowRunState["status"], string> = {
  pending: STATUS_DOT.pending,
  running: STATUS_DOT.running,
  completed: STATUS_DOT.done,
  errored: STATUS_DOT.failed,
  stopped: STATUS_DOT.pending,
};

/** Semantic colors for status labels. Uses the same checks as the status dots, but for text (status is always named, never conveyed by color alone). */
export const RUN_STATUS_TEXT: Record<WorkflowRunState["status"], string> = {
  pending: "text-foreground-subtle",
  running: "text-warning",
  completed: "text-success",
  errored: "text-destructive",
  stopped: "text-foreground-subtle",
};

/**
 * Reason label for `stopped` (reuse the cancellation presentation plus one line describing the reason). Read-side objects may be a projected run,
 * discovery-query summary, or tool-card display. Their schemas evolve in different protocol layers, so read an optional key structurally instead of binding to one type.
 */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  // Stopped and replaced by an AmendWorkflow:
  // the indicator remains a neutral stopped ring; only the label and link to the successor differ.
  "superseded",
] as const;
export type WorkflowRunStopReason = (typeof WORKFLOW_RUN_STOP_REASONS)[number];

export function readWorkflowRunStopReason(run: {
  status?: string;
  stopReason?: unknown;
}): WorkflowRunStopReason | undefined {
  if (run.status !== "stopped") return undefined;
  const reason = run.stopReason;
  return typeof reason === "string" &&
    (WORKFLOW_RUN_STOP_REASONS as readonly string[]).includes(reason)
    ? (reason as WorkflowRunStopReason)
    : undefined;
}

/** i18n key for the reason label (`chat.toolCall.workflow.run.stopReason.*`). */
export function workflowRunStopReasonMessageId(reason: WorkflowRunStopReason): string {
  return `chat.toolCall.workflow.run.stopReason.${reason}`;
}

/** Whether a run was stopped and replaced by a revision; cards and details use this to change the type label, hide Resume, and link to the successor. */
export function isWorkflowRunSuperseded(run: { status?: string; stopReason?: unknown }): boolean {
  return readWorkflowRunStopReason(run) === "superseded";
}
