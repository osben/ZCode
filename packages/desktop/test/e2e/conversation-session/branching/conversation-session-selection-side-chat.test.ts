import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  clickSelectionAction,
  typeSelectionComment,
} from "#e2e/helpers/conversation-selection-comment";
import {
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_SIDE_PANE_TOGGLE,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, DEFAULT_WORKSPACE, pinE2ELocale } from "#e2e/helpers/desktop-app";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4ConversationState,
  waitForV4AssistantMessageContaining,
} from "#e2e/helpers/v4-conversation";

const PARENT_MARKER = "E2E_SSC_PARENT_SELECTION_MARKER";
const MAIN_DRAFT = "E2E_SSC_MAIN_DRAFT_KEEP";
const SIDE_DRAFT = "E2E_SSC_SIDE_DRAFT_KEEP";
const SIDE_COMMENT_SEED = "Reply with exactly E2E_SSC_SIDE_COMMENT_SEED";
const SIDE_COMMENT_TARGET = "E2E_SSC_SIDE_COMMENT_TARGET";
const SIDE_COMMENT_RUNNING = "E2E_SSC_SIDE_COMMENT_RUNNING";
const SIDE_LIVE_PARA = "E2E_SSC_SIDE_LIVE_PARA";
const SIDE_COMMENT_NOTE = "E2E side note";
const SIDE_COMMENT_DISCARD = "E2E discard me";

async function expectModelPickerCloseToRestoreComposerFocus(paneTestId: string): Promise<void> {
  const trigger = $(
    `[data-testid="${paneTestId}"] [data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`,
  );
  await trigger.waitForClickable({ timeout: 15000 });
  await trigger.click();
  await browser.keys("Escape");
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, triggerTestId, inputTestId) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
          const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          return (
            document.querySelector(`[data-testid="${triggerTestId}"][aria-expanded="true"]`) ===
              null &&
            input !== null &&
            document.activeElement === input
          );
        },
        paneTestId,
        TID_CHAT_MODEL_SELECT_TRIGGER,
        TID_V4_COMPOSER_INPUT,
      ),
    {
      timeout: 10000,
      timeoutMsg: `model picker close did not restore focus to ${paneTestId}`,
    },
  );
}

