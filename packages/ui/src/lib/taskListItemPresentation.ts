import { useSyncExternalStore } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskListRowActivity } from "@/v4/taskListRowActivity.js";

export function deriveTaskLeadingIndicator(
  task: ZCodeTaskMeta,
  activity: TaskListRowActivity | null,
): "error" | "unread" | "loading" | "none" {
  if (activity?.phase === "error") {
    return "error";
  }

  // Search results or sessions-index may not have hydrated yet, so the activity sidecar may be absent.
  // In that case, fall back only to persisted error; once sessions-index is available, its phase is authoritative and live.
  if (!activity && task.status === "error") {
    return "error";
  }

  // unread is a tasks-index membership field, so the blue dot must read the current
  // query-cache row directly; do not fall back to the old Zustand map and create two competing unread sources of truth.
  if (typeof task.unreadAt === "number") {
    return "unread";
  }

  if (activity?.phase === "prewarming" || activity?.phase === "running") {
    return "loading";
  }

  // persisted status=running only means no terminal state had been received at last save; it does not prove the task is still live after app restart.
  // Current runtime must confirm loading, or historical lists will keep showing a spinner for the previously unfinished task.
  return "none";
}

// `now` is injected so the label is a pure function of its inputs. Callers that render a live label
// pass the shared minute ticker value (useNowMinute below); one-shot callers keep the Date.now() default.
export function formatTaskRelativeTime(
  timestamp: number,
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  },
  now: number = Date.now(),
): string {
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return intl.formatMessage({ id: "taskList.justNow" });
  if (minutes < 60) {
    return intl.formatMessage({ id: "taskList.minutesAgo" }, { minutes: String(minutes) });
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return intl.formatMessage({ id: "taskList.hoursAgo" }, { hours: String(hours) });
  }

  const days = Math.floor(hours / 24);
  return intl.formatMessage({ id: "taskList.daysAgo" }, { days: String(days) });
}

/** Relative time labels ("8m", "3h") only change at minute granularity, so one shared tick per window is enough. */
export const NOW_MINUTE_INTERVAL_MS = 60_000;

// One module-level store per window: every label subscriber shares a single interval instead of starting its own timer.
// The snapshot is a cached number that only a tick updates, so getSnapshot stays referentially stable for React.
type NowMinuteListener = () => void;
const nowMinuteListeners = new Set<NowMinuteListener>();
let nowMinuteSnapshotMs = Date.now();
let nowMinuteTimer: ReturnType<typeof setInterval> | undefined;
let nowMinuteVisibilityBound = false;

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function emitNowMinute(): void {
  nowMinuteSnapshotMs = Date.now();
  for (const listener of nowMinuteListeners) listener();
}

function startNowMinuteTimer(): void {
  if (nowMinuteTimer !== undefined || nowMinuteListeners.size === 0 || isDocumentHidden()) return;
  nowMinuteTimer = setInterval(emitNowMinute, NOW_MINUTE_INTERVAL_MS);
}

function stopNowMinuteTimer(): void {
  if (nowMinuteTimer === undefined) return;
  clearInterval(nowMinuteTimer);
  nowMinuteTimer = undefined;
}

function handleNowMinuteVisibilityChange(): void {
  if (isDocumentHidden()) {
    stopNowMinuteTimer();
    return;
  }
  // Labels may be a whole interval stale after the window was hidden; refresh now instead of waiting for the next tick.
  emitNowMinute();
  startNowMinuteTimer();
}

function subscribeNowMinute(listener: NowMinuteListener): () => void {
  nowMinuteListeners.add(listener);
  if (nowMinuteListeners.size === 1) {
    nowMinuteSnapshotMs = Date.now();
    if (typeof document !== "undefined" && !nowMinuteVisibilityBound) {
      document.addEventListener("visibilitychange", handleNowMinuteVisibilityChange);
      nowMinuteVisibilityBound = true;
    }
    startNowMinuteTimer();
  }
  return () => {
    nowMinuteListeners.delete(listener);
    if (nowMinuteListeners.size > 0) return;
    stopNowMinuteTimer();
    if (typeof document !== "undefined" && nowMinuteVisibilityBound) {
      document.removeEventListener("visibilitychange", handleNowMinuteVisibilityChange);
      nowMinuteVisibilityBound = false;
    }
  };
}

function getNowMinuteSnapshot(): number {
  return nowMinuteSnapshotMs;
}

/**
 * Current time, refreshed at most once a minute while the document is visible.
 * Use for display-only relative labels; never feed it into sort or grouping keys.
 */
export function useNowMinute(): number {
  return useSyncExternalStore(subscribeNowMinute, getNowMinuteSnapshot, getNowMinuteSnapshot);
}
