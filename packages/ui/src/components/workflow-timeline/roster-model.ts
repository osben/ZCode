import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { TimelinePill, TimelineStation } from "./timeline-model.js";

/**
 * Phase roster: when a station has more participants than the threshold, replace its row of pills
 * with "pinned pills + the rest." This performs only the pure partition—who is pinned, who remains, and counts by status—
 * using the same rule in four places: cards, timeline tail summary, confirmation dialog, and side pane (invariant 1).
 * A card folds "the rest" into one "N more" row (see "Five pills and a door," `rosterMore`); the side pane treats that row as a door
 * to a status-grouped list (see "A door and a scroll," `rosterRoll`).
 *
 * Subagents omitted from the visible roster (`station.unlisted`) have no pills, but still count toward the threshold, total,
 * status counts, and "N more" row: station totals must not shrink when subagents are omitted; only the visible rows decrease.
 */

/** Keep a pill row up to this many participants (six pills = 222 px, already taller than the roster). */
export const ROSTER_THRESHOLD = 6;
/** Number of pills pinned on a card: five plus one "N more" row = the height of six pills. */
export const ROSTER_PINS_CARD = 5;
/** Number of pills pinned in the side pane (fill a column while leaving room to show more names). */
export const ROSTER_PINS_PANE = 5;
/** Number of faces stacked in the "N more" row. */
export const ROSTER_DECK = 3;

export type RosterCounts = Record<StepRunStatus, number>;

/**
 * Omitted participants (`station.unlisted`): subagents folded out of the visible roster; they have no pills, faces, or rows.
 * The roster only **counts** them—station totals must not shrink when subagents are omitted. `settled` contains those known to have finished,
 * with `failed ⊆ settled`; the remaining `actors − settled` are still running.
 */
export interface RosterUnlisted {
  actors: number;
  settled: number;
  failed: number;
}

const NO_UNLISTED: RosterUnlisted = { actors: 0, failed: 0, settled: 0 };

export interface StationRoster {
  /** Pinned pills: asking → running → failed → fill remaining slots in participant order; slots are never left empty. */
  pinned: TimelinePill[];
  /** Remaining participants (not pinned), in participant order. Omitted participants are excluded because they have no pills. */
  rest: TimelinePill[];
  /** Counts by status for all participants, including pinned and omitted ones; static pills count as pending. */
  counts: RosterCounts;
  /** Omitted participants; zero when none are omitted. */
  unlisted: RosterUnlisted;
  total: number;
}

/** Static (no run) looks identical to pending and is grouped with it for counts. */
export function pillStatusOf(pill: Pick<TimelinePill, "status">): StepRunStatus {
  return pill.status ?? "pending";
}

/** Instance key (`siteId@ordinal`): pending questions use it to attach to their asker; synthetic lanes do not have one. */
export function pillInstanceKey(pill: Pick<TimelinePill, "instance">): string | undefined {
  return pill.instance === undefined
    ? undefined
    : `${pill.instance.siteId}@${pill.instance.ordinal}`;
}

export function rosterCounts(pills: readonly TimelinePill[]): RosterCounts {
  const counts: RosterCounts = { done: 0, failed: 0, pending: 0, running: 0 };
  for (const pill of pills) counts[pillStatusOf(pill)] += 1;
  return counts;
}

/**
 * Add omitted participants to the counts: only those in `settled` have an outcome (failed ones count as failed, the rest as done);
 * the rest have not finished and count as pending. Subagents rejected at creation or removed while queued are still in `actors`—
 * counting them as done would be the one false statement the UI must not make. The count row and station totals share this rule and always agree.
 */
function addUnlisted(counts: RosterCounts, unlisted: RosterUnlisted): RosterCounts {
  counts.done += unlisted.settled - unlisted.failed;
  counts.failed += unlisted.failed;
  counts.pending += Math.max(0, unlisted.actors - unlisted.settled);
  return counts;
}

/** Attention order: show the most important faces first in the "N more" stack; order list groups the same way. */
export const ATTENTION_ORDER: readonly StepRunStatus[] = ["failed", "running", "pending", "done"];
const ATTENTION_RANK: Record<StepRunStatus, number> = {
  failed: 0,
  running: 1,
  pending: 2,
  done: 3,
};

