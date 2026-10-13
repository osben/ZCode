// M4 gate: queue single-item management + B09 recall to composer.
// Evidence level L3: during a running turn, sendText enqueues → QueuePanel → deleteQueueItem authoritatively removes →
// the initiating side restores text + AttachmentRef[]; resending produces a new queueItemId. A non-empty draft blocks the
// command at the UI admission boundary, leaving both the queue and the draft unchanged.
import { clearAppData } from "../helpers/desktop-app.js";
import { waitForToastContaining } from "../helpers/conversation-session-toast.js";
import {
  clickV4Stop,
  clickV4QueueItemDelete,
  dragV4QueueItemOnto,
  clickV4QueueItemEdit,
  getV4ComposerAttachments,
  getV4ComposerText,
  getV4PaneSnapshot,
  getV4QueueItems,
  isV4ComposerFocused,
  prepareV4ConversationE2E,
  pasteV4ComposerImageAttachment,
  sendV4Prompt,
  setV4ComposerText,
  waitForV4Pane,
  waitForV4QueueCount,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";

describe("v4 M4/B09 门禁：queue 单项管理与撤回编辑", () => {
  afterEach(async () => {
    const snapshot = await getV4PaneSnapshot();
    if (!snapshot.canStop) return;
    // Reason for the fix: the controlled stream survives across cases for 45 seconds; without an explicit stop, the previous
    // active runtime runs in parallel with the next draft and drains a leftover queue at the end, polluting models/fixtures.
    await clickV4Stop();
    await waitForV4Pane((next) => !next.canStop, "queue operation case 收尾 stop 没有完成", 30000);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("running 中入队一条 → QueuePanel 显示 → 删除 → 队列清空", async () => {
    await prepareV4ConversationE2E();

    // First round: controllable slow stream, keep it running
    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    // While running, send a second prompt → it is enqueued
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 排队的问题");
    await waitForV4QueueCount(1, 30000);
    const before = await getV4QueueItems();
    expect(before).toHaveLength(1);
    expect(before[0]!.text).toContain("E2E_V4_QUEUE_ITEM");

    // Delete that queue item → the queue empties
    const clicked = await clickV4QueueItemDelete(before[0]!.queueItemId);
    expect(clicked).toBe(true);
    await waitForV4QueueCount(0, 30000);
    expect(await getV4QueueItems()).toHaveLength(0);
  });

  it("running 中带图片入队 → 撤回到 composer → 修改重发产生新 queueItemId", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    await pasteV4ComposerImageAttachment("e2e-queue-edit.png");
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 排队原文");
    await waitForV4QueueCount(1, 30000);
    const before = await getV4QueueItems();
    expect(before[0]!.text).toContain("排队原文");
    const queueItemId = before[0]!.queueItemId;

    // Reason for the fix: a double click before the ACK returns would send two deletes and restore the same attachment draft twice.
    // Clicking twice within the same event loop verifies the renderer-local operation lock also works before React re-renders.
    const clicked = await clickV4QueueItemEdit(queueItemId, 2);
    expect(clicked).toBe(true);
    await waitForV4QueueCount(0, 30000);
    await browser.waitUntil(
      async () => {
        const text = await getV4ComposerText();
        const attachments = await getV4ComposerAttachments();
        return (
          text === "E2E_V4_QUEUE_ITEM 排队原文" &&
          attachments.length === 1 &&
          // Bug cause: a media ref restored from the queue does not rebuild the local object URL, so the thumbnail may show
          // only the image fallback icon; verifying the filename via innerText would falsely judge the restored-and-ready attachment.
          attachments[0]?.uploadStatus === "ready"
        );
      },
      { timeout: 30000, timeoutMsg: "队列项移除后没有完整恢复 composer 文本与附件" },
    );
    expect(await isV4ComposerFocused()).toBe(true);
    expect(await getV4ComposerAttachments()).toHaveLength(1);

    await sendV4Prompt("E2E_V4_QUEUE_ITEM 编辑后重新提交");
    await waitForV4QueueCount(1, 30000);
    const after = await getV4QueueItems();
    expect(after).toHaveLength(1);
    expect(after[0]?.queueItemId).not.toBe(queueItemId);
    expect(after[0]?.text).toContain("编辑后重新提交");
  });

  it("composer 已有草稿时编辑 queue 不撤回且提示先处理草稿", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    await sendV4Prompt("E2E_V4_QUEUE_ITEM 不应被撤回");
    await waitForV4QueueCount(1, 30000);
    const before = await getV4QueueItems();
    await setV4ComposerText("保留现有草稿");

    expect(await clickV4QueueItemEdit(before[0]!.queueItemId)).toBe(true);
    await waitForToastContaining(
      [
        "Send or clear the current draft before editing a queued message.",
        "请先发送或清空当前草稿，再编辑队列消息。",
      ],
      // Bug root cause: E2E inherits the workspace locale; the old assertion accepted only English, so under a Chinese locale it
      // reported the correctly shown conflict toast as missing. The behavior contract must cover both supported languages.
      "非空草稿没有出现撤回阻止提示",
    );
    expect(await getV4ComposerText()).toBe("保留现有草稿");
    const after = await getV4QueueItems();
    expect(after).toHaveLength(1);
    expect(after[0]?.queueItemId).toBe(before[0]?.queueItemId);
    expect(after[0]?.text).toContain("不应被撤回");
  });

  it("running 中入队两条 → 拖拽第二条到第一条 → 顺序互换（reorderQueueItem）", async () => {
    await prepareV4ConversationE2E();

    await sendV4Prompt("E2E_V4_QUEUE_SLOW 慢慢回答");
    await waitForV4TimelineContaining("V4_QUEUE_STREAMING", 45000);
    await waitForV4Pane(
      (s) => s.canStop && s.sessionId !== "draft" && s.sessionId !== null,
      "首轮没有进入 running（canStop）",
      45000,
    );

    // While running, enqueue two items in order
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 第一条问题");
    await waitForV4QueueCount(1, 30000);
    await sendV4Prompt("E2E_V4_QUEUE_ITEM 第二条问题");
    await waitForV4QueueCount(2, 30000);

    const before = await getV4QueueItems();
    expect(before).toHaveLength(2);
    expect(before[0]!.text).toContain("第一条问题");
    expect(before[1]!.text).toContain("第二条问题");
    const secondId = before[1]!.queueItemId;

    // The drag only sends reorderQueueItem; the order update must come from the CLI projection flowing back.
    await dragV4QueueItemOnto(secondId, before[0]!.queueItemId);
    await browser.waitUntil(
      async () => {
        const items = await getV4QueueItems();
        return items.length === 2 && items[0]!.queueItemId === secondId;
      },
      { timeout: 30000, timeoutMsg: "第二条没有拖拽到队首" },
    );
    const after = await getV4QueueItems();
    expect(after).toHaveLength(2);
    expect(after[0]!.queueItemId).toBe(secondId);
    expect(after[0]!.text).toContain("第二条问题");
    expect(after[1]!.text).toContain("第一条问题");
  });
});
