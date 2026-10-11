import { arcLaneCount } from "./timeline-bands.js";
import type { TimelineArc, TimelineBand, TimelineStation } from "./timeline-model.js";

/** Horizontal timeline geometry constants, matching the design canvas exactly: station width 168, gap 24, and light at station-left + 17 (pill/avatar column). Kept separate because edge geometry reads them and must not depend on rendering components. */
export const STATION_WIDTH = 168;
export const STATION_GAP = 24;
export const STATION_PITCH = STATION_WIDTH + STATION_GAP;
/** Distance from station left to light center: outer margin 12 + radius 5. */
export const MARK_X = 17;

/** Track-row height. */
export const RAIL_ROW = 24;
/** Height difference between adjacent arc lanes. */
export const ARC_LANE = 14;
/** Minimum height of the lowest arc lane above the track centerline. It must fit an 8px corner plus a descending vertical segment (5.25px arrow, with a few pixels of straight line so the arrow looks like it falls from above). Previously it was 16: after the 8px corner, the vertical segment was −1px, so the final segment went up one pixel, `marker-end` pointed upward, and the arrow disappeared. */
export const ARC_BASE = 26;
/** Gap between adjacent arc endpoints (takeoff or landing) at the same light. */
export const TERMINAL_PITCH = 10;
export const PILL_HEIGHT = 32;
export const PILL_GAP = 6;

/** Platform row: present only in timelines with bands; one 24px row. Station headers (name + metadata) move from track rows into this row. The main track is directly above it; only branch-track stations need a connector line. */
export const PLATFORM_ROW = 24;
/** Left edge of the name in the platform row; aligned with the light’s outer margin so light, name, and avatar pills form one vertical spine. */
export const CAPTION_X = 12;
/** Fork point offset from the first station’s left edge; each branch track moves 8px farther left per level. */
export const FORK_BACK = 16;
/** Merge point offset from the merge station’s left edge (negative means to its left). */
export const MERGE_BACK = 10;
/** Length of the tail when there is no predecessor, also used for the stub when there is no merge station. */
export const TAIL = 4;
export const STUB = 6;

/**
 * Fill header row (docs/dynamic-workflow/presentation.md, “Holes on the timeline”): exists only on
 * timelines with fills, is 24px high, and sits above the arc lanes. The 12px pen aligns with the x
 * of the first new lamp; the name and `· T` follow, with no background or border.
 */
export const HEAD_ROW = 24;
/** Extra width after the final station for a tail hole: a fading dashed segment while open, and landing space for the fill header after completion. */
export const TAIL_STUB = 40;

export function timelineWidth(count: number, inset = 0, tail = false): number {
  return count === 0
    ? 0
    : (count - 1) * STATION_PITCH + STATION_WIDTH + inset + (tail ? TAIL_STUB : 0);
}

/** Left edge of station i. */
export function stationX(index: number, inset = 0): number {
  return index * STATION_PITCH + inset;
}

/** Center of station i’s light. */
export function lampX(index: number, inset = 0): number {
  return stationX(index, inset) + MARK_X;
}

/** x-coordinate where a band forks from the main track; if the band starts at station 0, there is no room on the left, so use 4 (the whole timeline shifts right by `inset`). */
export function bandForkX(band: Pick<TimelineBand, "from">, inset = 0): number {
  return band.from === 0 ? TAIL : stationX(band.from, inset) - FORK_BACK;
}

/** x-coordinate where a band merges into the main track; without a merge station, use 6px after the final station slot, where the strands still meet. */
export function bandMergeX(band: Pick<TimelineBand, "join" | "to">, inset = 0): number {
  return band.join === undefined
    ? stationX(band.to, inset) + STATION_WIDTH + STUB
    : stationX(band.join, inset) - MERGE_BACK;
}

/** Band containing station i; undefined outside a band. Unlike the same-named timeline-bands.ts function, this checks the model band rather than an index-only band. */
export function bandAt(bands: readonly TimelineBand[], index: number): TimelineBand | undefined {
  return bands.find((band) => band.from <= index && index <= band.to);
}

/** Where an arc’s endpoints attach. For an arc on one track inside a band, both endpoints are lights (`inTrack`). Otherwise, treat the band as one node: if the source is inside the band, take off from the band’s merge point (`fromBand`); if the target is inside, land at the band’s fork point (`toBand`). A band self-loop has both endpoints in the same band, but its `air` is the topmost lane and it always lands on track 0, so it is not classified as `inTrack`. */
export interface ArcEnds {
  inTrack: boolean;
  fromBand: boolean;
  toBand: boolean;
}

export function arcEnds(
  arc: Pick<TimelineArc, "air" | "from" | "to">,
  bands: readonly TimelineBand[],
  stations: readonly Pick<TimelineStation, "track">[],
): ArcEnds {
  const source = bandAt(bands, arc.from);
  const target = bandAt(bands, arc.to);
  const trackOf = (index: number): number => stations[index]?.track ?? 0;
  const inTrack =
    source !== undefined &&
    source === target &&
    trackOf(arc.from) === arc.air &&
    trackOf(arc.to) === arc.air;
  return {
    fromBand: !inTrack && source !== undefined,
    inTrack,
    toBand: !inTrack && target !== undefined,
  };
}

