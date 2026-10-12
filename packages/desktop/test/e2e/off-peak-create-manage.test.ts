import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_OFFPEAK_ACTION_CONTINUE,
  TID_OFFPEAK_ACTION_DELETE,
  TID_OFFPEAK_ACTION_PAUSE,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CARD_MENU,
  TID_OFFPEAK_CREATE_BUTTON,
  TID_OFFPEAK_EDIT_SUBMIT,
  TID_OFFPEAK_EDIT_VIEW,
  TID_OFFPEAK_FORM_INSTRUCTIONS,
  TID_OFFPEAK_FORM_TITLE,
  TID_OFFPEAK_TAB,
  TID_AUTOMATIONS_OPEN,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  testId,
} from "@zcode/shared";
import {
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  getE2EAppDataPaths,
  restoreElectronRendererContentSize,
  setInputValueByTestIdDom,
  setCurrentElectronRendererContentSize,
  type ElectronRendererContentSizeSnapshot,
  waitForTestIdByDom,
} from "./helpers/desktop-app.js";
import {
  ensureUpstreamModelForE2E,
  selectUpstreamModelById,
  UPSTREAM_SECONDARY_MODEL,
} from "./helpers/upstream-provider.js";
import { prepareConversationE2E, startNewTask } from "./helpers/conversation-session.js";
import {
  restartIntoWorkspace,
  seedBigModelConnectionSelection,
  seedBigModelOAuthCredential,
} from "./helpers/model-provider-restart.js";

let rendererSizeSnapshot: ElectronRendererContentSizeSnapshot | undefined;

/**
 * Idle-time task end-to-end: "form creation -> list echo -> Pause -> Continue -> delete".
 *
 * Driven by an in-process mock gateway (wdio.conf startOffPeakE2EMock sets ZCODE_OFFPEAK_MOCK=1):
 * the host starts the gateway, the rollout flag is forced on, and tickets stay queued within this
 * spec window. The whole flow only touches the UI + local sqlite + the in-process gateway's
 * ticket/status endpoints and dispatches no model requests, so it is deterministic.
 * Full runs (dispatch -> running -> completed), sensitive approvals, and restart resume are
 * covered by OPF/OPA/OPR in the coverage matrix.
 */
