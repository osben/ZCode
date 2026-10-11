// ============================================================
// ResumeWorkflowRun Tool - resume a cancelled / Interrupted workflow run
// ============================================================
// See the contract for `DynamicWorkflowRunPort.resume` in
// interfaces/dynamic-workflow-run.port.ts.
//
// This is the third entry point for workflow-run recovery, after the UI detail-page button
// and CLI /dwf resume. The execution foundation is unchanged: call the same
// `port.resume(runId)` and resume in place with the same runId (script pinned by scriptHash,
// arguments and caps reused from the journal, completed nodes replayed, and unfinished nodes
// dispatched again).
//
// Output has only a success shape: failures use ToolHandlerFailure (in core) and are outside
// this schema, so all fields are required and none are optional. `status: "backgrounded"` lets
// the executor recognize it by shape for automatic tracking through the same
// trackBackgroundTask path as CreateWorkflow.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESUME_WORKFLOW_RUN_TOOL_NAME = "ResumeWorkflowRun";

export const ResumeWorkflowRunInputSchema = z
  .object({
    // Use snake_case like GetWorkflowRun's run_id (which follows TaskOutput's task_id): to the
    // model, these are all identifiers from the same run/task family. The resumable set
    // (cancelled ∪ failed+Interrupted) is described above; the authority is the server-side
    // port.resume check, while this field only guides routing.
    run_id: z
      .string()
      .min(1)
      .describe(
        "The workflow run ID to resume — a cancelled run or one that failed with code `Interrupted`, as seen with GetWorkflowRun or ListWorkflowRuns",
      ),
  })
  .strict();

export type ResumeWorkflowRunInput = z.infer<typeof ResumeWorkflowRunInputSchema>;

export const ResumeWorkflowRunInputJsonSchema = toToolJsonSchema(ResumeWorkflowRunInputSchema);

/**
 * Success output: the run has resumed and is running in the background.
 *
 * - `backgroundTaskId ≡ runId` (same identity rule as CreateWorkflow's backgrounded output);
 *   cancellation, TaskOutput lookup, and terminal notifications all share this key.
 * - `status` accepts only the `"backgrounded"` literal: executor background tracking is
 *   triggered by this shape, and another value would add another lifecycle branch to explain.
 * - `response` is model-facing guidance (do not poll; wait for a notification), built by the
 *   core handler. It is prose rather than a contract field, so the schema only requires it to
 *   be present.
 */
export const ResumeWorkflowRunOutputSchema = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1),
    response: z.string(),
    status: z.literal("backgrounded"),
    backgroundTaskId: z.string().min(1),
  })
  .strict();

export type ResumeWorkflowRunOutput = z.infer<typeof ResumeWorkflowRunOutputSchema>;

export const ResumeWorkflowRunOutputJsonSchema = toToolJsonSchema(ResumeWorkflowRunOutputSchema);
