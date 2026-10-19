// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TID_CODING_PLAN_QUOTA_RESET_ACTION,
  TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY,
} from "@zcode/shared";
import type { CodingPlanResetType } from "@zcode/shared";
import {
  CodingPlanQuotaResetOpportunity,
  type CodingPlanQuotaResetDialogConfig,
} from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetOpportunity.js";
import type { CodingPlanQuotaResetDialogResetItem } from "@/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { mergeCodingPlanQuotaResetOpportunityBadges } from "@/lib/codingPlanQuotaResetUi.js";
import { expectedCopy } from "./helpers/uiCopy.js";

vi.mock("@/lib/codingPlanQuotaResetConfetti.js", () => ({
  burstCodingPlanQuotaResetConfetti: vi.fn(),
}));

function renderOpportunity(props: {
  count: number;
  dialog?: CodingPlanQuotaResetDialogConfig;
  dialogOpen?: boolean;
  expiresAt: number | null;
  onDialogOpenChange?: (open: boolean) => void;
}) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(CodingPlanQuotaResetOpportunity, {
        ...props,
        placement: "inline",
        visible: true,
      }),
    ),
  );
}

function createDialogConfig(overrides: Partial<CodingPlanQuotaResetDialogConfig> = {}) {
  return {
    usageItems: [
      {
        color: "var(--color-usage-chart-1)",
        id: "five-hour",
        label: "5 小时",
        percentage: 5,
        resetTime: "19:08",
        value: "5%",
      },
      {
        color: "var(--color-usage-chart-2)",
        id: "week",
        label: "每周",
        percentage: 99,
        resetTime: "8月12日",
        value: "99%",
      },
    ],
    resetItems: [
      {
        count: 1,
        expiresAt: Date.now() + 20 * 60_000,
        onReset: vi.fn(async () => undefined),
        resetType: "FIVE_HOUR" as const,
      },
      {
        count: 1,
        expiresAt: Date.now() + 2 * 24 * 60 * 60_000,
        onReset: vi.fn(async () => undefined),
        resetType: "WEEK" as const,
      },
    ],
    ...overrides,
  } satisfies CodingPlanQuotaResetDialogConfig;
}

// Simulates the real timing of useCodingPlanQuotaResetUi: when onReset resolves, the store has
// already written the completed state, and the dialog config then carries the remaining
// opportunities from the same status snapshot (count − 1, expiry taken from the next one; 0/null
// once exhausted, but the row stays in the config).
function renderStatefulOpportunity(
  initialExpiries: Partial<Record<CodingPlanResetType, number[]>>,
) {
  const onReset: Record<CodingPlanResetType, ReturnType<typeof vi.fn>> = {
    FIVE_HOUR: vi.fn(),
    WEEK: vi.fn(),
  };
  function Harness() {
    const [expiries, setExpiries] = useState(initialExpiries);
    const resetItems = (Object.keys(expiries) as CodingPlanResetType[]).map(
      (resetType): CodingPlanQuotaResetDialogResetItem => {
        const remaining = expiries[resetType] ?? [];
        return {
          count: remaining.length,
          expiresAt: remaining[0] ?? null,
          onReset: async () => {
            onReset[resetType]();
            setExpiries((current) => ({
              ...current,
              [resetType]: (current[resetType] ?? []).slice(1),
            }));
          },
          resetType,
        };
      },
    );
    // The entry badge matches the real entry: only merge types that still have remaining counts.
    const badge = mergeCodingPlanQuotaResetOpportunityBadges(
      resetItems.map((item) => ({ ...item, visible: item.count > 0 })),
    );
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(CodingPlanQuotaResetOpportunity, {
        count: badge.count,
        dialog: createDialogConfig({ resetItems }),
        expiresAt: badge.expiresAt,
        placement: "inline",
        visible: badge.visible,
      }),
    );
  }
  render(createElement(Harness));
  return onReset;
}

