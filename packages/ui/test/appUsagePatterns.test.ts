// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUsageSnapshot, IPlatformService } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { AppUsageActivityPatterns } from "@/settings/usage-stats/AppUsageActivityPatterns.js";
import { AppUsageExportButtons } from "@/settings/usage-stats/AppUsageExportButtons.js";
import { AppUsageTopSessions } from "@/settings/usage-stats/AppUsageTopSessions.js";
import {
  buildUsageCsv,
  buildUsageJson,
  findBusiestHour,
  hasHourlyActivity,
  hourlyLevel,
  usageExportFileName,
  weekdayLabels,
} from "@/settings/usage-stats/appUsagePatternsViewModel.js";

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast: toastSpy }));

function emptyCells(): number[] {
  return Array.from({ length: 168 }, () => 0);
}

function createSnapshot(overrides: Partial<AppUsageSnapshot> = {}): AppUsageSnapshot {
  return {
    range: "7d",
    generatedAt: 0,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 10,
      inputTokens: 10,
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
      peakDayTokens: 10,
      favoriteModel: null,
    },
    heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
    dailyModelUsage: [
      {
        date: "2026-07-19",
        models: [
          { modelId: 'glm, "5"', totalTokens: 7 },
          { modelId: "=cmd()", totalTokens: 2 },
          { modelId: null, totalTokens: 1 },
          { modelId: "zero", totalTokens: 0 },
        ],
      },
      { date: "2026-07-20", models: [] },
    ],
    models: [],
    tools: [],
    ...overrides,
  };
}

function inIntl(node: ReturnType<typeof createElement>, locale: "en-US" | "zh-CN" = "en-US") {
  return createElement(ZCodeIntlProvider, { initialLocale: locale }, node);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toastSpy.mockClear();
});

