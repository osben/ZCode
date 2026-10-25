// @vitest-environment jsdom
// Automations page with the dynamic workflow gray release disabled
// (docs/dynamic-workflow/launch.md "Gray release" DWG-07):
// with the gate off, the title offers no workflow tab.
//
import { createElement, useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TID_AUTOMATIONS_PAGE_TAB } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { expectedCopy } from "./helpers/uiCopy.js";
import {
  AutomationsPageTitle,
  type AutomationsPageTab,
} from "@/settings/saved-workflows/AutomationsPageTitleSwitch.js";

function Title({
  workflowTabEnabled,
  locale = "en-US",
}: {
  workflowTabEnabled: boolean;
  locale?: "zh-CN" | "en-US";
}) {
  const [tab, setTab] = useState<AutomationsPageTab>("automation");
  return createElement(
    ZCodeIntlProvider,
    { initialLocale: locale },
    createElement(AutomationsPageTitle, {
      workflowTabEnabled,
      value: tab,
      onValueChange: setTab,
    }),
  );
}

describe("AutomationsPageTitle gray gate", () => {
  afterEach(() => {
    cleanup();
  });

  it("gate off → flat 「Automations」 title, no tablist, no 「Workflows」 wording", () => {
    render(createElement(Title, { workflowTabEnabled: false }));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"))).toBeNull();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe(expectedCopy("settings.automations.title"));
  });

  it("gate off + en-US → title comes from the same i18n key, not hardcoded copy", () => {
    render(createElement(Title, { workflowTabEnabled: false, locale: "en-US" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Automations");
  });

  it("gate on → same as before the change: both title words form a tablist", () => {
    render(createElement(Title, { workflowTabEnabled: true }));
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      expectedCopy("automations.pageTab.automation"),
      expectedCopy("automations.pageTab.workflow"),
    ]);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});
