import { RefreshCcw } from "lucide-react";
import { Fragment, lazy, useEffect, useMemo, useState } from "react";
import type { AppUsageFilters, AppUsageSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { type AppUsageStatsQuery, useAppUsageStats } from "@/hooks/useUsageStats.js";
import { AppUsageActivityPatterns } from "@/settings/usage-stats/AppUsageActivityPatterns.js";
import { AppUsageDetailMetrics } from "@/settings/usage-stats/AppUsageDetailMetrics.js";
import { AppUsageExportButtons } from "@/settings/usage-stats/AppUsageExportButtons.js";
import { AppUsageFilterBar } from "@/settings/usage-stats/AppUsageFilterBar.js";
import { AppUsageRangeControls } from "@/settings/usage-stats/AppUsageRangeControls.js";
import { AppUsageToolsTable } from "@/settings/usage-stats/AppUsageToolsTable.js";
import { AppUsageTopSessions } from "@/settings/usage-stats/AppUsageTopSessions.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";
import { UsageHeatmap } from "@/settings/usage-stats/UsageHeatmap.js";
import { UsageStatsErrorNotice } from "@/settings/usage-stats/UsageStatsErrorNotice.js";
import {
  APP_USAGE_GRANULARITY_MIN_DAYS,
  type AppUsageGranularity,
  type AppUsagePreset,
  bucketDailyModelUsage,
  bucketNumberSeries,
  buildAppUsageQuery,
  formatLocalDate,
  resolveEffectiveGranularity,
  shiftLocalDate,
  validateCustomRange,
} from "@/settings/usage-stats/appUsageRangeViewModel.js";
import {
  UsageEmptyState,
  formatCompactNumber,
  formatSummaryCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

// Recharts triggers decimal.js-light's LN10 validation during module initialization,
// which blocks the entire renderer startup in Electron Linux containers. Loading charts on demand keeps
// normal startup and the E2E home page independent of Usage-page chart dependencies; opening Usage also isolates them behind a local boundary.
const AppUsageDailyModelTrendChart = lazy(() =>
  import("@/settings/usage-stats/AppUsageDailyModelTrendChart.js").then((module) => ({
    default: module.AppUsageDailyModelTrendChart,
  })),
);
const AppUsageModelUsagePieChart = lazy(() =>
  import("@/settings/usage-stats/AppUsageModelUsagePieChart.js").then((module) => ({
    default: module.AppUsageModelUsagePieChart,
  })),
);

const DEFAULT_CUSTOM_RANGE_DAYS = 30;

export function AppUsagePanel() {
  const { intl, locale } = useZCodeIntl();
  const [preset, setPreset] = useState<AppUsagePreset>("7d");
  const [today, setToday] = useState(() => formatLocalDate(new Date()));
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [compare, setCompare] = useState(false);
  const [granularityOverride, setGranularityOverride] = useState<AppUsageGranularity | null>(null);
  const [filters, setFilters] = useState<AppUsageFilters>({});

  const { snapshot: lifetimeSnapshot, refresh: refreshLifetime } = useAppUsageStats("all");
  // Hosts that return facets also understand the extra breakdowns; older hosts never see the field.
  const supportsExtras = Boolean(lifetimeSnapshot?.facets);

  const builtQuery = buildAppUsageQuery({
    preset,
    customFrom,
    customTo,
    compare,
    today,
    filters,
    withBreakdowns: supportsExtras,
  });
  const builtQueryKey = JSON.stringify(builtQuery);
  // An invalid custom range must not blank the page: keep requesting (and showing) the last valid query.
  const [query, setQuery] = useState<AppUsageStatsQuery>(() => builtQuery ?? { range: "7d" });
  useEffect(() => {
    const next = JSON.parse(builtQueryKey) as AppUsageStatsQuery | null;
    if (next) {
      setQuery(next);
    }
  }, [builtQueryKey]);

  const { snapshot, loading, error, refresh } = useAppUsageStats(query);

  // Drilling into a heatmap day is just a one-day custom range.
  const handleSelectDate = (date: string) => {
    setCustomFrom(date);
    setCustomTo(date);
    setGranularityOverride(null);
    setPreset("custom");
  };

  const handlePresetChange = (next: AppUsagePreset) => {
    if (next === "custom" && !customFrom && !customTo) {
      setCustomTo(today);
      setCustomFrom(shiftLocalDate(today, 1 - DEFAULT_CUSTOM_RANGE_DAYS));
    }
    // A manual interval belongs to the range it was chosen for.
    setGranularityOverride(null);
    setPreset(next);
  };

  const dayCount = snapshot?.dailyModelUsage.length ?? 0;
  const granularity = resolveEffectiveGranularity(granularityOverride, dayCount);
  const chartSnapshot = useMemo(
    () =>
      snapshot
        ? {
            ...snapshot,
            dailyModelUsage: bucketDailyModelUsage(snapshot.dailyModelUsage, granularity),
          }
        : null,
    [snapshot, granularity],
  );
  const previousDailyTotals = useMemo(
    () =>
      snapshot?.previous
        ? bucketNumberSeries(
            snapshot.dailyModelUsage.map((day) => day.date),
            snapshot.previous.dailyTokens,
            granularity,
          )
        : undefined,
    [snapshot, granularity],
  );

  const rangeControls = (
    <AppUsageRangeControls
      preset={preset}
      onPresetChange={handlePresetChange}
      customFrom={customFrom}
      customTo={customTo}
      onCustomChange={({ from, to }) => {
        setCustomFrom(from);
        setCustomTo(to);
      }}
      customValidation={validateCustomRange(customFrom, customTo, today)}
      today={today}
      compare={compare}
      onCompareChange={setCompare}
      granularity={granularity}
      onGranularityChange={setGranularityOverride}
      showGranularity={dayCount >= APP_USAGE_GRANULARITY_MIN_DAYS}
    />
  );
  // Filter options come from the all-time snapshot; hosts without the rollup omit them, hiding the bar.
  const filterBar = lifetimeSnapshot?.facets ? (
    <AppUsageFilterBar facets={lifetimeSnapshot.facets} filters={filters} onChange={setFilters} />
  ) : null;

  if (loading && !snapshot) {
    return (
      <div className="space-y-5">
        <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
        {rangeControls}
        {filterBar}
        {/* Bugfix: App Usage aggregates only local session history; it cannot reuse the Coding Plan monitor API loading description. */}
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.appUsageLoadingDescription",
          })}
        />
      </div>
    );
  }

  if (!snapshot || !chartSnapshot) {
    return (
      <div className="space-y-5">
        <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
        {rangeControls}
        {filterBar}
        {error ? <UsageStatsErrorNotice error={error} /> : null}
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <AppUsageLifetimeSummaryStrip snapshot={lifetimeSnapshot} />
      {lifetimeSnapshot?.heatmap.weeks.length ? (
        <UsageHeatmap
          locale={locale}
          intl={intl}
          weeks={lifetimeSnapshot.heatmap.weeks}
          onSelectDate={handleSelectDate}
        />
      ) : null}
      {rangeControls}
      {filterBar}
      {error ? <UsageStatsErrorNotice error={error} /> : null}

      <UsageChartLoadBoundary
        scope="settings.usage.app-daily-model-chart"
        resetKeys={[snapshot.range, snapshot.generatedAt]}
        loadingDescription={intl.formatMessage({
          id: "settings.usage.appUsageLoadingDescription",
        })}
      >
        <AppUsageDailyModelTrendChart
          snapshot={chartSnapshot}
          previousDailyTotals={previousDailyTotals}
        />
      </UsageChartLoadBoundary>
      <AppUsageDetailMetrics snapshot={snapshot} />
      <UsageChartLoadBoundary
        scope="settings.usage.app-model-pie-chart"
        resetKeys={[snapshot.range, snapshot.generatedAt, "model-pie"]}
        loadingDescription={intl.formatMessage({
          id: "settings.usage.appUsageLoadingDescription",
        })}
      >
        <AppUsageModelUsagePieChart snapshot={snapshot} />
      </UsageChartLoadBoundary>
      <AppUsageToolsTable snapshot={snapshot} />
      <AppUsageActivityPatterns hourlyTokens={snapshot.hourlyTokens} />
      <AppUsageTopSessions snapshot={snapshot} />

      <div className="flex flex-wrap justify-end gap-2">
        <AppUsageExportButtons snapshot={snapshot} query={query} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-md bg-background"
          onClick={() => {
            // Roll the "today" anchor forward if the window stayed open past midnight.
            setToday(formatLocalDate(new Date()));
            void Promise.all([refresh(), refreshLifetime()]);
          }}
        >
          <RefreshCcw className="size-3.5" />
          {intl.formatMessage({ id: "settings.usage.refresh" })}
        </Button>
      </div>
    </div>
  );
}

