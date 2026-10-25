import { useEffect, useRef } from "react";
import type { IPlatformService } from "@zcode/shared";
import type { ZCodeOffPeakTaskStatus } from "@zcode/shared";
import type { IOffPeakTaskService } from "@zcode/services";
import type { IntlInstance } from "@/i18n/index.js";
import { logger } from "@/logger.js";

// Off-peak task system notifications (in-app state is authoritative; clicking a notification opens the session; styling is pending design).
// Mounted globally at the App root, once per window: main's dispatchTaskNotification deduplicates by (status:taskId) for 3s,
// so duplicate triggers across windows show only one notification and need no leader election. Polling is independent of host sync (renderer cannot access SQLite).

const OFF_PEAK_NOTIFICATION_POLL_MS = 30_000;

/** Off-Peak aggregation notifies only terminal states; the regular session notification flow handles permission/elicitation to avoid duplicates. */
function notifiableStatus(status: ZCodeOffPeakTaskStatus): "completed" | "failed" | null {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return null;
}

export function useOffPeakTaskNotifications(params: {
  offPeakTaskService: IOffPeakTaskService;
  platform: Pick<IPlatformService, "showTaskNotification"> | null | undefined;
  enabled: boolean;
  formatMessage: IntlInstance["formatMessage"];
}): void {
  const { offPeakTaskService, platform, enabled, formatMessage } = params;
  // offPeakTaskId → last observed status; notify only on a "new → notify-worthy status" edge to avoid repeating every poll.
  const seenStatusRef = useRef(new Map<string, ZCodeOffPeakTaskStatus>());

  useEffect(() => {
    if (!enabled || !platform) return;
    let disposed = false;

    const tick = async () => {
      try {
        const tasks = await offPeakTaskService.list();
        if (disposed) return;
        const seen = seenStatusRef.current;
        const alive = new Set<string>();
        for (const task of tasks) {
          alive.add(task.offPeakTaskId);
          const previous = seen.get(task.offPeakTaskId);
          seen.set(task.offPeakTaskId, task.status);
          if (previous === task.status) continue;
          const kind = notifiableStatus(task.status);
          if (!kind) continue;
          // If first observed in a terminal state (for example, an existing task on app launch), do not send a historical notification; notify only on a real transition.
          if (previous === undefined) continue;
          const titleKey =
            kind === "completed" ? "offPeak.notify.completed.title" : "offPeak.notify.failed.title";
          const bodyKey =
            kind === "completed" ? "offPeak.notify.completed.body" : "offPeak.notify.failed.body";
          try {
            platform.showTaskNotification({
              // Use the run session's taskId for click navigation (terminal states without a session cannot navigate, so fall back to offPeakTaskId).
              taskId: task.sessionId ?? task.conversationId ?? task.offPeakTaskId,
              status: kind === "completed" ? "completed" : "failed",
              title: formatMessage({ id: titleKey }),
              body: formatMessage({ id: bodyKey }, { title: task.title || task.prompt }),
            });
          } catch (error) {
            logger.warn("[off-peak] notification dispatch failed", error);
          }
        }
        // Remove tasks that disappeared (were deleted) to prevent the Map from growing without bound.
        for (const id of seen.keys()) {
          if (!alive.has(id)) seen.delete(id);
        }
      } catch (error) {
        logger.warn("[off-peak] notification poll failed", error);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), OFF_PEAK_NOTIFICATION_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [enabled, platform, offPeakTaskService, formatMessage]);
}
