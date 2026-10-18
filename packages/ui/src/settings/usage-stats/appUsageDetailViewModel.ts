import type { AppUsageSnapshot, AppUsageToolUsage } from "@zcode/shared";

export const APP_USAGE_TOOLS_COLLAPSED_COUNT = 8;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** Latency formatter with sub-minute precision; the lifetime duration formatter floors to whole minutes. */
export function formatAppUsageLatency(locale: string, ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return "--";
  }
  const [unit, divisor] =
    ms < MS_PER_SECOND
      ? (["millisecond", 1] as const)
      : ms < MS_PER_MINUTE
        ? (["second", MS_PER_SECOND] as const)
        : ms < MS_PER_HOUR
          ? (["minute", MS_PER_MINUTE] as const)
          : (["hour", MS_PER_HOUR] as const);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "narrow",
    maximumFractionDigits: unit === "millisecond" ? 0 : 1,
  }).format(ms / divisor);
}

export interface AppUsageDetailValues {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheHitRate: number;
  cacheReadTokens: number;
  avgTurnDurationMs: number | null;
  avgTimeToFirstTokenMs: number | null;
  toolCallCount: number;
  toolErrorRate: number;
  modelErrorRate: number;
}

export function extractAppUsageDetailValues(
  summary: AppUsageSnapshot["summary"],
): AppUsageDetailValues {
  return {
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    reasoningTokens: summary.reasoningTokens,
    cacheHitRate: summary.cacheHitRate,
    cacheReadTokens: summary.cacheReadTokens,
    avgTurnDurationMs: summary.avgTurnDurationMs,
    avgTimeToFirstTokenMs: summary.avgTimeToFirstTokenMs,
    toolCallCount: summary.toolCallCount,
    toolErrorRate: summary.toolErrorRate,
    modelErrorRate: summary.modelErrorRate,
  };
}

/** Details only make sense when the range has model or tool activity; otherwise the empty states already explain it. */
export function resolveAppUsageDetailValues(
  snapshot: AppUsageSnapshot,
): AppUsageDetailValues | null {
  const { summary } = snapshot;
  const hasActivity =
    summary.totalTokens > 0 || summary.totalTurns > 0 || summary.toolCallCount > 0;
  return hasActivity ? extractAppUsageDetailValues(summary) : null;
}

export function resolveVisibleAppUsageTools(
  tools: readonly AppUsageToolUsage[],
  expanded: boolean,
): AppUsageToolUsage[] {
  return expanded ? [...tools] : tools.slice(0, APP_USAGE_TOOLS_COLLAPSED_COUNT);
}
