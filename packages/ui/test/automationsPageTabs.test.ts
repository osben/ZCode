// @vitest-environment jsdom
// Top-level tabs of the automations page: "Automations / Workflows"
// (docs/dynamic-workflow/launch.md "Where it lives" / "label memory").
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TID_AUTOMATIONS_PAGE_TAB } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  AutomationsPageTitleSwitch,
  type AutomationsPageTab,
} from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";
import {
  readAutomationsPageTab,
  writeAutomationsPageTab,
} from "@/settings/saved-workflows/automationsPageTabMemory.js";
import { expectedCopy } from "./helpers/uiCopy.js";

function Harness({ initial = "automation" }: { initial?: AutomationsPageTab }) {
  const [tab, setTab] = useState<AutomationsPageTab>(initial);
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: "en-US" },
    createElement(AutomationsPageTitleSwitch, { value: tab, onValueChange: setTab }),
  );
}

describe("AutomationsPageTitleSwitch", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("both title words are tabs in the tablist and the selected state follows value", () => {
    render(createElement(Harness));
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      expectedCopy("automations.pageTab.automation"),
      expectedCopy("automations.pageTab.workflow"),
    ]);
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

  it("arrow keys cycle between the two tabs", () => {
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
});

describe("automationsPageTabMemory", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("app-level single key stored in sessionStorage, no longer bucketed per project; unknown values fall back to default", () => {
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
