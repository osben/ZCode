import { describe, expect, it, vi } from "vitest";
import type { AppUsageQueryInput, AppUsageQueryResult, UsageStorePort } from "@zcode/contracts";
import { planUsageQuery } from "../src/zcode-protocol/usage-stats-request.js";
import { runUsageStats } from "../src/zcode-protocol/usage-stats-run.js";

const DAY = 86_400_000;
const KOLKATA_OFFSET = 5.5 * 3_600_000;
// 2026-07-20T12:00:00Z
const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);

function resultWithDay(dayIndex: number, totalTokens: number): AppUsageQueryResult {
  return {
    totals: {
      totalTokens,
      inputTokens: totalTokens,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 1,
      modelErrorCount: 0,
      avgTimeToFirstTokenMs: null,
    },
    turnTotals: { totalSessions: 1, totalTurns: 1, avgTurnDurationMs: null, longestSessionMs: 0 },
    toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
    models: [{ modelId: "m", totalTokens, inputTokens: totalTokens, outputTokens: 0, requestCount: 1 }],
    tools: [],
    days: [{ dayIndex, totalTokens, turnCount: 1, toolCallCount: 0 }],
    dayModels: [{ dayIndex, modelId: "m", totalTokens }],
  };
}

function fakeStore(resultFor: (input: AppUsageQueryInput) => AppUsageQueryResult) {
  const queryAppUsage = vi.fn(async (input: AppUsageQueryInput) => resultFor(input));
  return { store: { queryAppUsage } as Partial<UsageStorePort>, queryAppUsage };
}

describe("planUsageQuery", () => {
  it("keeps the legacy rolling arithmetic for preset ranges", () => {
    expect(planUsageQuery({ range: "7d", timeZone: "UTC" }, NOW)).toEqual({
      timeZone: "UTC",
      tzOffsetMs: 0,
      since: NOW - 7 * DAY,
      until: NOW,
    });
    expect(planUsageQuery({ range: "all" }, NOW)).toMatchObject({ since: 0, until: NOW });
  });

  it("selects whole local calendar days for a custom window", () => {
    const plan = planUsageQuery(
      { range: "all", timeZone: "Asia/Kolkata", window: { from: "2026-07-01", to: "2026-07-03" } },
      NOW,
    );
    expect(plan.tzOffsetMs).toBe(KOLKATA_OFFSET);
    expect(plan.since).toBe(Date.UTC(2026, 6, 1) - KOLKATA_OFFSET);
    expect(plan.until).toBe(Date.UTC(2026, 6, 4) - KOLKATA_OFFSET - 1);
    expect(plan.window).toEqual({ from: "2026-07-01", to: "2026-07-03" });
  });

  it("plans the previous span of equal length and ignores compare for the all-time range", () => {
    const window = planUsageQuery(
      { range: "all", window: { from: "2026-07-08", to: "2026-07-14" }, compare: true },
      NOW,
    );
    expect(window.previous?.window).toEqual({ from: "2026-07-01", to: "2026-07-07" });

    const preset = planUsageQuery({ range: "30d", compare: true }, NOW);
    expect(preset.previous).toEqual({ since: NOW - 60 * DAY, until: NOW - 30 * DAY - 1 });

    expect(planUsageQuery({ range: "all", compare: true }, NOW).previous).toBeUndefined();
  });
});

