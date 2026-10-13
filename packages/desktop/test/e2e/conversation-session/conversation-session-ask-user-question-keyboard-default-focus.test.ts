import { clearAppData } from "../helpers/desktop-app.js";
import { waitForUpstreamRequest } from "../helpers/conversation-session-network.js";
import { waitForToolCallBlockByToolName } from "../helpers/conversation-session-tool.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const MARKER_EMPTY_SUBMIT = "E2E_ADF_EMPTY_SUBMIT";
const MARKER_TAB_ENTER = "E2E_ADF_TAB_ENTER";
const MARKER_ENTER_SKIP = "E2E_ADF_ENTER_SKIP";
const MARKER_MULTISELECT = "E2E_ADF_MULTISELECT";
const MARKER_ESCAPE_DISMISS = "E2E_ADF_ESCAPE_DISMISS";

const Q1_SINGLE = "E2E_ADF_Q1_SINGLE_SELECT";
const Q2_MULTI = "E2E_ADF_Q2_MULTI_SELECT";

const Q1_OPT_A = "E2E_ADF_Q1_A";
const Q1_OPT_B = "E2E_ADF_Q1_B";
const Q2_OPT_A = "E2E_ADF_Q2_A";
const Q2_OPT_B = "E2E_ADF_Q2_B";
const Q2_OPT_C = "E2E_ADF_Q2_C";

