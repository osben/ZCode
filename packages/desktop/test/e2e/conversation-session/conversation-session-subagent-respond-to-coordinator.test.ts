import { registerIncomingMessageActiveCases } from "../helpers/incoming-message-active-cases.js";
import {
  INCOMING_MESSAGE_MODES,
  prepareIncomingMessageCapability,
} from "../helpers/incoming-message-capability.js";
import { assertIncomingMessage } from "../helpers/incoming-message-evidence.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_TOOL_SUMMARY_TRIGGER, TID_V4_SUBAGENT_OPEN_SIDE_PANE } from "@zcode/shared/test-ids";
import { clearAppData } from "../helpers/desktop-app.js";
import type { E2ENetworkCaptureArtifact } from "../helpers/network-capture-proxy.js";
import {
  findFirstUpstreamRequestIndex,
  getUpstreamRequestEvidence,
  getUpstreamRequestRecordCount,
  waitForUpstreamRequest,
} from "../helpers/conversation-session-network.js";
import { resolveE2ERuntimePath } from "../helpers/e2e-runtime-paths.js";
import {
  getToolCallBlockByToolCallId,
  waitForToolCallBlockByToolCallId,
} from "../helpers/conversation-session-tool.js";
import {
  clickV4Stop,
  getV4PaneSnapshot,
  getV4ConfigProjection,
  prepareV4ConversationE2E,
  sendV4Prompt,
  startNewV4Draft,
  switchV4Mode,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

const E2E_TIMEOUT_MS = 240_000;
const E2E_ROOT = resolveE2ERuntimePath("conversation-session-subagent-respond-to-coordinator");
const RELEASE_FILE = join(E2E_ROOT, "release-child-bash");
const FINAL_RELEASE_FILE = join(E2E_ROOT, "release-child-final");
const ERROR_CHILD_RELEASE_FILE = join(E2E_ROOT, "release-error-child");
const CONTINUED_WORK_FILE = join(E2E_ROOT, "continued-work.txt");
const PARENT_AGENT_TOOL_CALL_ID = "toolu_e2e_subagent_response_agent";
const RESPOND_TO_COORDINATOR_TOOL_CALL_ID = "toolu_e2e_subagent_respond_to_coordinator";
const TASK_OUTPUT_TOOL_CALL_ID = "toolu_e2e_task_output_card";
const ERROR_AGENT_TOOL_CALL_ID = "toolu_e2e_error_agent";
const ERROR_RESPOND_TO_COORDINATOR_TOOL_CALL_ID = "toolu_e2e_error_respond_to_coordinator";
const ERROR_TASK_OUTPUT_TOOL_CALL_ID = "toolu_e2e_error_task_output";
const MISSING_TASK_ID = "task_e2e_missing";
// Bug cause: tool execution failures now uniformly use the generic lifecycle copy; the old assertions still expected
// TaskOutput / RespondToCoordinator's dedicated failure copy, so E2E falsely reported a failure while the product
// correctly displayed "execution failed". Both languages verify against the shared status copy.
const TOOL_EXECUTION_FAILURE_LABELS = ["执行失败", "Failed"] as const;

describe("会话区 BG25/O18/O19 coordinator 与 TaskOutput 专属卡片 E2E", () => {
  before(async function () {
    this.timeout(E2E_TIMEOUT_MS);
    await prepareV4ConversationE2E();
  });

  beforeEach(async function () {
    this.timeout(E2E_TIMEOUT_MS);
    await mkdir(E2E_ROOT, { recursive: true });
    await rm(RELEASE_FILE, { force: true });
    await rm(FINAL_RELEASE_FILE, { force: true });
    await rm(ERROR_CHILD_RELEASE_FILE, { force: true });
    await writeFile(CONTINUED_WORK_FILE, "E2E_SUBAGENT_CONTINUED_WORK\n", "utf-8");
    await startNewV4Draft();
    // Bug cause: the legacy helper iterates all workspaces, and as long as any old workspace is yolo it wrongly
    // judges the current v4 draft as switched; the session actually still starts in build and the child Bash waits for
    // permission forever. We must explicitly write draft mode through the current v4 composer before starting this
    // case's session.
    await selectCurrentV4FullAccessMode();
  });

  afterEach(async () => {
    await writeFile(RELEASE_FILE, "release\n", "utf-8").catch(() => undefined);
    await writeFile(FINAL_RELEASE_FILE, "release\n", "utf-8").catch(() => undefined);
    await writeFile(ERROR_CHILD_RELEASE_FILE, "release\n", "utf-8").catch(() => undefined);
    await stopIfBusy();
    await rm(E2E_ROOT, { recursive: true, force: true }).catch(() => undefined);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const { label, mcs } of INCOMING_MESSAGE_MODES) {
    it(`${label} 渲染 child coordinator 回复与 completed TaskOutput，同时保持父子可见性边界`, async function () {
      this.timeout(E2E_TIMEOUT_MS);

      await prepareIncomingMessageCapability(mcs);
      await selectCurrentV4FullAccessMode();
      const prompt =
        "E2E_SUBAGENT_RESPOND_TO_COORDINATOR: Launch a background agent, ask it E2E_SUBAGENT_COORDINATOR_QUESTION while it is running, consume its response, and wait for E2E_SUBAGENT_FINAL_RESULT.";
      const requestCountBefore = await getUpstreamRequestRecordCount();
      // Bug cause: v4 has removed the legacy chat-input/chat-view; the old BG25 ended in the before hook and the
      // RespondToCoordinator main path never actually ran. Here everything reads the v4 pane/timeline instead.
      await sendV4Prompt(prompt);
      await waitForV4TimelineContaining("E2E_SUBAGENT_RESPOND_TO_COORDINATOR", 60000);
      await waitForToolCallBlockByToolCallId(PARENT_AGENT_TOOL_CALL_ID, 60_000);

      const sendMessageResultIndex = await waitForFirstRequestIndex(
        {
          includes: [
            "E2E_SUBAGENT_RESPOND_TO_COORDINATOR",
            "E2E_SUBAGENT_COORDINATOR_QUESTION",
            "sent to its active turn",
          ],
        },
        requestCountBefore,
        "SendMessage delivery result 没有进入 parent provider request",
      );
      await waitForV4Pane(
        (snapshot) => !snapshot.canStop,
        "parent SendMessage ack 没有完成",
        30000,
      );
      await writeFile(RELEASE_FILE, "release\n", "utf-8");

      const childResponseToolsIndex = await waitForFirstRequestIndex(
        {
          includes: [
            "E2E_SUBAGENT_CHILD_BASH_RELEASED",
            "The coordinator sent a message while you were working:",
            "E2E_SUBAGENT_COORDINATOR_QUESTION",
            "E2E_SUBAGENT_COORDINATOR_QUESTION_PAYLOAD",
          ],
        },
        sendMessageResultIndex,
        "child 没有在 Bash tool result 后收到 coordinator question",
      );
      const childContinuedWorkIndex = await waitForFirstRequestIndex(
        {
          includes: [
            "E2E_SUBAGENT_RESPONSE_QUEUED",
            "was queued for the coordinator",
            "E2E_SUBAGENT_CONTINUED_WORK",
          ],
        },
        childResponseToolsIndex,
        "RespondToCoordinator 与 Read tool result 没有共同进入 child 后续 request",
      );

      const parentResponseIndex = await waitForFirstRequestIndex(
        {
          includes: [
            "<subagent-message>",
            "E2E_SUBAGENT_RESPONSE_QUEUED",
            "E2E_SUBAGENT_COORDINATOR_QUESTION_PAYLOAD",
          ],
        },
        sendMessageResultIndex,
        "parent provider request 没有消费 model-only subagent response",
      );
      await waitForV4TimelineContaining("E2E_SUBAGENT_COORDINATOR_CONSUMED", 90000);
      await waitForV4Pane(
        (snapshot) => !snapshot.canStop,
        "parent 消费 coordinator response 后没有回到 idle",
        90_000,
      );
      // Bug cause: the child used to finish after a fixed 1-second sleep; on slow machines the completion notification
      // merged into the parent response turn first, so strict replay could not verify the two provider requests
      // separately. The child's terminal state is only released once the parent has consumed the response and returned
      // to idle, fixing the product-required order.
      await writeFile(FINAL_RELEASE_FILE, "release\n", "utf-8");
      const childFinalIndex = await waitForFirstRequestIndex(
        { includes: ["E2E_SUBAGENT_CONTINUED_WORK_TOOL_DONE"] },
        childContinuedWorkIndex,
        "child 回复 coordinator 后没有继续执行普通工作 tool",
      );
      const notificationIndex = await waitForFirstRequestIndex(
        {
          includes: ["<task-notification>", "E2E_SUBAGENT_FINAL_RESULT"],
          lastUserMessageIncludes: ["<task-notification>"],
        },
        Math.min(parentResponseIndex, childFinalIndex),
        "child final completion notification 没有进入 parent provider request",
      );

      const childEvidence = await getUpstreamRequestEvidence(
        {
          includes: [
            "The coordinator sent a message while you were working:",
            "E2E_SUBAGENT_COORDINATOR_QUESTION_PAYLOAD",
          ],
        },
        { afterIndex: childResponseToolsIndex - 1, beforeIndex: childResponseToolsIndex + 1 },
      );
      await assertIncomingMessage(childEvidence[0]!.requestJson, {
        presentation: "coordinator_steer",
        marker: "E2E_SUBAGENT_COORDINATOR_QUESTION_PAYLOAD",
        role: mcs ? "system" : "user",
        evidenceLabel: label,
        body: "E2E_SUBAGENT_COORDINATOR_QUESTION\n\nE2E_SUBAGENT_COORDINATOR_QUESTION_PAYLOAD",
      });
      const peerEvidence = await getUpstreamRequestEvidence(
        { includes: ["<subagent-message>"] },
        { afterIndex: parentResponseIndex - 1, beforeIndex: parentResponseIndex + 1 },
      );
      await assertIncomingMessage(peerEvidence[0]!.requestJson, {
        presentation: "subagent_reply",
        evidenceLabel: label,
        marker: "E2E_SUBAGENT_RESPONSE_QUEUED",
        role: "user",
      });
      const notificationEvidence = await getUpstreamRequestEvidence(
        { includes: ["<task-notification>", "E2E_SUBAGENT_FINAL_RESULT"] },
        { afterIndex: notificationIndex - 1, beforeIndex: notificationIndex + 1 },
      );
      await assertIncomingMessage(notificationEvidence[0]!.requestJson, {
        presentation: "task_notification",
        evidenceLabel: label,
        marker: "E2E_SUBAGENT_FINAL_RESULT",
        role: "user",
      });

      const responsePosition = await getRequestMarkerPosition(
        parentResponseIndex,
        "<subagent-message>",
      );
      const notificationPosition = await getRequestMarkerPosition(
        notificationIndex,
        "<task-notification>",
      );
      expect(compareRequestPositions(responsePosition, notificationPosition)).toBeLessThan(0);

      // v4 P9 keeps only the Agent/subagent summary on the parent timeline; child tool rows belong to the child
      // conversation and are no longer nested into the parent Agent card. BG25's product semantics are the
      // bidirectional message chain and the child continuing to run, already covered by the earlier provider request
      // ordering; the old renderer-store mirror assertions should be removed.
      const timeline = await getV4PaneSnapshot();
      expect(timeline.timelineText).not.toContain("E2E_SUBAGENT_RESPONSE_QUEUED");
      expect(timeline.timelineText).not.toContain("<subagent-message>");
      expect(await getToolCallBlockByToolCallId(RESPOND_TO_COORDINATOR_TOOL_CALL_ID)).toBeNull();
      await waitForV4Pane(
        (snapshot) => !snapshot.canStop,
        "RespondToCoordinator completion 后 parent 会话没有回到 idle",
        90_000,
      );

      await assertTaskOutputCard();
      await assertRespondToCoordinatorCard();

      // Reason for the fix: BG25 does not cover compact; if the spec wrongly falls back to manual-review, the
      // small-window configuration would insert unrelated dividers.
      const compactMarkerCount = await browser.execute(
        () =>
          document.querySelectorAll('[data-row-kind="timelineMarker"][data-marker-type="compact"]')
            .length,
      );
      expect(compactMarkerCount).toBe(0);
    });
  }

  it("组合渲染 TaskOutput 未知 ID 与 child RespondToCoordinator 输入错误", async function () {
    this.timeout(E2E_TIMEOUT_MS);

    const requestCountBefore = await getUpstreamRequestRecordCount();
    await sendV4Prompt(
      "E2E_TOOL_RENDERER_ERROR_CARDS: Launch the controlled background child and wait for E2E_ERROR_AGENT_COMPLETED.",
    );
    await waitForV4TimelineContaining("E2E_TOOL_RENDERER_ERROR_CARDS", 60_000);
    await waitForToolCallBlockByToolCallId(ERROR_AGENT_TOOL_CALL_ID, 60_000);

    const agentLaunchResultIndex = await waitForFirstRequestIndex(
      {
        includes: [
          "E2E_TOOL_RENDERER_ERROR_CARDS",
          "E2E_RESPOND_ERROR_CHILD",
          "Async agent launched successfully",
        ],
      },
      requestCountBefore,
      "错误卡片 case 的 background Agent 启动结果没有进入 parent provider request",
    );
    await waitForV4TimelineContaining("E2E_ERROR_AGENT_STARTED", 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "错误卡片 case 的 Agent 启动 turn 没有回到 idle",
      60_000,
    );

    await writeFile(ERROR_CHILD_RELEASE_FILE, "release\n", "utf-8");
    const childValidationErrorIndex = await waitForFirstRequestIndex(
      {
        includes: [
          ERROR_RESPOND_TO_COORDINATOR_TOOL_CALL_ID,
          "InputValidationError: RespondToCoordinator failed due to the following issue:",
          "The required parameter `message` is missing",
        ],
        lastUserMessageIncludes: [
          "InputValidationError: RespondToCoordinator failed due to the following issue:",
        ],
      },
      agentLaunchResultIndex,
      "RespondToCoordinator 输入校验错误没有进入 child provider continuation",
    );
    await waitForFirstRequestIndex(
      {
        includes: ["<task-notification>", "E2E_RESPOND_ERROR_CHILD_DONE"],
        lastUserMessageIncludes: ["<task-notification>", "E2E_RESPOND_ERROR_CHILD_DONE"],
      },
      childValidationErrorIndex,
      "错误 child 的完成通知没有进入 parent provider request",
    );
    await waitForV4TimelineContaining("E2E_ERROR_AGENT_COMPLETED", 60_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "错误 child 完成后 parent 没有回到 idle",
      60_000,
    );

    expect(
      await getToolCallBlockByToolCallId(ERROR_RESPOND_TO_COORDINATOR_TOOL_CALL_ID),
    ).toBeNull();
    await assertTaskOutputErrorCard();
    await assertRespondToCoordinatorErrorCard();
  });
  registerIncomingMessageActiveCases();
});

async function assertTaskOutputCard(): Promise<void> {
  const requestCountBefore = await getUpstreamRequestRecordCount();
  await sendV4Prompt(
    "E2E_TASK_OUTPUT_TOOL_CARD: Call TaskOutput with block=false and timeout=0 for the completed background agent, then report E2E_TASK_OUTPUT_TOOL_CARD_DONE.",
  );

  await waitForFirstRequestIndex(
    {
      includes: [
        "toolu_e2e_task_output_card",
        "<retrieval_status>success</retrieval_status>",
        "<task_id>agent_",
        "<status>completed</status>",
        "E2E_SUBAGENT_FINAL_RESULT",
      ],
    },
    requestCountBefore,
    "TaskOutput completed result 没有进入 parent provider request",
  );
  await waitForV4TimelineContaining("E2E_TASK_OUTPUT_TOOL_CARD_DONE", 60_000);
  await waitForV4Pane(
    (snapshot) => !snapshot.canStop,
    "TaskOutput tool turn 没有回到 idle",
    60_000,
  );

  const collapsed = await waitForToolCallBlockByToolCallId(TASK_OUTPUT_TOOL_CALL_ID, 30_000);
  expect(collapsed.status).toBe("completed");
  expect(collapsed.text).toMatch(/agent_[A-Za-z0-9_-]+/u);
  expect(["已获取", "Output retrieved"].some((label) => collapsed.text.includes(label))).toBe(true);
  expect(collapsed.text).not.toContain("E2E_SUBAGENT_FINAL_RESULT");
  assertTaskOutputProviderFieldsHidden(collapsed.text);

  const collapsedState = await readToolCardState(collapsed.testId);
  expect(collapsedState.ariaExpanded).toBe("false");
  expect(collapsedState.hasCollapsibleContent).toBe(true);
  await browser.execute(
    (blockTestId, summaryTriggerPrefix) => {
      const block = document.querySelector<HTMLElement>(`[data-testid="${blockTestId}"]`);
      block?.querySelector<HTMLElement>(`[data-testid^="${summaryTriggerPrefix}-"]`)?.click();
    },
    collapsed.testId,
    TID_TOOL_SUMMARY_TRIGGER,
  );

  await browser.waitUntil(
    async () => {
      const state = await readToolCardState(collapsed.testId);
      return state.ariaExpanded === "true" && state.text.includes("E2E_SUBAGENT_FINAL_RESULT");
    },
    {
      timeout: 10_000,
      timeoutMsg: "TaskOutput 卡片展开后没有显示 task output",
    },
  );
  const expandedState = await readToolCardState(collapsed.testId);
  assertTaskOutputProviderFieldsHidden(expandedState.text);
}

async function assertRespondToCoordinatorCard(): Promise<void> {
  await openSubagentSidePane(PARENT_AGENT_TOOL_CALL_ID);
  const responseCard = await waitForToolCallBlockByToolCallId(
    RESPOND_TO_COORDINATOR_TOOL_CALL_ID,
    30_000,
  );
  expect(responseCard.status).toBe("completed");
  expect(responseCard.text).toContain("E2E_SUBAGENT_RESPONSE_QUEUED");
  expect(["回复已排队", "Reply queued"].some((label) => responseCard.text.includes(label))).toBe(
    true,
  );
  expect(responseCard.text).not.toContain("E2E_SUBAGENT_COORDINATOR_QUESTION_PAYLOAD");
  expect(responseCard.text).not.toContain("was queued for the coordinator");
  expect(responseCard.text).not.toMatch(/response_[A-Za-z0-9_-]+/u);

  const responseCardState = await readToolCardState(responseCard.testId);
  expect(responseCardState.ariaExpanded).toBeNull();
  expect(responseCardState.hasCollapsibleContent).toBe(false);
}

async function assertTaskOutputErrorCard(): Promise<void> {
  const requestCountBefore = await getUpstreamRequestRecordCount();
  await sendV4Prompt(
    `E2E_TASK_OUTPUT_ERROR_CARD: Call TaskOutput for ${MISSING_TASK_ID}, then report E2E_TASK_OUTPUT_ERROR_DONE.`,
  );
  await waitForFirstRequestIndex(
    {
      includes: [
        ERROR_TASK_OUTPUT_TOOL_CALL_ID,
        `<tool_use_error>No task found with ID: ${MISSING_TASK_ID}</tool_use_error>`,
      ],
      lastUserMessageIncludes: [`No task found with ID: ${MISSING_TASK_ID}`],
    },
    requestCountBefore,
    "TaskOutput 未知 ID 错误没有进入 parent provider continuation",
  );
  await waitForV4TimelineContaining("E2E_TASK_OUTPUT_ERROR_DONE", 60_000);
  await waitForV4Pane(
    (snapshot) => !snapshot.canStop,
    "TaskOutput 错误 turn 没有回到 idle",
    60_000,
  );

  const card = await waitForToolCallBlockByToolCallId(ERROR_TASK_OUTPUT_TOOL_CALL_ID, 30_000);
  expect(card.status).toBe("failed");
  expect(card.text).toContain(MISSING_TASK_ID);
  expect(TOOL_EXECUTION_FAILURE_LABELS.some((label) => card.text.includes(label))).toBe(true);
  expect(card.text).not.toContain("No task found with ID");
  expect(card.text).not.toContain("<tool_use_error>");
  const state = await readToolCardState(card.testId);
  expect(state.ariaExpanded).toBeNull();
  expect(state.hasCollapsibleContent).toBe(false);
}

async function assertRespondToCoordinatorErrorCard(): Promise<void> {
  await openSubagentSidePane(ERROR_AGENT_TOOL_CALL_ID);
  const card = await waitForToolCallBlockByToolCallId(
    ERROR_RESPOND_TO_COORDINATOR_TOOL_CALL_ID,
    30_000,
  );
  expect(card.status).toBe("failed");
  expect(card.text).toContain("E2E_RESPOND_ERROR_SUMMARY");
  expect(TOOL_EXECUTION_FAILURE_LABELS.some((label) => card.text.includes(label))).toBe(true);
  expect(card.text).not.toContain("InputValidationError");
  expect(card.text).not.toContain("The required parameter");
  expect(card.text).not.toContain("<tool_use_error>");
  const state = await readToolCardState(card.testId);
  expect(state.ariaExpanded).toBeNull();
  expect(state.hasCollapsibleContent).toBe(false);
}

async function openSubagentSidePane(parentAgentToolCallId: string): Promise<void> {
  const parentAgent = await waitForToolCallBlockByToolCallId(parentAgentToolCallId, 30_000);
  const parentAgentElement = await $(`[data-testid="${parentAgent.testId}"]`);
  const openChildAction = await parentAgentElement.$(
    `[data-testid^="${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-"]`,
  );
  await openChildAction.waitForDisplayed({
    timeout: 10_000,
    timeoutMsg: "BG25 parent Agent 卡没有 child conversation 入口",
  });
  const actionTestId = await openChildAction.getAttribute("data-testid");
  const childSessionId = actionTestId?.slice(`${TID_V4_SUBAGENT_OPEN_SIDE_PANE}-`.length);
  if (!childSessionId) {
    throw new Error("BG25 parent Agent 卡的 child session 入口缺少 session id");
  }

  // Reason for the test: in the production bundle the Agent summary can remount during the completion projection, so
  // a single WebDriver element click lands on a stale node. Each round re-locates from the current DOM and clicks
  // again, taking the target child session pane actually becoming visible as the only success condition, without
  // changing production interactions.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await browser.execute(
      (blockTestId, actionId) => {
        document
          .querySelector<HTMLElement>(`[data-testid="${blockTestId}"] [data-testid="${actionId}"]`)
          ?.click();
      },
      parentAgent.testId,
      actionTestId,
    );
    try {
      await browser.waitUntil(
        () =>
          browser.execute(
            (expectedChildSessionId) =>
              Boolean(
                document.querySelector(
                  '[data-side-pane-tab-id^="subagent-session:"][data-state="active"]',
                ),
              ) &&
              Array.from(
                document.querySelectorAll<HTMLElement>(
                  `[data-session-id="${expectedChildSessionId}"]`,
                ),
              ).some((pane) => pane.offsetParent !== null),
            childSessionId,
          ),
        {
          timeout: 10_000,
          timeoutMsg: "BG25 child conversation 没有在右侧面板打开",
        },
      );
      return;
    } catch {
      if (attempt === 2) {
        throw new Error("BG25 child conversation 没有在右侧面板打开");
      }
    }
  }
}