/** Stable attention ordering: preserve participant order within each status tier. */
function byAttention(pills: readonly TimelinePill[]): TimelinePill[] {
  return pills
    .map((pill, index) => ({ index, pill }))
    .sort(
      (left, right) =>
        ATTENTION_RANK[pillStatusOf(left.pill)] - ATTENTION_RANK[pillStatusOf(right.pill)] ||
        left.index - right.index,
    )
    .map((entry) => entry.pill);
}

/**
 * Pinning order is asking → running → failed → participant order. Running participants have no cap, so any number of them can fill the pinned slots.
 * Preserve participant order within each tier, so a running slot opens only when that participant stops—one slot changes at a time, not the whole column.
 * A completed run has no asking or running pills, so this naturally reduces to failed → participant order without a separate liveness input.
 */
export function stationRoster(
  pills: readonly TimelinePill[],
  options: { pins: number; unlisted?: RosterUnlisted },
): StationRoster | undefined {
  const unlisted = options.unlisted ?? NO_UNLISTED;
  // Apply the threshold to **visible + omitted** participants: four visible pills and 300 omitted participants are still a roster.
  // Otherwise, once the row disappears, those 300 subagents vanish from the screen entirely.
  const total = pills.length + unlisted.actors;
  if (total <= ROSTER_THRESHOLD) return undefined;
  const counts = addUnlisted(rosterCounts(pills), unlisted);

  const pinned: TimelinePill[] = [];
  const pin = (pill: TimelinePill) => {
    if (pinned.length < options.pins && !pinned.includes(pill)) pinned.push(pill);
  };
  for (const pill of pills) if (pill.asking === true) pin(pill);
  for (const pill of pills) if (pillStatusOf(pill) === "running") pin(pill);
  for (const pill of pills) if (pillStatusOf(pill) === "failed") pin(pill);
  for (const pill of pills) pin(pill);

  const rest = pills.filter((pill) => !pinned.includes(pill));
  return { counts, pinned, rest, total, unlisted };
}

/**
 * Roster for one station: read omitted participants from the station (`station.unlisted`) so cards and the side pane use the same value;
 * neither has to inspect `run.unlistedByPhase` independently.
 */
export function stationRosterOf(
  station: Pick<TimelineStation, "pills" | "unlisted">,
  pins: number,
): StationRoster | undefined {
  return stationRoster(station.pills, {
    pins,
    // `nodesSettled` on the station is about nodes, while the roster counts people; use it only in the fraction, not here.
    ...(station.unlisted === undefined
      ? {}
      : {
          unlisted: {
            actors: station.unlisted.actors,
            failed: station.unlisted.failed,
            settled: station.unlisted.settled,
          },
        }),
  });
}

/** Count row when the door is closed: everything behind it—the remaining visible participants plus omitted ones without pills. */
export function rosterRestCounts(roster: StationRoster): RosterCounts {
  return addUnlisted(rosterCounts(roster.rest), roster.unlisted);
}

/** Content for the card’s “n more” row (see the “Five pills and a door” note). */
export interface RosterMore {
  /** Number of unpinned participants, including omitted ones, which are also behind this row. */
  count: number;
  /** Stacked faces: the first few remaining participants in attention order (failed → running → pending → done). Omitted participants have no faces. */
  deck: TimelinePill[];
  /** Number of failed participants behind this row (excluding pinned ones and including omitted failures)—the only status shown on this card row. */
  failed: number;
}

export function rosterMore(roster: StationRoster, deck: number = ROSTER_DECK): RosterMore {
  const pinnedFailed = roster.pinned.filter((pill) => pillStatusOf(pill) === "failed").length;
  return {
    count: roster.rest.length + roster.unlisted.actors,
    deck: byAttention(roster.rest).slice(0, deck),
    // `counts.failed` already includes omitted failures; subtract the pinned ones to get the number still hidden behind this row.
    failed: roster.counts.failed - pinnedFailed,
  };
}

/** One group in the side-pane list: remaining participants with the same status, in participant order. */
export interface RollGroup {
  status: StepRunStatus;
  pills: TimelinePill[];
}

/** List behind the door: group remaining participants by status in attention order; omit empty groups. */
export function rosterRoll(roster: StationRoster): RollGroup[] {
  return ATTENTION_ORDER.map((status) => ({
    pills: roster.rest.filter((pill) => pillStatusOf(pill) === status),
    status,
  })).filter((group) => group.pills.length > 0);
}
