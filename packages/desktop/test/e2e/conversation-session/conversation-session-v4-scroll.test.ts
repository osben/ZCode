// M5④ gate: long-session virtual scrolling (timeline dynamic height measurement + bottom anchoring + back-to-bottom).
// Evidence layer L3: 14 completed turns build a stable multi-turn history and verify
// ① bottom-anchored following — after the stream completes, the last row is visible without manual scrolling;
// ② top history reachable — after scrollTop=0 the earliest rows are present in the DOM (the virtual window backfills correctly);
// ③ scrolling up is not dragged back by streaming — while turn2 streams slowly and the user stays at the top, scrollTop is not yanked to the bottom by deltas;
// ④ back-to-bottom button — appears once following is released; pressing it restores following and snaps to the bottom.
// Full coverage of the anchor state machine semantics lives in the L1 unit test (packages/ui/test/v4TimelineScrollAnchor.test.ts).
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";
import { clearAppData } from "../helpers/desktop-app.js";
import {
  clickV4TimelineBackToBottom,
  getV4TimelineScrollState,
  prepareV4ConversationE2E,
  scrollV4TimelineToTop,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("v4 M5④ 门禁：长会话虚拟滚动", () => {
  const HISTORY_TURNS = 14;
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("50+ 行历史：底部锚定跟随 → 顶部可达 → 流式不拉回 → 回到底部", async () => {
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E();

    for (let index = 1; index <= HISTORY_TURNS; index += 1) {
      const marker = String(index).padStart(3, "0");
      await sendV4Prompt(`E2E_V4_SCROLL_HISTORY_${marker} 长会话历史`);
      await browser.waitUntil(
        async () => {
          const state = await getV4TimelineScrollState();
          // The render unit is created as soon as the user row arrives; waiting only on the unit count would
          // enter the assertion before the last assistant/timeline row materializes, reading 41/42 under default CI serial load.
          return state.renderUnitCount >= index && state.windowRowCount >= index * 3;
        },
        { timeout: 30000, timeoutMsg: `第 ${index} 个 scroll history turn 未完成` },
      );
    }

    const anchored = await getV4TimelineScrollState();
    const sessionA = await waitForV4Pane(
      (snapshot) => snapshot.sessionId !== null,
      "长会话没有绑定 session id",
    );
    if (!sessionA.sessionId) throw new Error("长会话 session id 缺失");
    // Fix rationale: this case verifies logical turn virtualization; a provider may project a single logical
    // turn into more raw rows, and binding exactly 3 rows/turn would misreport a legitimate projection as a scroll failure.
    expect(anchored.windowRowCount).toBeGreaterThanOrEqual(HISTORY_TURNS * 3);
    expect(anchored.renderUnitCount).toBe(HISTORY_TURNS);
    expect(anchored.following).toBe("true");
    // Virtualization is in effect: fewer rows mounted in the DOM than the projection window's rows (a long session is not rendered in full).
    expect(anchored.mountedRenderUnitCount).toBeLessThan(anchored.renderUnitCount);
    // Total content height far exceeds the viewport (scrollable history genuinely exists).
    expect(anchored.scrollHeight).toBeGreaterThan(anchored.clientHeight * 2);

    // ── Top history reachable: after scrolling to the top, the earliest rows enter the DOM ──
    await scrollV4TimelineToTop();
    await waitForV4TimelineContaining("E2E_V4_SCROLL_HISTORY_001", 15000);
    await browser.waitUntil(
      async () => {
        const state = await getV4TimelineScrollState();
        return state.following === "false" && state.hasBackToBottom;
      },
      {
        timeout: 10000,
        timeoutMsg: "上滚离底后没有解除跟随/出现回到底部按钮",
      },
    );

    const savedHistoricalPosition = await getV4TimelineScrollState();
    await startNewV4Draft();
    await selectV4TaskById(sessionA.sessionId);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionA.sessionId,
      "切回长会话后 session 没有恢复",
    );
    await browser.waitUntil(
      async () => {
        const restored = await getV4TimelineScrollState();
        return (
          restored.following === "false" &&
          restored.hasBackToBottom &&
          Math.abs(restored.scrollTop - savedHistoricalPosition.scrollTop) <= 4
        );
      },
      {
        timeout: 15000,
        timeoutMsg: "切回长会话后没有恢复离底阅读位置",
      },
    );

    // ── turn2: stay at the top while streaming slowly; streaming deltas must not pull back ──
    await clickV4TimelineBackToBottom();
    await sendV4Prompt("E2E_V4_SCROLL_TURN2 保持输出");
    await waitForV4TimelineContaining("V4_SCROLL_TURN2_STREAMING", 45000);
    await waitForV4Pane((s) => s.canStop, "turn2 streaming 没有出现 stop 按钮");

    await scrollV4TimelineToTop();
    await waitForV4TimelineContaining("E2E_V4_SCROLL_HISTORY_001", 15000);
    // Sample several times within the window while streaming is still running: scrollTop must stay near the top (not dragged back by deltas).
    for (let sample = 0; sample < 4; sample += 1) {
      await browser.pause(700);
      const during = await getV4TimelineScrollState();
      expect(during.scrollTop).toBeLessThan(200);
      expect(during.following).toBe("false");
    }
    // turn2 is still streaming when the sampling window ends (proving the samples above happened during streaming).
    const midStream = await waitForV4Pane(() => true, "读取流式中 pane 状态失败", 5000);
    expect(midStream.canStop).toBe(true);

    // ── Back to bottom: restore following; the completed-stream text becomes visible automatically ──
    await clickV4TimelineBackToBottom();
    const beforeBackgroundOutput = await waitForV4Pane(
      (snapshot) => snapshot.timelineText.includes("turn2 持续输出片段"),
      "切走前没有可比较的 turn2 流式片段",
    );
    const beforeBackgroundFragmentCount =
      beforeBackgroundOutput.timelineText.match(/turn2 持续输出片段/g)?.length ?? 0;
    await startNewV4Draft();
    await browser.pause(1200);
    await selectV4TaskById(sessionA.sessionId);
    const afterBackgroundOutput = await waitForV4Pane((snapshot) => {
      const fragmentCount = snapshot.timelineText.match(/turn2 持续输出片段/g)?.length ?? 0;
      // Fix rationale: the E2E session projection keep-warm is only 1 second; after switching away for 1.2 seconds,
      // on switching back data-session-id takes effect before the new lease/snapshot. Waiting only for the session id
      // returns 0 on the transitional frame where timeline rows are still empty, misjudging background streaming as
      // lost. Here we wait for both the target timeline to be restored and the fragments to actually grow, preserving
      // SRM03's original semantics of background output + snap-to-bottom recovery.
      return (
        snapshot.sessionId === sessionA.sessionId && fragmentCount > beforeBackgroundFragmentCount
      );
    }, "后台流式期间切回原 session 后投影没有恢复新增片段");
    const afterBackgroundFragmentCount =
      afterBackgroundOutput.timelineText.match(/turn2 持续输出片段/g)?.length ?? 0;
    expect(afterBackgroundFragmentCount).toBeGreaterThan(beforeBackgroundFragmentCount);
    await browser.waitUntil(
      async () => {
        const restored = await getV4TimelineScrollState();
        const distanceToBottom = Math.max(
          0,
          restored.scrollHeight - restored.clientHeight - restored.scrollTop,
        );
        return restored.following === "true" && distanceToBottom <= 48;
      },
      {
        timeout: 15000,
        timeoutMsg: "吸底 session 切回后没有定位到当前最新底部",
      },
    );
    await waitForV4TimelineContaining("V4_SCROLL_TURN2_DONE", 60000);
    await waitForV4Pane((s) => !s.canStop, "turn2 没有回到空闲态", 45000);
    const final = await getV4TimelineScrollState();
    expect(final.following).toBe("true");
    expect(final.hasBackToBottom).toBe(false);
  });
});
