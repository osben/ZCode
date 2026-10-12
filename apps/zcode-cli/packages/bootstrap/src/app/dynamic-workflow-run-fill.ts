// ============================================================
// Dynamic Workflow Run Service: fill in the body of one waiting hole
// ============================================================
// docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"; engine docs "Holes" → "The fill
// service's checks". This is the implementation body of `DynamicWorkflowRunPort.fillHole`, sharing the
// posture of `retuneConcurrency` and kept apart from the three launch entries: it mints no run at all, it
// only says one thing to the run already in flight.
//
// The order is the whole of the semantics, and **a refusal has zero side effects** (the hole stays waiting):
//   1. Find the run (journal row ∪ registry) → `run_not_found`; not in flight in this process → `hole_not_waiting`;
//   2. Read the run's script at this moment, collect the site table, locate the open hole by site id → absent
//      / already filled → `hole_not_waiting`;
//   3. Splice the body in as the call's last argument (`spliceHoleBody`), run the same analysis as submission
//      over the **entire** effective script, then check that every named model is in this run's binding table
//      (diagnostics are attributed by landing spot to inside the body / inside the draft) → `compile_failed`;
//   4. Site stability recheck (`checkSiteStability`): not a single old id missing, positions shifted only by
//      the inserted line count, and every new id written by this fill (prefixed with the filled hole, or a
//      newly left hole in the body and its in-body sites) → failing that is a host fault →
//      `fill_ids_unstable`;
//   5. Hand `holeBodies[siteId]`, the effective script, and its spec table / phase table to the engine through
//      the control plane (in one synchronous step `fillHole` writes back the run row, records `hole-filled`,
//      and releases the parked branch) → `not_waiting` / `settled` → `hole_not_waiting`;
//   6. Only after the engine accepts does the host side change: the registry entry is replaced with the
//      effective script's facts, the draft is rewritten **in place**, and `scriptPath` stays the same. A draft
//      write failure does not undo the fill — the journal is already the truth; the draft is only a handle.
//
// The only thing persisted before the engine is **the fresh draft of a run that had no draft**: its path must
// enter the journal with `hole-filled` (the cold read surface relies on it to find this draft after a
// restart), and the event is recorded by the engine in the same synchronous step, so it can only be minted
// first. If the engine then refuses (a race: just settled / not waiting), this just-minted file is deleted —
// "never delete a draft" refers to drafts the model has edited; a file created milliseconds ago, exclusively
// by this call, seen by no one, is not among them.

