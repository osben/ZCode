// ============================================================
// AmendWorkflow Tool - revise a run: stop it if it is still going, import its finished work, start the revision
// ============================================================
//
// Why this is a separate tool from CreateWorkflow: an amendment is **a different action and a
// different card**—the model is changing something the user is already watching, and its predecessor
// may still be running. Both tools share one output shape, so the executor's background tracking,
// `backgrounded` contract, and display payload have a single definition.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";

export const AMEND_WORKFLOW_TOOL_NAME = "AmendWorkflow";

/**
 * Validation message for "provide at most one amended script." It matches the placement and tone of
 * `CREATE_WORKFLOW_SOURCE_ERROR`; unlike that error, providing neither is **valid** here—it means
 * "reuse the predecessor's script."
 */
export const AMEND_WORKFLOW_SOURCE_ERROR =
  "Provide at most one revised script: `path` for the script file you edited (the usual form), or `script` for the whole revised script inline. Passing both is ambiguous; omit both to keep the predecessor's script unchanged.";

/**
 * Model-facing input. Only `run_id` is required; every other field follows one rule: **omission means
 * reuse the predecessor's value**. `predecessor` is not included here—it is a fact populated by
 * resolveInput (below), so the model's JSON schema does not list it.
 */
const AmendWorkflowModelInputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .describe(
      "ID of the run to amend (from a result, a notification, GetWorkflowRun or ListWorkflowRuns).",
    ),
  /**
   * Omit both `script` and `path` to reuse the predecessor's archived script: amendments that change
   * only settings need not copy thousands of tokens of script again. It follows the same lifecycle as
   * the two settings: `resolveInput` reads the predecessor's script, fills it in, and sets
   * `predecessor.script_inherited`; hooks, the confirmation window, and the handler then see one
   * script. The runtime schema must still allow omission because call-runner validates the model's
   * original shape again after hook rewriting.
   */
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The whole revised script, inline. This OR `path`, never both; omit both to keep the predecessor's script.",
    ),
  /**
   * Typical amendment flow: edit one line in the predecessor's script file in place and pass the same
   * path back. Inline scripts are still accepted, but require sending the whole script again—that is
   * exactly what this path avoids.
   */
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The revised script's file, usually the predecessor's own script file edited in place. This OR `script`, never both.",
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Display label for the new run; defaults to the predecessor's."),
  /**
   * Three states: omitted = reuse the predecessor's limit; `null` = clear it (return to the ceiling);
   * number = set it (clamped below the ceiling). The three states exist only through `resolveInput`,
   * which normalizes them to a number or omission; the confirmation window and handler see the value
   * that will take effect. The runtime schema keeps `nullable` because call-runner validates the
   * model's original shape again after hook rewriting.
   */
  max_concurrency: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Omit to keep the predecessor's limit, null to remove it, a number to set one (only when the user asks).",
    ),
  /**
   * Three states, with exactly the same semantics as `max_concurrency`:
   * omitted = reuse the predecessor's selection (`resolveInput` fills it from the predecessor snapshot
   * and **resolves it again**, so a model that has since been removed fails now rather than when the
   * subagent first speaks); `null` = clear it (return to the session model); string = set it. The
   * three states exist only through `resolveInput`, which normalizes them to a canonical string or omission.
   */
  subagent_model: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Omit to keep the predecessor's choice, null for the session model, a model id to set one (only when the user asks).",
    ),
});

/**
 * Predecessor facts populated by resolveInput (step 2).
 *
 * Both permission decisions (skip confirmation for runs in this session) and the confirmation window
 * ("still running; it will be stopped") read this value. Both run before the handler and need it
 * synchronously, so resolveInput (async and the only port read in the whole flow) computes it and
 * stores it in the input. Normalization **always overwrites** it; model-supplied values are invalid
 * (same precedent as saved.path).
 */
export const AmendWorkflowPredecessorSchema = z
  .object({
    name: z.string().min(1).optional(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
    stop_reason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    owned_by_this_session: z.boolean(),
    /**
     * This call omitted both `script` and `path`, so the input's `script` was read from the predecessor's
     * archive by resolveInput. It is true only when present: the confirmation window uses it to say
     * "script unchanged" in the lineage row, and the handler uses "reused" wording in the result and
     * first diagnostic line. Always overwritten along with the whole block; model-supplied values are invalid.
     */
    script_inherited: z.literal(true).optional(),
  })
  .strict();

export type AmendWorkflowPredecessor = z.infer<typeof AmendWorkflowPredecessorSchema>;

/**
 * "This predecessor belongs to this session and was not stopped manually by the user"—the owner rule
 * for skipping confirmation.
 *
 * Lives in the contract rather than the permission service because it now has **two** readers, which
 * must agree exactly: the permission service uses it to allow the always-ask branch, and when an
 * in-place concurrency adjustment gets `not_live`, the handler uses it to decide whether the fallback
 * amendment needs a confirmation window. Duplicating this rule would eventually let a call that
 * approved nothing silently start a new run.
 *
 * Accepts `unknown`: the permission service receives unresolved tool input, while the handler receives
 * the resolved fact block.
 */
export function isAmendWorkflowOwnedPredecessor(predecessor: unknown): boolean {
  if (!predecessor || typeof predecessor !== "object") return false;
  const facts = predecessor as Record<string, unknown>;
  return facts.owned_by_this_session === true && facts.stop_reason !== "user";
}

/**
 * Runtime input: model-facing keys plus the populated `predecessor` and `script_line_offset`.
 * `.strict()` makes legacy spellings such as `resume_from` visible errors here too.
 */
export const AmendWorkflowInputSchema = AmendWorkflowModelInputSchema.extend({
  predecessor: AmendWorkflowPredecessorSchema.optional(),
  /**
   * Offset from body lines to file lines; non-zero only when a `path` file contains a `/* zcode-workflow`
   * block. Like `predecessor`, this is a parsed result, not an input parameter, and is not listed in
   * the model's JSON schema.
   */
  script_line_offset: z.number().int().nonnegative().optional(),
}).strict();

export type AmendWorkflowInput = z.infer<typeof AmendWorkflowInputSchema>;

/** JSON schema shown to the model: excludes `predecessor` and `script_line_offset`. */
export const AmendWorkflowInputJsonSchema = toToolJsonSchema(
  AmendWorkflowModelInputSchema.strict(),
);
