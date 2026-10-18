import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { getUpstreamRequestRecordCount } from "../../../helpers/conversation-session-network.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4UserMessageContaining,
} from "../../../helpers/v4-conversation.js";

// specs/incognito-session.md scenarios 13 and 17: composer toggle, per-session checklist, tint +
// chip, and the sidebar marker after the first send.
const TRIGGER = '[data-testid="v4-composer-incognito-trigger"]';
const TOGGLE = '[data-testid="v4-composer-incognito-toggle"]';
const MCP_ITEM = '[data-testid="v4-composer-incognito-toggle-mcp"]';
const MARKER = '[data-testid="v4-composer-incognito-marker"]';
const OFF = '[data-testid="v4-composer-incognito-off"]';

// The toggle row arms the intent only after the Settings defaults read resolves, so the checked
// state settles asynchronously.
async function waitForIncognitoChecked() {
  await browser.waitUntil(async () => (await $(TOGGLE).getAttribute("aria-checked")) === "true", {
    timeoutMsg: "incognito toggle did not become checked",
  });
}

describe("Incognito session draft", () => {
  after(async () => {
    await clearAppData();
  });

  it("INCOGNITO-01: toggle, checklist and chip change only the draft, no request", async () => {
    await prepareV4ConversationE2E();
    const before = await getUpstreamRequestRecordCount();

    await $(TRIGGER).click();
    const toggle = $(TOGGLE);
    await toggle.waitForDisplayed();
    expect(await toggle.getAttribute("role")).toBe("menuitemcheckbox");
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    await toggle.click();
    await waitForIncognitoChecked();

    const mcp = $(MCP_ITEM);
    await mcp.waitForDisplayed();
    expect(await mcp.getAttribute("aria-checked")).toBe("false");
    await mcp.click();
    expect(await mcp.getAttribute("aria-checked")).toBe("true");
    await browser.keys("Escape");

    await $(MARKER).waitForDisplayed();
    expect(await $(TRIGGER).getAttribute("aria-pressed")).toBe("true");
    // specs/incognito-session.md "Composer toggle": the control sits in the trailing cluster, left of the model controls.
    const inTrailingCluster = await browser.execute((triggerSelector) => {
      const trigger = document.querySelector(triggerSelector);
      return Boolean(trigger?.closest("[data-composer-trailing-actions]"));
    }, TRIGGER);
    expect(inTrailingCluster).toBe(true);
    const tinted = await browser.execute((inputSelector) => {
      const shell = document.querySelector(inputSelector)?.closest(".rounded-2xl");
      return shell?.className.includes("!border-incognito") ?? false;
    }, `[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    expect(tinted).toBe(true);

    // The turn-off button is revealed on hover/focus of the chip (project-chip pattern).
    await $(MARKER).moveTo();
    await $(OFF).click();
    await $(MARKER).waitForExist({ reverse: true });
    expect(await $(TRIGGER).getAttribute("aria-pressed")).toBe("false");
    expect(await getUpstreamRequestRecordCount()).toBe(before);
  });

  it("INCOGNITO-02: the first send creates an incognito session marked in the sidebar", async () => {
    await prepareV4ConversationE2E();
    await $(TRIGGER).click();
    await $(TOGGLE).waitForDisplayed();
    await $(TOGGLE).click();
    // The intent must be armed before the draft is sent, or the send creates a normal session.
    await waitForIncognitoChecked();
    await browser.keys("Escape");
    await $(MARKER).waitForDisplayed();

    const prompt = "incognito e2e first message";
    await sendV4Prompt(prompt);
    await waitForV4UserMessageContaining(prompt);

    // The draft intent is consumed by the created session; the sidebar row carries the marker.
    await $(MARKER).waitForExist({ reverse: true });
    await $('[data-incognito-task-icon="true"]').waitForDisplayed({
      timeoutMsg: "incognito sidebar marker not shown",
    });
  });
});
