import { useEffect, useState } from "react";

/** Natural countdown interval: second-level copy does not change more frequently than this. */
export const NOW_TICKER_INTERVAL_MS = 1_000;

/**
 * A "now" value that advances only while `active`.
 *
 * Why not recompute as a side effect of projection updates? An ask in provider backoff **emits no events**, so an event-driven
 * value would stay at the second it was first received. Keep the timer only while a countdown is visible; when `active` becomes true,
 * read "now" again before starting so the previous interval's drift is not carried forward. This follows the same approach as the wait duration
 * in WorkflowRunPendingQuestionsSection, with a 1-second interval instead of 30 seconds because this UI displays seconds.
 */
export function useNowTicker(active: boolean, intervalMs: number = NOW_TICKER_INTERVAL_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
