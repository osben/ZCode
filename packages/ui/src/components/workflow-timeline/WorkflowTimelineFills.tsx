import { PenIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineFill } from "./timeline-holes.js";
import { framePath, legendGaps, type TimelineFrame } from "./timeline-frames.js";
import { HEAD_ROW, MARK_X, stationX } from "./timeline-geometry.js";

/** How long, after a fill joins the run, the frame redraws itself and the head is tinted warning (docs/dynamic-workflow/presentation.md "The stroke"). */
export const FILL_FRESH_MS = 2_000;

/**
 * Which fills are "fresh" right now: within two seconds after `filledAt`. State + a timer instead of
 * reading the clock every frame: the model has no time; the clock exists only here, only for these
 * two seconds. Headed fills and phase-less fills (the pen mark) are treated alike.
 */
export function useFreshFills(
  fills: readonly { holeId: string; filledAt?: number }[],
): ReadonlySet<string> {
  const compute = () => {
    const now = Date.now();
    return new Set(
      fills
        .filter((fill) => fill.filledAt !== undefined && now - fill.filledAt < FILL_FRESH_MS)
        .map((fill) => fill.holeId),
    );
  };
  const [fresh, setFresh] = useState<ReadonlySet<string>>(compute);
  const key = fills.map((fill) => `${fill.holeId}@${fill.filledAt ?? ""}`).join("\u0000");
  useEffect(() => {
    const next = compute();
    setFresh(next);
    if (next.size === 0) return undefined;
    const now = Date.now();
    const latest = Math.max(
      ...fills.filter((fill) => next.has(fill.holeId)).map((fill) => fill.filledAt ?? now),
    );
    const timer = setTimeout(() => setFresh(new Set()), Math.max(0, latest + FILL_FRESH_MS - now));
    return () => clearTimeout(timer);
    // Recompute only on the fills' identity and moments (`key`): the `fills` array is a fresh
    // reference every frame, and depending on it would reset the timer every frame.
  }, [key]);
  return fresh;
}

/** The fill head an event target belongs to (`data-fill-head`); with `inside`, also accepts a pen mark inside the target (a station-head button gaining focus). */
function fillHeadOf(target: EventTarget, inside: boolean): string | undefined {
  // The pointer often lands on the pen icon inside the head — an SVGElement, not an HTMLElement, so accept Element.
  if (!(target instanceof Element)) return undefined;
  const owner =
    target.closest<HTMLElement>("[data-fill-head]") ??
    (inside ? target.querySelector<HTMLElement>("[data-fill-head]") : null);
  return owner?.dataset.fillHead;
}

function focusVisible(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    // Environments that do not know :focus-visible (older jsdom): treat it as pointer-driven focus and draw no frame.
    return false;
  }
}

/**
 * Which frame to draw right now (shared by card and side pane): the delegation mounted on the root
 * only recognizes **heads** — elements with `data-fill-head` (the card's head, the pane's heading row,
 * a phase-less fill's pen mark). Either the pointer is over it or a focus-visible focus is on it
 * (including the pen mark inside a station-head button). Only focus-visible counts: when a click opens
 * the pane the focus stays on the head, which must not keep the frame lit. No delegation when
 * `enabled` is false.
 */
export function useFillHeadTarget(enabled: boolean): {
  active: string | undefined;
  handlers: {
    onPointerOver?: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerLeave?: () => void;
    onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
    onBlur?: () => void;
  };
} {
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const onPointerOver = useCallback((event: PointerEvent<HTMLDivElement>) => {
    setHovered(fillHeadOf(event.target, false));
  }, []);
  const onPointerLeave = useCallback(() => setHovered(undefined), []);
  const onFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    setFocused(focusVisible(event.target) ? fillHeadOf(event.target, true) : undefined);
  }, []);
  const onBlur = useCallback(() => setFocused(undefined), []);
  return enabled
    ? { active: hovered ?? focused, handlers: { onBlur, onFocus, onPointerLeave, onPointerOver } }
    : { active: undefined, handlers: {} };
}

/**
 * The width of the head rows (the gaps the legend cuts out of the frame's top edge): measured once
 * per commit, re-measured by a ResizeObserver when fonts or copy change. Empty when not measurable
 * (jsdom, before the first frame) — the frame still draws, just without the cut-out.
 */
