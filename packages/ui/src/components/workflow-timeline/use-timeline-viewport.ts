import { useEffect, useLayoutEffect, useState } from "react";

/**
 * Three scroll-viewport values (scrollLeft / clientWidth / scrollWidth) and a "currently scrolling" marker.
 * Coalesce scroll events per frame; observe size changes with ResizeObserver on both the container and content layer
 * (draft content width changes as the typewriter reveals each station). jsdom reports width 0, so consumers collapse nothing and static tests remain pixel-identical.
 *
 * Depend on the **element** rather than the ref object: drafts have no stations on the first frame and the scroll layer mounts one frame later.
 * An effect depending on the ref object would see null on the first frame and return permanently, never attaching listeners; the viewport would retain
 * one stale measurement from a resize and permanently fold the latest station onto the right ledge. The consumer passes the element through state via callback ref: attach when present, detach when removed.
 *
 * Reuse the object when measured values have not changed. ResizeObserver and scroll callbacks used to create a new object each time,
 * causing an unnecessary timeline render; during an empty-draft spin, those redundant updates also counted toward React's nested-update limit.
 */
export interface TimelineViewport {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
  /** Scrolled within the last 800ms (used to reveal the scrollbar). */
  scrolling: boolean;
}

const SCROLLING_MS = 800;
const EMPTY: TimelineViewport = { clientWidth: 0, scrollLeft: 0, scrollWidth: 0, scrolling: false };

function measure(element: HTMLElement): Omit<TimelineViewport, "scrolling"> {
  return {
    clientWidth: element.clientWidth,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
  };
}

/** Merge a measurement into the previous viewport; return the previous object if all three values and scrolling are unchanged so React can skip rendering. */
function merge(
  previous: TimelineViewport,
  measured: Omit<TimelineViewport, "scrolling">,
  scrolling = previous.scrolling,
): TimelineViewport {
  return previous.clientWidth === measured.clientWidth &&
    previous.scrollLeft === measured.scrollLeft &&
    previous.scrollWidth === measured.scrollWidth &&
    previous.scrolling === scrolling
    ? previous
    : { ...measured, scrolling };
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useTimelineViewport(
  /** Scroll-layer element; null before mount (first draft frame) or after unmount. */
  element: HTMLElement | null,
  /** Handle for content changes (station count/width); remeasure when it changes. */
  contentKey: number,
): TimelineViewport {
  const [viewport, setViewport] = useState<TimelineViewport>(EMPTY);

  useIsomorphicLayoutEffect(() => {
    if (element === null) return;
    setViewport((previous) => merge(previous, measure(element)));
  }, [element, contentKey]);

  useEffect(() => {
    if (element === null) return;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        setViewport((previous) => merge(previous, measure(element), true));
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          setViewport((previous) =>
            previous.scrolling ? { ...previous, scrolling: false } : previous,
          );
        }, SCROLLING_MS);
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        setViewport((previous) => merge(previous, measure(element)));
      });
      observer.observe(element);
      const content = element.firstElementChild;
      if (content !== null) observer.observe(content);
    }
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
    };
  }, [element]);

  return viewport;
}
