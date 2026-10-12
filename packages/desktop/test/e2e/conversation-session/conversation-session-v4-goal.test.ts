// M4 gate: sendGoalCommand (v4 composer slash `/goal <objective>`).
// Evidence layer L3: establish session → composer `/goal E2E_V4_GOAL_OBJECTIVE …` → handleSlashCommand →
// dispatchCommand("sendGoalCommand") → v4-bridge goalSession(set) → TargetChanged event →
// reducer updates the goal state → unified status-panel shell projects objective + active.
// Proves the full chain: goal slash entry + goal state projection + summary timer/pause/resume UI.
import { TID_CHAT_SUMMARY_PANEL, TID_V4_COMPOSER_INPUT } from "@zcode/shared";
import {
  clearAppData,
  setInputValueByTestIdDom,
} from "../helpers/desktop-app.js";
import { selectUpstreamThoughtLevelValue } from "../helpers/upstream-provider.js";
import {
  assertUpstreamThoughtLevelCapture,
  waitForUpstreamNetworkRequestStarted,
} from "../helpers/upstream-capture.js";
import {
  clickV4Send,
  getV4GoalProjection,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("v4 M4 门禁：sendGoalCommand（/goal slash）", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("建立 session → /goal → status panel 投影 → 独立 pause/resume", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_GOAL_SEED 建立会话");
    await waitForV4TimelineContaining("V4_GOAL_SEED_OK", 45000);
    await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "会话没有建立",
      45000,
    );

    // Set the goal via the composer (objective contains a fixture-matching sentinel)
    // Merged restore: /goal and a normal send must consume the same submission reasoning level, not re-read or reuse the old session's level.
    await selectUpstreamThoughtLevelValue("low");
    await setInputValueByTestIdDom(
      TID_V4_COMPOSER_INPUT,
      "/goal E2E_V4_GOAL_OBJECTIVE 完成竖切目标",
      { timeout: 15000, timeoutMsg: "composer 输入框没有出现" },
    );
    await clickV4Send();

    // goal banner appears, objective contains the sentinel, status is active (continuation slow stream keeps the window)
    await browser.waitUntil(
      async () => {
        const banner = await getV4GoalProjection();
        return (
          banner !== null &&
          (banner.objective ?? "").includes("E2E_V4_GOAL_OBJECTIVE")
        );
      },
      {
        timeout: 45000,
        timeoutMsg: "goal 状态面板投影没有出现或 objective 不含 sentinel",
      },
    );
    const banner = await getV4GoalProjection();
    expect(banner?.objective).toContain("E2E_V4_GOAL_OBJECTIVE");
    expect(["active", "verifying"]).toContain(banner?.status);
    const goalRequest = await waitForUpstreamNetworkRequestStarted("E2E_V4_GOAL_OBJECTIVE");
    assertUpstreamThoughtLevelCapture(goalRequest, "low");

    // Bug cause: in narrow windows the status panel auto-collapses into a mini capsule; the collapsed state only offers the expand
    // entry and does not render pause/resume. The old case looked for pause directly and misreported a legitimate responsive layout as a projection failure.
    await browser.waitUntil(
      async () =>
        browser.execute((panelTestId) => {
          const panel = document.querySelector<HTMLElement>(
            `[data-testid="${panelTestId}"]`,
          );
          if (!panel) return false;
          if (panel.dataset.state === "collapsed") {
            panel.querySelector<HTMLButtonElement>("button")?.click();
            return false;
          }
          return panel.dataset.state === "expanded";
        }, TID_CHAT_SUMMARY_PANEL),
      { timeout: 15000, timeoutMsg: "goal 状态面板没有展开" },
    );

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-goal-action="pause"]',
          );
          return Boolean(button && !button.disabled);
        }),
      { timeout: 15000, timeoutMsg: "active goal 没有可用的 pauseGoal 按钮" },
    );
    const activeElapsed = await browser.execute(() => {
      const metric = document.querySelector<HTMLElement>(
        "[data-goal-elapsed-seconds]",
      );
      return Number(metric?.getAttribute("data-goal-elapsed-seconds") ?? -1);
    });
    expect(activeElapsed).toBeGreaterThanOrEqual(0);
    const paused = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-goal-action="pause"]',
      );
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    expect(paused).toBe(true);
    await browser.waitUntil(
      async () => (await getV4GoalProjection())?.status === "paused",
      { timeout: 15000, timeoutMsg: "pauseGoal 后目标没有进入 paused" },
    );

    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-goal-action="resume"]',
          );
          return Boolean(button && !button.disabled);
        }),
      {
        timeout: 15000,
        timeoutMsg: "paused goal 没有可用的三角 resumeGoal 按钮",
      },
    );
    const resumed = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-goal-action="resume"]',
      );
      if (!button || button.disabled) return false;
      button.click();
      return true;
    });
    expect(resumed).toBe(true);
    await browser.waitUntil(
      async () => {
        const status = (await getV4GoalProjection())?.status;
        return (
          status === "active" || status === "verifying" || status === "verified"
        );
      },
      { timeout: 45000, timeoutMsg: "resumeGoal 后目标没有恢复或完成" },
    );
  });
});
