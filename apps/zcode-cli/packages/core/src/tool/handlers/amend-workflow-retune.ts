// ============================================================
// AmendWorkflow: changing only concurrency takes effect in place.
// ============================================================
// See docs/dynamic-workflow/launch.md, “Changing only the parallelism of a live run”; for how the engine and driver
// apply the new limit, see docs/dynamic-workflow/concurrency.md, “Retuning a live run.”
//
// A call containing only `run_id` and `max_concurrency` while its predecessor is live is **not an amendment**: it changes one value in place.
// The run keeps its ID, subagents, transcript, and in-flight asks; nothing stops or gets replaced, and no dialog opens.
// This was split from amend-workflow.ts for the same reason as amend-workflow-source.ts (the 400-line limit and clear ownership):
// that file handles amendments; this file owns the entire retune route—detection, port call, model-facing copy, and
// the facts that must be reread if a settlement race falls back to a real amendment.

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
import { normalizeWorkflowMaxConcurrency } from "./create-workflow-source.js";
import { workflowRunNotFoundFailure } from "./workflow-run-introspection.js";

/**
 * “Nothing changed except concurrency” (docs/dynamic-workflow/launch.md) is determined from the **input shape**, not from new field values.
 * Any `script`, `path`, `subagent_model`, or `name` sends this call through the amendment route, regardless of its value:
 * each can change what will run, while this route requires the same script and same set of subagents.
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
 * Route detection in resolveInput (docs/dynamic-workflow/launch.md: routing belongs at the only step that knows both conditions).
 * On a match, return normalized input **without a script**—prepareApproval then allows it and the handler calls
 * `retuneConcurrency`; otherwise return `undefined` and let the caller proceed with an amendment.
 *
 * All three conditions are required: the input changes only concurrency; the predecessor is still live (try both `pending` and `running`,
 * with the port deciding whether it is live); and the port supports this control surface. If the port lacks `retuneConcurrency` (an older host),
 * this path does not exist and the call falls through to today's revision behavior, including its confirmation window for another owner's run.
 */
export function resolveConcurrencyRetuneRoute(options: {
  model: AmendWorkflowInput;
  port: DynamicWorkflowRunPort;
  predecessor: AmendWorkflowPredecessor;
  /** The predecessor snapshot's limit; if absent, it runs at the default concurrency. */
  inherited: number | undefined;
}): { result: true; input: AmendWorkflowInput } | ToolHandlerFailure | undefined {
  const { model, port, predecessor } = options;
  if (!isConcurrencyOnlyAmend(model)) return undefined;
  if (predecessor.status !== "pending" && predecessor.status !== "running") return undefined;
  if (typeof port.retuneConcurrency !== "function") return undefined;

  // Do **not** normalize the three states here: pass `null` through to the port unchanged (see the resolveAmendMaxConcurrency comment).
  const requested = model.max_concurrency ?? null;
  const defaultConcurrency = port.defaultConcurrency?.();
  const unchanged = refuseUnchangedBound(
    model.run_id,
    requested,
    options.inherited,
    defaultConcurrency,
  );
  if (unchanged !== undefined) return unchanged;
  return {
    result: true,
    input: { run_id: model.run_id, max_concurrency: requested, predecessor },
  };
}

/**
 * Handle unchanged values here—before hooks and the confirmation dialog, without calling the port. If the default concurrency is unavailable (older hosts omit
 * `defaultConcurrency`), `null` cannot be converted to a number; skip this check and let the port return `unchanged`.
 */