function useRowWidths(key: string): {
  refFor: (from: number) => (element: HTMLElement | null) => void;
  widths: Readonly<Record<number, number>>;
} {
  const rows = useRef(new Map<number, HTMLElement>());
  const [widths, setWidths] = useState<Readonly<Record<number, number>>>({});
  const measure = useCallback(() => {
    const next: Record<number, number> = {};
    for (const [from, element] of rows.current) next[from] = element.offsetWidth;
    setWidths((previous) => {
      const same =
        Object.keys(previous).length === Object.keys(next).length &&
        Object.entries(next).every(([from, width]) => previous[Number(from)] === width);
      return same ? previous : next;
    });
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    for (const element of rows.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [key, measure]);
  const refFor = useCallback(
    (from: number) => (element: HTMLElement | null) => {
      if (element === null) rows.current.delete(from);
      else rows.current.set(from, element);
    },
    [],
  );
  return { refFor, widths };
}

/**
 * Fill heads and frames (docs/dynamic-workflow/presentation.md "Holes on the timeline").
 *
 * Head: a 24px row that exists only on timelines that have fills; the pen (12px) aligns with the
 * first new lamp's x, followed by the hole's name (caption, medium, subtle, 300px truncation). No
 * background, no line. Clicking it opens the pane on the fill's heading. It (and a phase-less fill's
 * pen mark) carries `data-fill-head`: the timeline reads hover and keyboard focus only from here;
 * stations and pills no longer light anything up.
 * Frame: the bounding rectangle computed by `timeline-frames.ts`, a single path with `pathLength` 1;
 * with `data-fill-on` the dash offset walks from 1 to 0 (drawn in one stroke, 420ms) and on leave the
 * whole line fades out over 160ms. During the fresh two seconds it carries `wf-fill-frame-fresh` and
 * redraws itself (an animation, not a transition: it is already lit in the frame it mounts). The head
 * rows are cut out of the top edge (mask), so the head is the legend and this holds no matter what
 * surface the timeline lands on. Only one frame lights at a time: nested fills do not stack.
 * When a nested fill starts on the same station as its outer fill, the inner head follows the outer
 * head: 12px past the outer head's right edge, on the same row — heads sharing a start go into one
 * flex row (gap 12px), derived by layout rather than measured widths; heads with different starts
 * each align with their own first lamp.
 */
export function WorkflowTimelineFills({
  active,
  fills,
  frames,
  fresh,
  height,
  inset,
  onOpenFill,
  width,
}: {
  fills: readonly TimelineFill[];
  /** One frame per fill (headed and phase-less alike, `timelineFrames`). */
  frames: readonly TimelineFrame[];
  /** The one frame drawn right now: the pointer is over its head, or keyboard focus is on the head. */
  active: string | undefined;
  fresh: ReadonlySet<string>;
  height: number;
  width: number;
  inset: number;
  onOpenFill?: (fill: TimelineFill) => void;
}) {
  const { intl } = useZCodeIntl();
  const maskId = `wf-fill-legend-${useId().replace(/:/gu, "")}`;
  // The model sorts by `from` ascending, outer fill before inner on a shared start, so heads with the
  // same start line up in the same order.
  const headRows = new Map<number, TimelineFill[]>();
  for (const fill of fills) {
    const row = headRows.get(fill.from);
    if (row === undefined) headRows.set(fill.from, [fill]);
    else row.push(fill);
  }
  const rowLeft = (from: number): number => stationX(from, inset) + MARK_X - 6;
  const { refFor, widths } = useRowWidths([...headRows.keys()].join(","));
  if (frames.length === 0 && fills.length === 0) return null;
  const gaps = legendGaps(
    [...headRows.keys()].map((from) => ({ left: rowLeft(from), width: widths[from] ?? 0 })),
  );

  const renderHead = (fill: TimelineFill) => {
    const isFresh = fresh.has(fill.holeId);
    const on = active === fill.holeId;
    const time =
      fill.filledAt === undefined ? undefined : new Date(fill.filledAt).toLocaleTimeString();
    const title = intl.formatMessage(
      {
        id:
          time === undefined
            ? "chat.toolCall.workflow.hole.head.title.untimed"
            : "chat.toolCall.workflow.hole.head.title",
      },
      { name: fill.name, time: time ?? "" },
    );
    const body = (
      <>
        <PenIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 max-w-[300px] truncate text-ui-caption font-medium">
          {fill.name}
        </span>
      </>
    );
    const className = cn(
      "wf-fill-head flex h-full items-center gap-1.5 whitespace-nowrap rounded-md",
      isFresh ? "wf-land text-warning" : on ? "text-foreground" : "text-foreground-subtle",
      onOpenFill !== undefined &&
        "cursor-pointer outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
    );
    const shared = {
      className,
      "data-fill-head": fill.holeId,
      "data-fill-on": on ? "true" : undefined,
      "data-testid": "workflow-timeline-fill-head",
      title,
    };
    return onOpenFill === undefined ? (
      <span key={fill.holeId} {...shared}>
        {body}
      </span>
    ) : (
      <button key={fill.holeId} onClick={() => onOpenFill(fill)} type="button" {...shared}>
        {body}
      </button>
    );
  };
  return (
    <>
      {/* The frame is beneath everything: lamps and track are drawn on its edges. */}
      <svg
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        data-testid="workflow-timeline-fill-frames"
        height={height}
        width={width}
      >
        {gaps.length === 0 ? null : (
          <defs>
            <mask
              height={height + 40}
              id={maskId}
              maskUnits="userSpaceOnUse"
              width={width + 40}
              x={-20}
              y={-20}
            >
              <rect fill="white" height={height + 40} width={width + 40} x={-20} y={-20} />
              {gaps.map((gap) => (
                <rect
                  fill="black"
                  height={HEAD_ROW}
                  key={gap.x}
                  width={gap.width}
                  x={gap.x}
                  y={0}
                />
              ))}
            </mask>
          </defs>
        )}
        {frames.map((frame) => {
          const isFresh = fresh.has(frame.holeId);
          return (
            <path
              className={cn("wf-fill-frame", isFresh && "wf-fill-frame-fresh")}
              d={framePath(frame.box)}
              data-fill-frame={frame.holeId}
              data-fill-fresh={isFresh ? "true" : undefined}
              data-fill-on={isFresh || active === frame.holeId ? "true" : undefined}
              data-testid="workflow-timeline-fill-frame"
              key={frame.holeId}
              {...(gaps.length === 0 ? {} : { mask: `url(#${maskId})` })}
              pathLength={1}
            />
          );
        })}
      </svg>
      {[...headRows].map(([from, row]) => (
        // Pen center on lamp center: the lamp center is at station left edge + MARK_X; the pen is 12px
        // wide with its left edge pulled back 6. A second head with the same start follows 12px after the previous one.
        <span
          className="absolute flex items-center gap-3"
          data-testid="workflow-timeline-fill-heads"
          key={from}
          ref={refFor(from)}
          style={{ height: HEAD_ROW, left: rowLeft(from), top: 0 }}
        >
          {row.map(renderHead)}
        </span>
      ))}
    </>
  );
}
