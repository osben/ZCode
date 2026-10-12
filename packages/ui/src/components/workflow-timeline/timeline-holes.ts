import {
  WORKFLOW_HOLE_SITE_ID_PATTERN,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { TimelineRail, TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";

/**
 * Hole derivation on the timeline model (docs/dynamic-workflow/presentation.md "Holes on the
 * timeline"). Split out of timeline-model.ts (max-lines gate): that file only asks "is this station a
 * hole" when building stations and "where is the head, does the tail need an extra 40px" at finish
 * time; the rules all live here. No React, no DOM, no time.
 *
 * A hole is just a phase (id = site id, name = literal; rule 9012 guarantees name uniqueness):
 *   - **Open**: display's `holes[]` lists it (tail or not); when the run stops on it, `run.holes` says
 *     it is waiting.
 *   - **Filled**: display's `holes[]` no longer lists it; the phases and stations it wrote carry
 *     `fill: <its id>`. A fill with phases: the body's stations stand at the hole's position and the
 *     hole keeps only a **head** (pen · name) floating above them; a fill without phases: the hole's
 *     own phase holds the body's asks, the station keeps its name, and a pen mark joins the name.
 * The filled name has no landing spot on the display (it is no longer a station), so it comes from
 * `run.holes`; static graphs without a run (the confirmation window, the fill row) get `holeLabels`
 * from the caller; when neither exists, fall back to the site id — better than blank.
 * The hole's type (the T in `hole<T>`) exists on the wire, not in the UI: it is a compiler contract,
 * not user-facing.
 *
 * **Nesting**: fills can contain further holes. The hole id is a name key (`hole#<8 hex digits>`) and
 * does not grow with depth, so nesting is not in the id: a hole's **own** phase / stations carry
 * `fill: <the hole enclosing it>` (top-level holes carry none), from which the parent table
 * {@link HoleTable.parents} is derived. The outer head covers all stations whose "`fill` is it or any
 * hole inside it", and the inner region lands inside the outer one; heads sort by `from` ascending,
 * outer fill first on a shared start (the region paints outer first, inner stacked above).
 * Fix rationale: before 2026-09-29 ids concatenated per level (`hole#1/hole#1`) and hit the
 * protocol's 64-character bound after eight or nine relay steps.
 *
 * A station's `fill` answers "which fill region does this station belong to": usually the phase's
 * `fill`; **a filled hole's own station** belongs to its own region (hovering it lights itself, and
 * when it just filled, it lands together), so it takes its own id — see {@link stationFillOf}.
 */
export type TimelineHoleState = "open" | "waiting" | "filled";

export interface TimelineHole {
  siteId: string;
  state: TimelineHoleState;
  /** The prompt the main agent received (while waiting, from `run.holes`); the pane's waiting body draws it. */
  prompt?: string;
  /** The script's tail: the track runs 40px further after it. */
  tail?: true;
  /** Arrival moment (waiting); fill moment (after filling). */
  since?: number;
  filledAt?: number;
  filledBy?: string;
}

/** The head left by one fill with phases: covering stations `from..to` (indexes into `stations`). */
export interface TimelineFill {
  holeId: string;
  name: string;
  from: number;
  to: number;
  filledAt?: number;
}

export type HoleLabels = ReadonlyMap<string, { name: string }>;

export function isHoleSiteId(id: string): boolean {
  return WORKFLOW_HOLE_SITE_ID_PATTERN.test(id);
}

/** Hole id → the hole id enclosing it (top-level holes are not in the table). */
export type HoleParents = Readonly<Record<string, string>>;

/** Every hole level starting at `id` and walking outward along the parent table (itself first); cycle-safe: the same id is not walked twice. */
function holeAncestors(id: string, parents: HoleParents): string[] {
  const out: string[] = [];
  for (
    let cur: string | undefined = id;
    cur !== undefined && !out.includes(cur);
    cur = parents[cur]
  ) {
    if (isHoleSiteId(cur)) out.push(cur);
  }
  return out;
}

/** Whether `id` is the fill `holeId` itself, or a hole inside it (any depth). */
export function fillContains(holeId: string, id: string, parents: HoleParents): boolean {
  return holeAncestors(id, parents).includes(holeId);
}

/**
 * Parent table: the `fill` on each hole's own phase and stations is the hole enclosing it (the
 * analyzer's convention, docs/analysis.md "Sites"). Phases take priority (a filled hole keeps only
 * its phase), stations as fallback (an open hole is a kind-hole station on the display).
 */
export function holeParentsOf(
  graph: Pick<WorkflowCausalityGraphData, "steps">,
  phases: readonly { id: string; fill?: string }[],
): HoleParents {
  const parents: Record<string, string> = {};
  for (const step of graph.steps) {
    if (step.kind === "hole" && step.fill !== undefined && step.fill !== step.id)
      parents[step.id] = step.fill;
  }
  for (const phase of phases) {
    if (isHoleSiteId(phase.id) && phase.fill !== undefined && phase.fill !== phase.id)
      parents[phase.id] = phase.fill;
  }
  return parents;
}

/**
 * Remove hole phases whose head already represents them from the timeline: filled, no members of
 * their own, and with other stations inside their body. The analyzer keeps such phases in the table
 * (the sidebar and `phaseNames` rely on it to speak each relay step's name, docs/analysis.md
 * "Sites"), but on the timeline it would be just an empty lamp before the body — the head already
 * says its name. When removing, edges into it are rewired to edges out of it (`a → h → b` becomes
 * `a → b`), so the track never breaks; fills without body stations are not removed (their station
 * carries the pen mark, the only trace).
 */
export function withoutHeadedHolePhases(
  graph: WorkflowCausalityGraphData,
): WorkflowCausalityGraphData {
  const phases = graph.phases ?? [];
  const open = new Set((graph.holes ?? []).map((hole) => hole.siteId));
  const withMembers = new Set(
    graph.steps.flatMap((step) => (step.phase === undefined ? [] : [step.phase])),
  );
  const parents = holeParentsOf(graph, phases);
  const hidden = new Set(
    phases
      .filter(
        (phase) => isHoleSiteId(phase.id) && !open.has(phase.id) && !withMembers.has(phase.id),
      )
      .filter((hole) =>
        phases.some(
          (phase) =>
            phase.id !== hole.id &&
            phase.fill !== undefined &&
            fillContains(hole.id, phase.fill, parents),
        ),
      )
      .map((phase) => phase.id),
  );
  if (hidden.size === 0) return graph;
  // Collapse one by one: each removal splices the paths through it, so consecutive removed phases also end up connected.
  let edges = [...(graph.phaseEdges ?? [])];
  for (const id of hidden) {
    const into = edges.filter((edge) => edge.to === id && edge.from !== id);
    const out = edges.filter((edge) => edge.from === id && edge.to !== id);
    edges = edges.filter((edge) => edge.from !== id && edge.to !== id);
    for (const a of into)
      for (const b of out)
        edges.push({ from: a.from, to: b.to, ...(b.back === true ? { back: true } : {}) });
  }
  const seen = new Set<string>();
  const phaseEdges = edges.filter((edge) => {
    const key = `${edge.from}>${edge.to}>${edge.back === true ? 1 : 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...graph,
    phaseEdges,
    phases: phases
      .filter((phase) => !hidden.has(phase.id))
      .map((phase) =>
        phase.alongside === undefined
          ? phase
          : { ...phase, alongside: phase.alongside.filter((id) => !hidden.has(id)) },
      ),
  };
}

/**
 * Which graph the timeline builds stations from: hole phases already represented by a head are
 * removed ({@link withoutHeadedHolePhases}), but the parent table is computed from the graph
 * **before** removal — a removed hole is still the parent of the holes inside its body, or nesting
 * would break.
 */
export function timelineHoleGraph(full: WorkflowCausalityGraphData): {
  graph: WorkflowCausalityGraphData;
  phases: NonNullable<WorkflowCausalityGraphData["phases"]>;
  parents: HoleParents;
} {
  const graph = withoutHeadedHolePhases(full);
  return { graph, parents: holeParentsOf(full, full.phases ?? []), phases: graph.phases ?? [] };
}

/** Which fill region a station belongs to (flattened onto the station): a filled hole's own station belongs to itself; other stations belong to the phase's `fill`. */
export function stationFillOf(
  phase: { id: string; fill?: string },
  hole: TimelineHole | undefined,
): { fill?: string } {
  const fill = hole?.state === "filled" ? phase.id : phase.fill;
  return fill === undefined ? {} : { fill };
}

export interface HoleTable {
  /** Phase id → that station is a hole (only those whose own phase is still in the table). */
  byPhase: ReadonlyMap<string, TimelineHole>;
  /** Heads of fills with phases, sorted by `from` ascending. */
  fills: TimelineFill[];
  /** Containment between holes (see {@link holeParentsOf}). */
  parents: HoleParents;
}

/**
 * Read the hole table from display and run. `phases` is the same phase table the model used to build
 * stations (implicit phases already synthesized); indexes align with stations.
 */
export function holeTable(
  graph: WorkflowCausalityGraphData,
  phases: readonly NonNullable<WorkflowCausalityGraphData["phases"]>[number][],
  run: WorkflowRunState | undefined,
  labels: HoleLabels | undefined,
  /** Parent table computed from the graph **before** collapsing (a removed hole phase is still the parent of holes inside its body); computed in place when absent. */
  parents: HoleParents = holeParentsOf(graph, phases),
): HoleTable {
  const runHoles = new Map((run?.holes ?? []).map((hole) => [hole.siteId, hole]));
  const index = new Map(phases.map((phase, i) => [phase.id, i]));
  const byPhase = new Map<string, TimelineHole>();
  const open = new Set<string>();
  for (const hole of graph.holes ?? []) {
    open.add(hole.siteId);
    const live = runHoles.get(hole.siteId);
    const waiting = live?.state === "waiting";
    byPhase.set(hole.siteId, {
      siteId: hole.siteId,
      state: waiting ? "waiting" : "open",
      ...(hole.tail === true ? { tail: true as const } : {}),
      ...(waiting && live.since !== undefined ? { since: live.since } : {}),
      ...(waiting && live.prompt !== undefined ? { prompt: live.prompt } : {}),
    });
  }
  // Filled holes: those the run recorded as filled, those named by some phase / station's `fill`, and those whose phase id is itself a hole id.
  const filled = new Set<string>();
  for (const hole of runHoles.values()) if (hole.state === "filled") filled.add(hole.siteId);
  // Named holes along with every level of their outer holes: after an inner fill, the outer may no longer be named directly by any phase.
  for (const phase of phases) {
    if (phase.fill !== undefined)
      for (const id of holeAncestors(phase.fill, parents)) filled.add(id);
    if (isHoleSiteId(phase.id)) filled.add(phase.id);
  }
  for (const step of graph.steps) {
    if (step.fill !== undefined) for (const id of holeAncestors(step.fill, parents)) filled.add(id);
  }
  for (const id of open) filled.delete(id);

  const fills: TimelineFill[] = [];
  const last = phases.length - 1;
  for (const holeId of filled) {
    const live = runHoles.get(holeId);
    const label = labels?.get(holeId);
    const own = index.get(holeId);
    // Body: stations whose `fill` is it, or any hole inside it — the outer's span covers the inner's.
    // Its own station is not in the body (its `fill` is the outer); when it sits right before the
    // body, it is folded under the head below.
    const body = phases.flatMap((phase, i) =>
      phase.fill !== undefined && fillContains(holeId, phase.fill, parents) ? [i] : [],
    );
    if (own !== undefined) {
      byPhase.set(holeId, {
        siteId: holeId,
        state: "filled",
        // A hole whose station ends the table is the script's tail: 40px remain after filling, so the head has somewhere to land.
        ...(own === last && body.length === 0 ? { tail: true as const } : {}),
        ...(live?.filledAt === undefined ? {} : { filledAt: live.filledAt }),
        ...(live?.filledBy === undefined ? {} : { filledBy: live.filledBy }),
      });
    }
    if (body.length === 0) continue;
    // The hole's own phase, when it sits right before the body, is also folded under the head (statements of the body before the first marker landed on that station).
    const from = own !== undefined && own === Math.min(...body) - 1 ? own : Math.min(...body);
    fills.push({
      holeId,
      name: live?.name ?? label?.name ?? holeId,
      from,
      to: Math.max(...body),
      ...(live?.filledAt === undefined ? {} : { filledAt: live.filledAt }),
    });
  }
  // Outer fill first on a shared start: longer span first; on equal spans by nesting depth (outer
  // shallower). Fix rationale: once ids stopped concatenating per level, collection along the parent
  // table runs inside-out, so insertion order would put inner heads before outer ones.
  const depth = (id: string): number => holeAncestors(id, parents).length;
  fills.sort(
    (left, right) =>
      left.from - right.from || right.to - left.to || depth(left.holeId) - depth(right.holeId),
  );
  return { byPhase, fills, parents };
}

/** Tail hole: open / waiting → a dashed stub fading over 40px; after a phase-less fill → only 40px of clearance (the head needs somewhere to land). */
export function tailStubOf(stations: readonly TimelineStation[]): "open" | "filled" | undefined {
  const hole = stations[stations.length - 1]?.hole;
  if (hole === undefined || hole.tail !== true) return undefined;
  return hole.state === "filled" ? "filled" : "open";
}

/** Track segments touching an open / waiting hole are dashed: that is not code yet. */
export function railTouchesHole(
  stations: readonly TimelineStation[],
  rail: Pick<TimelineRail, "from" | "to">,
): boolean {
  const at = (i: number): boolean => {
    const state = stations[i]?.hole?.state;
    return state === "open" || state === "waiting";
  };
  return at(rail.from) || at(rail.to);
}

/**
 * The fill row's draft phase line (docs/dynamic-workflow/presentation.md "The fill row"): the segment
 * of the parent track where the fill sits — the fill's stations at full ink, one adjacent station on
 * each side as ghost (40%) — other stations are not drawn. No arcs, bands, or run state ever: this is
 * a static picture saying "between which two stations the new ones landed". undefined when the hole
 * is not recognized.
 */
export function narrowTimelineToFill(
  model: WorkflowTimelineModel,
  holeId: string,
): WorkflowTimelineModel | undefined {
  const fill = model.fills?.find((candidate) => candidate.holeId === holeId);
  let from: number;
  let to: number;
  if (fill !== undefined) {
    from = fill.from;
    to = fill.to;
  } else {
    const own = model.stations.findIndex(
      (station) => station.hole?.siteId === holeId && station.hole.state === "filled",
    );
    if (own < 0) return undefined;
    from = own;
    to = own;
  }
  const start = Math.max(0, from - 1);
  const end = Math.min(model.stations.length - 1, to + 1);
  const stations = model.stations.slice(start, end + 1).map((station, i) => {
    const at = start + i;
    const ghost = at < from || at > to;
    const { typing: _typing, ...rest } = station;
    void _typing;
    return ghost ? { ...rest, ghost: true as const } : rest;
  });
  const rails = model.rails.flatMap((rail) =>
    rail.kind === undefined && rail.from >= start && rail.to <= end && rail.to === rail.from + 1
      ? [{ ...rail, from: rail.from - start, to: rail.to - start }]
      : [],
  );
  const includesLast = end === model.stations.length - 1;
  return {
    arcs: [],
    bands: [],
    fills: fill === undefined ? [] : [{ ...fill, from: from - start, to: to - start }],
    live: false,
    rails,
    runningIndex: undefined,
    stations,
    ...(includesLast && model.tailStub !== undefined ? { tailStub: model.tailStub } : {}),
  };
}