describe("AskUserQuestion 默认无焦点键盘导航 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  // Q15: dialog opens with no preselection → mouse-click Submit → submits an empty answer
  it("弹窗打开无预聚焦，鼠标点 Submit 提交空答案", async function () {
    this.timeout(180000);

    // Bug root cause: after this case was promoted it still used the legacy conversation harness,
    // so formal evidence could not guarantee the operations targeted the current V4 pane.
    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_EMPTY_SUBMIT}_${runId}: Trigger AskUserQuestion with one single-select question.`,
      `Question "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_EMPTY_SUBMIT}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    // Confirm the dialog appears with no option highlighted
    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    // Click Submit directly
    await clickPrimaryAction();

    // Confirm the empty answer was submitted
    await waitForUpstreamRequest(
      {
        includes: [`${MARKER_EMPTY_SUBMIT}_${runId}`, "toolu_e2e_adf_empty_submit"],
      },
      "空答案提交后 Agent 没有收到回复",
      60000,
    );
  });

  // Q18: dialog opens with no preselection → Tab → first item focused → Enter → selected and advanced
  it("无预聚焦时按 Tab 聚焦第一项，Enter 选中推进", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_TAB_ENTER}_${runId}: Trigger AskUserQuestion with two questions.`,
      `Q1 single-select "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      `Q2 single-select "${Q2_MULTI}" with options "${Q2_OPT_A}" and "${Q2_OPT_B}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_TAB_ENTER}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    // Confirm nothing is preselected
    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    // Tab → first item focused
    await browser.keys("Tab");
    await expectActiveOption(Q1_OPT_A);

    // Enter → selected and advanced to Q2
    await browser.keys("Enter");
    await waitForElicitationPage("2 / 2", Q2_MULTI);

    // Q2 also has no preselection (after switching questions, ordinary Q&A does not pre-focus).
    await expectNoOptionPreSelected();

    // The initial ArrowDown, like Tab, starts from card focus: it focuses the first item without selecting it.
    await browser.keys("ArrowDown");
    await expectActiveOption(Q2_OPT_A);
    await expectOptionSelected(Q2_OPT_A, false);
    await browser.keys("Enter");

    await waitForUpstreamRequest(
      { includes: [`${MARKER_TAB_ENTER}_${runId}`, Q1_OPT_A, Q2_OPT_A] },
      "Tab+Enter 选择结果没有进入下一次模型请求",
      60000,
    );
  });

  // Q19: dialog opens with no preselection → Enter directly → skip the current question and advance
  it("无预聚焦时直接按 Enter 跳过当前题推进", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_ENTER_SKIP}_${runId}: Trigger AskUserQuestion with two single-select questions.`,
      `Q1 "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      `Q2 "${Q2_MULTI}" with options "${Q2_OPT_A}" and "${Q2_OPT_B}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_ENTER_SKIP}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    // Enter directly → skip Q1
    await browser.keys("Enter");
    await waitForElicitationPage("2 / 2", Q2_MULTI);

    // Q22: while a later question is still at initial card focus, Escape returns to the previous question.
    await expectNoOptionPreSelected();
    await browser.keys("Escape");
    await waitForElicitationPage("1 / 2", Q1_SINGLE);
    await expectNoOptionPreSelected();

    // Enter directly again to skip Q1, proving the return did not implicitly select the first item.
    await browser.keys("Enter");
    await waitForElicitationPage("2 / 2", Q2_MULTI);

    // Tab → select Q2's first item → Enter to submit
    await browser.keys("Tab");
    await expectActiveOption(Q2_OPT_A);
    await browser.keys("Enter");

    await waitForUpstreamRequest(
      {
        includes: [`${MARKER_ENTER_SKIP}_${runId}`, "toolu_e2e_adf_enter_skip", Q2_OPT_A],
      },
      "Q1 跳过 + Q2 Enter 选中后没有进入模型请求",
      60000,
    );
  });

  // Q20: multi-select Space to check/uncheck, Enter to confirm
  it("多选题 Space 勾选取消，Enter 确认提交", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_MULTISELECT}_${runId}: Trigger AskUserQuestion with one multi-select question.`,
      `Multi-select question "${Q2_MULTI}"`,
      `with options "${Q2_OPT_A}", "${Q2_OPT_B}", "${Q2_OPT_C}".`,
      "Do not answer. After the user responds, briefly confirm what was received.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_MULTISELECT}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);

    await waitForElicitationVisible(Q2_MULTI);
    await expectNoOptionSelected();

    // Tab focuses the first item
    await browser.keys("Tab");
    await expectActiveOption(Q2_OPT_A);

    // Space checks Q2_OPT_A
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_A, true);

    // ArrowDown moves to Q2_OPT_B
    await browser.keys("ArrowDown");
    // Space checks Q2_OPT_B
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_B, true);

    // ArrowDown moves to Q2_OPT_C, Space checks it
    await browser.keys("ArrowDown");
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_C, true);

    // ArrowUp back to Q2_OPT_B, Space unchecks it
    await browser.keys("ArrowUp");
    await browser.keys(" ");
    await expectOptionChecked(Q2_OPT_B, false);

    // Enter confirms the submission
    await browser.keys("Enter");

    await waitForUpstreamRequest(
      { includes: [`${MARKER_MULTISELECT}_${runId}`, Q2_OPT_A, Q2_OPT_C] },
      "多选 Space + Enter 结果没有进入模型请求",
      60000,
    );
  });

  // Q22: first question at initial card focus → Escape → dismiss, and the declined result is returned to the Agent
  it("首题无选项聚焦时按 Escape 关闭整组问答", async function () {
    this.timeout(180000);

    await prepareV4ConversationE2E();

    const runId = Date.now();
    const prompt = [
      `${MARKER_ESCAPE_DISMISS}_${runId}: Trigger AskUserQuestion with one single-select question.`,
      `Question "${Q1_SINGLE}" with options "${Q1_OPT_A}" and "${Q1_OPT_B}".`,
      "Do not answer. Stop if the user dismisses the question.",
    ].join(" ");

    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(`${MARKER_ESCAPE_DISMISS}_${runId}`);
    await waitForToolCallBlockByToolName("AskUserQuestion", 60000);
    await waitForElicitationVisible(Q1_SINGLE);
    await expectNoOptionPreSelected();

    await browser.keys("Escape");
    await waitForElicitationClosed();
    // Fix rationale: the negative 1200ms packet-capture count depended on artifact flush timing; in isolation the
    // run could still read the old file after the request had already been sent, producing a false green. The current
    // product contract is that dismiss closes the UI and hands the declined tool_result to the model to wrap up; use
    // the case-local final fixture to positively evidence that request.
    await waitForUpstreamRequest(
      {
        includes: [
          `${MARKER_ESCAPE_DISMISS}_${runId}`,
          "toolu_e2e_adf_escape_dismiss",
          "AskUserQuestion was declined",
        ],
      },
      "Escape dismiss 后 declined tool_result 没有进入模型收口请求",
      60000,
    );
    await waitForV4TimelineContaining("E2E_ADF_ESCAPE_DISMISS_ACK", 60000);
  });
});

// --- helpers ---

interface ElicitationKeyboardSnapshot {
  activeText: string;
  bodyText: string;
  cardFocused: boolean;
  pageText: string | null;
  selectedTexts: string[];
  visible: boolean;
}

async function waitForElicitationVisible(questionContains: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.visible && latest.bodyText.includes(questionContains);
      },
      {
        timeout: 60000,
        timeoutMsg: `AskUserQuestion 弹窗没有出现或内容不包含 "${questionContains}"`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(`AskUserQuestion 弹窗没有出现; snapshot=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function waitForElicitationPage(pageText: string, questionContains: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return (
          latest.visible &&
          latest.pageText === pageText &&
          latest.bodyText.includes(questionContains)
        );
      },
      {
        timeout: 60000,
        timeoutMsg: `AskUserQuestion 没有进入目标题目 ${pageText} ${questionContains}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 没有进入目标题目; expected=${pageText}/${questionContains}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectNoOptionPreSelected() {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.cardFocused && latest.activeText === "" && latest.selectedTexts.length === 0;
      },
      {
        timeout: 10000,
        timeoutMsg: "AskUserQuestion 弹窗不应有预选选项",
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(`AskUserQuestion 弹窗不应有预选选项; snapshot=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function expectNoOptionSelected() {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.selectedTexts.length === 0;
      },
      {
        timeout: 10000,
        timeoutMsg: "AskUserQuestion 弹窗不应有已选选项",
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(`AskUserQuestion 弹窗不应有已选选项; snapshot=${JSON.stringify(latest)}`, {
      cause: error,
    });
  }
}

