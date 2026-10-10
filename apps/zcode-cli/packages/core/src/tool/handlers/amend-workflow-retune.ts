// AmendWorkflow: apply concurrency-only changes in place.
// When the call includes only `run_id` and `max_concurrency` and the predecessor is still running, preserve the run ID, subagents, transcript, and pending asks.
// This module handles routing, the port call, and result messaging. If the run settles between the check and call, reread predecessor state
// before deciding whether to fall back to the revision flow.

import {
  AmendWorkflowInputSchema,
  isAmendWorkflowOwnedPredecessor,
  type AmendWorkflowInput,
  type AmendWorkflowPredecessor,
  type CreateWorkflowOutput,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunRetuneResult,
} from "@zcode/contracts";
import type { ToolExecutionContext, ToolHandlerFailure } from "../types.js";
import {
  AMEND_WORKFLOW_ERROR_CODE,
  describePredecessor,
  resolveAmendMaxConcurrency,
  resolveAmendScript,
} from "./amend-workflow-source.js";
import { clampWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

/**
 * "Nothing changed except concurrency": check the **shape of the input**, not whether fields are new.
 * Any presence of `script`, `path`, `subagent_model`, or `name` routes this call through revision, regardless of their values;
 * each could change what will run, while this path requires "the same script and the same set of subagents are still running."
 *
 * The same applies after normalization: the revision path always resolves a script, so "no script but a concurrency value" can only mean
 * an in-place concurrency change.
 */
export function isConcurrencyOnlyAmend(model: AmendWorkflowInput): boolean {
  return (
    model.max_concurrency !== undefined &&
    model.script === undefined &&
    model.path === undefined &&
    model.subagent_model === undefined &&
    model.name === undefined
  );
}

/**
 * Routing decision used by resolveInput. On a match, return normalized input **without a script**; prepareApproval then allows it and the handler calls
 * `retuneConcurrency`. On no match, return `undefined` and let the caller continue through revision as usual.
 *
 * All three conditions are required: the input changes only concurrency; the predecessor is still live (try both `pending` and `running`,
 * with the port deciding whether it is live); and the port supports this control surface. If the port lacks `retuneConcurrency` (an older host),
 * this path does not exist and the call falls through to today's revision behavior, including its confirmation window for another owner's run.
 */
export function resolveConcurrencyRetuneRoute(options: {
  model: AmendWorkflowInput;
  port: DynamicWorkflowRunPort;
  predecessor: AmendWorkflowPredecessor;
  /** Upper bound from the predecessor snapshot; if absent, it runs at the ceiling. */
  inherited: number | undefined;
}): { result: true; input: AmendWorkflowInput } | ToolHandlerFailure | undefined {
  const { model, port, predecessor } = options;
  if (!isConcurrencyOnlyAmend(model)) return undefined;
  if (predecessor.status !== "pending" && predecessor.status !== "running") return undefined;
  if (typeof port.retuneConcurrency !== "function") return undefined;

  // Do **not** normalize the three states here: pass `null` through to the port unchanged (see the resolveAmendMaxConcurrency comment).
  const requested = model.max_concurrency ?? null;
  const ceiling = port.concurrencyCeiling?.();
  const unchanged = refuseUnchangedBound(model.run_id, requested, options.inherited, ceiling);
  if (unchanged !== undefined) return unchanged;
  return {
    result: true,
    input: { run_id: model.run_id, max_concurrency: requested, predecessor },
  };
}

/**
 * Handle an unchanged value here, before hooks and the confirmation window, without touching the port. If the ceiling is unavailable
 * (an older host has no `concurrencyCeiling`), `null` cannot be converted to a number, so let the port return `unchanged` itself.
 */
function refuseUnchangedBound(
  runId: string,
  requested: number | null,
  inherited: number | undefined,
  ceiling: number | undefined,
): ToolHandlerFailure | undefined {
  const current = inherited ?? ceiling;
  const next = requested === null ? ceiling : clampWorkflowMaxConcurrency(requested, ceiling);
  if (current === undefined || next === undefined || current !== next) return undefined;
  return retuneUnchangedFailure(runId, current, ceiling);
}

/**
 * Handler implementation: call the port and translate its three answers into model-facing results.
 *
 * `undefined` has only one meaning: the port returned `not_live` (or the host has no such control surface), so this call now describes a revision;
 * {@link resolveRetuneFallbackAmend} decides whether to perform it.
 */
export async function runConcurrencyRetune(
  parsed: AmendWorkflowInput,
  context: ToolExecutionContext,
): Promise<CreateWorkflowOutput | ToolHandlerFailure | undefined> {
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.retuneConcurrency !== "function") return undefined;
  const answer = await port.retuneConcurrency({
    runId: parsed.run_id,
    // Routing guarantees this is "a number or null"; `?? null` treats missing input that bypassed normalization as "use the ceiling."
    maxConcurrency: parsed.max_concurrency ?? null,
  });
  if (answer.ok) {
    return {
      diagnostics: [],
      ok: true,
      // Do not add this to the background tracker: the run is already there and remains the same run throughout. There is no `backgrounded`
      // contract and no compiled artifact to display. `retuned` is an **explicit** discriminator; consumers should not infer it from "ok with no status,"
      // because that shape can come from other paths.
      response: retuneResponse(parsed.run_id, answer),
      retuned: {
        runId: parsed.run_id,
        maxConcurrency: answer.maxConcurrency,
        previous: answer.previous,
        ceiling: answer.ceiling,
      },
    } satisfies CreateWorkflowOutput;
  }
  if (answer.reason === "unchanged") {
    return retuneUnchangedFailure(parsed.run_id, answer.current, port.concurrencyCeiling?.());
  }
  return undefined;
}