describe("框选文字副屏会话 manual review", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("SSC01/02/08/14/15/17/19/25/26/27/28/29/30/31: 隐藏历史、多开、关闭隔离、active 路由与 /side 命令", async function () {
    this.timeout(180000);
    await prepareV4ConversationE2E();
    // 用例断言中文辅助 tab 标题；首帧跟随系统语言，必须先固定语言再创建 child。
    await pinE2ELocale("zh-CN");
    await sendV4Prompt(`Reply with exactly ${PARENT_MARKER}`);
    await waitForSelectableMainTimelineText(PARENT_MARKER, 60000);
    const parent = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "SSC parent session 没有建立",
    );

    await setComposerText(testId(TID_V4_SESSION_PANE, "workspace-main"), MAIN_DRAFT);
    await selectMainTimelineText(PARENT_MARKER);
    // 当前 CLI 已把旧“添加到当前任务”合并到注释；留空保存仍只加原文，不覆盖主草稿。
    await clickSelectionAction("comment");
    const commentInput = $("[data-conversation-selection-comment-input]");
    await commentInput.waitForDisplayed({ timeout: 5000 });
    expect(await commentInput.getValue()).toBe("");
    await $("[data-conversation-selection-comment-save]").click();
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    await expectComposerState(testId(TID_V4_SESSION_PANE, "workspace-main"), MAIN_DRAFT, 1);

    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("ask-in-side-chat");
    const firstSide = await waitForSelectionSidePane();
    expect(firstSide.childSessionId).not.toBe(parent.sessionId);
    await expectComposerState(firstSide.paneTestId, "", 1);
    const inheritedHistoryVisible = await browser.execute(
      (paneTestId, marker) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        return pane?.innerText.includes(marker) ?? false;
      },
      firstSide.paneTestId,
      PARENT_MARKER,
    );
    expect(inheritedHistoryVisible).toBe(false);

    await setComposerText(firstSide.paneTestId, SIDE_DRAFT);
    await selectMainTimelineText("E2E_SSC_PARENT");
    await clickSelectionAction("ask-in-side-chat");
    const reusedSide = await waitForSelectionSidePane();
    expect(reusedSide.childSessionId).toBe(firstSide.childSessionId);
    await expectComposerState(reusedSide.paneTestId, SIDE_DRAFT, 2);

    await clickComposerSend(testId(TID_V4_SESSION_PANE, "workspace-main"));
    // Fix rationale: the timeline container also includes the Composer, so an old draft would
    // satisfy the "completed" check before the request is sent. Wait for this turn's unique
    // answer first, then close the selection side pane, so new message projections do not move
    // text while dragging the selection.
    await waitForV4AssistantMessageContaining("E2E_SSC_MAIN_DRAFT_DONE", 30000);
    await waitForV4ConversationState(
      (state) => state.state === "idle" && state.activeInputId === null,
      "父会话追加输入没有完成",
    );
    const afterParentAdvance = await waitForSelectionSidePane();
    expect(afterParentAdvance.childSessionId).toBe(firstSide.childSessionId);
    await expectComposerState(afterParentAdvance.paneTestId, SIDE_DRAFT, 2);

    await closeSelectionSideTab();
    await browser.waitUntil(
      async () =>
        browser.execute(
          () => !document.querySelector('[data-side-pane-tab-id^="selection-side-chat:"]'),
        ),
      { timeout: 30000, timeoutMsg: "关闭后 selection side tab 仍存在" },
    );

    // Closing the last tab collapses the side panel; the width animation keeps firing timeline
    // scroll events, and scroll closes the selection overlay. Wait until the panel actually
    // reaches zero width before text-selecting; the tab DOM disappearing does not mean the layout
    // has settled.
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const panel = document.querySelector('[data-workspace-side-frame="true"]')?.parentElement;
          return !panel || panel.getBoundingClientRect().width === 0;
        }),
      { timeout: 10000, timeoutMsg: "关闭最后一个辅助 tab 后面板没有收起" },
    );
    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("ask-in-side-chat");
    const recreatedSide = await waitForSelectionSidePane();
    expect(recreatedSide.childSessionId).not.toBe(firstSide.childSessionId);

    await clickAddSelectionSideConversation();
    await waitForSelectionSidePanes(2);
    await clickAddSelectionSideConversation();
    const threeSides = await waitForSelectionSidePanes(3);
    expect(new Set(threeSides.map((side) => side.childSessionId)).size).toBe(3);
    expect(threeSides.map((side) => side.title)).toEqual([
      "辅助对话 1",
      "辅助对话 2",
      "辅助对话 3",
    ]);

    // SSC34: closing a picker in a secondary composer must restore focus to that composer,
    // without moving it to the first (main) composer mounted in the document.
    await expectModelPickerCloseToRestoreComposerFocus(
      testId(TID_V4_SESSION_PANE, "workspace-main"),
    );
    await activateSidePaneTab(threeSides[2]!.tabId);
    await expectModelPickerCloseToRestoreComposerFocus(threeSides[2]!.paneTestId);

    await activateSidePaneTab(recreatedSide.tabId);
    await selectMainTimelineText("E2E_SSC_PARENT");
    await clickSelectionAction("ask-in-side-chat");
    await expectComposerState(recreatedSide.paneTestId, "", 2);
    for (const side of threeSides.filter(
      (candidate) => candidate.childSessionId !== recreatedSide.childSessionId,
    )) {
      await expectNoSelectionReferences(side.paneTestId);
    }

    const siblingSides = threeSides.filter(
      (candidate) => candidate.childSessionId !== recreatedSide.childSessionId,
    );
    const sideToClose = siblingSides[0];
    const survivingSibling = siblingSides[1];
    if (!sideToClose || !survivingSibling) {
      throw new Error("multi-open sibling side panes missing");
    }
    // A hidden tab's input is not interactable; switch via the real UI first, then verify that
    // closing the other tab does not lose the draft.
    await activateSidePaneTab(survivingSibling.tabId);
    await setComposerText(survivingSibling.paneTestId, "E2E_SSC_SIBLING_DRAFT");
    await closeSelectionSideTab(sideToClose.tabId);
    const remainingSides = await waitForSelectionSidePanes(2);
    expect(
      remainingSides.some((candidate) => candidate.childSessionId === sideToClose.childSessionId),
    ).toBe(false);
    await expectComposerText(survivingSibling.paneTestId, "E2E_SSC_SIBLING_DRAFT");
    await expectNoSelectionReferences(survivingSibling.paneTestId);

    await clickAddSidePaneItem("terminal");
    await waitForActiveSidePaneTab("terminal:");
    await selectMainTimelineText(PARENT_MARKER);
    await clickSelectionAction("ask-in-side-chat");
    const afterNoActiveAuxiliary = await waitForSelectionSidePanes(3);
    const remainingChildIds = new Set(remainingSides.map((side) => side.childSessionId));
    const createdForSelection = afterNoActiveAuxiliary.find(
      (side) => !remainingChildIds.has(side.childSessionId),
    );
    expect(createdForSelection).toBeDefined();
    if (!createdForSelection) {
      throw new Error("selection did not create a new auxiliary child");
    }
    await expectComposerState(createdForSelection.paneTestId, "", 1);

    // SSC28: the /side and /btw App-level commands open a new auxiliary tab as soon as selected, and remove the
    // command token from the input.
    const mainPaneTestId = testId(TID_V4_SESSION_PANE, "workspace-main");
    const sidesBeforeSlashCommand = await waitForSelectionSidePanes(3);
    const knownChildIds = new Set(sidesBeforeSlashCommand.map((side) => side.childSessionId));
    await typeIntoComposerByKeyboard(mainPaneTestId, "/side");
    await clickSlashSuggestionOption("app-slash:side");
    const afterSideCommand = await waitForSelectionSidePanes(4);
    const sideCommandChild = afterSideCommand.find(
      (side) => !knownChildIds.has(side.childSessionId),
    );
    expect(sideCommandChild).toBeDefined();
    await expectComposerPlainText(mainPaneTestId, "");

    await typeIntoComposerByKeyboard(mainPaneTestId, "/btw");
    await clickSlashSuggestionOption("app-slash:btw");
    await waitForSelectionSidePanes(5);
    await expectComposerPlainText(mainPaneTestId, "");

    // SSC30: `/side` with an argument creates the child directly and submits the argument as the first plain input.
    const childrenBeforeArgument = await waitForSelectionSidePanes(5);
    const childrenBeforeArgumentIds = new Set(
      childrenBeforeArgument.map((side) => side.childSessionId),
    );
    await setComposerText(mainPaneTestId, "/side E2E_SSC_SIDE_ARGUMENT_IDLE");
    await clickComposerSend(mainPaneTestId);
    const idleArgumentChildren = await waitForSelectionSidePanes(6);
    const idleArgumentChild = idleArgumentChildren.find(
      (side) => !childrenBeforeArgumentIds.has(side.childSessionId),
    );
    expect(idleArgumentChild).toBeDefined();
    if (!idleArgumentChild) throw new Error("带参数 /side 没有创建 child");
    await waitForSelectionSidePaneContaining(
      idleArgumentChild.paneTestId,
      "E2E_SSC_SIDE_ARGUMENT_IDLE",
    );
    await expectComposerPlainText(mainPaneTestId, "");

    // SSC31: sending `/btw <text>` right after the parent session starts a new turn — the argument command only
    // starts the child and does not change the parent session's current turn to queue/guide.
    await setComposerText(mainPaneTestId, "Reply with exactly E2E_SSC_RUNNING_PARENT");
    await clickComposerSend(mainPaneTestId);
    await waitForV4ConversationState(
      // V4 running state comes from the visible Stop projection, not the legacy store's
      // activeInputId mirror.
      (state) => state.state === "streaming",
      "SSC31 父轮没有实际运行",
    );
    const childrenBeforeRunningArgument = await waitForSelectionSidePanes(6);
    const childrenBeforeRunningArgumentIds = new Set(
      childrenBeforeRunningArgument.map((side) => side.childSessionId),
    );
    await setComposerText(mainPaneTestId, "/btw E2E_SSC_SIDE_ARGUMENT_RUNNING");
    await clickComposerSend(mainPaneTestId);
    const runningArgumentChildren = await waitForSelectionSidePanes(7);
    const runningArgumentChild = runningArgumentChildren.find(
      (side) => !childrenBeforeRunningArgumentIds.has(side.childSessionId),
    );
    expect(runningArgumentChild).toBeDefined();
    if (!runningArgumentChild) throw new Error("运行中带参数 /btw 没有创建 child");
    await waitForSelectionSidePaneContaining(
      runningArgumentChild.paneTestId,
      "E2E_SSC_SIDE_ARGUMENT_RUNNING",
    );
    await expectComposerPlainText(mainPaneTestId, "");

    // SSC29: the secondary conversation's own composer `/` panel does not offer /side or /btw;
    // CLI command display is unaffected.
    const activeSideAfterBtw = await waitForActiveSelectionSidePane();
    await typeIntoComposerByKeyboard(activeSideAfterBtw.paneTestId, "/");
    await expectSlashPanelWithoutSideCommands();
    await dismissSlashPanel(activeSideAfterBtw.paneTestId);

    // SSC29: draft state (no session created yet) does not offer /side or /btw.
    await openNewTaskDraft();
    await typeIntoComposerByKeyboard(mainPaneTestId, "/");
    await expectSlashPanelWithoutSideCommands();
    await dismissSlashPanel(mainPaneTestId);
  });

  it("SSC37/38/39/40/41/42: 辅助对话时间线复用主对话选区注释，写入辅助 composer", async function () {
    this.timeout(240000);
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    await pinE2ELocale("zh-CN");
    const mainPaneTestId = testId(TID_V4_SESSION_PANE, "workspace-main");
    // 上一个用例留下的辅助 composer 仍挂载；单点 Lexical bridge 可能不在主输入框上，改用真实键盘输入。
    await setComposerText(mainPaneTestId, `Reply with exactly ${PARENT_MARKER}`);
    await clickComposerSend(mainPaneTestId);
    await waitForSelectableMainTimelineText(PARENT_MARKER, 60000);
    await waitForV4ConversationState(
      (state) => state.state === "idle" && state.activeInputId === null,
      "SSC37 父会话没有完成",
    );

    const sideA = await openBareSideChat(mainPaneTestId);
    await setComposerText(sideA.paneTestId, SIDE_COMMENT_SEED);
    await clickComposerSend(sideA.paneTestId);
    await waitForSelectableMainTimelineText(SIDE_COMMENT_TARGET, 60000, sideA.paneTestId);
    await waitForV4Pane((pane) => !pane.canStop, "SSC37 辅助对话没有完成", 30000, sideA.tabId);

    // SSC37：辅助时间线框选 → 浮层只有“注释” → 保存后只进辅助 composer，辅助正文画编号。
    await selectMainTimelineText(SIDE_COMMENT_TARGET, sideA.paneTestId);
    expect(await readSelectionMenuActions()).toEqual(["comment"]);
    await clickSelectionAction("comment");
    await typeSelectionComment(SIDE_COMMENT_NOTE);
    await $("[data-conversation-selection-comment-save]").click();
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    await waitForPaneAnnotations(sideA.paneTestId, 1);
    expect(await readPaneComposerReferenceCount(mainPaneTestId)).toBeNull();
    expect(await readPaneAnnotationMarkCount(mainPaneTestId)).toBe(0);

    // SSC42 + SSC39：收起再展开侧栏，焦点不自动回辅助输入框；已保存注释与编号仍在。
    await toggleSidePane(sideA.paneTestId, "collapse");
    await toggleSidePane(sideA.paneTestId, "expand");
    expect(await isFocusInsideComposer(sideA.paneTestId)).toBe(false);
    await waitForPaneAnnotations(sideA.paneTestId, 1);

    // SSC38：注释输入中收起侧栏 → 输入丢弃；展开后不重弹。
    await selectMainTimelineText(SIDE_COMMENT_TARGET, sideA.paneTestId);
    await clickSelectionAction("comment");
    await typeSelectionComment(SIDE_COMMENT_DISCARD);
    await toggleSidePane(sideA.paneTestId, "collapse");
    await expectNoSelectionOverlay();
    await toggleSidePane(sideA.paneTestId, "expand");
    await expectNoSelectionOverlayStays();
    await waitForPaneAnnotations(sideA.paneTestId, 1);

    // SSC39：另一个辅助 tab 的 composer 没有这条注释。
    const sideB = await openBareSideChat(mainPaneTestId);
    expect(await readPaneComposerReferenceCount(sideB.paneTestId)).toBeNull();
    expect(await readPaneAnnotationMarkCount(sideB.paneTestId)).toBe(0);

    // SSC38：输入中切到另一辅助 tab → 原 tab 输入丢弃；切回不重弹。SSC39：切回后注释仍在。
    await activateSidePaneTab(sideA.tabId);
    await waitForActiveSidePaneTab(sideA.tabId);
    await selectMainTimelineText(SIDE_COMMENT_TARGET, sideA.paneTestId);
    await clickSelectionAction("comment");
    await typeSelectionComment(SIDE_COMMENT_DISCARD);
    await activateSidePaneTab(sideB.tabId);
    await waitForActiveSidePaneTab(sideB.tabId);
    await expectNoSelectionOverlay();
    await activateSidePaneTab(sideA.tabId);
    await waitForActiveSidePaneTab(sideA.tabId);
    await expectNoSelectionOverlayStays();
    await waitForPaneAnnotations(sideA.paneTestId, 1);
    expect(await readPaneComposerReferenceCount(sideB.paneTestId)).toBeNull();

    // SSC40：辅助输入中点主对话 → 输入丢弃；主对话“在辅助对话中提问”照常进当前辅助 tab。
    await selectMainTimelineText(SIDE_COMMENT_TARGET, sideA.paneTestId);
    await clickSelectionAction("comment");
    await typeSelectionComment(SIDE_COMMENT_DISCARD);
    await $(`[data-testid="${mainPaneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`).click();
    await expectNoSelectionOverlay();
    await selectMainTimelineText(PARENT_MARKER);
    expect(await readSelectionMenuActions()).toContain("ask-in-side-chat");
    await clickSelectionAction("ask-in-side-chat");
    await waitForPaneComposerReferenceCount(sideA.paneTestId, 2);
    expect(await readPaneComposerReferenceCount(sideB.paneTestId)).toBeNull();
    expect(await readPaneComposerReferenceCount(mainPaneTestId)).toBeNull();

    // SSC41：辅助对话输出中框选；Esc 只关浮层，不停止辅助对话；输出中可保存注释。
    await setComposerText(sideA.paneTestId, SIDE_COMMENT_RUNNING);
    await clickComposerSend(sideA.paneTestId);
    await waitForV4Pane(
      (pane) => pane.canStop && pane.timelineText.includes("ssc-side-live-2"),
      "SSC41 辅助对话没有开始流式输出",
      30000,
      sideA.tabId,
    );
    // 正在输出的段落逐词渐显，文字节点不稳定；框选已输出完的第一段（第二段已出现）。
    await waitForSelectableMainTimelineText(SIDE_LIVE_PARA, 30000, sideA.paneTestId);
    await selectMainTimelineText(SIDE_LIVE_PARA, sideA.paneTestId);
    expect(await readSelectionMenuActions()).toEqual(["comment"]);
    await browser.keys("Escape");
    await expectNoSelectionOverlay();
    const beforeEscape = (await getV4PaneSnapshot(sideA.tabId)).timelineText.length;
    // stop 命令异步生效：先跨过两个增量间隔，再确认仍可停止且正文继续增长，排除“已发 stop 但尚未落地”。
    await browser.pause(3200);
    const afterEscape = await getV4PaneSnapshot(sideA.tabId);
    expect(afterEscape.canStop).toBe(true);
    expect(afterEscape.timelineText.length).toBeGreaterThan(beforeEscape + 10);
    await selectMainTimelineText(SIDE_LIVE_PARA, sideA.paneTestId);
    await clickSelectionAction("comment");
    await typeSelectionComment(SIDE_COMMENT_NOTE);
    await $("[data-conversation-selection-comment-save]").click();
    await $("[data-conversation-selection-comment-editor]").waitForDisplayed({ reverse: true });
    await waitForPaneComposerReferenceCount(sideA.paneTestId, 1);
    // composer 有待发送注释时停止按钮会换成发送按钮，canStop 不再代表运行态；改看正文是否继续输出。
    const afterSave = (await getV4PaneSnapshot(sideA.tabId)).timelineText.length;
    await waitForV4Pane(
      (pane) => pane.timelineText.length > afterSave + 10,
      "SSC41 保存注释后辅助对话没有继续输出",
      15000,
      sideA.tabId,
    );

    // SSC38：菜单已出时关闭 tab，浮层随 tab 消失。
    await selectMainTimelineText(SIDE_LIVE_PARA, sideA.paneTestId);
    await closeSelectionSideTab(sideA.tabId);
    await expectNoSelectionOverlay();
  });
});

