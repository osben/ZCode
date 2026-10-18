import {
  APP_USAGE_MAX_WINDOW_DAYS,
  type AppUsageDailyModelUsage,
  type AppUsageFilters,
} from "@zcode/shared";
import type { AppUsageStatsQuery } from "@/hooks/useUsageStats.js";

export const APP_USAGE_PRESETS = ["7d", "30d", "90d", "1y", "all", "custom"] as const;
export type AppUsagePreset = (typeof APP_USAGE_PRESETS)[number];
export type AppUsageGranularity = "day" | "week" | "month";

const DAY_MS = 86_400_000;
const PRESET_WINDOW_DAYS: Record<"90d" | "1y", number> = { "90d": 90, "1y": 365 };
const AUTO_DAILY_MAX_DAYS = 45;
const AUTO_WEEKLY_MAX_DAYS = 200;
/** Granularity switching is pointless for short windows. */
export const APP_USAGE_GRANULARITY_MIN_DAYS = 15;

export type CustomRangeValidation = "ok" | "incomplete" | "order" | "future" | "tooLong";

function dateToDayIndex(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year!, month! - 1, day!) / DAY_MS);
}

function dayIndexToDate(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && dayIndexToDate(dateToDayIndex(value)) === value;
}

/** Local calendar date of `date` as YYYY-MM-DD, using the browser time zone. */
export function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftLocalDate(value: string, days: number): string {
  return dayIndexToDate(dateToDayIndex(value) + days);
}

export function validateCustomRange(
  from: string,
  to: string,
  today: string,
): CustomRangeValidation {
  if (!isCalendarDate(from) || !isCalendarDate(to)) return "incomplete";
  if (dateToDayIndex(from) > dateToDayIndex(to)) return "order";
  if (dateToDayIndex(to) > dateToDayIndex(today)) return "future";
  if (dateToDayIndex(to) - dateToDayIndex(from) + 1 > APP_USAGE_MAX_WINDOW_DAYS) return "tooLong";
  return "ok";
}

/**
 * Request fields for a selection. Presets 7d/30d (and all-time) keep the legacy request shape; the
 * longer presets and custom ranges use the additive `window`. Returns null for an invalid custom range.
 */
export function buildAppUsageQuery(input: {
  preset: AppUsagePreset;
  customFrom: string;
  customTo: string;
  compare: boolean;
  today: string;
  filters?: AppUsageFilters;
}): AppUsageStatsQuery | null {
  const { preset, compare, today } = input;
  const filters = compactFilters(input.filters);
  const extras = filters ? { filters } : {};
  if (preset === "all") {
    return { range: "all", ...extras };
  }
  if (preset === "7d" || preset === "30d") {
    return { range: preset, ...(compare ? { compare: true } : {}), ...extras };
  }
  if (preset === "custom") {
    if (validateCustomRange(input.customFrom, input.customTo, today) !== "ok") {
      return null;
    }
    return {
      range: "all",
      window: { from: input.customFrom, to: input.customTo },
      ...(compare ? { compare: true } : {}),
      ...extras,
    };
  }
  return {
    range: "all",
    window: { from: shiftLocalDate(today, 1 - PRESET_WINDOW_DAYS[preset]), to: today },
    ...(compare ? { compare: true } : {}),
    ...extras,
  };
}

/** Drops empty lists so an untouched filter bar produces the legacy request shape. */
export function compactFilters(filters: AppUsageFilters | undefined): AppUsageFilters | undefined {
  if (!filters) return undefined;
  const entries = (
    Object.entries(filters) as Array<[keyof AppUsageFilters, string[] | undefined]>
  ).filter(([, values]) => values && values.length > 0);
  return entries.length > 0 ? (Object.fromEntries(entries) as AppUsageFilters) : undefined;
}

export function resolveAutoGranularity(dayCount: number): AppUsageGranularity {
  if (dayCount <= AUTO_DAILY_MAX_DAYS) return "day";
  if (dayCount <= AUTO_WEEKLY_MAX_DAYS) return "week";
  return "month";
}

/** First day of the bucket holding `date` (weeks start on Sunday like the heatmap; months on the 1st). */
export function bucketStartDate(date: string, granularity: AppUsageGranularity): string {
  if (granularity === "day") return date;
  if (granularity === "month") return `${date.slice(0, 7)}-01`;
  const dayIndex = dateToDayIndex(date);
  // 1970-01-01 (day index 0) was a Thursday.
  const weekday = (((dayIndex + 4) % 7) + 7) % 7;
  return dayIndexToDate(dayIndex - weekday);
}

export function bucketDailyModelUsage(
  daily: readonly AppUsageDailyModelUsage[],
  granularity: AppUsageGranularity,
): AppUsageDailyModelUsage[] {
  if (granularity === "day") {
    return [...daily];
  }
  const buckets = new Map<string, Map<string, number>>();
  for (const day of daily) {
    const key = bucketStartDate(day.date, granularity);
    const models = buckets.get(key) ?? new Map<string, number>();
    for (const model of day.models) {
      const modelKey = model.modelId ?? "\u0000unknown";
      models.set(modelKey, (models.get(modelKey) ?? 0) + model.totalTokens);
    }
    buckets.set(key, models);
  }
  return [...buckets.entries()].map(([date, models]) => ({
    date,
    models: [...models.entries()].map(([modelKey, totalTokens]) => ({
      modelId: modelKey === "\u0000unknown" ? null : modelKey,
      totalTokens,
    })),
  }));
}

/** Sums `values` into the same buckets that `dates` produce, so a previous-period series lines up. */
export function bucketNumberSeries(
  dates: readonly string[],
  values: readonly number[],
  granularity: AppUsageGranularity,
): number[] {
  if (granularity === "day") {
    return dates.map((_, index) => values[index] ?? 0);
  }
  const sums = new Map<string, number>();
  dates.forEach((date, index) => {
    const key = bucketStartDate(date, granularity);
    sums.set(key, (sums.get(key) ?? 0) + (values[index] ?? 0));
  });
  return [...sums.values()];
}

export interface AppUsageDelta {
  direction: "up" | "down" | "flat";
  /** Absolute change in percent, rounded; null when the previous value was zero. */
  percent: number | null;
}

export function computeAppUsageDelta(current: number, previous: number): AppUsageDelta | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) {
    return current === 0 ? { direction: "flat", percent: 0 } : { direction: "up", percent: null };
  }
  const percent = Math.round((Math.abs(current - previous) / Math.abs(previous)) * 100);
  if (current === previous || percent === 0) return { direction: "flat", percent: 0 };
  return { direction: current > previous ? "up" : "down", percent };
}
