import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { laneRefsById, type LaneRef } from "@/components/workflow-graph/lane-name.js";
import {
  collapseStatuses,
  liveParticipantView,
  participantStatus,
  participantsOfPhase,
  withImplicitPhase,
} from "@/components/workflow-graph/participant-model.js";
import { phaseBinder } from "@/components/workflow-graph/instance-phases.js";
import { phaseNameMatches, type PhaseNaming } from "@/components/workflow-graph/phase-name.js";
import { phaseMembers } from "@/components/workflow-graph/phase-model.js";
import { workflowRunOverlay } from "@/components/workflow-graph/run-status.js";
import {
  laneClassOf,
  type LaneClass,
  type StepRunStatus,
  type WorkflowCausalityGraphData,
} from "@/components/workflow-graph/types.js";
import { sharedTimelineModel } from "./timeline-cache.js";
import {
  observePhase,
  phaseEntryFor,
  siteIdsOf,
  stationUnlisted,
  type StationUnlisted,
} from "./station-observation.js";
import {
  assignAirLanes,
  bandOf,
  foldPhaseBands,
  foldPhaseEdges,
  trackOf,
  type RailSpec,
  type TimelineRailKind,
} from "./timeline-bands.js";

/** Timeline model. One pure function folds the bounded display and `workflowRuns` projection into three things: stations (phases), track segments (between adjacent connected stations), and arcs (non-adjacent edges). Chat cards, confirmation dialogs, and sidebar lists all derive from this model—the invariant is “one model, three consumers.” No React, DOM, or time. Order is declaration order (`phases[]` follows the first `phase()` marker), not rank: sibling phases that share only a predecessor appear in declaration order, with their connecting edges shown as arcs. A back edge is determined by direction (its target station is left of its source), not by payload `back`: the analyzer treats re-entry (a second `phase("plan")` marker) as a forward edge, though it still points left on screen. */

export type TimelineInk = "faint" | "strong" | "march";
export type { TimelineRailKind } from "./timeline-bands.js";
// Arc lane assignment is pure index combinatorics; it lives with track folding in timeline-bands.ts and is re-exported here to keep the renderer entry point unchanged.
export { arcLaneCount, assignArcLanes } from "./timeline-bands.js";

export interface TimelinePill {
  /** Split participant ID (instance card `${participant}@${ordinal}`); used as the React key and when opening an instance. */
  key: string;
  lane: LaneRef;
  laneClass: LaneClass;
  /** Runtime name emitted by the engine (persona may rewrite the name in the script); if absent, use the lane display name. */
  runtimeName?: string;
  /** Avatar number assigned to this agent identity within a workflow; reused across phases. */
  avatarIndex?: number;
  /** undefined when there is no run (static pill, visually identical to pending). */
  status: StepRunStatus | undefined;
  /** Instance corresponding to this pill in the projection; synthetic lanes (workspace/unknown) have none. */
  instance?: { siteId: string; ordinal: number; sessionId?: string };
  /** Slot identity exposed by the pill: the instance ordinal when an instance exists, or its future ordinal otherwise—member card `member.index + 1`, single and `many` cards use 1 (the engine numbers them in station order). Available only for an agent lane in a live run; this lets an unstarted subagent open a placeholder transcript tab. */
  slot?: { siteId: string; ordinal: number };
  /** Handle exposed by a script pill: it has no instance or session, so it can open only the transcript for the entire run, anchored on the first card in this station. Mutually exclusive with `slot`; available only for a workspace lane in a live run. Without a run, there is nothing to open. */
  workspace?: { phaseId: string };
  /** This participant’s step ID in this phase (source for sidebar activity and counts). */
  stepIds: string[];
  /** Whether this instance has pending escalation questions (`run.pendingQuestions`); used by the roster pinning rule. */
  asking?: true;
}

export interface TimelineStation {
  id: string;
  naming: PhaseNaming;
  pills: TimelinePill[];
  /** Folded member step state; undefined when there is no run. */
  status: StepRunStatus | undefined;
  /** Whether the projection contains any node in this station. */
  visited: boolean;
  /** Maximum ordinal of a node in this station; 0 means not yet reached. */
  rounds: number;
  /** Whether this station is the source or target of any back edge (left-pointing arc); only such stations show `⟳ n`. */
  onLoop: boolean;
  /** Track containing this station (`timeline-bands.ts`); stations outside a band use track 0 (the main track). */
  track: number;
  /** `settled / observed`; absent when no nodes have been observed. Settled instances outside the table are included too. */
  fraction?: { settled: number; observed: number };
  /** Number of out-of-table entries consumed at this station (`station-observation.ts`); absent when none were consumed. */
  unlisted?: StationUnlisted;
  /** Last station not yet closed in the streaming draft. */
  typing?: true;
}

