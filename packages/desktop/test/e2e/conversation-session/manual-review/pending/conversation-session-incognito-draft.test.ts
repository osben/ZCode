import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { getUpstreamRequestRecordCount } from "../../../helpers/conversation-session-network.js";
import {
  prepareV4ConversationE2E,
  pasteV4ComposerImageAttachment,
  waitForV4RowAttachments,
  sendV4Prompt,
  waitForV4UserMessageContaining,
} from "../../../helpers/v4-conversation.js";

// specs/incognito-session.md scenarios 13, 17 and 31: the icon turns incognito on directly (no menu),
// the chip text opens the capability checklist (no master row, no Settings link), the chip's × turns it
// off, the tint and chip, and the sidebar marker after the first send.
const TRIGGER = '[data-testid="v4-composer-incognito-trigger"]';
const MCP_ITEM = '[data-testid="v4-composer-incognito-capability-mcp"]';
const MARKER = '[data-testid="v4-composer-incognito-marker"]';
const OFF = '[data-testid="v4-composer-incognito-off"]';

// Turning on reads the Settings defaults asynchronously, so the chip appears once that read resolves.
async function waitForIncognitoOn() {
  await $(MARKER).waitForDisplayed({ timeoutMsg: "incognito chip did not appear" });
}

describe("Incognito session draft", () => {
  after(async () => {
    await clearAppData();
  });

  it("INCOGNITO-01: icon turns on, checklist and chip change only the draft, no request", async () => {
    await prepareV4ConversationE2E();
    const before = await getUpstreamRequestRecordCount();

    // Off: the icon turns incognito on directly; no menu opens.
    expect(await $(TRIGGER).getAttribute("aria-pressed")).toBe("false");
    await $(TRIGGER).click();
    await waitForIncognitoOn();
    expect(await $(TRIGGER).getAttribute("aria-pressed")).toBe("true");
    expect((await $$('[data-testid="v4-composer-incognito-toggle"]')).length).toBe(0);

    // On: the chip text opens the capability checklist.
    await $(TRIGGER).click();
    const mcp = $(MCP_ITEM);
    await mcp.waitForDisplayed();
    expect(await mcp.getAttribute("role")).toBe("menuitemcheckbox");
    expect(await mcp.getAttribute("aria-checked")).toBe("false");
    await mcp.click();
    expect(await mcp.getAttribute("aria-checked")).toBe("true");
    // The Settings link is not in the composer menu.
    expect((await $$('[data-testid="v4-composer-incognito-settings-link"]')).length).toBe(0);
    await browser.keys("Escape");

    // specs/incognito-session.md "Composer toggle": the control sits in the composer top row after the
    // project and branch chips, not in the bottom toolbar's trailing cluster.
    const placement = await browser.execute((triggerSelector) => {
      const trigger = document.querySelector(triggerSelector);
      return {
        inTopRow: Boolean(trigger?.closest("[data-composer-context-row]")),
        inTrailingCluster: Boolean(trigger?.closest("[data-composer-trailing-actions]")),
      };
    }, TRIGGER);
    expect(placement.inTopRow).toBe(true);
    expect(placement.inTrailingCluster).toBe(false);
    const tinted = await browser.execute((inputSelector) => {
      const shell = document.querySelector(inputSelector)?.closest(".rounded-2xl");
      return shell?.className.includes("!border-incognito") ?? false;
    }, `[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    expect(tinted).toBe(true);

    // The × is revealed on hover/focus of the chip (project-chip pattern) and is the only off control.
    await $(MARKER).moveTo();
    await $(OFF).click();
    await $(MARKER).waitForExist({ reverse: true });
    expect(await $(TRIGGER).getAttribute("aria-pressed")).toBe("false");
    expect(await getUpstreamRequestRecordCount()).toBe(before);
  });

  it("INCOGNITO-02: the first send creates an incognito session marked in the sidebar", async () => {
    await prepareV4ConversationE2E();
    await $(TRIGGER).click();
    // The intent must be armed before the draft is sent, or the send creates a normal session.
    await waitForIncognitoOn();

    const prompt = "incognito e2e first message";
    await sendV4Prompt(prompt);
    await waitForV4UserMessageContaining(prompt);

    // The draft intent is consumed by the created session; the sidebar row carries the marker.
    await $(MARKER).waitForExist({ reverse: true });
    await $('[data-incognito-task-icon="true"]').waitForDisplayed({
      timeoutMsg: "incognito sidebar marker not shown",
    });
  });
  it("INCOGNITO-03: a pasted image starts an incognito session without a prewarm upload target", async () => {
    await prepareV4ConversationE2E();
    await $(TRIGGER).click();
    await waitForIncognitoOn();
    const filename = await pasteV4ComposerImageAttachment("E2E_INCOGNITO_FIRST_IMAGE.png");
    const prompt = "E2E_INCOGNITO_FIRST_IMAGE describe the attached image";
    await sendV4Prompt(prompt);
    await waitForV4UserMessageContaining(prompt);
    expect(await waitForV4RowAttachments(30_000, [filename])).toContain(filename);
    await $('[data-incognito-task-icon="true"]').waitForDisplayed();
    await $(MARKER).waitForExist({ reverse: true });
  });
});
