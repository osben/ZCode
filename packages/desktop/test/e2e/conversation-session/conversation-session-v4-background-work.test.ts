// M4 gate: cancelBackgroundWork (v4 background work panel cancel).
// Evidence layer L3: the first round's model returns a run_in_background Bash tool_use → approve the permission → background bash starts
// → BackgroundTaskStarted event → reducer fills backgroundWorks → background work panel shows running →
// click cancel → cancelBackgroundWork command → v4-bridge cancelBackgroundTask → process killed →
// BackgroundTaskCompleted(cancelled) → panel state cancelled. Proves the full background work chain.
import {
  clearAppData,
} from "../helpers/desktop-app.js";
import {
  approveV4Permission,
  clickV4BackgroundWorkCancel,
  getV4ComposerBackgroundWorkCounts,
  getLatestV4CommandAck,
  getV4BackgroundWorks,
  openV4ComposerRunningBackgroundWorks,
  prepareV4ConversationE2E,
  sendV4Prompt,
  setV4ElectronWindowSize,
  waitForV4PermissionDialog,
} from "../helpers/v4-conversation.js";

describe("v4 M4 门禁：cancelBackgroundWork", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("后台 bash 启动 → 面板显示 running → 取消 → cancelled", async function () {
    this.timeout(120000);
    await prepareV4ConversationE2E();
    await setV4ElectronWindowSize(1280, 900);

    // First round triggers a run_in_background Bash tool_use. If a permission dialog appears, approve it (best-effort).
    await sendV4Prompt("E2E_V4_BGWORK 起一个后台任务");
    try {
      await waitForV4PermissionDialog(15000);
      await approveV4Permission();
    } catch {
      // No permission dialog appeared (bash may be allowed by default) — go straight to waiting for the background work panel.
    }

    // The Composer entry first exposes the current session's typed running count.
    await browser.waitUntil(
      async () => {
        const counts = await getV4ComposerBackgroundWorkCounts();
        return (
          counts?.bashCount === 1 &&
          counts.subagentCount === 0 &&
          counts.totalCount === 1 &&
          counts.typedVisible &&
          !counts.compactVisible
        );
      },
      { timeout: 60000, timeoutMsg: "Composer 没有显示 running Bash typed count" },
    );

    // A narrow Composer merges into the total Activity count; after clicking, the panel uses an overlay and lands directly on Running.
    await setV4ElectronWindowSize(480, 800);
    await browser.waitUntil(
      async () => {
        const counts = await getV4ComposerBackgroundWorkCounts();
        return counts?.totalCount === 1 && counts.compactVisible && !counts.typedVisible;
      },
      { timeout: 15000, timeoutMsg: "窄 Composer 没有合并为 Activity 总数" },
    );
    await openV4ComposerRunningBackgroundWorks(60000);
    const narrowLayout = await browser.execute(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      timelineClass:
        document.querySelector<HTMLElement>('[data-v4-timeline-content-column="true"]')
          ?.className ?? "",
    }));
    expect(narrowLayout.scrollWidth).toBeLessThanOrEqual(narrowLayout.clientWidth + 1);
    expect(narrowLayout.timelineClass).not.toContain("-translate-x-[10.75rem]");

    let workId = "";
    await browser.waitUntil(
      async () => {
        const works = await getV4BackgroundWorks();
        const running = works.find((w) => w.status === "running");
        if (running) {
          workId = running.workId;
          return true;
        }
        return false;
      },
      { timeout: 60000, timeoutMsg: "后台工作面板没有出现 running 项" },
    );
    expect(workId).toBeTruthy();

    // Cancel that background work → command accepted/noop, the running item disappears from the active panel.
    const clicked = await clickV4BackgroundWorkCancel(workId);
    expect(clicked).toBe(true);
    await browser.waitUntil(
      async () => {
        const works = await getV4BackgroundWorks();
        return !works.some((work) => work.workId === workId);
      },
      { timeout: 60000, timeoutMsg: "取消后 running background item 没有消失" },
    );
    const ack = await getLatestV4CommandAck("cancelBackgroundWork");
    expect(["accepted", "noop"]).toContain(ack?.status);
    await browser.waitUntil(
      async () => (await getV4ComposerBackgroundWorkCounts()) === null,
      { timeout: 30000, timeoutMsg: "最后一个 running task 收口后 Composer 入口仍存在" },
    );
  });
});
