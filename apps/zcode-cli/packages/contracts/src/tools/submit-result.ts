// ============================================================
// submit_result Tool - actor terminal structured-result submission
// ============================================================
// Workflow actors (child AgentRuntime instances) use this to submit the structured result for
// the current ask. The declared input is generic arbitrary JSON (a single `result` property);
// each ask's schema is sent in the ask instruction's epilogue rather than the tool declaration,
// preserving the frozen-per-actor tool-cache invariant.

import { z } from "zod";
import { TOOL_JSON_SCHEMA_VERSION, toToolJsonSchema } from "./json-schema.js";

export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

export const SubmitResultInputSchema = z
  .object({
    // Intentionally generic: do not constrain the shape of result. The engine validates each
    // ask's schema on the WorkflowSubmitPort side, using the ask instruction's epilogue. This
    // lets the tool declaration remain frozen across asks and hit the prompt cache.
    result: z
      .unknown()
      .describe(
        "The structured result for this ask, matching the JSON schema given in the ask instructions.",
      ),
  })
  .strict();

export type SubmitResultInput = z.infer<typeof SubmitResultInputSchema>;

export const SubmitResultInputJsonSchema = toToolJsonSchema(SubmitResultInputSchema);

/**
 * Typed tool declaration for a mono subagent: the `result` subschema is that actor's only ask
 * result schema. Runtime zod validation still uses the generic `SubmitResultInputSchema`
 * above; the engine validates the per-ask shape through WorkflowSubmitPort. The declaration
 * only exposes it to the provider (and constrains it natively when supported). The outer object
 * matches the generic declaration: one required `result` and no extra keys.
 */
export function typedSubmitResultInputSchema(
  resultSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      result: {
        description: "The structured result for this ask.",
        ...resultSchema,
      },
    },
    required: ["result"],
    additionalProperties: false,
    $schema: TOOL_JSON_SCHEMA_VERSION,
  };
}

export const SubmitResultOutputSchema = z
  .object({
    status: z.literal("accepted"),
  })
  .strict();

export type SubmitResultOutput = z.infer<typeof SubmitResultOutputSchema>;

export const SubmitResultOutputJsonSchema = toToolJsonSchema(SubmitResultOutputSchema);