export function AppUsageLifetimeSummaryStrip({ snapshot }: { snapshot: AppUsageSnapshot | null }) {
  const { intl, locale } = useZCodeIntl();
  const items = [
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimeTotalTokens" }),
      value: snapshot ? formatSummaryCompactTokenUsage(locale, snapshot.summary.totalTokens) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimePeakTokens" }),
      value: snapshot
        ? formatSummaryCompactTokenUsage(locale, snapshot.summary.peakDayTokens)
        : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestSession" }),
      value: snapshot ? formatAppUsageDuration(snapshot.summary.longestSessionMs, intl) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.currentStreak" }),
      value: snapshot ? formatAppUsageDays(snapshot.summary.currentStreakDays, intl, locale) : "--",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestStreak" }),
      value: snapshot ? formatAppUsageDays(snapshot.summary.longestStreakDays, intl, locale) : "--",
    },
  ];

  return (
    <section className="flex flex-col overflow-hidden rounded-xl bg-surface sm:flex-row sm:items-center">
      {items.map((item, index) => (
        <Fragment key={item.label}>
          {index > 0 ? (
            <div aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
          ) : null}
          <div className="min-w-0 flex-1 px-4 py-3 text-center">
            <div className="truncate text-ui-lg font-medium text-foreground">{item.value}</div>
            <div className="mt-1 truncate text-ui-base text-foreground-subtle">{item.label}</div>
          </div>
        </Fragment>
      ))}
    </section>
  );
}

function formatAppUsageDays(
  days: number,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  locale: string,
): string {
  return `${formatCompactNumber(locale, days)} ${intl.formatMessage({
    id: "settings.usage.duration.day",
  })}`;
}

export function formatAppUsageDuration(
  durationMs: number,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  const totalMinutes = Math.max(0, Math.floor(durationMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days} ${intl.formatMessage({ id: "settings.usage.duration.day" })}`);
  }
  if (hours > 0) {
    parts.push(`${hours} ${intl.formatMessage({ id: "settings.usage.duration.hour" })}`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${intl.formatMessage({ id: "settings.usage.duration.minute" })}`);
  }
  return parts.join(" ");
}