async function selectMainTimelineText(
  text: string,
  paneTestId = testId(TID_V4_SESSION_PANE, "workspace-main"),
): Promise<void> {
  await browser.execute(() => {
    const state = window as Window & { __selectionTrace?: { events: unknown[]; stop(): void } };
    state.__selectionTrace?.stop();
    const events: unknown[] = [];
    const types = ["mousedown", "mouseup", "selectionchange", "scroll", "resize", "focusin"];
    const listener = (event: Event) => {
      const selection = window.getSelection();
      events.push({
        type: event.type,
        time: performance.now(),
        text: selection?.toString(),
        target: (event.target as Element)?.getAttribute?.("data-testid"),
        anchor: selection?.anchorNode?.parentElement
          ?.closest("[data-row-id]")
          ?.getAttribute("data-row-id"),
        focused: document.activeElement?.getAttribute("data-testid"),
        tooltip: Boolean(document.querySelector("[data-conversation-selection-tooltip]")),
      });
    };
    for (const type of types) window.addEventListener(type, listener, true);
    state.__selectionTrace = {
      events,
      stop: () => {
        for (const type of types) window.removeEventListener(type, listener, true);
      },
    };
  });
  // A previous reference action may have left a selection; dragging over the old selection
  // becomes an HTML drag-and-drop instead of a fresh text selection.
  await browser.execute(() => window.getSelection()?.removeAllRanges());
  // The old helper mutated the DOM Range directly and retried mouseup, bypassing native
  // selection and pane focus updates. Here we only read text coordinates; the interaction is a
  // real pointer drag, and scrolling happens before pointerdown.
  const locator = (id: string, targetText: string, scroll: boolean) => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!pane) throw new Error("缺少主 pane");
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
    let found: { node: Node; offset: number } | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.textContent ?? "";
      const offset = value.indexOf(targetText);
      if (offset < 0 || !node.parentElement?.closest("[data-row-id]")) continue;
      found ??= { node, offset };
      if (value.trim() === targetText) {
        found = { node, offset };
        break;
      }
    }
    if (!found) throw new Error(`主时间线缺少选区文本: ${targetText}`);
    if (scroll) found.node.parentElement?.scrollIntoView({ block: "center", behavior: "instant" });
    const range = document.createRange();
    range.setStart(found.node, found.offset);
    range.setEnd(found.node, found.offset + 1);
    const first = range.getBoundingClientRect();
    range.setStart(found.node, found.offset + targetText.length - 1);
    range.setEnd(found.node, found.offset + targetText.length);
    const last = range.getBoundingClientRect();
    return {
      x1: Math.ceil(first.left),
      y1: Math.round(first.top + first.height / 2),
      x2: Math.floor(last.right),
      y2: Math.round(last.top + last.height / 2),
    };
  };
  const readLayoutTransitions = (id: string): string[] => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!pane) return ["missing-pane"];
    return document.getAnimations().flatMap((animation) => {
      if (!(animation instanceof CSSTransition) || animation.playState !== "running") return [];
      if (!["width", "max-width", "height", "transform"].includes(animation.transitionProperty))
        return [];
      const target = (animation.effect as KeyframeEffect | null)?.target;
      return target instanceof Element && (pane.contains(target) || target.contains(pane))
        ? [animation.transitionProperty]
        : [];
    });
  };
  // After the secondary panel collapses, the main column still runs width transitions across
  // breakpoints; dynamic height measurement can scroll the text by another 59px. Take coordinates
  // only after the layout transitions actually finish, so stale coordinates do not drag a
  // neighboring row.
  await browser.waitUntil(
    async () => (await browser.execute(readLayoutTransitions, paneTestId)).length === 0,
    { timeout: 10000, timeoutMsg: "主时间线布局过渡未结束，不能开始原生划词" },
  );
  await browser.execute(locator, paneTestId, text, true);
  const position = await browser.execute(locator, paneTestId, text, false);
  expect(await browser.execute(readLayoutTransitions, paneTestId)).toEqual([]);
  await browser.performActions([
    {
      type: "pointer",
      id: "selection-drag",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: position.x1, y: position.y1, duration: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", x: position.x2, y: position.y2, duration: 200 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
  try {
    await browser.waitUntil(
      () => browser.execute((expected) => window.getSelection()?.toString() === expected, text),
      { timeout: 5000, timeoutMsg: `真实拖选未选中目标文本: ${text}` },
    );
    await $("[data-conversation-selection-tooltip]").waitForDisplayed({ timeout: 5000 });
  } catch (error) {
    const events = await browser.execute(
      () =>
        (window as Window & { __selectionTrace?: { events: unknown[] } }).__selectionTrace?.events,
    );
    await writeFile(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "selection-events.json"),
      JSON.stringify(
        {
          text,
          position,
          currentPosition: await browser.execute(locator, paneTestId, text, false),
          events,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await browser.execute(() =>
      (window as Window & { __selectionTrace?: { stop(): void } }).__selectionTrace?.stop(),
    );
  }
}

async function waitForSelectableMainTimelineText(
  text: string,
  timeout: number,
  paneTestId = testId(TID_V4_SESSION_PANE, "workspace-main"),
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (paneTestId, targetText) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
          if (!pane) return false;
          const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            if (
              node.textContent?.trim() === targetText &&
              node.parentElement?.closest("[data-row-id]")
            ) {
              return true;
            }
            node = walker.nextNode();
          }
          return false;
        },
        paneTestId,
        text,
      ),
    {
      timeout,
      timeoutMsg: `The timeline has no selectable text: ${text}`,
    },
  );
}

