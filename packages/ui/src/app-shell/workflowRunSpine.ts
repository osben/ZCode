import type {
  TimelineInk,
  WorkflowTimelineModel,
} from "@/components/workflow-timeline/timeline-model.js";

/**
 * Spine layout (docs/dynamic-workflow/presentation.md, “The spine”): translate the timeline model
 * into the vertical rails to draw for **each phase** and the **joint rows** between phases. This is
 * a pure function of indexes and pixels, with no React or DOM; renderers simply draw its output.
 *
 * Track t's vertical line is at `x = 21 + 12t`; a branch track in a band leaves the main track from 13px above the first segment via a fork curve, runs
 * vertically down, then returns to the main track with a mirrored curve at the merge segment's top (or at the last segment's bottom if there is no merge). The main track
 * still passes through branch segments, and its stroke is the main segment spanning that row — control flow really passes through there, even though that segment's node is off the main track.
 *
 * Branches and merges happen **between** stations, so each gets its own joint row (`SPINE_JOINT_PX`)
 * instead of being squeezed into an adjacent phase header: every band has a branch row before its
 * first phase and a merge row after its last phase. Previously, curves were drawn 13px above the
 * first phase, above the merge station, or below the band's **last** phase. A branch from the first
 * station then fell in from outside the list, while a merge at the final station appeared beneath
 * its pill and reconnected to a main rail that had already ended.
 *
 * For a band with no predecessor, the branch row is **open**: the main rail does not come from the
 * previous station; it starts 4px above the row with a rounded cap—a root. A band with no merge
 * station also has an open merge row, where the main rail ends 4px below the row—a sink (TAIL/STUB
 * on the card). Root cause (observed on device 2026-09-24): the first version drew joint rows only
 * when a predecessor/merge station existed, and strands started/ended at their own lamps. When the
 * workflow was one band with one station per strand (four phases running in pairs), each strand
 * had zero length and only four floating lamps remained on the spine. Open joint rows occupy their
 * own space without overlapping phase headers or pills, so always draw them.
 *
 * A strand's vertical rail runs from the bottom of its branch row to the top of its merge row. The
 * rail is still split by phase into upper/lower segments and `full` segments that cross a whole
 * phase; they expand and collapse with the phase, so no measurement is needed.
 */

/** Height of a joint row. */
export const SPINE_JOINT_PX = 16;
/** Center x-coordinate of the main vertical rail. */
export const SPINE_TRACK_X = 21;
/** Branch rails use a 12px pitch up to this count, then compress to 8px. */
const WIDE_PITCH_BRANCHES = 4;

/** A vertical track segment. `from` / `to` override the default start/end (px from the segment top / bottom) only when making room for a curve. */
export interface SpineRailPiece {
  track: number;
  ink: TimelineInk;
  position: "above" | "below" | "full";
  stream?: true;
}

/** A joint row: the main rail passes straight through (using the ink of the main-line segment crossing it), with one curve per branch. */
export interface SpineJoint {
  main: TimelineInk;
  branches: { track: number; ink: TimelineInk }[];
  /** Open row: a branch row has no predecessor (root), or a merge row has no merge station (sink); the main rail extends only a short stub outside the row. */
  open?: true;
}

export interface SpineSection {
  rails: SpineRailPiece[];
  /** Branch row attached **before** this phase (the first phase in a band). */
  fork?: SpineJoint;
  /** Merge row attached **after** this phase (the last phase in a band). */
  merge?: SpineJoint;
}

export interface SpineLayout {
  /** Spacing between adjacent rails. */
  pitch: number;
  /** Extra width reserved for the text column when bands exist: `pitch·(T − 1)`; 0 when there are none. */
  gutter: number;
  sections: SpineSection[];
}

export function spineLayout(model: WorkflowTimelineModel): SpineLayout {
  const { bands, rails, stations } = model;
  const widest = Math.max(1, ...bands.map((band) => band.tracks.length));
  const pitch = widest - 1 <= WIDE_PITCH_BRANCHES ? 12 : 8;
  const bandAt = (i: number) => bands.find((band) => band.from <= i && i <= band.to);
  // A double segment only says “these two stations run in parallel,” so draw no spine. Branch/merge
  // segments are drawn by joint rows, not inside phases either. Stream rails use the same two-half
  // rendering as regular segments, with one additional gap.
  const plain = rails.filter((rail) => rail.kind === undefined || rail.kind === "stream");
  const railOf = (from: number, to: number) =>
    plain.find((rail) => rail.from === from && rail.to === to);
  const plainInk = (from: number, to: number): TimelineInk => railOf(from, to)?.ink ?? "faint";
  const streamMark = (from: number, to: number) =>
    railOf(from, to)?.kind === "stream" ? { stream: true as const } : {};

  const sections: SpineSection[] = stations.map((_, i) => {
    const band = bandAt(i);
    if (band === undefined) {
      // Stations outside bands keep the existing behavior: draw the previous station's lower half
      // and the next station's upper half; leave gaps when there is no adjacent edge. The main
      // branch/merge rail (with no kind) connects here as usual; branch rails belong to joint rows.
      const pieces: SpineRailPiece[] = [];
      const above = plain.find((rail) => rail.to === i);
      const below = plain.find((rail) => rail.from === i);
      if (above !== undefined)
        pieces.push({ ink: above.ink, position: "above", ...streamMark(above.from, i), track: 0 });
      if (below !== undefined)
        pieces.push({ ink: below.ink, position: "below", ...streamMark(i, below.to), track: 0 });
      return { rails: pieces };
    }
    const pieces: SpineRailPiece[] = [];
    band.tracks.forEach((track, t) => {
      const members = track.stations;
      const at = members.indexOf(i);
      if (at >= 0) {
        // This strand's rail: the upper half connects to the previous member or branch row; the lower half connects to the next member or merge row.
        const previous = members[at - 1];
        const next = members[at + 1];
        pieces.push({
          ink: previous === undefined ? track.entry : plainInk(previous, i),
          position: "above",
          ...(previous === undefined ? {} : streamMark(previous, i)),
          track: t,
        });
        pieces.push({
          ink: next === undefined ? track.exit : plainInk(i, next),
          position: "below",
          ...(next === undefined ? {} : streamMark(i, next)),
          track: t,
        });
        return;
      }
      // Another rail crosses this entire phase: use incoming ink before its first member, outgoing
      // ink after its last member, and the segment's ink between them. This also applies to the main
      // rail passing through a branch station.
      const before = members.filter((member) => member < i).pop();
      const after = members.find((member) => member > i);
      const ink =
        before === undefined
          ? track.entry
          : after === undefined
            ? track.exit
            : plainInk(before, after);
      pieces.push({ ink, position: "full", track: t });
    });
    return { rails: pieces };
  });

  for (const band of bands) {
    const main = band.tracks[0]!;
    const branches = (end: "entry" | "exit") =>
      band.tracks.slice(1).map((track, k) => ({ ink: track[end], track: k + 1 }));
    sections[band.from]!.fork = {
      branches: branches("entry"),
      main: main.entry,
      ...(band.pred === undefined ? { open: true as const } : {}),
    };
    sections[band.to]!.merge = {
      branches: branches("exit"),
      main: main.exit,
      ...(band.join === undefined ? { open: true as const } : {}),
    };
  }
  return { gutter: pitch * (widest - 1), pitch, sections };
}
