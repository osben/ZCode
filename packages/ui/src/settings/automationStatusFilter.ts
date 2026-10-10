/* Automations list status filter: Scheduled and Off-Peak tasks share the same filter options.
   Grouping follows the status badges actually shown on cards: the group matches the badge color users see in the list. */
import type { ZCodeOffPeakTask } from "@zcode/shared";
import {
  hasAutomationFailureState,
  resolveAutomationStatusKind,
} from "@/settings/automationFormat.js";

export type AutomationStatusFilter = "all" | "inProgress" | "completed" | "failed";
type AutomationStatusFilterKind = Exclude<AutomationStatusFilter, "all">;

/** Default filter: no filtering. AutomationsSection references this constant to avoid a bare "all" in source triggering the All-tab regression assertion. */
export const DEFAULT_AUTOMATION_STATUS_FILTER: AutomationStatusFilter = "all";

export const AUTOMATION_STATUS_FILTERS: readonly AutomationStatusFilter[] = [
  "all",
  "inProgress",
  "completed",
  "failed",
];

/** Six Off-Peak states → three groups: queued/paused/running can still progress, so count as active; canceled and failed are both abnormal endings, so group as failed. */
function resolveOffPeakStatusFilterKind(
  task: Pick<ZCodeOffPeakTask, "status">,
): AutomationStatusFilterKind {
  switch (task.status) {
    case "completed":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "inProgress";
  }
}

type AutomationFilterLike = Parameters<typeof resolveAutomationStatusKind>[0] &
  Parameters<typeof hasAutomationFailureState>[0];

/** Scheduled tasks: check the failure badge first (including the latest run failure for recurring tasks), then lifecycle terminal states; all others are active. */
function resolveAutomationStatusFilterKind(
  automation: AutomationFilterLike,
): AutomationStatusFilterKind {
  if (hasAutomationFailureState(automation)) return "failed";
  return resolveAutomationStatusKind(automation) === "completed" ? "completed" : "inProgress";
}

export function filterOffPeakTasksByStatus<T extends Pick<ZCodeOffPeakTask, "status">>(
  tasks: readonly T[],
  filter: AutomationStatusFilter,
): readonly T[] {
  if (filter === "all") return tasks;
  return tasks.filter((task) => resolveOffPeakStatusFilterKind(task) === filter);
}

export function filterAutomationsByStatus<T extends AutomationFilterLike>(
  automations: readonly T[],
  filter: AutomationStatusFilter,
): readonly T[] {
  if (filter === "all") return automations;
  return automations.filter(
    (automation) => resolveAutomationStatusFilterKind(automation) === filter,
  );
}

/**
 * The filter used to be stored as `{ tab, filter }` and derived during render, so switching away from and back to a tab restored
 * its old filter, violating "changing the top-level tab resets to All." Put tab and filter in one state object instead;
 * reduce all tab changes through this function: preserve the same object when the tab is unchanged (avoid needless renders), reset the filter when it changes.
 */
export interface AutomationTabState<Tab extends string> {
  tab: Tab;
  filter: AutomationStatusFilter;
}

export function resolveAutomationTabState<Tab extends string>(
  previous: AutomationTabState<Tab>,
  nextTab: Tab,
): AutomationTabState<Tab> {
  if (nextTab === previous.tab) return previous;
  return { tab: nextTab, filter: DEFAULT_AUTOMATION_STATUS_FILTER };
}