async function waitForSelectionSidePane(): Promise<{
  childSessionId: string;
  paneTestId: string;
  tabId: string;
}> {
  let result: { childSessionId: string; paneTestId: string; tabId: string } | null = null;
  await browser.waitUntil(
    async () => {
      result = await browser.execute((panePrefix) => {
        const tab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id^="selection-side-chat:"]',
        );
        const tabId = tab?.dataset.sidePaneTabId;
        if (!tabId) return null;
        const paneTestId = `${panePrefix}-${tabId}`;
        const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
        const childSessionId = pane?.dataset.sessionId;
        return childSessionId ? { childSessionId, paneTestId, tabId } : null;
      }, TID_V4_SESSION_PANE);
      return result !== null;
    },
    { timeout: 30000, timeoutMsg: "selection side pane 没有打开" },
  );
  if (!result) throw new Error("selection side pane result missing");
  return result;
}

async function waitForSelectionSidePanes(expectedCount: number): Promise<
  Array<{
    childSessionId: string;
    paneTestId: string;
    tabId: string;
    title: string;
  }>
> {
  let result: Array<{
    childSessionId: string;
    paneTestId: string;
    tabId: string;
    title: string;
  }> = [];
  await browser.waitUntil(
    async () => {
      result = await browser.execute(
        (panePrefix) =>
          Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-side-pane-tab-id^="selection-side-chat:"]',
            ),
          ).flatMap((tab) => {
            const tabId = tab.dataset.sidePaneTabId;
            if (!tabId) return [];
            const paneTestId = `${panePrefix}-${tabId}`;
            const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
            const childSessionId = pane?.dataset.sessionId;
            return childSessionId
              ? [{ childSessionId, paneTestId, tabId, title: tab.innerText.trim() }]
              : [];
          }),
        TID_V4_SESSION_PANE,
      );
      return result.length === expectedCount;
    },
    {
      timeout: 30000,
      timeoutMsg: `selection side pane 数量不是 ${expectedCount}`,
    },
  );
  return result;
}

