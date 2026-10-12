/**
 * Expiry visibility clock for the Highspeed group-tail footer.
 *
 * Background (spec §9.3): the visibility of the footer "Generated above by Highspeed" is driven by
 * ConversationTimeline's `liveNowMs` crossing the card's `expiresAt`. The expiry wake-up relies on
 * the renderer `setTimeout`, which Chromium freezes when the window is hidden or occluded — the
 * timer stops firing, `liveNowMs` stays before expiry, and the footer only appears after the user
 * sends another message (the runtime clock jumps `liveNowMs` to the current time), violating the
 * "no extra user message required" rule.
 *
 * So besides the expiry `setTimeout`, this also listens for the window becoming visible again
 * (`visibilitychange`) and regaining focus (`focus`), immediately catching up `liveNowMs` to the
 * current time once the window returns to the foreground. Division of labor with SessionPane's
 * window-wake compensation on the aggregation link (`highspeedAutoShareClock`): that one refreshes
 * the settled share-entry/view-button data, this one refreshes the group-tail footer's visibility
 * clock; neither depends on new messages or snapshot events.
 */

type ExpiryClockWindow = Pick<
  Window & typeof globalThis,
  "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener"
>;

type ExpiryClockDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

export interface HighspeedFooterExpiryClockDeps {
  windowTarget?: ExpiryClockWindow;
  documentTarget?: ExpiryClockDocument;
  now?: () => number;
}

/**
 * Wakes `onExpire` once at the next card's expiry boundary, with compensating wake-ups when the
 * window becomes visible or focused again.
 * Returns a dispose that cleans up the timer and listeners (for a React effect's cleanup).
 */
export function armHighspeedFooterExpiryClock(
  nextExpiryMs: number,
  onExpire: () => void,
  deps: HighspeedFooterExpiryClockDeps = {},
): () => void {
  const windowTarget = deps.windowTarget ?? window;
  const documentTarget = deps.documentTarget ?? document;
  const now = deps.now ?? Date.now;

  // The +20ms buffer ensures the trigger is actually past expiresAt, avoiding boundary jitter
  // leaving the footer judged as not yet expired.
  const delayMs = Math.max(0, nextExpiryMs - now()) + 20;
  const timer = windowTarget.setTimeout(onExpire, delayMs);

  const catchUpFromWindowWake = () => {
    // No compensation when switching to hidden (same policy as SessionPane); only catch up the
    // clock when returning to the foreground.
    if (documentTarget.visibilityState === "hidden") return;
    onExpire();
  };
  documentTarget.addEventListener("visibilitychange", catchUpFromWindowWake);
  windowTarget.addEventListener("focus", catchUpFromWindowWake);

  return () => {
    windowTarget.clearTimeout(timer);
    documentTarget.removeEventListener("visibilitychange", catchUpFromWindowWake);
    windowTarget.removeEventListener("focus", catchUpFromWindowWake);
  };
}
