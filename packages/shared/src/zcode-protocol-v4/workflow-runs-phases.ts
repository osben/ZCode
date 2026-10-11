import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunPhase,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { readPhaseHoles } from "./workflow-runs-holes.js";

/**
 * Reduction for `phase-entered`: control flow passed a `phase("…")` marker. It lives outside the main
 * reducer for the same reason as concurrency observation: the main file is at its max-lines limit.
 *
 * Does not touch nodes/actors; a marker is not a work step. `rounds` uses **max** instead of +1 because
 * the engine may emit the prefix again when resuming. Markers have no journal rows for deduplication, so
 * monotonic reduction makes replay a no-op. A missing ordinal (older CLI or malformed payload) counts
 * as 1. Capacity follows the actors/nodes rule: reject new entries but continue updating existing ones;
 * overflow facts remain in the journal. `currentPhase` has no capacity limit because control-flow
 * position is a fact that must be reported even if it cannot fit in the table.
 */
/**
 * Reduction for `run-launched`: the anchor (inputId) belongs to the event, not this state. Carry only the
 * script-declared phase table `phaseNames`, in declaration order and bounded like `phases`. If it is
 * absent or empty, return the state unchanged (advancing only the watermark) and do not create the key;
 * the UI renders an implicit step when it is absent. This is recorded once per run, so resume's
 * `run-started` does not clear it and replay is a no-op.
 *
 * The concurrent-phase table `phaseAlongside` depends on this table because its indices refer to the
 * accepted `phaseNames`. Read it only after accepting the names and bound it to that table's length; see
 * {@link readPhaseAlongside}.
 */
export function reduceRunLaunched(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  if (!Array.isArray(payload.phaseNames)) return run;
  const phaseNames: string[] = [];
  for (const raw of payload.phaseNames) {
    if (typeof raw !== "string") continue;
    const name = raw.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
    if (name.length === 0) continue;
    phaseNames.push(name);
    if (phaseNames.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
  }
  if (phaseNames.length === 0) return run;
  const phaseAlongside = readPhaseAlongside(payload.phaseAlongside, phaseNames.length);
  // The hole index table (docs/dynamic-workflow/presentation.md "Holes on the timeline") follows the
  // same pattern as the concurrent-phase table: ride along with the declared names table, bounding
  // indices against the accepted table.
  const phaseHoles = readPhaseHoles(payload.holes, phaseNames.length);
  return {
    ...run,
    phaseNames,
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
    ...(phaseHoles === undefined ? {} : { phaseHoles }),
  };
}

/**
 * Carry the concurrent-phase table only after `phaseNames` has been accepted.
 *
 * Indices refer to the **accepted** name table, so bound this table to its length (padding shorter
 * payloads with empty arrays) and validate each item: integer, in `[0, count)`, not a self-reference (a
 * phase cannot run alongside itself), deduplicated in order, and bounded in count. An out-of-range index
 * would make the sidebar connect a parallel segment to a nonexistent step, so omit it instead.
 *
 * Return `undefined` when no entries remain and do not create the key; the UI draws a straight line when
 * absent, matching an empty `phaseNames` table.
 */
function readPhaseAlongside(raw: unknown, count: number): number[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: number[][] = [];
  let any = false;
  for (let index = 0; index < count; index += 1) {
    const entry: unknown = raw[index];
    const indexes: number[] = [];
    if (Array.isArray(entry)) {
      for (const value of entry) {
        if (typeof value !== "number" || !Number.isInteger(value)) continue;
        if (value < 0 || value >= count || value === index) continue;
        if (indexes.includes(value)) continue;
        indexes.push(value);
        if (indexes.length >= WORKFLOW_RUNS_LIMITS.maxPhases) break;
      }
    }
    if (indexes.length > 0) any = true;
    out.push(indexes);
  }
  return any ? out : undefined;
}

export function reducePhaseEntered(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const raw = typeof payload.name === "string" ? payload.name : undefined;
  const name = raw?.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
  if (name === undefined || name.length === 0) return run;
  const ordinal =
    typeof payload.ordinal === "number" && Number.isInteger(payload.ordinal) && payload.ordinal > 0
      ? payload.ordinal
      : 1;
  const existing = run.phases ?? [];
  const index = existing.findIndex((phase) => phase.name === name);
  let phases: WorkflowRunPhase[];
  let truncated = run.truncated === true;
  if (index >= 0) {
    const current = existing[index]!;
    phases =
      current.rounds >= ordinal
        ? existing
        : existing.map((phase, i) => (i === index ? { ...phase, rounds: ordinal } : phase));
  } else if (existing.length >= WORKFLOW_RUNS_LIMITS.maxPhases) {
    phases = existing;
    truncated = true;
  } else {
    phases = [...existing, { name, rounds: ordinal }];
  }
  return {
    ...run,
    phases,
    currentPhase: name,
    ...(truncated ? { truncated: true } : {}),
  };
}
