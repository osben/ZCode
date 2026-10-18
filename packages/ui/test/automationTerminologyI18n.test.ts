import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import {
  appendLocalCustomizeTemplate,
  resolveOffPeakTemplateText,
} from "@/settings/automationTemplateCatalog.js";

describe("Automations terminology", () => {
  it("keeps idle-time permissions on the main conversation vocabulary", () => {
    const modeValues = ["build", "edit", "plan", "yolo"] as const;

    expect(modeValues.map((value) => zhCN[`mode.label.glm.${value}`])).toEqual([
      "变更前确认",
      "自动编辑",
      "计划模式",
      "完全访问",
    ]);
    expect(modeValues.map((value) => enUS[`mode.label.glm.${value}`])).toEqual([
      "Ask before changes",
      "Edit automatically",
      "Plan mode",
      "Full access",
    ]);
    for (const value of modeValues) {
      expect(zhCN[`offPeak.mode.${value}`]).toBeUndefined();
      expect(enUS[`offPeak.mode.${value}`]).toBeUndefined();
    }
  });

  it("keeps the local Customize fallback copy for Client Scenes failures", () => {
    const customize = appendLocalCustomizeTemplate([])[0]!;
    const format =
      (messages: Record<string, string>) =>
      ({ id }: { id: string }) =>
        messages[id] ?? id;

    expect(resolveOffPeakTemplateText(customize, "title", "zh-CN", format(zhCN))).toBe("自定义");
    expect(resolveOffPeakTemplateText(customize, "title", "en-US", format(enUS))).toBe("Customize");
    expect(
      resolveOffPeakTemplateText(customize, "description", "zh-CN", format(zhCN)),
    ).toBeTruthy();
    expect(
      resolveOffPeakTemplateText(customize, "description", "en-US", format(enUS)),
    ).toBeTruthy();
  });

  it("does not retain locale entries for deleted static template catalogs", () => {
    const removedPrefixes = [
      "automations.template.",
      "offPeak.newTask.template.standupGitSummary.",
      "offPeak.newTask.template.ciFlakyReport.",
      "offPeak.newTask.template.documentationSyncCheck.",
    ];

    for (const messages of [enUS, zhCN]) {
      expect(
        Object.keys(messages).some((key) =>
          removedPrefixes.some((prefix) => key.startsWith(prefix)),
        ),
      ).toBe(false);
    }
  });

  it("keeps imminent next-run copy grammatical across locales", () => {
    const englishNextRun = enUS["automations.nextRun"].replace(
      "{when}",
      enUS["automations.time.soon"],
    );
    const chineseNextRun = zhCN["automations.nextRun"].replace(
      "{when}",
      zhCN["automations.time.soon"],
    );

    expect(englishNextRun).toBe("Next run soon");
    expect(chineseNextRun).toBe("下次运行 1 分钟内");
  });
});
