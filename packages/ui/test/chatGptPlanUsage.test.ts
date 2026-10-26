import { describe, expect, it } from "vitest";
import {
  usageHeadline,
  usagePace,
  usagePlanLabel,
  usageRemainingPercent,
  usageResetCountdown,
  usageSeverity,
  usageStaleMinutes,
  usageWindowLabel,
} from "@/settings/model-provider-section/chatgptPlanUsage.js";

// specs/chatgpt-plan-signin.md "Usage display (Settings)" (U2–U6).
const NOW = Date.parse("2026-10-15T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;

describe("chatgptPlanUsage", () => {
  it("labels windows by their length", () => {
    expect(usageWindowLabel({ windowMinutes: 300 }, "primary").id).toMatch(/fiveHour$/);
    expect(usageWindowLabel({ windowMinutes: 10080 }, "secondary").id).toMatch(/weekly$/);
    expect(usageWindowLabel({ windowMinutes: 2880 }, "secondary")).toMatchObject({
      values: { n: 2 },
    });
    expect(usageWindowLabel({ windowMinutes: 180 }, "primary")).toMatchObject({ values: { n: 3 } });
    expect(usageWindowLabel({}, "primary").id).toMatch(/fiveHour$/);
    expect(usageWindowLabel({}, "secondary").id).toMatch(/weekly$/);
  });

  it("computes the share left and severity thresholds", () => {
    expect(usageRemainingPercent(42.4)).toBe(58);
    expect(usageSeverity(69.9)).toBe("normal");
    expect(usageSeverity(70)).toBe("warning");
    expect(usageSeverity(90)).toBe("critical");
    expect(usageSeverity(10, true)).toBe("critical");
  });

  it("rounds the countdown up to minutes with at most two units", () => {
    expect(usageResetCountdown(at(2 * 60 * MIN + 3 * MIN + 10_000), NOW)).toMatchObject({
      values: { h: 2, m: 4 },
    });
    expect(usageResetCountdown(at(2 * 1440 * MIN + 4 * 60 * MIN + 30 * MIN), NOW)).toMatchObject({
      values: { d: 2, h: 4 },
    });
    expect(usageResetCountdown(at(3 * 1440 * MIN), NOW)).toMatchObject({ values: { d: 3 } });
    expect(usageResetCountdown(at(45 * MIN - 1), NOW)).toMatchObject({ values: { m: 45 } });
    expect(usageResetCountdown(at(30_000), NOW)?.toString()).not.toBe("pending");
    expect(usageResetCountdown(at(-1), NOW)).toBe("pending");
    expect(usageResetCountdown(undefined, NOW)).toBeNull();
  });

  it("reports staleness after five minutes", () => {
    expect(usageStaleMinutes({ capturedAt: at(-4 * MIN) }, NOW)).toBeNull();
    expect(usageStaleMinutes({ capturedAt: at(-7 * MIN) }, NOW)).toBe(7);
    expect(usageStaleMinutes({}, NOW)).toBeNull();
  });

  it("capitalises known plan types and keeps unknown ones", () => {
    expect(usagePlanLabel("plus")).toBe("Plus");
    expect(usagePlanLabel("PRO")).toBe("Pro");
    expect(usagePlanLabel("prolite")).toBe("prolite");
    expect(usagePlanLabel(undefined)).toBeNull();
  });
});

// specs/chatgpt-plan-signin.md "Usage across the app": the tightest window drives the chip and picker hints.
describe("usageHeadline", () => {
  it("picks the lowest share left among windows that have not reset", () => {
    expect(
      usageHeadline(
        {
          primary: { usedPercent: 42, resetsAt: at(60 * MIN) },
          secondary: { usedPercent: 76, resetsAt: at(3 * 1440 * MIN) },
        },
        NOW,
      ),
    ).toMatchObject({ kind: "window", role: "secondary", remaining: 24, severity: "warning" });
  });

  it("skips a window past its reset and reports pending when none is left", () => {
    expect(
      usageHeadline(
        {
          primary: { usedPercent: 99, resetsAt: at(-MIN) },
          secondary: { usedPercent: 10, resetsAt: at(MIN * 90) },
        },
        NOW,
      ),
    ).toMatchObject({ kind: "window", role: "secondary", remaining: 90 });
    expect(usageHeadline({ primary: { usedPercent: 99, resetsAt: at(-MIN) } }, NOW)).toEqual({
      kind: "pending",
    });
  });

  it("reports the limit when the plan says so", () => {
    expect(usageHeadline({ limitReached: true, primary: { usedPercent: 100 } }, NOW)).toEqual({
      kind: "limit",
    });
  });
});

// specs/chatgpt-plan-signin.md "Usage pace forecast" (P1–P3).
describe("usagePace", () => {
  const fiveHour = (usedPercent: number, elapsedMinutes: number) => ({
    usedPercent,
    windowMinutes: 300,
    resetsAt: at((300 - elapsedMinutes) * MIN),
  });

  it("projects the run-out time from the average pace", () => {
    expect(usagePace(fiveHour(60, 120), NOW)).toEqual({ kind: "runsOut", inMs: 80 * MIN });
    expect(usagePace(fiveHour(20, 120), NOW)).toEqual({ kind: "lasts" });
  });

  it("stays silent without enough history or inputs", () => {
    expect(usagePace(fiveHour(5, 3), NOW)).toBeNull();
    expect(usagePace({ usedPercent: 50, resetsAt: at(60 * MIN) }, NOW)).toBeNull();
    expect(usagePace(fiveHour(100, 120), NOW)).toBeNull();
    expect(usagePace(fiveHour(0, 120), NOW)).toBeNull();
  });
});
