import { clearAppData } from "../../../helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleUserMessagesNotContaining,
  getChatRootSnapshot,
  sendPrompt,
  waitForAssistantMessageContaining,
  waitForChatState,
  waitForComposerText,
  waitForUpstreamRequestContaining,
  waitForUserMessageContaining,
} from "../../../helpers/conversation-session.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

describe("会话区 Worktree 首发真实会话 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("Git 未 ready 时打开真实 session；ready 后同一 session 才启动 runtime 并发送首条消息", async function () {
    this.timeout(120000);

    await prepareV4ConversationE2E({ skipProvider: true });

    const destination = await $('button[aria-label="Choose where this task runs"]');
    await destination.waitForClickable({ timeout: 15000 });
    await destination.click();
    const worktreeSwitch = await $('button[role="switch"][aria-label="Worktree"]');
    await worktreeSwitch.waitForDisplayed({ timeout: 10000 });
    await worktreeSwitch.click();
    expect(await worktreeSwitch.getAttribute("aria-checked")).toBe("true");

    const runId = Date.now();
    const marker = `E2E_WORKTREE_CHAT_FIRST_${runId}`;
    const prompt = `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
    await sendPrompt(prompt);

    const setupStage = await $('[data-worktree-setup-steps="true"]');
    await setupStage.waitForDisplayed({ timeout: 10000 });
    await browser.waitUntil(
      async () =>
        (await $('[data-worktree-setup-step="creating"]').isExisting()) ||
        (await $('[data-worktree-setup-step="ready"]').isExisting()),
      { timeout: 10000, timeoutMsg: "chat shell did not show worktree setup progress" },
    );
    expect(await $('button[aria-label="Choose workspace"]').isExisting()).toBe(false);
    expect(await $('button[aria-label="Choose where this task runs"]').isExisting()).toBe(false);
    const header = await $('[data-testid="workspace-header"]');
    expect(await header.getAttribute("data-workspace-header-variant")).toBe("task");
    const beforeReady = await getChatRootSnapshot();
    expect(beforeReady.sessionId || beforeReady.taskId).toBeTruthy();
    const preparingSessionId = beforeReady.sessionId || beforeReady.taskId;
    await waitForComposerText("", "queued first message was not removed from the editor");
    await assertVisibleUserMessagesNotContaining(prompt);

    await waitForUserMessageContaining(prompt);
    const admitted = await waitForChatState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "worktree-ready first send did not bind the real session",
      30000,
    );
    expect(admitted.sessionId || admitted.taskId).toBe(preparingSessionId);
    await waitForUpstreamRequestContaining(marker, 60000);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
  });
});
