// M4 gate: forkAssistant (catalog group E).
// Evidence layer L3: clicking Fork on a completed assistant row in the parent session → the forkAssistant command →
// the v4-bridge pins targetRowId to a logical turn boundary via resolveStableForkTarget →
// forkStableConversation → ACK.result.sessionId → the pane switches in place to the child session (a new
// sessionId whose history contains the parent's content). Proves stable boundary resolution and conversation-only fork are wired end to end.
import {
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER,
} from "@zcode/shared";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForWorkspaceApp,
} from "../helpers/desktop-app.js";
import {
  selectUpstreamProviderModelById,
  selectUpstreamThoughtLevelValue,
  waitForUpstreamModelSelected,
} from "../helpers/upstream-provider.js";
import { restartWithSeededOpenAIProviders } from "../helpers/custom-openai-provider.js";
import {
  assertUpstreamRequestCapture,
  waitForUpstreamNetworkCapture,
} from "../helpers/upstream-capture.js";
import {
  clickFirstV4Fork,
  getV4ModelConfig,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4ComposerSelectionReady,
  waitForV4Fork,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("v4 M4 门禁：forkAssistant", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("完成态 assistant 行 fork → 切到 child session，历史含父内容", async () => {
    // This case creates a case-local GLM-5.2 provider, both preserving the real three-level capability catalog
    // and making model requests strictly hit this case's replay fixture.
    await prepareGlm52Draft();

    await sendV4Prompt("E2E_V4_FORK_PARENT 说一句话");
    await waitForV4TimelineContaining("V4_FORK_PARENT_REPLY", 60000);

    const parent = await waitForV4Pane(
      (s) => s.sessionId !== "draft" && s.sessionId !== null,
      "父会话没有绑定 sessionId",
    );
    const parentSessionId = parent.sessionId;
    const parentModelConfig = await getV4ModelConfig();
    expect(parentModelConfig.model).toBe("GLM-5.2");
    expect(parentModelConfig.provider).toBeTruthy();

    // E11/FX11: the parent session's runtime model is GLM-5.2 and the case-local provider's capabilities are the
    // non-generic three levels. Pin the parent-side baseline first to avoid a false green when the child equals the same wrong fallback.
    const parentThoughtLevels = await readThoughtLevelValues();
    expect(parentThoughtLevels).toHaveLength(3);
    expect(parentThoughtLevels).toEqual(expect.arrayContaining(["high", "max"]));

    // The completedSuccess final assistant row shows Fork; entry is decided entirely by the row.actions.canFork
    // and availability.fork projections, no longer by the UI guessing the phase.
    await waitForV4Fork();
    const clicked = await clickFirstV4Fork();
    expect(clicked).toBe(true);

    // Fork succeeds → forkAssistant ACK accepted, and the pane switches in place to the child (sessionId changes).
    // Proves: stable target resolution + conversation-only fork + child sessionId backfill + selection switch.
    const child = await waitForV4Pane(
      (s) => s.sessionId !== null && s.sessionId !== "draft" && s.sessionId !== parentSessionId,
      "fork 后 pane 没有切到 child session",
      60000,
    );
    expect(child.sessionId).not.toBe(parentSessionId);

    // The fork child must hydrate the selected model from its authoritative session config, even when there is no legacy task config cache.
    await waitForV4ComposerSelectionReady();
    const childModelConfig = await getV4ModelConfig();
    expect(childModelConfig.provider).toBe(parentModelConfig.provider);
    expect(childModelConfig.model).toBe(parentModelConfig.model);
    // Compare the runtime-owned model options instead of hard-coding a spelling for the no-thinking alias.
    expect(await readThoughtLevelValues()).toEqual(parentThoughtLevels);
    await browser.waitUntil(async () => (await getV4ModelConfig()).thought === "high", {
      timeout: 30000,
      timeoutMsg: "fork child 没有恢复父会话的 high 思考等级",
    });

    const childPrompt = "E2E_V4_FORK_CHILD 继续回答";
    await sendV4Prompt(childPrompt);
    const childRequest = await waitForUpstreamNetworkCapture("E2E_V4_FORK_CHILD");
    assertUpstreamRequestCapture(childRequest, {
      expectedText: childPrompt,
      model: "GLM-5.2",
    });
    // The provider maps the selected level to reasoning_effort and also keeps its explicit thinking toggle.
    const childRequestJson = childRequest.requestJson as Record<string, unknown>;
    expect(childRequestJson.reasoning_effort).toBe("high");
    expect(childRequestJson.thinking).toEqual({ type: "enabled" });
    // Fix rationale: the fork notice originally had no Attachment metadata, so the real request treated it as unlabeled user text.
    const boundaryText = "This session was forked from a previous session message.";
    const messages = childRequestJson.messages as Array<{ role: string; content: string }>;
    const boundaryIndex = messages.findIndex((message) => message.content.includes(boundaryText));
    const questionIndex = messages.findIndex((message) => message.content.includes(childPrompt));
    expect(boundaryIndex).toBeGreaterThanOrEqual(0);
    expect(boundaryIndex).toBeLessThan(questionIndex);
    const boundary = messages[boundaryIndex]!;
    expect(boundary.role).toBe("user");
    expect(boundary.content).toMatch(/^<system-reminder>\n/);
    expect(boundary.content).toMatch(/\n<\/system-reminder>$/);
    expect(boundary.content.match(/<system-reminder>/g)).toHaveLength(1);
    expect(JSON.stringify(messages).split(boundaryText)).toHaveLength(2);
    await waitForV4TimelineContaining("V4_FORK_CHILD_REPLY", 30000);

    // The child history inherits the parent's content: fork copies messages but not events; cold-subscription
    // hydration detects that the event log cannot cover the transcript and rebuilds the projection by synthesizing
    // transcript→events (transcript-hydration). This assertion verifies the full chain of fork-copy-to-target + transcript synthetic hydration.
    await waitForV4TimelineContaining("V4_FORK_PARENT_REPLY", 30000);
    const finalSnapshot = await getV4PaneSnapshot();
    expect(finalSnapshot.timelineText).toContain("E2E_V4_FORK_PARENT");
    expect(finalSnapshot.timelineText).not.toContain(boundaryText);
    expect(finalSnapshot.timelineText).not.toContain("<system-reminder>");
  });
});

