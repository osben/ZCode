// ============================================================
// Escalate Tool - actor escalates a blocking question to the main agent
// ============================================================
// Injected into the actor session in the same way as `submit_result` (registered when the port
// is present and added back by core even under `tools:"none"`), but they settle different
// things: submit settles **the result of this ask**, while escalate settles **one question and
// answer**.
//
// Output is deliberately a flat object with a discriminant rather than a union: both branches
// are ordinary tool results, not errors. The model sees only one text block; `status` serves
// logs and result projection.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const ESCALATE_TOOL_NAME = "escalate";

export const EscalateInputSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .describe(
        "The single focused question that unblocks you. One question per call, answerable in a sentence.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "What you already tried and where exactly you are stuck — the evidence the answerer needs.",
      ),
  })
  .strict();

export type EscalateInput = z.infer<typeof EscalateInputSchema>;

export const EscalateInputJsonSchema = toToolJsonSchema(EscalateInputSchema);

/**
 * Outcome of one escalation.
 *
 * - `answered`: `message` is the main agent's original answer, and `qid` is the globally
 *   unique id for this question and answer.
 * - `refused`: `message` describes the current state and next step (budget exhausted / no ask
 *   in flight), and `reason` is the discriminant. **This is not an error**; rendering "budget
 *   exhausted" as an error tool_result would look retryable to the model, which would hit the
 *   same wall repeatedly—the behavior this feature is intended to eliminate.
 */
export const EscalateOutputSchema = z
  .object({
    status: z.enum(["answered", "refused"]),
    message: z.string(),
    /** Present only for `answered`. */
    qid: z.string().optional(),
    /** Present only for `refused`. */
    reason: z.enum(["budget_exhausted", "no_active_ask"]).optional(),
  })
  .strict();

export type EscalateOutput = z.infer<typeof EscalateOutputSchema>;

export const EscalateOutputJsonSchema = toToolJsonSchema(EscalateOutputSchema);
