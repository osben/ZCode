// Pure model for a workflow run row in the sidebar.
// Input is workflowActivity from sessions-index plus the set confirmed by the renderer; output is “which rows to draw and how many dots per row.”
// No clock or DOM: collapse completed rows based only on the confirmation set, not time.
import type {
  SessionWorkflowActivity,
  SessionWorkflowPhaseSummary,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { isSessionWorkflowRunLive } from "@zcode/shared/zcode-protocol-v4";
import { bandOf, foldPhaseBands, trackOf } from "../components/workflow-timeline/timeline-bands.js";

/** Maximum number of run rows to draw for one session; fold the rest into “+n”. */
export const WORKFLOW_RUN_LINE_MAX_LINES = 2;
/** Maximum number of stations on a mini track; when there are more, fold to run station ±2 and add a trailing “+n”. */
const WORKFLOW_RUN_RAIL_MAX_STATIONS = 6;
/** Number of stations on either side of the run station to keep when folded. */
const RAIL_FOLD_RADIUS = 2;

export interface WorkflowRunRailStation {
  name: string;
  status: SessionWorkflowPhaseSummary["status"];
  /** Whether control flow has traversed the track segment entering this station (strong-color segment). */
  reached: boolean;
  /**
   * Whether the segment entering this station is a **double-line segment**: this station and the previous one belong to the same band but different lanes, and control flow did not go from the previous station
   * to this one—they run in parallel.
   * The marker is attached to the **station**, not the segment, so it survives the window fold below.
   */
  twin?: true;
  /** This site is an open hole: a dashed 6px indicator, using the warning color while waiting (docs/dynamic-workflow/presentation.md, “Holes on the timeline”). */
  hole?: "open" | "waiting";
}

export interface WorkflowRunRail {
  stations: WorkflowRunRailStation[];
  /** Number of folded-out stations not drawn (trailing “+n”); omit the tail when 0. */
  hidden: number;
  /** The script has no stage vocabulary; draw an implicit station named “Workflow.” */
  implicit: boolean;
}

/** Whether control flow has reached this station: running / done / failed all count. */
function isWorkflowRunStationReached(status: SessionWorkflowPhaseSummary["status"]): boolean {
  return status !== "pending";
}

/**
 * Fold the mini track: draw all stations when there are ≤ 6; otherwise keep a fixed window of five stations (±2) centered on the running station,
 * or on the last reached station, or the first station if none have been reached. Fold the rest into a trailing “+n”. This is a **fixed window**, not scrolling: the sidebar has no horizontal gesture.
 */
export function foldWorkflowRunRail(
  phases: readonly SessionWorkflowPhaseSummary[],
): WorkflowRunRail {
  if (phases.length === 0) {
    return { stations: [], hidden: 0, implicit: true };
  }
  // Fold bands across the **full list**: the window selects only one part, while bands are connected components in declaration order; regrouping only by window indices
  // would split bands across the window boundary. Fold first, then apply the window; the double-line marker follows its station.
  const bands = foldPhaseBands(
    phases.length,
    phases.map((phase) => phase.alongside ?? []),
  );
  const all: WorkflowRunRailStation[] = phases.map((phase, index) => {
    const band = index === 0 ? undefined : bandOf(bands, index);
    const twin =
      band !== undefined &&
      band === bandOf(bands, index - 1) &&
      trackOf(bands, index) !== trackOf(bands, index - 1);
    return {
      name: phase.name,
      status: phase.status,
      // A hole waiting for completion is where control flow has arrived; the segment leading to it has already run.
      reached: isWorkflowRunStationReached(phase.status) || phase.hole === "waiting",
      ...(twin ? { twin: true as const } : {}),
      ...(phase.hole === undefined ? {} : { hole: phase.hole }),
    };
  });
  if (all.length <= WORKFLOW_RUN_RAIL_MAX_STATIONS) {
    return { stations: all, hidden: 0, implicit: false };
  }
  // The window is anchored to a run site. If the run is paused at a hole, that site is the anchor (its indicator is a warning-colored dashed line, not a running state).
  let anchor = all.findIndex(
    (station) => station.status === "running" || station.hole === "waiting",
  );
  if (anchor < 0) {
    for (let index = all.length - 1; index >= 0; index -= 1) {
      if (all[index]!.reached) {
        anchor = index;
        break;
      }
    }
  }
  if (anchor < 0) anchor = 0;
  const windowSize = RAIL_FOLD_RADIUS * 2 + 1;
  let start = Math.max(0, anchor - RAIL_FOLD_RADIUS);
  const end = Math.min(all.length, start + windowSize);
  start = Math.max(0, end - windowSize);
  const stations = all.slice(start, end);
  return { stations, hidden: all.length - stations.length, implicit: false };
}

/** Connector between parallel stages: several stations are active side by side, not queued. */
export const WORKFLOW_RUN_PARALLEL_SEPARATOR = " ∥ ";

/**
 * Join names of simultaneously running stations into one tooltip segment. With parallel work, “current phase” is no longer one station—none is more current than another,
 * so show the names of all running stations instead.
 *
 * Returns `undefined` with zero or one running station; the caller then falls back to `currentPhase` with unchanged copy.
 */
export function workflowRunParallelPhaseLabel(
  phases: readonly SessionWorkflowPhaseSummary[],
): string | undefined {
  const running = phases.filter((phase) => phase.status === "running");
  return running.length > 1
    ? running.map((phase) => phase.name).join(WORKFLOW_RUN_PARALLEL_SEPARATOR)
    : undefined;
}

interface WorkflowRunLineSelection {
  lines: SessionWorkflowRunSummary[];
  /** Number of rows not drawn (for the “+n” label). */
  overflow: number;
}

/**
 * Select rows to draw: always include running rows; include completed rows only when **unconfirmed** (confirmation means the session was opened).
 * Input order is already set by the projection (running rows by start order first, followed by most recently completed); only filter and truncate here.
 */
export function selectWorkflowRunLines(
  activity: SessionWorkflowActivity | undefined,
  isAcknowledged: (runId: string) => boolean,
): WorkflowRunLineSelection {
  if (activity === undefined) return { lines: [], overflow: 0 };
  const visible = activity.runs.filter(
    (run) => isSessionWorkflowRunLive(run.status) || !isAcknowledged(run.runId),
  );
  return {
    lines: visible.slice(0, WORKFLOW_RUN_LINE_MAX_LINES),
    overflow: Math.max(0, visible.length - WORKFLOW_RUN_LINE_MAX_LINES),
  };
}

/** IDs of completed runs (can be confirmed); confirm all at once when the session opens. */
export function settledWorkflowRunIds(activity: SessionWorkflowActivity | undefined): string[] {
  if (activity === undefined) return [];
  return activity.runs
    .filter((run) => !isSessionWorkflowRunLive(run.status))
    .map((run) => run.runId);
}

/** Number of running runs (pulse dot and count beside a collapsed project-group header). */
export function countLiveWorkflowRuns(activity: SessionWorkflowActivity | undefined): number {
  if (activity === undefined) return 0;
  return activity.runs.filter((run) => isSessionWorkflowRunLive(run.status)).length;
}
