import type { TimelineStation } from "./timeline-model.js";
import { fillContains, type HoleParents, type TimelineFill } from "./timeline-holes.js";
import {
  HEAD_ROW,
  MARK_X,
  RAIL_ROW,
  STATION_WIDTH,
  stationX,
  type TimelineLayout,
} from "./timeline-geometry.js";

/**
 * Fill frames (docs/dynamic-workflow/presentation.md "Holes on the timeline", sections "Filled with
 * phases" and "The stroke"): a single 1px line, radius 8, enclosing what one fill wrote, drawn only
 * when the pointer is over its **head** (or keyboard focus is on the head); during the two seconds
 * after the fill joins the run it draws itself. The line is **one stroke**: it starts on the top edge
 * and circles clockwise back to its start — a headed fill starts at the pen's x (the head is the
 * legend; the line emerges at the name's right end and ends on the pen), a headless one starts from
 * the top-left corner. Pure geometry: no React, no DOM.
 *
 * Fix rationale (tested 2026-09-29): the previous "area" was a tinted block that lit whenever the
 * pointer touched any station / pill inside the fill, flickering all the way across a card sweep;
 * nested fills stacked into two blocks of different depth and read like a panel; and the side pane
 * had nothing at all.
 */

/** How far the frame extends past the columns it encloses, on both sides. */
export const FRAME_OUTSET = 8;
/** How far each nesting level of same-start nested frames insets inward. */
export const FRAME_NEST_INSET = 4;
/** The frame's corner radius. */
export const FRAME_RADIUS = 8;
/** The gap the line leaves on both sides of the head row. */
export const FRAME_LEGEND_GAP = 4;

/** The frame's bounding rectangle (integer pixels); `start` is the pen's x on the top edge; absent means the stroke starts from the top-left corner. */
export interface FrameBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  start?: number;
}

export interface TimelineFrame {
  holeId: string;
  box: FrameBox;
  /** The fill's moment: the fresh state (two seconds) is computed from it. */
  filledAt?: number;
}

/**
 * A one-stroke path: starts at `start` on the top edge, goes right, circles clockwise, and returns to
 * `start`. A 1px line stays crisp only on half pixels: the rectangle is inset by half a pixel.
 * The caller supplies `pathLength` 1; the dash offset walking from 1 to 0 is "being drawn".
 */
export function framePath(box: FrameBox, radius = FRAME_RADIUS): string {
  const x0 = box.x0 + 0.5;
  const y0 = box.y0 + 0.5;
  const x1 = box.x1 - 0.5;
  const y1 = box.y1 - 0.5;
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  const start = Math.min(Math.max(box.start ?? x0 + r, x0 + r), x1 - r);
  return [
    `M${start},${y0}`,
    `H${x1 - r}`,
    `Q${x1},${y0} ${x1},${y0 + r}`,
    `V${y1 - r}`,
    `Q${x1},${y1} ${x1 - r},${y1}`,
    `H${x0 + r}`,
    `Q${x0},${y1} ${x0},${y1 - r}`,
    `V${y0 + r}`,
    `Q${x0},${y0} ${x0 + r},${y0}`,
    `H${start}`,
  ].join(" ");
}

/** Phase-less fills: the holes' own stations that carry a pen mark and are not in `fills` (their frames enclose only their own column). */
export interface FillMark {
  holeId: string;
  index: number;
  filledAt?: number;
}

export function fillMarksOf(
  stations: readonly Pick<TimelineStation, "hole">[],
  fills: readonly Pick<TimelineFill, "holeId">[],
): FillMark[] {
  const headed = new Set(fills.map((fill) => fill.holeId));
  return stations.flatMap((station, index) => {
    const hole = station.hole;
    if (hole?.state !== "filled" || headed.has(hole.siteId)) return [];
    return [
      {
        holeId: hole.siteId,
        index,
        ...(hole.filledAt === undefined ? {} : { filledAt: hole.filledAt }),
      },
    ];
  });
}

/** How many fills start on the same station as `fill` and also enclose it: frames inset by depth. */
function sameStartDepth(
  fill: TimelineFill,
  fills: readonly TimelineFill[],
  parents: HoleParents,
): number {
  return fills.filter(
    (other) =>
      other.holeId !== fill.holeId &&
      other.from === fill.from &&
      fillContains(other.holeId, fill.holeId, parents),
  ).length;
}

/** How many fills enclose `holeId` (the pane's frames inset by it). */
export function fillDepthOf(
  holeId: string,
  fills: readonly Pick<TimelineFill, "holeId">[],
  parents: HoleParents,
): number {
  return fills.filter(
    (other) => other.holeId !== holeId && fillContains(other.holeId, holeId, parents),
  ).length;
}