async function clickAddSelectionSideConversation(): Promise<void> {
  await clickAddSidePaneItem("selection-side-conversation");
}

async function clickAddSidePaneItem(
  itemId: "selection-side-conversation" | "terminal",
): Promise<void> {
  // Reason for the fix: the Radix DropdownMenu trigger depends on a pointerdown gesture; element.click() or a lone
  // WebDriver click is unreliable under Electron. Same approach as e2ecase-regression: dispatch the full
  // pointer/mouse/click event sequence to activate the trigger and menu item.
  const dispatchActivationScript = (selector: string) => {
    const target = document.querySelector<HTMLElement>(selector);
    if (!target) return false;
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.focus();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const event = type.startsWith("pointer")
        ? new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          })
        : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      target.dispatchEvent(event);
    }
    return true;
  };
  await browser.waitUntil(
    async () => browser.execute(dispatchActivationScript, "[data-side-pane-add-trigger]"),
    { timeout: 15000, timeoutMsg: "Side Pane 新增标签按钮不存在" },
  );
  const itemSelector = `[data-state="active"] [data-side-pane-open-tab-item="${itemId}"]`;
  await browser.waitUntil(
    async () =>
      browser.execute((selector) => Boolean(document.querySelector(selector)), itemSelector),
    { timeout: 15000, timeoutMsg: `${itemId} 新增菜单没有打开` },
  );
  const clicked = await browser.execute(dispatchActivationScript, itemSelector);
  expect(clicked).toBe(true);
}