async function prepareGlm52Draft(): Promise<void> {
  const modelId = "GLM-5.2";
  const providerId = "e2e-v4-fork-glm52-provider";
  const providerName = `V4 Fork GLM 5.2 E2E ${Date.now()}`;
  await prepareV4ConversationE2E({ skipProvider: true });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  // Fix rationale: saving the settings page and refreshing the active workspace registry are not the same barrier;
  // sending immediately after would still land the real request on the old provider. Exit the process, atomically seed App+CLI, then restart.
  const [provider] = await restartWithSeededOpenAIProviders([
    { modelId, providerId, providerName },
  ]);
  if (!provider) throw new Error("V4 fork GLM-5.2 replay provider seed 失败");
  await prepareV4ConversationE2E({ skipProvider: true });
  await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30000);
  await selectUpstreamProviderModelById(modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
    providerName,
  });
  await waitForUpstreamModelSelected(modelId, {
    includePlainModelFallback: false,
    providerId: provider.id,
  });
  await selectUpstreamThoughtLevelValue("high");
}

async function readThoughtLevelValues(): Promise<string[]> {
  await clickTestIdByDom(TID_CHAT_THOUGHT_LEVEL_SELECT_TRIGGER, {
    timeout: 30000,
    timeoutMsg: "思考深度选择器没有出现",
  });
  const itemPrefix = `${TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM}-`;
  await browser.waitUntil(
    () =>
      browser.execute(
        (prefix) => document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`).length > 0,
        itemPrefix,
      ),
    {
      timeout: 10000,
      timeoutMsg: "思考深度菜单没有渲染选项",
    },
  );
  const values = await browser.execute((prefix) => {
    return Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`))
      .map((element) => (element.dataset.testid ?? "").slice(prefix.length))
      .filter(Boolean)
      .sort();
  }, itemPrefix);
  await browser.keys(["Escape"]);
  return values;
}
