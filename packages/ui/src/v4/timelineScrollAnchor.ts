// Virtual-scroll core: v4 timeline bottom-anchor state machine (pure functions, no DOM/React dependency).
//
// Semantics (scrollAnchor):
// - When the user is at the bottom, following=true; new content (rows, streaming deltas, or measurement changes) stays pinned to the bottom.
// - When the user scrolls up away from the bottom, following=false; streaming updates must not pull the reading position back, and the "back to bottom" button appears.
// - When the user scrolls back to the bottom manually or clicks the button, resume following.
//
// following represents user scroll intent, not a momentary geometry snapshot: only real user scroll input can change it;
// programmatic bottom pinning, terminal collapse, and virtualizer measurement corrections only update geometry bookkeeping.
//

/** Tolerance for deciding whether the view is at the bottom; smaller distances count as at bottom. Covers subpixel scrolling and last-row padding. */
const BOTTOM_ANCHOR_EPSILON_PX = 48;

interface TimelineScrollMetrics {
  /** Scroll container scrollTop. */
  scrollTop: number;
  /** Scroll container viewport height (clientHeight). */
  viewportHeight: number;
  /** Total content height (scrollHeight). */
  contentHeight: number;
}

/** Remaining scrollable distance to the bottom (0 when content is shorter than one viewport). */
export function distanceToBottom(metrics: TimelineScrollMetrics): number {
  return Math.max(0, metrics.contentHeight - metrics.viewportHeight - metrics.scrollTop);
}

export function isAtBottom(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return distanceToBottom(metrics) <= epsilonPx;
}

/** Following state after a scroll event. Rule: follow iff the final position is at the bottom. Covers user scrolling up (away from bottom → stop following), scrolling back (at bottom → resume), and programmatic pinning (at bottom → keep following) without distinguishing their source. */
function nextFollowingAfterScroll(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return isAtBottom(metrics, epsilonPx);
}

type TimelineScrollEventSource = "user" | "programmatic" | "layout";

/** Scroll-ownership decision after a scroll event. Layout/programmatic scrolls must not change user intent; only user input decides whether to follow based on the final position. */
export function resolveFollowingAfterScroll(input: {
  following: boolean;
  metrics: TimelineScrollMetrics;
  source: TimelineScrollEventSource;
  epsilonPx?: number;
}): boolean {
  if (input.source !== "user") return input.following;
  return nextFollowingAfterScroll(input.metrics, input.epsilonPx);
}

/** Action after content changes (new row, streaming delta increasing height, dynamic measurement correction): pin to bottom when following; preserve reading position when not following (never pull the user back). */
export function anchorActionAfterContentChange(
  following: boolean,
  contentWidthChanging: boolean = false,
): "stickToBottom" | "hold" {
  return following && !contentWidthChanging ? "stickToBottom" : "hold";
}

/** Scroll compensation decision after dynamic virtualizer measurements. A width resize may remeasure multiple messages in adjacent frames; compensating scrollTop one row at a time can cause visible jitter. */
export function shouldAdjustVirtualizerForItemSizeChange(input: {
  following: boolean;
  suppressAdjustment: boolean;
  contentWidthChanging: boolean;
  itemEnd: number;
  scrollTop: number;
}): boolean {
  if (input.suppressAdjustment || input.following || input.contentWidthChanging) {
    return false;
  }
  return input.itemEnd <= input.scrollTop;
}

/** Tolerance for unobserved scrolling: a scrollTop decrease smaller than this is treated as subpixel jitter, not user scrolling upward. */
const UNOBSERVED_SCROLL_EPSILON_PX = 2;

export type TimelineUserScrollIntent = "none" | "awayFromBottom" | "towardBottom" | "unknown";

/** wheel deltaY has the same direction as scrollTop: negative reads earlier content, positive moves toward the bottom. */
export function timelineWheelScrollIntent(deltaY: number): TimelineUserScrollIntent {
  if (deltaY < 0) return "awayFromBottom";
  if (deltaY > 0) return "towardBottom";
  return "none";
}

/** Touch-finger movement is opposite to scrollTop: moving a finger down reads earlier content. */
export function timelineTouchScrollIntent(
  previousClientY: number,
  nextClientY: number,
): TimelineUserScrollIntent {
  if (nextClientY > previousClientY) return "awayFromBottom";
  if (nextClientY < previousClientY) return "towardBottom";
  return "none";
}

/** Keyboard scroll intent; arrow keys used by an input control are not timeline scrolling. */
export function timelineKeyboardScrollIntent(input: {
  key: string;
  shiftKey: boolean;
  editableTarget: boolean;
}): TimelineUserScrollIntent {
  if (input.editableTarget) return "none";
  if (input.key === "ArrowUp" || input.key === "PageUp" || input.key === "Home") {
    return "awayFromBottom";
  }
  if (input.key === "ArrowDown" || input.key === "PageDown" || input.key === "End") {
    return "towardBottom";
  }
  if (input.key === " ") {
    return input.shiftKey ? "awayFromBottom" : "towardBottom";
  }
  return "none";
}

