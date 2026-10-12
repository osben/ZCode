import { TID_OFFPEAK_CREATE_BUTTON, TID_AUTOMATIONS_OPEN } from "@zcode/shared";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAppData,
  clickTestIdByDom,
  waitForDefaultWorkspaceReady,
} from "./helpers/desktop-app.js";
import { loginWithApiKey } from "./helpers/conversation-session.js";

/**
 * Off-peak task "server quota snapshot pre-gating" end-to-end (D39).
 *
 * Driven by the in-process mock gateway (wdio.conf startOffPeakE2EMock: when this spec matches it additionally sets
 * ZCODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS=3600000). client/configs no longer sends down limit;
 * the UI gets can_take_number=false + next_take_at from GET /ticket/availability.
 *
 * Assertions: after the entry loads, the create button is greyed out ahead of time, and the Tooltip explains both quota exhaustion and the server-side recovery time.
 * Pauses are kept throughout and key states are screenshotted (ZCODE_OFFPEAK_SHOT_DIR) for screen-recording review.
 */
// Bugfix: a hardcoded system temp directory is unusable on Windows; the default screenshot directory must follow the running platform.
const SHOT_DIR =
  process.env.ZCODE_OFFPEAK_SHOT_DIR ?? join(tmpdir(), "zc-offpeak-verify-shots");
let shotSeq = 0;
async function shot(label: string): Promise<void> {
  shotSeq += 1;
  const name = `${String(shotSeq).padStart(2, "0")}-${label}.png`;
  try {
    await browser.saveScreenshot(join(SHOT_DIR, name));
  } catch {
    // A screenshot failure does not block assertions (screen recording is auxiliary).
  }
}

describe("闲时任务服务端额度快照置灰 E2E（D39）", () => {
  before(() => {
    try {
      mkdirSync(SHOT_DIR, { recursive: true });
    } catch {
      // ignore
    }
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("availability 不可创建时按钮置灰并显示 next_take_at", async function () {
    this.timeout(150000);

    // Session readiness: log in (if stuck on the welcome page) + wait for the default workspace to be ready, then Automations (inside Settings) can be opened;
    // do not go through startNewTask's conversation draft flow (unrelated to off-peak). The off-peak mock gateway avoids real model requests.
    try {
      await waitForDefaultWorkspaceReady(30000);
    } catch {
      await loginWithApiKey();
      await waitForDefaultWorkspaceReady(30000);
    }

    // 1) Open the Automations main view.
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现 Automations 入口",
    });
    await browser.pause(2500); // recording: stay on the main view to show the initial button state
    await shot("automations-open");

    // 2) availability=false: the button should be greyed out before the actual POST /ticket.
    await browser.waitUntil(async () => (await offPeakCreateButtonState()).present, {
      timeout: 10000,
      timeoutMsg: "闲时任务创建按钮没有出现（灰度未命中？）",
    });
    // Covers the large-font scenario from the user's screenshot, ensuring the relative-duration text still fits fully inside the Tooltip background.
    await browser.execute(() => {
      document.documentElement.style.setProperty("--ui-font-size", "20px");
    });
    const state = await offPeakCreateButtonState();
    if (!state.disabled) {
      throw new Error("服务端额度不可用时，创建按钮应提前置灰");
    }
    if (!state.tooltip || !/额度|limit/i.test(state.tooltip)) {
      throw new Error(`额度置灰必须显示 Tooltip：${state.tooltip ?? "<empty>"}`);
    }
    if (!/(小时|分钟|hr|min)/i.test(state.tooltip)) {
      throw new Error(`额度 Tooltip 必须包含小时/分钟剩余时长：${state.tooltip}`);
    }
    if (/\d{4}|年|月|日/.test(state.tooltip)) {
      throw new Error(`额度 Tooltip 不应展示年月日或绝对日期：${state.tooltip}`);
    }
    if (!state.contentContained) {
      throw new Error("额度 Tooltip 文案必须完整包含在背景内");
    }
    await shot("create-button-quota-disabled");
    await browser.pause(3000); // recording: stay on the quota-gated state to show the final effect
  });
});

/** Current state of the create button: presence / disabled / Radix Tooltip text. */
async function offPeakCreateButtonState(): Promise<{
  present: boolean;
  disabled: boolean;
  tooltip: string | null;
  contentContained: boolean;
}> {
  const state = await browser.execute((btnTid) => {
    const button = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === btnTid,
    );
    if (!(button instanceof HTMLButtonElement)) {
      return { present: false, disabled: false };
    }
    return {
      present: true,
      disabled: button.disabled,
    };
  }, TID_OFFPEAK_CREATE_BUTTON);

  if (!state.present) {
    return { ...state, tooltip: null, contentContained: false };
  }
  const button = await $(`[data-testid="${TID_OFFPEAK_CREATE_BUTTON}"]`);
  const trigger = await button.$("..");
  // Radix Tooltip depends on a real pointer enter/leave lifecycle; a single synthesized pointermove does not update its
  // internal hover state, so hover via WebDriver and wait for the portal to enter the open state.
  await trigger.moveTo();
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>("[data-slot='tooltip-content']"),
        ).some((item) => item.dataset.state !== "closed"),
      ),
    { timeout: 5_000, timeoutMsg: "额度 Tooltip 没有在真实悬停后打开" },
  );
  const tooltip = await browser.execute(() => {
    const content = Array.from(
      document.querySelectorAll<HTMLElement>("[data-slot='tooltip-content']"),
    ).find((item) => item.dataset.state !== "closed");
    // ControlHintTooltip's body token has been consolidated from text-ui-base to text-ui-sm; the tooltip is
    // genuinely open, and the old E2E misjudged valid text as empty because it queried the old class.
    const title = content?.querySelector<HTMLElement>(":scope > span.text-ui-sm");
    if (!content || !title) {
      return { text: null, contentContained: false };
    }
    const contentRect = content.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    return {
      text: title.textContent?.trim() ?? null,
      contentContained:
        titleRect.left >= contentRect.left - 0.5 &&
        titleRect.right <= contentRect.right + 0.5 &&
        titleRect.top >= contentRect.top - 0.5 &&
        titleRect.bottom <= contentRect.bottom + 0.5,
    };
  });
  return {
    ...state,
    tooltip: tooltip.text,
    contentContained: tooltip.contentContained,
  };
}
