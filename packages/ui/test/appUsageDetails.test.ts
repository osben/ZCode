// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AppUsageSnapshot, AppUsageToolUsage } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { AppUsageDetailMetrics } from "@/settings/usage-stats/AppUsageDetailMetrics.js";
import { AppUsageToolsTable } from "@/settings/usage-stats/AppUsageToolsTable.js";
import {
  APP_USAGE_TOOLS_COLLAPSED_COUNT,
  formatAppUsageLatency,
  resolveAppUsageDetailValues,
  resolveVisibleAppUsageTools,
} from "@/settings/usage-stats/appUsageDetailViewModel.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

function createSnapshot(
  summary: Partial<AppUsageSnapshot["summary"]> = {},
  tools: AppUsageToolUsage[] = [],
): AppUsageSnapshot {
  return {
    range: "7d",
    generatedAt: 0,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 1_500_000,
      inputTokens: 1_200_000,
      outputTokens: 300_000,
      reasoningTokens: 40_000,
      cacheCreationTokens: 10_000,
      cacheReadTokens: 800_000,
      cacheHitRate: 0.667,
      totalSessions: 4,
      totalTurns: 8,
      toolCallCount: 120,
      toolErrorRate: 0.05,
      modelErrorRate: 0.01,
      avgTimeToFirstTokenMs: 850,
      avgTurnDurationMs: 42_500,
      activeDays: 3,
      currentStreakDays: 1,
      longestSessionMs: 0,
      longestStreakDays: 1,
      peakDayTokens: 0,
      favoriteModel: null,
      ...summary,
    },
    heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
    dailyModelUsage: [],
    models: [],
    tools,
  };
}

function createTools(count: number): AppUsageToolUsage[] {
  return Array.from({ length: count }, (_, index) => ({
    toolName: `tool_${index + 1}`,
    callCount: 100 - index,
    errorCount: index === 0 ? 5 : 0,
    errorRate: index === 0 ? 0.05 : 0,
    avgDurationMs: index === 0 ? null : 1200,
  }));
}

function renderIntl(locale: "en-US" | "zh-CN", node: ReturnType<typeof createElement>) {
  return createElement(ZCodeIntlProvider, { initialLocale: locale }, node);
}

describe("formatAppUsageLatency", () => {
  it("keeps sub-minute precision and renders missing values as a placeholder", () => {
    expect(formatAppUsageLatency("en-US", null)).toBe("--");
    expect(formatAppUsageLatency("en-US", Number.NaN)).toBe("--");
    expect(formatAppUsageLatency("en-US", -1)).toBe("--");
    expect(formatAppUsageLatency("en-US", 850)).toBe("850ms");
    expect(formatAppUsageLatency("en-US", 42_500)).toBe("42.5s");
    expect(formatAppUsageLatency("en-US", 90_000)).toBe("1.5m");
    expect(formatAppUsageLatency("en-US", 5_400_000)).toBe("1.5h");
  });
});

describe("resolveAppUsageDetailValues", () => {
  it("hides the group when the range has no activity", () => {
    const empty = createSnapshot({ totalTokens: 0, totalTurns: 0, toolCallCount: 0 });
    expect(resolveAppUsageDetailValues(empty)).toBeNull();
  });

  it("maps summary fields without recomputing them", () => {
    expect(resolveAppUsageDetailValues(createSnapshot())).toMatchObject({
      inputTokens: 1_200_000,
      outputTokens: 300_000,
      reasoningTokens: 40_000,
      cacheReadTokens: 800_000,
      avgTurnDurationMs: 42_500,
      toolErrorRate: 0.05,
    });
  });
});

