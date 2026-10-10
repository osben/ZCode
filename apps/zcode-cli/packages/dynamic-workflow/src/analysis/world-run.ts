/**
 * Compile-time command collection for world.run.
 *
 * The authorization model for `world.run` is **approve + pin**: cmd must be a compile-time string
 * literal, so the script's command set is closed before submission—the confirmation dialog shows
 * it, and the driver revalidates it at execution. A cmd formed only at runtime has no authorization
 * object to display, so report a located diagnostic instead of a runtime rejection (teach the
 * correction at the cheaper stage, as with the facade-siting rule).
 *
 * Inspect only the first argument: args arrays and opts may contain runtime values (interpolating
 * ask results into args is exactly how data edges arise). What is pinned is “which command to run,”
 * not “what to run it with.”
 */

import ts from "typescript";
import type { CompileDiagnostic, WorkflowProgram } from "../compiler/compile.js";
import type { SiteTable } from "./sites.js";

/** Diagnostic code for non-literal world.run cmd (9001 = facade-siting, 9002 = schema; continue from there). */
export const WORLD_RUN_LITERAL_CODE = 9003;

export interface WorldRunCommands {
  /** Script-declared command set: deduplicated and lexically sorted (shared by the confirmation dialog and driver revalidation). */
  commands: string[];
  /** Located diagnostic for non-literal cmd; any diagnostic blocks submission. */
  diagnostics: CompileDiagnostic[];
}

/**
 * Collect world.run commands from the site table. cmd must be a string literal without
 * substitutions (`"lean"` or `` `lean` ``—`ts.isStringLiteralLike` covers both; reject interpolated
 * templates and arbitrary expressions).
 */
export function collectWorldRunCommands(
  workflow: WorkflowProgram,
  table: SiteTable,
): WorldRunCommands {
  const commands = new Set<string>();
  const diagnostics: CompileDiagnostic[] = [];
  for (const site of table.worldReads) {
    if (site.op !== "run") continue;
    const cmd = site.args[0];
    if (cmd !== undefined && ts.isStringLiteralLike(cmd)) {
      commands.add(cmd.text);
      continue;
    }
    // Typecheck catches an arity error (missing cmd) first: a missing value reaching this point
    // means the call should not have compiled. Still, diagnostic collection should not rely on that
    // inference; report at the site and prefer one extra located error.
    const loc = cmd === undefined ? site.loc : workflow.toScriptLoc(cmd.getStart());
    diagnostics.push({
      code: WORLD_RUN_LITERAL_CODE,
      column: loc.column,
      line: loc.line,
      message:
        "world.run's first argument must be a compile-time string literal (\"lean\" or a " +
        "no-substitution template): the script's command set is shown to the user at " +
        "confirmation and only those commands are executable. Move the command name out of " +
        "the variable/template, and put runtime values in the args array instead.",
    });
  }
  return { commands: [...commands].sort(), diagnostics };
}
