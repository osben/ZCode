// Throttle high-frequency sessions-index fan-out events (docs/v4-refactor/14-sessions-index.md, "Event fan-out pacing").
// Scheduling only: window state and timers live here; the caller injects publish, and the gateway keeps only the call site.
//
// Root-cause memo: one workflow run's engine events reach the parent session as DynamicWorkflowRunProgress, measured at 4000 events in 8s.
// Each bumps record.updatedAt, so the summary changes on every event → the old implementation flushed one sessions-index delta per event
// → the Host recomputed task rows → the renderer re-pulled the task list at event frequency. ModelStreaming was excluded long ago for the same reason.

/** Fan-out window for workflow progress events: coalesce progress into one publication at the end of the window (sidebar running rows <= 4 Hz). */
export const WORKFLOW_PROGRESS_INDEX_FANOUT_MS = 250;

/** The scheduler treats timer handles as opaque: production uses setTimeout; tests may inject any implementation. */
export type FanoutTimerHandle = unknown;

export interface SessionsIndexFanoutThrottleOptions {
/** Publish the current summary for a session to sessions-index (the gateway's publishCurrentSummaryToIndex). */
  publish: (sessionId: string) => void;
  windowMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => FanoutTimerHandle;
  clearTimer?: (handle: FanoutTimerHandle) => void;
}

interface WindowState {
/** Whether the window has progress that has not yet been published; any immediate publication clears it. */
  pending: boolean;
  handle: FanoutTimerHandle;
}

function defaultSetTimer(callback: () => void, delayMs: number): FanoutTimerHandle {
  const timer = setTimeout(callback, delayMs);
  // Do not keep the CLI process alive for a throttle window (same approach as scheduleFlush).
  timer.unref?.();
  return timer;
}

function defaultClearTimer(handle: FanoutTimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * Leading + trailing window throttle, with an independent window per session:
 * publish the first request after an idle period immediately and open a window; later requests in
 * the window only set pending and are coalesced into one publication at the window's end. If anything
 * is pending, publish and extend the window, ensuring at most one frame per window during a burst.
 * If nothing is pending, close the window so the next request uses the leading edge again.
 */
export class SessionsIndexFanoutThrottle {
  private readonly windows = new Map<string, WindowState>();
  private readonly publish: (sessionId: string) => void;
  private readonly windowMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => FanoutTimerHandle;
  private readonly clearTimer: (handle: FanoutTimerHandle) => void;

  constructor(options: SessionsIndexFanoutThrottleOptions) {
    this.publish = options.publish;
    this.windowMs = options.windowMs ?? WORKFLOW_PROGRESS_INDEX_FANOUT_MS;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

/** Publication request for a high-frequency event: publish immediately (leading) or coalesce into one publication at window end (trailing). */
  request(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (open) {
      open.pending = true;
      return;
    }
    this.openWindow(sessionId);
    this.publish(sessionId);
  }

  /**
   * Any immediate publication (non-progress event, hydration replay, etc.) already includes progress
   * coalesced within the window, satisfying the pending trailing publication. Clear pending only; keep
   * the throttle window active and do not emit an empty extra delta frame.
   */
  notePublished(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (open) open.pending = false;
  }

/** Session runtime cleanup: its window timer must be removed too (cleanupSessionRuntime). */
  clearSession(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (!open) return;
    this.clearTimer(open.handle);
    this.windows.delete(sessionId);
  }

/** Gateway dispose: clear every window timer. */
  clear(): void {
    for (const open of this.windows.values()) this.clearTimer(open.handle);
    this.windows.clear();
  }

  private openWindow(sessionId: string): void {
    this.windows.set(sessionId, {
      pending: false,
      handle: this.setTimer(() => this.onWindowElapsed(sessionId), this.windowMs),
    });
  }

  private onWindowElapsed(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (!open) return;
    if (!open.pending) {
      // No new progress in the window -> close it; publish the next progress event immediately.
      this.windows.delete(sessionId);
      return;
    }
    // Extend the window before publishing: publish calls notePublished, so state must already reflect the new window.
    open.pending = false;
    open.handle = this.setTimer(() => this.onWindowElapsed(sessionId), this.windowMs);
    this.publish(sessionId);
  }
}
