/* eslint-disable max-lines -- The 22 historical MR-GOAL numbered cases are kept together so the catalog and the formal gates can be reconciled item by item. */
import { clearAppData } from "../helpers/desktop-app.js";
import {
  countUpstreamRequestsContaining,
  expectNoUpstreamRequestForTextWithin,
  waitForUpstreamRequest,
  waitForUpstreamRequestContaining,
} from "../helpers/conversation-session-network.js";
import {
  clickFirstQueueSendNow,
  clickQueueEdit,
  clickQueueRemove,
  getQueueItems,
  waitForQueueContaining,
  waitForQueueCount,
  waitForQueueOrderContaining,
} from "../helpers/conversation-session-queue.js";
import { expandAssistantHistoriesWithContent } from "../helpers/conversation-session-tool.js";
import {
  E2E_REPLY_TOKEN,
  assertVisibleV4UserMessagesNotContaining,
  clickV4Stop,
  editFirstV4UserQuery,
  dragV4QueueItemOnto,
  getV4Messages,
  getV4ConversationState,
  getV4ComposerText,
  getV4CompactMarkers,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  sendV4PausedQueueKeep,
  startNewV4Draft,
  type V4CompactMarkerSnapshot,
  waitForV4AssistantMessageContaining,
  waitForV4CompactMarker,
  waitForV4ComposerText,
  waitForV4ConversationState,
  waitForV4Edit,
  waitForV4Fork,
  waitForV4UserMessageContaining,
} from "../helpers/v4-conversation.js";

const COMPACT_REQUEST_SENTINEL = "CRITICAL: Respond with TEXT ONLY";
const CASE_TIMEOUT_MS = 180000;

