import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  testId,
  TID_AUTOMATION_CARD,
  TID_AUTOMATION_CUSTOM_CONFIRM,
  TID_AUTOMATION_CUSTOM_INTERVAL_SELECT,
  TID_AUTOMATION_CUSTOM_REPEAT_EDIT,
  TID_AUTOMATION_FORM_SUBMIT,
  TID_AUTOMATION_FORM_TITLE,
  TID_AUTOMATION_FREQUENCY_OPTION,
  TID_AUTOMATION_FREQUENCY_SELECT,
  TID_AUTOMATION_SCHEDULE_ADD,
  TID_AUTOMATION_SCHEDULE_DELETE,
  TID_AUTOMATION_SCHEDULE_PREVIEW,
  TID_AUTOMATIONS_LIST,
  TID_CHAT_MODE_SELECT_TRIGGER,
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_CRON_CREATE_CARD,
  TID_CRON_CREATE_OPEN,
  TID_V4_FEEDBACK_DISLIKE,
  TID_V4_FORK,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  clickTestIdByWebDriver,
  waitForTestIdByDom,
} from "../helpers/desktop-app.js";
import {
  expandAssistantHistoriesWithContent,
  getToolCallDiagnostics,
} from "../helpers/conversation-session-tool-diagnostics.js";
import {
  getUpstreamRequestToolContract,
  waitForUpstreamRequest,
} from "../helpers/conversation-session-network.js";
import {
  approveV4Permission,
  clickFirstV4Fork,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

// Aligned with fixtures/upstream/conversation-session/conversation-session-automation-cron-create.json:
// the marker in the prompt triggers the replayed CronCreate tool call; the title is the fixed automation
// title in the tool input.
const MARKER = "E2E_AUTOMATION_CRON_CREATE";
const AUTOMATION_TITLE = "E2E_CRON_STANDUP";
const INTERVAL = 31;
const INTERVAL_MINUTE = 49;
const COMPATIBLE_CRON = "49 * * * *";

/**
 * In-session CronCreate → chat card → derived turn-tail order → management page detail, end to end.
 *
 * The model response goes through upstream replay (the same-named fixture loads automatically); the
 * CronCreate tool really executes and persists; no dependence on the 20s polling scheduler, so it is
 * deterministic.
 */
describe("会话内 CronCreate 定时任务卡片与派生轮尾 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("创建定时任务 → 派生后卡片与操作栏先于分割线 → 直达任务详情", async function () {
    this.timeout(150000);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });

    // Trigger the replayed CronCreate tool call (prompt content doesn't matter; the fixture is matched by marker).
    await sendV4Prompt(`${MARKER} remind me every 31 hours at minute 49`);
    await waitForV4TimelineContaining(MARKER);
    // Regression boundary: the contract must actually reach the provider request; asserting only the local
    // ToolEntry would miss
    // link problems where description/input schema is lost during adapter serialization.
    const cronCreateRequest = {
      lastUserMessageIncludes: [MARKER],
    };
    await waitForUpstreamRequest(cronCreateRequest, "没有捕获到会话内 CronCreate 的 provider 请求");
    const cronCreateContract = await getUpstreamRequestToolContract(
      cronCreateRequest,
      "CronCreate",
    );
    expect(cronCreateContract).not.toBeNull();
    const serializedCronCreateContract = JSON.stringify(cronCreateContract);
    expect(serializedCronCreateContract).toContain("must never ask the run to create");
    expect(serializedCronCreateContract).toContain(
      "do not ask it to create or schedule another automation",
    );
    // Why: V4 parks CronCreate's side-effect permission request at the composer dock;
    // the old case waited for idle directly and would block forever — the tool only really executes and
    // persists after explicit approval.
    await approveV4Permission();
    const parent = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "会话内 CronCreate 没有完成",
      90000,
    );
    const parentSessionId = parent.sessionId;

    // 1) The CronCreate card appears in chat and shows the automation title (instead of falling back to a
    // plain tool block).
    // Bug root cause: in the completed state V4 folds tool calls into the assistant history; the old case
    // queried unmounted portal content directly and falsely reported the CronCreate card as missing.
    await expandAssistantHistoriesWithContent();
    try {
      await waitForTestIdByDom(TID_CRON_CREATE_CARD, {
        timeout: 15000,
        timeoutMsg: "会话内没有渲染 CronCreate 定时任务卡片",
      });
    } catch (error) {
      // Why: when the dedicated card is missing, keeping only the selector timeout cannot distinguish
      // "fixture didn't trigger",
      // "tool projection lost", and "renderer fallback". Bring the tool block/store evidence from the same
      // moment into the error.
      const diagnostics = await getToolCallDiagnostics({
        type: "toolName",
        value: "CronCreate",
      });
      throw new Error(
        `会话内没有渲染 CronCreate 定时任务卡片；diagnostics=${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
    await browser.waitUntil(
      async () => {
        const cardText = await readTestIdText(TID_CRON_CREATE_CARD);
        return (
          cardText.includes(AUTOMATION_TITLE) &&
          cardText.includes(String(INTERVAL)) &&
          cardText.includes(String(INTERVAL_MINUTE))
        );
      },
      {
        timeout: 10000,
        timeoutMsg: "CronCreate 卡片没有展示真实的每 31 小时第 49 分频率",
      },
    );
    const createdAutomation = await waitForAutomationRecordByTitle(AUTOMATION_TITLE);
    expect(createdAutomation.cronExpr).toBe(COMPATIBLE_CRON);
    expect(createdAutomation.scheduleRule).toMatchObject({
      unit: "hourly",
      interval: INTERVAL,
      minute: INTERVAL_MINUTE,
    });

    // 2) Derive from the completed-state assistant and switch to the child. The fork produces no new provider
    // request, so reusing the same deterministic fixture covers the render order after a real session
    // recovery.
    await waitForV4Fork();
    expect(await clickFirstV4Fork()).toBe(true);
    await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null &&
        snapshot.sessionId !== "draft" &&
        snapshot.sessionId !== parentSessionId,
      "CronCreate 会话派生后没有切到 child session",
      60000,
    );
    await waitForV4TimelineContaining(MARKER, 30000);
    await expandAssistantHistoriesWithContent();
    await waitForTestIdByDom(TID_CRON_CREATE_CARD, {
      timeout: 15000,
      timeoutMsg: "派生会话没有恢复 CronCreate 定时任务卡片",
    });

    // Bug root cause: turnTailBoundary, although split out of the work history, used to render before the
    // turn-local cards,
    // summary, and action bar. Lock the live DOM's full order here to make sure "derived from conversation"
    // always sits after the CronCreate card and the like/dislike/derive action bar.
    await waitForForkTailOrder();

    // 3) In the derived session, click "go to the automation" → enter the management page detail carrying
    // automationId.
    await clickTestIdByDom(TID_CRON_CREATE_OPEN, {
      timeoutMsg: "CronCreate 卡片没有可点击的「去到定时任务」按钮",
    });

    // Why: the product now opens the target detail directly after the list RPC completes; the old case still
    // waited for DOM that only exists in the
    // list view, which would stably misreport the correct navigation as a failure. Instead, lock the persisted
    // value of the detail title input.
    await waitForTestIdByDom(TID_AUTOMATION_FORM_TITLE, {
      timeout: 15000,
      timeoutMsg: "没有跳转到会话创建的定时任务详情",
    });
    await browser.waitUntil(
      async () => (await readTestIdValue(TID_AUTOMATION_FORM_TITLE)) === AUTOMATION_TITLE,
      {
        timeout: 15000,
        timeoutMsg: `任务详情没有回显会话创建的标题：${AUTOMATION_TITLE}`,
      },
    );

    // 3.5) Regression: when the detail page of a session-created task has no modifications, going back must
    // return straight to the list and must not misjudge the system callbacks emitted by Radix Select
    // registration races as user edits and pop the "unsaved" confirm dialog.
    // First wait for the permission-mode selector to mount, ensuring the assertion covers the race window
    // after toolbar control initialization.
    await waitForTestIdByDom(TID_CHAT_MODE_SELECT_TRIGGER, {
      timeout: 10000,
      timeoutMsg: "任务详情没有渲染权限模式选择器",
    });
    // The detail page's back navigation has moved to the Settings header breadcrumb; it mounts outside the
    // edit page, the sidebar test id
    // doesn't exist on the current surface, so the real breadcrumb must be clicked to return to the list.
    await clickAutomationsBreadcrumbBack();
    expect(await hasVisibleTestId(TID_CONFIRM_DIALOG_CONFIRM)).toBe(false);
    await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
      timeout: 15000,
      timeoutMsg: "无修改返回没有直接回到任务列表（疑似误弹未保存确认框）",
    });

    // Re-enter the detail and keep verifying the read-only schedule summary and the schedule-reset loop.
    await clickTestIdByDom(TID_AUTOMATION_CARD, {
      timeoutMsg: "返回列表后无法重新进入任务详情",
    });
    await browser.waitUntil(
      async () => (await readTestIdValue(TID_AUTOMATION_FORM_TITLE)) === AUTOMATION_TITLE,
      {
        timeout: 15000,
        timeoutMsg: `重新进入详情没有回显标题：${AUTOMATION_TITLE}`,
      },
    );

    // 4) The interval carrier's compatible cron is only an hourly candidate, but the detail page must echo the
    // authoritative
    // scheduleRule first and must not degrade to "the 49th minute of every hour".
    await waitForTestIdByDom(TID_AUTOMATION_SCHEDULE_PREVIEW, {
      timeout: 10000,
      timeoutMsg: "会话创建任务没有显示调度摘要",
    });
    const initialSchedule = await readTestIdText(TID_AUTOMATION_SCHEDULE_PREVIEW);
    expect(initialSchedule).toContain(String(INTERVAL));
    expect(initialSchedule).toContain(String(INTERVAL_MINUTE));
    expect(initialSchedule).not.toContain("下次运行");
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_REPEAT_EDIT, {
      timeoutMsg: "会话创建的 interval 调度没有自定义重复编辑入口",
    });
    await waitForTestIdByDom(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT, {
      timeout: 10000,
      timeoutMsg: "会话创建的 interval 调度没有复原自定义重复间隔",
    });
    expect(await readTestIdValue(TID_AUTOMATION_CUSTOM_INTERVAL_SELECT)).toBe(String(INTERVAL));
    await clickTestIdByDom(TID_AUTOMATION_CUSTOM_CONFIRM, {
      timeoutMsg: "会话创建的 interval 调度无法关闭自定义重复编辑",
    });

    // 5) Delete the old session schedule, then enter the standard UI add flow, pick daily, and save.
    await clickTestIdByDom(TID_AUTOMATION_SCHEDULE_DELETE, {
      timeoutMsg: "会话创建任务的自定义调度没有删除按钮",
    });
    await clickTestIdByWebDriver(TID_AUTOMATION_SCHEDULE_ADD, {
      timeoutMsg: "删除会话调度后没有进入添加调度流程",
    });
    await clickTestIdByDom(testId(TID_AUTOMATION_FREQUENCY_OPTION, "daily"), {
      timeoutMsg: "添加调度菜单没有每天选项",
    });
    await clickTestIdByDom(TID_AUTOMATION_FORM_SUBMIT, {
      timeoutMsg: "重新设置 UI 调度后无法保存",
    });

    // 6) Re-entering the detail should restore the standard UI schedule controls, proving the new cron replaced
    // the old session cron.
    await waitForTestIdByDom(TID_AUTOMATIONS_LIST, {
      timeout: 15000,
      timeoutMsg: "保存 UI 调度后没有回到任务列表",
    });
    await clickTestIdByDom(TID_AUTOMATION_CARD, {
      timeoutMsg: "无法再次进入会话创建任务详情",
    });
    await waitForTestIdByDom(TID_AUTOMATION_FREQUENCY_SELECT, {
      timeout: 15000,
      timeoutMsg: "重设后没有恢复标准 UI 调度控件",
    });
    const updatedSchedule = await readTestIdText(TID_AUTOMATION_SCHEDULE_PREVIEW);
    expect(updatedSchedule).not.toBe("自定义");
  });
});

/** The Settings header's Automations breadcrumb is the real entry from task detail back to the list. */
async function clickAutomationsBreadcrumbBack(): Promise<void> {
  const buttons = await browser.$$("nav[aria-label] button");
  for (const button of buttons) {
    if (/Automations|自动化/u.test(await button.getText())) {
      await button.click();
      return;
    }
  }
  throw new Error("任务详情没有返回 Automations 列表的 breadcrumb 入口");
}

interface AutomationRecord {
  cronExpr: string;
  scheduleRule: Record<string, unknown>;
}

async function waitForAutomationRecordByTitle(title: string): Promise<AutomationRecord> {
  let record: AutomationRecord | null = null;
  await browser.waitUntil(
    async () => {
      record = readAutomationRecordByTitle(title);
      return record !== null;
    },
    {
      timeout: 10000,
      timeoutMsg: `没有在 automation 数据库中找到 ${title}`,
    },
  );
  if (!record) throw new Error(`automation 数据库记录为空：${title}`);
  return record;
}

function readAutomationRecordByTitle(title: string): AutomationRecord | null {
  // Node's builtin SQLite currently only offers the synchronous DatabaseSync; the E2E does a single read-only
  // one-row query each time and closes immediately.
  const database = new DatabaseSync(
    join(getE2EAppDataPaths().storageRoot, "v2", "tasks-index.sqlite"),
    { readOnly: true },
  );
  try {
    const row = database
      .prepare(
        `SELECT cron_expr, schedule_rule
         FROM automations
         WHERE title = ?`,
      )
      .get(title) as { cron_expr: string; schedule_rule: string | null } | undefined;
    if (!row?.schedule_rule) return null;
    return {
      cronExpr: row.cron_expr,
      scheduleRule: JSON.parse(row.schedule_rule) as Record<string, unknown>,
    };
  } finally {
    database.close();
  }
}

/** Read the visible text of a test id element. */
async function readTestIdText(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (item) => item.dataset.testid === tid,
    );
    return el?.textContent?.trim() ?? "";
  }, currentTestId);
}

/** Whether a test id element is currently mounted (used to assert the confirm dialog did not appear). */
async function hasVisibleTestId(currentTestId: string): Promise<boolean> {
  return browser.execute(
    (tid) => Boolean(document.querySelector(`[data-testid="${tid}"]`)),
    currentTestId,
  );
}

interface ForkTailOrderSnapshot {
  cardTestId: string | null;
  dislikeTestId: string | null;
  forkActionTestId: string | null;
  boundaryRowId: string | null;
  ordered: boolean;
}

/** Wait for the card, action bar, and fork divider within the same turn to mount in the completed-state visual order. */
async function waitForForkTailOrder(): Promise<void> {
  let latest: ForkTailOrderSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readForkTailOrder();
        return latest.ordered;
      },
      {
        timeout: 15000,
        timeoutMsg: "派生分割线没有落在 CronCreate 卡片和 assistant 操作栏之后",
      },
    );
  } catch (error) {
    latest = await readForkTailOrder();
    throw new Error(`派生轮尾 DOM 顺序错误；latest=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

/** Read the key node order of the turn containing CronCreate in the derived child. */
async function readForkTailOrder(): Promise<ForkTailOrderSnapshot> {
  return browser.execute(
    (cardTid, dislikePrefix, forkPrefix) => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (item) => item.dataset.testid === cardTid,
      );
      const turn = card?.closest<HTMLElement>("[data-turn-id]");
      const dislike = turn?.querySelector<HTMLElement>(`[data-testid^="${dislikePrefix}-"]`);
      const forkAction = turn?.querySelector<HTMLElement>(`[data-testid^="${forkPrefix}-"]`);
      const boundary = turn?.querySelector<HTMLElement>(
        '[data-row-kind="timelineMarker"][data-marker-type="forkNotice"]',
      );
      const isBefore = (first?: HTMLElement | null, second?: HTMLElement | null) =>
        Boolean(
          first &&
          second &&
          first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      return {
        cardTestId: card?.dataset.testid ?? null,
        dislikeTestId: dislike?.dataset.testid ?? null,
        forkActionTestId: forkAction?.dataset.testid ?? null,
        boundaryRowId: boundary?.dataset.rowId ?? null,
        ordered:
          isBefore(card, dislike) &&
          isBefore(dislike, forkAction) &&
          isBefore(forkAction, boundary),
      };
    },
    TID_CRON_CREATE_CARD,
    TID_V4_FEEDBACK_DISLIKE,
    TID_V4_FORK,
  );
}

/** Read the current value of an input/textarea, avoiding misjudging controlled forms via textContent. */
async function readTestIdValue(currentTestId: string): Promise<string> {
  return browser.execute((tid) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `[data-testid="${tid}"]`,
    );
    return element?.value ?? "";
  }, currentTestId);
}
