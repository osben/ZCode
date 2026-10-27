export type {
  DreamJournalContract,
  DreamJournalAction,
  DreamJournalHost,
  DreamJournalItem,
  DreamJournalOutcome,
  DreamJournalRun,
  DreamJournalRunHandle,
  DreamJournalScope,
  DreamJournalSnapshot,
  DreamJournalTrigger,
} from "./contract.js";
export {
  DREAM_JOURNAL_DIRECTORY_NAME,
  DREAM_JOURNAL_RUN_LIMIT,
  DREAM_JOURNAL_SKIPPED_RUN_LIMIT,
  beginDreamJournalRun,
  listDreamJournalRuns,
  readDreamJournalRun,
  recordDreamJournalSkip,
} from "./journal.js";
export {
  beginDreamJournalRunSafely,
  countDreamJournalActions,
  finalizeDreamJournalSafely,
  logDreamSkip,
  recordDreamSkip,
  snapshotBeforeTouchSafely,
  type DreamSkipReasonCode,
} from "./runtime-adapter.js";

import type { DreamJournalContract } from "./contract.js";
import {
  beginDreamJournalRun,
  listDreamJournalRuns,
  readDreamJournalRun,
  recordDreamJournalSkip,
} from "./journal.js";

/** The journal store bound to its public contract. */
export const dreamJournal: DreamJournalContract = {
  beginRun: beginDreamJournalRun,
  listRuns: listDreamJournalRuns,
  readRun: readDreamJournalRun,
  recordSkip: recordDreamJournalSkip,
};
