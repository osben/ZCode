// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
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
    expect(html).toContain("rounded-xl");
    expect(html).toContain("h-7");
    expect(html).toContain("w-px");
    expect(html).not.toContain("border-border");
    expect(html).not.toContain("border-t");
    expect(html).not.toContain("sm:border-l");
  });

  it("keeps the selected range for charts but removes the old range metric cards", async () => {
    // Bugfix: both charts are lazy(() => import(...)) (loaded on demand so Recharts/decimal.js
    // do not slow down startup); under full-suite load, a test worker compiling the chart module
    // graph on the fly exceeds the waitFor 5s budget and the "calculating" Suspense fallback
    // never disappears (a7cade07fb relaxed it to 5s and it still was not enough). Warm up the
    // modules before rendering with the exact same specifiers the component's lazy calls use, so
    // the dynamic imports hit the cache and resolve immediately and the placeholder no longer
    // depends on machine load; if a chart module itself fails to load, the warm-up throws here.
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

    await screen.findAllByRole("tab");
    // Bugfix: while loading, multiple "calculating" placeholders can appear at once and
    // queryByText throws when it matches more than one element (under full-suite load, waitFor's
    // default 1s budget expires with a multiple elements error before things settle).
    // Switch to queryAllByText to assert all placeholders are gone, and relax the timeout to 5s
    // to tolerate slow convergence under load.
    await waitFor(
      () => {
        expect(screen.queryAllByText(expectedCopy("settings.usage.loadingTitle"))).toHaveLength(0);
      },
      { timeout: 5000 },
    );

    const renderedCopy = document.body.textContent ?? "";
    expect(renderedCopy).toContain(expectedCopy("settings.usage.lifetimeTotalTokens"));
    expect(renderedCopy).toContain(expectedCopy("settings.usage.heatmapTitle"));
    expect(
      screen.queryByRole("tablist", {
        name: expectedCopy("settings.usage.granularity.label"),
      }),
    ).toBeNull();
    await waitFor(() => {
      expect(document.body.innerHTML).toContain("99 tokens");
    });
    const tabs = screen.getAllByRole("tab");
    const sevenDayTab = tabs[0];
    const thirtyDayTab = tabs[1];
    expect(sevenDayTab.getAttribute("aria-selected")).toBe("true");
    expect(thirtyDayTab.getAttribute("aria-selected")).toBe("false");
    await waitFor(() => {
      expect(document.body.textContent).toContain(expectedCopy("settings.usage.dailyChartTitle"));
    });
    expect(document.body.textContent).not.toContain("趋势图");
    expect(document.body.textContent).not.toContain("按天 Token 趋势");
    expect(document.body.innerHTML).toContain("rounded-full bg-surface");
    expect(document.body.innerHTML).toContain("group-data-horizontal/tabs:h-7");
    expect(document.body.innerHTML).toContain("px-2.5 py-0 text-ui-sm");
    expect(document.body.innerHTML).not.toContain("w-16");
    expect(document.body.innerHTML).not.toContain("rounded-lg border border-border");
    expect(document.body.textContent).not.toContain(expectedCopy("settings.usage.totalTokens"));
    expect(document.body.textContent).not.toContain(expectedCopy("settings.usage.sessions"));
    expect(document.body.textContent).not.toContain(expectedCopy("settings.usage.messages"));
    expect(document.body.textContent).not.toContain(expectedCopy("settings.usage.activeDays"));
    expect(document.body.textContent).not.toContain(expectedCopy("settings.usage.favoriteModel"));
  });

  it("uses small typography for chart content while keeping chart titles unchanged", async () => {
    const [
      chartUiSource,
      dailyChartSource,
      modelChartSource,
      heatmapSource,
      codingPlanSource,
      codingPlanLineSource,
    ] = await Promise.all(
      [
        "packages/ui/src/components/ui/chart.tsx",
        "packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx",
        "packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx",
        "packages/ui/src/settings/usage-stats/UsageHeatmap.tsx",
        "packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx",
        "packages/ui/src/settings/usage-stats/CodingPlanUsageLineChart.tsx",
      ].map((path) => readFile(path, "utf8")),
    );

    expect(chartUiSource).toContain("justify-center text-ui-sm");
    expect(chartUiSource).toContain("text-ui-sm/relaxed");
    expect(dailyChartSource).toContain('className="flex min-w-0 items-center gap-2 text-ui-sm"');
    expect(dailyChartSource).toContain('<h3 className="text-ui-base font-medium text-foreground">');
    expect(modelChartSource).toContain("font-mono text-ui-sm text-foreground");
    expect(modelChartSource).toContain("font-mono text-ui-sm text-foreground-subtle tabular-nums");
    expect(modelChartSource).toContain('<h3 className="text-ui-base font-medium text-foreground">');
    expect(heatmapSource).toContain(
      'className="min-w-0 truncate text-ui-sm text-foreground-subtle"',
    );
    expect(heatmapSource).toContain(
      '<h3 className="min-w-0 truncate text-ui-base font-medium text-foreground">',
    );
    expect(codingPlanSource).toContain(
      'className="mt-3 flex flex-wrap items-center gap-3 text-ui-sm"',
    );
    expect(codingPlanSource).toContain(
      'className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-ui-sm"',
    );
    expect(codingPlanLineSource).toContain(
      'className="flex min-w-0 items-center gap-2 text-ui-sm"',
    );
  });
});
