import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_TOOL_SEARCH_OPTION,
  TID_SETTINGS_TOOL_SEARCH_SELECT,
  TID_TASK_SETTINGS_BUTTON,
  TID_TOOL_SUMMARY_TRIGGER,
  testId,
} from "@zcode/shared/test-ids";
import { releaseControlledReplay } from "#e2e/helpers/controlled-replay";
import { seedCustomAnthropicMessagesProvider } from "#e2e/helpers/custom-openai-provider";
import { restartIntoWorkspace } from "#e2e/helpers/model-provider-restart";
import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  readSettings,
  waitForWorkspaceApp,
} from "#e2e/helpers/desktop-app";
import {
  getLatestUpstreamToolResultByToolCallId,
  getUpstreamRequestToolNames,
} from "#e2e/helpers/conversation-session-network";
import { waitForToolCallBlockByToolCallId } from "#e2e/helpers/conversation-session-tool";
import { startConversationModelProviderReplayServer } from "#e2e/helpers/model-provider-replay";
import {
  selectUpstreamProviderModelById,
  waitForUpstreamModelSelected,
} from "#e2e/helpers/upstream-provider";
import {
  clickV4Stop,
  getV4TimelineScrollState,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "#e2e/helpers/v4-conversation";

const CASE_NAME = "conversation-session-tool-discovery-card";
const MODEL_ID = "e2e-tool-discovery-card-model";
let replay: Awaited<ReturnType<typeof startConversationModelProviderReplayServer>>;

describe("LocalToolSearch 与 ToolSearch 共用不可展开卡片", () => {
  before(async function () {
    this.timeout(240_000);
    replay = await startConversationModelProviderReplayServer(CASE_NAME);
    // The workspace helper exits new-profile onboarding via Escape, avoiding the old skip-button path that waited on a hidden element.
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    const providerId = "e2e-tool-discovery-card-provider";
    const providerName = "Tool discovery card E2E";
    await restartIntoWorkspace({
      afterElectronProcessExit: async () => {
        await seedCustomAnthropicMessagesProvider({
          baseURL: replay.baseUrl,
          modelId: MODEL_ID,
          providerId,
          providerName,
        });
      },
    });
    await prepareV4ConversationE2E({ skipProvider: true });
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
    const select = await browser.$(`[data-testid="${TID_SETTINGS_TOOL_SEARCH_SELECT}"]`);
    await select.scrollIntoView();
    await select.click();
    await clickTestIdByDom(testId(TID_SETTINGS_TOOL_SEARCH_OPTION, "local"));
    await browser.waitUntil(async () => (await readSettings()).toolSearchMode === "local", {
      timeout: 15_000,
      timeoutMsg: "Local mode was not saved",
    });
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await prepareV4ConversationE2E({ skipProvider: true, skipShellReady: true });
    // A new draft has its own model preference; select the model on the final draft so later initialization does not re-adopt the default model.
    await selectUpstreamProviderModelById(MODEL_ID, {
      includePlainModelFallback: false,
      providerId,
      providerName,
    });
    await waitForUpstreamModelSelected(MODEL_ID, {
      includePlainModelFallback: false,
      providerId,
    });
  });

  after(async () => {
    await replay?.stop();
  });

  it("TS14-SUMMARY: empty input, single select, multi select, keyword, no match and failure show only the summary", async function () {
    this.timeout(180_000);
    await sendV4Prompt(
      "E2E_TOOL_DISCOVERY_CARD_SUMMARY searches tools and checks the card without running the target tool.",
    );
    // The fixture commits the body text first, getting past the original retryable preamble buffer; then observe the real tool placeholder and release the arguments.
    try {
      await expectCard("card_single", /^Search tools$/u, "pending");
    } finally {
      await releaseControlledReplay("tool-discovery-card-summary");
    }
    await waitForV4AssistantMessageContaining("E2E_TOOL_DISCOVERY_CARD_DONE");
    await waitForV4Pane((pane) => !pane.canStop, "search turn did not finish", 30_000);
    const toolNames = await getUpstreamRequestToolNames({
      includes: ["E2E_TOOL_DISCOVERY_CARD_SUMMARY"],
      excludes: ["Generate a concise title", "CRITICAL: Respond with TEXT ONLY"],
    });
    expect(toolNames).toContain("LocalToolSearch");
    expect(toolNames).not.toContain("ToolSearch");

    for (const [id, query] of [
      ["card_single", "TodoWrite"],
      ["card_multi", "Read, TodoWrite, WebFetch"],
      ["card_keyword", "checklist"],
      ["card_none", "zztoolcardnomatch987654321"],
      ["card_invalid", "TodoWrite"],
    ] as const) {
      await expectCard(
        id,
        new RegExp(`(?:Search tools: )${query}`),
        id === "card_invalid" ? "failed" : "completed",
      );
      const result = await getLatestUpstreamToolResultByToolCallId(id);
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(id === "card_invalid");
      if (id === "card_invalid") expect(result!.content).toContain("max_results");
      else if (id === "card_none")
        expect(result!.content).toContain(
          "No matching deferred tools found. Loaded tools are not searchable here and need no loading. Check your loaded tool list and query; try corrected spelling, alternative names, or broader keywords before concluding a tool is missing.",
        );
      else expect(result!.content).toContain("<functions>");
    }

    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const theme of ["zai-light", "zai-dark"] as const) {
        await setPresentation(locale, theme);
        // The summary prefix is locale-specific; the zh-CN loop must match the zh-CN label.
        const label = locale === "zh-CN" ? "搜索工具：" : "Search tools: ";
        await expectCard(
          "card_multi",
          new RegExp(`${label}Read, TodoWrite, WebFetch`),
          "completed",
        );
        await expectCard("card_invalid", new RegExp(`${label}TodoWrite`), "failed");
      }
    }
  });

  it("TS14-STOP: stop while arguments stream; the card shows no partial JSON or result", async function () {
    this.timeout(90_000);
    await sendV4Prompt(
      "E2E_TOOL_DISCOVERY_CARD_STOP searches tools and stops before the arguments finish.",
    );
    await expectCard("card_stopped", /Search tools/u, "pending");
    await clickV4Stop();
    await waitForV4Pane((pane) => !pane.canStop, "session still running after stop", 30_000);
    await expectCard("card_stopped", /Search tools/u, "stopped");
    expect(await getLatestUpstreamToolResultByToolCallId("card_stopped")).toBeNull();
    // A user stop closes the HTTP connection and cancels the test gate, so the cancelled stream does not need to be released.
  });

  it("TS14-DEFERRED：隐藏包装参数预览和待办，保留包装错误", async function () {
    this.timeout(90_000);
    expect((await readSettings()).messageStreamShowTodos ?? false).toBe(false);
    const before = await getV4TimelineScrollState();
    await sendV4Prompt("E2E_TOOL_DISCOVERY_CARD_DEFERRED 更新待办并检查包装错误。");
    try {
      await browser.waitUntil(
        async () => {
          const response = await fetch(`${replay.baseUrl}/__e2e__/gates`);
          return ((await response.json()) as string[]).includes("tool-discovery-card-deferred");
        },
        { timeout: 15_000, timeoutMsg: "包装调用未进入受控参数流" },
      );
      await waitForV4AssistantMessageContaining("Preparing a deferred todo.");
      // Wait until the raw projection includes this turn's header, user message, body and wrapper row, so the non-existence assertion does not run before the events arrive.
      await browser.waitUntil(
        async () => (await getV4TimelineScrollState()).totalRowCount >= before.totalRowCount + 4,
        { timeout: 15_000, timeoutMsg: "包装行尚未到达 UI 投影" },
      );
      expect(await browser.$('[data-tool-call-id="card_deferred_todo"]').isExisting()).toBe(false);
      await waitForV4Pane((pane) => pane.canStop, "隐藏卡片后丢失 Stop 入口", 10_000);
    } finally {
      await releaseControlledReplay("tool-discovery-card-deferred");
    }
    await waitForV4AssistantMessageContaining("E2E_TOOL_DISCOVERY_CARD_DEFERRED_DONE");
    await waitForV4Pane((pane) => !pane.canStop, "包装调用轮次未结束", 30_000);
    const result = await getLatestUpstreamToolResultByToolCallId("card_deferred_todo");
    expect(result?.isError).toBe(false);
    expect(JSON.parse(result!.content)).toMatchObject({
      todos: [{ content: "Deferred visibility verified", status: "completed" }],
    });
    expect(await browser.$('[data-tool-call-id="card_deferred_todo"]').isExisting()).toBe(false);
    const failed = await waitForToolCallBlockByToolCallId("card_deferred_invalid");
    expect(failed.toolName).toBe("DeferredToolCall");
    expect(failed.status).toBe("failed");
  });
});

