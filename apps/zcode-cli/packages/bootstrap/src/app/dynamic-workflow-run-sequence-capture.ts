// Journal-sequence capture layer for engine events. It is separate from launch.ts: that module
// assembles and starts a run, while this one captures the number assigned by appendEvent for the immediately following emit. These are separate responsibilities, and this one has a single consumer.
import type { JournalStorePort, RunEvent, StoredEvent } from "@zcode/dynamic-workflow";

/**
 * Wrap the journal only to capture the sequence assigned by `appendEvent` for the immediately following emit.
 *
 * Assumption (guaranteed by the engine's `record()` and pinned by tests): each event is emitted
 * synchronously immediately after appendEvent, one-to-one. Thus the "sequence from the last append"
 * is the sequence for the event currently being emitted. For safety, verify **reference equality** on
 * the event object. If it differs, the assumption broke; fall back to the last sequence rather than
 * guessing. A silently wrong sequence is harder to diagnose than a stalled one, and tests should catch this first.
 */
export function createJournalSequenceCapture(journal: JournalStorePort): {
  journal: JournalStorePort;
  sequenceOf: (event: RunEvent) => number;
} {
  let lastStored: StoredEvent | undefined;
  // Forward each method explicitly rather than using `{...journal, appendEvent}`: both implementations
  // are classes, so spreading copies only own properties and drops all prototype methods (the engine
  // would later throw a TypeError calling getRun). The forwarding surface contains **only engine
  // ports**; orphan reconciliation and enumeration queries deliberately stay out because they happen
  // in the service layer and call deps.journal directly, bypassing this wrapper.
  const wrapped: JournalStorePort = {
    createRun: (record) => journal.createRun(record),
    getRun: (runId) => journal.getRun(runId),
    updateRunStatus: (runId, status, settlement) =>
      journal.updateRunStatus(runId, status, settlement),
    updateRunUsage: (runId, spentTokens) => journal.updateRunUsage(runId, spentTokens),
    updateRunCaps: (runId, caps) => journal.updateRunCaps(runId, caps),
    putActor: (record) => journal.putActor(record),
    getActor: (runId, siteId, ordinal) => journal.getActor(runId, siteId, ordinal),
    listActors: (runId) => journal.listActors(runId),
    putNode: (record) => journal.putNode(record),
    getNode: (runId, siteId, ordinal) => journal.getNode(runId, siteId, ordinal),
    listNodes: (runId) => journal.listNodes(runId),
    appendEvent: (runId, event) => {
      const stored = journal.appendEvent(runId, event);
      lastStored = stored;
      return stored;
    },
    listEvents: (runId, opts) => journal.listEvents(runId, opts),
  };
  return {
    journal: wrapped,
    sequenceOf: (event) =>
      lastStored?.event === event ? lastStored.sequence : (lastStored?.sequence ?? 0),
  };
}