function assertTaskOutputProviderFieldsHidden(text: string): void {
  expect(text).not.toContain("<retrieval_status>");
  expect(text).not.toContain("<task_id>");
  expect(text).not.toContain("<task_type>");
  expect(text).not.toContain("<status>");
  expect(text).not.toContain("<exit_code>");
  expect(text).not.toContain("<output>");
  expect(text).not.toContain("<error>");
  expect(text).not.toContain("<persisted-output>");
  expect(text).not.toContain("E2E RespondToCoordinator background child");
}

function readToolCardState(blockTestId: string): Promise<{
  ariaExpanded: string | null;
  hasCollapsibleContent: boolean;
  text: string;
}> {
  return browser.execute(
    (toolBlockTestId, summaryTriggerPrefix) => {
      const block = document.querySelector<HTMLElement>(`[data-testid="${toolBlockTestId}"]`);
      const summary = block?.querySelector<HTMLElement>(
        `[data-testid^="${summaryTriggerPrefix}-"]`,
      );
      return {
        ariaExpanded: summary?.getAttribute("aria-expanded") ?? null,
        hasCollapsibleContent: Boolean(block?.querySelector('[data-slot="collapsible-content"]')),
        text: block?.innerText.replace(/\u00a0/g, " ").trim() ?? "",
      };
    },
    blockTestId,
    TID_TOOL_SUMMARY_TRIGGER,
  );
}