function refuseUnchangedBound(
  runId: string,
  requested: number | null,
  inherited: number | undefined,
  defaultConcurrency: number | undefined,
): ToolHandlerFailure | undefined {
  const current = inherited ?? defaultConcurrency;
  const next = requested === null ? defaultConcurrency : normalizeWorkflowMaxConcurrency(requested);
  if (current === undefined || next === undefined || current !== next) return undefined;
  return retuneUnchangedFailure(runId, current, defaultConcurrency);
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
    // Route detection guarantees this is a number or null; `?? null` treats missing input that bypassed normalization as “use the default.”
    maxConcurrency: parsed.max_concurrency ?? null,
  });
  if (answer.ok) {
    return {
      diagnostics: [],
      ok: true,
      // Do not add this to the background tracker: the run is already tracked and remains the same run, so it has no `backgrounded`
      // contract or compiled artifact to display (docs/dynamic-workflow/launch.md). `retuned` is an **explicit**
      // discriminator; consumers must not infer it from “ok with no status,” which has other meanings.
      response: retuneResponse(parsed.run_id, answer),
      retuned: {
        runId: parsed.run_id,
        maxConcurrency: answer.maxConcurrency,
        previous: answer.previous,
        defaultConcurrency: answer.defaultConcurrency,
      },
    } satisfies CreateWorkflowOutput;
  }
  if (answer.reason === "unchanged") {
    return retuneUnchangedFailure(parsed.run_id, answer.current, port.defaultConcurrency?.());
  }
  return undefined;
}

/**
 * Settlement race (docs/dynamic-workflow/launch.md, “When the port says `not_live`”): the same input now
 * describes an amendment. Whether to proceed depends on one thing: **whether that amendment would have opened a dialog**.
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
      ...resolveAmendMaxConcurrency(parsed.max_concurrency, undefined),
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

/** Render the currently effective limit as a sentence; a limit equal to the default means “no per-run limit.” */
function describeBoundInForce(
  bound: number | undefined,
  defaultConcurrency: number | undefined,
): string {
  if (bound === undefined || bound === defaultConcurrency) {
    return defaultConcurrency === undefined
      ? "already runs at the default parallelism"
      : `already runs at the default parallelism (at most ${defaultConcurrency} subagents at once)`;
  }
  return bound === 1
    ? "already runs at most 1 subagent at once"
    : `already runs at most ${bound} subagents at once`;
}

/** Unchanged value: nothing was written or stopped; name the currently active bound in the rejection. */
export function retuneUnchangedFailure(
  runId: string,
  current: number | undefined,
  defaultConcurrency: number | undefined,
): ToolHandlerFailure {
  return {
    result: false,
    errorCode: AMEND_WORKFLOW_ERROR_CODE.RETUNE_UNCHANGED,
    message: `workflow_retune_unchanged: run ${runId} ${describeBoundInForce(current, defaultConcurrency)}, so there is nothing to change. Nothing was stopped, created or changed — pass a different \`max_concurrency\`, or a revised script if you meant to amend the run.`,
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
 * Model-facing response (docs/dynamic-workflow/launch.md): **identify one run and no successor**—this lets the model
 * distinguish which route the call took without describing the routing itself. Mark a limit equal to the default as “(default),”
 * matching the distinction used by `CreateWorkflow`.
 *
 * ⚠ This text is the **only fact that reaches v4**: this path has no display payload (`retuned` is process-local,
 * while the protocol's `toolOutputSchema` carries only text / display / truncated), and the tool card renders it as one line. It must therefore
 * stand alone—name the run, state the active bound, and clarify that no new run was started—and remain stable because changing the wording changes the UI.
 * Exact-string tests for both limit forms are in core/tests/amend-workflow-permission.test.ts.
 */
function retuneResponse(
  runId: string,
  answer: Extract<DynamicWorkflowRunRetuneResult, { ok: true }>,
): string {
  const count =
    answer.maxConcurrency === 1
      ? "at most 1 subagent runs at once"
      : `at most ${answer.maxConcurrency} subagents run at once`;
  const bound =
    answer.maxConcurrency === answer.defaultConcurrency ? `${count} (the default)` : count;
  return `Applied to the running run ${runId}; ${bound}. Run ${runId} keeps running under it: nothing was stopped and no new run was started.`;
}