describe("会话区 Goal Run 正式 E2E", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });

  afterEach(async () => {
    await stopCurrentWork();
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("MR-GOAL-01 completed 无 goal 时设置 goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const marker = goalFastMarker(1);

    await sendGoal(marker);
    const snapshot = await waitForGoalObjective(marker);

    expect(snapshot.queueCount).toBe(0);
    expect(snapshot.targetStatus).toBe("active");
    await waitForV4UserMessageContaining(marker);
  });

  it("MR-GOAL-02 completed 已有 goal 时更新 goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const first = goalFastMarker(2, "OLD");
    const updated = goalSlowMarker(2, "NEW");

    await sendGoal(first);
    await waitForGoalComplete(first);
    await sendGoal(updated);
    const snapshot = await waitForGoalObjective(updated);

    expect(snapshot.targetObjective).not.toContain(first);
    expect(snapshot.queueCount).toBe(0);
  });

  it("MR-GOAL-03 running 无 goal 时发送 /goal 入队", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = slowMarker(3);
    const goal = goalSlowMarker(3);

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(goal));
    const queue = await waitForQueueCount(1);

    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(goal);
    await expectNoUpstreamRequestForTextWithin(goal, 600);
  });

  it("MR-GOAL-04 running 已有 goal 时发送新 /goal 入队", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const existing = goalFastMarker(4, "OLD");
    const running = slowMarker(4);
    const queued = goalSlowMarker(4, "NEW");

    await sendGoal(existing);
    await waitForGoalComplete(existing);
    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(queued));
    const queue = await waitForQueueCount(1);

    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(queued);
    expect((await getV4ConversationState()).targetObjective).toContain(existing);
  });

  it("MR-GOAL-05 goal running 中 stop 后 target paused", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalSlowMarker(5);

    await sendGoal(goal);
    await waitForGoalObjective(goal);
    await clickV4Stop();
    const snapshot = await waitForV4ConversationState(
      (candidate) =>
        candidate.state !== "streaming" && candidate.targetObjective?.includes(goal) === true,
      "MR-GOAL-05 Stop 后 goal work 没有结束",
      30000,
    );

    expect(snapshot.targetStatus).toBe("paused");
  });

  it("MR-GOAL-06 interrupted held queue 后显式保留并启动新 /goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = slowMarker(6);
    const first = goalSlowMarker(6, "FIRST");
    const second = goalSlowMarker(6, "SECOND");

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(first));
    await waitForQueueCount(1);
    await clickV4Stop();
    await waitForHeldQueue(1);
    await sendV4PausedQueueKeep(goalPrompt(second));
    const snapshot = await waitForGoalObjective(second);
    const queue = await waitForQueueCount(1);

    expect(snapshot.targetObjective).toContain(second);
    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(first);
  });

  it("MR-GOAL-07 held goal queue 可编辑、重排、删除", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = slowMarker(7);
    const first = goalSlowMarker(7, "FIRST");
    const second = goalSlowMarker(7, "SECOND");
    const third = goalSlowMarker(7, "THIRD");
    const edited = goalSlowMarker(7, "SECOND_EDITED");

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(first));
    await sendV4Prompt(goalPrompt(second));
    await sendV4Prompt(goalPrompt(third));
    await waitForQueueCount(3);
    const initial = await getQueueItems();
    const firstId = requireQueueId(initial[0]?.id, "first");
    const secondId = requireQueueId(initial[1]?.id, "second");
    const thirdId = requireQueueId(initial[2]?.id, "third");
    await dragV4QueueItemOnto(thirdId, firstId);
    await waitForQueueOrderContaining([third, first, second]);
    await clickV4Stop();
    await waitForHeldQueue(3);

    // The last enqueued command's ACK can project onto the queue before the composer's pending finally;
    // the first edit click is then ignored by the product guard. Retry the real button action after busy
    // settles, and treat the authoritative queue deletion as the success boundary.
    await browser.waitUntil(
      async () => {
        if ((await getQueueItems()).length === 2) {
          return true;
        }
        await clickQueueEdit(secondId);
        return false;
      },
      {
        timeout: 30000,
        timeoutMsg: "MR-GOAL-07 goal queue item 没有撤回到 composer",
      },
    );
    await browser.waitUntil(async () => (await getV4ComposerText())?.includes(second) === true, {
      timeout: 30000,
      timeoutMsg: "MR-GOAL-07 编辑项没有撤回到 V4 composer",
    });
    // MR-GOAL-07 only covers held queue CRUD and does not cross with the active goal streaming's revision
    // CAS. Finish the deletion on the idle held queue first, then send the withdrawn-and-edited goal; otherwise
    // the target/title streaming projection may advance the revision at just the wrong moment, adjudicating a single delete click as stale.
    await waitForHeldQueue(2);
    await waitForQueueOrderContaining([third, first]);
    await clickQueueRemove(firstId);
    const queueAfterDelete = await waitForQueueCount(1);

    expect(queueAfterDelete[0]?.content).toContain(third);
    expect(queueAfterDelete.map((item) => item.kind)).toEqual(["goal"]);

    await sendV4PausedQueueKeep(goalPrompt(edited));
    await waitForGoalObjective(edited);
    const queueAfterEditedGoal = await waitForQueueCount(1);

    expect(queueAfterEditedGoal[0]?.content).toContain(third);
    expect(queueAfterEditedGoal.map((item) => item.kind)).toEqual(["goal"]);
  });

  it("MR-GOAL-08 manual compacting 中发送 /goal 只入队", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    await buildManualCompactHistory(8);
    const goal = goalSlowMarker(8);

    await sendV4Prompt("/compact");
    await waitForV4CompactMarker({ origin: "manual", status: "running" }, 30000);
    await sendV4Prompt(goalPrompt(goal));
    const queue = await waitForQueueCount(1);

    expect(queue[0]?.kind).toBe("goal");
    expect(queue[0]?.content).toContain(goal);
  });

  it("MR-GOAL-09 auto compact 前置于 queued goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = highUsageSlowMarker(9);
    const goal = goalFastMarker(9);
    const existingRows = await getAutoCompactRowIds();

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(goal));
    await waitForQueueContaining(goal);
    await waitForNewAutoCompactSuccess(existingRows);
    await waitForUpstreamRequestContaining(goal, 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "MR-GOAL-09 auto compact 后 queued goal 没有消费",
      90000,
    );
  });

  it("MR-GOAL-10 切换 session 时 goal 跟随当前 session", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalSlowMarker(10, "A");
    await sendGoal(goal);
    const sessionA = await waitForGoalObjective(goal);
    await clickV4Stop();
    await waitForHeldQueue(0);

    await freshTask();
    const sessionB = await sendFastPrompt(fastMarker(10, "B"));
    requireTaskId(sessionA.taskId, "session A");
    requireTaskId(sessionB.taskId, "session B");

    await selectV4TaskById(sessionA.taskId as string);
    const restoredA = await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId === sessionA.taskId && snapshot.targetObjective?.includes(goal) === true,
      "MR-GOAL-10 没有恢复 session A 的 paused goal",
      30000,
    );
    expect(restoredA.targetStatus).toBe("paused");
    await selectV4TaskById(sessionB.taskId as string);
    const restoredB = await waitForV4ConversationState(
      (snapshot) => snapshot.taskId === sessionB.taskId,
      "MR-GOAL-10 没有切回 session B",
      30000,
    );
    expect(restoredB.targetObjective).toBeNull();
  });

  it("MR-GOAL-11 queued goal send-now 后更新目标", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const oldGoal = goalFastMarker(11, "OLD");
    const running = slowMarker(11);
    const newGoal = goalSlowMarker(11, "NEW");

    await sendGoal(oldGoal);
    await waitForGoalComplete(oldGoal);
    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(newGoal));
    await waitForQueueContaining(newGoal);
    await clickFirstQueueSendNow();
    // Fix rationale: Send Now first projects the new goal, then asynchronously deletes the queue item. Waiting
    // only for the objective reads a brief mixed state where the target has updated but queueCount is still 1.
    const snapshot = await waitForActiveGoalWithEmptyQueue(newGoal);

    expect(snapshot.queueCount).toBe(0);
    expect(snapshot.targetObjective).not.toContain(oldGoal);
  });

  it("MR-GOAL-12 goal continuation stop 后 queue 保留且不自动消费", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalSlowMarker(12);
    const queued = fastMarker(12);

    await sendGoal(goal);
    await waitForGoalObjective(goal);
    await sendV4Prompt(simplePrompt(queued));
    await waitForQueueContaining(queued);
    const requestsBefore = await countUpstreamRequestsContaining(queued);
    await clickV4Stop();
    const snapshot = await waitForHeldQueue(1);

    expect(snapshot.targetStatus).toBe("paused");
    expect(await countUpstreamRequestsContaining(queued)).toBe(requestsBefore);
  });

  it("MR-GOAL-13 verifier 是 completion-blocking work", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalVerifierSlowMarker(13);
    const queued = fastMarker(13);

    await sendGoal(goal);
    await waitForVerifierRequest(goal);
    await sendV4Prompt(simplePrompt(queued));
    const queue = await waitForQueueCount(1);

    expect(queue[0]?.kind).toBe("text");
    await expectNoUpstreamRequestForTextWithin(queued, 600);
    expect((await getV4ConversationState()).state).toBe("streaming");
  });

  it("MR-GOAL-14 verifier 中 text/goal 保持 FIFO，compact 不抢占", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalVerifierSlowMarker(14, "ACTIVE");
    const textOne = fastMarker(14, "TEXT_ONE");
    const queuedGoal = goalFastMarker(14, "QUEUED");
    const textTwo = fastMarker(14, "TEXT_TWO");

    await sendGoal(goal);
    await waitForVerifierRequest(goal);
    await sendQueuedPromptAndWait(simplePrompt(textOne), textOne);
    await sendQueuedPromptAndWait(goalPrompt(queuedGoal), queuedGoal);
    const compactBefore = await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL);
    await sendQueuedPromptAndWait("/compact", "/compact");
    await sendQueuedPromptAndWait(simplePrompt(textTwo), textTwo);
    const queue = await waitForQueueOrderContaining([textOne, queuedGoal, "/compact", textTwo]);

    expect(queue.map((item) => item.kind)).toEqual(["text", "goal", "compact", "text"]);
    expect(await countUpstreamRequestsContaining(COMPACT_REQUEST_SENTINEL)).toBe(compactBefore);
    await assertVisibleV4UserMessagesNotContaining("/compact");
  });

  it("MR-GOAL-15 立即消费 typed goal 保留 goal intent", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = slowMarker(15);
    const goal = goalSlowMarker(15);

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(goal));
    await waitForQueueContaining(goal);
    await clickFirstQueueSendNow();
    const snapshot = await waitForActiveGoalWithEmptyQueue(goal);

    expect(snapshot.queueCount).toBe(0);
    expect(snapshot.targetStatus).toBe("active");
  });

  it("MR-GOAL-16 manual compact success 后消费 queued goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    await buildManualCompactHistory(16);
    const goal = goalFastMarker(16);

    await sendV4Prompt("/compact");
    await waitForV4CompactMarker({ origin: "manual", status: "running" }, 30000);
    await sendV4Prompt(goalPrompt(goal));
    await waitForQueueContaining(goal);
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
    await waitForUpstreamRequestContaining(goal, 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "MR-GOAL-16 compact success 后 queued goal 没有消费",
      90000,
    );
  });

  it("MR-GOAL-17 auto compact success 后消费 queued goal", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const running = highUsageSlowMarker(17);
    const goal = goalFastMarker(17);
    const existingRows = await getAutoCompactRowIds();

    await startSlowPrompt(running);
    await sendV4Prompt(goalPrompt(goal));
    await waitForQueueContaining(goal);
    await waitForNewAutoCompactSuccess(existingRows);
    await waitForUpstreamRequestContaining(goal, 90000);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "MR-GOAL-17 auto compact success 后 queued goal 没有消费",
      90000,
    );
  });

  it("MR-GOAL-18 goal complete 后 edit/fork/compact 控件恢复", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const seed = compactHistoryMarker(18, "SEED");
    const goal = goalFastMarker(18);

    await sendFastPrompt(seed);
    await sendGoal(goal);
    await waitForGoalComplete(goal);
    await expandAssistantHistoriesWithContent();
    // A controlOnly /goal row does not support direct edit; after completion what is restored is the existing
    // ordinary query's edit and assistant fork controls. V4 rows are identified by rowId rather than legacy
    // messageId; the V4 action contract must be read so the old message helper does not misreport an existing button as null.
    await waitForV4Edit();
    await waitForV4Fork();

    await sendV4Prompt("/compact");
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90000);
  });

  it("MR-GOAL-19 edit latest 普通 query 保持既有 goal scope", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalFastMarker(19);
    const beforeEdit = fastMarker(19, "BEFORE_EDIT");
    const afterEdit = fastMarker(19, "AFTER_EDIT");

    await sendGoal(goal);
    await waitForGoalComplete(goal);
    await sendFastPrompt(beforeEdit);
    await editFirstV4UserQuery(simplePrompt(afterEdit));
    await waitForUpstreamRequestContaining(afterEdit, 45000);
    const existingGoal = await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.targetObjective?.includes(goal) === true,
      "MR-GOAL-19 edit 普通 query 后 existing goal scope 丢失",
      90000,
    );
    expect(existingGoal.targetObjective).toContain(goal);

    await freshTask();
    const noGoalBefore = fastMarker(19, "NO_GOAL_BEFORE");
    const noGoalAfter = fastMarker(19, "NO_GOAL_AFTER");
    await sendFastPrompt(noGoalBefore);
    await editFirstV4UserQuery(simplePrompt(noGoalAfter));
    await waitForUpstreamRequestContaining(noGoalAfter, 45000);
    expect(
      (
        await waitForV4ConversationState(
          (snapshot) => snapshot.state === "idle",
          "MR-GOAL-19 无 goal edit 后没有回到 idle",
          90000,
        )
      ).targetObjective,
    ).toBeNull();
  });

  it("MR-GOAL-20 历史 session goal/queue 状态不串", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goalA = goalSlowMarker(20, "A");
    const queueA = goalFastMarker(20, "A_QUEUE");
    await sendGoal(goalA);
    const sessionA = await waitForGoalObjective(goalA);
    await sendV4Prompt(goalPrompt(queueA));
    await waitForQueueContaining(queueA);
    requireTaskId(sessionA.taskId, "session A");

    await freshTask();
    const sessionB = await sendFastPrompt(fastMarker(20, "B"));
    requireTaskId(sessionB.taskId, "session B");
    expect(sessionB.targetObjective).toBeNull();
    expect(sessionB.queueCount).toBe(0);

    await selectV4TaskById(sessionA.taskId as string);
    const restoredA = await waitForV4ConversationState(
      (snapshot) =>
        snapshot.taskId === sessionA.taskId &&
        snapshot.targetObjective?.includes(goalA) === true &&
        snapshot.queueCount === 1,
      "MR-GOAL-20 session A goal/queue 没有恢复",
      30000,
    );
    expect(restoredA.targetObjective).toContain(goalA);
  });

  it("MR-GOAL-21 普通 queue send-now 停止 active goal 输出", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalSlowMarker(21);
    const queued = fastMarker(21);
    const assistantRowIdsBeforeGoal = new Set(
      (await getV4Messages("assistant")).flatMap((message) =>
        message.id === null ? [] : [message.id],
      ),
    );

    await sendGoal(goal);
    await waitForGoalObjective(goal);
    await waitForNewGoalContinuationOutput(goal, assistantRowIdsBeforeGoal);
    await sendV4Prompt(simplePrompt(queued));
    await waitForQueueContaining(queued);
    await clickFirstQueueSendNow();
    await waitForUpstreamRequestContaining(queued, 90000);
    const snapshot = await waitForV4ConversationState(
      (candidate) => candidate.queueCount === 0,
      "MR-GOAL-21 send-now 后被点文本没有离开 queue",
      30000,
    );

    expect(snapshot.targetStatus).toBe("paused");
    await waitForV4UserMessageContaining(queued);
  });

  it("MR-GOAL-22 普通 queue send-now 停止 goal verifier", async function () {
    this.timeout(CASE_TIMEOUT_MS);
    await freshTask();
    const goal = goalVerifierSlowMarker(22);
    const queued = fastMarker(22);

    await sendGoal(goal);
    await waitForVerifierRequest(goal);
    await sendV4Prompt(simplePrompt(queued));
    await waitForQueueContaining(queued);
    const verifierBefore = await countUpstreamRequestsContaining(
      "Verify whether the active session goal",
    );
    await clickFirstQueueSendNow();
    await waitForUpstreamRequestContaining(queued, 90000);
    const snapshot = await waitForV4ConversationState(
      (candidate) => candidate.queueCount === 0,
      "MR-GOAL-22 send-now 后被点文本没有离开 queue",
      30000,
    );
    await browser.pause(500);

    expect(snapshot.targetStatus).toBe("paused");
    expect(await countUpstreamRequestsContaining("Verify whether the active session goal")).toBe(
      verifierBefore,
    );
  });
});

