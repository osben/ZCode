import type { AppUsageFilters, AppUsageRange, AppUsageWindow } from "@zcode/shared";
import { dayIndexToDate, resolveTzOffsetMs } from "./usage-stats-builder.js";

const DAY_MS = 86_400_000;
const PRESET_RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };

export interface UsageStatsRequestParams {
  range: AppUsageRange;
  timeZone?: string;
  window?: AppUsageWindow;
  compare?: boolean;
  filters?: AppUsageFilters;
}

export interface UsageQuerySpan {
  since: number;
  until: number;
  /** Set only for explicit custom windows (first local day index). */
  windowStartDayIndex?: number;
  window?: AppUsageWindow;
}

export interface UsageQueryPlan extends UsageQuerySpan {
  timeZone: string;
  tzOffsetMs: number;
  previous?: UsageQuerySpan;
}

function dateToDayIndex(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year!, month! - 1, day!) / DAY_MS);
}

/** Local-midnight-treated-as-UTC day index to the instant range [start, end] for the caller's offset. */
function spanForDays(
  firstDayIndex: number,
  lastDayIndex: number,
  tzOffsetMs: number,
): UsageQuerySpan {
  return {
    since: firstDayIndex * DAY_MS - tzOffsetMs,
    until: (lastDayIndex + 1) * DAY_MS - tzOffsetMs - 1,
    windowStartDayIndex: firstDayIndex,
    window: { from: dayIndexToDate(firstDayIndex), to: dayIndexToDate(lastDayIndex) },
  };
}

/**
 * Turns request params into the query spans. Default requests (no `window`) keep the exact legacy
 * rolling-range arithmetic; a `window` selects whole local calendar days. `compare` adds the
 * immediately preceding span of equal length and is ignored for the all-time range.
 */
export function planUsageQuery(params: UsageStatsRequestParams, nowMs: number): UsageQueryPlan {
  const timeZone = params.timeZone ?? "UTC";
  const tzOffsetMs = resolveTzOffsetMs(timeZone, nowMs);

  if (params.window) {
    const first = dateToDayIndex(params.window.from);
    const last = dateToDayIndex(params.window.to);
    const length = last - first + 1;
    const current = spanForDays(first, last, tzOffsetMs);
    return {
      timeZone,
      tzOffsetMs,
      ...current,
      ...(params.compare ? { previous: spanForDays(first - length, first - 1, tzOffsetMs) } : {}),
    };
  }

  const rangeDays = PRESET_RANGE_DAYS[params.range];
  if (rangeDays === undefined) {
    return { timeZone, tzOffsetMs, since: 0, until: nowMs };
  }
  const since = nowMs - rangeDays * DAY_MS;
  const plan: UsageQueryPlan = { timeZone, tzOffsetMs, since, until: nowMs };
  if (params.compare) {
    plan.previous = { since: since - rangeDays * DAY_MS, until: since - 1 };
  }
  return plan;
}

/** Local calendar window covered by a span, for labeling the previous period in the response. */
export function describeSpanWindow(span: UsageQuerySpan, tzOffsetMs: number): AppUsageWindow {
  return (
    span.window ?? {
      from: dayIndexToDate(Math.floor((span.since + tzOffsetMs) / DAY_MS)),
      to: dayIndexToDate(Math.floor((span.until + tzOffsetMs) / DAY_MS)),
    }
  );
}
