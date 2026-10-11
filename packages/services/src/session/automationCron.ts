import { Cron } from "croner";
import type { ZCodeAutomation, ZCodeAutomationScheduleRule } from "@zcode/shared";
import { isValidCronExpr } from "#src/session/automationCronValidation.js";

export { isValidCronExpr } from "#src/session/automationCronValidation.js";

const ONE_SHOT_MISSED_RUN_GRACE_MS = 60 * 1_000;
// Recognition window for a one-time fixed month/day cron whose target has just passed. The model's notion of "now" is often stale (its time context is from
// the start of the session/turn), so when it converts a relative request into an absolute cron, the target minute may already be several to dozens of minutes old.
// Treat an expired target within the window as a model calculation error, not as a user intending to schedule it next year: execute immediately if under 1 min;
// otherwise reject before writing and suggest delayMinutes. A 30 min window covers real clock drift; beyond it (for example, creation after the target month), preserve next-year semantics.
const ONE_SHOT_STALE_TARGET_WINDOW_MS = 30 * 60 * 1_000;
const FIXED_CALENDAR_CRON = /^\d+\s+\d+\s+\d+\s+\d+\s+\*$/;

/** Determine whether a directly submitted scheduleRule changes only display fields; ignore anchorAt in the comparison. */
export function scheduleRuleDefinition(rule: ZCodeAutomationScheduleRule): string {
  return JSON.stringify([
    rule.unit,
    rule.interval,
    rule.hour,
    rule.minute,
    rule.weekdays ? [...rule.weekdays].sort((a, b) => a - b) : null,
    rule.monthDays ? [...rule.monthDays].sort((a, b) => a - b) : null,
    rule.months ? [...rule.months].sort((a, b) => a - b) : null,
    rule.monthlyMode ?? null,
  ]);
}

/** A one-time fixed-calendar task specified a target time that just passed but can no longer be safely executed immediately. */
export class StaleOneShotAutomationScheduleError extends Error {
  constructor(targetAt: number) {
    super(
      `一次性定时任务的目标时间（${new Date(targetAt).toLocaleString()}）已过去；相对时间请使用 delayMinutes，绝对时间请确认未来时刻后重试`,
    );
    this.name = "StaleOneShotAutomationScheduleError";
  }
}

/**
 * A strictly one-time task (non-recurring and runs at most once). A relative delay means one specific target time,
 * not an interval-based recurrence. Once its window is missed, it must reach a terminal state; do not infer a new execution commitment
 * from a compatibility scheduleRule (such as a minute rule derived from delayMinutes).
 */
export function isOneShotAutomation(
  automation: Pick<ZCodeAutomation, "recurring" | "maxRuns">,
): boolean {
  return !automation.recurring && (automation.maxRuns ?? 1) <= 1;
}

/**
 * Calculate the next trigger time for a cron expression (local timezone). Scheduled tasks use croner only to parse and calculate the next time;
 * it does not perform actual scheduling. The scheduler loop polls automation_runs / claimDue itself.
 */

/**
 * Calculate the next trigger time for cron (timestamp in milliseconds).
 * @param from Baseline time (milliseconds); defaults to now. Returns the next occurrence strictly after from, or null if there is no future occurrence.
 */
export function computeNextRunAt(cronExpr: string, from?: number): number | null {
  const cron = new Cron(cronExpr);
  const next = cron.nextRun(from === undefined ? undefined : new Date(from));
  return next ? next.getTime() : null;
}

/**
 * Convert "in a few minutes" into a one-time rule anchored to the server's actual clock. cronExpr is for compatibility/display only;
 * the actual nextRunAt is calculated from scheduleRule with a second-level anchorAt, avoiding a full-minute early or late offset from five-field cron.
 */