describe("闲时任务表单创建与管理 E2E", () => {
  afterEach(async function () {
    if (this.currentTest?.state === "failed") {
      console.info("[SR87 idle diagnosis]", await browser.execute(() => document.body.innerText));
    }
  });
  after(async () => {
    if (rendererSizeSnapshot) {
      await restoreElectronRendererContentSize(rendererSizeSnapshot);
    }
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("表单创建闲时任务后列表回显，可 Pause / Continue 并删除", async function () {
    this.timeout(150000);

    // Login + workspace ready is enough to enter the Automations main view; the mock gateway removes the need for a real provider.
    await prepareConversationE2E({ skipProvider: true });
    await seedCurrentAccount();
    // Fix reason: Electron 41 does not support WebDriver window/rect; only by fixing a wide
    // screen via BrowserWindow can we stably verify that a Tooltip preferring the right side
    // does not flip due to the narrow-window collision strategy.
    // Fix only the width to hit the right-side Tooltip layout; height is limited by the macOS
    // work area and cannot be hardcoded to 960px.
    rendererSizeSnapshot = await setCurrentElectronRendererContentSize(1440);

    // 1) Open the Automations main view (sidebar entry).
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, {
      timeoutMsg: "侧栏没有出现 Automations 入口",
    });

    // 2) Creation entries are shown per tab; enter idle-time tasks first — the idle-time create
    // button must not be looked for under the scheduled tab.
    // An empty list has no tabs and directly shows both kinds of creation entries; tabs only
    // split the flows once tasks exist.
    if (await browser.$(`[data-testid="${TID_OFFPEAK_TAB}"]`).isExisting())
      await selectIdleTimeTab();
    await clickTestIdByDom(TID_OFFPEAK_CREATE_BUTTON, {
      timeoutMsg: "闲时任务创建按钮没有出现（灰度未命中？）",
    });

    // 3) The model may be preselected, but the reasoning level must be explicitly chosen; do not rely on the legacy auto-fill-default behavior.
    await selectOffPeakReasoning();
    const title = `E2E_OFFPEAK_${Date.now()}`;
    await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, title, {
      timeoutMsg: "闲时任务标题输入没有出现",
    });
    await setInputValueByTestIdDom(
      TID_OFFPEAK_FORM_INSTRUCTIONS,
      "整理今天改动的文件并生成一份摘要",
      { timeoutMsg: "闲时任务 instructions 输入没有出现" },
    );
    await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, {
      timeoutMsg: "闲时任务创建提交按钮不可点击",
    });

    // 4) After a successful creation the list view still defaults to the scheduled tab; idle-time
    // tasks are never mixed into that tab, so switch to "Idle-time task" before verifying the echo.
    await selectIdleTimeTab();
    await browser.waitUntil(
      async () => (await offPeakCardTitles()).some((t) => t.includes(title)),
      {
        timeout: 20000,
        timeoutMsg: `闲时任务列表没有回显新建卡片：${title}`,
      },
    );

    // 5) Pause: the new task must be paused first so the scheduler does not dispatch it while the details are being inspected.
    await openOffPeakCardMenu({
      timeoutMsg: "卡片操作菜单没有出现",
    });
    await assertMenuHintDoesNotSelectAction(TID_OFFPEAK_ACTION_PAUSE, "right");

    // Fix reason: in a narrow window the right hint gets flipped by Radix to left inside the
    // menu, so after it switches to top we must verify it no longer intersects the menu at all;
    // this size covers the single-column card layout users get after shrinking the desktop window.
    await browser.keys("Escape");
    await setCurrentElectronRendererContentSize(900, 720);
    await openOffPeakCardMenu({
      timeoutMsg: "窄窗口下卡片操作菜单没有出现",
    });
    await assertMenuHintDoesNotSelectAction(TID_OFFPEAK_ACTION_PAUSE, "top");
    await clickTestIdByDom(TID_OFFPEAK_ACTION_PAUSE, {
      timeoutMsg: "卡片菜单没有 Pause 项",
    });
    await setCurrentElectronRendererContentSize(1440);
    await openOffPeakCardMenu({
      timeoutMsg: "Pause 后重新打开卡片菜单失败",
    });
    await waitForTestIdByDom(TID_OFFPEAK_ACTION_CONTINUE, {
      timeoutMsg: "Pause 后菜单没有出现 Continue，状态未切 paused",
    });

    // 6) Clicking the card body enters the task details; History is reachable and the empty state keeps no creation CTA.
    await browser.execute((cardTid) => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (item) => item.dataset.testid === cardTid,
      );
      card?.click();
    }, TID_OFFPEAK_CARD);
    await waitForTestIdByDom(TID_OFFPEAK_EDIT_VIEW, {
      timeoutMsg: "点击闲时任务卡片没有进入任务详情",
    });
    const editView = await browser.$(`[data-testid="${TID_OFFPEAK_EDIT_VIEW}"]`);
    const editViewButtons = await editView.$$("button");
    let historyButton: WebdriverIO.Element | undefined;
    for (const button of editViewButtons) {
      if (/History|历史/.test(await button.getText())) {
        historyButton = button;
        break;
      }
    }
    if (!historyButton) {
      throw new Error("任务详情里没有 History 入口");
    }
    // Fix reason: Radix tabs switch the value at the pointer/mouse-down stage, while
    // HTMLElement.click() only dispatches a click event, so the old E2E found the History
    // button without ever actually switching the tab.
    await historyButton.click();
    await browser.waitUntil(
      async () =>
        browser.execute(
          (viewTid, submitTid) => {
            const view = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
              (item) => item.dataset.testid === viewTid,
            );
            return !Array.from(view?.querySelectorAll<HTMLElement>("[data-testid]") ?? []).some(
              (item) => item.dataset.testid === submitTid,
            );
          },
          TID_OFFPEAK_EDIT_VIEW,
          TID_OFFPEAK_EDIT_SUBMIT,
        ),
      {
        timeout: 5000,
        timeoutMsg: "History 详情态仍显示创建或保存 CTA",
      },
    );
    // Back navigation from the details page moved to the Settings header breadcrumb. The old
    // case clicked "the first button" in the edit area, which turned into a non-back action as
    // the Settings/History control ordering changed, leaving the test stuck on the details page.
    await clickAutomationsBreadcrumbBack();
    await browser.waitUntil(
      async () => (await offPeakCardTitles()).some((t) => t.includes(title)),
      {
        timeout: 10000,
        timeoutMsg: "从闲时任务详情返回后列表没有恢复",
      },
    );

    // 7) Continue: click Continue and the menu shows Pause again (state back to queued).
    await openOffPeakCardMenu({
      timeoutMsg: "返回列表后重新打开卡片菜单失败",
    });
    await assertMenuHintDoesNotSelectAction(TID_OFFPEAK_ACTION_CONTINUE, "right");
    await clickTestIdByDom(TID_OFFPEAK_ACTION_CONTINUE, {
      timeoutMsg: "卡片菜单没有 Continue 项",
    });
    await openOffPeakCardMenu({
      timeoutMsg: "Continue 后重新打开卡片菜单失败",
    });
    await waitForTestIdByDom(TID_OFFPEAK_ACTION_PAUSE, {
      timeoutMsg: "Continue 后菜单没有回到 Pause，状态未回 queued",
    });

    // 8) Delete: click Delete in the menu -> confirm again -> the card disappears.
    await clickTestIdByDom(TID_OFFPEAK_ACTION_DELETE, {
      timeoutMsg: "卡片菜单没有删除项",
    });
    await clickTestIdByDom(TID_CONFIRM_DIALOG_CONFIRM, {
      timeoutMsg: "删除二次确认弹窗没有出现",
    });
    await browser.waitUntil(
      async () => !(await offPeakCardTitles()).some((t) => t.includes(title)),
      { timeout: 15000, timeoutMsg: `删除后卡片仍然存在：${title}` },
    );
  });

  it("F-OFFPEAK-004：等待运行期间切换普通聊天计划不会重绑已保存闲时任务", async function () {
    this.timeout(150000);
    await startNewTask();
    await prepareConversationE2E();
    await ensureUpstreamModelForE2E(UPSTREAM_SECONDARY_MODEL);

    await clickTestIdByDom(TID_AUTOMATIONS_OPEN, { timeoutMsg: "侧栏没有 Automations 入口" });
    await clickTestIdByDom(TID_OFFPEAK_CREATE_BUTTON, { timeoutMsg: "闲时任务创建按钮没有出现" });
    await selectOffPeakReasoning();
    const title = `E2E_OFFPEAK_SWITCH_${Date.now()}`;
    await setInputValueByTestIdDom(TID_OFFPEAK_FORM_TITLE, title);
    await setInputValueByTestIdDom(
      TID_OFFPEAK_FORM_INSTRUCTIONS,
      "等待期间切换普通聊天的模型连接，闲时任务仍使用创建时快照。",
    );
    await clickTestIdByDom(TID_OFFPEAK_EDIT_SUBMIT, { timeoutMsg: "闲时任务提交按钮不可用" });

    const before = await waitForOffPeakModelSelection(title);
    expect(before.providerId).toContain("offpeak");
    await startNewTask();
    await selectUpstreamModelById(UPSTREAM_SECONDARY_MODEL);
    const after = await waitForOffPeakModelSelection(title);
    expect(after).toEqual(before);
    expect(await readOffPeakStatus(title)).toBe("queued");
  });
});

