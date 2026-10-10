import type {
  TimelineInk,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";

/**
 * Spine layout: translate the timeline model into the vertical tracks and curves to draw for **each segment**.
 * Pure function using only indexes and pixel offsets; no React or DOM — renderers can draw directly from its output.
 *
 * Track t's vertical line is at `x = 21 + 12t`; a branch track in a band leaves the main track from 13px above the first segment via a fork curve, runs
 * vertically down, then returns to the main track with a mirrored curve at the merge segment's top (or at the last segment's bottom if there is no merge). The main track
 * still passes through branch segments, and its stroke is the main segment spanning that row — control flow really passes through there, even though that segment's node is off the main track.
 *
 * Look up track segments only as **pairs** (`from → to`), not by `from` index: a band segment can be the left endpoint of both a branch and a main-track segment,
 * so `from` is no longer unique.
 */

/** Height occupied by a fork / merge curve. */
const SPINE_CURVE_PX = 13;

/** A vertical track segment. `from` / `to` override the default start/end (px from the segment top / bottom) only when making room for a curve. */
export interface SpineRailPiece {
  track: number;
  ink: TimelineInk;
  /** `above` = segment top to node, `below` = node to segment bottom, `full` = through the entire segment. */
  position: "above" | "below" | "full";
  from?: number;
  to?: number;
}

/** The 13px where the branch track leaves / returns to the main track. */
export interface SpineCurvePiece {
  kind: "fork" | "merge";
  track: number;
  ink: TimelineInk;
  /** Attach to the segment top or bottom (without a merge node, the merge is drawn at the bottom of the band's last segment). */
  at: "top" | "bottom";
}

export interface SpineSection {
  rails: SpineRailPiece[];
  curves: SpineCurvePiece[];
}

export function spineSections(model: WorkflowTimelineModel): SpineSection[] {
  const sections: SpineSection[] = model.stations.map(() => ({ curves: [], rails: [] }));
  const trackAt = (i: number): number => model.stations[i]?.track ?? 0;
  const plain = model.rails.filter((rail) => rail.kind === undefined);
  /** Horizontal track spanning segment i with both ends on track t (used by the main track through a branch node and by a branch track through another node). */
  const spanning = (i: number, track: number): TimelineInk | undefined =>
    plain.find(
      (rail) =>
        rail.from < i && i < rail.to && trackAt(rail.from) === track && trackAt(rail.to) === track,
    )?.ink;
  const pairInk = (from: number, to: number): TimelineInk =>
    plain.find((rail) => rail.from === from && rail.to === to)?.ink ?? "faint";

  model.stations.forEach((station, i) => {
    const section = sections[i]!;
    const band =
      station.track === 0 ? undefined : model.bands.find((b) => b.from <= i && i <= b.to);
    const track = band?.tracks[station.track];
    if (track === undefined) {
      // Main-track node: as before, draw the lower half from the previous node and the upper half toward the next; leave empty when there is no adjacent edge.
      const above = model.rails.find(
        (rail) => rail.to === i && rail.kind !== "twin" && rail.kind !== "merge",
      );
      const below = model.rails.find(
        (rail) => rail.from === i && rail.kind !== "twin" && rail.kind !== "fork",
      );
      if (above !== undefined) section.rails.push({ ink: above.ink, position: "above", track: 0 });
      if (below !== undefined) section.rails.push({ ink: below.ink, position: "below", track: 0 });
      return;
    }
    // Branch node: the upper/lower halves use its own track; the outer endpoints use the entering/exiting strokes (the fork / merge segments).
    const at = track.stations.indexOf(i);
    const previous = track.stations[at - 1];
    const next = track.stations[at + 1];
    section.rails.push({
      ink: previous === undefined ? track.entry : pairInk(previous, i),
      position: "above",
      track: station.track,
    });
    section.rails.push({
      ink: next === undefined ? track.exit : pairInk(i, next),
      position: "below",
      track: station.track,
    });
    const main = spanning(i, 0);
    if (main !== undefined) section.rails.push({ ink: main, position: "full", track: 0 });
  });

  for (const band of model.bands) {
    band.tracks.forEach((track, t) => {
      if (t === 0) return;
      const end = band.join ?? band.to;
      const first = track.stations[0]!;
      const last = track.stations[track.stations.length - 1]!;
      // Without a merge node, the merge is drawn at the bottom of the last band segment, so shorten that segment's vertical track by 13px.
      const tail = band.join === undefined ? SPINE_CURVE_PX : undefined;
      sections[band.from]?.curves.push({ at: "top", ink: track.entry, kind: "fork", track: t });
      sections[end]?.curves.push({
        at: tail === undefined ? "top" : "bottom",
        ink: track.exit,
        kind: "merge",
        track: t,
      });
      for (let i = band.from; i <= end; i += 1) {
        const section = sections[i];
        if (section === undefined) continue;
        if (track.stations.includes(i)) {
          if (tail !== undefined && i === end) {
            for (const rail of section.rails) {
              if (rail.track === t && rail.position === "below") rail.to = tail;
            }
          }
          continue;
        }
        // When there is a merge node, a curve occupies the top of that segment, so no vertical section passes through it.
        if (i === end && tail === undefined) continue;
        const ink =
          i < first ? track.entry : i > last ? track.exit : (spanning(i, t) ?? track.exit);
        section.rails.push({
          ink,
          position: "full",
          track: t,
          ...(i === band.from ? { from: SPINE_CURVE_PX } : {}),
          ...(tail !== undefined && i === end ? { to: tail } : {}),
        });
      }
    });
  }
  return sections;
}
