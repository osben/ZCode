import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  HOURLY_HOURS,
  findBusiestHour,
  formatHourLabel,
  hasHourlyActivity,
  hourlyLevel,
  weekdayLabels,
} from "@/settings/usage-stats/appUsagePatternsViewModel.js";
import { formatCompactTokenUsage } from "@/settings/usage-stats/usageStatsUiParts.js";

const AXIS_HOURS = new Set([0, 6, 12, 18]);
const GRID_STYLE = {
  gridTemplateColumns: `2.25rem repeat(${HOURLY_HOURS}, minmax(0, 1fr))`,
} as const;

export function AppUsageActivityPatterns({
  hourlyTokens,
}: {
  hourlyTokens: readonly number[] | undefined;
}) {
  const { intl, locale } = useZCodeIntl();
  if (!hasHourlyActivity(hourlyTokens)) {
    return null;
  }
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  const weekdays = weekdayLabels(locale);
  const maxTokens = Math.max(...hourlyTokens);
  const busiest = findBusiestHour(hourlyTokens);

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.hourly.title" })}
        </h3>
        {busiest ? (
          <span className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.usage.hourly.busiest" },
              {
                weekday: weekdays[busiest.weekday] ?? "",
                hour: `${formatHourLabel(busiest.hour)}:00`,
              },
            )}
          </span>
        ) : null}
      </div>
      <div role="table" aria-label={intl.formatMessage({ id: "settings.usage.hourly.title" })}>
        {weekdays.map((weekday, weekdayIndex) => (
          <div key={weekday} role="row" className="mb-0.5 grid gap-x-0.5" style={GRID_STYLE}>
            <span role="rowheader" className="truncate pr-1 text-ui-sm text-foreground-subtle">
              {weekday}
            </span>
            {Array.from({ length: HOURLY_HOURS }, (_, hour) => {
              const tokens = hourlyTokens[weekdayIndex * HOURLY_HOURS + hour] ?? 0;
              return (
                <div
                  key={hour}
                  role="cell"
                  title={`${weekday} ${formatHourLabel(hour)}:00 - ${formatCompactTokenUsage(locale, tokens)} ${tokenUnit}`}
                  className="aspect-square min-w-0 rounded-[3px] border border-transparent hover:border-border-hover"
                  style={{
                    backgroundColor: `var(--color-usage-heatmap-${hourlyLevel(tokens, maxTokens)})`,
                  }}
                />
              );
            })}
          </div>
        ))}
        <div className="mt-1 grid gap-x-0.5" style={GRID_STYLE} aria-hidden="true">
          <span />
          {Array.from({ length: HOURLY_HOURS }, (_, hour) => (
            <span
              key={hour}
              className="min-w-0 overflow-visible whitespace-nowrap text-ui-xs text-foreground-subtle"
            >
              {AXIS_HOURS.has(hour) ? formatHourLabel(hour) : ""}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