describe("appUsagePatternsViewModel", () => {
  it("uses the daily heatmap thresholds for hour levels", () => {
    expect(hourlyLevel(0, 100)).toBe(0);
    expect(hourlyLevel(10, 0)).toBe(0);
    expect(hourlyLevel(25, 100)).toBe(1);
    expect(hourlyLevel(26, 100)).toBe(2);
    expect(hourlyLevel(51, 100)).toBe(3);
    expect(hourlyLevel(76, 100)).toBe(4);
  });

  it("finds the busiest cell and requires a full grid with activity", () => {
    const cells = emptyCells();
    expect(findBusiestHour(cells)).toBeNull();
    expect(hasHourlyActivity(cells)).toBe(false);
    expect(hasHourlyActivity(undefined)).toBe(false);
    expect(hasHourlyActivity([1, 2, 3])).toBe(false);

    cells[2 * 24 + 15] = 40;
    cells[5 * 24 + 3] = 90;
    expect(findBusiestHour(cells)).toEqual({ weekday: 5, hour: 3, tokens: 90 });
    expect(hasHourlyActivity(cells)).toBe(true);
  });

  it("starts weekday labels on Sunday", () => {
    expect(weekdayLabels("en-US")).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });

  it("writes long-format CSV, quoting commas and quotes and defusing formulas", () => {
    const csv = buildUsageCsv(createSnapshot(), "Unknown model");
    expect(csv.split("\n")).toEqual([
      "date,model,tokens",
      '2026-07-19,"glm, ""5""",7',
      "2026-07-19,'=cmd(),2",
      "2026-07-19,Unknown model,1",
      "",
    ]);
  });

  it("exports JSON without the heatmap and names files after the covered days", () => {
    const snapshot = createSnapshot();
    const parsed = JSON.parse(
      buildUsageJson(snapshot, { range: "7d" }, new Date("2026-07-20T00:00:00Z")),
    );
    expect(parsed.exportedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(parsed.query).toEqual({ range: "7d" });
    expect(parsed).not.toHaveProperty("heatmap");
    expect(parsed.summary.totalTokens).toBe(10);

    expect(usageExportFileName(snapshot, "csv")).toBe("zcode-usage-2026-07-19_2026-07-20.csv");
    expect(usageExportFileName(createSnapshot({ dailyModelUsage: [] }), "json")).toBe(
      "zcode-usage-7d.json",
    );
  });
});

describe("AppUsageActivityPatterns", () => {
  it("renders the 7 x 24 grid with the busiest caption", () => {
    const cells = emptyCells();
    cells[2 * 24 + 15] = 1_200_000;
    cells[2 * 24 + 16] = 300_000;
    const { container } = render(
      inIntl(createElement(AppUsageActivityPatterns, { hourlyTokens: cells })),
    );

    expect(container.querySelectorAll('[role="cell"]')).toHaveLength(168);
    expect(screen.getByText("Busiest: Tue 15:00")).toBeTruthy();
    const busiestCell = container.querySelector('[role="cell"][title^="Tue 15:00"]');
    expect(busiestCell?.getAttribute("title")).toContain("tokens");
    expect(busiestCell?.getAttribute("style")).toContain("--color-usage-heatmap-4");
  });

  it("renders nothing without hourly activity", () => {
    expect(
      renderToStaticMarkup(
        inIntl(createElement(AppUsageActivityPatterns, { hourlyTokens: emptyCells() })),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        inIntl(createElement(AppUsageActivityPatterns, { hourlyTokens: undefined })),
      ),
    ).toBe("");
  });
});

describe("AppUsageTopSessions", () => {
  it("lists sessions with an untitled fallback and hides when empty", () => {
    const html = renderToStaticMarkup(
      inIntl(
        createElement(AppUsageTopSessions, {
          snapshot: createSnapshot({
            topSessions: [
              {
                sessionId: "a",
                title: "Refactor auth",
                workspaceKey: "/work/alpha",
                totalTokens: 1_500_000,
                turnCount: 12,
                durationMs: 90_000,
              },
              {
                sessionId: "b",
                title: null,
                workspaceKey: "",
                totalTokens: 500,
                turnCount: 1,
                durationMs: 800,
              },
            ],
          }),
        }),
      ),
    );
    expect(html).toContain("Busiest sessions");
    expect(html).toContain("Refactor auth");
    expect(html).toContain("alpha");
    expect(html).toContain("1.5M");
    expect(html).toContain("1.5m");
    expect(html).toContain("Untitled session");
    expect(html).toContain("--");

    expect(
      renderToStaticMarkup(
        inIntl(createElement(AppUsageTopSessions, { snapshot: createSnapshot() })),
      ),
    ).toBe("");
  });
});

describe("AppUsageExportButtons", () => {
  it("saves through the platform dialog and reports the saved path", async () => {
    const saveFile = vi.fn(async () => ({ success: true, path: "/tmp/usage.csv" }));
    const platform = { saveFile } as unknown as IPlatformService;
    render(
      createElement(
        PlatformProvider,
        { platform },
        inIntl(
          createElement(AppUsageExportButtons, {
            snapshot: createSnapshot(),
            query: { range: "7d" },
          }),
        ),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    const [request] = saveFile.mock.calls[0] as unknown as [
      { suggestedName: string; data: ArrayBuffer },
    ];
    expect(request.suggestedName).toBe("zcode-usage-2026-07-19_2026-07-20.csv");
    expect(new TextDecoder().decode(request.data).startsWith("date,model,tokens")).toBe(true);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("Saved to /tmp/usage.csv"));
  });

  it("stays quiet when the save dialog is canceled and toasts on failure", async () => {
    const saveFile = vi
      .fn()
      .mockResolvedValueOnce({ success: false, canceled: true })
      .mockResolvedValueOnce({ success: false, error: "disk full" });
    const platform = { saveFile } as unknown as IPlatformService;
    render(
      createElement(
        PlatformProvider,
        { platform },
        inIntl(createElement(AppUsageExportButtons, { snapshot: createSnapshot(), query: {} })),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    expect(toastSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("Export failed"));
  });

  it("falls back to a Blob download without a platform save dialog", async () => {
    const createObjectURL = vi.fn(() => "blob:usage");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        clicked.push(this.download);
      },
    );
    render(inIntl(createElement(AppUsageExportButtons, { snapshot: createSnapshot(), query: {} })));

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(clicked).toEqual(["zcode-usage-2026-07-19_2026-07-20.csv"]));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:usage");
  });
});
