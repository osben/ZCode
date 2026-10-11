// ============================================================
// `run-started` branch of workflowRuns reduction.
// ============================================================
// Split out of workflow-runs-reducer.ts to satisfy the max-lines limit: the main reducer is left with only switch dispatch, following the same pattern as
// `concurrency-changed` / `phase-entered`. This event has the most to cover — resume's
// re-arming semantics, lineage pointer, and this run's own concurrency limit — and these are related: a second `run-started` for the same runId
// must clear settlement remnants from the previous life without resetting the shared cap learned by the process back to the default concurrency.

import { reduceRunStartedConcurrency } from "./workflow-runs-concurrency.js";
import { workflowRunTablesForNewLife } from "./workflow-runs-eviction.js";
import { withoutWaitingHoles } from "./workflow-runs-holes.js";
import { readRunIdField } from "./workflow-runs-lineage.js";
import { WORKFLOW_RUNS_LIMITS, type WorkflowRunState } from "./workflow-runs.js";

/**
 * Subagent model in the payload (canonical string `providerId/modelId[$reasoningLevel]`).
 * Discard the entire value if it exceeds the limit rather than truncating it: a shortened model id would be false, so showing nothing is preferable.
 */
function readSubagentModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= WORKFLOW_RUNS_LIMITS.maxSubagentModelLength
    ? text
    : undefined;
}

/**
 * `run-started` → the run returns to running, usage resets, and settlement remnants from the previous life are removed.
 *
 * Resume fix:
 * The same runId may receive another run-started (in-process cancel → resume). Spreading the old run as-is would leave settlement remnants
 * (error / resultPreview) on a running run — these removals are the projection-side counterpart of the journal's clearing semantics
 * (updateRunStatus clears settlement for non-terminal states).
 * Suspended upgrade questions are also remnants from the previous life, with even less reason to survive: those questions
 * belong to deferreds from the previous suspension and were rejected with cancelAsk when cancelled. In the new life, the corresponding
 * ask runs again, the actor asks again, and gets a **new qid** — keeping the old one would leave the sidebar showing a question that will never
 * get an answer and that no one is waiting for anymore.
 * `resumable` is also a settlement fact from the previous life: once resume starts, it is no longer resumable.
 *
 * Usage is replaced with a zero object, so **the two evicted-instance counters (`nodesUnlisted` / `nodesUnlistedSettled`)
 * are reset too** — that is their intended semantics: re-arming resends the entire script prefix (completed instances are cached
 * settle, new instances are queued), and failing to reset would add together the "steps missing from the table" across two lives. See workflow-runs-caps.ts.
 * For the same reason, clear `unlistedByPhase` (it records where the previous life's bounds were hit), and **clear both tables for a run that overflowed**
 * — see workflowRunTablesForNewLife in workflow-runs-eviction.ts for the rule and rationale.
 *
 * `concurrency` is **not** removed: it is a fact about the concurrency under which this run executes
 * (both limits), and the shared-pool side is even process-level state. See workflow-runs-concurrency.ts for the rule.
 * The same applies even more strongly to `subagentModel`: it is a condition set by the user for this run, and resume carries the same value.
 */
export function reduceRunStarted(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const {
    error: staleError,
    resultPreview: staleResultPreview,
    pendingQuestions: staleQuestions,
    resumable: staleResumable,
    stopReason: staleStopReason,
    unlistedByPhase: staleUnlisted,
    ...rebased
  } = run;
  void [
    staleError,
    staleResultPreview,
    staleQuestions,
    staleResumable,
    staleStopReason,
    staleUnlisted,
  ];
  // The lineage pointer arrives with `run-started` (the CLI derives it from launch arguments or a journal row); re-arming carries the same value, so pass it through.
  const resumedFrom = readRunIdField(payload.resumedFrom) ?? rebased.resumedFrom;
  // Subagent model: like `limit`, a condition specific to this run, carried only with
  // this event. If it cannot be read, fall back to the known value — old CLIs do not send this key, and erasing an already displayed model is one of the worst
  // regressions: the run would appear to switch models when only a field was missing. Absence means the entire key is omitted (not undefined).
  const subagentModel = readSubagentModel(payload.subagentModel) ?? rebased.subagentModel;
  // Waiting holes and suspended questions are both remnants of the previous life (workflow-runs-holes.ts): when resume re-executes
  // past that site it emits another `hole-reached`; a hole that has been filled is code wired into the run and survives across lives.
  return reduceRunStartedConcurrency(
    {
      ...withoutWaitingHoles(rebased as WorkflowRunState),
      ...(resumedFrom === undefined ? {} : { resumedFrom }),
      ...(subagentModel === undefined ? {} : { subagentModel }),
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      ...workflowRunTablesForNewLife(run),
    },
    payload,
  );
}
