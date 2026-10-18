import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { AppUsageSnapshot } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  APP_USAGE_TOOLS_COLLAPSED_COUNT,
  formatAppUsageLatency,
  resolveVisibleAppUsageTools,
} from "@/settings/usage-stats/appUsageDetailViewModel.js";
import { formatCompactNumber, formatPercent } from "@/settings/usage-stats/usageStatsUiParts.js";

const TOOLS_GRID_CLASS =
  "grid grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_4rem] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_4.5rem_6rem_5rem]";

export function AppUsageToolsTable({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const { tools } = snapshot;
  if (tools.length === 0) {
    return null;
  }
  const visibleTools = resolveVisibleAppUsageTools(tools, expanded);
  const canToggle = tools.length > APP_USAGE_TOOLS_COLLAPSED_COUNT;

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.appToolsTitle" })}
      </h3>
      <div role="table" className="min-w-0">
        <div
          role="row"
          className={cn(TOOLS_GRID_CLASS, "pb-2 text-ui-sm font-medium text-foreground-subtle")}
        >
          <span role="columnheader" className="truncate">
            {intl.formatMessage({ id: "settings.usage.appToolsColumn.tool" })}
          </span>
          <span role="columnheader" className="truncate text-right">
            {intl.formatMessage({ id: "settings.usage.calls" })}
          </span>
          <span role="columnheader" className="truncate text-right">
            {intl.formatMessage({ id: "settings.usage.appToolsColumn.errors" })}
          </span>
          <span role="columnheader" className="truncate text-right">
            {intl.formatMessage({ id: "settings.usage.appToolsColumn.avgDuration" })}
          </span>
        </div>
        {visibleTools.map((tool) => (
          <div
            key={tool.toolName}
            role="row"
            className={cn(TOOLS_GRID_CLASS, "border-t border-border/70 py-2 text-ui-sm")}
          >
            <span
              role="cell"
              className="min-w-0 truncate font-mono text-foreground"
              title={tool.toolName}
            >
              {tool.toolName}
            </span>
            <span role="cell" className="text-right font-mono text-foreground tabular-nums">
              {formatCompactNumber(locale, tool.callCount)}
            </span>
            <span
              role="cell"
              className={cn(
                "truncate text-right font-mono tabular-nums",
                tool.errorCount > 0 ? "text-destructive" : "text-foreground-subtle",
              )}
            >
              {tool.errorCount > 0
                ? `${formatCompactNumber(locale, tool.errorCount)} (${formatPercent(locale, tool.errorRate)})`
                : "0"}
            </span>
            <span role="cell" className="text-right font-mono text-foreground-subtle tabular-nums">
              {formatAppUsageLatency(locale, tool.avgDurationMs)}
            </span>
          </div>
        ))}
      </div>
      {canToggle ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="flex items-center gap-1 text-ui-sm text-foreground-subtle hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
          {expanded
            ? intl.formatMessage({ id: "settings.usage.appToolsShowLess" })
            : intl.formatMessage({ id: "settings.usage.appToolsShowAll" }, { count: tools.length })}
        </button>
      ) : null}
    </section>
  );
}