/**
 * Frames on the card. A headed fill: x from the first column's left edge − 8 to the last column's
 * right edge + 8, y from the head row's midline to 8px below its tallest column's pills (when those
 * columns have no pills — the card collapsed, say — to 4px below the rail row / platform row);
 * same-start nested frames inset 4px on left, right, and bottom per level. A phase-less fill: its own
 * column, 4px above the rail row to 8px below its pill, stroke starting from the top-left corner.
 * Everything is clamped to the timeline canvas (so the first and last columns' frames are not cut in
 * half by the scroll layer).
 */
export function timelineFrames({
  columnHeight,
  fills,
  height,
  inset,
  layout,
  parents,
  stations,
  width,
}: {
  fills: readonly TimelineFill[];
  stations: readonly Pick<TimelineStation, "hole" | "track">[];
  layout: Pick<TimelineLayout, "pillsTop" | "rowY">;
  /** The i-th station's pill-column height (0 when there are no pills). */
  columnHeight: (index: number) => number;
  height: number;
  width: number;
  inset: number;
  parents: HoleParents;
}): TimelineFrame[] {
  const bottomOf = (from: number, to: number): number => {
    let tallest = 0;
    for (let i = from; i <= to; i += 1) tallest = Math.max(tallest, columnHeight(i));
    // Pill column top = rail row (or platform row) bottom + 8, so with no pills, pillsTop − 4 is 4px below that row.
    return tallest > 0 ? layout.pillsTop + tallest + FRAME_OUTSET : layout.pillsTop - 4;
  };
  const clamp = (box: FrameBox): FrameBox => ({
    ...box,
    x0: Math.max(0, box.x0),
    x1: Math.min(width, box.x1),
    y0: Math.max(0, box.y0),
    y1: Math.min(height, box.y1),
  });
  const frames: TimelineFrame[] = fills.map((fill) => {
    const k = sameStartDepth(fill, fills, parents) * FRAME_NEST_INSET;
    return {
      holeId: fill.holeId,
      box: clamp({
        x0: stationX(fill.from, inset) - FRAME_OUTSET + k,
        x1: stationX(fill.to, inset) + STATION_WIDTH + FRAME_OUTSET - k,
        y0: HEAD_ROW / 2,
        y1: bottomOf(fill.from, fill.to) - k,
        start: stationX(fill.from, inset) + MARK_X,
      }),
      ...(fill.filledAt === undefined ? {} : { filledAt: fill.filledAt }),
    };
  });
  for (const mark of fillMarksOf(stations, fills)) {
    const rowY = layout.rowY[stations[mark.index]?.track ?? 0] ?? layout.rowY[0]!;
    frames.push({
      holeId: mark.holeId,
      box: clamp({
        x0: stationX(mark.index, inset) - FRAME_OUTSET,
        x1: stationX(mark.index, inset) + STATION_WIDTH + FRAME_OUTSET,
        y0: rowY - RAIL_ROW / 2 - 4,
        y1: bottomOf(mark.index, mark.index),
      }),
      ...(mark.filledAt === undefined ? {} : { filledAt: mark.filledAt }),
    });
  }
  return frames;
}

/** The gap the head row cuts out of the top edge (the legend): one rectangle per row, 4px clearance on each side. Not cut when the width is unmeasurable (0). */
export function legendGaps(
  rows: readonly { left: number; width: number }[],
): { x: number; width: number }[] {
  return rows
    .filter((row) => row.width > 0)
    .map((row) => ({ x: row.left - FRAME_LEGEND_GAP, width: row.width + 2 * FRAME_LEGEND_GAP }));
}

/**
 * The side pane's frame: x from 8 to the list's right edge − 12, each nesting level inset 4px; a
 * headed fill goes from the heading's midline to 4px below its last section, with the stroke starting
 * at the track's x (21, where the pen covers the line); a phase-less fill encloses its own section,
 * inset 2px top and bottom, stroke starting from the top-left corner. Vertical positions are measured
 * from the DOM by the caller (section expand/collapse changes them).
 */
export const SPINE_FRAME_LEFT = 8;
export const SPINE_FRAME_RIGHT = 12;
export const SPINE_RAIL_X = 21;

export function spineFrameBox({
  bottom,
  depth,
  headed,
  top,
  width,
}: {
  /** The heading row's top (headed) or the section's top (headless), relative to the list content. */
  top: number;
  /** The last section's bottom. */
  bottom: number;
  width: number;
  depth: number;
  headed: boolean;
}): FrameBox {
  const k = depth * FRAME_NEST_INSET;
  return headed
    ? {
        x0: SPINE_FRAME_LEFT + k,
        x1: width - SPINE_FRAME_RIGHT - k,
        y0: Math.round(top + HEAD_ROW / 2),
        y1: Math.round(bottom + 4),
        start: SPINE_RAIL_X,
      }
    : {
        x0: SPINE_FRAME_LEFT + k,
        x1: width - SPINE_FRAME_RIGHT - k,
        y0: Math.round(top + 2),
        y1: Math.round(bottom - 2),
      };
}
