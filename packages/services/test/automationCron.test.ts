import { describe, expect, it } from "vitest";
import {
  buildIntervalScheduleRule,
  buildRelativeDelaySchedule,
  computeInitialAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  inferMinuteIntervalScheduleRule,
  isOneShotAutomation,
  isValidCronExpr,
  StaleOneShotAutomationScheduleError,
} from "../src/session/automationCron.js";

describe("automationCron", () => {
  it("isOneShotAutomation：只有非循环且至多一次的任务是纯一次性", () => {
    // One-shot semantics is a definite target time: after a scheduler misfire the task is finalized based on it and
    // must not be rescheduled.
    expect(isOneShotAutomation({ recurring: false })).toBe(true);
    expect(isOneShotAutomation({ recurring: false, maxRuns: 1 })).toBe(true);
    expect(isOneShotAutomation({ recurring: false, maxRuns: 3 })).toBe(false);
    expect(isOneShotAutomation({ recurring: true })).toBe(false);
  });

  it("isValidCronExpr：合法 5 段表达式返回 true", () => {
    expect(isValidCronExpr("0 9 * * *")).toBe(true);
    expect(isValidCronExpr("*/5 * * * *")).toBe(true);
    expect(isValidCronExpr("30 18 * * 1,3,5")).toBe(true);
    expect(isValidCronExpr("0 9 * */2 1#1")).toBe(true);
  });

  it("isValidCronExpr：非法表达式返回 false", () => {
    expect(isValidCronExpr("not a cron")).toBe(false);
    expect(isValidCronExpr("99 99 * * *")).toBe(false);
    expect(isValidCronExpr("")).toBe(false);
  });

  it("computeNextRunAt：每天 09:00 的下一次严格晚于基准且命中 09:00", () => {
    // Baseline: local 2023-11-14T20:00-ish (fixed timestamp, to avoid depending on the current time).
    const from = new Date(2023, 10, 14, 20, 0, 0).getTime();
    const next = computeNextRunAt("0 9 * * *", from);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(from);
    const d = new Date(next!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it("computeNextRunAt：从 08:00 出发，当天 09:00 即为下一次", () => {
    const from = new Date(2023, 10, 14, 8, 0, 0).getTime();
    const next = computeNextRunAt("0 9 * * *", from);
    const expected = new Date(2023, 10, 14, 9, 0, 0).getTime();
    expect(next).toBe(expected);
  });

  it("computeNextRunAt：每分钟表达式返回下一分钟", () => {
    const from = new Date(2023, 10, 14, 8, 0, 30).getTime();
    const next = computeNextRunAt("* * * * *", from);
    const expected = new Date(2023, 10, 14, 8, 1, 0).getTime();
    expect(next).toBe(expected);
  });

  it("相对分钟计划以服务端真实时钟为锚点，保留秒级延迟", () => {
    const from = new Date(2026, 6, 28, 14, 44, 28).getTime();
    const schedule = buildRelativeDelaySchedule(3, from);

    expect(schedule.cronExpr).toBe("47 14 28 7 *");
    expect(schedule.scheduleRule).toMatchObject({
      unit: "minute",
      interval: 3,
      anchorAt: from,
    });
    expect(computeScheduleRuleNextRunAt(schedule.scheduleRule!, from)).toBe(from + 3 * 60_000);
  });

  it("一次性固定月日 cron 刚错过目标分钟时立即到期，避免滚到下一年", () => {
    const from = new Date(2026, 6, 16, 17, 31, 30).getTime();

    expect(
      computeInitialAutomationNextRunAt(
        {
          cronExpr: "31 17 16 7 *",
          recurring: false,
        },
        from,
      ),
    ).toBe(from);
  });

  it("一次性固定月日 cron 目标已过去 4 分 53 秒时拒绝创建", () => {
    const from = new Date(2026, 6, 28, 14, 38, 53).getTime();

    expect(() =>
      computeInitialAutomationNextRunAt(
        {
          cronExpr: "34 14 28 7 *",
          recurring: false,
        },
        from,
      ),
    ).toThrow(StaleOneShotAutomationScheduleError);
  });

  it("一次性固定月日 cron 跨过目标整一分钟时不再补执行", () => {
    const from = new Date(2026, 6, 28, 14, 35, 0).getTime();

    expect(() =>
      computeInitialAutomationNextRunAt(
        {
          cronExpr: "34 14 28 7 *",
          recurring: false,
        },
        from,
      ),
    ).toThrow(StaleOneShotAutomationScheduleError);
  });

  it("循环任务与尚未到期的一次性日历任务保持原计划", () => {
    const from = new Date(2026, 6, 16, 17, 31, 30).getTime();
    const nextYear = new Date(2027, 6, 16, 17, 31, 0).getTime();

    expect(
      computeInitialAutomationNextRunAt(
        { cronExpr: "31 17 16 7 *", recurring: true },
        from,
      ),
    ).toBe(nextYear);
    expect(
      computeInitialAutomationNextRunAt(
        { cronExpr: "32 17 16 7 *", recurring: false },
        from,
      ),
    ).toBe(new Date(2026, 6, 16, 17, 32, 0).getTime());
  });

  it("一次性固定月日 cron 目标已过去 6 分钟（模型时钟漂移）时拒绝创建，不静默滚到下一年", () => {
    // Regression: 'in 8 minutes' was self-computed by the model into a fixed calendar cron; at creation the target
    // minute had already passed by a few minutes, and the old 5-minute window let it through → silently rolled to
    // next year (the next run showed 2027). The 30-minute window covers the drift and rejects instead.
    const from = new Date(2026, 6, 16, 17, 37, 0).getTime();

    expect(() =>
      computeInitialAutomationNextRunAt(
        { cronExpr: "31 17 16 7 *", recurring: false },
        from,
      ),
    ).toThrow(StaleOneShotAutomationScheduleError);
  });

  it("一次性日历任务在目标月份之后创建时保留下一年语义", () => {
    // Created in August, targeting July 16: the target passed about a month ago, far beyond the staleness window —
    // this is the user explicitly asking for next year, not a model-miscalculated approximation of "now".
    const from = new Date(2026, 7, 16, 12, 0, 0).getTime();

    expect(
      computeInitialAutomationNextRunAt(
        { cronExpr: "31 17 16 7 *", recurring: false },
        from,
      ),
    ).toBe(new Date(2027, 6, 16, 17, 31, 0).getTime());
  });

  it("computeScheduleRuleNextRunAt：每 31 小时按锚点推进并保持第 49 分", () => {
    const anchorAt = new Date(2026, 7, 4, 18, 38).getTime();
    const rule = {
      unit: "hourly" as const,
      interval: 31,
      hour: 0,
      minute: 49,
      anchorAt,
    };

    const first = computeScheduleRuleNextRunAt(rule, anchorAt);
    expect(first).toBe(new Date(2026, 7, 4, 18, 49).getTime());
    expect(computeScheduleRuleNextRunAt(rule, first!)).toBe(
      new Date(2026, 7, 6, 1, 49).getTime(),
    );
  });

  it("computeScheduleRuleNextRunAt：每 2 周保持锚点周序", () => {
    const anchorAt = new Date(2024, 0, 1, 8, 0).getTime(); // Monday
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "weekly",
        interval: 2,
        hour: 9,
        minute: 0,
        anchorAt,
        weekdays: [2],
      },
      new Date(2024, 0, 2, 10, 0).getTime(),
    );
    expect(next).toBe(new Date(2024, 0, 16, 9, 0).getTime());
  });

  it("每 10 分钟从创建时刻计时，不提前命中墙钟刻度且不随晚派发漂移", () => {
    const anchorAt = new Date(2026, 6, 20, 11, 46, 15).getTime();
    const rule = inferMinuteIntervalScheduleRule("*/10 * * * *", anchorAt);

    expect(rule).toMatchObject({ unit: "minute", interval: 10, anchorAt });
    expect(computeScheduleRuleNextRunAt(rule!, anchorAt)).toBe(
      new Date(2026, 6, 20, 11, 56, 15).getTime(),
    );
    expect(computeScheduleRuleNextRunAt(rule!, new Date(2026, 6, 20, 11, 57).getTime())).toBe(
      new Date(2026, 6, 20, 12, 6, 15).getTime(),
    );
  });

  it("computeScheduleRuleNextRunAt：每 2 年保持锚点月日", () => {
    const anchorAt = new Date(2026, 6, 12, 8, 0).getTime();
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "yearly",
        interval: 2,
        hour: 9,
        minute: 30,
        anchorAt,
        monthDays: [12],
      },
      new Date(2026, 6, 13, 0, 0).getTime(),
    );
    expect(next).toBe(new Date(2028, 6, 12, 9, 30).getTime());
  });

  it("computeScheduleRuleNextRunAt：月度间隔 1200 的边界仍能计算下一轮", () => {
    const anchorAt = new Date(2026, 0, 1, 10, 0).getTime();
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "monthly",
        interval: 1_200,
        hour: 9,
        minute: 0,
        anchorAt,
        monthDays: [1],
        monthlyMode: "date",
      },
      anchorAt,
    );

    expect(next).toBe(new Date(2126, 0, 1, 9, 0).getTime());
  });

  it("computeScheduleRuleNextRunAt：months 覆盖锚点月份", () => {
    // The anchor is in July, but the rule specifies March 5 → the next run should land in March (of the next year).
    const anchorAt = new Date(2026, 6, 12, 8, 0).getTime();
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "yearly",
        interval: 1,
        hour: 9,
        minute: 30,
        anchorAt,
        months: [3],
        monthDays: [5],
      },
      new Date(2026, 6, 13, 0, 0).getTime(),
    );
    expect(next).toBe(new Date(2027, 2, 5, 9, 30).getTime());
  });

  it("computeScheduleRuleNextRunAt：2/29 只在闰年触发（溢出守卫）", () => {
    const anchorAt = new Date(2025, 0, 1, 8, 0).getTime();
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "yearly",
        interval: 1,
        hour: 9,
        minute: 30,
        anchorAt,
        months: [2],
        monthDays: [29],
      },
      new Date(2025, 5, 1, 0, 0).getTime(),
    );
    // 2026/2027 are not leap years and are skipped by the guard, landing on 2028-02-29.
    expect(next).toBe(new Date(2028, 1, 29, 9, 30).getTime());
  });

  describe("buildIntervalScheduleRule：会话侧长间隔 carrier 归一化", () => {
    // Bug background: each cron field has a step cap (minute 59, hour 24, day-of-month 31, month 12), so "every
    // 50 hours / 40 days / 13 months" cannot be expressed directly with a five-field cron. The session side uses an
    // intervalUnit+interval controlled carrier, and the host side uses this function to parse the compatible cron's
    // fields into the authoritative scheduleRule; the real interval is carried by scheduleRule while cronExpr is
    // display-only. anchorAt is passed in by the caller (the service) as the real creation/modification time.
    const anchorAt = new Date(2026, 7, 4, 10, 30, 0).getTime();

    it("hourly：从兼容 cron 解析 minute，间隔 50 落入 scheduleRule", () => {
      // The compatible cron '15 * * * *' means "the 15th minute of every hour"; the real 50-hour interval is carried
      // by the carrier.
      const rule = buildIntervalScheduleRule("hourly", 50, "15 * * * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "hourly",
        interval: 50,
        hour: 0,
        minute: 15,
        anchorAt,
      });
      expect(rule!.weekdays).toBeUndefined();
      // Next: the first :15 after the 10:30 anchor, then +50 hours.
      expect(computeScheduleRuleNextRunAt(rule!, anchorAt)).toBe(
        new Date(2026, 7, 4, 10, 15).getTime() + 50 * 3_600_000,
      );
    });

    it("daily：解析 hour/minute，间隔 40 落入 scheduleRule", () => {
      const rule = buildIntervalScheduleRule("daily", 40, "9 9 * * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "daily",
        interval: 40,
        hour: 9,
        minute: 9,
        anchorAt,
      });
      // Next: the anchor 8/4 10:30 has passed that day's 09:09, so advance by the 40-day interval; the next round is
      // 8/4 + 40 = 9/13 09:09.
      expect(computeScheduleRuleNextRunAt(rule!, anchorAt)).toBe(
        new Date(2026, 8, 13, 9, 9).getTime(),
      );
    });

    it("weekly：从 dow 解析 weekdays，间隔 8 落入 scheduleRule", () => {
      // The compatible cron '0 9 * * 1,3,5' means Mon/Wed/Fri 09:00; the real interval is 8 weeks.
      const rule = buildIntervalScheduleRule("weekly", 8, "0 9 * * 1,3,5", anchorAt);
      expect(rule).toMatchObject({
        unit: "weekly",
        interval: 8,
        hour: 9,
        minute: 0,
        weekdays: [1, 3, 5],
        anchorAt,
      });
    });

    it("monthly：从 dom 解析 monthDays，间隔 13 落入 scheduleRule", () => {
      // The compatible cron '0 9 15 * *' means the 15th of every month at 09:00; the real interval is 13 months.
      const rule = buildIntervalScheduleRule("monthly", 13, "0 9 15 * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "monthly",
        interval: 13,
        hour: 9,
        minute: 0,
        monthDays: [15],
        monthlyMode: "date",
        anchorAt,
      });
    });

    it("yearly：从 dom+month 解析 months+monthDays，间隔 2 落入 scheduleRule", () => {
      // The compatible cron '0 9 15 6 *' means June 15 every year at 09:00; the real interval is 2 years.
      const rule = buildIntervalScheduleRule("yearly", 2, "0 9 15 6 *", anchorAt);
      expect(rule).toMatchObject({
        unit: "yearly",
        interval: 2,
        hour: 9,
        minute: 0,
        months: [6],
        monthDays: [15],
        anchorAt,
      });
    });

    it("minute：直接以 anchorAt 的时分作展示锚点，间隔 90 落入 scheduleRule", () => {
      // The compatible cron '* * * * *' is a display placeholder only; the real interval is 90 minutes.
      const rule = buildIntervalScheduleRule("minute", 90, "* * * * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "minute",
        interval: 90,
        hour: 10,
        minute: 30,
        anchorAt,
      });
    });

    it("兼容 cron 字段缺失时回退到安全默认值，不抛错", () => {
      // The model may pass a '* * * * *' placeholder cron for weekly/monthly/yearly; when parsing fails, give
      // sensible defaults (weekday=[1], monthDays=[1], months=[anchor month]) so the scheduling engine can still
      // compute. hour/minute take the anchor's time ('*' parses to undefined and falls back to the anchor's
      // hour/minute).
      const rule = buildIntervalScheduleRule("weekly", 5, "* * * * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "weekly",
        interval: 5,
        weekdays: [1],
        hour: 10,
        minute: 30,
      });
      const monthlyRule = buildIntervalScheduleRule("monthly", 7, "* * * * *", anchorAt);
      expect(monthlyRule).toMatchObject({ unit: "monthly", monthDays: [4] });
      const yearlyRule = buildIntervalScheduleRule("yearly", 3, "* * * * *", anchorAt);
      expect(yearlyRule).toMatchObject({
        unit: "yearly",
        months: [new Date(anchorAt).getMonth() + 1],
        monthDays: [new Date(anchorAt).getDate()],
      });
    });

    it("无效 unit 抛错，避免静默生成错误规则", () => {
      expect(() =>
        buildIntervalScheduleRule("decade" as never, 10, "0 9 * * *", anchorAt),
      ).toThrow();
    });
  });
});