/** Reconcile user scroll intent before pinning after a content commit. Following is driven by scroll events, but an event is dispatched on the next render frame after scrolling. If the user scrolls up (wheel) or a test assigns scrollTop programmatically, then a React commit changing totalSize/rowCount happens before the event dispatch (streaming delta, ResizeObserver measurement, or viewport recalculation from a composer-size change), the pin-to-bottom effect may use stale following=true and drag scrollTop back to the bottom. The resulting position then makes the later scroll event classify the view as following again, swallowing the user/test scroll ("resize/measurement commit steals scroll ownership"). Reconciliation rules, using live metrics at commit time: an explicit upward scroll immediately stops following, even if the same frame has a terminal/layout commit; with no user input, preserve following (scrollTop decreases from virtualizer/collapse are not upward intent); for unknown/downward input, resume if at bottom, stop if clearly moved away, otherwise preserve current state. */
export function reconcileFollowingForContentAnchor(input: {
  /** Current following state (existing value driven by scroll events). */
  following: boolean;
  /** Live scroll metrics at commit time, before the pin-to-bottom action. */
  metrics: TimelineScrollMetrics;
  /** Last accounted scrollTop (read from a scroll event or reread after a programmatic write). */
  lastObservedScrollTop: number;
  /** User scroll intent captured before the current content commit; when omitted, reconcile as an unknown source for compatibility. */
  userScrollIntent?: TimelineUserScrollIntent;
  bottomEpsilonPx?: number;
  scrollEpsilonPx?: number;
}): boolean {
  const userScrollIntent = input.userScrollIntent ?? "unknown";
  if (userScrollIntent === "awayFromBottom") return false;
  if (userScrollIntent === "none") return input.following;
  if (isAtBottom(input.metrics, input.bottomEpsilonPx ?? BOTTOM_ANCHOR_EPSILON_PX)) {
    return true;
  }
  const unobservedUpscroll =
    input.metrics.scrollTop <
    input.lastObservedScrollTop - (input.scrollEpsilonPx ?? UNOBSERVED_SCROLL_EPSILON_PX);
  if (unobservedUpscroll) {
    return false;
  }
  return input.following;
}

/** Visibility of the "back to bottom" button: show only when following is stopped and content exists. */
export function shouldShowBackToBottom(following: boolean, rowCount: number): boolean {
  return !following && rowCount > 0;
}

/** Session switch / first binding: reset to following (opening a session positions at the latest message). */
export function initialFollowing(): boolean {
  return true;
}

// ── loadOlder: preserve the scroll anchor while prepending (a classic virtual-scroll pitfall) ──
//
// Semantics: when older rows are prepended at the top of the window, the row the user is reading (the anchor) must not move in the viewport.
// In a virtual list, prepending changes only total height (existing turns keep cached measurements keyed by turnId and are not remounted/re-measured),
// so anchor restoration shifts scrollTop by the height added above the existing content.
//   scrollTop' = scrollTop + (nextTotalSize - prevTotalSize)
// Preconditions: existing render-unit keys are stable (getItemKey=turnId), and no other measurement correction happens in the same frame.
// New rows have estimated heights in the prepend commit; later ResizeObserver corrections use the virtualizer's
// normal shift logic and do not go through this function.

export interface PrependVirtualAnchor {
  key: string;
  /** Offset from the top of the viewport to the measurement start for the anchor. */
  offsetTop: number;
  start: number;
}

/** ScrollTop adjustment to apply to the same stable key after a prepend. Between loadOlder and the row commit, restored layout or the virtualizer may already change scrollTop; adding only the difference in measurement.start would count that intermediate movement twice. Compute the absolute target from the saved viewport offset, then subtract the live scrollTop to reliably restore the original reading position. */
export function prependVirtualAnchorAdjustment(
  previous: PrependVirtualAnchor,
  next: PrependVirtualAnchor,
  currentScrollTop: number,
): number | null {
  if (previous.key !== next.key) return null;
  if (
    !Number.isFinite(previous.offsetTop) ||
    !Number.isFinite(next.start) ||
    !Number.isFinite(currentScrollTop)
  ) {
    return null;
  }
  return next.start - previous.offsetTop - currentScrollTop;
}

interface PrependAnchorInput {
  /** First row rowId from the previous commit (null means there were no rows yet). */
  prevFirstRowId: number | null;
  /** First row rowId in this commit (null means rows were cleared). */
  nextFirstRowId: number | null;
  /** Total virtual-list height in the previous commit. */
  prevTotalSize: number;
  /** Total virtual-list height in this commit. */
  nextTotalSize: number;
}

/** scrollTop shift after prepending. Return a positive shift only when the first row rowId decreases (a real prepend); return null for append/replace/clear/first frame so the scroll position is unchanged and bottom-anchor logic handles it. */
export function prependScrollAdjustment(input: PrependAnchorInput): number | null {
  if (input.prevFirstRowId === null || input.nextFirstRowId === null) {
    return null;
  }
  if (input.nextFirstRowId >= input.prevFirstRowId) return null;
  const delta = input.nextTotalSize - input.prevTotalSize;
  return delta > 0 ? delta : null;
}

/** Top trigger threshold: within this distance of the top, treat the view as at the top and fetch an earlier window. */
const LOAD_OLDER_TRIGGER_PX = 64;

/** Prefetch two viewports ahead so network and rendering finish before the user reaches the window boundary. */
const LOAD_OLDER_PREFETCH_VIEWPORTS = 2;

export function historyPrefetchTriggerPx(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return LOAD_OLDER_TRIGGER_PX;
  }
  return Math.max(LOAD_OLDER_TRIGGER_PX, viewportHeight * LOAD_OLDER_PREFETCH_VIEWPORTS);
}

/** Whether a scroll event should trigger loadOlder (at top + more available + not already in flight). */
export function shouldTriggerLoadOlder(input: {
  scrollTop: number;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  triggerPx?: number;
}): boolean {
  return (
    input.canLoadOlder &&
    !input.loadingOlder &&
    input.scrollTop <= (input.triggerPx ?? LOAD_OLDER_TRIGGER_PX)
  );
}
