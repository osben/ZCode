// ============================================================
// Effective script used to preview the FillWorkflowHole confirmation dialog.
// ============================================================
// docs/dynamic-workflow/launch.md, “Approval”: when a run from another session opens a dialog, show the graph of the **effective script**
// (with the function body inserted). Actual splicing and compilation happen in the port implementation after approval. So resolveInput
// splices it here in advance only to give prepareApproval a graph to render; this is not the execution path—the port's `fillHole` is.
//
// The splice itself is `spliceHoleBody` in the analyzer package (apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md,
// “Sites”): the function body is inserted before the hole call's closing parenthesis, and the analyzer guarantees site ID numbering.

import { collectSites, createWorkflowProgram, spliceHoleBody } from "@zcode/dynamic-workflow";

/**
 * Splice the function body into the run's script and return the effective script text. Return `undefined` if splicing fails
 * (unknown or already-filled hole, or the script cannot produce a site table); the caller then opens the dialog without a preview. Never throw.
 */
export function spliceHoleBodyPreview(
  scriptText: string,
  holeSiteId: string,
  body: string,
): string | undefined {
  try {
    const table = collectSites(createWorkflowProgram(scriptText));
    return spliceHoleBody(scriptText, table, holeSiteId, body)?.text;
  } catch {
    return undefined;
  }
}