async function expectCard(callId: string, label: RegExp, status: string) {
  const snapshot = await waitForToolCallBlockByToolCallId(callId, 30_000);
  const block = await browser.$(`[data-testid="${snapshot.testId}"]`);
  await browser.waitUntil(async () => (await block.getAttribute("data-status")) === status, {
    timeout: 15_000,
    timeoutMsg: `${callId} did not change to ${status}`,
  });
  if (status === "pending" || status === "stopped") {
    expect(await block.getAttribute("data-tool-name")).toBe("LocalToolSearch");
  }
  const summary = await block.$(`[data-testid="${testId(TID_TOOL_SUMMARY_TRIGGER, callId)}"]`);
  await expect(summary).toHaveText(label);
  expect(await summary.getAttribute("title")).toBe("ToolSearch");
  expect(await summary.getAttribute("role")).not.toBe("button");
  expect(await summary.getAttribute("aria-expanded")).toBeNull();
  await summary.scrollIntoView();
  await summary.click();
  expect(await summary.getAttribute("aria-expanded")).toBeNull();
  expect(await block.$("pre").isExisting()).toBe(false);
  expect(await block.getText()).not.toMatch(
    /select:|max_results|<functions>|inputSchema|Tool loaded\./u,
  );
}

async function setPresentation(locale: "en-US" | "zh-CN", theme: "zai-light" | "zai-dark") {
  const changed = await browser.execute(
    (nextLocale, nextTheme) => {
      const actions = (window as typeof window & { __testActions?: Record<string, unknown> })
        .__testActions;
      if (typeof actions?.setLocale !== "function" || typeof actions.setTheme !== "function")
        return false;
      (actions.setLocale as (value: string) => void)(nextLocale);
      (actions.setTheme as (value: string) => void)(nextTheme);
      return true;
    },
    locale,
    theme,
  );
  expect(changed).toBe(true);
  await browser.waitUntil(
    async () =>
      (await browser.$("html").getAttribute("class"))?.split(" ").includes(`theme-${theme}`),
    {
      timeout: 10_000,
      timeoutMsg: "theme not updated",
    },
  );
}
