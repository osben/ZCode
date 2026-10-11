// ============================================================
// Dynamic Workflow Run Service: three launch entry points (submit / amend / resume) and "compile once"
// ============================================================
// dynamic-workflow-run-service.ts reached oxlint's 400-line limit, so its `submit` and `resume`
// entry points, along with their shared mintRunId helper, moved here (compileOnce was split out
// further into dynamic-workflow-run-compile.ts). The public exports still come from
// dynamic-workflow-run-service.ts. The two entry points have opposite directions and never share a
// gate (invariant 1 in that file's header), but they share the same registry, quiescence table,
// and settlement bookkeeping. The service explicitly passes these through
// {@link DynamicWorkflowRunEntryContext}; this file owns no state of its own.

import { randomUUID } from "node:crypto";
import type {
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
  TraceContext,
} from "@zcode/contracts";
import {
  collectDiagnostics,
  createWorkflowProgram,
  type Caps,
  type ImportedRunCache,
  type RunSettlement,
} from "@zcode/dynamic-workflow";
import { formatModelPickerValue } from "@zcode/shared/model-selection";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  buildImportedCache,
  preflightAmendImport,
  rebuildImportedCacheForResume,
} from "./dynamic-workflow-import.js";
import {
  boundedResumeDiagnostics,
  compileOnce,
  compileProgram,
} from "./dynamic-workflow-run-compile.js";
import {
  openHoleIndexes,
  phaseNamesFromEvents,
  readRunHoleEvents,
} from "./dynamic-workflow-run-holes.js";
import { launchDynamicWorkflowRun } from "./dynamic-workflow-run-launch.js";
import {
  readRunLaunchAnchor,
  readRunModelBindings,
  readRunScriptPath,
  readRunSubagentModel,
  resolveLaunchAnchor,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { isResumableRecord, type RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";
import { workflowSubagentPermissionModeField } from "./workflow-actor-permission.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import { createWorkflowRunControl } from "./workflow-run-control.js";

/**
 * Internal service state used by both entry points. These are all **references**, not copies: the
 * registry and quiescence table belong to the service; `trackSettlement` is its settlement
 * bookkeeping (record terminal state, normalize failures, notify settlement); and `caps` computes
 * the upper bound from current concurrency for submit (resume reuses the caps recorded in the journal).
 */
export interface DynamicWorkflowRunEntryContext {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  escalations: WorkflowEscalationRegistry;
  /**
   * Caps for this launch. The input is the **requested** concurrency ceiling (`max_concurrency`
   * from `CreateWorkflow` / `AmendWorkflow`, normalized by the tool layer to a number or omitted):
   * omission means default concurrency; a supplied value is floored to at least 1, with no upper limit.
   */
  caps: (requestedMaxConcurrency?: number) => Caps;
  trackSettlement: (
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ) => Promise<RunSettlement>;
}

/** Implementation of `DynamicWorkflowRunPort.submit`: a fresh run with no predecessor or cache. */
export async function submitDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowRunSubmitRequest,
): Promise<DynamicWorkflowRunSubmitResult> {
  const runId = startNewRun(ctx, {
    runId: mintRunId(),
    scriptText: request.scriptText,
    cwd: request.cwd,
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.args === undefined ? {} : { args: request.args }),
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    ...(request.launchInputId === undefined ? {} : { launchInputId: request.launchInputId }),
    ...(request.phaseNames === undefined ? {} : { phaseNames: request.phaseNames }),
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    ...(request.subagentModel === undefined ? {} : { subagentModel: request.subagentModel }),
    ...(request.modelBindings === undefined ? {} : { modelBindings: request.modelBindings }),
    // The script file travels with the subagent model and passes through unchanged. The port does
    // not infer anything: whether a draft was saved is a tool-side fact, and omission means there is no file.
    ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
    ...(request.phaseAlongside === undefined ? {} : { phaseAlongside: request.phaseAlongside }),
    trace: request.trace,
  });
  return { ok: true, runId };
}

