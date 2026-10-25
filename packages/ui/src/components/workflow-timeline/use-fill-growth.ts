import { useEffect, useState, type CSSProperties } from "react";
import { STATION_PITCH } from "./timeline-geometry.js";
import type { WorkflowTimelineModel } from "./timeline-model.js";

/**
 * Fill growth (docs/dynamic-workflow/presentation.md "Holes on the timeline", section "Growth"): when
 * a fill joins the run, stations to the right of the insertion slide open by the inserted width — a
 * 320ms transform that lands on the new position when it finishes (the new position is the layout
 * position; the animation merely starts from −width). The new stations' own `wf-land` / `wf-rail-grow`
 * landing and the region's two fresh seconds happen elsewhere.
 *
 * The model has neither time nor history, so "how many stations were inserted" is derived by the
 * component comparing consecutive frames: a new fill head plus a station-count increase. The first
 * frame has no previous frame, so cold-opening an already-filled timeline does not slide. The camera
 * does not move: the fill's first station shares the hole's index and x, so an unchanged `scrollLeft`
 * means "the camera stays on the waiting station's x". Under reduced-motion the `.wf-slide` animation
 * is none and the new row appears directly.
 */
export const SLIDE_MS = 320;

export interface FillSlide {
  /** Stations with a greater index slide. */
  after: number;
  /** The inserted width (px): stations slide from −shift to 0. */
  shift: number;
  /** A new key per growth so two consecutive growths each play once. */
  key: number;
}

interface SeenShape {
  key: string;
  stations: number;
  fills: readonly string[];
}

function shapeOf(model: WorkflowTimelineModel): SeenShape {
  const fills = (model.fills ?? []).map((fill) => fill.holeId);
  return {
    key: `${model.stations.map((station) => station.id).join("\u0000")}\u0001${fills.join("\u0000")}`,
    stations: model.stations.length,
    fills,
  };
}

/** What grew from the previous frame to this one: a new fill head plus an increased station count. */
export function fillGrowth(
  previous: Pick<SeenShape, "stations" | "fills">,
  model: WorkflowTimelineModel,
): Pick<FillSlide, "after" | "shift"> | undefined {
  const grown = (model.fills ?? []).filter((fill) => !previous.fills.includes(fill.holeId));
  const delta = model.stations.length - previous.stations;
  if (grown.length === 0 || delta <= 0) return undefined;
  return { after: Math.max(...grown.map((fill) => fill.to)), shift: delta * STATION_PITCH };
}

export function useFillGrowth(model: WorkflowTimelineModel): FillSlide | undefined {
  const shape = shapeOf(model);
  const [seen, setSeen] = useState(shape);
  const [slide, setSlide] = useState<FillSlide | undefined>(undefined);
  // Derived during render (React's "derive state from props" pattern): when the shape differs from
  // the previous frame, record this frame in place; on growth, start one slide.
  if (seen.key !== shape.key) {
    const growth = fillGrowth(seen, model);
    setSeen(shape);
    if (growth !== undefined) setSlide((current) => ({ ...growth, key: (current?.key ?? 0) + 1 }));
  }
  // Remove the class once the animation ends (or never played under reduced-motion), so remounted stations do not replay it.
  useEffect(() => {
    if (slide === undefined) return undefined;
    const timer = setTimeout(() => setSlide(undefined), SLIDE_MS);
    return () => clearTimeout(timer);
  }, [slide]);
  return slide;
}

export function slideClass(index: number, slide: FillSlide | undefined): string | undefined {
  return slide !== undefined && index > slide.after ? "wf-slide" : undefined;
}

export function slideStyle(index: number, slide: FillSlide | undefined): CSSProperties {
  return slide !== undefined && index > slide.after
    ? ({ "--wf-slide": `${-slide.shift}px` } as CSSProperties)
    : {};
}
