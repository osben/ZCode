// ============================================================
// ResolveWorkflowQuestion Tool - main agent answers a blocking question escalated by an actor
// ============================================================
// See `DynamicWorkflowRunPort.resolveQuestion` in
// interfaces/dynamic-workflow-run.port.ts.
//
// Accept only qid, not a `(run_id, question_id)` pair: qid is globally unique across runs,
// and asking the model to pair them during concurrent runs invites mistakes. Failures use
// ToolHandlerFailure (in core), so this output has only a success shape.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESOLVE_WORKFLOW_QUESTION_TOOL_NAME = "ResolveWorkflowQuestion";

export const ResolveWorkflowQuestionInputSchema = z
  .object({
    // Use snake_case like GetWorkflowRun's and ResumeWorkflowRun's run_id: to the model, these
    // are opaque identifiers from the same family.
    question_id: z
      .string()
      .min(1)
      .describe(
        "The question ID from the escalation notification, or from GetWorkflowRun's pending questions (looks like `dwfq-...`)",
      ),
    answer: z
      .string()
      .min(1)
      .describe("The answer text, delivered verbatim to the subagent that asked"),
  })
  .strict();

export type ResolveWorkflowQuestionInput = z.infer<typeof ResolveWorkflowQuestionInputSchema>;

export const ResolveWorkflowQuestionInputJsonSchema = toToolJsonSchema(
  ResolveWorkflowQuestionInputSchema,
);

export const ResolveWorkflowQuestionOutputSchema = z
  .object({
    ok: z.literal(true),
    qid: z.string().min(1),
    /** Confirmation text for the model (prose, not a contract field; the schema only requires it to be present). */
    response: z.string(),
  })
  .strict();

export type ResolveWorkflowQuestionOutput = z.infer<typeof ResolveWorkflowQuestionOutputSchema>;

export const ResolveWorkflowQuestionOutputJsonSchema = toToolJsonSchema(
  ResolveWorkflowQuestionOutputSchema,
);