async function freshTask() {
  await startNewV4Draft();
  await waitForV4ConversationState(
    (snapshot) => snapshot.taskId === null && snapshot.queueCount === 0,
    "新建任务后没有进入空草稿",
    15000,
  );
  // The old MR-GOAL cases enter through a completed session, not an empty draft. Sending /goal on an empty draft
  // only pre-creates the session and cannot cover target/queue semantics on a completed task.
  return sendFastPrompt(fastMarker(0, "SETUP"));
}

async function sendFastPrompt(marker: string) {
  await sendV4Prompt(simplePrompt(marker));
  await waitForV4ComposerText("", `${marker} 发送后输入框没有清空`);
  await waitForUpstreamRequestContaining(marker, 30000);
  await waitForV4AssistantMessageContaining(E2E_REPLY_TOKEN);
  return waitForV4ConversationState(
    (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
    `${marker} 没有完成`,
    60000,
  );
}

async function startSlowPrompt(marker: string) {
  await sendV4Prompt(simplePrompt(marker));
  await waitForV4ComposerText("", `${marker} 发送后输入框没有清空`);
  // Bug root cause: waiting only on bodyIncludes first hits the title request carrying the same user marker,
  // then misreports a completed snapshot that has not entered the main turn as a running-state failure. Lock onto
  // the last user message and exclude title/compact so the admission corresponds to the controlled-stream fixture.
  await waitForV4UserMessageContaining(marker);
  await waitForUpstreamRequest(
    {
      excludes: ["Generate a concise title", COMPACT_REQUEST_SENTINEL],
      lastUserMessageIncludes: [marker],
    },
    `${marker} 主 turn 请求没有开始`,
    30000,
  );
  // The runtime evidence comes from the provider main request's pending controlled-stream; when a completed
  // session resumes its next turn, the renderer's task bridge briefly keeps the previous turn's completed state
  // before the V4 deltas, and this legacy diagnostic projection must not be allowed to negate the real main
  // request that has already started. The per-case queue/Stop assertions that follow continue to verify busy
  // admission rather than loosening the product outcome here.
}

async function sendGoal(marker: string) {
  await sendV4Prompt(goalPrompt(marker));
  await waitForV4ComposerText("", `${marker} goal 发送后输入框没有清空`);
  await waitForV4UserMessageContaining(marker);
}

async function sendQueuedPromptAndWait(prompt: string, marker: string) {
  await sendV4Prompt(prompt);
  // Fix rationale: after consecutive send clicks on Windows, the previous prompt's async composer clear can
  // overwrite the next prompt just written; each step must simultaneously confirm the input is cleared and this
  // marker was accepted into the queue.
  await waitForV4ComposerText("", `${marker} 入队后输入框没有清空`);
  return waitForQueueContaining(marker);
}

function waitForGoalObjective(marker: string) {
  return waitForV4ConversationState(
    (snapshot) =>
      snapshot.state === "streaming" && snapshot.targetObjective?.includes(marker) === true,
    `${marker} 没有进入 active goal work`,
    45000,
  );
}

async function waitForNewGoalContinuationOutput(
  marker: string,
  previousAssistantRowIds: ReadonlySet<string>,
) {
  await waitForUpstreamRequest(
    {
      excludes: [COMPACT_REQUEST_SENTINEL, "Verify whether the active session goal"],
      includes: [marker, "Continue working toward the active session goal"],
    },
    `${marker} goal continuation 请求没有开始`,
    45000,
  );
  await browser.waitUntil(
    async () => {
      const messages = await getV4Messages("assistant");
      return messages.some(
        (message) =>
          message.id !== null &&
          !previousAssistantRowIds.has(message.id) &&
          message.text.includes("deep"),
      );
    },
    {
      timeout: 30000,
      // Bug root cause: waiting only for target=active happens before the continuation's first delta; clicking
      // send-now immediately then can cross that delta's revision increment, the CAS returns stale per spec, and
      // the case misreports stop as broken. Lock onto the new assistant row first to truly enter "active goal outputting".
      timeoutMsg: `${marker} goal continuation 首段输出没有进入新 assistant row`,
    },
  );
}

function waitForActiveGoalWithEmptyQueue(marker: string) {
  let stableSamples = 0;
  return waitForV4ConversationState(
    (snapshot) => {
      // Fix rationale: Send Now first updates the store/goal projection, then asynchronously unmounts the queue
      // DOM; waiting only for the objective reads a mixed snapshot on Windows where the goal is already active but the old queue nodes still exist.
      const settled =
        snapshot.state === "streaming" &&
        snapshot.targetObjective?.includes(marker) === true &&
        snapshot.targetStatus === "active" &&
        snapshot.queueCount === 0;
      stableSamples = settled ? stableSamples + 1 : 0;
      return stableSamples >= 2;
    },
    `${marker} Send Now 后 active goal 与空队列没有稳定收敛`,
    45000,
  );
}

function waitForGoalComplete(marker: string) {
  return waitForV4ConversationState(
    (snapshot) =>
      snapshot.state === "idle" &&
      snapshot.targetObjective?.includes(marker) === true &&
      (snapshot.targetStatus === "complete" ||
        snapshot.targetStatus === "completed" ||
        snapshot.targetStatus === "verified"),
    `${marker} 没有通过 verifier 自然完成`,
    60000,
  );
}

async function waitForVerifierRequest(marker: string) {
  await waitForUpstreamRequest(
    {
      excludes: [COMPACT_REQUEST_SENTINEL],
      includes: [marker, "Verify whether the active session goal"],
    },
    `${marker} verifier 请求没有开始`,
    60000,
  );
  return waitForV4ConversationState(
    (snapshot) =>
      snapshot.state === "streaming" && snapshot.targetObjective?.includes(marker) === true,
    `${marker} verifier 没有保持 completion-blocking 状态`,
    30000,
  );
}

function waitForHeldQueue(expectedCount: number) {
  return waitForV4ConversationState(
    (snapshot) => snapshot.state !== "streaming" && snapshot.queueCount === expectedCount,
    `Stop 后没有保留 ${expectedCount} 条 held queue`,
    30000,
  );
}

async function buildManualCompactHistory(caseId: number) {
  await sendFastPrompt(compactHistoryMarker(caseId, "A"));
  await sendFastPrompt(compactHistoryMarker(caseId, "B"));
}

async function getAutoCompactRowIds() {
  await expandAssistantHistoriesWithContent();
  return new Set(
    (await getV4CompactMarkers())
      .filter((marker) => marker.origin === "auto" && marker.rowId !== null)
      .map((marker) => marker.rowId as number),
  );
}

async function waitForNewAutoCompactSuccess(
  existingRowIds: ReadonlySet<number>,
): Promise<V4CompactMarkerSnapshot> {
  let latestMarkers: V4CompactMarkerSnapshot[] = [];
  await browser.waitUntil(
    async () => {
      await expandAssistantHistoriesWithContent();
      latestMarkers = await getV4CompactMarkers();
      return latestMarkers.some(
        (marker) =>
          marker.origin === "auto" &&
          marker.status === "success" &&
          marker.rowId !== null &&
          !existingRowIds.has(marker.rowId),
      );
    },
    {
      timeout: 90000,
      timeoutMsg: `没有等到新的 auto/success marker: ${JSON.stringify(latestMarkers)}`,
    },
  );
  const marker = latestMarkers.find(
    (candidate) =>
      candidate.origin === "auto" &&
      candidate.status === "success" &&
      candidate.rowId !== null &&
      !existingRowIds.has(candidate.rowId),
  );
  if (!marker) {
    throw new Error("新的 auto/success marker 在等待后仍不存在");
  }
  return marker;
}

async function stopCurrentWork() {
  const snapshot = await getV4ConversationState().catch(() => null);
  if (snapshot?.state !== "streaming") {
    return;
  }
  await clickV4Stop().catch(() => undefined);
  await waitForV4ConversationState(
    (candidate) => candidate.state !== "streaming",
    "afterEach Stop 后没有结束当前 work",
    30000,
  ).catch(() => undefined);
}

function requireQueueId(value: string | undefined, label: string) {
  if (!value) {
    throw new Error(`${label} queue item 缺少 id`);
  }
  return value;
}

function requireTaskId(value: string | null, label: string) {
  if (!value) {
    throw new Error(`${label} 缺少 taskId`);
  }
  return value;
}

function simplePrompt(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

function goalPrompt(marker: string) {
  return `/goal ${goalObjective(marker)}`;
}

function goalObjective(marker: string) {
  return `${marker}: Reply with exactly "${E2E_REPLY_TOKEN}" and no other text.`;
}

function fastMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_FAST_${caseId}_${suffix}_${Date.now()}`;
}

function slowMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_SLOW_${caseId}_${suffix}_${Date.now()}`;
}

function highUsageSlowMarker(caseId: number) {
  return `E2E_GR_HIGH_USAGE_SLOW_${caseId}_${Date.now()}`;
}

function goalFastMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_GOAL_FAST_${caseId}_${suffix}_${Date.now()}`;
}

function goalSlowMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_GOAL_SLOW_${caseId}_${suffix}_${Date.now()}`;
}

function goalVerifierSlowMarker(caseId: number, suffix = "MAIN") {
  return `E2E_GR_GOAL_VERIFY_SLOW_${caseId}_${suffix}_${Date.now()}`;
}

function compactHistoryMarker(caseId: number, suffix: string) {
  return `E2E_GR_COMPACT_HISTORY_${caseId}_${suffix}_${Date.now()}`;
}
