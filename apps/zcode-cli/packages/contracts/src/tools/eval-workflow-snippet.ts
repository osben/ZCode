// ============================================================
// EvalWorkflowSnippet Tool - compile and run a dynamic workflow snippet synchronously (scratch facade)
// ============================================================
// Experimental path for workflow authoring:
// uses the same compile / lowering / sandbox / world-read execution path, with an in-memory
// journal and fully transient state.

import { z } from "zod";
import { CreateWorkflowDiagnosticSchema, WORKFLOW_SOURCE_MISSING_HINT } from "./create-workflow.js";
import { toToolJsonSchema } from "./json-schema.js";

export const EVAL_WORKFLOW_SNIPPET_TOOL_NAME = "EvalWorkflowSnippet";

/** Snippet wall-clock default is 60s; maximum is 600s (to allow time for real build checks). */
export const EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS = 60_000;
export const EVAL_WORKFLOW_SNIPPET_MAX_TIMEOUT_MS = 600_000;
export const EVAL_WORKFLOW_SNIPPET_MIN_TIMEOUT_MS = 1_000;

/** Both sources were given (same tone as the other three tools). */
export const EVAL_WORKFLOW_SNIPPET_SOURCE_CONFLICT_ERROR =
  "Provide exactly one snippet source: `code` for the snippet inline, or `path` for a file holding it. Passing both is ambiguous.";

/** Neither source arrived: usually the arguments failed to parse; see {@link WORKFLOW_SOURCE_MISSING_HINT} for the reason. */
export const EVAL_WORKFLOW_SNIPPET_SOURCE_MISSING_ERROR = `No snippet source arrived. Pass \`code\` for the snippet inline, or \`path\` for a file holding it. ${WORKFLOW_SOURCE_MISSING_HINT}`;

const EvalWorkflowSnippetModelInputSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .optional()
      .describe("The snippet, inline. This OR `path`, never both."),
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

/**
 * Runtime input: the model-facing fields plus `script`, backfilled by `resolveInput`.
 *
 * `script` is always the normalized `code`. The other three script-submitting tools (CreateWorkflow /
 * AmendWorkflow / FillWorkflowHole) all name the field `script`, so a PreToolUse hook reading only
 * `tool_input.script` used to find nothing on snippets and silently pass them through (confirmed in the
 * 2026-10 user regression). `code` is kept: UI rendering and existing hooks read it.
 * Same posture as `CreateWorkflow.script_line_offset` — a parse result that the model's JSON schema omits;
 * if the model forces it in anyway, normalization overwrites it unconditionally.
 */
export const EvalWorkflowSnippetInputSchema = EvalWorkflowSnippetModelInputSchema.extend({
  script: z.string().min(1).optional(),
}).strict();

export type EvalWorkflowSnippetInput = z.infer<typeof EvalWorkflowSnippetInputSchema>;

/** JSON schema handed to the model: does not include `script`. */
export const EvalWorkflowSnippetInputJsonSchema = toToolJsonSchema(
  EvalWorkflowSnippetModelInputSchema,
);

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
