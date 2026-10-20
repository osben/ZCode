/**
 * Bands and tracks.
 *
 * The analyzer's `alongside` reports a **node fact**: when entering this phase, strands in other phases that have not joined are still running.
 * Fold that into visual **bands**—a contiguous range of phases in declaration order, split internally into **tracks**. Track 0 is the main line
 * (the bottom row), with branch tracks above it. The band forks before and merges after; arcs treat the whole band as **one node**.
 *
 * Indices only: no IDs, drawing instructions, or pixels. The timeline model and the sidebar's mini run line share this folding logic; the latter
 * has only the `phaseNames` index space and no display graph.
 */

/**
 * A phase stream (docs/dynamic-workflow/presentation.md, “Streams”): while both stations are
 * running, `from` passes work to `to`. Uses indexes in the same space as `alongside`.
 */
export interface StreamSpec {
  from: number;
  to: number;
}

/** One band: all stations in the closed interval `[from, to]`; `tracks[0]` is the main line. */
export interface PhaseBand {
  from: number;
  to: number;
  tracks: number[][];
}

/**
 * Fold alongside relationships into bands. `alongside[i]` contains indices of stations parallel to station i (out-of-range, self-referential, and unlisted indices are ignored).
 *
 * 1. Symmetrize: `alongside` can be reported only by the later station (when entering B, A is still running and A's payload does not include B),
 *    but the two stations are peers in the visualization.
 * 2. For connected components of `~` with at least two members, create interval `[min, max]`; merge intersecting intervals. Gaps within an interval
 *    count as members for robustness (they cannot occur without cycles).
 * 3. Tracks use greedy interval-graph coloring in **declaration order**: place each member on the lowest track with no parallel member,
 *    otherwise create a new track. The first member therefore always lands on track 0.
 * 4. With streams (`streams`), color only treats two stations as parallel when neither can reach
 *    the other: a phase and every downstream phase belong to the same line of work and should use
 *    one track even when they run simultaneously. **Dissolve** a band when all its members fit on
 *    one track—it is not a band, so return its stations to the main line and connect them with
 *    stream rails (spec, “Bands and tracks”). The sidebar's mini run line does not pass streams.
 */
export function foldPhaseBands(
  count: number,
  alongside: readonly (readonly number[])[],
  streams: readonly StreamSpec[] = [],
): PhaseBand[] {
  const near = Array.from({ length: Math.max(0, count) }, () => new Set<number>());
  for (let i = 0; i < near.length; i += 1) {
    for (const j of alongside[i] ?? []) {
      if (!Number.isInteger(j) || j < 0 || j >= near.length || j === i) continue;
      near[i]!.add(j);
      near[j]!.add(i);
    }
  }

  const seen = Array.from({ length: near.length }, () => false);
  const spans: { from: number; to: number }[] = [];
  for (let root = 0; root < near.length; root += 1) {
    if (seen[root] === true || near[root]!.size === 0) continue;
    let from = root;
    let to = root;
    const stack = [root];
    seen[root] = true;
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (i < from) from = i;
      if (i > to) to = i;
      for (const j of near[i]!) {
        if (seen[j] === true) continue;
        seen[j] = true;
        stack.push(j);
      }
    }
    spans.push({ from, to });
  }

  spans.sort((left, right) => left.from - right.from);
  const merged: { from: number; to: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }

  const reach = streamReach(near.length, streams);
  const apart = (i: number, j: number): boolean =>
    near[i]!.has(j) && !reach[i]!.has(j) && !reach[j]!.has(i);
  return merged.flatMap((span) => {
    const tracks: number[][] = [];
    for (let i = span.from; i <= span.to; i += 1) {
      const free = tracks.find((members) => !members.some((member) => apart(i, member)));
      if (free === undefined) tracks.push([i]);
      else free.push(i);
    }
    return tracks.length > 1 ? [{ from: span.from, to: span.to, tracks }] : [];
  });
}

/** Reachability along streams: `reach[i]` is the set of stations reachable by following streams from station i (ignore out-of-range and self-referential streams). */
function streamReach(count: number, streams: readonly StreamSpec[]): Set<number>[] {
  const next = Array.from({ length: count }, () => [] as number[]);
  for (const stream of streams) {
    if (!inRange(stream.from, count) || !inRange(stream.to, count)) continue;
    if (stream.from !== stream.to) next[stream.from]!.push(stream.to);
  }
  return next.map((_, start) => {
    const reached = new Set<number>();
    const stack = [...next[start]!];
    while (stack.length > 0) {
      const i = stack.pop()!;
      if (reached.has(i)) continue;
      reached.add(i);
      stack.push(...next[i]!);
    }
    return reached;
  });
}

const inRange = (i: number, count: number): boolean => Number.isInteger(i) && i >= 0 && i < count;

/** Band containing station i; undefined outside any band. */
export function bandOf<T extends PhaseBand>(bands: readonly T[], i: number): T | undefined {
  return bands.find((band) => band.from <= i && i <= band.to);
}