export function buildRelativeDelaySchedule(
  delayMinutes: number,
  from = Date.now(),
): Pick<ZCodeAutomation, "cronExpr" | "scheduleRule"> {
  const target = new Date(from + delayMinutes * 60 * 1_000);
  return {
    cronExpr: `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`,
    scheduleRule: {
      unit: "minute",
      interval: delayMinutes,
      hour: target.getHours(),
      minute: target.getMinutes(),
      anchorAt: from,
    },
  };
}

/**
 * First trigger time for a new task. If a one-time fixed month/day cron has just missed its target minute, the next occurrence rolls to next year;
 * only allow immediate execution for a tool-call timing error under one minute. Older targets must be rejected and recalculated.
 */
export function computeInitialAutomationNextRunAt(
  automation: Pick<ZCodeAutomation, "cronExpr" | "recurring" | "scheduleRule">,
  from = Date.now(),
): number | null {
  const nextRunAt = computeAutomationNextRunAt(automation, from);
  if (
    automation.recurring ||
    automation.scheduleRule ||
    !FIXED_CALENDAR_CRON.test(automation.cronExpr.trim())
  ) {
    return nextRunAt;
  }

  const cron = new Cron(automation.cronExpr);
  const previousRun = cron.previousRuns(1, new Date(from))[0]?.getTime();
  const targetAge =
    previousRun !== undefined &&
    from >= previousRun &&
    from - previousRun <= ONE_SHOT_STALE_TARGET_WINDOW_MS
      ? from - previousRun
      : undefined;
  const rolledToNextCalendarOccurrence =
    nextRunAt === null || nextRunAt - from > ONE_SHOT_STALE_TARGET_WINDOW_MS;
  if (targetAge !== undefined && rolledToNextCalendarOccurrence) {
    if (targetAge < ONE_SHOT_MISSED_RUN_GRACE_MS) return from;

    // Treating any past time as "just crossed the minute" would immediately execute a model-miscalculated
    // relative time after creation. Beyond one minute, we cannot safely infer the user still wants an immediate run; reject before writing.
    throw new StaleOneShotAutomationScheduleError(from - targetAge);
  }
  return nextRunAt;
}

function atTime(date: Date, hour: number, minute: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function firstWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const first = new Date(year, month, 1);
  return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7));
}

