import { TID_V4_SUBAGENT_OPEN_SIDE_PANE } from "@zcode/shared";
import { clearAppData } from "../helpers/desktop-app.js";
import { waitForUpstreamRequest } from "../helpers/conversation-session-network.js";
import {
  expandAssistantHistoriesWithContent,
  waitForToolCallBlockByToolCallId,
} from "../helpers/conversation-session-tool.js";
import { getToolCallDiagnostics } from "../helpers/conversation-session-tool-diagnostics.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  startNewV4Draft,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";
import {
  beginConversationTelemetryCapture,
  readConversationReportRequests,
  waitForConversationReportInventory,
} from "../helpers/conversation-telemetry-parity-capture.js";

const BG26_TIMEOUT_MS = 240000;
const PARENT_MARKER = "E2E_BACKGROUND_SUBAGENT_RATE_LIMIT_PARENT";
const PARENT_DONE = "E2E_BACKGROUND_SUBAGENT_RATE_LIMIT_PARENT_DONE";
const CHILD_MARKER = "E2E_BACKGROUND_SUBAGENT_RATE_LIMIT_CHILD";
const TOOL_CALL_ID = "toolu_e2e_background_subagent_rate_limit_agent";
const PROVIDER_ERROR =
  "Requests are too frequent. Please reduce your request frequency, wait a short moment, and retry your request. Request id: e2e-background-subagent-rate-limit";

describe("会话区 background subagent 429 错误展示 E2E", () => {
  before(async function () {
    this.timeout(BG26_TIMEOUT_MS);
    await prepareV4ConversationE2E();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("BG26: 429 原始错误进入 subagent result、失败 hover 和 restore snapshot", async function () {
    this.timeout(BG26_TIMEOUT_MS);

    const telemetryCapture = await beginConversationTelemetryCapture();
    const prompt = `${PARENT_MARKER}: launch one background Agent and finish after its failed task notification with ${PARENT_DONE}.`;
    // Bug cause: v4 has removed chat-input/chat-view, so the old formal case waited in the before hook for the legacy
    // composer and the real scenario never executed. Sending, timeline, and session switching all go through the v4
    // contract.
    await sendV4Prompt(prompt);
    await waitForV4TimelineContaining(PARENT_MARKER, 60000);
    await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 60000);

    // Bug root cause: the old assertion waited directly on the parent notification; on failure there was no way to
    // tell whether the child's physical request reached the replay server. Establish the child request barrier first,
    // so shard logs clearly separate a network send stall from a 429 terminal/notification projection stall.
    await waitForUpstreamRequest(
      { lastUserMessageIncludes: [CHILD_MARKER] },
      "background subagent child 请求没有到达 replay server",
      60000,
    );
    await waitForUpstreamRequest(
      {
        includes: [
          `<tool-use-id>${TOOL_CALL_ID}</tool-use-id>`,
          "<status>failed</status>",
          `<error>${PROVIDER_ERROR}</error>`,
          `failed. ${PROVIDER_ERROR}`,
        ],
      },
      "background subagent failed notification 没有透传 provider 原始错误",
      90000,
    );
    await waitForV4TimelineContaining(PARENT_DONE, 90000);
    await waitForConversationReportInventory(telemetryCapture, {
      message_completion: 2,
    });
    const reports = await readConversationReportRequests(telemetryCapture);
    // Early staging assertions had no background step; the later first-terminal-state settlement already requires a
    // zero-usage Agent summary to be reported even on failure.
    // A 429 response carries no usage, so a failed call must not be counted as confirmed billable usage.
    expect(
      reports.filter(
        (report) =>
          report.element_name === "agent_step" &&
          (report.event_extra_detail as Record<string, unknown> | undefined)?.agent_role ===
            "background subagent",
      ),
    ).toEqual([
      expect.objectContaining({
        event_extra_detail: expect.objectContaining({
          agent_role: "background subagent",
          tool_name: "Agent",
          status: "fail",
          error_msg: expect.stringContaining(PROVIDER_ERROR),
          model_request_count: "0",
          token_usage_scope: "",
          total_tokens: "0",
        }),
      }),
    ]);
    expect(
      reports.filter(
        (report) =>
          report.element_name === "message_completion" &&
          ["child_session_id", "parent_tool_call_id"].some((key) =>
            Object.hasOwn(
              (report.event_extra_detail as Record<string, unknown> | undefined) ?? {},
              key,
            ),
          ),
      ),
    ).toHaveLength(0);
    const idleSnapshot = await waitForV4Pane(
      (snapshot) =>
        snapshot.sessionId !== null && snapshot.sessionId !== "draft" && !snapshot.canStop,
      "background subagent 429 notification 后父会话没有回到 idle",
      60000,
    );
    if (!idleSnapshot.sessionId || idleSnapshot.sessionId === "draft") {
      throw new Error(`background subagent 429 case 缺少 taskId: ${JSON.stringify(idleSnapshot)}`);
    }

    const sourceTaskId = idleSnapshot.sessionId;
    await assertFailedAgentSurface("live");

    await startNewV4Draft();
    await selectV4TaskById(sourceTaskId);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sourceTaskId && !snapshot.canStop,
      "background subagent 429 case 切回后没有完成原 task snapshot restore",
      30000,
    );
    await waitForV4TimelineContaining(PARENT_DONE, 60000);

    await assertFailedAgentSurface("restored");
  });
});

