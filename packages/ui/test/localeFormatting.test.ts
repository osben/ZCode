import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Locale } from "@zcode/shared";
import { createIntl } from "../src/i18n/createIntl.js";
import enUS from "../src/i18n/locales/en-US.js";
import ukUA from "../src/i18n/locales/uk-UA.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { formatCompactTokenNumber } from "../src/lib/tokenNumberFormat.js";
import { workDurationParts, workDurationUnitSeparator } from "../src/lib/workDuration.js";
import { formatMemoryUpdatedAt } from "../src/settings/memoryUpdatedAt.js";
import { formatConversationWorkDuration } from "../src/v4/conversationWorkDuration.js";

const MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "uk-UA": ukUA,
};
const intlFor = (locale: Locale) => createIntl(locale, MESSAGES);
const DURATION_MS = (1 * 60 + 42) * 1000;

function workedFor(locale: Locale): string {
  const intl = intlFor(locale);
  return workDurationParts(DURATION_MS, intl.formatMessage)
    .map((part) => `${part.value}${workDurationUnitSeparator(locale)}${part.unit}`)
    .join(" ");
}

describe("work duration", () => {
  it("keeps zh and en output unchanged", () => {
    assert.equal(workedFor("en-US"), "1m 42s");
    assert.equal(
      workedFor("zh-CN"),
      `1 ${zhCN["chat.history.duration.minute"]} 42 ${zhCN["chat.history.duration.second"]}`,
    );
  });

  it("separates uk units from the number", () => {
    const minute = ukUA["chat.history.duration.minute"] ?? enUS["chat.history.duration.minute"];
    const second = ukUA["chat.history.duration.second"] ?? enUS["chat.history.duration.second"];
    assert.equal(workedFor("uk-UA"), `1 ${minute} 42 ${second}`);
  });

  it("turn header and completion card agree for every locale", () => {
    for (const locale of Object.keys(MESSAGES) as Locale[]) {
      assert.equal(
        formatConversationWorkDuration(DURATION_MS, intlFor(locale), locale),
        workedFor(locale),
      );
    }
  });
});

describe("memory updated-at", () => {
  // 2026-03-18 是周三；本周一为 03-16。
  const now = new Date(2026, 2, 18, 15, 0).getTime();
  const format = (locale: Locale, updatedAt: number) =>
    formatMemoryUpdatedAt({ formatMessage: intlFor(locale).formatMessage, locale, now, updatedAt });

  it("uses Intl weekday and date names for uk", () => {
    const monday = new Date(2026, 2, 16, 9, 5).getTime();
    const weekday = new Intl.DateTimeFormat("uk-UA", { weekday: "short" }).format(monday);
    assert.ok(format("uk-UA", monday).includes(weekday), format("uk-UA", monday));

    const lastYear = new Date(2025, 10, 3, 9, 5).getTime();
    const date = new Intl.DateTimeFormat("uk-UA", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(lastYear);
    assert.ok(format("uk-UA", lastYear).includes(date), format("uk-UA", lastYear));
  });

  it("keeps zh and en weekday output unchanged", () => {
    const monday = new Date(2026, 2, 16, 9, 5).getTime();
    assert.ok(format("en-US", monday).includes("Mon"), format("en-US", monday));
    assert.ok(format("zh-CN", monday).includes("一"), format("zh-CN", monday));
  });
});

describe("compact numbers", () => {
  it("formats token counts with the uk compact notation", () => {
    assert.equal(
      formatCompactTokenNumber("uk-UA", 1_200),
      new Intl.NumberFormat("uk-UA", { notation: "compact", maximumFractionDigits: 1 }).format(
        1_200,
      ),
    );
    assert.equal(formatCompactTokenNumber("en-US", 1_200), "1.2K");
  });
});
