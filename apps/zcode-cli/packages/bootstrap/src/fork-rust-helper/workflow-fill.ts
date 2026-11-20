import {
  analyzeWorkflowScript,
  checkSiteStability,
  collectPhaseNames,
  collectSites,
  createWorkflowProgram,
  interpret,
  projectControlFlow,
  spliceHoleBody,
} from "@zcode/dynamic-workflow";
import { compileProgram } from "../app/dynamic-workflow-run-compile.js";
import { mapFillDiagnostics, unboundFillModelDiagnostics } from "../app/dynamic-workflow-run-holes.js";
import { parseParams } from "../zcode-protocol/server-types.js";
import { jsonShape } from "./workflow-compile.js";
import { workflowFillPrepareParamsSchema } from "./workflow-protocol.js";

type Refusal = {
  ok: false;
  reason: "hole_not_waiting" | "compile_failed" | "fill_ids_unstable";
  message: string;
  diagnostics?: unknown[];
};

/**
 * `helper/workflow/fillPrepare` (W7-12, specs/fork-rust-workflow-engine.md, 9.45): steps 2 to 4 and the compile of Node's
 * `fillOnce` (`bootstrap/src/app/dynamic-workflow-run-fill.ts`), in the same order and with the same texts. It splices the
 * body into the run's script, runs the submission analysis over the whole effective script, checks that existing site ids
 * kept their places, and compiles the effective script to take the hole's code. It writes nothing and starts nothing; the
 * Rust run service asks the owner to apply the result.
 */
export function fillPrepareForRust(raw: unknown): Refusal | Record<string, unknown> {
  const params = parseParams(workflowFillPrepareParamsSchema, raw);
  const { runId, holeId } = params;
  const workflow = createWorkflowProgram(params.scriptText);
  const before = collectSites(workflow);
  const site = before.holes.find((hole) => hole.id === holeId);
  if (site === undefined) {
    const known = before.holes.map((hole) => `${hole.id} (${hole.name ?? "?"})`).join(", ");
    return refuse(
      "hole_not_waiting",
      `${holeId} is not a hole of run ${runId}${known === "" ? "" : `; its holes are ${known}`}.`,
    );
  }
  if (site.body !== undefined) {
    return refuse("hole_not_waiting", `${holeId} of run ${runId} is already filled.`);
  }

  const spliced = spliceHoleBody(params.scriptText, before, holeId, params.body);
  if (spliced === undefined) {
    return refuse("hole_not_waiting", `${holeId} of run ${runId} cannot take a body.`);
  }
  const analysis = analyzeWorkflowScript(spliced.text);
  const diagnostics = analysis.ok
    ? unboundFillModelDiagnostics(analysis.modelReferences, params.modelBindings ?? {})
    : analysis.diagnostics;
  if (diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: `The effective script does not compile (${diagnostics.length} diagnostic${
        diagnostics.length === 1 ? "" : "s"
      }); nothing was spliced and the hole is still waiting.`,
      diagnostics: mapFillDiagnostics({
        diagnostics,
        effectiveText: spliced.text,
        body: params.body,
        insertedAtLine: spliced.insertedAtLine,
        insertedLines: spliced.insertedLines,
      }),
    };
  }

  const effective = createWorkflowProgram(spliced.text);
  const after = collectSites(effective);
  const stability = checkSiteStability(
    before,
    after,
    holeId,
    spliced.insertedAtLine,
    spliced.insertedLines,
  );
  if (!stability.ok) {
    return refuse(
      "fill_ids_unstable",
      `The compiled effective script renumbered an existing site (${stability.detail}). This is a host fault, not a problem with the body; the hole is still waiting.`,
    );
  }
  // The compile throws for gates the analysis does not run (the unsupported ask result types, for one). Like the
  // CreateWorkflow compile, that is a refusal the caller can read, not an RPC fault: the hole stays waiting.
  let compiled;
  try {
    compiled = compileProgram(spliced.text, effective, after);
  } catch (error) {
    return {
      ok: false,
      reason: "compile_failed",
      message: error instanceof Error ? error.message : String(error),
      diagnostics: [],
    };
  }
  const code = compiled.holeBodies[holeId];
  if (code === undefined) {
    return refuse(
      "fill_ids_unstable",
      `Lowering produced no body for ${holeId}; this is a host fault and the hole is still waiting.`,
    );
  }

  const previousPhases = new Set(
    collectPhaseNames(projectControlFlow(interpret(workflow, before))).phaseNames,
  );
  const phaseNames = compiled.phases.phaseNames;
  const shaped = jsonShape({
    askSpecs: compiled.askSpecs,
    sitePhases: compiled.sitePhases,
  }) as { askSpecs: Record<string, unknown>; sitePhases: Record<string, unknown> };
  return {
    ok: true,
    effectiveText: spliced.text,
    scriptHash: compiled.scriptHash,
    code,
    askSpecs: shaped.askSpecs,
    sitePhases: shaped.sitePhases,
    phaseNames,
    ...(compiled.phases.holes.length === 0 ? {} : { holes: compiled.phases.holes }),
    phasesAdded: phaseNames.filter((name) => !previousPhases.has(name)),
  };
}

function refuse(reason: Refusal["reason"], message: string): Refusal {
  return { ok: false, reason, message };
}
