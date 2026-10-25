// ============================================================
// ListSavedWorkflows Tool - list saved dwf definitions in this project
// ============================================================
//
// This is **different from** ListWorkflowRuns: that tool lists past runs (history), while
// this one lists definitions available to run (the catalog). The names deliberately distinguish
// "Runs" from "SavedWorkflows" because the model can easily confuse "which workflows are
// available?" with "which workflows have run?"

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SavedWorkflowEntrySchema, SavedWorkflowInvalidEntrySchema } from "./saved-workflow.js";

export const LIST_SAVED_WORKFLOWS_TOOL_NAME = "ListSavedWorkflows";

export const ListSavedWorkflowsInputSchema = z
  .object({})
  // Same constraint as ListWorkflowRuns: deliberately no cwd input; the tool always scans the
  // current session's working directory. The model cannot scan other projects, which is also
  // required for `sideEffectScope: "none"`.
  .strict();

export type ListSavedWorkflowsInput = z.infer<typeof ListSavedWorkflowsInputSchema>;

export const ListSavedWorkflowsInputJsonSchema = toToolJsonSchema(ListSavedWorkflowsInputSchema);

export const ListSavedWorkflowsOutputSchema = z
  .object({
    workflows: z.array(SavedWorkflowEntrySchema),
    /** Files that could not be read. Omitted when empty; an empty array would add a noisy field to every call. */
    invalid: z.array(SavedWorkflowInvalidEntrySchema).optional(),
  })
  .strict();

export type ListSavedWorkflowsOutput = z.infer<typeof ListSavedWorkflowsOutputSchema>;

export const ListSavedWorkflowsOutputJsonSchema = toToolJsonSchema(ListSavedWorkflowsOutputSchema);
