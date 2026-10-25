import { encodeCustomModelValue } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_V4_COMPOSER_INPUT,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData } from "../../../helpers/desktop-app.js";
import { sel } from "../../../helpers/selectors.js";
import {
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_SECONDARY_MODEL,
} from "../../../helpers/upstream-provider.js";
import { selectTaskById } from "../../../helpers/conversation-session.js";
import {
  getV4ModelConfig,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";

// Pending (manual-review): the existing session is created by a replayed send. The replay server
// has no recording for the request this spec produces, and capture needs a real upstream key, so the
// send step fails in the local replay environment. See specs/composer-unresolved-model-selection.md
// and docs/ui/model-switch-toast.md for the scenarios.
// The token the recorded replay answers with for this prompt (observed in a replay run).
const REPLY_TOKEN = "deepseek-e2e-ok";
const REQUEST_PROMPT = `Reply with exactly "${REPLY_TOKEN}" and no other text.`;
// Matches the Chinese and English toast copy: "已从 … 切换至 …" / "Switched from … to …".
const SWITCH_TOAST_PATTERN = "Switched from |已从 .* 切换至";

describe("composer model pick in an existing session (ISSUE-035)", () => {
  after(async () => {
    await clearAppData();
  });

  it("MT01 picking a different model shows the switch toast before any send", async function () {
    this.timeout(180000);
    await createExistingSession();

    await pickModelFromToolbar(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL);

    await waitForSwitchToast();
  });

  it("MP01 a picked model without text survives leaving the session and returning", async function () {
    this.timeout(240000);
    const sessionId = await createExistingSession();

    await pickModelFromToolbar(UPSTREAM_PROVIDER_ID, UPSTREAM_SECONDARY_MODEL);
    await waitForSwitchToast();
    expect(await readComposerText()).toBe("");

    // Leave the session for a new draft, then open it again from the task list.
    await startNewV4Draft();
    await selectTaskById(sessionId);
    await browser.waitUntil(
      async () => (await getV4ModelConfig()).model === UPSTREAM_SECONDARY_MODEL,
      {
        timeout: 30000,
        timeoutMsg: `返回会话后模型没有恢复为所选的 ${UPSTREAM_SECONDARY_MODEL}`,
      },
    );
  });
});

async function createExistingSession(): Promise<string> {
  await prepareV4ConversationE2E();
  await sendV4Prompt(REQUEST_PROMPT);
  await waitForV4AssistantMessageContaining(REPLY_TOKEN, 90000);
  const snapshot = await getV4PaneSnapshot();
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error("发送后 v4 pane 没有绑定到已存在的会话");
  }
  return snapshot.sessionId;
}

// Model-only pick from the toolbar. switchV4Model also changes the reasoning depth, which this
// scenario does not exercise, so the menu click is repeated here without that step.
async function pickModelFromToolbar(provider: string, model: string) {
  const itemTestId = testId(TID_CHAT_MODEL_SELECT_ITEM, encodeCustomModelValue(provider, model));
  const groupTestId = testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${provider}`);
  const trigger = $(sel(TID_CHAT_MODEL_SELECT_TRIGGER));
  await trigger.waitForClickable({ timeout: 30000 });
  await trigger.click();
  await browser.waitUntil(
    async () =>
      browser.execute(
        (itemId, groupId) => {
          const item = document.querySelector<HTMLElement>(`[data-testid="${itemId}"]`);
          if (item) {
            item.click();
            return true;
          }
          // Provider models may sit in a submenu: expand the group first, then the item is listed.
          document.querySelector<HTMLElement>(`[data-testid="${groupId}"]`)?.click();
          return false;
        },
        itemTestId,
        groupTestId,
      ),
    { timeout: 45000, timeoutMsg: `模型菜单没有出现目标项: ${provider}/${model}` },
  );
  await browser.waitUntil(async () => (await getV4ModelConfig()).model === model, {
    timeout: 30000,
    timeoutMsg: `选择模型后 Composer 没有显示 ${model}`,
  });
}

async function waitForSwitchToast() {
  await browser.waitUntil(
    () =>
      browser.execute(
        (pattern) => new RegExp(pattern).test(document.body.innerText),
        SWITCH_TOAST_PATTERN,
      ),
    { timeout: 15000, timeoutMsg: "手动选择模型后没有出现切换提示" },
  );
}

async function readComposerText(): Promise<string> {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
    return input?.textContent?.trim() ?? "";
  }, TID_V4_COMPOSER_INPUT);
}
