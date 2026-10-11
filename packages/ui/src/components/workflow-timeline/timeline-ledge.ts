import type { CSSProperties } from "react";
import { lampX, stationX, STATION_WIDTH } from "./timeline-geometry.js";

/**
 * Pure geometry for edge ledges: compress the two ends of one rail.
 *
 * The timeline scrolls freely. Stations whose indicators move beyond the viewport edge are **folded** into that side's ledge: the same 10px
 * indicators, 16px apart, connected by a track segment in the same color, on a clean background at the viewport edge. Rail rows fade over 40px
 * next to the ledge; pills fade only at the viewport boundary. Folding is a fixed point: a wider ledge (more indicators) covers more stations,
 * so repeat the calculation until the set stops changing.
 *
 * Everything uses viewport coordinates (x = station indicator center − scrollLeft). No React or DOM.
 */
export const LEDGE_LAMP = 10;
export const LEDGE_PITCH = 16;
export const LEDGE_PAD = 8;
export const LEDGE_FADE = 40;
export const LEDGE_MAX_LAMPS = 3;
/** Width of the `+n` count. */
const LEDGE_MORE = 26;
/** Do not draw the short rail between ledge and content if it would be shorter than this (it would look like a dot). */
const STUB_MIN = 6;
/** Minimum scrollbar-thumb length. */
const THUMB_MIN = 24;

export interface TimelineFold {
  /** Stations folded into the left ledge (ascending order). */
  left: number[];
  /** Stations folded into the right ledge (ascending order). */
  right: number[];
}

export const NO_FOLD: TimelineFold = { left: [], right: [] };

/** Width occupied by one side's ledge (including padding on both sides; zero indicators means no ledge). */
export function ledgeWidth(count: number): number {
  if (count <= 0) return 0;
  const lamps = Math.min(count, LEDGE_MAX_LAMPS) * LEDGE_PITCH - (LEDGE_PITCH - LEDGE_LAMP);
  return LEDGE_PAD + lamps + (count > LEDGE_MAX_LAMPS ? LEDGE_MORE : 0) + LEDGE_PAD;
}

/**
 * Folded set: stations whose indicators fall under the "ledge + fade" area; iterate to a fixed point. Fold nothing if the viewport has not been measured (width 0).
 * `keep` is the station the viewport is moving toward: the viewport was measured before `scrollTo`, so during the few hundred milliseconds
 * of smooth scrolling it appears outside the view according to the stale scrollLeft. But it is about to enter, so showing its indicator in the ledge
 * would be a false positive; exclude it on both sides. `inset` is the rightward shift of the whole rail when bands are present; indicators and folding checks both follow it.
 */
export function foldStations(
  count: number,
  scrollLeft: number,
  clientWidth: number,
  keep?: number,
  inset = 0,
): TimelineFold {
  if (count === 0 || clientWidth <= 0) return NO_FOLD;
  const xs = Array.from({ length: count }, (_, i) => lampX(i, inset) - scrollLeft);
  let left: number[] = [];
  let right: number[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const lw = left.length === 0 ? 0 : ledgeWidth(left.length) + LEDGE_FADE;
    const rw = right.length === 0 ? 0 : ledgeWidth(right.length) + LEDGE_FADE;
    const nextLeft = xs.flatMap((x, i) => (x < lw && i !== keep ? [i] : []));
    const nextRight = xs.flatMap((x, i) =>
      x > clientWidth - rw && i !== keep && !nextLeft.includes(i) ? [i] : [],
    );
    if (nextLeft.length === left.length && nextRight.length === right.length) break;
    left = nextLeft;
    right = nextRight;
  }
  return left.length === 0 && right.length === 0 ? NO_FOLD : { left, right };
}

/** Indicators shown on the ledge (up to three, prioritizing the end nearest the content) and the count. */
export function ledgeLamps(
  indexes: readonly number[],
  side: "left" | "right",
): { shown: number[]; more: number } {
  const more = Math.max(0, indexes.length - LEDGE_MAX_LAMPS);
  const shown =
    more === 0
      ? [...indexes]
      : side === "left"
        ? indexes.slice(more)
        : indexes.slice(0, LEDGE_MAX_LAMPS);
  return { shown, more };
}

/**
 * Width of the short rail between the ledge and first unfolded station: on the left, from the inner ledge edge to 6px before that station's indicator;
 * on the right, from the **slot end** of the last unfolded station (not the indicator, which would cross its header text) to the inner ledge edge.
 * Do not draw it when shorter than 6px.
 */
export function ledgeStubWidth(
  fold: TimelineFold,
  side: "left" | "right",
  scrollLeft: number,
  clientWidth: number,
  inset = 0,
): number {
  const indexes = side === "left" ? fold.left : fold.right;
  if (indexes.length === 0) return 0;
  const inner = ledgeWidth(indexes.length) - LEDGE_PAD;
  let width: number;
  if (side === "left") {
    const open = indexes[indexes.length - 1]! + 1;
    width = lampX(open, inset) - scrollLeft - STUB_MIN - inner;
  } else {
    const open = indexes[0]! - 1;
    width = clientWidth - inner - (stationX(open, inset) + STATION_WIDTH - scrollLeft);
  }
  return width < STUB_MIN ? 0 : Math.round(width);
}