/** The product currently shows scheduled and idle-time tasks in separate tabs; select the idle-time tab by its localized label. */
async function selectIdleTimeTab(): Promise<void> {
  const tabList = await browser.$(`[data-testid="${TID_OFFPEAK_TAB}"]`);
  const buttons = await tabList.$$("button");
  for (const button of buttons) {
    if (/Idle-time task|闲时任务/u.test(await button.getText())) {
      await button.click();
      return;
    }
  }
  throw new Error("闲时任务列表没有闲时 tab");
}

async function seedCurrentAccount(): Promise<void> {
  // The gateway mock only replaces ticket fetching, not the Registry's account model. Use the isolated account control plane.
  await restartIntoWorkspace({
    afterElectronProcessExit: async () => {
      await seedBigModelConnectionSelection({ kind: "individual-coding-plan" });
      await seedBigModelOAuthCredential();
    },
  });
}

async function selectOffPeakReasoning(): Promise<void> {
  await clickTestIdByWebDriver(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER);
  await clickTestIdByWebDriver(testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, "high"));
}

/** The Automations breadcrumb in the Settings header is the real entry for going back from edit details to the list. */
async function clickAutomationsBreadcrumbBack(): Promise<void> {
  const buttons = await browser.$$("nav[aria-label] button");
  for (const button of buttons) {
    if (/Automations|自动化/u.test(await button.getText())) {
      await button.click();
      return;
    }
  }
  throw new Error("闲时任务详情没有返回 Automations 列表的 breadcrumb 入口");
}

