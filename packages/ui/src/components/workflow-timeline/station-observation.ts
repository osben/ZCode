import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { PhaseBinder } from "@/components/workflow-graph/instance-phases.js";
import { phaseNameMatches } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * What a station observed: instances assigned to that station plus **unlisted** items whose work was attributed to it.
 *
 * Like timeline-bands.ts, this computes only the display model and does not depend on React, DOM, or a clock.
 */

export interface ObservedPhase {
  visited: boolean;
  rounds: number;
  settled: number;
  observed: number;
  /** Control flow entered this station (an entry record exists in `run.phases`). */
  entered: boolean;
}

/**
 * Items omitted from the reduction listing (`run.unlistedByPhase`). `actors` are subagents born in this station and not listed now:
 * this includes ones rejected at birth or evicted while queued/after finishing. They have no pill, face, or transcript.
 * `settled` counts those known to have finished; `failed ⊆ settled`; `nodesSettled` is the count of settled **nodes** omitted from this station.
 * Absent means this station has no omitted items.
 */
export interface StationUnlisted {
  actors: number;
  settled: number;
  failed: number;
  nodesSettled: number;
}

/**
 * Attribute an unlisted bucket by the **birth-phase stamp**, using the same `phaseBinder` as pill binding and station observation:
 * this is one partition, not a broadcast. A bucket without `phaseName` belongs to the unnamed station (same rule as unstamped instances),
 * rather than being assigned arbitrarily. Re-entered stations with the same name each receive their own share, matching the node algorithm.
 */
export function stationUnlisted(
  run: WorkflowRunState | undefined,
  binder: PhaseBinder,
  phaseId: string,
): StationUnlisted | undefined {
  const buckets = run?.unlistedByPhase;
  if (buckets === undefined) return undefined;
  const total: StationUnlisted = { actors: 0, failed: 0, nodesSettled: 0, settled: 0 };
  for (const bucket of buckets) {
    if (!binder.has(phaseId, bucket.phaseName)) continue;
    total.actors += bucket.actors;
    // Zero-valued child keys are omitted on the wire. Absence means "zero", not "unknown", so unfinished items remain pending.
    total.settled += bucket.actorsSettled ?? 0;
    total.failed += bucket.actorsFailed ?? 0;
    total.nodesSettled += bucket.settled;
  }
  return total.actors === 0 && total.settled === 0 && total.nodesSettled === 0 ? undefined : total;
}

type WorkflowRunPhaseEntry = NonNullable<WorkflowRunState["phases"]>[number];

/**
 * Station-entry records are joined by name using `phaseNameMatches` (the same phase-name.ts rule used to bind instances).
 * Two records may share the same 128-character prefix; the exact match takes precedence.
 */
export function phaseEntryFor(
  run: WorkflowRunState | undefined,
  name: string | undefined,
): WorkflowRunPhaseEntry | undefined {
  const entries = run?.phases;
  if (entries === undefined || name === undefined) return undefined;
  return (
    entries.find((entry) => entry.name === name) ??
    entries.find((entry) => phaseNameMatches(name, entry.name))
  );
}

/**
 * Station set: each member step's `source ?? id`. may-set copies report the station ID, matching the join key in run-status.ts;
 * omitting `source` would leave copied stations permanently unvisited.
 */
export function siteIdsOf(
  steps: readonly WorkflowCausalityGraphData["steps"][number][],
): Set<string> {
  return new Set(steps.map((step) => step.source ?? step.id));
}

/**
 * Nodes observed by a station: matching the station alone is insufficient. If k phases re-enter the same station, k cards share its station ID;
 * nodes must also belong to the station by their instance's birth stamp (`belongs`), or visited/rounds/fraction would all be overstated k-fold.
 */
export function observePhase(
  run: WorkflowRunState | undefined,
  siteIds: ReadonlySet<string>,
  entry: WorkflowRunPhaseEntry | undefined,
  belongs: (node: WorkflowRunState["nodes"][number]) => boolean,
  unlisted: StationUnlisted | undefined,
): ObservedPhase {
  const result: ObservedPhase = {
    entered: false,
    observed: 0,
    rounds: 0,
    settled: 0,
    visited: false,
  };
  if (run === undefined) return result;
  for (const node of run.nodes) {
    if (!siteIds.has(node.siteId) || !belongs(node)) continue;
    result.visited = true;
    result.observed += 1;
    if (node.ordinal > result.rounds) result.rounds = node.ordinal;
    if (node.phase === "settled") result.settled += 1;
  }
  // Settled **unlisted nodes** increase both numerator and denominator. They did run; details are simply truncated at the boundary.
  // Omitting them could turn "300/300" into "1/1", which is false. Leave visited/rounds unchanged because those describe control flow.
  result.observed += unlisted?.nodesSettled ?? 0;
  result.settled += unlisted?.nodesSettled ?? 0;
  // Entry record: visited = nodes landed in this station OR control flow entered it; rounds is the greater of the two counts.
  // A second loop iteration in a single-stage body is inferred from node count, while a second iteration in an empty station is visible only in the entry record.
  if (entry !== undefined) {
    result.entered = true;
    result.visited = true;
    if (entry.rounds > result.rounds) result.rounds = entry.rounds;
  }
  return result;
}