/**
 * Implementation of `DynamicWorkflowRunPort.amend`.
 *
 * The order defines the semantics:
 *   1. **Preflight** the predecessor (exists and has complete boundaries). A refusal changes
 *      nothing; the predecessor keeps running.
 *   2. Mint a new ID.
 *   3. If the predecessor is active, cancel it with `{ superseded: newRunId }` and **await its own
 *      settlement promise**—no timeout or journal polling. It then settles as
 *      `stopped(superseded, supersededBy)`.
 *   4. Wait a bounded time for the aborted turn to finish writing, then ask which sessions are
 *      safe to count. This affects continuation of in-flight asks only; completed-prefix boundaries
 *      are journal facts (see the full rationale below).
 *   5. Build a cache from the settled predecessor. Since preflight passed, any refusal here can
 *      only be a host failure and is propagated.
 *   6. Launch through the same path as a fresh submit, with `resumedFrom` and the cache.
 *
 * Previously, `submit({resumeFrom})` returned `not_amendable` for an active predecessor, forcing the
 * model through TaskStop → poll until stopped → resubmit. This method moves stop and settlement
 * waiting into the service, eliminating that race.
 */
export async function amendDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowRunAmendRequest,
): Promise<DynamicWorkflowRunAmendResult> {
  const { deps, runs } = ctx;
  const preflight = preflightAmendImport(deps.journal, request.predecessorRunId);
  if (!preflight.ok) {
    deps.logger?.info?.("Dynamic workflow amend refused", {
      event: "dynamic_workflow.amend.refused",
      module: "bootstrap.app",
      predecessorRunId: request.predecessorRunId,
      reason: preflight.reason,
    });
    return { ok: false, reason: preflight.reason };
  }
  const predecessor = preflight.run;
  const runId = mintRunId();

  // Determine liveness from **this process's registry**, not journal status. If the journal says
  // running but the registry has no entry, another process (or a dead process) owns the run; this
  // service cannot stop or await it. Treat it as settled and let the import builder's terminal-state
  // gate decide (a nonterminal run throws; see below).
  const live = runs.get(request.predecessorRunId);
  let supersededRunId: string | undefined;
  if (live !== undefined && live.terminal === undefined) {
    live.controller.abort({ superseded: runId });
    // Await the predecessor's settlement promise (the same promise as waitForTask; trackSettlement
    // guarantees it never rejects).
    await live.settlement;
    supersededRunId = request.predecessorRunId;
    deps.logger?.info?.("Dynamic workflow run superseded by an amendment", {
      event: "dynamic_workflow.amend.superseded",
      module: "bootstrap.app",
      predecessorRunId: request.predecessorRunId,
      runId,
    });
  }

  // Quiescence gate (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, "What is imported").
  //
  // Root cause: `dispose()` is synchronous. For a session with an active turn, it only attaches
  // `state.turn.then(close, close)` without awaiting it; the engine settles immediately after
  // `cancelAsk` aborts the turn. Thus `await live.settlement` above guarantees that the run settled,
  // **not** that the aborted turn finished writing. Counting predecessor messages now could miss a
  // message or count one whose parts are not fully persisted. That count becomes the continuation
  // position (`inFlight.messageBoundary`) used by the driver to truncate copied history. Completed
  // prefixes are different: their boundaries were journaled when the ask settled, so they are facts,
  // not observations made now.
  //
  // Ask the driver once which sessions are quiet, and continue only those. **This does not hide the
  // race with a timeout**: a session not persisted by the deadline is not treated as quiet; it simply
  // gets no `inFlight` entry. That matches the behavior before this feature (discard the in-flight
  // transcript and restart the ask from the complete prefix). We skip an optimization rather than
  // truncate a transcript using a count that is still changing.
  //
  // Neither of these cases waits, because neither has a questionable count:
  //   - This process has no live predecessor entry (it is terminal already or was left by a dead
  //     process), so without a driver nothing is writing its sessions.
  //   - The assembly has no transcript access, so it cannot count messages or produce `inFlight`
  //     (the builder also requires `messageCount` for continuation); waiting would be wasted.
  // Both map to "omitted means all sessions are quiet" (see AmendImportOptions.quietSessions).
  const quietSessions =
    deps.actorTranscriptStore === undefined ? undefined : await live?.quiescence?.quietSessions();

  const built = await buildImportedCache(
    deps,
    request.predecessorRunId,
    quietSessions === undefined ? undefined : { quietSessions },
  );
  if (!built.ok) {
    // Preflight just passed: the run exists and has complete boundaries. The only remaining
    // refusal is a nonterminal predecessor—the registry says it is inactive while the journal says
    // it is running (owned by another process). This is not model-correctable input; propagate it as
    // a wiring failure.
    throw new Error(
      `dynamic workflow amend could not import from run ${request.predecessorRunId} after preflight: ${built.reason}`,
    );
  }

  // Usage baseline: read the row again **after the predecessor settles**. The preflight copy was a
  // snapshot from before stopping and would miss the predecessor's final turns—the common case
  // when amending an active run. If the row is gone, use 0 (the predecessor may have just been cleaned up).
  const settledPredecessor = deps.journal.getRun(request.predecessorRunId);
  const inheritedTokens = settledPredecessor?.spentTokens ?? 0;
  // Reuse args only when the caller explicitly requests it (the GUI's Configure action reruns the
  // predecessor's own script; see the port field comment). The tool path omits them, so amendments
  // continue without args. If the predecessor has no args (inline script / legacy row), omit the field.
  const inheritedArgs =
    request.inheritArgs === true && settledPredecessor?.args !== undefined
      ? settledPredecessor.args
      : undefined;

  startNewRun(ctx, {
    runId,
    scriptText: request.scriptText,
    cwd: request.cwd,
    inheritedTokens,
    // Keep the predecessor's display name: an amendment is the next version of the same work, and
    // changing the name in cards and notifications would make it look like a different workflow.
    ...(request.name !== undefined
      ? { name: request.name }
      : predecessor.name === undefined
        ? {}
        : { name: predecessor.name }),
    ...(inheritedArgs === undefined ? {} : { args: inheritedArgs }),
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    ...(request.phaseNames === undefined ? {} : { phaseNames: request.phaseNames }),
    // Do not inherit the concurrency ceiling from the predecessor. "Omitted means inherit" is a
    // three-state rule at the **tool surface**; `AmendWorkflow`'s resolveInput has normalized it to
    // a number or omission here (omission = default concurrency). Inheriting again at the port
    // would make "remove the limit" (`null`) impossible to express.
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    // Do not inherit the subagent model from the predecessor either; the same reasoning applies as
    // for the concurrency ceiling above. "Omitted means inherit" is a three-state rule at the
    // **tool surface**. `AmendWorkflow`'s resolveInput normalizes it to a selection or omission here
    // (omission = use the session model). Inheriting again at the port would make "use the session
    // model" (`null`) impossible to express.
    ...(request.subagentModel === undefined ? {} : { subagentModel: request.subagentModel }),
    // Script-named models are likewise not inherited from the predecessor at the port: "reuse the
    // predecessor's binding for the same name" is a tool-surface rule, and `AmendWorkflow`'s
    // resolveInput has already normalized it into a table here.
    ...(request.modelBindings === undefined ? {} : { modelBindings: request.modelBindings }),
    // **Never inherit the script file from the predecessor**: an amendment records which file this
    // revision's script came from (`path` submission means that file; inline submission means the
    // newly written draft). Reusing the predecessor's path would make the model edit the old script next time.
    ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
    ...(request.phaseAlongside === undefined ? {} : { phaseAlongside: request.phaseAlongside }),
    trace: request.trace,
    imported: { cache: built.cache, resumedFrom: built.resumedFrom },
  });
  return { ok: true, runId, ...(supersededRunId === undefined ? {} : { supersededRunId }) };
}

