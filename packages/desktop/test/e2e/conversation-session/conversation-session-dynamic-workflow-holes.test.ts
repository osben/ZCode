import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { clearAppData } from "../helpers/desktop-app.js";
import {
  approveV4Permission,
  prepareV4ConversationE2E,
  waitForV4Pane,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "../helpers/v4-conversation.js";
import { getLatestUpstreamToolResultByToolCallId } from "#e2e/helpers/conversation-session-network";

// Holes (docs/dynamic-workflow/presentation.md "Holes on the timeline", docs/dynamic-workflow/launch.md
// "The `FillWorkflowHole` tool", docs/dynamic-workflow/transcript-and-notifications.md "The hole row's live state"):
// three desktop flows — the hole station and its waiting state on the run card, the notification row's three states,
// and the new stations that grow on the card and side pane after a fill.
//
// The case-local replay only decides model calls; the real Skill, workflow compilation, approval,
// hole notification and fill still go through the product pipeline.
// Only after the first hole's waiting-state checks complete do we send the real fill instruction,
// so the automatic reply cannot race ahead and clear the UI state under verification.
const RUN_DIGEST = `[data-testid^="${TID_CHAT_WORKFLOW_RUN_DIGEST}"]`;
// The hole id is keyed by name (apps/zcode-cli/packages/dynamic-workflow/docs/analysis.md "Sites"): the "decide grouping" hole → this id.
const DECIDE_HOLE_ID = "hole#21b40fca";

describe("动态工作流 · 留白", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("DWH-01 卡上画出留白站，run 到达时变成等待态并长出「1 处留白待补全」", async function () {
    this.timeout(240000);
    await sendV4Prompt("E2E_DWH_START 使用工作流演示留白：先等待决定分组，再等待评判。");
    await approveV4Permission();
    // Reason: workflows use a dedicated summary and no longer render the generic ToolCallBlock; the real tool result confirms creation succeeded.
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwh_create"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "CreateWorkflow 未执行成功" },
    );
    const digest = await $(RUN_DIGEST);
    await digest.waitForDisplayed({ timeout: 120000 });

    // Hole station: dashed lamp + name (the type is not shown in the UI); the rail segment touching it is dashed;
    // after the tail hole there is a 40px stub.
    const holeStation = await digest.$(
      '[data-testid="workflow-timeline-station"][data-station-hole]',
    );
    await holeStation.waitForDisplayed({ timeout: 60000 });
    expect(await holeStation.getText()).toContain("决定分组");
    expect(await holeStation.getText()).not.toContain("Plan");
    await expect(
      digest.$('[data-testid="workflow-timeline-rail"][data-rail-dashed="true"]'),
    ).toBeExisting();
    await expect(digest.$('[data-testid="workflow-timeline-tail-stub"]')).toBeExisting();

    // Arrival: the lamp switches to a warning-color outline, the metadata reads "waiting for completion", the header grows a pen
    // chip; the lamp does not pulse.
    await browser.waitUntil(
      async () => (await holeStation.getAttribute("data-station-hole")) === "waiting",
      { timeout: 120000, timeoutMsg: "run 没有停在留白上" },
    );
    await expect(holeStation.$('[data-testid="workflow-hole-waiting"]')).toBeDisplayed();
    await expect(holeStation.$(".wf-lamp-hole-waiting")).toBeExisting();
    await expect(holeStation.$(".wf-lamp-running")).not.toBeExisting();
    const chip = await digest.$('[data-testid="workflow-digest-holes"]');
    await chip.waitForDisplayed({ timeout: 30000 });
    expect(await chip.getText()).toContain("1 处留白待补全");
    // An open hole is a step on the main agent's lane, not a subagent: the station containing the `hole()` call does
    // not gain an extra "unnamed subagent" pill.
    for (const pill of await digest.$$('[data-testid="workflow-agent-pill"]')) {
      expect(await pill.getText()).not.toContain("未命名子代理");
    }
  });

  it("DWH-02 通知行：笔图标、「工作流留白 · 等待补全」，展开体有提示、位置、草稿路径与等待时长", async function () {
    this.timeout(120000);
    const row = await $(
      '[data-testid^="chat-workflow-notification-row-"][data-hole-state="waiting"]',
    );
    await row.waitForDisplayed({ timeout: 120000 });
    expect(await row.getText()).toContain("工作流留白 · 等待补全");
    expect(await row.$('[data-testid="workflow-hole-notification-name"]').getText()).toBe(
      "决定分组",
    );
    await row.$('[role="button"]').click();
    const body = await row.$('[data-testid="workflow-hole-notification-body"]');
    await body.waitForDisplayed({ timeout: 10000 });
    await expect(body).toHaveText(expect.stringContaining("补全须返回 Plan"));
    await expect(body.$('[data-testid="workflow-hole-notification-draft"]')).toBeExisting();
    await expect(body.$('[data-testid="workflow-hole-notification-waited"]')).toBeExisting();
  });

  it("DWH-03 补全接进 run：补全行说「留白已补全」，卡长出头与新站，通知行翻成「留白已补全」", async function () {
    this.timeout(240000);
    await waitForV4Pane((pane) => !pane.canStop, "留白通知回复未结束", 30000);
    // The two-second fresh state is a visual transient; observe the DOM before the real action
    // instead of adding delays or racing a timed screenshot.
    await browser.execute(() => {
      const probe = window as Window & { __dwhFreshSeen?: boolean };
      probe.__dwhFreshSeen = false;
      const observer = new MutationObserver(() => {
        if (
          document.querySelector(
            '[data-testid="workflow-timeline-fill-frame"][data-fill-fresh="true"]',
          )
        ) {
          probe.__dwhFreshSeen = true;
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-fill-fresh"],
      });
    });
    await sendV4Prompt("E2E_DWH_FILL_NOW 补全决定分组，加入收集和分组两个阶段，继续等评判。");
    await browser.waitUntil(
      async () =>
        (await getLatestUpstreamToolResultByToolCallId("toolu_dwh_fill"))?.isError === false,
      { timeout: 60_000, timeoutMsg: "FillWorkflowHole 未执行成功" },
    );
    await waitForV4AssistantMessageContaining("补全", 180000);
    const fillRow = await $(
      '[data-testid="workflow-tool-summary"][data-tool-call-id]:has([data-testid="workflow-summary-hole-name"])',
    );
    await fillRow.waitForDisplayed({ timeout: 60000 });
    expect(await fillRow.getText()).toContain("留白已补全");
    expect(await fillRow.$('[data-testid="workflow-summary-hole-phases"]').getText()).toContain(
      "个阶段",
    );

    const digest = await $(RUN_DIGEST);
    const head = await digest.$('[data-testid="workflow-timeline-fill-head"]');
    await head.waitForDisplayed({ timeout: 60000 });
    expect(await head.getText()).toContain("决定分组");
    // For two seconds after joining the run, the frame draws itself once (a warning-colored stroke); afterwards it
    // only draws when the pointer rests on the head.
    expect(
      await browser.execute(() => (window as Window & { __dwhFreshSeen?: boolean }).__dwhFreshSeen),
    ).toBe(true);
    await browser.waitUntil(
      async () =>
        !(await digest
          .$('[data-testid="workflow-timeline-fill-frame"][data-fill-fresh="true"]')
          .isExisting()),
      { timeout: 10000, timeoutMsg: "框的新鲜态没有在两秒后退去" },
    );
    // Stations light up nothing: when the pointer lands on a station written by a fill, no frame is drawn.
    await (
      await digest.$(`[data-testid="workflow-timeline-station"][data-fill="${DECIDE_HOLE_ID}"]`)
    ).moveTo();
    await expect(
      digest.$('[data-testid="workflow-timeline-fill-frame"][data-fill-on="true"]'),
    ).not.toBeExisting();
    // The head lights up its own frame, and it is the only one.
    await head.moveTo();
    await expect(
      digest.$(
        `[data-testid="workflow-timeline-fill-frame"][data-fill-frame="${DECIDE_HOLE_ID}"][data-fill-on="true"]`,
      ),
    ).toBeExisting();
    expect(
      await digest.$$('[data-testid="workflow-timeline-fill-frame"][data-fill-on="true"]'),
    ).toHaveLength(1);
    // The first hole is filled and the run immediately reaches the second; one hole still waits,
    // so the global chip must not be required to disappear.
    await expect(digest.$('[data-testid="workflow-digest-holes"]')).toHaveText(
      expect.stringContaining("1 处留白待补全"),
    );
    await expect(
      digest.$('[data-testid="workflow-timeline-station"][data-station-hole="waiting"]'),
    ).toHaveText(expect.stringContaining("评判"));

    const row = await $(
      '[data-testid^="chat-workflow-notification-row-"][data-hole-state="filled"]',
    );
    await row.waitForDisplayed({ timeout: 60000 });
    expect(await row.getText()).toContain("留白已补全");
  });

  it("DWH-04 侧板：留白节头、等待体，补全后的标题行（它是框的头）与不缩进的补全节；侧栏运行行写「评判 · 等待补全」", async function () {
    this.timeout(120000);
    const digest = await $(RUN_DIGEST);
    await (await digest.$('[data-testid="workflow-timeline-fill-head"]')).click();
    const heading = await $('[data-testid="workflow-run-fill-heading"]');
    await heading.waitForDisplayed({ timeout: 60000 });
    expect(await heading.getText()).toContain("决定分组");
    await expect(
      $(`[data-testid="workflow-run-phase"][data-phase-fill="${DECIDE_HOLE_ID}"]`),
    ).toBeExisting();
    // The heading row is this fill's head: when the pointer lands on it, the side pane draws the same frame (vertically).
    await heading.moveTo();
    await expect(
      $(
        `[data-testid="workflow-run-fill-frame"][data-fill-frame="${DECIDE_HOLE_ID}"][data-fill-on="true"]`,
      ),
    ).toBeExisting();
    // The still-open tail hole appears in the side pane as a dashed lamp + name; its type is not shown in the UI.
    const tail = await $('[data-testid="workflow-run-phase"][data-phase-hole="waiting"]');
    await expect(tail).toBeExisting();
    expect(await tail.getText()).toContain("评判");
    expect(await tail.getText()).not.toContain("Verdict");
    // Sidebar run line: while the run sits at the second hole it reads "verdict · waiting for completion", and the mini rail's lamp is
    // a dashed warning color.
    const line = await $('[data-workflow-run-line="true"]');
    await browser.waitUntil(async () => (await line.getText()).includes("等待补全"), {
      timeout: 120000,
      timeoutMsg: "侧栏运行行没有写「等待补全」",
    });
    await expect(line.$('[data-rail-hole="waiting"]')).toBeExisting();
    await expect($('[data-testid="workflow-run-hole-waiting"]')).toBeExisting();
    // The waiting body renders the prompt the main agent received (run state holes[].prompt, from hole-reached).
    await expect($('[data-testid="workflow-run-hole-prompt"]')).toBeExisting();
    await expect($('[data-testid="workflow-run-holes"]')).toBeExisting();
  });
});
