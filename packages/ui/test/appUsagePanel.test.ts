// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUsageRange, AppUsageSnapshot } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  AppUsageLifetimeSummaryStrip,
  AppUsagePanel,
} from "@/settings/usage-stats/AppUsagePanel.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

function createSnapshot(
  overrides: Partial<AppUsageSnapshot> & { range?: AppUsageRange } = {},
): AppUsageSnapshot {
  return {
    range: overrides.range ?? "all",
    generatedAt: 0,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 20_650_000_000,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      totalSessions: 0,
      totalTurns: 0,
      toolCallCount: 0,
      toolErrorRate: 0,
      modelErrorRate: 0,
      avgTimeToFirstTokenMs: null,
      avgTurnDurationMs: null,
      activeDays: 0,
      currentStreakDays: 5,
      longestSessionMs: 2 * 60 * 60 * 1000 + 15 * 60 * 1000,
      longestStreakDays: 34,
      peakDayTokens: 370_000_000,
      favoriteModel: null,
    },
    heatmap: {
      startDate: null,
      endDate: null,
      maxTokens: 370_000_000,
      weeks: [],
    },
    dailyModelUsage: [],
    models: [],
    tools: [],
    ...overrides,
  };
}

function createOneDayHeatmap(totalTokens: number): AppUsageSnapshot["heatmap"] {
  return {
    startDate: "2026-08-15",
    endDate: "2026-08-15",
    maxTokens: totalTokens,
    weeks: [
      {
        weekIndex: 0,
        days: [
          {
            date: "2026-08-15",
            level: 1,
            totalTokens,
            turnCount: 1,
            toolCallCount: 0,
          },
        ],
      },
    ],
  };
}

function createServices(): IServiceAccessor {
  return {
    usageStatsService: {
      getAppUsageSnapshot: vi.fn(async ({ range }: { range: AppUsageRange }) =>
        createSnapshot({
          range,
          heatmap: range === "all" ? createOneDayHeatmap(99) : createOneDayHeatmap(10),
          summary: {
            ...createSnapshot().summary,
            totalTokens: range === "all" ? 20_650_000_000 : 389_000,
            totalSessions: 4,
            totalTurns: 8,
            activeDays: 1,
            favoriteModel:
              range === "all"
                ? null
                : {
                    modelId: "glm-5.3",
                    totalTokens: 280_080,
                    share: 0.72,
                  },
          },
        }),
      ),
    },
  } as unknown as IServiceAccessor;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppUsageLifetimeSummaryStrip", () => {
  it("renders all-time app usage metrics independent of the selected range", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(AppUsageLifetimeSummaryStrip, {
          snapshot: createSnapshot(),
        }),
      ),
    );

    expect(html).toContain(expectedCopy("settings.usage.lifetimeTotalTokens"));
    expect(html).toContain(expectedCopy("settings.usage.lifetimePeakTokens"));
    expect(html).toContain(expectedCopy("settings.usage.longestSession"));
    expect(html).toContain(expectedCopy("settings.usage.currentStreak"));
    expect(html).toContain(expectedCopy("settings.usage.longestStreak"));
    expect(html).toContain("20.7B");
    expect(html).toContain("370M");
    expect(html).toContain("2 h 15 m");
    expect(html).toContain("5 d");
    expect(html).toContain("34 d");
  });

  it("keeps the selected range for charts but removes the old range metric cards", async () => {
    // Bugfix: both charts are lazy(() => import(...)) (loaded on demand so Recharts/decimal.js
    // do not slow startup); under full-suite load the worker can exceed waitFor 5s compiling the
    // chart module graph, leaving the "Computing usage" Suspense fallback stuck (a7cade07fb already
    // relaxed this to 5s). Warm the modules with the exact specifiers the components use before
    // rendering so the dynamic import resolves from cache; if a chart module fails to load, the
    // warm-up throws right here.
    await Promise.all([
      import("@/settings/usage-stats/AppUsageDailyModelTrendChart.js"),
      import("@/settings/usage-stats/AppUsageModelUsagePieChart.js"),
    ]);
    render(
      createElement(
        ServiceProvider,
        { services: createServices() },
        createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, createElement(AppUsagePanel)),
      ),
    );

    await screen.findByText(expectedCopy("settings.usage.lifetimeTotalTokens"));
    // Bugfix: the "Computing usage" placeholder can appear several times while loading, and
    // queryByText throws on multiple matches (under load waitFor's 1s default times out before
    // convergence). Use queryAllByText to assert every placeholder is gone, with 5s tolerance.
    await waitFor(
      () => {
        expect(screen.queryAllByText(expectedCopy("settings.usage.loadingTitle"))).toHaveLength(0);
      },
      { timeout: 5000 },
    );

    const lifetimeTitle = screen.getByText(expectedCopy("settings.usage.lifetimeTotalTokens"));
    const tokenActivityTitle = screen.getByText(expectedCopy("settings.usage.heatmapTitle"));
    const rangeTitle = screen.getByText(expectedCopy("settings.usage.appUsageRangeTitle"));
    expect(
      lifetimeTitle.compareDocumentPosition(tokenActivityTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tokenActivityTitle.compareDocumentPosition(rangeTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(rangeTitle).toBeTruthy();
    expect(document.body.innerHTML).toContain("99");
    const sevenDayTab = screen.getByText(expectedCopy("settings.usage.range.7d"));
    const thirtyDayTab = screen.getByText(expectedCopy("settings.usage.range.30d"));
    expect(sevenDayTab.getAttribute("aria-selected")).toBe("true");
    expect(thirtyDayTab.getAttribute("aria-selected")).toBe("false");
    expect(await screen.findByText(expectedCopy("settings.usage.dailyChartTitle"))).toBeTruthy();
    expect(screen.queryByText("Trend chart")).toBeNull();
    expect(screen.queryByText("Daily token trend")).toBeNull();
    expect(screen.queryByText(expectedCopy("settings.usage.totalTokens"))).toBeNull();
    expect(screen.queryByText(expectedCopy("settings.usage.sessions"))).toBeNull();
    expect(screen.queryByText(expectedCopy("settings.usage.messages"))).toBeNull();
    expect(screen.queryByText(expectedCopy("settings.usage.activeDays"))).toBeNull();
    expect(screen.queryByText(expectedCopy("settings.usage.favoriteModel"))).toBeNull();
  });
});
