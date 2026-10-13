// ============================================================
// "Compile once": one ts.Program simultaneously feeds the site table, schema synthesis, and lowering
// ============================================================
// Extracted from dynamic-workflow-run-submit.ts (max-lines gate): submit / amend use compileOnce; resume first
// takes diagnostics from the same Program (boundedResumeDiagnostics) then hands off to compileProgram. Pure
// compilation — it never touches the registry or the journal.

import { createHash } from "node:crypto";
import {
  buildAskSpecs,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  collectPhaseNames,
  collectSitePhases,
  deriveActorSubmitProfiles,
  interpret,
  lowerWorkflow,
  projectControlFlow,
  synthesizeAskSchemas,
  type CompileDiagnostic,
  type SiteTable,
  type WorkflowProgram,
} from "@zcode/dynamic-workflow";
import { projectSiteGraph } from "@zcode/dynamic-workflow/projections";
import { compiledHolesOf } from "./dynamic-workflow-run-holes.js";
import type { CompiledDynamicWorkflowScript } from "./dynamic-workflow-run-launch.js";

/**
 * Compile once: one ts.Program simultaneously feeds the site table, schema synthesis, and lowering.
 *
 * A dirty script hard-fails here and **creates no run**: the handler only calls submit when `ok`, so a dirty script
 * reaching this point can only be a wiring error. The defensive checks read the diagnostics of that same compiled
 * program and never spin up a second Program (that would break "compile once"). Resume recompiles the journal's
 * original text with this same function — a byte-identical script necessarily passes the same checks again.
 */
export function compileOnce(scriptText: string): CompiledDynamicWorkflowScript {
  return compileProgram(scriptText, createWorkflowProgram(scriptText));
}

/** Upper bound for diagnostics inside the resume rejection text (same magnitude as the hub-launched compile_failed). */
const RESUME_DIAGNOSTICS_MAX_CHARS = 2000;

/** Human-readable compile_failed diagnostics: one `L:C message` per line, bounded overall. */
export function boundedResumeDiagnostics(runId: string, diagnostics: CompileDiagnostic[]): string {
  const body = [
    `The stored script of run ${runId} no longer compiles against the current workflow facade:`,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > RESUME_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, RESUME_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}

/**
 * The second half of compileOnce: site table / schema synthesis / lowering on the **already built** Program. Resume
 * first takes diagnostics from the same Program and then hands it here, still "compile once" (the Program caches its
 * own diagnostics; re-reading does not recompute).
 */
export function compileProgram(
  scriptText: string,
  workflow: WorkflowProgram,
  /**
   * The site table already collected (the completion service collected it once before its stability re-check; no
   * need to walk it again on the same Program). Absent means collect here.
   */
  collected?: SiteTable,
): CompiledDynamicWorkflowScript {
  const diagnostics = [
    ...workflow.program.getSyntacticDiagnostics(),
    ...workflow.program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script that does not typecheck (${diagnostics.length} diagnostics); no run was created`,
    );
  }

  const table = collected ?? collectSites(workflow);
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table);
  if (schemaDiagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with unsupported ask result types: ${schemaDiagnostics
        .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  // world.run's authorization surface is exactly the compile-time literals (9003) + the confirmation window's
  // display; the driver no longer keeps a separate command set for re-verification (workflow-world-read.ts file
  // header, item 2). Non-literal cmds are already blocked in the handler's analyze stage;
  // one appearing here is a wiring error — hard-fail without creating a run.
  const worldRun = collectWorldRunCommands(workflow, table);
  if (worldRun.diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with non-literal world.run commands (${worldRun.diagnostics.length} diagnostics); no run was created`,
    );
  }

  // buildAskSpecs is the only correct way to build askSpecs: untyped sites are explicitly recorded {typed:false}.
  // Building from schemas' keys would make untyped sites vanish entirely, and the engine hard-fails an absent site as a wiring error.
  const askSpecs = buildAskSpecs(table, schemas);

  // One interpretation on the **same** Program (analyzeWorkflowScript already ran on this exact text in the
  // handler's analyze stage), still "compile once"; both artifacts are read from the same core: the submit profile
  // goes through the site graph projection, while the lexical birth phase table reads the trace directly
  // (docs/execution-engine.md "Identity: sites, ordinals, phases").
  // Resume recomputes over byte-identical text with this same function, so determinism holds.
  const core = interpret(workflow, table);
  const lowered = lowerWorkflow(workflow, table);

  return {
    askSpecs,
    // Each actor site's submit profile (docs/execution-engine.md "Submit profiles").
    actorSubmitProfiles: deriveActorSubmitProfiles(projectSiteGraph(core), askSpecs),
    sitePhases: collectSitePhases(core),
    lowered: lowered.code,
    // Holes (docs/execution-engine.md "Holes"): a filled hole's body text is the `code` the completion handed to
    // the engine — produced by the same lowering as the rest of the script, so the text executed when filled now
    // and replayed later is byte-for-byte identical; the hole's compile-time facts table (name / type / line) feeds
    // snapshots and progress payloads; the phase table comes from the control-flow projection (holes are
    // placeholders by name, same source as contracts' createWorkflowPhaseNames), so the recomputed table after a
    // fill aligns with the launch-time table under the same rule.
    holeBodies: lowered.holeBodies,
    holes: compiledHolesOf(table),
    phases: collectPhaseNames(projectControlFlow(core)),
    // scriptHash's ownership lives **here**, not in the harness. The harness receives both scriptText and lowered
    // and deliberately does not check their consistency — checking would mean compiling again, exactly the pass
    // "compile once" exists to avoid (harness.ts writes this down as a caller invariant). So the hash must be taken
    // over the author's original text: if the harness hashed "the text it saw", the lowered path would persist the
    // lowered body's hash while resume compares against the author's original — the comparison would silently
    // misalign. This function produces lowered and hash from the same compilation, so they are consistent by construction.
    scriptHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
  };
}
