// Active duration of a dwf run, used for the completion card's time field.
// Sum the active intervals for each launch of this run and each predecessor reached through `resumedFrom`;
// do not count gaps after stopping or process exit and before the next resume.
//
// Do not use only the current registry entry's `completedAt - startedAt`: resume or amendment resets that clock
// and would omit earlier runtime. Duration and token usage should cover the full lineage.
//
// The event log already records each interval's start and last activity time, so read and sum them without extra persistence.

import type { JournalStorePort } from "@zcode/dynamic-workflow";
import { supportsRunLifeSpans } from "./dynamic-workflow-run-journal.js";

/**
 * Maximum number of hops when traversing lineage. Each amendment adds one hop and chains are typically single digits; the limit guards against
 * `resumedFrom` being externally written into an arbitrarily long chain—a duration read for one run should not scan an unlimited number of rows.
 */
const LINEAGE_HOP_LIMIT = 64;

/**
 * Active duration in milliseconds for this run and its lineage, or `undefined` if there is no evidence from any lifecycle.
 *
 * `undefined` and `0` are different: the former means "the journal has no answer" (read surface unavailable, events predate this tracking,
 * or rows were cleaned up), so the caller falls back to the lifecycle it observed; the latter means a lifecycle exists but lasted less than 1 ms.
 *
 * Cycle prevention is not decorative defensive programming: `resumedFrom` is fixed when a run is created and should not form a cycle, but this
 * loop's termination depends on **database data**, not process logic. An externally written self-referential row could make a snapshot read loop forever,
 * and snapshot reads run on the background tracker's polling path.
 */
export function runLineageActiveMs(journal: JournalStorePort, runId: string): number | undefined {
  if (!supportsRunLifeSpans(journal)) return undefined;
  let total = 0;
  let sawLife = false;
  let cursor: string | undefined = runId;
  const visited = new Set<string>();
  for (let hop = 0; cursor !== undefined && hop < LINEAGE_HOP_LIMIT; hop += 1) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    for (const life of journal.listRunLifeSpans(cursor)) {
      sawLife = true;
      // Clamp to zero or above: both timestamps come from `dwf_event.time_created`, which is **wall-clock** time; a system clock adjustment can
      // make the "last" time earlier than the "first." A negative duration would subtract real time from another lifecycle, worse than dropping this one.
      total += Math.max(0, life.lastActivityAt - life.startedAt);
    }
    // Traverse lineage upward only, not down through supersededBy: an amendment is the next version of the same work, so the superseded predecessor's active
    // time underlies this version. Later successors are unrelated to this run's duration (they have their own cards).
    cursor = journal.getRun(cursor)?.resumedFrom;
  }
  return sawLife ? total : undefined;
}
