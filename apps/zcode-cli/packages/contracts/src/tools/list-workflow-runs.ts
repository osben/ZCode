// ============================================================
// ListWorkflowRuns Tool - list workflow runs for the project (cwd), including cross-session history
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_WORKFLOW_RUNS_TOOL_NAME = "ListWorkflowRuns";

/**
 * Workflow-run lifecycle vocabulary. The literals match the port's
 * `DynamicWorkflowRunLifecycleStatus`, but are redeclared here as a zod enum because the schema
 * is the **runtime** validation surface; a type-only union cannot serve that purpose. If the
 * two diverge, the tool will reject a valid status from the model, so the port-side comment
 * also points here.
 */
export const WORKFLOW_RUN_LIFECYCLE_STATUSES = [
  "completed",
  "errored",
  "pending",
  "running",
  "stopped",
] as const;

/** Reasons for `stopped` (zod surface for the port's `DynamicWorkflowRunStopReason`). */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

/** Bounds and default for limit. 50 is the maximum that avoids cursor pagination for a low-cardinality entity like a run. */
export const LIST_WORKFLOW_RUNS_MIN_LIMIT = 1;
export const LIST_WORKFLOW_RUNS_MAX_LIMIT = 50;
export const LIST_WORKFLOW_RUNS_DEFAULT_LIMIT = 20;

export const ListWorkflowRunsInputSchema = z
  .object({
    limit: clampedLimit().describe(
      `Maximum number of runs to return (${LIST_WORKFLOW_RUNS_MIN_LIMIT}-${LIST_WORKFLOW_RUNS_MAX_LIMIT}, default ${LIST_WORKFLOW_RUNS_DEFAULT_LIMIT}). Most recently updated runs come first.`,
    ),
    statuses: z
      .array(z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES))
      .optional()
      .describe(
        "Optional status filter. Omit to see every run in this project. Pass [\"running\", \"pending\"] to see only what is still in flight.",
      ),
  })
  // Deliberately no cwd input: the tool always queries the current session's working directory
  // (the model cannot query other projects, which is also required for `sideEffectScope: "none"`).
  // .strict() makes an extra cwd argument a visible error.
  .strict();

export type ListWorkflowRunsInput = z.infer<typeof ListWorkflowRunsInputSchema>;

export const ListWorkflowRunsInputJsonSchema = toToolJsonSchema(ListWorkflowRunsInputSchema);

/**
 * **Shared summary** for list and detail (schema surface for the port's
 * `DynamicWorkflowRunSummary`).
 *
 * Use one shared set of fields rather than two independently evolving tables: showing the same
 * run with different names or ownership in the list and detail view is hard to catch in tests
 * and directly undermines trust. Keep the shared fields on the **list** side because the list
 * is the shallowest projection of this summary; detail extends it.
 */
export const WorkflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  /** Resolved display label (name → first script line → runId, derived by the service). */
  label: z.string(),
  /** `"name"` = name supplied by the user; `"script"` = derived from the script when read (including runId fallback). */
  labelSource: z.enum(["name", "script"]),
  status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
  /** Present only when `status === "stopped"`. */
  stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
  /** Run this one was amended from (`dwf_run.resumed_from`); omitted when it is not an amendment. */
  resumedFrom: z.string().min(1).optional(),
  /** Amendment that stopped and replaced this run (settlement data for `stopped(superseded)`); omitted when it was not replaced. */
  supersededBy: z.string().min(1).optional(),
  ownedByThisSession: z.boolean(),
  /** Marker that this session cannot confirm the run is still alive; present only when true. Never rewrites the status. */
  possiblyInterrupted: z.boolean().optional(),
  /** Epoch milliseconds (`time_created` / `time_updated` in the journal). */
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ListWorkflowRunsRunSchema = WorkflowRunSummarySchema.extend({
  spentTokens: z.number(),
}).strict();

export type ListWorkflowRunsRun = z.infer<typeof ListWorkflowRunsRunSchema>;

export const ListWorkflowRunsOutputSchema = z
  .object({
    runs: z.array(ListWorkflowRunsRunSchema),
    /** More runs remain beyond this page (detected by fetching limit+1); present only when true. */
    truncated: z.boolean().optional(),
  })
  .strict();

export type ListWorkflowRunsOutput = z.infer<typeof ListWorkflowRunsOutputSchema>;

export const ListWorkflowRunsOutputJsonSchema = toToolJsonSchema(ListWorkflowRunsOutputSchema);

/**
 * Clamp rather than reject limit: a read-only listing should not become a tool error the model
 * must recover from just because a number is out of range. `limit` defaults to 20 and is
 * clamped to [1, 50].
 *
 * Clamp in preprocess rather than the handler to preserve two properties: JSON schema still
 * projects the inner schema (`type: integer` + minimum/maximum/default, visible to the model),
 * while out-of-range runtime values are brought within bounds. `Math.min/max` in the handler
 * would be rejected by this schema's min/max first and never execute. Semantic coercion in
 * preprocess follows existing conventions (task-output's semanticBoolean and bash's timeout).
 */
function clampedLimit(): z.ZodEffects<z.ZodDefault<z.ZodNumber>, number, unknown> {
  return z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(
      LIST_WORKFLOW_RUNS_MAX_LIMIT,
      Math.max(LIST_WORKFLOW_RUNS_MIN_LIMIT, Math.trunc(value)),
    );
  }, z.number().int().min(LIST_WORKFLOW_RUNS_MIN_LIMIT).max(LIST_WORKFLOW_RUNS_MAX_LIMIT).default(LIST_WORKFLOW_RUNS_DEFAULT_LIMIT));
}
