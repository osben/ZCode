// @vitest-environment jsdom
// Top-level tabs of the automations page: "Automation / Workflows"
// (docs/dynamic-workflow/launch.md, "Where it lives" / "label memory").
import { createElement, useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TID_AUTOMATIONS_PAGE_TAB, testId } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  AutomationsPageTitleSwitch,
  type AutomationsPageTab,
} from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";
import {
  readAutomationsPageTab,
  writeAutomationsPageTab,
} from "@/settings/saved-workflows/automationsPageTabMemory.js";

function Harness({ initial = "automation" }: { initial?: AutomationsPageTab }) {
  const [tab, setTab] = useState<AutomationsPageTab>(initial);
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "zh-CN" },
    createElement(AutomationsPageTitleSwitch, { value: tab, onValueChange: setTab }),
  );
}

// Under jsdom, `new URL(…, import.meta.url)` is not a file: URL; vitest runs from the repo root,
// so resolve the source relative to cwd.
const automationsSectionSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/settings/AutomationsSection.tsx"),
  "utf8",
).replaceAll("\r\n", "\n");

describe("AutomationsPageTitleSwitch", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("两个标题词是 tablist 里的 tab，选中态跟随 value", () => {
    render(createElement(Harness));
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["自动化", "工作流"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    // Only the selected item joins the Tab order; unselected items rely on arrow keys.
    expect(tabs[0]?.getAttribute("tabindex")).toBe("0");
    expect(tabs[1]?.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(screen.getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow")));
    expect(
      screen
        .getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"))
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("方向键在两个标签间循环切换", () => {
    render(createElement(Harness));
    const tablist = screen.getByRole("tablist");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(
      screen
        .getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"))
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(
      screen
        .getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "automation"))
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });
    expect(
      screen
        .getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"))
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("标题字号沿用原 h1 的 30/34 页面标题层级，未选中用次级色", () => {
    render(createElement(Harness));
    const active = screen.getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "automation"));
    const inactive = screen.getByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"));
    expect(active.className).toContain("text-[30px]");
    expect(active.className).toContain("leading-[34px]");
    expect(active.className).toContain("text-foreground");
    expect(inactive.className).toContain("text-foreground-subtle");
  });
});

describe("automationsPageTabMemory", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("app 级单 key 记在 sessionStorage，不再按项目分桶；未知值回默认", () => {
    expect(readAutomationsPageTab()).toBe("automation");
    writeAutomationsPageTab("workflow");
    expect(readAutomationsPageTab()).toBe("workflow");
    // A single key, independent of the active project.
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem("zcode-automations-page-tab")).toBe("workflow");
    sessionStorage.setItem("zcode-automations-page-tab", "bogus");
    expect(readAutomationsPageTab()).toBe("automation");
    writeAutomationsPageTab("automation");
    expect(readAutomationsPageTab()).toBe("automation");
    expect(sessionStorage.length).toBe(1);
  });
});

describe("AutomationsSection 顶级标签接线", () => {
  it('页标题即切换，且 openAutomationTab: "workflow" 深链直接落到工作流页', () => {
    // The title component decides between switch and flat h1 via the gray-scale flag
    // (gray-scale assertions live in dynamicWorkflowGrayAutomationsPage.test.ts).
    expect(automationsSectionSource).toMatch(
      /<AutomationsPageTitle\s+workflowTabEnabled=\{dynamicWorkflowEnabled\}\s+value=\{pageTab\}\s+onValueChange=\{setPageTab\}\s*\/>/,
    );
    // Memory is app-level now: no more pageTabStorageKey; reads take no arguments and writes take
    // one.
    expect(automationsSectionSource).not.toContain("pageTabStorageKey");
    expect(automationsSectionSource).toContain("readAutomationsPageTab()");
    expect(automationsSectionSource).toContain("writeAutomationsPageTab(next)");
    expect(automationsSectionSource).toMatch(
      /if \(openAutomationTab === "workflow"\) \{\s*setPageTab\("workflow"\);\s*onOpenAutomationConsumed\?\.\(\);\s*return;/,
    );
    // The scheduled / off-peak task pill rows stay inside "Automation": the whole Workflows page
    // is delegated to SavedWorkflowsSection.
    expect(automationsSectionSource).toMatch(
      /if \(pageTab === "workflow"\) \{\s*return \(\s*<SavedWorkflowsSection/,
    );
    // Deep-link openWorkflow / consumption callbacks are passed through to SavedWorkflowsSection
    // (invariant 8, multi-project view).
    expect(automationsSectionSource).toContain("openWorkflow={openWorkflow}");
    expect(automationsSectionSource).toContain("onOpenWorkflowConsumed={onOpenWorkflowConsumed}");
  });
});