/** Next run for a custom recurrence rule; all calculations use local calendar time. */
export function computeScheduleRuleNextRunAt(
  rule: ZCodeAutomationScheduleRule,
  from = Date.now(),
): number | null {
  const interval = Math.max(1, Math.floor(rule.interval));
  const anchor = new Date(rule.anchorAt);

  if (rule.unit === "minute") {
    const step = interval * 60 * 1_000;
    // Minute intervals start at the creation/update time; unlike a `*/N` cron, they must not fire early at the next wall-clock boundary.
    // Always deriving from a fixed anchor also prevents drift from accumulating when the scheduler dispatches late.
    const steps = Math.max(1, Math.floor((from - rule.anchorAt) / step) + 1);
    return rule.anchorAt + steps * step;
  }

  if (rule.unit === "hourly") {
    const base = new Date(anchor);
    base.setMinutes(rule.minute, 0, 0);
    const step = interval * 60 * 60 * 1_000;
    const steps = Math.max(0, Math.floor((from - base.getTime()) / step) + 1);
    return base.getTime() + steps * step;
  }

  if (rule.unit === "daily") {
    for (let index = 0; index < 36_600; index += 1) {
      const date = new Date(
        anchor.getFullYear(),
        anchor.getMonth(),
        anchor.getDate() + index * interval,
      );
      const candidate = atTime(date, rule.hour, rule.minute).getTime();
      if (candidate > from) return candidate;
    }
    return null;
  }

  if (rule.unit === "weekly") {
    const anchorWeek = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    anchorWeek.setDate(anchorWeek.getDate() - ((anchorWeek.getDay() + 6) % 7));
    const weekdays = [...(rule.weekdays?.length ? rule.weekdays : [1])].sort();
    for (let week = 0; week < 5_220; week += interval) {
      for (const weekday of weekdays) {
        const dayOffset = (weekday + 6) % 7;
        const date = new Date(
          anchorWeek.getFullYear(),
          anchorWeek.getMonth(),
          anchorWeek.getDate() + week * 7 + dayOffset,
        );
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > from) return candidate;
      }
    }
    return null;
  }

  if (rule.unit === "monthly") {
    // 1200 is both a valid monthly interval and the search boundary. The previous strict-less-than check only examined offset=0,
    // incorrectly returning null after the current month's candidate had passed. Include the boundary to calculate the next occurrence 100 years later.
    for (let offset = 0; offset <= 1_200; offset += interval) {
      const month = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);
      const candidates =
        rule.monthlyMode === "weekday"
          ? [firstWeekdayOfMonth(month.getFullYear(), month.getMonth(), rule.weekdays?.[0] ?? 1)]
          : [...(rule.monthDays?.length ? rule.monthDays : [1])]
              .sort((left, right) => left - right)
              .map((day) => new Date(month.getFullYear(), month.getMonth(), day))
              .filter((date) => date.getMonth() === month.getMonth());
      for (const date of candidates) {
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > from) return candidate;
      }
    }
    return null;
  }

  // yearly: prefer rule.months (1-12 → 0-indexed); default to the anchor month for compatibility with old records.
  // Use monthDays[0] or the anchor day. Overflow guard: dates such as 2/30 or 2/29 in a non-leap year roll into the next month; skip that year to avoid a false trigger.
  const targetMonth =
    rule.months?.[0] != null ? (((rule.months[0] - 1) % 12) + 12) % 12 : anchor.getMonth();
  const targetDay = rule.monthDays?.[0] ?? anchor.getDate();
  for (let offset = 0; offset < 400; offset += interval) {
    const date = new Date(anchor.getFullYear() + offset, targetMonth, targetDay);
    if (date.getMonth() !== targetMonth) continue;
    const candidate = atTime(date, rule.hour, rule.minute).getTime();
    if (candidate > from) return candidate;
  }
  return null;
}

/** Recognize a "every N minutes" cron display expression as a product schedule rule anchored to its creation time. */
export function inferMinuteIntervalScheduleRule(
  cronExpr: string,
  anchorAt: number,
): ZCodeAutomationScheduleRule | undefined {
  const match = /^\*\/([1-9]\d*)\s+\*\s+\*\s+\*\s+\*$/.exec(cronExpr.trim());
  if (!match) return undefined;
  return {
    unit: "minute",
    interval: Number(match[1]),
    hour: new Date(anchorAt).getHours(),
    minute: new Date(anchorAt).getMinutes(),
    anchorAt,
  };
}

/**
 * Parse the five cron fields. Supports only standard five-field cron (minute hour day-of-month month day-of-week);
 * returns numeric parse results for each field. Range fields (dow/dom/month) are comma-separated; wildcard fields return undefined.
 * Returns undefined on failure, leaving the fallback policy to the caller.
 */
function parseCronFields(cronExpr: string): {
  minute?: number;
  hour?: number;
  monthDays?: number[];
  months?: number[];
  weekdays?: number[];
} {
  const parts = cronExpr.trim().split(/\s+/);
  // With noUncheckedIndexedAccess, parts[i] includes undefined in its type; destructure the first five fields. Parse only standard five-field cron.
  // If there are too few fields, return an empty object and let the caller fall back to anchorAt defaults (so "0 9" is not treated as valid cron).
  const [minuteToken, hourToken, domToken, monthToken, dowToken] = parts;
  if (parts.length < 5 || minuteToken === undefined) return {};
  const parseSingle = (token: string): number | undefined => {
    if (token === "*" || token === "?") return undefined;
    const value = Number(token);
    return Number.isInteger(value) ? value : undefined;
  };
  // Range fields support comma-separated lists (such as "1,3,5"); ignore non-numeric tokens (such as "*/2" or "1#1").
  // These step/ordinal expressions are outside the carrier use case (only out-of-range steps use the carrier), so fall back to defaults.
  const parseList = (token: string): number[] | undefined => {
    if (token === "*" || token === "?") return undefined;
    const values = token
      .split(",")
      .map((piece) => Number(piece))
      .filter((value) => Number.isInteger(value));
    return values.length > 0 ? values : undefined;
  };
  return {
    minute: parseSingle(minuteToken),
    hour: hourToken === undefined ? undefined : parseSingle(hourToken),
    monthDays: domToken === undefined ? undefined : parseList(domToken),
    months: monthToken === undefined ? undefined : parseList(monthToken),
    weekdays: dowToken === undefined ? undefined : parseList(dowToken),
  };
}