/** Track segment between adjacent stations on one track; indices point into `stations`. */
export interface TimelineRail {
  from: number;
  to: number;
  ink: TimelineInk;
  /** Absent means a normal segment on one track; track endpoints are `fork`/`merge`, while adjacent stations on different tracks within a band are `twin`. */
  kind?: TimelineRailKind;
}

/** A non-adjacent edge: `to < from` means a back edge. `lane` starts at 0, nearest the track; assign lanes only to arcs that intersect along x (see {@link assignArcLanes}), and keep unrelated arcs at the same height. */
export interface TimelineArc {
  from: number;
  to: number;
  lane: number;
  ink: TimelineInk;
  /** Track above which to draw the arc; lanes are assigned independently per air, so filter by `air` before computing `arcLaneCount`. */
  air: number;
}

/** One track within a band; `stations` are its members in declaration order. */
export interface TimelineTrack {
  stations: number[];
  /** Ink entering this track from a fork; without a predecessor, use whether the first station has been reached. */
  entry: TimelineInk;
  /** Ink leaving this track through a merge; without a merge station, use whether the last station has been reached. */
  exit: TimelineInk;
}

/** A band: a declaration-order contiguous span of stations split across several tracks; arcs treat it as one node (`timeline-bands.ts`). */
export interface TimelineBand {
  from: number;
  to: number;
  /** Predecessor station for the fork; when absent, the visual contains only a short tail. */
  pred?: number;
  /** Successor station for the merge; when absent, the visual contains only a short stub. */
  join?: number;
  tracks: TimelineTrack[];
}

export interface WorkflowTimelineModel {
  stations: TimelineStation[];
  rails: TimelineRail[];
  arcs: TimelineArc[];
  /** Bands folded from parallel phases, sorted by `from`; a timeline without `alongside` has none. */
  bands: TimelineBand[];
  /** Currently running station (rightmost if there are several); undefined if none. */
  runningIndex: number | undefined;
  /** Whether any run projection is present (determines whether status lights/ink have anything to show). */
  live: boolean;
  /** Streaming draft: stations are written as text arrives; subagents are counted but not drawn (`draft-scan.ts`). The analyzer model does not include this. */
  draft?: { agents: number };
}

/** How `currentPhase` maps to a station, using the same name rule as `phaseEntryFor`. */
function isCurrentPhase(run: WorkflowRunState | undefined, name: string | undefined): boolean {
  return phaseNameMatches(name, run?.currentPhase);
}

/** Station light. Member nodes take precedence: running/failed are hard facts. Control flow is considered next: the current phase is running while the run is active (control stays on this station before the first ask is dispatched and after the last ask settles until the next marker). A station with no observed nodes (zero members or entirely skipped) can be lit only by an entry record. `nodeStatus` is the folded result; undefined means “no node,” and folding does not invent a pending state for a station the control flow never reached. */
function stationStatus(
  run: WorkflowRunState | undefined,
  nodeStatus: StepRunStatus | undefined,
  current: boolean,
  entered: boolean,
): StepRunStatus | undefined {
  if (run === undefined) return undefined;
  if (nodeStatus === "running" || nodeStatus === "failed") return nodeStatus;
  const live = run.status === "running" || run.status === "pending";
  if (current && live) return "running";
  // When a run ends, the current phase is finalized at this station (whether it has nodes or not);
  // cancelled is drawn like a node cancellation and therefore also appears as failed.
  if (current) return run.status === "completed" ? "done" : "failed";
  if (nodeStatus !== undefined) return nodeStatus;
  return entered ? "done" : "pending";
}

/** One model, three consumers (invariant 1): the card, detail page, and sidebar list receive the same model object in the same frame. Memoize by (graph, run) object identity—see `timeline-cache.ts` for why identity is the right key. The model is read-only and no consumer mutates it, so sharing also provides stable references. */
export function buildWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): WorkflowTimelineModel {
  return sharedTimelineModel(input, run, () => computeWorkflowTimeline(input, run));
}

function computeWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): WorkflowTimelineModel {
  const graph = withImplicitPhase(input);
  const phases = graph.phases ?? [];
  const index = new Map(phases.map((phase, i) => [phase.id, i]));
  const members = phaseMembers(graph);
  const overlay = workflowRunOverlay(run, graph);
  const live = liveParticipantView(graph, run);
  const binder = phaseBinder(graph, run);
  const laneRefs = laneRefsById(graph.lanes);
  const sessionByInstance = new Map(
    (run?.actors ?? []).map((actor) => [`${actor.siteId}@${actor.ordinal}`, actor.sessionId]),
  );
  const askingInstances = new Set(
    (run?.pendingQuestions ?? [])
      .filter(
        (question) => question.actorSiteId !== undefined && question.actorOrdinal !== undefined,
      )
      .map((question) => `${question.actorSiteId}@${question.actorOrdinal}`),
  );

  // Edges: deduplicate by index first (self-loops and edges to unlisted phases do not apply at this level), then collapse through lanes.
  // Adjacent edges become track segments, the rest become arcs, and lanes absorb the fork/merge edges (`timeline-bands.ts`).
  const edges: { from: number; to: number }[] = [];
  const seen = new Set<string>();
  for (const edge of graph.phaseEdges ?? []) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  const folded = foldPhaseBands(
    phases.length,
    phases.map((phase) =>
      (phase.alongside ?? []).flatMap((id) => {
        const at = index.get(id);
        return at === undefined ? [] : [at];
      }),
    ),
  );
  const fold = foldPhaseEdges(phases.length, folded, edges);
  const arcPairs = [...fold.arcs].sort(
    (left, right) => Math.abs(left.from - left.to) - Math.abs(right.from - right.to),
  );
  // Loop both endpoints of a back-edge; when an endpoint is in a lane, loop the whole lane because a lane is one node and is re-entered as a whole.
  const onLoop = new Set<number>();
  for (const arc of arcPairs) {
    if (arc.to >= arc.from) continue;
    for (const end of [arc.from, arc.to]) {
      const band = bandOf(folded, end);
      if (band === undefined) onLoop.add(end);
      else for (let i = band.from; i <= band.to; i += 1) onLoop.add(i);
    }
  }

  // Name hashes can collide; assign sequential numbers by instance identity so the same agent keeps its avatar across phases.
  const avatarIndexes = new Map<string, number>();
  const stations: TimelineStation[] = phases.map((phase, i) => {
    const memberSteps = members.get(phase.id) ?? [];
    const unlisted = stationUnlisted(run, binder, phase.id);
    const observed = observePhase(
      run,
      siteIdsOf(memberSteps),
      phaseEntryFor(run, phase.name),
      (node) => binder.has(phase.id, node.phaseName),
      unlisted,
    );
    const pills: TimelinePill[] = participantsOfPhase(live.graph, phase.id).map((participant) => {
      const instance = live.instances[participant.id];
      const lane = laneRefs.get(participant.lane) ?? {
        id: participant.lane,
        laneClass: laneClassOf(participant.lane),
      };
      // Empty after folding means this subagent did nothing in this station/run; the hollow marker is accurate.
      // Reserve undefined for static pills with no run.
      const status =
        run === undefined
          ? undefined
          : (participantStatus(participant, overlay.statuses, live.participantStatuses) ??
            "pending");
      const sessionId =
        instance === undefined
          ? undefined
          : sessionByInstance.get(`${participant.lane}@${instance.ordinal}`);
      const slot =
        run !== undefined && lane.laneClass === "agent"
          ? {
              ordinal: instance?.ordinal ?? (participant.member?.index ?? 0) + 1,
              siteId: participant.lane,
            }
          : undefined;
      const avatarKey = `${participant.lane}@${instance?.ordinal ?? (participant.member?.index ?? 0) + 1}`;
      if (lane.laneClass === "agent" && !avatarIndexes.has(avatarKey)) {
        avatarIndexes.set(avatarKey, avatarIndexes.size);
      }
      return {
        ...(lane.laneClass === "agent" ? { avatarIndex: avatarIndexes.get(avatarKey)! } : {}),
        key: participant.id,
        lane,
        laneClass: lane.laneClass,
        ...(instance?.name === undefined ? {} : { runtimeName: instance.name }),
        status,
        ...(instance === undefined
          ? {}
          : {
              instance: {
                ordinal: instance.ordinal,
                siteId: participant.lane,
                ...(sessionId === undefined ? {} : { sessionId }),
              },
            }),
        ...(slot === undefined ? {} : { slot }),
        ...(run !== undefined && lane.laneClass === "workspace"
          ? { workspace: { phaseId: phase.id } }
          : {}),
        stepIds: [...participant.steps],
        ...(instance !== undefined && askingInstances.has(`${participant.lane}@${instance.ordinal}`)
          ? { asking: true as const }
          : {}),
      };
    });
    return {
      id: phase.id,
      naming: { id: phase.id, ...(phase.name === undefined ? {} : { name: phase.name }) },
      pills,
      status: stationStatus(
        run,
        collapseStatuses(
          memberSteps.map((step) => step.id),
          overlay.statuses,
        ),
        isCurrentPhase(run, phase.name),
        observed.entered,
      ),
      visited: observed.visited,
      rounds: observed.rounds,
      onLoop: onLoop.has(i),
      track: trackOf(folded, i),
      ...(observed.observed === 0
        ? {}
        : { fraction: { observed: observed.observed, settled: observed.settled } }),
      ...(unlisted === undefined ? {} : { unlisted }),
    };
  });

  const visited = (i: number): boolean => stations[i]?.visited === true;
  let runningIndex: number | undefined;
  for (let i = stations.length - 1; i >= 0; i -= 1) {
    if (stations[i]?.status === "running") {
      runningIndex = i;
      break;
    }
  }

  const rails: TimelineRail[] = fold.rails.map((rail: RailSpec) => ({
    from: rail.from,
    ink: visited(rail.from) && visited(rail.to) ? ("strong" as TimelineInk) : "faint",
    ...(rail.kind === undefined ? {} : { kind: rail.kind }),
    to: rail.to,
  }));
  const lanes = assignAirLanes(arcPairs);
  const arcs: TimelineArc[] = arcPairs.map((arc, at) => {
    const back = arc.to < arc.from;
    const strong = back
      ? visited(arc.from) && (stations[arc.to]?.rounds ?? 0) >= 2
      : visited(arc.from) && visited(arc.to);
    return {
      air: arc.air,
      from: arc.from,
      ink: strong ? "strong" : "faint",
      lane: lanes[at] ?? 0,
      to: arc.to,
    };
  });

  // Moving edge: the edge from the last settled phase into a running phase. The projection has no timestamps, so choose the most accurate edge by priority:
  // a re-entry back-edge > the track segment entering the station > any arc landing at the station.
  // Process each running station; two tracks in a lane can run at once, and each fork should light up.
  for (let r = 0; r < stations.length; r += 1) {
    if (stations[r]?.status !== "running") continue;
    const entry = bandOf(folded, r)?.from ?? r;
    const reentry = arcs.find(
      (arc) =>
        arc.to === entry && arc.from > arc.to && visited(arc.from) && stations[r]!.rounds >= 2,
    );
    if (reentry !== undefined) {
      reentry.ink = "march";
      continue;
    }
    // A parallel segment is not a control-flow path; it only says the two stations run concurrently and never animates.
    const inbound = rails.filter(
      (rail) => rail.to === r && rail.kind !== "twin" && visited(rail.from),
    );
    if (inbound.length > 0) {
      for (const rail of inbound) rail.ink = "march";
      continue;
    }
    const landing = arcs.find((arc) => arc.to === r && visited(arc.from));
    if (landing !== undefined) landing.ink = "march";
  }

  const railInk = (from: number, to: number): TimelineInk =>
    rails.find((rail) => rail.from === from && rail.to === to && rail.kind !== "twin")?.ink ??
    "faint";
  const bands: TimelineBand[] = fold.bands.map((band) => ({
    from: band.from,
    ...(band.join === undefined ? {} : { join: band.join }),
    ...(band.pred === undefined ? {} : { pred: band.pred }),
    to: band.to,
    tracks: band.tracks.map((members) => {
      const head = members[0]!;
      const tail = members[members.length - 1]!;
      return {
        entry:
          band.pred === undefined
            ? ((visited(head) ? "strong" : "faint") as TimelineInk)
            : railInk(band.pred, head),
        exit:
          band.join === undefined
            ? ((visited(tail) ? "strong" : "faint") as TimelineInk)
            : railInk(tail, band.join),
        stations: [...members],
      };
    }),
  }));

  return { arcs, bands, live: run !== undefined, rails, runningIndex, stations };
}

/** What a pill is "doing": prefer the running step's label, then the last settled one, then the first. */
export function pillActivity(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  pill: TimelinePill,
): { label: string; asks: number; reads: number } {
  const stepsById = new Map(graph.steps.map((step) => [step.id, step]));
  const statuses = run === undefined ? {} : workflowRunOverlay(run, graph).statuses;
  let asks = 0;
  let reads = 0;
  let running: string | undefined;
  let done: string | undefined;
  let first: string | undefined;
  for (const id of pill.stepIds) {
    const step = stepsById.get(id);
    if (step === undefined) continue;
    if (step.kind === "world-read") reads += 1;
    else asks += 1;
    first ??= step.label;
    const status = statuses[id];
    if (status === "running") running ??= step.label;
    else if (status === "done" || status === "failed") done = step.label;
  }
  return { asks, label: running ?? done ?? first ?? "", reads };
}