async function assertFailedAgentSurface(stage: "live" | "restored") {
  // Bug cause: the child 429 and the parent failed notification persisted successfully, but the v4 Agent card
  // projection still kept completed. Constrain the user-visible state directly here, instead of continuing to rely on
  // the deleted legacy renderer store projection and masking a real product regression.
  let latestDiagnostics: Awaited<ReturnType<typeof getToolCallDiagnostics>> | null = null;
  try {
    await browser.waitUntil(
      async () => {
        // Bug root cause: a restored completed turn is collapsed by default and the failed Agent row is not mounted
        // yet; the old assertion checked the block before expanding history, misreporting the already-persisted 429
        // state as lost on restore.
        await expandAssistantHistoriesWithContent();
        latestDiagnostics = await getToolCallDiagnostics({
          type: "toolCallId",
          value: TOOL_CALL_ID,
        });
        return latestDiagnostics.matchedBlock?.status === "failed";
      },
      {
        timeout: 30000,
        timeoutMsg: `${stage} Agent 卡没有进入 failed`,
      },
    );
  } catch (error) {
    throw new Error(
      `${stage} Agent 卡没有进入 failed; latest=${JSON.stringify(latestDiagnostics)}`,
      { cause: error },
    );
  }

  const blockSnapshot = await waitForToolCallBlockByToolCallId(TOOL_CALL_ID, 30000);
  // Bug root cause: the Agent card product contract has become "a one-line summary in the parent conversation + a
  // child session on the right", with canToggle=false, so the expandable tool-summary-trigger is no longer rendered.
  // The old E2E expanding it is a guaranteed false failure; the raw 429 error is constrained by two layers of
  // evidence: the provider request and the failed-status tooltip.
  const sidePaneAction = await $(`[data-testid="${blockSnapshot.testId}"]`).$(
    `[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`,
  );
  await sidePaneAction.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: `${stage} Agent 卡没有右侧 child session 入口`,
  });
  // The tooltip trigger may render only an icon with no readable text; judge the visible copy by the whole Agent card.
  expect(["执行失败", "Failed"].some((label) => blockSnapshot.text.includes(label))).toBe(true);
  const block = await $(`[data-testid="${blockSnapshot.testId}"]`);
  const failedStatus = await block.$('[data-slot="tooltip-trigger"]');
  await failedStatus.waitForDisplayed({
    timeout: 10000,
    timeoutMsg: `${stage} Agent 卡没有失败 tooltip trigger`,
  });
  // The E2E system language follows the runner; both supported languages must keep the existing failure copy and the
  // same hover interaction.
  await hoverFailedAgentStatus(blockSnapshot.testId, stage);
  await $('[data-testid^="v4-session-pane-"]').moveTo({
    xOffset: 20,
    yOffset: 20,
  });

  const current = await getV4PaneSnapshot();
  expect(current.canStop).toBe(false);
}

async function hoverFailedAgentStatus(
  blockTestId: string,
  stage: "live" | "restored",
  attempt = 1,
): Promise<void> {
  // Bug root cause: card expansion and streaming close-out can remount the Radix trigger; in a long batch a single
  // moveTo may land on a stale node, or the pointer may sit at the same coordinates without a fresh pointerenter.
  // Each attempt re-fetches the trigger from the current DOM, moves off the card first, then does a real hover, and
  // only accepts a currently visible tooltip.
  const pane = await $('[data-testid^="v4-session-pane-"]');
  await pane.moveTo({ xOffset: 20, yOffset: 20 });
  const currentBlock = await $(`[data-testid="${blockTestId}"]`);
  const currentTrigger = await currentBlock.$('[data-slot="tooltip-trigger"]');
  await currentTrigger.waitForDisplayed({ timeout: 3000 });
  await currentTrigger.moveTo();

  let latestTooltipText: string | null = null;
  const opened = await browser
    .waitUntil(
      async () => {
        latestTooltipText = await browser.execute(() => {
          const visibleTooltip = Array.from(
            document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]'),
          ).find((element) => {
            const style = window.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number(style.opacity || "1") > 0 &&
              element.getClientRects().length > 0
            );
          });
          return visibleTooltip?.innerText ?? null;
        });
        // Radix maintains both the displayed content and an accessibility mirror, and innerText can return two copies
        // of the same text under some Chromium timings; the product constraint is that the visible tooltip fully
        // contains the original error.
        return normalizeText(latestTooltipText ?? "").includes(normalizeText(PROVIDER_ERROR));
      },
      {
        interval: 100,
        timeout: 3000,
        timeoutMsg: `${stage} 执行失败 hover 没有显示匹配的可见 tooltip`,
      },
    )
    .then(() => true)
    .catch(() => false);
  if (opened) {
    return;
  }
  if (attempt >= 3) {
    throw new Error(
      `${stage} 执行失败 hover 没有显示可见 tooltip; latest=${JSON.stringify(latestTooltipText)}`,
    );
  }
  await hoverFailedAgentStatus(blockTestId, stage, attempt + 1);
}

function normalizeText(value: string) {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
