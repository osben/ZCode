// ============================================================
// Active duration of a dwf run (the completion card's time field)
// ============================================================
// Definition and rationale: see docs/dynamic-workflow/transcript-and-notifications.md, "How long it took":
// the completion card's duration is **the active duration of the full lineage**—every lifecycle of
// this run, plus every lifecycle of each predecessor reached through `resumedFrom`; gaps between
// lifecycles do not count.
//
// Defect history (2026-09-21): the duration used to be "the clock of whichever process settled the
// run" (the registry entry's `completedAt − startedAt`). Resume swaps in a new entry and amendment
// mints a new runId; both reset that clock to zero, and the amendment/resumed lifecycle is mostly
// cache replay—seconds. So a run that worked four hours and was amended once reported "12 seconds,"
// while the neighboring tokens field showed the full-lineage total (that field has counted by
// lineage since run creation; see execution-engine.md, "Usage across the lineage"). Both fields
// answer the same question and must use the same span.
//
// Duration needs no per-row accumulation like tokens: the event log already dates every lifecycle
// (`run-started` → the last event of that lifecycle), so this is a **read-only sum** with zero
// writes and zero migrations, and it holds equally for runs that predate the upgrade.

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
