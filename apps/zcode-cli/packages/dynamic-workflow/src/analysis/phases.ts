/**
 * Compile-time validation for `phase("…")` markers.
 *
 * Two rules, for the same reason—**the marker's meaning must be clear before submission**. The
 * name must be a compile-time literal because the phase list is shown in the confirmation dialog
 * (as with `world.run`'s cmd, a name formed at runtime has nothing displayable). The call must be a
 * standalone statement because the marker means “from here to the end of the block”; a marker in
 * an initializer / argument / ternary arm has no well-defined scope. Both are **located
 * diagnostics**, not runtime fallbacks, so corrections happen at the cheaper stage.
 *
 * Alias escape (`const p = phase`) is not handled here—phase is declared by the facade, and
 * facade-misuse pass 1 already rejects references outside direct call positions.
 */

import ts from "typescript";
import type { CompileDiagnostic, ScriptLoc, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** Diagnostic code for phase markers (9001 = facade-siting, 9002 = schema, 9003 = world-run; continue from there). */
export const PHASE_MARKER_CODE = 9004;

const LITERAL_MESSAGE =
  'phase()\'s argument must be a compile-time string literal ("gate" or a no-substitution ' +
  "template): the script's phase names are fixed when it is submitted, because they label " +
  "the graph the user confirms before anything runs. Write the name inline — a name that " +
  "only exists at run time cannot be drawn.";

const EMPTY_MESSAGE =
  'phase("") has no name to show: the phase label is what the confirmation graph draws. ' +
  'Give the group a word ("preflight", "gate", "wrap-up"), or drop the marker — a script ' +
  "with no markers is perfectly legal and is drawn step by step.";

const STATEMENT_MESSAGE =
  'phase("…") must stand alone as its own statement. The marker claims the rest of the block ' +
  "it stands in, so one in expression position (a variable initializer, an argument, a " +
  "ternary arm) has no rest-of-block to claim. Put the call on its own line at the head of " +
  "the steps it names.";

/**
 * Validate collected phase markers. Any diagnostic blocks submission (`analyzeWorkflowScript`
 * handles it alongside misuse / world.run).
 *
 * A marker can violate both rules at once (`const x = phase(bad)`); report both so the author sees everything to fix at once.
 */
export function collectPhaseMarkerDiagnostics(
  workflow: WorkflowProgram,
  table: SiteTable,
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const push = (loc: ScriptLoc, message: string): void => {
    diagnostics.push({ code: PHASE_MARKER_CODE, column: loc.column, line: loc.line, message });
  };

  for (const marker of table.phases) {
    // Locate the name diagnostic on the **expression with the problem** (fall back to the call site
    // when absent); that is the expression the author needs to change.
    const nameLoc =
      marker.nameExpr === undefined
        ? marker.loc
        : workflow.toScriptLoc(marker.nameExpr.getStart(workflow.scriptFile));
    if (marker.name === undefined) {
      push(nameLoc, LITERAL_MESSAGE);
    } else if (marker.name.trim() === "") {
      push(nameLoc, EMPTY_MESSAGE);
    }
    if (!ts.isExpressionStatement(marker.call.parent)) {
      push(marker.loc, STATEMENT_MESSAGE);
    }
  }
  return diagnostics;
}