async function waitForActiveSidePaneTab(idPrefix: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((nextIdPrefix) => {
        const activeTab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id][data-state="active"]',
        );
        return activeTab?.dataset.sidePaneTabId?.startsWith(nextIdPrefix) ?? false;
      }, idPrefix),
    {
      timeout: 30000,
      timeoutMsg: `Side Pane active tab 不是 ${idPrefix}`,
    },
  );
}

async function activateSidePaneTab(tabId: string): Promise<void> {
  const clicked = await browser.execute((targetTabId) => {
    const tab = document.querySelector<HTMLElement>(
      `[data-side-pane-tab-id="${CSS.escape(targetTabId)}"]`,
    );
    tab?.click();
    return Boolean(tab);
  }, tabId);
  expect(clicked).toBe(true);
}

async function setComposerText(paneTestId: string, text: string): Promise<void> {
  // With multiple panes sharing a testid, the single-point Lexical bridge may not be on the
  // target input; type through the real keyboard.
  await clearComposerByKeyboard(paneTestId);
  await browser.keys(text.split(""));
  await expectComposerPlainText(paneTestId, text);
}

async function expectComposerState(
  paneTestId: string,
  text: string,
  referenceCount: number,
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, inputTestId, expectedText, expectedReferenceCount) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
          const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          return (
            (input?.textContent ?? "").trim() === expectedText &&
            pane?.querySelector(
              `[data-conversation-selection-reference-count="${expectedReferenceCount}"]`,
            ) !== null
          );
        },
        paneTestId,
        TID_V4_COMPOSER_INPUT,
        text,
        referenceCount,
      ),
    {
      timeout: 15000,
      timeoutMsg: `composer 草稿或引用数量不匹配: ${paneTestId}`,
    },
  );
}

async function expectNoSelectionReferences(paneTestId: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((nextPaneTestId) => {
        const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
        return (
          pane !== null &&
          pane.querySelector("[data-conversation-selection-reference-count]") === null
        );
      }, paneTestId),
    {
      timeout: 15000,
      timeoutMsg: `非目标辅助对话出现了划词引用: ${paneTestId}`,
    },
  );
}

async function expectComposerText(paneTestId: string, text: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, inputTestId, expectedText) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
          const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          return (
            (
              input as
                | (HTMLElement & {
                    __zcodeLexicalInputE2E?: { getText: () => string };
                  })
                | undefined
            )?.__zcodeLexicalInputE2E?.getText() === expectedText
          );
        },
        paneTestId,
        TID_V4_COMPOSER_INPUT,
        text,
      ),
    {
      timeout: 15000,
      timeoutMsg: `composer 草稿不匹配: ${paneTestId}`,
    },
  );
}

