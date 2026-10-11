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

export function formatTaskRelativeTime(
  timestamp: number,
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  },
): string {
  const diff = Date.now() - timestamp;
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
