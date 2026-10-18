import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Database,
  Timer,
  TriangleAlert,
  Wrench,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AppUsageSnapshot } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  extractAppUsageDetailValues,
  formatAppUsageLatency,
  resolveAppUsageDetailValues,
  type AppUsageDetailValues,
} from "@/settings/usage-stats/appUsageDetailViewModel.js";
import {
  computeAppUsageDelta,
  type AppUsageDelta,
} from "@/settings/usage-stats/appUsageRangeViewModel.js";
import {
  UsageMetricCard,
  formatCompactNumber,
  formatCompactTokenUsage,
  formatPercent,
} from "@/settings/usage-stats/usageStatsUiParts.js";

const DELTA_GLYPH = { up: "▲", down: "▼", flat: "–" } as const;

/** Neutral comparison note: an increase is not inherently good or bad, so no semantic colors. */
function DeltaNote({ delta, title }: { delta: AppUsageDelta | null; title: string }) {
  const { locale } = useZCodeIntl();
  if (!delta) {
    return null;
  }
  const percent =
    delta.percent === null
      ? ""
      : ` ${new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(delta.percent / 100)}`;
  return (
    <span
      className="shrink-0 font-mono text-ui-sm text-foreground-subtle tabular-nums"
      title={title}
    >
      {DELTA_GLYPH[delta.direction]}
      {percent}
    </span>
  );
}

export function AppUsageDetailMetrics({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const values = resolveAppUsageDetailValues(snapshot);
  if (!values) {
    return null;
  }
  const previous = snapshot.previous
    ? extractAppUsageDetailValues(snapshot.previous.summary)
    : null;
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  const compareTitle = intl.formatMessage({ id: "settings.usage.compare.vsPrevious" });
  const note = (pick: (value: AppUsageDetailValues) => number | null): ReactNode => {
    if (!previous) {
      return undefined;
    }
    const current = pick(values);
    const before = pick(previous);
    return current === null || before === null ? undefined : (
      <DeltaNote delta={computeAppUsageDelta(current, before)} title={compareTitle} />
    );
  };

  return (
    <section className="space-y-3">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.detailsTitle" })}
      </h3>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <UsageMetricCard
          icon={ArrowDownToLine}
          label={intl.formatMessage({ id: "settings.usage.detail.inputTokens" })}
          value={`${formatCompactTokenUsage(locale, values.inputTokens)} ${tokenUnit}`}
          trailing={note((value) => value.inputTokens)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={ArrowUpFromLine}
          label={intl.formatMessage({ id: "settings.usage.detail.outputTokens" })}
          value={`${formatCompactTokenUsage(locale, values.outputTokens)} ${tokenUnit}`}
          helper={
            values.reasoningTokens > 0
              ? intl.formatMessage(
                  { id: "settings.usage.detail.reasoningHelper" },
                  { tokens: formatCompactTokenUsage(locale, values.reasoningTokens) },
                )
              : undefined
          }
          trailing={note((value) => value.outputTokens)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={Database}
          label={intl.formatMessage({ id: "settings.usage.detail.cacheHitRate" })}
          value={formatPercent(locale, values.cacheHitRate)}
          helper={intl.formatMessage(
            { id: "settings.usage.detail.cacheHelper" },
            { tokens: formatCompactTokenUsage(locale, values.cacheReadTokens) },
          )}
          trailing={note((value) => value.cacheHitRate)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={Timer}
          label={intl.formatMessage({ id: "settings.usage.detail.avgTurnDuration" })}
          value={formatAppUsageLatency(locale, values.avgTurnDurationMs)}
          trailing={note((value) => value.avgTurnDurationMs)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={Zap}
          label={intl.formatMessage({ id: "settings.usage.detail.avgFirstToken" })}
          value={formatAppUsageLatency(locale, values.avgTimeToFirstTokenMs)}
          trailing={note((value) => value.avgTimeToFirstTokenMs)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={Wrench}
          label={intl.formatMessage({ id: "settings.usage.detail.toolCalls" })}
          value={formatCompactNumber(locale, values.toolCallCount)}
          trailing={note((value) => value.toolCallCount)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={TriangleAlert}
          label={intl.formatMessage({ id: "settings.usage.detail.toolErrorRate" })}
          value={formatPercent(locale, values.toolErrorRate)}
          trailing={note((value) => value.toolErrorRate)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={TriangleAlert}
          label={intl.formatMessage({ id: "settings.usage.detail.modelErrorRate" })}
          value={formatPercent(locale, values.modelErrorRate)}
          trailing={note((value) => value.modelErrorRate)}
          valueSize="lg"
        />
      </div>
    </section>
  );
}