/** Text of all idle-time task cards currently in the list (titles included). */
async function offPeakCardTitles(): Promise<string[]> {
  return browser.execute((cardTid) => {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .filter((item) => item.dataset.testid === cardTid)
      .map((item) => item.textContent?.trim() ?? "");
  }, TID_OFFPEAK_CARD);
}

/** The desktop card menu only shows after hover; the Radix trigger also needs a real pointerdown. */
async function openOffPeakCardMenu({ timeoutMsg }: { timeoutMsg: string }): Promise<void> {
  const card = await browser.$(`[data-testid="${TID_OFFPEAK_CARD}"]`);
  const menu = await browser.$(`[data-testid="${TID_OFFPEAK_CARD_MENU}"]`);
  // Shrinking the window makes the list container scrollable. Scroll the card back into the
  // viewport and hover over it for real; the button's visibility is driven by the group-hover
  // CSS transition. After the window shrinks, ChromeDriver on Electron 41 misjudges buttons
  // that are already visible, enabled, and inside the viewport as unclickable in
  // waitForClickable, so issue a real WebDriver click directly once the verified DOM
  // preconditions for interaction hold.
  await card.scrollIntoView();
  await card.moveTo();
  await browser.waitUntil(
    () =>
      browser
        .execute((menuTestId) => {
          const menu = document.querySelector<HTMLElement>(`[data-testid="${menuTestId}"]`);
          if (!(menu instanceof HTMLButtonElement)) return { present: false };
          const rect = menu.getBoundingClientRect();
          return {
            disabled: menu.disabled,
            opacity: getComputedStyle(menu).opacity,
            present: true,
            visible:
              rect.bottom > 0 &&
              rect.left > 0 &&
              rect.right < window.innerWidth &&
              rect.top < window.innerHeight,
          };
        }, TID_OFFPEAK_CARD_MENU)
        .then(
          (state) => state.present && !state.disabled && state.opacity === "1" && state.visible,
        ),
    { timeout: 5_000, timeoutMsg },
  );
  try {
    await menu.click();
  } catch (error) {
    const opened = await browser.execute((menuTestId) => {
      const trigger = document.querySelector<HTMLElement>(`[data-testid="${menuTestId}"]`);
      return trigger?.getAttribute("aria-expanded") === "true";
    }, TID_OFFPEAK_CARD_MENU);
    // After a resize, Electron 41 + ChromeDriver can produce a false "html intercepted click"
    // error even though the same native pointer chain already put the Radix trigger into
    // aria-expanded=true. Continue only when the menu is really open; otherwise keep the
    // original error so a genuine click failure is not swallowed.
    if (!opened) throw error;
  }
}

