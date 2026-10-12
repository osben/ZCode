import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/components/lib/utils.js";
import type { WorkflowTimelineModel } from "@/components/workflow-timeline/timeline-model.js";
import {
  fillDepthOf,
  fillMarksOf,
  framePath,
  spineFrameBox,
  type FrameBox,
} from "@/components/workflow-timeline/timeline-frames.js";
import {
  useFillHeadTarget,
  useFreshFills,
} from "@/components/workflow-timeline/WorkflowTimelineFills.js";

/**
 * Fill frames on the side pane (docs/dynamic-workflow/presentation.md "The pane"): the same frame as on
 * the card, drawn vertically — same ink, same radius, same stroke. The card's frames come from column
 * geometry; here section heights change with expand/collapse and list toggling, so vertical positions
 * are measured from the DOM: the top of the heading row (`data-fill-heading`) and the bottom of the
 * fill's last section (`data-phase-id`), relative to the list content (scroll included).
 * Measured after every commit, re-measured by a ResizeObserver when the list resizes; if the measured
 * values equal the previous ones, state is left untouched.
 *
 * Lighting only tracks heads (`useFillHeadTarget`, shared with the card): the heading row and the pen
 * mark carry `data-fill-head`. The pane does not indent (user revision: nesting is expressed by frames
 * within frames); each nesting level insets its frame by 4px.
 */
interface SpineFrameGeometry {
  width: number;
  height: number;
  boxes: Readonly<Record<string, FrameBox>>;
}

const EMPTY: SpineFrameGeometry = { width: 0, height: 0, boxes: {} };

function sectionOf(root: HTMLElement, attribute: string, value: string): HTMLElement | undefined {
  return [...root.querySelectorAll<HTMLElement>(`[${attribute}]`)].find(
    (element) => element.getAttribute(attribute) === value,
  );
}

export function useSpineFillFrames(
  rootRef: RefObject<HTMLDivElement | null>,
  model: WorkflowTimelineModel,
): {
  /** Delegation mounted on the list root (an empty object when there are no fills). */
  handlers: ReturnType<typeof useFillHeadTarget>["handlers"];
  /** The frame currently drawn (the head under the pointer or focus). */
  active: string | undefined;
  fresh: ReadonlySet<string>;
  frames: ReactNode;
} {
  const fills = model.fills ?? [];
  const marks = fillMarksOf(model.stations, fills);
  const parents = model.holeParents ?? {};
  const fresh = useFreshFills([...fills, ...marks]);
  const [geometry, setGeometry] = useState<SpineFrameGeometry>(EMPTY);
  const any = fills.length + marks.length > 0;

  const measure = () => {
    const root = rootRef.current;
    if (root === null || !any) return;
    const rootTop = root.getBoundingClientRect().top - root.scrollTop;
    const top = (element: HTMLElement) => element.getBoundingClientRect().top - rootTop;
    const bottom = (element: HTMLElement) => top(element) + element.getBoundingClientRect().height;
    const width = root.clientWidth;
    const boxes: Record<string, FrameBox> = {};
    for (const fill of fills) {
      const heading = sectionOf(root, "data-fill-heading", fill.holeId);
      const last = model.stations[fill.to];
      const section = last === undefined ? undefined : sectionOf(root, "data-phase-id", last.id);
      if (heading === undefined || section === undefined) continue;
      boxes[fill.holeId] = spineFrameBox({
        bottom: bottom(section),
        depth: fillDepthOf(fill.holeId, fills, parents),
        headed: true,
        top: top(heading),
        width,
      });
    }
    for (const mark of marks) {
      const station = model.stations[mark.index];
      const section =
        station === undefined ? undefined : sectionOf(root, "data-phase-id", station.id);
      if (section === undefined) continue;
      boxes[mark.holeId] = spineFrameBox({
        bottom: bottom(section),
        depth: fillDepthOf(mark.holeId, fills, parents),
        headed: false,
        top: top(section),
        width,
      });
    }
    const next: SpineFrameGeometry = { boxes, height: root.scrollHeight, width };
    setGeometry((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  };
  // The observer is created once but must always call the latest version of the measure function
  // (its closure holds this frame's fills and stations).
  const measureRef = useRef(measure);
  measureRef.current = measure;
  useLayoutEffect(() => measureRef.current());
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || !any || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => measureRef.current());
    observer.observe(root);
    // When sections expand/collapse the list's own box stays the same while content height changes:
    // observe every section too. The frame svg itself is not observed.
    for (const child of root.children) if (!(child instanceof SVGElement)) observer.observe(child);
    return () => observer.disconnect();
  }, [any, rootRef]);

  const { active, handlers } = useFillHeadTarget(any);
  if (!any) return { active: undefined, fresh, frames: null, handlers };

  const frames = (
    <svg
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      data-testid="workflow-run-fill-frames"
      height={geometry.height}
      width={geometry.width}
    >
      {[...fills, ...marks].map(({ holeId }) => {
        const box = geometry.boxes[holeId];
        const isFresh = fresh.has(holeId);
        return (
          <path
            className={cn("wf-fill-frame", isFresh && "wf-fill-frame-fresh")}
            d={box === undefined ? "" : framePath(box)}
            data-fill-frame={holeId}
            data-fill-fresh={isFresh ? "true" : undefined}
            data-fill-on={isFresh || active === holeId ? "true" : undefined}
            data-testid="workflow-run-fill-frame"
            key={holeId}
            pathLength={1}
          />
        );
      })}
    </svg>
  );
  return { active, fresh, frames, handlers };
}