/** Whether content remains beyond either viewport edge (left: already scrolled past; right: not yet at the end). */
export interface EdgeOverflow {
  left: boolean;
  right: boolean;
}

/**
 * Scroll-layer mask split into **two horizontal bands** (per product revision: pills fade only at the actual boundary, alongside their station indicators):
 *   - Rail band (arc airspace + rail rows, height `railBand`): under a ledge, the ledge side stays fully opaque then fades over 40px—the ledge needs
 *     a clean background. On an overflowing side without a ledge, fade over 40px from the viewport edge so station headings are not abruptly cut off.
 *   - Pill band (remaining height): fade over 40px only at the viewport edge and only on a side with content beyond it. Pills do not fold with indicators
 *     (symmetric on both sides); they remain visible under the ledge through to the boundary.
 * Each mask layer occupies one band (no-repeat, separated by position/size); default add composition forms their union. No mask when neither side overflows.
 */
export function timelineMaskStyle(
  fold: TimelineFold,
  railBand: number,
  edges: EdgeOverflow,
): CSSProperties | undefined {
  if (!edges.left && !edges.right) return undefined;
  const edgeLeft = edges.left ? `transparent 0px, #000 ${LEDGE_FADE}px` : "#000 0px";
  const edgeRight = edges.right
    ? `#000 calc(100% - ${LEDGE_FADE}px), transparent 100%`
    : "#000 100%";
  const railLeft =
    fold.left.length > 0
      ? `transparent ${ledgeWidth(fold.left.length) + LEDGE_PAD}px, #000 ${ledgeWidth(fold.left.length) + LEDGE_PAD + LEDGE_FADE}px`
      : edgeLeft;
  const railRight =
    fold.right.length > 0
      ? `#000 calc(100% - ${ledgeWidth(fold.right.length) + LEDGE_PAD + LEDGE_FADE}px), transparent calc(100% - ${ledgeWidth(fold.right.length) + LEDGE_PAD}px)`
      : edgeRight;
  const image = `linear-gradient(90deg, ${railLeft}, ${railRight}), linear-gradient(90deg, ${edgeLeft}, ${edgeRight})`;
  const size = `100% ${railBand}px, 100% calc(100% - ${railBand}px)`;
  const position = `0 0, 0 ${railBand}px`;
  return {
    WebkitMaskImage: image,
    WebkitMaskPosition: position,
    WebkitMaskRepeat: "no-repeat, no-repeat",
    WebkitMaskSize: size,
    maskImage: image,
    maskPosition: position,
    maskRepeat: "no-repeat, no-repeat",
    maskSize: size,
  };
}

/** Scrollbar thumb: length = viewport² / content (minimum 24), positioned by scroll ratio; absent when there is no overflow. */
export function scrollbarThumb(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: number; width: number } | undefined {
  if (clientWidth <= 0 || scrollWidth <= clientWidth) return undefined;
  const width = Math.max(THUMB_MIN, (clientWidth * clientWidth) / scrollWidth);
  const range = scrollWidth - clientWidth;
  const left = ((clientWidth - width) * Math.min(Math.max(scrollLeft, 0), range)) / range;
  return { left: Math.round(left), width: Math.round(width) };
}

/**
 * One viewport flight: `scrollTo(target)` was issued but has not landed. Do not fold the index during flight.
 * `from` is the previously sampled scrollLeft—smooth scrolling moves monotonically toward the target, so a position farther away than the last sample means the user took control.
 */
export interface CameraFlight {
  index: number;
  /** Destination clamped to `scrollWidth − clientWidth`. */
  target: number;
  from: number;
}

/**
 * Whether a flight continues after one scroll sample: finish when it lands (within ±1px) or deviates (user took control); otherwise record the current position and keep flying.
 * Use scroll position only, not a timer—a user-interrupted smooth scroll never reaches its target, and a timer fallback would make the target station miss folding.
 */
export function flightAfterScroll(
  flight: CameraFlight | undefined,
  scrollLeft: number,
): CameraFlight | undefined {
  if (flight === undefined) return undefined;
  const distance = Math.abs(scrollLeft - flight.target);
  if (distance <= 1) return undefined;
  if (distance > Math.abs(flight.from - flight.target) + 1) return undefined;
  return scrollLeft === flight.from ? flight : { ...flight, from: scrollLeft };
}

/** Viewport: scroll a station to the center of the viewport (left edge never below 0). Used when an indicator on a ledge is clicked. */
export function stationCameraLeft(index: number, clientWidth: number, inset = 0): number {
  return Math.max(0, stationX(index, inset) - (clientWidth - STATION_WIDTH) / 2);
}

/**
 * Lookup key for a track segment: **a pair of stations**, not a start point. One station in a band may have several segments—a main-line segment,
 * a fork, and a double segment—so looking up only by start point would return whichever one sorted first.
 */
export function railKey(from: number, to: number): string {
  return `${from}>${to}`;
}
