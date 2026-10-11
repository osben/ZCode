import type { ZCodeOffPeakTask } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { OffPeakTakeNumberAvailabilityStatus } from "@/store/offPeakTaskStore.js";

export type OffPeakCreateBlockReason = "plan" | "quota" | "unavailable";

/** Off-peak creation disable reasons are long messages and cannot use the generic one-line tooltip layout. */
export const OFF_PEAK_CREATE_TOOLTIP_CLASSNAME =
  "max-w-[220px] [&>span]:break-words [&>span]:whitespace-normal [&>span]:text-wrap-pretty";

/** Allow creation only after the server confirms that a queue position can be assigned; fail closed for all other eligibility/dependency states. */
export function resolveOffPeakCreateBlockReason({
  availabilityStatus,
  canTakeNumber,
  grayEnabled,
  noPlan,
}: {
  availabilityStatus: OffPeakTakeNumberAvailabilityStatus;
  canTakeNumber: boolean | undefined;
  grayEnabled: boolean;
  noPlan: boolean;
}): OffPeakCreateBlockReason | null {
  if (!grayEnabled) return null;
  if (availabilityStatus === "loading" || availabilityStatus === "error") {
    return "unavailable";
  }
  if (noPlan) return "plan";
  if (availabilityStatus !== "ready") return "unavailable";
  return canTakeNumber === true ? null : "quota";
}

/** Convert the server's absolute recovery time to a localized remaining duration containing only hours/minutes. */
export function formatOffPeakRemainingWait(
  nextTakeAt: number,
  now: number,
  intl: IntlInstance,
): string {
  const remainingMs = nextTakeAt - now;
  if (remainingMs <= 0) {
    return intl.formatMessage({
      id: "offPeak.create.remaining.lessThanMinute",
    });
  }

  // The old tooltip displayed a full date/time, making the copy too long and requiring users to calculate the remaining wait themselves.
  // Round minutes up to avoid showing 0 minutes or underestimating the server recovery time while dozens of seconds remain.
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) {
    return intl.formatMessage({ id: "offPeak.create.remaining.hoursMinutes" }, { hours, minutes });
  }
  if (hours > 0) {
    return intl.formatMessage({ id: "offPeak.create.remaining.hours" }, { hours });
  }
  return intl.formatMessage({ id: "offPeak.create.remaining.minutes" }, { minutes });
}

export type OffPeakStatusIconKind =
  | "moon"
  | "pause"
  | "spinner"
  | "success"
  | "warning"
  | "stopped";

export interface OffPeakStatusFooterPresentation {
  icon: OffPeakStatusIconKind;
  className: string;
  labelId: string;
  labelValues?: Record<string, string>;
}

/**
 * Synchronize only the creation title that still uses its automatic default.
 * A locale change must not overwrite user input, template drafts, or a saved task title.
 */
export function resolveLocalizedOffPeakCreateTitle({
  currentTitle,
  hasInitialTitle,
  isEditing,
  nextDefaultTitle,
  previousDefaultTitle,
  titleTouched,
}: {
  currentTitle: string;
  hasInitialTitle: boolean;
  isEditing: boolean;
  nextDefaultTitle: string;
  previousDefaultTitle: string;
  titleTouched: boolean;
}): string {
  if (isEditing || hasInitialTitle || titleTouched || currentTitle !== previousDefaultTitle) {
    return currentTitle;
  }
  return nextDefaultTitle;
}

/** Single mapping for off-peak card status icon and copy, preventing a paused item with a position from being shown with the queued moon icon. */
export function resolveOffPeakStatusFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation {
  switch (task.status) {
    case "queued":
      return task.queuePosition
        ? {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.badge.queuePosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "moon",
            className: "text-idle-task",
            labelId: "offPeak.status.queued",
          };
    case "paused":
      return task.queuePosition
        ? {
            icon: "pause",
            // Paused and Queued both represent positions that still need attention; the design uses the same subtle brand pill for both.
            className: "text-idle-task",
            labelId: "offPeak.badge.pausedPosition",
            labelValues: { position: String(task.queuePosition) },
          }
        : {
            icon: "pause",
            className: "text-idle-task",
            labelId: "offPeak.status.paused",
          };
    case "running":
      return {
        icon: "spinner",
        className: "text-success",
        labelId: "offPeak.status.running",
      };
    case "completed":
      return {
        icon: "success",
        // Completed is a static terminal state that needs no further attention; highlighting it as success would make it more prominent than active tasks.
        className: "text-foreground-subtle",
        labelId: "offPeak.status.completed",
      };
    case "failed":
      return {
        icon: "warning",
        className: "text-destructive",
        labelId: "offPeak.status.failed",
      };
    case "cancelled":
      return {
        icon: "stopped",
        className: "text-foreground-subtle",
        labelId: "offPeak.status.cancelled",
      };
  }
}

/** Terminal tasks will not be scheduled again; do not show an invalid historical selection as a current error that needs fixing. */
export function shouldShowOffPeakModelSelectionIssue(
  status: Pick<ZCodeOffPeakTask, "status">["status"],
): boolean {
  return status === "queued" || status === "paused" || status === "running";
}

/**
 * Render a subdued queue position separately when a failed task still retains a position returned by the server.
 * The main status mapping returns only one footer; failed state needs a separate way to preserve queue context instead of replacing it with Failure.
 */
export function resolveFailedOffPeakQueueFooter(
  task: Pick<ZCodeOffPeakTask, "queuePosition" | "status">,
): OffPeakStatusFooterPresentation | null {
  if (task.status !== "failed" || task.queuePosition === undefined) return null;
  return {
    icon: "moon",
    className: "text-idle-task",
    labelId: "offPeak.badge.queuePosition",
    labelValues: { position: String(task.queuePosition) },
  };
}
