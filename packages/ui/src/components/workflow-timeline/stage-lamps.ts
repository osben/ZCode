import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "@/components/workflow-graph/phase-name.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { StreamSpec } from "./timeline-bands.js";

// The two ordering rules (`isCurrentPhase` / `stationStatus`) used to live in timeline-model.ts;
// after dwf-recursive and dwf-pipeline-display merged, that file reached 430 lines (oxlint max-lines
// cap is 400), so the lamp rules all moved here.

/** Associates `currentPhase` with a station, using the same name rule as `phaseEntryFor`. */
export function isCurrentPhase(
  run: WorkflowRunState | undefined,
  name: string | undefined,
): boolean {
  return phaseNameMatches(name, run?.currentPhase);
}

/**
 * A station's lamp. Member nodes speak first — running / failed are hard facts. Control flow gets a
 * turn only after that: if this station is the current phase and the run is still going, it is running
 * (control flow sits at this station before the first ask is dispatched, after the last ask settles,
 * and until the next token arrives). A station no node has been observed at (zero members, or the
 * whole station skipped) can only be lit by its entry record. `nodeStatus` is the folded result;
 * absent (undefined) means "no nodes" — folding never fabricates a pending for a station control flow
 * did not walk.
 */
export function stationStatus(
  run: WorkflowRunState | undefined,
  nodeStatus: StepRunStatus | undefined,
  current: boolean,
  entered: boolean,
): StepRunStatus | undefined {
  if (run === undefined) return undefined;
  if (nodeStatus === "running" || nodeStatus === "failed") return nodeStatus;
  const live = run.status === "running" || run.status === "pending";
  if (current && live) return "running";
  // The current phase concludes with the run's terminal state: a failure happened at this station
  // (regardless of whether it has nodes); cancelled is drawn like a node failure — failed as well.
  if (current) return run.status === "completed" ? "done" : "failed";
  if (nodeStatus !== undefined) return nodeStatus;
  return entered ? "done" : "pending";
}

/**
 * Stage lamps and stream ink (docs/dynamic-workflow/presentation.md "Station status", "Ink").
 *
 * A **stage** = a station with an `alongside` partner or a stream and at least one member step. A
 * stage's future executes its own `phase()` marker the moment it starts, so "entered" and
 * "is currentPhase" say nothing about it: in the run that triggered it, five markers finished within
 * 108ms, and stations still waiting on their channel were drawn as done ("entered, no nodes"), while
 * the last station (the only currentPhase) carried the run's red stop lamp without running a single
 * node. A stage's lamp therefore looks only at its own nodes and at the stations feeding it:
 *
 * 1. No nodes: pending while the run is alive; once ended, done if `completed` and entered,
 *    otherwise pending;
 * 2. Otherwise the folded value — but while the run is alive and some station feeding it is still
 *    **open**, done remains running (more live work can arrive). A station is open = the run is alive
 *    and, by its own nodes, it is running / pending (no nodes also counts as pending), or a station
 *    feeding it is open. Solved as a fixed point; the feedback loop also terminates.
 *
 * Stations that are not stages, and stages without member steps (markers only), keep following the
 * ordering rule (`sequential`).
 */
export function stageStatuses(input: {
  run: WorkflowRunState | undefined;
  /** Each station's folded member-step status; absent = no nodes. */
  nodeStatuses: readonly (StepRunStatus | undefined)[];
  entered: readonly boolean[];
  /** Whether each station has member steps (marker-only phases do not). */
  hasMembers: readonly boolean[];
  /** Each station's `alongside` (indexes; only later stations can report it, read symmetrically here). */
  alongside: readonly (readonly number[])[];
  streams: readonly StreamSpec[];
  /** Lamps from the ordering rule (non-stage stations use it as-is). */
  sequential: readonly (StepRunStatus | undefined)[];
}): (StepRunStatus | undefined)[] {
  const { alongside, entered, hasMembers, nodeStatuses, run, sequential, streams } = input;
  if (run === undefined) return [...sequential];
  const parallel = new Set([
    ...streams.flatMap((stream) => [stream.from, stream.to]),
    ...alongside.flatMap((near, i) => (near.length > 0 ? [i, ...near] : [])),
  ]);
  const stage = nodeStatuses.map((_, i) => hasMembers[i] === true && parallel.has(i));
  const live = run.status === "running" || run.status === "pending";
  const feeders = nodeStatuses.map(() => [] as number[]);
  for (const stream of streams) feeders[stream.to]?.push(stream.from);

  const own = (i: number): StepRunStatus | undefined =>
    stage[i] ? (nodeStatuses[i] ?? "pending") : sequential[i];
  const open = nodeStatuses.map((_, i) => live && (own(i) === "running" || own(i) === "pending"));
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < open.length; i += 1) {
      if (open[i] || !live || !feeders[i]!.some((f) => open[f])) continue;
      open[i] = true;
      changed = true;
    }
  }

  return nodeStatuses.map((status, i) => {
    if (!stage[i]) return sequential[i];
    if (status === undefined) {
      if (live) return "pending";
      return run.status === "completed" && entered[i] ? "done" : "pending";
    }
    if (status === "done" && live && feeders[i]!.some((f) => open[f])) return "running";
    return status;
  });
}

/** The payload's `phaseStreams` → index pairs: both ends must be listed, no self-loops, one entry per ordered pair. */
export function phaseStreamIndexes(
  streams: readonly { from: string; to: string }[] | undefined,
  index: ReadonlyMap<string, number>,
): StreamSpec[] {
  const out: StreamSpec[] = [];
  const seen = new Set<string>();
  for (const stream of streams ?? []) {
    const from = index.get(stream.from);
    const to = index.get(stream.to);
    if (from === undefined || to === undefined || from === to || seen.has(`${from}>${to}`))
      continue;
    seen.add(`${from}>${to}`);
    out.push({ from, to });
  }
  return out;
}

/**
 * One stream's ink: both ends running is `march` (things passing now); otherwise if the target
 * station has observed a node it is `strong` (has passed); otherwise `faint`. "Has observed a node"
 * rather than `visited`: a stage's entry record exists from the very start of the run.
 */
export function streamInk(
  from: { status: StepRunStatus | undefined },
  to: { status: StepRunStatus | undefined; fraction?: unknown },
): "faint" | "strong" | "march" {
  if (from.status === "running" && to.status === "running") return "march";
  return to.fraction === undefined ? "faint" : "strong";
}
