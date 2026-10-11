import type {
  WorkflowRunActor,
  WorkflowRunNode,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { phaseBinder } from "./instance-phases.js";
import {
  isSyntheticLaneId,
  type StepRunStatus,
  type StepStatusTable,
  type WorkflowCausalityGraphData,
} from "./types.js";

/** Pure selector for the live overlay view (live view v1). This view deliberately does not expand into an instance graph: it is the static causal graph submitted at launch with a layer of status decoration. The strongest resulting property is that the graph’s node and edge sets never change during a run; rank is monotonic and the graph never reorders because the overlay does not place cards. There is one tradeoff: a static step may correspond to N runtime instances (loop/fan-out), so status must collapse, and a single card cannot say “round 3 failed, round 4 is running.” */
export interface WorkflowRunOverlay {
  /** Status indexed by graph step ID. Sparse map: steps with no observed instances have no entry. “Every step has a value” was once a React Flow promise because every card needed decoration; after retiring that board no consumer needs it, and it made “never run” and “queued” share pending. */
  statuses: StepStatusTable;
  /** Whether ordering edges from a running step should animate. */
  animatedEdges: boolean;
}

/** Engine phase → one of four `StepRunStatus` values. Vocabulary follows events the engine actually emits: queued / dispatched / executing / waiting / repairing / nudged / settled. executing/waiting are driver observations: the model request was actually sent / it is waiting for a process-level slot or backoff. queued/dispatched/waiting map to pending intentionally: no request is currently running at the provider in any of these states (waiting for FIFO/per-run limit, session readiness before first admission, or a gate/backoff queue). executing indicates real work. */
export function statusOfRunNode(node: WorkflowRunNode): StepRunStatus {
  switch (node.phase) {
    case "executing":
    case "repairing":
    case "nudged":
      return "running";
    case "settled":
      // Draw both failure and cancellation as failed (the journal distinguishes their semantics, but the overlay uses only four status labels).
      // Missing outcome is unreachable in the engine (settled must carry an outcome). If encountered, treat it as finished,
      // because falsely saying pending (not started) is worse than losing one color indicator, and falsely saying failed creates a false alarm.
      return node.outcome === "failed" || node.outcome === "cancelled" ? "failed" : "done";
    default:
      return "pending";
  }
}

/** The only fold: multiset of instance states → one state. Empty set → undefined (absence is not a state, and folding must not invent one; consumers resolve absence from control flow). Any running → running, intentionally before failed: readers most need to know whether anything is still active. A mix of settled and queued → running (started, not finished); the old rule returned pending (“not started”), the same confusion in different clothes. All queued → pending. All settled: any failed → failed, otherwise done. Each rule uses `any`, so folding by station and then participant produces the same result as folding instances directly; two-stage folding does not drift. Input can be instance status (`statusOfRunNode`) or station status (this function’s output); both use the same vocabulary. */
export function aggregateRunStatuses(
  statuses: readonly StepRunStatus[],
): StepRunStatus | undefined {
  if (statuses.length === 0) return undefined;
  if (statuses.includes("running")) return "running";
  const queued = statuses.includes("pending");
  const settled = statuses.some((status) => status === "done" || status === "failed");
  if (queued) return settled ? "running" : "pending";
  return statuses.includes("failed") ? "failed" : "done";
}

/** State gate for one card. `lane` exists only on a may-set expansion; it is the card’s entire claim (“this ask may run in this lane”), so instances from other lanes are irrelevant. `phase` makes the same claim for a phase expansion (“this ask was issued in this phase”), so instances born in other phases are irrelevant. */
interface OverlayTarget {
  instances: StepRunStatus[];
  lane?: string;
  phase?: string;
}

export function workflowRunOverlay(
  run: WorkflowRunState | undefined,
  graph: WorkflowCausalityGraphData,
): WorkflowRunOverlay {
  // Without a run, this is static rendering: return an empty map, not an all-pending map, so the component keeps its “no runtime data” appearance.
  if (!run) return { statuses: {}, animatedEdges: false };

  // Join by station ID, not card ID: after expanding may-set lanes, one station has a card per candidate lane;
  // after phase expansion, one station has a card per claiming phase (`ask#1~phase#3`). `source` remembers the station each copy came from,
  // then narrow each kind of copy by its claim: lane copies by actor lane, phase copies by instance birth phase
  // (`phaseName`, supplied by the same phaseBinder that binds cards and observes stations). If the latter check is omitted,
  // a shared helper dispatching subagents from five phases makes the first batch light all five stations.
  const byStepId = new Map<string, StepRunStatus[]>();
  const targetsBySiteId = new Map<string, OverlayTarget[]>();
  for (const step of graph.steps) {
    const instances: StepRunStatus[] = [];
    byStepId.set(step.id, instances);
    // Do not narrow steps without `source` by lane: when there are >4 candidates (or an unknown candidate), the fallback single card is drawn in lanes[0],
    // but an instance may run in any candidate lane; narrowing would keep that card permanently dark.
    const target: OverlayTarget = {
      instances,
      ...(step.source === undefined ? {} : { lane: step.lane }),
      ...(step.phase === undefined ? {} : { phase: step.phase }),
    };
    const siteId = step.source ?? step.id;
    const targets = targetsBySiteId.get(siteId);
    if (targets === undefined) targetsBySiteId.set(siteId, [target]);
    else targets.push(target);
  }

  const binder = phaseBinder(graph, run);
  for (const node of run.nodes) {
    // Ignore site IDs that do not exist in the graph; the overlay must never add or remove nodes.
    const targets = targetsBySiteId.get(node.siteId);
    if (targets === undefined) continue;
    const status = statusOfRunNode(node);
    for (const target of targets) {
      // Instances with no actorSiteId appear in every copy of their station: over-light the old single-card fallback instead of making the graph dead;
      // liveness hints may light one extra lane, but must never fail to light any lane.
      const belongsToOtherLane =
        target.lane !== undefined &&
        node.actorSiteId !== undefined &&
        node.actorSiteId !== target.lane;
      if (belongsToOtherLane) continue;
      // Same for birth phase: the binder places untagged instances (old runs, created before the marker) according to existing rules;
      // runs with no phase vocabulary appear in all phases, preserving the existing over-light fallback instead of turning the lights off.
      const belongsToOtherPhase =
        target.phase !== undefined && !binder.has(target.phase, node.phaseName);
      if (belongsToOtherPhase) continue;
      target.instances.push(status);
    }
  }

  const statuses: StepStatusTable = {};
  let anyRunning = false;
  for (const [stepId, instanceStatuses] of byStepId) {
    const status = aggregateRunStatuses(instanceStatuses);
    if (status === undefined) continue;
    statuses[stepId] = status;
    if (status === "running") anyRunning = true;
  }

  return { statuses, animatedEdges: anyRunning };
}

/** Lane → actor instances in that lane (phase 5 transcript drill-down: open directly for one instance or show a picker for multiple). Lane site ID is identity; display name is only presentation and follows the causality-graph naming contract. Synthetic `workspace` and `unknown` lanes have no sessions and always return empty, so a world-read step has a selected state but no drill-down. */
export function workflowRunActorsForLane(
  run: WorkflowRunState | undefined,
  laneId: string,
): WorkflowRunActor[] {
  if (!run || isSyntheticLaneId(laneId)) return [];
  return run.actors
    .filter((actor) => actor.siteId === laneId)
    .sort((left, right) => left.ordinal - right.ordinal);
}
