import {
  TID_CHAT_TOOL_CALL_BLOCK,
  TID_V4_COMPOSER_INPUT,
  TID_V4_COMPOSER_SEND,
  TID_V4_SESSION_PANE,
  testId,
} from "@zcode/shared";
import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";
import { waitForUpstreamRequest } from "../../../helpers/conversation-session.js";

const ROOT_MARKER = "E2E_PLAN_SIDE_CHAT_ROOT";
const PROMPT_MARKER = "E2E_PLAN_SIDE_CHAT_PROMPT";
const ENTER_MARKER = "E2E_PLAN_SIDE_CHAT_ENTER";
const EXIT_MARKER = "E2E_PLAN_SIDE_CHAT_EXIT";
const PLAN_MARKER = "E2E_PLAN_SIDE_CHAT_BODY";
const ENTER_TOOL_CALL_ID = "toolu_e2e_plan_side_chat_enter";
const EXIT_TOOL_CALL_ID = "toolu_e2e_plan_side_chat_exit";

describe("conversation session plan detail from side chat", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("opens a child-session ExitPlanMode plan in the root task side pane", async function () {
    this.timeout(120_000);
    await prepareV4ConversationE2E();
    await sendV4Prompt(`Reply with exactly ${ROOT_MARKER}`);
    await waitForV4TimelineContaining(ROOT_MARKER, 60_000);

    const mainPaneTestId = testId(TID_V4_SESSION_PANE, "workspace-main");
    await setComposerText(
      mainPaneTestId,
      `/btw ${PROMPT_MARKER}: ${ENTER_MARKER} enter plan mode; ${EXIT_MARKER} request approval with a plan containing ${PLAN_MARKER}.`,
    );
    await clickComposerSend(mainPaneTestId);
    const child = await waitForSelectionSidePane();

    await waitForUpstreamRequest(
      {
        includes: [PROMPT_MARKER, ENTER_MARKER, EXIT_MARKER],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "side-chat plan initial request",
      60_000,
    );
    await waitForUpstreamRequest(
      {
        includes: [EXIT_MARKER, ENTER_TOOL_CALL_ID],
        excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
      },
      "side-chat plan ExitPlanMode request",
      60_000,
    );
    await waitForPlanCard(child.paneTestId, PLAN_MARKER, 60_000);

    const opened = await browser.execute((paneTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
      const button = Array.from(pane?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (candidate) =>
          candidate.innerText.includes("View full plan") ||
          candidate.innerText.includes("查看完整计划"),
      );
      button?.click();
      return Boolean(button);
    }, child.paneTestId);
    expect(opened).toBe(true);

    await browser.waitUntil(
      () =>
        browser.execute(
          (toolCallId, marker) => {
            const detail = document.querySelector<HTMLElement>(
              `[data-plan-detail-tool-call-id="${toolCallId}"]`,
            );
            return Boolean(detail?.innerText.includes(marker));
          },
          EXIT_TOOL_CALL_ID,
          PLAN_MARKER,
        ),
      { timeout: 30_000, timeoutMsg: "Side chat plan detail tab did not open under the root task" },
    );
  });
});

async function setComposerText(paneTestId: string, text: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (currentPaneTestId, inputTestId, nextText) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${currentPaneTestId}"]`);
          const input = pane?.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
          const bridge = (
            input as
              | (HTMLElement & {
                  __zcodeLexicalInputE2E?: {
                    getText: () => string;
                    setText: (value: string) => void;
                  };
                })
              | undefined
          )?.__zcodeLexicalInputE2E;
          if (!bridge) return false;
          bridge.setText(nextText);
          return bridge.getText() === nextText;
        },
        paneTestId,
        TID_V4_COMPOSER_INPUT,
        text,
      ),
    { timeout: 15_000, timeoutMsg: `composer is not editable: ${paneTestId}` },
  );
}

async function clickComposerSend(paneTestId: string): Promise<void> {
  const clicked = await browser.execute(
    (currentPaneTestId, sendTestId) => {
      const pane = document.querySelector<HTMLElement>(`[data-testid="${currentPaneTestId}"]`);
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

async function waitForSelectionSidePane(): Promise<{ childSessionId: string; paneTestId: string }> {
  let result: { childSessionId: string; paneTestId: string } | null = null;
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
        return childSessionId ? { childSessionId, paneTestId } : null;
      }, TID_V4_SESSION_PANE);
      return result !== null;
    },
    { timeout: 30_000, timeoutMsg: "selection side chat did not open" },
  );
  if (!result) throw new Error("selection side chat pane result missing");
  return result;
}

async function waitForPlanCard(
  paneTestId: string,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const planToolTestId = testId(TID_CHAT_TOOL_CALL_BLOCK, EXIT_TOOL_CALL_ID);
  await browser.waitUntil(
    () =>
      browser.execute(
        (currentPaneTestId, expectedMarker, toolTestId) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${currentPaneTestId}"]`);
          const toolCall = pane?.querySelector<HTMLElement>(`[data-testid="${toolTestId}"]`);
          return Boolean(toolCall?.innerText.includes(expectedMarker));
        },
        paneTestId,
        marker,
        planToolTestId,
      ),
    { timeout: timeoutMs, timeoutMsg: "ExitPlanMode plan card did not render in the side chat" },
  );
}