/** Arc-endpoint slots. Both light endpoints of an arc—the source station’s takeoff and target station’s landing—occupy slots at that station. Each endpoint uses a slot spaced by `TERMINAL_PITCH`, centered on the light; a station with one endpoint stays at the light center, so timelines without conflicts do not move by even a pixel. Previously only landings were offset and every takeoff stayed at the light center. When a station had both incoming and outgoing arcs, the outgoing vertical crossed the incoming arrow; both verticals merged and the arrow sat mid-line (stations in branches A/B of testfield’s “workflow stress test”). Lanes separate arcs by y but cannot separate their x positions. Slot order from left to right: endpoints whose far end is left of the station, then endpoints whose far end is right; within each side, the lowest lane is farthest out. Each arc is an L opening toward its far endpoint: left-facing Ls go left and right-facing Ls go right, so the two sides never meet. On one side, an L with a lower bend placed inside forces the higher-bend vertical through its horizontal segment—this is the lane closed-interval argument rotated by 90 degrees. Band forks/merges do not use slots: a fork has only landings and a merge only takeoffs, so verticals at the same point share a strand-like line without crossing arrows. Return two offset columns, one for each endpoint of each arc, relative to the light center; the side that is not attached to a light always has offset 0. */
export function arcTerminalOffsets(
  arcs: readonly Pick<TimelineArc, "air" | "from" | "lane" | "to">[],
  bands: readonly TimelineBand[],
  stations: readonly Pick<TimelineStation, "track">[],
): { takeoff: number[]; landing: number[] } {
  const takeoff = arcs.map(() => 0);
  const landing = arcs.map(() => 0);
  interface Terminal {
    arc: number;
    end: "takeoff" | "landing";
    /** Far endpoint is left: −1; right: 1. */
    side: -1 | 1;
    lane: number;
  }
  const byStation = new Map<number, Terminal[]>();
  const add = (station: number, terminal: Terminal): void => {
    const list = byStation.get(station) ?? [];
    list.push(terminal);
    byStation.set(station, list);
  };
  arcs.forEach((arc, j) => {
    const ends = arcEnds(arc, bands, stations);
    if (!ends.fromBand) {
      add(arc.from, { arc: j, end: "takeoff", lane: arc.lane, side: arc.to > arc.from ? 1 : -1 });
    }
    if (!ends.toBand) {
      add(arc.to, { arc: j, end: "landing", lane: arc.lane, side: arc.from > arc.to ? 1 : -1 });
    }
  });
  for (const list of byStation.values()) {
    // In the same station and air lane, every pair of arcs intersects (closed intervals), so they cannot share a lane; stable sorting provides deterministic order.
    list.sort(
      (left, right) =>
        left.side - right.side || (left.side < 0 ? left.lane - right.lane : right.lane - left.lane),
    );
    list.forEach((terminal, k) => {
      const offset = (k - (list.length - 1) / 2) * TERMINAL_PITCH;
      if (terminal.end === "takeoff") takeoff[terminal.arc] = offset;
      else landing[terminal.arc] = offset;
    });
  }
  return { landing, takeoff };
}

/** Timeline row layout: centerlines for tracks, platform row, top of the pill column, and overall right inset. */
export interface TimelineLayout {
  /** y-coordinate of each track centerline, indexed by track number; `rowY[0]` is the main (bottom) track. */
  rowY: number[];
  /** Centerline of the platform row; without bands, falls back to the main track row where station headers remain. */
  capY: number;
  /** Top of the pill column. */
  pillsTop: number;
  /** Right offset for the full track: 12 when a band starts at station 0 (to leave room for its fork), otherwise 0. */
  inset: number;
  /** Whether the view contains any bands. */
  banded: boolean;
}

/** Row layout from top to bottom `t = R−1 … 0`: each track gets its own air (arc lanes) followed by a 24px track row, so the main track is at the bottom just above the platform row. Air is based on arc lanes in that level: reserve 6px of breathing room for the top level when there are no arcs and 0 for the others. Without bands, R = 1 and the formula returns exactly to the previous “arc lane + track row” layout. */
export function timelineLayout(
  arcs: readonly TimelineArc[],
  bands: readonly TimelineBand[],
  /** Timeline with fills: reserve a `HEAD_ROW` at the top, then shift the rest of the geometry down unchanged. */
  heads = false,
): TimelineLayout {
  const banded = bands.length > 0;
  const tracks = banded ? Math.max(2, ...bands.map((band) => band.tracks.length)) : 1;
  const rowY: number[] = [];
  let y = heads ? HEAD_ROW : 0;
  for (let t = tracks - 1; t >= 0; t -= 1) {
    const lanes = arcLaneCount(arcs.filter((arc) => arc.air === t));
    // The top line of the highest lane is y = 8: rowY = air + RAIL_ROW/2 = 8 + ARC_BASE + ARC_LANE × (lanes − 1).
    const air =
      lanes === 0
        ? t === tracks - 1
          ? 6
          : 0
        : 8 + ARC_BASE - RAIL_ROW / 2 + ARC_LANE * (lanes - 1);
    y += air;
    rowY[t] = y + RAIL_ROW / 2;
    y += RAIL_ROW;
  }
  const capY = banded ? y + PLATFORM_ROW / 2 : rowY[0]!;
  if (banded) y += PLATFORM_ROW;
  return {
    banded,
    capY,
    inset: banded && bands.some((band) => band.from === 0) ? CAPTION_X : 0,
    pillsTop: y + 8,
    rowY,
  };
}
