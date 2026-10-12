import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

/**
 * Reads repository source for text-contract assertions.
 *
 * Bugfix: some assertions below contain multi-line fragments (`<AutomationCreateDropdown\n
 * ...`), but the repo only declares `eol=lf` for *.mjs / *.sh; all other sources are CRLF in a
 * Windows checkout with `core.autocrlf=true`, so `toContain`'s `\n` never matches `\r\n` and the
 * case would always fail on Windows. What it asserts is a source-content contract, independent
 * of line-ending bytes; normalize to LF before comparing.
 */
const automationsSectionSource = readFileSync(
  new URL("../src/settings/AutomationsSection.tsx", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

describe("Automations populated-list Figma contract", () => {
  it("removes the All tab and its unified mixed grid", () => {
    // Spec source: docs/off-peak-task/decisions.md D47 (2026-07-28) — the main view keeps only
    // the Scheduled / Idle tabs; the mixed All overview and its unified grid are removed. The
    // task-area anchor is kept for layout assertions.
    expect(automationsSectionSource).not.toContain('"all"');
    expect(automationsSectionSource).not.toContain("showUnifiedAllTaskGrid");
    expect(automationsSectionSource).toContain("data-automations-task-grid");
    expect(automationsSectionSource).toContain(
      '"grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2"',
    );
  });

  it("keeps the populated banner ahead of tasks with the Figma spacing", () => {
    const bannerStart = automationsSectionSource.indexOf("<AutomationKeepAwakeNotice");
    const gridStart = automationsSectionSource.indexOf("data-automations-task-grid");

    expect(bannerStart).toBeGreaterThanOrEqual(0);
    expect(gridStart).toBeGreaterThan(bannerStart);
    // D47: keep-awake is a global switch shown on both Scheduled / Idle tabs; with tasks
    // present, the banner and action row tighten to 20px.
    expect(automationsSectionSource).toMatch(/hasAnyTasks \? "mt-5" : "mt-8"/);
  });

  it("keeps inactive tabs transparent and shows the scheduled create split action only on its tab", () => {
    expect(automationsSectionSource).toContain(
      '"text-foreground-subtle hover:bg-hover hover:text-foreground"',
    );
    expect(automationsSectionSource).not.toContain(
      '"bg-surface text-foreground-subtle hover:bg-hover hover:text-foreground"',
    );
    expect(automationsSectionSource).toContain(
      "<AutomationCreateDropdown\n                onViaChat={handleCreateViaChat}",
    );
    expect(automationsSectionSource).not.toContain("appearance={");
  });

  it("keeps manual refresh immediately before the populated create action", () => {
    const refreshAction = automationsSectionSource.indexOf(
      'aria-label={intl.formatMessage({ id: "automations.refresh" })}',
    );
    const createAction = automationsSectionSource.indexOf(
      "<AutomationCreateDropdown\n                onViaChat={handleCreateViaChat}",
    );

    expect(refreshAction).toBeGreaterThanOrEqual(0);
    expect(createAction).toBeGreaterThan(refreshAction);
    expect(automationsSectionSource).toContain("refresh(zcodeAgentService)");
    expect(automationsSectionSource).toContain("offPeakRefresh(offPeakTaskService)");
    expect(automationsSectionSource).toMatch(
      /variant="outline"\s+size="icon"\s+aria-label=\{intl\.formatMessage\(\{ id: "automations\.refresh" \}\)\}/,
    );
  });

  it("keeps scheduled-task delete confirmation buttons text-only", () => {
    expect(automationsSectionSource).toMatch(
      /presentation: "automation-confirmation",[\s\S]*?id: "automations\.delete\.title"[\s\S]*?confirmVariant: "destructive",[\s\S]*?showKeyboardHints: false,/,
    );
  });

  it("labels scheduled-task toggle actions as pause and continue", () => {
    expect(zhCN["automations.pause"]).toBe("暂停");
    expect(zhCN["automations.resume"]).toBe("继续");
    expect(enUS["automations.pause"]).toBe("Pause");
    expect(enUS["automations.resume"]).toBe("Continue");
  });

  it("uses the dedicated idle-time delete confirmation action label", () => {
    expect(automationsSectionSource).toMatch(
      /id: "offPeak\.delete\.title"[\s\S]*?id: "offPeak\.delete\.description"[\s\S]*?id: "offPeak\.delete\.confirm"/,
    );
  });

  it("dims paused schedule time and run count to 40 percent opacity", () => {
    expect(automationsSectionSource).toContain("font-normal text-success opacity-40");
    expect(automationsSectionSource).toMatch(
      /\(hasFailure \|\| status === "paused"\) &&\s+"opacity-40"/,
    );
  });

  it("shows only the cumulative run count without a max-runs denominator", () => {
    expect(automationsSectionSource).toContain('{ id: "automations.runCount" }');
    expect(automationsSectionSource).not.toContain('{ id: "automations.runCountLimited" }');
  });

  it("does not expose retry queue details on scheduled task cards", () => {
    expect(automationsSectionSource).not.toContain('id: "automations.retryQueued"');
    expect(automationsSectionSource).not.toContain("hasAutomationRetryQueueState(automation)");
  });

  it("shows a cron summary for completed scheduled tasks", () => {
    expect(automationsSectionSource).toMatch(
      /status === "paused" \|\|\s+status === "completed" \? \(/,
    );
  });

  it("keeps completed cards dimmed without card hover styling", () => {
    expect(automationsSectionSource).toMatch(
      /status === "completed"\s+\?\s+"opacity-60"\s+:\s+"hover:bg-hover"/,
    );
    expect(automationsSectionSource).not.toContain("opacity-60 hover:opacity-100");
  });

  it("appends next-run time only for active non-failing cards", () => {
    expect(automationsSectionSource).toContain("`${scheduleText} · ${intl.formatMessage(");
    // The list grid is embedded in a ternary branch of the filter empty state, so indentation
    // varies with structure; the assertion only cares about the call shape.
    expect(automationsSectionSource).toMatch(
      /formatAutomationCardNextRun\(\s*automation\.nextRunAt/,
    );
    // completed/paused/failed schedules no longer advance; for finite tasks that finished, the
    // nextRunAt can still point to a future time and must not be appended to the card copy.
    expect(automationsSectionSource).toContain(
      'status === "active" && !hasFailure && formattedNextRun',
    );
  });
});
