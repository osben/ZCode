// ============================================================
// Saved workflows - shared vocabulary for saved dwf definitions
// ============================================================
//
// This module **only** defines what a saved workflow is: valid name shape, file location,
// argument declarations, and metadata. Three tools use it as their contract (SaveWorkflow
// writes, ListSavedWorkflows reads, and CreateWorkflow runs from a `saved` source), and the
// store in core also gets its schema here. If the metadata shape evolves independently on the
// write and read sides, a saved workflow may not appear in the list—a divergence that is hard
// to catch with tests on either side alone.

import { z } from "zod";

/**
 * Extension for saved workflow files. Use `.dwf.ts` rather than `.ts`: the editor highlights
 * it as TypeScript (frontmatter is a syntactically valid block comment), while the `.dwf`
 * segment lets discovery distinguish it from project source without opening the file.
 */
export const SAVED_WORKFLOW_FILE_EXTENSION = ".dwf.ts";

/** Project-scope directory, relative to the session working directory. */
export const SAVED_WORKFLOW_PROJECT_DIR = ".zcode/workflows";

/**
 * Draft directory, relative to the session working directory. Script files that the model
 * edits in place between submissions live here. It is a sibling of `.zcode/workflows/`
 * (user-saved definitions), is machine-owned, and includes `.gitignore: *`.
 */
export const WORKFLOW_DRAFTS_DIR = ".zcode/workflow-drafts";

/**
 * Global-scope directory, relative to the agent process's home directory. Files are stored at
 * `~/.zcode/workflows/<name>.dwf.ts`, the same user root as the legacy Workflow tool, and are
 * visible to all projects.
 */
export const SAVED_WORKFLOW_GLOBAL_DIR = ".zcode/workflows";

/**
 * Valid name shape. Matches the parser used by the old `Workflow` tool
 * (script-workflow-tool-port.ts). Names are also used as file names, so slashes, `..`, and
 * whitespace are prohibited: this regex **is** the path-traversal defense, not a style choice.
 */
export const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;

/** Maximum name length. 64 works as a file name on every platform, stays well below any PATH_MAX, and is descriptive enough. */
export const SAVED_WORKFLOW_MAX_NAME_CHARS = 64;

/**
 * Scope has two values: `project` stores the definition in the project's `.zcode/workflows/`,
 * visible only in that project; `global` stores it under `~/.zcode/workflows/` (the agent
 * process's home directory), visible to all projects. A file's scope is inferred from its
 * directory and is not stored in frontmatter.
 */
export const SAVED_WORKFLOW_SCOPES = ["project", "global"] as const;

export const SavedWorkflowScopeSchema = z.enum(SAVED_WORKFLOW_SCOPES);

export type SavedWorkflowScope = z.infer<typeof SavedWorkflowScopeSchema>;

/**
 * Shadowing fact: a same-named definition exists in the other scope. Computed during save and
 * shown in the confirmation dialog.
 * `hides_global`: this save is project-scoped and will shadow a same-named global definition
 * in this project.
 * `hidden_by_project`: this save is global, and a same-named project definition will shadow it
 * in this project.
 */
export const SAVED_WORKFLOW_SHADOWING = ["hides_global", "hidden_by_project"] as const;

export const SavedWorkflowShadowingSchema = z.enum(SAVED_WORKFLOW_SHADOWING);

export type SavedWorkflowShadowing = z.infer<typeof SavedWorkflowShadowingSchema>;

/**
 * Argument type vocabulary. Three primitives plus a `json` catch-all: primitives can validate
 * that a value was passed with the wrong type, while `json` explicitly means "accept anything."
 * This distinguishes "not validated" from "validation not configured" in the declaration,
 * rather than leaving both as the same hole.
 */
export const SAVED_WORKFLOW_ARG_TYPES = ["string", "number", "boolean", "json"] as const;

export const SavedWorkflowArgTypeSchema = z.enum(SAVED_WORKFLOW_ARG_TYPES);

export type SavedWorkflowArgType = z.infer<typeof SavedWorkflowArgTypeSchema>;

export const SavedWorkflowArgDeclarationSchema = z
  .object({
    type: SavedWorkflowArgTypeSchema.describe(
      'Value type. "json" accepts any JSON value without further checking.',
    ),
    description: z
      .string()
      .optional()
      .describe("What this argument means, for whoever calls the workflow later."),
    required: z
      .boolean()
      .optional()
      .describe("When true the workflow cannot run without this argument."),
    // `default` is deliberately unknown rather than a union discriminated by `type`: after
    // **applying defaults**, validateWorkflowArgs checks default and supplied values through
    // the same path, keeping one rule instead of two.
    default: z.unknown().optional().describe("Value used when the caller omits this argument."),
  })
  .strict();

export type SavedWorkflowArgDeclaration = z.infer<typeof SavedWorkflowArgDeclarationSchema>;

export const SavedWorkflowArgsDeclarationSchema = z.record(SavedWorkflowArgDeclarationSchema);

export type SavedWorkflowArgsDeclaration = z.infer<typeof SavedWorkflowArgsDeclarationSchema>;

/**
 * Metadata body in frontmatter. `.strict()` makes a misspelled key a visible invalid row
 * rather than a silently discarded field; users edit saved files by hand, so typos must be
 * reported.
 */
export const SavedWorkflowMetaSchema = z
  .object({
    description: z.string().min(1),
    whenToUse: z.string().min(1).optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();

export type SavedWorkflowMeta = z.infer<typeof SavedWorkflowMetaSchema>;

/** One list row: metadata + location, **without the script body** (listing does not read files). */
export const SavedWorkflowEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    whenToUse: z.string().optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
    scope: SavedWorkflowScopeSchema,
    path: z.string().min(1),
  })
  .strict();

export type SavedWorkflowEntry = z.infer<typeof SavedWorkflowEntrySchema>;

/**
 * A file that exists but cannot be read. The list **must not fail because one file is invalid**:
 * if a user breaks frontmatter while editing it, other workflows must remain available, and
 * the invalid file must be identified so it does not simply disappear.
 */
export const SavedWorkflowInvalidEntrySchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export type SavedWorkflowInvalidEntry = z.infer<typeof SavedWorkflowInvalidEntrySchema>;

/** Whether a name is valid as a file name (and could therefore identify a saved workflow). */
export function isValidSavedWorkflowName(name: string): boolean {
  if (name.length === 0 || name.length > SAVED_WORKFLOW_MAX_NAME_CHARS) return false;
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) return false;
  // `.` and `..` pass the character-set check above but are directory entries, not names.
  return name.replaceAll(".", "").length > 0;
}
