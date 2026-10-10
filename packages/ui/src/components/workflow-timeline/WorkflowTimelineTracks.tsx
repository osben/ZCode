import { useId } from "react";
import { cn } from "@/components/lib/utils.js";
import type {
  TimelineBand,
  TimelineInk,
  TimelineStation,
  WorkflowTimelineModel,
} from "./timeline-model.js";
import {
  bandAt,
  bandForkX,
  bandMergeX,
  lampX,
  STUB,
  TAIL,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { MarchLight } from "./WorkflowMarchLight.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";

/**
 * Track layer.
 *
 * In a timeline without lanes, track segments remain a border fragment on the station-header row (pixel-for-pixel unchanged).
 * **With lanes**, the whole track moves into the SVG layer for the arc: the main line follows the bottom row, branch tracks stack above it,
 * with a fork before each lane and a merge after it. Two 8px quarter circles lift the branch up and back down (branches go upward).
 * Lights remain DOM elements (they need status classes), absolutely positioned on their own track rows; station headers move to the platform row,
 * and a dotted guide connects each branch-track station back to its label.
 */
const INK_STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-workflow-trace-strong)",
  strong: "var(--color-workflow-trace-strong)",
};

/** A point on the canvas. */
export interface TimelinePoint {
  x: number;
  y: number;
}

/** A track segment on screen: one path, one ink style, and its two stations (useful for tests/debugging). */
export interface TimelineRailPiece {
  key: string;
  d: string;
  /**
   * The path endpoints come from the same values as `d`; the moving-edge light gradient (`MarchLight`) uses these points
   * instead of parsing `d` again.
   */
  start: TimelinePoint;
  end: TimelinePoint;
  ink: TimelineInk;
  /** `fork` / `merge` are curves with lanes at both ends; `tail` / `stub` are short main-line segments when there is no predecessor/merge station. */
  kind?: "fork" | "merge" | "tail" | "stub";
  from?: number;
  to?: number;
}

/** Path and its endpoints: each segment in `timelineRailPieces` computes these first, then adds ink and its two stations. */
type RailShape = Pick<TimelineRailPiece, "d" | "end" | "start">;

/**
 * Track segment → path (pure function). An ordinary segment on one track is a straight line on that row (light + 8 → light − 8).
 * Main-line segments cross fork/merge points and therefore remain straight lines. An ordinary segment whose endpoints are in **different lanes**
 * can only be the segment between adjacent lanes; draw it on the main line from the previous lane's merge to the next lane's fork.
 * Parallel segments are not drawn on cards.
 */
export function timelineRailPieces(
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">,
  layout: TimelineLayout,
): TimelineRailPiece[] {
  const { bands, rails, stations } = model;
  const { inset, rowY } = layout;
  const y0 = rowY[0]!;
  const rowOf = (track: number): number => rowY[track] ?? y0;
  const lx = (i: number): number => lampX(i, inset);
  const forkX = (band: TimelineBand): number => bandForkX(band, inset);
  const mergeX = (band: TimelineBand): number => bandMergeX(band, inset);
  const trackOfStation = (i: number): number => stations[i]?.track ?? 0;

  /** A straight segment on one row. */
  const straight = (x1: number, x2: number, y: number): RailShape => ({
    d: `M${x1},${y} H${x2}`,
    end: { x: x2, y },
    start: { x: x1, y },
  });
  // Branch track t leaves the main line at forkX − 8(t−1), rises to its row through two quarter circles, then runs horizontally to 8px before its first light.
  const forkPath = (band: TimelineBand, track: number, head: number): RailShape => {
    const xf = forkX(band) - 8 * (track - 1);
    const yt = rowOf(track);
    return {
      d: `M${xf},${y0} Q${xf + 8},${y0} ${xf + 8},${y0 - 8} V${yt + 8} Q${xf + 8},${yt} ${xf + 16},${yt} H${lx(head) - 8}`,
      end: { x: lx(head) - 8, y: yt },
      start: { x: xf, y: y0 },
    };
  };
  // Merge mirrors the fork: run horizontally from 8px after the last station's light to xm − 8, then descend to the main line.
  // The higher a lane is, the farther left its merge point.
  const mergePath = (band: TimelineBand, track: number, tail: number): RailShape => {
    const xm = mergeX(band) - 8 * (band.tracks.length - 1 - track);
    const yt = rowOf(track);
    return {
      d: `M${lx(tail) + 8},${yt} H${xm - 8} Q${xm},${yt} ${xm},${yt + 8} V${y0 - 8} Q${xm},${y0} ${xm + 8},${y0}`,
      end: { x: xm + 8, y: y0 },
      start: { x: lx(tail) + 8, y: yt },
    };
  };

  const pieces: TimelineRailPiece[] = [];
  // A lane without a predecessor/merge station grows its own ends: a short main-line tail/stub and the branch-track curve.
  // No matching track segment exists in the model (a segment needs both a fork and merge station); use the lane's own entry/exit ink.
  for (const band of bands) {
    const main = band.tracks[0]!;
    if (band.pred === undefined) {
      const head = main.stations[0]!;
      pieces.push({
        ...straight(forkX(band) - TAIL, lx(head) - 8, y0),
        ink: main.entry,
        key: `tail:${band.from}`,
        kind: "tail",
        to: head,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const first = track.stations[0]!;
        pieces.push({
          ...forkPath(band, t, first),
          ink: track.entry,
          key: `fork:${band.from}:${t}`,
          kind: "fork",
          to: first,
        });
      });
    }
    if (band.join === undefined) {
      const last = main.stations[main.stations.length - 1]!;
      pieces.push({
        ...straight(lx(last) + 8, mergeX(band) + STUB, y0),
        ink: main.exit,
        key: `stub:${band.to}`,
        kind: "stub",
        from: last,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const end = track.stations[track.stations.length - 1]!;
        pieces.push({
          ...mergePath(band, t, end),
          ink: track.exit,
          key: `merge:${band.to}:${t}`,
          kind: "merge",
          from: end,
        });
      });
    }
  }

  for (const rail of rails) {
    // A parallel segment only indicates that these stations run concurrently; do not draw it on cards because the fork and merge already show that.
    if (rail.kind === "twin") continue;
    const ends = { from: rail.from, ink: rail.ink, key: `${rail.from}>${rail.to}`, to: rail.to };
    if (rail.kind === "fork") {
      const band = bandAt(bands, rail.to);
      if (band === undefined) continue;
      pieces.push({ ...ends, ...forkPath(band, trackOfStation(rail.to), rail.to), kind: "fork" });
      continue;
    }
    if (rail.kind === "merge") {
      const band = bandAt(bands, rail.from);
      if (band === undefined) continue;
      pieces.push({
        ...ends,
        ...mergePath(band, trackOfStation(rail.from), rail.from),
        kind: "merge",
      });
      continue;
    }
    const source = bandAt(bands, rail.from);
    const target = bandAt(bands, rail.to);
    if (source !== undefined && target !== undefined && source !== target) {
      pieces.push({ ...ends, ...straight(mergeX(source), forkX(target), y0) });
      continue;
    }
    const yt = rowOf(trackOfStation(rail.from));
    pieces.push({ ...ends, ...straight(lx(rail.from) + 8, lx(rail.to) - 8, yt) });
  }
  return pieces;
}

