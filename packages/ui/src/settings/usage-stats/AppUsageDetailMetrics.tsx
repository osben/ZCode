import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Database,
  Timer,
  TriangleAlert,
  Wrench,
  Zap,
} from "lucide-react";
import type { AppUsageSnapshot } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatAppUsageLatency,
  resolveAppUsageDetailValues,
} from "@/settings/usage-stats/appUsageDetailViewModel.js";
import {
  UsageMetricCard,
  formatCompactNumber,
  formatCompactTokenUsage,
  formatPercent,
} from "@/settings/usage-stats/usageStatsUiParts.js";

export function AppUsageDetailMetrics({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const values = resolveAppUsageDetailValues(snapshot);
  if (!values) {
    return null;
  }
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });

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
          valueSize="lg"
        />
        <UsageMetricCard
          icon={Timer}
          label={intl.formatMessage({ id: "settings.usage.detail.avgTurnDuration" })}
          value={formatAppUsageLatency(locale, values.avgTurnDurationMs)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={Zap}
          label={intl.formatMessage({ id: "settings.usage.detail.avgFirstToken" })}
          value={formatAppUsageLatency(locale, values.avgTimeToFirstTokenMs)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={Wrench}
          label={intl.formatMessage({ id: "settings.usage.detail.toolCalls" })}
          value={formatCompactNumber(locale, values.toolCallCount)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={TriangleAlert}
          label={intl.formatMessage({ id: "settings.usage.detail.toolErrorRate" })}
          value={formatPercent(locale, values.toolErrorRate)}
          valueSize="lg"
        />
        <UsageMetricCard
          icon={TriangleAlert}
          label={intl.formatMessage({ id: "settings.usage.detail.modelErrorRate" })}
          value={formatPercent(locale, values.modelErrorRate)}
          valueSize="lg"
        />
      </div>
    </section>
  );
}