describe("CodingPlanQuotaResetOpportunity", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("可重置额度按钮复用任务列表等待请求的确认色", () => {
    renderOpportunity({
      count: 1,
      dialog: createDialogConfig(),
      expiresAt: Date.now() + 20 * 60_000,
    });

    const button = screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY);
    expect(button.className).toContain("bg-interaction-confirmation-surface");
    expect(button.className).toContain("text-interaction-confirmation-foreground");
  });

  it("单个机会保持徽标文案和倒计时，点击同样打开重置弹框", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));

    renderOpportunity({
      count: 1,
      dialog: createDialogConfig(),
      expiresAt: Date.now() + 19 * 60_000 + 8_000,
    });

    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.opportunity", { count: 1 }),
    );
    const countdown = screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY)
      .lastElementChild as HTMLElement;
    expect(countdown.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.expiresIn", { time: "19m 8s" }),
    );
    expect(countdown.className).toContain("font-normal");
    expect(countdown.className).toContain("text-interaction-confirmation-foreground/80");
    // A single opportunity does not switch to the "get N resets" multi-opportunity copy; only the
    // interaction upgrades to a button.
    expect(
      (
        screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY) as HTMLButtonElement
      ).getAttribute("aria-label"),
    ).not.toBe(expectedCopy("codingPlan.quotaReset.openDialog", { count: 1 }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.body.textContent).toContain(expectedCopy("codingPlan.quotaReset.dialog.title"));
  });

  it("多个机会在入口展示机会次数、隐藏倒计时，点击后打开交付稿弹框", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));

    renderOpportunity({
      count: 2,
      dialog: createDialogConfig(),
      expiresAt: Date.now() + 19 * 60_000 + 8_000,
    });

    expect(document.body.textContent).not.toContain(
      expectedCopy("codingPlan.quotaReset.expiresIn", { time: "19m 8s" }),
    );
    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.body.textContent).toContain(expectedCopy("codingPlan.quotaReset.dialog.title"));
    // The title no longer shows a remaining-count pill; the count is annotated per opportunity
    // row instead.
    expect(screen.getByRole("dialog").querySelector("h2")?.children).toHaveLength(0);
    expect(screen.getByRole("dialog").querySelectorAll("section").length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.fiveHour"),
    );
    expect(document.body.textContent).toContain(expectedCopy("codingPlan.quotaReset.dialog.week"));
  });

  it.each([
    [1, "grid-cols-1"],
    [2, "grid-cols-2"],
    [3, "grid-cols-3"],
  ])("弹窗按 %i 个剩余额度项使用对应列数", (itemCount, expectedClass) => {
    const baseConfig = createDialogConfig();
    const usageItems = [
      ...baseConfig.usageItems,
      {
        color: "var(--color-usage-chart-3)",
        id: "monthly-tool",
        label: "MCP 额度",
        percentage: 75,
        resetTime: "9月1日",
        value: "75%",
      },
    ];
    renderOpportunity({
      count: 1,
      dialog: createDialogConfig({
        usageItems: usageItems.slice(0, itemCount),
      }),
      expiresAt: Date.now() + 20 * 60_000,
    });

    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));
    const grid = screen.getByRole("dialog").querySelector("section > div");
    expect(grid?.className).toContain(expectedClass);
    expect(grid?.className).toContain("max-sm:grid-cols-1");
  });

  it("弹框内只调用被点击额度的 reset，成功后展示反馈并收起已消费项", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));
    const onReset = renderStatefulOpportunity({
      FIVE_HOUR: [Date.now() + 20 * 60_000],
      WEEK: [Date.now() + 2 * 24 * 60 * 60_000],
    });

    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));
    await act(async () => {
      fireEvent.click(screen.getAllByTestId(TID_CODING_PLAN_QUOTA_RESET_ACTION)[0]);
      await Promise.resolve();
    });

    expect(onReset.FIVE_HOUR).toHaveBeenCalledTimes(1);
    expect(onReset.WEEK).not.toHaveBeenCalled();
    expect(screen.getAllByTestId(TID_CODING_PLAN_QUOTA_RESET_ACTION)[0]).toBeTruthy();
    // After opportunities are exhausted the expiry is empty: the countdown row stays blank during
    // the success feedback and collapse animation, never rendering "0m 0s".
    expect(screen.getByRole("dialog").textContent).not.toContain("0m 0s");

    act(() => vi.advanceTimersByTime(600));
    expect(screen.getByRole("dialog").textContent).not.toContain("0m 0s");

    act(() => vi.advanceTimersByTime(220));
    expect(document.body.textContent).not.toContain(
      expectedCopy("codingPlan.quotaReset.dialog.fiveHour"),
    );
    expect(document.body.textContent).toContain(expectedCopy("codingPlan.quotaReset.dialog.week"));
  });

  it("同类型多张机会核销一张后保留该行并展示下一张倒计时，不关闭弹框即可再次核销", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));
    const onReset = renderStatefulOpportunity({
      FIVE_HOUR: [Date.now() + 20 * 60_000, Date.now() + 3 * 60 * 60_000 + 30 * 60_000 + 30_000],
      WEEK: [Date.now() + 2 * 24 * 60 * 60_000],
    });

    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));
    // Initial: five hours holds 2 tickets, showing the "2" pill and the earliest ticket's
    // "soonest" countdown.
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.itemCount", { count: 2 }),
    );
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.expiresInSoonest", { time: "20m" }),
    );

    await act(async () => {
      fireEvent.click(screen.getAllByTestId(TID_CODING_PLAN_QUOTA_RESET_ACTION)[0]);
      await Promise.resolve();
    });
    expect(onReset.FIVE_HOUR).toHaveBeenCalledTimes(1);

    // Bugfix regression: when the success feedback ends, the row's fate follows the latest
    // projection. If the same type still has remaining opportunities, the row stays and does not
    // enter the collapse animation; the countdown switches to the next ticket instead of
    // rendering the completed state's empty expiry as "0m 0s".
    act(() => vi.advanceTimersByTime(600));
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.fiveHour"),
    );
    expect(document.body.textContent).not.toContain(
      expectedCopy("codingPlan.quotaReset.dialog.itemCount", { count: 2 }),
    );
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.expiresIn", { time: "3h 30m" }),
    );
    expect(screen.getByRole("dialog").textContent).not.toContain("0m 0s");
    const resetAgain = screen.getAllByTestId(
      TID_CODING_PLAN_QUOTA_RESET_ACTION,
    )[0] as HTMLButtonElement;
    expect(resetAgain.disabled).toBe(false);

    act(() => vi.advanceTimersByTime(220));
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.fiveHour"),
    );

    // Clicking again without closing the dialog: onReset is really invoked a second time; once
    // opportunities are exhausted the row collapses and the weekly quota row is unaffected.
    await act(async () => {
      fireEvent.click(screen.getAllByTestId(TID_CODING_PLAN_QUOTA_RESET_ACTION)[0]);
      await Promise.resolve();
    });
    expect(onReset.FIVE_HOUR).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("dialog").textContent).not.toContain("0m 0s");
    act(() => vi.advanceTimersByTime(820));
    expect(document.body.textContent).not.toContain(
      expectedCopy("codingPlan.quotaReset.dialog.fiveHour"),
    );
    expect(document.body.textContent).toContain(expectedCopy("codingPlan.quotaReset.dialog.week"));
    expect(onReset.WEEK).not.toHaveBeenCalled();
  });

  it("同类型持有多张机会时展示次数药丸与「最快」倒计时，单张不展示", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T10:00:00+08:00"));

    renderOpportunity({
      count: 3,
      dialog: createDialogConfig({
        resetItems: [
          {
            count: 2,
            expiresAt: Date.now() + 4 * 60 * 60_000 + 52 * 60_000,
            onReset: vi.fn(async () => undefined),
            resetType: "FIVE_HOUR",
          },
          {
            count: 1,
            expiresAt: Date.now() + 4 * 60 * 60_000 + 58 * 60_000,
            onReset: vi.fn(async () => undefined),
            resetType: "WEEK",
          },
        ],
      }),
      expiresAt: Date.now() + 4 * 60 * 60_000 + 52 * 60_000,
    });

    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));

    // Multiple tickets: a "2" pill sits next to the title and the countdown is marked "soonest"
    // to avoid being misread as a uniform deadline.
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.itemCount", { count: 2 }),
    );
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.expiresInSoonest", { time: "4h 52m" }),
    );
    // Single ticket: no "1" pill appears and the countdown keeps its original copy.
    expect(document.body.textContent).not.toContain(
      expectedCopy("codingPlan.quotaReset.dialog.itemCount", { count: 1 }),
    );
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.expiresIn", { time: "4h 58m" }),
    );
  });

  it("弹框打开后服务端机会数下降时仍保持挂载，直到用户主动关闭", () => {
    const dialog = createDialogConfig();
    const view = renderOpportunity({
      count: 2,
      dialog,
      expiresAt: Date.now() + 20 * 60_000,
    });

    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));
    expect(screen.getByRole("dialog")).toBeTruthy();

    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(CodingPlanQuotaResetOpportunity, {
          count: 1,
          dialog,
          expiresAt: Date.now() + 20 * 60_000,
          placement: "inline",
          visible: true,
        }),
      ),
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("成功动画期间关闭并重新打开时，不受上一次弹框的延时任务影响", async () => {
    vi.useFakeTimers();
    const resetFiveHour = vi.fn(async () => undefined);
    renderOpportunity({
      count: 2,
      dialog: createDialogConfig({
        resetItems: [
          {
            count: 1,
            expiresAt: Date.now() + 20 * 60_000,
            onReset: resetFiveHour,
            resetType: "FIVE_HOUR",
          },
        ],
      }),
      expiresAt: Date.now() + 20 * 60_000,
    });

    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));
    await act(async () => {
      fireEvent.click(screen.getAllByTestId(TID_CODING_PLAN_QUOTA_RESET_ACTION)[0]);
      await Promise.resolve();
    });
    fireEvent.click(
      screen
        .getByRole("dialog")
        .querySelectorAll("button")
        .item(screen.getByRole("dialog").querySelectorAll("button").length - 1),
    );
    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));

    act(() => vi.advanceTimersByTime(820));
    expect(document.body.textContent).toContain(
      expectedCopy("codingPlan.quotaReset.dialog.fiveHour"),
    );
  });

  it("支持由 Composer 控制弹框开关，保证 HoverCard 在弹框期间不卸载", () => {
    const onDialogOpenChange = vi.fn();
    renderOpportunity({
      count: 2,
      dialog: createDialogConfig(),
      dialogOpen: false,
      expiresAt: Date.now() + 20 * 60_000,
      onDialogOpenChange,
    });

    fireEvent.click(screen.getByTestId(TID_CODING_PLAN_QUOTA_RESET_OPPORTUNITY));
    expect(onDialogOpenChange).toHaveBeenCalledWith(true);
  });
});