/** Track containing station i; always 0 (main line) outside a band. */
export function trackOf(bands: readonly PhaseBand[], i: number): number {
  const track = bandOf(bands, i)?.tracks.findIndex((members) => members.includes(i));
  return track === undefined || track < 0 ? 0 : track;
}

/** Rail segment kind; absent means a regular segment on one track, while `stream` means a phase stream between adjacent stations on the same track. */
export type TimelineRailKind = "fork" | "merge" | "twin" | "stream";

export interface RailSpec {
  from: number;
  to: number;
  kind?: TimelineRailKind;
}

export interface ArcSpec {
  from: number;
  to: number;
  /** Which track's airspace to draw in: arcs on the same track inside a band use that track's airspace; all others use the topmost track's. */
  air: number;
  /** Non-adjacent phase stream: draw as an arc to indicate “feeds,” not a loop or control-flow jump. */
  stream?: true;
}

/** A band plus its two visual endpoints: the predecessor station where it forks and the successor station where it merges. */
export interface BoundBand extends PhaseBand {
  pred?: number;
  join?: number;
}

export interface PhaseEdgeFold {
  bands: BoundBand[];
  rails: RailSpec[];
  arcs: ArcSpec[];
}

/** Band predecessor/successor: the adjacent station **outside the band** that has an edge to/from any band member. Do not connect adjacent bands; that is a flat segment. */
function bindBands(
  count: number,
  bands: readonly PhaseBand[],
  edges: readonly { from: number; to: number }[],
): BoundBand[] {
  const outside = (i: number): boolean => i >= 0 && i < count && bandOf(bands, i) === undefined;
  return bands.map((band) => {
    const before = band.from - 1;
    const after = band.to + 1;
    const pred =
      outside(before) &&
      edges.some((edge) => edge.from === before && bandOf(bands, edge.to) === band);
    const join =
      outside(after) &&
      edges.some((edge) => edge.to === after && bandOf(bands, edge.from) === band);
    return {
      ...band,
      ...(join ? { join: after } : {}),
      ...(pred ? { pred: before } : {}),
    };
  });
}

/**
 * Rail segments produced within a band: adjacent members on the same track (**unconditionally**, as
 * one track is one strand; use a stream rail if a stream connects them), branches, merges, and double segments.
 */
function bandRails(bands: readonly BoundBand[], streamed: ReadonlySet<string>): RailSpec[] {
  const rails: RailSpec[] = [];
  for (const band of bands) {
    band.tracks.forEach((members, track) => {
      for (let k = 1; k < members.length; k += 1) {
        const from = members[k - 1]!;
        const to = members[k]!;
        rails.push({
          from,
          ...(streamed.has(`${from}>${to}`) ? { kind: "stream" as const } : {}),
          to,
        });
      }
      if (band.pred !== undefined) {
        rails.push({
          from: band.pred,
          ...(track === 0 ? {} : { kind: "fork" as const }),
          to: members[0]!,
        });
      }
      if (band.join !== undefined) {
        rails.push({
          from: members[members.length - 1]!,
          ...(track === 0 ? {} : { kind: "merge" as const }),
          to: band.join,
        });
      }
    });
    // Double segment: two stations adjacent in band declaration order but on different tracks. Read only by the workbench and sidebar; never traversed.
    for (let i = band.from; i < band.to; i += 1) {
      if (trackOf(bands, i) !== trackOf(bands, i + 1))
        rails.push({ from: i, kind: "twin", to: i + 1 });
    }
  }
  return rails;
}

/**
 * Convert edges into track segments and arcs. A band absorbs some edges: forks and merges already show
 * "control passed through here." The remaining edges become arcs, whose endpoints are **reattached** to the band endpoints—the band is one node.
 */
