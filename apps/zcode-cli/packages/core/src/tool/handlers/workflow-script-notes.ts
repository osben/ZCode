// ============================================================
// Three model-facing sentences about script files
// ============================================================
//
// Tool responses are one of three readers (the others are terminal notifications and `GetWorkflowRun`), and all three should direct
// the model to the same next step: **edit that file**. Keep only one concern here: once the script file is known, how to format
// diagnostic lines and notes. `CreateWorkflow` and `AmendWorkflow` share this because “edit it and return it via `path`” should be the
// same sentence in both tools.
//
// When the file is unknown (for example, draft writing failed), emit no sentence; the caller keeps the previous message, which still
// tells the model to fix the script and submit it again.

import type { CreateWorkflowDiagnostic } from "@zcode/contracts";

/**
 * Model-facing identity of the script file. `kind` changes only one verb: `draft` is a copy **just written by the tool** (“saved at”),
 * while `path` is the file provided by the model (“The script file is”). Saying “saved at” for a file that already existed would imply
 * that the tool just modified it.
 */
export interface WorkflowScriptLocation {
  kind: "draft" | "path";
  /** Model-facing form (workspace-relative or absolute), computed by `describeWorkflowScriptPath`. */
  described: string;
  /** Offset from body lines to file lines; 0 when there is no metadata block. */
  lineOffset: number;
}

/**
 * Model-facing diagnostic line. With a file, format as `{path}:L{line}:C{column} {message}` using **file** line numbers so the
 * location can be pasted into an `Edit` for that file. Without a file, use the old `L:C` form (body line numbers).
 *
 * Do **not** change the output's `diagnostics` array or display payload: transcript views render the body, so body lines remain their coordinates.
 */
export function formatWorkflowDiagnosticLines(
  diagnostics: readonly CreateWorkflowDiagnostic[],
  location: WorkflowScriptLocation | undefined,
): string[] {
  if (location === undefined) {
    return diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    );
  }
  return diagnostics.map(
    (diagnostic) =>
      `${location.described}:L${diagnostic.line + location.lineOffset}:C${diagnostic.column} ${diagnostic.message}`,
  );
}

/**
 * NOTE for a script file that did not compile (inline and `path` sources). The final phrase captures the entire purpose of this feature:
 * **do not paste the script again**.
 */
export function workflowScriptFileNote(location: WorkflowScriptLocation): string {
  const where =
    location.kind === "draft"
      ? `The script is saved at ${location.described}.`
      : `The script file is ${location.described}.`;
  return `NOTE: The workflow was NOT executed. ${where} Edit that file in place and resubmit with \`path: "${location.described}"\` — do not paste the script inline again.`;
}

/**
 * NOTE for a saved-definition source that did not compile. Explain two additional things: **which definition** was copied (so the model
 * knows to edit the copy, not the definition), and that changing the definition itself requires `SaveWorkflow`. Arguments must be
 * passed again; the copy retains its metadata block and declarations, so submitting via `path` validates them too.
 */
export function workflowSavedDraftNote(options: {
  savedName: string;
  savedPath: string;
  draft: string;
}): string {
  return `NOTE: The workflow was NOT executed. A working copy of the saved workflow '${options.savedName}' (${options.savedPath}) was written to ${options.draft}. Edit that copy in place and resubmit with \`path: "${options.draft}"\` (pass its \`args\` again); to change the saved definition itself, use SaveWorkflow.`;
}

/** Sentence appended after a successful launch: edit this file for the next revision. */
export function workflowLaunchedScriptSentence(location: WorkflowScriptLocation): string {
  const where =
    location.kind === "draft"
      ? `The script is saved at ${location.described}`
      : `The script file is ${location.described}`;
  return ` ${where}; to revise it later, edit that file and pass \`path\` to AmendWorkflow.`;
}

/** Sentence appended after a successful revision launch (the same action applies to another revision). */
export function workflowAmendedScriptSentence(location: WorkflowScriptLocation): string {
  return ` The revision's script is at ${location.described}; edit it there for a further revision.`;
}