async function waitForFirstRequestIndex(
  query: Parameters<typeof waitForUpstreamRequest>[0],
  afterIndex: number,
  timeoutMsg: string,
) {
  await waitForUpstreamRequest(query, timeoutMsg, 60_000, { afterIndex });
  const index = await findFirstUpstreamRequestIndex(query, { afterIndex });
  if (index === null) {
    throw new Error(`${timeoutMsg}; request disappeared after wait`);
  }
  return index;
}

async function getRequestMarkerPosition(requestIndex: number, marker: string) {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) {
    throw new Error("E2E_PROVIDER_CAPTURE_PATH is required for request ordering assertions");
  }
  const artifact = JSON.parse(await readFile(capturePath, "utf-8")) as E2ENetworkCaptureArtifact;
  const body = JSON.stringify(artifact.records[requestIndex]?.requestJson ?? "");
  const contentIndex = body.indexOf(marker);
  if (contentIndex < 0) {
    throw new Error(`request ${requestIndex} does not contain marker ${marker}`);
  }
  return { requestIndex, contentIndex };
}

function compareRequestPositions(
  left: { requestIndex: number; contentIndex: number },
  right: { requestIndex: number; contentIndex: number },
) {
  return left.requestIndex === right.requestIndex
    ? left.contentIndex - right.contentIndex
    : left.requestIndex - right.requestIndex;
}

async function selectCurrentV4FullAccessMode() {
  // Bug root cause: the legacy session store's workspace configOptions is no longer the authoritative projection of
  // V4 draft mode, and DOM element.click() cannot reliably confirm a Radix Select. Reuse the V4 helper's keyboard
  // confirmation path, and judge that the configuration command has flowed back via the composer's data-mode
  // projection.
  await switchV4Mode("yolo");
  await browser.waitUntil(async () => (await getV4ConfigProjection()).mode === "yolo", {
    timeout: 30_000,
    timeoutMsg: "BG25 当前 v4 composer 没有收敛到 Full access mode",
  });
}

async function stopIfBusy() {
  const snapshot = await getV4PaneSnapshot();
  if (!snapshot.canStop) return;
  await clickV4Stop();
  await waitForV4Pane(
    (state) => !state.canStop,
    "RespondToCoordinator E2E teardown stop 后没有回到 idle",
    60_000,
  );
}