async function expectActiveOption(optionText: string) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        return latest.activeText.includes(optionText);
      },
      {
        timeout: 10000,
        timeoutMsg: `AskUserQuestion 当前焦点选项不是 "${optionText}"`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 当前焦点选项不是 "${optionText}"; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectOptionChecked(optionText: string, checked: boolean) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        const isSelected = latest.selectedTexts.some((t) => t.includes(optionText));
        return isSelected === checked;
      },
      {
        timeout: 10000,
        timeoutMsg: `AskUserQuestion 勾选状态不符合预期; option=${optionText} expectedChecked=${checked}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 勾选状态不符合预期; option=${optionText} expectedChecked=${checked}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function expectOptionSelected(optionText: string, selected: boolean) {
  let latest: ElicitationKeyboardSnapshot | null = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await getElicitationKeyboardSnapshot();
        const isSelected = latest.selectedTexts.some((text) => text.includes(optionText));
        return isSelected === selected;
      },
      {
        timeout: 10000,
        timeoutMsg: `AskUserQuestion 单选状态不符合预期; option=${optionText} expectedSelected=${selected}`,
      },
    );
  } catch (error) {
    latest = await getElicitationKeyboardSnapshot();
    throw new Error(
      `AskUserQuestion 单选状态不符合预期; option=${optionText} expectedSelected=${selected}; snapshot=${JSON.stringify(latest)}`,
      { cause: error },
    );
  }
}

async function clickPrimaryAction() {
  const button = await $('[data-elicitation-dialog-footer="true"] button:last-child');
  await button.waitForDisplayed({ timeout: 10000 });
  await button.click();
}

async function waitForElicitationClosed() {
  await browser.waitUntil(
    async () =>
      !(await browser.execute(() =>
        Boolean(document.querySelector('[data-elicitation-dialog-card="true"]')),
      )),
    {
      timeout: 10000,
      timeoutMsg: "AskUserQuestion 弹窗没有在 Escape 后关闭",
    },
  );
}

function getElicitationKeyboardSnapshot(): Promise<ElicitationKeyboardSnapshot> {
  return browser.execute(() => {
    const normalizeText = (value: string | null | undefined) =>
      (value ?? "").replace(/\u00a0/g, " ").trim();
    const body = document.querySelector<HTMLElement>('[data-elicitation-dialog-body="true"]');
    const focused = document.activeElement as HTMLElement | null;
    const card = document.querySelector<HTMLElement>('[data-elicitation-dialog-card="true"]');
    // Fix rationale: roving tabindex still gives the first item tabindex=0 while the card is focused; only
    // document.activeElement can prove an option holds real keyboard focus.
    const activeOption = focused?.closest<HTMLElement>('button[role="option"],[role="checkbox"]');
    const pageText =
      normalizeText(body?.innerText)
        .match(/\b\d+\s*\/\s*\d+\b/)?.[0]
        ?.replace(/\s+/g, " ") ?? null;
    const selectedTexts = Array.from(
      body?.querySelectorAll<HTMLElement>(
        'button[role="option"][aria-selected="true"],[role="checkbox"][aria-checked="true"]',
      ) ?? [],
    ).map((element) => normalizeText(element.innerText));

    return {
      activeText: normalizeText(activeOption?.innerText),
      bodyText: normalizeText(body?.innerText),
      cardFocused: focused === card,
      pageText,
      selectedTexts,
      visible: Boolean(body),
    };
  });
}