interface StartNewRunInput {
  runId: string;
  scriptText: string;
  cwd: string;
  name?: string;
  args?: Record<string, unknown>;
  parentSessionId?: string;
  toolCallId?: string;
  launchInputId?: string;
  /** Script-declared phase table (passed for submit and amend; amendments use the **new script's** phases). */
  phaseNames?: string[];
  /** Requested concurrency ceiling; omission means default concurrency. Normalized in {@link DynamicWorkflowRunEntryContext.caps}. */
  maxConcurrency?: number;
  /**
   * This run's subagent model. Omission means subagents use the session model.
   * The structured selection is normalized to a picker string before persistence; see the comment in startNewRun.
   */
  subagentModel?: ModelSelection;
  /** Script-named models (name → structured selection); normalized to canonical strings together with the subagent model before persistence. Omission means none were named. */
  modelBindings?: Record<string, ModelSelection>;
  /**
   * Absolute path of this run's script file. Omission means this run has no editable script file.
   * Model-surface metadata only: it does not affect execution or resume validation.
   */
  scriptPath?: string;
  /** The "running in parallel" table aligned with `phaseNames`; indices refer to that table, and both travel together. */
  phaseAlongside?: number[][];
  trace: TraceContext;
  /**
   * This run's usage baseline (`spentTokens` after predecessor settlement). Amend supplies it; fresh submit omits it (= 0).
   */
  inheritedTokens?: number;
  /** Amend path: the lineage pointer and import cache are provided together. */
  imported?: { cache: ImportedRunCache; resumedFrom: string };
}