import { rm, writeFile } from "node:fs/promises";
import type { DynamicWorkflowRunFillHoleRequest, FillWorkflowHoleResult } from "@zcode/contracts";
import {
  analyzeWorkflowScript,
  checkSiteStability,
  collectPhaseNames,
  collectSites,
  createWorkflowProgram,
  interpret,
  projectControlFlow,
  spliceHoleBody,
  type SiteTable,
  type WorkflowProgram,
} from "@zcode/dynamic-workflow";
import { compileProgram } from "./dynamic-workflow-run-compile.js";
import { mapFillDiagnostics, unboundFillModelDiagnostics } from "./dynamic-workflow-run-holes.js";
import type { RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

/** Service internal state borrowed by this module; all references — this file holds no state of its own. */
export interface DynamicWorkflowRunFillContext {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  /**
   * Per-run fill serialization chain (see {@link fillDynamicWorkflowHole}): runId → the last fill enqueued for
   * that run. The key is deleted as soon as the chain drains; it does not live for the run's whole life. The
   * service holds the one map.
   */
  fillQueues: Map<string, Promise<unknown>>;
}

/**
 * Fills of the same run execute **serially**. Bug root cause (2026-09-28 review): a run can be parked at two
 * holes at once (one in each of two futures, or one in each of two branches), and the model may put two
 * FillWorkflowHole calls into the same parallel batch; this function has an await between reading
 * `entry.scriptText` and handing the effective script to the engine (minting a draft first when there is
 * none), so the second call would splice against the text from **before the first fill**, and the engine's
 * `updateRunScript` would then overwrite the first body wholesale. So each fill starts only after the run's
 * previous fill has **fully returned**, and the script is read only on its own turn; a previous refusal (or
 * even a throw) does not block the next. Different runs do not queue behind each other.
 */
export function fillDynamicWorkflowHole(
  ctx: DynamicWorkflowRunFillContext,
  request: DynamicWorkflowRunFillHoleRequest,
): Promise<FillWorkflowHoleResult> {
  const { runId } = request;
  const previous = ctx.fillQueues.get(runId) ?? Promise.resolve();
  const turn = previous.then(
    () => fillOnce(ctx, request),
    () => fillOnce(ctx, request),
  );
  // What hangs on the chain is the fact of "having ended", success or failure alike; the key is deleted as soon as the chain drains (only the entry that is still ours).
  const settled: Promise<unknown> = turn.then(
    () => undefined,
    () => undefined,
  );
  ctx.fillQueues.set(runId, settled);
  void settled.then(() => {
    if (ctx.fillQueues.get(runId) === settled) ctx.fillQueues.delete(runId);
  });
  return turn;
}

/** Fallback name for minting a draft when the run has no name and an empty phase table (the same fallback word as the tool side). */
const DRAFT_FALLBACK_NAME = "workflow";

type Refusal = Extract<FillWorkflowHoleResult, { ok: false }>;

async function fillOnce(
  ctx: DynamicWorkflowRunFillContext,
  request: DynamicWorkflowRunFillHoleRequest,
): Promise<FillWorkflowHoleResult> {
  const { deps, runs } = ctx;
  const { runId, holeId } = request;
  const entry = runs.get(runId);
  const record = deps.journal.getRun(runId);
  if (entry === undefined && record === undefined) {
    return refuse("run_not_found", `No run with id ${runId}.`);
  }
  // In-flight determination looks at **this process's registry**: if the journal says running but it is not
  // here, it is another process's run (or a dead one), and this service cannot reach its engine. A stopped run
  // is pointed at ResumeWorkflowRun — resume will reach the hole again and ask once more.
  if (entry === undefined || entry.terminal !== undefined || entry.control === undefined) {
    const status = entry?.terminal?.status ?? record?.status;
    const hint =
      status === "stopped"
        ? `Run ${runId} is stopped; ResumeWorkflowRun it first, after which the hole asks again.`
        : status === "completed" || status === "errored"
          ? `Run ${runId} has ended (${status}); nothing is waiting.`
          : `Run ${runId} is not in flight in this session.`;
    return refuse("hole_not_waiting", hint);
  }

  // 2. The run's script at this moment (the entry's copy is the one the engine holds: a fill replaces it
  //    synchronously). Read only on our own turn — fills queued ahead have already swapped it for the
  //    effective script carrying that body.
  const scriptText = entry.scriptText;
  const workflow = createWorkflowProgram(scriptText);
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

  // 3. Splice + the same analysis as submission (9012 and the other authoring rules are all inside).
  const spliced = spliceHoleBody(scriptText, before, holeId, request.body);
  if (spliced === undefined) {
    return refuse("hole_not_waiting", `${holeId} of run ${runId} cannot take a body.`);
  }
  // Model names can only come from this run's binding table (see unboundFillModelDiagnostics): the table lives
  // on the entry and fills are serialized per run, so what is read here is exactly the one the subagent session
  // creation will consult.
  const analysis = analyzeWorkflowScript(spliced.text);
  const diagnostics = analysis.ok
    ? unboundFillModelDiagnostics(analysis.modelReferences, entry.modelBindings)
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
        body: request.body,
        insertedAtLine: spliced.insertedAtLine,
        insertedLines: spliced.insertedLines,
      }),
    };
  }

  // 4. The stability recheck happens before compilation: compiling (schema synthesis, lowering) a script with misaligned ids is effort paid for nothing.
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
    deps.logger?.error?.("Dynamic workflow hole fill renumbered an existing site", undefined, {
      detail: stability.detail,
      event: "dynamic_workflow.fill.ids_unstable",
      holeId,
      module: "bootstrap.app",
      runId,
    });
    return refuse(
      "fill_ids_unstable",
      `The compiled effective script renumbered an existing site (${stability.detail}). This is a host fault, not a problem with the body; the hole is still waiting.`,
    );
  }
  const compiled = compileProgram(spliced.text, effective, after);
  const code = compiled.holeBodies[holeId];
  if (code === undefined) {
    // The splice succeeded and stability passed, yet lowering produced no body for this hole: the only
    // possibility is contract drift between the analyzer and lowering. Report it as a host fault instead of
    // handing undefined to the engine.
    return refuse(
      "fill_ids_unstable",
      `Lowering produced no body for ${holeId}; this is a host fault and the hole is still waiting.`,
    );
  }

  // 5. Hand it to the engine (one synchronous step: swap the tables, write back the effective script, record
  //    hole-filled, release the parked branch). A run without a draft has one minted first (see the file
  //    header); the path lands in the journal with the event.
  const minted =
    entry.scriptPath === undefined ? await mintDraft(ctx, entry, spliced.text) : undefined;
  const filledBy =
    request.parentSessionId === undefined ? {} : { filledBy: String(request.parentSessionId) };
  const result = entry.control.fillHole({
    siteId: holeId,
    code,
    script: { text: spliced.text, hash: compiled.scriptHash },
    askSpecs: compiled.askSpecs,
    sitePhases: compiled.sitePhases,
    phaseNames: compiled.phases.phaseNames,
    ...(compiled.phases.holes.length === 0 ? {} : { holes: compiled.phases.holes }),
    ...filledBy,
    ...(minted === undefined ? {} : { scriptPath: minted }),
  });
  if (result === undefined || !result.ok) {
    if (minted !== undefined) await discardMintedDraft(ctx, runId, minted);
    const reason = result?.reason;
    deps.logger?.info?.("Dynamic workflow hole fill refused by the engine", {
      event: "dynamic_workflow.fill.refused",
      holeId,
      module: "bootstrap.app",
      reason: reason ?? "engine_unbound",
      runId,
    });
    return refuse(
      "hole_not_waiting",
      reason === "settled"
        ? `Run ${runId} has already settled; nothing is waiting.`
        : `Run ${runId} is not waiting at ${holeId}: it has not reached it yet, or it is already filled.`,
    );
  }

  // 6. The engine accepted: the host-side facts follow (the script, hole table, and phase table must describe the same script), then the draft is written.
  const previousPhases = phaseNamesOf(workflow, before);
  entry.scriptText = spliced.text;
  entry.holes = compiled.holes;
  entry.phaseNames = compiled.phases.phaseNames;
  if (minted !== undefined) entry.scriptPath = minted;
  else await rewriteDraft(ctx, entry, runId, spliced.text);
  const scriptPath = entry.scriptPath;
  deps.logger?.info?.("Dynamic workflow hole filled", {
    event: "dynamic_workflow.fill.applied",
    holeId,
    module: "bootstrap.app",
    runId,
    ...(scriptPath === undefined ? {} : { scriptPath }),
  });
  return {
    ok: true,
    phasesAdded: compiled.phases.phaseNames.filter((name) => !previousPhases.has(name)),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    scriptText: spliced.text,
  };
}

