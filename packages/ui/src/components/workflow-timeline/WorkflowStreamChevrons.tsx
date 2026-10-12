import type { CSSProperties } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineInk } from "./timeline-model.js";

/**
 * Stream-rail chevrons (docs/dynamic-workflow/presentation.md "Stream rails"): the track breaks for a
 * `STREAM_GAP` segment at the middle of its visible span, and a group of `›››` stands in the gap —
 * three chevrons 5px apart, each 2.6 × 6.4, stroke 1.35, round caps and joins, pointing along the
 * flow's direction. The ink lives on the chevrons: `faint` (nothing has passed yet) is
 * workflow-trace; `strong` (has passed, not passing now) is workflow-trace-strong; `march` (both ends
 * running, things passing now) is the warning color, and the three light up in sequence along the
 * flow (`wf-stream-flow`, a 1.2s cycle, staggered 0.15s). The track itself does not move; only the
 * chevrons do.
 *
 * Drawn in SVG coordinates (the card's arc layer and the band's track layer are both SVG); the
 * station-head row's DOM track wraps a small SVG via {@link StreamChevronsBox}. The spine uses it
 * vertically: two chevrons, pointing down.
 */
export const STREAM_GAP = 22;
const PITCH = 5;
const HALF_WIDTH = 1.3;
const HALF_HEIGHT = 3.2;
const STAGGER_S = 0.15;

const STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-warning)",
  strong: "var(--color-workflow-trace-strong)",
};

export type StreamDirection = "right" | "left" | "down";

/** Path for a group of chevrons (pure function): centered at (x, y), `count` chevrons laid out along `direction` and pointing that way. */
export function streamChevronPaths(
  x: number,
  y: number,
  direction: StreamDirection,
  count = 3,
): string[] {
  const sign = direction === "left" ? -1 : 1;
  return Array.from({ length: count }, (_, k) => {
    const offset = (k - (count - 1) / 2) * PITCH * sign;
    if (direction === "down") {
      const cy = y + offset;
      return `M${x - HALF_HEIGHT},${cy - HALF_WIDTH} L${x},${cy + HALF_WIDTH} L${x + HALF_HEIGHT},${cy - HALF_WIDTH}`;
    }
    const cx = x + offset;
    return `M${cx - HALF_WIDTH * sign},${y - HALF_HEIGHT} L${cx + HALF_WIDTH * sign},${y} L${cx - HALF_WIDTH * sign},${y + HALF_HEIGHT}`;
  });
}

export function StreamChevrons({
  count = 3,
  direction = "right",
  ink,
  x,
  y,
}: {
  x: number;
  y: number;
  ink: TimelineInk;
  direction?: StreamDirection;
  count?: number;
}) {
  const flowing = ink === "march";
  return (
    <g aria-hidden data-stream-ink={ink} data-testid="workflow-stream-chevrons">
      {streamChevronPaths(x, y, direction, count).map((d, k) => (
        <path
          className={cn("wf-ink", flowing && "wf-stream-flow")}
          d={d}
          fill="none"
          key={d}
          stroke={STROKE[ink]}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.35}
          // Light up in sequence: the k-th chevron along the flow is delayed by 0.15s·k.
          style={flowing ? { animationDelay: `${k * STAGGER_S}s` } : undefined}
        />
      ))}
    </g>
  );
}

/** A small SVG for DOM use: its center sticks to the host's (left, top); the host breaks its own line here. */
export function StreamChevronsBox({
  count = 3,
  direction = "right",
  ink,
  style,
}: {
  ink: TimelineInk;
  direction?: StreamDirection;
  count?: number;
  style?: CSSProperties;
}) {
  const vertical = direction === "down";
  const long = (count - 1) * PITCH + 2 * HALF_HEIGHT + 2;
  const width = vertical ? 2 * HALF_HEIGHT + 2 : long;
  const height = vertical ? long : 2 * HALF_HEIGHT + 2;
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute overflow-visible"
      height={height}
      style={{ transform: "translate(-50%, -50%)", ...style }}
      viewBox={`${-width / 2} ${-height / 2} ${width} ${height}`}
      width={width}
    >
      <StreamChevrons count={count} direction={direction} ink={ink} x={0} y={0} />
    </svg>
  );
}