/**
 * Shared launch tail for submit and amend: compile → anchor → registry entry → fire-and-forget launch.
 * Returns the runId synchronously; the registry entry already exists before this function returns (see below).
 */
function startNewRun(ctx: DynamicWorkflowRunEntryContext, input: StartNewRunInput): string {
  const { deps, runs, escalations } = ctx;
  const { imported, runId } = input;
  const compiled = compileOnce(input.scriptText);
  // Compute the normalized ceiling only **once**: it is persisted in EngineConfig as
  // dwf_run.caps_max_concurrency and copied into the registry entry for the gap before the journal
  // row appears (the only source for getTask / getRunDetail during that gap). Computing it twice
  // could make the two read paths disagree if the default value changes between reads.
  const caps = ctx.caps(input.maxConcurrency);
  // Canonical string format (`providerId/modelId[$reasoningLevel]`). The port accepts a structured
  // selection, while the journal event, both read paths, and progress payload use a string. Normalize
  // it once here, then pass it through unchanged downstream.
  const subagentModel =
    input.subagentModel === undefined ? undefined : formatModelPickerValue(input.subagentModel);
  // Same normalization point for the binding table: structured selections → canonical strings,
  // with the same table recorded in `run-launched` and the entry.
  const modelBindings = formatModelBindings(input.modelBindings);

  // Launch anchor: amendments reuse the predecessor's value, direct launches use an explicit value,
  // and chat uses the active turn; if none exists, mint one. The engine records it as run-launched
  // in the run's creation lifetime.
  // The script-declared phase table and this run's subagent model travel alongside the anchor:
  // amendments reuse the predecessor's inputId but use the **new script's** phases and never inherit
  // the predecessor's model, so neither belongs in resolveLaunchAnchor.
  const launch: RunLaunch = {
    ...resolveLaunchAnchor({
      ...(input.launchInputId === undefined ? {} : { requested: input.launchInputId }),
      trace: input.trace,
      ...(deps.resolveLaunchInputId === undefined
        ? {}
        : { resolveLaunchInputId: deps.resolveLaunchInputId }),
      ...(imported === undefined
        ? {}
        : (() => {
            const predecessor = readRunLaunchAnchor(deps.journal, imported.resumedFrom);
            return predecessor === undefined ? {} : { predecessor };
          })()),
    }),
    ...(input.phaseNames === undefined ? {} : { phaseNames: input.phaseNames }),
    // The subagent model travels alongside the phase table (also excluded from resolveLaunchAnchor:
    // amendments never inherit the predecessor's model). It lives in this event; dwf_run intentionally
    // has no corresponding column or migration.
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // Script-named models travel alongside the subagent model (also excluded from
    // resolveLaunchAnchor). Zero SQL.
    ...(modelBindings === undefined ? {} : { modelBindings }),
    // Subagent permission mode: read the session's mode **at the moment the run is created**
    // (docs/dynamic-workflow/launch.md, "Permissions inside a run"). Excluded from
    // resolveLaunchAnchor—an amendment is a new run and never reuses the predecessor's; resume
    // does not go through here.
    ...workflowSubagentPermissionModeField(deps.permissionMode?.()),
    // The script file travels alongside the subagent model (also excluded from resolveLaunchAnchor:
    // amendments record the new script's file). It lives in this event; dwf_run has no corresponding column.
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(input.phaseAlongside === undefined ? {} : { phaseAlongside: input.phaseAlongside }),
    // Which sites in the phase table are open holes (docs/execution-engine.md, "Holes"): holes
    // stand by name in the submitter's declared table (9012 guarantees the names are unique), and
    // their indexes are matched against the compiled artifact's open hole names. No holes means
    // the field is omitted.
    ...(() => {
      const holes = openHoleIndexes(input.phaseNames, compiled.holes);
      return holes === undefined ? {} : { holes };
    })(),
  };

  // Register before launch: cancellation can arrive any time after submit returns, and the
  // background tracker starts polling snapshots immediately. The registry is the only synchronous
  // fact that the run exists; the journal's dwf_run row is written after engine construction, several
  // microtasks later.
  const controller = new AbortController();
  // Create the live control surface and AbortController together and add both to the entry (see
  // RunRegistryEntry.control). "Stop this run" and "change a run setting" are two channels that
  // must be available at the same time, both before launch; retune may arrive in any microtask after submit returns.
  const control = createWorkflowRunControl();
  const entry: RunRegistryEntry = {
    controller,
    control,
    startedAt: new Date(),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    // The only source for project key and label in the enumeration surface before the journal row exists (see RunRegistryEntry).
    cwd: input.cwd,
    ...(input.name === undefined ? {} : { name: input.name }),
    scriptText: input.scriptText,
    // Effective concurrency ceiling (the persisted value). The same gap rationale applies:
    // AmendWorkflow's resolveInput reads getTask to determine what to inherit, and amending a newly
    // started run can land in this gap.
    maxConcurrency: caps.maxConcurrency,
    // Gap copy of the subagent model, following the same rule as the concurrency ceiling (see
    // RunRegistryEntry.subagentModel). This is the **only** normalization point from structured
    // selection to canonical string. The value written to `run-launched` is the same value read by
    // both read paths and the `run-started` payload, so their formats cannot diverge.
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // Gap copy of the binding table, following the same rule as the subagent model (see
    // RunRegistryEntry.modelBindings).
    ...(modelBindings === undefined ? {} : { modelBindings }),
    // Gap copy of the script file, following the same rule as the subagent model (see RunRegistryEntry.scriptPath).
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(imported === undefined ? {} : { resumedFrom: imported.resumedFrom }),
    // Hole fact table and phase table (see RunRegistryEntry.holes / phaseNames): one fill replaces
    // both with the effective script's.
    holes: compiled.holes,
    ...(input.phaseNames === undefined ? {} : { phaseNames: input.phaseNames }),
    // Gap copy of the usage baseline, following the concurrency-ceiling rule: before the journal
    // row exists, both read paths can get usage only from the entry. An amendment of a newly started
    // run can land in those microtasks; reporting 0 would make the detail view say the lineage spent nothing.
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // Replaced by the real settlement promise below; this placeholder satisfies the type and is synchronously visible.
    settlement: Promise.resolve<RunSettlement>({ status: "stopped", reason: "user" }),
  };
  runs.set(runId, entry);

  // Fire-and-forget: never await settlement in submit. The submit contract is "launch and return the runId."
  entry.settlement = ctx.trackSettlement(
    runId,
    entry,
    launchDynamicWorkflowRun({
      caps,
      compiled,
      cwd: input.cwd,
      deps,
      // name follows the same metadata path as scriptText / cwd: launch → harness passes it unchanged
      // to EngineConfig, and the engine persists dwf_run.name during createRun. The service
      // intentionally does not issue a second UPDATE, which would create another dwf_run writer
      // (the same rationale as invariant 1 in the file header).
      ...(entry.name === undefined ? {} : { name: entry.name }),
      // Args follow the same metadata path: launch → harness → EngineConfig (persisted as args_json)
      // and spawn payload (injected as the sandbox's args global). Inline scripts have no args, so omit the field.
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(entry.parentSessionId === undefined ? {} : { parentSessionId: entry.parentSessionId }),
      escalationRegistry: escalations,
      control,
      runId,
      scriptText: input.scriptText,
      signal: controller.signal,
      ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
      // Store the session-quiescence probe on the entry so a future amendment of this run can query
      // it (quietSessions in dynamic-workflow-import.ts). All three entry points attach it because
      // we do not know which run will become a predecessor.
      onQuiescenceProbe: (probe) => {
        entry.quiescence = probe;
      },
      // Hole types read the entry's fact table **as of right now**: after a fill swaps the table,
      // holes newly reached inside the function body can still resolve their types.
      holeTypeOf: (siteId) => entry.holes?.find((hole) => hole.siteId === siteId)?.type,
      // Pass the lineage pointer and cache together (launch → harness → EngineConfig): the pointer
      // is written once to dwf_run.resumed_from during createRun; the cache exists only for this execution.
      ...(imported === undefined
        ? {}
        : { importedCache: imported.cache, resumedFrom: imported.resumedFrom }),
      // Usage baseline follows the same path (launch → harness → EngineConfig); the engine uses it
      // as the initial spent_tokens value.
      ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
      // The subagent model has no separate path: it is in launch (see RunLaunch above) and is
      // persisted in the same `run-launched` event. The launch side then reads it from that object,
      // parses it into a selection, and passes it to the actor runtime factory.
      launch,
    }),
  );

  return runId;
}