describe("runUsageStats", () => {
  it("answers a default request with exactly one legacy-shaped query", async () => {
    const { store, queryAppUsage } = fakeStore(() => resultWithDay(0, 5));
    const snapshot = await runUsageStats(store, { range: "7d", timeZone: "UTC" }, NOW);

    expect(queryAppUsage).toHaveBeenCalledTimes(1);
    expect(queryAppUsage).toHaveBeenCalledWith({
      since: NOW - 7 * DAY,
      until: NOW,
      tzOffsetMs: 0,
    });
    expect(snapshot.window).toBeUndefined();
    expect(snapshot.previous).toBeUndefined();
    expect(snapshot.range).toBe("7d");
  });

  it("builds one day per window day and echoes the window", async () => {
    const { store } = fakeStore(() => resultWithDay(Math.floor(Date.UTC(2026, 6, 2) / DAY), 40));
    const snapshot = await runUsageStats(
      store,
      { range: "all", timeZone: "UTC", window: { from: "2026-07-01", to: "2026-07-05" } },
      NOW,
    );
    expect(snapshot.window).toEqual({ from: "2026-07-01", to: "2026-07-05" });
    expect(snapshot.dailyModelUsage.map((day) => day.date)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
    ]);
    expect(snapshot.dailyModelUsage[1]?.models).toEqual([{ modelId: "m", totalTokens: 40 }]);
  });

  it("returns the previous period aligned day by day and passes filters to both queries", async () => {
    const firstDay = Math.floor(Date.UTC(2026, 6, 8) / DAY);
    const { store, queryAppUsage } = fakeStore((input) =>
      input.until < Date.UTC(2026, 6, 8)
        ? resultWithDay(firstDay - 6, 7)
        : resultWithDay(firstDay + 1, 70),
    );
    const filters = { workspaceKeys: ["/work/alpha"] };
    const snapshot = await runUsageStats(
      store,
      {
        range: "all",
        timeZone: "UTC",
        window: { from: "2026-07-08", to: "2026-07-14" },
        compare: true,
        filters,
      },
      NOW,
    );

    expect(queryAppUsage).toHaveBeenCalledTimes(2);
    for (const call of queryAppUsage.mock.calls) {
      expect(call[0].filters).toEqual(filters);
    }
    expect(snapshot.previous?.window).toEqual({ from: "2026-07-01", to: "2026-07-07" });
    expect(snapshot.previous?.summary.totalTokens).toBe(7);
    // Previous day 2026-07-02 (index 1 of its window) lines up with 2026-07-09 (index 1 here).
    expect(snapshot.previous?.dailyTokens).toEqual([0, 7, 0, 0, 0, 0, 0]);
    expect(snapshot.dailyModelUsage).toHaveLength(7);
    expect(snapshot.summary.totalTokens).toBe(70);
  });

  it("asks for filter facets only on the unfiltered all-time snapshot and returns them", async () => {
    const facets = { models: ["m"], providers: ["p"], querySources: ["main_turn"], workspaces: [""] };
    const { store, queryAppUsage } = fakeStore((input) => ({
      ...resultWithDay(0, 1),
      ...(input.includeFacets ? { facets } : {}),
    }));

    const lifetime = await runUsageStats(store, { range: "all", timeZone: "UTC" }, NOW);
    expect(queryAppUsage).toHaveBeenLastCalledWith(expect.objectContaining({ includeFacets: true }));
    expect(lifetime.facets).toEqual(facets);

    const preset = await runUsageStats(store, { range: "7d", timeZone: "UTC" }, NOW);
    expect(queryAppUsage.mock.lastCall?.[0]).not.toHaveProperty("includeFacets");
    expect(preset.facets).toBeUndefined();

    await runUsageStats(
      store,
      { range: "all", window: { from: "2026-07-01", to: "2026-07-02" } },
      NOW,
    );
    expect(queryAppUsage.mock.lastCall?.[0]).not.toHaveProperty("includeFacets");
  });

  it("requests the hourly and session breakdowns only for the main span", async () => {
    const hourlyTokens = Array.from({ length: 168 }, (_, index) => index);
    const topSessions = [
      { sessionId: "s1", title: "A", workspaceKey: "/w", totalTokens: 9, turnCount: 2, durationMs: 5 },
    ];
    const { store, queryAppUsage } = fakeStore((input) => ({
      ...resultWithDay(0, 1),
      ...(input.include?.hourly ? { hourlyTokens } : {}),
      ...(input.include?.sessions ? { topSessions } : {}),
    }));

    const snapshot = await runUsageStats(
      store,
      { range: "7d", timeZone: "UTC", compare: true, include: ["hourly", "sessions"] },
      NOW,
    );

    expect(queryAppUsage).toHaveBeenCalledTimes(2);
    expect(queryAppUsage.mock.calls[0]?.[0].include).toEqual({ hourly: true, sessions: true });
    expect(queryAppUsage.mock.calls[1]?.[0]).not.toHaveProperty("include");
    expect(snapshot.hourlyTokens).toEqual(hourlyTokens);
    expect(snapshot.topSessions).toEqual(topSessions);

    const plain = await runUsageStats(store, { range: "7d", timeZone: "UTC" }, NOW);
    expect(queryAppUsage.mock.lastCall?.[0]).not.toHaveProperty("include");
    expect(plain.hourlyTokens).toBeUndefined();
    expect(plain.topSessions).toBeUndefined();
  });

  it("falls back to an empty result when no usage store is available", async () => {
    const snapshot = await runUsageStats(undefined, { range: "30d" }, NOW);
    expect(snapshot.summary.totalTokens).toBe(0);
    expect(snapshot.models).toEqual([]);
  });
});
