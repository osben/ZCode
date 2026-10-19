import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import {
  describeCron,
  describeCronBuilder,
  type CronBuilderState,
  type IntlLike,
} from "@/settings/automationFormat.js";

function scheduleRuleToBuilder(rule: ZCodeAutomationScheduleRule): CronBuilderState {
  return {
    frequency: "custom",
    hour: rule.hour,
    minute: rule.minute,
    weekdays: rule.weekdays ?? [1],
    dayOfMonth: rule.monthDays?.[0] ?? 1,
    rawExpr: "",
    customInterval: rule.interval,
    customUnit: rule.unit,
    customWeekdays: rule.weekdays ?? [1],
    customMonthDays: rule.monthDays ?? [1],
    customMonth: rule.months?.[0] ?? new Date(rule.anchorAt).getMonth() + 1,
    customMonthlyMode: rule.monthlyMode ?? "date",
  };
}

export type AutomationCardScheduleKind = "one-time" | "recurring";

export function getAutomationCardScheduleKind(automation: {
  recurring?: boolean;
  maxRuns?: number;
}): AutomationCardScheduleKind {
  return automation.recurring === false && (automation.maxRuns ?? 1) <= 1
    ? "one-time"
    : "recurring";
}

/** Cards prefer the authoritative scheduleRule; generate a summary from the compatibility cron only when older data lacks the rule. */
export function describeAutomationCardSchedule(
  automation: {
    cronExpr: string;
    scheduleRule?: ZCodeAutomationScheduleRule;
    recurring?: boolean;
    maxRuns?: number;
  },
  intl: IntlLike,
): string {
  // Relative-time one-off tasks (such as "remind in 4 minutes") are stored as minute scheduleRules for compatibility display,
  // but describeCronBuilder would misrepresent them as repeating "every 4 minutes." One-off tasks run once and have no frequency,
  // so display them as "Custom," like one-off fixed-calendar cron tasks, and show the actual time in "Next run."
  if (getAutomationCardScheduleKind(automation) === "one-time") {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  // Compatibility cron for a long monthly interval is fixed as a monthly candidate; parsing cron alone would misdisplay "every 30 months" as "monthly."
  if (automation.scheduleRule) {
    return describeCronBuilder(scheduleRuleToBuilder(automation.scheduleRule), intl);
  }
  return describeCron(automation.cronExpr, intl);
}