export function foldPhaseEdges(
  count: number,
  folded: readonly PhaseBand[],
  edges: readonly { from: number; to: number }[],
  streams: readonly StreamSpec[] = [],
): PhaseEdgeFold {
  const bands = bindBands(count, folded, edges);
  const top = Math.max(1, ...bands.map((band) => band.tracks.length)) - 1;
  const streamed = new Set(
    streams
      .filter((stream) => inRange(stream.from, count) && inRange(stream.to, count))
      .map((stream) => `${stream.from}>${stream.to}`),
  );
  const rails = bandRails(bands, streamed);
  const arcs: ArcSpec[] = [];
  // Streams (spec, “Rails,” type 6 and following section): adjacent stations on the same track use
  // stream rails (already drawn within bands by bandRails); non-adjacent stations use stream arcs.
  // Do not draw streams across tracks within a band; the branch and merge already show that both are running.
  for (const key of streamed) {
    const [from, to] = key.split(">").map(Number) as [number, number];
    if (from === to) continue;
    const source = bandOf(bands, from);
    const target = bandOf(bands, to);
    if (source === undefined && target === undefined) {
      if (to === from + 1) rails.push({ from, kind: "stream", to });
      else arcs.push({ air: top, from, stream: true, to });
      continue;
    }
    if (source === undefined || source !== target) continue;
    const track = trackOf(bands, from);
    if (track !== trackOf(bands, to)) continue;
    const members = source.tracks[track]!;
    if (members[members.indexOf(from) + 1] !== to)
      arcs.push({ air: track, from, stream: true, to });
  }
  for (const edge of edges) {
    const source = bandOf(bands, edge.from);
    const target = bandOf(bands, edge.to);
    if (source === undefined && target === undefined) {
      if (edge.to === edge.from + 1) rails.push({ from: edge.from, to: edge.to });
      else arcs.push({ air: top, from: edge.from, to: edge.to });
      continue;
    }
    if (source !== undefined && source === target) {
      const track = trackOf(bands, edge.from);
      if (track !== trackOf(bands, edge.to)) {
        // Cross-track edge: a forward edge is already represented by the fork; a backward edge is a self-loop around the whole band.
        if (edge.to < edge.from) arcs.push({ air: top, from: source.to, to: source.from });
        continue;
      }
      const members = source.tracks[track]!;
      // Same track and adjacent: the strand is already shown, so do not draw it again.
      if (members[members.indexOf(edge.from) + 1] !== edge.to) {
        arcs.push({ air: track, from: edge.from, to: edge.to });
      }
      continue;
    }
    // Outgoing/incoming band edges: the adjacent edge is already absorbed by the merge/fork; reattach the rest to the band endpoints.
    if (source !== undefined && target === undefined && edge.to === source.to + 1) continue;
    if (source === undefined && target !== undefined && edge.from === target.from - 1) continue;
    const from = source === undefined ? edge.from : source.to;
    const to = target === undefined ? edge.to : target.from;
    if (source !== undefined && target !== undefined && source.to + 1 === target.from) {
      rails.push({ from, to });
      continue;
    }
    arcs.push({ air: top, from, to });
  }
  // A stream rail replaces the regular segment between the same pair of stations: draw only one rail between them, and the stream conveys more than a regular segment.
  const streamRails = new Set(
    rails.filter((rail) => rail.kind === "stream").map((rail) => `${rail.from}>${rail.to}`),
  );
  return {
    arcs: dedupe(arcs, (arc) => `${arc.air}:${arc.from}>${arc.to}:${arc.stream ? "s" : ""}`),
    bands,
    rails: order(
      rails.filter(
        (rail) => rail.kind !== undefined || !streamRails.has(`${rail.from}>${rail.to}`),
      ),
    ),
  };
}

function dedupe<T extends { from: number; to: number }>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.from === item.to || seen.has(key(item))) return false;
    seen.add(key(item));
    return true;
  });
}

/** Sort track segments by left endpoint, then right; without bands, this matches the previous station-by-station order exactly. */
function order(rails: RailSpec[]): RailSpec[] {
  return dedupe(rails, (rail) => `${rail.from}>${rail.to}:${rail.kind ?? ""}`).sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
}

/** Number of arc lanes (highest lane + 1); the renderer uses it to reserve height for arcs. */
export function arcLaneCount(arcs: readonly { lane: number }[]): number {
  return arcs.reduce((max, arc) => Math.max(max, arc.lane + 1), 0);
}

/**
 * Assign arcs to lanes with greedy interval-graph coloring. Process arcs from shortest to longest (preserving payload order for equal spans),
 * placing each on the **lowest available lane**—a lane is "available" when its existing arcs do not **intersect** it by station index
 * (closed intervals: sharing an endpoint counts as intersection because both arcs' vertical segments meet at that station). Thus unrelated arcs
 * share a height; nested arcs place the inner one lower and the outer one higher (the short arc fits first); only crossing arcs are pushed upward.
 *
 * The previous rule, "arc k goes on lane k," placed two unrelated loops at different heights merely because they were listed separately,
 * making readers search for a reason that did not exist.
 */
export function assignArcLanes(
  pairs: readonly { from: number; to: number }[],
): { from: number; to: number; lane: number }[] {
  const placed: { lo: number; hi: number; lane: number }[] = [];
  return pairs.map((pair) => {
    const lo = Math.min(pair.from, pair.to);
    const hi = Math.max(pair.from, pair.to);
    const taken = new Set(
      placed
        .filter((other) => Math.max(lo, other.lo) <= Math.min(hi, other.hi))
        .map((other) => other.lane),
    );
    let lane = 0;
    while (taken.has(lane)) lane += 1;
    placed.push({ hi, lane, lo });
    return { from: pair.from, lane, to: pair.to };
  });
}

/**
 * Color each `air` space independently: one track's airspace contains only arcs on that track, and cross-track arcs use the topmost airspace.
 * Arcs in the two spaces do not conflict even if their x-ranges intersect. Return one lane index per input arc.
 */
export function assignAirLanes(arcs: readonly ArcSpec[]): number[] {
  const lanes = Array.from({ length: arcs.length }, () => 0);
  for (const air of new Set(arcs.map((arc) => arc.air))) {
    const group = arcs.flatMap((arc, at) => (arc.air === air ? [{ ...arc, at }] : []));
    assignArcLanes(group).forEach((placed, k) => {
      lanes[group[k]!.at] = placed.lane;
    });
  }
  return lanes;
}
