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
import type { PhaseNaming } from "@/components/workflow-graph/phase-name.js";
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
  isCurrentPhase,
  phaseStreamIndexes,
  stageStatuses,
  stationStatus,
  streamInk,
} from "./stage-lamps.js";
import {
  holeTable,
  railTouchesHole,
  stationFillOf,
  tailStubOf,
  timelineHoleGraph,
  type HoleLabels,
  type TimelineFill,
  type TimelineHole,
} from "./timeline-holes.js";
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
  /** This station is a hole (`timeline-holes.ts`): dashed lamp and type badge; it is the current station while waiting. */
  hole?: TimelineHole;
  /** This station was added by a fill (the `fill` on a display phase); hovering highlights its filled region. */
  fill?: string;
  /** Neighboring station on a fill row's draft phase line: context only, rendered at 40% ink. */
  ghost?: true;
}

/** Track segment between adjacent stations on one track; indices point into `stations`. */
export interface TimelineRail {
  from: number;
  to: number;
  ink: TimelineInk;
  /** Absent means a normal segment on one track; track endpoints are `fork`/`merge`, while adjacent stations on different tracks within a band are `twin`. */
  kind?: TimelineRailKind;
  /** Touches an open/waiting hole: draw it as a dashed line because there is no code there yet. */
  dashed?: true;
}

/** A non-adjacent edge: `to < from` means a back edge. `lane` starts at 0, nearest the track; assign lanes only to arcs that intersect along x (see {@link assignArcLanes}), and keep unrelated arcs at the same height. */
export interface TimelineArc {
  from: number;
  to: number;
  lane: number;
  ink: TimelineInk;
  /** Track above which to draw the arc; lanes are assigned independently per air, so filter by `air` before computing `arcLaneCount`. */
  air: number;
  /** Non-adjacent phase stream: use stream ink, but do not animate it or add a ring to the station. */
  stream?: true;
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
  /** Hole headers left by fills with phases (`timeline-holes.ts`), sorted by `from`; empty when there are no fills. */
  fills?: TimelineFill[];
  /** Hole id → containing hole id (`holeParentsOf` in `timeline-holes.ts`); used to highlight outer regions on hover. */
  holeParents?: Readonly<Record<string, string>>;
  /** The final station is a tail hole: `open` draws a 40px dashed segment that fades out; `filled` reserves only 40px of space. */
  tailStub?: "open" | "filled";
}

/** One model, three consumers (invariant 1): the card, detail page, and sidebar list receive the same model object in the same frame. Memoize by (graph, run) object identity—see `timeline-cache.ts` for why identity is the right key. The model is read-only and no consumer mutates it, so sharing also provides stable references. */
export function buildWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  /**
   * Names and types of filled holes (docs/dynamic-workflow/presentation.md, “Holes on the timeline”):
   * static graphs without a run (confirmation dialog, fill row) receive them from tool input. When
   * provided, skip the shared cache, which is keyed by (graph, run).
   */
  holeLabels?: HoleLabels,
): WorkflowTimelineModel {
  if (holeLabels !== undefined) return computeWorkflowTimeline(input, run, holeLabels);
  return sharedTimelineModel(input, run, () => computeWorkflowTimeline(input, run, undefined));
}

function computeWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  holeLabels: HoleLabels | undefined,
): WorkflowTimelineModel {
  // A phase representing a hole header is not a station; the parent map comes from the uncollapsed graph so nesting remains intact (`timeline-holes.ts`).
  const { graph, parents, phases } = timelineHoleGraph(withImplicitPhase(input));
  const index = new Map(phases.map((phase, i) => [phase.id, i]));
  const members = phaseMembers(graph);
  const holes = holeTable(graph, phases, run, holeLabels, parents);
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
  // Phase streams (spec, “Streams”): also deduplicated by index; they take a stage on a line out of its band.
  const streams = phaseStreamIndexes(graph.phaseStreams, index);
  const alongsideIndexes = phases.map((phase) =>
    (phase.alongside ?? []).flatMap((id) => {
      const at = index.get(id);
      return at === undefined ? [] : [at];
    }),
  );
  const folded = foldPhaseBands(phases.length, alongsideIndexes, streams);
  const fold = foldPhaseEdges(phases.length, folded, edges, streams);
  const arcPairs = [...fold.arcs].sort(
    (left, right) => Math.abs(left.from - left.to) - Math.abs(right.from - right.to),
  );
  // Loop both endpoints of a back-edge; when an endpoint is in a lane, loop the whole lane because a lane is one node and is re-entered as a whole.
  const onLoop = new Set<number>();
  for (const arc of arcPairs) {
    if (arc.to >= arc.from || arc.stream) continue;
    for (const end of [arc.from, arc.to]) {
      const band = bandOf(folded, end);
      if (band === undefined) onLoop.add(end);
      else for (let i = band.from; i <= band.to; i += 1) onLoop.add(i);
    }
  }

  // Name hashes can collide; assign sequential numbers by instance identity so the same agent keeps its avatar across phases.
  const avatarIndexes = new Map<string, number>();
  const nodeStatuses: (StepRunStatus | undefined)[] = [];
  const entered: boolean[] = [];
  const hasMembers: boolean[] = [];
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
    const nodeStatus = collapseStatuses(
      memberSteps.map((step) => step.id),
      overlay.statuses,
    );
    nodeStatuses.push(nodeStatus);
    entered.push(observed.entered);
    hasMembers.push(memberSteps.length > 0);
    // A run paused on a hole makes that station current (its incoming segment is in transit and the view focuses on it); `hole` determines the lamp style.
    const hole = holes.byPhase.get(phase.id);
    const waiting = hole?.state === "waiting";
    return {
      id: phase.id,
      naming: { id: phase.id, ...(phase.name === undefined ? {} : { name: phase.name }) },
      pills,
      status: waiting
        ? "running"
        : stationStatus(run, nodeStatus, isCurrentPhase(run, phase.name), observed.entered),
      visited: observed.visited || waiting,
      rounds: observed.rounds,
      ...(hole === undefined ? {} : { hole }),
      ...stationFillOf(phase, hole),
      onLoop: onLoop.has(i),
      track: trackOf(folded, i),
      ...(observed.observed === 0
        ? {}
        : { fraction: { observed: observed.observed, settled: observed.settled } }),
      ...(unlisted === undefined ? {} : { unlisted }),
    };
  });

  // Stage lamp (spec, “Station status”): for a parallel or streaming station with member steps, use only its own nodes and the stations feeding it.
  const staged = stageStatuses({
    alongside: alongsideIndexes,
    entered,
    hasMembers,
    nodeStatuses,
    run,
    sequential: stations.map((station) => station.status),
    streams,
  });
  // A hole waiting to be filled remains running because the run is paused on it. Even in `future`,
  // it is a parallel station; do not let the stage rule turn it into pending because it has no
  // nodes. These rules were aligned when dwf-recursive and dwf-pipeline-display were merged.
  stations.forEach((station, i) => {
    if (station.hole?.state !== "waiting") station.status = staged[i];
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
    ink:
      rail.kind === "stream"
        ? streamInk(stations[rail.from]!, stations[rail.to]!)
        : visited(rail.from) && visited(rail.to)
          ? ("strong" as TimelineInk)
          : "faint",
    ...(rail.kind === undefined ? {} : { kind: rail.kind }),
    to: rail.to,
    ...(railTouchesHole(stations, rail) ? { dashed: true as const } : {}),
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
      ink: arc.stream
        ? streamInk(stations[arc.from]!, stations[arc.to]!)
        : strong
          ? "strong"
          : "faint",
      lane: lanes[at] ?? 0,
      ...(arc.stream ? { stream: true as const } : {}),
      to: arc.to,
    };
  });

  // Moving edge: the edge from the last settled phase into a running phase. The projection has no timestamps, so choose the most accurate edge by priority:
  // a re-entry back-edge > the track segment entering the station > any arc landing at the station.
  // Process each running station; two tracks in a lane can run at once, and each fork should light up.
  for (let r = 0; r < stations.length; r += 1) {
    if (stations[r]?.status !== "running") continue;
    const entry = bandOf(folded, r)?.from ?? r;
    // Stream rails and stream arcs do not participate (spec, “March” final segment): their ink already indicates whether anything is moving through.
    const reentry = arcs.find(
      (arc) =>
        !arc.stream &&
        arc.to === entry &&
        arc.from > arc.to &&
        visited(arc.from) &&
        stations[r]!.rounds >= 2,
    );
    if (reentry !== undefined) {
      reentry.ink = "march";
      continue;
    }
    // A parallel segment is not a control-flow path; it only says the two stations run concurrently and never animates.
    const inbound = rails.filter(
      (rail) =>
        rail.to === r && rail.kind !== "twin" && rail.kind !== "stream" && visited(rail.from),
    );
    if (inbound.length > 0) {
      for (const rail of inbound) rail.ink = "march";
      continue;
    }
    const landing = arcs.find((arc) => !arc.stream && arc.to === r && visited(arc.from));
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

  const tailStub = tailStubOf(stations);
  return {
    arcs,
    bands,
    fills: holes.fills,
    ...(Object.keys(holes.parents).length === 0 ? {} : { holeParents: holes.parents }),
    live: run !== undefined,
    rails,
    runningIndex,
    stations,
    ...(tailStub === undefined ? {} : { tailStub }),
  };
}
