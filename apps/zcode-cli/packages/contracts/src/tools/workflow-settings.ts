// ============================================================
// The two adjustable run settings in the confirmation window (shared by CreateWorkflow / AmendWorkflow)
// ============================================================
// docs/dynamic-workflow/launch.md "Adjusting the settings in the window".
//
// Two schemas, one out and one back:
//   - `WorkflowAdjustableSettingsSchema`: facts backfilled into the arguments by `resolveInput`, telling the
//     confirmation window "this agent will apply the values you changed in the window" plus the local ceilings.
//   - `WorkflowSettingsAdjustmentSchema`: the changes the user's Allow reply carries back in `content`.
//
// The backfill block travels through the **argument channel** rather than the `create_workflow` display: the display's
// field set is frozen (see the warning on tool-result-metadata.ts); one extra key would make clients that strictly
// parse it drop the whole block along with the graph, while the argument channel is schema-free for every client
// version. Old clients that do not recognize the block keep drawing the plain-text condition lines; old agents do not
// write it, so new clients never see an adjustment they would drop.

import { z } from "zod";

/** Length cap for the canonical `providerId/modelId[$level]` form (team plans use a UUID as the providerId). */
const WORKFLOW_SETTINGS_MAX_MODEL_CHARS = 512;

/**
 * The "adjustable in the confirmation window" facts backfilled by `resolveInput`. Same stance as
 * `script_line_offset` and `AmendWorkflow.predecessor`: a parsed result rather than a fillable argument — the model's
 * JSON schema does not list it, and anything the model hard-fills is unconditionally overwritten.
 */
export const WorkflowAdjustableSettingsSchema = z
  .object({
    /** The host has a model catalog and can resolve a model picked in the confirmation window. When false, the window only allows adjusting the bound and the model line is one sentence. */
    subagent_model: z.boolean(),
    /**
     * The default concurrency D (the key name predates the "default concurrency" concept and is kept for old-client
     * compatibility); absent when the port cannot say. It is not a cap: the stepper has no upper bound; D only writes
     * the "default N" hint and the "equal to default = no own bound" judgment.
     */
    concurrency_ceiling: z.number().int().positive().optional(),
  })
  .strict();

export type WorkflowAdjustableSettings = z.infer<typeof WorkflowAdjustableSettingsSchema>;

/** How many distinct model names a script may name at most (the binding table's entry cap). Far beyond any real script; it only keeps the table bounded. */
export const WORKFLOW_MODEL_BINDINGS_MAX_ENTRIES = 64;
/** Length cap for a model name in the script (the name is a model id or `providerId/modelId[$level]`). */
const WORKFLOW_MODEL_NAME_MAX_CHARS = 512;

/**
 * Models named by the script → canonical form (docs/dynamic-workflow/launch.md "Models the script names"): the key is
 * the name the script wrote **verbatim** (not trimmed: that is exactly the string carried into the runtime persona),
 * the value is `providerId/modelId[$level]`.
 *
 * Same stance, same channel as {@link WorkflowAdjustableSettingsSchema}: backfilled into the arguments by
 * `resolveInput`, not listed in the model's JSON schema, and hard-filled values are unconditionally overwritten. The
 * confirmation window does not draw it name by name (the script's choice is the author's decision about its model);
 * its presence only rewords the model sentence to "subagents run on by default"; the reply has no field to change it
 * either.
 */
export const WorkflowModelBindingsSchema = z
  .record(
    z.string().min(1).max(WORKFLOW_MODEL_NAME_MAX_CHARS),
    z.string().trim().min(1).max(WORKFLOW_SETTINGS_MAX_MODEL_CHARS),
  )
  .refine((bindings) => Object.keys(bindings).length <= WORKFLOW_MODEL_BINDINGS_MAX_ENTRIES, {
    message: `at most ${WORKFLOW_MODEL_BINDINGS_MAX_ENTRIES} model names`,
  });

export type WorkflowModelBindings = z.infer<typeof WorkflowModelBindingsSchema>;

/**
 * The settings the user changed in the confirmation window — the Allow reply's `content`. Uses the tool's own field
 * names and a three-state: omitted = unchanged, `null` = back to default (session model / default concurrency),
 * value = set — verbatim the same three-state as `AmendWorkflow`'s model surface, so the agent side has a single
 * parser.
 *
 * Deliberately **not** strict: the reply comes from a client, and the broker takes only the two keys it knows and
 * drops the rest, rather than voiding both of the user's changes because of one key it does not recognize.
 */
export const WorkflowSettingsAdjustmentSchema = z.object({
  subagent_model: z
    .string()
    .trim()
    .min(1)
    .max(WORKFLOW_SETTINGS_MAX_MODEL_CHARS)
    .nullable()
    .optional(),
  max_concurrency: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional(),
});

export type WorkflowSettingsAdjustment = z.infer<typeof WorkflowSettingsAdjustmentSchema>;

/** Parses a reply `content`: the adjustment made of recognized keys; a bad shape or no keys at all yields `undefined`. */
export function parseWorkflowSettingsAdjustment(
  content: unknown,
): WorkflowSettingsAdjustment | undefined {
  const parsed = WorkflowSettingsAdjustmentSchema.safeParse(content);
  if (!parsed.success) return undefined;
  const adjustment: WorkflowSettingsAdjustment = {};
  if (parsed.data.subagent_model !== undefined) {
    adjustment.subagent_model = parsed.data.subagent_model;
  }
  if (parsed.data.max_concurrency !== undefined) {
    adjustment.max_concurrency = parsed.data.max_concurrency;
  }
  return Object.keys(adjustment).length === 0 ? undefined : adjustment;
}
