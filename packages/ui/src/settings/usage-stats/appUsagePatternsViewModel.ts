import type { AppUsageSnapshot } from "@zcode/shared";

export const HOURLY_WEEKDAYS = 7;
export const HOURLY_HOURS = 24;

export type HourlyLevel = 0 | 1 | 2 | 3 | 4;

export interface BusiestHour {
  weekday: number;
  hour: number;
  tokens: number;
}

/** Same thresholds as the daily heatmap so the two grids read alike. */
export function hourlyLevel(tokens: number, max: number): HourlyLevel {
  if (tokens <= 0 || max <= 0) return 0;
  const ratio = tokens / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

export function findBusiestHour(cells: readonly number[]): BusiestHour | null {
  let best: BusiestHour | null = null;
  cells.forEach((tokens, index) => {
    if (tokens > 0 && (!best || tokens > best.tokens)) {
      best = {
        weekday: Math.floor(index / HOURLY_HOURS),
        hour: index % HOURLY_HOURS,
        tokens,
      };
    }
  });
  return best;
}

export function hasHourlyActivity(cells: readonly number[] | undefined): cells is number[] {
  return Boolean(
    cells && cells.length === HOURLY_WEEKDAYS * HOURLY_HOURS && cells.some((v) => v > 0),
  );
}

/** Short weekday names, Sunday first, in the active locale. */
export function weekdayLabels(locale: string): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: HOURLY_WEEKDAYS }, (_, index) =>
    formatter.format(new Date(Date.UTC(2023, 0, 1 + index))),
  );
}

export function formatHourLabel(hour: number): string {
  return String(hour).padStart(2, "0");
}

const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvCell(value: string | number): string {
  if (typeof value === "number") {
    return String(value);
  }
  // Text beginning with a formula trigger is neutralized so spreadsheets do not execute it.
  const safe = CSV_FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Long-format daily usage: one row per day and model that has tokens. */
export function buildUsageCsv(snapshot: AppUsageSnapshot, unknownModelLabel: string): string {
  const rows: Array<Array<string | number>> = [["date", "model", "tokens"]];
  for (const day of snapshot.dailyModelUsage) {
    for (const model of day.models) {
      if (model.totalTokens > 0) {
        rows.push([day.date, model.modelId?.trim() || unknownModelLabel, model.totalTokens]);
      }
    }
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function buildUsageJson(
  snapshot: AppUsageSnapshot,
  query: unknown,
  exportedAt: Date,
): string {
  const { heatmap: _heatmap, ...exported } = snapshot;
  return `${JSON.stringify({ exportedAt: exportedAt.toISOString(), query, ...exported }, null, 2)}\n`;
}

export function usageExportFileName(snapshot: AppUsageSnapshot, extension: "csv" | "json"): string {
  const first = snapshot.dailyModelUsage[0]?.date;
  const last = snapshot.dailyModelUsage.at(-1)?.date;
  const span = first && last ? `${first}_${last}` : snapshot.range;
  return `zcode-usage-${span}.${extension}`;
}