describe("resolveVisibleAppUsageTools", () => {
  it("collapses to the top rows and expands to everything without mutating input", () => {
    const tools = createTools(APP_USAGE_TOOLS_COLLAPSED_COUNT + 3);
    expect(resolveVisibleAppUsageTools(tools, false)).toHaveLength(APP_USAGE_TOOLS_COLLAPSED_COUNT);
    expect(resolveVisibleAppUsageTools(tools, true)).toHaveLength(tools.length);
    expect(tools).toHaveLength(APP_USAGE_TOOLS_COLLAPSED_COUNT + 3);
  });
});

describe("AppUsageDetailMetrics", () => {
  it("renders the eight detail tiles and the reasoning helper", () => {
    const html = renderToStaticMarkup(
      renderIntl("en-US", createElement(AppUsageDetailMetrics, { snapshot: createSnapshot() })),
    );
    for (const label of [
      "Details",
      "Input",
      "Output",
      "Cache hit rate",
      "Avg turn time",
      "Avg first token",
      "Tool calls",
      "Tool error rate",
      "Model error rate",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("40K reasoning");
    expect(html).toContain("42.5s");
    expect(html).toContain("850ms");
    expect(html).toContain("rounded-xl");
  });

  it("omits the reasoning helper when there are no reasoning tokens and shows -- for null averages", () => {
    const html = renderToStaticMarkup(
      renderIntl(
        "en-US",
        createElement(AppUsageDetailMetrics, {
          snapshot: createSnapshot({
            reasoningTokens: 0,
            avgTurnDurationMs: null,
            avgTimeToFirstTokenMs: null,
          }),
        }),
      ),
    );
    expect(html).not.toContain("reasoning");
    expect(html).toContain("--");
  });

  it("renders nothing for an empty range and localizes labels", () => {
    const empty = renderToStaticMarkup(
      renderIntl(
        "en-US",
        createElement(AppUsageDetailMetrics, {
          snapshot: createSnapshot({ totalTokens: 0, totalTurns: 0, toolCallCount: 0 }),
        }),
      ),
    );
    expect(empty).toBe("");

    const zh = renderToStaticMarkup(
      renderIntl("zh-CN", createElement(AppUsageDetailMetrics, { snapshot: createSnapshot() })),
    );
    expect(zh).toContain(zhCN["settings.usage.detail.cacheHitRate"]);
    expect(zh).toContain(zhCN["settings.usage.detail.avgTurnDuration"]);
  });
});

describe("AppUsageToolsTable", () => {
  it("renders nothing when no tools were called", () => {
    const html = renderToStaticMarkup(
      renderIntl("en-US", createElement(AppUsageToolsTable, { snapshot: createSnapshot() })),
    );
    expect(html).toBe("");
  });

  it("shows errors in the destructive color only when present and has no toggle for short lists", () => {
    const { container } = render(
      renderIntl(
        "en-US",
        createElement(AppUsageToolsTable, { snapshot: createSnapshot({}, createTools(2)) }),
      ),
    );
    const errorCells = container.querySelectorAll('[role="cell"].text-destructive');
    expect(errorCells).toHaveLength(1);
    expect(errorCells[0]?.textContent).toContain("5");
    expect(screen.queryByRole("button")).toBeNull();
    // Missing average duration falls back to the placeholder.
    expect(container.textContent).toContain("--");
  });

  it("collapses long lists and toggles between top rows and all rows", () => {
    const total = APP_USAGE_TOOLS_COLLAPSED_COUNT + 4;
    const { container } = render(
      renderIntl(
        "en-US",
        createElement(AppUsageToolsTable, { snapshot: createSnapshot({}, createTools(total)) }),
      ),
    );
    const bodyRows = () => container.querySelectorAll('[role="row"]').length - 1;
    expect(bodyRows()).toBe(APP_USAGE_TOOLS_COLLAPSED_COUNT);

    fireEvent.click(screen.getByRole("button", { name: `Show all ${total}` }));
    expect(bodyRows()).toBe(total);

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(bodyRows()).toBe(APP_USAGE_TOOLS_COLLAPSED_COUNT);
  });
});
