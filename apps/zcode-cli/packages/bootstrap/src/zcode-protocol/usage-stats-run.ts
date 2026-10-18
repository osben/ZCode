import type { AppUsageQueryResult, UsageStorePort } from "@zcode/contracts";
import type { AppUsageSnapshot } from "@zcode/shared";
import { buildAppUsageSnapshot } from "./usage-stats-builder.js";
import {
  describeSpanWindow,
  planUsageQuery,
  type UsageQuerySpan,
  type UsageStatsRequestParams,
} from "./usage-stats-request.js";

const EMPTY_RESULT: AppUsageQueryResult = {
  totals: {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    modelRequestCount: 0,
    modelErrorCount: 0,
    avgTimeToFirstTokenMs: null,
  },
  turnTotals: { totalSessions: 0, totalTurns: 0, avgTurnDurationMs: null, longestSessionMs: 0 },
  toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
  models: [],
  tools: [],
  days: [],
  dayModels: [],
};

function dailyTokenTotals(snapshot: AppUsageSnapshot, length: number): number[] {
  const totals = snapshot.dailyModelUsage.map((day) =>
    day.models.reduce((sum, model) => sum + model.totalTokens, 0),
  );
  // Align the previous period to the current one day by day; pad or trim so lengths always match.
  return Array.from({ length }, (_, index) => totals[index] ?? 0);
}

/**
 * App Usage snapshot for one request. Without `window`/`compare`/`filters` this is exactly the
 * legacy single query; the new fields only add spans and filters on top of it.
 */
export async function runUsageStats(
  usageStore: Partial<UsageStorePort> | undefined,
  params: UsageStatsRequestParams,
  nowMs: number,
): Promise<AppUsageSnapshot> {
  const plan = planUsageQuery(params, nowMs);
  const baseOptions = {
    range: params.range,
    timeZone: plan.timeZone,
    tzOffsetMs: plan.tzOffsetMs,
    generatedAt: nowMs,
  };
  const optionsFor = (span: UsageQuerySpan) => ({
    ...baseOptions,
    since: span.since,
    until: span.until,
    ...(span.windowStartDayIndex !== undefined
      ? { windowStartDayIndex: span.windowStartDayIndex }
      : {}),
  });
  const query = async (span: UsageQuerySpan): Promise<AppUsageQueryResult> => {
    if (!usageStore?.queryAppUsage) {
      // No usage store (should not happen): an empty result lets the UI show its empty state.
      return EMPTY_RESULT;
    }
    return usageStore.queryAppUsage({
      since: span.since,
      until: span.until,
      tzOffsetMs: plan.tzOffsetMs,
      ...(params.filters ? { filters: params.filters } : {}),
    });
  };

  const snapshot = buildAppUsageSnapshot(await query(plan), optionsFor(plan));
  if (!plan.window && !plan.previous) {
    return snapshot;
  }
  const previous = plan.previous
    ? buildAppUsageSnapshot(await query(plan.previous), optionsFor(plan.previous))
    : undefined;
  return {
    ...snapshot,
    ...(plan.window ? { window: plan.window } : {}),
    ...(plan.previous && previous
      ? {
          previous: {
            window: describeSpanWindow(plan.previous, plan.tzOffsetMs),
            summary: previous.summary,
            dailyTokens: dailyTokenTotals(previous, snapshot.dailyModelUsage.length),
          },
        }
      : {}),
  };
}
