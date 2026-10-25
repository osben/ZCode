import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
} from "react";
import { cn } from "@/components/lib/utils.js";

const overflowFadeClassName =
  "[mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,black_calc(100%_-_1.5rem),transparent)]";
const marqueeGapPx = 24;
const marqueePixelsPerSecond = 40;
const minimumMarqueeDurationSeconds = 6;
const marqueePauseSeconds = 2;
const marqueeHoverDelayMs = 1_000;
const marqueeMaskFadeInSeconds = 0.15;
const rightFadeMask =
  "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)";
const bothEdgesFadeMask =
  "linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)";

function createMaskKeyframe(maskImage: string, offset: number): Keyframe {
  return { maskImage, offset, webkitMaskImage: maskImage };
}

type TaskTitleOverflowTextProps = ComponentPropsWithoutRef<"p"> & {
  as?: "p" | "span";
};

export function TaskTitleOverflowText({
  as = "p",
  children,
  className,
  // Native title tooltips obscure task names while the marquee is scrolling on hover.
  // Consume this prop at the component boundary so individual task rows cannot omit it and reintroduce the tooltip.
  title: _nativeTitle,
  ...props
}: TaskTitleOverflowTextProps) {
  const Component = as as ElementType;
  const textRef = useRef<HTMLElement | null>(null);
  const originalTextRef = useRef<HTMLSpanElement | null>(null);
  const marqueeTrackRef = useRef<HTMLSpanElement | null>(null);
  const [overflowState, setOverflowState] = useState({
    distance: 0,
    duration: minimumMarqueeDurationSeconds,
    isOverflowing: false,
  });
  const { distance, duration, isOverflowing } = overflowState;

  useEffect(() => {
    const textElement = textRef.current;
    const originalTextElement = originalTextRef.current;
    if (!textElement || !originalTextElement) return;

    const updateOverflow = () => {
      // The title used to always have a mask, giving fully visible short titles a fade effect too.
      // Use the actual layout width of a single title to avoid the marquee duplicate inflating scrollWidth and preventing overflow state from clearing.
      const contentWidth = originalTextElement.scrollWidth;
      const nextIsOverflowing = contentWidth > textElement.clientWidth;
      const nextDistance = nextIsOverflowing ? contentWidth + marqueeGapPx : 0;
      const nextDuration = nextIsOverflowing
        ? Math.max(minimumMarqueeDurationSeconds, nextDistance / marqueePixelsPerSecond)
        : minimumMarqueeDurationSeconds;
      setOverflowState((current) =>
        current.isOverflowing === nextIsOverflowing &&
        current.distance === nextDistance &&
        current.duration === nextDuration
          ? current
          : {
              distance: nextDistance,
              duration: nextDuration,
              isOverflowing: nextIsOverflowing,
            },
      );
    };

    updateOverflow();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateOverflow);
      return () => window.removeEventListener("resize", updateOverflow);
    }

    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(textElement);
    resizeObserver.observe(originalTextElement);
    return () => resizeObserver.disconnect();
  }, [children]);

  useEffect(() => {
    const textElement = textRef.current;
    const marqueeTrack = marqueeTrackRef.current;
    if (
      !isOverflowing ||
      !textElement ||
      !marqueeTrack ||
      typeof marqueeTrack.animate !== "function"
    ) {
      return;
    }

    const reducedMotionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    // Marquee events used to be bound to the text node, so hovering over the task item's time,
    // status, or action area would not scroll the title. Bind to the nearest regular or grouped task-row boundary instead.
    const hoverTarget =
      textElement.closest<HTMLElement>("[data-task-item-key], [data-grouped-task-key]") ??
      textElement;
    let animations: Animation[] = [];
    let startTimer: number | null = null;

    const stopMarquee = () => {
      if (startTimer !== null) {
        window.clearTimeout(startTimer);
        startTimer = null;
      }
      animations.forEach((animation) => animation.cancel());
      animations = [];
    };
    const startMarquee = () => {
      if (reducedMotionQuery?.matches) return;

      stopMarquee();
      const totalDuration = duration + marqueePauseSeconds;
      // A pure CSS infinite animation can pause only by percentage and cannot guarantee a fixed 2-second wait
      // after duplicate headings align when title width changes. Web Animation uses dynamic offsets to separate travel and pause durations.
      const movementEndOffset = duration / totalDuration;
      const maskFadeInEndOffset = marqueeMaskFadeInSeconds / totalDuration;
      // Continuing the left mask fade across the 24px gap leaves an empty gradient after the main title exits.
      // Switch directly to a right-only mask when the main title's tail reaches the left edge.
      const originalTailArrivalTime = duration * ((distance - marqueeGapPx) / distance);
      const originalTailArrivalOffset = originalTailArrivalTime / totalDuration;
      const animationOptions: KeyframeAnimationOptions = {
        duration: totalDuration * 1_000,
        easing: "linear",
        iterations: Infinity,
      };
      const trackAnimation = marqueeTrack.animate(
        [
          { offset: 0, transform: "translate3d(0, 0, 0)" },
          {
            offset: movementEndOffset,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
          {
            offset: 1,
            transform: `translate3d(-${distance}px, 0, 0)`,
          },
        ],
        animationOptions,
      );
      // Keeping masks on both sides throughout the scroll leaves the title's beginning hard to read during the 2-second pause after alignment.
      // Share the movement animation's duration with the mask, fading out the left side before arrival and keeping it that way until the next cycle.
      const maskAnimation = textElement.animate(
        [
          createMaskKeyframe(rightFadeMask, 0),
          createMaskKeyframe(bothEdgesFadeMask, maskFadeInEndOffset),
          createMaskKeyframe(bothEdgesFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, originalTailArrivalOffset),
          createMaskKeyframe(rightFadeMask, 1),
        ],
        animationOptions,
      );
      animations = [trackAnimation, maskAnimation];
    };
    const scheduleMarquee = () => {
      if (reducedMotionQuery?.matches) return;
      stopMarquee();
      // Interaction rule: briefly passing over a task row should not start motion; begin only after hovering for a full second.
      startTimer = window.setTimeout(() => {
        startTimer = null;
        startMarquee();
      }, marqueeHoverDelayMs);
    };
    const handleMotionPreferenceChange = (event: MediaQueryListEvent) => {
      if (event.matches) stopMarquee();
    };

    hoverTarget.addEventListener("mouseenter", scheduleMarquee);
    hoverTarget.addEventListener("mouseleave", stopMarquee);
    reducedMotionQuery?.addEventListener("change", handleMotionPreferenceChange);

    return () => {
      hoverTarget.removeEventListener("mouseenter", scheduleMarquee);
      hoverTarget.removeEventListener("mouseleave", stopMarquee);
      reducedMotionQuery?.removeEventListener("change", handleMotionPreferenceChange);
      stopMarquee();
    };
  }, [distance, duration, isOverflowing]);

  return (
    <Component
      ref={textRef}
      className={cn(
        "min-w-0 flex-1 overflow-hidden whitespace-nowrap",
        isOverflowing && overflowFadeClassName,
        isOverflowing && "task-title-marquee",
        className,
      )}
      {...props}
    >
      <span
        ref={marqueeTrackRef}
        data-task-title-marquee-track="true"
        className="task-title-marquee-track inline-flex w-max min-w-max items-center gap-6"
      >
        <span ref={originalTextRef} data-task-title-copy="original" className="shrink-0">
          {children}
        </span>
        {isOverflowing ? (
          <span aria-hidden="true" data-task-title-copy="duplicate" className="shrink-0">
            {children}
          </span>
        ) : null}
      </span>
    </Component>
  );
}
