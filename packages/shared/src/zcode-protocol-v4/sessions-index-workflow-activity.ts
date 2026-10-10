// ============================================================
// Workflow run summary for sessions-index.
// ============================================================
// The sidebar needs a “Workflow icon + mini phase lights + current phase name” under each session title, but must not subscribe to all
// workflowRuns (the authoritative conversation projection, which changes frequently as each run progresses). This derives a bounded summary
// from `workflowRuns` + `backgroundWorks` in the same snapshot, containing **only fields the sidebar reads**:
// it is a pure function with no clock; the renderer's acknowledged set decides when ended rows collapse, so this code stores no time.

import { z } from "zod";
import { timestampSchema } from "./core.js";
import type { BackgroundWorkSummary } from "./snapshot.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunSchema,
  type WorkflowRunNode,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/** Maximum runs sent per session: active runs first in start order, followed by the most recently ended. */
export const SESSION_WORKFLOW_ACTIVITY_MAX_RUNS = 4;

/**
 * Four phase-light states, using the same vocabulary as the card timeline (`STATUS_DOT`). Control flow provides the outline: while running,
 * the current phase is running, entered phases are done, and the rest are pending; completed means entered phases are done; errored means the current phase failed; stopped means the current phase is pending.
 *
 * Member nodes add one more rule: while a run is active, a node **born in this phase** and actually running now lights it up.
 * Parallel phases can therefore be active at once: control flow remembers only the latest marker, while A's subagent may still work after the marker for B.
 * Nodes can only say “still running”; they never change done/failed/pending. Failure status comes from control flow.
 */
export const sessionWorkflowPhaseStatusSchema = z.enum(["pending", "running", "done", "failed"]);
export type SessionWorkflowPhaseStatus = z.infer<typeof sessionWorkflowPhaseStatusSchema>;

export const sessionWorkflowPhaseSummarySchema = z.object({
  name: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength),
  status: sessionWorkflowPhaseStatusSchema,
  /**
   * **Indexes** of other phases still running when this phase was entered (indexes into this `phases` array), from
   * `run.phaseAlongside`. The sidebar uses these to draw a double connector between parallel phases. This fact exists only when using the declared phase list;
   * the fallback list (entered phases) is built in entry order and has no parallelism, so the key is omitted there.
   */
  alongside: z.array(z.number().int().nonnegative()).max(WORKFLOW_RUNS_LIMITS.maxPhases).optional(),
});
export type SessionWorkflowPhaseSummary = z.infer<typeof sessionWorkflowPhaseSummarySchema>;

export const sessionWorkflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  /** Tool call ID of the initiating row, used to open the run pane when the row is clicked; directly launched runs also have one (`launch-` prefix). */
  toolCallId: z.string().min(1).optional(),
  /** Title of the workflow background work (= run display name); omitted when the projection has no matching background work. */
  name: z.string().min(1).optional(),
  status: workflowRunSchema.shape.status,
  stopReason: workflowRunSchema.shape.stopReason,
  /** Background work start time, used for elapsed time in the tooltip; omitted when there is no background work. */
  startedAt: timestampSchema.optional(),
  /**
   * Phase list in declaration order: use `run.phaseNames` (declared list from run-launched) when present; otherwise fall back to entered
   * phases plus the current phase in entry order. If both are empty, the UI draws an implicit phase named “Workflow”.
   */
  phases: z.array(sessionWorkflowPhaseSummarySchema).max(WORKFLOW_RUNS_LIMITS.maxPhases),
  currentPhase: z.string().min(1).max(WORKFLOW_RUNS_LIMITS.maxPhaseNameLength).optional(),
  /** Number of subagents with status === "running" (shown in the tooltip as “{n} agents working”). */
  agentsWorking: z.number().int().nonnegative(),
});
export type SessionWorkflowRunSummary = z.infer<typeof sessionWorkflowRunSummarySchema>;

export const sessionWorkflowActivitySchema = z.object({
  runs: z.array(sessionWorkflowRunSummarySchema).max(SESSION_WORKFLOW_ACTIVITY_MAX_RUNS),
});
export type SessionWorkflowActivity = z.infer<typeof sessionWorkflowActivitySchema>;

export function isSessionWorkflowRunLive(status: SessionWorkflowRunSummary["status"]): boolean {
  return status === "pending" || status === "running";
}

/**
 * “This node is actually running now”: matches the running branch of `statusOfRunNode` in packages/ui and the statuses used by
 * the reducer for the actor's three states (workflow-runs-reducer.ts), so phase lights and “{n} agents working” always agree on what counts as running.
 *
 * `dispatched` / `waiting` do not count: the former is the brief phase after the session is ready but before the first request is admitted; the latter waits for a slot
 * or backs off. `node-executing` indicates that work was actually dispatched.
 */
function isRunNodeRunning(node: WorkflowRunNode): boolean {
  return node.phase === "executing" || node.phase === "repairing" || node.phase === "nudged";
}

/**
 * Association rule between phase names and instance birth timestamps. Matches `phaseNameMatches` in packages/ui (workflow-graph/phase-name.ts):
 * exact match first, with prefix fallback only when the phase name **exactly reaches the limit**. Prefix matching is enabled only when truncation actually occurred;
 * otherwise “Plan” could match “Plan repair”. That helper lives in the UI layer, so shared inlines the same rule instead of depending on UI.
 */
