// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUsageSnapshot } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import {
  bucketDailyModelUsage,
  bucketNumberSeries,
  bucketStartDate,
  buildAppUsageQuery,
  compactFilters,
  computeAppUsageDelta,
  formatLocalDate,
  resolveAutoGranularity,
  shiftLocalDate,
  validateCustomRange,
} from "@/settings/usage-stats/appUsageRangeViewModel.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

const TODAY = "2026-07-20";

describe("appUsageRangeViewModel dates", () => {
  it("formats local dates and shifts by calendar days across month and year ends", () => {
    expect(formatLocalDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(shiftLocalDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftLocalDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftLocalDate(TODAY, 1 - 90)).toBe("2026-04-22");
  });

  it("validates custom ranges", () => {
    expect(validateCustomRange("", "2026-07-01", TODAY)).toBe("incomplete");
    expect(validateCustomRange("2026-02-30", "2026-03-01", TODAY)).toBe("incomplete");
    expect(validateCustomRange("2026-07-10", "2026-07-01", TODAY)).toBe("order");
    expect(validateCustomRange("2026-07-01", "2026-07-21", TODAY)).toBe("future");
    expect(validateCustomRange("2020-01-01", "2026-07-20", TODAY)).toBe("tooLong");
    expect(validateCustomRange("2026-07-01", "2026-07-20", TODAY)).toBe("ok");
  });
});

describe("buildAppUsageQuery", () => {
  const base = { customFrom: "", customTo: "", compare: false, today: TODAY };

  it("keeps the legacy request shape for 7d, 30d and all", () => {
    expect(buildAppUsageQuery({ ...base, preset: "7d" })).toEqual({ range: "7d" });
    expect(buildAppUsageQuery({ ...base, preset: "30d" })).toEqual({ range: "30d" });
    expect(buildAppUsageQuery({ ...base, preset: "all", compare: true })).toEqual({
      range: "all",
    });
  });

  it("uses an inclusive local-day window for longer presets and custom ranges", () => {
    expect(buildAppUsageQuery({ ...base, preset: "90d" })).toEqual({
      range: "all",
      window: { from: "2026-04-22", to: TODAY },
    });
    expect(buildAppUsageQuery({ ...base, preset: "1y", compare: true })).toEqual({
      range: "all",
      window: { from: "2025-07-21", to: TODAY },
      compare: true,
    });
    expect(
      buildAppUsageQuery({
        ...base,
        preset: "custom",
        customFrom: "2026-07-01",
        customTo: "2026-07-10",
      }),
    ).toEqual({ range: "all", window: { from: "2026-07-01", to: "2026-07-10" } });
  });

  it("returns null for an invalid custom range", () => {
    expect(buildAppUsageQuery({ ...base, preset: "custom" })).toBeNull();
    expect(
      buildAppUsageQuery({
        ...base,
        preset: "custom",
        customFrom: "2026-07-10",
        customTo: "2026-07-01",
      }),
    ).toBeNull();
  });
});

describe("filters in the request", () => {
  const base = { customFrom: "", customTo: "", compare: false, today: TODAY };

  it("drops empty filter lists so an untouched bar keeps the legacy shape", () => {
    expect(compactFilters(undefined)).toBeUndefined();
    expect(compactFilters({ modelIds: [], workspaceKeys: undefined })).toBeUndefined();
    expect(compactFilters({ modelIds: ["glm"], providerIds: [] })).toEqual({ modelIds: ["glm"] });
    expect(
      buildAppUsageQuery({ ...base, preset: "7d", filters: { modelIds: [], providerIds: [] } }),
    ).toEqual({ range: "7d" });
  });

  it("adds active filters to every preset, including all-time", () => {
    const filters = { workspaceKeys: ["/work/alpha"] };
    expect(buildAppUsageQuery({ ...base, preset: "7d", filters })).toEqual({
      range: "7d",
      filters,
    });
    expect(buildAppUsageQuery({ ...base, preset: "all", filters })).toEqual({
      range: "all",
      filters,
    });
    expect(buildAppUsageQuery({ ...base, preset: "90d", filters })).toMatchObject({ filters });
  });
});

describe("granularity bucketing", () => {
  it("chooses an automatic granularity from the day count", () => {
    expect(resolveAutoGranularity(30)).toBe("day");
    expect(resolveAutoGranularity(90)).toBe("week");
    expect(resolveAutoGranularity(365)).toBe("month");
  });

  it("starts weeks on Sunday and months on the 1st", () => {
    // 2026-07-20 is a Monday.
    expect(bucketStartDate("2026-07-20", "week")).toBe("2026-07-19");
    expect(bucketStartDate("2026-07-19", "week")).toBe("2026-07-19");
    expect(bucketStartDate("2026-07-25", "week")).toBe("2026-07-19");
    expect(bucketStartDate("2026-07-26", "week")).toBe("2026-07-26");
    expect(bucketStartDate("2026-07-20", "month")).toBe("2026-07-01");
  });

  it("sums per-model tokens into week buckets, keeping the unknown model separate", () => {
    const daily = [
      { date: "2026-07-18", models: [{ modelId: "a", totalTokens: 1 }] },
      {
        date: "2026-07-19",
        models: [
          { modelId: "a", totalTokens: 2 },
          { modelId: null, totalTokens: 5 },
        ],
      },
      { date: "2026-07-20", models: [{ modelId: "a", totalTokens: 4 }] },
    ];
    expect(bucketDailyModelUsage(daily, "day")).toEqual(daily);
    expect(bucketDailyModelUsage(daily, "week")).toEqual([
      { date: "2026-07-12", models: [{ modelId: "a", totalTokens: 1 }] },
      {
        date: "2026-07-19",
        models: [
          { modelId: "a", totalTokens: 6 },
          { modelId: null, totalTokens: 5 },
        ],
      },
    ]);
  });

  it("buckets a previous-period series with the current dates so lengths line up", () => {
    const dates = ["2026-07-18", "2026-07-19", "2026-07-20"];
    expect(bucketNumberSeries(dates, [10, 20, 30], "day")).toEqual([10, 20, 30]);
    expect(bucketNumberSeries(dates, [10, 20, 30], "week")).toEqual([10, 50]);
  });
});

describe("computeAppUsageDelta", () => {
  it("reports direction and rounded percent, treating zero baselines explicitly", () => {
    expect(computeAppUsageDelta(150, 100)).toEqual({ direction: "up", percent: 50 });
    expect(computeAppUsageDelta(80, 100)).toEqual({ direction: "down", percent: 20 });
    expect(computeAppUsageDelta(100, 100)).toEqual({ direction: "flat", percent: 0 });
    expect(computeAppUsageDelta(5, 0)).toEqual({ direction: "up", percent: null });
    expect(computeAppUsageDelta(0, 0)).toEqual({ direction: "flat", percent: 0 });
    expect(computeAppUsageDelta(Number.NaN, 1)).toBeNull();
  });
});

function createSnapshot(range: AppUsageSnapshot["range"], withPrevious: boolean): AppUsageSnapshot {
  const summary = {
    totalTokens: 1000,
    inputTokens: 800,
    outputTokens: 200,
    reasoningTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 400,
    cacheHitRate: 0.5,
    totalSessions: 2,
    totalTurns: 4,
    toolCallCount: 10,
    toolErrorRate: 0.1,
    modelErrorRate: 0,
    avgTimeToFirstTokenMs: 300,
    avgTurnDurationMs: 4000,
    activeDays: 2,
    currentStreakDays: 1,
    longestSessionMs: 0,
    longestStreakDays: 1,
    peakDayTokens: 600,
    favoriteModel: null,
  };
  return {
    range,
    generatedAt: 0,
    timeZone: "UTC",
    source: "agent-db",
    summary,
    heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
    dailyModelUsage: [
      { date: "2026-07-19", models: [{ modelId: "glm", totalTokens: 400 }] },
      { date: "2026-07-20", models: [{ modelId: "glm", totalTokens: 600 }] },
    ],
    models: [
      {
        modelId: "glm",
        totalTokens: 1000,
        inputTokens: 800,
        outputTokens: 200,
        requestCount: 4,
        share: 1,
      },
    ],
    tools: [],
    ...(withPrevious
      ? {
          previous: {
            window: { from: "2026-07-17", to: "2026-07-18" },
            summary: { ...summary, inputTokens: 400, totalTokens: 500 },
            dailyTokens: [200, 300],
          },
        }
      : {}),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppUsagePanel range controls", () => {
  it("sends legacy requests by default and adds window / compare only when chosen", async () => {
    await Promise.all([
      import("@/settings/usage-stats/AppUsageDailyModelTrendChart.js"),
      import("@/settings/usage-stats/AppUsageModelUsagePieChart.js"),
    ]);
    const getAppUsageSnapshot = vi.fn(
      async (request: { range: AppUsageSnapshot["range"]; compare?: boolean }) =>
        createSnapshot(request.range, Boolean(request.compare)),
    );
    const services = { usageStatsService: { getAppUsageSnapshot } } as unknown as IServiceAccessor;
    render(
      createElement(
        ServiceProvider,
        { services },
        createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, createElement(AppUsagePanel)),
      ),
    );

    await screen.findByText("Time range");
    await waitFor(() => expect(getAppUsageSnapshot).toHaveBeenCalledTimes(2));
    const initial = getAppUsageSnapshot.mock.calls.map(([request]) => request);
    expect(initial.map((request) => Object.keys(request).sort())).toEqual([
      ["range", "timeZone"],
      ["range", "timeZone"],
    ]);
    expect(initial.map((request) => request.range).sort()).toEqual(["7d", "all"]);

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(getAppUsageSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ range: "7d", compare: true }),
      ),
    );
    await screen.findByText("Previous period");

    fireEvent.mouseDown(screen.getByText("Last 90 days"), { button: 0 });
    await waitFor(() => {
      const call = getAppUsageSnapshot.mock.calls.at(-1)?.[0] as
        | { range: string; window?: { from: string; to: string }; compare?: boolean }
        | undefined;
      expect(call?.range).toBe("all");
      expect(call?.compare).toBe(true);
      expect(call?.window?.to).toBe(formatLocalDate(new Date()));
    });
  });

  it("keeps the last valid data and explains an invalid custom range", async () => {
    await Promise.all([
      import("@/settings/usage-stats/AppUsageDailyModelTrendChart.js"),
      import("@/settings/usage-stats/AppUsageModelUsagePieChart.js"),
    ]);
    const getAppUsageSnapshot = vi.fn(async (request: { range: AppUsageSnapshot["range"] }) =>
      createSnapshot(request.range, false),
    );
    const services = { usageStatsService: { getAppUsageSnapshot } } as unknown as IServiceAccessor;
    const { container } = render(
      createElement(
        ServiceProvider,
        { services },
        createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, createElement(AppUsagePanel)),
      ),
    );
    await screen.findByText("Time range");
    await waitFor(() => expect(getAppUsageSnapshot).toHaveBeenCalledTimes(2));

    fireEvent.mouseDown(screen.getByText("Custom"), { button: 0 });
    await waitFor(() => expect(getAppUsageSnapshot).toHaveBeenCalledTimes(3));
    const inputs = container.querySelectorAll<HTMLInputElement>('input[type="date"]');
    expect(inputs).toHaveLength(2);

    const callsBefore = getAppUsageSnapshot.mock.calls.length;
    // The prefilled start date is now after this end date, so the pair is invalid.
    fireEvent.change(inputs[1]!, { target: { value: "2020-01-01" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(getAppUsageSnapshot.mock.calls.length).toBe(callsBefore);
    expect(screen.queryByText("Details")).toBeTruthy();
  });
});

