import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineHole } from "./timeline-holes.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import { LEDGE_PITCH, LEDGE_LAMP, ledgeLamps, railKey, scrollbarThumb } from "./timeline-ledge.js";
import type { TimelineViewport } from "./use-timeline-viewport.js";

/**
 * Ledge and scrollbar.
 *
 * Ledge: stations collapsed off one side of the viewport appear as a row of identical 10px lights (16px each), connected by short ink-colored track segments.
 * On the content side, a short track connects to the first open station; on the far side, show `+n` when more than five are hidden.
 * Each light is a button: click it to bring that station back into view. A collapsed station is not drawn in the content—the light on the ledge **is** that station.
 *
 * Scrollbar: a 2px bar at the bottom of the timeline, with a border-colored track and foreground-subtlest thumb.
 * It is opacity 0 at rest and appears while the pointer is over a card or scrolling; hover thickens the track to 4px.
 * The thumb can be dragged and clicking the track pages. Hide the native scrollbar.
 */

/** Station light: `STATUS_DOT` vocabulary; running adds a 3px breathing glow, the only glowing element on screen. */
export function stationLampClass(
  status: StepRunStatus | undefined,
  /**
   * Hole indicator (docs/dynamic-workflow/presentation.md, “Holes on the timeline”): an open or waiting hole is a
   * 1.5px dashed, unfilled indicator; while waiting, its stroke uses the warning color with a steady 3px glow—**no pulsing**, since nothing is running there.
   * After completion it becomes a regular indicator. All three drawing locations (track row, band indicator layer, and ledge) use this component, so holes look the same everywhere.
   */
  hole?: TimelineHole,
): string {
  if (hole !== undefined && hole.state !== "filled") {
    return cn(
      "wf-lamp wf-lamp-hole size-2.5 shrink-0 rounded-full border-[1.5px] border-dashed bg-transparent",
      hole.state === "waiting"
        ? "wf-lamp-hole-waiting border-warning"
        : "border-foreground-subtlest",
    );
  }
  const resolved = status ?? "pending";
  return cn(
    "wf-lamp size-2.5 shrink-0 rounded-full",
    STATUS_DOT[resolved],
    resolved === "running" && "wf-lamp-running motion-reduce:animate-none",
  );
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// The connector must match the static main track at 1px to avoid a width seam at the scroll edge.
// Parallel segment: when two stations on the ledge run concurrently, show two 1px lines 2px apart instead of one.
// The ledge flattens the lane so forks and merges do not fit; two parallel lines are the only remaining way to indicate simultaneity.
function Segment({ rail, width }: { rail: TimelineRail | undefined; width: number }) {
  if (rail?.kind === "twin") {
    return (
      <span
        aria-hidden
        className="relative h-0 shrink-0"
        data-ledge-ink={rail.ink}
        data-ledge-twin="true"
        style={{ width }}
      >
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: -1 }}
        />
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: 1 }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "h-0 shrink-0 border-t border-foreground-subtlest",
        rail === undefined && "invisible",
      )}
      data-ledge-ink={rail?.ink ?? "none"}
      style={{ width }}
    />
  );
}