/** Implementation of `DynamicWorkflowRunPort.resume`. */
export async function resumeDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  runId: string,
): Promise<DynamicWorkflowRunResumeResult> {
  const { deps, runs, escalations } = ctx;
  const record = deps.journal.getRun(runId);
  if (record === undefined) return { ok: false, reason: "not_found" };
  // Same runId is active in this process: its journal status is running, so it cannot be resumed.
  // Keep this reason distinct because callers should take a different action than for an
  // unrecoverable terminal run (wait for settlement vs abandon it).
  const live = runs.get(runId);
  if (live !== undefined && live.terminal === undefined) {
    return { ok: false, reason: "already_running" };
  }
  // Keep superseded runs distinct from unrecoverable terminal runs: callers should inspect the
  // successor instead of abandoning the work.
  if (record.status === "stopped" && record.stopReason === "superseded") {
    return { ok: false, reason: "superseded" };
  }
  if (!isResumableRecord(record)) return { ok: false, reason: "not_resumable" };
  // scriptText persistence began with workflow-live-run; older records have no script to rerun.
  if (record.scriptText === undefined) return { ok: false, reason: "script_missing" };

  // Older journal source was written against the facade as it existed **then**, and may no longer
  // pass type checking after refactors. compileOnce treats invalid source as a hard failure because
  // that path indicates a wiring error. On resume, however, this is an expected user-facing branch:
  // return a structured refusal with bounded diagnostics for the UI / TUI / tool surface to point to
  // AmendWorkflow, rather than reporting a generic execution failure. Diagnostics and the following
  // compilation share one Program, preserving the "compile once" rule.
  const workflow = createWorkflowProgram(record.scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) {
    deps.logger?.warn?.("Dynamic workflow resume refused: stored script no longer compiles", {
      diagnosticCount: diagnostics.length,
      event: "dynamic_workflow.resume.compile_failed",
      module: "bootstrap.app",
      runId,
    });
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedResumeDiagnostics(runId, diagnostics),
    };
  }
  const compiled = compileProgram(record.scriptText, workflow);
  // Server-side precondition (the engine checks again during construction as defense in depth): if
  // the record was externally modified so scriptText and scriptHash no longer agree, do not create
  // a registry entry or launch. A synchronous engine-side throw would mark the entry failed and
  // hide the fact that the record is still repairable.
  if (record.scriptHash !== undefined && record.scriptHash !== compiled.scriptHash) {
    deps.logger?.warn?.("Dynamic workflow resume refused: script hash mismatch", {
      event: "dynamic_workflow.resume.script_hash_mismatch",
      expected: record.scriptHash,
      got: compiled.scriptHash,
      module: "bootstrap.app",
      runId,
    });
    return { ok: false, reason: "script_mismatch" };
  }

  // Resume of an amended run: rebuild the import cache.
  // Consumed imports have real rows in this run's journal and replay will short-circuit them as
  // usual; unconsumed imports exist only in memory, and without rebuilding they would be rerun live
  // during this resume. Rebuilding and submission both use the same pure function over the same
  // predecessor journal, so they are deterministic. The engine derives the divergence point from
  // this run's recorded rows (reconcileRecorded in imported-cache.ts), keeping both sides aligned.
  //
  // **A rebuild failure must never prevent resume**: the predecessor journal supports the amended
  // run's continued optimization, but is only an acceleration structure. Losing it makes execution
  // more expensive, not incorrect. If the predecessor was cleaned up or no longer passes the
  // boundary gate, launch without a cache; unconsumed imports rerun live, while this run's own
  // journal rows continue to replay one by one.
  const rebuilt =
    record.resumedFrom === undefined
      ? undefined
      : await rebuildImportedCacheForResume(deps, {
          predecessorRunId: record.resumedFrom,
          runId,
        });

  // Replace the registry entry: same runId, new AbortController, new settlement promise, restoring
  // cancel support. Do this before launch (header invariant 5: the entry is required by the watcher).
  const resumedSubagentModel = readRunSubagentModel(deps.journal, runId);
  const resumedModelBindings = readRunModelBindings(deps.journal, runId);
  const resumedScriptPath = readRunScriptPath(deps.journal, runId);
  // The phase table in effect right now: after a fill it is the one on the last `hole-filled`
  // event; otherwise it is the declared table from `run-launched`.
  const resumedPhaseNames = phaseNamesFromEvents(readRunHoleEvents(deps.journal, runId));
  const controller = new AbortController();
  // Same rule as submit: a new entry gets a new AbortController and control surface. The previous
  // generation's handles point to a settled engine; keeping them would make retune talk to a dead engine.
  const control = createWorkflowRunControl();
  const entry: RunRegistryEntry = {
    controller,
    control,
    startedAt: new Date(),
    // Effective concurrency ceiling for this run: **resume trusts the journal row** (an in-place
    // retune already wrote its new value to `caps_max_concurrency`, so this is the ceiling for this
    // generation). Copy it into the entry so `retuneConcurrency` and both read paths follow one rule:
    // if an entry exists, read from it.
    maxConcurrency: record.caps.maxConcurrency,
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
    ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
    // Gap metadata for enumeration (see RunRegistryEntry): the journal row is authoritative on
    // resume; this is an in-memory copy of the same fact. cwd comes from the same source as launch below.
    cwd: record.cwd ?? process.cwd(),
    ...(record.name === undefined ? {} : { name: record.name }),
    scriptText: record.scriptText,
    // Subagent model: read the event header once and copy it to the entry (see
    // RunRegistryEntry.subagentModel). It was fixed in `run-launched` when the run was created and
    // never changes, so the copy cannot diverge from the event. Both read paths then follow one
    // rule: use the entry when present, and scan events only for cold rows.
    ...(resumedSubagentModel === undefined ? {} : { subagentModel: resumedSubagentModel }),
    // Binding table: same read and same rationale as the subagent model.
    ...(resumedModelBindings === undefined ? {} : { modelBindings: resumedModelBindings }),
    // Script file: same read and rationale as the subagent model (fixed at run creation and
    // unchanged afterward, so the copy cannot diverge from the event). After resume, both read
    // paths still use the entry when present.
    ...(resumedScriptPath === undefined ? {} : { scriptPath: resumedScriptPath }),
    // The hole fact table comes from this compilation of the (effective) script in the row; the
    // phase table is read back from events (for filled runs, the `hole-filled` one).
    holes: compiled.holes,
    ...(resumedPhaseNames === undefined ? {} : { phaseNames: resumedPhaseNames }),
    settlement: Promise.resolve<RunSettlement>({ status: "stopped", reason: "user" }),
  };
  runs.set(runId, entry);

  entry.settlement = ctx.trackSettlement(
    runId,
    entry,
    launchDynamicWorkflowRun({
      holeTypeOf: (siteId) => entry.holes?.find((hole) => hole.siteId === siteId)?.type,
      // Reuse the journaled caps: spentTokens accumulated under these caps, and recalculating them
      // would silently move the goalposts.
      caps: record.caps,
      compiled,
      cwd: record.cwd ?? process.cwd(),
      deps,
      ...(record.name === undefined ? {} : { name: record.name }),
      // Resume **replays** the stored args and never accepts new ones: a run's identity includes
      // its args, following the same rule as "only byte-identical scripts are valid." The resume
      // entry point intentionally has no args parameter, so the journal row is the only source. Old
      // rows without this column omit it (the sandbox reads `{}`). Different args mean a new run and
      // a new confirmation window.
      ...(record.args === undefined ? {} : { args: record.args }),
      // Do not pass a new subagent model either: it lives with the anchor in `run-launched`, fixed
      // when the run was created. The launch side reads it from the journal event header (the same
      // read copied into the entry above). As with caps / args, a run's identity includes the model
      // it used; resume replays the stored value and never accepts a new one.
      ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
      // Both entry points share the same quiescence table (see the field comment above).
      escalationRegistry: escalations,
      // Unlike the quiescence table, **each entry point creates its own** control surface (it is
      // bound to this generation's engine and admission gate).
      control,
      runId,
      scriptText: record.scriptText,
      signal: controller.signal,
      ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
      // Same as submit / amend: a resumed run can still become the predecessor of a future amendment.
      onQuiescenceProbe: (probe) => {
        entry.quiescence = probe;
      },
      // Do not pass resumedFrom again: createRun fixed it at submission, and on resume the engine
      // finds the existing row without calling createRun. Only the rebuilt cache needs to be passed.
      ...(rebuilt === undefined ? {} : { importedCache: rebuilt }),
    }),
  );

  return {
    ok: true,
    runId,
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
  };
}

/**
 * Mint a run ID using a safe character set: it appears in actor session IDs, URLs, file paths, and
 * logs, so use only `[A-Za-z0-9-]` (the character set produced by randomUUID), never `#`/`@`/`/`.
 */
function mintRunId(): string {
  return `dwfrun-${randomUUID()}`;
}

/** Sole normalization point for the binding table: structured selections → canonical picker strings. An empty table is equivalent to omission (no empty shell keys). */
function formatModelBindings(
  bindings: Record<string, ModelSelection> | undefined,
): Record<string, string> | undefined {
  if (bindings === undefined) return undefined;
  const entries = Object.entries(bindings);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([name, selection]) => [name, formatModelPickerValue(selection)]),
  );
}