/**
 * Settlement race: this input now describes a revision. Whether it can proceed depends on one thing—**whether that revision would normally open a confirmation window**.
 *
 * A run owned by this session and not manually stopped by the user: owner rules would not open a window anyway, so proceed with revision; resolve the script
 * and compile it now (report a missing or invalid script as a revision rejection). Another owner's run, or one stopped by the user: reject it.
 * No window has opened on this path, so "nothing was approved" cannot be treated as permission to start another run.
 */
export async function resolveRetuneFallbackAmend(
  parsed: AmendWorkflowInput,
  context: ToolExecutionContext,
): Promise<{ result: true; input: AmendWorkflowInput } | ToolHandlerFailure> {
  const port = context.dynamicWorkflowRunPort;
  // Reread the facts: the run settled between the liveness check and the port call, while the input snapshot still says "running."
  const snapshot = port === undefined ? undefined : await port.getTask(parsed.run_id);
  if (snapshot === undefined) return predecessorNotFoundFailure(parsed.run_id);
  const predecessor = describePredecessor(snapshot, context.sessionId);
  if (!isAmendWorkflowOwnedPredecessor(predecessor)) {
    // Not yet settled (pending, engine not created) and settled are different states, but the next step is the same: call again.
    return predecessor.status === "pending" || predecessor.status === "running"
      ? notRetunableFailure(parsed.run_id)
      : runSettledFailure(parsed.run_id);
  }
  const script = await resolveAmendScript({
    model: parsed,
    cwd: context.workingDirectory,
    port,
    predecessorScriptPath: snapshot.scriptPath,
  });
  if (!script.result) return script;
  return {
    result: true,
    input: AmendWorkflowInputSchema.parse({
      run_id: parsed.run_id,
      ...script.fields,
      // Revision returns to "a number or nothing": this call explicitly supplied a value, so there is nothing to inherit.
      ...resolveAmendMaxConcurrency(
        parsed.max_concurrency,
        undefined,
        port?.concurrencyCeiling?.(),
      ),
      predecessor: {
        ...predecessor,
        ...(script.inherited ? { script_inherited: true as const } : {}),
      },
    }) as AmendWorkflowInput,
  };
}

/** Predecessor is missing: use the same source and message as resolveInput (one explanation for a mistyped run ID). */
function predecessorNotFoundFailure(runId: string): ToolHandlerFailure {
  const base = workflowRunNotFoundFailure(runId);
  return {
    ...base,
    message: `${base.message} Nothing was stopped or created: \`run_id\` pointed at a run that does not exist — pass an existing run's ID (see ListWorkflowRuns), or start a fresh run with CreateWorkflow.`,
  };
}

/** Describe the active upper bound; the ceiling means there is no lower per-run limit. */
function describeBoundInForce(bound: number | undefined, ceiling: number | undefined): string {
  if (bound === undefined || bound === ceiling) {
    return "has no limit on how many subagents run at once (it runs at this machine's maximum)";
  }
  return bound === 1
    ? "already runs at most 1 subagent at once"
    : `already runs at most ${bound} subagents at once`;
}

/** Unchanged value: nothing was written or stopped; name the currently active bound in the rejection. */
export function retuneUnchangedFailure(
  runId: string,
  current: number | undefined,
  ceiling: number | undefined,
): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.RETUNE_UNCHANGED,
    message: `workflow_retune_unchanged: run ${runId} ${describeBoundInForce(current, ceiling)}, so there is nothing to change. Nothing was stopped, created or changed — pass a different \`max_concurrency\`, or a revised script if you meant to amend the run.`,
  };
}

/** Another owner's run has settled: call again to revise it from the beginning, including its confirmation window. */
export function runSettledFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.RUN_SETTLED,
    message: `workflow_run_settled: run ${runId} settled before the new parallelism limit could take hold, so there is nothing running to retune. Nothing was stopped, created or changed — call AmendWorkflow again if you want a new run of it under that limit.`,
  };
}

/** Another owner's run that this agent never took ownership of (`pending`, engine not created): same next step. */
export function notRetunableFailure(runId: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.NOT_RETUNABLE,
    message: `workflow_run_not_retunable: run ${runId} is not being executed by this agent, so its parallelism cannot be changed in place. Nothing was stopped, created or changed — call AmendWorkflow again if you want a new run of it under that limit.`,
  };
}

/**
 * Model-facing response: **name one run and no successor**; this lets the model
 * distinguish which path this call took without exposing the routing itself. When the upper bound equals the ceiling, say "the limit is removed"
 * instead of reporting a number, matching the rule used by `CreateWorkflow`.
 *
 * ⚠ This text is the **only fact that reaches v4**: this path has no display payload (`retuned` is process-local,
 * while the protocol's `toolOutputSchema` carries only text / display / truncated), and the tool card renders it as one line. It must therefore
 * stand alone—name the run, state the active bound, and clarify that no new run was started—and remain stable because changing the wording changes the UI.
 */
function retuneResponse(
  runId: string,
  answer: Extract<DynamicWorkflowRunRetuneResult, { ok: true }>,
): string {
  const bound =
    answer.maxConcurrency === answer.ceiling
      ? "the limit on how many subagents run at once is removed (this machine's maximum applies)"
      : answer.maxConcurrency === 1
        ? "at most 1 subagent runs at once"
        : `at most ${answer.maxConcurrency} subagents run at once`;
  return `Applied to the running run ${runId}; ${bound}. Run ${runId} keeps running under it: nothing was stopped and no new run was started.`;
}
