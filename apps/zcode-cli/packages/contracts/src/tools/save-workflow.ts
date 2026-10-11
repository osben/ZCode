// ============================================================
// SaveWorkflow Tool - save a dwf script and its metadata as a reusable project definition
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { CreateWorkflowDiagnosticSchema } from "./create-workflow.js";
import {
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SavedWorkflowArgsDeclarationSchema,
  SavedWorkflowScopeSchema,
  SavedWorkflowShadowingSchema,
} from "./saved-workflow.js";

export const SAVE_WORKFLOW_TOOL_NAME = "SaveWorkflow";

/**
 * Violation message for "provide exactly one body source." The field is not named `path`
 * because `path` is already this tool's **resolved output location** (read by the confirmation
 * dialog and UI). Giving an input and output field the same name would lead the model to pass
 * the save destination as the source file.
 */
export const SAVE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one script source: `script` for the body inline, or `script_path` for the file holding it (a draft, usually). Passing both, or neither, is ambiguous.";

/** Business failure message when the model supplies a script with its own frontmatter. */
export const SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR =
  "The `script` must be the workflow body only — it already starts with a `/* zcode-workflow` metadata block. Pass the metadata through the `description` / `whenToUse` / `args` fields instead; the block is written for you.";

export const SaveWorkflowInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("File-safe identifier: letters, digits, dot, dash and underscore."),
    description: z
      .string()
      .min(1)
      .describe("One line saying what the workflow does."),
    whenToUse: z
      .string()
      .min(1)
      .optional()
      .describe("When this workflow is the right answer."),
    args: SavedWorkflowArgsDeclarationSchema.optional().describe(
      "Argument declarations the script reads off `args`.",
    ),
    script: z
      .string()
      .optional()
      .describe(
        "The script body, inline, without a metadata block. This OR `script_path`, never both.",
      ),
    /**
     * Second source for the body: a file that already exists on disk, usually the draft that was
     * just run. If the file contains a metadata block, **discard the block**; metadata comes
     * from this call's fields, which are what the user approved.
     */
    script_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A file holding the script body, usually a draft a result named. This OR `script`, never both.",
      ),
    // The **model** selects the scope; the system does not guess, and there is no default, so
    // it must decide each time. Use a neutral criterion: does the script refer to anything in
    // this repository? Yes → project; no → global.
    scope: SavedWorkflowScopeSchema.describe(
      '"project" when the script depends on this repository; "global" when it depends on nothing in it. Required, no default.',
    ),
    /**
     * Provenance (docs/dynamic-workflow/launch.md, “`SaveWorkflow`”): identifies the run from which
     * this definition was distilled. It is **not a third source of script content**; the body still
     * comes only from `script` / `script_path`, and the handler does not read this field.
     * Its sole purpose is to let that run's completion card recognize that it has been saved,
     * （docs/dynamic-workflow/transcript-and-notifications.md「Which workflow a run is saved as」），
     * which is the **only** persistent link between the saved definition and that run: the model may
     * choose a new name and summarize the script, so neither can be used to reconnect them.
     */
    run_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Provenance only: the id of the run this workflow was distilled from, when saving a workflow that just ran. Pass it whenever you know it; it does not change what is saved.",
      ),
    // The following three fields are resolved and filled by `resolveInput`; the model does not
    // supply them.
    // They are **facts shown in the confirmation dialog**: which file this save targets,
    // whether it overwrites an existing file, and whether it shadows a definition in the other
    // scope. They travel through input rather than display because the input channel passes
    // through without a schema in every client version, so old Desktop and legacy v3 clients
    // also receive the full content.
    /** Filled during resolution: file destination. */
    path: z.string().min(1).optional(),
    /** Filled during resolution: target already exists, so this approval is an **overwrite**. */
    overwrite: z.boolean().optional(),
    /** Filled during resolution: the same name exists in the other scope (shadowing fact shown in the confirmation dialog). Omitted when there is no name conflict. */
    shadowing: SavedWorkflowShadowingSchema.optional(),
  })
  .strict();

export type SaveWorkflowInput = z.infer<typeof SaveWorkflowInputSchema>;

export const SaveWorkflowInputJsonSchema = toToolJsonSchema(SaveWorkflowInputSchema);

/**
 * Output shares a schema for diagnostics with CreateWorkflow: both tools use the **same** type
 * checker, and showing the model different diagnostic shapes would teach it two parsers.
 *
 * `overwritten` is present only when a file was actually written. A diagnostics-only result
 * cannot say whether anything was overwritten; returning `false` would make the model think
 * the file was saved.
 */
export const SaveWorkflowOutputSchema = z
  .object({
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    ok: z.boolean(),
    response: z.string(),
    name: z.string().min(1),
    scope: SavedWorkflowScopeSchema,
    /** File destination (when not written, this is where it **would have** been saved, so the model can explain the error). */
    path: z.string().min(1),
    overwritten: z.boolean().optional(),
  })
  .strict();

export type SaveWorkflowOutput = z.infer<typeof SaveWorkflowOutputSchema>;

export const SaveWorkflowOutputJsonSchema = toToolJsonSchema(SaveWorkflowOutputSchema);
