import {
  setV4ComposerText,
  waitForV4ComposerText,
  startNewV4Draft,
  sendV4Prompt,
  getV4PaneSnapshot,
  selectV4TaskById,
  getV4Messages,
  waitForV4UserMessageContaining,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";
import { getV4ComposerDraftScopeSnapshot } from "../../../helpers/conversation-session-store.js";
import { getUpstreamRequestRecordCount } from "../../../helpers/conversation-session-network.js";
import { DEFAULT_WORKSPACE, clearAppData } from "../../../helpers/desktop-app.js";
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
    const creatingStep = $('[data-worktree-setup-step="creating"]');
    await creatingStep.waitForDisplayed({ timeout: 10000 });
    expect(await $('button[aria-label="Choose workspace"]').isExisting()).toBe(false);
    expect(await $('button[aria-label="Choose where this task runs"]').isExisting()).toBe(false);
    const header = await $('[data-testid="workspace-header"]');
    expect(await header.getAttribute("data-workspace-header-variant")).toBe("task");
    const beforeReady = await getChatRootSnapshot();
    expect(beforeReady.sessionId || beforeReady.taskId).toBeTruthy();
    const preparingSessionId = beforeReady.sessionId || beforeReady.taskId;
    await waitForComposerText("", "queued first message was not removed from the editor");
    await assertVisibleUserMessagesNotContaining(prompt);
    const nextDraft = "E2E_WORKTREE_NEXT_DRAFT";
    await setV4ComposerText(nextDraft);

    await $('[data-worktree-setup-step="ready"]').waitForDisplayed({ timeout: 30000 });
    await waitForUserMessageContaining(prompt);
    const admitted = await waitForChatState(
      (snapshot) => Boolean(snapshot.sessionId || snapshot.taskId),
      "worktree-ready first send did not bind the real session",
      30000,
    );
    expect(admitted.sessionId || admitted.taskId).toBe(preparingSessionId);
    await waitForUpstreamRequestContaining(marker, 60000);
    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForV4ComposerText(nextDraft, "The first send ACK cleared the next draft");
  });
  it("second message during the first response targets the active session without restarting preparation", async function () {
    this.timeout(120000);
    await startNewV4Draft();
    const destination = await $('button[aria-label="Choose where this task runs"]');
    await destination.waitForClickable({ timeout: 15000 });
    await destination.click();
    const toggle = await $('button[role="switch"][aria-label="Worktree"]');
    await toggle.waitForDisplayed({ timeout: 10000 });
    if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
    await destination.click();

    const runId = Date.now();
    const firstMarker = `E2E_WORKTREE_CHAT_FIRST_${runId}`;
    const secondMarker = `E2E_WORKTREE_CHAT_SECOND_${runId}`;
    await sendPrompt(`${firstMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`);
    await $('[data-worktree-setup-step="ready"]').waitForDisplayed({ timeout: 30000 });
    await waitForUserMessageContaining(firstMarker);
    const activeSessionId = (await getV4PaneSnapshot()).sessionId!;
    expect(activeSessionId).toBeTruthy();

    // Send while the first turn is still in flight: preparation must already be complete, so
    // this is ordinary session input (queue/guide), never a second reservation or worktree setup.
    const nextDraft = "E2E_WORKTREE_SECOND_NEXT_DRAFT";
    await setV4ComposerText(nextDraft);
    await sendV4Prompt(
      `${secondMarker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`,
    );
    expect(await $('[data-worktree-setup-steps="true"]').isExisting()).toBe(false);

    await waitForAssistantMessageContaining(E2E_REPLY_TOKEN);
    await waitForUpstreamRequestContaining(secondMarker, 60000);
    await waitForV4UserMessageContaining(secondMarker);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    // One runtime, one session: both turns live under the prepared session identity.
    expect((await getV4PaneSnapshot()).sessionId).toBe(activeSessionId);
    await waitForV4ComposerText(nextDraft, "The second send ACK cleared the next draft");
  });

  it("detaches the old send on navigation and keeps recovery separate from the next draft", async function () {
    this.timeout(120000);
    await startNewV4Draft();
    const destination = await $('button[aria-label="Choose where this task runs"]');
    await destination.waitForClickable({ timeout: 15000 });
    await destination.click();
    const toggle = await $('button[role="switch"][aria-label="Worktree"]');
    await toggle.waitForDisplayed({ timeout: 10000 });
    if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
    await destination.click();
    const beforeRequests = await getUpstreamRequestRecordCount();
    const submitted = "E2E_WORKTREE_DETACHED_SUBMISSION: Reply with exactly upstream-e2e-ok";
    await sendV4Prompt(submitted);
    await $('[data-worktree-setup-step="creating"]').waitForDisplayed({ timeout: 15000 });
    const preparedId = (await getV4PaneSnapshot()).sessionId!;
    expect(preparedId).not.toBe("draft");
    await startNewV4Draft();
    const next = "E2E_WORKTREE_NAVIGATION_DRAFT_B";
    await setV4ComposerText(next);
    await selectV4TaskById(preparedId);
    await $('[data-worktree-setup-step="ready"]').waitForDisplayed({ timeout: 30000 });
    const recovery = await $('[data-testid="composer-worktree-recovery"]');
    await recovery.waitForDisplayed({ timeout: 15000 });
    expect(await recovery.getText()).toContain(submitted);
    expect((await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null)).text).toBe(next);
    expect((await getV4Messages("user")).some((message) => message.text.includes(submitted))).toBe(
      false,
    );
    expect(await getUpstreamRequestRecordCount()).toBe(beforeRequests);
    await waitForV4ComposerText("", "Recovery must not merge into the visible editor");
    await recovery.$("button=Restore").click();
    await waitForV4ComposerText(
      submitted,
      "Explicit recovery did not restore the original message",
    );
    await sendV4Prompt(submitted);
    await waitForV4UserMessageContaining(submitted);
    await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
    expect((await getV4PaneSnapshot()).sessionId).toBe(preparedId);
    expect((await getV4ComposerDraftScopeSnapshot(DEFAULT_WORKSPACE, null)).text).toBe(next);
  });

  it("a new worktree chat stays independent of an earlier preparation", async function () {
    this.timeout(180000);
    const enableWorktree = async () => {
      const destination = await $('button[aria-label="Choose where this task runs"]');
      await destination.waitForClickable({ timeout: 15000 });
      await destination.click();
      const toggle = await $('button[role="switch"][aria-label="Worktree"]');
      await toggle.waitForDisplayed({ timeout: 10000 });
      if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
      await destination.click();
    };
    await startNewV4Draft();
    await enableWorktree();
    const first = "E2E_WORKTREE_NEW_CHAT_A preserve this pending input";
    await sendV4Prompt(first);
    await $('[data-worktree-setup-step="creating"]').waitForDisplayed({ timeout: 15000 });
    const firstSessionId = (await getV4PaneSnapshot()).sessionId!;
    expect(firstSessionId).not.toBe("draft");

    await startNewV4Draft();
    await enableWorktree();
    const second = "E2E_WORKTREE_NEW_CHAT_B create an independent session";
    await sendV4Prompt(second);
    await $('[data-worktree-setup-step="creating"]').waitForDisplayed({ timeout: 15000 });
    const secondSessionId = (await getV4PaneSnapshot()).sessionId!;
    expect(secondSessionId).not.toBe("draft");
    expect(secondSessionId).not.toBe(firstSessionId);
    await waitForV4UserMessageContaining(second);
    await waitForV4AssistantMessageContaining("WORKTREE_NEW_CHAT_B_OK");

    await selectV4TaskById(firstSessionId);
    const recovery = await $('[data-testid="composer-worktree-recovery"]');
    await recovery.waitForDisplayed({ timeout: 15000 });
    await $('[data-worktree-setup-step="ready"]').waitForDisplayed({ timeout: 30000 });
    expect(await recovery.getText()).toContain(first);
    expect(await recovery.getText()).not.toContain(second);
    expect((await getV4Messages("user")).some((message) => message.text.includes(second))).toBe(
      false,
    );
  });

  it("opens sessions from Settings and ignores Pinned in Archived without losing the preference", async function () {
    this.timeout(90000);
    const currentId = (await getV4PaneSnapshot()).sessionId;
    const openManager = async () => {
      await $('[data-testid="task-settings-button"]').click();
      await $('[data-testid="settings-page"]').waitForDisplayed({ timeout: 10000 });
      await $('button[aria-label="Manage sessions"]').click();
      await $('[role="grid"][aria-label="Sessions"]').waitForDisplayed({ timeout: 15000 });
    };
    await openManager();
    const row = await $('[role="row"][tabindex="0"]');
    await row.waitForDisplayed({ timeout: 15000 });
    await row.$('button[aria-label="Session actions"]').click();
    await $('[role="menuitem"]=Archive').click();
    const pinned = await $("button=Pinned");
    await pinned.click();
    expect(await pinned.getAttribute("aria-pressed")).toBe("true");
    const setStatus = async (status: string) => {
      await $("button*=Status:").click();
      await $(`[role="menuitem"]=${status === "active" ? "Active" : "Archived"}`).click();
    };
    await setStatus("archived");
    await browser.waitUntil(async () => (await $$('[role="row"][tabindex="0"]').length) > 0, {
      timeout: 15000,
    });
    expect(await pinned.isEnabled()).toBe(false);
    expect(await pinned.getAttribute("aria-pressed")).toBe("false");
    await setStatus("active");
    expect(await pinned.isEnabled()).toBe(true);
    expect(await pinned.getAttribute("aria-pressed")).toBe("true");
    await pinned.click();
    await $('[data-testid="settings-back-button"]').click();
    await browser.waitUntil(async () => !(await $('[data-testid="settings-page"]').isDisplayed()), {
      timeout: 10000,
    });
    expect((await getV4PaneSnapshot()).sessionId).toBe(currentId);
    await openManager();
    const remaining = await $('[role="row"][tabindex="0"]');
    await remaining.waitForDisplayed({ timeout: 15000 });
    await remaining.click();
    await browser.waitUntil(async () => !(await $('[data-testid="settings-page"]').isDisplayed()), {
      timeout: 10000,
    });
    expect((await getV4PaneSnapshot()).sessionId).toBeTruthy();
  });
});
