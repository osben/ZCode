import { describe, expect, it } from "vitest";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import {
  formatMemoryDayGroupLabel,
  formatMemoryLastDreamLabel,
  formatMemoryUpdatedAt,
} from "@/settings/memoryUpdatedAt.js";
import { expectedCopy } from "./helpers/uiCopy.js";

const messageIds = [
  "settings.memory.viewer.updated.justNow",
  "settings.memory.viewer.updated.minutesAgo",
  "settings.memory.viewer.updated.today",
  "settings.memory.viewer.updated.yesterday",
  "settings.memory.viewer.updated.weekday",
  "settings.memory.viewer.updated.weekdayZh",
  "settings.memory.viewer.updated.date",
  "settings.memory.viewer.updated.dateMonthDay",
  "settings.memory.viewer.updated.dateYearMonthDay",
  "settings.memory.viewer.group.today",
  "settings.memory.viewer.group.yesterday",
  "settings.memory.viewer.lastDream",
] as const;

const messages: Record<string, string> = Object.fromEntries(
  messageIds.map((id) => [id, expectedCopy(id)]),
);

const formatMessage: IntlInstance["formatMessage"] = ({ id }, values) => {
  let message = messages[id] ?? id;
  for (const [key, value] of Object.entries(values ?? {})) {
    message = message.replaceAll(`{${key}}`, String(value));
  }
  return message;
};

const now = new Date(2026, 7, 7, 22, 32).getTime();

function format(value: Date): string {
  return formatMemoryUpdatedAt({
    formatMessage,
    locale: "en-US",
    now,
    updatedAt: value.getTime(),
  });
}

describe("formatMemoryUpdatedAt", () => {
  it.each([
    [new Date(2026, 7, 7, 22, 31, 31), expectedCopy("settings.memory.viewer.updated.justNow")],
    [
      new Date(2026, 7, 7, 22, 20),
      expectedCopy("settings.memory.viewer.updated.minutesAgo", { count: 12 }),
    ],
    [
      new Date(2026, 7, 7, 22, 2),
      expectedCopy("settings.memory.viewer.updated.today", { time: "22:02" }),
    ],
    [
      new Date(2026, 7, 6, 22, 32),
      expectedCopy("settings.memory.viewer.updated.yesterday", { time: "22:32" }),
    ],
    [
      new Date(2026, 7, 3, 9, 5),
      expectedCopy("settings.memory.viewer.updated.weekday", { weekday: "Mon", time: "09:05" }),
    ],
    [
      new Date(2026, 6, 20, 9, 5),
      expectedCopy("settings.memory.viewer.updated.date", { date: "Jul 20", time: "09:05" }),
    ],
    [
      new Date(2025, 11, 18, 9, 5),
      expectedCopy("settings.memory.viewer.updated.date", { date: "Dec 18, 2025", time: "09:05" }),
    ],
  ])("按时间分段格式化 %s", (updatedAt, expected) => {
    expect(format(updatedAt)).toBe(expected);
  });

  it("未来时间按刚刚处理", () => {
    expect(format(new Date(2026, 7, 7, 22, 40))).toBe(
      expectedCopy("settings.memory.viewer.updated.justNow"),
    );
  });
});

describe("formatMemoryDayGroupLabel", () => {
  function label(value: Date, locale: "en-US" | "zh-CN" = "en-US"): string {
    return formatMemoryDayGroupLabel({
      formatMessage,
      locale,
      now,
      updatedAt: value.getTime(),
    });
  }

  it.each([
    [new Date(2026, 7, 7, 22, 32), expectedCopy("settings.memory.viewer.group.today")],
    [new Date(2026, 7, 7, 0, 0), expectedCopy("settings.memory.viewer.group.today")],
    [new Date(2026, 7, 6, 23, 59), expectedCopy("settings.memory.viewer.group.yesterday")],
    [new Date(2026, 7, 3, 9, 5), "Aug 3"],
    [new Date(2025, 11, 18, 9, 5), "Dec 18, 2025"],
  ])("groups memory files by local day %s", (updatedAt, expected) => {
    expect(label(updatedAt)).toBe(expected);
  });

  it("formats group date labels without time", () => {
    expect(label(new Date(2026, 7, 3, 9, 5))).not.toContain("09:05");
  });
});

describe("formatMemoryLastDreamLabel", () => {
  function label(lastDreamConsolidatedAt: number | undefined): string | undefined {
    return formatMemoryLastDreamLabel({
      formatMessage,
      lastDreamConsolidatedAt,
      locale: "en-US",
      now,
    });
  }

  it("interpolates the shared updated-time formatter into the last-dream message", () => {
    expect(label(new Date(2026, 7, 7, 22, 31, 31).getTime())).toBe(
      expectedCopy("settings.memory.viewer.lastDream", {
        time: expectedCopy("settings.memory.viewer.updated.justNow"),
      }),
    );
    expect(label(new Date(2026, 7, 7, 22, 2).getTime())).toBe(
      expectedCopy("settings.memory.viewer.lastDream", {
        time: expectedCopy("settings.memory.viewer.updated.today", { time: "22:02" }),
      }),
    );
  });

  it("returns undefined without a completed dream", () => {
    expect(label(undefined)).toBeUndefined();
  });
});