function phaseNameMatches(stationName: string, stamp: string): boolean {
  return (
    stationName === stamp ||
    (stationName.length >= WORKFLOW_RUNS_LIMITS.maxPhaseNameLength && stamp.startsWith(stationName))
  );
}

function derivePhases(run: WorkflowRunState): SessionWorkflowPhaseSummary[] {
  const entered = new Set((run.phases ?? []).map((phase) => phase.name));
  const current = run.currentPhase;
  let names: string[];
  // “Running alongside” indexes refer to positions in the **declared phase list**, so they are meaningful only on that path; the fallback list
  // (entered phases plus current phase) uses a different index space, so omit the whole field there.
  let alongside: readonly (readonly number[])[] | undefined;
  if (run.phaseNames !== undefined && run.phaseNames.length > 0) {
    names = run.phaseNames;
    alongside = run.phaseAlongside;
  } else {
    names = (run.phases ?? []).map((phase) => phase.name);
    if (current !== undefined && !entered.has(current)) names = [...names, current];
  }
  const live = isSessionWorkflowRunLive(run.status);
  // Birth timestamps for running nodes. The list is empty when the run is not active: no one is working in a terminal run, even if a settled
  // event has not yet been recorded (matching the actor's three-state rule that terminal state takes precedence).
  const burning = live
    ? run.nodes.filter(isRunNodeRunning).flatMap((node) => node.phaseName ?? [])
    : [];
  const emitted = Math.min(names.length, WORKFLOW_RUNS_LIMITS.maxPhases);
  return names.slice(0, WORKFLOW_RUNS_LIMITS.maxPhases).map((name, index) => {
    const isCurrent = name === current;
    const wasEntered = entered.has(name) || isCurrent;
    // A node born in this phase is still running, so this phase remains active even if control flow has advanced to the next marker.
    const burningHere = burning.some((stamp) => phaseNameMatches(name, stamp));
    let status: SessionWorkflowPhaseStatus;
    if (live) {
      status = isCurrent || burningHere ? "running" : wasEntered ? "done" : "pending";
    } else if (run.status === "completed") {
      status = wasEntered ? "done" : "pending";
    } else if (run.status === "errored") {
      status = isCurrent ? "failed" : wasEntered ? "done" : "pending";
    } else {
      // stopped: control flow stopped at the current phase; it is neither complete nor failed, so leave an unfilled light.
      status = isCurrent ? "pending" : wasEntered ? "done" : "pending";
    }
    // Trimming the list narrows its index space: discard references to trimmed phases, and omit the key if none remain.
    const beside = (alongside?.[index] ?? []).filter(
      (other) => Number.isInteger(other) && other >= 0 && other < emitted && other !== index,
    );
    return { name, status, ...(beside.length === 0 ? {} : { alongside: beside }) };
  });
}

function summarizeRun(
  run: WorkflowRunState,
  work: BackgroundWorkSummary | undefined,
): SessionWorkflowRunSummary {
  const name = work?.title.trim();
  return {
    runId: run.runId,
    ...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
    ...(name === undefined || name.length === 0 ? {} : { name }),
    status: run.status,
    ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
    ...(work === undefined ? {} : { startedAt: work.startedAt }),
    phases: derivePhases(run),
    ...(run.currentPhase === undefined ? {} : { currentPhase: run.currentPhase }),
    agentsWorking: run.actors.filter((actor) => actor.status === "running").length,
  };
}

/**
 * Derive a session's workflow run summary from `workflowRuns` + `backgroundWorks` in the same snapshot.
 * Active runs (pending/running) come first in `runs[]` order (= start order); ended runs follow, sorted by background work `endedAt`
 * descending, or by `runs[]` descending when `endedAt` is absent (later-created first). Trim the total to 4.
 * If the session has no runs, return `undefined` (omit the key entirely so older CLIs remain unchanged).
 */
export function deriveSessionWorkflowActivity(input: {
  workflowRuns: WorkflowRunsState | undefined;
  backgroundWorks: readonly BackgroundWorkSummary[];
}): SessionWorkflowActivity | undefined {
  const runs = input.workflowRuns?.runs;
  if (runs === undefined || runs.length === 0) return undefined;
  const workByRunId = new Map<string, BackgroundWorkSummary>();
  for (const work of input.backgroundWorks) {
    if (work.kind === "workflow") workByRunId.set(work.workId, work);
  }
  const live: SessionWorkflowRunSummary[] = [];
  const settled: { summary: SessionWorkflowRunSummary; endedAt: number; index: number }[] = [];
  runs.forEach((run, index) => {
    const work = workByRunId.get(run.runId);
    const summary = summarizeRun(run, work);
    if (isSessionWorkflowRunLive(run.status)) live.push(summary);
    else settled.push({ summary, endedAt: work?.endedAt ?? 0, index });
  });
  settled.sort((a, b) => b.endedAt - a.endedAt || b.index - a.index);
  return {
    runs: [...live, ...settled.map((entry) => entry.summary)].slice(
      0,
      SESSION_WORKFLOW_ACTIVITY_MAX_RUNS,
    ),
  };
}
