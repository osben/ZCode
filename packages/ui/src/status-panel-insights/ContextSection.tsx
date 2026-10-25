import { useMemo } from "react";
import type { ZCodeContextBudgetTone, ZCodeContextUsageBreakdownItem } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  buildContextUsageBreakdownSegments,
  buildContextUsageProgressSegments,
  formatContextUsageTokenCount,
} from "@/chat-input-toolbar/contextUsage.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ContextSectionModel } from "./contract.js";

// Labels come from the composer popover's keys; that map is private to an upstream file.
const BREAKDOWN_LABEL_ID: Record<ZCodeContextUsageBreakdownItem["source"], string> = {
  messages: "chat.contextUsage.breakdown.messages",
  system_prompt: "chat.contextUsage.breakdown.systemPrompt",
  meta_user_context: "chat.contextUsage.breakdown.metaUserContext",
  skills: "chat.contextUsage.breakdown.skills",
  tool_prompt: "chat.contextUsage.breakdown.toolPrompt",
  system_tool_schemas: "chat.contextUsage.breakdown.systemTools",
  mcp_tool_schemas: "chat.contextUsage.breakdown.mcpTools",
};

const TONE_TEXT_CLASS: Record<ZCodeContextBudgetTone, string | null> = {
  normal: null,
  warning: "text-warning",
  critical: "text-destructive",
};

const TONE_FILL: Record<ZCodeContextBudgetTone, string> = {
  normal: "var(--color-usage-chart-1)",
  warning: "var(--color-warning)",
  critical: "var(--color-destructive)",
};

function usePercentFormatter() {
  const { locale } = useZCodeIntl();
  return useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0, style: "percent" }),
    [locale],
  );
}

/** Header status content: the used percentage, coloured by the composer's tone rule. */
export function ContextSectionTrailing({ model }: { model: ContextSectionModel }) {
  const percent = usePercentFormatter();
  return (
    <span
      data-status-panel-context-percent={model.tone}
      className={cn("tabular-nums", TONE_TEXT_CLASS[model.tone])}
    >
      {percent.format(model.usedRatio)}
    </span>
  );
}

export function ContextSectionBody({ model }: { model: ContextSectionModel }) {
  const { intl, locale } = useZCodeIntl();
  const percent = usePercentFormatter();
  const segments = useMemo(
    () =>
      model.breakdown ? buildContextUsageBreakdownSegments(model.breakdown, model.usedTokens) : [],
    [model.breakdown, model.usedTokens],
  );
  const progressSegments = useMemo(() => buildContextUsageProgressSegments(segments), [segments]);
  const tokens = (value: number) => formatContextUsageTokenCount(value, locale);
  // Breakdown colours only describe composition; a warning/critical budget overrides them with the tone fill.
  const showBreakdownFill = model.tone === "normal" && progressSegments.length > 0;

  return (
    <div data-status-panel-context="body" className="flex flex-col gap-2 px-2 pb-1 pt-1">
      <div
        role="progressbar"
        aria-label={intl.formatMessage({ id: "chat.statusPanel.context" })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(model.usedRatio * 100)}
        className="relative h-1.5 w-full rounded-full bg-[var(--color-surface)]"
      >
        <div
          className="flex h-full overflow-hidden rounded-full"
          style={{ width: `${model.usedRatio * 100}%` }}
        >
          {showBreakdownFill ? (
            progressSegments.map((segment) => (
              <span
                key={segment.id}
                className="h-full"
                style={{ ...segment.style, width: `${segment.percent * 100}%` }}
              />
            ))
          ) : (
            <span className="h-full w-full" style={{ backgroundColor: TONE_FILL[model.tone] }} />
          )}
        </div>
        {model.autoCompactThresholdTokens !== null ? (
          <span
            data-status-panel-context-threshold="true"
            aria-hidden="true"
            className="absolute -top-0.5 h-2.5 w-0.5 -translate-x-1/2 rounded-full bg-[var(--color-foreground-subtle)]"
            style={{
              left: `${Math.min(model.autoCompactThresholdTokens / model.maxTokens, 1) * 100}%`,
            }}
          />
        ) : null}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2 text-ui-sm text-[var(--color-foreground-subtle)]">
        <span className="shrink-0 tabular-nums">
          {`${tokens(model.usedTokens)} / ${tokens(model.maxTokens)}`}
        </span>
        {model.tokensUntilAutoCompact !== null ? (
          <span className={cn("min-w-0 truncate", TONE_TEXT_CLASS[model.tone])}>
            {intl.formatMessage(
              { id: "chat.statusPanel.contextUntilAutoCompact" },
              { tokens: tokens(model.tokensUntilAutoCompact) },
            )}
          </span>
        ) : null}
      </div>
      {segments.length > 0 ? (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-ui-sm">
          {segments.map((segment, index) => (
            <li key={segment.source} className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-sm"
                style={progressSegments[index]?.style}
              />
              <span className="min-w-0 flex-1 truncate">
                {intl.formatMessage({ id: BREAKDOWN_LABEL_ID[segment.source] })}
              </span>
              <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtle)]">
                {percent.format(segment.percent)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-x-3 border-t border-[var(--color-border)] pt-1.5 text-ui-sm text-[var(--color-foreground-subtle)]">
        <span>
          {intl.formatMessage(
            { id: "chat.statusPanel.contextCumulative.input" },
            { tokens: tokens(model.cumulative.inputTokens) },
          )}
        </span>
        <span>
          {intl.formatMessage(
            { id: "chat.statusPanel.contextCumulative.output" },
            { tokens: tokens(model.cumulative.outputTokens) },
          )}
        </span>
        <span>
          {intl.formatMessage(
            { id: "chat.statusPanel.contextCumulative.cacheRead" },
            { tokens: tokens(model.cumulative.cacheReadTokens) },
          )}
        </span>
      </div>
    </div>
  );
}