/**
 * Tracks and guides are drawn in the arc's SVG layer (mounted only when lanes exist). Moving segments are layered as before,
 * but the layer now contains a **stationary** light (`MarchLight`): it fades in from the segment start and is brightest near the light.
 */
export function WorkflowTimelineTracks({
  folded,
  layout,
  model,
}: {
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">;
  layout: TimelineLayout;
  /** A station folded into the eave; its guide fades out along with the light. */
  folded: ReadonlySet<number>;
}) {
  const pieces = timelineRailPieces(model, layout);
  // The track layer shares the arc's SVG, so gradient IDs must be unique across the whole SVG: instance prefix + segment key (with `:` and `>` removed).
  const gradientBase = useId();
  return (
    <g>
      {pieces.map((piece) => (
        <g
          data-rail-from={piece.from}
          data-rail-ink={piece.ink}
          data-rail-kind={piece.kind}
          data-rail-to={piece.to}
          data-testid="workflow-timeline-rail"
          key={piece.key}
        >
          <path
            className="wf-ink"
            d={piece.d}
            fill="none"
            stroke={INK_STROKE[piece.ink]}
            strokeWidth={1}
          />
          {piece.ink === "march" ? (
            <MarchLight
              d={piece.d}
              from={piece.start}
              id={`${gradientBase}lit-${piece.key.replace(/[^\w-]/g, "-")}`}
              to={piece.end}
            />
          ) : null}
        </g>
      ))}
      {model.stations.map((station, i) =>
        station.track === 0 ? null : (
          <path
            className={cn("wf-foldable", folded.has(i) && "wf-folded")}
            d={`M${lampX(i, layout.inset)},${(layout.rowY[station.track] ?? layout.rowY[0]!) + 7} V${layout.capY - 10}`}
            data-leader-station={i}
            data-testid="workflow-timeline-leader"
            fill="none"
            key={station.id}
            stroke="var(--color-workflow-trace)"
            strokeDasharray="1 2"
            strokeLinecap="round"
            strokeWidth={1}
          />
        ),
      )}
    </g>
  );
}

/**
 * Lights (when lanes exist) remain DOM spans, with status classes, glow, and pulsing handled in CSS.
 * They are absolutely positioned on their own track rows instead of following the station headers.
 */
export function WorkflowTimelineLamps({
  draft,
  folded,
  layout,
  stations,
}: {
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  folded: ReadonlySet<number>;
  draft: boolean;
}) {
  return (
    <>
      {stations.map((station, i) => (
        <span
          aria-hidden
          className={cn(
            stationLampClass(station.status),
            "absolute",
            "wf-foldable",
            folded.has(i) && "wf-folded",
            draft && "wf-land",
          )}
          data-lamp={station.status ?? "pending"}
          data-lamp-track={station.track}
          key={station.id}
          style={{
            left: lampX(i, layout.inset) - 5,
            top: (layout.rowY[station.track] ?? layout.rowY[0]!) - 5,
          }}
        />
      ))}
    </>
  );
}