/**
 * The Pause / Continue info icons are embedded inside selectable menu items: the tooltip must
 * avoid the menu, and clicking the icon must only show the description without bubbling up
 * to run the parent action.
 */
async function assertMenuHintDoesNotSelectAction(
  actionTestId: string,
  expectedSide: "right" | "top",
): Promise<void> {
  const action = await browser.$(`[data-testid="${actionTestId}"]`);
  const hintTrigger = await action.$(":scope > span:last-child");
  await hintTrigger.moveTo();

  await browser.waitUntil(
    async () => {
      const tooltip = await browser.$('[role="tooltip"]');
      return tooltip.isDisplayed();
    },
    {
      timeout: 5000,
      timeoutMsg: `操作提示没有出现：${actionTestId}`,
    },
  );

  const geometry = await browser.execute(() => {
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    // The portal keeps tooltip nodes that are closing; read only the currently open node,
    // otherwise an empty data-side would falsely report the actual right/top layout as a failure.
    const tooltip = Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]')).find(
      (item) => item.dataset.state !== "closed",
    );
    if (!menu || !tooltip) {
      return null;
    }
    const menuRect = menu.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    return {
      menuRight: menuRect.right,
      menuTop: menuRect.top,
      tooltipBottom: tooltipRect.bottom,
      tooltipLeft: tooltipRect.left,
      tooltipWidth: tooltipRect.width,
    };
  });

  expect(geometry).not.toBeNull();
  // Radix's data-side is an internal implementation property, not a promise to the user; the
  // actual geometry is the behavioral contract for the tooltip avoiding the menu.
  if (expectedSide === "right") {
    expect(geometry?.tooltipLeft ?? 0).toBeGreaterThanOrEqual(
      geometry?.menuRight ?? Number.POSITIVE_INFINITY,
    );
  } else {
    expect(geometry?.tooltipBottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      geometry?.menuTop ?? 0,
    );
  }
  expect(geometry?.tooltipWidth ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(320);

  await hintTrigger.click();
  await browser.waitUntil(
    async () => {
      const currentAction = await browser.$(`[data-testid="${actionTestId}"]`);
      return currentAction.isDisplayed();
    },
    {
      timeout: 2000,
      timeoutMsg: `点击信息图标错误触发了父级动作：${actionTestId}`,
    },
  );
}

async function waitForOffPeakModelSelection(title: string): Promise<{
  modelId: string;
  providerId: string;
}> {
  let selection: { modelId: string; providerId: string } | null = null;
  await browser.waitUntil(
    async () => {
      selection = readOffPeakModelSelection(title);
      return selection !== null;
    },
    { timeout: 30000, interval: 500, timeoutMsg: `闲时任务没有保存模型选择：${title}` },
  );
  if (!selection) throw new Error(`闲时任务模型选择为空：${title}`);
  return selection;
}

function readOffPeakModelSelection(title: string): { modelId: string; providerId: string } | null {
  const database = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT model_selection FROM off_peak_tasks WHERE title = ?")
      .get(title) as { model_selection: string | null } | undefined;
    if (!row?.model_selection) return null;
    const parsed = JSON.parse(row.model_selection) as { modelId?: string; providerId?: string };
    return parsed.modelId && parsed.providerId
      ? { modelId: parsed.modelId, providerId: parsed.providerId }
      : null;
  } finally {
    database.close();
  }
}

function readOffPeakStatus(title: string): string | null {
  const database = new DatabaseSync(join(getE2EAppDataPaths().appDataDir, "tasks-index.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database.prepare("SELECT status FROM off_peak_tasks WHERE title = ?").get(title) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  } finally {
    database.close();
  }
}
