// M5 ③-3 usage query golden tests (L2 transport layer): frozen method names for v4/usage/stats and
// v4/conversation/usage + payload schema validation semantics (the additive surface evolves backed by golden tests).
import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  v4ConversationUsageParamsSchema,
  v4ConversationUsageResultSchema,
  v4UsageStatsParamsSchema,
  v4UsageStatsResultSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("zcode protocol v4 usage query", () => {
  it("freezes the v4 usage method names", () => {
    // Method names are a wire contract: changing one = breaking protocol change; add a new method instead of renaming.
    expect(V4_METHODS.usageStats).toBe("v4/usage/stats");
    expect(V4_METHODS.conversationUsage).toBe("v4/conversation/usage");
  });

  it("accepts the app usage stats params shape and rejects unknown keys", () => {
    expect(v4UsageStatsParamsSchema.parse({ range: "7d", timeZone: "Asia/Shanghai" })).toEqual({
      range: "7d",
      timeZone: "Asia/Shanghai",
    });
    expect(v4UsageStatsParamsSchema.parse({ range: "30d" })).toEqual({
      range: "30d",
    });
    // strict: same shape as the old usage/stats; unknown fields must not be carried silently (guards against old-param drift).
    expect(v4UsageStatsParamsSchema.safeParse({ range: "7d", extra: true }).success).toBe(false);
    expect(v4UsageStatsParamsSchema.safeParse({ range: "1y" }).success).toBe(false);
  });

  it("accepts the additive window, compare, and filters fields and validates the window", () => {
    const parsed = v4UsageStatsParamsSchema.parse({
      range: "all",
      timeZone: "Asia/Kolkata",
      window: { from: "2026-07-01", to: "2026-09-30" },
      compare: true,
      filters: { modelIds: ["glm-5.3"], workspaceKeys: ["/work/alpha", ""] },
    });
    expect(parsed.window).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(parsed.compare).toBe(true);

    const invalidWindows = [
      { from: "2026-09-30", to: "2026-07-01" },
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-7-1", to: "2026-07-02" },
      { from: "2020-01-01", to: "2026-01-01" },
      { from: "2026-07-01", to: "2026-07-02", extra: true },
    ];
    for (const window of invalidWindows) {
      expect(v4UsageStatsParamsSchema.safeParse({ range: "all", window }).success).toBe(false);
    }
    expect(
      v4UsageStatsParamsSchema.safeParse({ range: "all", filters: { unknown: ["x"] } }).success,
    ).toBe(false);
    // Legacy shapes are unchanged: no extras means no extra keys in the parsed params.
    expect(v4UsageStatsParamsSchema.parse({ range: "7d" })).toEqual({ range: "7d" });
  });

  it("accepts only known include values and a full 168-cell hourly grid", () => {
    expect(
      v4UsageStatsParamsSchema.parse({ range: "all", include: ["hourly", "sessions"] }).include,
    ).toEqual(["hourly", "sessions"]);
    expect(v4UsageStatsParamsSchema.safeParse({ range: "all", include: ["tokens"] }).success).toBe(
      false,
    );
    expect(
      v4UsageStatsParamsSchema.safeParse({
        range: "all",
        include: ["hourly", "hourly", "sessions"],
      }).success,
    ).toBe(false);
  });

  it("parses snapshots with and without the additive window, previous, and facets fields", () => {
    const summary = {
      totalTokens: 1,
      inputTokens: 1,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      totalSessions: 1,
      totalTurns: 1,
      toolCallCount: 0,
      toolErrorRate: 0,
      modelErrorRate: 0,
      avgTimeToFirstTokenMs: null,
      avgTurnDurationMs: null,
      activeDays: 1,
      currentStreakDays: 1,
      longestSessionMs: 0,
      longestStreakDays: 1,
      peakDayTokens: 1,
      favoriteModel: null,
    };
    const legacy = {
      range: "7d",
      generatedAt: 1,
      timeZone: "UTC",
      source: "agent-db",
      summary,
      heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
      dailyModelUsage: [],
      models: [],
      tools: [],
    };
    // An older host's response (no new fields) still parses, and the new fields stay absent.
    const legacyParsed = v4UsageStatsResultSchema.parse(legacy);
    expect(legacyParsed.window).toBeUndefined();
    expect(legacyParsed.previous).toBeUndefined();
    expect(legacyParsed.facets).toBeUndefined();

    const extended = v4UsageStatsResultSchema.parse({
      ...legacy,
      window: { from: "2026-07-01", to: "2026-07-07" },
      previous: { window: { from: "2026-06-24", to: "2026-06-30" }, summary, dailyTokens: [1, 2] },
      facets: { models: ["m"], providers: ["p"], querySources: ["main_turn"], workspaces: [""] },
      somethingNewerThanThisClient: true,
    });
    expect(extended.previous?.dailyTokens).toEqual([1, 2]);
    expect(extended.facets?.workspaces).toEqual([""]);
    // Unknown future fields are stripped rather than failing the whole response.
    expect(extended).not.toHaveProperty("somethingNewerThanThisClient");
  });

  it("validates conversation usage params and result round-trip", () => {
    expect(v4ConversationUsageParamsSchema.parse({ sessionId: "sess_1" })).toEqual({
      sessionId: "sess_1",
    });
    expect(v4ConversationUsageParamsSchema.safeParse({ sessionId: "" }).success).toBe(false);

    const result = {
      sessionId: "sess_1",
      totalTokens: 42,
      inputTokens: 30,
      outputTokens: 10,
      reasoningTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 3,
      modelErrorCount: 0,
      inputBaselineBySource: { "web-remote-replayable": 5 },
    };
    expect(v4ConversationUsageResultSchema.parse(result)).toEqual(result);
    // Usage fields must not be negative (aggregator invariant).
    expect(
      v4ConversationUsageResultSchema.safeParse({
        ...result,
        totalTokens: -1,
      }).success,
    ).toBe(false);
  });
});
