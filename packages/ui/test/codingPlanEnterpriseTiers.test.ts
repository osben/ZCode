import { describe, expect, it } from "vitest";
import { formatEnterpriseTier } from "@/settings/model-provider-section/codingPlanEnterpriseTiers.js";
import zhCN from "@/i18n/locales/zh-CN.js";

// After the native purchase panel was retired, enterprise tiers are still used in the settings
// page; the language contract for that live code is kept here.
describe("enterprise tier labels", () => {
  it.each([
    ["LITE", "基础版"],
    ["PRO", "标准版"],
    ["MAX", "高级版"],
  ])("localizes %s using the configured messages", (tier, label) => {
    expect(
      formatEnterpriseTier(tier, {
        locale: "en-US",
        formatMessage: (id, fallback) => zhCN[id as keyof typeof zhCN] ?? fallback,
      }),
    ).toBe(label);
  });

  it("preserves the English and unknown-tier fallback", () => {
    expect(formatEnterpriseTier("PRO", "en-US")).toBe("Pro");
    expect(formatEnterpriseTier("MAX", "en-US")).toBe("Max");
    expect(formatEnterpriseTier("TEAM_PLUS", "zh-CN")).toBe("Team_plus");
  });
});
