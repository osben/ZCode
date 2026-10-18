import type { AppUsageSnapshot } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatAppUsageLatency } from "@/settings/usage-stats/appUsageDetailViewModel.js";
import {
  formatCompactNumber,
  formatCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

const SESSIONS_GRID_CLASS =
  "grid grid-cols-[minmax(0,1fr)_4.5rem_3rem] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_8rem_5rem_3.5rem_5rem]";

function folderName(workspaceKey: string): string {
  const trimmed = workspaceKey.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function AppUsageTopSessions({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const sessions = snapshot.topSessions ?? [];
  if (sessions.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.sessions.title" })}
      </h3>
      <div role="table" className="min-w-0">
        <div
          role="row"
          className={cn(SESSIONS_GRID_CLASS, "pb-2 text-ui-sm font-medium text-foreground-subtle")}
        >
          <span role="columnheader" className="truncate">
            {intl.formatMessage({ id: "settings.usage.sessions.column.session" })}
          </span>
          <span role="columnheader" className="hidden truncate sm:block">
            {intl.formatMessage({ id: "settings.usage.sessions.column.workspace" })}
          </span>
          <span role="columnheader" className="truncate text-right">
            {intl.formatMessage({ id: "settings.usage.sessions.column.tokens" })}
          </span>
          <span role="columnheader" className="truncate text-right">
            {intl.formatMessage({ id: "settings.usage.sessions.column.turns" })}
          </span>
          <span role="columnheader" className="hidden truncate text-right sm:block">
            {intl.formatMessage({ id: "settings.usage.sessions.column.time" })}
          </span>
        </div>
        {sessions.map((session) => (
          <div
            key={session.sessionId}
            role="row"
            className={cn(SESSIONS_GRID_CLASS, "border-t border-border/70 py-2 text-ui-sm")}
          >
            <span
              role="cell"
              className="min-w-0 truncate text-foreground"
              title={session.title ?? ""}
            >
              {session.title?.trim() ||
                intl.formatMessage({ id: "settings.usage.sessions.untitled" })}
            </span>
            <span
              role="cell"
              className="hidden min-w-0 truncate font-mono text-foreground-subtle sm:block"
              title={session.workspaceKey}
            >
              {session.workspaceKey ? folderName(session.workspaceKey) : "--"}
            </span>
            <span role="cell" className="text-right font-mono text-foreground tabular-nums">
              {formatCompactTokenUsage(locale, session.totalTokens)}
            </span>
            <span role="cell" className="text-right font-mono text-foreground-subtle tabular-nums">
              {formatCompactNumber(locale, session.turnCount)}
            </span>
            <span
              role="cell"
              className="hidden text-right font-mono text-foreground-subtle tabular-nums sm:block"
            >
              {formatAppUsageLatency(locale, session.durationMs)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