function refuse(reason: Refusal["reason"], message: string): Refusal {
  return { ok: false, reason, message };
}

/** The pre-splice script's phase table (the same projection rule); the comparison basis for `phasesAdded`. */
function phaseNamesOf(workflow: WorkflowProgram, table: SiteTable): Set<string> {
  return new Set(collectPhaseNames(projectControlFlow(interpret(workflow, table))).phaseNames);
}

/**
 * In-place draft rewrite (docs/dynamic-workflow/launch.md "The draft after a fill"): if the run has a draft,
 * rewrite that file and keep the path — the sole exception to "a draft is never overwritten behind the
 * model's back"; this write is exactly what the model asked for.
 * Best effort: if it cannot be written, log one warn and keep the path (the file is still there, just stale;
 * the log says why).
 */
async function rewriteDraft(
  ctx: DynamicWorkflowRunFillContext,
  entry: RunRegistryEntry,
  runId: string,
  text: string,
): Promise<void> {
  if (entry.scriptPath === undefined) return;
  try {
    await writeFile(entry.scriptPath, text, "utf8");
  } catch (error) {
    ctx.deps.logger?.warn?.("Dynamic workflow draft could not be rewritten after a fill", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.fill.draft_rewrite_failed",
      module: "bootstrap.app",
      runId,
      scriptPath: entry.scriptPath,
    });
  }
}

/**
 * For a run without a draft, mint one by the inline rules (the rules live in the tool layer, injected via
 * deps); if minting fails (not injected, or the write fails), return `undefined` — the fill still succeeds,
 * the reply just carries no path.
 */
async function mintDraft(
  ctx: DynamicWorkflowRunFillContext,
  entry: RunRegistryEntry,
  text: string,
): Promise<string | undefined> {
  const minted = await ctx.deps.writeWorkflowDraft?.({
    cwd: entry.cwd,
    name: entry.name ?? entry.phaseNames?.[0] ?? DRAFT_FALLBACK_NAME,
    source: text,
  });
  return minted?.path;
}

/** The engine refused this fill: the draft just minted for it has been seen by no one, so delete it (see the file header); if deletion fails, only log. */
async function discardMintedDraft(
  ctx: DynamicWorkflowRunFillContext,
  runId: string,
  path: string,
): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    ctx.deps.logger?.warn?.(
      "Dynamic workflow draft minted for a refused fill could not be removed",
      {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.fill.minted_draft_orphaned",
        module: "bootstrap.app",
        runId,
        scriptPath: path,
      },
    );
  }
}