describe("AppUsagePanel filters and day drill-down", () => {
  it("sends selected filters and turns a heatmap day into a one-day window", async () => {
    await Promise.all([
      import("@/settings/usage-stats/AppUsageDailyModelTrendChart.js"),
      import("@/settings/usage-stats/AppUsageModelUsagePieChart.js"),
    ]);
    const activeDay = shiftLocalDate(formatLocalDate(new Date()), -1);
    const getAppUsageSnapshot = vi.fn(
      async (request: { range: AppUsageSnapshot["range"]; window?: unknown }) => {
        const snapshot = createSnapshot(request.range, false);
        if (request.range !== "all" || request.window) {
          return snapshot;
        }
        return {
          ...snapshot,
          heatmap: {
            startDate: activeDay,
            endDate: activeDay,
            maxTokens: 10,
            weeks: [
              {
                weekIndex: 0,
                days: [
                  {
                    date: activeDay,
                    level: 4 as const,
                    totalTokens: 10,
                    turnCount: 1,
                    toolCallCount: 0,
                  },
                ],
              },
            ],
          },
          facets: {
            models: ["glm", ""],
            providers: ["zai"],
            querySources: ["main_turn", "custom_source"],
            workspaces: ["/work/alpha", ""],
          },
        };
      },
    );
    const services = { usageStatsService: { getAppUsageSnapshot } } as unknown as IServiceAccessor;
    render(
      createElement(
        ServiceProvider,
        { services },
        createElement(ZCodeIntlProvider, { initialLocale: "en-US" }, createElement(AppUsagePanel)),
      ),
    );

    // Facets in the all-time snapshot signal a host that understands the extra breakdowns.
    await waitFor(() =>
      expect(getAppUsageSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ range: "7d", include: ["hourly", "sessions"] }),
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Models" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "glm" }));
    await waitFor(() =>
      expect(getAppUsageSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ range: "7d", filters: { modelIds: ["glm"] } }),
      ),
    );
    // The lifetime snapshot that feeds the menus never carries filters.
    for (const [request] of getAppUsageSnapshot.mock.calls) {
      if (request.range === "all") {
        expect(request).not.toHaveProperty("filters");
      }
    }
    expect(await screen.findByText(/apply to token and model data only/)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: activeDay }));
    await waitFor(() => {
      const last = getAppUsageSnapshot.mock.calls.at(-1)?.[0] as
        | { window?: { from: string; to: string }; filters?: unknown }
        | undefined;
      expect(last?.window).toEqual({ from: activeDay, to: activeDay });
      expect(last?.filters).toEqual({ modelIds: ["glm"] });
    });
  });
});