export function WorkflowLedge({
  indexes,
  nameOf,
  onSelect,
  rails,
  side,
  stations,
  stubWidth,
  top,
}: {
  side: "left" | "right";
  /** Stations collapsed to this side, in ascending order. */
  indexes: readonly number[];
  stations: readonly TimelineStation[];
  /** Track segments between adjacent stations, indexed by **station pair** (`railKey`); a station in a lane can produce several segments. */
  rails: ReadonlyMap<string, TimelineRail>;
  /** Width of the short track from the ledge to the first open station; 0 means do not draw. */
  stubWidth: number;
  /** Top of the track row (same height as the ledge and lights). */
  top: number;
  nameOf: (index: number) => string;
  onSelect: (index: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (indexes.length === 0) return null;
  const { shown, more } = ledgeLamps(indexes, side);
  const stubRail =
    side === "left"
      ? rails.get(railKey(indexes[indexes.length - 1]!, indexes[indexes.length - 1]! + 1))
      : rails.get(railKey(indexes[0]! - 1, indexes[0]!));
  const stub = stubWidth > 0 ? <Segment rail={stubRail} width={stubWidth} /> : null;
  const count =
    more > 0 ? (
      <span
        className="shrink-0 text-center font-mono text-ui-2xs text-foreground-subtlest"
        data-testid="workflow-timeline-ledge-more"
        style={{ width: 26 }}
      >
        +{more}
      </span>
    ) : null;
  const lamps = shown.map((index, k) => {
    const station = stations[index]!;
    const label = `${nameOf(index)} · ${intl.formatMessage({ id: `chat.toolCall.workflow.graph.status.${station.status ?? "pending"}` })}`;
    return (
      <span className="flex items-center" key={station.id}>
        {k > 0 ? (
          <Segment
            rail={rails.get(railKey(shown[k - 1]!, index))}
            width={LEDGE_PITCH - LEDGE_LAMP}
          />
        ) : null}
        <button
          aria-label={label}
          className="wf-ledge-lamp relative flex shrink-0 cursor-pointer items-center justify-center rounded-full outline-none before:absolute before:-inset-1 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring/40"
          data-station-index={index}
          data-testid="workflow-timeline-ledge-lamp"
          onClick={() => onSelect(index)}
          style={{ height: LEDGE_LAMP, width: LEDGE_LAMP }}
          title={label}
          type="button"
        >
          <span
            aria-hidden
            className={cn(stationLampClass(station.status, station.hole), "wf-land")}
            data-lamp={station.status ?? "pending"}
          />
        </button>
      </span>
    );
  });
  return (
    <div
      aria-label={intl.formatMessage(
        { id: `chat.toolCall.workflow.timeline.ledge.${side === "left" ? "earlier" : "later"}` },
        { count: indexes.length },
      )}
      className={cn(
        "wf-ledge pointer-events-auto absolute flex h-6 items-center",
        side === "left" ? "left-0 pl-2" : "right-0 pr-2",
      )}
      data-testid={`workflow-timeline-ledge-${side}`}
      role="group"
      style={{ top }}
    >
      {side === "left" ? count : stub}
      {lamps}
      {side === "left" ? stub : count}
    </div>
  );
}

/**
 * After dragging the thumb or clicking the track, the browser also dispatches a click that bubbles up to the host card.
 * End-of-turn summary cards treat a click on empty space as collapse/expand, and their child-control predicate recognizes only button/a/form elements, not scrollbars.
 * Dragging the slider therefore collapsed the card. Stop the scrollbar click here because the scrollbar has already consumed this interaction.
 */
function stopClick(event: ReactMouseEvent<HTMLDivElement>) {
  event.stopPropagation();
}

export function WorkflowTimelineScrollbar({
  scrollRef,
  viewport,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  viewport: TimelineViewport;
}) {
  const { intl } = useZCodeIntl();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);
  const thumb = scrollbarThumb(viewport.scrollLeft, viewport.clientWidth, viewport.scrollWidth);
  if (thumb === undefined) return null;
  const range = viewport.scrollWidth - viewport.clientWidth;
  const ratio = viewport.scrollWidth / viewport.clientWidth;

  const onThumbDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startLeft: viewport.scrollLeft,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onThumbMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    const element = scrollRef.current;
    if (state === null || element === null || state.pointerId !== event.pointerId) return;
    element.scrollLeft = state.startLeft + (event.clientX - state.startX) * ratio;
  };
  const onThumbUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };
  const onTrackDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const element = scrollRef.current;
    if (element === null) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const direction = x < thumb.left ? -1 : 1;
    element.scrollBy({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      left: direction * viewport.clientWidth,
    });
  };
  return (
    <div
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.timeline.scrollbar" })}
      aria-orientation="horizontal"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round((100 * Math.min(viewport.scrollLeft, range)) / range)}
      className="wf-sb absolute inset-x-0 bottom-0 h-0.5 cursor-pointer rounded-full bg-border"
      data-dragging={dragging ? "true" : undefined}
      data-scrolling={viewport.scrolling ? "true" : undefined}
      data-testid="workflow-timeline-scrollbar"
      onClick={stopClick}
      onPointerDown={onTrackDown}
      role="scrollbar"
    >
      <span
        className="wf-sb-thumb absolute inset-y-0 rounded-full bg-foreground-subtlest"
        data-testid="workflow-timeline-scrollbar-thumb"
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        style={{ left: thumb.left, width: thumb.width }}
      />
    </div>
  );
}
