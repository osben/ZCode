import type { ReactNode } from "react";
import type { TimelineArc, TimelineBand, TimelineInk, TimelineStation } from "./timeline-model.js";
import {
  ARC_BASE,
  ARC_LANE,
  arcEnds,
  arcTerminalOffsets,
  bandAt,
  bandForkX,
  bandMergeX,
  lampX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { MarchLight } from "./WorkflowMarchLight.js";

/**
 * Arc layer: the timeline's only SVG; draws only non-adjacent edges.
 * An edge rises from the source light to its arc lane, runs horizontally to the target, then descends to its light with a downward arrow.
 * Each arc endpoint at a station—arrival or departure—gets its own slot, 10px apart (`arcTerminalOffsets`: far endpoints stay on their side,
 * and the lowest lane on each side is outermost), so outgoing vertical segments do not cross incoming arrows.
 * On first appearance, draw from source to target (`pathLength=1` makes dashoffset independent of geometry); later changes update only the ink.
 * A moving edge gets an additional stationary light layer (`MarchLight`, brightest toward the target light); motion belongs to the lights themselves.
 *
 * With lanes, a lane is **one node**: a source in a lane leaves from its merge point, and a target in a lane lands at its fork point
 * (4px early because there is no light to stop at). Arc height comes from its own **air** (`arc.air`): arcs within the same lane use that lane's air,
 * while cross-lane and lane-level arcs use the topmost air. Track segments also move into this layer (`children`).
 *
 * Vertical segments of lane-level arcs extend to the **row of their own endpoint**: a station source starts from its light's row, while a lane source
 * starts at the main-line merge; destinations likewise use the main-line fork or target light row. Rule 3 on the Loops board says vertical segments
 * "cross branch rows through columns that are empty in those rows." Ending at the topmost track row crosses nothing and leaves a full row of empty space
 * between the main-line light and its arc, making the connection look broken. The design-canvas generator stopping at `rowY[R−1]` is a shortcut, not the design.
 */
const INK_STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-workflow-trace-strong)",
  strong: "var(--color-workflow-trace-strong)",
};

export function WorkflowTimelineArcs({
  arcs,
  bands,
  children,
  height,
  layout,
  markerId,
  stations,
  width,
}: {
  arcs: readonly TimelineArc[];
  bands: readonly TimelineBand[];
  /** All stations (not only the draft's slice); arc indexes point here to read each station's track. */
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  width: number;
  height: number;
  markerId: string;
  children?: ReactNode;
}) {
  const terminals = arcTerminalOffsets(arcs, bands, stations);
  const { inset, rowY } = layout;
  const rowOf = (track: number): number => rowY[track] ?? rowY[0]!;
  const trackOf = (index: number): number => stations[index]?.track ?? 0;
  return (
    <svg
      aria-hidden
      className="absolute left-0 top-0 overflow-visible"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <defs>
        {(["faint", "strong"] as const).map((ink) => (
          <marker
            id={`${markerId}-${ink}`}
            key={ink}
            markerHeight="6"
            markerWidth="6"
            orient="auto-start-reverse"
            refX="7"
            refY="4"
            viewBox="0 0 8 8"
          >
            <path d="M0,0.5 L7,4 L0,7.5 Z" fill={INK_STROKE[ink]} />
          </marker>
        ))}
      </defs>
      {children}
      {arcs.map((arc, j) => {
        // Arcs within one lane stay entirely in that lane's air and end at lights; all other arcs treat a lane as one node (`arcEnds`).
        const { fromBand, toBand } = arcEnds(arc, bands, stations);
        const source = bandAt(bands, arc.from);
        const target = bandAt(bands, arc.to);
        const ly = rowOf(arc.air) - ARC_BASE - ARC_LANE * arc.lane;
        // Each endpoint at a light gets its own slot; a fork/merge point is one point, not a row of lights, so it uses no slot (offset is always 0).
        const xa =
          fromBand && source !== undefined
            ? bandMergeX(source, inset)
            : lampX(arc.from, inset) + terminals.takeoff[j]!;
        const xb =
          toBand && target !== undefined
            ? bandForkX(target, inset)
            : lampX(arc.to, inset) + terminals.landing[j]!;
        const sign = xb < xa ? -1 : 1;
        // Both departure and arrival follow the **endpoint's own row**: lanes use main-line merge/fork points, while stations use their light row.
        const ya = fromBand ? rowY[0]! - 3 : rowOf(trackOf(arc.from)) - 7;
        const yb = toBand ? rowY[0]! - 4 : rowOf(trackOf(arc.to)) - 9;
        const tail = `V${yb}`;
        const path = `M${xa},${ya} V${ly + 8} Q${xa},${ly} ${xa + 8 * sign},${ly} H${xb - 8 * sign} Q${xb},${ly} ${xb},${ly + 8} ${tail}`;
        const ink = arc.ink === "march" ? "strong" : arc.ink;
        return (
          <g
            data-arc-from={arc.from}
            data-arc-ink={arc.ink}
            data-arc-to={arc.to}
            data-testid="workflow-timeline-arc"
            key={`${arc.from}-${arc.to}-${arc.air}`}
          >
            <path
              className="wf-ink wf-draw"
              d={path}
              fill="none"
              markerEnd={`url(#${markerId}-${ink})`}
              pathLength={1}
              stroke={INK_STROKE[ink]}
              strokeWidth={1}
            />
            {arc.ink === "march" ? (
              // Shorten the moving-edge light by 6px so it stops at the arrow base.
              <MarchLight
                d={`${path.slice(0, -tail.length)}V${yb - 6}`}
                from={{ x: xa, y: ya }}
                id={`${markerId}-lit-${j}`}
                to={{ x: xb, y: yb - 6 }}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