/**
 * Normalize a session-side custom recurrence carrier (intervalUnit + interval) into the authoritative scheduleRule.
 *
 * Each cron field has a step limit (minute 59, hour 24, day-of-month 31, month 12),
 * so "every 50 hours," "every 40 days," or "every 13 months" cannot be expressed directly with five-field cron. Session-side "every N units" rules use the controlled carrier
 * intervalUnit+interval to hold the actual interval; cronExpr is only a valid compatibility/display expression. This function parses compatible cron fields
 * into the hour/minute/weekdays/monthDays/months required by scheduleRule, while the carrier supplies the actual interval.
 * The caller (service) passes the actual creation/update time as anchorAt, and the scheduler advances from it.
 *
 * If compatible cron fields are missing (for example, the '* * * * *' placeholder), use safe defaults (weekday=[1], monthDays=[1],
 * months=anchor month) so the scheduler can still calculate the next run instead of silently returning null.
 */
export function buildIntervalScheduleRule(
  intervalUnit: ZCodeAutomationScheduleRule["unit"],
  interval: number,
  cronExpr: string,
  anchorAt: number,
): ZCodeAutomationScheduleRule {
  const fields = parseCronFields(cronExpr);
  const anchor = new Date(anchorAt);
  const minute = fields.minute ?? anchor.getMinutes();
  const hour = fields.hour ?? anchor.getHours();
  const monthDays = fields.monthDays ?? [anchor.getDate()];
  // Cron mixes 1-based and 0-based month/day-of-week fields; normalize them to scheduleRule semantics (see scheduler implementation).
  const months = fields.months ?? [anchor.getMonth() + 1];
  const weekdays = fields.weekdays ?? [1];

  switch (intervalUnit) {
    case "minute":
      // Minute-interval scheduling advances entirely from anchorAt; hour/minute are for display only. Preserve the anchor's hour/minute for the card.
      return {
        unit: "minute",
        interval,
        hour: anchor.getHours(),
        minute: anchor.getMinutes(),
        anchorAt,
      };
    case "hourly":
      // The scheduler's hourly branch uses only rule.minute to align minutes; hour is not part of the calculation (see computeScheduleRuleNextRunAt).
      return { unit: "hourly", interval, hour: 0, minute, anchorAt };
    case "daily":
      return { unit: "daily", interval, hour, minute, anchorAt };
    case "weekly":
      return { unit: "weekly", interval, hour, minute, weekdays, anchorAt };
    case "monthly":
      return {
        unit: "monthly",
        interval,
        hour,
        minute,
        monthDays,
        monthlyMode: "date",
        anchorAt,
      };
    case "yearly":
      return { unit: "yearly", interval, hour, minute, months, monthDays, anchorAt };
    default: {
      // Reject invalid units during normalization so an incorrect rule is not silently generated and persisted.
      const exhaustive: never = intervalUnit;
      throw new Error(`Unsupported intervalUnit: ${String(exhaustive)}`);
    }
  }
}

export function computeAutomationNextRunAt(
  automation: Pick<ZCodeAutomation, "cronExpr" | "scheduleRule">,
  from?: number,
): number | null {
  return automation.scheduleRule
    ? computeScheduleRuleNextRunAt(automation.scheduleRule, from)
    : computeNextRunAt(automation.cronExpr, from);
}
