// Message pins (docs/chat-message-pins.md): pin a completed assistant reply → chips bar appears →
// chip click jumps back to the row → unpin from the chip removes the bar. Display-only bookmark on
// the setRowPinned command path; the provider reply comes from case-local upstream replay.
import { TID_V4_PINNED_BAR, TID_V4_PINNED_CHIP } from "@zcode/shared";
import { clearAppData, waitForTestIdByDom } from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const MARKER = "E2E_MESSAGE_PINS";
const REPLY_TEXT = "E2E_MESSAGE_PINS_REPLY";

describe("会话消息固定（message pins）E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("固定 assistant 回复 → chip 条出现 → 点击 chip 定位消息 → chip 取消固定", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });

    await sendV4Prompt(`${MARKER} 回答一句话`);
    await waitForV4TimelineContaining(REPLY_TEXT, 60000);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "消息固定 case 首轮没有完成",
      90000,
    );

    // 1) Pin the completed assistant reply through its toolbar toggle.
    const pinClicked = await clickFirstV4Pin();
    expect(pinClicked).toBe(true);
    await waitForTestIdByDom(TID_V4_PINNED_BAR, {
      timeout: 15000,
      timeoutMsg: "固定后 chips 条没有出现",
    });
    const chipText = await browser.execute((chipPrefix) => {
      const chip = document.querySelector<HTMLElement>(`[data-testid^="${chipPrefix}"]`);
      return chip?.textContent ?? "";
    }, `${TID_V4_PINNED_CHIP}-`);
    expect(chipText).toContain(REPLY_TEXT);

    // 2) Chip jump: scroll the timeline away first, then the chip must bring the row back into view.
    await scrollTimelineToTop();
    const jumpedBack = await browser.execute((chipPrefix) => {
      const chip = document.querySelector<HTMLElement>(`[data-testid^="${chipPrefix}"]`);
      const jumpButton = chip?.querySelector<HTMLButtonElement>("button");
      if (!jumpButton) return false;
      jumpButton.click();
      return true;
    }, `${TID_V4_PINNED_CHIP}-`);
    expect(jumpedBack).toBe(true);
    await browser.waitUntil(async () => (await timelineScrollTop()) > 0, {
      timeout: 10000,
      timeoutMsg: "点击 chip 后时间线没有滚回固定消息",
    });

    // 3) Unpin from the chip removes the bar entirely.
    const unpinned = await browser.execute(() => {
      const unpin = document.querySelector<HTMLButtonElement>(
        '[data-testid^="v4-pinned-chip-unpin-"]',
      );
      if (!unpin) return false;
      unpin.click();
      return true;
    });
    expect(unpinned).toBe(true);
    await browser.waitUntil(
      async () =>
        browser.execute(
          (barTestId) => !document.querySelector(`[data-testid="${barTestId}"]`),
          TID_V4_PINNED_BAR,
        ),
      { timeout: 15000, timeoutMsg: "取消固定后 chips 条没有消失" },
    );
  });
});

async function clickFirstV4Pin(): Promise<boolean> {
  return browser.execute(() => {
    const pin = document.querySelector<HTMLButtonElement>('[data-testid^="v4-pin-"]');
    if (!pin) return false;
    pin.click();
    return true;
  });
}

async function scrollTimelineToTop(): Promise<void> {
  await browser.execute(() => {
    const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]');
    if (timeline) timeline.scrollTop = 0;
  });
}

async function timelineScrollTop(): Promise<number> {
  return browser.execute(() => {
    const timeline = document.querySelector<HTMLElement>('[data-v4-timeline-scroll="true"]');
    return timeline?.scrollTop ?? 0;
  });
}
