// ============================================================
// EvalWorkflowSnippet Tool - compile and run a dynamic workflow snippet synchronously (scratch facade)
// ============================================================
// Experimental path for workflow authoring:
// uses the same compile / lowering / sandbox / world-read execution path, with an in-memory
// journal and fully transient state.

import { z } from "zod";
import { CreateWorkflowDiagnosticSchema } from "./create-workflow.js";
import { toToolJsonSchema } from "./json-schema.js";

export const EVAL_WORKFLOW_SNIPPET_TOOL_NAME = "EvalWorkflowSnippet";

/** Snippet wall-clock default is 60s; maximum is 600s (to allow time for real build checks). */
export const EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS = 60_000;
export const EVAL_WORKFLOW_SNIPPET_MAX_TIMEOUT_MS = 600_000;
export const EVAL_WORKFLOW_SNIPPET_MIN_TIMEOUT_MS = 1_000;

/** Violation message for "provide exactly one snippet" (same tone as the other three tools). */
export const EVAL_WORKFLOW_SNIPPET_SOURCE_ERROR =
  "Provide exactly one snippet source: `code` for the snippet inline, or `path` for a file holding it. Passing both, or neither, is ambiguous.";

export const EvalWorkflowSnippetInputSchema = z
  .object({
    code: z.string().min(1).optional().describe("The snippet, inline. This OR `path`, never both."),
    /**
     * Second source for a snippet. **The entire file is code**:
     * snippets do not use saved-definition semantics, so a file that happens to start with
     * `/* zcode-workflow` must not have that block stripped as metadata.
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe("A file holding the snippet, read whole. This OR `code`, never both."),
    timeoutMs: z
      .number()
      .int()
      .min(EVAL_WORKFLOW_SNIPPET_MIN_TIMEOUT_MS)
      .max(EVAL_WORKFLOW_SNIPPET_MAX_TIMEOUT_MS)
      .optional()
      .describe("Wall clock for the whole snippet, in ms. Default 60000, at most 600000."),
  })
  .strict();

export type EvalWorkflowSnippetInput = z.infer<typeof EvalWorkflowSnippetInputSchema>;

export const EvalWorkflowSnippetInputJsonSchema = toToolJsonSchema(EvalWorkflowSnippetInputSchema);

// Log limits (all payloads at the protocol boundary are bounded): item count × item length;
// the service truncates and marks excess items.
export const EVAL_WORKFLOW_SNIPPET_MAX_LOGS = 100;
export const EVAL_WORKFLOW_SNIPPET_MAX_LOG_CHARS = 2_048;
/** Serialization limit for the top-level return value (the harness does not measure artifact size; this belongs in the service/tool layer). */
export const EVAL_WORKFLOW_SNIPPET_MAX_ARTIFACT_BYTES = 256 * 1024;

export const EvalWorkflowSnippetOutputSchema = z
  .object({
    /** True when compilation is clean and the script returns normally; false when diagnostics are present or execution fails (timeout / exception / cap). */
    ok: z.boolean(),
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    /** Engine `log()` events captured in arrival order (bounded; the last item marks truncation). */
    logs: z.array(z.string().max(EVAL_WORKFLOW_SNIPPET_MAX_LOG_CHARS)),
    /** Model-facing text: serialized artifact / diagnostic list / structured failure (error code + message). */
    response: z.string(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export type EvalWorkflowSnippetOutput = z.infer<typeof EvalWorkflowSnippetOutputSchema>;

export const EvalWorkflowSnippetOutputJsonSchema = toToolJsonSchema(
  EvalWorkflowSnippetOutputSchema,
);
