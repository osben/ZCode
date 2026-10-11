/**
 * Pure display rules for pending questions (workflow escalations).
 *
 * Split from workflowRunPanel.ts to meet the eslint 400-line max-lines rule, following the precedent in WorkflowRunSidePaneSections.tsx:
 * that file already contains four groups of detail-page rules (budget math, Cancel availability, result classification, and event-row
 * summaries), and escalation questions are a new vocabulary family that would push it over the limit.
 */

const WAITED_MINUTE_MS = 60_000;
const WAITED_HOUR_MS = 60 * WAITED_MINUTE_MS;
const WAITED_DAY_MS = 24 * WAITED_HOUR_MS;

/**
 * Declare the small amount of intl capability this module needs locally instead of borrowing it from workflowRunPanel.
 *
 * It is a structural type, so declaring it in both places will not drift (its shape is determined by react-intl's formatMessage); importing
 * a type would add an unnecessary module dependency — avoiding that dependency is the reason for splitting the file.
 */
type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * “How long has this question been waiting?” — the first thing readers ask when they see a pending question.
 *
 * Pure function; the caller injects `now` (the component supplies updated timestamps at a fixed interval): a waiting run **does not emit events**,
 * so it cannot rely on “recompute on the next projection update” — a question stuck for half an hour would keep showing “just now.”
 *
 * Reuse the existing `sidePane.time.*` copy family (available in both languages); do not create a new set of keys for the same meaning.
 *
 * Record these three boundaries:
 *   - If `askedAt` is missing (events replayed from older journals do not include it), return undefined and do not render the label,
 *     rather than inventing a “just now” value.
 *   - If clock skew puts `askedAt` in the future (the CLI process stamps the question, and in remote sessions it may be on a different
 *     machine from the renderer), clamp it to “just now.” A negative duration is worse than hiding the label.
 *   - Stop the scale at “days”: pending questions may wait indefinitely by design (there is no timeout), so the range needs an upper bound.
 */
export function workflowRunQuestionWaitedLabel(
  askedAt: number | undefined,
  now: number,
  formatMessage: FormatMessage,
): string | undefined {
  if (askedAt === undefined || !Number.isFinite(askedAt)) return undefined;
  const elapsed = now - askedAt;
  if (elapsed < WAITED_MINUTE_MS) return formatMessage({ id: "sidePane.time.justNow" });
  if (elapsed < WAITED_HOUR_MS) {
    return formatMessage(
      { id: "sidePane.time.minutesAgo" },
      { count: String(Math.floor(elapsed / WAITED_MINUTE_MS)) },
    );
  }
  if (elapsed < WAITED_DAY_MS) {
    return formatMessage(
      { id: "sidePane.time.hoursAgo" },
      { count: String(Math.floor(elapsed / WAITED_HOUR_MS)) },
    );
  }
  return formatMessage(
    { id: "sidePane.time.daysAgo" },
    { count: String(Math.floor(elapsed / WAITED_DAY_MS)) },
  );
}