async function clickComposerSend(paneTestId: string): Promise<void> {
  const clicked = await browser.execute(
    (nextPaneTestId, sendTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
      const button = pane?.querySelector<HTMLButtonElement>(`[data-testid="${sendTestId}"]`);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    paneTestId,
    TID_V4_COMPOSER_SEND,
  );
  expect(clicked).toBe(true);
}

async function waitForActiveSelectionSidePane(): Promise<{
  childSessionId: string;
  paneTestId: string;
  tabId: string;
}> {
  let result: { childSessionId: string; paneTestId: string; tabId: string } | null = null;
  await browser.waitUntil(
    async () => {
      result = await browser.execute((panePrefix) => {
        const tab = document.querySelector<HTMLElement>(
          '[data-side-pane-tab-id^="selection-side-chat:"][data-state="active"]',
        );
        const tabId = tab?.dataset.sidePaneTabId;
        if (!tabId) return null;
        const paneTestId = `${panePrefix}-${tabId}`;
        const childSessionId = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`)
          ?.dataset.sessionId;
        return childSessionId ? { childSessionId, paneTestId, tabId } : null;
      }, TID_V4_SESSION_PANE);
      return result !== null;
    },
    { timeout: 30000, timeoutMsg: "没有 active 的 selection side pane" },
  );
  if (!result) throw new Error("active selection side pane missing");
  return result;
}

async function waitForSelectionSidePaneContaining(
  paneTestId: string,
  marker: string,
): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (nextPaneTestId, nextMarker) =>
          document
            .querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`)
            ?.innerText.includes(nextMarker) ?? false,
        paneTestId,
        marker,
      ),
    { timeout: 60000, timeoutMsg: `selection side pane 没有出现 ${marker}` },
  );
}

/** Slash panels are triggered by real keyboard events; type once, then wait for the visible
 *  body to settle. */
async function typeIntoComposerByKeyboard(paneTestId: string, text: string): Promise<void> {
  await setComposerText(paneTestId, text);
}

/** Bridge-free clearing: select all + Backspace (real key sequence, handled normally by Lexical). */
async function clearComposerByKeyboard(paneTestId: string): Promise<void> {
  const inputSelector = `[data-testid="${paneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`;
  const input = $(inputSelector);
  await input.waitForClickable({ timeout: 15000 });
  await input.click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await browser.keys([modifier, "a"]);
  await browser.keys("Backspace");
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector) =>
          (document.querySelector<HTMLElement>(selector)?.textContent ?? "").trim() === "",
        inputSelector,
      ),
    { timeout: 10000, timeoutMsg: `composer 清空失败: ${paneTestId}` },
  );
}

/** Bridge-free composer text assertion (the bridge can detach in multi-composer scenarios). */
async function expectComposerPlainText(paneTestId: string, text: string): Promise<void> {
  const inputSelector = `[data-testid="${paneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`;
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector, expectedText) =>
          (document.querySelector<HTMLElement>(selector)?.textContent ?? "").trim() ===
          expectedText,
        inputSelector,
        text,
      ),
    { timeout: 15000, timeoutMsg: `composer 文本不匹配: ${paneTestId}` },
  );
}

async function clickSlashSuggestionOption(optionId: string): Promise<void> {
  // Reason for the fix: the panel may close momentarily when the editor loses focus (new auxiliary tab autofocus);
  // between the two round trips of "check first, then click", the option can disappear. Here the lookup and the
  // mousedown are fused into a single atomic script and retried as a whole.
  // MentionPanel options trigger onSelect in onMouseDown; element.click() does not hit it.
  await browser.waitUntil(
    async () =>
      browser.execute((nextOptionId) => {
        const option = document.querySelector<HTMLButtonElement>(
          `[data-option-id="${CSS.escape(nextOptionId)}"]`,
        );
        if (!option) return false;
        option.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
        );
        return true;
      }, optionId),
    { timeout: 15000, timeoutMsg: `斜杠面板没有出现选项: ${optionId}` },
  );
}

async function expectSlashPanelWithoutSideCommands(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (panelTestId) => Boolean(document.querySelector(`[data-testid="${panelTestId}"]`)),
        TID_PROMPT_SUGGESTION_PANEL,
      ),
    { timeout: 15000, timeoutMsg: "斜杠面板没有打开" },
  );
  // SSC29 only restricts the secondary-conversation entry points; legitimate App commands added
  // later, such as /plan, are not in scope for the ban.
  const appCommands = await browser.execute(() =>
    [...document.querySelectorAll('[data-option-id^="app-slash:"]')].map((node) =>
      node.getAttribute("data-option-id"),
    ),
  );
  expect(appCommands).not.toContain("app-slash:side");
  expect(appCommands).not.toContain("app-slash:btw");
}

async function dismissSlashPanel(paneTestId: string): Promise<void> {
  await browser.keys("Escape");
  await clearComposerByKeyboard(paneTestId);
}

async function openNewTaskDraft(): Promise<void> {
  await startDraftFromProject(DEFAULT_WORKSPACE);
  await waitForV4ConversationState(
    (state) => state.sessionId === null && state.taskId === null,
    "项目没有进入空草稿",
  );
}

async function closeSelectionSideTab(tabId?: string): Promise<void> {
  const clicked = await browser.execute((targetTabId) => {
    const tab = document.querySelector<HTMLElement>(
      targetTabId
        ? `[data-side-pane-tab-id="${CSS.escape(targetTabId)}"]`
        : '[data-side-pane-tab-id^="selection-side-chat:"]',
    );
    const button = tab?.querySelector<HTMLButtonElement>("button");
    button?.click();
    return Boolean(button);
  }, tabId);
  expect(clicked).toBe(true);
}

/** 用裸 `/btw` 新建并激活一个空辅助对话；按 tab id 差集识别新 tab，不受其他父任务的隐藏 tab 影响。 */
async function openBareSideChat(
  mainPaneTestId: string,
): Promise<{ paneTestId: string; tabId: string }> {
  const previousTabIds = await readSelectionSideTabIds();
  await typeIntoComposerByKeyboard(mainPaneTestId, "/btw");
  await clickSlashSuggestionOption("app-slash:btw");
  let tabId = "";
  await browser.waitUntil(
    async () => {
      tabId = (await readSelectionSideTabIds()).find((id) => !previousTabIds.includes(id)) ?? "";
      return Boolean(tabId);
    },
    { timeout: 30000, timeoutMsg: "裸 /btw 没有新建辅助 tab" },
  );
  await waitForV4Pane((pane) => Boolean(pane.sessionId), "辅助对话没有就绪", 30000, tabId);
  await waitForActiveSidePaneTab(tabId);
  return { paneTestId: testId(TID_V4_SESSION_PANE, tabId), tabId };
}

async function readSelectionSideTabIds(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-side-pane-tab-id^="selection-side-chat:"]'),
      (tab) => tab.dataset.sidePaneTabId ?? "",
    ).filter(Boolean),
  );
}

/** 当前选区浮层里的动作按钮，按 DOM 顺序。 */
async function readSelectionMenuActions(): Promise<string[]> {
  await $("[data-conversation-selection-tooltip]").waitForDisplayed({ timeout: 5000 });
  return browser.execute(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-conversation-selection-tooltip] [data-conversation-selection-action]",
      ),
      (button) => button.dataset.conversationSelectionAction ?? "",
    ),
  );
}

/** composer 里的引用条数；排除时间线历史 user row 上的 chip。 */
async function readPaneComposerReferenceCount(paneTestId: string): Promise<number | null> {
  return browser.execute((nextPaneTestId) => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`);
    const chip = Array.from(
      pane?.querySelectorAll<HTMLElement>("[data-conversation-selection-reference-count]") ?? [],
    )
      .filter((candidate) => !candidate.closest("[data-row-id]"))
      .at(-1);
    return chip ? Number(chip.dataset.conversationSelectionReferenceCount) : null;
  }, paneTestId);
}

async function waitForPaneComposerReferenceCount(paneTestId: string, count: number): Promise<void> {
  await browser.waitUntil(
    async () => (await readPaneComposerReferenceCount(paneTestId)) === count,
    { timeout: 15000, timeoutMsg: `composer 注释条数不是 ${count}: ${paneTestId}` },
  );
}

async function readPaneAnnotationMarkCount(paneTestId: string): Promise<number> {
  return browser.execute(
    (nextPaneTestId) =>
      document
        .querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`)
        ?.querySelectorAll("[data-conversation-annotation-marks] [data-annotation-number-variant]")
        .length ?? 0,
    paneTestId,
  );
}

/** composer 有 count 条注释，且该 pane 正文画出同样数量的编号标记。 */
async function waitForPaneAnnotations(paneTestId: string, count: number): Promise<void> {
  await waitForPaneComposerReferenceCount(paneTestId, count);
  await browser.waitUntil(async () => (await readPaneAnnotationMarkCount(paneTestId)) === count, {
    timeout: 15000,
    timeoutMsg: `正文注释编号数量不是 ${count}: ${paneTestId}`,
  });
}

async function expectNoSelectionOverlay(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          !document.querySelector("[data-conversation-selection-tooltip]") &&
          !document.querySelector("[data-conversation-selection-comment-editor]"),
      ),
    { timeout: 5000, timeoutMsg: "选区浮层或注释输入没有关闭" },
  );
}

/** 恢复可见后浮层不能重新弹出：先确认关闭，再观察一段时间仍为关闭。 */
async function expectNoSelectionOverlayStays(): Promise<void> {
  await expectNoSelectionOverlay();
  // 浮层由 rAF 调度重新检查选区；观察窗口覆盖多帧与侧栏展开动画。
  await browser.pause(1000);
  await expectNoSelectionOverlay();
}

async function toggleSidePane(paneTestId: string, target: "collapse" | "expand"): Promise<void> {
  await $(`[data-testid="${TID_SIDE_PANE_TOGGLE}"]`).click();
  await $(
    `[data-testid="${paneTestId}"] [data-testid="${TID_V4_COMPOSER_INPUT}"]`,
  ).waitForDisplayed({ reverse: target === "collapse", timeout: 15000 });
  if (target === "collapse") return;
  // 侧栏展开宽度由动画驱动（不全是 CSS transition），文字仍在横移时取坐标会拖偏；
  // 等 pane 位置连续两次采样一致后再继续划词。
  let previous = "";
  await browser.waitUntil(
    async () => {
      const rect = await browser.execute((nextPaneTestId) => {
        const box = document
          .querySelector<HTMLElement>(`[data-testid="${nextPaneTestId}"]`)
          ?.getBoundingClientRect();
        return box ? `${box.left}:${box.width}` : "";
      }, paneTestId);
      const stable = rect !== "" && rect === previous;
      previous = rect;
      return stable;
    },
    { timeout: 10000, interval: 200, timeoutMsg: `侧栏展开后布局没有稳定: ${paneTestId}` },
  );
}

async function isFocusInsideComposer(paneTestId: string): Promise<boolean> {
  return browser.execute(
    (nextPaneTestId, inputTestId) => {
      const input = document.querySelector<HTMLElement>(
        `[data-testid="${nextPaneTestId}"] [data-testid="${inputTestId}"]`,
      );
      return Boolean(input && document.activeElement && input.contains(document.activeElement));
    },
    paneTestId,
    TID_V4_COMPOSER_INPUT,
  );
}
